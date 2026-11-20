// Manažerský portál – Nastavení (B5): organizace, revíry, ryby a limity, platby. Každé uložení = nová verze.
(function () {
  const { qs, qsa, esc, api, showToast, czDateTime, loadSession, hasRole } = window.Mistenka;
  let view = null;
  let tab = "organization";
  let mode = "settings"; // settings = organizace, ryby, platby; reviry = jednotlivé revíry
  let isAdmin = false;

  const val = (id) => qs(`#${id}`)?.value.trim() ?? "";
  const num = (id, label, { int = true, optional = false } = {}) => {
    const raw = val(id).replace(",", ".");
    if (raw === "" && optional) return null;
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || (int && !Number.isInteger(n))) throw new Error(`${label}: zadejte ${int ? "celé " : ""}číslo.`);
    return n;
  };
  const REQUIRED_FIELDS = new Set(["oShort", "pcChars", "prTickets", "prAccounting", "prEmails", "prAudit", "prBackups", "lpCount", "pAccount", "pBank", "pReservation", "rName", "rPrice", "rCapacity", "rAhead", "rLate", "nId", "nName", "nPrice", "nCapacity", "nAhead", "nLate"]);
  const field = (id, label, value, attrs = "") => `<div><label class="field-label${REQUIRED_FIELDS.has(id) ? " req" : ""}" for="${id}">${label}</label><input id="${id}" value="${esc(value ?? "")}" ${attrs}></div>`;
  const area = (id, label, value, rows = 3) => `<label class="field-label" for="${id}">${label}</label><textarea id="${id}" rows="${rows}">${esc(value ?? "")}</textarea>`;
  // Doba hájení: uloženo MM-DD, zobrazeno d.m.–d.m.; více období oddělených středníkem.
  const seasonsToText = (list) => (list || []).map(({ from, to }) => `${Number(from.slice(3))}.${Number(from.slice(0, 2))}.–${Number(to.slice(3))}.${Number(to.slice(0, 2))}.`).join("; ");
  function textToSeasons(text, name) {
    if (!text.trim()) return undefined;
    return text.split(";").map((part) => {
      const m = part.trim().match(/^(\d{1,2})\.\s*(\d{1,2})\.?\s*[–-]\s*(\d{1,2})\.\s*(\d{1,2})\.?$/);
      if (!m) throw new Error(`${name}: dobu hájení zapište jako 1.1.–15.6. (více období oddělte středníkem).`);
      const md = (d, mo) => `${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return { from: md(m[1], m[2]), to: md(m[3], m[4]) };
    });
  }

  function meta(part) {
    return part.source === "database" ? `Upraveno ${esc(czDateTime(part.updatedAt))}${part.updatedBy ? ` · ${esc(part.updatedBy)}` : ""} · verze #${esc(part.version)}` : "Výchozí hodnoty ze souboru";
  }
  // Společná patička: poznámka, uložit, historie, výchozí hodnoty, JSON (admin).
  function footer(scope, part, { canEdit = true } = {}) {
    return `<p class="req-legend"><span class="required">*</span> povinné údaje</p><div class="settings-footer">
      ${canEdit ? `<input id="settingsNote" maxlength="200" placeholder="Poznámka ke změně (volitelné)"><button class="primary-button" type="submit">Uložit</button>` : ""}
      <span class="muted-inline">${meta(part)}</span></div>
      <div class="settings-tools"><button class="text-button" type="button" data-history="${esc(scope)}">Historie změn</button>
      ${canEdit && part.source === "database" ? `<button class="text-button" type="button" data-reset="${esc(scope)}">Obnovit výchozí ze souboru</button>` : ""}
      ${canEdit && isAdmin ? `<button class="text-button" type="button" data-json="${esc(scope)}">Upravit jako JSON</button>` : ""}</div>
      <div class="settings-history" id="settingsHistory"></div>`;
  }

  // Formuláře se vykreslují do jednoho panelu, který se přesune do aktivní sekce (Revíry / Nastavení).
  async function load(initialTab, nextMode = "settings") {
    mode = nextMode;
    const host = qs(`.settings-host[data-host="${mode}"]`);
    host.append(qs("#settingsTabs"), qs("#settingsPanel"));
    const panel = qs("#settingsPanel");
    const inMode = (key) => (mode === "reviry" ? key.startsWith("revir:") || key === "new-revir" : !key.startsWith("revir:") && key !== "new-revir");
    if (initialTab && inMode(initialTab)) tab = initialTab;
    else if (!inMode(tab)) tab = mode === "reviry" ? "" : "organization";
    try {
      isAdmin = hasRole(await loadSession(), "admin");
      view = await api("/manage/settings");
      renderTabs();
      render();
    } catch (error) { panel.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  function renderTabs() {
    const tabs = mode === "reviry"
      ? [...view.reviry.map((r) => [`revir:${r.id}`, r.data.name]), ["new-revir", "+ Nový revír"]]
      : [["organization", "Organizace"], ["species", "Ryby a limity"], ["payment", "Platby"]];
    if (!tabs.some(([key]) => key === tab)) tab = tabs[0][0];
    qs("#settingsTabs").innerHTML = tabs.map(([key, label]) => `<button type="button" class="tab${key === tab ? " active" : ""}" data-tab="${esc(key)}">${esc(label)}</button>`).join("");
    qsa("#settingsTabs .tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; renderTabs(); render(); }));
  }
  function render() {
    const panel = qs("#settingsPanel");
    if (tab === "organization") panel.innerHTML = organizationForm();
    else if (tab === "payment") panel.innerHTML = paymentForm();
    else if (tab === "species") panel.innerHTML = speciesForm();
    else if (tab === "new-revir") panel.innerHTML = newRevirForm();
    else panel.innerHTML = revirForm(view.reviry.find((r) => `revir:${r.id}` === tab));
    bindCommon();
  }

  // ---------- organizace ----------
  function organizationForm() {
    const d = view.organization.data;
    const o = d.organization || {};
    const c = o.contact || {};
    const lp = d.limitPolicy || {};
    const pc = d.publicCheck || {};
    return `<form class="settings-form" data-scope="organization" novalidate>
      <h3>Organizace</h3>
      <div class="form-two-col">${field("oName", "Celý název", o.name)}${field("oShort", "Zkratka", o.shortName)}</div>
      <div class="form-two-col">${field("oWeb", "Web", o.web)}${field("oPrivacy", "Vlastní stránka zásad (prázdné = privacy.html)", o.privacyUrl)}</div>
      <div class="form-two-col">${field("oAddress", "Sídlo (pro zásady zpracování)", o.address)}${field("oIco", "IČO", o.ico)}</div>
      <h3>Kontakty</h3>
      <div class="form-two-col">${field("cLabel", "Kontakt – popisek", c.label)}${field("cPhone", "Telefon", c.phone)}</div>
      <div class="form-two-col">${field("cEmail", "Veřejný e-mail", c.email, 'type="email"')}${field("oManager", "E-mail správce (upozornění: zadržení, limity)", o.managerEmail, 'type="email"')}</div>
      <h3>Výchozí odesílatel automatických e-mailů</h3>
      <div class="form-two-col">${field("eName", "Jméno odesílatele", d.email?.fromName, 'placeholder="Místenka – MO Karviná"')}${field("eEmail", "Adresa odesílatele", d.email?.fromEmail, 'type="email" placeholder="mistenka@…"')}</div>
      <p class="field-help">Použije se pro e-maily, kterým není přiřazen poštovní účet v sekci <b>Admin → Emailoví klienti</b>. Adresa musí patřit k poštovnímu účtu, přes který server odesílá (jinak skončí ve spamu). Na tyto e-maily se neodpovídá – kontakt pro rybáře je výše.</p>
      <h3>Veřejná kontrola místenky</h3>
      <div class="form-two-col"><div><label class="checkbox-label settings-check"><input type="checkbox" id="pcFull"${pc.showFullName !== false ? " checked" : ""}> <span>Zobrazit celé příjmení</span></label></div>${field("pcChars", "Viditelné číslice legitimace", pc.memberIdVisibleChars ?? 4, 'type="number" min="0" max="8"')}</div>
      <h3>Ochrana osobních údajů – lhůty uchování <a class="text-link" href="privacy.html" target="_blank">zobrazit zásady ↗</a></h3>
      <div class="form-three-col">${field("prEmail", "E-mail pro žádosti subjektů údajů", d.privacy?.contactEmail, 'type="email"')}${field("prTickets", "Místenky (roky po roce lovu)", d.privacy?.ticketYears ?? 3, 'type="number" min="1" max="20"')}${field("prAccounting", "Platby – účetní lhůta (roky)", d.privacy?.accountingYears ?? 10, 'type="number" min="5" max="20"')}</div>
      <div class="form-three-col">${field("prEmails", "Odeslané e-maily (dny)", d.privacy?.emailDays ?? 90, 'type="number" min="7"')}${field("prAudit", "Audit (roky)", d.privacy?.auditYears ?? 5, 'type="number" min="1" max="20"')}${field("prBackups", "Zálohy (roky)", d.privacy?.backupYears ?? 3, 'type="number" min="1" max="20"')}</div>
      <p class="field-help">Po uplynutí lhůt se údaje automaticky anonymizují nebo smažou. Výchozí hodnoty jsou obecné doporučení; potvrďte je ve výboru.</p>
      <p class="field-help">Pravidla automatické blokace (limity, pozdní odevzdání, zadržení) nastavíte v sekci <a class="text-link" href="#limits" onclick="document.querySelector('[data-section=limits]').click();return false">Limity a blokace</a>.</p>
      ${footer("organization", view.organization)}</form>`;
  }
  function organizationData() {
    const d = structuredClone(view.organization.data);
    d.privacy = { contactEmail: val("prEmail"), ticketYears: num("prTickets", "Místenky"), accountingYears: num("prAccounting", "Účetní lhůta"), emailDays: num("prEmails", "E-maily"), auditYears: num("prAudit", "Audit"), backupYears: num("prBackups", "Zálohy") };
    d.organization = { ...d.organization, name: val("oName"), shortName: val("oShort"), web: val("oWeb"), privacyUrl: val("oPrivacy"), address: val("oAddress"), ico: val("oIco"), managerEmail: val("oManager"), contact: { ...(d.organization?.contact || {}), label: val("cLabel"), email: val("cEmail"), phone: val("cPhone") } };
    d.email = { ...(d.email || {}), fromName: val("eName"), fromEmail: val("eEmail") };
    d.publicCheck = { showFullName: qs("#pcFull").checked, memberIdVisibleChars: num("pcChars", "Viditelné číslice") };
    return d;
  }

  // ---------- platby ----------
  function paymentForm() {
    const p = view.payment.data;
    const ro = view.canEditPayment ? "" : "disabled";
    return `<form class="settings-form" data-scope="payment" novalidate>
      <h3>Platební údaje</h3>
      <div class="${view.canEditPayment ? "info-box" : "status-error"}">${view.canEditPayment ? "Změnu účtu dostanou e-mailem všichni admini. Nové objednávky se budou platit na nový účet, rozpracované zůstávají na původním." : "Platební údaje smí měnit jen admin."}</div>
      <div class="form-two-col">${field("pAccount", "Číslo účtu (s předčíslím: 19-123456789)", p.accountNumber, ro)}${field("pBank", "Kód banky", p.bankCode, `${ro} maxlength="4"`)}</div>
      <p class="field-help">IBAN: <b>${esc(view.payment.iban)}</b> · zdroj plateb: <b>${esc(view.payment.provider)}</b> (mění se jen v konfiguraci serveru)</p>
      <div class="form-two-col">${field("pRecipient", "Příjemce (do QR platby, bez diakritiky)", p.recipientName, ro)}${field("pMessage", "Zpráva pro příjemce – předpona", p.messagePrefix, ro)}</div>
      <div class="form-two-col">${field("pReservation", "Rezervace místa před platbou (minuty)", p.reservationMinutes, `${ro} type="number" min="10" max="1440"`)}<div></div></div>
      ${footer("payment", view.payment, { canEdit: view.canEditPayment })}</form>`;
  }
  const paymentData = () => ({ accountNumber: val("pAccount"), bankCode: val("pBank"), recipientName: val("pRecipient"), messagePrefix: val("pMessage"), reservationMinutes: num("pReservation", "Rezervace") });

  // ---------- revír ----------
  function revirForm(r) {
    const d = r.data;
    const subs = d.subdistrictList || [];
    const ticketSubs = (d.ticketSubdistricts || []).map(String);
    return `<form class="settings-form" data-scope="revir:${esc(r.id)}" novalidate>
      <h3>Revír <small class="muted-inline">${esc(r.id)}</small></h3>
      <div class="form-two-col">${field("rName", "Název", d.name)}${field("rNumber", "Číslo revíru", d.number)}</div>
      <div class="form-two-col">${field("rUnion", "Územní svaz", d.union)}${field("rKind", "Druh revíru", d.kind)}</div>
      <h3>Prodej</h3>
      <div class="form-four-col">${field("rPrice", "Cena za den (Kč)", d.priceCzk, 'type="number" min="0" step="1"')}${field("rCapacity", "Míst na den", d.dailyCapacity, 'type="number" min="1"')}${field("rAhead", "Prodej dní dopředu", d.bookingDaysAhead, 'type="number" min="0" max="60"')}${field("rLate", "Opožděné odevzdání (dní)", d.lateReturnDays, 'type="number" min="0" max="60"')}</div>
      <p class="field-help">Změna ceny platí pro nové objednávky; vystavené místenky si cenu pamatují.</p>
      <h3>Voda a podrevíry</h3>
      <div class="form-two-col">${field("rArea", "Výměra (např. 4,8 ha)", d.area)}${field("rSubText", "Popis podrevírů", d.subdistricts)}</div>
      <table class="data-table edit-table" id="subTable"><thead><tr><th>Č.</th><th>Název</th><th>Výměra</th><th>Platí místenka</th><th></th></tr></thead><tbody>${subs.map((s, i) => subRow(s, ticketSubs.includes(String(s.number)), i)).join("")}</tbody></table>
      <button class="text-button" type="button" id="addSub">+ Podrevír</button>
      <div class="form-three-col">${field("rLat", "GPS šířka", d.gps?.lat)}${field("rLon", "GPS délka", d.gps?.lon)}${field("rGpsLabel", "GPS popisek", d.gps?.label)}</div>
      ${field("rCard", "Karta revíru (odkaz)", d.cardUrl)}
      <h3>Doba lovu</h3>
      <table class="data-table edit-table" id="hoursTable"><thead><tr><th>Měsíce (čísla)</th><th>Od</th><th>Do</th><th>Popisek</th><th></th></tr></thead><tbody>${(d.fishingHours || []).map(hoursRow).join("")}</tbody></table>
      <button class="text-button" type="button" id="addHours">+ Období</button>
      <h3>Texty pro rybáře</h3>
      ${area("rPermit", "Upozornění před nákupem", d.permitNote, 2)}
      ${area("rRestrictions", "Omezení (v detailu revíru)", d.restrictions, 2)}
      <h3>Pravidla revíru <small class="muted-inline">(každý řádek = jedna odrážka)</small></h3>
      <div id="rulesSections">${(d.rules || []).map(ruleSection).join("")}</div>
      <button class="text-button" type="button" id="addRule">+ Oddíl pravidel</button>
      ${footer(`revir:${r.id}`, r)}</form>`;
  }
  const subRow = (s = {}, active = false) => `<tr><td><input class="sub-number" value="${esc(s.number ?? "")}" size="2"></td><td><input class="sub-name" value="${esc(s.name ?? "")}"></td><td><input class="sub-area" value="${esc(s.area ?? "")}" placeholder="0,9 ha"></td><td><input type="checkbox" class="sub-ticket"${active ? " checked" : ""}></td><td><button class="text-button remove-row" type="button">✕</button></td></tr>`;
  const hoursRow = (h = {}) => `<tr><td><input class="h-months" value="${esc((h.months || []).join(", "))}" placeholder="4, 5, 6"></td><td><input class="h-from" value="${esc(h.from ?? "")}" placeholder="04:00" size="5"></td><td><input class="h-to" value="${esc(h.to ?? "")}" placeholder="24:00" size="5"></td><td><input class="h-label" value="${esc(h.label ?? "")}"></td><td><button class="text-button remove-row" type="button">✕</button></td></tr>`;
  const ruleSection = (s = {}) => `<div class="rule-section"><input class="rule-title" value="${esc(s.title ?? "")}" placeholder="Nadpis oddílu"><textarea class="rule-items" rows="4">${esc((s.items || []).join("\n"))}</textarea><button class="text-button remove-section" type="button">Odebrat oddíl</button></div>`;
  function revirData(r) {
    const d = structuredClone(r.data);
    Object.assign(d, { name: val("rName"), number: val("rNumber"), union: val("rUnion"), kind: val("rKind"), priceCzk: num("rPrice", "Cena", { int: false }), dailyCapacity: num("rCapacity", "Míst na den"), bookingDaysAhead: num("rAhead", "Prodej dopředu"), lateReturnDays: num("rLate", "Opožděné odevzdání"),
      area: val("rArea"), subdistricts: val("rSubText"), cardUrl: val("rCard"), permitNote: val("rPermit"), restrictions: val("rRestrictions") });
    const subs = qsa("#subTable tbody tr").map((tr) => ({ number: Number(qs(".sub-number", tr).value) || qs(".sub-number", tr).value.trim(), name: qs(".sub-name", tr).value.trim(), area: qs(".sub-area", tr).value.trim(), ticket: qs(".sub-ticket", tr).checked }));
    const previous = new Map((r.data.subdistrictList || []).map((s) => [String(s.number), s]));
    d.subdistrictList = subs.filter((s) => s.name || s.number).map(({ ticket, ...s }) => ({ ...(previous.get(String(s.number)) || {}), ...s }));
    d.subdistrictCount = d.subdistrictList.length;
    const ticketSubs = subs.filter((s) => s.ticket).map((s) => s.number);
    if (ticketSubs.length) d.ticketSubdistricts = ticketSubs; else delete d.ticketSubdistricts;
    if (val("rLat") || val("rLon")) d.gps = { lat: num("rLat", "GPS šířka", { int: false }), lon: num("rLon", "GPS délka", { int: false }), label: val("rGpsLabel") }; else delete d.gps;
    d.fishingHours = qsa("#hoursTable tbody tr").map((tr) => ({ months: qs(".h-months", tr).value.split(/[,\s]+/).filter(Boolean).map(Number), from: qs(".h-from", tr).value.trim(), to: qs(".h-to", tr).value.trim(), label: qs(".h-label", tr).value.trim() }))
      .filter((h) => h.months.length);
    if (d.fishingHours.some((h) => h.months.some((m) => !(m >= 1 && m <= 12)) || !/^\d{2}:\d{2}$/.test(h.from) || !/^\d{2}:\d{2}$/.test(h.to))) throw new Error("Doba lovu: měsíce 1–12, čas ve tvaru 04:00.");
    d.rules = qsa(".rule-section").map((s) => ({ title: qs(".rule-title", s).value.trim(), items: qs(".rule-items", s).value.split("\n").map((l) => l.trim()).filter(Boolean) })).filter((s) => s.title || s.items.length);
    return d;
  }
  function newRevirForm() {
    return `<form class="settings-form" data-scope="new-revir" novalidate>
      <h3>Nový revír</h3><p class="field-help">Identifikátor se ukládá k místenkám a později ho nelze změnit (a–z, 0–9, pomlčka). Ostatní údaje doplníte po vytvoření.</p>
      <div class="form-two-col">${field("nId", "Identifikátor", "", 'placeholder="napr-olse-2"')}${field("nName", "Název", "")}</div>
      <div class="form-four-col">${field("nPrice", "Cena za den (Kč)", "200", 'type="number"')}${field("nCapacity", "Míst na den", "30", 'type="number"')}${field("nAhead", "Prodej dní dopředu", "3", 'type="number"')}${field("nLate", "Opožděné odevzdání (dní)", "7", 'type="number"')}</div>
      <button class="primary-button" type="submit">Vytvořit revír</button></form>`;
  }

  // ---------- ryby a limity ----------
  let speciesRef = null;
  function speciesForm() {
    const docs = view.species;
    speciesRef = docs.some((s) => s.ref === speciesRef) ? speciesRef : docs[0]?.ref;
    const part = docs.find((s) => s.ref === speciesRef);
    const d = part.data;
    const limitRows = (list, kind) => (list || []).map((l, i) => `<tr><td>${esc(l.label)}${l.maxAreaHa ? ` <small class="muted-inline">(do ${esc(l.maxAreaHa)} ha)</small>` : ""}</td><td>${kind === "day" ? "den" : l.period === "week" ? "týden" : "měsíc"}</td><td><input class="limit-max" data-kind="${kind}" data-index="${i}" type="number" min="1" value="${esc(l.maxCount)}" size="3"></td><td><small class="muted-inline">${esc(l.source || "")}</small></td></tr>`).join("");
    return `<form class="settings-form" data-scope="species:${esc(part.ref)}" novalidate>
      ${docs.length > 1 ? `<label class="field-label" for="speciesSelect">Pravidla</label><select id="speciesSelect">${docs.map((s) => `<option value="${esc(s.ref)}"${s.ref === speciesRef ? " selected" : ""}>${esc(s.data.name || s.ref)}</option>`).join("")}</select>` : ""}
      <h3>${esc(d.name || part.ref)}</h3><p class="field-help">Platí ${esc(d.validFrom || "?")} – ${esc(d.validTo || "?")}. Změny se uplatní hned při dalších odevzdáních; místenka si pamatuje verzi pravidel, podle které byla zkontrolována.</p>
      <h3>Limity úlovků</h3>
      <table class="data-table edit-table"><thead><tr><th>Druhy</th><th>Období</th><th>Max. ks</th><th>Zdroj</th></tr></thead><tbody>${limitRows(d.dailyLimits, "day")}${limitRows(d.periodLimits, "period")}</tbody></table>
      <h3>Druhy ryb <small class="muted-inline">(prázdné = bez omezení)</small></h3>
      <div class="table-scroll"><table class="data-table edit-table species-table"><thead><tr><th>Druh</th><th>Lovná míra (cm)</th><th>Vrátit od (cm)</th><th>Doba hájení</th><th>Koef. hmotnosti</th></tr></thead><tbody>${d.species.map((s, i) => `
        <tr data-index="${i}"><td><b>${esc(s.name)}</b>${s.invasive ? ' <small class="muted-inline">invazní</small>' : ""}</td><td><input class="sp-min" type="number" min="0" value="${esc(s.minLength ?? "")}" size="3"></td><td><input class="sp-release" type="number" min="0" value="${esc(s.releaseFromLength ?? "")}" size="3"></td>
        <td><input class="sp-seasons" value="${esc(seasonsToText(s.closedSeasons))}" placeholder="1.1.–15.6."></td><td><input class="sp-factor" type="number" min="0" step="0.05" value="${esc(s.weightFactor ?? "")}" size="4"></td></tr>`).join("")}</tbody></table></div>
      ${footer(`species:${part.ref}`, part)}</form>`;
  }
  function speciesData() {
    const d = structuredClone(view.species.find((s) => s.ref === speciesRef).data);
    const optionalNumber = (input, label) => { const raw = input.value.trim().replace(",", "."); if (!raw) return undefined; const n = Number(raw); if (!(n >= 0)) throw new Error(`${label}: neplatné číslo.`); return n; };
    qsa(".species-table tbody tr").forEach((tr) => {
      const s = d.species[Number(tr.dataset.index)];
      for (const [cls, key, label] of [["sp-min", "minLength", "lovná míra"], ["sp-release", "releaseFromLength", "vrátit od"], ["sp-factor", "weightFactor", "koeficient"]]) {
        const value = optionalNumber(qs(`.${cls}`, tr), `${s.name} – ${label}`);
        if (value === undefined) delete s[key]; else s[key] = value;
      }
      const seasons = textToSeasons(qs(".sp-seasons", tr).value, s.name);
      if (seasons) s.closedSeasons = seasons; else delete s.closedSeasons;
    });
    qsa(".limit-max").forEach((input) => {
      const list = input.dataset.kind === "day" ? d.dailyLimits : d.periodLimits;
      list[Number(input.dataset.index)].maxCount = Number(input.value);
    });
    return d;
  }

  // ---------- uložení, historie, JSON ----------
  function bindCommon() {
    const form = qs("#settingsPanel form");
    qs("#speciesSelect")?.addEventListener("change", (e) => { speciesRef = e.target.value; render(); });
    qs("#addSub")?.addEventListener("click", () => qs("#subTable tbody").insertAdjacentHTML("beforeend", subRow()));
    qs("#addHours")?.addEventListener("click", () => qs("#hoursTable tbody").insertAdjacentHTML("beforeend", hoursRow()));
    qs("#addRule")?.addEventListener("click", () => qs("#rulesSections").insertAdjacentHTML("beforeend", ruleSection()));
    form.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-row")) e.target.closest("tr").remove();
      if (e.target.classList.contains("remove-section")) e.target.closest(".rule-section").remove();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const scope = form.dataset.scope;
      const button = event.submitter;
      try {
        let request;
        if (scope === "new-revir") {
          request = ["/manage/settings/reviry", "POST", { id: val("nId"), data: { name: val("nName"), priceCzk: num("nPrice", "Cena", { int: false }), dailyCapacity: num("nCapacity", "Míst na den"), bookingDaysAhead: num("nAhead", "Prodej dopředu"), lateReturnDays: num("nLate", "Opožděné odevzdání"), rules: [], fishingHours: [] } }];
        } else {
          const note = val("settingsNote");
          if (scope === "organization") request = ["/manage/settings/organization", "PUT", { data: organizationData(), note }];
          else if (scope === "payment") {
            if (!window.confirm("Opravdu změnit platební údaje? Všichni admini dostanou e-mail.")) return;
            request = ["/manage/settings/payment", "PUT", { data: paymentData(), note }];
          } else if (scope.startsWith("species:")) request = ["/manage/settings/species", "PUT", { ref: speciesRef, data: speciesData(), note }];
          else { const r = view.reviry.find((x) => `revir:${x.id}` === scope); request = [`/manage/settings/reviry/${r.id}`, "PUT", { data: revirData(r), note }]; }
        }
        if (button) button.disabled = true;
        const result = await api(request[0], { method: request[1], body: request[2] });
        view = result.settings;
        if (scope === "new-revir") tab = `revir:${request[2].id}`;
        showToast("Nastavení uloženo.");
        renderTabs();
        render();
      } catch (error) { showToast(error.message); if (button) button.disabled = false; }
    });
    qs("[data-history]")?.addEventListener("click", (e) => showHistory(e.target.dataset.history));
    qs("[data-reset]")?.addEventListener("click", async (e) => {
      if (!window.confirm("Obnovit výchozí hodnoty ze souboru? Uloží se jako nová verze, historie zůstane.")) return;
      try { view = (await api("/manage/settings/reset", { method: "POST", body: { scope: e.target.dataset.reset } })).settings; showToast("Obnoveny výchozí hodnoty."); renderTabs(); render(); } catch (error) { showToast(error.message); }
    });
    qs("[data-json]")?.addEventListener("click", (e) => showJson(e.target.dataset.json));
  }
  function currentPart(scope) {
    if (scope === "organization") return view.organization;
    if (scope === "payment") return view.payment;
    if (scope.startsWith("species:")) return view.species.find((s) => `species:${s.ref}` === scope);
    return view.reviry.find((r) => `revir:${r.id}` === scope);
  }
  async function showHistory(scope) {
    const box = qs("#settingsHistory");
    try {
      const { versions } = await api("/manage/settings/history", { query: { scope } });
      box.innerHTML = versions.length ? `<ul class="plain-list">${versions.map((v, i) => `<li>#${esc(v.version)} · ${esc(czDateTime(v.createdAt))} · ${esc(v.createdBy || "—")}${v.note ? ` · ${esc(v.note)}` : ""} ${i ? `<button class="text-button inline-link" type="button" data-restore="${esc(v.version)}">Obnovit</button>` : "<b>(platná)</b>"}</li>`).join("")}</ul>` : '<p class="muted">Zatím beze změn – platí hodnoty ze souboru.</p>';
      qsa("[data-restore]", box).forEach((b) => b.addEventListener("click", async () => {
        if (!window.confirm(`Obnovit verzi #${b.dataset.restore}? Uloží se jako nová verze.`)) return;
        try { view = (await api(`/manage/settings/versions/${b.dataset.restore}/restore`, { method: "POST" })).settings; showToast("Verze obnovena."); renderTabs(); render(); } catch (error) { showToast(error.message); }
      }));
    } catch (error) { box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
  }
  // Admin: úplná data části jako JSON (pro pole, která formulář nenabízí).
  function showJson(scope) {
    const box = qs("#settingsHistory");
    box.innerHTML = `<textarea id="jsonEditor" class="json-editor" rows="18" spellcheck="false">${esc(JSON.stringify(currentPart(scope).data, null, 2))}</textarea><button class="secondary-button" type="button" id="saveJson">Uložit JSON</button>`;
    qs("#saveJson").addEventListener("click", async () => {
      let data;
      try { data = JSON.parse(qs("#jsonEditor").value); } catch { return showToast("Neplatný JSON."); }
      const path = scope === "organization" ? ["/manage/settings/organization", { data }] : scope === "payment" ? ["/manage/settings/payment", { data }] : scope.startsWith("species:") ? ["/manage/settings/species", { ref: scope.slice(8), data }] : [`/manage/settings/reviry/${scope.slice(6)}`, { data }];
      try { view = (await api(path[0], { method: path[0].endsWith("/reviry") ? "POST" : "PUT", body: { ...path[1], note: "Úprava JSON" } })).settings; showToast("Nastavení uloženo."); renderTabs(); render(); } catch (error) { showToast(error.message); }
    });
  }

  window.MistenkaSettings = { load };
})();
