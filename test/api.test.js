"use strict";
// Sdílené testy API – stejná sada musí projít proti Node serveru i proti WordPress pluginu.
//
//   node test/api.test.js                 spustí vlastní Node server s testovací konfigurací
//   node test/api.test.js --base <url>    testuje běžící server, např.
//                                         --base "https://test.rybarikarvina.cz/?rest_route=/mistenka/v1"
//
// Cílový server musí běžet s konfigurací test/fixtures/organization.test.json, falešnou bankou,
// vývojovým režimem (endpointy /dev/clock, /dev/payments, /dev/vouchers) a vypnutými limity požadavků.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const argIndex = process.argv.indexOf("--base");
let BASE = argIndex > -1 ? process.argv[argIndex + 1].replace(/\/$/, "") : "";
let child = null;
let tmpDir = null;

before(async () => {
  if (BASE) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mistenka-test-"));
  // PORT=0: volný port vybere systém, server ho vypíše (žádné kolize při souběhu).
  child = spawn(process.execPath, ["--no-warnings", path.join(__dirname, "..", "src", "node", "server.js")], {
    env: { ...process.env, PORT: "0", DATA_DIR: tmpDir, MISTENKA_CONFIG: path.join(__dirname, "fixtures", "organization.test.json"), MISTENKA_DEV: "1", MISTENKA_RATE_LIMIT: "0", MISTENKA_JOBS_INTERVAL_MS: "0", APP_URL: "http://localhost:3999" },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; const m = out.match(/běží na .* · port (\d+)/); if (m) resolve(m[1]); });
    child.on("exit", (code) => reject(new Error(`Server skončil (${code}).`)));
  });
  BASE = `http://localhost:${port}/api`;
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------- pomocné ----------
function url(p) {
  // Prefix WordPressu už obsahuje "?" (/?rest_route=…), další parametry se připojí přes "&".
  return BASE.includes("?") ? BASE + p.replace("?", "&") : BASE + p;
}
// session = { cookie, csrf } – „prohlížeč“ přihlášeného uživatele; cookie i CSRF se aktualizují z odpovědí.
async function call(method, p, { body, token, memberId, session, csrf } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Mistenka-Token"] = token;
  if (memberId) headers["X-Mistenka-Member-Id"] = memberId;
  if (session?.cookie) headers.Cookie = session.cookie;
  const csrfValue = csrf === undefined ? session?.csrf : csrf;
  if (csrfValue) headers["X-Mistenka-Csrf"] = csrfValue;
  const response = await fetch(url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (session) {
    const setCookie = response.headers.get("set-cookie");
    const match = setCookie && setCookie.match(/mistenka_session=([^;]*)/);
    if (match) session.cookie = match[1] ? `mistenka_session=${match[1]}` : "";
    if (data && typeof data === "object" && "csrf" in data) session.csrf = data.csrf;
  }
  return { status: response.status, data };
}
const setClock = (now) => call("POST", "/dev/clock", { body: { now } });
const pay = (body) => call("POST", "/dev/payments", { body });
let seq = 0;
function orderBody(overrides = {}) {
  seq += 1;
  // Revír A prodává místenky na podrevíry (1: 200 Kč / 30 míst, 2: 250 Kč / 2 místa) – výchozí podrevír 1.
  const sub = !overrides.revirId || overrides.revirId === "revir-a" ? { subdistrict: 1 } : {};
  return { revirId: "revir-a", date: "2026-06-10", memberId: String(30000000 + seq), firstName: "Jan", lastName: "Tester", birthDate: "1985-03-02", email: `tester${seq}@example.cz`, declaration: true, ...sub, ...overrides };
}
async function order(overrides) {
  const res = await call("POST", "/orders", { body: orderBody(overrides) });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}
async function paidTicket(overrides) {
  const { token, ticket } = await order(overrides);
  const paid = await pay({ code: ticket.code });
  assert.equal(paid.data.result, "matched");
  return { token, code: ticket.code, memberId: ticket.memberId };
}
const PERSONAL_KEYS = ["email", "birthDate", "firstName", "lastName", "memberId"];

// ---------- účty (B1) ----------
const { totp } = require("../src/node/lib/security");
const T0 = Date.parse("2026-06-10T08:00:00Z");
let accountSeq = 0;
function accountBody(overrides = {}) {
  accountSeq += 1;
  return { email: `ucet${accountSeq}@example.cz`, password: "tajne-heslo-123", firstName: "Eva", lastName: "Účtová", birthDate: "1990-04-01", memberId: String(50000000 + accountSeq), consent: true, ...overrides };
}
async function lastEmail(to, kind) {
  const { data } = await call("GET", `/dev/outbox?to=${encodeURIComponent(to)}`);
  return data.emails.find((mail) => !kind || mail.kind === kind) || null;
}
async function linkToken(to, kind, fragment) {
  const mail = await lastEmail(to, kind);
  assert.ok(mail, `chybí e-mail ${kind} pro ${to}`);
  const match = mail.text.match(new RegExp(`#${fragment}=([A-Za-z0-9_-]+)`));
  assert.ok(match, mail.text);
  return match[1];
}
// Registrace + ověření e-mailu → přihlášená relace.
async function verifiedAccount(overrides) {
  const body = accountBody(overrides);
  assert.equal((await call("POST", "/auth/register", { body })).status, 200);
  const session = {};
  const verified = await call("POST", "/auth/verify", { body: { token: await linkToken(body.email, "account_verify", "verify") }, session });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return { ...body, session, user: verified.data.user };
}
async function enableTwoFactor(session, atMs) {
  const setup = await call("POST", "/me/2fa/setup", { session });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  await setClock(new Date(atMs).toISOString());
  const enabled = await call("POST", "/me/2fa/enable", { body: { otp: totp(setup.data.secret, atMs) }, session });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  return setup.data.secret;
}

// ---------- první spuštění (musí běžet první: průvodce založí admina, ten pak spustí službu) ----------
const ROOT = { email: "admin@example.cz", password: "admin-heslo", secret: null, session: null };
const LAUNCH = { season: null, accountId: null };
test("průvodce prvním spuštěním: admin vznikne jen s jednorázovým odkazem a rovnou s 2FA", async () => {
  await setClock("2026-06-10T08:00:00Z");
  assert.deepEqual((await call("GET", "/setup")).data, { needed: true });
  assert.equal((await call("POST", "/setup/2fa", { body: { token: "spatny-token" } })).data.code, "invalid_setup_token");
  const { token } = (await call("POST", "/dev/setup-token")).data;
  const setup = await call("POST", "/setup/2fa", { body: { token } });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.ok(setup.data.otpauthUrl.startsWith("otpauth://totp/"));
  const body = { token, email: "Admin@Example.cz", firstName: "Hlavní", lastName: "Admin", password: "admin-heslo" };
  assert.equal((await call("POST", "/setup", { body: { ...body, password: "kratke" } })).data.code, "weak_password");
  assert.equal((await call("POST", "/setup", { body: { ...body, otp: "000000" } })).data.code, "invalid_otp");
  const session = {};
  const done = await call("POST", "/setup", { body: { ...body, otp: totp(setup.data.secret, T0) }, session });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.user.roles, ["member", "admin"]);
  assert.equal(done.data.user.twoFactor, true);
  assert.equal(done.data.user.mfaRequired, false);
  assert.equal(done.data.user.staffOnly, true, "admin nemusí mít rybářské údaje");
  assert.equal(done.data.user.memberId, null);
  assert.equal((await call("GET", "/manage/users", { session })).status, 200, "admin může hned spravovat");
  assert.deepEqual((await call("GET", "/setup")).data, { needed: false });
  assert.equal((await call("POST", "/setup", { body: { ...body, otp: totp(setup.data.secret, T0 + 30_000) } })).data.code, "setup_closed");
  assert.equal((await call("POST", "/dev/setup-token")).status, 404, "dokud admin existuje, nový odkaz nevznikne");
  // Přihlášení admina: heslo + 2FA.
  await setClock(new Date(T0 + 60_000).toISOString());
  assert.equal((await call("POST", "/auth/login", { body: { email: "admin@example.cz", password: "admin-heslo" } })).data.code, "otp_required");
  const rootSession = {};
  assert.equal((await call("POST", "/auth/login", { body: { email: "admin@example.cz", password: "admin-heslo", otp: totp(setup.data.secret, T0 + 60_000) }, session: rootSession })).status, 200, "správa se přihlásí i před spuštěním služby");
  Object.assign(ROOT, { secret: setup.data.secret, session: rootSession });
});


// Zavřeno, dokud správa ručně neotevře první sezonu; otevřít ji jde až s nastavenými e-maily (výchozí odesílání neexistuje).
test("spuštění služby: před otevřením první sezony je zavřeno, otevřít ji lze až s nastavenými e-maily", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const session = ROOT.session;
  assert.deepEqual((await call("GET", "/config")).data.service, { launched: false, seasonOpen: false });
  const days = (await call("GET", "/reviry/revir-a/availability")).data.days;
  assert.ok(days.every((d) => d.closed && d.closedReason === "Sezona zatím nebyla otevřena"), JSON.stringify(days[0]));
  assert.equal((await call("POST", "/orders", { body: orderBody() })).data.code, "out_of_season");
  const blocked = await call("POST", "/auth/register", { body: accountBody() });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "service_not_launched", "registrace až po spuštění");

  const email = (await call("GET", "/manage/email/accounts", { session })).data;
  assert.equal(email.ready, false);
  assert.deepEqual(email.missing, ["tickets", "accounts", "notices", "bugs", "noticeRecipients"]);
  assert.deepEqual(email.noticeRecipients, []);
  assert.ok(!("fallback" in email), "výchozí odesílatel neexistuje");
  const season = { name: "Sezona 2026", opensOn: "2026-01-01" };
  assert.equal((await call("POST", "/manage/seasons", { body: season, session })).data.code, "email_not_ready");
  const created = await call("POST", "/manage/email/accounts", { body: { label: "Místenka MO", fromEmail: "mistenka@example.cz", fromName: "Místenka MO Test", host: "smtp.example.cz", port: 465, encryption: "ssl", username: "mistenka@example.cz", password: "smtp-heslo" }, session });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const account = created.data.account;
  assert.equal((await call("POST", `/manage/email/accounts/${account.id}/verify`, { body: { to: ROOT.email }, session })).status, 200);
  assert.equal((await call("PUT", "/manage/email/senders", { body: { noticeRecipients: "spravce-mo@example.cz, spatna" }, session })).data.code, "invalid_email");
  const partial = await call("PUT", "/manage/email/senders", { body: { tickets: account.id, accounts: account.id }, session });
  assert.deepEqual(partial.data.missing, ["notices", "bugs", "noticeRecipients"]);
  const saved = await call("PUT", "/manage/email/senders", { body: { notices: account.id, bugs: account.id, noticeRecipients: ["Spravce-MO@example.cz", "vybor@example.cz", "vybor@example.cz"] }, session });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.noticeRecipients, ["spravce-mo@example.cz", "vybor@example.cz"]);
  assert.equal(saved.data.ready, true);

  const opened = await call("POST", "/manage/seasons", { body: season, session });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  assert.equal(opened.data.season.state, "open");
  assert.deepEqual((await call("GET", "/config")).data.service, { launched: true, seasonOpen: true });
  assert.equal((await call("GET", "/reviry/revir-a/availability")).data.days[0].closed, false);
  Object.assign(LAUNCH, { season: opened.data.season, accountId: account.id });
});

// ---------- konfigurace a dostupnost ----------
test("GET /config vrací veřejnou konfiguraci bez tajných údajů", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { status, data } = await call("GET", "/config");
  assert.equal(status, 200);
  assert.equal(data.organization.shortName, "MO Test");
  assert.deepEqual(data.reviry.map((r) => r.id), ["revir-a", "revir-b"]);
  assert.equal(data.today, "2026-06-10");
  assert.equal(data.payment.mode, "fake");
  const [a, b] = data.reviry.map((r) => r.fishRules);
  assert.ok(a.species.length >= 40, "kompletní seznam druhů ze souboru pravidel organizace");
  assert.equal(a.id, "crs-smas-mp-2026-2027");
  const lin = (rules) => rules.species.find((s) => s.id === "lin-obecny");
  assert.equal(lin(a).minLength, 25, "lín podle BPVRP");
  assert.equal(lin(b).minLength, 30, "revír může míru zpřísnit (speciesOverrides)");
  assert.ok(a.dailyLimits.some((l) => l.maxCount === 2), "denní limit významných druhů");
  assert.ok(!("speciesOverrides" in data.reviry[1]) && !("speciesRules" in data), "interní odkazy se neposílají");
  assert.deepEqual(data.reviry[0].ticketSubdistricts, [1, 2], "místenka může platit pro více podrevírů");
  const text = JSON.stringify(data);
  for (const secret of ["accountNumber", "iban", "FIO", "token"]) assert.ok(!text.includes(secret), `konfigurace nesmí obsahovat ${secret}`);
});

