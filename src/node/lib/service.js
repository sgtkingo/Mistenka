"use strict";
// Doménová logika místenek. Stejné chování musí mít PHP plugin – viz docs/API.md.
const crypto = require("node:crypto");
const { transaction } = require("./db");
const time = require("./time");
const { getRevir, revirRules } = require("./config");
const { spayd } = require("./payments");
const emails = require("./emails");
const { ApiError, normalizeMemberId, validEmail, validMemberId, validName, validBirthDate } = require("./validate");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{6}$/;
const VOUCHER_RE = /^[A-Z0-9]{16}$/;

const normalizeCode = (value) => String(value || "").trim().toUpperCase();
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const iso = (date) => date.toISOString();

// ---------- pravidla druhů ryb (config/species/*.json) ----------
function findSpecies(rules, name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key || !rules) return null;
  return rules.species.find((s) => s.name.toLowerCase() === key || (s.aliases || []).some((alias) => alias.toLowerCase() === key)) || null;
}
// Doba hájení MM-DD včetně; rozsah může přecházet přes konec roku (např. 09-01 až 04-15).
function inClosedSeason(species, isoDate) {
  const md = isoDate.slice(5);
  return (species.closedSeasons || []).find(({ from, to }) => (from <= to ? md >= from && md <= to : md >= from || md <= to)) || null;
}
const czMonthDay = (md) => `${Number(md.slice(3))}. ${Number(md.slice(0, 2))}.`;
// Vrátí důvod, proč si rybu nelze přisvojit, nebo null.
function catchProblem(species, length, fishingDate) {
  const season = inClosedSeason(species, fishingDate);
  if (season) return { code: "closed_season", message: season.from === "01-01" && season.to === "12-31" ? `${species.name} je celoročně hájen(a) – rybu je nutné vrátit.` : `${species.name} je v době hájení (${czMonthDay(season.from)}–${czMonthDay(season.to)}) – rybu je nutné vrátit.` };
  if (species.minLength && length < species.minLength) return { code: "undersized", message: `${species.name} pod nejmenší lovnou mírou (${species.minLength} cm) – rybu je nutné vrátit.` };
  if (species.releaseFromLength && length >= species.releaseFromLength) return { code: "must_release", message: `${species.name} od ${species.releaseFromLength} cm se musí vrátit zpět do revíru.` };
  return null;
}

