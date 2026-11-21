"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 17;

// Sloupce tabulky users (sdílí vytvoření i migrace).
const USERS_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,              -- malými písmeny
      email_verified_at TEXT,
      password_hash TEXT,                      -- NULL = jen přihlášení odkazem z e-mailu
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      birth_date TEXT,                         -- rybářské údaje; u účtu jen pro správu mohou chybět
      member_id TEXT UNIQUE,                   -- číslo členské legitimace, jedno na účet
      roles TEXT NOT NULL DEFAULT 'member',    -- seznam oddělený čárkami
      totp_secret TEXT,                        -- base32, 2FA (TOTP)
      totp_enabled_at TEXT,
      totp_last_step INTEGER,                  -- ochrana proti opakovanému použití kódu
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL`;
const USERS_COPY = "id, email, email_verified_at, password_hash, first_name, last_name, birth_date, member_id, roles, totp_secret, totp_enabled_at, totp_last_step, created_at, updated_at";

// Migrace 3 -> 4: číslo legitimace a datum narození jsou volitelné (účty jen pro správu).
// SQLite neumí ALTER COLUMN, tabulka se přestaví.
function migrateUsersNullable(db) {
  const memberId = db.prepare("PRAGMA table_info(users)").all().find((column) => column.name === "member_id");
  if (!memberId || !memberId.notnull) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE users_new (${USERS_COLUMNS});
      INSERT INTO users_new (${USERS_COPY}) SELECT ${USERS_COPY} FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// Kontrola integrity souboru SQLite. Vrátí null (v pořádku), nebo popis problému.
function integrityProblem(file) {
  let probe;
  try {
    probe = new DatabaseSync(file);
    const rows = probe.prepare("PRAGMA integrity_check").all();
    return rows.length === 1 && rows[0].integrity_check === "ok" ? null : rows.map((r) => r.integrity_check).join("; ").slice(0, 300);
  } catch (error) {
    return error.message;
  } finally {
    try { probe?.close(); } catch { /* už zavřeno */ }
  }
}

// Automatická obnova: poškozená databáze se odloží do DATA_DIR/corrupt/ a nahradí nejnovější platnou zálohou.
function autoRestore(dataDir, file, problem) {
  const backupDir = path.join(dataDir, "backups");
  const candidates = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite")).map((name) => path.join(backupDir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  const source = candidates.find((candidate) => !integrityProblem(candidate));
  if (!source) throw new Error(`Databáze ${file} je poškozená (${problem}) a žádná platná záloha není k dispozici v ${backupDir}.`);
  const corruptDir = path.join(dataDir, "corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const corruptFile = path.join(corruptDir, `mistenka-${stamp}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, corruptFile + suffix);
  fs.copyFileSync(source, file);
  return { at: new Date().toISOString(), problem, from: path.basename(source), corruptFile };
}