test("GET /reviry/{id}/availability vrací dny od dneška", async () => {
  const { status, data } = await call("GET", "/reviry/revir-a/availability");
  assert.equal(status, 200);
  assert.deepEqual(data.days.map((d) => d.date), ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"]);
  assert.equal(data.days[0].capacity, 32, "součet míst podrevírů v prodeji");
  assert.deepEqual(data.days[0].subdistricts.map((s) => [s.number, s.name, s.priceCzk, s.capacity]), [[1, "Horní nádrž", 200, 30], [2, "Dolní nádrž", 250, 2]]);
  assert.deepEqual((await call("GET", "/reviry/revir-b/availability")).data.days[0].subdistricts, [], "revír bez podrevírů v prodeji");
  assert.equal((await call("GET", "/reviry/neexistuje/availability")).status, 404);
});

// ---------- objednávka ----------
test("POST /orders validuje vstup", async () => {
  const cases = [
    [{ declaration: false }, "declaration_required"],
    [{ date: "2026-06-09" }, "invalid_date"],
    [{ date: "2026-06-14" }, "invalid_date"],
    [{ date: "10. června" }, "invalid_date"],
    [{ revirId: "neexistuje" }, "unknown_revir"],
    [{ email: "bez-zavinace" }, "invalid_email"],
    [{ memberId: "1234567" }, "invalid_member_id"],
    [{ memberId: "12345678A" }, "invalid_member_id"],
    [{ memberId: "CZ-2026-18472" }, "invalid_member_id"],
    [{ firstName: "" }, "invalid_name"],
    [{ birthDate: "2030-01-01" }, "invalid_birth_date"],
    [{ voucherCode: "KRATKY" }, "invalid_voucher"]
  ];
  for (const [overrides, code] of cases) {
    const res = await call("POST", "/orders", { body: orderBody(overrides) });
    assert.equal(res.status, 400, `${JSON.stringify(overrides)} → ${res.status}`);
    assert.equal(res.data.code, code, JSON.stringify(overrides));
  }
});

test("POST /orders vytvoří objednávku čekající na platbu s QR platbou", async () => {
  const { token, ticket } = await order();
  assert.match(ticket.code, /^[A-Z0-9]{6}$/);
  assert.ok(token.length >= 20);
  assert.equal(ticket.status, "pending_payment");
  assert.equal(ticket.amountDueHalere, 20000);
  const p = ticket.payment;
  assert.match(p.variableSymbol, /^\d{1,10}$/);
  assert.equal(p.amountHalere, 20000);
  assert.ok(p.spayd.startsWith("SPD*1.0*ACC:CZ"), p.spayd);
  assert.ok(p.spayd.includes("20100000002401876543"), "IBAN z čísla účtu");
  assert.ok(p.spayd.includes("*AM:200.00*CC:CZK*"), p.spayd);
  assert.ok(p.spayd.includes(`*X-VS:${p.variableSymbol}`), p.spayd);
  assert.equal(new Date(p.reservedUntil).toISOString(), "2026-06-10T09:00:00.000Z", "rezervace 60 minut");
});

test("veřejná kontrola nevrací osobní údaje, nezaplacená místenka nemá držitele", async () => {
  const { ticket } = await order();
  const { status, data } = await call("GET", `/tickets/${ticket.code}`);
  assert.equal(status, 200);
  assert.equal(data.status, "pending_payment");
  assert.equal(data.holder, null);
  for (const key of PERSONAL_KEYS) assert.ok(!(key in data), `veřejná odpověď obsahuje ${key}`);
  assert.equal((await call("GET", "/tickets/ZZZZZZ")).status, 404);
  assert.equal((await call("GET", "/tickets/abc")).data.code, "invalid_code");
});

test("detail objednávky vyžaduje token nebo číslo členské legitimace", async () => {
  const { token, ticket } = await order({ memberId: "1234 5678" });
  assert.equal(ticket.memberId, "12345678", "mezery v čísle legitimace se ignorují");
  assert.equal((await call("GET", `/orders/${ticket.code}`)).status, 403);
  assert.equal((await call("GET", `/orders/${ticket.code}`, { token: "spatny-token-1234567890" })).status, 403);
  assert.equal((await call("GET", `/orders/${ticket.code}`, { memberId: "87654321" })).status, 403);
  const byToken = await call("GET", `/orders/${ticket.code}`, { token });
  assert.equal(byToken.status, 200);
  assert.equal(byToken.data.email, ticket.email);
  const byMemberId = await call("GET", `/orders/${ticket.code}`, { memberId: "1234 5678" });
  assert.equal(byMemberId.status, 200);
});

// ---------- platby ----------
test("párování plateb: špatná částka, správná platba, duplicita", async () => {
  const { token, ticket } = await order();
  const vs = ticket.payment.variableSymbol;
  assert.equal((await pay({ variableSymbol: vs, amountHalere: 15000 })).data.result, "amount_mismatch");
  assert.equal((await call("GET", `/orders/${ticket.code}`, { token })).data.status, "pending_payment");
  assert.equal((await pay({ variableSymbol: "1", amountHalere: 20000 })).data.result, "unmatched");
  assert.equal((await pay({ variableSymbol: vs, amountHalere: 20000 })).data.result, "matched");
  const issued = (await call("GET", `/orders/${ticket.code}`, { token })).data;
  assert.equal(issued.status, "active");
  assert.equal(issued.payment, null);
  assert.equal((await pay({ variableSymbol: vs, amountHalere: 20000 })).data.result, "duplicate_payment");
  const pub = (await call("GET", `/tickets/${ticket.code}`)).data;
  assert.equal(pub.holder.name, "Jan Tester");
  assert.ok(pub.holder.memberId.startsWith("•") && pub.holder.memberId.endsWith(ticket.memberId.slice(-4)), "číslo legitimace je maskované");
});

test("kapacita revíru se hlídá na serveru a uvolní se zrušením", async () => {
  const date = "2026-06-12";
  const first = await order({ revirId: "revir-b", date });
  await order({ revirId: "revir-b", date });
  const full = await call("POST", "/orders", { body: orderBody({ revirId: "revir-b", date }) });
  assert.equal(full.status, 409);
  assert.equal(full.data.code, "sold_out");
  const day = (await call("GET", "/reviry/revir-b/availability")).data.days.find((d) => d.date === date);
  assert.equal(day.available, 0);
  const cancelled = await call("POST", `/orders/${first.ticket.code}/cancel`, { token: first.token });
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal((await call("POST", `/orders/${first.ticket.code}/cancel`, { token: first.token })).data.code, "not_cancellable");
  await order({ revirId: "revir-b", date });
});

test("vypršení rezervace uvolní místo; pozdní platba projde jen při volném místě", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const date = "2026-06-13";
  const a = await order({ revirId: "revir-b", date });
  const b = await order({ revirId: "revir-b", date });
  await setClock("2026-06-10T09:01:00Z");
  assert.equal((await call("GET", `/tickets/${a.ticket.code}`)).data.status, "payment_expired");
  assert.equal((await call("GET", "/reviry/revir-b/availability")).data.days.find((d) => d.date === date).available, 2);
  // Místo A je volné -> pozdní platba se přijme.
  assert.equal((await pay({ code: a.ticket.code })).data.result, "matched");
  // Mezitím někdo obsadí poslední místo -> pozdní platba B jde k ručnímu řešení.
  await order({ revirId: "revir-b", date });
  assert.equal((await pay({ code: b.ticket.code })).data.result, "late");
  assert.equal((await call("GET", `/tickets/${b.ticket.code}`)).data.status, "payment_expired");
  await setClock("2026-06-10T08:00:00Z");
});

// ---------- poukazy ----------
test("poukaz vystaví místenku zdarma a jde použít jen jednou", async () => {
  const voucher = await call("POST", "/dev/vouchers", { body: { code: "TESTPOUKAZ000001" } });
  assert.equal(voucher.status, 201);
  assert.equal((await call("GET", "/vouchers/TESTPOUKAZ000001")).data.valid, true);
  const { ticket } = await order({ voucherCode: "testpoukaz000001" });
  assert.equal(ticket.status, "active");
  assert.equal(ticket.amountDueHalere, 0);
  assert.equal(ticket.voucherUsed, true);
  assert.equal(ticket.payment, null);
  const again = await call("POST", "/orders", { body: orderBody({ voucherCode: "TESTPOUKAZ000001" }) });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "voucher_used");
  assert.equal((await call("GET", "/vouchers/TESTPOUKAZ000001")).data.valid, false);
  await call("POST", "/dev/vouchers", { body: { code: "JENPROREVIRB0001", revirId: "revir-b" } });
  assert.equal((await call("POST", "/orders", { body: orderBody({ voucherCode: "JENPROREVIRB0001" }) })).data.code, "invalid_voucher");
});

// ---------- odevzdání ----------
test("odevzdání: validace úlovků, míry, hájení, povinné vrácení, úspěch, opakování", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { token, code } = await paidTicket({ revirId: "revir-b" });
  const ret = (body) => call("POST", `/tickets/${code}/return`, { body, token });
  assert.equal((await call("POST", `/tickets/${code}/return`, { body: { noCatch: true } })).status, 403);
  assert.equal((await ret({ catches: [] })).data.code, "catches_required");
  assert.equal((await ret({ noCatch: true, catches: [{ species: "kapr", length: 50 }] })).data.code, "invalid_catches");
  assert.equal((await ret({ catches: [{ species: "", length: 40 }] })).data.code, "invalid_catches");
  const ok = await ret({ catches: [{ species: "Kapr", length: 52, weight: 2.1, weightEstimated: true }, { species: "plotice", length: 20 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "expired_returned");
  assert.equal(ok.data.late, false);
  assert.deepEqual(ok.data.catches.map((c) => c.species), ["kapr obecný", "plotice obecná"], "druh se zapíše v kanonickém tvaru");
  assert.equal(ok.data.catches[0].weightEstimated, true);
  assert.deepEqual(ok.data.catches.map((c) => c.warning), [null, null]);
  assert.equal((await ret({ noCatch: true })).data.code, "already_returned");

  // Míra, hájení a povinné vrácení odevzdání nebrání (rozhodují pravidla v RIS) – úlovek dostane upozornění.
  const second = await paidTicket({ date: "2026-06-11" });
  await setClock("2026-06-11T08:00:00Z");
  const warned = await call("POST", `/tickets/${second.code}/return`, { token: second.token, body: { catches: [
    { species: "lín", length: 22 }, { species: "kapr", length: 39 }, { species: "kapr", length: 72 }, { species: "štika obecná", length: 80 }, { species: "lipan", length: 40 }, { species: "plotice", length: 20 }] } });
  assert.equal(warned.status, 200, JSON.stringify(warned.data));
  const w = warned.data.catches.map((c) => c.warning);
  assert.match(w[0], /lovnou mírou \(25 cm\)/);
  assert.match(w[1], /lovnou mírou \(40 cm\)/);
  assert.match(w[2], /od 70 cm se musí vrátit/, "kapr od 70 cm se vrací");
  assert.match(w[3], /době hájení/, "štika hájena do 15. 6.");
  assert.match(w[4], /celoročně hájen/, "lipan celoročně hájen");
  assert.equal(w[5], null);
  const warden = await wardenAccount();
  const checked = (await call("GET", `/warden/tickets/${second.code}`, { session: warden.session })).data;
  assert.equal(checked.catches.filter((c) => c.warning).length, 5, "porybný vidí upozornění");
});

test("odevzdání: před dnem lovu nelze, opožděně do 7 dnů lze, pak se místenka uzavře jako neodevzdaná", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const future = await paidTicket({ date: "2026-06-11" });
  assert.equal((await call("POST", `/tickets/${future.code}/return`, { body: { noCatch: true }, token: future.token })).data.code, "too_early");
  const lateOne = await paidTicket();
  const closed = await paidTicket();
  await setClock("2026-06-11T08:00:00Z"); // druhý den dopoledne
  const status = (await call("GET", `/orders/${lateOne.code}`, { memberId: lateOne.memberId })).data;
  assert.equal(status.status, "expired_unreturned");
  assert.equal(status.returnable, true);
  const late = await call("POST", `/tickets/${lateOne.code}/return`, { body: { noCatch: true }, memberId: lateOne.memberId });
  assert.equal(late.status, 200, JSON.stringify(late.data));
  assert.equal(late.data.late, true);
  assert.equal(late.data.noCatch, true);
  await setClock("2026-06-17T21:59:00Z"); // těsně před koncem 7denní lhůty (konec dne lovu 10. 6. 22:00 UTC + 7 dní)
  const lastDay = (await call("GET", `/orders/${closed.code}`, { token: closed.token })).data;
  assert.equal(lastDay.status, "expired_unreturned");
  assert.equal(lastDay.returnDeadline, "2026-06-17T22:00:00.000Z");
  await setClock("2026-06-17T22:00:01Z"); // po lhůtě – úlohy místenku uzavřou
  const closedTicket = (await call("GET", `/orders/${closed.code}`, { token: closed.token })).data;
  assert.equal(closedTicket.status, "closed_unreturned");
  assert.equal(closedTicket.late, true);
  assert.equal(closedTicket.returnable, false);
  assert.ok(closedTicket.closedAt, "uzavření je zaznamenané");
  assert.deepEqual(closedTicket.catches, []);
  assert.equal((await call("GET", `/tickets/${closed.code}`)).data.status, "closed_unreturned");
  assert.equal((await call("POST", `/tickets/${closed.code}/return`, { body: { noCatch: true }, token: closed.token })).data.code, "return_closed");
  await setClock("2026-06-10T08:00:00Z");
});

// ---------- čas ----------
test("platnost místenky respektuje pásmo Europe/Prague a přelom roku", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const summer = (await call("GET", `/tickets/${(await paidTicket()).code}`)).data;
  assert.equal(summer.validFrom, "2026-06-09T22:00:00.000Z", "letní čas UTC+2");
  assert.equal(summer.validTo, "2026-06-10T22:00:00.000Z");
  await setClock("2026-12-30T10:00:00Z");
  const winter = await paidTicket({ date: "2026-12-31" });
  const w = (await call("GET", `/tickets/${winter.code}`)).data;
  assert.equal(w.validFrom, "2026-12-30T23:00:00.000Z", "zimní čas UTC+1");
  assert.equal(w.status, "future");
  await setClock("2027-01-01T09:00:00Z");
  assert.equal((await call("GET", `/tickets/${winter.code}`)).data.status, "expired_unreturned", "po přelomu roku místenka propadne, nezačne znovu platit");
  await setClock("2026-06-10T08:00:00Z");
});

test("registrace: validace, ověření e-mailu, přihlášení heslem, odhlášení", async () => {
  await setClock("2026-06-10T08:00:00Z");
  for (const [overrides, code] of [[{ consent: false }, "consent_required"], [{ password: "kratke" }, "weak_password"], [{ memberId: "123" }, "invalid_member_id"], [{ email: "x" }, "invalid_email"]]) {
    const res = await call("POST", "/auth/register", { body: accountBody(overrides) });
    assert.equal(res.data?.code, code, JSON.stringify(overrides));
  }
  const body = accountBody();
  assert.deepEqual((await call("POST", "/auth/register", { body })).data, { sent: true });
  assert.equal((await call("POST", "/auth/login", { body: { email: body.email, password: body.password } })).data.code, "email_not_verified");
  assert.deepEqual((await call("GET", "/auth/me")).data, { user: null, csrf: null });

  const token = await linkToken(body.email, "account_verify", "verify");
  const session = {};
  const verified = await call("POST", "/auth/verify", { body: { token }, session });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.email, body.email);
  assert.deepEqual(verified.data.user.roles, ["member"]);
  assert.ok(session.cookie && session.csrf, "relace v cookie + CSRF token");
  assert.equal((await call("POST", "/auth/verify", { body: { token } })).data.code, "invalid_link", "odkaz jde použít jen jednou");
  const me = await call("GET", "/auth/me", { session });
  assert.equal(me.data.user.memberId, body.memberId);
  assert.equal(me.data.csrf, session.csrf);

  assert.equal((await call("POST", "/auth/login", { body: { email: body.email, password: "spatne-heslo-1" } })).data.code, "invalid_credentials");
  assert.equal((await call("POST", "/auth/login", { body: { email: "nikdo@example.cz", password: "spatne-heslo-1" } })).data.code, "invalid_credentials");
  const second = {};
  assert.equal((await call("POST", "/auth/login", { body: { email: body.email.toUpperCase(), password: body.password }, session: second })).status, 200, "e-mail bez ohledu na velikost písmen");
  const secondCookie = second.cookie;
  assert.equal((await call("POST", "/auth/logout", { session: second })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session: { cookie: secondCookie } })).data.user, null, "relace po odhlášení neplatí");

  // Opakovaná registrace neprozradí existenci účtu; číslo legitimace je unikátní.
  assert.deepEqual((await call("POST", "/auth/register", { body: { ...body, memberId: "59999999" } })).data, { sent: true });
  assert.ok(await lastEmail(body.email, "account_exists"));
  const taken = await call("POST", "/auth/register", { body: accountBody({ memberId: body.memberId }) });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.code, "member_id_taken");
});

test("účet: CSRF, úprava údajů, změna e-mailu a hesla", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount();
  const { session } = account;
  assert.equal((await call("PATCH", "/me", { body: { firstName: "Iva" }, session, csrf: "" })).data.code, "csrf_failed");
  assert.equal((await call("PATCH", "/me", { body: { firstName: "Iva" }, session, csrf: "spatny" })).data.code, "csrf_failed");
  const updated = await call("PATCH", "/me", { body: { firstName: "Iva", memberId: "5800 0001" }, session });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.user.firstName, "Iva");
  assert.equal(updated.data.user.memberId, "58000001");
  assert.equal((await call("PATCH", "/me", { body: {} })).data.code, "unauthorized");

  const newEmail = `zmena${accountSeq}@example.cz`;
  const change = await call("PATCH", "/me", { body: { email: newEmail }, session });
  assert.equal(change.data.emailChangePending, newEmail);
  assert.equal(change.data.user.email, account.email, "e-mail se změní až po potvrzení");
  const confirmed = await call("POST", "/auth/email/confirm", { body: { token: await linkToken(newEmail, "email_change", "email") } });
  assert.equal(confirmed.data.user.email, newEmail);

  assert.equal((await call("PUT", "/me/password", { body: { currentPassword: "spatne-heslo-1", newPassword: "nove-heslo-456" }, session })).data.code, "wrong_password");
  assert.equal((await call("PUT", "/me/password", { body: { currentPassword: account.password, newPassword: "nove-heslo-456" }, session })).status, 200);
  assert.equal((await call("POST", "/auth/login", { body: { email: newEmail, password: account.password } })).data.code, "invalid_credentials");
  assert.equal((await call("POST", "/auth/login", { body: { email: newEmail, password: "nove-heslo-456" } })).status, 200);
});

