// Samostatná stránka revíru s interaktivní mapou (map.html?revir=<id>): název, číslo, lokalita, GPS,
// odkaz na kartu revíru v RIS a mapa se zakreslenými plochami a místy (parkoviště, WC …). Podrevíry, na které
// místenka podle aktuálního nastavení revíru neplatí, jsou šrafované.
(async function () {
  const { qs, esc, api, loadConfig, selectedRevir, revirUrl, applyBranding, icon } = window.Mistenka;
  const { createMap, featureGroup, legendHtml, mapyLink, subdistrictInfo, popupHtml, latlngs } = window.MistenkaMap;
  const { rodIcon } = window.Mistenka;
  // Střed plochy (těžiště vnějšího obrysu) – GPS podrevíru, když ho nemá v nastavení revíru.
  function centroid(ring) {
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const f = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      a += f; x += (ring[i][0] + ring[i + 1][0]) * f; y += (ring[i][1] + ring[i + 1][1]) * f;
    }
    if (Math.abs(a) < 1e-14) return [ring[0][0], ring[0][1]];
    return [x / (3 * a), y / (3 * a)];
  }
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
    // Podrevíry (seznam se doplní po načtení mapy – GPS ze zakreslené plochy).
    const subs = revir.subdistrictList || [];
    if (subs.length) facts.push(["ticket", "Podrevíry", '<ul class="sub-status-list" id="subList"></ul>']);
    if (revir.gps && !subs.length) facts.push(["water", "GPS", `<a href="${esc(mapyLink(revir.gps.lat, revir.gps.lon))}" target="_blank" rel="noreferrer">${esc(revir.gps.label || `${revir.gps.lat}, ${revir.gps.lon}`)} ↗</a>`]);
    const links = [revir.cardUrl && `<a class="map-link" href="${esc(revir.cardUrl)}" target="_blank" rel="noreferrer">Karta revíru v RIS <span>↗</span></a>`, `<a class="map-link" href="${esc(revirUrl("rules.html", revir, config))}">${icon("doc")}Pravidla revíru <span>→</span></a>`].filter(Boolean);
    qs("#mapFacts").innerHTML = `<div class="detail-list">${facts.map(([ico, title, body]) => `<div><span class="detail-icon">${icon(ico)}</span><span><b>${title}</b><br>${body}</span></div>`).join("")}</div><div class="map-fact-links">${links.join("")}</div>`;

    const { map: data } = await api(`/maps/${encodeURIComponent(revir.id)}`);
    const features = data?.features || [];
    box.innerHTML = "";
    const map = createMap(box, config.mapTiles, { base: data?.view?.base || "outdoor", scrollWheelZoom: true });
    const group = featureGroup(data, { revir }).addTo(map);
    if (data?.view) map.setView(data.view.center, data.view.zoom);
    else if (features.length) map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 17 });
    else if (revir.gps) map.setView([revir.gps.lat, revir.gps.lon], 15);
    else map.setView([49.8, 15.5], 7);
    // Bez zakreslené mapy aspoň značka na GPS revíru.
    if (!features.length && revir.gps) window.L.marker([revir.gps.lat, revir.gps.lon], { icon: window.MistenkaMap.poiIcon("other"), title: revir.name }).addTo(map).bindPopup(`<b>${esc(revir.name)}</b>`);
    qs("#mapLegend").innerHTML = legendHtml(data, revir);
    // Seznam podrevírů: ikona stavu (platí / neplatí podle aktuálního nastavení), název, GPS; klepnutí na název ukáže podrevír v mapě.
    if (subs.length) {
      const featureOf = (number) => features.find((f) => f.properties?.kind === "subdistrict" && String(f.properties.number) === String(number));
      const list = qs("#subList");
      list.innerHTML = subs.map((s, i) => {
        const closed = subdistrictInfo(revir, s.number).closed;
        const f = featureOf(s.number);
        const gps = window.Mistenka.hasGps(s.gps) ? s.gps : f ? (([lon, lat]) => ({ lat, lon }))(centroid(f.geometry.coordinates[0])) : null;
        const title = esc([s.number, s.name].filter(Boolean).join(" – "));
        return `<li class="${closed ? "closed" : "open"}">${rodIcon(closed)}<span><b>${f ? `<button type="button" class="text-button sub-show" data-i="${i}">${title}</button>` : title}</b>
          <small class="sub-state">${closed ? "Na tomto podrevíru místenka není!" : "Na tento podrevír lze zakoupit místenku"}</small>
          ${gps ? `<small>GPS ${window.Mistenka.gpsLink(gps, 17)}</small>` : ""}</span></li>`;
      }).join("");
      list.querySelectorAll(".sub-show").forEach((button) => button.addEventListener("click", () => {
        const f = featureOf(subs[Number(button.dataset.i)].number);
        const ring = latlngs(f.geometry.coordinates[0]);
        map.fitBounds(ring, { padding: [40, 40], maxZoom: 18 });
        const [lon, lat] = centroid(f.geometry.coordinates[0]);
        window.L.popup().setLatLng([lat, lon]).setContent(popupHtml(f, revir)).openOn(map);
        box.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
    }
    qs("#mapNote").textContent = features.length
      ? "Mapa je orientační – závazné jsou údaje v RIS a na kartě revíru. Klepnutím na plochu nebo značku zobrazíte podrobnosti."
      : "Mapa revíru zatím nebyla zakreslena – značka ukazuje GPS revíru. Závazné jsou údaje v RIS a na kartě revíru.";
  } catch (error) {
    box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
})();
