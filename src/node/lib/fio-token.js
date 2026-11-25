"use strict";
// Token Fio API (jen pro čtení) pro automatické párování plateb (stejně ve WordPressu, includes/FioToken.php).
//
// Zdroj tokenu: proměnná prostředí FIO_TOKEN (má přednost, v portálu ji nejde změnit), jinak token zadaný adminem
// v portálu (Bankovní spojení → Párování s bankou). Ten je v provozní databázi jen zašifrovaný (meta fio_token,
// klíč MISTENKA_SECRET_KEY / DATA_DIR/secret.key) a server ho nikdy nevrací. Testovací databáze ho nedostane –
// banku stahuje vždy jen provoz (viz test-mode.js).
const time = require("./time");
const emails = require("./emails");
const { secretBox } = require("./mail-accounts");
const { ApiError } = require("./validate");

const TOKEN_RE = /^[A-Za-z0-9]{20,128}$/;
const META_KEY = "fio_token";
const iso = (date) => date.toISOString();

function createFioToken({ db, config, dataDir, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
  const box = secretBox(dataDir);
  const stored = () => { try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY)?.value || "null"); } catch { return null; } };

  function token() {
    if (env.FIO_TOKEN) return env.FIO_TOKEN;
    const s = stored();
    try { return s?.enc ? box.decrypt(s.enc) : ""; } catch { return ""; } // jiný klíč (secret.key) – token je potřeba zadat znovu
  }
  function status() {
    if (env.FIO_TOKEN) return { configured: true, source: "env", updatedAt: null, updatedBy: null };
    const s = stored();
    return { configured: Boolean(s?.enc && token()), source: s?.enc ? "portal" : null, updatedAt: s?.updatedAt || null, updatedBy: s?.updatedBy || null, unreadable: Boolean(s?.enc && !token()) };
  }

  // Uložení / smazání (prázdný token). Audit a e-mail všem adminům jako u změny platebních údajů.
  function set(actor, body = {}) {
    if (env.FIO_TOKEN) throw new ApiError(409, "fio_token_env", "Token je nastavený v konfiguraci serveru (FIO_TOKEN) – v portálu ho nejde změnit.");
    const value = String(body.token ?? "").trim();
    if (value && !TOKEN_RE.test(value)) throw new ApiError(400, "invalid_fio_token", "Token Fio má 20–128 písmen a číslic (vygenerujte ho v internetovém bankovnictví Fio: Nastavení → API, jen pro čtení).");
    const before = status().configured;
    const now = iso(time.now());
    const actorName = actor ? `${actor.first_name || ""} ${actor.last_name || ""}`.trim() || actor.email : "systém";
    if (value) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(META_KEY, JSON.stringify({ enc: box.encrypt(value), updatedAt: now, updatedBy: actorName }));
    else db.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
    db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'settings', 'fio_token', NULL)").run(now, actor?.id ?? null, value ? "fio_token_changed" : "fio_token_removed");
    const mail = emails.paymentSettingsChanged(config, { actorName: actor ? `${actorName} (${actor.email})` : actorName, before: { fioToken: before ? "nastaven" : "nenastaven" }, after: { fioToken: value ? (before ? "nastaven (nový)" : "nastaven") : "nenastaven" }, at: now });
    for (const admin of db.prepare("SELECT email FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").all()) {
      db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (NULL, 'payment_settings_changed', ?, ?, ?, ?, ?)").run(admin.email, mail.subject, mail.html, mail.text, now);
    }
    return status();
  }

  // Ověření bez posunu zarážky „last“: pohyby za dnešek (endpoint periods). Fio povoluje 1 dotaz za 30 s na token.
  async function verify() {
    const value = token();
    if (!value) throw new ApiError(400, "fio_token_missing", "Token Fio není nastavený.");
    const day = time.pragueToday();
    let response;
    try {
      response = await fetchImpl(`https://fioapi.fio.cz/v1/rest/periods/${encodeURIComponent(value)}/${day}/${day}/transactions.json`);
    } catch {
      return { ok: false, message: "Fio API není dostupné – zkuste to později." };
    }
    if (response.status === 409) return { ok: false, message: "Fio povoluje jeden dotaz za 30 sekund na token (platby se právě stahují) – zkuste to za chvíli." };
    if (!response.ok) return { ok: false, message: `Fio token odmítlo (HTTP ${response.status}) – zkontrolujte, že je platný a má oprávnění jen pro čtení.` };
    const info = (await response.json().catch(() => null))?.accountStatement?.info || {};
    const account = info.accountId ? `${info.accountId}/${info.bankId || ""}` : "";
    const expected = `${config.payment.accountNumber}/${config.payment.bankCode}`;
    const core = (number) => String(number || "").split("-").pop().replace(/^0+/, ""); // bez předčíslí a úvodních nul
    const matches = account ? core(info.accountId) === core(config.payment.accountNumber) && String(info.bankId || "") === String(config.payment.bankCode) : null;
    return { ok: true, account, matchesAccount: matches, message: account ? (matches === false ? `Token funguje, ale patří účtu ${account} – v Bankovním spojení je ${expected}.` : `Token funguje – účet ${account}.`) : "Token funguje." };
  }

  return { token, status, set, verify };
}

module.exports = { createFioToken };
