"use strict";
// Práce s časem v pásmu Europe/Prague. Datum lovu je kalendářní den (YYYY-MM-DD),
// okamžiky (vytvoření, platba, odevzdání) se ukládají jako ISO čas v UTC.
const TZ = "Europe/Prague";
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

let clockOverride = null; // jen pro testy (MISTENKA_DEV=1)

function now() {
  return clockOverride ? new Date(clockOverride.getTime()) : new Date();
}
function setClock(value) {
  clockOverride = value ? new Date(value) : null;
  if (clockOverride && Number.isNaN(clockOverride.getTime())) { clockOverride = null; throw new Error("Neplatný čas."); }
}

function pragueParts(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function pragueToday(at = now()) {
  const p = pragueParts(at);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function offsetMs(at) {
  const p = pragueParts(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

// Místní čas v Praze (např. "2026-11-08" + "24:00") -> okamžik v UTC. Zvládá letní/zimní čas.
function pragueLocalToDate(isoDate, time = "00:00") {
  const [y, m, d] = isoDate.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const local = Date.UTC(y, m - 1, d, hh, mm);
  let guess = local;
  for (let i = 0; i < 3; i++) guess = local - offsetMs(new Date(guess));
  return new Date(guess);
}

function monthOf(isoDate) {
  return Number(isoDate.slice(5, 7));
}

module.exports = { TZ, now, setClock, isIsoDate, pragueToday, addDays, pragueLocalToDate, monthOf };
