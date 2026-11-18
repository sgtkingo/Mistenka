"use strict";
// Zarybnění, přehledy a uzávěrky (B6). Smlouva v docs/API.md, sekce „Zarybnění a přehledy“.
const { transaction } = require("./db");
const time = require("./time");
const emails = require("./emails");
const { getRevir } = require("./config");
const { ApiError } = require("./validate");

const iso = (date) => date.toISOString();
const AGE_CLASSES = ["plůdek", "K0", "K1", "K2", "K3", "K4", "tržní", "generační", "jiné"];

function createReports({ db, config, appUrl }) {
  const revirName = (id) => (id ? getRevir(config, id)?.name || id : "Všechny revíry");
  const audit = (actor, action, targetType, targetId, detail = null) => db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(iso(time.now()), actor?.id ?? null, action, targetType, String(targetId), detail ? JSON.stringify(detail) : null);
  function validRevir(value, { required = false } = {}) {
    if (value === null || value === undefined || value === "") {
      if (required) throw new ApiError(400, "unknown_revir", "Vyberte revír.");
      return null;
    }
    if (!getRevir(config, String(value))) throw new ApiError(400, "unknown_revir", "Revír neexistuje.");
    return String(value);
  }
  function validRange(from, to) {
    if (!time.isIsoDate(String(from || "")) || !time.isIsoDate(String(to || ""))) throw new ApiError(400, "invalid_date", "Zadejte období od–do.");
    if (to < from) throw new ApiError(400, "invalid_date", "Konec období musí být po začátku.");
    return { from: String(from), to: String(to) };
  }
  // Kanonický název druhu podle pravidel revíru (stejně jako u úlovků).
  function speciesOf(revirId, value) {
    const revir = getRevir(config, revirId) || config.reviry[0];
    const rules = revir.fishRules;
    const key = String(value || "").trim().toLowerCase();
    const known = rules?.species.find((s) => s.id === key || s.name.toLowerCase() === key || (s.aliases || []).some((a) => a.toLowerCase() === key));
    if (known) return { id: known.id, name: known.name };
    if (!key || key.length > 60) throw new ApiError(400, "invalid_species", "Vyplňte druh ryby.");
    return { id: null, name: String(value).trim() };
  }
  const optionalNumber = (value, label, { int = false } = {}) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw new ApiError(400, "invalid_number", `${label} musí být ${int ? "celé " : ""}číslo ≥ 0.`);
    return n;
  };

  // ---------- zarybnění ----------
  function stockingShape(s) {
    return {
      id: s.id, revirId: s.revir_id, revir: revirName(s.revir_id), subdistrict: s.subdistrict, date: s.date, planned: Boolean(s.planned),
      speciesId: s.species_id, species: s.species_name, ageClass: s.age_class, kg: s.kg, pieces: s.pieces, costHalere: s.cost_halere,
      supplier: s.supplier || "", note: s.note || "", createdAt: s.created_at, updatedAt: s.updated_at
    };
  }
  function listStocking({ year, revirId, planned } = {}) {
    const where = ["deleted_at IS NULL"];
    const params = [];
    if (year) { where.push("substr(date, 1, 4) = ?"); params.push(String(year)); }
    if (revirId) { where.push("revir_id = ?"); params.push(String(revirId)); }
    if (planned === "1" || planned === "0") { where.push("planned = ?"); params.push(Number(planned)); }
    return { stocking: db.prepare(`SELECT * FROM stocking_events WHERE ${where.join(" AND ")} ORDER BY date DESC, id DESC LIMIT 1000`).all(...params).map(stockingShape), ageClasses: AGE_CLASSES };
  }
  function stockingInput(body) {
    const revirId = validRevir(body.revirId, { required: true });
    if (!time.isIsoDate(String(body.date || ""))) throw new ApiError(400, "invalid_date", "Zadejte datum (u plánu předpokládané).");
    const species = speciesOf(revirId, body.species);
    const ageClass = String(body.ageClass || "").trim();
    if (ageClass.length > 30) throw new ApiError(400, "invalid_age_class", "Věková kategorie je příliš dlouhá.");
    const kg = optionalNumber(body.kg, "Hmotnost");
    const pieces = optionalNumber(body.pieces, "Počet kusů", { int: true });
    if (kg === null && pieces === null) throw new ApiError(400, "invalid_amount", "Zadejte hmotnost nebo počet kusů.");
    const costCzk = optionalNumber(body.costCzk, "Cena");
    const subdistrict = body.subdistrict === null || body.subdistrict === undefined || body.subdistrict === "" ? null : String(body.subdistrict);
    const revir = getRevir(config, revirId);
    if (subdistrict && Array.isArray(revir.subdistrictList) && !revir.subdistrictList.some((s) => String(s.number) === subdistrict)) throw new ApiError(400, "invalid_subdistrict", "Podrevír neexistuje.");
    return { revirId, date: String(body.date), species, ageClass: ageClass || null, kg, pieces, costHalere: costCzk === null ? null : Math.round(costCzk * 100), supplier: String(body.supplier || "").trim().slice(0, 120), note: String(body.note || "").trim().slice(0, 500), subdistrict, planned: body.planned === true ? 1 : 0 };
  }
  function saveStocking(actor, id, body = {}) {
    const v = stockingInput(body);
    return transaction(db, () => {
      const now = iso(time.now());
      let rowId = id;
      if (id) {
        if (!db.prepare("SELECT 1 FROM stocking_events WHERE id = ? AND deleted_at IS NULL").get(Number(id))) throw new ApiError(404, "not_found", "Záznam neexistuje.");
        db.prepare(`UPDATE stocking_events SET revir_id = ?, subdistrict = ?, date = ?, planned = ?, species_id = ?, species_name = ?, age_class = ?, kg = ?, pieces = ?, cost_halere = ?, supplier = ?, note = ?, updated_at = ? WHERE id = ?`)
          .run(v.revirId, v.subdistrict, v.date, v.planned, v.species.id, v.species.name, v.ageClass, v.kg, v.pieces, v.costHalere, v.supplier, v.note, now, Number(id));
      } else {
        rowId = Number(db.prepare(`INSERT INTO stocking_events (revir_id, subdistrict, date, planned, species_id, species_name, age_class, kg, pieces, cost_halere, supplier, note, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.revirId, v.subdistrict, v.date, v.planned, v.species.id, v.species.name, v.ageClass, v.kg, v.pieces, v.costHalere, v.supplier, v.note, actor.id, now, now).lastInsertRowid);
      }
      audit(actor, id ? "stocking_updated" : "stocking_created", "stocking", rowId, { planned: Boolean(v.planned), species: v.species.name });
      return { stocking: stockingShape(db.prepare("SELECT * FROM stocking_events WHERE id = ?").get(rowId)) };
    });
  }
  function deleteStocking(actor, id) {
    const result = db.prepare("UPDATE stocking_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(iso(time.now()), Number(id));
    if (!result.changes) throw new ApiError(404, "not_found", "Záznam neexistuje.");
    audit(actor, "stocking_deleted", "stocking", id);
    return { deleted: true };
  }
  // Rozpočet zarybnění na rok (pro revír nebo celou MO).
  function getBudget(year) {
    if (!/^\d{4}$/.test(String(year || ""))) throw new ApiError(400, "invalid_year", "Zadejte rok.");
    const rows = db.prepare("SELECT * FROM stocking_budgets WHERE year = ?").all(String(year));
    const spent = (revirId, planned) => db.prepare(`SELECT COALESCE(SUM(cost_halere), 0) AS s FROM stocking_events WHERE deleted_at IS NULL AND planned = ? AND substr(date, 1, 4) = ? AND (? IS NULL OR revir_id = ?)`).get(planned, String(year), revirId, revirId).s;
    const budgets = config.reviry.map((r) => {
      const row = rows.find((b) => b.revir_id === r.id);
      return { revirId: r.id, revir: r.name, amountHalere: row ? row.amount_halere : null, note: row?.note || "", spentHalere: spent(r.id, 0), plannedHalere: spent(r.id, 1), total: false };
    });
    // Celá MO = kontrolní součet revírů (nedá se nastavit samostatně).
    const amounts = budgets.filter((b) => b.amountHalere !== null);
    const sum = (key) => budgets.reduce((total, b) => total + b[key], 0);
    budgets.push({ revirId: null, revir: "Všechny revíry", amountHalere: amounts.length ? amounts.reduce((total, b) => total + b.amountHalere, 0) : null, note: "", spentHalere: sum("spentHalere"), plannedHalere: sum("plannedHalere"), total: true });
    return { year: String(year), budgets };
  }
  function setBudget(actor, body = {}) {
    const year = String(body.year || "");
    if (!/^\d{4}$/.test(year)) throw new ApiError(400, "invalid_year", "Zadejte rok.");
    const revirId = validRevir(body.revirId, { required: true }); // rozpočet MO je součtem revírů
    const amount = optionalNumber(body.amountCzk, "Rozpočet");
    const note = String(body.note || "").trim().slice(0, 300);
    transaction(db, () => {
      db.prepare("DELETE FROM stocking_budgets WHERE year = ? AND COALESCE(revir_id, '') = ?").run(year, revirId || "");
      if (amount !== null) db.prepare("INSERT INTO stocking_budgets (year, revir_id, amount_halere, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(year, revirId, Math.round(amount * 100), note || null, actor.id, iso(time.now()));
      audit(actor, "stocking_budget_set", "budget", `${year}:${revirId || "mo"}`, { amount });
    });
    return getBudget(year);
  }

  // ---------- přehledy ----------
  // Statistika za období (den lovu / den zarybnění v rozsahu), volitelně jen revír.
  function stats({ from, to, revirId } = {}) {
    const range = validRange(from, to);
    const revir = validRevir(revirId);
    const scope = "(? IS NULL OR revir_id = ?)";
    const tickets = db.prepare(`SELECT * FROM tickets WHERE fishing_date BETWEEN ? AND ? AND ${scope}`).all(range.from, range.to, revir, revir);
    const issued = tickets.filter((t) => t.status === "issued");
    const today = time.pragueToday();
    const summary = {
      sold: issued.length,
      returned: issued.filter((t) => t.returned_at).length,
      returnedLate: issued.filter((t) => t.returned_at && t.return_late).length,
      noCatch: issued.filter((t) => t.returned_at && t.no_catch).length,
      unreturned: issued.filter((t) => !t.returned_at && t.fishing_date < today).length,
      upcoming: issued.filter((t) => !t.returned_at && t.fishing_date >= today).length,
      seized: issued.filter((t) => t.seized_at).length,
      cancelled: tickets.filter((t) => t.status === "cancelled" && t.paid_at).length,
      vouchers: issued.filter((t) => t.voucher_code).length,
      revenueHalere: issued.filter((t) => t.paid_at).reduce((sum, t) => sum + t.amount_due_halere, 0),
      anglers: new Set(issued.map((t) => t.member_id)).size
    };
    const ids = issued.map((t) => t.id);
    const catches = ids.length ? db.prepare(`SELECT c.*, t.fishing_date FROM catches c JOIN tickets t ON t.id = c.ticket_id WHERE t.status = 'issued' AND t.fishing_date BETWEEN ? AND ? AND (? IS NULL OR t.revir_id = ?)`).all(range.from, range.to, revir, revir) : [];
    const bySpecies = new Map();
    for (const c of catches) {
      const s = bySpecies.get(c.species) || { species: c.species, count: 0, weightKg: 0, weighed: 0, estimated: 0, lengthSum: 0, maxLength: 0 };
      s.count += 1;
      s.lengthSum += c.length_cm;
      s.maxLength = Math.max(s.maxLength, c.length_cm);
      if (c.weight_kg) { s.weightKg += c.weight_kg; s.weighed += 1; if (c.weight_estimated) s.estimated += 1; }
      bySpecies.set(c.species, s);
    }
    const catchRows = [...bySpecies.values()].map(({ lengthSum, ...s }) => ({ ...s, weightKg: Math.round(s.weightKg * 100) / 100, avgLength: Math.round((lengthSum / s.count) * 10) / 10 })).sort((a, b) => b.count - a.count);
    const stocking = db.prepare(`SELECT * FROM stocking_events WHERE deleted_at IS NULL AND planned = 0 AND date BETWEEN ? AND ? AND ${scope}`).all(range.from, range.to, revir, revir);
    const stockedBySpecies = new Map();
    for (const s of stocking) {
      const row = stockedBySpecies.get(s.species_name) || { species: s.species_name, pieces: 0, kg: 0, costHalere: 0 };
      row.pieces += s.pieces || 0;
      row.kg += s.kg || 0;
      row.costHalere += s.cost_halere || 0;
      stockedBySpecies.set(s.species_name, row);
    }
    // Uloveno vs. nasazeno: podklad pro plán zarybnění.
    const names = new Set([...bySpecies.keys(), ...stockedBySpecies.keys()]);
    const balance = [...names].map((species) => {
      const caught = catchRows.find((c) => c.species === species);
      const stocked = stockedBySpecies.get(species);
      return { species, caughtCount: caught?.count || 0, caughtKg: caught?.weightKg || 0, stockedPieces: stocked?.pieces || 0, stockedKg: Math.round((stocked?.kg || 0) * 100) / 100, balanceKg: Math.round(((stocked?.kg || 0) - (caught?.weightKg || 0)) * 100) / 100 };
    }).sort((a, b) => b.caughtKg - a.caughtKg || b.stockedKg - a.stockedKg);
    const months = new Map();
    const month = (date) => { const key = date.slice(0, 7); if (!months.has(key)) months.set(key, { month: key, tickets: 0, catches: 0, revenueHalere: 0, stockingHalere: 0 }); return months.get(key); };
    for (const t of issued) { const m = month(t.fishing_date); m.tickets += 1; if (t.paid_at) m.revenueHalere += t.amount_due_halere; }
    for (const c of catches) month(c.fishing_date).catches += 1;
    for (const s of stocking) month(s.date).stockingHalere += s.cost_halere || 0;
    return {
      ...range, revirId: revir, revir: revirName(revir), generatedAt: iso(time.now()), summary,
      catches: { total: catches.length, weightKg: Math.round(catchRows.reduce((sum, c) => sum + c.weightKg, 0) * 100) / 100, bySpecies: catchRows },
      stocking: { costHalere: [...stockedBySpecies.values()].reduce((sum, s) => sum + s.costHalere, 0), bySpecies: [...stockedBySpecies.values()].map((s) => ({ ...s, kg: Math.round(s.kg * 100) / 100 })) },
      balance,
      byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
    };
  }

  // ---------- uzávěrky ----------
  const reportMeta = (r) => ({ id: r.id, name: r.name, kind: r.kind, seasonId: r.season_id, revirId: r.revir_id, revir: revirName(r.revir_id), from: r.date_from, to: r.date_to, createdAt: r.created_at });
  function listReports() {
    return { reports: db.prepare("SELECT * FROM season_reports ORDER BY id DESC LIMIT 200").all().map(reportMeta) };
  }
  function getReport(id) {
    const row = db.prepare("SELECT * FROM season_reports WHERE id = ?").get(Number(id));
    if (!row) throw new ApiError(404, "not_found", "Uzávěrka neexistuje.");
    return { ...reportMeta(row), data: JSON.parse(row.data) };
  }
  function insertReport({ name, kind, seasonId = null, revirId, from, to, actor = null }) {
    const data = stats({ from, to, revirId });
    const id = Number(db.prepare("INSERT INTO season_reports (name, kind, season_id, revir_id, date_from, date_to, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(name, kind, seasonId, revirId || null, from, to, JSON.stringify(data), actor?.id ?? null, iso(time.now())).lastInsertRowid);
    return { id, data };
  }
  // Ruční uzávěrka za libovolné období (rok, měsíc, probíhající sezona …).
  function createReport(actor, body = {}) {
    const range = validRange(body.from, body.to);
    const revirId = validRevir(body.revirId);
    const name = String(body.name || "").trim().slice(0, 120) || `Uzávěrka ${range.from} – ${range.to}`;
    return transaction(db, () => {
      const { id } = insertReport({ name, kind: "manual", revirId, ...range, actor });
      audit(actor, "report_created", "report", id, { ...range, revirId });
      return getReport(id);
    });
  }
  // Plánovaná úloha: po skončení sezony (den po closesOn) vytvoří automatickou uzávěrku a pošle ji správci.
  const onReportHooks = [];
  function closeSeasons() {
    const today = time.pragueToday();
    const due = db.prepare("SELECT * FROM seasons WHERE deleted_at IS NULL AND closes_on IS NOT NULL AND closes_on < ? AND closed_report_at IS NULL").all(today);
    const created = [];
    for (const season of due) {
      transaction(db, () => {
        const { id, data } = insertReport({ name: `Uzávěrka – ${season.name}`, kind: "season", seasonId: season.id, revirId: season.revir_id, from: season.opens_on, to: season.closes_on });
        db.prepare("UPDATE seasons SET closed_report_at = ? WHERE id = ?").run(iso(time.now()), season.id);
        audit(null, "season_report_created", "report", id, { seasonId: season.id });
        if (config.organization.managerEmail) {
          const mail = emails.seasonReport(config, { name: season.name, revir: revirName(season.revir_id), data, link: `${appUrl}/manage.html#reports/${id}` });
          db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (NULL, 'season_report', ?, ?, ?, ?, ?)").run(config.organization.managerEmail, mail.subject, mail.html, mail.text, iso(time.now()));
        }
        created.push(id);
      });
    }
    for (const id of created) for (const hook of onReportHooks) { try { hook(getReport(id)); } catch (error) { console.error("[uzávěrka]", error.message); } }
    return { created: created.length };
  }
  const onSeasonReport = (fn) => onReportHooks.push(fn); // např. záloha po uzávěrce (B7)

  return { listStocking, saveStocking, deleteStocking, getBudget, setBudget, stats, listReports, getReport, createReport, closeSeasons, onSeasonReport };
}

module.exports = { createReports, AGE_CLASSES };
