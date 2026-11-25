"use strict";
// Lokální vývojový server Místenky (Node.js + SQLite). Produkční implementace je PHP plugin
// pro WordPress; obě musí dodržet stejnou smlouvu API (docs/API.md) a projít stejnými testy (test/).
//
// Proměnné prostředí:
//   PORT=3000                 port serveru
//   DATA_DIR=data             databáze a odeslané e-maily (outbox)
//   APP_URL=http://localhost:3000   základ odkazů v e-mailech
//   MISTENKA_CONFIG=config/organization.json   konfigurace MO a revírů (bez souboru vzor config/example)
//   MISTENKA_MAPY_API_KEY=...  podklad interaktivní mapy revíru z Mapy.com (jinak OpenStreetMap)
//   MISTENKA_DEV=1            zapne vývojové endpointy (posun času pro testy)
//   MISTENKA_CRON_KEY=...     povolí POST /api/jobs/run s hlavičkou X-Mistenka-Cron-Key
//   MISTENKA_JOBS_INTERVAL_MS interval plánovaných úloh (0 = vypnuto)
//   MISTENKA_RATE_LIMIT=0     vypne omezení počtu požadavků (jen pro testy)
//   FIO_TOKEN=...             token Fio API (jen při payment.provider = "fio")
//   MISTENKA_TEST_MODE=0      zakáže testovací režim (Admin → Testování) – ostrý server
//   MISTENKA_GITHUB_TOKEN, MISTENKA_GITHUB_REPO   hlášení chyb → GitHub issues (token s právem issues, "vlastník/repozitář")
//   MISTENKA_SECRET_KEY=...   klíč pro šifrování hesel SMTP účtů (jinak se vygeneruje DATA_DIR/secret.key)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, publicConfig, getRevir } = require("./lib/config");
const { openDatabase, serviceLaunched, seasonOpen } = require("./lib/db");
const { createProvider, createFakeProvider } = require("./lib/payments");
const { PAYMENTS, VS_RANGES, isTestVs, createTestModeState, seedTestDatabase, syncStaff, createForwardedProvider, testDir } = require("./lib/test-mode");
const { createFileMailer } = require("./lib/emails");
const { createService, ApiError } = require("./lib/service");
const { createAccounts } = require("./lib/accounts");
const { createOperations } = require("./lib/operations");
const { createSettings } = require("./lib/settings");
const { createReports } = require("./lib/reports");
const { createBackups } = require("./lib/backups");
const { createRetention } = require("./lib/retention");
const { createMailAccounts } = require("./lib/mail-accounts");
const { createSmtpMailer } = require("./lib/smtp");
const { createBugs } = require("./lib/bugs");
const { createFioToken } = require("./lib/fio-token");
const time = require("./lib/time");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"));
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEV = process.env.MISTENKA_DEV === "1";
const CRON_KEY = process.env.MISTENKA_CRON_KEY || "";
const FRONTEND = path.join(__dirname, "..", "frontend");

// E-maily: vlastní SMTP klient přes účty z portálu; ve vývoji (MISTENKA_DEV) jen soubory v <data>/outbox.
const MAIL_TRANSPORT = process.env.MISTENKA_MAIL_TRANSPORT || (DEV ? "file" : "smtp");

