"use strict";
// Načtení a kontrola konfigurace MO (config/organization.json → revíry → mapy revírů).
// Jiná MO = jiný konfigurační soubor (proměnná MISTENKA_CONFIG), kód zůstává stejný.
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_DIR = path.join(__dirname, "..", "..", "..", "config");
const DEFAULT_PATH = path.join(CONFIG_DIR, "organization.json");
// Konfigurace MO je jen lokální (není v repu); bez ní se použije vzor config/example, aby šel balíček rovnou spustit.
const EXAMPLE_PATH = path.join(CONFIG_DIR, "example", "organization.json");
function defaultPath() {
  if (fs.existsSync(DEFAULT_PATH) || !fs.existsSync(EXAMPLE_PATH)) return DEFAULT_PATH;
  console.warn("Konfigurace config/organization.json chybí – používám vzor config/example (zkopírujte ho a upravte pro svou MO).");
  return EXAMPLE_PATH;
}

function fail(message) {
  throw new Error(`Chybná konfigurace: ${message}`);
}

function readJsonFile(file, what) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`nelze načíst ${what} (${error.message})`); }
}

// Zdroj konfigurace: soubor MO + soubory, na které odkazuje. Odkazy jsou relativní ke složce organization.json:
//   reviry: ["reviry/petruvka-1a.json", …]   revír ve vlastním souboru (nebo přímo objekt v seznamu)
//   revír.map: "maps/petruvka-1a.json"       mapa revíru (GeoJSON); bez odkazu se použije maps/<id>.json, pokud existuje
//   speciesRules: "species/….json"            pravidla druhů ryb (u organizace nebo revíru)
function readSource(file = process.env.MISTENKA_CONFIG || defaultPath()) {
  const raw = readJsonFile(file, file);
  const baseDir = path.dirname(file);
  raw.reviry = (Array.isArray(raw.reviry) ? raw.reviry : []).map((entry) => (typeof entry === "string" ? readJsonFile(path.resolve(baseDir, entry), `revír ${entry}`) : entry));
  const maps = {};
  for (const revir of raw.reviry) {
    if (!revir || typeof revir !== "object") continue;
    const ref = revir.map || (revir.id && fs.existsSync(path.join(baseDir, "maps", `${revir.id}.json`)) ? `maps/${revir.id}.json` : null);
    delete revir.map;
    if (!ref || !revir.id) continue;
    maps[revir.id] = typeof ref === "object" ? ref : readJsonFile(path.resolve(baseDir, ref), `mapa revíru ${revir.id} (${ref})`);
  }
  const species = {};
  const refs = new Set([raw.speciesRules, ...raw.reviry.map((r) => r?.speciesRules)].filter(Boolean));
  for (const ref of refs) species[ref] = readJsonFile(path.resolve(baseDir, ref), `pravidla ${ref}`);
  return { file, raw, species, maps };
}

function loadConfig(file) {
  const source = readSource(file);
  const config = buildConfig(source.raw, source.species, source.maps);
  Object.defineProperty(config, "source", { value: source, enumerable: false });
  return config;
}

