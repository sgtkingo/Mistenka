"use strict";
// Lokální vývojový server Místenky (Node.js + SQLite). Produkční implementace je PHP plugin
// pro WordPress; obě musí dodržet stejnou smlouvu API (docs/API.md) a projít stejnými testy (test/).
//
// Proměnné prostředí:
//   PORT=3000                 port serveru
//   DATA_DIR=data             databáze a odeslané e-maily (outbox)
//   APP_URL=http://localhost:3000   základ odkazů v e-mailech
//   MISTENKA_CONFIG=config/organization.json   konfigurace MO a revírů
//   MISTENKA_DEV=1            zapne vývojové endpointy (posun času pro testy)
//   MISTENKA_CRON_KEY=...     povolí POST /api/jobs/run s hlavičkou X-Mistenka-Cron-Key
//   MISTENKA_JOBS_INTERVAL_MS interval plánovaných úloh (0 = vypnuto)
//   MISTENKA_RATE_LIMIT=0     vypne omezení počtu požadavků (jen pro testy)
//   FIO_TOKEN=...             token Fio API (jen při payment.provider = "fio")
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, publicConfig } = require("./lib/config");
const { openDatabase } = require("./lib/db");
const { createProvider } = require("./lib/payments");
const { createFileMailer } = require("./lib/emails");
const { createService, ApiError } = require("./lib/service");
const { createAccounts } = require("./lib/accounts");
const time = require("./lib/time");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"));
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEV = process.env.MISTENKA_DEV === "1";
const CRON_KEY = process.env.MISTENKA_CRON_KEY || "";
const FRONTEND = path.join(__dirname, "..", "frontend");

const config = loadConfig();
const db = openDatabase(DATA_DIR);
const provider = createProvider(config);
const mailer = createFileMailer(path.join(DATA_DIR, "outbox"));
const service = createService({ db, config, provider, mailer, appUrl: APP_URL });
const accounts = createAccounts({ db, config, appUrl: APP_URL });
service.addJob("accounts", () => accounts.cleanup());

// ---------- omezení počtu požadavků (v paměti, na IP) ----------
const RATE_LIMITS = process.env.MISTENKA_RATE_LIMIT !== "0"; // testy limity vypínají
const buckets = new Map();
function rateLimited(ip, bucket, limit, windowMs, consume = true) {
  if (!RATE_LIMITS) return false;
  const key = `${bucket}:${ip}`;
  const nowMs = Date.now();
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= nowMs) { entry = { count: 0, resetAt: nowMs + windowMs }; buckets.set(key, entry); }
  if (entry.count >= limit) return true;
  if (consume) entry.count += 1;
  return false;
}
setInterval(() => { const nowMs = Date.now(); for (const [key, entry] of buckets) if (entry.resetAt <= nowMs) buckets.delete(key); }, 60_000).unref();

// ---------- HTTP pomocné ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new ApiError(413, "payload_too_large", "Požadavek je příliš velký.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new ApiError(400, "invalid_json", "Neplatný formát požadavku.")); }
    });
    req.on("error", reject);
  });
}
// ---------- přihlášení (cookie) ----------
const SESSION_COOKIE = "mistenka_session";
const SECURE_COOKIE = APP_URL.startsWith("https://");
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${SECURE_COOKIE ? "; Secure" : ""}`;
const sessionCookie = (session) => ({ "Set-Cookie": `${SESSION_COOKIE}=${session.token}; Max-Age=${session.maxAgeSeconds}; ${cookieAttrs}` });
const clearCookie = { "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttrs}` };
// Odpověď s novou relací: { user, csrf } + cookie.
const sendLogin = (res, { user, session }) => send(res, 200, { user, csrf: session.csrf }, sessionCookie(session));
// Endpointy, které relaci vytvářejí nebo ji nepotřebují (bez kontroly CSRF).
const CSRF_EXEMPT = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/verify", "/api/auth/magic-link", "/api/auth/magic", "/api/auth/password-reset", "/api/auth/password-reset/confirm", "/api/auth/email/confirm", "/api/jobs/run", "/api/setup", "/api/setup/2fa"]);

