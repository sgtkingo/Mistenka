// Samostatná stránka revíru s interaktivní mapou (map.html?revir=<id>): název, číslo, lokalita, GPS,
// odkaz na kartu revíru v RIS a mapa se zakreslenými plochami a místy (parkoviště, WC …).
(async function () {
  const { qs, esc, api, loadConfig, selectedRevir, revirUrl, applyBranding, icon } = window.Mistenka;
  const { createMap, featureGroup, legendHtml, mapyLink } = window.MistenkaMap;
  const box = qs("#revirMap");
  try {
    const config = await loadConfig();
    applyBranding?.(config);
    const revir = selectedRevir(config);
    if (!revir) { location.href = "./"; return; }
    document.title = `Mapa revíru · ${revir.name}`;
    qs("#mapTitle").textContent = revir.name;
    qs("#mapSubtitle").textContent = [revir.number && `číslo ${revir.number}`, revir.union, revir.kind].filter(Boolean).join(" · ");
    const home = revirUrl("./", revir, config);
    qs("#homeLink").href = home;
    qs("#backLink").href = home;

    const facts = [];
    if (revir.subdistricts || revir.area) facts.push(["map", "Lokalita", esc([revir.subdistricts, !revir.subdistricts && revir.area].filter(Boolean).join(" · "))]);
    if (revir.gps) facts.push(["water", "GPS", `<a href="${esc(mapyLink(revir.gps.lat, revir.gps.lon))}" target="_blank" rel="noreferrer">${esc(revir.gps.label || `${revir.gps.lat}, ${revir.gps.lon}`)} ↗</a>`]);
    const links = [revir.cardUrl && `<a class="map-link" href="${esc(revir.cardUrl)}" target="_blank" rel="noreferrer">Karta revíru v RIS <span>↗</span></a>`, `<a class="map-link" href="${esc(revirUrl("rules.html", revir, config))}">${icon("doc")}Pravidla revíru <span>→</span></a>`].filter(Boolean);
    qs("#mapFacts").innerHTML = `<div class="detail-list">${facts.map(([ico, title, body]) => `<div><span class="detail-icon">${icon(ico)}</span><span><b>${title}</b><br>${body}</span></div>`).join("")}</div><div class="map-fact-links">${links.join("")}</div>`;

    const { map: data } = await api(`/maps/${encodeURIComponent(revir.id)}`);
    const features = data?.features || [];
    box.innerHTML = "";
    const map = createMap(box, config.mapTiles, { base: data?.view?.base || "outdoor", scrollWheelZoom: true });
    const group = featureGroup(data).addTo(map);
    if (data?.view) map.setView(data.view.center, data.view.zoom);
    else if (features.length) map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 17 });
    else if (revir.gps) map.setView([revir.gps.lat, revir.gps.lon], 15);
    else map.setView([49.8, 15.5], 7);
    // Bez zakreslené mapy aspoň značka na GPS revíru.
    if (!features.length && revir.gps) window.L.marker([revir.gps.lat, revir.gps.lon], { icon: window.MistenkaMap.poiIcon("other"), title: revir.name }).addTo(map).bindPopup(`<b>${esc(revir.name)}</b>`);
    qs("#mapLegend").innerHTML = legendHtml(data);
    qs("#mapNote").textContent = features.length
      ? "Mapa je orientační – závazné jsou údaje v RIS a na kartě revíru. Klepnutím na plochu nebo značku zobrazíte podrobnosti."
      : "Mapa revíru zatím nebyla zakreslena – značka ukazuje GPS revíru. Závazné jsou údaje v RIS a na kartě revíru.";
  } catch (error) {
    box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
})();
