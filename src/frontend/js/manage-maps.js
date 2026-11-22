// Editor map revírů (Správa → Revíry → Mapy revírů). Nad podkladem mapy se zakreslí plochy (hranice revíru,
// podrevíry, zákaz lovu), čáry (cesta, zákaz lovu na úseku) a body (parkoviště, WC, vstup k vodě …).
// Mapa se uloží jako část nastavení map:<id revíru> s verzemi (GeoJSON + výchozí pohled + schematický náhled PNG
// pro e-mail a PDF – kreslí se jen ze zakreslených dat, podklad Mapy.com se ukládat nesmí).
// Export/import JSON = soubor pro config/maps/<id revíru>.json (výchozí mapa při instalaci).
(function () {
  const { qs, qsa, esc, api, loadConfig, showToast, czDateTime } = window.Mistenka;
  const MM = window.MistenkaMap;
  const Lf = () => window.L;

  const TOOLS = [
    { group: "Plochy", items: [["draw", "revir", "Polygon"], ["draw", "subdistrict", "Polygon"], ["draw", "restricted", "Polygon"]] },
    { group: "Čáry", items: [["draw", "path", "LineString"], ["draw", "restricted", "LineString"]] },
    { group: "Body", items: [["place", "parking", "Point"], ["place", "wc", "Point"], ["place", "entrance", "Point"], ["place", "info", "Point"], ["place", "danger", "Point"], ["place", "other", "Point"]] }
  ];
  const state = {
    config: null, maps: [], revirId: "",
    features: [], view: null, selected: null,
    mode: { type: "select" }, draft: [],
    undo: [], dirty: false, editSnapshot: null,
    map: null, fg: null, handles: null, draftLayer: null, layers: new Map()
  };
  let seq = 0;
  const newId = () => `f${Date.now().toString(36)}${(++seq).toString(36)}`;
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const revir = () => state.config?.reviry.find((r) => r.id === state.revirId) || null;
  const mapMeta = () => state.maps.find((m) => m.revirId === state.revirId) || null;
  const selectedFeature = () => state.features.find((f) => f.properties._id === state.selected) || null;
  const visible = () => !qs("#section-maps")?.classList.contains("hidden");

  // ---------- načtení ----------
  async function load(initial = "") {
    const host = qs("#mapEditor");
    try {
      const [config, settings] = await Promise.all([loadConfig(), api("/manage/settings")]);
      state.config = config;
      state.maps = settings.maps || [];
      const ids = config.reviry.map((r) => r.id);
      const target = ids.includes(initial) ? initial : ids.includes(state.revirId) ? state.revirId : ids[0];
      renderTabs(target);
      // Neuložené změny téhož revíru se při návratu do sekce zachovají.
      if (state.dirty && state.map && target === state.revirId) { window.setTimeout(() => state.map.invalidateSize(), 50); return; }
      open(target);
    } catch (error) { host.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  function renderTabs(active) {
    qs("#mapTabs").innerHTML = state.config.reviry.map((r) => {
      const meta = state.maps.find((m) => m.revirId === r.id);
      const count = meta?.data?.features?.length || 0;
      return `<button type="button" class="tab${r.id === active ? " active" : ""}" role="tab" aria-selected="${r.id === active}" data-revir="${esc(r.id)}">${esc(r.name)}${count ? ` <small class="muted-inline">(${count})</small>` : ""}</button>`;
    }).join("");
    qsa("#mapTabs [data-revir]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.revir === state.revirId) return;
      if (state.dirty && !window.confirm("Mapa má neuložené změny. Zahodit je?")) return;
      renderTabs(b.dataset.revir);
      open(b.dataset.revir);
    }));
  }
  function open(revirId) {
    state.revirId = revirId;
    const doc = mapMeta()?.data;
    state.features = (doc?.features || []).map((f) => ({ type: "Feature", geometry: structuredClone(f.geometry), properties: { ...f.properties, _id: newId() } }));
    state.view = doc?.view ? structuredClone(doc.view) : null;
    state.selected = null;
    state.mode = { type: "select" };
    state.draft = [];
    state.undo = [];
    state.dirty = false;
    history.replaceState(null, "", `#maps/${encodeURIComponent(revirId)}`);
    renderEditor();
  }

  // ---------- rozvržení editoru ----------
  function toolButton([type, kind, geometry]) {
    const style = MM.KINDS[kind];
    const icon = geometry === "Point"
      ? `<span class="map-poi${style.symbol.length > 1 ? " wide" : ""}" style="background:${style.color}">${esc(style.symbol)}</span>`
      : geometry === "LineString"
        ? `<span class="swatch" style="height:0;border-top:3px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`
        : `<span class="swatch" style="background:${style.fill || style.color}55;border:2px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`;
    return `<button type="button" class="map-tool" data-tool="${type}:${kind}:${geometry}" title="${type === "place" ? "Klepněte do mapy, kam bod umístit" : "Klepáním do mapy zakreslete body tvaru"}">${icon}${esc(MM.kindLabel(kind, geometry))}</button>`;
  }
  function renderEditor() {
    const meta = mapMeta();
    const host = qs("#mapEditor");
    if (state.map) { state.map.remove(); state.map = null; }
    host.innerHTML = `
      <div class="map-toolbar">${TOOLS.map((g) => `<div class="tool-group"><span>${esc(g.group)}</span>${g.items.map(toolButton).join("")}</div>`).join("")}</div>
      <div class="map-editor-map" id="mapEditorMap" aria-label="Mapa revíru – editor"></div>
      <div class="map-hint" id="mapHint" aria-live="polite"></div>
      <div class="map-editor-cols">
        <div class="map-feature-form" id="mapFeatureForm"></div>
        <div><h3 class="stats-subtitle">Zakreslené prvky</h3><ul class="map-feature-list" id="mapFeatureList"></ul></div>
      </div>
      <div class="map-view-row" id="mapViewRow"></div>
      <div class="settings-footer">
        <input id="mapNote" maxlength="200" placeholder="Poznámka ke změně (volitelné)">
        <button class="primary-button" type="button" id="mapSave">Uložit mapu</button>
        <span class="muted-inline" id="mapStatus"></span>
      </div>
      <div class="settings-tools">
        <button class="text-button" type="button" id="mapUndo">↶ Zpět</button>
        <button class="text-button" type="button" id="mapExport">Exportovat JSON</button>
        <button class="text-button" type="button" id="mapImport">Importovat JSON</button>
        <input type="file" id="mapImportFile" accept=".json,.geojson,application/json,application/geo+json" hidden>
        <button class="text-button" type="button" id="mapHistoryButton">Historie změn</button>
        ${meta?.hasFile && meta.source === "database" ? '<button class="text-button" type="button" id="mapReset">Obnovit výchozí ze souboru</button>' : ""}
        <a class="text-button" id="mapPublicLink" href="map.html?revir=${encodeURIComponent(state.revirId)}" target="_blank" rel="noreferrer">Zobrazit mapu pro rybáře ↗</a>
      </div>
      <p class="field-help">Export uloží mapu jako soubor JSON – patří do <code>config/maps/${esc(state.revirId)}.json</code> (výchozí mapa při instalaci). Import načte GeoJSON (i z jiných nástrojů, např. geojson.io); uloží se až tlačítkem Uložit mapu.</p>
      <div class="settings-history" id="mapHistory"></div>`;
    initMap();
    bindEditor();
    refresh();
  }
  function initMap() {
    const L = Lf();
    const r = revir();
    state.map = MM.createMap(qs("#mapEditorMap"), state.config.mapTiles, { base: state.view?.base || "outdoor", doubleClickZoom: false, scrollWheelZoom: true });
    state.fg = L.featureGroup().addTo(state.map);
    state.handles = L.layerGroup().addTo(state.map);
    state.draftLayer = L.layerGroup().addTo(state.map);
    state.map.on("click", onMapClick);
    state.map.on("baselayerchange", (e) => { if (state.view) { state.view.base = e.base; markDirty(); } renderViewRow(); });
    // Pohled se nastaví dřív než vrstvy (značky se do mapy bez pohledu přidají až později a nešly by přetahovat).
    const box = MM.bounds(state.features);
    if (state.view) state.map.setView(state.view.center, state.view.zoom);
    else if (box) state.map.fitBounds([[box.south, box.west], [box.north, box.east]], { padding: [30, 30], maxZoom: 17 });
    else if (r?.gps) state.map.setView([r.gps.lat, r.gps.lon], 16);
    else state.map.setView([49.8, 15.5], 7);
    drawFeatures();
    window.setTimeout(() => state.map?.invalidateSize(), 60);
  }

  // ---------- kreslení vrstev ----------
  function drawFeatures() {
    const L = Lf();
    state.fg.clearLayers();
    state.layers.clear();
    const order = { Polygon: 0, LineString: 1, Point: 2 };
    const sorted = [...state.features].sort((a, b) => order[a.geometry.type] - order[b.geometry.type] || (a.properties.kind === "revir" ? -1 : b.properties.kind === "revir" ? 1 : 0));
    for (const f of sorted) {
      const id = f.properties._id;
      const layer = MM.featureLayer(f, { selected: id === state.selected });
      // V režimu výběru klepnutí prvek vybere (a nepropadne do mapy); při kreslení propadne a přidá bod tvaru.
      layer.options.bubblingMouseEvents = state.mode.type !== "select";
      layer.on("click", (e) => {
        if (state.mode.type !== "select") return;
        Lf().DomEvent.stop(e);
        select(id);
      });
      if (f.properties.kind === "subdistrict" && f.properties.number !== undefined && f.properties.number !== null && f.properties.number !== "") layer.bindTooltip(String(f.properties.number), { permanent: true, direction: "center", className: "map-label" });
      const draggable = f.geometry.type === "Point" && state.mode.type === "select";
      if (draggable) layer.options.draggable = true;
      layer.addTo(state.fg);
      state.layers.set(id, layer);
      if (draggable) {
        layer.on("dragstart", () => { pushUndo(); select(id, { keepLayers: true }); });
        layer.on("dragend", (e) => {
          const { lat, lng } = e.target.getLatLng();
          f.geometry.coordinates = [round6(lng), round6(lat)];
          markDirty();
          refresh();
        });
      }
    }
    drawHandles();
  }
  const vertexIcon = (kind = "") => Lf().divIcon({ className: "", html: `<span class="map-vertex ${kind}"></span>`, iconSize: [0, 0] });
  // Ring plochy bez opakovaného uzavíracího bodu / body čáry.
  const shapePoints = (f) => (f.geometry.type === "Polygon" ? f.geometry.coordinates[0].slice(0, -1) : f.geometry.coordinates);
  function setShapePoints(f, points) {
    if (f.geometry.type === "Polygon") f.geometry.coordinates[0] = [...points, points[0]];
    else f.geometry.coordinates = points;
  }
  function drawHandles() {
    const L = Lf();
    state.handles.clearLayers();
    const f = selectedFeature();
    if (!f || f.geometry.type === "Point" || state.mode.type !== "select") return;
    const closed = f.geometry.type === "Polygon";
    const points = shapePoints(f);
    points.forEach((p, i) => {
      const handle = L.marker([p[1], p[0]], { icon: vertexIcon(), draggable: true, keyboard: false, zIndexOffset: 1000, title: "Přetažením posunete bod, dvojklikem ho odeberete" }).addTo(state.handles);
      handle.on("dragstart", () => pushUndo());
      handle.on("drag", (e) => {
        const { lat, lng } = e.target.getLatLng();
        const next = shapePoints(f).map((q) => [...q]);
        next[i] = [round6(lng), round6(lat)];
        setShapePoints(f, next);
        const layer = state.layers.get(f.properties._id);
        if (layer) layer.setLatLngs(closed ? f.geometry.coordinates.map(MM.latlngs) : MM.latlngs(f.geometry.coordinates));
      });
      handle.on("dragend", () => { markDirty(); refresh(); });
      const remove = (e) => {
        L.DomEvent.stop(e);
        const current = shapePoints(f);
        if (current.length <= (closed ? 3 : 2)) return showToast(closed ? "Plocha musí mít alespoň 3 body." : "Čára musí mít alespoň 2 body.", "warning");
        pushUndo();
        setShapePoints(f, current.filter((_, j) => j !== i));
        markDirty();
        refresh();
      };
      handle.on("dblclick", remove);
      handle.on("contextmenu", remove);
    });
    // Poloprůhledné body uprostřed hran: klepnutím přidají nový bod tvaru.
    const edges = closed ? points.length : points.length - 1;
    for (let i = 0; i < edges; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const mid = [round6((a[0] + b[0]) / 2), round6((a[1] + b[1]) / 2)];
      const handle = L.marker([mid[1], mid[0]], { icon: vertexIcon("mid"), keyboard: false, zIndexOffset: 900, title: "Klepnutím přidáte bod" }).addTo(state.handles);
      handle.on("click", (e) => {
        L.DomEvent.stop(e);
        pushUndo();
        const next = shapePoints(f).map((q) => [...q]);
        next.splice(i + 1, 0, mid);
        setShapePoints(f, next);
        markDirty();
        refresh();
      });
    }
  }
  function drawDraft() {
    const L = Lf();
    state.draftLayer.clearLayers();
    if (state.mode.type !== "draw" || !state.draft.length) return;
    const style = MM.KINDS[state.mode.kind];
    const polygon = state.mode.geometry === "Polygon";
    L.polyline(state.draft, { color: style.color, weight: 3, dashArray: "6 6", interactive: false }).addTo(state.draftLayer);
    if (polygon && state.draft.length > 2) L.polyline([state.draft[state.draft.length - 1], state.draft[0]], { color: style.color, weight: 2, dashArray: "2 6", opacity: 0.7, interactive: false }).addTo(state.draftLayer);
    state.draft.forEach((p, i) => {
      const finisher = (polygon && i === 0 && state.draft.length > 2) || (!polygon && i === state.draft.length - 1 && state.draft.length > 1);
      const marker = L.marker(p, { icon: vertexIcon(i === 0 ? "first" : ""), keyboard: false, zIndexOffset: 1000, title: finisher ? "Klepnutím dokončíte" : "" }).addTo(state.draftLayer);
      marker.on("click", (e) => { L.DomEvent.stop(e); if (finisher) finishDraw(); });
    });
  }

  // ---------- režimy a události mapy ----------
  const modeKey = (mode) => (mode.type === "select" ? "" : `${mode.type}:${mode.kind}:${mode.geometry}`);
  function setMode(mode) {
    state.mode = mode;
    state.draft = [];
    if (mode.type !== "select") state.selected = null;
    refresh();
  }
  function onMapClick(e) {
    const { lat, lng } = e.latlng;
    if (state.mode.type === "place") {
      pushUndo();
      const f = makeFeature(state.mode.kind, "Point", [round6(lng), round6(lat)]);
      state.features.push(f);
      state.selected = f.properties._id;
      state.mode = { type: "select" };
      markDirty();
      refresh();
      return;
    }
    if (state.mode.type === "draw") {
      state.draft.push([lat, lng]);
      drawDraft();
      renderHint();
      return;
    }
    if (state.selected) { state.selected = null; refresh(); }
  }
  function finishDraw() {
    if (state.mode.type !== "draw") return;
    const { kind, geometry } = state.mode;
    const points = state.draft.map(([lat, lng]) => [round6(lng), round6(lat)]);
    if (geometry === "Polygon" && points.length < 3) return showToast("Plocha potřebuje alespoň 3 body.", "warning");
    if (geometry === "LineString" && points.length < 2) return showToast("Čára potřebuje alespoň 2 body.", "warning");
    pushUndo();
    const f = makeFeature(kind, geometry, geometry === "Polygon" ? [[...points, points[0]]] : points);
    state.features.push(f);
    state.selected = f.properties._id;
    state.mode = { type: "select" };
    state.draft = [];
    markDirty();
    refresh();
  }
  // Nový prvek: podrevír dostane další číslo (a název podle revíru), hranice revíru jeho název.
  function makeFeature(kind, geometry, coordinates) {
    const properties = { kind, _id: newId() };
    if (kind === "subdistrict") {
      const used = new Set(state.features.filter((f) => f.properties.kind === "subdistrict").map((f) => String(f.properties.number)));
      const known = (revir()?.subdistrictList || []).find((s) => !used.has(String(s.number)));
      const numbers = state.features.map((f) => Number(f.properties.number)).filter(Number.isFinite);
      properties.number = known ? known.number : (numbers.length ? Math.max(...numbers) + 1 : 1);
      if (known?.name) properties.name = known.name;
    }
    if (kind === "revir") properties.name = revir()?.name || "";
    return { type: "Feature", geometry: { type: geometry, coordinates }, properties };
  }
  function select(id, { keepLayers = false } = {}) {
    state.selected = id;
    if (keepLayers) { renderForm(); renderList(); return; }
    refresh();
  }
  function deleteSelected() {
    const f = selectedFeature();
    if (!f) return;
    pushUndo();
    state.features = state.features.filter((item) => item !== f);
    state.selected = null;
    markDirty();
    refresh();
  }

  // ---------- zpět, změny ----------
  const snapshot = () => JSON.stringify({ features: state.features, view: state.view });
  function pushUndo(snap = snapshot()) {
    state.undo.push(snap);
    if (state.undo.length > 60) state.undo.shift();
  }
  function undo() {
    const snap = state.undo.pop();
    if (!snap) return showToast("Není co vrátit.", "info");
    const data = JSON.parse(snap);
    state.features = data.features;
    state.view = data.view;
    if (!state.features.some((f) => f.properties._id === state.selected)) state.selected = null;
    state.mode = { type: "select" };
    state.draft = [];
    markDirty();
    refresh();
  }
  function markDirty() {
    state.dirty = true;
    renderStatus();
  }

  // ---------- panely ----------
  function refresh() {
    qsa(".map-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === modeKey(state.mode)));
    qs("#mapEditorMap")?.classList.toggle("drawing", state.mode.type !== "select");
    drawFeatures();
    drawDraft();
    renderHint();
    renderForm();
    renderList();
    renderViewRow();
    renderStatus();
  }
  function renderHint() {
    const box = qs("#mapHint");
    if (!box) return;
    const m = state.mode;
    if (m.type === "draw") {
      const label = MM.kindLabel(m.kind, m.geometry);
      const need = m.geometry === "Polygon" ? 3 : 2;
      box.innerHTML = `<span><b>Kreslíte: ${esc(label)}.</b> Klepejte do mapy na body tvaru (${state.draft.length} ${state.draft.length === 1 ? "bod" : state.draft.length < 5 && state.draft.length ? "body" : "bodů"}). ${m.geometry === "Polygon" ? "Dokončíte klepnutím na první bod" : "Dokončíte klepnutím na poslední bod"}, tlačítkem nebo klávesou Enter.</span>
        <button class="secondary-button" type="button" id="mapFinish"${state.draft.length < need ? " disabled" : ""}>Dokončit</button><button class="text-button" type="button" id="mapCancel">Zrušit (Esc)</button>`;
      qs("#mapFinish").addEventListener("click", finishDraw);
      qs("#mapCancel").addEventListener("click", () => setMode({ type: "select" }));
    } else if (m.type === "place") {
      box.innerHTML = `<span><b>Umístěte: ${esc(MM.kindLabel(m.kind, "Point"))}.</b> Klepněte do mapy.</span><button class="text-button" type="button" id="mapCancel">Zrušit (Esc)</button>`;
      qs("#mapCancel").addEventListener("click", () => setMode({ type: "select" }));
    } else {
      box.innerHTML = state.features.length
        ? "<span>Klepnutím na prvek ho vyberete a upravíte. Značky i body tvaru jde přetahovat.</span>"
        : "<span>Začněte nástrojem nahoře – např. <b>Hranice revíru</b> a klepejte do mapy kolem vody.</span>";
    }
  }
  function renderForm() {
    const box = qs("#mapFeatureForm");
    if (!box) return;
    const f = selectedFeature();
    if (!f) {
      box.innerHTML = `<h3>Vybraný prvek</h3><p class="muted">Nic není vybráno. Klepněte na prvek v mapě nebo v seznamu.</p>
        <p class="field-help">Plochy: hranice revíru, podrevíry (s číslem), zákaz lovu. Čáry: přístupová cesta, úsek se zákazem lovu. Body: parkoviště, WC, vstup k vodě, informace, pozor, jiné místo.</p>`;
      return;
    }
    const p = f.properties;
    const type = f.geometry.type;
    const kinds = MM.GEOMETRY_KINDS[type];
    const subs = revir()?.subdistrictList || [];
    box.innerHTML = `<h3>${esc(MM.featureTitle(f))}</h3>
      <label class="field-label" for="mfKind">Druh</label>
      <select id="mfKind">${kinds.map((k) => `<option value="${k}"${k === p.kind ? " selected" : ""}>${esc(MM.kindLabel(k, type))}</option>`).join("")}</select>
      ${p.kind === "subdistrict" ? `<label class="field-label" for="mfNumber">Číslo podrevíru</label><input id="mfNumber" list="mfNumbers" maxlength="10" value="${esc(p.number ?? "")}"><datalist id="mfNumbers">${subs.map((s) => `<option value="${esc(s.number)}">${esc(s.name || "")}</option>`).join("")}</datalist>` : ""}
      <label class="field-label" for="mfName">Název <span class="optional">(volitelné)</span></label><input id="mfName" maxlength="80" value="${esc(p.name || "")}" placeholder="${esc(MM.kindLabel(p.kind, type))}">
      <label class="field-label" for="mfNote">Poznámka pro rybáře <span class="optional">(volitelné)</span></label><textarea id="mfNote" maxlength="300" placeholder="např. Parkujte jen na zpevněné ploše.">${esc(p.note || "")}</textarea>
      <p class="field-help">${type === "Point" ? "Značku přesunete přetažením." : "Body tvaru přetáhněte; poloprůhledným bodem uprostřed hrany přidáte nový, dvojklikem (nebo pravým tlačítkem) bod odeberete."}</p>
      <button class="danger-button" type="button" id="mfDelete">Smazat prvek</button>`;
    box.addEventListener("focusin", () => { state.editSnapshot = snapshot(); }, { once: true });
    const apply = (mutate) => { if (state.editSnapshot) { pushUndo(state.editSnapshot); state.editSnapshot = null; } mutate(); markDirty(); };
    qs("#mfKind").addEventListener("change", (e) => apply(() => {
      p.kind = e.target.value;
      if (p.kind === "subdistrict" && (p.number === undefined || p.number === null || p.number === "")) p.number = makeFeature("subdistrict", type, []).properties.number;
      if (p.kind !== "subdistrict") delete p.number;
      refresh();
    }));
    qs("#mfNumber")?.addEventListener("input", (e) => apply(() => {
      const raw = e.target.value.trim();
      p.number = /^\d+$/.test(raw) ? Number(raw) : raw;
      const known = subs.find((s) => String(s.number) === raw);
      if (known?.name && !p.name) { p.name = known.name; qs("#mfName").value = known.name; }
      drawFeatures();
      renderList();
    }));
    qs("#mfName").addEventListener("input", (e) => apply(() => { p.name = e.target.value; if (!p.name) delete p.name; renderList(); }));
    qs("#mfNote").addEventListener("input", (e) => apply(() => { p.note = e.target.value; if (!p.note) delete p.note; }));
    ["#mfName", "#mfNote", "#mfNumber"].forEach((sel) => qs(sel)?.addEventListener("change", () => { state.editSnapshot = snapshot(); drawFeatures(); }));
    qs("#mfDelete").addEventListener("click", deleteSelected);
  }
  function renderList() {
    const list = qs("#mapFeatureList");
    if (!list) return;
    const order = { Polygon: 0, LineString: 1, Point: 2 };
    const items = [...state.features].sort((a, b) => order[a.geometry.type] - order[b.geometry.type]);
    list.innerHTML = items.length ? items.map((f) => {
      const style = MM.KINDS[f.properties.kind] || MM.KINDS.other;
      const chip = f.geometry.type === "Point"
        ? `<span class="map-poi small${style.symbol.length > 1 ? " wide" : ""}" style="background:${style.color}">${esc(style.symbol)}</span>`
        : `<span class="legend-area" style="background:${style.fill || style.color}55;border:2px ${style.dash ? "dashed" : "solid"} ${style.color}${f.geometry.type === "LineString" ? ";height:0;border-width:3px 0 0" : ""}"></span>`;
      const info = f.geometry.type === "Point" ? MM.kindLabel(f.properties.kind, "Point") : `${MM.kindLabel(f.properties.kind, f.geometry.type)} · ${shapePoints(f).length} bodů`;
      return `<li data-id="${esc(f.properties._id)}" class="${f.properties._id === state.selected ? "selected" : ""}">${chip}<span class="grow">${esc(MM.featureTitle(f))}<br><small>${esc(info)}</small></span><button class="text-button" type="button" data-delete="${esc(f.properties._id)}" aria-label="Smazat prvek">✕</button></li>`;
    }).join("") : '<li class="muted">Zatím nic – mapa je prázdná.</li>';
    qsa("li[data-id]", list).forEach((li) => li.addEventListener("click", (e) => {
      if (e.target.closest("[data-delete]")) return;
      state.mode = { type: "select" };
      select(li.dataset.id);
      const layer = state.layers.get(li.dataset.id);
      if (layer?.getBounds) state.map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 18 });
      else if (layer?.getLatLng) state.map.panTo(layer.getLatLng());
    }));
    qsa("[data-delete]", list).forEach((b) => b.addEventListener("click", () => { state.selected = b.dataset.delete; deleteSelected(); }));
  }
  function renderViewRow() {
    const box = qs("#mapViewRow");
    if (!box) return;
    const r = revir();
    box.innerHTML = `<span>Výchozí pohled pro rybáře: <b>${state.view ? `uložený výřez (přiblížení ${esc(state.view.zoom)}, ${esc(MM.MAPY_BASES[state.view.base] || "podklad")})` : "automaticky podle zakreslených prvků"}</b></span>
      <button class="text-button" type="button" id="mapUseView">Použít aktuální výřez</button>
      ${state.view ? '<button class="text-button" type="button" id="mapAutoView">Automaticky</button>' : ""}
      ${r?.gps ? '<button class="text-button" type="button" id="mapGps">Na GPS revíru</button>' : ""}`;
    qs("#mapUseView").addEventListener("click", () => {
      pushUndo();
      const c = state.map.getCenter();
      state.view = { center: [round6(c.lat), round6(c.lng)], zoom: Math.max(3, Math.min(20, Math.round(state.map.getZoom()))), base: state.map.currentBase() === "osm" ? "outdoor" : state.map.currentBase() };
      markDirty();
      renderViewRow();
    });
    qs("#mapAutoView")?.addEventListener("click", () => { pushUndo(); state.view = null; markDirty(); renderViewRow(); });
    qs("#mapGps")?.addEventListener("click", () => state.map.setView([r.gps.lat, r.gps.lon], 16));
  }
  function renderStatus() {
    const box = qs("#mapStatus");
    if (!box) return;
    const meta = mapMeta();
    const saved = meta?.source === "database" ? `Uloženo ${esc(czDateTime(meta.updatedAt))}${meta.updatedBy ? ` · ${esc(meta.updatedBy)}` : ""} · verze #${esc(meta.version)}` : meta?.hasFile ? "Výchozí mapa ze souboru" : "Zatím neuloženo";
    box.innerHTML = state.dirty ? `<span class="map-dirty">Neuložené změny</span> · ${saved}` : saved;
    const undoButton = qs("#mapUndo");
    if (undoButton) undoButton.disabled = !state.undo.length;
  }

  // ---------- uložení, export, import, historie ----------
  // Dokument mapy: GeoJSON bez místních id + výchozí pohled + schematický náhled PNG (jen když jsou prvky).
  function buildDoc() {
    const features = state.features.map((f) => {
      const { _id, ...properties } = f.properties;
      for (const key of ["name", "note"]) if (properties[key] !== undefined) { properties[key] = String(properties[key]).trim(); if (!properties[key]) delete properties[key]; }
      if (properties.number === "") delete properties.number;
      return { type: "Feature", properties, geometry: f.geometry };
    });
    const doc = { type: "FeatureCollection", ...(state.view ? { view: state.view } : {}), features };
    if (features.length) doc.preview = MM.renderPreview(doc, { width: 1200, height: 760, title: revir()?.name || "" }).toDataURL("image/png");
    return doc;
  }
  async function save() {
    const button = qs("#mapSave");
    button.disabled = true;
    try {
      const result = await api(`/manage/settings/maps/${encodeURIComponent(state.revirId)}`, { method: "PUT", body: { data: buildDoc(), note: qs("#mapNote").value } });
      state.maps = result.settings.maps || [];
      state.dirty = false;
      state.undo = [];
      showToast("Mapa revíru uložena.", "success");
      renderTabs(state.revirId);
      open(state.revirId);
    } catch (error) { showToast(error.message, "error"); } finally { if (qs("#mapSave")) qs("#mapSave").disabled = false; }
  }
  function exportJson() {
    const blob = new Blob([`${JSON.stringify(buildDoc(), null, 2)}\n`], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.revirId}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // Import GeoJSON: Polygon/LineString/Point (i Multi*), druh podle vlastnosti kind, jinak podle typu geometrie.
  function importFeatures(data) {
    const source = data?.type === "FeatureCollection" ? data.features : data?.type === "Feature" ? [data] : Array.isArray(data) ? data : null;
    if (!Array.isArray(source)) throw new Error("Soubor není GeoJSON (FeatureCollection nebo Feature).");
    const out = [];
    let skipped = 0;
    const defaults = { Polygon: "revir", LineString: "path", Point: "other" };
    const add = (type, coordinates, props) => {
      const kind = MM.GEOMETRY_KINDS[type].includes(props?.kind) ? props.kind : defaults[type];
      const properties = { kind, _id: newId() };
      for (const key of ["name", "note"]) if (typeof props?.[key] === "string" && props[key].trim()) properties[key] = props[key].trim().slice(0, key === "name" ? 80 : 300);
      if (kind === "subdistrict" && props?.number !== undefined && props?.number !== null) properties.number = props.number;
      if (type === "Polygon") coordinates = coordinates.slice(0, 10).map((ring) => { const r = ring.map((p) => [round6(p[0]), round6(p[1])]); const [a, b] = [r[0], r[r.length - 1]]; return a[0] === b[0] && a[1] === b[1] ? r : [...r, a]; });
      else if (type === "LineString") coordinates = coordinates.map((p) => [round6(p[0]), round6(p[1])]);
      else coordinates = [round6(coordinates[0]), round6(coordinates[1])];
      out.push({ type: "Feature", geometry: { type, coordinates }, properties });
    };
    for (const feature of source) {
      const g = feature?.geometry;
      const props = feature?.properties || {};
      if (!g) { skipped++; continue; }
      if (g.type === "Polygon" || g.type === "LineString" || g.type === "Point") add(g.type, g.coordinates, props);
      else if (g.type === "MultiPolygon") g.coordinates.forEach((c) => add("Polygon", c, props));
      else if (g.type === "MultiLineString") g.coordinates.forEach((c) => add("LineString", c, props));
      else if (g.type === "MultiPoint") g.coordinates.forEach((c) => add("Point", c, props));
      else skipped++;
    }
    return { features: out, skipped, view: data?.view || null };
  }
  async function importJson(file) {
    try {
      const { features, skipped, view } = importFeatures(JSON.parse(await file.text()));
      if (!features.length) throw new Error("V souboru nejsou žádné plochy, čáry ani body.");
      if (state.features.length && !window.confirm(`Nahradit zakreslené prvky (${state.features.length}) importovanými (${features.length})?`)) return;
      pushUndo();
      state.features = features;
      if (view) state.view = view;
      state.selected = null;
      markDirty();
      refresh();
      state.map.fitBounds(state.fg.getBounds(), { padding: [30, 30], maxZoom: 17 });
      showToast(`Načteno ${features.length} prvků${skipped ? `, ${skipped} nepodporovaných přeskočeno` : ""}. Uložte mapu tlačítkem Uložit mapu.`, skipped ? "warning" : "success");
    } catch (error) { showToast(error.message || "Soubor nejde načíst.", "error"); }
  }
  async function showHistory() {
    const box = qs("#mapHistory");
    try {
      const { versions } = await api("/manage/settings/history", { query: { scope: `map:${state.revirId}` } });
      box.innerHTML = versions.length ? `<ul class="plain-list">${versions.map((v, i) => `<li>#${esc(v.version)} · ${esc(czDateTime(v.createdAt))} · ${esc(v.createdBy || "—")}${v.note ? ` · ${esc(v.note)}` : ""} ${i ? `<button class="text-button inline-link" type="button" data-restore="${esc(v.version)}">Obnovit</button>` : "<b>(platná)</b>"}</li>`).join("")}</ul>` : '<p class="muted">Zatím beze změn.</p>';
      qsa("[data-restore]", box).forEach((b) => b.addEventListener("click", async () => {
        if (state.dirty && !window.confirm("Mapa má neuložené změny. Zahodit je?")) return;
        if (!window.confirm(`Obnovit verzi #${b.dataset.restore}? Uloží se jako nová verze.`)) return;
        try { state.maps = (await api(`/manage/settings/versions/${b.dataset.restore}/restore`, { method: "POST" })).settings.maps || []; state.dirty = false; showToast("Verze obnovena.", "success"); renderTabs(state.revirId); open(state.revirId); } catch (error) { showToast(error.message, "error"); }
      }));
    } catch (error) { box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  async function resetToFile() {
    if (!window.confirm("Obnovit výchozí mapu ze souboru? Uloží se jako nová verze, historie zůstane.")) return;
    try { state.maps = (await api("/manage/settings/reset", { method: "POST", body: { scope: `map:${state.revirId}` } })).settings.maps || []; state.dirty = false; showToast("Obnovena výchozí mapa.", "success"); renderTabs(state.revirId); open(state.revirId); } catch (error) { showToast(error.message, "error"); }
  }
  function bindEditor() {
    qsa(".map-tool").forEach((b) => b.addEventListener("click", () => {
      const [type, kind, geometry] = b.dataset.tool.split(":");
      setMode(modeKey(state.mode) === b.dataset.tool ? { type: "select" } : { type, kind, geometry });
    }));
    qs("#mapSave").addEventListener("click", save);
    qs("#mapUndo").addEventListener("click", undo);
    qs("#mapExport").addEventListener("click", exportJson);
    qs("#mapImport").addEventListener("click", () => qs("#mapImportFile").click());
    qs("#mapImportFile").addEventListener("change", (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importJson(file); });
    qs("#mapHistoryButton").addEventListener("click", showHistory);
    qs("#mapReset")?.addEventListener("click", resetToFile);
  }

  // Klávesy: Esc zruší kreslení / výběr, Enter dokončí, Delete smaže vybraný prvek, Ctrl+Z vrátí krok.
  document.addEventListener("keydown", (e) => {
    if (!visible() || !state.map) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape") { if (state.mode.type !== "select") setMode({ type: "select" }); else if (state.selected && !typing) { state.selected = null; refresh(); } }
    else if (e.key === "Enter" && state.mode.type === "draw" && !typing) { e.preventDefault(); finishDraw(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && state.selected && !typing) { e.preventDefault(); deleteSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); }
  });
  // Neuložené změny: varování při odchodu ze sekce a ze stránky.
  document.addEventListener("click", (e) => {
    const item = e.target.closest?.(".manage-nav-item");
    if (!item || item.dataset.section === "maps" || !state.dirty || !visible()) return;
    if (!window.confirm("Mapa revíru má neuložené změny. Opravdu odejít?")) { e.preventDefault(); e.stopImmediatePropagation(); }
    else state.dirty = false;
  }, true);
  window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  window.MistenkaMapEditor = { load };
})();
