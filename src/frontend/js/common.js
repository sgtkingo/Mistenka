// Sdílené funkce všech stránek Místenky.
(function () {
  const API_BASE = (window.MISTENKA_ENV && window.MISTENKA_ENV.apiBase) || "/api";
  const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
  const WEEKDAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
  const WEEKDAYS_SHORT = ["ne", "po", "út", "st", "čt", "pá", "so"];

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  // Escapování všeho, co se vkládá do HTML (jména, kódy, texty z konfigurace).
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  // Volání API. Prefix může obsahovat "?" (WordPress: /?rest_route=/mistenka/v1), proto se query skládá ručně.
  async function api(path, { method = "GET", body, token, memberId, query } = {}) {
    let url = API_BASE + path;
    if (query) {
      const params = new URLSearchParams(query).toString();
      if (params) url += (url.includes("?") ? "&" : "?") + params;
    }
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["X-Mistenka-Token"] = token;
    if (memberId) headers["X-Mistenka-Member-Id"] = memberId;
    let response;
    try {
      response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError("Server je nedostupný. Zkontrolujte připojení a zkuste to znovu.", 0, "network");
    }
    let data = null;
    try { data = await response.json(); } catch { /* prázdná nebo neplatná odpověď */ }
    if (!response.ok) throw new ApiError(data?.error || "Požadavek se nepodařilo dokončit.", response.status, data?.code || "error");
    return data;
  }

  let configPromise = null;
  function loadConfig() {
    configPromise ||= api("/config");
    return configPromise;
  }

  // Výběr revíru: ?revir=<id>, jinak jediný revír v konfiguraci.
  function selectedRevir(config) {
    const id = new URLSearchParams(location.search).get("revir");
    if (id) return config.reviry.find((revir) => revir.id === id) || null;
    return config.reviry.length === 1 ? config.reviry[0] : null;
  }
  function revirUrl(page, revir, config) {
    return config.reviry.length > 1 && revir ? `${page}?revir=${encodeURIComponent(revir.id)}` : page;
  }

  // ---------- formátování ----------
  const parseIso = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
  function czDate(iso, { weekday = false, year = true } = {}) {
    const date = parseIso(iso);
    const text = `${date.getUTCDate()}. ${MONTHS[date.getUTCMonth()]}${year ? ` ${date.getUTCFullYear()}` : ""}`;
    return weekday ? `${WEEKDAYS[date.getUTCDay()]} ${text}` : text;
  }
  function dayInfo(iso, todayIso) {
    const date = parseIso(iso);
    const diff = Math.round((date - parseIso(todayIso)) / 86400000);
    const name = WEEKDAYS[date.getUTCDay()];
    return {
      label: diff === 0 ? "Dnes" : diff === 1 ? "Zítra" : name.charAt(0).toUpperCase() + name.slice(1),
      short: `${WEEKDAYS_SHORT[date.getUTCDay()]} ${date.getUTCDate()}. ${date.getUTCMonth() + 1}.`
    };
  }
  const czk = (halere) => `${(halere / 100).toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} Kč`;
  const czDateTime = (iso) => new Date(iso).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  function fishingHours(revir, iso) {
    const month = Number(iso.slice(5, 7));
    const rule = (revir.fishingHours || []).find((item) => item.months.includes(month));
    return rule ? `${rule.from}–${rule.to}` : "";
  }
  // Číslo členské legitimace: 8 číslic pod čárovým kódem, mezery se ignorují.
  const normalizeMemberId = (value) => String(value || "").replace(/\s+/g, "");
  const isMemberId = (value) => /^\d{8}$/.test(normalizeMemberId(value));
  // ---------- pravidla druhů ryb (stejná logika jako server, viz docs/API.md) ----------
  function findSpecies(rules, name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key || !rules) return null;
    return rules.species.find((s) => s.name.toLowerCase() === key || (s.aliases || []).some((alias) => alias.toLowerCase() === key)) || null;
  }
  const czMonthDay = (md) => `${Number(md.slice(3))}. ${Number(md.slice(0, 2))}.`;
  const seasonText = (season) => (season.from === "01-01" && season.to === "12-31" ? "celoročně" : `${czMonthDay(season.from)}–${czMonthDay(season.to)}`);
  function inClosedSeason(species, isoDate) {
    const md = isoDate.slice(5);
    return (species.closedSeasons || []).find(({ from, to }) => (from <= to ? md >= from && md <= to : md >= from || md <= to)) || null;
  }
  function catchProblem(species, length, fishingDate) {
    const season = inClosedSeason(species, fishingDate);
    if (season) return season.from === "01-01" && season.to === "12-31" ? "Celoročně hájen – vraťte zpět" : `V době hájení (${seasonText(season)}) – vraťte zpět`;
    if (species.minLength && length && length < species.minLength) return `Podměrečná ryba (minimum ${species.minLength} cm)`;
    if (species.releaseFromLength && length >= species.releaseFromLength) return `Od ${species.releaseFromLength} cm se musí vrátit`;
    return "";
  }
  // Podrevíry, na které se místenka vztahuje (nastavení revíru ticketSubdistricts), např. "1 – Petr 1, 2 – Petr 2".
  function subdistrictLabel(revir) {
    const numbers = Array.isArray(revir?.ticketSubdistricts) ? revir.ticketSubdistricts : [];
    return numbers.map((number) => {
      const item = (revir.subdistrictList || []).find((s) => String(s.number) === String(number));
      return item?.name ? `${number} – ${item.name}` : String(number);
    }).join(", ");
  }
  const subdistrictTitle = (revir) => ((revir?.ticketSubdistricts || []).length > 1 ? "Podrevíry" : "Podrevír");
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

  // ---------- přístup držitele ----------
  // Token z odkazu (#t=...) má přednost; uloží se, aby fungoval i po obnovení stránky.
  const TOKENS_KEY = "mistenkaTokens";
  function readTokens() { try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || "{}"); } catch { return {}; } }
  function saveToken(code, token) {
    try { const tokens = readTokens(); tokens[code] = token; localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens)); } catch { /* bez úložiště */ }
  }
  function credentialsFor(code) {
    const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
    if (hashToken) {
      saveToken(code, hashToken);
      history.replaceState(null, "", location.pathname + location.search);
      return { token: hashToken };
    }
    const token = readTokens()[code];
    let memberId = "";
    try { memberId = sessionStorage.getItem(`mistenkaMemberId:${code}`) || ""; } catch { /* bez úložiště */ }
    return { token: token || "", memberId };
  }
  function rememberMemberId(code, memberId) {
    try { sessionStorage.setItem(`mistenkaMemberId:${code}`, memberId); } catch { /* bez úložiště */ }
  }

  // ---------- QR kódy (knihovna vendor/qrcode.js) ----------
  function qrMatrix(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const size = qr.getModuleCount();
    return { size, isDark: (row, col) => qr.isDark(row, col) };
  }
  function qrSvg(text, label) {
    const { size, isDark } = qrMatrix(text);
    const margin = 2;
    let path = "";
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (isDark(row, col)) path += `M${col + margin},${row + margin}h1v1h-1z`;
    const total = size + margin * 2;
    return `<svg class="qr-svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="${esc(label || "QR kód")}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }
  const ticketCheckUrl = (code) => new URL(`status.html?code=${encodeURIComponent(code)}`, location.href).href;

  function showToast(message) {
    const toast = qs("#toast");
    if (!toast) return window.alert(message);
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  // Hlavička, patička a kontakt podle konfigurace MO.
  function applyBranding(config) {
    const org = config.organization;
    qsa("[data-org-short]").forEach((el) => { el.textContent = org.shortName; });
    qsa("[data-org-web]").forEach((el) => { if (org.web) { el.href = org.web; el.hidden = false; } else el.hidden = true; });
    qsa("[data-privacy]").forEach((el) => { if (org.privacyUrl) el.href = org.privacyUrl; else el.hidden = true; });
  }

  window.Mistenka = { qs, qsa, esc, api, ApiError, loadConfig, selectedRevir, revirUrl, czDate, dayInfo, czk, czDateTime, fishingHours, subdistrictLabel, subdistrictTitle, plural, findSpecies, catchProblem, seasonText, normalizeMemberId, isMemberId, credentialsFor, saveToken, rememberMemberId, qrMatrix, qrSvg, ticketCheckUrl, showToast, applyBranding };
})();