// Sestaví a zkontroluje konfiguraci z dat MO (tvar organization.json) a pravidel druhů (ref -> dokument).
// Používá se pro soubor i pro nastavení uložené v databázi (B5); chyba = výjimka „Chybná konfigurace: …“.
function buildConfig(rawInput, speciesDocs, mapDocs = {}) {
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
    // GPS: revír bez podrevírů má společnou GPS; s podrevíry má GPS každý podrevír (společná je jen záložní).
    if (gpsProblem(revir.gps)) fail(`revír ${revir.id}: ${gpsProblem(revir.gps)}`);
    // Podrevír v prodeji může mít vlastní cenu a počet míst (jinak platí hodnoty revíru).
    for (const s of Array.isArray(revir.subdistrictList) ? revir.subdistrictList : []) {
      if (gpsProblem(s.gps)) fail(`revír ${revir.id}, podrevír ${s.number}: ${gpsProblem(s.gps)}`);
      if (s.priceCzk !== undefined && s.priceCzk !== null && !(typeof s.priceCzk === "number" && s.priceCzk >= 0)) fail(`revír ${revir.id}, podrevír ${s.number}: cena musí být číslo >= 0`);
      if (s.dailyCapacity !== undefined && s.dailyCapacity !== null && !(Number.isInteger(s.dailyCapacity) && s.dailyCapacity >= 1)) fail(`revír ${revir.id}, podrevír ${s.number}: počet míst musí být kladné celé číslo`);
    }
    revir.saleSubdistricts = saleSubdistricts(revir);
    delete revir.map; // mapa revíru je samostatná část (config.maps), ne údaj revíru
  }
  // Mapy revírů (GeoJSON se zakreslenými plochami a body); mapa revíru, který v konfiguraci není, se ignoruje.
  config.maps = {};
  for (const [id, doc] of Object.entries(mapDocs || {})) if (ids.has(id)) config.maps[id] = validateMap(doc, id);
  config.payment.reservationMinutes ||= 60;
  if (!Number.isInteger(config.payment.reservationMinutes) || config.payment.reservationMinutes < 10 || config.payment.reservationMinutes > 24 * 60) fail("rezervace před platbou musí být 10–1440 minut");
  config.payment.provider ||= "fake";
  config.publicCheck ||= { showFullName: true, memberIdVisibleChars: 4 };
  // Veřejná část statistiky v účtu („Jak se posledně dařilo ostatním?“) – výchozí zapnuto.
  config.statsPolicy = { community: true, ...(config.statsPolicy || {}) };
  if (typeof config.statsPolicy.community !== "boolean") fail("statsPolicy.community musí být true/false");
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

