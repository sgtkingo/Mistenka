"use strict";
// Naplní lokální databázi ukázkovými místenkami ve všech stavech, relativně k dnešnímu dni.
// Použití: npm run seed   (smaže a znovu vytvoří data/mistenka.sqlite)
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { openDatabase } = require("../lib/db");
const time = require("../lib/time");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "..", "data"));
for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(path.join(DATA_DIR, `mistenka.sqlite${suffix}`), { force: true });

const config = loadConfig();
const db = openDatabase(DATA_DIR);
const revir = config.reviry[0];
const today = time.pragueToday();
const now = time.now();
const iso = (date) => date.toISOString();
const hoursAgo = (h) => iso(new Date(now.getTime() - h * 3600_000));
const price = Math.round(revir.priceCzk * 100);

const insert = db.prepare(`INSERT INTO tickets (code, revir_id, fishing_date, member_id, first_name, last_name, birth_date, email, price_halere, amount_due_halere,
  variable_symbol, voucher_code, status, created_at, reserved_until, paid_at, issued_at, returned_at, return_late, no_catch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const rows = [
  // kód, posun dne, jméno, příjmení, stav, odevzdáno (hodin zpět | null), pozdě, bez úlovku, popis
  ["TST001", 1, "Petra", "Svobodová", "issued", null, 0, 0, "budoucí"],
  ["TST002", 2, "Martin", "Dvořák", "issued", null, 0, 0, "budoucí"],
  ["TST003", 0, "Tomáš", "Procházka", "issued", null, 0, 0, "aktivní (dnes)"],
  ["TST004", 0, "Alena", "Veselá", "issued", 1, 0, 1, "dnes odevzdaná bez úlovku"],
  ["EXP001", -1, "Karel", "Beneš", "issued", null, 0, 0, "včera, neodevzdaná – lze odevzdat opožděně"],
  ["EXP002", -9, "Ivana", "Šimková", "issued", null, 0, 0, "neodevzdaná po 7denní lhůtě – uzavře se jako neodevzdaná"],
  ["EXP003", -2, "Jan", "Novák", "issued", 30, 0, 0, "odevzdaná včas s úlovkem"],
  ["EXP004", -4, "Anna", "Malá", "issued", 70, 1, 0, "odevzdaná opožděně"],
  ["PAY001", 1, "Pavel", "Hruška", "pending_payment", null, 0, 0, "čeká na platbu"],
  ["PAY002", 1, "Marek", "Jelínek", "payment_expired", null, 0, 0, "rezervace vypršela"]
];

rows.forEach(([code, offset, first, last, status, returnedHoursAgo, late, noCatch], index) => {
  const pending = status === "pending_payment";
  const expired = status === "payment_expired";
  const issued = status === "issued";
  const vs = issued || pending || expired ? String(9000000000 + index) : null;
  insert.run(code, revir.id, time.addDays(today, offset), `2026${String(index).padStart(4, "0")}`, first, last, "1980-05-15", `${code.toLowerCase()}@example.cz`, price, price,
    vs, null, status, hoursAgo(48), pending ? iso(new Date(now.getTime() + 45 * 60_000)) : expired ? hoursAgo(1) : null,
    issued ? hoursAgo(47) : null, issued ? hoursAgo(47) : null, returnedHoursAgo === null ? null : hoursAgo(returnedHoursAgo), late, noCatch);
});
const exp003 = db.prepare("SELECT id FROM tickets WHERE code = 'EXP003'").get().id;
db.prepare("INSERT INTO catches (ticket_id, species, length_cm, weight_kg, weight_estimated) VALUES (?, 'kapr obecný', 55, 3.3, 1)").run(exp003);

for (const code of ["DEMO16ADBEFA9755", "DEMODE0D3AC759F9", "DEMO360008F96605"]) db.prepare("INSERT INTO vouchers (code) VALUES (?)").run(code);
db.prepare("INSERT INTO vouchers (code, used_at, ticket_code) VALUES ('DEMO03DCA6CD2460', ?, 'TST001')").run(hoursAgo(47));

console.log(`Databáze ${path.join(DATA_DIR, "mistenka.sqlite")} naplněna (revír ${revir.name}, dnes ${today}).`);
console.log("Číslo členské legitimace pro přístup k místence je ve druhém sloupci.");
rows.forEach(([code, , first, last, , , , , note], index) => console.log(`  ${code}  2026${String(index).padStart(4, "0")}  ${first} ${last} – ${note}`));
console.log("Poukazy: DEMO16ADBEFA9755, DEMODE0D3AC759F9, DEMO360008F96605 (nepoužité), DEMO03DCA6CD2460 (použitý).");