test("přihlášení odkazem z e-mailu a obnova hesla", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount({ password: undefined });
  assert.equal(account.user.hasPassword, false, "účet bez hesla – jen přihlášení odkazem");
  assert.deepEqual((await call("POST", "/auth/magic-link", { body: { email: "neexistuje@example.cz" } })).data, { sent: true }, "neprozradí, zda účet existuje");
  assert.equal(await lastEmail("neexistuje@example.cz"), null);
  await call("POST", "/auth/magic-link", { body: { email: account.email } });
  const session = {};
  const magic = await call("POST", "/auth/magic", { body: { token: await linkToken(account.email, "magic_link", "login") }, session });
  assert.equal(magic.status, 200);
  assert.equal((await call("GET", "/auth/me", { session })).data.user.email, account.email);
  await setClock("2026-06-10T08:16:00Z");
  await call("POST", "/auth/magic-link", { body: { email: account.email } });
  const token = await linkToken(account.email, "magic_link", "login");
  await setClock("2026-06-10T08:32:00Z");
  assert.equal((await call("POST", "/auth/magic", { body: { token } })).data.code, "invalid_link", "odkaz pro přihlášení platí 15 minut");

  await call("POST", "/auth/password-reset", { body: { email: account.email } });
  const resetToken = await linkToken(account.email, "password_reset", "reset");
  assert.equal((await call("POST", "/auth/password-reset/confirm", { body: { token: resetToken, password: "kratke" } })).data.code, "weak_password");
  assert.equal((await call("POST", "/auth/password-reset/confirm", { body: { token: resetToken, password: "obnovene-heslo-1" } })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session })).data.user, null, "obnova hesla odhlásí ostatní zařízení");
  assert.equal((await call("POST", "/auth/login", { body: { email: account.email, password: "obnovene-heslo-1" } })).status, 200);
  await setClock("2026-06-10T08:00:00Z");
});

test("místenky účtu: předchozí nákupy se připojí po ověření, nové se ukládají k účtu", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const body = accountBody();
  const guest = await paidTicket({ memberId: body.memberId, email: body.email.toUpperCase() });
  const stranger = await paidTicket({ memberId: body.memberId }); // jiný e-mail → nepřipojí se
  await call("POST", "/auth/register", { body });
  const session = {};
  await call("POST", "/auth/verify", { body: { token: await linkToken(body.email, "account_verify", "verify") }, session });
  const own = await order({ memberId: body.memberId, email: body.email });
  const bought = await call("POST", "/orders", { body: orderBody({ memberId: body.memberId, email: body.email }), session });
  assert.equal(bought.status, 201, JSON.stringify(bought.data));
  assert.equal((await call("POST", "/orders", { body: orderBody(), session, csrf: "" })).data.code, "csrf_failed", "nákup s relací vyžaduje CSRF");
  const list = (await call("GET", "/me/tickets", { session })).data.tickets.map((t) => t.code);
  assert.ok(list.includes(guest.code), "dřívější nákup se stejným e-mailem a legitimací");
  assert.ok(list.includes(bought.data.ticket.code), "nákup přihlášeného uživatele");
  assert.ok(!list.includes(stranger.code) && !list.includes(own.ticket.code), "jiný e-mail ani nákup bez přihlášení se nepřipojí");
  assert.equal((await call("GET", `/orders/${bought.data.ticket.code}`, { session })).status, 200, "držitel otevře místenku bez tokenu");
  assert.equal((await call("GET", `/orders/${stranger.code}`, { session })).status, 403);
  assert.equal((await call("GET", "/me/tickets")).data.code, "unauthorized");
});

test("2FA: zapnutí, povinný kód při přihlášení, ochrana proti opakování", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount();
  const secret = await enableTwoFactor(account.session, T0 + 60_000);
  const loginBody = { email: account.email, password: account.password };
  assert.equal((await call("POST", "/auth/login", { body: loginBody })).data.code, "otp_required");
  assert.equal((await call("POST", "/auth/login", { body: { ...loginBody, otp: "000000" } })).data.code, "invalid_otp");
  assert.equal((await call("POST", "/auth/login", { body: { ...loginBody, otp: totp(secret, T0 + 60_000) } })).data.code, "invalid_otp", "kód použitý při zapnutí nejde použít znovu");
  await setClock(new Date(T0 + 120_000).toISOString());
  const code = totp(secret, T0 + 120_000);
  assert.equal((await call("POST", "/auth/login", { body: { ...loginBody, otp: code } })).status, 200);
  assert.equal((await call("POST", "/auth/login", { body: { ...loginBody, otp: code } })).data.code, "invalid_otp", "stejný kód podruhé neprojde");
  await call("POST", "/auth/magic-link", { body: { email: account.email } });
  const magicToken = await linkToken(account.email, "magic_link", "login");
  assert.equal((await call("POST", "/auth/magic", { body: { token: magicToken } })).data.code, "otp_required", "2FA platí i pro přihlášení odkazem");
  await setClock(new Date(T0 + 180_000).toISOString());
  assert.equal((await call("POST", "/auth/magic", { body: { token: magicToken, otp: totp(secret, T0 + 180_000) } })).status, 200, "odkaz zůstal platný po chybějícím kódu");
  await setClock("2026-06-10T08:00:00Z");
});

test("role: správce jmenuje porybné, admin správce; admin musí mít 2FA; posledního admina nelze odebrat", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const admin = await verifiedAccount();
  const manager = await verifiedAccount();
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/users", { session: member.session })).data.code, "forbidden_role");
  assert.equal((await call("GET", "/manage/users")).data.code, "unauthorized");
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: ["admin"] } });
  assert.equal((await call("GET", "/manage/users", { session: admin.session })).data.code, "mfa_required", "admin bez 2FA nic nespravuje");
  assert.equal((await call("GET", "/auth/me", { session: admin.session })).data.user.mfaRequired, true);
  await enableTwoFactor(admin.session, T0 + 30_000);
  await setClock("2026-06-10T08:00:00Z");

  const found = await call("GET", `/manage/users?q=${encodeURIComponent(manager.email)}`, { session: admin.session });
  assert.equal(found.status, 200, JSON.stringify(found.data));
  const managerId = found.data.users[0].id;
  assert.ok(!("birthDate" in found.data.users[0]), "seznam neobsahuje datum narození");
  // Filtr podle role (záložky Admin / Správce / Porybný / Rybář) + počty.
  const admins = await call("GET", "/manage/users?role=admin", { session: admin.session });
  assert.ok(admins.data.users.length >= 1 && admins.data.users.every((u) => u.roles.includes("admin")), JSON.stringify(admins.data));
  assert.ok(admins.data.counts.admin >= 1 && "member" in admins.data.counts);
  assert.ok((await call("GET", "/manage/users?role=member", { session: admin.session })).data.users.every((u) => u.roles.length === 1));
  assert.equal((await call("GET", "/manage/users?role=boss", { session: admin.session })).data.code, "invalid_roles");
  const promoted = await call("PUT", `/manage/users/${managerId}/roles`, { body: { roles: ["manager"] }, session: admin.session });
  assert.deepEqual(promoted.data.user.roles, ["member", "manager"]);
  assert.equal((await call("PUT", `/manage/users/${managerId}/roles`, { body: { roles: ["boss"] }, session: admin.session })).data.code, "invalid_roles");

  // Správce (bez 2FA – pro správce je volitelná) smí jen porybného.
  const warden = await call("PUT", `/manage/users/${member.user.id}/roles`, { body: { roles: ["warden"] }, session: manager.session });
  assert.equal(warden.status, 200, JSON.stringify(warden.data));
  assert.deepEqual(warden.data.user.roles, ["member", "warden"]);
  assert.equal((await call("PUT", `/manage/users/${member.user.id}/roles`, { body: { roles: ["warden", "manager"] }, session: manager.session })).data.code, "forbidden_role");
  assert.equal((await call("PUT", `/manage/users/${admin.user.id}/roles`, { body: { roles: [] }, session: manager.session })).data.code, "forbidden_role");

  // Posledního admina nelze odebrat ani smazat; admin si nemůže vypnout 2FA. (Admin z průvodce dočasně bez role.)
  await call("POST", "/dev/users/roles", { body: { email: ROOT.email, roles: [] } });
  assert.equal((await call("PUT", `/manage/users/${admin.user.id}/roles`, { body: { roles: ["manager"] }, session: admin.session })).data.code, "last_admin");
  assert.equal((await call("POST", "/me/delete", { body: { confirm: true, password: admin.password }, session: admin.session })).data.code, "last_admin");
  assert.equal((await call("POST", "/me/2fa/disable", { body: { otp: "123456" }, session: admin.session })).data.code, "two_factor_required");

  // Neověřený účet nedostane roli.
  const pending = accountBody();
  await call("POST", "/auth/register", { body: pending });
  const pendingId = (await call("GET", `/manage/users?q=${encodeURIComponent(pending.email)}`, { session: admin.session })).data.users[0].id;
  assert.equal((await call("PUT", `/manage/users/${pendingId}/roles`, { body: { roles: ["warden"] }, session: admin.session })).data.code, "user_not_verified");
  // Úklid pro další testy: druhý admin by jinak ovlivnil kontrolu „posledního admina“.
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: [] } });
  await call("POST", "/dev/users/roles", { body: { email: ROOT.email, roles: ["admin"] } });
});

test("smazání účtu: místenky zůstanou, přihlášení přestane fungovat; neověřené účty se po 48 h smažou", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount();
  const bought = await call("POST", "/orders", { body: orderBody({ memberId: account.memberId, email: account.email }), session: account.session });
  assert.equal(bought.status, 201, JSON.stringify(bought.data));
  assert.equal((await call("POST", "/me/delete", { body: { confirm: true, password: "spatne-heslo-1" }, session: account.session })).data.code, "wrong_password");
  assert.equal((await call("POST", "/me/delete", { body: { password: account.password }, session: account.session })).data.code, "confirm_required");
  const deleted = await call("POST", "/me/delete", { body: { confirm: true, password: account.password }, session: account.session });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await call("GET", "/auth/me", { session: account.session })).data.user, null);
  assert.equal((await call("POST", "/auth/login", { body: { email: account.email, password: account.password } })).data.code, "invalid_credentials");
  assert.equal((await call("GET", `/tickets/${bought.data.ticket.code}`)).status, 200, "místenka zůstává");
  assert.ok(await lastEmail(account.email, "account_deleted"));

  const pending = accountBody();
  await call("POST", "/auth/register", { body: pending });
  await setClock("2026-06-12T08:00:01Z");
  const again = await call("POST", "/auth/register", { body: accountBody({ memberId: pending.memberId }) });
  assert.equal(again.status, 200, "číslo legitimace z neověřeného účtu se po 48 h uvolní");
  await setClock("2026-06-10T08:00:00Z");
});

// ---------- porybný (B2) ----------
async function wardenAccount() {
  const warden = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: warden.email, roles: ["warden"] } });
  return warden;
}

test("porybný: plná kontrola jen s rolí, údaje člena, místenky v týdnu a měsíci, záznam kontroly", async () => {
  await setClock("2026-06-10T08:00:00Z"); // středa
  const memberId = "71000001";
  const monday = await paidTicket({ memberId, date: "2026-06-10" });
  const { code } = await paidTicket({ memberId, date: "2026-06-12", revirId: "revir-b" });
  const member = await verifiedAccount();
  assert.equal((await call("GET", `/warden/tickets/${code}`)).data.code, "unauthorized");
  assert.equal((await call("GET", `/warden/tickets/${code}`, { session: member.session })).data.code, "forbidden_role");

  const warden = await wardenAccount();
  const res = await call("GET", `/warden/tickets/${monday.code}`, { session: warden.session });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const view = res.data;
  assert.equal(view.memberId, memberId, "celé číslo legitimace");
  assert.equal(view.birthDate, "1985-03-02");
  assert.equal(view.status, "active");
  assert.equal(view.seizable, true);
  assert.deepEqual(view.memberHistory.week, { from: "2026-06-08", to: "2026-06-14" }, "kalendářní týden po–ne");
  assert.deepEqual(view.memberHistory.month, { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(view.memberHistory.tickets.map((t) => t.code), [monday.code, code], "místenky člena v týdnu/měsíci");
  assert.equal(view.memberHistory.tickets[0].current, true);
  assert.equal(view.checks.length, 1, "kontrola je zapsaná");
  assert.equal(view.checks[0].wardenName, "Eva Účtová");
  assert.equal((await call("GET", `/warden/tickets/${monday.code}`, { session: warden.session })).data.checks.length, 1, "opakované otevření do 10 min se nezapisuje");
  const unpaid = await order();
  assert.equal((await call("GET", `/warden/tickets/${unpaid.ticket.code}`, { session: warden.session })).data.code, "not_issued");
  // Funkce držitele: nákup bez účtu = rybář; místenka na legitimaci porybného ukáže i porybného.
  assert.deepEqual(view.memberRoles, ["member"]);
  const own = await paidTicket({ memberId: warden.memberId, date: "2026-06-11" });
  assert.deepEqual((await call("GET", `/warden/tickets/${own.code}`, { session: warden.session })).data.memberRoles, ["member", "warden"]);
});

test("zadržení: jen platná místenka, lov končí, odevzdat je nutné i tak; e-mail držiteli a správci", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const warden = await wardenAccount();
  const active = await paidTicket({ email: "drzitel-zadrzeni@example.cz" });
  const future = await paidTicket({ date: "2026-06-11" });
  const seize = (code, body) => call("POST", `/warden/tickets/${code}/seize`, { body, session: warden.session });
  assert.equal((await seize(active.code, { reason: "x" })).data.code, "invalid_reason");
  assert.equal((await seize(future.code, { reason: "Lov bez místenky na tento den" })).data.code, "not_seizable");
  assert.equal((await call("POST", `/warden/tickets/${active.code}/seize`, { body: { reason: "Překročení" } })).data.code, "unauthorized");

  const seized = await seize(active.code, { reason: "Ponechání podměrečné štiky", place: "Petr 1, severní břeh" });
  assert.equal(seized.status, 200, JSON.stringify(seized.data));
  assert.equal(seized.data.status, "seized");
  assert.equal(seized.data.seizable, false);
  assert.equal(seized.data.seizure.reason, "Ponechání podměrečné štiky");
  assert.equal(seized.data.seizure.wardenName, "Eva Účtová");
  assert.equal(seized.data.checks[0].status, "seized");
  assert.equal((await seize(active.code, { reason: "Znovu zadržet" })).data.code, "already_seized");

  const pub = (await call("GET", `/tickets/${active.code}`)).data;
  assert.equal(pub.status, "seized", "veřejná kontrola ukáže zadržení");
  assert.equal(pub.seized, true);
  assert.ok(!("seizure" in pub), "důvod zadržení není veřejný");
  assert.ok(await lastEmail("drzitel-zadrzeni@example.cz", "ticket_seized"), "e-mail držiteli");
  assert.ok(await lastEmail("spravce-mo@example.cz", "seizure_notice"), "upozornění správci");

  const owner = (await call("GET", `/orders/${active.code}`, { token: active.token })).data;
  assert.equal(owner.returnable, true, "zadrženou místenku lze odevzdat");
  assert.equal(owner.seizure.place, "Petr 1, severní břeh");
  const returned = await call("POST", `/tickets/${active.code}/return`, { body: { catches: [{ species: "plotice", length: 20 }] }, token: active.token });
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.equal(returned.data.status, "expired_returned");
  assert.equal(returned.data.seized, true, "informace o zadržení zůstává");
});

test("zadržená neodevzdaná místenka dostane připomínku a po lhůtě se uzavře jako neodevzdaná", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const warden = await wardenAccount();
  const ticket = await paidTicket({ email: "zadrzena-neodevzdana@example.cz" });
  await call("POST", `/warden/tickets/${ticket.code}/seize`, { body: { reason: "Lov třemi pruty" }, session: warden.session });
  await setClock("2026-06-11T08:00:00Z");
  const next = (await call("GET", `/tickets/${ticket.code}`)).data;
  assert.equal(next.status, "seized");
  assert.equal(next.late, true, "po dni lovu už jde o opožděné odevzdání");
  assert.ok(await lastEmail("zadrzena-neodevzdana@example.cz", "return_reminder"), "připomínka odevzdání");
  await setClock("2026-06-17T22:00:01Z");
  const closed = (await call("GET", `/tickets/${ticket.code}`)).data;
  assert.equal(closed.status, "closed_unreturned");
  assert.equal(closed.seized, true);
  await setClock("2026-06-10T08:00:00Z");
});

