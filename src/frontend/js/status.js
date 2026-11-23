const { qs, qsa, esc, api, loadConfig, czDate, czDateTime, initUserMenu, hasRole, ticketState, showToast, limitsHtml } = window.Mistenka;
const code = (new URLSearchParams(location.search).get("code") || "").trim().toUpperCase();

// Stav -> [popisek, vysvětlení, CSS třída, ikona]
const STATES = {
  future: ["Budoucí", "Místenka začne platit v den lovu.", "status-future", "→"],
  active: ["Aktivní", "Místenka platí pro dnešní den lovu.", "status-active", "✓"],
  expired_returned: ["Odevzdaná", "Místenka byla odevzdána.", "status-returned", "↩"],
  expired_returned_late: ["Opožděné odevzdání", "Místenka byla odevzdána po skončení dne lovu.", "status-warning", "↩"],
  expired_unreturned: ["Propadlá, neodevzdaná", "Místenka už neplatí pro lov a nebyla odevzdána.", "status-warning", "!"],
  closed_unreturned: ["Uzavřená, neodevzdaná", "Místenka nebyla odevzdána ani v prodloužené lhůtě a byla automaticky uzavřena.", "status-expired", "×"],
  pending_payment: ["Čeká na platbu", "Místenka zatím nebyla zaplacena a neopravňuje k lovu.", "status-warning", "…"],
  payment_expired: ["Nezaplacená", "Objednávka nebyla včas zaplacena. Místenka neplatí.", "status-neutral", "×"],
  cancelled: ["Zrušená", "Objednávka byla zrušena. Místenka neplatí.", "status-neutral", "×"],
  seized: ["Zadržená", "Místenku zadržela rybářská stráž. Neopravňuje k lovu; držitel ji musí odevzdat s úlovky.", "status-expired", "!"]
};

function showError(message) {
  qs("#statusLoading").classList.add("hidden");
  qs("#statusError").textContent = message;
  qs("#statusError").classList.remove("hidden");
}

// Falešná banka (testovací web): varování, že místenky neplatí.
loadConfig().then((config) => qs("#testModeBanner").classList.toggle("hidden", config.payment?.mode !== "fake")).catch(() => {});