// Kontext = databáze se všemi službami nad ní. Provoz běží vždy (DATA_DIR), testovací kontext (DATA_DIR/test)
// jen při zapnutém testovacím režimu – pak obslouží všechny požadavky (viz lib/test-mode.js).
function buildContext({ dataDir, test = false, payments = "fake" }) {
  const config = loadConfig();
  if (test) for (const target of [config.source.raw.payment, config.payment]) Object.assign(target, { provider: payments, testMode: true });
  const db = openDatabase(dataDir);
  // Token Fio: FIO_TOKEN, nebo zadaný v portálu (zašifrovaný v provozní databázi); test banku nestahuje.
  const fioToken = test ? null : createFioToken({ db, config, dataDir });
  const provider = test ? (payments === "fio" ? createForwardedProvider() : createFakeProvider()) : createProvider(config, { getToken: () => fioToken.token() });
  const mailer = MAIL_TRANSPORT === "file" ? createFileMailer(path.join(dataDir, "outbox")) : createSmtpMailer();
  const settings = createSettings({ db, config }); // nastavení z portálu (B5) přepíše hodnoty ze souboru
  const operations = createOperations({ db, config, appUrl: APP_URL });
  // SMTP účty (Admin → Emailoví klienti); klíč k heslům je společný – testovací databáze má kopie účtů z provozu.
  const mailAccounts = createMailAccounts({ db, config, dataDir: DATA_DIR, mailer });
  const service = createService({ db, config, provider, mailer, appUrl: APP_URL, operations, settings, mailAccounts, vsRange: VS_RANGES[test ? "test" : "production"], forwardTransaction: test ? null : forwardToTest });
  const accounts = createAccounts({ db, config, appUrl: APP_URL });
  const reports = createReports({ db, config, appUrl: APP_URL });
  // Hlášení chyb; GitHub issue jen s MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO (vlastník/repozitář).
  const bugs = createBugs({ db, config, appUrl: APP_URL, github: { token: process.env.MISTENKA_GITHUB_TOKEN || "", repo: process.env.MISTENKA_GITHUB_REPO || "" } });
  const backups = createBackups({ db, dataDir, onRestored: () => settings.reload() });
  if (db.autoRestored) accounts.notifyAutoRestore(db.autoRestored);
  reports.onSeasonReport((report) => backups.afterSeasonReport(report)); // trvalá záloha po každé uzávěrce
  service.addJob("seasons", () => reports.closeSeasons()); // automatická uzávěrka po skončení sezony
  service.addJob("backups", () => backups.daily()); // denní záloha během sezony (drží se 2)
  const retention = createRetention({ db, config, backups });
  service.addJob("retention", () => retention.run()); // GDPR: anonymizace a mazání po uplynutí lhůt
  service.addJob("accounts", () => accounts.cleanup());
  return { test, payments, config, db, provider, fioToken, settings, operations, mailAccounts, service, accounts, reports, bugs, backups };
}

const testMode = createTestModeState(DATA_DIR);
const prod = buildContext({ dataDir: DATA_DIR });
let testCtx = null;
// Testovací kontext (otevře se při prvním použití; změna plateb v testu ho sestaví znovu).
function testContext() {
  const state = testMode.get();
  if (testCtx && testCtx.payments === state.payments) return testCtx;
  if (testCtx) testCtx.db.close();
  if (!testMode.testDatabaseExists()) { seedTestDatabase(prod.db, DATA_DIR); testMode.save({ seededAt: new Date().toISOString() }); }
  testCtx = buildContext({ dataDir: testDir(DATA_DIR), test: true, payments: state.payments });
  return testCtx;
}
const current = () => (testMode.get().enabled ? testContext() : prod);

// Ostré platby v testu: provoz stahuje z Fio i během testu a transakci s testovacím VS předá testovací databázi.
function forwardToTest(tx) {
  const state = testMode.get();
  if (!state.enabled || state.payments !== "fio" || !isTestVs(tx.variableSymbol)) return null;
  const vs = String(tx.variableSymbol).replace(/^0+/, "");
  if (prod.db.prepare("SELECT 1 FROM tickets WHERE variable_symbol = ?").get(vs)) return null; // starší provozní místenka s VS na 9
  return testContext().service.processTransaction(tx);
}
// Plánované úlohy: provoz vždy (platby, rezervace, e-maily), test jen při zapnutém režimu.
async function runAllJobs(options = {}) {
  const report = await prod.service.runJobs(options);
  if (testMode.get().enabled) report.test = await testContext().service.runJobs(options);
  return report;
}