// ---------- limity úlovků (B3) ----------
const limitOf = (ticket, id) => ticket.limits.find((l) => l.id === id);

// Hlídání limitů je ve výchozím stavu vypnuté – testy limitů ho zapnou v nastavení pravidel ryb.
const SPECIES_REF = "../../config/species/crs-smas-mp-2026-2027.json";
async function enableLimits() {
  const { session } = await managerAccount();
  const doc = (await call("GET", "/manage/settings", { session })).data.species.find((s) => s.ref === SPECIES_REF).data;
  if (doc.limitsEnabled === true) return;
  const saved = await call("PUT", "/manage/settings/species", { body: { ref: SPECIES_REF, data: { ...doc, limitsEnabled: true } }, session });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
}

test("limity: denní limit jen upozorní, odevzdání projde a správce dostane e-mail", async () => {
  await enableLimits();
  await setClock("2026-06-10T08:00:00Z");
  const { token, code } = await paidTicket({ revirId: "revir-b", memberId: "72000001" });
  const three = [{ species: "kapr", length: 50 }, { species: "lín", length: 35 }, { species: "amur", length: 65 }];
  const res = await call("POST", `/tickets/${code}/return`, { body: { catches: three }, token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const daily = limitOf(res.data, "vyznamne");
  assert.equal(daily.period, "day");
  assert.equal(daily.count, 3);
  assert.equal(daily.exceeded, true, "překročený denní limit je jen upozornění");
  assert.equal(limitOf(res.data, "vyznamne-tyden").count, 3);
  assert.equal(limitOf(res.data, "vyznamne-tyden").exceeded, false);
  const mail = await lastEmail("spravce-mo@example.cz", "limit_exceeded");
  assert.ok(mail && mail.text.includes(code), "správce dostane upozornění");
});

test("limity: týdenní limit se počítá ze všech místenek člena (i bez účtu), kapr 2 ks týdně do 5 ha", async () => {
  await enableLimits();
  await setClock("2026-06-10T08:00:00Z");
  const memberId = "72000002";
  const ret = async (catches, overrides = {}) => {
    const t = await paidTicket({ memberId, ...overrides });
    const res = await call("POST", `/tickets/${t.code}/return`, { body: { catches }, token: t.token });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data;
  };
  await ret([{ species: "lín", length: 35 }, { species: "lín", length: 36 }]);
  const second = await ret([{ species: "amur", length: 65 }, { species: "amur", length: 66 }]);
  assert.equal(limitOf(second, "vyznamne-tyden").count, 4, "součet ze dvou místenek");
  assert.equal(limitOf(second, "vyznamne-tyden").exceeded, false, "4 ks je ještě v limitu");
  const third = await ret([{ species: "kapr", length: 50 }]);
  const week = limitOf(third, "vyznamne-tyden");
  assert.equal(week.count, 5);
  assert.equal(week.exceeded, true);
  assert.deepEqual([week.from, week.to], ["2026-06-08", "2026-06-14"]);
  assert.equal(limitOf(third, "vyznamne-mesic").exceeded, false, "měsíční limit 10 ks");
  assert.ok(limitOf(third, "kapr-maly-revir"), "revír do 5 ha → limit kapra platí");

  // Nová místenka ukáže stav limitů už při objednávce.
  const next = await order({ memberId, date: "2026-06-11" });
  assert.equal(limitOf(next.ticket, "vyznamne-tyden").count, 5, "upozornění už při nákupu");
});

test("limity: po 2 porušeních automatická blokace nákupu; správce ji vidí a zruší, může blokovat ručně", async () => {
  await enableLimits();
  await setClock("2026-06-10T08:00:00Z");
  const memberId = "72000003";
  const over = [{ species: "lín", length: 35 }, { species: "lín", length: 36 }, { species: "lín", length: 37 }];
  for (let i = 0; i < 2; i++) {
    const t = await paidTicket({ memberId, email: "blokovany@example.cz" });
    assert.equal((await call("POST", `/tickets/${t.code}/return`, { body: { catches: over }, token: t.token })).status, 200);
  }
  const blocked = await call("POST", "/orders", { body: orderBody({ memberId }) });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, "member_blocked");
  assert.ok(await lastEmail("blokovany@example.cz", "member_blocked"), "držitel se o blokaci dozví");

  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/blocks", { session: member.session })).data.code, "forbidden_role");
  const manager = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: manager.email, roles: ["manager"] } });
  const violations = (await call("GET", "/manage/violations", { session: manager.session })).data.violations.filter((v) => v.memberId === memberId);
  assert.ok(violations.length >= 2 && violations.every((v) => v.blocked));
  const block = (await call("GET", "/manage/blocks", { session: manager.session })).data.blocks.find((b) => b.memberId === memberId);
  assert.equal(block.source, "auto");
  assert.equal(block.until, "2026-07-09", "30 dní včetně dneška");
  const lifted = await call("POST", `/manage/blocks/${block.id}/lift`, { session: manager.session });
  assert.equal(lifted.data.block.active, false);
  assert.equal((await call("POST", "/orders", { body: orderBody({ memberId }) })).status, 201, "po zrušení blokace lze nakoupit");

  // Ruční blokace.
  assert.equal((await call("POST", "/manage/blocks", { body: { memberId: "123", reason: "Test" }, session: manager.session })).data.code, "invalid_member_id");
  const manual = await call("POST", "/manage/blocks", { body: { memberId: "72000004", reason: "Neodevzdané místenky" }, session: manager.session });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(manual.data.block.until, null, "bez data = do zrušení");
  assert.equal((await call("POST", "/manage/blocks", { body: { memberId: "72000004", reason: "Znovu" }, session: manager.session })).data.code, "already_blocked");
  assert.equal((await call("POST", "/orders", { body: orderBody({ memberId: "72000004" }) })).data.code, "member_blocked");
});

test("limity: porybný je vidí při kontrole, přihlášený člen v účtu", async () => {
  await enableLimits();
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount();
  const t = await call("POST", "/orders", { body: orderBody({ memberId: account.memberId, email: account.email }), session: account.session });
  await pay({ code: t.data.ticket.code });
  await call("POST", `/tickets/${t.data.ticket.code}/return`, { body: { catches: [{ species: "lín", length: 35 }] }, session: account.session });
  const mine = (await call("GET", "/me/limits", { session: account.session })).data;
  assert.equal(mine.limits.find((l) => l.id === "vyznamne-tyden").count, 1);
  assert.ok(!mine.limits.some((l) => l.period === "day"), "v účtu jen týden a měsíc");
  assert.equal(mine.blocked, null);
  const warden = await wardenAccount();
  const view = (await call("GET", `/warden/tickets/${t.data.ticket.code}`, { session: warden.session })).data;
  assert.equal(view.limits.find((l) => l.id === "vyznamne-tyden").count, 1);
  assert.equal(view.blocked, null);
});

test("osobní statistika rybáře v účtu", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const account = await verifiedAccount();
  const empty = (await call("GET", "/me/stats", { session: account.session })).data;
  assert.equal(empty.visits, 0);
  assert.equal(empty.biggest, null);
  const buy = async (date, catches) => {
    const t = await call("POST", "/orders", { body: orderBody({ memberId: account.memberId, email: account.email, date }), session: account.session });
    assert.equal(t.status, 201, JSON.stringify(t.data));
    await pay({ code: t.data.ticket.code });
    return t.data.ticket.code;
  };
  const first = await buy("2026-06-10");
  await call("POST", `/tickets/${first}/return`, { body: { catches: [{ species: "kapr", length: 55, weight: 3 }, { species: "lín", length: 35 }] }, session: account.session });
  await buy("2026-06-12");
  await setClock("2026-06-12T08:00:00Z");
  const stats = (await call("GET", "/me/stats", { session: account.session })).data;
  assert.equal(stats.visits, 2);
  assert.equal(stats.returned, 1);
  assert.equal(stats.catches, 2);
  assert.equal(stats.totalWeight, 3);
  assert.equal(stats.successRate, 100);
  assert.equal(stats.biggest.species, "kapr obecný");
  assert.equal(stats.biggest.length, 55);
  assert.equal(stats.biggest.date, "2026-06-10");
  assert.equal(stats.heaviest.weight, 3);
  assert.equal(stats.bestTrip.catches, 2);
  assert.deepEqual(stats.species.map((x) => x.count), [1, 1]);
  assert.deepEqual(stats.years, [{ year: "2026", visits: 2, catches: 2 }]);
  assert.equal(stats.avgLength, 45, "průměrná délka (55 + 35) / 2");
  assert.equal(stats.bestTrip.avgLength, 45);
  assert.equal((await call("GET", "/me/stats")).status, 401);

  // „Jak se posledně dařilo ostatním?“ – bez osobních údajů, poslední den lovu před dneškem.
  const community = (await call("GET", "/me/community", { session: account.session })).data;
  assert.ok(community.lastDay && community.lastDay.date < "2026-06-12", JSON.stringify(community.lastDay));
  assert.ok(community.lastDay.catches >= 0 && community.lastDay.anglers >= 1);
  assert.ok(community.biggest.length >= 55 && community.biggest.species && community.biggest.date);
  assert.ok(community.bestTrip.catches >= 2 && community.bestTrip.avgLength > 0);
  assert.ok(!JSON.stringify(community).includes(account.memberId), "žádné osobní údaje");
  assert.equal((await call("GET", "/me/community")).status, 401);
  assert.equal(community.enabled, true);
  assert.ok(community.lastDay.capacity > 0 && community.lastDay.issued >= community.lastDay.anglers, JSON.stringify(community.lastDay));
  assert.equal(community.lastDay.pressure, Math.round((community.lastDay.issued / community.lastDay.capacity) * 100));
  // Správa může veřejnou statistiku vypnout (nastavení organizace, výchozí zapnuto).
  const { session: mgr } = await managerAccount();
  const orgDoc = (await call("GET", "/manage/settings", { session: mgr })).data.organization.data;
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...orgDoc, statsPolicy: { community: false } } }, session: mgr })).status, 200);
  assert.deepEqual((await call("GET", "/me/community", { session: account.session })).data, { enabled: false });
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...orgDoc, statsPolicy: { community: "ne" } } }, session: mgr })).data.code, "invalid_settings");
  await call("POST", "/manage/settings/reset", { body: { scope: "organization" }, session: mgr });
  assert.equal((await call("GET", "/me/community", { session: account.session })).data.enabled, true);
});

// ---------- provoz: důležité zprávy, sezony, uzavření (B4) ----------
async function managerAccount() {
  const manager = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: manager.email, roles: ["manager"] } });
  return manager;
}

test("důležité zprávy: správa jen pro správce, veřejně nejvýš 3 aktivní pro revír, připnuté první", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/announcements", { session: member.session })).data.code, "forbidden_role");
  const { session } = await managerAccount();
  for (const a of (await call("GET", "/manage/announcements", { session })).data.announcements) await call("DELETE", `/manage/announcements/${a.id}`, { session });
  const add = (body) => call("POST", "/manage/announcements", { body, session });
  assert.equal((await add({ title: "" })).data.code, "invalid_title");
  assert.equal((await add({ title: "X", validFrom: "2026-06-12", validTo: "2026-06-11" })).data.code, "invalid_date");
  assert.equal((await add({ title: "X", revirId: "neexistuje" })).data.code, "unknown_revir");
  const created = await add({ title: "Sezona začala", text: "Vítejte u vody", revirId: "revir-a" });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  await add({ title: "Ryby nasazeny", revirId: "revir-a" });
  await add({ title: "Údržba systému", revirId: null }); // celá MO
  await add({ title: "Připnuto", revirId: "revir-a", pinned: true });
  await add({ title: "Jen revír B", revirId: "revir-b" });
  await add({ title: "Prošlá", revirId: "revir-a", validTo: "2026-06-09" });
  await add({ title: "Budoucí", revirId: "revir-a", validFrom: "2026-06-20" });

  const pubA = (await call("GET", "/announcements?revirId=revir-a")).data.announcements;
  assert.equal(pubA.length, 3, "nejvýš 3 zprávy");
  assert.equal(pubA[0].title, "Připnuto");
  assert.deepEqual(pubA.slice(1).map((a) => a.title), ["Údržba systému", "Ryby nasazeny"], "pak nejnovější");
  const pubB = (await call("GET", "/announcements?revirId=revir-b")).data.announcements.map((a) => a.title);
  assert.deepEqual(pubB, ["Jen revír B", "Údržba systému"], "zprávy pro celou MO platí i pro revír B");

  const edited = await call("PUT", `/manage/announcements/${created.data.announcement.id}`, { body: { title: "Sezona začala!", revirId: "revir-a", pinned: true }, session });
  assert.equal(edited.data.announcement.pinned, true);
  const all = (await call("GET", "/manage/announcements", { session })).data.announcements;
  assert.equal(all.find((a) => a.title === "Prošlá").active, false);
  for (const a of all) assert.equal((await call("DELETE", `/manage/announcements/${a.id}`, { session })).status, 200);
  assert.deepEqual((await call("GET", "/announcements?revirId=revir-a")).data.announcements, []);
});

test("sezona: prodává se jen v otevřené sezoně; revír bez sezony je zavřený; dny mimo sezonu jsou v dostupnosti uzavřené", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const manager = await managerAccount();
  const { session } = manager;
  const fisher = await verifiedAccount();
  assert.equal((await call("DELETE", `/manage/seasons/${LAUNCH.season.id}`, { session })).status, 200);
  // Uzavřená sezona: rybář se nepřihlásí ani nezaregistruje, správa ano.
  const denied = await call("POST", "/auth/login", { body: { email: fisher.email, password: fisher.password } });
  assert.deepEqual([denied.status, denied.data.code], [409, "season_closed"]);
  assert.equal((await call("POST", "/auth/register", { body: accountBody() })).data.code, "season_closed");
  assert.equal((await call("POST", "/auth/login", { body: { email: manager.email, password: manager.password } })).status, 200, "správce se přihlásí");
  const none = (await call("GET", "/reviry/revir-b/availability")).data.days[0];
  assert.equal(none.closed, true, "bez sezony je zavřeno");
  assert.equal(none.closedReason, "Mimo sezonu", "služba už běží – jen mimo sezonu");
  assert.equal((await call("POST", "/manage/seasons", { body: { name: "Sezona 2026", revirId: "revir-a" }, session })).data.code, "invalid_date");
  // Název je nepovinný; uzavření od data = poslední den lovu je den předtím; uzavřít lze nejdřív ode dneška.
  const unnamed = (await call("POST", "/manage/seasons", { body: { revirId: "revir-b", opensOn: "2026-06-01" }, session })).data.season;
  assert.equal(unnamed.name, "Sezona 2026");
  assert.equal((await call("POST", `/manage/seasons/${unnamed.id}/close`, { body: { from: "2026-06-09" }, session })).data.code, "invalid_date");
  const closing = (await call("POST", `/manage/seasons/${unnamed.id}/close`, { body: { from: "2026-06-12" }, session })).data.season;
  assert.equal(closing.closesOn, "2026-06-11");
  assert.equal((await call("POST", "/orders", { body: orderBody({ revirId: "revir-b", date: "2026-06-12" }) })).data.code, "out_of_season");
  const now = (await call("POST", `/manage/seasons/${unnamed.id}/close`, { body: { from: "2026-06-10" }, session })).data.season;
  assert.equal(now.state, "closed", "uzavřeno ihned");
  await call("DELETE", `/manage/seasons/${unnamed.id}`, { session });
  const season = await call("POST", "/manage/seasons", { body: { name: "Sezona 2026", revirId: "revir-a", opensOn: "2026-06-12", closesOn: "2026-12-31" }, session });
  assert.equal(season.status, 201, JSON.stringify(season.data));
  assert.equal(season.data.season.state, "upcoming");
  const days = (await call("GET", "/reviry/revir-a/availability")).data.days;
  assert.equal(days[0].closed, true);
  assert.equal(days[0].available, 0);
  assert.match(days[0].closedReason, /Mimo sezonu – otevírá se 12\. 6\. 2026/);
  assert.equal(days[2].closed, false, "12. 6. je otevřeno");
  const out = await call("POST", "/orders", { body: orderBody({ date: "2026-06-10" }) });
  assert.equal(out.status, 409);
  assert.equal(out.data.code, "out_of_season");
  assert.equal((await call("POST", "/orders", { body: orderBody({ date: "2026-06-12" }) })).status, 201);
  assert.equal((await call("POST", "/orders", { body: orderBody({ revirId: "revir-b", date: "2026-06-11" }) })).data.code, "out_of_season", "revír B sezonu nemá → zavřený");
  // Předčasné uzavření sezony = změna data uzavření.
  const closed = await call("PUT", `/manage/seasons/${season.data.season.id}`, { body: { name: "Sezona 2026", revirId: "revir-a", opensOn: "2026-06-01", closesOn: "2026-06-10" }, session });
  assert.equal(closed.data.season.state, "open", "dnes je poslední den");
  assert.equal((await call("POST", "/orders", { body: orderBody({ date: "2026-06-11" }) })).data.code, "out_of_season");
  assert.equal((await call("DELETE", `/manage/seasons/${season.data.season.id}`, { session })).status, 200);
  assert.equal((await call("GET", "/reviry/revir-a/availability")).data.days[0].closed, true);
  // Úklid: celoroční sezona celé MO pro další testy.
  const restored = await call("POST", "/manage/seasons", { body: { name: "Sezona 2026", opensOn: "2026-01-01" }, session });
  assert.equal(restored.status, 201);
  LAUNCH.season = restored.data.season;
  assert.equal((await call("GET", "/reviry/revir-a/availability")).data.days[0].closed, false);
});