const credentialsOf = (req) => ({ token: req.headers["x-mistenka-token"] || "", memberId: req.headers["x-mistenka-member-id"] || "" });

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };
function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const safePath = path.normalize(path.join(FRONTEND, file));
  if (!safePath.startsWith(FRONTEND + path.sep) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) return send(res, 404, { error: "Nenalezeno.", code: "not_found" });
  res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(safePath)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  fs.createReadStream(safePath).pipe(res);
}

// ---------- API ----------
async function handleApi(req, res, url, ip) {
  const { pathname } = url;
  const method = req.method;
  let m;

  // Přihlášený uživatel (nebo null). Měnící požadavky s relací musí nést CSRF token z /auth/me.
  const ctx = accounts.resolveSession(cookieOf(req, SESSION_COOKIE));
  if (ctx && method !== "GET" && method !== "HEAD" && !CSRF_EXEMPT.has(pathname) && !pathname.startsWith("/api/dev/")) {
    if (req.headers["x-mistenka-csrf"] !== ctx.session.csrf) throw new ApiError(403, "csrf_failed", "Platnost stránky vypršela. Načtěte ji prosím znovu.");
  }
  const user = ctx?.user || null;

  if (pathname === "/api/config" && method === "GET") {
    return send(res, 200, publicConfig(config, { today: time.pragueToday(), now: time.now().toISOString(), devMode: DEV }));
  }
  if ((m = pathname.match(/^\/api\/reviry\/([a-z0-9-]+)\/availability$/)) && method === "GET") {
    return send(res, 200, service.availability(m[1]));
  }
  if (pathname === "/api/orders" && method === "POST") {
    if (rateLimited(ip, "order", 10, 60_000)) throw new ApiError(429, "rate_limited", "Příliš mnoho objednávek, zkuste to za chvíli.");
    return send(res, 201, service.createOrder(await readBody(req), user));
  }
  if ((m = pathname.match(/^\/api\/vouchers\/([^/]+)$/)) && method === "GET") {
    if (rateLimited(ip, "voucher", 20, 60_000)) throw new ApiError(429, "rate_limited", "Příliš mnoho pokusů, zkuste to za chvíli.");
    return send(res, 200, service.checkVoucher(m[1]));
  }
  if ((m = pathname.match(/^\/api\/tickets\/([^/]+)$/)) && method === "GET") {
    if (rateLimited(ip, "lookup", 60, 60_000)) throw new ApiError(429, "rate_limited", "Příliš mnoho dotazů, zkuste to za chvíli.");
    return send(res, 200, service.getPublicTicket(m[1]));
  }

  // Operace držitele místenky (token nebo číslo členské legitimace).
  const owner = pathname.match(/^\/api\/orders\/([^/]+)(\/cancel)?$/) || pathname.match(/^\/api\/tickets\/([^/]+)(\/return)$/);
  if (owner) {
    if (rateLimited(ip, "auth_fail", 10, 10 * 60_000, false)) throw new ApiError(429, "rate_limited", "Příliš mnoho neúspěšných pokusů, zkuste to později.");
    const credentials = credentialsOf(req);
    try {
      if (!owner[2] && method === "GET") return send(res, 200, service.getOwnerTicket(owner[1], credentials, user));
      if (owner[2] === "/cancel" && method === "POST") return send(res, 200, service.cancelOrder(owner[1], credentials, user));
      if (owner[2] === "/return" && method === "POST") return send(res, 200, service.submitReturn(owner[1], credentials, await readBody(req), user));
    } catch (error) {
      if (error.code === "forbidden" || error.code === "not_found") rateLimited(ip, "auth_fail", 10, 10 * 60_000);
      throw error;
    }
  }

  // ---------- účty ----------
  if (pathname === "/api/auth/me" && method === "GET") return send(res, 200, accounts.me(ctx));
  if (pathname.startsWith("/api/auth/") && method === "POST") {
    const action = pathname.slice("/api/auth/".length);
    if (["register", "magic-link", "password-reset"].includes(action) && rateLimited(ip, "account_mail", 5, 10 * 60_000)) throw new ApiError(429, "rate_limited", "Příliš mnoho požadavků, zkuste to později.");
    if (action !== "logout" && rateLimited(ip, "auth_fail", 10, 10 * 60_000, false)) throw new ApiError(429, "rate_limited", "Příliš mnoho neúspěšných pokusů, zkuste to později.");
    const body = await readBody(req);
    try {
      if (action === "register") return send(res, 200, accounts.register(body));
      if (action === "verify") return sendLogin(res, accounts.verifyEmail(body));
      if (action === "login") return sendLogin(res, accounts.login(body));
      if (action === "magic-link") return send(res, 200, accounts.requestMagicLink(body));
      if (action === "magic") return sendLogin(res, accounts.magicLogin(body));
      if (action === "password-reset") return send(res, 200, accounts.requestPasswordReset(body));
      if (action === "password-reset/confirm") return sendLogin(res, accounts.resetPassword(body));
      if (action === "email/confirm") return send(res, 200, accounts.confirmEmailChange(body));
      if (action === "logout") return send(res, 200, accounts.logout(cookieOf(req, SESSION_COOKIE)), clearCookie);
    } catch (error) {
      if (["invalid_credentials", "invalid_otp", "invalid_link"].includes(error.code)) rateLimited(ip, "auth_fail", 10, 10 * 60_000);
      if (error.code === "email_not_verified") rateLimited(ip, "account_mail", 5, 10 * 60_000);
      throw error;
    }
  }
  // ---------- průvodce prvním spuštěním ----------
  if (pathname === "/api/setup" && method === "GET") return send(res, 200, accounts.setupStatus());
  if ((pathname === "/api/setup" || pathname === "/api/setup/2fa") && method === "POST") {
    if (rateLimited(ip, "auth_fail", 10, 10 * 60_000, false)) throw new ApiError(429, "rate_limited", "Příliš mnoho neúspěšných pokusů, zkuste to později.");
    const body = await readBody(req);
    try {
      if (pathname === "/api/setup/2fa") return send(res, 200, accounts.setupTwoFactor(body));
      return sendLogin(res, accounts.completeSetup(body));
    } catch (error) {
      if (["invalid_setup_token", "invalid_otp"].includes(error.code)) rateLimited(ip, "auth_fail", 10, 10 * 60_000);
      throw error;
    }
  }
  if (pathname === "/api/me" && method === "PATCH") return send(res, 200, accounts.updateProfile(ctx, await readBody(req)));
  if (pathname === "/api/me/password" && method === "PUT") return send(res, 200, accounts.changePassword(ctx, await readBody(req)));
  if (pathname === "/api/me/delete" && method === "POST") return send(res, 200, accounts.deleteAccount(ctx, await readBody(req)), clearCookie);
  if (pathname === "/api/me/tickets" && method === "GET") return send(res, 200, { tickets: service.ticketsForUser(accounts.requireUser(ctx)) });
  if (pathname === "/api/me/2fa/setup" && method === "POST") return send(res, 200, accounts.twoFactorSetup(ctx));
  if (pathname === "/api/me/2fa/enable" && method === "POST") return send(res, 200, accounts.twoFactorEnable(ctx, await readBody(req)));
  if (pathname === "/api/me/2fa/disable" && method === "POST") return send(res, 200, accounts.twoFactorDisable(ctx, await readBody(req)));

  // ---------- porybný ----------
  if ((m = pathname.match(/^\/api\/warden\/tickets\/([^/]+)$/)) && method === "GET") return send(res, 200, service.wardenCheck(m[1], accounts.requireWarden(ctx)));
  if ((m = pathname.match(/^\/api\/warden\/tickets\/([^/]+)\/seize$/)) && method === "POST") return send(res, 200, service.seizeTicket(m[1], accounts.requireWarden(ctx), await readBody(req)));

  // ---------- manažerský portál ----------
  if (pathname === "/api/manage/users" && method === "GET") return send(res, 200, accounts.listUsers(ctx, { q: url.searchParams.get("q") || "" }));
  if (pathname === "/api/manage/users" && method === "POST") return send(res, 201, accounts.inviteStaff(ctx, await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/users\/(\d+)\/roles$/)) && method === "PUT") return send(res, 200, accounts.setRoles(ctx, m[1], await readBody(req)));

  if (pathname === "/api/jobs/run" && method === "POST") {
    if (!CRON_KEY || req.headers["x-mistenka-cron-key"] !== CRON_KEY) throw new ApiError(404, "not_found", "Nenalezeno.");
    return send(res, 200, await service.runJobs());
  }
  if (pathname === "/api/dev/payments" && method === "POST") {
    return send(res, 200, await service.simulatePayment(await readBody(req)));
  }
  if (pathname === "/api/dev/clock" && method === "POST" && DEV) {
    const body = await readBody(req);
    try { time.setClock(body.now || null); } catch { throw new ApiError(400, "invalid_time", "Neplatný čas."); }
    await service.runJobs({ force: true });
    return send(res, 200, { now: time.now().toISOString(), today: time.pragueToday() });
  }
  if (pathname === "/api/dev/vouchers" && method === "POST" && DEV) {
    return send(res, 201, service.createVoucher(await readBody(req)));
  }
  if (pathname === "/api/dev/users/roles" && method === "POST" && DEV) {
    const body = await readBody(req);
    return send(res, 200, { user: accounts.forceRoles(body.email, body.roles) });
  }
  if (pathname === "/api/dev/setup-token" && method === "POST" && DEV) {
    const setup = accounts.createSetupToken();
    if (!setup) throw new ApiError(404, "setup_closed", "Admin už existuje.");
    return send(res, 200, { token: setup.token });
  }
  if (pathname === "/api/dev/outbox" && method === "GET" && DEV) {
    const to = String(url.searchParams.get("to") || "").toLowerCase();
    const rows = db.prepare("SELECT kind, to_email, subject, body_text, created_at FROM email_outbox WHERE lower(to_email) = ? ORDER BY id DESC LIMIT 20").all(to);
    return send(res, 200, { emails: rows.map((r) => ({ kind: r.kind, to: r.to_email, subject: r.subject, text: r.body_text, createdAt: r.created_at })) });
  }
  if (pathname === "/api/dev/jobs" && method === "POST" && DEV) {
    return send(res, 200, await service.runJobs({ force: true }));
  }
  throw new ApiError(404, "not_found", "Nenalezeno.");
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    if (pathname.startsWith("/api/")) return await handleApi(req, res, url, ip);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Metoda není povolena.", code: "method_not_allowed" });
    return serveStatic(res, pathname);
  } catch (error) {
    if (error instanceof ApiError) return send(res, error.status, { error: error.message, code: error.code });
    console.error(error);
    return send(res, 500, { error: "Server nedokázal požadavek dokončit.", code: "server_error" });
  }
});

const interval = Number(process.env.MISTENKA_JOBS_INTERVAL_MS ?? (provider.name === "fio" ? 31_000 : 10_000));
if (interval > 0) setInterval(() => { service.runJobs().catch((error) => console.error("[úlohy]", error)); }, interval).unref();

server.listen(PORT, () => {
  console.log(`Místenka (${config.organization.shortName}) běží na ${APP_URL} · platby: ${provider.name}${DEV ? " · DEV" : ""}`);
  printSetupLink();
});

// Dokud neexistuje admin, vypíše jednorázový odkaz na průvodce založením (platí 60 minut, nový při každém startu).
function printSetupLink() {
  const setup = accounts.createSetupToken();
  if (!setup) return;
  console.log("");
  console.log("  Zatím neexistuje žádný admin. Založte ho průvodcem (odkaz platí " + setup.minutes + " minut, jen jednou):");
  console.log("  " + setup.link);
  console.log("");
}
