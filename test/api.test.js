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
  const port = 3300 + Math.floor(Math.random() * 500);
  child = spawn(process.execPath, ["--no-warnings", path.join(__dirname, "..", "src", "node", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: tmpDir, MISTENKA_CONFIG: path.join(__dirname, "fixtures", "organization.test.json"), MISTENKA_DEV: "1", MISTENKA_RATE_LIMIT: "0", MISTENKA_JOBS_INTERVAL_MS: "0", APP_URL: `http://localhost:${port}` },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("běží na")) resolve(); });
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
  return { revirId: "revir-a", date: "2026-06-10", memberId: String(30000000 + seq), firstName: "Jan", lastName: "Tester", birthDate: "1985-03-02", email: `tester${seq}@example.cz`, declaration: true, ...overrides };
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
  assert.equal(data.days[0].capacity, 30);
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
test("odevzdání: validace úlovků, míry, hájení, povinné vrácení, denní limit, úspěch, opakování", async () => {
  await setClock("2026-06-10T08:00:00Z");
  const { token, code } = await paidTicket({ revirId: "revir-b" });
  const ret = (body) => call("POST", `/tickets/${code}/return`, { body, token });
  assert.equal((await call("POST", `/tickets/${code}/return`, { body: { noCatch: true } })).status, 403);
  assert.equal((await ret({ catches: [] })).data.code, "catches_required");
  assert.equal((await ret({ noCatch: true, catches: [{ species: "kapr", length: 50 }] })).data.code, "invalid_catches");
  assert.equal((await ret({ catches: [{ species: "lín", length: 28 }] })).data.code, "undersized", "revír B má zpřísněnou míru lína 30 cm");
  assert.equal((await ret({ catches: [{ species: "kapr", length: 39 }] })).data.code, "undersized");
  assert.equal((await ret({ catches: [{ species: "kapr", length: 72 }] })).data.code, "must_release", "kapr od 70 cm se vrací");
  assert.equal((await ret({ catches: [{ species: "štika obecná", length: 80 }] })).data.code, "closed_season", "štika hájena do 15. 6.");
  assert.equal((await ret({ catches: [{ species: "lipan", length: 40 }] })).data.code, "closed_season", "lipan celoročně hájen");
  const three = [{ species: "kapr", length: 50 }, { species: "lín", length: 35 }, { species: "amur", length: 65 }];
  assert.equal((await ret({ catches: three })).data.code, "daily_limit", "max. 2 ks významných druhů");
  assert.equal((await ret({ catches: [{ species: "", length: 40 }] })).data.code, "invalid_catches");
  const ok = await ret({ catches: [{ species: "Kapr", length: 52, weight: 2.1, weightEstimated: true }, { species: "plotice", length: 20 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "expired_returned");
  assert.equal(ok.data.late, false);
  assert.deepEqual(ok.data.catches.map((c) => c.species), ["kapr obecný", "plotice obecná"], "druh se zapíše v kanonickém tvaru");
  assert.equal(ok.data.catches[0].weightEstimated, true);
  assert.equal((await ret({ noCatch: true })).data.code, "already_returned");
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
  const promoted = await call("PUT", `/manage/users/${managerId}/roles`, { body: { roles: ["manager"] }, session: admin.session });
  assert.deepEqual(promoted.data.user.roles, ["member", "manager"]);
  assert.equal((await call("PUT", `/manage/users/${managerId}/roles`, { body: { roles: ["boss"] }, session: admin.session })).data.code, "invalid_roles");

  // Správce (bez 2FA – pro správce je volitelná) smí jen porybného.
  const warden = await call("PUT", `/manage/users/${member.user.id}/roles`, { body: { roles: ["warden"] }, session: manager.session });
  assert.equal(warden.status, 200, JSON.stringify(warden.data));
  assert.deepEqual(warden.data.user.roles, ["member", "warden"]);
  assert.equal((await call("PUT", `/manage/users/${member.user.id}/roles`, { body: { roles: ["warden", "manager"] }, session: manager.session })).data.code, "forbidden_role");
  assert.equal((await call("PUT", `/manage/users/${admin.user.id}/roles`, { body: { roles: [] }, session: manager.session })).data.code, "forbidden_role");

  // Posledního admina nelze odebrat ani smazat; admin si nemůže vypnout 2FA.
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

// ---------- průvodce prvním spuštěním a pozvání správce ----------
// Musí běžet poslední: po založení admina se průvodce zavře.
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
  assert.equal((await call("POST", "/auth/login", { body: { email: "admin@example.cz", password: "admin-heslo", otp: totp(setup.data.secret, T0 + 60_000) } })).status, 200);

  // Admin pozve správce: účet jen pro správu, heslo si nastaví z odkazu.
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