function openDatabase(dataDir, { autoRecover = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "mistenka.sqlite");
  let recovered = null;
  if (autoRecover && fs.existsSync(file)) {
    const problem = integrityProblem(file);
    if (problem) {
      recovered = autoRestore(dataDir, file, problem);
      console.error(`[databáze] POŠKOZENÁ (${problem}) – automaticky obnovena ze zálohy ${recovered.from}; poškozený soubor: ${recovered.corruptFile}`);
    }
  }
  const db = new DatabaseSync(file);
  db.autoRestored = recovered; // server zapíše do auditu a upozorní adminy
  const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (ticketColumns.length && !(ticketColumns.includes("member_id") && ticketColumns.includes("closed_at"))) {
    db.close();
    throw new Error(`Databáze ${file} má starší formát. Smažte ji, nebo spusťte "npm run seed".`);
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const previousVersion = hasMeta ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0) : 0;
  // Migrace 2 -> 3: místenka může patřit k účtu.
  if (ticketColumns.length && !ticketColumns.includes("user_id")) db.exec("ALTER TABLE tickets ADD COLUMN user_id INTEGER REFERENCES users(id)");
  migrateUsersNullable(db);
  // Migrace 7 -> 8: zrušení správcem, řešení plateb, správa poukazů (B4).
  const addColumns = (table, columns) => {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!existing.length) return; // tabulka vznikne níže už s novými sloupci
    for (const [column, definition] of columns) if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  // Migrace 16 -> 17: místenka na jeden podrevír (null = celý revír).
  addColumns("tickets", [["subdistrict", "TEXT"]]);
  addColumns("tickets", [["cancel_reason", "TEXT"], ["cancelled_by", "INTEGER"], ["rules_version", "TEXT"], ["anonymized_at", "TEXT"]]);
  addColumns("bank_transactions", [["resolution", "TEXT"], ["resolution_note", "TEXT"], ["resolved_at", "TEXT"], ["resolved_by", "INTEGER"]]);
  addColumns("member_blocks", [["cause", "TEXT"]]);
  addColumns("vouchers", [["created_at", "TEXT"], ["created_by", "INTEGER"], ["note", "TEXT"], ["voided_at", "TEXT"]]);
  // Migrace 13 -> 14: odesílatel e-mailu (SMTP účet skupiny nebo výchozí).
  addColumns("email_outbox", [["sender", "TEXT"]]);
  // Migrace 4 -> 5: zadržení místenky porybným.
  for (const [column, definition] of [["seized_at", "TEXT"], ["seized_by", "INTEGER"], ["seized_reason", "TEXT"], ["seized_place", "TEXT"]]) {
    if (ticketColumns.length && !ticketColumns.includes(column)) db.exec(`ALTER TABLE tickets ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    -- Uživatelské účty (B1). Role jsou sada oprávnění: member, warden, manager, admin.
    CREATE TABLE IF NOT EXISTS users (${USERS_COLUMNS});
    -- Přihlášení (cookie). Ukládá se jen SHA-256 hash tokenu.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    -- Jednorázové odkazy z e-mailu: ověření účtu, přihlášení, obnova hesla, změna e-mailu.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,                   -- verify_email | magic_link | password_reset | change_email
      new_email TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT                              -- JSON
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      revir_id TEXT NOT NULL,
      subdistrict TEXT,                        -- podrevír místenky (číslo), null = celý revír
      fishing_date TEXT NOT NULL,              -- YYYY-MM-DD (kalendářní den v Praze)
      member_id TEXT NOT NULL,              -- číslo členské legitimace (8 číslic)
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      birth_date TEXT NOT NULL,
      email TEXT NOT NULL,
      price_halere INTEGER NOT NULL,
      amount_due_halere INTEGER NOT NULL,
      variable_symbol TEXT UNIQUE,             -- jen u objednávek placených převodem
      voucher_code TEXT,
      status TEXT NOT NULL,                    -- pending_payment | issued | payment_expired | cancelled
      created_at TEXT NOT NULL,
      reserved_until TEXT,
      paid_at TEXT,
      issued_at TEXT,
      cancelled_at TEXT,
      returned_at TEXT,
      closed_at TEXT,                          -- automaticky uzavřena jako neodevzdaná
      return_late INTEGER NOT NULL DEFAULT 0,
      no_catch INTEGER NOT NULL DEFAULT 0,
      reminder_sent_at TEXT,
      user_id INTEGER REFERENCES users(id),     -- účet, ke kterému místenka patří (NULL = nákup bez účtu)
      seized_at TEXT,                          -- zadržení porybným (B2): lov končí, odevzdat je nutné i tak
      seized_by INTEGER,                       -- id porybného (bez FK – účet může být smazán)
      seized_reason TEXT,
      seized_place TEXT,
      cancel_reason TEXT,                      -- zrušení správcem (B4)
      cancelled_by INTEGER,
      rules_version TEXT,                      -- verze pravidel druhů použitá při odevzdání (B5)
      anonymized_at TEXT                       -- osobní údaje odstraněny po uplynutí lhůty (GDPR)
    );
    -- Nastavení z manažerského portálu (B5): každá změna = nová verze celé části.
    CREATE TABLE IF NOT EXISTS settings_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,                     -- organization | payment | revir:<id> | species:<odkaz>
      data TEXT NOT NULL,                      -- JSON
      note TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settings_versions_scope ON settings_versions (scope, id);
    -- Zarybnění (B6): skutečné (planned = 0) i plánované (planned = 1) nasazení ryb.
    CREATE TABLE IF NOT EXISTS stocking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revir_id TEXT NOT NULL,
      subdistrict TEXT,                        -- číslo podrevíru, NULL = celý revír
      date TEXT NOT NULL,                      -- YYYY-MM-DD (u plánu předpokládané)
      planned INTEGER NOT NULL DEFAULT 0,
      species_id TEXT,
      species_name TEXT NOT NULL,
      age_class TEXT,                          -- K1, K2, K3, plůdek, tržní …
      kg REAL,
      pieces INTEGER,
      cost_halere INTEGER,
      supplier TEXT,
      note TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS stocking_date ON stocking_events (date);
    CREATE TABLE IF NOT EXISTS stocking_budgets (
      year TEXT NOT NULL,
      revir_id TEXT,                           -- NULL = celá MO
      amount_halere INTEGER NOT NULL,
      note TEXT,
      updated_by INTEGER,
      updated_at TEXT NOT NULL
    );
    -- Zálohy databáze (B7): daily (drží se 2) | season (trvalá, po uzávěrce) | manual.
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      note TEXT,
      report_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    -- Uzávěrky: automatické po skončení sezony a ruční za libovolné období. data = statistika (JSON).
    CREATE TABLE IF NOT EXISTS season_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,                      -- season | manual
      season_id INTEGER,
      revir_id TEXT,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      data TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    -- Kontroly místenek porybným (obdoba zápisu stráže do povolenky).
    CREATE TABLE IF NOT EXISTS ticket_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      user_id INTEGER,                         -- porybný (bez FK – účet může být smazán)
      warden_name TEXT NOT NULL,               -- jméno v době kontroly
      at TEXT NOT NULL,
      status TEXT NOT NULL                     -- stav místenky v okamžiku kontroly
    );
    CREATE INDEX IF NOT EXISTS ticket_checks_ticket ON ticket_checks (ticket_id, at);
    -- Překročené limity úlovků (B3), zapsané při odevzdání.
    CREATE TABLE IF NOT EXISTS limit_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      member_id TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      label TEXT NOT NULL,
      period TEXT NOT NULL,                    -- day | week | month
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      count INTEGER NOT NULL,
      max_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS limit_violations_member ON limit_violations (member_id, created_at);
    -- Blokace nákupu místenek pro číslo legitimace (ručně správcem nebo automaticky po porušení limitů).
    CREATE TABLE IF NOT EXISTS member_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      until TEXT,                              -- YYYY-MM-DD včetně; NULL = do zrušení
      source TEXT NOT NULL,                    -- manual | auto
      cause TEXT,                              -- limits | late_return | seizure | manual
      created_by INTEGER,
      created_at TEXT NOT NULL,
      lifted_at TEXT,
      lifted_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS member_blocks_member ON member_blocks (member_id);
    -- Provoz (B4). revir_id NULL = platí pro všechny revíry organizace. Mazání je měkké (deleted_at).
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revir_id TEXT,
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      valid_from TEXT,                         -- YYYY-MM-DD; NULL = hned
      valid_to TEXT,                           -- YYYY-MM-DD včetně; NULL = do smazání
      pinned INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revir_id TEXT,
      name TEXT NOT NULL,
      opens_on TEXT NOT NULL,                  -- YYYY-MM-DD
      closes_on TEXT,                          -- YYYY-MM-DD včetně; NULL = otevřená do uzavření
      closed_report_at TEXT,                   -- automatická uzávěrka (B6)
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revir_id TEXT,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_capacity ON tickets (revir_id, fishing_date, status);
    CREATE INDEX IF NOT EXISTS tickets_member ON tickets (member_id, fishing_date);
    -- Přístupové tokeny držitele (prohlížeč, odkazy v e-mailech). Ukládá se jen SHA-256 hash.
    CREATE TABLE IF NOT EXISTS ticket_tokens (
      token_hash TEXT PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      purpose TEXT NOT NULL,                   -- order | email
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      species TEXT NOT NULL,
      length_cm REAL NOT NULL,
      weight_kg REAL,
      weight_estimated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vouchers (
      code TEXT PRIMARY KEY,
      revir_id TEXT,                           -- NULL = platí pro všechny revíry
      used_at TEXT,
      ticket_code TEXT,
      created_at TEXT,
      created_by INTEGER,
      note TEXT,
      voided_at TEXT                           -- zneplatněný správcem
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      booked_at TEXT,
      amount_halere INTEGER NOT NULL,
      currency TEXT NOT NULL,
      variable_symbol TEXT,
      counter_account TEXT,
      counter_name TEXT,
      message TEXT,
      ticket_id INTEGER REFERENCES tickets(id),
      result TEXT NOT NULL,                    -- matched | unmatched | amount_mismatch | duplicate_payment | late | ignored
      note TEXT,
      created_at TEXT NOT NULL,
      resolution TEXT,                         -- ruční řešení: assigned | refunded | ignored
      resolution_note TEXT,
      resolved_at TEXT,
      resolved_by INTEGER,
      UNIQUE (provider, transaction_id)
    );
    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER REFERENCES tickets(id),
      kind TEXT NOT NULL,                      -- payment_instructions | ticket_issued | return_reminder
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      error TEXT,
      sender TEXT                              -- přes který účet odešel (název SMTP účtu / „výchozí“)
    );
    -- Žádosti „Jsem porybný“ (notifikace pro správce). unverified = čeká na ověření e-mailu žadatele.
    CREATE TABLE IF NOT EXISTS warden_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,                    -- unverified | pending | approved | rejected
      note TEXT,
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      decided_at TEXT,
      decided_by INTEGER,
      decided_via TEXT,                        -- portal | email
      decision_note TEXT,
      action_token_hash TEXT,                  -- odkaz z e-mailu správci (jednorázový, 7 dní)
      action_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS warden_requests_user ON warden_requests (user_id, id);
    -- SMTP účty pro odesílání (Admin → Emailoví klienti). Heslo šifrované (AES-256-GCM), nikdy se nevrací do API.
    CREATE TABLE IF NOT EXISTS email_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      from_email TEXT NOT NULL,
      from_name TEXT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      encryption TEXT NOT NULL,                -- ssl | tls | none
      username TEXT,
      password_enc TEXT,
      verified_at TEXT,                        -- úspěšný testovací e-mail; změna připojení ověření ruší
      verified_to TEXT,
      last_error TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS tickets_user ON tickets (user_id)");
  // v16: instalace, která už prodávala (má místenky nebo sezony), je spuštěná – nové pravidlo ji nezavře.
  if (previousVersion && previousVersion < 16 && (db.prepare("SELECT 1 FROM tickets LIMIT 1").get() || db.prepare("SELECT 1 FROM seasons WHERE deleted_at IS NULL LIMIT 1").get())) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('service_launched_at', ?) ON CONFLICT (key) DO NOTHING").run(new Date().toISOString());
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
  return db;
}

// Spustí fn v transakci se zámkem pro zápis (kapacita, poukazy, párování plateb).
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Spuštění služby: čerstvá instalace je zavřená (sezona uzavřena, registrace a přihlášení rybářů vypnuté),
// dokud správce ručně neotevře první sezonu. Stav se drží v meta (při obnově ze zálohy se nemění).
const serviceLaunched = (db) => Boolean(db.prepare("SELECT value FROM meta WHERE key = 'service_launched_at'").get()?.value);
const markLaunched = (db, at) => db.prepare("INSERT INTO meta (key, value) VALUES ('service_launched_at', ?) ON CONFLICT (key) DO NOTHING").run(at);

module.exports = { openDatabase, transaction, integrityProblem, serviceLaunched, markLaunched };