function createService({ db, config, provider, mailer, appUrl, operations, settings, mailAccounts }) {
  // ---------- pomocné ----------
  function makeCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!db.prepare("SELECT 1 FROM tickets WHERE code = ?").get(code)) return code;
    }
  }
  function makeVariableSymbol() {
    for (;;) {
      const vs = String(crypto.randomInt(1_000_000_000, 10_000_000_000));
      if (!db.prepare("SELECT 1 FROM tickets WHERE variable_symbol = ?").get(vs)) return vs;
    }
  }
  function issueToken(ticketId, purpose) {
    const token = crypto.randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO ticket_tokens (token_hash, ticket_id, purpose, created_at) VALUES (?, ?, ?, ?)").run(sha256(token), ticketId, purpose, iso(time.now()));
    return token;
  }
  function revirOf(ticket) {
    return getRevir(config, ticket.revir_id) || { id: ticket.revir_id, name: ticket.revir_id, lateReturnDays: 7 };
  }
  function windowOf(ticket) {
    const start = time.pragueLocalToDate(ticket.fishing_date, "00:00");
    const end = time.pragueLocalToDate(ticket.fishing_date, "24:00");
    // Opožděné odevzdání je možné lateReturnDays dní po konci dne lovu, pak se místenka uzavře.
    const deadline = new Date(end.getTime() + Number(revirOf(ticket).lateReturnDays) * 86_400_000);
    return { start, end, deadline };
  }
  function stateOf(ticket, at = time.now()) {
    if (ticket.status === "pending_payment") return new Date(ticket.reserved_until) <= at ? "payment_expired" : "pending_payment";
    if (ticket.status !== "issued") return ticket.status;
    if (ticket.returned_at) return "expired_returned";
    const w = windowOf(ticket);
    // Zadržená: neplatí pro lov, ale do konce lhůty ji lze (a je nutné) odevzdat.
    if (ticket.seized_at) return at < w.deadline && !ticket.closed_at ? "seized" : "closed_unreturned";
    if (at < w.start) return "future";
    if (at < w.end) return "active";
    if (at < w.deadline && !ticket.closed_at) return "expired_unreturned";
    return "closed_unreturned";
  }
  function isReturnable(ticket, at = time.now()) {
    const state = stateOf(ticket, at);
    return state === "active" || state === "expired_unreturned" || state === "seized";
  }
  function takenSeats(revirId, date, excludeId = 0) {
    return db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE revir_id = ? AND fishing_date = ? AND id != ?
      AND (status = 'issued' OR (status = 'pending_payment' AND reserved_until > ?))`).get(revirId, date, excludeId, iso(time.now())).n;
  }
  function findTicket(code) {
    const normalized = normalizeCode(code);
    if (!CODE_RE.test(normalized)) throw new ApiError(400, "invalid_code", "Kód místenky má 6 znaků A–Z a 0–9.");
    const ticket = db.prepare("SELECT * FROM tickets WHERE code = ?").get(normalized);
    if (!ticket) throw new ApiError(404, "not_found", "Místenka nebyla nalezena.");
    return ticket;
  }
  // Držitel se prokáže tokenem (prohlížeč / odkaz z e-mailu), číslem členské legitimace,
  // nebo je přihlášený k účtu, ke kterému místenka patří.
  function authorize(ticket, credentials = {}, user = null) {
    if (user && ticket.user_id === user.id) return;
    if (credentials.token) {
      const row = db.prepare("SELECT 1 FROM ticket_tokens WHERE token_hash = ? AND ticket_id = ?").get(sha256(credentials.token), ticket.id);
      if (row) return;
    }
    if (credentials.memberId && normalizeMemberId(credentials.memberId) === ticket.member_id) return;
    throw new ApiError(403, "forbidden", credentials.token || credentials.memberId ? "Údaje pro přístup k místence nesouhlasí." : "Pro tuto akci zadejte číslo členské legitimace nebo použijte odkaz z e-mailu.");
  }
  function maskMemberId(memberId) {
    const visible = Number(config.publicCheck.memberIdVisibleChars ?? 4);
    if (visible <= 0) return "•••";
    return "•".repeat(Math.max(3, memberId.length - visible)) + memberId.slice(-visible);
  }
  function links(ticket, token) {
    const ticketLink = token ? `${appUrl}/payment.html?code=${ticket.code}#t=${token}` : `${appUrl}/status.html?code=${ticket.code}`;
    return {
      status: `${appUrl}/status.html?code=${ticket.code}`,
      ticket: ticketLink,
      payment: ticketLink,
      return: token ? `${appUrl}/return.html?code=${ticket.code}#t=${token}` : `${appUrl}/return.html?code=${ticket.code}`
    };
  }
  function enqueueEmail(ticket, kind, token, extra = {}) {
    const revir = revirOf(ticket);
    const render = { payment_instructions: emails.paymentInstructions, ticket_issued: emails.ticketIssued, return_reminder: emails.returnReminder, ticket_closed: emails.ticketClosed, ticket_seized: emails.ticketSeized, seizure_notice: emails.seizureNotice, limit_exceeded: emails.limitExceeded, member_blocked: emails.memberBlocked, ticket_cancelled: emails.ticketCancelled }[kind];
    const mail = render(config, { ticket, revir, links: links(ticket, token), ...extra });
    db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ticket.id, kind, extra.to || ticket.email, mail.subject, mail.html, mail.text, iso(time.now()));
  }

  // ---------- výstupní tvary (docs/API.md) ----------
  function paymentInfo(ticket) {
    const message = `${config.payment.messagePrefix || "Mistenka"} ${ticket.code} ${ticket.fishing_date}`;
    return {
      iban: config.iban,
      accountNumber: `${config.payment.accountNumber}/${config.payment.bankCode}`,
      recipientName: config.payment.recipientName || config.organization.shortName,
      variableSymbol: ticket.variable_symbol,
      amountHalere: ticket.amount_due_halere,
      message,
      reservedUntil: ticket.reserved_until,
      spayd: spayd({ iban: config.iban, amountHalere: ticket.amount_due_halere, variableSymbol: ticket.variable_symbol, message, recipientName: config.payment.recipientName })
    };
  }
  function publicTicket(ticket) {
    const revir = revirOf(ticket);
    const status = stateOf(ticket);
    const w = windowOf(ticket);
    const issued = ticket.status === "issued";
    const name = config.publicCheck.showFullName ? `${ticket.first_name} ${ticket.last_name}` : `${ticket.first_name} ${ticket.last_name.charAt(0)}.`;
    return {
      code: ticket.code,
      revir: { id: revir.id, name: revir.name, number: revir.number || "" },
      date: ticket.fishing_date,
      status,
      late: status === "expired_unreturned" || status === "closed_unreturned" || (status === "expired_returned" && Boolean(ticket.return_late)) || (status === "seized" && time.now() >= w.end),
      seized: Boolean(ticket.seized_at),
      holder: issued ? { name, memberId: maskMemberId(ticket.member_id) } : null,
      validFrom: iso(w.start),
      validTo: iso(w.end)
    };
  }
  function ownerTicket(ticket, { withLimits = true } = {}) {
    const base = publicTicket(ticket);
    const w = windowOf(ticket);
    const catches = db.prepare("SELECT species, length_cm, weight_kg, weight_estimated FROM catches WHERE ticket_id = ? ORDER BY id").all(ticket.id)
      .map((c) => ({ species: c.species, length: c.length_cm, weight: c.weight_kg, weightEstimated: Boolean(c.weight_estimated) }));
    const out = {
      ...base,
      holder: undefined,
      firstName: ticket.first_name,
      lastName: ticket.last_name,
      birthDate: ticket.birth_date,
      email: ticket.email,
      memberId: ticket.member_id,
      priceHalere: ticket.price_halere,
      amountDueHalere: ticket.amount_due_halere,
      voucherUsed: Boolean(ticket.voucher_code),
      createdAt: ticket.created_at,
      issuedAt: ticket.issued_at,
      returnedAt: ticket.returned_at,
      noCatch: Boolean(ticket.no_catch),
      returnable: isReturnable(ticket),
      returnDeadline: iso(w.deadline),
      closedAt: ticket.closed_at,
      seizure: ticket.seized_at ? { at: ticket.seized_at, reason: ticket.seized_reason, place: ticket.seized_place || "" } : null,
      catches,
      payment: base.status === "pending_payment" ? paymentInfo(ticket) : null
    };
    if (withLimits && ticket.status !== "cancelled") out.limits = limitsFor(ticket);
    delete out.holder;
    return out;
  }

  // ---------- veřejné operace ----------
  function availability(revirId) {
    const revir = getRevir(config, revirId);
    if (!revir) throw new ApiError(404, "unknown_revir", "Revír neexistuje.");
    const today = time.pragueToday();
    const days = [];
    for (let offset = 0; offset <= revir.bookingDaysAhead; offset++) {
      const date = time.addDays(today, offset);
      const taken = takenSeats(revir.id, date);
      const day = operations.dayStatus(revir.id, date);
      days.push({ date, capacity: revir.dailyCapacity, taken, available: day.open ? Math.max(0, revir.dailyCapacity - taken) : 0, closed: !day.open, closedReason: day.open ? null : day.reason });
    }
    return { revirId: revir.id, today, days };
  }

  function validateOrder(input) {
    const revir = getRevir(config, String(input.revirId || ""));
    if (!revir) throw new ApiError(400, "unknown_revir", "Vyberte revír.");
    const today = time.pragueToday();
    const date = String(input.date || "");
    if (!time.isIsoDate(date) || date < today || date > time.addDays(today, revir.bookingDaysAhead)) throw new ApiError(400, "invalid_date", `Datum lovu musí být mezi dneškem a ${revir.bookingDaysAhead}. dnem dopředu.`);
    const memberId = validMemberId(input.memberId);
    const { firstName, lastName } = validName(input.firstName, input.lastName);
    const birthDate = validBirthDate(input.birthDate);
    const email = validEmail(input.email);
    if (input.declaration !== true) throw new ApiError(400, "declaration_required", "Potvrďte čestné prohlášení a podmínky rezervace.");
    const voucherCode = normalizeCode(input.voucherCode);
    if (voucherCode && !VOUCHER_RE.test(voucherCode)) throw new ApiError(400, "invalid_voucher", "Kód poukazu musí mít 16 znaků A–Z nebo 0–9.");
    return { revir, date, memberId, firstName, lastName, birthDate, email, voucherCode };
  }

  function createOrder(input, user = null) {
    const order = validateOrder(input);
    return transaction(db, () => {
      const { revir } = order;
      const day = operations.dayStatus(revir.id, order.date);
      if (!day.open) throw new ApiError(409, day.code, day.code === "revir_closed" ? `Revír je v tento den mimořádně uzavřen: ${day.reason}` : `${day.reason}. Místenku na tento den nelze koupit.`);
      const block = activeBlock(order.memberId);
      if (block) throw new ApiError(403, "member_blocked", `Nákup místenek je pro toto číslo legitimace pozastaven ${block.until ? `do ${block.until.split("-").reverse().map(Number).join(". ")}` : "do odvolání"}. Důvod: ${block.reason}. Kontaktujte správce organizace.`);
      if (takenSeats(revir.id, order.date) >= revir.dailyCapacity) throw new ApiError(409, "sold_out", "Na vybraný den už nejsou volná místa.");
      if (order.voucherCode) {
        const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ?").get(order.voucherCode);
        if (!voucher || (voucher.revir_id && voucher.revir_id !== revir.id)) throw new ApiError(400, "invalid_voucher", "Poukaz není platný.");
        if (voucher.voided_at) throw new ApiError(400, "invalid_voucher", "Poukaz není platný.");
        if (voucher.used_at) throw new ApiError(409, "voucher_used", "Poukaz už byl použit.");
      }
      const now = time.now();
      const price = Math.round(Number(revir.priceCzk) * 100);
      const due = order.voucherCode ? 0 : price;
      const free = due === 0;
      const code = makeCode();
      const result = db.prepare(`INSERT INTO tickets (code, revir_id, fishing_date, member_id, first_name, last_name, birth_date, email,
        price_halere, amount_due_halere, variable_symbol, voucher_code, status, created_at, reserved_until, paid_at, issued_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        code, revir.id, order.date, order.memberId, order.firstName, order.lastName, order.birthDate, order.email,
        price, due, free ? null : makeVariableSymbol(), order.voucherCode || null, free ? "issued" : "pending_payment", iso(now),
        free ? null : iso(new Date(now.getTime() + config.payment.reservationMinutes * 60_000)), null, free ? iso(now) : null, user?.id ?? null
      );
      const ticketId = Number(result.lastInsertRowid);
      if (order.voucherCode) {
        const used = db.prepare("UPDATE vouchers SET used_at = ?, ticket_code = ? WHERE code = ? AND used_at IS NULL").run(iso(now), code, order.voucherCode);
        if (!used.changes) throw new ApiError(409, "voucher_used", "Poukaz už byl použit.");
      }
      const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
      const token = issueToken(ticketId, "order");
      enqueueEmail(ticket, free ? "ticket_issued" : "payment_instructions", token);
      return { token, ticket: ownerTicket(ticket) };
    });
  }

  function getPublicTicket(code) {
    return publicTicket(findTicket(code));
  }
  function getOwnerTicket(code, credentials, user) {
    const ticket = findTicket(code);
    authorize(ticket, credentials, user);
    return ownerTicket(ticket);
  }
  // Místenky přihlášeného uživatele, nejnovější den lovu první.
  function ticketsForUser(user) {
    return db.prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY fishing_date DESC, id DESC LIMIT 200").all(user.id).map((t) => ownerTicket(t, { withLimits: false }));
  }
  function cancelOrder(code, credentials, user) {
    const ticket = findTicket(code);
    authorize(ticket, credentials, user);
    return transaction(db, () => {
      const fresh = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
      if (fresh.status !== "pending_payment" && fresh.status !== "payment_expired") throw new ApiError(409, "not_cancellable", "Zrušit lze jen nezaplacenou objednávku.");
      db.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ?, reserved_until = NULL WHERE id = ?").run(iso(time.now()), ticket.id);
      return ownerTicket(db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id));
    });
  }

  function submitReturn(code, credentials, body = {}, user = null) {
    const ticket = findTicket(code);
    authorize(ticket, credentials, user);
    const noCatch = body.noCatch === true;
    const items = Array.isArray(body.catches) ? body.catches : [];
    if (noCatch && items.length) throw new ApiError(400, "invalid_catches", "Při hlášení bez úlovku neuvádějte žádné úlovky.");
    if (!noCatch && items.length === 0) throw new ApiError(400, "catches_required", "Zapište alespoň jeden úlovek, nebo zvolte „Bez úlovku“.");
    if (items.length > 100) throw new ApiError(400, "invalid_catches", "Příliš mnoho úlovků.");
    const rules = revirRules(revirOf(ticket));
    const catches = items.map((item, index) => {
      const name = String(item?.species || "").trim();
      const length = Number(item?.length);
      const weight = item?.weight === null || item?.weight === undefined || item?.weight === "" ? null : Number(item.weight);
      const row = `Úlovek ${index + 1}`;
      if (!name || name.length > 60) throw new ApiError(400, "invalid_catches", `${row}: vyplňte druh ryby.`);
      if (!(length > 0 && length <= 400)) throw new ApiError(400, "invalid_catches", `${row}: vyplňte délku v cm.`);
      if (weight !== null && !(weight > 0 && weight <= 300)) throw new ApiError(400, "invalid_catches", `${row}: neplatná hmotnost.`);
      const known = findSpecies(rules, name);
      const problem = known && catchProblem(known, length, ticket.fishing_date);
      if (problem) throw new ApiError(400, problem.code, `${row}: ${problem.message}`);
      return { species: known ? known.name : name, speciesId: known?.id || null, length, weight, weightEstimated: weight !== null && item.weightEstimated === true };
    });
    return transaction(db, () => {
      const fresh = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
      const now = time.now();
      const state = stateOf(fresh, now);
      if (fresh.status !== "issued") throw new ApiError(409, "not_issued", "Místenka nebyla vystavena.");
      if (state === "expired_returned") throw new ApiError(409, "already_returned", "Místenka už byla odevzdána.");
      if (state === "future") throw new ApiError(409, "too_early", "Místenku není možné odevzdat před dnem lovu.");
      if (state === "closed_unreturned") throw new ApiError(409, "return_closed", "Lhůta pro odevzdání uplynula, místenka byla uzavřena jako neodevzdaná. Kontaktujte hospodáře.");
      const insert = db.prepare("INSERT INTO catches (ticket_id, species, length_cm, weight_kg, weight_estimated) VALUES (?, ?, ?, ?, ?)");
      for (const c of catches) insert.run(fresh.id, c.species, c.length, c.weight, c.weightEstimated ? 1 : 0);
      db.prepare("UPDATE tickets SET returned_at = ?, return_late = ?, no_catch = ?, rules_version = ? WHERE id = ?").run(iso(now), now >= windowOf(fresh).end ? 1 : 0, noCatch ? 1 : 0, settings ? settings.rulesVersion(fresh.revir_id) : null, fresh.id);
      const returned = db.prepare("SELECT * FROM tickets WHERE id = ?").get(fresh.id);
      recordViolations(returned);
      if (returned.return_late) applyPenalty(returned, "late_return");
      return ownerTicket(returned);
    });
  }

  // ---------- limity úlovků (B3) ----------
  // Počítají se podle čísla legitimace z odevzdaných místenek v Místence (i bez účtu).
  const parseHa = (text) => { const m = String(text || "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*ha/); return m ? Number(m[1]) : null; };
  // Výměra vody, na kterou místenka platí: největší z jejích podrevírů, jinak výměra revíru.
  function ticketAreaHa(revir) {
    const numbers = Array.isArray(revir.ticketSubdistricts) ? revir.ticketSubdistricts : [];
    const areas = numbers.map((n) => parseHa((revir.subdistrictList || []).find((s) => String(s.number) === String(n))?.area));
    if (areas.length && areas.every((a) => a !== null)) return Math.max(...areas);
    return parseHa(revir.area);
  }
  const limitApplies = (limit, revir) => limit.maxAreaHa === undefined || limit.maxAreaHa === null || (ticketAreaHa(revir) ?? Infinity) <= limit.maxAreaHa;
  function periodRange(period, date) {
    if (period === "week") { const from = time.weekStart(date); return { from, to: time.addDays(from, 6) }; }
    if (period === "month") return { from: `${date.slice(0, 8)}01`, to: time.monthEnd(date) };
    return { from: date, to: date };
  }
  // Přehled limitů pro místenku: denní (jen tato místenka) + týdenní a měsíční (všechny místenky člena v období).
  function limitsFor(ticket) {
    const revir = revirOf(ticket);
    const rules = revirRules(revir);
    if (!rules) return [];
    const speciesIdOf = (name) => findSpecies(rules, name)?.id || null;
    const own = db.prepare("SELECT species FROM catches WHERE ticket_id = ?").all(ticket.id).map((c) => speciesIdOf(c.species));
    const out = [];
    for (const limit of rules.dailyLimits || []) {
      const count = own.filter((id) => id && limit.species.includes(id)).length;
      out.push({ id: limit.id, label: limit.label, period: "day", from: ticket.fishing_date, to: ticket.fishing_date, maxCount: limit.maxCount, count, exceeded: count > limit.maxCount, source: limit.source || "" });
    }
    for (const limit of rules.periodLimits || []) {
      if (!limitApplies(limit, revir)) continue;
      const range = periodRange(limit.period, ticket.fishing_date);
      const tickets = db.prepare("SELECT id, revir_id FROM tickets WHERE member_id = ? AND status = 'issued' AND fishing_date BETWEEN ? AND ?").all(ticket.member_id, range.from, range.to)
        .filter((t) => limitApplies(limit, revirOf(t)));
      let count = 0;
      for (const t of tickets) {
        count += db.prepare("SELECT species FROM catches WHERE ticket_id = ?").all(t.id).filter((c) => limit.species.includes(speciesIdOf(c.species))).length;
      }
      out.push({ id: limit.id, label: limit.label, period: limit.period, ...range, maxCount: limit.maxCount, count, exceeded: count > limit.maxCount, source: limit.source || "" });
    }
    return out;
  }
  function activeBlock(memberId) {
    return db.prepare("SELECT * FROM member_blocks WHERE member_id = ? AND lifted_at IS NULL AND (until IS NULL OR until >= ?) ORDER BY id DESC").get(memberId, time.pragueToday()) || null;
  }
  // Při odevzdání: zapíše překročené limity, upozorní správce, případně automaticky zablokuje (limitPolicy).
  function recordViolations(ticket) {
    const exceeded = limitsFor(ticket).filter((l) => l.exceeded);
    if (!exceeded.length) return [];
    const now = iso(time.now());
    const insert = db.prepare("INSERT INTO limit_violations (ticket_id, member_id, limit_id, label, period, period_from, period_to, count, max_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const l of exceeded) insert.run(ticket.id, ticket.member_id, l.id, l.label, l.period, l.from, l.to, l.count, l.maxCount, now);
    if (config.organization.managerEmail) enqueueEmail(ticket, "limit_exceeded", null, { to: config.organization.managerEmail, limits: exceeded });
    applyPenalty(ticket, "limits", { limits: exceeded });
    return exceeded;
  }

  // Následky porušení pravidel: po N případech v kalendářním roce (dle dne lovu) automatická blokace nákupu.
  // limits = místenky s překročeným limitem (limitPolicy), late_return = opožděně odevzdané (+ volitelně neodevzdané),
  // seizure = zadržené porybným (penaltyPolicy). Držitel dostane e-mail, správce blokaci vidí a může ji zrušit.
  const PENALTY_LABELS = { limits: "překročení limitů úlovků", late_return: "pozdní odevzdání místenky", seizure: "zadržení místenky porybným" };
  function penaltyRule(cause) {
    if (cause === "limits") { const p = config.limitPolicy || {}; return { count: p.violationsBeforeBlock || 0, blockDays: p.blockDays ?? null }; }
    if (cause === "late_return") return config.penaltyPolicy.lateReturn;
    return config.penaltyPolicy.seizure;
  }
  function penaltyCount(memberId, year, cause) {
    if (cause === "limits") return db.prepare("SELECT COUNT(DISTINCT v.ticket_id) AS n FROM limit_violations v JOIN tickets t ON t.id = v.ticket_id WHERE v.member_id = ? AND substr(t.fishing_date, 1, 4) = ?").get(memberId, year).n;
    if (cause === "seizure") return db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE member_id = ? AND seized_at IS NOT NULL AND substr(fishing_date, 1, 4) = ?").get(memberId, year).n;
    const unreturned = config.penaltyPolicy.lateReturn.includeUnreturned ? " OR (closed_at IS NOT NULL AND returned_at IS NULL)" : "";
    return db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE member_id = ? AND status = 'issued' AND substr(fishing_date, 1, 4) = ? AND ((returned_at IS NOT NULL AND return_late = 1)${unreturned})`).get(memberId, year).n;
  }
  function applyPenalty(ticket, cause, extra = {}) {
    const rule = penaltyRule(cause);
    if (!(rule.count > 0) || !ticket.member_id || activeBlock(ticket.member_id)) return null;
    const year = ticket.fishing_date.slice(0, 4);
    const count = penaltyCount(ticket.member_id, year, cause);
    if (count < rule.count) return null;
    const now = iso(time.now());
    const until = rule.blockDays ? time.addDays(time.pragueToday(), rule.blockDays - 1) : `${year}-12-31`;
    const reason = `Opakované ${PENALTY_LABELS[cause]} (${count}× v roce ${year})`;
    const id = Number(db.prepare("INSERT INTO member_blocks (member_id, reason, until, source, cause, created_at) VALUES (?, ?, ?, 'auto', ?, ?)").run(ticket.member_id, reason, until, cause, now).lastInsertRowid);
    const block = db.prepare("SELECT * FROM member_blocks WHERE id = ?").get(id);
    db.prepare("INSERT INTO audit_events (at, action, target_type, target_id, detail) VALUES (?, 'member_blocked_auto', 'member', ?, ?)").run(now, ticket.member_id, JSON.stringify({ cause, count, until }));
    enqueueEmail(ticket, "member_blocked", null, { block, ...extra });
    return block;
  }

  // ---------- správa limitů a blokací (manažerský portál) ----------
  const blockShape = (b) => {
    const holder = db.prepare("SELECT first_name, last_name FROM tickets WHERE member_id = ? ORDER BY id DESC").get(b.member_id);
    return { id: b.id, memberId: b.member_id, holder: holder ? `${holder.first_name} ${holder.last_name}` : "", reason: b.reason, until: b.until, source: b.source, cause: b.cause || (b.source === "manual" ? "manual" : "limits"),
      createdAt: b.created_at, liftedAt: b.lifted_at, active: !b.lifted_at && (!b.until || b.until >= time.pragueToday()) };
  };
  function listViolations() {
    const rows = db.prepare(`SELECT v.*, t.code, t.first_name, t.last_name, t.fishing_date FROM limit_violations v JOIN tickets t ON t.id = v.ticket_id ORDER BY v.id DESC LIMIT 200`).all();
    return { violations: rows.map((v) => ({ id: v.id, code: v.code, date: v.fishing_date, memberId: v.member_id, holder: `${v.first_name} ${v.last_name}`, label: v.label, period: v.period, from: v.period_from, to: v.period_to, count: v.count, maxCount: v.max_count, createdAt: v.created_at, blocked: Boolean(activeBlock(v.member_id)) })) };
  }
  function listBlocks() {
    return { blocks: db.prepare("SELECT * FROM member_blocks ORDER BY (lifted_at IS NULL) DESC, id DESC LIMIT 200").all().map(blockShape) };
  }
  function createBlock(actor, body = {}) {
    const memberId = String(body.memberId || "").replace(/\s+/g, "");
    if (!/^\d{8}$/.test(memberId)) throw new ApiError(400, "invalid_member_id", "Zadejte 8místné číslo členské legitimace.");
    const reason = String(body.reason || "").trim();
    if (reason.length < 3 || reason.length > 500) throw new ApiError(400, "invalid_reason", "Uveďte důvod blokace (3–500 znaků).");
    const until = body.until ? String(body.until) : null;
    if (until && (!time.isIsoDate(until) || until < time.pragueToday())) throw new ApiError(400, "invalid_date", "Datum konce blokace musí být dnes nebo později.");
    return transaction(db, () => {
      if (activeBlock(memberId)) throw new ApiError(409, "already_blocked", "Toto číslo legitimace už je zablokované.");
      const now = iso(time.now());
      const result = db.prepare("INSERT INTO member_blocks (member_id, reason, until, source, cause, created_by, created_at) VALUES (?, ?, ?, 'manual', 'manual', ?, ?)").run(memberId, reason, until, actor.id, now);
      db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'member_blocked', 'member', ?, ?)").run(now, actor.id, memberId, JSON.stringify({ reason, until }));
      return { block: blockShape(db.prepare("SELECT * FROM member_blocks WHERE id = ?").get(Number(result.lastInsertRowid))) };
    });
  }
  function liftBlock(actor, id) {
    return transaction(db, () => {
      const block = db.prepare("SELECT * FROM member_blocks WHERE id = ?").get(Number(id));
      if (!block) throw new ApiError(404, "not_found", "Blokace neexistuje.");
      if (block.lifted_at) throw new ApiError(409, "already_lifted", "Blokace už byla zrušena.");
      const now = iso(time.now());
      db.prepare("UPDATE member_blocks SET lifted_at = ?, lifted_by = ? WHERE id = ?").run(now, actor.id, block.id);
      db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id) VALUES (?, ?, 'member_unblocked', 'member', ?)").run(now, actor.id, block.member_id);
      return { block: blockShape(db.prepare("SELECT * FROM member_blocks WHERE id = ?").get(block.id)) };
    });
  }
  // Limity přihlášeného člena pro dnešek (týden/měsíc) na zvoleném revíru.
  function limitsForMember(user, revirId) {
    if (!user.member_id) return { date: time.pragueToday(), limits: [], blocked: null };
    const revir = getRevir(config, revirId) || config.reviry[0];
    const date = time.pragueToday();
    const limits = limitsFor({ id: 0, member_id: user.member_id, fishing_date: date, revir_id: revir.id }).filter((l) => l.period !== "day");
    const block = activeBlock(user.member_id);
    return { date, revirId: revir.id, limits, blocked: block ? blockShape(block) : null };
  }

  // ---------- porybný (B2) ----------
  const catchesOf = (ticketId) => db.prepare("SELECT species, length_cm, weight_kg, weight_estimated FROM catches WHERE ticket_id = ? ORDER BY id").all(ticketId)
    .map((c) => ({ species: c.species, length: c.length_cm, weight: c.weight_kg, weightEstimated: Boolean(c.weight_estimated) }));
  // Plné údaje pro porybného + místenky téhož člena v týdnu a měsíci dne lovu (podklad pro limity, B3).
  function wardenView(ticket) {
    const base = publicTicket(ticket);
    const week = { from: time.weekStart(ticket.fishing_date), to: time.addDays(time.weekStart(ticket.fishing_date), 6) };
    const month = { from: `${ticket.fishing_date.slice(0, 8)}01`, to: time.monthEnd(ticket.fishing_date) };
    const from = week.from < month.from ? week.from : month.from;
    const to = week.to > month.to ? week.to : month.to;
    const history = db.prepare("SELECT * FROM tickets WHERE member_id = ? AND status = 'issued' AND fishing_date BETWEEN ? AND ? ORDER BY fishing_date, id").all(ticket.member_id, from, to)
      .map((t) => ({
        code: t.code, date: t.fishing_date, revir: revirOf(t).name, status: stateOf(t), current: t.id === ticket.id,
        inWeek: t.fishing_date >= week.from && t.fishing_date <= week.to, inMonth: t.fishing_date >= month.from && t.fishing_date <= month.to,
        noCatch: Boolean(t.no_catch), catches: catchesOf(t.id)
      }));
    const checks = db.prepare("SELECT warden_name, at, status FROM ticket_checks WHERE ticket_id = ? ORDER BY at DESC LIMIT 20").all(ticket.id)
      .map((c) => ({ wardenName: c.warden_name, at: c.at, status: c.status }));
    let seizure = null;
    if (ticket.seized_at) {
      const by = ticket.seized_by ? db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(ticket.seized_by) : null;
      seizure = { at: ticket.seized_at, reason: ticket.seized_reason, place: ticket.seized_place || "", wardenName: by ? `${by.first_name} ${by.last_name}` : "" };
    }
    return {
      ...base,
      holder: undefined,
      firstName: ticket.first_name, lastName: ticket.last_name, birthDate: ticket.birth_date, memberId: ticket.member_id,
      returnedAt: ticket.returned_at, noCatch: Boolean(ticket.no_catch), catches: catchesOf(ticket.id),
      seizable: stateOf(ticket) === "active",
      seizure, checks, memberHistory: { week, month, tickets: history },
      limits: limitsFor(ticket),
      blocked: activeBlock(ticket.member_id) ? blockShape(activeBlock(ticket.member_id)) : null
    };
  }
  const wardenName = (user) => `${user.first_name} ${user.last_name}`;
  // Každé otevření místenky porybným je kontrola; opakované otevření do 10 minut se nezapisuje znovu.
  function wardenCheck(code, warden) {
    const ticket = findTicket(code);
    if (ticket.status !== "issued") throw new ApiError(409, "not_issued", "Místenka nebyla vystavena (nezaplacená nebo zrušená) a neopravňuje k lovu.");
    const now = time.now();
    const recent = db.prepare("SELECT 1 FROM ticket_checks WHERE ticket_id = ? AND user_id = ? AND at > ?").get(ticket.id, warden.id, iso(new Date(now.getTime() - 10 * 60_000)));
    if (!recent) db.prepare("INSERT INTO ticket_checks (ticket_id, user_id, warden_name, at, status) VALUES (?, ?, ?, ?, ?)").run(ticket.id, warden.id, wardenName(warden), iso(now), stateOf(ticket, now));
    return wardenView(ticket);
  }
  function seizeTicket(code, warden, body = {}) {
    const reason = String(body.reason || "").trim();
    const place = String(body.place || "").trim();
    if (reason.length < 3 || reason.length > 500) throw new ApiError(400, "invalid_reason", "Uveďte důvod zadržení (3–500 znaků).");
    if (place.length > 200) throw new ApiError(400, "invalid_place", "Místo může mít nejvýše 200 znaků.");
    const ticket = findTicket(code);
    return transaction(db, () => {
      const fresh = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
      const state = stateOf(fresh);
      if (fresh.seized_at) throw new ApiError(409, "already_seized", "Místenka už byla zadržena.");
      if (state !== "active") throw new ApiError(409, "not_seizable", "Zadržet lze jen místenku platnou v den lovu.");
      const now = iso(time.now());
      db.prepare("UPDATE tickets SET seized_at = ?, seized_by = ?, seized_reason = ?, seized_place = ? WHERE id = ?").run(now, warden.id, reason, place || null, fresh.id);
      db.prepare("INSERT INTO ticket_checks (ticket_id, user_id, warden_name, at, status) VALUES (?, ?, ?, ?, 'seized')").run(fresh.id, warden.id, wardenName(warden), now);
      db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'ticket_seized', 'ticket', ?, ?)").run(now, warden.id, fresh.code, JSON.stringify({ reason, place }));
      const seized = db.prepare("SELECT * FROM tickets WHERE id = ?").get(fresh.id);
      // Držitel: e-mail s odkazem na odevzdání. Správce: jen upozornění (nepotvrzuje).
      enqueueEmail(seized, "ticket_seized", issueToken(seized.id, "email"), { deadline: iso(windowOf(seized).deadline) });
      applyPenalty(seized, "seizure");
      if (config.organization.managerEmail) enqueueEmail(seized, "seizure_notice", null, { to: config.organization.managerEmail, wardenName: wardenName(warden) });
      return wardenView(seized);
    });
  }

  function checkVoucher(code) {
    const normalized = normalizeCode(code);
    if (!VOUCHER_RE.test(normalized)) throw new ApiError(400, "invalid_voucher", "Kód poukazu musí mít 16 znaků A–Z nebo 0–9.");
    const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ?").get(normalized);
    return { code: normalized, valid: Boolean(voucher && !voucher.used_at && !voucher.voided_at), usedAt: voucher?.used_at || null, revirId: voucher?.revir_id || null };
  }

  // Vytvoření poukazu (zatím jen vývojový endpoint, později administrace).
  function createVoucher({ code, revirId = null } = {}) {
    const normalized = normalizeCode(code) || Array.from({ length: 16 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
    if (!VOUCHER_RE.test(normalized)) throw new ApiError(400, "invalid_voucher", "Kód poukazu musí mít 16 znaků A–Z nebo 0–9.");
    if (revirId && !getRevir(config, revirId)) throw new ApiError(400, "unknown_revir", "Revír neexistuje.");
    if (db.prepare("SELECT 1 FROM vouchers WHERE code = ?").get(normalized)) throw new ApiError(409, "voucher_exists", "Poukaz už existuje.");
    db.prepare("INSERT INTO vouchers (code, revir_id) VALUES (?, ?)").run(normalized, revirId);
    return checkVoucher(normalized);
  }

  // ---------- správa místenek, plateb a poukazů (B4) ----------
  const audit = (actor, action, targetType, targetId, detail = null) => db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(iso(time.now()), actor?.id ?? null, action, targetType, String(targetId), detail ? JSON.stringify(detail) : null);
  const TICKET_FILTER_STATES = ["pending_payment", "payment_expired", "cancelled", "future", "active", "expired_unreturned", "closed_unreturned", "expired_returned", "seized"];
  function manageRow(t) {
    const status = stateOf(t);
    const catchCount = db.prepare("SELECT COUNT(*) AS n FROM catches WHERE ticket_id = ?").get(t.id).n;
    return {
      code: t.code, date: t.fishing_date, revirId: t.revir_id, revir: revirOf(t).name, firstName: t.first_name, lastName: t.last_name, memberId: t.member_id, email: t.email,
      status, late: publicTicket(t).late, seized: Boolean(t.seized_at), priceHalere: t.price_halere, amountDueHalere: t.amount_due_halere, voucherUsed: Boolean(t.voucher_code),
      catchCount, noCatch: Boolean(t.no_catch), createdAt: t.created_at, paidAt: t.paid_at, returnedAt: t.returned_at, account: Boolean(t.user_id)
    };
  }
  // Filtry: status (stav v API), revirId, from/to (den lovu), q (kód, jméno, číslo legitimace, e-mail).
  function searchTickets(filters = {}) {
    const where = [];
    const params = [];
    if (filters.revirId) { where.push("revir_id = ?"); params.push(String(filters.revirId)); }
    if (filters.from) { if (!time.isIsoDate(filters.from)) throw new ApiError(400, "invalid_date", "Neplatné datum od."); where.push("fishing_date >= ?"); params.push(filters.from); }
    if (filters.to) { if (!time.isIsoDate(filters.to)) throw new ApiError(400, "invalid_date", "Neplatné datum do."); where.push("fishing_date <= ?"); params.push(filters.to); }
    const q = String(filters.q || "").trim().toLowerCase();
    if (q) {
      where.push("(lower(code) = ? OR member_id LIKE ? OR lower(first_name || ' ' || last_name) LIKE ? OR lower(email) LIKE ? OR variable_symbol = ?)");
      params.push(q, `%${q.replace(/\s+/g, "")}%`, `%${q}%`, `%${q}%`, q);
    }
    if (filters.status && !TICKET_FILTER_STATES.includes(filters.status)) throw new ApiError(400, "invalid_status", "Neznámý stav.");
    const rows = db.prepare(`SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY fishing_date DESC, id DESC LIMIT 5000`).all(...params)
      .filter((t) => !filters.status || stateOf(t) === filters.status);
    return rows;
  }
  function listTickets(filters = {}) {
    const rows = searchTickets(filters);
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    return { total: rows.length, tickets: rows.slice(offset, offset + limit).map(manageRow) };
  }
  function ticketsCsv(filters = {}) {
    const cell = (value) => { const text = String(value ?? ""); return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const header = ["Kód", "Revír", "Datum lovu", "Jméno", "Příjmení", "Č. legitimace", "E-mail", "Stav", "Opožděně", "Zadržena", "Cena Kč", "Zaplaceno Kč", "Poukaz", "Úlovky", "Bez úlovku", "Vytvořeno", "Zaplaceno", "Odevzdáno"];
    const lines = searchTickets(filters).map((t) => {
      const r = manageRow(t);
      const catches = db.prepare("SELECT species, length_cm, weight_kg FROM catches WHERE ticket_id = ? ORDER BY id").all(t.id).map((c) => `${c.species} ${c.length_cm} cm${c.weight_kg ? ` ${c.weight_kg} kg` : ""}`).join(", ");
      return [r.code, r.revir, r.date, r.firstName, r.lastName, r.memberId, r.email, r.status, r.late ? "ano" : "", r.seized ? "ano" : "", (r.priceHalere / 100).toFixed(2).replace(".", ","), (t.paid_at ? r.amountDueHalere / 100 : 0).toFixed(2).replace(".", ","), r.voucherUsed ? "ano" : "", catches, r.noCatch ? "ano" : "", r.createdAt, r.paidAt || "", r.returnedAt || ""].map(cell).join(";");
    });
    return "\uFEFF" + [header.join(";"), ...lines].join("\r\n") + "\r\n"; // BOM + středník: Excel v češtině
  }
  function ticketDetail(code) {
    const ticket = findTicket(code);
    const payments = db.prepare("SELECT * FROM bank_transactions WHERE ticket_id = ? ORDER BY id").all(ticket.id).map(paymentShape);
    const checks = db.prepare("SELECT warden_name, at, status FROM ticket_checks WHERE ticket_id = ? ORDER BY at DESC").all(ticket.id).map((c) => ({ wardenName: c.warden_name, at: c.at, status: c.status }));
    const violations = db.prepare("SELECT label, period, period_from, period_to, count, max_count FROM limit_violations WHERE ticket_id = ? ORDER BY id").all(ticket.id)
      .map((v) => ({ label: v.label, period: v.period, from: v.period_from, to: v.period_to, count: v.count, maxCount: v.max_count }));
    const sentEmails = db.prepare("SELECT kind, to_email, subject, created_at, sent_at, error, sender FROM email_outbox WHERE ticket_id = ? ORDER BY id").all(ticket.id)
      .map((e) => ({ kind: e.kind, to: e.to_email, subject: e.subject, createdAt: e.created_at, sentAt: e.sent_at, error: e.error, sender: e.sender || null }));
    const cancellation = ticket.cancelled_at ? { at: ticket.cancelled_at, reason: ticket.cancel_reason || "zrušeno držitelem před zaplacením", byManager: Boolean(ticket.cancelled_by) } : null;
    return { ticket: { ...ownerTicket(ticket), variableSymbol: ticket.variable_symbol, account: Boolean(ticket.user_id), rulesVersion: ticket.rules_version || null }, payments, checks, violations, emails: sentEmails, cancellation, cancellable: ["pending_payment", "payment_expired", "future", "active", "expired_unreturned", "seized"].includes(stateOf(ticket)) };
  }
  // Zrušení správcem: vystavená neodevzdaná místenka nebo objednávka. Peníze se nevracejí automaticky.
  function cancelByManager(actor, code, body = {}) {
    const reason = String(body.reason || "").trim();
    if (reason.length < 3 || reason.length > 300) throw new ApiError(400, "invalid_reason", "Uveďte důvod zrušení (3–300 znaků).");
    const ticket = findTicket(code);
    return transaction(db, () => {
      const fresh = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
      const state = stateOf(fresh);
      if (!["pending_payment", "payment_expired", "future", "active", "expired_unreturned", "seized"].includes(state)) throw new ApiError(409, "not_cancellable", "Zrušit nelze odevzdanou, uzavřenou ani už zrušenou místenku.");
      const now = iso(time.now());
      db.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, cancelled_by = ?, reserved_until = NULL WHERE id = ?").run(now, reason, actor.id, fresh.id);
      const cancelled = db.prepare("SELECT * FROM tickets WHERE id = ?").get(fresh.id);
      if (fresh.status === "issued") enqueueEmail(cancelled, "ticket_cancelled", null);
      audit(actor, "ticket_cancelled", "ticket", fresh.code, { reason, previous: state, paid: Boolean(fresh.paid_at) });
      return ticketDetail(fresh.code);
    });
  }

  const OPEN_RESULTS = ["unmatched", "amount_mismatch", "duplicate_payment", "late"];
  function paymentShape(p) {
    const ticket = p.ticket_id ? db.prepare("SELECT code, first_name, last_name, status FROM tickets WHERE id = ?").get(p.ticket_id) : null;
    return {
      id: p.id, provider: p.provider, transactionId: p.transaction_id, bookedAt: p.booked_at, amountHalere: p.amount_halere, currency: p.currency, variableSymbol: p.variable_symbol,
      counterAccount: p.counter_account, counterName: p.counter_name, message: p.message, result: p.result, note: p.note, createdAt: p.created_at,
      ticket: ticket ? { code: ticket.code, holder: `${ticket.first_name} ${ticket.last_name}` } : null,
      needsAction: OPEN_RESULTS.includes(p.result) && !p.resolved_at,
      resolution: p.resolved_at ? { action: p.resolution, note: p.resolution_note, at: p.resolved_at } : null
    };
  }
  // Fronta plateb: state=open (k vyřešení, výchozí) | all.
  function listPayments({ state = "open" } = {}) {
    const rows = state === "all"
      ? db.prepare("SELECT * FROM bank_transactions ORDER BY id DESC LIMIT 500").all()
      : db.prepare(`SELECT * FROM bank_transactions WHERE resolved_at IS NULL AND result IN (${OPEN_RESULTS.map(() => "?").join(",")}) ORDER BY id`).all(...OPEN_RESULTS);
    return { payments: rows.map(paymentShape) };
  }
  // Ruční vyřešení: assign = vystavit místenku k objednávce (správce přebírá odpovědnost za částku i kapacitu),
  // refunded = peníze vráceny v bankovnictví, ignored = bez akce (např. jiná platba na účet).
  function resolvePayment(actor, id, body = {}) {
    const action = String(body.action || "");
    if (!["assign", "refunded", "ignored"].includes(action)) throw new ApiError(400, "invalid_action", "Akce musí být assign, refunded nebo ignored.");
    const note = String(body.note || "").trim().slice(0, 300);
    return transaction(db, () => {
      const payment = db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(Number(id));
      if (!payment) throw new ApiError(404, "not_found", "Platba neexistuje.");
      if (payment.resolved_at || !OPEN_RESULTS.includes(payment.result)) throw new ApiError(409, "already_resolved", "Platba už je vyřešená.");
      let ticketId = payment.ticket_id;
      if (action === "assign") {
        const ticket = body.ticketCode ? findTicket(body.ticketCode) : ticketId ? db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) : null;
        if (!ticket) throw new ApiError(400, "ticket_required", "Zadejte kód místenky, ke které platba patří.");
        if (ticket.status === "issued" || ticket.paid_at) throw new ApiError(409, "already_paid", "Místenka už je zaplacená – platbu vraťte.");
        if (!["pending_payment", "payment_expired", "cancelled"].includes(ticket.status)) throw new ApiError(409, "not_assignable", "K této místence nelze platbu přiřadit.");
        issuePaid(ticket);
        ticketId = ticket.id;
      }
      db.prepare("UPDATE bank_transactions SET resolution = ?, resolution_note = ?, resolved_at = ?, resolved_by = ?, ticket_id = ? WHERE id = ?").run(action === "assign" ? "assigned" : action, note || null, iso(time.now()), actor.id, ticketId, payment.id);
      audit(actor, "payment_resolved", "payment", payment.id, { action, note, ticketId });
      return { payment: paymentShape(db.prepare("SELECT * FROM bank_transactions WHERE id = ?").get(payment.id)) };
    });
  }

  const voucherShape = (v) => ({ code: v.code, revirId: v.revir_id, revir: v.revir_id ? getRevir(config, v.revir_id)?.name || v.revir_id : "Všechny revíry", note: v.note || "", createdAt: v.created_at, usedAt: v.used_at, ticketCode: v.ticket_code, voidedAt: v.voided_at,
    state: v.voided_at ? "voided" : v.used_at ? "used" : "valid" });
  function listVouchers() {
    return { vouchers: db.prepare("SELECT * FROM vouchers ORDER BY (used_at IS NULL AND voided_at IS NULL) DESC, COALESCE(created_at, '') DESC, code LIMIT 1000").all().map(voucherShape) };
  }
  function generateVouchers(actor, body = {}) {
    const count = Number(body.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, "invalid_count", "Počet poukazů 1–50.");
    const revirId = body.revirId ? String(body.revirId) : null;
    if (revirId && !getRevir(config, revirId)) throw new ApiError(400, "unknown_revir", "Revír neexistuje.");
    const note = String(body.note || "").trim().slice(0, 200);
    return transaction(db, () => {
      const now = iso(time.now());
      const codes = [];
      while (codes.length < count) {
        const code = Array.from({ length: 16 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
        if (db.prepare("SELECT 1 FROM vouchers WHERE code = ?").get(code)) continue;
        db.prepare("INSERT INTO vouchers (code, revir_id, created_at, created_by, note) VALUES (?, ?, ?, ?, ?)").run(code, revirId, now, actor.id, note || null);
        codes.push(code);
      }
      audit(actor, "vouchers_created", "voucher", codes.length, { revirId, note, codes });
      return { vouchers: codes.map((code) => voucherShape(db.prepare("SELECT * FROM vouchers WHERE code = ?").get(code))) };
    });
  }
  function voidVoucher(actor, code) {
    const normalized = normalizeCode(code);
    const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ?").get(normalized);
    if (!voucher) throw new ApiError(404, "not_found", "Poukaz neexistuje.");
    if (voucher.used_at || voucher.voided_at) throw new ApiError(409, "not_voidable", "Použitý nebo už zneplatněný poukaz nelze zneplatnit.");
    db.prepare("UPDATE vouchers SET voided_at = ? WHERE code = ?").run(iso(time.now()), normalized);
    audit(actor, "voucher_voided", "voucher", normalized);
    return { voucher: voucherShape(db.prepare("SELECT * FROM vouchers WHERE code = ?").get(normalized)) };
  }

  // ---------- platby ----------
  function issuePaid(ticket) {
    const now = iso(time.now());
    db.prepare("UPDATE tickets SET status = 'issued', paid_at = ?, issued_at = ?, reserved_until = NULL WHERE id = ?").run(now, now, ticket.id);
    const issued = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
    enqueueEmail(issued, "ticket_issued", issueToken(issued.id, "email"));
  }

  function processTransaction(tx) {
    return transaction(db, () => {
      if (db.prepare("SELECT 1 FROM bank_transactions WHERE provider = ? AND transaction_id = ?").get(provider.name, tx.transactionId)) return "already_processed";
      let result;
      let note = null;
      let ticketId = null;
      if (!(tx.amountHalere > 0)) {
        result = "ignored";
      } else {
        const vs = String(tx.variableSymbol || "").replace(/^0+/, "");
        const ticket = vs ? db.prepare("SELECT * FROM tickets WHERE variable_symbol = ?").get(vs) : null;
        if (!ticket) {
          result = "unmatched";
        } else {
          ticketId = ticket.id;
          if (tx.currency !== "CZK" || tx.amountHalere !== ticket.amount_due_halere) {
            result = "amount_mismatch";
            note = `očekáváno ${ticket.amount_due_halere} haléřů CZK`;
          } else if (ticket.status === "issued" || ticket.paid_at) {
            result = "duplicate_payment";
          } else if (ticket.status === "cancelled") {
            result = "late";
            note = "objednávka byla zrušena";
          } else {
            const pending = stateOf(ticket) === "pending_payment";
            const dayNotOver = time.pragueToday() <= ticket.fishing_date;
            const revir = revirOf(ticket);
            const seatFree = dayNotOver && takenSeats(ticket.revir_id, ticket.fishing_date, ticket.id) < (revir.dailyCapacity || 0);
            if (pending || seatFree) {
              issuePaid(ticket);
              result = "matched";
            } else {
              result = "late";
              note = dayNotOver ? "rezervace vypršela a místo už není volné" : "den lovu už uplynul";
            }
          }
        }
      }
      db.prepare(`INSERT INTO bank_transactions (provider, transaction_id, booked_at, amount_halere, currency, variable_symbol, counter_account, counter_name, message, ticket_id, result, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(provider.name, tx.transactionId, tx.bookedAt, tx.amountHalere, tx.currency, tx.variableSymbol || null,
        tx.counterAccount || null, tx.counterName || null, tx.message || null, ticketId, result, note, iso(time.now()));
      return result;
    });
  }

  let lastSync = 0;
  async function syncPayments(force = false) {
    if (!force && Date.now() - lastSync < provider.minIntervalMs) return { skipped: true, results: [] };
    lastSync = Date.now();
    const transactions = await provider.fetchTransactions();
    return { skipped: false, results: transactions.map(processTransaction) };
  }

  function expireReservations() {
    return db.prepare("UPDATE tickets SET status = 'payment_expired' WHERE status = 'pending_payment' AND reserved_until <= ?").run(iso(time.now())).changes;
  }

  function sendReminders() {
    const now = time.now();
    const candidates = db.prepare("SELECT * FROM tickets WHERE status = 'issued' AND returned_at IS NULL AND reminder_sent_at IS NULL AND fishing_date <= ?").all(time.pragueToday(now));
    let sent = 0;
    for (const ticket of candidates) {
      const state = stateOf(ticket, now);
      if (!(state === "expired_unreturned" || (state === "seized" && now >= windowOf(ticket).end)) || !isReturnable(ticket, now)) continue;
      transaction(db, () => {
        enqueueEmail(ticket, "return_reminder", issueToken(ticket.id, "email"), { deadline: iso(windowOf(ticket).deadline) });
        db.prepare("UPDATE tickets SET reminder_sent_at = ? WHERE id = ?").run(iso(now), ticket.id);
      });
      sent += 1;
    }
    return sent;
  }

  // Po uplynutí lhůty pro opožděné odevzdání se místenka uzavře jako neodevzdaná (bez úlovku)
  // a držitel dostane e-mail. Následky (blokace) podle penaltyPolicy.lateReturn.
  function closeOverdue() {
    const now = time.now();
    const candidates = db.prepare("SELECT * FROM tickets WHERE status = 'issued' AND returned_at IS NULL AND closed_at IS NULL AND fishing_date <= ?").all(time.pragueToday(now));
    let closed = 0;
    for (const ticket of candidates) {
      if (now < windowOf(ticket).deadline) continue;
      transaction(db, () => {
        db.prepare("UPDATE tickets SET closed_at = ? WHERE id = ? AND closed_at IS NULL AND returned_at IS NULL").run(iso(now), ticket.id);
        const closedTicket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
        enqueueEmail(closedTicket, "ticket_closed", null);
        if (config.penaltyPolicy.lateReturn.includeUnreturned) applyPenalty(closedTicket, "late_return");
      });
      closed += 1;
    }
    return closed;
  }

  // Odesílatel podle skupiny e-mailu (SMTP účet z portálu, jinak výchozí) – viz mail-accounts.js.
  async function deliverOutbox() {
    const pending = db.prepare("SELECT * FROM email_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20").all();
    for (const mail of pending) {
      try {
        const sender = mailAccounts ? mailAccounts.senderFor(mail.kind) : { from: null, account: null, label: "výchozí" };
        await mailer.send({ id: mail.id, to: mail.to_email, subject: mail.subject, html: mail.body_html, text: mail.body_text, from: sender.from, account: sender.account });
        db.prepare("UPDATE email_outbox SET sent_at = ?, error = NULL, sender = ? WHERE id = ?").run(iso(time.now()), sender.label, mail.id);
      } catch (error) {
        db.prepare("UPDATE email_outbox SET error = ? WHERE id = ?").run(String(error.message).slice(0, 500), mail.id);
      }
    }
    return pending.length;
  }

  // Plánované úlohy: v Node běží v intervalu, ve WordPressu je spustí cron hostingu.
  const extraJobs = [];
  const addJob = (name, fn) => extraJobs.push([name, fn]);
  async function runJobs({ force = false } = {}) {
    const report = {};
    const step = async (name, fn) => {
      try { report[name] = await fn(); } catch (error) { report[name] = { error: error.message }; console.error(`[úloha ${name}]`, error.message); }
    };
    await step("expired", () => expireReservations());
    await step("payments", () => syncPayments(force));
    await step("reminders", () => sendReminders());
    await step("closed", () => closeOverdue());
    for (const [name, fn] of extraJobs) await step(name, fn);
    await step("emails", () => deliverOutbox());
    return report;
  }

  // Jen falešná banka: simulace příchozí platby (vývoj a demo).
  async function simulatePayment(input = {}) {
    if (provider.name !== "fake") throw new ApiError(404, "not_found", "Simulace plateb je dostupná jen s falešnou bankou.");
    let variableSymbol = String(input.variableSymbol || "");
    let amountHalere = input.amountHalere;
    if (input.code) {
      const ticket = findTicket(input.code);
      variableSymbol ||= ticket.variable_symbol || "";
      amountHalere ??= ticket.amount_due_halere;
    }
    if (!variableSymbol || !(Number(amountHalere) > 0)) throw new ApiError(400, "invalid_payment", "Zadejte kód místenky nebo variabilní symbol a částku.");
    provider.push({ variableSymbol, amountHalere: Number(amountHalere), currency: input.currency || "CZK" });
    const report = await runJobs({ force: true });
    return { result: report.payments?.results?.[0] || null };
  }

  return { availability, createOrder, getPublicTicket, getOwnerTicket, ticketsForUser, wardenCheck, seizeTicket, listTickets, ticketsCsv, ticketDetail, cancelByManager, listPayments, resolvePayment, listVouchers, generateVouchers, voidVoucher, listViolations, listBlocks, createBlock, liftBlock, limitsForMember, cancelOrder, submitReturn, checkVoucher, createVoucher, runJobs, addJob, simulatePayment, processTransaction, stateOf };
}

module.exports = { createService, ApiError };
