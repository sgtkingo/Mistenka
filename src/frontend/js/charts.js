// Přehledové grafy (inline SVG, bez knihovny). Barvy podle role (CSS proměnné .viz-root), jedna osa,
// tenké značky se zaobleným koncem, tooltip při najetí; pod grafy zůstávají tabulky (tabulkové zobrazení).
(function () {
  const { esc } = window.Mistenka;
  const SVG = "http://www.w3.org/2000/svg";
  const renderers = new Map(); // kontejner -> funkce pro překreslení při změně šířky

  // ---------- tooltip ----------
  let tip = null;
  function showTip(event, html) {
    tip ||= Object.assign(document.body.appendChild(document.createElement("div")), { className: "viz-tip", role: "status" });
    tip.innerHTML = html;
    tip.style.display = "block";
    const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.max(8, event.clientY - tip.offsetHeight - 10);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => { if (tip) tip.style.display = "none"; };

  // ---------- pomocné ----------
  // Osa s „hezkým“ krokem (1, 2, 5 × 10^n), 3–6 dílků; niceMax vrací horní mez osy.
  function niceStep(value) {
    const raw = value / 4;
    const exp = 10 ** Math.floor(Math.log10(raw));
    const f = raw / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
  }
  function niceMax(value) {
    if (value <= 0) return 1;
    const step = Math.max(niceStep(value), value < 4 ? 1 : 0);
    return Math.ceil(value / step) * step;
  }
  function ticks(max) {
    const step = Math.max(niceStep(max), max <= 4 ? 1 : 0);
    const out = [];
    for (let t = 0; t <= max + step / 1000; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  }
  // Obdélník se zaobleným koncem dat (4 px), druhý konec rovně na základně.
  function barPath(x, y, w, h, horizontal) {
    if (w <= 0 || h <= 0) return "";
    const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h);
    return horizontal
      ? `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}Z`
      : `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}Z`;
  }
  function svgEl(width, height, label) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    return svg;
  }
  function frame(container, title, legend, draw) {
    const render = () => {
      const width = Math.max(260, container.clientWidth || 600);
      container.innerHTML = `<div class="viz-head"><b>${esc(title)}</b>${legend ? `<div class="viz-legend">${legend.map((l) => `<span><i style="background:var(${l.color})"></i>${esc(l.name)}</span>`).join("")}</div>` : ""}</div>`;
      container.append(draw(width));
      // Tooltip: zásah je celý řádek/sloupec, ne jen tenká značka.
      container.querySelectorAll("[data-tip]").forEach((el) => {
        el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
        el.addEventListener("mouseleave", hideTip);
      });
    };
    renderers.set(container, render);
    render();
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderers.forEach((render, el) => (el.isConnected ? render() : renderers.delete(el))), 150);
  });
  function empty(container, title, text) {
    renderers.delete(container);
    container.innerHTML = `<div class="viz-head"><b>${esc(title)}</b></div><p class="muted">${esc(text)}</p>`;
  }

  // ---------- jedna řada: sloupce (čas) nebo vodorovné pruhy (kategorie) ----------
  function bars(container, { title, items, format, orientation = "vertical", color = "--series-1", emptyText = "Žádná data." }) {
    if (!items.length || items.every((i) => !i.value)) return empty(container, title, emptyText);
    frame(container, title, null, (width) => {
      const max = niceMax(Math.max(...items.map((i) => i.value)));
      if (orientation === "horizontal") {
        const labelW = Math.min(170, width * 0.32);
        const row = 26;
        const height = items.length * row + 28;
        const plotW = width - labelW - 60;
        const svg = svgEl(width, height, title);
        let html = ticks(max).map((t) => { const x = labelW + (t / max) * plotW; return `<line class="viz-grid" x1="${x}" x2="${x}" y1="0" y2="${height - 22}"/><text class="viz-axis" x="${x}" y="${height - 6}" text-anchor="middle">${esc(format(t, true))}</text>`; }).join("");
        items.forEach((item, i) => {
          const y = i * row;
          const w = (item.value / max) * plotW;
          html += `<g data-tip="${esc(`<b>${esc(item.label)}</b><br>${esc(item.title || format(item.value))}`)}"><rect class="viz-hit" x="0" y="${y}" width="${width}" height="${row}"/>
            <text class="viz-label" x="${labelW - 8}" y="${y + row / 2 + 4}" text-anchor="end">${esc(item.label)}</text>
            <path d="${barPath(labelW, y + 6, w, row - 12, true)}" fill="var(${color})"/>
            <text class="viz-value" x="${labelW + w + 6}" y="${y + row / 2 + 4}">${esc(format(item.value))}</text></g>`;
        });
        svg.innerHTML = html;
        return svg;
      }
      const height = 220;
      const left = 54;
      const bottom = 26;
      const plotH = height - bottom - 10;
      const slot = (width - left - 8) / items.length;
      const barW = Math.max(6, Math.min(36, slot * 0.6));
      const svg = svgEl(width, height, title);
      let html = ticks(max).map((t) => { const y = 10 + plotH - (t / max) * plotH; return `<line class="viz-grid" x1="${left}" x2="${width}" y1="${y}" y2="${y}"/><text class="viz-axis" x="${left - 6}" y="${y + 4}" text-anchor="end">${esc(format(t, true))}</text>`; }).join("");
      const every = Math.ceil(items.length / Math.floor((width - left) / 56)); // popisky osy jen tolik, kolik se vejde
      items.forEach((item, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        const h = (item.value / max) * plotH;
        html += `<g data-tip="${esc(`<b>${esc(item.label)}</b><br>${esc(item.title || format(item.value))}`)}"><rect class="viz-hit" x="${left + i * slot}" y="0" width="${slot}" height="${height}"/>
          <path d="${barPath(x, 10 + plotH - h, barW, h, false)}" fill="var(${color})"/>
          ${i % every === 0 ? `<text class="viz-axis" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${esc(item.short || item.label)}</text>` : ""}</g>`;
      });
      html += `<line class="viz-base" x1="${left}" x2="${width}" y1="${10 + plotH}" y2="${10 + plotH}"/>`;
      svg.innerHTML = html;
      return svg;
    });
  }

  // ---------- dvě řady téže jednotky: seskupené vodorovné pruhy ----------
  function grouped(container, { title, categories, series, format, emptyText = "Žádná data." }) {
    if (!categories.length) return empty(container, title, emptyText);
    const colors = ["--series-1", "--series-2"];
    frame(container, title, series.map((s, i) => ({ name: s.name, color: colors[i] })), (width) => {
      const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
      const labelW = Math.min(170, width * 0.32);
      const bar = 10;
      const row = series.length * bar + 2 * (series.length - 1) + 14;
      const height = categories.length * row + 28;
      const plotW = width - labelW - 70;
      const svg = svgEl(width, height, title);
      let html = ticks(max).map((t) => { const x = labelW + (t / max) * plotW; return `<line class="viz-grid" x1="${x}" x2="${x}" y1="0" y2="${height - 22}"/><text class="viz-axis" x="${x}" y="${height - 6}" text-anchor="middle">${esc(format(t, true))}</text>`; }).join("");
      categories.forEach((label, i) => {
        const y = i * row + 7;
        const tipHtml = `<b>${esc(label)}</b>${series.map((s, k) => `<br><i class="viz-swatch" style="background:var(${colors[k]})"></i>${esc(s.name)}: ${esc(format(s.values[i]))}`).join("")}`;
        html += `<g data-tip="${esc(tipHtml)}"><rect class="viz-hit" x="0" y="${i * row}" width="${width}" height="${row}"/>
          <text class="viz-label" x="${labelW - 8}" y="${y + (row - 14) / 2 + 4}" text-anchor="end">${esc(label)}</text>`;
        series.forEach((s, k) => {
          const by = y + k * (bar + 2); // 2px mezera mezi pruhy
          const w = (s.values[i] / max) * plotW;
          html += `<path d="${barPath(labelW, by, w, bar, true)}" fill="var(${colors[k]})"/>`;
        });
        html += "</g>";
      });
      svg.innerHTML = html;
      return svg;
    });
  }

  // ---------- čerpání rozpočtu: nasazeno + plán (skládané) proti rysce rozpočtu ----------
  function budget(container, { title, rows, format }) {
    const used = rows.filter((r) => r.budget || r.spent || r.planned);
    if (!used.length) return empty(container, title, "Zatím bez rozpočtu a nákladů.");
    frame(container, title, [{ name: "Nasazeno", color: "--series-1" }, { name: "Plán", color: "--series-2" }, { name: "Rozpočet", color: "--text-primary" }], (width) => {
      const max = niceMax(Math.max(...used.map((r) => Math.max(r.budget || 0, r.spent + r.planned))));
      const labelW = Math.min(170, width * 0.32);
      const row = 34;
      const height = used.length * row + 28;
      const plotW = width - labelW - 16;
      const svg = svgEl(width, height, title);
      let html = ticks(max).map((t) => { const x = labelW + (t / max) * plotW; return `<line class="viz-grid" x1="${x}" x2="${x}" y1="0" y2="${height - 22}"/><text class="viz-axis" x="${x}" y="${height - 6}" text-anchor="middle">${esc(format(t, true))}</text>`; }).join("");
      used.forEach((r, i) => {
        const y = i * row + 9;
        const h = 16;
        const ws = (r.spent / max) * plotW;
        const wp = (r.planned / max) * plotW;
        const left = r.budget ? r.budget - r.spent - r.planned : null;
        const tipHtml = `<b>${esc(r.label)}</b><br>Nasazeno: ${esc(format(r.spent))}<br>Plán: ${esc(format(r.planned))}<br>Rozpočet: ${r.budget ? esc(format(r.budget)) : "—"}${left !== null ? `<br>${left < 0 ? "Překročeno o" : "Zbývá"}: ${esc(format(Math.abs(left)))}` : ""}`;
        html += `<g data-tip="${esc(tipHtml)}"><rect class="viz-hit" x="0" y="${i * row}" width="${width}" height="${row}"/>
          <text class="viz-label" x="${labelW - 8}" y="${y + h / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
          ${ws ? (wp ? `<rect x="${labelW}" y="${y}" width="${Math.max(0, ws - 1)}" height="${h}" fill="var(--series-1)"/>` : `<path d="${barPath(labelW, y, ws, h, true)}" fill="var(--series-1)"/>`) : ""}
          ${wp ? `<path d="${barPath(labelW + ws + (ws ? 1 : 0), y, Math.max(0, wp - (ws ? 1 : 0)), h, true)}" fill="var(--series-2)"/>` : ""}
          ${r.budget ? `<line class="viz-target${left < 0 ? " over" : ""}" x1="${labelW + (r.budget / max) * plotW}" x2="${labelW + (r.budget / max) * plotW}" y1="${y - 5}" y2="${y + h + 5}"/>` : ""}</g>`;
      });
      svg.innerHTML = html;
      return svg;
    });
  }

  window.MistenkaCharts = { bars, grouped, budget };
})();