async function loadStatus() {
  if (!/^[A-Z0-9]{6}$/.test(code)) return showError("Chybí platný šestimístný kód místenky.");
  try {
    const ticket = await api(`/tickets/${code}`);
    const key = ticket.status === "expired_returned" && ticket.late ? "expired_returned_late" : ticket.status;
    const [label, message, css, icon] = STATES[key] || [ticket.status, "", "status-expired", "!"];
    qs("#statusBanner").className = `status-banner ${css}`;
    qs("#statusBanner").innerHTML = `<span>${esc(icon)}</span><div><strong>${esc(label)}</strong><small>${esc(message)}</small></div>`;
    const rows = [["Datum lovu", czDate(ticket.date, { weekday: true })]];
    if (ticket.subdistrict) rows.unshift(["Podrevír", ticket.subdistrict.label]);
    if (ticket.holder) rows.unshift(["Rybář", ticket.holder.name], ["Č. legitimace", ticket.holder.memberId]);
    if (ticket.status === "active") rows.push(["Platí do", czDateTime(ticket.validTo)]);
    rows.push(["Stav", label]);
    if (ticket.seized && ticket.status !== "seized") rows.push(["Poznámka", "Místenka byla zadržena rybářskou stráží"]);
    qs("#ticketStatusCard").innerHTML = `<span class="section-kicker">Místenka ${esc(ticket.code)}</span><h2>${esc([ticket.revir.name, ticket.revir.number].filter(Boolean).join(" · "))}</h2><dl class="summary-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
    document.title = `Místenka ${ticket.code} · ${label}`;
    qs("#statusLoading").classList.add("hidden");
    qs("#statusContent").classList.remove("hidden");
    const user = await initUserMenu();
    if (hasRole(user, "warden") && ticket.holder) loadWarden();
  } catch (error) {
    showError(error.message);
  }
}

// ---------- porybný: plná kontrola a zadržení (B2) ----------
const catchText = (t) => (t.catches.length ? t.catches.map((c) => `${c.species} ${c.length} cm${c.warning || c.suspect ? " ⚠" : ""}`).join(", ") : t.noCatch ? "nic neponecháno" : "—");
// Úlovky s možným porušením pravidel (míra, hájení, povinné vrácení) – porybný je má zkontrolovat podle RIS.
const catchWarningsHtml = (catches) => {
  const warned = (catches || []).filter((c) => c.warning);
  const html = warned.length ? `<div class="warn-box catch-warning-box"><b>⚠ Možné porušení pravidel – zkontrolujte</b><ul>${warned.map((c) => `<li>${esc(c.species)} ${esc(c.length)} cm: ${esc(c.warning)}</li>`).join("")}</ul><small>Podle údajů v Místence; rozhodují pravidla v RIS.</small></div>` : "";
  // Odlehlé pozorování (hlídání nereálných měr a vah) – místenka je vedená jako podezřelá.
  const suspects = (catches || []).filter((c) => c.suspect);
  return html + (suspects.length ? `<div class="warn-box catch-warning-box"><b>⚠ Neobvyklé míry nebo váhy</b><ul>${suspects.map((c) => `<li>${esc(c.suspect)}</li>`).join("")}</ul></div>` : "");
};
async function loadWarden() {
  const panel = qs("#wardenPanel");
  try {
    renderWarden(await api(`/warden/tickets/${code}`));
  } catch (error) {
    panel.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
    panel.classList.remove("hidden");
  }
}
// Funkce člena v organizaci (barvy jednotné v celém systému – common.js roleBadges).
const memberRolesHtml = (roles = ["member"]) => window.Mistenka.roleBadges(roles);
function renderWarden(view) {
  const panel = qs("#wardenPanel");
  const history = view.memberHistory.tickets;
  const weekCount = history.filter((t) => t.inWeek).length;
  const monthCount = history.filter((t) => t.inMonth).length;
  const seizure = view.seizure ? `<div class="status-error"><b>Zadrženo ${esc(czDateTime(view.seizure.at))}</b>${view.seizure.wardenName ? ` · ${esc(view.seizure.wardenName)}` : ""}<br>${esc(view.seizure.reason)}${view.seizure.place ? ` · ${esc(view.seizure.place)}` : ""}</div>` : "";
  panel.innerHTML = `
    <div class="warden-head"><span class="section-kicker">Kontrola porybného</span></div>
    <dl class="summary-list">
      <div><dt>Rybář</dt><dd>${esc(`${view.firstName} ${view.lastName}`)}</dd></div>
      ${view.subdistrict ? `<div><dt>Podrevír</dt><dd>${esc(view.subdistrict.label)}</dd></div>` : ""}
      <div><dt>Funkce</dt><dd class="member-roles">${memberRolesHtml(view.memberRoles)}</dd></div>
      <div><dt>Datum narození</dt><dd>${esc(czDate(view.birthDate))}</dd></div>
      <div><dt>Č. legitimace</dt><dd>${esc(view.memberId)}</dd></div>
      ${view.returnedAt ? `<div><dt>Úlovky na této místence</dt><dd>${esc(catchText(view))}</dd></div>` : ""}
    </dl>
    ${seizure}
    ${catchWarningsHtml(view.catches)}
    ${view.blocked ? `<div class="status-error">Člen má pozastavený nákup místenek ${view.blocked.until ? `do ${esc(czDate(view.blocked.until))}` : "do odvolání"}: ${esc(view.blocked.reason)}</div>` : ""}
    ${limitsHtml(view.limits, { mode: "all", title: "Limity úlovků člena" })}
    <h3>Místenky člena</h3>
    <p class="field-help">Týden ${esc(czDate(view.memberHistory.week.from, { year: false }))}–${esc(czDate(view.memberHistory.week.to))}: ${weekCount} · měsíc: ${monthCount}. Jen místenky v Místence – limity platí na všech revírech svazu dohromady.</p>
    <table class="data-table"><thead><tr><th>Den</th><th>Revír</th><th>Stav</th><th>Úlovky${window.Mistenka.infoTip("⚠ = možné porušení pravidel u úlovku (míra, hájení, povinné vrácení) podle údajů v Místence – rozhodují pravidla v RIS.")}</th></tr></thead><tbody>${history.map((t) => {
      const state = ticketState(t);
      return `<tr${t.current ? ' class="current-row"' : ""}><td data-label="Den">${esc(czDate(t.date, { year: false }))}${t.inWeek ? "" : ' <small class="muted-inline">(mimo týden)</small>'}</td><td data-label="Revír">${esc(t.revir)}</td><td data-label="Stav"><span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span></td><td data-label="Úlovky">${esc(catchText(t))}</td></tr>`;
    }).join("")}</tbody></table>
    <h3>Záznam kontrol</h3>
    <ul class="check-log">${view.checks.map((c) => `<li>${esc(czDateTime(c.at))} · ${esc(c.wardenName)}${c.status === "seized" ? " · <b>zadržení</b>" : ""}</li>`).join("") || "<li>—</li>"}</ul>
    ${view.seizable ? `<details class="seize-box"><summary>Zadržet místenku</summary>
      <p class="field-help">Zadržením lov okamžitě končí a místenka neplatí. Držitel ji musí i tak odevzdat s úlovky. Držitel i správce dostanou e-mail.</p>
      <label class="field-label req" for="seizeReason">Důvod zadržení</label><textarea id="seizeReason" rows="3" maxlength="500"></textarea>
      <label class="field-label" for="seizePlace">Místo <span class="optional">(volitelné)</span></label><input id="seizePlace" maxlength="200" placeholder="např. Petr 1, severní břeh">
      <button class="danger-button" type="button" id="seizeButton">Zadržet místenku</button></details>` : ""}`;
  panel.classList.remove("hidden");
  qs("#seizeButton")?.addEventListener("click", async (event) => {
    const reason = qs("#seizeReason").value.trim();
    if (reason.length < 3) return showToast("Uveďte důvod zadržení.", "warning");
    if (!window.confirm("Opravdu zadržet místenku? Lov tím okamžitě končí.")) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/warden/tickets/${code}/seize`, { method: "POST", body: { reason, place: qs("#seizePlace").value.trim() } });
      showToast("Místenka byla zadržena.", "success");
      loadStatus();
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  });
}

qs("#nextCheck").addEventListener("click", () => {
  const nextCode = qs("#nextCode").value.trim().toUpperCase();
  const error = qs("#nextCodeError");
  const invalid = !/^[A-Z0-9]{6}$/.test(nextCode);
  error.textContent = invalid ? (nextCode ? "Kód místenky má 6 znaků (písmena A–Z a číslice)." : "Zadejte kód místenky.") : "";
  error.classList.toggle("hidden", !invalid);
  qs("#nextCode").setAttribute("aria-invalid", String(invalid));
  if (invalid) return qs("#nextCode").focus();
  window.location.href = `status.html?code=${encodeURIComponent(nextCode)}`;
});
qs("#nextCode").addEventListener("keydown", (event) => { if (event.key === "Enter") qs("#nextCheck").click(); });
window.Mistenka.attachQrScanner(qs("#nextCode"), () => qs("#nextCheck").click());
loadStatus();