test("mimořádné uzavření: zablokuje nákup na dny, držitelé dotčených místenek dostanou e-mail", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { session } = await managerAccount();
  const holder = await paidTicket({ date: "2026-06-11", email: "uzavreni@example.cz" });
  const other = await paidTicket({ date: "2026-06-13", email: "mimo-uzavreni@example.cz" });
  assert.equal((await call("POST", "/manage/closures", { body: { revirId: "revir-a", dateFrom: "2026-06-11", reason: "x" }, session })).data.code, "invalid_reason");
  const closure = await call("POST", "/manage/closures", { body: { revirId: "revir-a", dateFrom: "2026-06-11", dateTo: "2026-06-12", reason: "Výlov nádrže" }, session });
  assert.equal(closure.status, 201, JSON.stringify(closure.data));
  assert.ok(closure.data.affectedTickets.some((t) => t.code === holder.code), "dotčená místenka");
  assert.ok(!closure.data.affectedTickets.some((t) => t.code === other.code));
  assert.ok(await lastEmail("uzavreni@example.cz", "closure_notice"));
  assert.equal(await lastEmail("mimo-uzavreni@example.cz", "closure_notice"), null);
  const day = (await call("GET", "/reviry/revir-a/availability")).data.days.find((d) => d.date === "2026-06-11");
  assert.equal(day.closed, true);
  assert.equal(day.closedReason, "Výlov nádrže");
  const blocked = await call("POST", "/orders", { body: orderBody({ date: "2026-06-12" }) });
  assert.equal(blocked.data.code, "revir_closed");
  assert.ok((await call("GET", "/manage/closures", { session })).data.closures.some((c) => c.id === closure.data.closure.id));
  assert.equal((await call("DELETE", `/manage/closures/${closure.data.closure.id}`, { session })).status, 200);
  assert.equal((await call("POST", "/orders", { body: orderBody({ date: "2026-06-12" }) })).status, 201, "po zrušení uzavření lze koupit");
});

test("správa místenek: seznam s filtry, detail, export CSV jen pro správce", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/tickets", { session: member.session })).data.code, "forbidden_role");
  const { session } = await managerAccount();
  const t = await paidTicket({ memberId: "73000001", lastName: "Hledaný", email: "hledany@example.cz" });
  const byQ = await call("GET", "/manage/tickets?q=hledaný", { session });
  assert.equal(byQ.status, 200, JSON.stringify(byQ.data));
  assert.ok(byQ.data.tickets.some((x) => x.code === t.code));
  assert.ok((await call("GET", `/manage/tickets?q=${t.code.toLowerCase()}`, { session })).data.tickets.length === 1, "hledání podle kódu");
  assert.ok((await call("GET", "/manage/tickets?q=73000001", { session })).data.tickets.every((x) => x.memberId === "73000001"));
  const active = (await call("GET", "/manage/tickets?status=active&from=2026-06-10&to=2026-06-10&limit=500", { session })).data;
  assert.ok(active.total > 0 && active.tickets.every((x) => x.status === "active" && x.date === "2026-06-10"));
  assert.equal((await call("GET", "/manage/tickets?status=nesmysl", { session })).data.code, "invalid_status");

  const detail = (await call("GET", `/manage/tickets/${t.code}`, { session })).data;
  assert.equal(detail.ticket.lastName, "Hledaný");
  assert.equal(detail.payments[0].result, "matched");
  assert.ok(detail.emails.some((e) => e.kind === "ticket_issued"));
  assert.equal(detail.cancellable, true);

  const csv = await fetch(url("/manage/tickets.csv?q=hledaný"), { headers: { Cookie: session.cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM pro Excel");
  const text = bytes.toString("utf8");
  assert.ok(text.includes("Kód;Revír;Podrevír;Datum lovu"), "hlavička se středníky");
  assert.ok(text.includes(`${t.code};`));
  assert.equal((await fetch(url("/manage/tickets.csv"))).status, 401, "bez přihlášení nic");
});

test("zrušení místenky správcem: uvolní místo, držitel dostane e-mail; odevzdanou zrušit nelze", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { session } = await managerAccount();
  const t = await paidTicket({ date: "2026-06-11", email: "zrusena@example.cz" });
  assert.equal((await call("POST", `/manage/tickets/${t.code}/cancel`, { body: { reason: "" }, session })).data.code, "invalid_reason");
  const cancelled = await call("POST", `/manage/tickets/${t.code}/cancel`, { body: { reason: "Duplicitní nákup, peníze vráceny" }, session });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.ticket.status, "cancelled");
  assert.equal(cancelled.data.cancellation.reason, "Duplicitní nákup, peníze vráceny");
  assert.equal(cancelled.data.cancellable, false);
  assert.equal((await call("GET", `/tickets/${t.code}`)).data.status, "cancelled", "veřejná kontrola: neplatí");
  assert.ok(await lastEmail("zrusena@example.cz", "ticket_cancelled"));
  const returned = await paidTicket();
  await call("POST", `/tickets/${returned.code}/return`, { body: { noCatch: true }, token: returned.token });
  assert.equal((await call("POST", `/manage/tickets/${returned.code}/cancel`, { body: { reason: "Pokus o zrušení" }, session })).data.code, "not_cancellable");
});

test("fronta plateb: nespárované platby k vyřešení, přiřazení platby vystaví místenku", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { session } = await managerAccount();
  const { token, ticket } = await order({ email: "spatna-castka@example.cz" });
  assert.equal((await pay({ variableSymbol: ticket.payment.variableSymbol, amountHalere: 19000 })).data.result, "amount_mismatch");
  assert.equal((await pay({ variableSymbol: "999", amountHalere: 5000 })).data.result, "unmatched");
  const open = (await call("GET", "/manage/payments", { session })).data.payments;
  const mismatch = open.find((p) => p.ticket?.code === ticket.code);
  const unmatched = open.find((p) => p.variableSymbol === "999");
  assert.ok(mismatch && mismatch.needsAction && unmatched);
  assert.equal((await call("POST", `/manage/payments/${mismatch.id}/resolve`, { body: { action: "smazat" }, session })).data.code, "invalid_action");
  const assigned = await call("POST", `/manage/payments/${mismatch.id}/resolve`, { body: { action: "assign", note: "Doplatek 10 Kč dorovná na místě" }, session });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.payment.resolution.action, "assigned");
  assert.equal((await call("GET", `/orders/${ticket.code}`, { token })).data.status, "active", "místenka vystavena");
  assert.ok(await lastEmail("spatna-castka@example.cz", "ticket_issued"));
  assert.equal((await call("POST", `/manage/payments/${unmatched.id}/resolve`, { body: { action: "assign" }, session })).data.code, "ticket_required");
  assert.equal((await call("POST", `/manage/payments/${unmatched.id}/resolve`, { body: { action: "refunded", note: "Vráceno 11. 6." }, session })).status, 200);
  assert.equal((await call("POST", `/manage/payments/${unmatched.id}/resolve`, { body: { action: "ignored" }, session })).data.code, "already_resolved");
  const after = (await call("GET", "/manage/payments", { session })).data.payments.map((p) => p.id);
  assert.ok(!after.includes(mismatch.id) && !after.includes(unmatched.id), "vyřešené z fronty zmizí");
  assert.ok((await call("GET", "/manage/payments?state=all", { session })).data.payments.some((p) => p.id === unmatched.id));
});

test("poukazy: správce je vygeneruje a může zneplatnit nepoužitý", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("POST", "/manage/vouchers", { body: { count: 1 }, session: member.session })).data.code, "forbidden_role");
  const { session } = await managerAccount();
  assert.equal((await call("POST", "/manage/vouchers", { body: { count: 51 }, session })).data.code, "invalid_count");
  const created = await call("POST", "/manage/vouchers", { body: { count: 3, revirId: "revir-a", note: "Dětské rybářské závody" }, session });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const codes = created.data.vouchers.map((v) => v.code);
  assert.equal(codes.length, 3);
  assert.ok(codes.every((c) => /^[A-Z0-9]{16}$/.test(c)));
  const listed = (await call("GET", "/manage/vouchers", { session })).data.vouchers;
  assert.equal(listed.find((v) => v.code === codes[0]).note, "Dětské rybářské závody");
  assert.equal((await call("POST", `/manage/vouchers/${codes[0]}/void`, { session })).data.voucher.state, "voided");
  assert.equal((await call("GET", `/vouchers/${codes[0]}`)).data.valid, false);
  assert.equal((await call("POST", "/orders", { body: orderBody({ voucherCode: codes[0] }) })).data.code, "invalid_voucher");
  await order({ voucherCode: codes[1] });
  assert.equal((await call("POST", `/manage/vouchers/${codes[1]}/void`, { session })).data.code, "not_voidable", "použitý poukaz nejde zneplatnit");
});

// ---------- nastavení v portálu (B5) ----------
test("nastavení revíru: změna ceny a kapacity platí hned, neplatná hodnota se neuloží, historie a obnovení", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/settings", { session: member.session })).data.code, "forbidden_role");
  const { session } = await managerAccount();
  const view = (await call("GET", "/manage/settings", { session })).data;
  assert.equal(view.canEditPayment, false);
  const revirB = view.reviry.find((r) => r.id === "revir-b");
  assert.equal(revirB.source, "file");
  assert.ok(!("fishRules" in revirB.data), "odvozená pravidla se neukládají");

  const bad = await call("PUT", "/manage/settings/reviry/revir-b", { body: { data: { ...revirB.data, dailyCapacity: 0 } }, session });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "invalid_settings");
  assert.match(bad.data.error, /kapacita/);

  const saved = await call("PUT", "/manage/settings/reviry/revir-b", { body: { data: { ...revirB.data, priceCzk: 250, dailyCapacity: 5 }, note: "Nový ceník" }, session });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const cfg = (await call("GET", "/config")).data.reviry.find((r) => r.id === "revir-b");
  assert.equal(cfg.priceCzk, 250, "veřejná konfigurace hned s novou cenou");
  assert.equal((await call("GET", "/reviry/revir-b/availability")).data.days[0].capacity, 5);
  assert.equal((await order({ revirId: "revir-b", date: "2026-06-13" })).ticket.amountDueHalere, 25000, "nová objednávka za novou cenu");

  const history = (await call("GET", "/manage/settings/history?scope=revir:revir-b", { session })).data;
  assert.equal(history.versions[0].note, "Nový ceník");
  assert.equal(history.hasFile, true);
  const reset = await call("POST", "/manage/settings/reset", { body: { scope: "revir:revir-b" }, session });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await call("GET", "/config")).data.reviry.find((r) => r.id === "revir-b").priceCzk, revirB.data.priceCzk, "výchozí hodnoty ze souboru");
  const restored = await call("POST", `/manage/settings/versions/${history.versions[0].version}/restore`, { session });
  assert.equal(restored.data.settings.reviry.find((r) => r.id === "revir-b").data.priceCzk, 250, "obnovení starší verze");
  await call("POST", "/manage/settings/reset", { body: { scope: "revir:revir-b" }, session });
});

test("nastavení organizace a pravidel ryb; verze pravidel se uloží k odevzdané místence", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { session } = await managerAccount();
  const view = (await call("GET", "/manage/settings", { session })).data;
  const org = view.organization.data;
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...org, organization: { ...org.organization, contact: { ...org.organization.contact, email: "spatny" } } } }, session })).data.code, "invalid_settings");
  const changed = await call("PUT", "/manage/settings/organization", { body: { data: { ...org, publicCheck: { showFullName: false, memberIdVisibleChars: 2 } } }, session });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  // Lhůta pro opožděné odevzdání je jedna pro celou MO (Limity a blokace) a platí pro všechny revíry.
  assert.equal(org.returnPolicy.lateReturnDays, 7, "výchozí lhůta");
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...changed.data.settings.organization.data, returnPolicy: { lateReturnDays: 61 } } }, session })).data.code, "invalid_settings");
  const longer = await call("PUT", "/manage/settings/organization", { body: { data: { ...changed.data.settings.organization.data, returnPolicy: { lateReturnDays: 10 } } }, session });
  assert.equal(longer.status, 200, JSON.stringify(longer.data));
  assert.deepEqual((await call("GET", "/config")).data.reviry.map((r) => r.lateReturnDays), [10, 10]);
  const restored = await call("PUT", "/manage/settings/organization", { body: { data: { ...longer.data.settings.organization.data, returnPolicy: { lateReturnDays: 7 } } }, session });
  assert.equal(restored.status, 200);
  // Prodej dopředu – také jeden údaj pro celou MO (Ceny a místa).
  assert.equal(org.salesPolicy.bookingDaysAhead, 3, "výchozí prodej dopředu");
  const ahead = await call("PUT", "/manage/settings/organization", { body: { data: { ...restored.data.settings.organization.data, salesPolicy: { bookingDaysAhead: 5 } } }, session });
  assert.equal(ahead.status, 200, JSON.stringify(ahead.data));
  assert.deepEqual((await call("GET", "/config")).data.reviry.map((r) => r.bookingDaysAhead), [5, 5]);
  assert.equal((await call("GET", "/reviry/revir-b/availability")).data.days.length, 6);
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...ahead.data.settings.organization.data, salesPolicy: { bookingDaysAhead: 3 } } }, session })).status, 200);
  const t = await paidTicket({ lastName: "Veřejný" });
  const pub = (await call("GET", `/tickets/${t.code}`)).data;
  assert.equal(pub.holder.name, "Jan V.", "zkrácené jméno ve veřejné kontrole");
  assert.ok(pub.holder.memberId.endsWith(t.memberId.slice(-2)) && !pub.holder.memberId.endsWith(t.memberId.slice(-3)));
  await call("POST", "/manage/settings/reset", { body: { scope: "organization" }, session });

  const ref = "../../config/species/crs-smas-mp-2026-2027.json";
  const species = view.species.find((s) => s.ref === ref);
  assert.ok(species, JSON.stringify(view.species.map((s) => s.ref)));
  const doc = structuredClone(species.data);
  doc.species.find((s) => s.id === "lin-obecny").minLength = 30;
  const savedRules = await call("PUT", "/manage/settings/species", { body: { ref, data: doc, note: "Zpřísnění lína" }, session });
  assert.equal(savedRules.status, 200, JSON.stringify(savedRules.data));
  const ticket = await paidTicket();
  const linReturn = await call("POST", `/tickets/${ticket.code}/return`, { body: { catches: [{ species: "lín", length: 27 }, { species: "lín", length: 31 }] }, token: ticket.token });
  assert.equal(linReturn.status, 200, JSON.stringify(linReturn.data));
  assert.match(linReturn.data.catches[0].warning, /\(30 cm\)/, "nová míra platí hned");
  assert.equal(linReturn.data.catches[1].warning, null);
  const detail = (await call("GET", `/manage/tickets/${ticket.code}`, { session })).data;
  assert.match(detail.ticket.rulesVersion, /^crs-smas-mp-2026-2027@v\d+$/, "verze pravidel u místenky");

  await call("POST", "/manage/settings/reset", { body: { scope: `species:${ref}` }, session });
  const defaults = (await call("GET", "/config")).data.reviry[0].fishRules;
  assert.equal(defaults.limitsEnabled, false, "limity jsou ve výchozím stavu vypnuté");
  assert.equal(defaults.sizeRulesEnabled, true, "lovné míry ve výchozím stavu zapnuté");
  // Vypnuté hlídání: lovné míry se nekontrolují, limity se nepočítají (odevzdání, kontrola, účet).
  const off = { ...structuredClone(species.data), limitsEnabled: false, sizeRulesEnabled: false };
  assert.equal((await call("PUT", "/manage/settings/species", { body: { ref, data: off }, session })).status, 200);
  const cfgOff = (await call("GET", "/config")).data.reviry[0].fishRules;
  assert.equal(cfgOff.limitsEnabled, false);
  assert.equal(cfgOff.sizeRulesEnabled, false);
  const free = await paidTicket();
  const many = Array.from({ length: 6 }, () => ({ species: "lín", length: 20 }));
  const freeReturn = await call("POST", `/tickets/${free.code}/return`, { body: { catches: many }, token: free.token });
  assert.equal(freeReturn.status, 200, JSON.stringify(freeReturn.data));
  assert.deepEqual(freeReturn.data.limits, [], "vypnuté limity se nepočítají");
  assert.ok(freeReturn.data.catches.every((c) => c.warning === null), "vypnuté míry nevarují");
  assert.equal((await call("PUT", "/manage/settings/species", { body: { ref, data: { ...off, limitsEnabled: "ne" } }, session })).data.code, "invalid_settings");
  const onAgain = await call("PUT", "/manage/settings/species", { body: { ref, data: { ...off, limitsEnabled: true, sizeRulesEnabled: true } }, session });
  assert.equal(onAgain.status, 200);
  const strict = await paidTicket();
  const strictReturn = await call("POST", `/tickets/${strict.code}/return`, { body: { catches: [{ species: "lín", length: 20 }] }, token: strict.token });
  assert.match(strictReturn.data.catches[0].warning, /lovnou mírou/, "po zapnutí se míra kontroluje (upozorněním)");
  doc.dailyLimits[0].maxCount = 0;
  assert.equal((await call("PUT", "/manage/settings/species", { body: { ref, data: doc }, session })).data.code, "invalid_settings");
  await call("POST", "/manage/settings/reset", { body: { scope: `species:${ref}` }, session });
  assert.equal((await call("GET", "/config")).data.reviry[0].fishRules.species.find((s) => s.id === "lin-obecny").minLength, 25);
});

