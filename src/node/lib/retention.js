"use strict";
// Uchovávání osobních údajů (GDPR). Lhůty jsou v nastavení organizace (privacy), výchozí hodnoty viz config.js.
// Plánovaná úloha jednou denně: po uplynutí lhůt údaje anonymizuje nebo smaže. Statistiky (úlovky, počty, částky) zůstávají.
const time = require("./time");
const { transaction } = require("./db");

const iso = (date) => date.toISOString();
const yearsAgo = (years) => { const d = time.now(); d.setUTCFullYear(d.getUTCFullYear() - years); return d; };

function createRetention({ db, config, backups }) {
  function run({ force = false } = {}) {
    const today = time.pragueToday();
    if (!force && db.prepare("SELECT value FROM meta WHERE key = 'last_retention'").get()?.value === today) return { skipped: true };
    const p = config.privacy;
    const report = {};
    transaction(db, () => {
      const now = iso(time.now());
      // Místenky: po uplynutí ticketYears let od konce roku lovu se anonymizují osobní údaje držitele.
      // Zůstává revír, den, stav, cena, VS (účetnictví) a úlovky (statistika).
      const lastYear = Number(today.slice(0, 4)) - p.ticketYears - 1; // např. 2030 − 3 − 1 = 2026 → místenky z roku 2026 a starší
      const old = db.prepare("SELECT id FROM tickets WHERE anonymized_at IS NULL AND substr(fishing_date, 1, 4) <= ?").all(String(lastYear)).map((t) => t.id);
      for (const id of old) {
        db.prepare("UPDATE tickets SET first_name = 'Anonymizováno', last_name = '', birth_date = '', email = '', member_id = '', user_id = NULL, seized_reason = CASE WHEN seized_reason IS NULL THEN NULL ELSE 'anonymizováno' END, seized_place = NULL, cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE 'anonymizováno' END, anonymized_at = ? WHERE id = ?").run(now, id);
        db.prepare("DELETE FROM ticket_tokens WHERE ticket_id = ?").run(id);
        db.prepare("UPDATE limit_violations SET member_id = '' WHERE ticket_id = ?").run(id);
        db.prepare("UPDATE email_outbox SET to_email = '', body_html = '', body_text = '' WHERE ticket_id = ?").run(id);
      }
      report.ticketsAnonymized = old.length;
      // Ukončené blokace starší než lhůta pro místenky.
      const blockCutoff = `${lastYear}-12-31`;
      report.blocksDeleted = db.prepare("DELETE FROM member_blocks WHERE (lifted_at IS NOT NULL AND substr(lifted_at, 1, 10) <= ?) OR (until IS NOT NULL AND until <= ?)").run(blockCutoff, blockCutoff).changes;
      // Bankovní transakce: identifikace plátce po uplynutí účetní lhůty (částka, VS a výsledek zůstávají).
      report.paymentsAnonymized = db.prepare("UPDATE bank_transactions SET counter_account = NULL, counter_name = NULL, message = NULL WHERE created_at <= ? AND (counter_account IS NOT NULL OR counter_name IS NOT NULL OR message IS NOT NULL)").run(iso(yearsAgo(p.accountingYears))).changes;
      // Odeslané e-maily (obsahují osobní údaje) po emailDays dnech.
      report.emailsDeleted = db.prepare("DELETE FROM email_outbox WHERE sent_at IS NOT NULL AND created_at <= ?").run(iso(new Date(time.now().getTime() - p.emailDays * 86_400_000))).changes;
      // Audit po auditYears letech.
      report.auditDeleted = db.prepare("DELETE FROM audit_events WHERE at <= ?").run(iso(yearsAgo(p.auditYears))).changes;
      db.prepare("INSERT INTO meta (key, value) VALUES ('last_retention', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(today);
    });
    // Zálohy obsahují osobní údaje – i trvalé se po backupYears letech mažou.
    report.backupsDeleted = backups ? backups.removeOlderThan(iso(yearsAgo(p.backupYears))) : 0;
    return report;
  }
  return { run };
}

module.exports = { createRetention };