const actorName = (user) => `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.email; // uživatel relace (řádek tabulky users)
// Ostré platby v testu potřebují Fio v provozu; ve vývoji je zastoupí falešná banka provozu (/dev/payments).
const fioAvailable = () => (prod.provider.name === "fio" && Boolean(prod.fioToken.token())) || DEV;
function testModeView() {
  const state = testMode.get();
  return { enabled: state.enabled, payments: state.payments, locked: testMode.locked, since: state.enabled ? state.since : null, by: state.enabled ? state.by : null,
    seededAt: testMode.testDatabaseExists() ? state.seededAt : null, fioAvailable: fioAvailable() };
}
function setTestMode(actor, body = {}) {
  const before = testMode.get();
  const enabled = body.enabled === undefined ? before.enabled : body.enabled === true;
  const payments = body.payments === undefined ? before.payments : String(body.payments);
  if (!PAYMENTS.includes(payments)) throw new ApiError(400, "invalid_payments", "Platby v testu musí být „fake“ (simulované) nebo „fio“ (ostré).");
  if (payments === "fio" && !fioAvailable()) throw new ApiError(400, "fio_unavailable", "Ostré platby v testu potřebují platby přes Fio (FIO_TOKEN).");
  if (enabled && testMode.locked) throw new ApiError(403, "test_mode_locked", "Testovací režim je na tomto serveru zakázaný (MISTENKA_TEST_MODE=0).");
  const now = new Date().toISOString();
  testMode.save({ enabled, payments, ...(enabled && !before.enabled ? { since: now, by: actorName(actor) } : {}) });
  if (enabled && !before.enabled) syncStaff(prod.db, testContext().db);
  if (enabled !== before.enabled) prod.accounts.notifyTestMode(actor, enabled ? "test_mode_enabled" : "test_mode_disabled", { payments, by: actorName(actor) });
  else if (payments !== before.payments) prod.accounts.notifyTestMode(actor, "test_mode_payments", { payments, by: actorName(actor) });
  return testModeView();
}
function resetTestDatabase(actor) {
  if (testCtx) { testCtx.db.close(); testCtx = null; }
  seedTestDatabase(prod.db, DATA_DIR);
  testMode.save({ seededAt: new Date().toISOString() });
  prod.accounts.notifyTestMode(actor, "test_mode_reset", { by: actorName(actor) });
  return testModeView();
}

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
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new ApiError(413, "payload_too_large", "Požadavek je příliš velký.")); req.destroy(); return; }
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
const CSRF_EXEMPT = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/verify", "/api/auth/magic-link", "/api/auth/magic", "/api/auth/password-reset", "/api/auth/password-reset/confirm", "/api/auth/email/confirm", "/api/jobs/run", "/api/setup", "/api/setup/2fa", "/api/requests/view", "/api/requests/decide"]);

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
  // Databáze podle režimu (provoz / testovací režim); požadavek ji drží až do konce, i když se režim mezitím přepne.
  const c = current();
  const { config, db, service, accounts, operations, settings, mailAccounts, reports, bugs, backups } = c;

  // Přihlášený uživatel (nebo null). Měnící požadavky s relací musí nést CSRF token z /auth/me.
  const ctx = accounts.resolveSession(cookieOf(req, SESSION_COOKIE));
  if (ctx && method !== "GET" && method !== "HEAD" && !CSRF_EXEMPT.has(pathname) && !pathname.startsWith("/api/dev/")) {
    if (req.headers["x-mistenka-csrf"] !== ctx.session.csrf) throw new ApiError(403, "csrf_failed", "Platnost stránky vypršela. Načtěte ji prosím znovu.");
  }
  const user = ctx?.user || null;

  if (pathname === "/api/config" && method === "GET") {
    return send(res, 200, publicConfig(config, { today: time.pragueToday(), now: time.now().toISOString(), devMode: DEV, service: { launched: serviceLaunched(db), seasonOpen: seasonOpen(db, time.pragueToday()) } }));
  }
  // Mapa revíru (veřejná): zakreslené plochy a body.
  if ((m = pathname.match(/^\/api\/maps\/([a-z0-9-]+)$/)) && method === "GET") {
    if (!getRevir(config, m[1])) throw new ApiError(404, "unknown_revir", "Revír neexistuje.");
    return send(res, 200, { revirId: m[1], map: config.maps?.[m[1]] || null });
  }
  if ((m = pathname.match(/^\/api\/reviry\/([a-z0-9-]+)\/availability$/)) && method === "GET") {
    return send(res, 200, service.availability(m[1]));
  }
  // Hlášení chyby (kdokoli; snímek obrazovky až ~1,5 MB).
  if (pathname === "/api/bug-reports" && method === "POST") {
    if (rateLimited(ip, "bug_report", 5, 10 * 60_000)) throw new ApiError(429, "rate_limited", "Příliš mnoho hlášení, zkuste to za chvíli.");
    return send(res, 201, bugs.create(await readBody(req, 3 * 1024 * 1024), user));
  }
  if (pathname === "/api/announcements" && method === "GET") return send(res, 200, operations.activeAnnouncements(url.searchParams.get("revirId") || ""));
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
  if (pathname === "/api/me/community" && method === "GET") { accounts.requireUser(ctx); return send(res, 200, service.communityStats()); }
  if (pathname === "/api/me/stats" && method === "GET") return send(res, 200, service.statsForUser(accounts.requireUser(ctx)));
  if (pathname === "/api/me/limits" && method === "GET") return send(res, 200, service.limitsForMember(accounts.requireUser(ctx), url.searchParams.get("revirId") || ""));
  if (pathname === "/api/me/warden-request" && method === "POST") return send(res, 200, accounts.requestWarden(ctx, await readBody(req)));
  // Žádost „Jsem porybný“ z odkazu v e-mailu správci (bez přihlášení, token z request.html).
  if ((pathname === "/api/requests/view" || pathname === "/api/requests/decide") && method === "POST") {
    if (rateLimited(ip, "auth_fail", 10, 10 * 60_000, false)) throw new ApiError(429, "rate_limited", "Příliš mnoho neúspěšných pokusů, zkuste to později.");
    const body = await readBody(req);
    try {
      return send(res, 200, pathname.endsWith("/view") ? accounts.viewRequestByToken(body) : accounts.decideRequestByToken(body));
    } catch (error) {
      if (error.code === "invalid_link") rateLimited(ip, "auth_fail", 10, 10 * 60_000);
      throw error;
    }
  }
  if (pathname === "/api/me/2fa/setup" && method === "POST") return send(res, 200, accounts.twoFactorSetup(ctx));
  if (pathname === "/api/me/2fa/enable" && method === "POST") return send(res, 200, accounts.twoFactorEnable(ctx, await readBody(req)));
  if (pathname === "/api/me/2fa/disable" && method === "POST") return send(res, 200, accounts.twoFactorDisable(ctx, await readBody(req)));

  // ---------- porybný ----------
  if ((m = pathname.match(/^\/api\/warden\/tickets\/([^/]+)$/)) && method === "GET") return send(res, 200, service.wardenCheck(m[1], accounts.requireWarden(ctx)));
  if ((m = pathname.match(/^\/api\/warden\/tickets\/([^/]+)\/seize$/)) && method === "POST") return send(res, 200, service.seizeTicket(m[1], accounts.requireWarden(ctx), await readBody(req)));

  // ---------- manažerský portál ----------
  if ((m = pathname.match(/^\/api\/manage\/seasons\/(\d+)\/close$/)) && method === "POST") return send(res, 200, operations.closeSeason(accounts.requireManager(ctx), m[1], await readBody(req)));
  // Provoz (B4): důležité zprávy, sezony, mimořádná uzavření.
  const ops = pathname.match(/^\/api\/manage\/(announcements|seasons|closures)(?:\/(\d+))?$/);
  if (ops) {
    const actor = accounts.requireManager(ctx);
    const [, kind, id] = ops;
    if (method === "GET" && !id) return send(res, 200, { announcements: operations.listAnnouncements, seasons: operations.listSeasons, closures: operations.listClosures }[kind]());
    if (method === "POST" && !id) {
      const body = await readBody(req);
      return send(res, 201, { announcements: () => operations.saveAnnouncement(actor, null, body), seasons: () => operations.saveSeason(actor, null, body), closures: () => operations.createClosure(actor, body) }[kind]());
    }
    if (method === "PUT" && id && kind !== "closures") {
      const body = await readBody(req);
      return send(res, 200, kind === "announcements" ? operations.saveAnnouncement(actor, id, body) : operations.saveSeason(actor, id, body));
    }
    if (method === "DELETE" && id) return send(res, 200, { announcements: operations.deleteAnnouncement, seasons: operations.deleteSeason, closures: operations.deleteClosure }[kind](actor, id));
  }
  // Nastavení (B5). Platební údaje jen admin (kontrola v settings.save).
  // Token Fio (jen admin; vždy provozní databáze, i v testovacím režimu): stav, uložení/smazání s kódem 2FA, ověření.
  if (pathname === "/api/manage/settings/fio-token" && method === "GET") { accounts.requireAdmin(ctx); return send(res, 200, { ...prod.fioToken.status(), provider: prod.provider.name }); }
  if (pathname === "/api/manage/settings/fio-token" && method === "PUT") { const body = await readBody(req); return send(res, 200, { ...prod.fioToken.set(accounts.confirmOtp(ctx, body.otp), body), provider: prod.provider.name }); }
  if (pathname === "/api/manage/settings/fio-token/verify" && method === "POST") { accounts.requireAdmin(ctx); return send(res, 200, await prod.fioToken.verify()); }
  if (pathname.startsWith("/api/manage/settings")) {
    const actor = accounts.requireManager(ctx);
    const sub = pathname.slice("/api/manage/settings".length);
    if (sub === "" && method === "GET") return send(res, 200, settings.view(actor));
    if (sub === "/organization" && method === "PUT") { const b = await readBody(req); return send(res, 200, settings.save(actor, "organization", b.data, { note: b.note })); }
    if (sub === "/payment" && method === "PUT") { const b = await readBody(req); return send(res, 200, settings.save(actor, "payment", b.data, { note: b.note })); }
    if (sub === "/reviry" && method === "POST") { const b = await readBody(req); return send(res, 201, settings.save(actor, `revir:${String(b.id || "")}`, b.data, { note: b.note, creating: true })); }
    if ((m = sub.match(/^\/reviry\/([a-z0-9-]+)$/)) && method === "PUT") { const b = await readBody(req); return send(res, 200, settings.save(actor, `revir:${m[1]}`, b.data, { note: b.note })); }
    if (sub === "/species" && method === "PUT") { const b = await readBody(req); return send(res, 200, settings.save(actor, `species:${String(b.ref || "")}`, b.data, { note: b.note })); }
    // Mapa revíru (GeoJSON + náhled PNG) – větší tělo požadavku.
    if ((m = sub.match(/^\/maps\/([a-z0-9-]+)$/)) && method === "PUT") { const b = await readBody(req, 3 * 1024 * 1024); return send(res, 200, settings.save(actor, `map:${m[1]}`, b.data, { note: b.note })); }
    if (sub === "/history" && method === "GET") return send(res, 200, settings.history(url.searchParams.get("scope") || ""));
    if ((m = sub.match(/^\/versions\/(\d+)$/)) && method === "GET") return send(res, 200, settings.versionData(m[1]));
    if ((m = sub.match(/^\/versions\/(\d+)\/restore$/)) && method === "POST") return send(res, 200, settings.restore(actor, m[1]));
    if (sub === "/reset" && method === "POST") { const b = await readBody(req); return send(res, 200, settings.resetToFile(actor, b.scope)); }
    if (sub === "/export" && method === "GET") {
      if (!String(actor.roles).split(",").includes("admin")) throw new ApiError(403, "forbidden_role", "Export nastavení je jen pro admina.");
      return send(res, 200, settings.exportAll(), { "Content-Disposition": `attachment; filename="mistenka-nastaveni-${time.pragueToday()}.json"` });
    }
  }

  // Zálohy a audit (B7) – jen admin.
  if (pathname === "/api/manage/backups" && method === "GET") { accounts.requireAdmin(ctx); return send(res, 200, backups.list()); }
  if (pathname === "/api/manage/backups" && method === "POST") return send(res, 201, backups.manual(accounts.requireAdmin(ctx), await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/backups\/(\d+)\/download$/)) && method === "GET") {
    accounts.requireAdmin(ctx);
    const backup = backups.filePath(m[1]);
    res.writeHead(200, { "Content-Type": "application/vnd.sqlite3", "Content-Length": backup.size, "Content-Disposition": `attachment; filename="${backup.file}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return fs.createReadStream(backup.full).pipe(res);
  }
  if ((m = pathname.match(/^\/api\/manage\/backups\/(\d+)\/restore$/)) && method === "POST") {
    const body = await readBody(req);
    const admin = accounts.confirmOtp(ctx, body.otp);
    return send(res, 200, backups.restore(admin, m[1], body));
  }
  if ((m = pathname.match(/^\/api\/manage\/backups\/(\d+)$/)) && method === "DELETE") return send(res, 200, backups.remove(accounts.requireAdmin(ctx), m[1]));
  // Hlášení chyb – jen admin.
  if (pathname === "/api/manage/bug-reports" && method === "GET") { accounts.requireAdmin(ctx); return send(res, 200, bugs.list({ status: url.searchParams.get("status") || "" })); }
  if ((m = pathname.match(/^\/api\/manage\/bug-reports\/(\d+)$/))) {
    if (method === "GET") { accounts.requireAdmin(ctx); return send(res, 200, bugs.get(m[1])); }
    if (method === "PATCH") return send(res, 200, bugs.update(accounts.requireAdmin(ctx), m[1], await readBody(req)));
  }
  if ((m = pathname.match(/^\/api\/manage\/bug-reports\/(\d+)\/github$/)) && method === "POST") return send(res, 200, await bugs.toGithub(accounts.requireAdmin(ctx), m[1]));
  // E-mailoví klienti: účty spravuje admin, odesílatele skupin vybírá správce.
  if (pathname === "/api/manage/email/accounts" && method === "GET") return send(res, 200, mailAccounts.list(accounts.requireManager(ctx)));
  if (pathname === "/api/manage/email/accounts" && method === "POST") return send(res, 201, mailAccounts.create(accounts.requireManager(ctx), await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/email\/accounts\/(\d+)$/))) {
    if (method === "PUT") return send(res, 200, mailAccounts.update(accounts.requireManager(ctx), m[1], await readBody(req)));
    if (method === "DELETE") return send(res, 200, mailAccounts.remove(accounts.requireManager(ctx), m[1]));
  }
  if ((m = pathname.match(/^\/api\/manage\/email\/accounts\/(\d+)\/verify$/)) && method === "POST") return send(res, 200, await mailAccounts.verify(accounts.requireManager(ctx), m[1], await readBody(req)));
  if (pathname === "/api/manage/email/senders" && method === "PUT") return send(res, 200, mailAccounts.setSenders(accounts.requireManager(ctx), await readBody(req)));
  // Testovací režim (jen admin): stav, přepnutí (s kódem 2FA) a nové založení testovací databáze z provozu.
  if (pathname === "/api/manage/test-mode" && method === "GET") { accounts.requireAdmin(ctx); return send(res, 200, testModeView()); }
  if (pathname === "/api/manage/test-mode" && method === "PUT") { const body = await readBody(req); return send(res, 200, setTestMode(accounts.confirmOtp(ctx, body.otp), body)); }
  if (pathname === "/api/manage/test-mode/reset" && method === "POST") { const body = await readBody(req); return send(res, 200, resetTestDatabase(accounts.confirmOtp(ctx, body.otp))); }
  if (pathname === "/api/manage/audit" && method === "GET") return send(res, 200, accounts.listAudit(ctx, { limit: url.searchParams.get("limit"), action: url.searchParams.get("action") || "" }));

  // Zarybnění, přehledy, uzávěrky (B6).
  if (pathname.startsWith("/api/manage/stocking") || pathname.startsWith("/api/manage/stats") || pathname.startsWith("/api/manage/reports")) {
    const actor = accounts.requireManager(ctx);
    const q = (key) => url.searchParams.get(key) || "";
    if (pathname === "/api/manage/stocking" && method === "GET") return send(res, 200, reports.listStocking({ year: q("year"), revirId: q("revirId"), planned: q("planned") }));
    if (pathname === "/api/manage/stocking" && method === "POST") return send(res, 201, reports.saveStocking(actor, null, await readBody(req)));
    if (pathname === "/api/manage/stocking/budget" && method === "GET") return send(res, 200, reports.getBudget(q("year")));
    if (pathname === "/api/manage/stocking/budget" && method === "PUT") return send(res, 200, reports.setBudget(actor, await readBody(req)));
    if ((m = pathname.match(/^\/api\/manage\/stocking\/(\d+)$/))) {
      if (method === "PUT") return send(res, 200, reports.saveStocking(actor, m[1], await readBody(req)));
      if (method === "DELETE") return send(res, 200, reports.deleteStocking(actor, m[1]));
    }
    if (pathname === "/api/manage/stats" && method === "GET") return send(res, 200, reports.stats({ from: q("from"), to: q("to"), revirId: q("revirId"), seasonId: q("seasonId") }));
    if (pathname === "/api/manage/reports" && method === "GET") return send(res, 200, reports.listReports());
    if (pathname === "/api/manage/reports" && method === "POST") return send(res, 201, reports.createReport(actor, await readBody(req)));
    if ((m = pathname.match(/^\/api\/manage\/reports\/(\d+)$/)) && method === "GET") return send(res, 200, reports.getReport(m[1]));
  }

  // Místenky, platby, poukazy (B4).
  const filters = () => Object.fromEntries(["status", "revirId", "from", "to", "q", "limit", "offset"].map((key) => [key, url.searchParams.get(key) || ""]));
  if (pathname === "/api/manage/tickets" && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.listTickets(filters())); }
  if (pathname === "/api/manage/tickets.csv" && method === "GET") {
    accounts.requireManager(ctx);
    const csv = service.ticketsCsv(filters());
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="mistenky-${time.pragueToday()}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return res.end(csv);
  }
  if ((m = pathname.match(/^\/api\/manage\/tickets\/([^/]+)$/)) && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.ticketDetail(m[1])); }
  if ((m = pathname.match(/^\/api\/manage\/tickets\/([^/]+)\/cancel$/)) && method === "POST") return send(res, 200, service.cancelByManager(accounts.requireManager(ctx), m[1], await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/tickets\/([^/]+)\/catches$/)) && method === "PUT") return send(res, 200, service.correctCatches(accounts.requireManager(ctx), m[1], await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/tickets\/([^/]+)\/clear-suspicion$/)) && method === "POST") return send(res, 200, service.clearSuspicion(accounts.requireManager(ctx), m[1], await readBody(req)));
  if (pathname === "/api/manage/payments" && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.listPayments({ state: url.searchParams.get("state") || "open" })); }
  if ((m = pathname.match(/^\/api\/manage\/payments\/(\d+)\/resolve$/)) && method === "POST") return send(res, 200, service.resolvePayment(accounts.requireManager(ctx), m[1], await readBody(req)));
  if (pathname === "/api/manage/vouchers" && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.listVouchers()); }
  if (pathname === "/api/manage/vouchers" && method === "POST") return send(res, 201, service.generateVouchers(accounts.requireManager(ctx), await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/vouchers\/([^/]+)\/void$/)) && method === "POST") return send(res, 200, service.voidVoucher(accounts.requireManager(ctx), m[1]));
  if (pathname === "/api/manage/violations" && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.listViolations()); }
  if (pathname === "/api/manage/blocks" && method === "GET") { accounts.requireManager(ctx); return send(res, 200, service.listBlocks()); }
  if (pathname === "/api/manage/blocks" && method === "POST") return send(res, 201, service.createBlock(accounts.requireManager(ctx), await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/blocks\/(\d+)\/lift$/)) && method === "POST") return send(res, 200, service.liftBlock(accounts.requireManager(ctx), m[1]));
  if (pathname === "/api/manage/notifications" && method === "GET") return send(res, 200, accounts.listNotifications(ctx));
  if ((m = pathname.match(/^\/api\/manage\/notifications\/(\d+)\/(approve|reject)$/)) && method === "POST") return send(res, 200, accounts.decideNotification(ctx, m[1], m[2], await readBody(req)));
  if (pathname === "/api/manage/users" && method === "GET") return send(res, 200, accounts.listUsers(ctx, { q: url.searchParams.get("q") || "", role: url.searchParams.get("role") || "" }));
  if (pathname === "/api/manage/users" && method === "POST") return send(res, 201, accounts.inviteStaff(ctx, await readBody(req)));
  if ((m = pathname.match(/^\/api\/manage\/users\/(\d+)\/roles$/)) && method === "PUT") return send(res, 200, accounts.setRoles(ctx, m[1], await readBody(req)));

  if (pathname === "/api/jobs/run" && method === "POST") {
    if (!CRON_KEY || req.headers["x-mistenka-cron-key"] !== CRON_KEY) throw new ApiError(404, "not_found", "Nenalezeno.");
    return send(res, 200, await runAllJobs());
  }
  if (pathname === "/api/dev/payments" && method === "POST") {
    const body = await readBody(req);
    if (c.test && c.payments === "fio") {
      // Ostré platby v testu: příchozí platbu simuluje falešná banka provozu (jen vývoj) a provoz ji předá testu.
      if (!DEV || prod.provider.name !== "fake") throw new ApiError(404, "not_found", "Simulace plateb je dostupná jen s falešnou bankou.");
      const ticket = body.code ? db.prepare("SELECT variable_symbol, amount_due_halere FROM tickets WHERE code = ?").get(String(body.code).toUpperCase()) : null;
      return send(res, 200, await prod.service.simulatePayment({ variableSymbol: body.variableSymbol || ticket?.variable_symbol, amountHalere: body.amountHalere ?? ticket?.amount_due_halere, currency: body.currency }));
    }
    return send(res, 200, await service.simulatePayment(body));
  }
  if (pathname === "/api/dev/clock" && method === "POST" && DEV) {
    const body = await readBody(req);
    try { time.setClock(body.now || null); } catch { throw new ApiError(400, "invalid_time", "Neplatný čas."); }
    await runAllJobs({ force: true });
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
    const rows = db.prepare("SELECT kind, to_email, subject, body_text, body_html, created_at FROM email_outbox WHERE lower(to_email) = ? ORDER BY id DESC LIMIT 20").all(to);
    return send(res, 200, { emails: rows.map((r) => ({ kind: r.kind, to: r.to_email, subject: r.subject, text: r.body_text, html: r.body_html, createdAt: r.created_at })) });
  }
  if (pathname === "/api/dev/jobs" && method === "POST" && DEV) {
    return send(res, 200, await runAllJobs({ force: true }));
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

const interval = Number(process.env.MISTENKA_JOBS_INTERVAL_MS ?? (prod.provider.name === "fio" ? 31_000 : 10_000));
if (interval > 0) setInterval(() => { runAllJobs().catch((error) => console.error("[úlohy]", error)); }, interval).unref();

server.listen(PORT, () => {
  const state = testMode.get();
  console.log(`Místenka (${prod.config.organization.shortName}) běží na ${APP_URL} · port ${server.address().port} · platby: ${prod.provider.name}${DEV ? " · DEV" : ""}${state.enabled ? ` · TESTOVACÍ REŽIM (platby ${state.payments})` : ""}`);
  printSetupLink();
});

// Dokud neexistuje admin, vypíše jednorázový odkaz na průvodce založením (platí 60 minut, nový při každém startu).
function printSetupLink() {
  const setup = prod.accounts.createSetupToken();
  if (!setup) return;
  console.log("");
  console.log("  Zatím neexistuje žádný admin. Založte ho průvodcem (odkaz platí " + setup.minutes + " minut, jen jednou):");
  console.log("  " + setup.link);
  console.log("");
}
