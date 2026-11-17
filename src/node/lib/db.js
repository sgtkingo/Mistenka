"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 2;

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
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
      reminder_sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_capacity ON tickets (revir_id, fishing_date, status);
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
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!version) db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
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
