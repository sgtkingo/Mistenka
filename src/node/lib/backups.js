"use strict";
// Zálohy databáze (B7). Node: konzistentní kopie SQLite (VACUUM INTO) do DATA_DIR/backups.
// WordPress: export tabulek pluginu do chráněného adresáře (stejná pravidla uchování, viz docs/API.md).
//
// Pravidla: denní záloha během sezony (drží se poslední a aktuální = 2), po každé uzávěrce sezony
// jedna trvalá, ruční záloha admina. Spravovat, stahovat a mazat smí jen admin.
const fs = require("node:fs");
const path = require("node:path");
const time = require("./time");
const { ApiError } = require("./validate");

const DAILY_KEEP = 2;
const iso = (date) => date.toISOString();

function createBackups({ db, dataDir }) {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const audit = (actor, action, targetId, detail = null) => db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'backup', ?, ?)")
    .run(iso(time.now()), actor?.id ?? null, action, String(targetId), detail ? JSON.stringify(detail) : null);
  const shape = (b) => ({ id: b.id, kind: b.kind, file: b.file, sizeBytes: b.size_bytes, note: b.note || "", reportId: b.report_id, createdAt: b.created_at, exists: fs.existsSync(path.join(dir, b.file)) });

  function create(kind, { note = "", reportId = null, actor = null } = {}) {
    const now = time.now();
    const stamp = iso(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let file = `mistenka-${stamp}-${kind}.sqlite`;
    for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `mistenka-${stamp}-${kind}-${i}.sqlite`;
    const target = path.join(dir, file);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const size = fs.statSync(target).size;
    const id = Number(db.prepare("INSERT INTO backups (kind, file, size_bytes, note, report_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(kind, file, size, note || null, reportId, actor?.id ?? null, iso(now)).lastInsertRowid);
    audit(actor, "backup_created", id, { kind, file });
    return shape(db.prepare("SELECT * FROM backups WHERE id = ?").get(id));
  }
  function removeRow(row) {
    fs.rmSync(path.join(dir, row.file), { force: true });
    db.prepare("DELETE FROM backups WHERE id = ?").run(row.id);
  }

  // Je dnes sezona? Ano, když je otevřená některá sezona, nebo když žádná sezona není nastavená (revíry otevřené celý rok).
  function inSeason(today) {
    const seasons = db.prepare("SELECT opens_on, closes_on FROM seasons WHERE deleted_at IS NULL").all();
    return !seasons.length || seasons.some((s) => s.opens_on <= today && (!s.closes_on || today <= s.closes_on));
  }
  // Plánovaná úloha: jednou za den (Praha) během sezony; starší denní zálohy nad limit se smažou.
  function daily() {
    const today = time.pragueToday();
    const last = db.prepare("SELECT value FROM meta WHERE key = 'last_daily_backup'").get()?.value;
    if (last === today || !inSeason(today)) return { created: false };
    const backup = create("daily");
    db.prepare("INSERT INTO meta (key, value) VALUES ('last_daily_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(today);
    const old = db.prepare("SELECT * FROM backups WHERE kind = 'daily' ORDER BY id DESC").all().slice(DAILY_KEEP);
    for (const row of old) removeRow(row);
    return { created: true, file: backup.file, removed: old.length };
  }
  // Po uzávěrce sezony: trvalá záloha.
  function afterSeasonReport(report) {
    return create("season", { note: report.name, reportId: report.id });
  }

  function list() {
    const rows = db.prepare("SELECT * FROM backups ORDER BY id DESC").all();
    return { backups: rows.map(shape), dailyKeep: DAILY_KEEP, totalBytes: rows.reduce((sum, b) => sum + b.size_bytes, 0) };
  }
  function manual(actor, body = {}) {
    return { backup: create("manual", { note: String(body.note || "").trim().slice(0, 200), actor }) };
  }
  function find(id) {
    const row = db.prepare("SELECT * FROM backups WHERE id = ?").get(Number(id));
    if (!row) throw new ApiError(404, "not_found", "Záloha neexistuje.");
    return row;
  }
  function filePath(id) {
    const row = find(id);
    const full = path.join(dir, row.file);
    if (!fs.existsSync(full)) throw new ApiError(404, "not_found", "Soubor zálohy chybí.");
    return { file: row.file, full, size: row.size_bytes };
  }
  function remove(actor, id) {
    const row = find(id);
    removeRow(row);
    audit(actor, "backup_deleted", row.id, { file: row.file, kind: row.kind });
    return { deleted: true };
  }

  return { daily, afterSeasonReport, list, manual, filePath, remove };
}

module.exports = { createBackups };
