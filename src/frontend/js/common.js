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

  // ---------- přihlášený uživatel ----------
  // Relace je v HttpOnly cookie; měnící požadavky nesou CSRF token z GET /auth/me.
  let sessionPromise = null;
  let csrfToken = null;
  function loadSession(force = false) {
    if (force || !sessionPromise) {
      sessionPromise = rawApi("/auth/me").then((data) => { csrfToken = data.csrf; return data.user; }).catch(() => { csrfToken = null; return null; });
    }
    return sessionPromise;
  }
  // Po přihlášení / odhlášení: odpověď { user, csrf }.
  function setSession(data) {
    csrfToken = data?.csrf || null;
    sessionPromise = Promise.resolve(data?.user || null);
    renderUserMenu(data?.user || null);
  }
  // Změna údajů uživatele ve stejné relaci (CSRF token zůstává).
  function setSessionUser(user) {
    sessionPromise = Promise.resolve(user);
    renderUserMenu(user);
  }
  const hasRole = (user, role) => Boolean(user?.roles?.includes(role));
  const isStaff = (user) => hasRole(user, "manager") || hasRole(user, "admin");

  // Volání API. Prefix může obsahovat "?" (WordPress: /?rest_route=/mistenka/v1), proto se query skládá ručně.
  async function api(path, options = {}) {
    const method = options.method || "GET";
    if (method === "GET") return rawApi(path, options);
    await loadSession();
    try {
      return await rawApi(path, options);
    } catch (error) {
      if (error.code !== "csrf_failed") throw error;
      await loadSession(true); // relace se mezitím změnila (jiná záložka) – jeden nový pokus
      return rawApi(path, options);
    }
  }
  async function rawApi(path, { method = "GET", body, token, memberId, query } = {}) {
    const started = Date.now();
    const logApi = (result) => logEvent("api", `${method} ${maskPath(path)} → ${result} (${Date.now() - started} ms)`);
    let url = API_BASE + path;
    if (query) {
      const params = new URLSearchParams(query).toString();
      if (params) url += (url.includes("?") ? "&" : "?") + params;
    }
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["X-Mistenka-Token"] = token;
    if (memberId) headers["X-Mistenka-Member-Id"] = memberId;
    if (method !== "GET" && csrfToken) headers["X-Mistenka-Csrf"] = csrfToken;
    let response;
    try {
      response = await fetch(url, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      logApi("síť nedostupná");
      throw new ApiError("Server je nedostupný. Zkontrolujte připojení a zkuste to znovu.", 0, "network");
    }
    let data = null;
    try { data = await response.json(); } catch { /* prázdná nebo neplatná odpověď */ }
    logApi(response.ok ? response.status : `${response.status} ${data?.code || "error"}`);
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
  // Datum narození v českém tvaru (d.m.rrrr) – nativní <input type=date> se řídí jazykem prohlížeče, ne stránky.
  function parseCzDate(value) {
    const m = String(value || "").trim().match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/);
    if (!m) return "";
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const d = new Date(`${iso}T12:00:00Z`);
    return d.getUTCDate() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) ? iso : "";
  }
  const formatCzDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? `${Number(iso.slice(8))}. ${Number(iso.slice(5, 7))}. ${iso.slice(0, 4)}` : "");
  // Kalendářní výběr pro všechna textová data (.date-input): text zůstává v českém tvaru, tlačítko otevře nativní kalendář.
  function attachDatePicker(input) {
    if (input.dataset.picker || input.autocomplete === "bday" || input.dataset.noPicker !== undefined || input.type !== "text" && input.type !== "") return;
    input.dataset.picker = "1";
    const wrap = document.createElement("span");
    wrap.className = "date-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const native = document.createElement("input");
    native.type = "date";
    native.tabIndex = -1;
    native.className = "date-native";
    native.setAttribute("aria-hidden", "true");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "date-pick";
    button.title = "Vybrat v kalendáři";
    button.setAttribute("aria-label", "Vybrat datum v kalendáři");
    button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
    wrap.append(native, button);
    button.addEventListener("click", () => {
      if (input.disabled || input.readOnly) return;
      native.value = parseCzDate(input.value) || "";
      try { native.showPicker(); } catch { native.focus(); native.click(); }
    });
    native.addEventListener("change", () => {
      if (!native.value) return;
      input.value = formatCzDate(native.value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  function enhanceDateInputs(root = document) { root.querySelectorAll?.("input.date-input").forEach(attachDatePicker); }
  if (typeof document !== "undefined") {
    const start = () => {
      enhanceDateInputs();
      new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches("input.date-input")) attachDatePicker(n); else enhanceDateInputs(n); } }))).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
  // Heslo: alespoň 8 znaků a shoda s potvrzením. Vrátí chybovou zprávu, nebo "".
  const PASSWORD_MIN = 8;
  function passwordProblem(password, confirmation) {
    if (password.length < PASSWORD_MIN) return `Heslo musí mít alespoň ${PASSWORD_MIN} znaků.`;
    if (password !== confirmation) return "Hesla se neshodují.";
    return "";
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
  // Hlídání nereálných měr a vah (rules.plausibility, stejná logika jako server): odlehlé pozorování = délka nad
  // obvyklým maximem druhu, nebo zapsaná hmotnost víc než weightTolerance× (a o víc než 0,5 kg) mimo odhad z délky.
  const czNum = (n) => String(n).replace(".", ",");
  function catchOutlier(rules, species, length, weight, weightEstimated) {
    const p = rules?.plausibility;
    if (!species || !p?.enabled || !(length > 0)) return "";
    if (species.maxLength && length > species.maxLength) return `Neobvyklá délka – obvyklé maximum druhu je ${czNum(species.maxLength)} cm`;
    if (weight > 0 && !weightEstimated && species.weightFactor) {
      const expected = species.weightFactor * length ** 3 / 100000;
      const ratio = weight / expected;
      if ((ratio > p.weightTolerance || ratio < 1 / p.weightTolerance) && Math.abs(weight - expected) > 0.5) return `Hmotnost neodpovídá délce – obvykle kolem ${czNum(Math.round(expected * 10) / 10)} kg`;
    }
    return "";
  }
  // Obecná horní hranice délky a hmotnosti jedné ryby (při vypnutém hlídání jen technická hranice 1000).
  const catchLimits = (rules) => (rules?.plausibility?.enabled ? { maxLength: rules.plausibility.maxLength, maxWeight: rules.plausibility.maxWeight } : { maxLength: 1000, maxWeight: 1000 });
  // Podrevír místenky (vybraný při nákupu), u starších místenek podrevíry revíru (ticketSubdistricts), např. "1 – Petr 1".
  function subdistrictLabel(revir, ticket = null) {
    if (ticket?.subdistrict) return ticket.subdistrict.label;
    const numbers = Array.isArray(revir?.ticketSubdistricts) ? revir.ticketSubdistricts : [];
    return numbers.map((number) => {
      const item = (revir.subdistrictList || []).find((s) => String(s.number) === String(number));
      return item?.name ? `${number} – ${item.name}` : String(number);
    }).join(", ");
  }
  // ---------- GPS a místo lovu ----------
  // Revír bez podrevírů má společnou GPS; s podrevíry má GPS každý podrevír (společná je jen záložní).
  const hasGps = (gps) => Boolean(gps) && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lon));
  const gpsText = (gps) => gps.label || `${Number(gps.lat).toFixed(5)}, ${Number(gps.lon).toFixed(5)}`;
  const mapyUrl = (lat, lon, zoom = 16) => `https://mapy.cz/zakladni?source=coor&id=${encodeURIComponent(lon)}%2C${encodeURIComponent(lat)}&x=${encodeURIComponent(lon)}&y=${encodeURIComponent(lat)}&z=${zoom}`;
  const gpsLink = (gps, zoom = 16) => `<a href="${esc(mapyUrl(gps.lat, gps.lon, zoom))}" target="_blank" rel="noreferrer">${esc(gpsText(gps))} ↗</a>`;
  // Místo lovu místenky: vybraný podrevír s jeho GPS (bez ní záložní GPS revíru), jinak celý revír a GPS revíru.
  function fishingPlace(revir, number) {
    if (number !== undefined && number !== null && number !== "") {
      const item = (revir?.subdistrictList || []).find((s) => String(s.number) === String(number));
      const label = item?.name ? `${number} – ${item.name}` : String(number);
      return { subdistrict: true, label, title: `Podrevír ${label}`, gps: hasGps(item?.gps) ? item.gps : hasGps(revir?.gps) ? revir.gps : null };
    }
    return { subdistrict: false, label: revir?.name || "", title: `Celý revír ${revir?.name || ""}`, gps: hasGps(revir?.gps) ? revir.gps : null };
  }
  // GPS k zobrazení u revíru: s podrevíry GPS jednotlivých podrevírů, jinak (nebo když je žádný nemá) společná GPS.
  function gpsPlaces(revir) {
    const sale = (revir?.ticketSubdistricts || []).map(String);
    const subs = (revir?.subdistrictList || []).filter((s) => hasGps(s.gps));
    if (subs.length) return subs.map((s) => ({ label: s.name ? `${s.number} – ${s.name}` : String(s.number), gps: s.gps, closed: sale.length > 0 && !sale.includes(String(s.number)) }));
    return hasGps(revir?.gps) ? [{ label: "", gps: revir.gps, closed: false }] : [];
  }
  // Ikona prutu s plovákem: zelená = na podrevír lze koupit místenku, červená přeškrtnutá = místenka není.
  const rodIcon = (closed, size = 22) => `<svg class="sub-rod${closed ? " closed" : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${closed ? "Na tomto podrevíru místenka není" : "Na tento podrevír lze zakoupit místenku"}"><title>${closed ? "Na tomto podrevíru místenka není!" : "Na tento podrevír lze zakoupit místenku"}</title><path d="M3 21 16 3"/><path d="M16 3c2 3 3 6 3 9"/><ellipse cx="19" cy="15" rx="2" ry="3"/><path d="M11 21c1.3-1 2.7-1 4 0s2.7 1 4 0"/>${closed ? '<path d="M3 3l18 18" stroke-width="2.4"/>' : ""}</svg>`;
  const gpsListHtml = (revir) => gpsPlaces(revir).map((p) => `<span class="gps-line">${p.label ? `<b>${esc(p.label)}</b> ` : ""}${gpsLink(p.gps)}${p.label ? ` ${rodIcon(p.closed, 16)}` : ""}</span>`).join("");
  const subdistrictTitle = (revir, ticket = null) => (!ticket?.subdistrict && (revir?.ticketSubdistricts || []).length > 1 ? "Podrevíry" : "Podrevír");
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
  // ---------- čtečka QR kódu místenky (kamera) ----------
  // Dekódování: vestavěné BarcodeDetector (Chrome/Edge na Androidu, macOS), jinde knihovna jsQR (vendor/jsqr.js,
  // načte se až při prvním skenování) – funguje tak i v Safari na iPhonu a ve Firefoxu. Kamera vyžaduje HTTPS.
  const qrScanSupported = () => Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
  let jsQrPromise = null;
  function loadJsQr() {
    jsQrPromise ||= new Promise((resolve, reject) => {
      if (window.jsQR) return resolve(window.jsQR);
      const script = document.createElement("script");
      // Stejný adresář jako common.js (funguje i ve WordPress pluginu).
      script.src = new URL("../vendor/jsqr.js", document.currentScript?.src || qs('script[src*="common.js"]')?.src || location.href).href;
      script.onload = () => resolve(window.jsQR);
      script.onerror = () => { jsQrPromise = null; reject(new Error("Čtečku QR se nepodařilo načíst.")); };
      document.head.append(script);
    });
    return jsQrPromise;
  }
  // Vrátí funkci, která ze snímku videa přečte QR kódy jako [{ text, format }] (tvar, který čeká scanWithCamera).
  async function qrDecoder(video) {
    if ("BarcodeDetector" in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats?.();
        if (!formats || formats.includes("qr_code")) {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          return async () => (await detector.detect(video)).map((r) => ({ text: r.rawValue, format: "qr_code" }));
        }
      } catch { /* přejde na jsQR */ }
    }
    const jsQR = await loadJsQr();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return async () => {
      if (!video.videoWidth) return [];
      const scale = Math.min(1, 640 / video.videoWidth); // menší snímek = rychlejší dekódování na mobilu
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
      return result ? [{ text: result.data, format: "qr_code" }] : [];
    };
  }
  // Z textu QR vytáhne kód místenky: odkaz …status.html?code=KÓD, nebo samotný kód.
  function codeFromQr(text) {
    const value = String(text || "").trim();
    try {
      const fromUrl = new URL(value).searchParams.get("code");
      if (fromUrl && /^[A-Z0-9]{6}$/i.test(fromUrl)) return fromUrl.toUpperCase();
    } catch { /* není odkaz */ }
    return /^[A-Z0-9]{6}$/i.test(value) ? value.toUpperCase() : "";
  }
  // Nápověda ⓘ po najetí / fokusu (doplňující vysvětlení k poli, sloupci nebo nadpisu).
  const infoTip = (text) => `<span class="info-tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>`;
  // Vložení do pole kódu místenky / jednorázového kódu: z PDF se kód kopíruje s mezerami („C C R 3 D 8“),
  // které by se započítaly do maxlength a kód uřízly. Vezmou se jen písmena a číslice (u odkazu kód z ?code=).
  document.addEventListener("paste", (event) => {
    const input = event.target.closest?.(".code-input, .otp-input");
    if (!input) return;
    const text = event.clipboardData?.getData("text") || "";
    const cleaned = input.classList.contains("otp-input") ? text.replace(/\D/g, "").slice(0, 6) : (codeFromQr(text) || text.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase());
    if (!cleaned) return;
    event.preventDefault();
    input.value = cleaned;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const CAMERA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/></svg>';
  // Společný dialog s kamerou: decoderFactory(video) vrací funkci → [{ text, format }], parse(text) → hodnota nebo "".
  // onMiss(text, format) může vrátit nápovědu, když se načte kód, který nevyhovuje.
  function scanWithCamera({ title, hint, wide = false, decoderFactory, parse, onMiss = () => "" }) {
    const overlay = document.createElement("div");
    overlay.className = "qr-scan-overlay";
    overlay.innerHTML = `<div class="qr-scan-box" role="dialog" aria-label="${esc(title)}"><div class="qr-scan-video${wide ? " barcode" : ""}"><video playsinline muted></video><span class="qr-scan-frame"></span></div>
      <p class="qr-scan-hint">${esc(hint)}</p><button type="button" class="secondary-button">Zrušit</button></div>`;
    document.body.append(overlay);
    const video = overlay.querySelector("video");
    const hintEl = overlay.querySelector(".qr-scan-hint");
    let stream = null;
    let stopped = false;
    const stop = () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); overlay.remove(); };
    return new Promise((resolve) => {
      const finish = (result) => { stop(); resolve(result); };
      overlay.querySelector("button").addEventListener("click", () => finish(null));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
      (async () => {
        try {
          // Vyšší rozlišení pomáhá u tenkých čar čárového kódu.
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: wide ? 1920 : 1280 } }, audio: false });
          if (stopped) return stream.getTracks().forEach((t) => t.stop());
          video.srcObject = stream;
          await video.play();
          const decode = await decoderFactory(video);
          const tick = async () => {
            if (stopped) return;
            try {
              for (const { text, format } of await decode()) {
                const value = parse(text);
                if (value) return finish({ value, format });
                const miss = onMiss(text, format);
                if (miss) hintEl.textContent = miss;
              }
            } catch { /* snímek ještě není připravený */ }
            setTimeout(tick, 200);
          };
          tick();
        } catch (error) {
          finish(null);
          showToast(error.name === "NotAllowedError" ? "Přístup ke kameře byl zamítnut. Povolte ho v prohlížeči, nebo údaj opište." : error.message?.startsWith("Čtečku") ? error.message : "Kameru se nepodařilo spustit. Údaj opište ručně.", "error");
        }
      })();
    });
  }
  async function scanQr() {
    const result = await scanWithCamera({ title: "Načíst QR kód místenky", hint: "Namiřte kameru na QR kód místenky.", decoderFactory: qrDecoder, parse: codeFromQr });
    return result?.value || "";
  }

  // ---------- čárový kód členské legitimace (8 číslic pod čárovým kódem) ----------
  // Legitimace ČRS má čárový kód Code 128 s 8 číslicemi (ověřeno skenem skutečné legitimace 11/2026).
  // Dekódování: BarcodeDetector, jinak knihovna ZXing (vendor/zxing.min.js, načte se až při prvním skenování –
  // Safari na iPhonu, Firefox).
  const BARCODE_FORMATS = ["code_128"];
  const FORMAT_LABELS = { code_128: "Code 128", code_39: "Code 39", code_93: "Code 93", ean_8: "EAN-8", ean_13: "EAN-13", itf: "ITF (2 z 5 prokládaný)", codabar: "Codabar", upc_a: "UPC-A", upc_e: "UPC-E", qr_code: "QR" };
  const formatLabel = (format) => FORMAT_LABELS[String(format || "").toLowerCase()] || String(format || "neznámý formát");
  let zxingPromise = null;
  function loadZxing() {
    zxingPromise ||= new Promise((resolve, reject) => {
      if (window.ZXing) return resolve(window.ZXing);
      const script = document.createElement("script");
      script.src = new URL("../vendor/zxing.min.js", document.currentScript?.src || qs('script[src*="common.js"]')?.src || location.href).href;
      script.onload = () => resolve(window.ZXing);
      script.onerror = () => { zxingPromise = null; reject(new Error("Čtečku čárových kódů se nepodařilo načíst.")); };
      document.head.append(script);
    });
    return zxingPromise;
  }
  async function barcodeDecoder(video) {
    if ("BarcodeDetector" in window) {
      try {
        const supported = (await window.BarcodeDetector.getSupportedFormats?.()) || BARCODE_FORMATS; // bez Code 128 → ZXing
        const formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
        if (formats.length) {
          const detector = new window.BarcodeDetector({ formats });
          return async () => (await detector.detect(video)).map((r) => ({ text: r.rawValue, format: r.format }));
        }
      } catch { /* přejde na ZXing */ }
    }
    const ZXing = await loadZxing();
    const F = ZXing.BarcodeFormat;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return async () => {
      if (!video.videoWidth) return [];
      // Jen prostřední pás snímku (rámeček v dialogu) – rychlejší a přesnější.
      const sw = video.videoWidth;
      const sh = Math.round(video.videoHeight * 0.4);
      const sy = Math.round((video.videoHeight - sh) / 2);
      const scale = Math.min(1, 1280 / sw);
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      ctx.drawImage(video, 0, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      try {
        const result = reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas))));
        return [{ text: result.getText(), format: String(F[result.getBarcodeFormat()] || "").toLowerCase() }];
      } catch { return []; }
    };
  }
  const memberIdFromBarcode = (text) => { const digits = String(text || "").replace(/\D/g, ""); return /^\d{8}$/.test(digits) && String(text).replace(/[\s-]/g, "").length === 8 ? digits : ""; };
  async function scanMemberId() {
    return scanWithCamera({
      title: "Načíst číslo členské legitimace", hint: "Namiřte kameru na čárový kód na titulní straně legitimace, kód držte vodorovně v rámečku.", wide: true,
      decoderFactory: barcodeDecoder, parse: memberIdFromBarcode,
      onMiss: (text, format) => `Načten kód ${formatLabel(format)} „${String(text).slice(0, 20)}“ – to není 8místné číslo legitimace. Zkuste to znovu.`
    });
  }
  // Ikona kamery u pole s číslem legitimace; po načtení vyplní číslo a ukáže formát kódu.
  function attachMemberIdScanner(input) {
    if (!input || input.dataset.scanner || !qrScanSupported()) return;
    input.dataset.scanner = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "qr-scan-button";
    button.title = "Načíst čárový kód legitimace kamerou";
    button.setAttribute("aria-label", "Načíst číslo členské legitimace kamerou");
    button.innerHTML = CAMERA_ICON;
    const wrap = document.createElement("span");
    wrap.className = "qr-input-wrap member-scan-wrap";
    input.before(wrap);
    wrap.append(input, button);
    button.addEventListener("click", async () => {
      const result = await scanMemberId();
      if (!result) return;
      input.value = result.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("blur"));
      showToast(`Číslo legitimace ${result.value} načteno (${formatLabel(result.format)}).`, "success");
    });
  }
  // Všechna pole s číslem legitimace (memberId, regMemberId, pMemberId, …) dostanou čtečku automaticky.
  const attachMemberIdScanners = () => qsa("input").filter((el) => /^(memberId|[a-zA-Z]+MemberId)$/.test(el.id)).forEach(attachMemberIdScanner);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachMemberIdScanners); else attachMemberIdScanners();
  // Přidá ikonu kamery k poli s kódem místenky; po načtení vyplní kód a zavolá onCode(code).
  function attachQrScanner(input, onCode) {
    if (!input || !qrScanSupported()) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "qr-scan-button";
    button.title = "Načíst QR kód kamerou";
    button.setAttribute("aria-label", "Načíst QR kód místenky kamerou");
    button.innerHTML = CAMERA_ICON;
    const wrap = document.createElement("span");
    wrap.className = "qr-input-wrap";
    input.before(wrap);
    wrap.append(input, button);
    button.addEventListener("click", async () => {
      const code = await scanQr();
      if (!code) return;
      input.value = code;
      input.dispatchEvent(new Event("input"));
      onCode(code);
    });
  }

  const ticketCheckUrl = (code) => new URL(`status.html?code=${encodeURIComponent(code)}`, location.href).href;

  // Barva podle typu: info (modrá), success (zelená), warning (oranžová – chybějící/špatný údaj),
  // error (červená – akce selhala). Varování a chyby zůstanou déle, ať se dají dočíst.
  const TOAST_TONES = ["info", "success", "warning", "error"];
  function showToast(message, tone = "info") {
    if (!TOAST_TONES.includes(tone)) tone = "info";
    logEvent("toast", tone === "info" ? message : `${tone}: ${message}`);
    const toast = qs("#toast");
    if (!toast) return window.alert(message);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" || tone === "warning" ? "alert" : "status");
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), tone === "info" || tone === "success" ? 3200 : 5500);
  }

  // Stav místenky pro seznamy (klientská zóna, správa). Podrobné texty má status.js.
  const TICKET_STATES = {
    pending_payment: ["Čeká na platbu", "warn"], payment_expired: ["Nezaplacená", "off"], cancelled: ["Zrušená", "off"],
    future: ["Budoucí", "info"], active: ["Aktivní", "ok"], expired_unreturned: ["K odevzdání", "warn"],
    closed_unreturned: ["Neodevzdaná", "bad"], expired_returned: ["Odevzdaná", "ok"], seized: ["Zadržená", "bad"]
  };
  function ticketState(ticket) {
    const [label, tone] = TICKET_STATES[ticket.status] || [ticket.status, "off"];
    // Barvy: zelená = v pořádku, oranžová = varování, červená = vážné, modrá / šedá = informace.
    if (ticket.status === "expired_returned" && ticket.late) return { label: "Odevzdaná opožděně", tone: "mild" };
    return { label, tone };
  }
  // Limity úlovků (B3): přehled pro rybáře, porybného i správce.
  // mode "notable" = jen dosažené nebo překročené limity (upozornění), "all" = všechny s počtem.
  const PERIOD_NAMES = { day: "Den", week: "Týden", month: "Měsíc" };
  function limitPeriod(limit) {
    if (limit.period === "day") return "Tento den";
    const short = (iso) => `${Number(iso.slice(8))}. ${Number(iso.slice(5, 7))}.`;
    return `${PERIOD_NAMES[limit.period]} ${short(limit.from)}–${short(limit.to)}`;
  }
  function limitsHtml(limits, { mode = "notable", title = "Limity úlovků" } = {}) {
    const list = (limits || []).filter((l) => mode === "all" || l.count >= l.maxCount);
    if (!list.length) return "";
    const exceeded = list.some((l) => l.exceeded);
    return `<div class="limits-box${exceeded ? " limits-exceeded" : ""}"><strong>${esc(title)}</strong><ul>${list.map((l) => `<li class="${l.exceeded ? "over" : l.count >= l.maxCount ? "full" : ""}"><span>${esc(limitPeriod(l))}: ${esc(l.label)}</span><b>${esc(l.count)} / ${esc(l.maxCount)} ks${l.exceeded ? " · překročeno" : l.count >= l.maxCount ? " · vyčerpáno" : ""}</b></li>`).join("")}</ul><small>Podle místenek v Místence. Limity platí na všech revírech svazu dohromady – úlovky z jiných revírů zde nevidíme.</small></div>`;
  }
  // Našeptávač druhů ryb (vlastní, nativní <datalist> se v prohlížečích vykresluje nespolehlivě).
  // input musí být v obalu s position:relative (.fish-field); getSpecies() vrací seznam druhů z pravidel revíru.
  // Jediná implementace pro celou aplikaci (odevzdání, zarybnění, oprava úlovků): filtruje podle názvu i aliasů,
  // ovládání šipkami, Enter vybere, Esc zavře. hint(species) = volitelný doplněk u položky (např. „min. 40 cm“).
  function attachSpeciesSuggest(input, getSpecies, onChoose = () => {}, { hint = () => "" } = {}) {
    const box = document.createElement("div");
    box.className = "fish-suggestions";
    box.setAttribute("role", "listbox");
    input.after(box);
    input.setAttribute("autocomplete", "off");
    let active = -1;
    const hide = () => { box.classList.remove("visible"); active = -1; };
    const choose = (name) => { input.value = name; hide(); onChoose(name); };
    const render = () => {
      const query = input.value.trim().toLowerCase();
      const matches = (getSpecies() || []).filter((s) => !query || s.name.toLowerCase().includes(query) || (s.aliases || []).some((a) => a.toLowerCase().includes(query)));
      box.innerHTML = matches.map((s) => { const extra = hint(s); return `<button type="button" role="option" data-name="${esc(s.name)}">${esc(s.name)}${extra ? ` <small>${esc(extra)}</small>` : ""}</button>`; }).join("");
      box.classList.toggle("visible", matches.length > 0);
      active = -1;
      qsa("button", box).forEach((button) => button.addEventListener("mousedown", (event) => { event.preventDefault(); choose(button.dataset.name); }));
    };
    input.addEventListener("focus", render);
    input.addEventListener("input", render);
    input.addEventListener("blur", () => window.setTimeout(hide, 120));
    input.addEventListener("keydown", (event) => {
      const buttons = qsa("button", box);
      if (!box.classList.contains("visible") || !buttons.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = event.key === "ArrowDown" ? (active + 1) % buttons.length : (active - 1 + buttons.length) % buttons.length;
        buttons.forEach((button, index) => button.classList.toggle("active", index === active));
        buttons[active].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        choose(buttons[active].dataset.name);
      } else if (event.key === "Escape") hide();
    });
  }
  const ROLE_LABELS = { member: "Rybář", warden: "Porybný", manager: "Správce", admin: "Admin" };
  // Funkce člena mají v celém systému stejné barvy (styles.css: .role-badge.role-*): Admin oranžová,
  // Správce červená, Porybný modrá, Rybář zelená. Pořadí zobrazení: Admin, Správce, Porybný, Rybář.
  const ROLE_ORDER = ["admin", "manager", "warden", "member"];
  const roleBadge = (role) => `<span class="role-badge role-${esc(role)}">${esc(ROLE_LABELS[role] || role)}</span>`;
  const roleBadges = (roles = [], { member = true } = {}) => ROLE_ORDER.filter((role) => roles.includes(role) && (member || role !== "member")).map(roleBadge).join(" ");

  // Odkaz na účet v hlavičce ([data-account-link]) a do správy ([data-manage-link]).
  function renderUserMenu(user) {
    qsa("[data-account-link]").forEach((el) => {
      el.textContent = user ? `${user.firstName} ${user.lastName}` : "Přihlásit se";
      el.title = user ? "Můj účet" : "Přihlášení a registrace";
      el.href = "account.html";
      // Rychlé odhlášení vpravo vedle jména.
      let quick = el.nextElementSibling?.classList.contains("logout-quick") ? el.nextElementSibling : null;
      if (!quick) {
        quick = document.createElement("button");
        quick.type = "button";
        quick.className = "login-button logout-quick hidden";
        quick.title = "Odhlásit se";
        quick.innerHTML = `${icon("logout")}<span>Odhlásit</span>`;
        quick.addEventListener("click", async () => {
          quick.disabled = true;
          try { await api("/auth/logout", { method: "POST" }); } catch { /* odhlásit lokálně i při chybě */ }
          setSession(null);
          location.href = "./";
        });
        el.after(quick);
      }
      quick.classList.toggle("hidden", !user);
    });
    qsa("[data-manage-link]").forEach((el) => el.classList.toggle("hidden", !isStaff(user)));
  }
  async function initUserMenu() {
    const user = await loadSession();
    renderUserMenu(user);
    return user;
  }

  // Hlavička, patička a kontakt podle konfigurace MO.
  function applyBranding(config) {
    const org = config.organization;
    qsa("[data-org-short]").forEach((el) => { el.textContent = org.shortName; });
    qsa("[data-org-web]").forEach((el) => { if (org.web) { el.href = org.web; el.hidden = false; } else el.hidden = true; });
    qsa("[data-privacy]").forEach((el) => { el.href = org.privacyUrl || "privacy.html"; el.hidden = false; });
  }

  // Drobné ikony (Lucide-like, stroke = currentColor).
  const ICONS = {
    fast: '<path d="M13 19l7-7-7-7"/><path d="M4 19l7-7-7-7"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    water: '<path d="M2 12c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/><path d="M2 17c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/><path d="M2 7c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 3l1.5 3M15 3l-1.5 3M12 10v10M3 13h5M16 13h5M4 8l4 2M20 8l-4 2M4 19l4-2M20 19l-4-2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    ticket: '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
    fish: '<path d="M2 12c3-5 9-6.5 14-3l5-3v12l-5-3c-5 3.5-11 2-14-3z"/><path d="M7.5 11h.01"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12h.01"/>',
    chart: '<path d="M3 21h18M6 17v-5M11 17V7M16 17v-8M21 17v-3"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/>',
    weight: '<circle cx="12" cy="5" r="2.2"/><path d="M6.5 8h11l2.5 13H4z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    ruler: '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>'
  };
  const icon = (name, size = 16) => `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  // ---------- hlášení chyb ----------
  // Záznam posledních událostí (stránky, volání API, chyby, hlášky) v sessionStorage – přikládá se k hlášení.
  // Bez osobních údajů: jen cesta bez parametrů a kotvy, kódy místenek zamaskované, žádná těla požadavků.
  function maskPath(path) { return String(path).split(/[?#]/)[0].replace(/\/[A-Z0-9]{6}(?=\/|$)/g, "/******"); }
  function logEvent(type, message) {
    try {
      const list = JSON.parse(sessionStorage.getItem("mistenka.log") || "[]");
      list.push({ at: new Date().toISOString(), type, message: String(message ?? "").slice(0, 300), page: location.pathname });
      sessionStorage.setItem("mistenka.log", JSON.stringify(list.slice(-60)));
    } catch { /* bez úložiště se záznam nevede */ }
  }
  const readLog = () => { try { return JSON.parse(sessionStorage.getItem("mistenka.log") || "[]"); } catch { return []; } };
  logEvent("page", "stránka načtena");
  window.addEventListener("error", (e) => logEvent("error", `${e.message || "chyba skriptu"}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => logEvent("error", `nezachycená chyba: ${e.reason?.message || e.reason}`));

  // Snímek obrazovky: zmenšit a převést na JPEG, aby se vešel do limitu (~1,5 MB).
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        for (const [maxW, quality] of [[1600, 0.82], [1280, 0.7], [1000, 0.6]]) {
          const scale = Math.min(1, maxW / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/jpeg", quality);
          if (data.length < 1_900_000) return resolve(data);
        }
        reject(new Error("Snímek je příliš velký."));
      };
      img.onerror = () => reject(new Error("Soubor není obrázek."));
      img.src = URL.createObjectURL(file);
    });
  }
  async function openBugReport() {
    let dialog = qs("#bugDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "bugDialog";
      dialog.className = "bug-dialog";
      document.body.append(dialog);
    }
    const user = await loadSession().catch(() => null);
    const log = readLog();
    let screenshot = null;
    dialog.innerHTML = `<form method="dialog" class="bug-form" novalidate>
      <div class="bug-head"><span class="bug-title">${icon("bug", 20)} Nahlásit chybu</span><button class="bug-x bug-close" type="button" aria-label="Zavřít">×</button></div>
      <label class="field-label req" for="bugText">Co se stalo?</label>
      <textarea id="bugText" rows="5" maxlength="4000" placeholder="Popište, co jste dělali a co se pokazilo (např. po kliknutí na Zaplatit se nic nestalo)."></textarea>
      ${user ? `<p class="field-help">Hlášení odešle ${esc(`${user.firstName} ${user.lastName}`)} – odpovíme na e-mail účtu.</p>` : '<label class="field-label" for="bugEmail">E-mail pro odpověď <span class="optional">(nepovinný)</span></label><input id="bugEmail" type="email" maxlength="200" autocomplete="email">'}
      <label class="field-label" for="bugFile">Snímek obrazovky <span class="optional">(nepovinný)</span></label>
      <div class="bug-shot"><label class="secondary-button bug-file-button">${icon("doc")} Přiložit snímek…<input id="bugFile" type="file" accept="image/*" hidden></label><span class="field-help">nebo ho vložte ze schránky (Ctrl+V)</span></div>
      <div class="bug-preview hidden" id="bugPreview"><img alt="Náhled snímku obrazovky"><button class="text-button" type="button" id="bugRemoveShot">Odebrat snímek</button></div>
      <details class="bug-log"><summary>Přiloží se čas, stránka, prohlížeč a záznam posledních ${log.length} událostí</summary><pre>${esc(log.map((e) => `${e.at.slice(11, 19)} ${e.type} ${e.page} ${e.message}`).join("\n") || "žádné události")}</pre></details>
      <div class="bug-actions"><button class="secondary-button bug-close" type="button">Zrušit</button><button class="primary-button" type="submit" id="bugSend">Odeslat hlášení</button></div>
    </form>`;
    const setShot = (data) => {
      screenshot = data;
      qs("#bugPreview", dialog).classList.toggle("hidden", !data);
      if (data) qs("#bugPreview img", dialog).src = data;
    };
    const useFile = async (file) => { try { setShot(await shrinkImage(file)); } catch (error) { showToast(error.message, "error"); } };
    qs("#bugFile", dialog).addEventListener("change", (e) => { if (e.target.files[0]) useFile(e.target.files[0]); });
    dialog.onpaste = (e) => { const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/")); if (item) { e.preventDefault(); useFile(item.getAsFile()); } };
    qs("#bugRemoveShot", dialog).addEventListener("click", () => { setShot(null); qs("#bugFile", dialog).value = ""; });
    qsa(".bug-close", dialog).forEach((b) => b.addEventListener("click", () => dialog.close()));
    qs("form", dialog).addEventListener("submit", async (event) => {
      event.preventDefault();
      const description = qs("#bugText", dialog).value.trim();
      if (description.length < 10) { qs("#bugText", dialog).focus(); return showToast("Popište prosím, co se stalo (aspoň 10 znaků).", "warning"); }
      const button = qs("#bugSend", dialog);
      button.disabled = true;
      try {
        const { id } = await api("/bug-reports", { method: "POST", body: {
          description, contactEmail: qs("#bugEmail", dialog)?.value.trim() || "", url: location.pathname, userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`, clientTime: new Date().toISOString(), log: readLog(), screenshot
        } });
        dialog.close();
        showToast(`Děkujeme, chyba je nahlášená (č. ${id}).`, "success");
      } catch (error) { showToast(error.message, "error"); button.disabled = false; }
    });
    dialog.showModal();
    qs("#bugText", dialog).focus();
  }
  // Tlačítko s broukem v horním panelu, nalevo od přihlášení.
  function addBugButton() {
    const hosts = qsa(".user-menu").length ? qsa(".user-menu") : qsa(".site-header");
    hosts.forEach((host) => {
      if (qs(".bug-button", host)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "login-button bug-button";
      button.title = "Nahlásit chybu";
      button.innerHTML = `${icon("bug")}<span>Nahlásit chybu</span>`;
      button.addEventListener("click", openBugReport);
      host.prepend(button);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addBugButton); else addBugButton();

  window.Mistenka = { infoTip, icon, rodIcon, hasGps, gpsText, mapyUrl, gpsLink, fishingPlace, gpsPlaces, gpsListHtml, openBugReport, logEvent, qs, qsa, esc, api, ApiError, loadConfig, selectedRevir, revirUrl, czDate, dayInfo, czk, czDateTime, fishingHours, subdistrictLabel, subdistrictTitle, plural, findSpecies, catchProblem, catchOutlier, catchLimits, seasonText, normalizeMemberId, isMemberId, credentialsFor, saveToken, rememberMemberId, qrMatrix, qrSvg, ticketCheckUrl, showToast, applyBranding, loadSession, setSession, setSessionUser, hasRole, isStaff, renderUserMenu, initUserMenu, ticketState, ROLE_LABELS, parseCzDate, formatCzDate, passwordProblem, limitsHtml, attachSpeciesSuggest, attachQrScanner, attachMemberIdScanner, codeFromQr, memberIdFromBarcode, roleBadge, roleBadges };
})();

// Pole s číslem členské legitimace (max. 8 znaků): ponechá jen číslice, aby vložené „1234 5678“ nepřišlo o číslici.
document.addEventListener("input", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !/^(memberId|[a-zA-Z]+MemberId)$/.test(el.id)) return;
  const digits = el.value.replace(/\D/g, "").slice(0, 8);
  if (digits !== el.value) el.value = digits;
}, true);
// Vložení ze schránky: mezery a pomlčky se odstraní ještě před oříznutím na maxlength.
document.addEventListener("paste", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !/^(memberId|[a-zA-Z]+MemberId)$/.test(el.id)) return;
  event.preventDefault();
  const pasted = (event.clipboardData?.getData("text") || "").replace(/\D/g, "");
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = (el.value.slice(0, start) + pasted + el.value.slice(end)).replace(/\D/g, "").slice(0, 8);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, true);