// ---------- mapy revírů ----------
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const square = (lon, lat, d = 0.001) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
test("mapy revírů: mapa ze souboru, uložení s náhledem, kontrola, veřejné API a e-mail s mapou", async () => {
  await setClock("2026-06-10T08:00:00Z");
  // Revír B je ve vlastním souboru (reviry/revir-b.json), mapa revíru A v maps/revir-a.json.
  const cfg = (await call("GET", "/config")).data;
  assert.deepEqual(cfg.reviry.map((r) => r.id), ["revir-a", "revir-b"]);
  assert.equal(cfg.reviry[1].name, "Malý revír B", "revír ze samostatného souboru");
  assert.deepEqual(cfg.reviry[0].map, { features: 7, preview: null });
  assert.equal(cfg.reviry[1].map, null);
  assert.equal(cfg.mapTiles.provider, "osm", "bez klíče Mapy.com podklad OpenStreetMap");
  const fileMap = (await call("GET", "/maps/revir-a")).data;
  assert.equal(fileMap.map.features.length, 7);
  assert.equal(fileMap.map.view.zoom, 16);
  assert.equal(fileMap.preview, null);
  assert.equal((await call("GET", "/maps/revir-b")).data.map, null);
  assert.equal((await call("GET", "/maps/neexistuje")).status, 404);
  assert.equal((await fetch(url("/maps/revir-a/preview.png"))).status, 404, "mapa ze souboru bez náhledu");

  // Uložení mapy revíru B ve správě (GeoJSON + náhled PNG), nejdřív kontroly.
  const manager = await managerAccount();
  const member = await verifiedAccount();
  const doc = { type: "FeatureCollection", view: { center: [49.91, 18.55], zoom: 15, base: "aerial" }, preview: PNG_1PX, features: [
    { type: "Feature", properties: { kind: "revir", name: "Revír B" }, geometry: { type: "Polygon", coordinates: square(18.55, 49.91, 0.004) } },
    { type: "Feature", properties: { kind: "subdistrict", number: 1, name: "Petr 1" }, geometry: { type: "Polygon", coordinates: square(18.551, 49.911) } },
    { type: "Feature", properties: { kind: "parking", name: "Parkoviště", note: "U hráze" }, geometry: { type: "Point", coordinates: [18.549, 49.909] } }
  ] };
  const put = (data, session = manager.session, revirId = "revir-b") => call("PUT", `/manage/settings/maps/${revirId}`, { body: { data, note: "Mapa revíru" }, session });
  assert.equal((await put(doc, member.session)).status, 403, "mapy upravuje jen správa");
  assert.equal((await put(doc, manager.session, "neexistuje")).status, 404);
  const bad = async (patch, why) => assert.equal((await put({ ...doc, ...patch })).data.code, "invalid_settings", why);
  await bad({ type: "Feature" }, "musí být FeatureCollection");
  await bad({ features: [{ ...doc.features[2], properties: { kind: "hrad" } }] }, "neznámý druh bodu");
  await bad({ features: [{ ...doc.features[0], properties: { kind: "parking" } }] }, "plocha nemůže být parkoviště");
  await bad({ features: [{ ...doc.features[0], geometry: { type: "Polygon", coordinates: [[[18.55, 49.91], [18.56, 49.91], [18.56, 49.92], [18.551, 49.92]]] } }] }, "neuzavřená plocha");
  await bad({ features: [{ ...doc.features[2], geometry: { type: "Point", coordinates: [200, 49.9] } }] }, "souřadnice mimo rozsah");
  await bad({ preview: "data:image/jpeg;base64,AAAA" }, "náhled jen PNG");
  await bad({ view: { center: [49.91, 18.55], zoom: 40 } }, "neplatné přiblížení");
  const saved = await put(doc);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const viewMap = saved.data.settings.maps.find((m) => m.revirId === "revir-b");
  assert.equal(viewMap.data.features.length, 3);
  assert.ok(!("preview" in viewMap.data), "nastavení vrací mapu bez náhledu");
  assert.match(viewMap.preview, /^[0-9a-f]{12}$/);
  assert.equal(viewMap.hasFile, false);

  // Veřejné API: mapa bez náhledu + otisk, náhled jako obrázek PNG.
  const pub = (await call("GET", "/maps/revir-b")).data;
  assert.equal(pub.map.features.length, 3);
  assert.ok(!("preview" in pub.map));
  assert.equal(pub.preview, viewMap.preview);
  assert.equal((await call("GET", "/config")).data.reviry[1].map.preview, viewMap.preview);
  const png = await fetch(url("/maps/revir-b/preview.png"));
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join(""), "PNG");

  // Místenka na revír s mapou (revír A, mapa s náhledem): e-mail obsahuje odkaz na interaktivní mapu a náhled.
  const withPreview = await put({ ...fileMap.map, preview: PNG_1PX }, manager.session, "revir-a");
  assert.equal(withPreview.status, 200, JSON.stringify(withPreview.data));
  const hashA = withPreview.data.settings.maps.find((m) => m.revirId === "revir-a").preview;
  const email = "mapa-revir-a@example.cz";
  await paidTicket({ date: "2026-06-11", email });
  const mail = await lastEmail(email, "ticket_issued");
  assert.ok(mail, "e-mail s místenkou");
  assert.match(mail.html, /map\.html\?revir=revir-a/);
  assert.match(mail.html, new RegExp(`maps/revir-a/preview\\.png(\\?|&amp;)v=${hashA}`)); // ve WordPressu &amp; (prefix /?rest_route=)
  assert.match(mail.text, /map\.html\?revir=revir-a/);

  // Historie a obnovení: mapa A má výchozí hodnoty v souboru, mapa B ne.
  const history = (await call("GET", "/manage/settings/history?scope=map:revir-b", { session: manager.session })).data;
  assert.ok(history.versions.length >= 1);
  assert.equal(history.hasFile, false);
  assert.equal((await call("GET", "/manage/settings/history?scope=map:revir-a", { session: manager.session })).data.hasFile, true);
  assert.equal((await call("POST", "/manage/settings/reset", { body: { scope: "map:revir-a" }, session: manager.session })).status, 200);
  const resetA = (await call("GET", "/maps/revir-a")).data;
  assert.equal(resetA.map.features.length, 7, "obnoveno ze souboru");
  assert.equal(resetA.preview, null);
  // Smazání mapy B = prázdná mapa; e-mail už mapu nepřikládá.
  assert.equal((await put({ type: "FeatureCollection", features: [] })).status, 200);
  assert.deepEqual((await call("GET", "/config")).data.reviry[1].map, { features: 0, preview: null });
});

test("platební údaje mění jen admin; změnu dostanou e-mailem všichni admini; nový revír", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const manager = await managerAccount();
  const view = (await call("GET", "/manage/settings", { session: manager.session })).data;
  assert.equal((await call("PUT", "/manage/settings/payment", { body: { data: view.payment.data }, session: manager.session })).data.code, "forbidden_role");
  const admin = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: ["admin"] } });
  await enableTwoFactor(admin.session, T0 + 30_000);
  await setClock("2026-06-10T08:00:00Z");
  assert.equal((await call("PUT", "/manage/settings/payment", { body: { data: { ...view.payment.data, bankCode: "12" } }, session: admin.session })).data.code, "invalid_settings");
  const saved = await call("PUT", "/manage/settings/payment", { body: { data: { ...view.payment.data, accountNumber: "1234567890" } }, session: admin.session });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.payment.provider, "fake", "zdroj plateb se z portálu nemění");
  const { ticket } = await order();
  assert.ok(ticket.payment.spayd.includes("20100000001234567890"), "nová objednávka s novým účtem");
  const mail = await lastEmail(admin.email, "payment_settings_changed");
  assert.ok(mail && mail.text.includes("1234567890"), "admin dostane e-mail se změnou");
  await call("POST", "/manage/settings/reset", { body: { scope: "payment" }, session: admin.session });

  const created = await call("POST", "/manage/settings/reviry", { body: { id: "revir-c", data: { name: "Revír C", priceCzk: 100, dailyCapacity: 10, bookingDaysAhead: 2, lateReturnDays: 7 } }, session: manager.session });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok((await call("GET", "/config")).data.reviry.some((r) => r.id === "revir-c"), "nový revír je hned v nabídce");
  assert.equal((await call("POST", "/manage/settings/reviry", { body: { id: "revir-c", data: { name: "X" } }, session: manager.session })).data.code, "revir_exists");
  const exported = await call("GET", "/manage/settings/export", { session: admin.session });
  assert.ok(exported.data.organization.reviry.some((r) => r.id === "revir-c"), "export platné konfigurace");
  assert.equal((await call("GET", "/manage/settings/export", { session: manager.session })).data.code, "forbidden_role");
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: [] } }); // průvodce na konci testů čeká, že admin neexistuje
});

// ---------- zarybnění, přehledy, uzávěrky (B6) ----------
test("zarybnění: záznamy a plán, validace, rozpočet roku", async () => {
  await setClock("2026-08-03T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/stocking", { session: member.session })).data.code, "forbidden_role");
  const { session } = await managerAccount();
  const add = (body) => call("POST", "/manage/stocking", { body, session });
  assert.equal((await add({ revirId: "revir-a", date: "2026-08-01", species: "kapr" })).data.code, "invalid_amount");
  assert.equal((await add({ revirId: "neexistuje", date: "2026-08-01", species: "kapr", kg: 1 })).data.code, "unknown_revir");
  const actual = await add({ revirId: "revir-a", date: "2026-08-01", species: "kapr", ageClass: "K3", kg: 100, pieces: 200, costCzk: 15000, supplier: "Rybářství Třeboň" });
  assert.equal(actual.status, 201, JSON.stringify(actual.data));
  assert.equal(actual.data.stocking.species, "kapr obecný", "druh v kanonickém tvaru");
  assert.equal(actual.data.stocking.costHalere, 1500000);
  const plan = await add({ revirId: "revir-a", date: "2026-10-01", species: "amur", kg: 30, costCzk: 4500, planned: true });
  assert.equal(plan.data.stocking.planned, true);
  const planned = (await call("GET", "/manage/stocking?year=2026&planned=1", { session })).data.stocking;
  assert.ok(planned.some((s) => s.id === plan.data.stocking.id) && planned.every((s) => s.planned));

  const budget = await call("PUT", "/manage/stocking/budget", { body: { year: "2026", revirId: "revir-a", amountCzk: 50000 }, session });
  assert.equal(budget.status, 200, JSON.stringify(budget.data));
  const row = budget.data.budgets.find((b) => b.revirId === "revir-a");
  assert.equal(row.amountHalere, 5000000);
  assert.equal(row.spentHalere, 1500000, "skutečné náklady");
  assert.equal(row.plannedHalere, 450000, "plánované náklady");
  const total = budget.data.budgets.find((b) => b.total);
  assert.equal(total.revirId, null);
  assert.equal(total.amountHalere, 5000000, "celá MO = součet revírů");
  assert.equal(budget.data.budgets.at(-1).total, true, "součet je poslední řádek");
  assert.equal((await call("PUT", "/manage/stocking/budget", { body: { year: "2026", revirId: null, amountCzk: 1 }, session })).data.code, "unknown_revir", "rozpočet MO nejde nastavit samostatně");
  // Realizace plánu = úprava záznamu (planned: false).
  const done = await call("PUT", `/manage/stocking/${plan.data.stocking.id}`, { body: { revirId: "revir-a", date: "2026-08-02", species: "amur", kg: 28, costCzk: 4200, planned: false }, session });
  assert.equal(done.data.stocking.planned, false);
  assert.equal((await call("GET", "/manage/stocking/budget?year=2026", { session })).data.budgets.find((b) => b.revirId === "revir-a").spentHalere, 1920000);
  assert.equal((await call("DELETE", `/manage/stocking/${plan.data.stocking.id}`, { session })).status, 200);
});

test("přehledy: místenky, tržby, úlovky po druzích, uloveno vs. nasazeno, po měsících", async () => {
  await setClock("2026-08-03T08:00:00Z");
  const { session } = await managerAccount();
  const a = await paidTicket({ date: "2026-08-03", memberId: "74000001" });
  const b = await paidTicket({ date: "2026-08-03", memberId: "74000002" });
  await call("POST", `/tickets/${a.code}/return`, { body: { catches: [{ species: "kapr", length: 50, weight: 2.5 }, { species: "kapr", length: 55 }, { species: "lín", length: 30 }] }, token: a.token });
  await call("POST", `/tickets/${b.code}/return`, { body: { noCatch: true }, token: b.token });
  assert.equal((await call("GET", "/manage/stats?from=2026-08-31&to=2026-08-01", { session })).data.code, "invalid_date");
  const res = await call("GET", "/manage/stats?from=2026-08-01&to=2026-08-31&revirId=revir-a", { session });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const s = res.data;
  assert.equal(s.summary.sold, 2);
  assert.equal(s.summary.returned, 2);
  assert.equal(s.summary.noCatch, 1);
  assert.equal(s.summary.anglers, 2);
  assert.equal(s.summary.revenueHalere, 40000);
  assert.equal(s.catches.total, 3);
  const kapr = s.catches.bySpecies.find((c) => c.species === "kapr obecný");
  assert.deepEqual([kapr.count, kapr.weightKg, kapr.weighed, kapr.avgLength, kapr.maxLength], [2, 2.5, 1, 52.5, 55]);
  const balance = s.balance.find((x) => x.species === "kapr obecný");
  assert.deepEqual([balance.caughtKg, balance.stockedKg, balance.stockedPieces, balance.balanceKg], [2.5, 100, 200, 97.5], "uloveno vs. nasazeno");
  assert.equal(s.stocking.costHalere, 1500000);
  assert.deepEqual(s.byMonth.map((m) => [m.month, m.tickets, m.catches]), [["2026-08", 2, 3]]);
});

