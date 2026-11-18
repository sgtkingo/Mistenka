"use strict";
// Provoz revírů (B4): důležité zprávy, sezony a mimořádná uzavření. Smlouva v docs/API.md, sekce „Provoz“.
const { transaction } = require("./db");
const time = require("./time");
const emails = require("./emails");
const { getRevir } = require("./config");
const { ApiError } = require("./validate");

const iso = (date) => date.toISOString();
const MAX_PUBLIC_ANNOUNCEMENTS = 3;

function createOperations({ db, config, appUrl }) {
  // ---------- pomocné ----------
  function audit(actor, action, targetType, targetId, detail = null) {
    db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(iso(time.now()), actor?.id ?? null, action, targetType, String(targetId), detail ? JSON.stringify(detail) : null);
  }
  function validRevir(value) {
    if (value === null || value === undefined || value === "") return null; // null = všechny revíry organizace
    if (!getRevir(config, String(value))) throw new ApiError(400, "unknown_revir", "Revír neexistuje.");
    return String(value);
  }
  function validDate(value, { required = false, label = "Datum" } = {}) {
    if (value === null || value === undefined || value === "") {
      if (required) throw new ApiError(400, "invalid_date", `${label} je povinné.`);
      return null;
    }
    if (!time.isIsoDate(String(value))) throw new ApiError(400, "invalid_date", `${label} musí být platné datum.`);
    return String(value);
  }
  function validText(value, { min = 0, max, code, label }) {
    const text = String(value ?? "").trim();
    if (text.length < min || text.length > max) throw new ApiError(400, code, min ? `${label}: ${min}–${max} znaků.` : `${label}: nejvýše ${max} znaků.`);
    return text;
  }
  const revirName = (id) => (id ? getRevir(config, id)?.name || id : "Všechny revíry");
  const scopeSql = "(revir_id IS NULL OR revir_id = ?)";

  // Jednorázový převod oznámení z konfigurace (revir.notice) do databáze.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'notices_imported'").get()) {
    const now = iso(time.now());
    for (const revir of config.reviry) {
      if (revir.notice?.title) db.prepare("INSERT INTO announcements (revir_id, title, text, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(revir.id, revir.notice.title, revir.notice.text || "", now, now);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('notices_imported', ?)").run(now);
  }

  // ---------- důležité zprávy ----------
  function announcementShape(a, today = time.pragueToday()) {
    return {
      id: a.id, revirId: a.revir_id, revirName: revirName(a.revir_id), title: a.title, text: a.text, validFrom: a.valid_from, validTo: a.valid_to, pinned: Boolean(a.pinned),
      active: (!a.valid_from || a.valid_from <= today) && (!a.valid_to || a.valid_to >= today), createdAt: a.created_at, updatedAt: a.updated_at
    };
  }
  // Veřejně: nejvýš 3 aktivní zprávy pro revír (připnuté první, pak nejnovější).
  function activeAnnouncements(revirId) {
    const today = time.pragueToday();
    const rows = db.prepare(`SELECT * FROM announcements WHERE deleted_at IS NULL AND ${scopeSql}
      AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)
      ORDER BY pinned DESC, COALESCE(valid_from, substr(created_at, 1, 10)) DESC, id DESC LIMIT ?`).all(String(revirId || ""), today, today, MAX_PUBLIC_ANNOUNCEMENTS);
    return { announcements: rows.map((a) => { const { id, revirId: r, title, text, validFrom, validTo, pinned } = announcementShape(a, today); return { id, revirId: r, title, text, validFrom, validTo, pinned }; }) };
  }
  function listAnnouncements() {
    const today = time.pragueToday();
    return { announcements: db.prepare("SELECT * FROM announcements WHERE deleted_at IS NULL ORDER BY pinned DESC, id DESC").all().map((a) => announcementShape(a, today)), maxPublic: MAX_PUBLIC_ANNOUNCEMENTS };
  }
  function saveAnnouncement(actor, id, body = {}) {
    const title = validText(body.title, { min: 1, max: 120, code: "invalid_title", label: "Nadpis" });
    const text = validText(body.text, { max: 1000, code: "invalid_text", label: "Text" });
    const revirId = validRevir(body.revirId);
    const validFrom = validDate(body.validFrom, { label: "Začátek platnosti" });
    const validTo = validDate(body.validTo, { label: "Konec platnosti" });
    if (validFrom && validTo && validTo < validFrom) throw new ApiError(400, "invalid_date", "Konec platnosti musí být po začátku.");
    const pinned = body.pinned === true ? 1 : 0;
    return transaction(db, () => {
      const now = iso(time.now());
      let rowId = id;
      if (id) {
        const existing = db.prepare("SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL").get(Number(id));
        if (!existing) throw new ApiError(404, "not_found", "Zpráva neexistuje.");
        db.prepare("UPDATE announcements SET revir_id = ?, title = ?, text = ?, valid_from = ?, valid_to = ?, pinned = ?, updated_at = ? WHERE id = ?").run(revirId, title, text, validFrom, validTo, pinned, now, existing.id);
      } else {
        rowId = Number(db.prepare("INSERT INTO announcements (revir_id, title, text, valid_from, valid_to, pinned, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(revirId, title, text, validFrom, validTo, pinned, actor.id, now, now).lastInsertRowid);
      }
      audit(actor, id ? "announcement_updated" : "announcement_created", "announcement", rowId, { title });
      return { announcement: announcementShape(db.prepare("SELECT * FROM announcements WHERE id = ?").get(rowId)) };
    });
  }
  function deleteAnnouncement(actor, id) {
    const result = db.prepare("UPDATE announcements SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(iso(time.now()), Number(id));
    if (!result.changes) throw new ApiError(404, "not_found", "Zpráva neexistuje.");
    audit(actor, "announcement_deleted", "announcement", id);
    return { deleted: true };
  }

  // ---------- sezony ----------
  const seasonShape = (s, today = time.pragueToday()) => ({
    id: s.id, revirId: s.revir_id, revirName: revirName(s.revir_id), name: s.name, opensOn: s.opens_on, closesOn: s.closes_on,
    state: s.closes_on && s.closes_on < s.opens_on ? "closed" : s.opens_on > today ? "upcoming" : !s.closes_on || s.closes_on >= today ? "open" : "closed"
  });
  const seasonsFor = (revirId) => db.prepare(`SELECT * FROM seasons WHERE deleted_at IS NULL AND ${scopeSql} ORDER BY opens_on`).all(revirId);
  function listSeasons() {
    const today = time.pragueToday();
    return { seasons: db.prepare("SELECT * FROM seasons WHERE deleted_at IS NULL ORDER BY opens_on DESC, id DESC").all().map((s) => seasonShape(s, today)) };
  }
  function saveSeason(actor, id, body = {}) {
    const revirId = validRevir(body.revirId);
    const opensOn = validDate(body.opensOn, { required: true, label: "Otevření sezony" });
    // Název je nepovinný – výchozí „Sezona <rok otevření>“.
    const name = validText(body.name, { max: 80, code: "invalid_name", label: "Název" }) || `Sezona ${opensOn.slice(0, 4)}`;
    const closesOn = validDate(body.closesOn, { label: "Uzavření sezony" });
    if (closesOn && closesOn < opensOn) throw new ApiError(400, "invalid_date", "Uzavření sezony musí být po jejím otevření.");
    return transaction(db, () => {
      const now = iso(time.now());
      let rowId = id;
      if (id) {
        const existing = db.prepare("SELECT * FROM seasons WHERE id = ? AND deleted_at IS NULL").get(Number(id));
        if (!existing) throw new ApiError(404, "not_found", "Sezona neexistuje.");
        db.prepare("UPDATE seasons SET revir_id = ?, name = ?, opens_on = ?, closes_on = ?, updated_at = ? WHERE id = ?").run(revirId, name, opensOn, closesOn, now, existing.id);
      } else {
        rowId = Number(db.prepare("INSERT INTO seasons (revir_id, name, opens_on, closes_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(revirId, name, opensOn, closesOn, actor.id, now, now).lastInsertRowid);
      }
      audit(actor, id ? "season_updated" : "season_created", "season", rowId, { name, opensOn, closesOn, revirId });
      return { season: seasonShape(db.prepare("SELECT * FROM seasons WHERE id = ?").get(rowId)) };
    });
  }
  // Uzavření sezony od data (včetně): posledním dnem lovu je den předtím. Od dneška = uzavřít ihned.
  // Už vystavené místenky platí dál; nákup na dny od data uzavření se zablokuje.
  function closeSeason(actor, id, body = {}) {
    const from = validDate(body.from, { required: true, label: "Datum uzavření" });
    if (from < time.pragueToday()) throw new ApiError(400, "invalid_date", "Sezonu lze uzavřít nejdříve ode dneška.");
    return transaction(db, () => {
      const season = db.prepare("SELECT * FROM seasons WHERE id = ? AND deleted_at IS NULL").get(Number(id));
      if (!season) throw new ApiError(404, "not_found", "Sezona neexistuje.");
      const closesOn = time.addDays(from, -1);
      if (season.closes_on && season.closes_on < closesOn) throw new ApiError(409, "already_closing", "Sezona už končí dříve.");
      db.prepare("UPDATE seasons SET closes_on = ?, updated_at = ? WHERE id = ?").run(closesOn, iso(time.now()), season.id);
      audit(actor, "season_closed", "season", season.id, { from, closesOn });
      return { season: seasonShape(db.prepare("SELECT * FROM seasons WHERE id = ?").get(season.id)) };
    });
  }
  function deleteSeason(actor, id) {
    const result = db.prepare("UPDATE seasons SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(iso(time.now()), Number(id));
    if (!result.changes) throw new ApiError(404, "not_found", "Sezona neexistuje.");
    audit(actor, "season_deleted", "season", id);
    return { deleted: true };
  }

  // ---------- mimořádná uzavření ----------
  const closureShape = (c) => ({ id: c.id, revirId: c.revir_id, revirName: revirName(c.revir_id), dateFrom: c.date_from, dateTo: c.date_to, reason: c.reason, createdAt: c.created_at });
  function listClosures() {
    return { closures: db.prepare("SELECT * FROM closures WHERE deleted_at IS NULL ORDER BY date_from DESC, id DESC LIMIT 200").all().map(closureShape) };
  }
  // Místenky na uzavřené dny (vystavené a rezervované) dostanou e-mail; vrácení peněz řeší správce ručně.
  function createClosure(actor, body = {}) {
    const revirId = validRevir(body.revirId);
    const dateFrom = validDate(body.dateFrom, { required: true, label: "Datum od" });
    const dateTo = validDate(body.dateTo, { label: "Datum do" }) || dateFrom;
    if (dateTo < dateFrom) throw new ApiError(400, "invalid_date", "Datum do musí být po datu od.");
    const reason = validText(body.reason, { min: 3, max: 300, code: "invalid_reason", label: "Důvod" });
    return transaction(db, () => {
      const now = iso(time.now());
      const id = Number(db.prepare("INSERT INTO closures (revir_id, date_from, date_to, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(revirId, dateFrom, dateTo, reason, actor.id, now).lastInsertRowid);
      const closure = db.prepare("SELECT * FROM closures WHERE id = ?").get(id);
      const affected = db.prepare(`SELECT * FROM tickets WHERE fishing_date BETWEEN ? AND ? AND (? IS NULL OR revir_id = ?)
        AND ((status = 'issued' AND returned_at IS NULL) OR (status = 'pending_payment' AND reserved_until > ?))`).all(dateFrom, dateTo, revirId, revirId, now);
      for (const ticket of affected) {
        const revir = getRevir(config, ticket.revir_id) || { name: ticket.revir_id };
        const mail = emails.closureNotice(config, { ticket, revir, closure: closureShape(closure), links: { status: `${appUrl}/status.html?code=${ticket.code}` } });
        db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (?, 'closure_notice', ?, ?, ?, ?, ?)").run(ticket.id, ticket.email, mail.subject, mail.html, mail.text, now);
      }
      audit(actor, "closure_created", "closure", id, { revirId, dateFrom, dateTo, reason, affected: affected.length });
      return { closure: closureShape(closure), affectedTickets: affected.map((t) => ({ code: t.code, date: t.fishing_date, holder: `${t.first_name} ${t.last_name}`, status: t.status })) };
    });
  }
  function deleteClosure(actor, id) {
    const result = db.prepare("UPDATE closures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(iso(time.now()), Number(id));
    if (!result.changes) throw new ApiError(404, "not_found", "Uzavření neexistuje.");
    audit(actor, "closure_deleted", "closure", id);
    return { deleted: true };
  }

  // ---------- je den otevřený pro nákup? ----------
  // Uzavření má přednost; pak sezona. Revír bez nastavené sezony je otevřený celý rok.
  function dayStatus(revirId, date) {
    const closure = db.prepare(`SELECT * FROM closures WHERE deleted_at IS NULL AND ${scopeSql} AND ? BETWEEN date_from AND date_to ORDER BY id DESC`).get(revirId, date);
    if (closure) return { open: false, code: "revir_closed", reason: closure.reason };
    const seasons = seasonsFor(revirId);
    if (seasons.length && !seasons.some((s) => s.opens_on <= date && (!s.closes_on || date <= s.closes_on))) {
      const next = seasons.find((s) => s.opens_on > date);
      return { open: false, code: "out_of_season", reason: next ? `Mimo sezonu – otevírá se ${next.opens_on.split("-").reverse().map(Number).join(". ")}` : "Mimo sezonu", opensOn: next?.opens_on || null };
    }
    return { open: true };
  }

  return { activeAnnouncements, listAnnouncements, saveAnnouncement, deleteAnnouncement, listSeasons, saveSeason, closeSeason, deleteSeason, listClosures, createClosure, deleteClosure, dayStatus };
}

module.exports = { createOperations };
