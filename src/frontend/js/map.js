// Mapy revírů: druhy zakreslených prvků, schematický náhled (canvas, bez podkladu – pro e-mail a PDF)
// a vrstvy pro interaktivní mapu a editor (Leaflet, podklad Mapy.com nebo OpenStreetMap).
// Data jsou GeoJSON FeatureCollection (souřadnice [lon, lat]) + view { center: [lat, lon], zoom, base }.
(function () {
  const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
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
  const LINE_LABELS = { restricted: "Zákaz lovu (úsek)" };
  const kindOf = (feature) => KINDS[feature?.properties?.kind] ? feature.properties.kind : "other";
  const kindLabel = (kind, geometry) => (geometry === "LineString" && LINE_LABELS[kind]) || KINDS[kind]?.label || kind;

  // Název prvku pro seznamy, popisky a legendu.
  function featureTitle(feature) {
    const p = feature.properties || {};
    if (p.kind === "subdistrict") return [p.number !== undefined && p.number !== null && p.number !== "" ? `Podrevír ${p.number}` : "Podrevír", p.name].filter(Boolean).join(" – ");
    return p.name || kindLabel(p.kind, feature.geometry?.type);
  }

  // ---------- geometrie (Web Mercator) ----------
  const project = ([lon, lat]) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
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
  // Těžiště plochy (vnější obrys) – kam patří popisek podrevíru.
  function centroid(ring) {
    let area = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const f = x1 * y2 - x2 * y1;
      area += f;
      x += (x1 + x2) * f;
      y += (y1 + y2) * f;
    }
    if (Math.abs(area) < 1e-14) return ring.reduce((acc, p) => [acc[0] + p[0] / ring.length, acc[1] + p[1] / ring.length], [0, 0]);
    return [x / (3 * area), y / (3 * area)];
  }
  // Pořadí kreslení: plochy (revír pod podrevíry), čáry, body.
  const ORDER = { revir: 0, subdistrict: 1, restricted: 2 };
  const sortFeatures = (features) => [...features].sort((a, b) => {
    const rank = (f) => (f.geometry.type === "Polygon" ? ORDER[kindOf(f)] ?? 2 : f.geometry.type === "LineString" ? 10 : 20);
    return rank(a) - rank(b);
  });

  // ---------- schematický náhled (canvas) ----------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function haloText(ctx, text, x, y, { size, weight = 700, color = "#1c1917", align = "center" }) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, size / 4);
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function poiMarker(ctx, kind, x, y, r) {
    const k = KINDS[kind] || KINDS.other;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = k.color;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r / 5);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.round(r * (k.symbol.length > 1 ? 0.78 : 1.05))}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(k.symbol, x, y + r * 0.04);
  }
  // Položky legendy pro druhy, které mapa obsahuje (pořadí podle KINDS).
  function legendItems(map) {
    const seen = new Map();
    for (const f of map?.features || []) {
      const kind = kindOf(f);
      const key = `${f.geometry.type === "Point" ? "point" : f.geometry.type === "LineString" ? "line" : "area"}:${kind}`;
      if (!seen.has(key)) seen.set(key, { kind, type: key.split(":")[0], label: kindLabel(kind, f.geometry.type) });
    }
    const order = Object.keys(KINDS);
    const typeOrder = { area: 0, line: 1, point: 2 };
    return [...seen.values()].sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || order.indexOf(a.kind) - order.indexOf(b.kind));
  }
  function niceDistance(meters) {
    const steps = [5, 10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    return steps.reduce((best, s) => (s <= meters ? s : best), steps[0]);
  }

  // Vykreslí schéma mapy do obdélníku rect = { x, y, w, h }. Vrací převod [lon, lat] → [x, y] (např. pro odkazy).
  function drawSchematic(ctx, map, rect, { legend = true, scale = 1, background = "#eef4f1", emptyText = "Mapa revíru zatím nebyla zakreslena." } = {}) {
    const features = sortFeatures(map?.features || []);
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14 * scale);
    ctx.fillStyle = background;
    ctx.fill();
    ctx.clip();
    const box = bounds(features);
    if (!box) {
      haloText(ctx, emptyText, rect.x + rect.w / 2, rect.y + rect.h / 2, { size: 20 * scale, weight: 600, color: "#6d6862" });
      ctx.restore();
      return null;
    }
    // Rozsah ve Web Mercatoru, okraj 9 % (a místo na legendu dole).
    const [x1, y1] = project([box.west, box.north]);
    const [x2, y2] = project([box.east, box.south]);
    const pad = Math.min(rect.w, rect.h) * 0.09;
    const legendH = legend ? 64 * scale : 0;
    const spanX = Math.max(x2 - x1, 1e-7);
    const spanY = Math.max(y2 - y1, 1e-7);
    const k = Math.min((rect.w - 2 * pad) / spanX, (rect.h - 2 * pad - legendH) / spanY);
    const offX = rect.x + (rect.w - spanX * k) / 2;
    const offY = rect.y + (rect.h - legendH - spanY * k) / 2;
    const toXY = (p) => { const [px, py] = project(p); return [offX + (px - x1) * k, offY + (py - y1) * k]; };
    // Jemná mřížka jako orientace (každých ~80 px).
    ctx.strokeStyle = "rgba(0,0,0,.035)";
    ctx.lineWidth = 1;
    for (let gx = rect.x; gx < rect.x + rect.w; gx += 80 * scale) { ctx.beginPath(); ctx.moveTo(gx, rect.y); ctx.lineTo(gx, rect.y + rect.h); ctx.stroke(); }
    for (let gy = rect.y; gy < rect.y + rect.h; gy += 80 * scale) { ctx.beginPath(); ctx.moveTo(rect.x, gy); ctx.lineTo(rect.x + rect.w, gy); ctx.stroke(); }

    const labels = [];
    for (const f of features) {
      const kind = kindOf(f);
      const style = KINDS[kind];
      if (f.geometry.type === "Polygon") {
        ctx.beginPath();
        for (const ring of f.geometry.coordinates) ring.forEach((p, i) => { const [x, y] = toXY(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath();
        ctx.globalAlpha = style.fillOpacity ?? 0.2;
        ctx.fillStyle = style.fill || style.color;
        ctx.fill("evenodd");
        ctx.globalAlpha = 1;
        ctx.setLineDash((style.dash || []).map((d) => d * scale));
        ctx.lineWidth = (style.weight || 2) * scale;
        ctx.strokeStyle = style.color;
        ctx.stroke();
        ctx.setLineDash([]);
        if (kind === "subdistrict") labels.push({ at: toXY(centroid(f.geometry.coordinates[0])), number: f.properties.number, name: f.properties.name });
        else if (kind === "restricted" && f.properties.name) labels.push({ at: toXY(centroid(f.geometry.coordinates[0])), text: f.properties.name, color: style.color });
      } else if (f.geometry.type === "LineString") {
        ctx.beginPath();
        f.geometry.coordinates.forEach((p, i) => { const [x, y] = toXY(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.setLineDash((style.dash || []).map((d) => d * scale));
        ctx.lineWidth = (style.weight || 3) * scale + (kind === "restricted" ? 1 * scale : 0);
        ctx.strokeStyle = style.color;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const label of labels) {
      const [x, y] = label.at;
      if (label.number !== undefined && label.number !== null && label.number !== "") {
        haloText(ctx, String(label.number), x, y - (label.name ? 9 * scale : 0), { size: 26 * scale, weight: 800, color: "#14532d" });
        if (label.name) haloText(ctx, label.name, x, y + 16 * scale, { size: 14 * scale, weight: 700, color: "#14532d" });
      } else if (label.name) {
        haloText(ctx, label.name, x, y, { size: 15 * scale, weight: 700, color: "#14532d" });
      } else if (label.text) {
        haloText(ctx, label.text, x, y, { size: 14 * scale, weight: 700, color: label.color });
      }
    }
    // Body: nejdřív všechny značky, pak popisky – popisek, který by zakryl jinou značku, se vynechá (vysvětlí legenda).
    const points = features.filter((item) => item.geometry.type === "Point").map((f) => ({ f, at: toXY(f.geometry.coordinates) }));
    for (const { f, at } of points) poiMarker(ctx, kindOf(f), at[0], at[1], 14 * scale);
    ctx.font = `700 ${14 * scale}px ${FONT}`;
    for (const { f, at } of points) {
      const name = f.properties.name;
      if (!name || name === KINDS[kindOf(f)].label) continue;
      const [x, y] = at;
      const left = x + 20 * scale;
      const right = left + ctx.measureText(name).width;
      const blocked = points.some((other) => other.f !== f && other.at[0] + 15 * scale > left && other.at[0] - 15 * scale < right && Math.abs(other.at[1] - y) < 24 * scale);
      if (!blocked && right < rect.x + rect.w - 8 * scale) haloText(ctx, name, left, y, { size: 14 * scale, weight: 700, align: "left" });
    }

    // Měřítko (vlevo dole) a sever (vpravo nahoře).
    const centerLat = (box.north + box.south) / 2;
    const metersPerPx = (Math.cos((centerLat * Math.PI) / 180) * 2 * Math.PI * 6378137) / k;
    const meters = niceDistance(metersPerPx * 140 * scale);
    const barW = meters / metersPerPx;
    const bx = rect.x + 18 * scale;
    const by = rect.y + rect.h - legendH - 22 * scale;
    ctx.fillStyle = "rgba(255,255,255,.85)";
    roundRect(ctx, bx - 8 * scale, by - 22 * scale, barW + 16 * scale, 34 * scale, 6 * scale);
    ctx.fill();
    ctx.fillStyle = "#1c1917";
    ctx.fillRect(bx, by, barW, 4 * scale);
    ctx.fillRect(bx, by - 5 * scale, 2 * scale, 9 * scale);
    ctx.fillRect(bx + barW - 2 * scale, by - 5 * scale, 2 * scale, 9 * scale);
    ctx.font = `600 ${12 * scale}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(meters >= 1000 ? `${meters / 1000} km` : `${meters} m`, bx, by - 8 * scale);
    const nx = rect.x + rect.w - 30 * scale;
    const ny = rect.y + 34 * scale;
    ctx.beginPath();
    ctx.moveTo(nx, ny - 18 * scale);
    ctx.lineTo(nx + 9 * scale, ny + 8 * scale);
    ctx.lineTo(nx, ny + 3 * scale);
    ctx.lineTo(nx - 9 * scale, ny + 8 * scale);
    ctx.closePath();
    ctx.fillStyle = "#1c1917";
    ctx.fill();
    haloText(ctx, "S", nx, ny + 20 * scale, { size: 13 * scale, weight: 800 });

    if (legend) drawLegend(ctx, map, { x: rect.x, y: rect.y + rect.h - legendH, w: rect.w, h: legendH }, scale);
    ctx.restore();
    return toXY;
  }
  function drawLegend(ctx, map, rect, scale) {
    const items = legendItems(map);
    ctx.fillStyle = "rgba(255,255,255,.94)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "rgba(0,0,0,.08)";
    ctx.fillRect(rect.x, rect.y, rect.w, 1);
    let x = rect.x + 18 * scale;
    let y = rect.y + rect.h / 2;
    const rowH = 24 * scale;
    if (items.length > 6) y = rect.y + rect.h / 2 - rowH / 2;
    ctx.font = `600 ${13 * scale}px ${FONT}`;
    for (const item of items) {
      const w = 30 * scale + ctx.measureText(item.label).width + 22 * scale;
      if (x + w > rect.x + rect.w - 10 * scale) { x = rect.x + 18 * scale; y += rowH; }
      const style = KINDS[item.kind];
      if (item.type === "point") poiMarker(ctx, item.kind, x + 9 * scale, y, 9 * scale);
      else if (item.type === "line") {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 20 * scale, y);
        ctx.setLineDash((style.dash || []).map((d) => d * scale));
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = style.color;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.globalAlpha = Math.min(0.6, (style.fillOpacity || 0.2) * 2);
        ctx.fillStyle = style.fill || style.color;
        ctx.fillRect(x, y - 7 * scale, 20 * scale, 14 * scale);
        ctx.globalAlpha = 1;
        ctx.setLineDash((style.dash || []).map((d) => (d * scale) / 2));
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = style.color;
        ctx.strokeRect(x, y - 7 * scale, 20 * scale, 14 * scale);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#1c1917";
      ctx.font = `600 ${13 * scale}px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(item.label, x + 28 * scale, y);
      x += w;
    }
  }
  // Náhled PNG pro e-mail (uloží ho editor spolu s mapou): schéma s legendou a poznámkou.
  function renderPreview(map, { width = 1200, height = 760, title = "" } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    const scale = width / 1000;
    drawSchematic(ctx, map, { x: 0, y: 0, w: width, h: height }, { scale });
    if (title) haloText(ctx, title, 20 * scale, 26 * scale, { size: 18 * scale, weight: 800, align: "left" });
    haloText(ctx, "Schéma revíru – podrobnosti v interaktivní mapě", width - 20 * scale, height - 64 * scale - 14 * scale, { size: 12 * scale, weight: 600, color: "#57534e", align: "right" });
    return canvas;
  }

  // ---------- Leaflet (interaktivní mapa a editor) ----------
  const MAPY_BASES = { outdoor: "Turistická", aerial: "Letecká", basic: "Základní", winter: "Zimní" };
  // Podkladové vrstvy: Mapy.com (s API klíčem, logo a copyright povinné), jinak OpenStreetMap.
  function baseLayers(mapTiles = {}) {
    const L = window.L;
    if (mapTiles.provider === "mapy" && mapTiles.apiKey) {
      const attribution = '<a href="https://api.mapy.com/copyright" target="_blank" rel="noreferrer">&copy; Seznam.cz a.s. a další</a>';
      const retina = window.devicePixelRatio > 1;
      return Object.fromEntries(Object.entries(MAPY_BASES).map(([id, label]) => {
        const size = retina && (id === "outdoor" || id === "basic") ? "256@2x" : "256";
        return [id, { label, layer: L.tileLayer(`https://api.mapy.com/v1/maptiles/${id}/${size}/{z}/{x}/{y}?apikey=${encodeURIComponent(mapTiles.apiKey)}`, { minZoom: 3, maxZoom: id === "aerial" ? 20 : 19, attribution }) }];
      }));
    }
    return { osm: { label: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { minZoom: 3, maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>' }) } };
  }
  // Mapa s podkladem, přepínačem podkladu a (u Mapy.com) povinným logem.
  function createMap(element, mapTiles, { base = "outdoor", ...options } = {}) {
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
    if (ids.length > 1) {
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
  function popupHtml(feature) {
    const p = feature.properties || {};
    const [lon, lat] = feature.geometry.type === "Point" ? feature.geometry.coordinates : [null, null];
    const nav = lat !== null ? `<a href="https://mapy.cz/zakladni?source=coor&id=${encodeURIComponent(lon)}%2C${encodeURIComponent(lat)}&x=${encodeURIComponent(lon)}&y=${encodeURIComponent(lat)}&z=17" target="_blank" rel="noreferrer">Otevřít v Mapy.com ↗</a>` : "";
    return `<b>${esc(featureTitle(feature))}</b>${p.note ? `<br>${esc(p.note)}` : ""}${nav ? `<br>${nav}` : ""}`;
  }
  // Vrstva jednoho prvku (plocha, čára nebo bod) se stylem podle druhu.
  function featureLayer(feature, { selected = false, interactive = true } = {}) {
    const L = window.L;
    const kind = kindOf(feature);
    const style = KINDS[kind];
    const { type, coordinates } = feature.geometry;
    if (type === "Point") return L.marker([coordinates[1], coordinates[0]], { icon: poiIcon(kind, { selected }), interactive, keyboard: interactive, title: featureTitle(feature), riseOnHover: true });
    const options = { color: style.color, weight: (style.weight || 2) + (selected ? 2 : 0), dashArray: style.dash ? style.dash.join(" ") : null, interactive, lineCap: "round", lineJoin: "round" };
    if (type === "LineString") return L.polyline(latlngs(coordinates), options);
    return L.polygon(coordinates.map(latlngs), { ...options, fillColor: style.fill || style.color, fillOpacity: (style.fillOpacity ?? 0.2) + (selected ? 0.12 : 0) });
  }
  // Všechny prvky mapy jako skupina (interaktivní mapa pro rybáře): popupy a popisky podrevírů.
  function featureGroup(map) {
    const L = window.L;
    const group = L.featureGroup();
    for (const feature of sortFeatures(map?.features || [])) {
      const layer = featureLayer(feature);
      layer.bindPopup(popupHtml(feature));
      if (feature.properties?.kind === "subdistrict" && feature.properties.number !== undefined && feature.properties.number !== null && feature.properties.number !== "") {
        layer.bindTooltip(String(feature.properties.number), { permanent: true, direction: "center", className: "map-label" });
      }
      layer.addTo(group);
    }
    return group;
  }
  // HTML legenda pro stránku mapy.
  function legendHtml(map) {
    return legendItems(map).map((item) => {
      const style = KINDS[item.kind];
      const swatch = item.type === "point"
        ? `<span class="map-poi small${style.symbol.length > 1 ? " wide" : ""}" style="background:${style.color}">${esc(style.symbol)}</span>`
        : item.type === "line"
          ? `<span class="legend-line" style="border-top:3px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`
          : `<span class="legend-area" style="background:${style.fill || style.color}40;border:2px ${style.dash ? "dashed" : "solid"} ${style.color}"></span>`;
      return `<span class="legend-item">${swatch}${esc(item.label)}</span>`;
    }).join("");
  }
  // Odkaz na bod v Mapy.com (otevře mapu se značkou na souřadnicích).
  const mapyLink = (lat, lon, zoom = 16) => `https://mapy.cz/zakladni?source=coor&id=${encodeURIComponent(lon)}%2C${encodeURIComponent(lat)}&x=${encodeURIComponent(lon)}&y=${encodeURIComponent(lat)}&z=${zoom}`;

  window.MistenkaMap = { KINDS, GEOMETRY_KINDS, MAPY_BASES, kindLabel, featureTitle, bounds, centroid, legendItems, drawSchematic, renderPreview, baseLayers, createMap, featureLayer, featureGroup, poiIcon, popupHtml, legendHtml, mapyLink, latlngs };
})();
