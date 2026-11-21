// Manažerský portál – Zarybnění a Přehledy (B6).
(function () {
  const { qs, qsa, esc, api, showToast, czDate, czk, czDateTime, parseCzDate, loadConfig, attachSpeciesSuggest } = window.Mistenka;
  const charts = window.MistenkaCharts;
  // Formáty hodnot pro grafy: plná hodnota v tooltipu, zkrácená na ose.
  const fmtCount = (v, axis) => (axis ? String(Math.round(v)) : `${Math.round(v)} ks`);
  const fmtKg = (v, axis) => (axis ? `${Math.round(v * 10) / 10}` : `${(Math.round(v * 100) / 100).toLocaleString("cs-CZ")} kg`);
  const fmtKc = (halere, axis) => (axis ? (halere >= 100000 ? `${(halere / 100000).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} tis.` : `${Math.round(halere / 100)}`) : czk(halere));
  // Nejvýš 8 položek, zbytek do „Ostatní“ (jedna řada, žádné barvy navíc).
  function topWithOther(rows, valueOf, labelOf, limit = 8) {
    const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
    const top = sorted.slice(0, limit).map((r) => ({ label: labelOf(r), value: valueOf(r) }));
    const rest = sorted.slice(limit).reduce((sum, r) => sum + valueOf(r), 0);
    if (rest > 0) top.push({ label: "Ostatní", value: rest });
    return top;
  }
  function balanceChart(el, balance, title) {
    const rows = [...balance].sort((a, b) => Math.max(b.caughtKg, b.stockedKg) - Math.max(a.caughtKg, a.stockedKg)).slice(0, 8).filter((b) => b.caughtKg || b.stockedKg);
    charts.grouped(el, { title, categories: rows.map((b) => b.species), series: [{ name: "Nasazeno", values: rows.map((b) => b.stockedKg) }, { name: "Uloveno", values: rows.map((b) => b.caughtKg) }], format: fmtKg, emptyText: "Zatím bez úlovků s hmotností a bez zarybnění." });
  }
  let config = null;
  const short = (iso) => (iso ? `${Number(iso.slice(8))}. ${Number(iso.slice(5, 7))}. ${iso.slice(0, 4)}` : "");
  const MONTHS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];
  const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  const kg = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString("cs-CZ")} kg`;
  const dateInput = (id, label) => {
    const raw = qs(`#${id}`).value.trim();
    const iso = parseCzDate(raw);
    if (!iso) throw new Error(`${label}: zadejte datum ve tvaru den.měsíc.rok.`);
    return iso;
  };
  const revirOptions = (all = true) => `${all ? '<option value="">Všechny revíry</option>' : ""}${config.reviry.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}`;
  async function ensureConfig() { config ||= await loadConfig(); }

  // ---------- zarybnění ----------
  let year = String(new Date().getFullYear());
  let stocking = [];
  async function loadStocking() {
    await ensureConfig();
    const panel = qs("#stockingPanel");
    if (!qs("#stockYear")) {
      panel.innerHTML = `
        <div class="ticket-filters stock-filters"><select id="stockYear"></select><select id="stockRevir">${revirOptions()}</select></div>
        <details class="invite-box" id="stockBox"><summary id="stockSummary">+ Zapsat zarybnění nebo plán</summary>
          <form id="stockForm" novalidate><input type="hidden" id="stId">
            <div class="form-three-col"><div><label class="field-label req" for="stRevir">Revír</label><select id="stRevir">${revirOptions(false)}</select></div><div><label class="field-label" for="stSub">Podrevír</label><select id="stSub"></select></div><div><label class="field-label req" for="stDate">Datum (u plánu předpokládané)</label><input id="stDate" class="date-input" inputmode="numeric" maxlength="10" placeholder="dd.mm.rrrr"></div></div>
            <div class="form-four-col"><div><label class="field-label req" for="stSpecies">Druh</label><div class="fish-field"><input id="stSpecies" autocomplete="off" placeholder="např. kapr"></div></div><div><label class="field-label" for="stAge">Věková kategorie</label><select id="stAge"></select></div><div><label class="field-label req" for="stKg">Hmotnost (kg)</label><input id="stKg" type="number" min="0" step="0.1"></div><div><label class="field-label req" for="stPieces">Počet kusů</label><input id="stPieces" type="number" min="0" step="1"></div></div>
            <div class="form-three-col"><div><label class="field-label" for="stCost">Cena (Kč)</label><input id="stCost" type="number" min="0" step="1"></div><div><label class="field-label" for="stSupplier">Dodavatel</label><input id="stSupplier" maxlength="120"></div><div><label class="field-label" for="stNote">Poznámka</label><input id="stNote" maxlength="500"></div></div>
            <p class="req-legend"><span class="required">*</span> povinné údaje; z hmotnosti a počtu kusů stačí vyplnit jedno.</p>
            <label class="checkbox-label settings-check"><input type="checkbox" id="stPlanned"> <span>Jen plán (zatím nenasazeno)</span></label>
            <div class="resolve-actions"><button class="primary-button" type="submit" id="stSubmit">Uložit</button><button class="text-button" type="button" id="stCancel">Zrušit úpravu</button></div>
          </form></details>
        <div class="viz-root viz-grid-2"><div class="viz-card" id="chartBudget"></div><div class="viz-card" id="chartStocked"></div></div>
        <div id="budgetBox"></div>
        <h2 class="manage-h2">Nasazeno</h2><div id="stockActual"></div>
        <h2 class="manage-h2">Plán zarybnění</h2><div id="stockPlan"></div>
        <h2 class="manage-h2">Uloveno vs. nasazeno <small class="muted-inline">(podklad pro plán, za zvolený rok)</small></h2><div class="viz-root"><div class="viz-card" id="chartStockBalance"></div></div><div id="stockBalance"></div>`;
      const now = new Date().getFullYear();
      qs("#stockYear").innerHTML = [now + 1, now, now - 1, now - 2].map((y) => `<option${String(y) === year ? " selected" : ""}>${y}</option>`).join("");
      qs("#stockYear").addEventListener("change", (e) => { year = e.target.value; refreshStocking(); });
      qs("#stockRevir").addEventListener("change", refreshStocking);
      qs("#stRevir").addEventListener("change", fillRevirFields);
      qs("#stCancel").addEventListener("click", () => editStocking(null));
      qs("#stockForm").addEventListener("submit", saveStocking);
      if (!qs("#stDate").value) qs("#stDate").value = short(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`);
      attachSpeciesSuggest(qs("#stSpecies"), () => (config.reviry.find((r) => r.id === qs("#stRevir").value) || config.reviry[0]).fishRules?.species);
      fillRevirFields();
    }
    refreshStocking();
  }
  function fillRevirFields() {
    const revir = config.reviry.find((r) => r.id === qs("#stRevir").value) || config.reviry[0];
    qs("#stSub").innerHTML = `<option value="">Celý revír</option>${(revir.subdistrictList || []).map((s) => `<option value="${esc(s.number)}">${esc(s.number)} – ${esc(s.name)}</option>`).join("")}`;
  }
  async function refreshStocking() {
    const revirId = qs("#stockRevir").value;
    try {
      const [{ stocking: rows, ageClasses }, budget, stats] = await Promise.all([
        api("/manage/stocking", { query: Object.fromEntries(Object.entries({ year, revirId }).filter(([, v]) => v)) }),
        api("/manage/stocking/budget", { query: { year } }),
        api("/manage/stats", { query: Object.fromEntries(Object.entries({ from: `${year}-01-01`, to: `${year}-12-31`, revirId }).filter(([, v]) => v)) })
      ]);
      stocking = rows;
      if (!qs("#stAge").options.length) qs("#stAge").innerHTML = `<option value="">—</option>${ageClasses.map((a) => `<option>${esc(a)}</option>`).join("")}`;
      const table = (list, plan) => list.length ? `<table class="data-table"><thead><tr><th>${plan ? "Předpoklad" : "Datum"}</th><th>Revír</th><th>Druh</th><th>Kat.</th><th>Množství</th><th>Cena</th><th>Dodavatel</th><th></th></tr></thead><tbody>${list.map((s) => `
        <tr><td data-label="Datum">${esc(short(s.date))}</td><td data-label="Revír">${esc(s.revir)}${s.subdistrict ? ` · ${esc(s.subdistrict)}` : ""}</td><td data-label="Druh"><b>${esc(s.species)}</b></td><td data-label="Kat.">${esc(s.ageClass || "")}</td>
        <td data-label="Množství">${[s.kg !== null ? kg(s.kg) : "", s.pieces !== null ? `${s.pieces} ks` : ""].filter(Boolean).join(" · ")}</td><td data-label="Cena">${s.costHalere !== null ? esc(czk(s.costHalere)) : ""}</td><td data-label="Dodavatel">${esc(s.supplier)}</td>
        <td class="row-actions"><button class="text-button" type="button" data-edit="${s.id}">${plan ? "Upravit / nasadit" : "Upravit"}</button><button class="text-button" type="button" data-delete="${s.id}">Smazat</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné záznamy.</p>';
      qs("#stockActual").innerHTML = table(rows.filter((s) => !s.planned), false);
      qs("#stockPlan").innerHTML = table(rows.filter((s) => s.planned), true);
      qsa("[data-edit]", qs("#stockingPanel")).forEach((b) => b.addEventListener("click", () => editStocking(stocking.find((s) => s.id === Number(b.dataset.edit)))));
      qsa("[data-delete]", qs("#stockingPanel")).forEach((b) => b.addEventListener("click", async () => {
        if (!window.confirm("Smazat záznam zarybnění?")) return;
        try { await api(`/manage/stocking/${b.dataset.delete}`, { method: "DELETE" }); refreshStocking(); } catch (error) { showToast(error.message); }
      }));
      renderBudget(budget);
      qs("#stockBalance").innerHTML = balanceTable(stats.balance);
      charts.budget(qs("#chartBudget"), { title: `Čerpání rozpočtu ${year}`, rows: budget.budgets.filter((b) => !b.total).map((b) => ({ label: b.revir, spent: b.spentHalere, planned: b.plannedHalere, budget: b.amountHalere })), format: fmtKc });
      charts.bars(qs("#chartStocked"), { title: `Nasazeno ${year} podle druhů (kg)`, orientation: "horizontal", items: topWithOther(stats.stocking.bySpecies, (s) => s.kg, (s) => s.species), format: fmtKg, emptyText: "Zatím žádné zarybnění." });
      balanceChart(qs("#chartStockBalance"), stats.balance, "Uloveno vs. nasazeno (kg)");
    } catch (error) { qs("#stockActual").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  function renderBudget(budget) {
    const left = (b) => (b.amountHalere === null ? null : b.amountHalere - b.spentHalere - b.plannedHalere);
    const leftCell = (b) => (left(b) === null ? "—" : `<b class="${left(b) < 0 ? "over-budget" : ""}">${esc(czk(left(b)))}</b>`);
    const rows = budget.budgets.filter((b) => !b.total);
    const total = budget.budgets.find((b) => b.total);
    qs("#budgetBox").innerHTML = `<h2 class="manage-h2">Rozpočet ${esc(budget.year)}</h2><table class="data-table budget-table"><thead><tr><th>Revír</th><th>Rozpočet (Kč)</th><th>Nasazeno</th><th>Plán</th><th>Zbývá</th><th></th></tr></thead><tbody>${rows.map((b) => `
      <tr><td data-label="Revír">${esc(b.revir)}</td><td data-label="Rozpočet"><input class="budget-input" data-revir="${esc(b.revirId)}" type="number" min="0" step="100" value="${b.amountHalere === null ? "" : b.amountHalere / 100}" placeholder="—"></td>
        <td data-label="Nasazeno">${esc(czk(b.spentHalere))}</td><td data-label="Plán">${esc(czk(b.plannedHalere))}</td><td data-label="Zbývá">${leftCell(b)}</td>
        <td><button class="text-button save-budget" type="button" data-revir="${esc(b.revirId)}">Uložit</button></td></tr>`).join("")}</tbody>
      ${total ? `<tfoot><tr class="total-row"><td data-label="Celkem">${esc(total.revir)} <small class="muted-inline">(součet)</small></td><td data-label="Rozpočet">${total.amountHalere === null ? "—" : esc(czk(total.amountHalere))}</td><td data-label="Nasazeno">${esc(czk(total.spentHalere))}</td><td data-label="Plán">${esc(czk(total.plannedHalere))}</td><td data-label="Zbývá">${leftCell(total)}</td><td></td></tr></tfoot>` : ""}</table>`;
    qsa(".save-budget").forEach((b) => b.addEventListener("click", async () => {
      const input = qs(`.budget-input[data-revir="${b.dataset.revir}"]`);
      try { renderBudget(await api("/manage/stocking/budget", { method: "PUT", body: { year: budget.year, revirId: b.dataset.revir, amountCzk: input.value === "" ? null : Number(input.value) } })); showToast("Rozpočet uložen."); } catch (error) { showToast(error.message); }
    }));
  }
  function editStocking(s) {
    qs("#stId").value = s ? s.id : "";
    qs("#stRevir").value = s ? s.revirId : config.reviry[0].id;
    fillRevirFields();
    qs("#stSub").value = s?.subdistrict || "";
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    qs("#stDate").value = short(s?.date || todayIso);
    qs("#stSpecies").value = s?.species || "";
    qs("#stAge").value = s?.ageClass || "";
    qs("#stKg").value = s?.kg ?? "";
    qs("#stPieces").value = s?.pieces ?? "";
    qs("#stCost").value = s?.costHalere != null ? s.costHalere / 100 : "";
    qs("#stSupplier").value = s?.supplier || "";
    qs("#stNote").value = s?.note || "";
    qs("#stPlanned").checked = Boolean(s?.planned);
    qs("#stockSummary").textContent = s ? (s.planned ? "Úprava plánu (pro nasazení zrušte „Jen plán“ a doplňte skutečné údaje)" : "Úprava záznamu") : "+ Zapsat zarybnění nebo plán";
    qs("#stockBox").open = Boolean(s);
    if (s) qs("#stockBox").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function saveStocking(event) {
    event.preventDefault();
    const button = event.submitter;
    try {
      const id = qs("#stId").value;
      const body = { revirId: qs("#stRevir").value, subdistrict: qs("#stSub").value || null, date: dateInput("stDate", "Datum"), species: qs("#stSpecies").value.trim(), ageClass: qs("#stAge").value,
        kg: qs("#stKg").value, pieces: qs("#stPieces").value, costCzk: qs("#stCost").value, supplier: qs("#stSupplier").value.trim(), note: qs("#stNote").value.trim(), planned: qs("#stPlanned").checked };
      button.disabled = true;
      await api(id ? `/manage/stocking/${id}` : "/manage/stocking", { method: id ? "PUT" : "POST", body });
      showToast(body.planned ? "Plán uložen." : "Zarybnění zapsáno.");
      editStocking(null);
      refreshStocking();
    } catch (error) { showToast(error.message); } finally { button.disabled = false; }
  }

  // ---------- přehledy a uzávěrky ----------
  const sign = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
  const balanceTable = (rows) => rows.length ? `<table class="data-table"><thead><tr><th>Druh</th><th>Uloveno</th><th>Nasazeno</th><th>Rozdíl (kg)</th></tr></thead><tbody>${rows.map((b) => `
    <tr><td data-label="Druh"><b>${esc(b.species)}</b></td><td data-label="Uloveno">${esc(b.caughtCount)} ks · ${esc(kg(b.caughtKg))}</td><td data-label="Nasazeno">${b.stockedPieces ? `${esc(b.stockedPieces)} ks · ` : ""}${esc(kg(b.stockedKg))}</td>
    <td data-label="Rozdíl"><b class="bal-${sign(b.balanceKg) || "zero"}">${b.balanceKg > 0 ? "+" : ""}${esc(kg(b.balanceKg))}</b></td></tr>`).join("")}</tbody></table><p class="field-help">Hmotnost úlovků jen z vyplněných nebo dopočtených hodnot – skutečně odebrané množství může být vyšší.</p>` : '<p class="muted">Žádné úlovky ani zarybnění.</p>';
  const catchTable = (rows) => (rows.length ? `<table class="data-table"><thead><tr><th>Druh</th><th>Kusů</th><th>Hmotnost</th><th>Prům. délka</th><th>Max. délka</th></tr></thead><tbody>${rows.map((c) => `<tr><td data-label="Druh"><b>${esc(c.species)}</b></td><td data-label="Kusů">${esc(c.count)}</td><td data-label="Hmotnost">${esc(kg(c.weightKg))}${c.weighed < c.count ? ` <small class="muted-inline">(${esc(c.weighed)}/${esc(c.count)} vážených)</small>` : ""}</td><td data-label="Prům. délka">${esc(c.avgLength)} cm</td><td data-label="Max. délka">${esc(c.maxLength)} cm</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné úlovky.</p>');
  // Úlovky a bilance po podrevírech (když data podrevíry mají), jinak jedna tabulka.
  const grouped = (s, render, whole) => (s.groups?.length ? s.groups.map((g) => `<h4 class="report-group">${esc(g.label)}</h4>${render(g)}`).join("") : whole);
  const seasonPeriod = (x) => `${short(x.opensOn)} – ${x.closesOn ? short(x.closesOn) : "probíhá"}`;
  // Z jaké sezony je přehled: navázaný na sezonu, nebo období (a sezony, do kterých zasahuje).
  const seasonInfo = (s) => (s.season
    ? `<div class="report-season">Sezona <b>${esc(s.season.name)}</b> · ${esc(s.season.revir)} · ${esc(seasonPeriod(s.season))}</div>`
    : `<div class="report-season period">Vlastní období ${esc(short(s.from))} – ${esc(short(s.to))} · ${s.seasons?.length ? `zasahuje do sezon: ${s.seasons.map((x) => `<b>${esc(x.name)}</b> (${esc(x.revir)}, ${esc(seasonPeriod(x))})`).join(", ")}` : "mimo sezony"}</div>`);
  function statsHtml(s, title) {
    const sum = s.summary;
    const tiles = [["Prodané místenky", sum.sold], ["Rybářů", sum.anglers], ["Tržby", czk(sum.revenueHalere)], ["Odevzdané", `${sum.returned}${sum.returnedLate ? ` (${sum.returnedLate} opožděně)` : ""}`], ["Čeká na odevzdání", sum.awaitingReturn ? `${sum.awaitingReturn} (do ${short(sum.returnDeadline)})` : 0], ["Neodevzdané (po lhůtě)", sum.unreturned], ["Úlovky", `${s.catches.total} ks · ${kg(s.catches.weightKg)}`], ["Zarybnění", czk(s.stocking.costHalere)], ["Poukazy · zadržené", `${sum.vouchers} · ${sum.seized}`]];
    // Dokud běží lhůta pro odevzdání, čísla se ještě mohou změnit.
    const pendingNote = sum.awaitingReturn ? `<div class="report-pending no-print">Uzávěrka zatím není konečná – ${sum.awaitingReturn} ${sum.awaitingReturn === 1 ? "místenku" : sum.awaitingReturn < 5 ? "místenky" : "místenek"} lze ještě odevzdat (nejpozději ${esc(short(sum.returnDeadline))}). Úlovky z nich se do čísel promítnou po odevzdání; automatická uzávěrka sezony vzniká až po této lhůtě.</div>` : "";
    // Bilance (zeleně/červeně); ostatní přehledové údaje zůstávají černé.
    const money = sum.revenueHalere - s.stocking.costHalere;
    const fishKg = s.balance.reduce((total, b) => total + b.balanceKg, 0);
    tiles.push(["Finanční bilance", `${money > 0 ? "+" : ""}${czk(money)}`, sign(money), "tržby − náklady na zarybnění"], ["Bilance ryb", `${fishKg > 0 ? "+" : ""}${kg(fishKg)}`, sign(fishKg), "nasazeno − uloveno"]);
    return `<div class="report-head"><div><span class="section-kicker">${esc(s.revir)}</span><h2>${esc(title || s.season?.name || `${short(s.from)} – ${short(s.to)}`)}</h2>${s.seasons ? seasonInfo(s) : ""}<small class="muted-inline">Období ${esc(short(s.from))} – ${esc(short(s.to))} · vytvořeno ${esc(czDateTime(s.generatedAt))}</small></div><button class="secondary-button no-print" type="button" onclick="window.print()">⎙ Tisk / PDF</button></div>
      ${pendingNote}<div class="kpi-grid">${tiles.map(([label, value, tone, hint]) => `<div class="kpi${tone ? ` kpi-${tone}` : ""}"><small>${esc(label)}</small><b>${esc(value)}</b>${hint ? `<em>${esc(hint)}</em>` : ""}</div>`).join("")}</div>
      <div class="viz-root viz-grid-2"><div class="viz-card" data-chart="tickets"></div><div class="viz-card" data-chart="money"></div><div class="viz-card" data-chart="species"></div><div class="viz-card" data-chart="balance"></div></div>
      <h3>Úlovky podle druhů</h3>${grouped(s, (g) => catchTable(g.catches.bySpecies), catchTable(s.catches.bySpecies))}
      ${s.bySubdistrict?.length ? `<h3>Tržby</h3><table class="data-table"><thead><tr><th>Revír</th><th>Podrevír</th><th>Místenky</th><th>Tržby</th><th>Úlovky</th></tr></thead><tbody>${s.bySubdistrict.map((b) => `<tr><td data-label="Revír">${esc(b.revir)}</td><td data-label="Podrevír"><b>${esc(b.label)}</b></td><td data-label="Místenky">${esc(b.tickets)}</td><td data-label="Tržby">${esc(czk(b.revenueHalere))}</td><td data-label="Úlovky">${esc(b.catches)}</td></tr>`).join("")}</tbody></table>` : ""}
      <h3>Uloveno vs. nasazeno</h3>${grouped(s, (g) => balanceTable(g.balance), balanceTable(s.balance))}
      <h3>Po měsících</h3>${s.byMonth.length ? `<table class="data-table"><thead><tr><th>Měsíc</th><th>Místenky</th><th>Úlovky</th><th>Tržby</th><th>Zarybnění</th></tr></thead><tbody>${s.byMonth.map((m) => `<tr><td data-label="Měsíc">${esc(monthName(m.month))}</td><td data-label="Místenky">${esc(m.tickets)}</td><td data-label="Úlovky">${esc(m.catches)}</td><td data-label="Tržby">${esc(czk(m.revenueHalere))}</td><td data-label="Zarybnění">${esc(czk(m.stockingHalere))}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádná data.</p>'}`;
  }
  function renderStatsCharts(s, root) {
    const el = (name) => qs(`[data-chart="${name}"]`, root);
    const months = s.byMonth;
    charts.bars(el("tickets"), { title: "Prodané místenky po měsících", items: months.map((m) => ({ label: monthName(m.month), short: `${Number(m.month.slice(5, 7))}/${m.month.slice(2, 4)}`, value: m.tickets })), format: fmtCount });
    charts.grouped(el("money"), { title: "Tržby a zarybnění po měsících (Kč)", categories: months.map((m) => monthName(m.month)), series: [{ name: "Tržby", values: months.map((m) => m.revenueHalere) }, { name: "Zarybnění", values: months.map((m) => m.stockingHalere) }], format: fmtKc });
    charts.bars(el("species"), { title: "Úlovky podle druhů (ks)", orientation: "horizontal", items: topWithOther(s.catches.bySpecies, (c) => c.count, (c) => c.species), format: fmtCount, emptyText: "Žádné úlovky." });
    balanceChart(el("balance"), s.balance, "Uloveno vs. nasazeno (kg)");
  }
  async function loadReports(reportId) {
    await ensureConfig();
    const panel = qs("#reportsPanel");
    if (!qs("#statsForm")) {
      const y = new Date().getFullYear();
      panel.innerHTML = `
        <form class="stats-filters no-print" id="statsForm" novalidate>
          <div class="stats-row"><span class="stats-label">Vlastní období</span><input id="sFrom" class="date-input" inputmode="numeric" maxlength="10" value="1. 1. ${y}" aria-label="Od"><input id="sTo" class="date-input" inputmode="numeric" maxlength="10" value="31. 12. ${y}" aria-label="Do"><select id="sRevir" aria-label="Revír">${revirOptions()}</select><button class="secondary-button" type="submit">Zobrazit období</button></div>
          <div class="stats-row"><span class="stats-label">Sezona</span><select id="sSeason" aria-label="Sezona"></select><button class="primary-button" type="button" id="saveReport">Uložit jako uzávěrku</button></div>
        </form>
        <div id="statsOut" class="report-body"></div>
        <h2 class="manage-h2 no-print">Uzávěrky</h2><p class="field-help no-print">Po skončení sezony (a lhůty pro odevzdání) se uzávěrka sezony vytvoří automaticky a příjemci upozornění dostanou e-mail. Ruční uzávěrku uložíte za vybranou sezonu, nebo za vlastní období (i přes více sezon).</p><div id="reportList" class="no-print"></div>`;
      await loadSeasonOptions();
      // Přehled je buď za sezonu (výběr), nebo za vlastní období (data nahoře, i přes více sezon); ukládá se ten zobrazený.
      qs("#sSeason").addEventListener("change", () => { statsMode = qs("#sSeason").value ? "season" : "period"; showStats(); });
      qs("#statsForm").addEventListener("submit", (e) => { e.preventDefault(); statsMode = "period"; showStats(); });
      qs("#saveReport").addEventListener("click", async (e) => {
        const button = e.currentTarget;
        try {
          const seasonId = statsMode === "season" ? qs("#sSeason").value : "";
          const seasonName = seasonId ? qs("#sSeason").selectedOptions[0].dataset.name : "";
          const name = window.prompt("Název uzávěrky:", seasonId ? `Uzávěrka – ${seasonName}` : `Uzávěrka ${qs("#sFrom").value} – ${qs("#sTo").value}`);
          if (name === null) return;
          button.disabled = true;
          const body = seasonId ? { name, seasonId: Number(seasonId) } : { name, from: dateInput("sFrom", "Od"), to: dateInput("sTo", "Do"), revirId: qs("#sRevir").value || null };
          const report = await api("/manage/reports", { method: "POST", body });
          showToast("Uzávěrka uložena.");
          listReports();
          showReport(report.id);
        } catch (error) { showToast(error.message); } finally { button.disabled = false; }
      });
    }
    listReports();
    if (reportId) showReport(reportId); else showStats();
  }
  // Výběr přehledu: sezony (výchozí probíhající, jinak nejnovější), nebo vlastní období.
  let statsMode = "season";
  async function loadSeasonOptions() {
    const select = qs("#sSeason");
    let seasons = [];
    try { seasons = (await api("/manage/seasons")).seasons; } catch { /* bez sezon jen vlastní období */ }
    const current = seasons.find((x) => x.state === "open") || seasons[0];
    select.innerHTML = seasons.length ? seasons.map((x) => `<option value="${x.id}" data-name="${esc(x.name)}"${x === current ? " selected" : ""}>${esc(`${x.name} · ${x.revirName} · ${short(x.opensOn)} – ${x.closesOn ? short(x.closesOn) : "probíhá"}`)}</option>`).join("") : '<option value="">Zatím žádná sezona</option>';
    select.disabled = !seasons.length;
    statsMode = seasons.length ? "season" : "period";
  }
  async function showStats() {
    try {
      const seasonId = statsMode === "season" ? qs("#sSeason").value : "";
      const query = seasonId ? { seasonId } : Object.fromEntries(Object.entries({ from: dateInput("sFrom", "Od"), to: dateInput("sTo", "Do"), revirId: qs("#sRevir").value }).filter(([, v]) => v));
      const s = await api("/manage/stats", { query });
      qs("#statsOut").innerHTML = statsHtml(s);
      renderStatsCharts(s, qs("#statsOut"));
    } catch (error) { qs("#statsOut").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  async function listReports() {
    try {
      const { reports } = await api("/manage/reports");
      qs("#reportList").innerHTML = reports.length ? `<table class="data-table"><thead><tr><th>Název</th><th>Sezona</th><th>Revír</th><th>Období</th><th>Typ</th><th>Vytvořeno</th></tr></thead><tbody>${reports.map((r) => `
        <tr class="clickable" data-report="${r.id}"><td data-label="Název"><b>${esc(r.name)}</b></td><td data-label="Sezona">${r.season ? esc(r.season) : '<span class="muted-inline">vlastní období</span>'}</td><td data-label="Revír">${esc(r.revir)}</td><td data-label="Období">${esc(short(r.from))} – ${esc(short(r.to))}</td><td data-label="Typ">${r.kind === "season" ? '<span class="badge badge-info">sezona</span>' : "ruční"}</td><td data-label="Vytvořeno">${esc(czDateTime(r.createdAt))}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Zatím žádné uzávěrky.</p>';
      qsa("[data-report]").forEach((row) => row.addEventListener("click", () => showReport(row.dataset.report)));
    } catch (error) { qs("#reportList").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  async function showReport(id) {
    try {
      const report = await api(`/manage/reports/${id}`);
      qs("#statsOut").innerHTML = `<div class="info-box no-print">Uložená uzávěrka – data ze dne vytvoření. <button class="text-button inline-link" type="button" id="backToStats">Zpět na aktuální přehled</button></div>${statsHtml(report.data, report.name)}`;
      renderStatsCharts(report.data, qs("#statsOut"));
      qs("#backToStats").addEventListener("click", showStats);
      history.replaceState(null, "", `#reports/${id}`);
      qs("#statsOut").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { showToast(error.message); }
  }

  window.MistenkaReports = { loadStocking, loadReports };
})();
