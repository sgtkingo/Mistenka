"use strict";
// Načtení a kontrola konfigurace MO (config/organization.json).
// Jiná MO = jiný konfigurační soubor (proměnná MISTENKA_CONFIG), kód zůstává stejný.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "..", "config", "organization.json");

function fail(message) {
  throw new Error(`Chybná konfigurace: ${message}`);
}

function loadConfig(file = process.env.MISTENKA_CONFIG || DEFAULT_PATH) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!config.organization?.shortName) fail("chybí organization.shortName");
  if (!Array.isArray(config.reviry) || config.reviry.length === 0) fail("chybí seznam reviry");
  if (!config.payment?.accountNumber || !config.payment?.bankCode) fail("chybí payment.accountNumber nebo payment.bankCode");
  const ids = new Set();
  for (const revir of config.reviry) {
    if (!/^[a-z0-9-]+$/.test(revir.id || "")) fail(`revír má neplatné id: ${revir.id}`);
    if (ids.has(revir.id)) fail(`duplicitní id revíru: ${revir.id}`);
    ids.add(revir.id);
    for (const key of ["name", "priceCzk", "dailyCapacity", "bookingDaysAhead", "lateReturnDays"]) {
      if (revir[key] === undefined || revir[key] === null || revir[key] === "") fail(`revír ${revir.id}: chybí ${key}`);
    }
    if (!Number.isInteger(revir.dailyCapacity) || revir.dailyCapacity < 1) fail(`revír ${revir.id}: dailyCapacity musí být kladné celé číslo`);
    if (!(revir.priceCzk >= 0)) fail(`revír ${revir.id}: priceCzk musí být >= 0`);
    if (revir.ticketSubdistricts !== undefined) {
      if (!Array.isArray(revir.ticketSubdistricts)) fail(`revír ${revir.id}: ticketSubdistricts musí být seznam čísel podrevírů`);
      for (const number of revir.ticketSubdistricts) {
        if (Array.isArray(revir.subdistrictList) && !revir.subdistrictList.some((s) => String(s.number) === String(number))) fail(`revír ${revir.id}: podrevír ${number} z ticketSubdistricts není v subdistrictList`);
      }
    }
  }
  config.payment.reservationMinutes ||= 60;
  config.payment.provider ||= "fake";
  config.publicCheck ||= { showFullName: true, memberIdVisibleChars: 4 };
  const baseDir = path.dirname(file);
  const orgRules = loadSpeciesRules(baseDir, config.speciesRules, "organizace");
  for (const revir of config.reviry) {
    const rules = revir.speciesRules ? loadSpeciesRules(baseDir, revir.speciesRules, `revír ${revir.id}`) : orgRules;
    revir.fishRules = applyOverrides(rules, revir.speciesOverrides || [], revir.id);
  }
  config.iban = czIban(config.payment.accountNumber, config.payment.bankCode);
  return config;
}

// Pravidla druhů ryb (míry, hájení, denní limity) jsou v samostatném souboru, např.
// config/species/crs-smas-mp-2026-2027.json. Cesta je relativní ke konfiguraci MO.
function loadSpeciesRules(baseDir, ref, owner) {
  if (!ref) fail(`${owner}: chybí odkaz speciesRules na soubor s pravidly druhů ryb`);
  const file = path.resolve(baseDir, ref);
  let rules;
  try { rules = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`${owner}: nelze načíst ${file} (${error.message})`); }
  if (!Array.isArray(rules.species) || rules.species.length === 0) fail(`${file}: chybí seznam species`);
  const ids = new Set();
  for (const s of rules.species) {
    if (!/^[a-z0-9-]+$/.test(s.id || "") || !s.name) fail(`${file}: druh musí mít id (a-z0-9-) a name`);
    if (ids.has(s.id)) fail(`${file}: duplicitní druh ${s.id}`);
    ids.add(s.id);
    for (const season of s.closedSeasons || []) {
      if (!/^\d{2}-\d{2}$/.test(season.from) || !/^\d{2}-\d{2}$/.test(season.to)) fail(`${file}: ${s.id} má neplatnou dobu hájení (MM-DD)`);
    }
  }
  for (const limit of rules.dailyLimits || []) {
    for (const id of limit.species) if (!ids.has(id)) fail(`${file}: denní limit ${limit.id} odkazuje na neznámý druh ${id}`);
  }
  return { id: rules.id, name: rules.name, validFrom: rules.validFrom, validTo: rules.validTo, sources: rules.sources || [], dailyLimits: rules.dailyLimits || [], species: rules.species };
}

// Úpravy pro konkrétní revír ("na vybraných revírech je zvýšena lovná míra …").
function applyOverrides(rules, overrides, revirId) {
  const species = rules.species.map((s) => ({ ...s }));
  for (const override of overrides) {
    const target = species.find((s) => s.id === override.id);
    if (!target) fail(`revír ${revirId}: speciesOverrides odkazuje na neznámý druh ${override.id}`);
    Object.assign(target, override);
  }
  return { ...rules, species };
}

function getRevir(config, id) {
  return config.reviry.find((revir) => revir.id === id) || null;
}

// Podrevíry, na které se místenka vztahuje, např. "1 – Petr 1, 2 – Petr 2" (null = celý revír).
function ticketSubdistrictLabel(revir) {
  const numbers = Array.isArray(revir.ticketSubdistricts) ? revir.ticketSubdistricts : [];
  if (!numbers.length) return null;
  return numbers.map((number) => {
    const item = (revir.subdistrictList || []).find((s) => String(s.number) === String(number));
    return item?.name ? `${number} – ${item.name}` : String(number);
  }).join(", ");
}

function revirRules(revir) {
  return revir.fishRules;
}

// Veřejná část konfigurace pro frontend – bez tajných a interních údajů.
function publicConfig(config, extra = {}) {
  const org = config.organization;
  return {
    organization: { id: org.id, name: org.name, shortName: org.shortName, web: org.web || "", privacyUrl: org.privacyUrl || "", contact: org.contact || {} },
    payment: { mode: config.payment.provider, reservationMinutes: config.payment.reservationMinutes },
    reviry: config.reviry.map((revir) => {
      const { fishRules, speciesRules, speciesOverrides, ...rest } = revir;
      return { ...rest, fishRules };
    }),
    ...extra
  };
}

// Číslo účtu ve tvaru [předčíslí-]číslo + kód banky -> IBAN (CZ).
function czIban(accountNumber, bankCode) {
  const [prefix, number] = String(accountNumber).includes("-") ? String(accountNumber).split("-") : ["0", String(accountNumber)];
  if (!/^\d{1,6}$/.test(prefix) || !/^\d{2,10}$/.test(number) || !/^\d{4}$/.test(String(bankCode))) fail("neplatné číslo účtu nebo kód banky");
  const bban = String(bankCode) + prefix.padStart(6, "0") + number.padStart(10, "0");
  const numeric = bban + "123500"; // "CZ00": C=12, Z=35
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return `CZ${String(98 - remainder).padStart(2, "0")}${bban}`;
}

module.exports = { loadConfig, getRevir, revirRules, ticketSubdistrictLabel, publicConfig, czIban };