test("uzávěrky: ruční za období; čeká na odevzdání vs. neodevzdané; automatická až po lhůtě pro odevzdání, s e-mailem správci, jen jednou", async () => {
  await setClock("2026-08-03T08:00:00Z");
  const { session } = await managerAccount();
  const manual = await call("POST", "/manage/reports", { body: { name: "Srpen 2026", from: "2026-08-01", to: "2026-08-31", revirId: "revir-a" }, session });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(manual.data.kind, "manual");
  assert.equal(manual.data.data.summary.sold, 2, "uložená statistika");

  await paidTicket({ date: "2026-08-03" }); // neodevzdaná – lhůta 7 dní po dni lovu
  const season = await call("POST", "/manage/seasons", { body: { name: "Letní sezona", revirId: "revir-a", opensOn: "2026-08-01", closesOn: "2026-08-03" }, session });
  assert.equal(season.status, 201);
  // Přehled navázaný na sezonu: období a revír podle sezony; přehled za období uvádí, ze kterých sezon je.
  const bySeason = (await call("GET", `/manage/stats?seasonId=${season.data.season.id}`, { session })).data;
  assert.deepEqual([bySeason.season.name, bySeason.from, bySeason.to, bySeason.revirId, bySeason.summary.sold], ["Letní sezona", "2026-08-01", "2026-08-03", "revir-a", 3]);
  assert.equal((await call("GET", "/manage/stats?seasonId=999999", { session })).status, 404);
  const period = (await call("GET", "/manage/stats?from=2026-08-01&to=2026-08-31&revirId=revir-a", { session })).data;
  assert.equal(period.season, null);
  assert.ok(["Letní sezona", "Sezona 2026"].every((n) => period.seasons.some((x) => x.name === n)), JSON.stringify(period.seasons));
  // Úlovky a bilance po podrevírech.
  const sub1 = bySeason.groups.find((g) => g.revirId === "revir-a" && g.subdistrict === "1");
  assert.ok(sub1, JSON.stringify(bySeason.groups));
  assert.deepEqual([sub1.label, sub1.catches.total], ["1 – Horní nádrž", 3]);
  assert.ok(sub1.balance.some((b) => b.species === "kapr obecný" && b.caughtCount === 2));
  // Ruční uzávěrka za sezonu.
  const seasonManual = await call("POST", "/manage/reports", { body: { seasonId: season.data.season.id }, session });
  assert.equal(seasonManual.status, 201, JSON.stringify(seasonManual.data));
  assert.deepEqual([seasonManual.data.name, seasonManual.data.seasonId, seasonManual.data.data.season.name], ["Uzávěrka – Letní sezona", season.data.season.id, "Letní sezona"]);
  assert.equal((await call("GET", "/manage/reports", { session })).data.reports.find((r) => r.id === seasonManual.data.id).season, "Letní sezona");

  const before = (await call("GET", "/manage/reports", { session })).data.reports.filter((r) => r.kind === "season").length;
  const seasonReport = async () => (await call("GET", "/manage/reports", { session })).data.reports.find((r) => r.kind === "season" && r.seasonId === season.data.season.id);

  // Den po skončení sezony: lhůta pro odevzdání běží → uzávěrka by nebyla konečná, automatická ještě nevznikne.
  await setClock("2026-08-04T06:00:00Z");
  const pending = (await call("GET", "/manage/stats?from=2026-08-01&to=2026-08-03&revirId=revir-a", { session })).data.summary;
  assert.deepEqual([pending.sold, pending.returned, pending.awaitingReturn, pending.returnDeadline, pending.unreturned], [3, 2, 1, "2026-08-10", 0], JSON.stringify(pending));
  assert.equal(await seasonReport(), undefined, "automatická uzávěrka až po lhůtě pro odevzdání");
  await setClock("2026-08-10T20:00:00Z");
  assert.equal(await seasonReport(), undefined, "poslední den lhůty ještě ne");

  // Po lhůtě: místenka se uzavře jako neodevzdaná a vznikne konečná uzávěrka.
  await setClock("2026-08-11T06:00:00Z");
  const auto = await seasonReport();
  assert.ok(auto, "automatická uzávěrka");
  assert.deepEqual([auto.from, auto.to], ["2026-08-01", "2026-08-03"]);
  const final = (await call("GET", `/manage/reports/${auto.id}`, { session })).data.data.summary;
  assert.deepEqual([final.sold, final.returned, final.awaitingReturn, final.returnDeadline, final.unreturned], [3, 2, 0, null, 1], JSON.stringify(final));
  assert.ok(await lastEmail("spravce-mo@example.cz", "season_report"), "e-mail správci");
  await setClock("2026-08-12T06:00:00Z");
  assert.equal((await call("GET", "/manage/reports", { session })).data.reports.filter((r) => r.kind === "season").length, before + 1, "uzávěrka sezony jen jednou");
  await call("DELETE", `/manage/seasons/${season.data.season.id}`, { session });
  await setClock("2026-06-10T08:00:00Z");
});

// ---------- zálohy a audit (B7) ----------
test("zálohy: jen admin; ruční záloha jde stáhnout; denní se drží 2; po uzávěrce sezony trvalá; audit", async () => {
  await setClock("2026-09-01T08:00:00Z");
  const manager = await managerAccount();
  assert.equal((await call("GET", "/manage/backups", { session: manager.session })).data.code, "forbidden_role", "správce zálohy nespravuje");
  assert.equal((await call("GET", "/manage/audit", { session: manager.session })).data.code, "forbidden_role");
  const admin = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: ["admin"] } });
  await enableTwoFactor(admin.session, Date.parse("2026-09-01T08:00:30Z"));
  const session = admin.session;

  const manual = await call("POST", "/manage/backups", { body: { note: "Před úpravou ceníku" }, session });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal(manual.data.backup.kind, "manual");
  assert.ok(manual.data.backup.sizeBytes > 0);
  const download = await fetch(url(`/manage/backups/${manual.data.backup.id}/download`), { headers: { Cookie: session.cookie } });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  // Node: kopie databáze SQLite; WordPress: export tabulek pluginu (JSON komprimovaný gzipem).
  assert.ok(bytes.subarray(0, 15).toString() === "SQLite format 3" || (bytes[0] === 0x1f && bytes[1] === 0x8b), "platná záloha (SQLite nebo gzip)");
  assert.equal((await fetch(url(`/manage/backups/${manual.data.backup.id}/download`), { headers: { Cookie: manager.session.cookie } })).status, 403);

  // Denní zálohy: každý den jedna, drží se poslední dvě (bez nastavené sezony = celý rok v sezoně).
  for (const day of ["2026-09-02", "2026-09-03", "2026-09-04"]) await setClock(`${day}T06:00:00Z`);
  const daily = (await call("GET", "/manage/backups", { session })).data.backups.filter((b) => b.kind === "daily");
  assert.equal(daily.length, 2, "drží se poslední a aktuální denní záloha");
  assert.ok(daily[0].createdAt.startsWith("2026-09-04") && daily.every((b) => b.exists));

  // Mimo sezonu se denní záloha nedělá (celoroční sezona z prvního spuštění dočasně pryč).
  await setClock("2026-09-04T08:00:00Z");
  assert.equal((await call("DELETE", `/manage/seasons/${LAUNCH.season.id}`, { session })).status, 200);
  const season = await call("POST", "/manage/seasons", { body: { name: "Podzim", opensOn: "2026-09-01", closesOn: "2026-09-04" }, session });
  await setClock("2026-09-12T06:00:00Z"); // po lhůtě pro odevzdání → uzávěrka → trvalá záloha
  const after = (await call("GET", "/manage/backups", { session })).data.backups;
  const seasonBackup = after.find((b) => b.kind === "season");
  assert.ok(seasonBackup, "záloha po uzávěrce sezony");
  assert.match(seasonBackup.note, /Podzim/);
  assert.ok(!after.some((b) => b.kind === "daily" && b.createdAt.startsWith("2026-09-12")), "mimo sezonu bez denní zálohy");
  LAUNCH.season = (await call("POST", "/manage/seasons", { body: { name: "Sezona 2026", opensOn: "2026-01-01" }, session })).data.season;

  assert.equal((await call("DELETE", `/manage/backups/${manual.data.backup.id}`, { session })).status, 200);
  assert.ok(!(await call("GET", "/manage/backups", { session })).data.backups.some((b) => b.id === manual.data.backup.id));
  const audit = (await call("GET", "/manage/audit?limit=50", { session })).data.events;
  assert.ok(audit.some((e) => e.action === "backup_deleted") && audit.some((e) => e.action === "season_created"), "audit změn");
  await call("DELETE", `/manage/seasons/${season.data.season.id}`, { session });
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: [] } }); // průvodce na konci čeká, že admin neexistuje
  await setClock("2026-06-10T08:00:00Z");
});

test("obnova ze zálohy: jen admin s kódem 2FA a potvrzením; data se vrátí, přihlášení zůstane, vznikne pojistná záloha", async () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  await setClock(new Date(t0).toISOString());
  const admin = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: ["admin"] } });
  const secret = await enableTwoFactor(admin.session, t0 + 30_000);
  const session = admin.session;
  await call("POST", "/manage/announcements", { body: { title: "Před zálohou", revirId: null }, session });
  const backup = (await call("POST", "/manage/backups", { body: { note: "test obnovy" }, session })).data.backup;
  const before = (await call("GET", "/manage/announcements", { session })).data.announcements;
  for (const a of before) await call("DELETE", `/manage/announcements/${a.id}`, { session });
  await call("POST", "/manage/announcements", { body: { title: "Po záloze", revirId: null }, session });

  await setClock(new Date(t0 + 60_000).toISOString());
  const restore = (body) => call("POST", `/manage/backups/${backup.id}/restore`, { body, session });
  assert.equal((await restore({ confirm: "OBNOVIT" })).data.code, "otp_required");
  assert.equal((await restore({ confirm: "OBNOVIT", otp: "000000" })).data.code, "invalid_otp");
  await setClock(new Date(t0 + 90_000).toISOString());
  assert.equal((await restore({ otp: totp(secret, t0 + 90_000) })).data.code, "confirm_required");
  await setClock(new Date(t0 + 120_000).toISOString());
  const done = await restore({ confirm: "OBNOVIT", otp: totp(secret, t0 + 120_000) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.safetyBackup.kind, "pre-restore");
  const titles = (await call("GET", "/manage/announcements", { session })).data.announcements.map((a) => a.title);
  assert.ok(titles.includes("Před zálohou") && !titles.includes("Po záloze"), "data ve stavu zálohy");
  assert.equal((await call("GET", "/auth/me", { session })).data.user.email, admin.email, "přihlášení se obnovou nezruší");
  const list = (await call("GET", "/manage/backups", { session })).data.backups;
  assert.ok(list.some((b) => b.id === done.data.safetyBackup.id), "seznam záloh se obnovou nepřepíše");
  assert.ok((await call("GET", "/manage/audit?action=backup_restored", { session })).data.events.length >= 1);
  for (const a of (await call("GET", "/manage/announcements", { session })).data.announcements) await call("DELETE", `/manage/announcements/${a.id}`, { session });
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: [] } });
  await setClock("2026-06-10T08:00:00Z");
});

test("uchovávání (GDPR): místenka se 3 roky po konci roku lovu anonymizuje, statistika zůstává", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const t = await paidTicket({ email: "retence@example.cz", memberId: "75000001", lastName: "Uchovávaný" });
  await call("POST", `/tickets/${t.code}/return`, { body: { catches: [{ species: "plotice", length: 20 }] }, token: t.token });
  const cfg = (await call("GET", "/config")).data;
  assert.equal(cfg.privacy.ticketYears, 3, "lhůty jsou ve veřejné konfiguraci (stránka zásad)");
  await setClock("2029-12-31T10:00:00Z");
  assert.equal((await call("GET", `/orders/${t.code}`, { memberId: "75000001" })).status, 200, "do konce třetího roku po roce lovu se uchovává");
  await setClock("2030-01-02T08:00:00Z");
  const pub = (await call("GET", `/tickets/${t.code}`)).data;
  assert.equal(pub.holder.name.startsWith("Anonymizováno"), true, "osobní údaje odstraněny");
  assert.equal((await call("GET", `/orders/${t.code}`, { memberId: "75000001" })).status, 403);
  assert.equal(await lastEmail("retence@example.cz"), null, "staré e-maily smazány");
  const { session } = await managerAccount();
  const detail = (await call("GET", `/manage/tickets/${t.code}`, { session })).data;
  assert.equal(detail.ticket.email, "");
  assert.equal(detail.ticket.catches.length, 1, "úlovky zůstávají pro statistiku");
  await setClock("2026-06-10T08:00:00Z");
});

test("pravidla porušení: po pozdních odevzdáních a po zadržení automatická blokace nákupu s příčinou", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { session } = await managerAccount();
  const org = (await call("GET", "/manage/settings", { session })).data.organization.data;
  assert.equal((await call("PUT", "/manage/settings/organization", { body: { data: { ...org, penaltyPolicy: { lateReturn: { count: -1 }, seizure: { count: 1 } } } }, session })).data.code, "invalid_settings");
  const saved = await call("PUT", "/manage/settings/organization", { body: { data: { ...org, penaltyPolicy: { lateReturn: { count: 2, blockDays: 10, includeUnreturned: true }, seizure: { count: 1, blockDays: null } } } }, session });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const late = "76000001";
  const a = await paidTicket({ memberId: late, email: "pozdni@example.cz" });
  const b = await paidTicket({ memberId: late, email: "pozdni@example.cz" });
  await setClock("2026-06-11T08:00:00Z"); // den po lovu → opožděné odevzdání
  await call("POST", `/tickets/${a.code}/return`, { body: { noCatch: true }, token: a.token });
  assert.equal((await call("POST", "/orders", { body: orderBody({ memberId: late, date: "2026-06-12" }) })).status, 201, "první pozdní odevzdání ještě neblokuje");
  await call("POST", `/tickets/${b.code}/return`, { body: { noCatch: true }, token: b.token });
  const blocked = await call("POST", "/orders", { body: orderBody({ memberId: late, date: "2026-06-12" }) });
  assert.equal(blocked.data.code, "member_blocked", "po 2 pozdních odevzdáních blokace");
  assert.ok(await lastEmail("pozdni@example.cz", "member_blocked"));
  const lateBlock = (await call("GET", "/manage/blocks", { session })).data.blocks.find((x) => x.memberId === late);
  assert.equal(lateBlock.cause, "late_return");
  assert.equal(lateBlock.until, "2026-06-20", "10 dní včetně dneška");

  await setClock("2026-06-10T08:00:00Z");
  const warden = await wardenAccount();
  const seizedMember = "76000002";
  const t = await paidTicket({ memberId: seizedMember });
  await call("POST", `/warden/tickets/${t.code}/seize`, { body: { reason: "Lov čtyřmi pruty" }, session: warden.session });
  assert.equal((await call("POST", "/orders", { body: orderBody({ memberId: seizedMember, date: "2026-06-11" }) })).data.code, "member_blocked", "po zadržení blokace");
  const seizureBlock = (await call("GET", "/manage/blocks", { session })).data.blocks.find((x) => x.memberId === seizedMember);
  assert.equal(seizureBlock.cause, "seizure");
  assert.equal(seizureBlock.until, "2026-12-31", "bez počtu dní = do konce roku");
  await call("POST", "/manage/settings/reset", { body: { scope: "organization" }, session });
});

