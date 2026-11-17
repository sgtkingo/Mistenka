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

function createService({ db, config, provider, mailer, appUrl }) {
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
    if (at < w.start) return "future";
    if (at < w.end) return "active";
    if (at < w.deadline && !ticket.closed_at) return "expired_unreturned";
    return "closed_unreturned";
  }
  function isReturnable(ticket, at = time.now()) {
    const state = stateOf(ticket, at);
    return state === "active" || state === "expired_unreturned";
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
    const render = { payment_instructions: emails.paymentInstructions, ticket_issued: emails.ticketIssued, return_reminder: emails.returnReminder, ticket_closed: emails.ticketClosed }[kind];
    const mail = render(config, { ticket, revir, links: links(ticket, token), ...extra });
    db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ticket.id, kind, ticket.email, mail.subject, mail.html, mail.text, iso(time.now()));
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
      late: status === "expired_unreturned" || status === "closed_unreturned" || (status === "expired_returned" && Boolean(ticket.return_late)),
      holder: issued ? { name, memberId: maskMemberId(ticket.member_id) } : null,
      validFrom: iso(w.start),
      validTo: iso(w.end)
    };
  }
  function ownerTicket(ticket) {
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
      catches,
      payment: base.status === "pending_payment" ? paymentInfo(ticket) : null
    };
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
      days.push({ date, capacity: revir.dailyCapacity, taken, available: Math.max(0, revir.dailyCapacity - taken) });
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
      if (takenSeats(revir.id, order.date) >= revir.dailyCapacity) throw new ApiError(409, "sold_out", "Na vybraný den už nejsou volná místa.");
      if (order.voucherCode) {
        const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ?").get(order.voucherCode);
        if (!voucher || (voucher.revir_id && voucher.revir_id !== revir.id)) throw new ApiError(400, "invalid_voucher", "Poukaz není platný.");
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
    return db.prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY fishing_date DESC, id DESC LIMIT 200").all(user.id).map(ownerTicket);
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
    for (const limit of rules?.dailyLimits || []) {
      const count = catches.filter((c) => c.speciesId && limit.species.includes(c.speciesId)).length;
      if (count > limit.maxCount) throw new ApiError(400, "daily_limit", `Denní limit: nejvýše ${limit.maxCount} ks (${limit.label}). Přisvojením posledního povoleného kusu denní lov končí.`);
    }
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
      db.prepare("UPDATE tickets SET returned_at = ?, return_late = ?, no_catch = ? WHERE id = ?").run(iso(now), now >= windowOf(fresh).end ? 1 : 0, noCatch ? 1 : 0, fresh.id);
      return ownerTicket(db.prepare("SELECT * FROM tickets WHERE id = ?").get(fresh.id));
    });
  }

  function checkVoucher(code) {
    const normalized = normalizeCode(code);
    if (!VOUCHER_RE.test(normalized)) throw new ApiError(400, "invalid_voucher", "Kód poukazu musí mít 16 znaků A–Z nebo 0–9.");
    const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ?").get(normalized);
    return { code: normalized, valid: Boolean(voucher && !voucher.used_at), usedAt: voucher?.used_at || null, revirId: voucher?.revir_id || null };
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
      if (stateOf(ticket, now) !== "expired_unreturned" || !isReturnable(ticket, now)) continue;
      transaction(db, () => {
        enqueueEmail(ticket, "return_reminder", issueToken(ticket.id, "email"), { deadline: iso(windowOf(ticket).deadline) });
        db.prepare("UPDATE tickets SET reminder_sent_at = ? WHERE id = ?").run(iso(now), ticket.id);
      });
      sent += 1;
    }
    return sent;
  }

  // Po uplynutí lhůty pro opožděné odevzdání se místenka uzavře jako neodevzdaná (bez úlovku)
  // a držitel dostane e-mail. Další následky (např. blokace) zatím nejsou definované.
  function closeOverdue() {
    const now = time.now();
    const candidates = db.prepare("SELECT * FROM tickets WHERE status = 'issued' AND returned_at IS NULL AND closed_at IS NULL AND fishing_date <= ?").all(time.pragueToday(now));
    let closed = 0;
    for (const ticket of candidates) {
      if (now < windowOf(ticket).deadline) continue;
      transaction(db, () => {
        db.prepare("UPDATE tickets SET closed_at = ? WHERE id = ? AND closed_at IS NULL AND returned_at IS NULL").run(iso(now), ticket.id);
        enqueueEmail(db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id), "ticket_closed", null);
      });
      closed += 1;
    }
    return closed;
  }

  async function deliverOutbox() {
    const pending = db.prepare("SELECT * FROM email_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20").all();
    for (const mail of pending) {
      try {
        await mailer.send({ id: mail.id, to: mail.to_email, subject: mail.subject, html: mail.body_html, text: mail.body_text });
        db.prepare("UPDATE email_outbox SET sent_at = ?, error = NULL WHERE id = ?").run(iso(time.now()), mail.id);
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

  return { availability, createOrder, getPublicTicket, getOwnerTicket, ticketsForUser, cancelOrder, submitReturn, checkVoucher, createVoucher, runJobs, addJob, simulatePayment, processTransaction, stateOf };
}

module.exports = { createService, ApiError };