// ---------- mapy revírů ----------
// GeoJSON FeatureCollection: plochy (revír, podrevír, zákaz lovu), čáry (cesta, zákaz lovu) a body (parkoviště, WC …).
// Navíc view = výchozí pohled { center: [lat, lon], zoom, base }. Stav podrevírů (místenka platí / neplatí) se do mapy
// neukládá – mapa ho bere z aktuálního nastavení revíru (ticketSubdistricts).
const MAP_KINDS = { Polygon: ["revir", "subdistrict", "restricted"], LineString: ["path", "restricted"], Point: ["parking", "wc", "entrance", "info", "danger", "other"] };
const MAP_BASES = ["outdoor", "basic", "aerial", "winter"];
function validateMap(input, id) {
  const where = `mapa revíru ${id}`;
  if (!input || typeof input !== "object" || Array.isArray(input) || input.type !== "FeatureCollection" || !Array.isArray(input.features)) fail(`${where}: musí být GeoJSON FeatureCollection`);
  // Starší verze ukládaly i náhled PNG (preview) – už se nepoužívá, zahodí se.
  const { preview, ...doc } = input;
  if (doc.features.length > 300) fail(`${where}: nejvýš 300 prvků`);
  const position = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -180 && p[0] <= 180 && p[1] >= -85 && p[1] <= 85;
  let total = 0;
  doc.features.forEach((feature, index) => {
    const label = `${where}, prvek ${index + 1}`;
    if (!feature || typeof feature !== "object" || feature.type !== "Feature" || !feature.geometry || typeof feature.geometry !== "object") fail(`${label}: neplatný prvek`);
    const { type, coordinates } = feature.geometry;
    if (!MAP_KINDS[type]) fail(`${label}: nepodporovaný typ geometrie ${type}`);
    let points = 0;
    if (type === "Point") {
      if (!position(coordinates)) fail(`${label}: neplatné souřadnice`);
      points = 1;
    } else if (type === "LineString") {
      if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(position)) fail(`${label}: čára potřebuje alespoň 2 platné body`);
      points = coordinates.length;
    } else {
      if (!Array.isArray(coordinates) || coordinates.length < 1 || coordinates.length > 10) fail(`${label}: neplatná plocha`);
      for (const ring of coordinates) {
        if (!Array.isArray(ring) || ring.length < 4 || !ring.every(position)) fail(`${label}: plocha potřebuje alespoň 3 platné body`);
        const [first, last] = [ring[0], ring[ring.length - 1]];
        if (first[0] !== last[0] || first[1] !== last[1]) fail(`${label}: plocha musí být uzavřená`);
        points += ring.length;
      }
    }
    total += points;
    if (points > 2000 || total > 10000) fail(`${where}: příliš mnoho bodů`);
    const props = feature.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) fail(`${label}: chybí vlastnosti (properties)`);
    if (!MAP_KINDS[type].includes(props.kind)) fail(`${label}: neznámý druh ${props.kind}`);
    for (const [key, max] of [["name", 80], ["note", 300]]) {
      if (props[key] !== undefined && props[key] !== null && !(typeof props[key] === "string" && props[key].length <= max)) fail(`${label}: ${key} musí být text do ${max} znaků`);
    }
    if (props.number !== undefined && props.number !== null && !(Number.isInteger(props.number) || (typeof props.number === "string" && props.number.length <= 10))) fail(`${label}: neplatné číslo podrevíru`);
  });
  const view = doc.view;
  if (view !== undefined && view !== null) {
    if (typeof view !== "object" || Array.isArray(view) || !Array.isArray(view.center) || !position([view.center[1], view.center[0]]) || !Number.isInteger(view.zoom) || view.zoom < 3 || view.zoom > 20 || (view.base !== undefined && !MAP_BASES.includes(view.base))) fail(`${where}: neplatný výchozí pohled (view)`);
  }
  return doc;
}
// Souhrn mapy pro veřejnou konfiguraci (počet zakreslených prvků).
function mapSummary(map) {
  return map ? { features: map.features.length } : null;
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
  // Hlídání limitů úlovků (výchozí vypnuto) a lovných měr – míra, hájení, povinné vrácení (výchozí zapnuto); přepíná se ve správě.
  for (const key of ["limitsEnabled", "sizeRulesEnabled"]) if (rules[key] !== undefined && typeof rules[key] !== "boolean") fail(`${file}: ${key} musí být true/false`);
  return { id: rules.id, name: rules.name, validFrom: rules.validFrom, validTo: rules.validTo, sources: rules.sources || [], dailyLimits: rules.dailyLimits || [], periodLimits: rules.periodLimits || [], species: rules.species,
    limitsEnabled: rules.limitsEnabled === true, sizeRulesEnabled: rules.sizeRulesEnabled !== false };
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

// GPS { lat, lon, label? }: null = v pořádku (nebo nezadaná), jinak popis chyby.
function gpsProblem(gps) {
  if (gps === undefined || gps === null) return null;
  if (typeof gps !== "object" || Array.isArray(gps)) return "GPS musí být objekt { lat, lon }";
  if (!(typeof gps.lat === "number" && gps.lat >= -90 && gps.lat <= 90) || !(typeof gps.lon === "number" && gps.lon >= -180 && gps.lon <= 180)) return "GPS: šířka −90 až 90, délka −180 až 180";
  if (gps.label !== undefined && gps.label !== null && !(typeof gps.label === "string" && gps.label.length <= 120)) return "GPS: popisek do 120 znaků";
  return null;
}
const hasGps = (gps) => Boolean(gps) && typeof gps.lat === "number" && typeof gps.lon === "number";
// Místo lovu místenky: vybraný podrevír s jeho GPS (bez ní záložní GPS revíru), jinak celý revír a GPS revíru.
function fishingPlace(revir, number) {
  if (number !== undefined && number !== null && number !== "") {
    const item = (revir.subdistrictList || []).find((s) => String(s.number) === String(number));
    return { subdistrict: true, title: `Podrevír ${subdistrictName(revir, number)}`, gps: hasGps(item?.gps) ? item.gps : hasGps(revir.gps) ? revir.gps : null };
  }
  return { subdistrict: false, title: `Celý revír ${revir.name}`, gps: hasGps(revir.gps) ? revir.gps : null };
}
const gpsText = (gps) => gps.label || `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
const mapyUrl = (gps, zoom = 16) => `https://mapy.cz/zakladni?source=coor&id=${gps.lon}%2C${gps.lat}&x=${gps.lon}&y=${gps.lat}&z=${zoom}`;

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
      return { ...rest, fishRules, map: mapSummary(config.maps?.[revir.id]) };
    }),
    // Podklad interaktivní mapy: Mapy.com s API klíčem (MISTENKA_MAPY_API_KEY), jinak OpenStreetMap.
    // Klíč se používá v prohlížeči (dlaždice); omezte ho na doménu v účtu developer.mapy.com.
    mapTiles: process.env.MISTENKA_MAPY_API_KEY ? { provider: "mapy", apiKey: process.env.MISTENKA_MAPY_API_KEY } : { provider: "osm" },
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

module.exports = { loadConfig, readSource, buildConfig, getRevir, revirRules, ticketSubdistrictLabel, saleSubdistricts, subdistrictName, fishingPlace, gpsText, mapyUrl, publicConfig, czIban, validateMap, mapSummary, MAP_KINDS };