// ---------- žádost „Jsem porybný“ (notifikace) ----------
test("jsem porybný: žádost z registrace i z účtu, schválení v portálu a odkazem z e-mailu, e-mail žadateli", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const manager = await managerAccount();
  // Z registrace: správce se o žádosti dozví až po ověření e-mailu žadatele.
  const body = accountBody({ wardenRequest: true });
  await call("POST", "/auth/register", { body });
  assert.ok(!(await call("GET", "/manage/notifications", { session: manager.session })).data.notifications.some((n) => n.user?.email === body.email), "neověřený účet ještě nežádá");
  const session = {};
  const verified = await call("POST", "/auth/verify", { body: { token: await linkToken(body.email, "account_verify", "verify") }, session });
  assert.equal(verified.data.user.wardenRequest.status, "pending");
  assert.equal((await call("POST", "/me/warden-request", { body: {}, session })).data.code, "request_pending");
  const list = await call("GET", "/manage/notifications", { session: manager.session });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  const request = list.data.notifications.find((n) => n.user?.email === body.email);
  assert.equal(request.status, "pending");
  assert.ok(list.data.pending >= 1);
  const member = await verifiedAccount();
  assert.equal((await call("GET", "/manage/notifications", { session: member.session })).data.code, "forbidden_role");

  // Odkaz z e-mailu správci: náhled a rozhodnutí bez přihlášení, jen jednou.
  const mail = await lastEmail("spravce-mo@example.cz", "warden_request");
  assert.ok(mail && mail.text.includes(body.email), "e-mail správci");
  const token = mail.text.match(/request\.html#t=([A-Za-z0-9_-]+)&a=approve/)[1];
  assert.equal((await call("POST", "/requests/view", { body: { token } })).data.notification.user.email, body.email);
  assert.equal((await call("POST", "/requests/decide", { body: { token, action: "maybe" } })).data.code, "invalid_action");
  const approved = await call("POST", "/requests/decide", { body: { token, action: "approve" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.notification.status, "approved");
  assert.equal((await call("POST", "/requests/decide", { body: { token, action: "reject" } })).data.code, "invalid_link", "odkaz jde použít jen jednou");
  assert.deepEqual((await call("GET", "/auth/me", { session })).data.user.roles, ["member", "warden"]);
  assert.ok(await lastEmail(body.email, "warden_request_approved"), "e-mail žadateli");
  assert.equal((await call("POST", "/me/warden-request", { body: {}, session })).data.code, "already_warden");

  // Z účtu: zamítnutí v portálu.
  const other = await verifiedAccount();
  const asked = await call("POST", "/me/warden-request", { body: { note: "Rybářská stráž MO" }, session: other.session });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const pending = (await call("GET", "/manage/notifications", { session: manager.session })).data.notifications.find((n) => n.user?.email === other.email);
  assert.equal(pending.note, "Rybářská stráž MO");
  const rejected = await call("POST", `/manage/notifications/${pending.id}/reject`, { body: { note: "Nejste v seznamu stráže" }, session: manager.session });
  assert.equal(rejected.data.notification.status, "rejected");
  assert.equal(rejected.data.notification.decidedVia, "portal");
  assert.equal((await call("POST", `/manage/notifications/${pending.id}/approve`, { body: {}, session: manager.session })).data.code, "already_decided");
  assert.ok(await lastEmail(other.email, "warden_request_rejected"));
  const me = (await call("GET", "/auth/me", { session: other.session })).data.user;
  assert.deepEqual(me.roles, ["member"]);
  assert.equal(me.wardenRequest.status, "rejected");
  assert.equal(me.wardenRequest.decisionNote, "Nejste v seznamu stráže");
});

// ---------- e-mailoví klienti (SMTP účty) ----------
test("e-mailoví klienti: účty spravuje admin, heslo se nevrací, odesílatelem skupiny může být jen ověřený účet", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const manager = await managerAccount();
  const admin = await verifiedAccount();
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: ["admin"] } });
  await enableTwoFactor(admin.session, T0 + 30_000);
  await setClock("2026-06-10T08:00:00Z");
  const session = admin.session;
  const body = { label: "Místenka", fromEmail: "mistenka@example.cz", fromName: "Místenka MO Test", host: "smtp.example.cz", port: 465, encryption: "ssl", username: "mistenka@example.cz", password: "smtp-tajne-heslo" };
  assert.equal((await call("POST", "/manage/email/accounts", { body, session: manager.session })).data.code, "forbidden_role", "účty zakládá jen admin");
  for (const [overrides, code] of [[{ fromEmail: "x" }, "invalid_email"], [{ host: "smtp example" }, "invalid_host"], [{ port: 0 }, "invalid_port"], [{ encryption: "starttls" }, "invalid_encryption"]]) {
    assert.equal((await call("POST", "/manage/email/accounts", { body: { ...body, ...overrides }, session })).data.code, code, JSON.stringify(overrides));
  }
  const created = await call("POST", "/manage/email/accounts", { body, session });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const account = created.data.account;
  assert.equal(account.hasPassword, true);
  assert.equal(account.verified, false);
  assert.ok(!JSON.stringify(created.data).includes("smtp-tajne-heslo"), "heslo se nevrací");

  const listed = await call("GET", "/manage/email/accounts", { session: manager.session });
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.canEdit, false, "správce účty jen vidí");
  assert.deepEqual(listed.data.groups.map((g) => g.id), ["tickets", "accounts", "notices", "bugs"]);
  assert.equal(listed.data.groups.find((g) => g.id === "notices").label, "Upozornění správců");
  assert.ok(listed.data.accounts.some((a) => a.id === account.id) && !JSON.stringify(listed.data).includes("smtp-tajne-heslo"));
  assert.equal((await call("POST", `/manage/email/accounts/${account.id}/verify`, { body: {}, session: manager.session })).data.code, "forbidden_role");
  assert.equal((await call("PUT", "/manage/email/senders", { body: { tickets: account.id }, session: manager.session })).data.code, "account_not_verified", "neověřený účet nejde přiřadit");

  const verified = await call("POST", `/manage/email/accounts/${account.id}/verify`, { body: { to: admin.email }, session });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.account.verified, true);
  assert.equal(verified.data.account.verifiedTo, admin.email);
  const assigned = await call("PUT", "/manage/email/senders", { body: { tickets: account.id, accounts: null }, session: manager.session });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.senders.tickets, account.id);
  assert.equal(assigned.data.senders.accounts, null);

  // E-maily skupiny „Místenky“ odejdou přes přiřazený účet (detail místenky ukazuje odesílatele).
  const t = await paidTicket();
  await call("POST", "/dev/jobs");
  const detail = (await call("GET", `/manage/tickets/${t.code}`, { session: manager.session })).data;
  assert.ok(detail.emails.length >= 2 && detail.emails.every((e) => e.sentAt && e.sender === "Místenka"), JSON.stringify(detail.emails));

  // Změna připojení zruší ověření; prázdné heslo = beze změny.
  const edited = await call("PUT", `/manage/email/accounts/${account.id}`, { body: { ...body, password: "", port: 587, encryption: "tls" }, session });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.account.verified, false);
  assert.equal(edited.data.account.hasPassword, true);
  assert.equal((await call("DELETE", `/manage/email/accounts/${account.id}`, { session })).status, 200);
  assert.equal((await call("GET", "/manage/email/accounts", { session })).data.senders.tickets, null, "smazaný účet se odebere ze skupin");
  const restored = await call("PUT", "/manage/email/senders", { body: { tickets: LAUNCH.accountId, accounts: LAUNCH.accountId }, session });
  assert.equal(restored.data.ready, true, "úklid: odesílatelé z prvního spuštění");
  await call("POST", "/dev/users/roles", { body: { email: admin.email, roles: [] } });
});

// ---------- místenka na podrevír ----------
test("podrevíry: místenka na jeden podrevír s vlastní cenou a kapacitou; jediný podrevír v prodeji se vybere sám", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const date = "2026-06-12";
  const missing = await call("POST", "/orders", { body: orderBody({ date, subdistrict: undefined }) });
  assert.equal(missing.data.code, "invalid_subdistrict", "u více podrevírů je výběr povinný");
  assert.equal((await call("POST", "/orders", { body: orderBody({ date, subdistrict: 9 }) })).data.code, "invalid_subdistrict");
  const first = await order({ date, subdistrict: 2 });
  assert.equal(first.ticket.amountDueHalere, 25000, "cena podrevíru");
  assert.deepEqual(first.ticket.subdistrict, { number: "2", label: "2 – Dolní nádrž" });
  await order({ date, subdistrict: 2 });
  const full = await call("POST", "/orders", { body: orderBody({ date, subdistrict: 2 }) });
  assert.equal(full.data.code, "sold_out", "kapacita podrevíru 2");
  const day = (await call("GET", "/reviry/revir-a/availability")).data.days.find((d) => d.date === date);
  assert.deepEqual(day.subdistricts.map((s) => [s.number, s.available]), [[1, 30 - day.subdistricts[0].taken], [2, 0]]);
  assert.equal((await order({ date, subdistrict: 1 })).ticket.subdistrict.number, "1", "podrevír 1 má místa dál");
  assert.equal((await call("GET", `/tickets/${first.ticket.code}`)).data.subdistrict.label, "2 – Dolní nádrž", "veřejná kontrola ukazuje podrevír");
  const mail = await lastEmail(first.ticket.email, "payment_instructions");
  assert.match(mail.text, /Podrevír: 2 – Dolní nádrž/);

  // Revír s jediným podrevírem v prodeji: podrevír se doplní sám.
  const manager = await managerAccount();
  const view = (await call("GET", "/manage/settings", { session: manager.session })).data;
  const revirB = view.reviry.find((r) => r.id === "revir-b");
  const single = await call("PUT", "/manage/settings/reviry/revir-b", { body: { data: { ...revirB.data, subdistrictList: [{ number: 1, name: "Jediná nádrž", priceCzk: 120, dailyCapacity: 3 }], ticketSubdistricts: [1] }, note: "Jeden podrevír" }, session: manager.session });
  assert.equal(single.status, 200, JSON.stringify(single.data));
  const auto = await order({ revirId: "revir-b", date });
  assert.deepEqual([auto.ticket.subdistrict, auto.ticket.amountDueHalere], [{ number: "1", label: "1 – Jediná nádrž" }, 12000]);
  assert.equal((await call("PUT", "/manage/settings/reviry/revir-b", { body: { data: revirB.data, note: "Zpět" }, session: manager.session })).status, 200);
});

// ---------- hlášení chyb ----------
test("hlášení chyb: kdokoli nahlásí (popis, záznam událostí, snímek), admin dostane e-mail, řeší stav a prioritu", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const body = { description: "Po kliknutí na Zaplatit se nic nestalo.", url: "/payment.html", userAgent: "Test", viewport: "390x844", clientTime: "2026-06-10T08:00:00Z",
    log: [{ at: "2026-06-10T07:59:58Z", type: "api", message: "POST /orders → 500 error", page: "/" }], screenshot: png };
  for (const [overrides, code] of [[{ description: "krátké" }, "invalid_description"], [{ screenshot: "data:text/html;base64,PGI+" }, "invalid_screenshot"], [{ contactEmail: "x" }, "invalid_email"]]) {
    assert.equal((await call("POST", "/bug-reports", { body: { ...body, ...overrides } })).data.code, code, JSON.stringify(overrides));
  }
  const sent = await call("POST", "/bug-reports", { body: { ...body, contactEmail: "Rybar@Example.cz" } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.ok(await lastEmail(ROOT.email, "bug_report"), "e-mail adminovi");

  const manager = await managerAccount();
  assert.equal((await call("GET", "/manage/bug-reports", { session: manager.session })).status, 403, "jen admin");
  const admin = {};
  await setClock(new Date(T0 + 150_000).toISOString());
  assert.equal((await call("POST", "/auth/login", { body: { email: ROOT.email, password: ROOT.password, otp: totp(ROOT.secret, T0 + 150_000) }, session: admin })).status, 200);
  await setClock("2026-06-10T08:00:00Z");
  const list = (await call("GET", "/manage/bug-reports", { session: admin })).data;
  const row = list.reports.find((r) => r.id === sent.data.id);
  assert.deepEqual([row.status, row.priority, row.hasScreenshot, row.contactEmail, list.github.configured], ["new", "normal", true, "rybar@example.cz", false]);
  assert.ok(!("screenshot" in row) && !("log" in row), "seznam bez snímku a záznamu");
  const detail = (await call("GET", `/manage/bug-reports/${row.id}`, { session: admin })).data.report;
  assert.deepEqual([detail.screenshot, detail.log[0].message, detail.viewport], [png, "POST /orders → 500 error", "390x844"]);
  assert.equal((await call("PATCH", `/manage/bug-reports/${row.id}`, { body: { priority: "urgent" }, session: admin })).data.code, "invalid_priority");
  assert.equal((await call("PATCH", `/manage/bug-reports/${row.id}`, { body: { githubUrl: "https://example.cz/1" }, session: admin })).data.code, "invalid_github_url");
  const updated = (await call("PATCH", `/manage/bug-reports/${row.id}`, { body: { status: "resolved", priority: "high", note: "Opraveno v 1.0.1", githubUrl: "https://github.com/mo/mistenka/issues/7" }, session: admin })).data.report;
  assert.deepEqual([updated.status, updated.priority, updated.note, updated.githubUrl, Boolean(updated.resolvedAt)], ["resolved", "high", "Opraveno v 1.0.1", "https://github.com/mo/mistenka/issues/7", true]);
  assert.equal((await call("GET", "/manage/bug-reports?status=resolved", { session: admin })).data.counts.resolved, 1);
  assert.equal((await call("POST", `/manage/bug-reports/${row.id}/github`, { session: admin })).data.code, "github_not_configured");
});

// ---------- pozvání správce ----------
test("pozvání správce: admin pozve správce, účet jen pro správu, heslo z odkazu", async () => {
  await setClock(new Date(T0 + 180_000).toISOString());
  const session = {};
  assert.equal((await call("POST", "/auth/login", { body: { email: ROOT.email, password: ROOT.password, otp: totp(ROOT.secret, T0 + 180_000) }, session })).status, 200);
  await setClock("2026-06-10T08:00:00Z");
  const member = await verifiedAccount();
  assert.equal((await call("POST", "/manage/users", { body: { email: "x@example.cz", firstName: "A", lastName: "B", roles: ["warden"] }, session })).data.code, "invalid_roles");
  assert.equal((await call("POST", "/manage/users", { body: { email: member.email, firstName: "A", lastName: "B", roles: ["manager"] }, session })).data.code, "email_taken");
  const invited = await call("POST", "/manage/users", { body: { email: "spravce@example.cz", firstName: "Sára", lastName: "Správcová", roles: ["manager"] }, session });
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  assert.deepEqual(invited.data.user.roles, ["member", "manager"]);
  const managerSession = {};
  const accepted = await call("POST", "/auth/password-reset/confirm", { body: { token: await linkToken("spravce@example.cz", "staff_invite", "invite"), password: "spravce-heslo" }, session: managerSession });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.user.staffOnly, true);
  assert.equal((await call("POST", "/manage/users", { body: { email: "dalsi@example.cz", firstName: "C", lastName: "D", roles: ["manager"] }, session: managerSession })).data.code, "forbidden_role", "zvát smí jen admin");
  // Správce nemusí mít rybářské údaje, běžný uživatel ano.
  assert.equal((await call("PATCH", "/me", { body: { firstName: "Sára", memberId: "", birthDate: "" }, session: managerSession })).status, 200);
  const withFisher = await call("PATCH", "/me", { body: { memberId: "6100 0001", birthDate: "1980-01-01" }, session: managerSession });
  assert.equal(withFisher.data.user.staffOnly, false, "správce si může rybářské údaje doplnit");
  assert.equal((await call("PATCH", "/me", { body: { memberId: "" }, session: member.session })).data.code, "invalid_member_id");
});
