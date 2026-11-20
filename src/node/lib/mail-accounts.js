"use strict";
// SMTP účty pro odesílání e-mailů (portál → Admin → Emailoví klienti). Smlouva v docs/API.md, sekce „E-mailoví klienti“.
//
// Admin účty zakládá, upravuje, ověřuje (testovací e-mail) a maže. Správce pro každou skupinu e-mailů vybere
// jeden ověřený účet jako odesílatele. Skupina bez přiřazeného (nebo neověřeného) účtu odesílá výchozím
// způsobem serveru s odesílatelem z nastavení organizace (email.fromEmail / fromName).
//
// Heslo se ukládá šifrovaně (AES-256-GCM), do frontendu se nikdy nevrací. Klíč: MISTENKA_SECRET_KEY,
// jinak se vygeneruje do DATA_DIR/secret.key. Node e-maily neodesílá (ukládá je do data/outbox), WordPress
// je odešle přes SMTP vybraného účtu.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const time = require("./time");
const { transaction } = require("./db");
const { ApiError, EMAIL_RE } = require("./validate");

const iso = (date) => date.toISOString();
const ENCRYPTIONS = ["ssl", "tls", "none"];
// Skupiny e-mailů: každá má svého odesílatele. Druhy odpovídají sloupci email_outbox.kind.
const GROUPS = [
  { id: "tickets", label: "Místenky", help: "pokyny k platbě, vystavená místenka, připomínka a uzavření, zadržení, zrušení, uzavření revíru, blokace nákupu",
    kinds: ["payment_instructions", "ticket_issued", "return_reminder", "ticket_closed", "ticket_seized", "ticket_cancelled", "closure_notice", "member_blocked"] },
  { id: "accounts", label: "Účty", help: "registrace, přihlášení odkazem, obnova hesla, změna e-mailu, pozvánka do správy, vyřízení žádosti o porybného, smazání účtu",
    kinds: ["account_verify", "account_exists", "magic_link", "password_reset", "email_change", "staff_invite", "account_deleted", "warden_request_approved", "warden_request_rejected"] },
  { id: "notices", label: "Upozornění správcům", help: "žádosti „Jsem porybný“, zadržení, překročené limity, uzávěrka sezony, změna platebních údajů, obnova databáze",
    kinds: ["seizure_notice", "limit_exceeded", "season_report", "payment_settings_changed", "database_auto_restored", "warden_request"] }
];
const groupOf = (kind) => (GROUPS.find((g) => g.kinds.includes(kind)) || GROUPS[0]).id;
// Změna těchto údajů ruší ověření (účet je potřeba znovu otestovat).
const CONNECTION_FIELDS = ["from_email", "host", "port", "encryption", "username", "password_enc"];

function loadKey(dataDir) {
  const fromEnv = process.env.MISTENKA_SECRET_KEY;
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  const file = path.join(dataDir, "secret.key");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
}

