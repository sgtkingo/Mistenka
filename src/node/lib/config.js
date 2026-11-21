"use strict";
// Načtení a kontrola konfigurace MO (config/organization.json).
// Jiná MO = jiný konfigurační soubor (proměnná MISTENKA_CONFIG), kód zůstává stejný.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "..", "config", "organization.json");

function fail(message) {
  throw new Error(`Chybná konfigurace: ${message}`);
}

// Zdroj konfigurace: soubor MO + soubory pravidel druhů ryb, na které odkazuje (speciesRules).
function readSource(file = process.env.MISTENKA_CONFIG || DEFAULT_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const baseDir = path.dirname(file);
  const species = {};
  const refs = new Set([raw.speciesRules, ...(raw.reviry || []).map((r) => r.speciesRules)].filter(Boolean));
  for (const ref of refs) {
    try { species[ref] = JSON.parse(fs.readFileSync(path.resolve(baseDir, ref), "utf8")); } catch (error) { fail(`nelze načíst pravidla ${ref} (${error.message})`); }
  }
  return { file, raw, species };
}

function loadConfig(file) {
  const source = readSource(file);
  const config = buildConfig(source.raw, source.species);
  Object.defineProperty(config, "source", { value: source, enumerable: false });
  return config;
}

// Sestaví a zkontroluje konfiguraci z dat MO (tvar organization.json) a pravidel druhů (ref -> dokument).
// Používá se pro soubor i pro nastavení uložené v databázi (B5); chyba = výjimka „Chybná konfigurace: …“.
function buildConfig(rawInput, speciesDocs) {
  const config = structuredClone(rawInput);
  if (!config.organization?.shortName) fail("chybí organization.shortName");
  if (!Array.isArray(config.reviry) || config.reviry.length === 0) fail("chybí seznam reviry");
  if (!config.payment?.accountNumber || !config.payment?.bankCode) fail("chybí payment.accountNumber nebo payment.bankCode");
  // Lhůta pro opožděné odevzdání je jedna pro celou MO (portál → Limity a blokace, výchozí 7 dní).
  // Starší konfigurace ji měly u revíru – převezme se hodnota prvního revíru.
  const legacyDays = config.reviry.find((r) => Number.isInteger(r?.lateReturnDays))?.lateReturnDays;
  config.returnPolicy = { lateReturnDays: legacyDays ?? 7, ...(config.returnPolicy || {}) };
  if (!Number.isInteger(config.returnPolicy.lateReturnDays) || config.returnPolicy.lateReturnDays < 0 || config.returnPolicy.lateReturnDays > 60) fail("lhůta pro opožděné odevzdání musí být 0–60 dní");
  for (const revir of config.reviry) if (revir && typeof revir === "object") revir.lateReturnDays = config.returnPolicy.lateReturnDays;
  // Prodej dopředu je také jeden pro celou MO (portál → Ceny a místa, výchozí 3 dny).
  const legacyAhead = config.reviry.find((r) => Number.isInteger(r?.bookingDaysAhead))?.bookingDaysAhead;
  config.salesPolicy = { bookingDaysAhead: legacyAhead ?? 3, ...(config.salesPolicy || {}) };
  if (!Number.isInteger(config.salesPolicy.bookingDaysAhead) || config.salesPolicy.bookingDaysAhead < 0 || config.salesPolicy.bookingDaysAhead > 60) fail("prodej dopředu musí být 0–60 dní");
  for (const revir of config.reviry) if (revir && typeof revir === "object") revir.bookingDaysAhead = config.salesPolicy.bookingDaysAhead;
  const ids = new Set();
  for (const revir of config.reviry) {
    if (!/^[a-z0-9-]+$/.test(revir.id || "")) fail(`revír má neplatné id: ${revir.id}`);
    if (ids.has(revir.id)) fail(`duplicitní id revíru: ${revir.id}`);
    ids.add(revir.id);
    for (const key of ["name", "priceCzk", "dailyCapacity", "bookingDaysAhead", "lateReturnDays"]) {
      if (revir[key] === undefined || revir[key] === null || revir[key] === "") fail(`revír ${revir.id}: chybí ${key}`);
    }
    if (!Number.isInteger(revir.dailyCapacity) || revir.dailyCapacity < 1) fail(`revír ${revir.id}: denní kapacita musí být kladné celé číslo`);
    if (!(typeof revir.priceCzk === "number" && revir.priceCzk >= 0)) fail(`revír ${revir.id}: cena musí být číslo >= 0`);
    if (!Number.isInteger(revir.bookingDaysAhead) || revir.bookingDaysAhead < 0 || revir.bookingDaysAhead > 60) fail(`revír ${revir.id}: prodej dopředu musí být 0–60 dní`);
    if (!Number.isInteger(revir.lateReturnDays) || revir.lateReturnDays < 0 || revir.lateReturnDays > 60) fail(`revír ${revir.id}: lhůta pro opožděné odevzdání musí být 0–60 dní`);
    if (revir.ticketSubdistricts !== undefined) {
      if (!Array.isArray(revir.ticketSubdistricts)) fail(`revír ${revir.id}: ticketSubdistricts musí být seznam čísel podrevírů`);
      for (const number of revir.ticketSubdistricts) {
        if (Array.isArray(revir.subdistrictList) && !revir.subdistrictList.some((s) => String(s.number) === String(number))) fail(`revír ${revir.id}: podrevír ${number} z ticketSubdistricts není v subdistrictList`);
      }
    }
    // Podrevír v prodeji může mít vlastní cenu a počet míst (jinak platí hodnoty revíru).
    for (const s of Array.isArray(revir.subdistrictList) ? revir.subdistrictList : []) {
      if (s.priceCzk !== undefined && s.priceCzk !== null && !(typeof s.priceCzk === "number" && s.priceCzk >= 0)) fail(`revír ${revir.id}, podrevír ${s.number}: cena musí být číslo >= 0`);
      if (s.dailyCapacity !== undefined && s.dailyCapacity !== null && !(Number.isInteger(s.dailyCapacity) && s.dailyCapacity >= 1)) fail(`revír ${revir.id}, podrevír ${s.number}: počet míst musí být kladné celé číslo`);
    }
    revir.saleSubdistricts = saleSubdistricts(revir);
  }
  config.payment.reservationMinutes ||= 60;
  if (!Number.isInteger(config.payment.reservationMinutes) || config.payment.reservationMinutes < 10 || config.payment.reservationMinutes > 24 * 60) fail("rezervace před platbou musí být 10–1440 minut");
  config.payment.provider ||= "fake";
  config.publicCheck ||= { showFullName: true, memberIdVisibleChars: 4 };
  // Automatická blokace po opakovaném porušení limitů (0 = vypnuto).
  config.limitPolicy = { violationsBeforeBlock: 0, blockDays: null, ...(config.limitPolicy || {}) };
  if (!Number.isInteger(config.limitPolicy.violationsBeforeBlock) || config.limitPolicy.violationsBeforeBlock < 0) fail("počet porušení před blokací musí být celé číslo >= 0");
  if (config.limitPolicy.blockDays !== null && !(Number.isInteger(config.limitPolicy.blockDays) && config.limitPolicy.blockDays > 0)) fail("délka blokace musí být kladný počet dní, nebo prázdná (do konce roku)");
  // Uchovávání osobních údajů (GDPR) – obecné výchozí lhůty, organizace je může upravit.
  config.privacy = { contactEmail: "", ticketYears: 3, accountingYears: 10, emailDays: 90, auditYears: 5, backupYears: 3, ...(config.privacy || {}) };
  for (const [key, min, max, label] of [["ticketYears", 1, 20, "uchování místenek"], ["accountingYears", 5, 20, "účetní lhůta"], ["emailDays", 7, 3650, "uchování e-mailů"], ["auditYears", 1, 20, "uchování auditu"], ["backupYears", 1, 20, "uchování záloh"]]) {
    if (!Number.isInteger(config.privacy[key]) || config.privacy[key] < min || config.privacy[key] > max) fail(`${label} musí být celé číslo ${min}–${max}`);
  }
  if (config.privacy.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.privacy.contactEmail)) fail("neplatný e-mail pro ochranu osobních údajů");
  // Následky porušení pravidel (automatická blokace nákupu): pozdní/neodevzdání a zadržení porybným.
  const pp = config.penaltyPolicy || {};
  config.penaltyPolicy = {
    lateReturn: { count: 0, blockDays: null, includeUnreturned: true, ...(pp.lateReturn || {}) },
    seizure: { count: 0, blockDays: null, ...(pp.seizure || {}) }
  };
  for (const [key, label] of [["lateReturn", "pozdní odevzdání"], ["seizure", "zadržení"]]) {
    const rule = config.penaltyPolicy[key];
    if (!Number.isInteger(rule.count) || rule.count < 0 || rule.count > 50) fail(`${label}: počet případů musí být celé číslo 0–50`);
    if (rule.blockDays !== null && !(Number.isInteger(rule.blockDays) && rule.blockDays > 0 && rule.blockDays <= 3650)) fail(`${label}: délka blokace musí být 1–3650 dní, nebo prázdná (do konce roku)`);
  }
  // E-maily (odesílatelé, příjemci upozornění) nastavuje admin v portálu (Emailoví klienti), ne konfigurace.
  delete config.organization.managerEmail;
  delete config.email;
  const contactEmail = config.organization.contact?.email;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) fail("neplatný veřejný e-mail");
  const orgRules = speciesRulesFor(speciesDocs, config.speciesRules, "organizace");
  for (const revir of config.reviry) {
    const rules = revir.speciesRules ? speciesRulesFor(speciesDocs, revir.speciesRules, `revír ${revir.id}`) : orgRules;
    revir.fishRules = applyOverrides(rules, revir.speciesOverrides || [], revir.id);
  }
  config.iban = czIban(config.payment.accountNumber, config.payment.bankCode);
  return config;
}

