// Mapy revírů: druhy zakreslených prvků a vrstvy pro interaktivní mapu, kartu na úvodu a editor
// (Leaflet, podklad Mapy.com nebo OpenStreetMap). Data jsou GeoJSON FeatureCollection (souřadnice [lon, lat])
// + view { center: [lat, lon], zoom, base }. Stav podrevírů se nebere z mapy, ale z aktuálního nastavení revíru:
// podrevír, na který místenka neplatí (není v ticketSubdistricts), je šrafovaný s upozorněním.
(function () {
  // Druhy prvků podle typu geometrie (stejné jako MAP_KINDS na serveru).
  const GEOMETRY_KINDS = { Polygon: ["revir", "subdistrict", "restricted"], LineString: ["path", "restricted"], Point: ["parking", "wc", "entrance", "info", "danger", "other"] };
  const KINDS = {
    revir: { label: "Hranice revíru", color: "#0b63b8", fill: "#4f9fe6", fillOpacity: 0.16, weight: 3 },
    subdistrict: { label: "Podrevír", color: "#15803d", fill: "#3fb06a", fillOpacity: 0.24, weight: 2 },
    restricted: { label: "Zákaz lovu", color: "#c8302a", fill: "#e2554e", fillOpacity: 0.26, weight: 3, dash: [7, 6] },
    path: { label: "Cesta", color: "#8a5a00", weight: 3, dash: [2, 6] },
    parking: { label: "Parkoviště", symbol: "P", color: "#0b63b8" },
    wc: { label: "WC", symbol: "WC", color: "#6d4fd6" },
    entrance: { label: "Vstup k vodě", symbol: "↘", color: "#15803d" },
    info: { label: "Informace", symbol: "i", color: "#0a6bc4" },
    danger: { label: "Pozor", symbol: "!", color: "#c2610c" },
    other: { label: "Místo", symbol: "•", color: "#57534e" }
  };
  // Podrevír, na který místenka neplatí: šedý přerušovaný obrys a šrafování.
  const CLOSED = { color: "#6b6560", weight: 2, dash: [6, 5] };
  const CLOSED_TEXT = "Na tomto podrevíru místenka není!";
  const LINE_LABELS = { restricted: "Zákaz lovu (úsek)" };
  const kindOf = (feature) => KINDS[feature?.properties?.kind] ? feature.properties.kind : "other";
  const kindLabel = (kind, geometry) => (geometry === "LineString" && LINE_LABELS[kind]) || KINDS[kind]?.label || kind;
  const hasNumber = (value) => value !== undefined && value !== null && value !== "";

  // Stav podrevíru podle aktuálního nastavení revíru: název ze seznamu podrevírů a zda na něj místenka platí
  // (revír s podrevíry v prodeji – ticketSubdistricts – prodává místenky jen na ně; bez nich platí na celý revír).
  function subdistrictInfo(revir, number) {
    const item = (revir?.subdistrictList || []).find((s) => String(s.number) === String(number));
    const sale = (revir?.ticketSubdistricts || []).map(String);
    return { known: Boolean(item), name: item?.name || "", closed: sale.length > 0 && hasNumber(number) && !sale.includes(String(number)) };
  }
  const isClosed = (feature, revir) => feature?.properties?.kind === "subdistrict" && subdistrictInfo(revir, feature.properties.number).closed;

  // Název prvku pro seznamy, popisky a legendu (název podrevíru doplní z nastavení revíru).
  function featureTitle(feature, revir = null) {
    const p = feature.properties || {};
    if (p.kind === "subdistrict") return [hasNumber(p.number) ? `Podrevír ${p.number}` : "Podrevír", p.name || subdistrictInfo(revir, p.number).name].filter(Boolean).join(" – ");
    return p.name || kindLabel(p.kind, feature.geometry?.type);
  }

  // ---------- geometrie ----------
  function positions(feature) {
    const { type, coordinates } = feature.geometry;
    if (type === "Point") return [coordinates];
    if (type === "LineString") return coordinates;
    return coordinates.flat();
  }
  function bounds(features) {
    const all = features.flatMap(positions);
    if (!all.length) return null;
    const lons = all.map((p) => p[0]);
    const lats = all.map((p) => p[1]);
    return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
  }
  // Pořadí kreslení: plochy (revír pod podrevíry), čáry, body.
  const ORDER = { revir: 0, subdistrict: 1, restricted: 2 };
  const sortFeatures = (features) => [...features].sort((a, b) => {
    const rank = (f) => (f.geometry.type === "Polygon" ? ORDER[kindOf(f)] ?? 2 : f.geometry.type === "LineString" ? 10 : 20);
    return rank(a) - rank(b);
  });

  // Položky legendy pro druhy, které mapa obsahuje (pořadí podle KINDS); podrevíry podle toho, zda na ně místenka platí.
  function legendItems(map, revir = null) {
    const seen = new Map();
    const features = map?.features || [];
    const anyClosed = features.some((f) => isClosed(f, revir));
    for (const f of features) {
      const kind = kindOf(f);
      const type = f.geometry.type === "Point" ? "point" : f.geometry.type === "LineString" ? "line" : "area";
      const closed = isClosed(f, revir);
      const key = `${type}:${kind}${closed ? ":closed" : ""}`;
      const label = closed ? "Podrevír – místenka není" : kind === "subdistrict" && anyClosed ? "Podrevír – lze zakoupit místenku" : kindLabel(kind, f.geometry.type);
      if (!seen.has(key)) seen.set(key, { kind, type, closed, label });
    }
    const order = Object.keys(KINDS);
    const typeOrder = { area: 0, line: 1, point: 2 };
    return [...seen.values()].sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || order.indexOf(a.kind) - order.indexOf(b.kind) || a.closed - b.closed);
  }

  // ---------- Leaflet ----------
  const MAPY_BASES = { outdoor: "Turistická", aerial: "Letecká", basic: "Základní", winter: "Zimní" };
  // Podkladové vrstvy: Mapy.com (s API klíčem, logo a copyright povinné), jinak OpenStreetMap.
  // Stránky mají Referrer-Policy: no-referrer, ale dlaždice potřebují Referer: OpenStreetMap bez něj vrací
  // „Access blocked“ a klíč Mapy.com omezený na doménu ho ověřuje. Dlaždicím se proto pošle jen původ webu
  // (https://domena/, bez cesty a parametrů).
  const TILE_REFERRER = "strict-origin";
  function baseLayers(mapTiles = {}) {
    const L = window.L;
    if (mapTiles.provider === "mapy" && mapTiles.apiKey) {
      const attribution = '<a href="https://api.mapy.com/copyright" target="_blank" rel="noreferrer">&copy; Seznam.cz a.s. a další</a>';
      const retina = window.devicePixelRatio > 1;
      return Object.fromEntries(Object.entries(MAPY_BASES).map(([id, label]) => {
        const size = retina && (id === "outdoor" || id === "basic") ? "256@2x" : "256";
        return [id, { label, layer: L.tileLayer(`https://api.mapy.com/v1/maptiles/${id}/${size}/{z}/{x}/{y}?apikey=${encodeURIComponent(mapTiles.apiKey)}`, { minZoom: 3, maxZoom: id === "aerial" ? 20 : 19, attribution, referrerPolicy: TILE_REFERRER }) }];
      }));
    }
    return { osm: { label: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { minZoom: 3, maxZoom: 19, referrerPolicy: TILE_REFERRER, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }) } };
  }
  // Mapa s podkladem, přepínačem podkladu (switcher) a (u Mapy.com) povinným logem.
  function createMap(element, mapTiles, { base = "outdoor", switcher = true, ...options } = {}) {
    const L = window.L;
    const map = L.map(element, { zoomControl: true, attributionControl: true, ...options });
    map.attributionControl.setPrefix(false);
    const layers = baseLayers(mapTiles);
    const ids = Object.keys(layers);
    let current = layers[base] ? base : ids[0];
    layers[current].layer.addTo(map);
    if (mapTiles?.provider === "mapy") {
      const Logo = L.Control.extend({
        options: { position: "bottomleft" },
        onAdd() {
          const link = L.DomUtil.create("a", "mapy-logo");
          link.href = "https://mapy.com/";
          link.target = "_blank";
          link.rel = "noreferrer";
          link.innerHTML = '<img src="https://api.mapy.com/img/api/logo.svg" alt="Mapy.com" height="30">';
          L.DomEvent.disableClickPropagation(link);
          return link;
        }
      });
      new Logo().addTo(map);
    }
    if (switcher && ids.length > 1) {
      const Switch = L.Control.extend({
        options: { position: "topright" },
        onAdd() {
          const box = L.DomUtil.create("div", "map-base-switch");
          box.innerHTML = ids.map((id) => `<button type="button" data-base="${id}" class="${id === current ? "active" : ""}">${layers[id].label}</button>`).join("");
          L.DomEvent.disableClickPropagation(box);
          box.addEventListener("click", (event) => {
            const id = event.target.closest("[data-base]")?.dataset.base;
            if (!id || id === current) return;
            map.removeLayer(layers[current].layer);
            current = id;
            layers[id].layer.addTo(map);
            box.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.base === id));
            map.fire("baselayerchange", { base: id });
          });
          return box;
        }
      });
      new Switch().addTo(map);
    }
    map.currentBase = () => current;
    return map;
  }
  const latlngs = (coords) => coords.map(([lon, lat]) => [lat, lon]);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  function poiIcon(kind, { selected = false } = {}) {
    const k = KINDS[kind] || KINDS.other;
    return window.L.divIcon({ className: "", html: `<span class="map-poi${selected ? " selected" : ""}${k.symbol.length > 1 ? " wide" : ""}" style="background:${k.color}">${esc(k.symbol)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
  }
  // Šrafování (SVG vzor) pro podrevíry, na které místenka neplatí – vloží se do SVG vrstvy mapy při prvním použití.
  const HATCH = "mistenka-hatch";
  function ensureHatch(svg) {
    if (!svg || svg.querySelector(`#${HATCH}`)) return;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `<pattern id="${HATCH}" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="rgba(107,101,96,.12)"/><line x1="0" y1="0" x2="0" y2="9" stroke="#6b6560" stroke-width="3" stroke-opacity=".5"/></pattern>`;
    svg.insertBefore(defs, svg.firstChild);
  }
  function popupHtml(feature, revir = null) {
    const p = feature.properties || {};
    const [lon, lat] = feature.geometry.type === "Point" ? feature.geometry.coordinates : [null, null];
    const nav = lat !== null ? `<a href="${esc(mapyLink(lat, lon, 17))}" target="_blank" rel="noreferrer">Otevřít v Mapy.com ↗</a>` : "";
    const closed = isClosed(feature, revir) ? `<br><span class="map-popup-warning">⚠ ${esc(CLOSED_TEXT)}</span>` : "";
    return `<b>${esc(featureTitle(feature, revir))}</b>${closed}${p.note ? `<br>${esc(p.note)}` : ""}${nav ? `<br>${nav}` : ""}`;
  }
  // Vrstva jednoho prvku (plocha, čára nebo bod) se stylem podle druhu a stavu podrevíru.
  function featureLayer(feature, { selected = false, interactive = true, revir = null } = {}) {
    const L = window.L;
    const kind = kindOf(feature);
    const closed = isClosed(feature, revir);
    const style = closed ? { ...KINDS.subdistrict, ...CLOSED } : KINDS[kind];
    const { type, coordinates } = feature.geometry;
    if (type === "Point") return L.marker([coordinates[1], coordinates[0]], { icon: poiIcon(kind, { selected }), interactive, keyboard: interactive, title: featureTitle(feature, revir), riseOnHover: true });
    const options = { color: style.color, weight: (style.weight || 2) + (selected ? 2 : 0), dashArray: style.dash ? style.dash.join(" ") : null, interactive, lineCap: "round", lineJoin: "round" };
    if (type === "LineString") return L.polyline(latlngs(coordinates), options);
    if (!closed) return L.polygon(coordinates.map(latlngs), { ...options, fillColor: style.fill || style.color, fillOpacity: (style.fillOpacity ?? 0.2) + (selected ? 0.12 : 0) });
    // Leaflet zapíše fillColor rovnou do atributu fill – odkaz na vzor šrafování.
    const layer = L.polygon(coordinates.map(latlngs), { ...options, fillColor: `url(#${HATCH})`, fillOpacity: selected ? 1 : 0.9 });
    layer.on("add", () => ensureHatch(layer._path?.ownerSVGElement));
    return layer;
  }
  // Číslo podrevíru jako trvalý popisek uprostřed plochy (u podrevíru bez místenky šedě).
  function labelSubdistrict(layer, feature, revir) {
    const p = feature.properties || {};
    if (p.kind !== "subdistrict" || !hasNumber(p.number)) return;
    layer.bindTooltip(esc(p.number), { permanent: true, direction: "center", className: `map-label${isClosed(feature, revir) ? " closed" : ""}` });
  }
  // Všechny prvky mapy jako skupina (interaktivní mapa pro rybáře): popupy a popisky podrevírů.
  function featureGroup(map, { revir = null, interactive = true } = {}) {
    const L = window.L;
    const group = L.featureGroup();
    for (const feature of sortFeatures(map?.features || [])) {
      const layer = featureLayer(feature, { revir, interactive });
      if (interactive) layer.bindPopup(popupHtml(feature, revir));
      labelSubdistrict(layer, feature, revir);
      layer.addTo(group);
    }
    return group;
  }
  // Vzorek druhu (legenda, seznam v editoru, nástroje).
  function swatchHtml(kind, type, { closed = false } = {}) {
    const style = KINDS[kind] || KINDS.other;
    if (type === "point") return `<span class="map-poi small${style.symbol.length > 1 ? " wide" : ""}" style="background:${style.color}">${esc(style.symbol)}</span>`;
    if (type === "line") return `<span class="legend-line" style="border-top:3px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`;
    if (closed) return '<span class="legend-area closed"></span>';
    return `<span class="legend-area" style="background:${style.fill || style.color}40;border:2px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`;
  }
  // HTML legenda pro stránku mapy.
  const legendHtml = (map, revir = null) => legendItems(map, revir).map((item) => `<span class="legend-item">${swatchHtml(item.kind, item.type, item)}${esc(item.label)}</span>`).join("");
  // Odkaz na bod v Mapy.com (otevře mapu se značkou na souřadnicích).
  const mapyLink = (lat, lon, zoom = 16) => window.Mistenka.mapyUrl(lat, lon, zoom);

  window.MistenkaMap = { KINDS, GEOMETRY_KINDS, MAPY_BASES, CLOSED_TEXT, kindLabel, featureTitle, subdistrictInfo, isClosed, bounds, sortFeatures, legendItems, baseLayers, createMap, featureLayer, featureGroup, labelSubdistrict, poiIcon, popupHtml, swatchHtml, legendHtml, mapyLink, latlngs };
})();
