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
  // Vrátí funkci, která ze snímku videa přečte text QR kódu (nebo prázdný řetězec).
  async function qrDecoder(video) {
    if ("BarcodeDetector" in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats?.();
        if (!formats || formats.includes("qr_code")) {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          return async () => (await detector.detect(video)).map((r) => r.rawValue);
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
      return result ? [result.data] : [];
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
          showToast(error.name === "NotAllowedError" ? "Přístup ke kameře byl zamítnut. Povolte ho v prohlížeči, nebo údaj opište." : error.message?.startsWith("Čtečku") ? error.message : "Kameru se nepodařilo spustit. Údaj opište ručně.");
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
      showToast(`Číslo legitimace ${result.value} načteno (${formatLabel(result.format)}).`);
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

  function showToast(message) {
    const toast = qs("#toast");
    if (!toast) return window.alert(message);
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  // Stav místenky pro seznamy (klientská zóna, správa). Podrobné texty má status.js.
  const TICKET_STATES = {
    pending_payment: ["Čeká na platbu", "warn"], payment_expired: ["Nezaplacená", "off"], cancelled: ["Zrušená", "off"],
    future: ["Budoucí", "info"], active: ["Aktivní", "ok"], expired_unreturned: ["K odevzdání", "warn"],
    closed_unreturned: ["Neodevzdaná", "bad"], expired_returned: ["Odevzdaná", "ok"], seized: ["Zadržená", "bad"]
  };
  function ticketState(ticket) {
    const [label, tone] = TICKET_STATES[ticket.status] || [ticket.status, "off"];
    return { label: ticket.status === "expired_returned" && ticket.late ? "Odevzdaná opožděně" : label, tone };
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
  function attachSpeciesSuggest(input, getSpecies, onChoose = () => {}) {
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
      box.innerHTML = matches.map((s) => `<button type="button" role="option" data-name="${esc(s.name)}">${esc(s.name)}</button>`).join("");
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
  const ROLE_LABELS = { member: "Uživatel", warden: "Porybný", manager: "Správce", admin: "Admin" };

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
    ticket: '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v2M13 11v2M13 17v2"/>'
  };
  const icon = (name, size = 16) => `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  window.Mistenka = { icon, qs, qsa, esc, api, ApiError, loadConfig, selectedRevir, revirUrl, czDate, dayInfo, czk, czDateTime, fishingHours, subdistrictLabel, subdistrictTitle, plural, findSpecies, catchProblem, seasonText, normalizeMemberId, isMemberId, credentialsFor, saveToken, rememberMemberId, qrMatrix, qrSvg, ticketCheckUrl, showToast, applyBranding, loadSession, setSession, setSessionUser, hasRole, isStaff, renderUserMenu, initUserMenu, ticketState, ROLE_LABELS, parseCzDate, formatCzDate, passwordProblem, limitsHtml, attachSpeciesSuggest, attachQrScanner, attachMemberIdScanner, codeFromQr, memberIdFromBarcode };
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