// Pravidla druhů ryb (míry, hájení, limity), např. config/species/crs-smas-mp-2026-2027.json.
function speciesRulesFor(speciesDocs, ref, owner) {
  if (!ref) fail(`${owner}: chybí odkaz speciesRules na pravidla druhů ryb`);
  const rules = speciesDocs[ref];
  if (!rules) fail(`${owner}: pravidla ${ref} nejsou načtená`);
  return validateSpeciesRules(rules, ref);
}
function validateSpeciesRules(rules, file) {
  if (!Array.isArray(rules.species) || rules.species.length === 0) fail(`${file}: chybí seznam species`);
  const ids = new Set();
  for (const s of rules.species) {
    if (!/^[a-z0-9-]+$/.test(s.id || "") || !s.name) fail(`${file}: druh musí mít id (a-z0-9-) a name`);
    if (ids.has(s.id)) fail(`${file}: duplicitní druh ${s.id}`);
    ids.add(s.id);
    for (const key of ["minLength", "releaseFromLength", "weightFactor"]) {
      if (s[key] !== undefined && s[key] !== null && !(typeof s[key] === "number" && s[key] >= 0)) fail(`${file}: ${s.name} – ${key} musí být číslo >= 0`);
    }
    for (const season of s.closedSeasons || []) {
      if (!/^\d{2}-\d{2}$/.test(season.from) || !/^\d{2}-\d{2}$/.test(season.to)) fail(`${file}: ${s.name} má neplatnou dobu hájení (MM-DD)`);
    }
  }
  for (const limit of rules.dailyLimits || []) {
    if (!(Number.isInteger(limit.maxCount) && limit.maxCount > 0)) fail(`${file}: denní limit ${limit.id} musí mít maxCount > 0`);
    for (const id of limit.species) if (!ids.has(id)) fail(`${file}: denní limit ${limit.id} odkazuje na neznámý druh ${id}`);
  }
  for (const limit of rules.periodLimits || []) {
    if (!["week", "month"].includes(limit.period)) fail(`${file}: limit ${limit.id} má neplatné období (week | month)`);
    if (!(Number.isInteger(limit.maxCount) && limit.maxCount > 0)) fail(`${file}: limit ${limit.id} musí mít maxCount > 0`);
    for (const id of limit.species) if (!ids.has(id)) fail(`${file}: limit ${limit.id} odkazuje na neznámý druh ${id}`);
  }
  return { id: rules.id, name: rules.name, validFrom: rules.validFrom, validTo: rules.validTo, sources: rules.sources || [], dailyLimits: rules.dailyLimits || [], periodLimits: rules.periodLimits || [], species: rules.species };
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

// Podrevíry v prodeji (ticketSubdistricts): místenka platí pro jeden z nich, každý má cenu a počet míst
// (vlastní, jinak revíru). Prázdné = místenka na celý revír (cena a místa revíru).
function saleSubdistricts(revir) {
  const numbers = Array.isArray(revir.ticketSubdistricts) ? revir.ticketSubdistricts : [];
  return numbers.map((number) => {
    const s = (revir.subdistrictList || []).find((item) => String(item.number) === String(number)) || {};
    return {
      number, name: s.name || "", area: s.area || "",
      priceCzk: typeof s.priceCzk === "number" ? s.priceCzk : revir.priceCzk,
      dailyCapacity: Number.isInteger(s.dailyCapacity) ? s.dailyCapacity : revir.dailyCapacity
    };
  });
}
// Podrevír místenky, např. "1 – Petr 1" (null = celý revír).
function subdistrictName(revir, number) {
  if (number === null || number === undefined || number === "") return null;
  const item = (revir?.subdistrictList || []).find((s) => String(s.number) === String(number));
  return item?.name ? `${number} – ${item.name}` : String(number);
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
    organization: { id: org.id, name: org.name, shortName: org.shortName, web: org.web || "", privacyUrl: org.privacyUrl || "", contact: org.contact || {}, address: org.address || "", ico: org.ico || "" },
    privacy: config.privacy,
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

module.exports = { loadConfig, readSource, buildConfig, getRevir, revirRules, ticketSubdistrictLabel, saleSubdistricts, subdistrictName, publicConfig, czIban };
