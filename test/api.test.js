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
  return BASE + p;
}
async function call(method, p, { body, token, memberId } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Mistenka-Token"] = token;
  if (memberId) headers["X-Mistenka-Member-Id"] = memberId;
  const response = await fetch(url(p), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
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