function createMailAccounts({ db, config, dataDir, mailer }) {
  const key = loadKey(dataDir);
  function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }
  function decrypt(value) {
    if (!value) return "";
    const raw = Buffer.from(String(value).slice(3), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  const audit = (actor, action, targetId, detail = null) => db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'email_account', ?, ?)")
    .run(iso(time.now()), actor?.id ?? null, action, String(targetId), detail ? JSON.stringify(detail) : null);
  const metaGet = (k) => db.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value ?? null;
  const metaSet = (k, v) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  const rolesOf = (user) => String(user?.roles || "").split(",");
  function requireAdminRole(actor) {
    if (!rolesOf(actor).includes("admin")) throw new ApiError(403, "forbidden_role", "E-mailové účty spravuje jen admin.");
  }

  const find = (id) => db.prepare("SELECT * FROM email_accounts WHERE id = ? AND deleted_at IS NULL").get(Number(id)) || null;
  function senders() {
    const stored = JSON.parse(metaGet("email_senders") || "{}");
    return Object.fromEntries(GROUPS.map((g) => [g.id, stored[g.id] ? Number(stored[g.id]) : null]));
  }
  function shape(a) {
    const assigned = Object.entries(senders()).filter(([, id]) => id === a.id).map(([group]) => group);
    return {
      id: a.id, label: a.label, fromEmail: a.from_email, fromName: a.from_name || "", host: a.host, port: a.port, encryption: a.encryption,
      username: a.username || "", hasPassword: Boolean(a.password_enc), verified: Boolean(a.verified_at), verifiedAt: a.verified_at, verifiedTo: a.verified_to,
      lastError: a.last_error, usedFor: assigned, createdAt: a.created_at, updatedAt: a.updated_at
    };
  }

  // ---------- čtení (správce i admin) ----------
  function list(actor) {
    const accounts = db.prepare("SELECT * FROM email_accounts WHERE deleted_at IS NULL ORDER BY label, id").all().map(shape);
    const fallback = { fromEmail: config.email?.fromEmail || "", fromName: config.email?.fromName || "" };
    return { accounts, senders: senders(), groups: GROUPS.map(({ id, label, help }) => ({ id, label, help })), fallback, delivery: mailer.delivery, canEdit: rolesOf(actor).includes("admin") };
  }

  // ---------- správa účtů (jen admin) ----------
  function input(body, existing) {
    const text = (value, max, code, label, { required = false } = {}) => {
      const out = String(value ?? "").trim();
      if ((required && !out) || out.length > max) throw new ApiError(400, code, required ? `${label}: povinné, nejvýše ${max} znaků.` : `${label}: nejvýše ${max} znaků.`);
      return out;
    };
    const fromEmail = text(body.fromEmail, 200, "invalid_email", "Adresa odesílatele", { required: true }).toLowerCase();
    if (!EMAIL_RE.test(fromEmail)) throw new ApiError(400, "invalid_email", "Zadejte platnou adresu odesílatele.");
    const host = text(body.host, 253, "invalid_host", "Server SMTP", { required: true }).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) throw new ApiError(400, "invalid_host", "Server SMTP zadejte jako název (např. smtp.websupport.cz).");
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, "invalid_port", "Port musí být celé číslo 1–65535 (obvykle 465 nebo 587).");
    const encryption = String(body.encryption || "");
    if (!ENCRYPTIONS.includes(encryption)) throw new ApiError(400, "invalid_encryption", "Šifrování musí být ssl, tls nebo none.");
    const password = body.password === undefined || body.password === null ? "" : String(body.password);
    if (password.length > 500) throw new ApiError(400, "invalid_password", "Heslo je příliš dlouhé.");
    return {
      label: text(body.label, 80, "invalid_label", "Název") || fromEmail,
      from_email: fromEmail,
      from_name: text(body.fromName, 100, "invalid_name", "Jméno odesílatele"),
      host, port, encryption,
      username: text(body.username, 200, "invalid_username", "Přihlašovací jméno"),
      // Prázdné heslo při úpravě = beze změny.
      password_enc: password ? encrypt(password) : existing ? existing.password_enc : null
    };
  }
  function create(actor, body = {}) {
    requireAdminRole(actor);
    const v = input(body, null);
    const now = iso(time.now());
    const id = Number(db.prepare(`INSERT INTO email_accounts (label, from_email, from_name, host, port, encryption, username, password_enc, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.label, v.from_email, v.from_name, v.host, v.port, v.encryption, v.username, v.password_enc, actor.id, now, now).lastInsertRowid);
    audit(actor, "email_account_created", id, { label: v.label, fromEmail: v.from_email, host: v.host });
    return { account: shape(find(id)) };
  }
  function update(actor, id, body = {}) {
    requireAdminRole(actor);
    return transaction(db, () => {
      const existing = find(id);
      if (!existing) throw new ApiError(404, "not_found", "E-mailový účet neexistuje.");
      const v = input(body, existing);
      const reset = CONNECTION_FIELDS.some((field) => String(v[field] ?? "") !== String(existing[field] ?? ""));
      db.prepare(`UPDATE email_accounts SET label = ?, from_email = ?, from_name = ?, host = ?, port = ?, encryption = ?, username = ?, password_enc = ?, updated_at = ?${reset ? ", verified_at = NULL, verified_to = NULL" : ""} WHERE id = ?`)
        .run(v.label, v.from_email, v.from_name, v.host, v.port, v.encryption, v.username, v.password_enc, iso(time.now()), existing.id);
      audit(actor, "email_account_updated", existing.id, { label: v.label, verificationReset: reset });
      return { account: shape(find(existing.id)) };
    });
  }
  function remove(actor, id) {
    requireAdminRole(actor);
    return transaction(db, () => {
      const existing = find(id);
      if (!existing) throw new ApiError(404, "not_found", "E-mailový účet neexistuje.");
      db.prepare("UPDATE email_accounts SET deleted_at = ?, password_enc = NULL WHERE id = ?").run(iso(time.now()), existing.id);
      const current = senders();
      for (const group of Object.keys(current)) if (current[group] === existing.id) current[group] = null;
      metaSet("email_senders", JSON.stringify(current));
      audit(actor, "email_account_deleted", existing.id, { label: existing.label });
      return { deleted: true };
    });
  }
  // Ověření = odeslání testovacího e-mailu přes účet. Úspěch účet označí jako ověřený, chyba se uloží a vrátí.
  async function verify(actor, id, body = {}) {
    requireAdminRole(actor);
    const existing = find(id);
    if (!existing) throw new ApiError(404, "not_found", "E-mailový účet neexistuje.");
    const to = String(body.to || actor.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(to)) throw new ApiError(400, "invalid_email", "Zadejte platnou adresu pro testovací e-mail.");
    const org = config.organization;
    const at = iso(time.now());
    const mail = {
      subject: `Místenka – test odesílání (${existing.label})`,
      text: `Testovací e-mail Místenky (${org.shortName}).\nÚčet: ${existing.label}\nOdesílatel: ${existing.from_email}\nServer: ${existing.host}:${existing.port} (${existing.encryption})\nOdesláno: ${at}`,
      html: `<p>Testovací e-mail Místenky (<b>${escapeHtml(org.shortName)}</b>).</p><p>Účet: ${escapeHtml(existing.label)}<br>Odesílatel: ${escapeHtml(existing.from_email)}<br>Server: ${escapeHtml(`${existing.host}:${existing.port} (${existing.encryption})`)}<br>Odesláno: ${escapeHtml(at)}</p><p>Pokud tento e-mail čtete, odesílání funguje.</p>`
    };
    try {
      await mailer.send({ id: `test-${existing.id}-${Date.now()}`, to, ...mail, from: fromOf(existing), account: accountForSending(existing) });
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      db.prepare("UPDATE email_accounts SET last_error = ?, verified_at = NULL, verified_to = NULL WHERE id = ?").run(message, existing.id);
      audit(actor, "email_account_verify_failed", existing.id, { to, error: message });
      throw new ApiError(400, "smtp_failed", `Testovací e-mail se nepodařilo odeslat: ${message}`);
    }
    db.prepare("UPDATE email_accounts SET verified_at = ?, verified_to = ?, last_error = NULL WHERE id = ?").run(at, to, existing.id);
    audit(actor, "email_account_verified", existing.id, { to });
    return { account: shape(find(existing.id)) };
  }

  // ---------- odesílatelé skupin (správce i admin) ----------
  function setSenders(actor, body = {}) {
    return transaction(db, () => {
      const current = senders();
      for (const group of GROUPS) {
        if (!(group.id in body)) continue;
        const value = body[group.id];
        if (value === null || value === "" || value === undefined) { current[group.id] = null; continue; }
        const account = find(value);
        if (!account) throw new ApiError(404, "not_found", "E-mailový účet neexistuje.");
        if (!account.verified_at) throw new ApiError(409, "account_not_verified", `Účet ${account.label} ještě není ověřený testovacím e-mailem.`);
        current[group.id] = account.id;
      }
      metaSet("email_senders", JSON.stringify(current));
      audit(actor, "email_senders_changed", "senders", current);
      return list(actor);
    });
  }

  // ---------- odeslání ----------
  const fromOf = (a) => ({ email: a.from_email, name: a.from_name || "" });
  const accountForSending = (a) => ({ id: a.id, label: a.label, host: a.host, port: a.port, encryption: a.encryption, username: a.username || "", password: decrypt(a.password_enc) });
  // Odesílatel pro druh e-mailu: přiřazený ověřený účet skupiny, jinak výchozí odesílatel organizace.
  function senderFor(kind) {
    const id = senders()[groupOf(kind)];
    const account = id ? find(id) : null;
    if (account?.verified_at) return { from: fromOf(account), account: accountForSending(account), label: account.label };
    return { from: { email: config.email?.fromEmail || "", name: config.email?.fromName || "" }, account: null, label: "výchozí" };
  }

  return { list, create, update, remove, verify, setSenders, senderFor, GROUPS };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

module.exports = { createMailAccounts, GROUPS, groupOf };
