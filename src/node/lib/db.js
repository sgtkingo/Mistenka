"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 5;

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

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "mistenka.sqlite");
  const db = new DatabaseSync(file);
  const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all().map((column) => column.name);
  if (ticketColumns.length && !(ticketColumns.includes("member_id") && ticketColumns.includes("closed_at"))) {
    db.close();
    throw new Error(`Databáze ${file} má starší formát. Smažte ji, nebo spusťte "npm run seed".`);
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  // Migrace 2 -> 3: místenka může patřit k účtu.
  if (ticketColumns.length && !ticketColumns.includes("user_id")) db.exec("ALTER TABLE tickets ADD COLUMN user_id INTEGER REFERENCES users(id)");
  migrateUsersNullable(db);
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
      seized_place TEXT
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
      ticket_code TEXT
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
      error TEXT
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS tickets_user ON tickets (user_id)");
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

module.exports = { openDatabase, transaction };
