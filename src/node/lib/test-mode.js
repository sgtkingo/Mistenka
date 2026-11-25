"use strict";
// Testovací režim (stejně ve WordPress pluginu, includes/TestMode.php).
//
// Celý web dočasně běží nad oddělenou testovací databází (DATA_DIR/test/mistenka.sqlite, zálohy a e-maily
// v DATA_DIR/test). Provozní data test nikdy nevidí ani nezmění. Přepíná admin v portálu (Admin → Testování),
// zakázat ho jde proměnnou MISTENKA_TEST_MODE=0 (ostrý web).
//
// - Testovací databáze vzniká kopií provozní konfigurace: nastavení, revíry, mapy, sezony, zarybnění, vývěska,
//   e-mailové účty a účty správců (s relacemi, aby admin zůstal přihlášený) – bez místenek, plateb, úlovků,
//   rybářských účtů, hlášení a auditu. Tlačítkem „Obnovit z provozu“ se založí znovu.
// - Platby v testu: simulované (falešná banka, tlačítko „Simulovat platbu“), nebo ostré přes Fio. Fio vydá
//   každou transakci jen jednou (/last), proto stahuje jen provoz – i během testu – a transakce s testovacím
//   variabilním symbolem (začíná 9, provoz takové negeneruje) předá testovací databázi.
// - Stav přepínače je mimo obě databáze: DATA_DIR/test-mode.json.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PAYMENTS = ["fake", "fio"];
// Variabilní symboly: provoz 1000000000–8999999999, test 9000000000–9999999999.
const VS_RANGES = { production: [1_000_000_000, 9_000_000_000], test: [9_000_000_000, 10_000_000_000] };
const isTestVs = (vs) => /^9\d{9}$/.test(String(vs || "").replace(/^0+/, ""));

// Tabulky, které se do testovací databáze nekopírují (provozní a osobní data).
const CLEARED_TABLES = ["tickets", "ticket_tokens", "ticket_checks", "catches", "bank_transactions", "email_outbox", "bug_reports",
  "limit_violations", "member_blocks", "season_reports", "backups", "auth_tokens", "audit_events", "warden_requests", "vouchers"];
const CLEARED_META = ["setup_token", "last_daily_backup", "last_retention", "fio_token"]; // token Fio jen v provozu
const STAFF = "(',' || roles || ',' LIKE '%,admin,%' OR ',' || roles || ',' LIKE '%,manager,%' OR ',' || roles || ',' LIKE '%,warden,%')";

const testDir = (dataDir) => path.join(dataDir, "test");
const testDbFile = (dataDir) => path.join(testDir(dataDir), "mistenka.sqlite");

function createTestModeState(dataDir, env = process.env) {
  const file = path.join(dataDir, "test-mode.json");
  const locked = ["0", "false"].includes(String(env.MISTENKA_TEST_MODE || "").toLowerCase());
  const defaults = { enabled: false, payments: "fake", since: null, by: null, seededAt: null };
  let state = defaults;
  try { state = { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { /* zatím nezapnuto */ }
  return {
    locked,
    get: () => ({ ...state, enabled: Boolean(state.enabled) && !locked }),
    save(changes) {
      state = { ...state, ...changes };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
      return { ...state };
    },
    testDatabaseExists: () => fs.existsSync(testDbFile(dataDir))
  };
}

// Založí testovací databázi znovu jako kopii provozní (VACUUM INTO) a vyprázdní provozní data.
function seedTestDatabase(prodDb, dataDir) {
  const file = testDbFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  prodDb.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys = OFF; BEGIN");
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    for (const table of CLEARED_TABLES) if (existing.has(table)) db.exec(`DELETE FROM ${table}`);
    db.exec(`DELETE FROM users WHERE NOT ${STAFF}`);
    db.exec("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)");
    for (const key of CLEARED_META) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

// Při zapnutí: správci z provozu do testu (i do starší testovací databáze) – podle e-mailu se doplní nebo aktualizují
// (role, heslo, 2FA) a dostanou své relace, aby admin po přepnutí zůstal přihlášený a mohl režim zase vypnout.
function syncStaff(prodDb, testDb) {
  const staff = prodDb.prepare(`SELECT * FROM users WHERE ${STAFF}`).all();
  testDb.exec("BEGIN");
  try {
    for (const user of staff) {
      const { id, ...fields } = user;
      const columns = Object.keys(fields);
      const existing = testDb.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(user.email);
      let testId = existing?.id;
      if (testId) testDb.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...columns.map((c) => fields[c]), testId);
      else testId = Number(testDb.prepare(`INSERT INTO users (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => fields[c])).lastInsertRowid);
      for (const s of prodDb.prepare("SELECT * FROM sessions WHERE user_id = ?").all(id)) {
        testDb.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(s.token_hash, testId, s.csrf, s.created_at, s.expires_at);
      }
    }
    testDb.exec("COMMIT");
  } catch (error) {
    testDb.exec("ROLLBACK");
    throw error;
  }
}

// Platby v testu přes Fio: test sám banku nestahuje, transakce mu předává provoz (viz výše).
function createForwardedProvider() {
  return { name: "fio", minIntervalMs: 0, forwarded: true, async fetchTransactions() { return []; } };
}

module.exports = { PAYMENTS, VS_RANGES, isTestVs, createTestModeState, seedTestDatabase, syncStaff, createForwardedProvider, testDir, testDbFile };
