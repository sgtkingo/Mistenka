"use strict";
// Hlášení chyb (tlačítko s broukem v horním panelu → portál, Admin → Hlášení chyb). Smlouva v docs/API.md.
//
// Kdokoli (i nepřihlášený) pošle popis, záznam posledních událostí z prohlížeče, čas a volitelně snímek
// obrazovky. Admin hlášení řeší: stav, priorita, poznámka, odkaz na GitHub issue (nebo ho rovnou založí,
// je-li nastaven MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO). Každé hlášení dostanou e-mailem všichni admini.
const time = require("./time");
const emails = require("./emails");
const { ApiError, EMAIL_RE } = require("./validate");

const iso = (date) => date.toISOString();
const STATUSES = ["new", "in_progress", "resolved", "wontfix"];
const PRIORITIES = ["low", "normal", "high", "critical"];
const MAX_LOG = 100;
// Snímek obrazovky se po 90 dnech maže a vyřízené hlášení rok po vyřízení (retention.js).
const MAX_SCREENSHOT = 2_000_000; // znaků data URL (~1,5 MB obrázku)
const SCREENSHOT_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

// Přijme „vlastník/repozitář“ i celou adresu (https://github.com/vlastník/repozitář[.git]).
function normalizeRepo(value) {
  const v = String(value || "").trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/(\.git)?\/*$/i, "");
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : "";
}

function createBugs({ db, config, appUrl, github: githubIn = {} }) {
  const github = { token: githubIn.token || "", repo: normalizeRepo(githubIn.repo) };
  const audit = (actor, action, id, detail = null) => db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'bug_report', ?, ?)")
    .run(iso(time.now()), actor?.id ?? null, action, String(id), detail ? JSON.stringify(detail) : null);
  const text = (value, max) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
  const userOf = (id) => (id ? db.prepare("SELECT first_name, last_name, email, roles FROM users WHERE id = ?").get(id) : null);
  // Jen stránka bez parametrů a kotvy (kód místenky, tokeny z odkazů v e-mailu se neukládají).
  const pageOf = (value) => text(value, 500).split(/[?#]/)[0];
  const githubConfigured = () => Boolean(github.token && github.repo);

  function shape(r, { full = false } = {}) {
    const u = userOf(r.user_id);
    const out = {
      id: r.id, createdAt: r.created_at, status: r.status, priority: r.priority, description: r.description, url: r.url,
      user: u ? { name: `${u.first_name || ""} ${u.last_name || ""}`.trim(), email: u.email, roles: String(u.roles || "").split(",").filter(Boolean) } : null,
      contactEmail: r.contact_email || null, hasScreenshot: Boolean(r.screenshot), githubUrl: r.github_url || null, note: r.note || "", updatedAt: r.updated_at, resolvedAt: r.resolved_at
    };
    if (full) Object.assign(out, { userAgent: r.user_agent || "", viewport: r.viewport || "", clientTime: r.client_time || null, log: JSON.parse(r.log || "[]"), screenshot: r.screenshot || null });
    return out;
  }
  const find = (id) => {
    const row = db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(Number(id));
    if (!row) throw new ApiError(404, "not_found", "Hlášení neexistuje.");
    return row;
  };

  // ---------- nahlášení (veřejné) ----------
  function create(input = {}, user = null) {
    const description = text(input.description, 4000);
    if (description.length < 10) throw new ApiError(400, "invalid_description", "Popište prosím, co se stalo (aspoň 10 znaků).");
    const contactEmail = text(input.contactEmail, 200).toLowerCase();
    if (contactEmail && !EMAIL_RE.test(contactEmail)) throw new ApiError(400, "invalid_email", "Zadejte platný e-mail pro odpověď, nebo pole nechte prázdné.");
    const screenshot = input.screenshot ? String(input.screenshot) : null;
    if (screenshot && (screenshot.length > MAX_SCREENSHOT || !SCREENSHOT_RE.test(screenshot))) throw new ApiError(400, "invalid_screenshot", "Snímek obrazovky musí být obrázek PNG, JPEG nebo WebP do 1,5 MB.");
    const log = (Array.isArray(input.log) ? input.log : []).slice(-MAX_LOG).map((e) => ({ at: text(e?.at, 40), type: text(e?.type, 20), message: text(e?.message, 500), page: text(e?.page, 200) }));
    const now = iso(time.now());
    const id = Number(db.prepare(`INSERT INTO bug_reports (created_at, user_id, contact_email, description, url, user_agent, viewport, client_time, log, screenshot, status, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'normal', ?)`).run(now, user?.id ?? null, contactEmail || null, description, pageOf(input.url), text(input.userAgent, 400), text(input.viewport, 40), text(input.clientTime, 40) || null, JSON.stringify(log), screenshot, now).lastInsertRowid);
    // E-mail všem adminům (skupina „Hlášení chyb“ v Emailoví klienti).
    const report = shape(find(id));
    const mail = emails.bugReport(config, { report, link: `${appUrl}/manage.html#bugs/${id}` });
    for (const admin of db.prepare("SELECT email FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").all()) {
      db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (NULL, 'bug_report', ?, ?, ?, ?, ?)").run(admin.email, mail.subject, mail.html, mail.text, now);
    }
    return { id };
  }

  // ---------- správa (admin) ----------
  function list({ status = "" } = {}) {
    if (status && !STATUSES.includes(status)) throw new ApiError(400, "invalid_status", "Neznámý stav.");
    const rows = db.prepare(`SELECT * FROM bug_reports ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 500`).all(...(status ? [status] : []));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE status = ?").get(s).n]));
    return { reports: rows.map((r) => shape(r)), counts, github: { configured: githubConfigured(), repo: github.repo || null } };
  }
  const get = (id) => ({ report: shape(find(id), { full: true }) });
  function update(actor, id, body = {}) {
    const row = find(id);
    const status = body.status === undefined ? row.status : String(body.status);
    if (!STATUSES.includes(status)) throw new ApiError(400, "invalid_status", "Neznámý stav.");
    const priority = body.priority === undefined ? row.priority : String(body.priority);
    if (!PRIORITIES.includes(priority)) throw new ApiError(400, "invalid_priority", "Neznámá priorita.");
    const note = body.note === undefined ? row.note || "" : text(body.note, 2000);
    const githubUrl = body.githubUrl === undefined ? row.github_url || "" : text(body.githubUrl, 300);
    if (githubUrl && !GITHUB_URL_RE.test(githubUrl)) throw new ApiError(400, "invalid_github_url", "Odkaz musí vést na GitHub issue (https://github.com/…/issues/123).");
    const now = iso(time.now());
    const resolvedAt = ["resolved", "wontfix"].includes(status) ? row.resolved_at || now : null;
    db.prepare("UPDATE bug_reports SET status = ?, priority = ?, note = ?, github_url = ?, resolved_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(status, priority, note || null, githubUrl || null, resolvedAt, now, actor.id, row.id);
    audit(actor, "bug_report_updated", row.id, { status, priority });
    return get(row.id);
  }
  // Založení GitHub issue (bez osobních údajů a snímku – ten zůstává v portálu).
  function issueBody(r) {
    const lines = [r.description, "", `- Hlášení: #${r.id} (${appUrl}/manage.html#bugs/${r.id})`, `- Čas: ${r.created_at}`, `- Stránka: ${r.url || "—"}`, `- Prohlížeč: ${r.user_agent || "—"}`, `- Okno: ${r.viewport || "—"}`, `- Priorita: ${r.priority}`, `- Snímek obrazovky: ${r.screenshot ? "ano (v portálu)" : "ne"}`];
    const log = JSON.parse(r.log || "[]");
    if (log.length) lines.push("", "<details><summary>Poslední události</summary>", "", "```", ...log.map((e) => `${e.at} ${e.type} ${e.page || ""} ${e.message}`), "```", "</details>");
    return lines.join("\n");
  }
  async function toGithub(actor, id) {
    const row = find(id);
    if (!githubConfigured()) throw new ApiError(409, "github_not_configured", "GitHub není nastaven (MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO na serveru).");
    if (row.github_url) throw new ApiError(409, "already_on_github", "Hlášení už má GitHub issue.");
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${github.repo}/issues`, {
        method: "POST",
        headers: { Authorization: `Bearer ${github.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "mistenka" },
        body: JSON.stringify({ title: `[Místenka #${row.id}] ${row.description.split("\n")[0].slice(0, 100)}`, body: issueBody(row), labels: ["bug"] })
      });
    } catch (error) { throw new ApiError(502, "github_failed", `GitHub je nedostupný: ${error.message}`); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.html_url) throw new ApiError(502, "github_failed", `GitHub issue se nepodařilo založit (${response.status}${data.message ? `: ${data.message}` : ""}).`);
    db.prepare("UPDATE bug_reports SET github_url = ?, status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, updated_at = ?, updated_by = ? WHERE id = ?").run(data.html_url, iso(time.now()), actor.id, row.id);
    audit(actor, "bug_report_github", row.id, { url: data.html_url });
    return get(row.id);
  }

  return { create, list, get, update, toGithub, issueBody: (id) => issueBody(find(id)) };
}

module.exports = { createBugs, normalizeRepo };
