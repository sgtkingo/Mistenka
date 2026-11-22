"use strict";
// Nastavení organizace v databázi (B5). Soubor config/organization.json (+ pravidla druhů) zůstává výchozími
// hodnotami; každá změna z manažerského portálu se uloží jako nová verze celé části (scope) s autorem.
// Platná konfigurace = soubor + poslední verze každé části. Změna se projeví hned (objekt config se přepíše).
//
// Části (scope): organization | payment | revir:<id> | species:<odkaz na soubor pravidel> | map:<id revíru>
const { transaction } = require("./db");
const time = require("./time");
const emails = require("./emails");
const { buildConfig } = require("./config");
const { ApiError } = require("./validate");

const ORG_KEYS = ["organization", "returnPolicy", "salesPolicy", "publicCheck", "statsPolicy", "limitPolicy", "penaltyPolicy", "privacy"];
const PAYMENT_KEYS = ["accountNumber", "bankCode", "recipientName", "reservationMinutes", "messagePrefix"];
const iso = (date) => date.toISOString();
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));

function createSettings({ db, config }) {
  const source = config.source;
  if (!source) throw new Error("Konfigurace nemá zdroj (použijte loadConfig).");

  const latestRows = () => db.prepare("SELECT v.* FROM settings_versions v JOIN (SELECT scope, MAX(id) AS id FROM settings_versions GROUP BY scope) m ON m.id = v.id").all();
  const latest = (scope) => db.prepare("SELECT * FROM settings_versions WHERE scope = ? ORDER BY id DESC LIMIT 1").get(scope) || null;

  // Výchozí dokument části ze souboru.
  function fileDoc(scope) {
    if (scope === "organization") return pick(source.raw, ORG_KEYS);
    if (scope === "payment") return pick(source.raw.payment, PAYMENT_KEYS);
    if (scope.startsWith("revir:")) {
      const revir = source.raw.reviry.find((r) => r.id === scope.slice(6));
      if (!revir) return null;
      const { id, ...rest } = revir;
      return rest;
    }
    if (scope.startsWith("species:")) return source.species[scope.slice(8)] || null;
    if (scope.startsWith("map:")) return source.maps?.[scope.slice(4)] || null;
    return null;
  }

  // Zdroj + uložené verze (+ navrhovaná změna) -> data pro buildConfig.
  function effective(overrides = {}) {
    const docs = {};
    for (const row of latestRows()) docs[row.scope] = JSON.parse(row.data);
    Object.assign(docs, overrides);
    const raw = structuredClone(source.raw);
    if (docs.organization) for (const key of ORG_KEYS) if (key in docs.organization) raw[key] = docs.organization[key];
    if (docs.payment) raw.payment = { ...docs.payment, provider: source.raw.payment.provider }; // zdroj plateb (fake/fio) jen ze souboru
    for (const [scope, data] of Object.entries(docs)) {
      if (!scope.startsWith("revir:")) continue;
      const revir = { ...data, id: scope.slice(6) };
      const index = raw.reviry.findIndex((r) => r.id === revir.id);
      if (index >= 0) raw.reviry[index] = revir; else raw.reviry.push(revir);
    }
    const species = { ...source.species };
    for (const [scope, data] of Object.entries(docs)) if (scope.startsWith("species:")) species[scope.slice(8)] = data;
    const maps = { ...(source.maps || {}) };
    for (const [scope, data] of Object.entries(docs)) if (scope.startsWith("map:")) maps[scope.slice(4)] = data;
    return { raw, species, maps };
  }
  function build(overrides) {
    const { raw, species, maps } = effective(overrides);
    try { return buildConfig(raw, species, maps); } catch (error) { throw new ApiError(400, "invalid_settings", error.message.replace(/^Chybná konfigurace: /, "")); }
  }
  // Přepíše sdílený objekt config na místě – všechny moduly ho drží odkazem.
  function apply(next) {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, next);
  }
  if (latestRows().length) {
    try { apply(build()); } catch (error) { throw new Error(`Uložené nastavení není platné (${error.message}). Opravte ho, nebo smažte poslední verzi v tabulce settings_versions.`); }
  }

  // ---------- čtení ----------
  const stripRevir = (revir) => { const { fishRules, ...rest } = revir; return rest; };
  function versionMeta(scope) {
    const row = latest(scope);
    if (!row) return { version: null, source: "file" };
    const by = row.created_by ? db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(row.created_by) : null;
    return { version: row.id, source: "database", updatedAt: row.created_at, updatedBy: by ? `${by.first_name} ${by.last_name}` : "" };
  }
  function view(actor) {
    const { species } = effective();
    return {
      organization: { data: pick(config, ORG_KEYS), ...versionMeta("organization") },
      payment: { data: pick(config.payment, PAYMENT_KEYS), iban: config.iban, provider: config.payment.provider, ...versionMeta("payment") },
      reviry: config.reviry.map((revir) => ({ id: revir.id, data: (({ id, ...rest }) => rest)(stripRevir(revir)), ...versionMeta(`revir:${revir.id}`) })),
      species: Object.entries(species).map(([ref, doc]) => ({ ref, data: doc, ...versionMeta(`species:${ref}`) })),
      // Mapy revírů bez náhledu PNG (editor si ho při uložení vykreslí znovu).
      maps: config.reviry.map((revir) => ({ revirId: revir.id, data: config.maps?.[revir.id] || null, hasFile: Boolean(source.maps?.[revir.id]), ...versionMeta(`map:${revir.id}`) })),
      canEditPayment: rolesOf(actor).includes("admin")
    };
  }
  const rolesOf = (user) => String(user?.roles || "").split(",");

  // ---------- uložení ----------
  function checkScope(scope, actor, { creating = false } = {}) {
    if (scope === "organization") return;
    if (scope === "payment") {
      if (!rolesOf(actor).includes("admin")) throw new ApiError(403, "forbidden_role", "Platební údaje smí měnit jen admin.");
      return;
    }
    if (scope.startsWith("revir:")) {
      const id = scope.slice(6);
      if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new ApiError(400, "invalid_settings", "Identifikátor revíru smí obsahovat jen a–z, 0–9 a pomlčku.");
      const exists = config.reviry.some((r) => r.id === id);
      if (creating && exists) throw new ApiError(409, "revir_exists", "Revír s tímto identifikátorem už existuje.");
      if (!creating && !exists) throw new ApiError(404, "not_found", "Revír neexistuje.");
      return;
    }
    if (scope.startsWith("species:")) {
      if (!effective().species[scope.slice(8)]) throw new ApiError(404, "not_found", "Pravidla druhů neexistují.");
      return;
    }
    if (scope.startsWith("map:")) {
      if (!config.reviry.some((r) => r.id === scope.slice(4))) throw new ApiError(404, "not_found", "Revír neexistuje.");
      return;
    }
    throw new ApiError(400, "invalid_scope", "Neznámá část nastavení.");
  }
  function normalize(scope, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError(400, "invalid_settings", "Nastavení musí být objekt.");
    if (scope === "organization") return pick(data, ORG_KEYS);
    if (scope === "payment") return pick(data, PAYMENT_KEYS);
    if (scope.startsWith("revir:")) { const { id, fishRules, map, ...rest } = data; return rest; }
    if (scope.startsWith("map:")) { const { preview, ...rest } = data; return rest; } // náhled PNG starších verzí se neukládá
    return data;
  }
  function save(actor, scope, data, { note = "", creating = false } = {}) {
    checkScope(scope, actor, { creating });
    const doc = normalize(scope, data);
    return transaction(db, () => {
      const before = scope === "payment" ? { ...pick(config.payment, PAYMENT_KEYS), iban: config.iban } : null;
      const next = build({ [scope]: doc }); // kontrola celé konfigurace, než se cokoli uloží
      const now = iso(time.now());
      const id = Number(db.prepare("INSERT INTO settings_versions (scope, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(scope, JSON.stringify(doc), String(note || "").slice(0, 200) || null, actor?.id ?? null, now).lastInsertRowid);
      apply(next);
      db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'settings_changed', 'settings', ?, ?)").run(now, actor?.id ?? null, scope, JSON.stringify({ version: id, note }));
      // Změna účtu pro platby je nejcitlivější změna – dozví se o ní všichni admini.
      if (scope === "payment") {
        const after = { ...pick(config.payment, PAYMENT_KEYS), iban: config.iban };
        const admins = db.prepare("SELECT email FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").all();
        const actorName = actor ? `${actor.first_name} ${actor.last_name} (${actor.email})` : "systém";
        const mail = emails.paymentSettingsChanged(config, { actorName, before, after, at: now });
        for (const admin of admins) db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (NULL, 'payment_settings_changed', ?, ?, ?, ?, ?)").run(admin.email, mail.subject, mail.html, mail.text, now);
      }
      return { scope, version: id, settings: view(actor) };
    });
  }

  function history(scope) {
    const rows = db.prepare("SELECT v.id, v.note, v.created_at, u.first_name, u.last_name FROM settings_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.scope = ? ORDER BY v.id DESC LIMIT 100").all(String(scope));
    return { scope, versions: rows.map((r) => ({ version: r.id, note: r.note || "", createdAt: r.created_at, createdBy: r.first_name ? `${r.first_name} ${r.last_name}` : "" })), hasFile: Boolean(fileDoc(String(scope))) };
  }
  function versionData(versionId) {
    const row = db.prepare("SELECT * FROM settings_versions WHERE id = ?").get(Number(versionId));
    if (!row) throw new ApiError(404, "not_found", "Verze neexistuje.");
    return { scope: row.scope, version: row.id, data: JSON.parse(row.data), createdAt: row.created_at };
  }
  // Obnovení starší verze = uložení její kopie jako nové verze (historie se nepřepisuje).
  function restore(actor, versionId) {
    const { scope, version, data } = versionData(versionId);
    return save(actor, scope, data, { note: `Obnovena verze #${version}` });
  }
  function resetToFile(actor, scope) {
    const doc = fileDoc(String(scope));
    if (!doc) throw new ApiError(404, "not_found", "Tato část nemá výchozí hodnoty v souboru.");
    return save(actor, String(scope), doc, { note: "Obnoveny výchozí hodnoty ze souboru" });
  }
  // Export platné konfigurace ve tvaru souborů (záloha, převod do WordPressu).
  function exportAll() {
    const { raw, species, maps } = effective();
    return { organization: raw, species, maps, exportedAt: iso(time.now()) };
  }
  // Verze pravidel druhů pro revír – ukládá se k odevzdané místence.
  function rulesVersion(revirId) {
    const revir = config.reviry.find((r) => r.id === revirId);
    const ref = revir?.speciesRules || config.speciesRules;
    const row = ref ? latest(`species:${ref}`) : null;
    return `${revir?.fishRules?.id || ref || "?"}@${row ? `v${row.id}` : "soubor"}`;
  }

  // Po obnově databáze: nastavení se znovu sestaví z obnovených verzí.
  function reload() {
    apply(latestRows().length ? build() : buildConfig(structuredClone(source.raw), { ...source.species }, { ...(source.maps || {}) }));
  }

  return { view, save, history, versionData, restore, resetToFile, exportAll, rulesVersion, reload };
}

module.exports = { createSettings };
