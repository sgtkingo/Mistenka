// Manažerský portál (správce a admin). Zatím sekce Uživatelé a role (B1); další sekce podle docs/PLAN.md.
const { qs, qsa, esc, api, loadConfig, showToast, applyBranding, initUserMenu, hasRole, isStaff, ROLE_LABELS, czDate, parseCzDate, czk, czDateTime, ticketState, limitsHtml } = window.Mistenka;

let me = null;
let config = null;

function deny(html) {
  qs("#loadingState").classList.add("hidden");
  qs("#deniedState").innerHTML = html;
  qs("#deniedState").classList.remove("hidden");
}

// ---------- navigace ----------
qsa(".manage-nav-item").forEach((item) => item.addEventListener("click", () => {
  qsa(".manage-nav-item").forEach((other) => other.classList.toggle("active", other === item));
  const section = item.dataset.section;
  qsa(".manage-section").forEach((el) => el.classList.toggle("hidden", el.id !== `section-${section}`));
  if (location.hash.slice(1).split("/")[0] !== section) history.replaceState(null, "", section === "tickets" ? location.pathname : `#${section}`);
  if (section === "tickets") loadTickets();
  if (section === "backups") loadBackups();
  if (section === "audit") loadAudit();
  if (section === "stocking") window.MistenkaReports.loadStocking();
  if (section === "reports") window.MistenkaReports.loadReports(location.hash.startsWith("#reports/") ? location.hash.split("/")[1] : "");
  if (section === "settings") window.MistenkaSettings.load(decodeURIComponent(location.hash.split("/")[1] || ""), "settings");
  if (section === "reviry") window.MistenkaSettings.load(decodeURIComponent(location.hash.split("/")[1] || ""), "reviry");
  if (section === "payments") loadPayments();
  if (section === "vouchers") loadVouchers();
  if (section === "users") loadUsers();
  if (section === "limits") loadLimits();
  if (section === "announcements") loadAnnouncements();
  if (section === "seasons") loadSeasons();
}));

// ---------- uživatelé a role ----------
// Správce mění jen roli porybného, admin i správce a adminy (server to vynucuje, UI jen nenabízí).
const editableRoles = () => (hasRole(me, "admin") ? ["warden", "manager", "admin"] : ["warden"]);

async function loadUsers(q = "") {
  const list = qs("#userList");
  list.innerHTML = '<p class="muted">Načítám…</p>';
  try {
    const { users } = await api("/manage/users", { query: { q } });
    if (!users.length) { list.innerHTML = '<p class="muted">Nikoho jsme nenašli.</p>'; return; }
    const editable = editableRoles();
    list.innerHTML = `<table class="data-table"><thead><tr><th>Uživatel</th><th>Č. legitimace</th><th>Role</th><th></th></tr></thead><tbody>${users.map((user) => `
      <tr data-user="${esc(user.id)}">
        <td data-label="Uživatel"><b>${esc(`${user.firstName} ${user.lastName}`)}</b><br><small class="muted-inline">${esc(user.email)}${user.emailVerified ? "" : " · neověřený"}${user.twoFactor ? " · 2FA" : ""}</small></td>
        <td data-label="Legitimace">${user.memberId ? esc(user.memberId) : '<span class="muted-inline">účet pro správu</span>'}</td>
        <td data-label="Role"><div class="role-toggles">${["warden", "manager", "admin"].map((role) => `<label class="role-toggle${editable.includes(role) ? "" : " locked"}"><input type="checkbox" value="${role}"${user.roles.includes(role) ? " checked" : ""}${editable.includes(role) && user.emailVerified ? "" : " disabled"}> ${esc(ROLE_LABELS[role])}</label>`).join("")}</div></td>
        <td><button class="secondary-button save-roles" type="button" disabled>Uložit</button></td>
      </tr>`).join("")}</tbody></table>`;
    qsa("tr[data-user]", list).forEach((row) => {
      const button = qs(".save-roles", row);
      qsa("input[type=checkbox]", row).forEach((box) => box.addEventListener("change", () => { button.disabled = false; }));
      button.addEventListener("click", async () => {
        button.disabled = true;
        const roles = qsa("input[type=checkbox]:checked", row).map((box) => box.value);
        try {
          const { user } = await api(`/manage/users/${row.dataset.user}/roles`, { method: "PUT", body: { roles } });
          showToast(`${user.firstName} ${user.lastName}: ${user.roles.map((role) => ROLE_LABELS[role]).join(", ")}`);
          if (user.id === me.id) location.reload();
        } catch (error) {
          showToast(error.message);
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
}
qs("#inviteForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const { user } = await api("/manage/users", { method: "POST", body: { firstName: qs("#invFirstName").value.trim(), lastName: qs("#invLastName").value.trim(), email: qs("#invEmail").value.trim(), roles: [qs("#invRole").value] } });
    qs("#inviteForm").reset();
    qs("#inviteBox").open = false;
    showToast(`Pozvánka odeslána na ${user.email}.`);
    loadUsers();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
qs("#userSearch").addEventListener("submit", (event) => {
  event.preventDefault();
  loadUsers(qs("#userQuery").value.trim());
});

// ---------- limity a blokace (B3) ----------
const PERIODS = { day: "den", week: "týden", month: "měsíc" };
async function loadLimits() {
  const blocks = qs("#blockList");
  const violations = qs("#violationList");
  try {
    const [b, v] = await Promise.all([api("/manage/blocks"), api("/manage/violations")]);
    blocks.innerHTML = b.blocks.length ? `<table class="data-table"><thead><tr><th>Člen</th><th>Důvod</th><th>Do</th><th>Stav</th><th></th></tr></thead><tbody>${b.blocks.map((x) => `
      <tr><td data-label="Člen"><b>${esc(x.memberId)}</b><br><small class="muted-inline">${esc(x.holder)}</small></td><td data-label="Důvod">${esc(x.reason)}<br><small class="muted-inline">${x.source === "auto" ? "automaticky" : "ručně"}</small></td>
      <td data-label="Do">${x.until ? esc(czDate(x.until)) : "do zrušení"}</td><td data-label="Stav"><span class="badge badge-${x.active ? "bad" : "off"}">${x.active ? "Aktivní" : x.liftedAt ? "Zrušená" : "Vypršela"}</span></td>
      <td>${x.active ? `<button class="secondary-button lift-block" type="button" data-id="${esc(x.id)}">Zrušit</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné blokace.</p>';
    qsa(".lift-block", blocks).forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Zrušit blokaci nákupu?")) return;
      button.disabled = true;
      try { await api(`/manage/blocks/${button.dataset.id}/lift`, { method: "POST" }); showToast("Blokace zrušena."); loadLimits(); }
      catch (error) { showToast(error.message); button.disabled = false; }
    }));
    violations.innerHTML = v.violations.length ? `<table class="data-table"><thead><tr><th>Místenka</th><th>Člen</th><th>Limit</th><th>Počet</th></tr></thead><tbody>${v.violations.map((x) => `
      <tr><td data-label="Místenka"><a class="text-link" href="status.html?code=${encodeURIComponent(x.code)}">${esc(x.code)}</a><br><small class="muted-inline">${esc(czDate(x.date))}</small></td>
      <td data-label="Člen">${esc(x.holder)}<br><small class="muted-inline">${esc(x.memberId)}${x.blocked ? " · blokován" : ""}</small></td>
      <td data-label="Limit">${esc(x.label)}<br><small class="muted-inline">${esc(PERIODS[x.period])}${x.period === "day" ? "" : ` ${esc(czDate(x.from, { year: false }))}–${esc(czDate(x.to))}`}</small></td>
      <td data-label="Počet"><b>${esc(x.count)} / ${esc(x.maxCount)}</b></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Zatím žádné překročení.</p>';
  } catch (error) {
    blocks.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
}
qs("#blockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const untilRaw = qs("#blockUntil").value.trim();
  const until = untilRaw ? parseCzDate(untilRaw) : null;
  if (untilRaw && !until) return showToast("Datum zadejte ve tvaru den.měsíc.rok.");
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/manage/blocks", { method: "POST", body: { memberId: qs("#blockMemberId").value, reason: qs("#blockReason").value.trim(), until } });
    qs("#blockForm").reset();
    showToast("Člen je zablokován.");
    loadLimits();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

// ---------- pomocné pro formuláře ----------
const shortDate = (iso) => (iso ? `${Number(iso.slice(8))}. ${Number(iso.slice(5, 7))}. ${iso.slice(0, 4)}` : "");
// Pole s českým datem → ISO; prázdné = null; neplatné = výjimka se zprávou.
function dateField(id, label) {
  const raw = qs(`#${id}`).value.trim();
  if (!raw) return null;
  const iso = parseCzDate(raw);
  if (!iso) throw new Error(`${label}: zadejte datum ve tvaru den.měsíc.rok.`);
  return iso;
}
async function submitForm(event, fn) {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try { await fn(); } catch (error) { showToast(error.message); } finally { if (button) button.disabled = false; }
}
function fillRevirSelects() {
  qsa("[data-revir-select]").forEach((select) => {
    select.innerHTML = `<option value="">Všechny revíry</option>${config.reviry.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}`;
    if (config.reviry.length === 1) select.value = config.reviry[0].id;
  });
}

// ---------- místenky ----------
const ticketQuery = { offset: 0 };
function currentFilters() {
  return { q: qs("#fQuery").value.trim(), status: qs("#fStatus").value, revirId: qs("#fRevir").value, from: dateField("fFrom", "Od") || "", to: dateField("fTo", "Do") || "" };
}
const queryString = (params) => Object.entries(params).filter(([, v]) => v !== "" && v !== null && v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
async function loadTickets(append = false) {
  const table = qs("#ticketTable");
  let filters;
  try { filters = currentFilters(); } catch (error) { return showToast(error.message); }
  if (!append) ticketQuery.offset = 0;
  // Export CSV se stejnými filtry (prefix API může obsahovat "?").
  const base = (window.MISTENKA_ENV && window.MISTENKA_ENV.apiBase) || "/api";
  const qsFilters = queryString(filters);
  qs("#csvLink").href = `${base}/manage/tickets.csv${qsFilters ? (base.includes("?") ? "&" : "?") + qsFilters : ""}`;
  try {
    const { total, tickets } = await api("/manage/tickets", { query: Object.fromEntries(Object.entries({ ...filters, limit: 100, offset: ticketQuery.offset }).filter(([, v]) => v !== "")) });
    const rows = tickets.map((t) => {
      const state = ticketState(t);
      return `<tr class="clickable" data-code="${esc(t.code)}"><td data-label="Den">${esc(czDate(t.date, { year: false }))}</td><td data-label="Kód"><b>${esc(t.code)}</b></td>
        <td data-label="Rybář">${esc(`${t.firstName} ${t.lastName}`)}<br><small class="muted-inline">${esc(t.memberId)}${t.account ? " · účet" : ""}</small></td>
        <td data-label="Revír">${esc(t.revir)}</td><td data-label="Stav"><span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span>${t.seized && t.status !== "seized" ? ' <span class="badge badge-bad">zadržena</span>' : ""}</td>
        <td data-label="Úlovky">${t.status === "expired_returned" ? (t.noCatch ? "bez úlovku" : esc(t.catchCount)) : ""}</td><td data-label="Cena">${t.voucherUsed ? "poukaz" : esc(czk(t.priceHalere))}</td></tr>`;
    }).join("");
    if (append) qs("#ticketTable tbody").insertAdjacentHTML("beforeend", rows);
    else table.innerHTML = total ? `<table class="data-table"><thead><tr><th>Den</th><th>Kód</th><th>Rybář</th><th>Revír</th><th>Stav</th><th>Úlovky</th><th>Cena</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">Žádné místenky neodpovídají filtru.</p>';
    ticketQuery.offset += tickets.length;
    qs("#ticketTotal").textContent = `Nalezeno ${total} · zobrazeno ${ticketQuery.offset}`;
    qs("#moreTickets").classList.toggle("hidden", ticketQuery.offset >= total);
    qsa("tr.clickable", table).forEach((row) => { if (!row.dataset.bound) { row.dataset.bound = "1"; row.addEventListener("click", () => openTicket(row.dataset.code)); } });
  } catch (error) { table.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#ticketFilters").addEventListener("submit", (event) => { event.preventDefault(); loadTickets(); });
qs("#moreTickets").addEventListener("click", () => loadTickets(true));

const RESULT_LABELS = { matched: "spárováno", amount_mismatch: "jiná částka", duplicate_payment: "duplicitní platba", late: "po vypršení / zrušená", unmatched: "nespárováno", ignored: "odchozí" };
const RESOLUTION_LABELS = { assigned: "přiřazeno k místence", refunded: "vráceno", ignored: "bez akce" };
async function openTicket(code) {
  const dialog = qs("#ticketDialog");
  const body = qs("#ticketDialogBody");
  body.innerHTML = '<p class="muted">Načítám…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const d = await api(`/manage/tickets/${encodeURIComponent(code)}`);
    const t = d.ticket;
    const state = ticketState(t);
    const catches = t.catches.length ? t.catches.map((c) => `${esc(c.species)} ${esc(c.length)} cm${c.weight ? ` · ${esc(c.weight)} kg${c.weightEstimated ? " (odhad)" : ""}` : ""}`).join("<br>") : t.noCatch ? "bez úlovku" : "—";
    body.innerHTML = `
      <div class="dialog-head"><div><span class="section-kicker">Místenka</span><h2>${esc(t.code)} <span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span></h2></div><button class="text-button" type="button" id="closeDialog">Zavřít ✕</button></div>
      <dl class="summary-list">
        <div><dt>Rybář</dt><dd>${esc(`${t.firstName} ${t.lastName}`)}${t.account ? " (účet)" : ""}</dd></div>
        <div><dt>Č. legitimace · narozen</dt><dd>${esc(t.memberId)} · ${esc(czDate(t.birthDate))}</dd></div>
        <div><dt>E-mail</dt><dd>${esc(t.email)}</dd></div>
        <div><dt>Revír · den lovu</dt><dd>${esc(t.revir.name)} · ${esc(czDate(t.date, { weekday: true }))}</dd></div>
        <div><dt>Cena</dt><dd>${esc(czk(t.priceHalere))}${t.voucherUsed ? " · poukaz" : ""}${t.variableSymbol ? ` · VS ${esc(t.variableSymbol)}` : ""}</dd></div>
        <div><dt>Vytvořeno · vystaveno</dt><dd>${esc(czDateTime(t.createdAt))}${t.issuedAt ? ` · ${esc(czDateTime(t.issuedAt))}` : ""}</dd></div>
        ${t.returnedAt ? `<div><dt>Odevzdáno</dt><dd>${esc(czDateTime(t.returnedAt))}${t.late ? " · opožděně" : ""}</dd></div>` : ""}
        <div><dt>Úlovky</dt><dd>${catches}</dd></div>
      </dl>
      ${t.seizure ? `<div class="status-error"><b>Zadrženo ${esc(czDateTime(t.seizure.at))}</b><br>${esc(t.seizure.reason)}${t.seizure.place ? ` · ${esc(t.seizure.place)}` : ""}</div>` : ""}
      ${d.cancellation ? `<div class="status-error"><b>Zrušeno ${esc(czDateTime(d.cancellation.at))}</b>${d.cancellation.byManager ? " správcem" : ""}<br>${esc(d.cancellation.reason)}</div>` : ""}
      ${limitsHtml(t.limits, { title: "Limity úlovků" })}
      ${d.violations.length ? `<p class="field-help">Zapsané překročení: ${d.violations.map((v) => `${esc(v.label)} ${esc(v.count)}/${esc(v.maxCount)}`).join(", ")}</p>` : ""}
      <h3>Platby</h3>${d.payments.length ? `<ul class="plain-list">${d.payments.map((p) => `<li>${esc(czDateTime(p.createdAt))} · ${esc(czk(p.amountHalere))} · ${esc(RESULT_LABELS[p.result] || p.result)}${p.resolution ? ` → ${esc(RESOLUTION_LABELS[p.resolution.action])}` : ""}</li>`).join("")}</ul>` : '<p class="muted">Žádné.</p>'}
      <h3>Kontroly porybným</h3>${d.checks.length ? `<ul class="plain-list">${d.checks.map((c) => `<li>${esc(czDateTime(c.at))} · ${esc(c.wardenName)}${c.status === "seized" ? " · zadržení" : ""}</li>`).join("")}</ul>` : '<p class="muted">Žádné.</p>'}
      <h3>E-maily</h3><ul class="plain-list">${d.emails.map((e) => `<li>${esc(czDateTime(e.createdAt))} · ${esc(e.subject)}${e.sentAt ? "" : e.error ? " · <b>chyba</b>" : " · čeká"}</li>`).join("") || "<li>—</li>"}</ul>
      ${d.cancellable ? `<details class="seize-box"><summary>Zrušit místenku</summary><p class="field-help">Místenka přestane platit a uvolní místo. ${t.payment === null && !t.voucherUsed ? "Peníze se nevracejí automaticky – vraťte je v bankovnictví. " : ""}Držitel vystavené místenky dostane e-mail.</p>
        <label class="field-label" for="cancelReason">Důvod</label><input id="cancelReason" maxlength="300"><button class="danger-button" type="button" id="cancelTicket">Zrušit místenku</button></details>` : ""}`;
    qs("#closeDialog").addEventListener("click", () => dialog.close());
    qs("#cancelTicket")?.addEventListener("click", async (event) => {
      const reason = qs("#cancelReason").value.trim();
      if (reason.length < 3) return showToast("Uveďte důvod zrušení.");
      if (!window.confirm(`Opravdu zrušit místenku ${t.code}?`)) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await api(`/manage/tickets/${t.code}/cancel`, { method: "POST", body: { reason } }); showToast("Místenka zrušena."); openTicket(t.code); loadTickets(); }
      catch (error) { showToast(error.message); button.disabled = false; }
    });
  } catch (error) { body.innerHTML = `<p class="status-error">${esc(error.message)}</p><button class="text-button" type="button" onclick="this.closest('dialog').close()">Zavřít</button>`; }
}
qs("#ticketDialog").addEventListener("click", (event) => { if (event.target.id === "ticketDialog") event.target.close(); });

// ---------- platby ----------
async function loadPayments() {
  const list = qs("#paymentList");
  try {
    const all = qs("#showAllPayments").checked;
    const { payments } = await api("/manage/payments", { query: { state: all ? "all" : "open" } });
    if (!all) updatePaymentCount(payments.length);
    list.innerHTML = payments.length ? payments.map((p) => `
      <div class="payment-item${p.needsAction ? " needs-action" : ""}">
        <div><b>${esc(czk(p.amountHalere))}</b> ${p.currency !== "CZK" ? esc(p.currency) : ""} · VS ${esc(p.variableSymbol || "—")} · <span class="badge badge-${p.needsAction ? "warn" : p.result === "matched" ? "ok" : "off"}">${esc(RESULT_LABELS[p.result] || p.result)}</span>
          <br><small class="muted-inline">${esc(czDateTime(p.createdAt))} · ${esc(p.counterName || "")} ${esc(p.counterAccount || "")}${p.message ? ` · „${esc(p.message)}“` : ""}${p.note ? ` · ${esc(p.note)}` : ""}</small>
          ${p.ticket ? `<br><button class="text-button inline-link" type="button" data-open="${esc(p.ticket.code)}">Místenka ${esc(p.ticket.code)} · ${esc(p.ticket.holder)}</button>` : ""}
          ${p.resolution ? `<br><small>Vyřešeno: ${esc(RESOLUTION_LABELS[p.resolution.action])}${p.resolution.note ? ` – ${esc(p.resolution.note)}` : ""} (${esc(czDateTime(p.resolution.at))})</small>` : ""}</div>
        ${p.needsAction ? `<form class="resolve-form" data-id="${p.id}">
          <input name="ticketCode" class="code-input" maxlength="6" placeholder="Kód místenky" value="${esc(p.ticket?.code || "")}">
          <input name="note" maxlength="300" placeholder="Poznámka">
          <div class="resolve-actions"><button class="primary-button" type="submit" value="assign">Přiřadit a vystavit</button><button class="secondary-button" type="submit" value="refunded">Vráceno</button><button class="text-button" type="submit" value="ignored">Bez akce</button></div>
        </form>` : ""}
      </div>`).join("") : `<p class="muted">${all ? "Žádné platby." : "Nic k vyřešení. 👍"}</p>`;
    qsa("[data-open]", list).forEach((b) => b.addEventListener("click", () => openTicket(b.dataset.open)));
    qsa(".resolve-form", list).forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = event.submitter.value;
      const body = { action, note: form.note.value.trim(), ticketCode: form.ticketCode.value.trim().toUpperCase() || undefined };
      if (action === "assign" && !window.confirm(`Přiřadit platbu k místence ${body.ticketCode || ""} a vystavit ji? Odpovídáte za částku i volné místo.`)) return;
      event.submitter.disabled = true;
      try { await api(`/manage/payments/${form.dataset.id}/resolve`, { method: "POST", body }); showToast("Platba vyřešena."); loadPayments(); }
      catch (error) { showToast(error.message); event.submitter.disabled = false; }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
function updatePaymentCount(n) {
  qs("#paymentCount").textContent = n;
  qs("#paymentCount").classList.toggle("hidden", !n);
}
qs("#showAllPayments").addEventListener("change", loadPayments);

// ---------- poukazy ----------
const VOUCHER_STATES = { valid: ["Platný", "ok"], used: ["Použitý", "off"], voided: ["Zneplatněný", "bad"] };
async function loadVouchers() {
  const list = qs("#voucherList");
  try {
    const { vouchers } = await api("/manage/vouchers");
    list.innerHTML = vouchers.length ? `<table class="data-table"><thead><tr><th>Kód</th><th>Platí pro</th><th>Poznámka</th><th>Stav</th><th></th></tr></thead><tbody>${vouchers.map((v) => {
      const [label, tone] = VOUCHER_STATES[v.state];
      return `<tr><td data-label="Kód"><code class="voucher-code">${esc(v.code)}</code></td><td data-label="Platí pro">${esc(v.revir)}</td><td data-label="Poznámka">${esc(v.note)}</td>
        <td data-label="Stav"><span class="badge badge-${tone}">${label}</span>${v.ticketCode ? ` <button class="text-button inline-link" type="button" data-open="${esc(v.ticketCode)}">${esc(v.ticketCode)}</button>` : ""}</td>
        <td>${v.state === "valid" ? `<button class="text-button void-voucher" type="button" data-code="${esc(v.code)}">Zneplatnit</button>` : ""}</td></tr>`;
    }).join("")}</tbody></table>` : '<p class="muted">Žádné poukazy.</p>';
    qsa("[data-open]", list).forEach((b) => b.addEventListener("click", () => openTicket(b.dataset.open)));
    qsa(".void-voucher", list).forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm(`Zneplatnit poukaz ${b.dataset.code}?`)) return;
      try { await api(`/manage/vouchers/${b.dataset.code}/void`, { method: "POST" }); loadVouchers(); } catch (error) { showToast(error.message); }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#voucherForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const { vouchers } = await api("/manage/vouchers", { method: "POST", body: { count: Number(qs("#vCount").value), revirId: qs("#vRevir").value || null, note: qs("#vNote").value.trim() } });
  qs("#newVouchers").innerHTML = `<div class="info-box"><b>Nové poukazy</b> (zkopírujte a předejte): <br>${vouchers.map((v) => `<code class="voucher-code">${esc(v.code)}</code>`).join(" ")}</div>`;
  qs("#voucherForm").reset();
  fillRevirSelects();
  loadVouchers();
}));

// ---------- důležité zprávy ----------
let announcements = [];
async function loadAnnouncements() {
  const list = qs("#announcementList");
  try {
    ({ announcements } = await api("/manage/announcements"));
    list.innerHTML = announcements.length ? announcements.map((a) => `
      <div class="ann-item${a.active ? "" : " inactive"}">
        <div><b>${esc(a.title)}</b>${a.pinned ? ' <span class="badge badge-info">Připnuto</span>' : ""} <span class="badge badge-${a.active ? "ok" : "off"}">${a.active ? "Zobrazuje se" : "Nezobrazuje se"}</span>
          ${a.text ? `<p>${esc(a.text)}</p>` : ""}<small class="muted-inline">${esc(a.revirName)} · ${a.validFrom || a.validTo ? `${esc(shortDate(a.validFrom) || "hned")} – ${esc(shortDate(a.validTo) || "do smazání")}` : "do smazání"}</small></div>
        <div class="ann-actions"><button class="text-button edit-ann" type="button" data-id="${a.id}">Upravit</button><button class="text-button delete-ann" type="button" data-id="${a.id}">Smazat</button></div>
      </div>`).join("") : '<p class="muted">Žádné zprávy.</p>';
    qsa(".edit-ann", list).forEach((b) => b.addEventListener("click", () => editAnnouncement(announcements.find((a) => a.id === Number(b.dataset.id)))));
    qsa(".delete-ann", list).forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Smazat zprávu?")) return;
      try { await api(`/manage/announcements/${b.dataset.id}`, { method: "DELETE" }); showToast("Zpráva smazána."); loadAnnouncements(); } catch (error) { showToast(error.message); }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
function editAnnouncement(a) {
  qs("#annId").value = a ? a.id : "";
  qs("#annTitle").value = a?.title || "";
  qs("#annText").value = a?.text || "";
  qs("#annRevir").value = a ? a.revirId || "" : config.reviry.length === 1 ? config.reviry[0].id : "";
  qs("#annPinned").checked = Boolean(a?.pinned);
  qs("#annFrom").value = shortDate(a?.validFrom);
  qs("#annTo").value = shortDate(a?.validTo);
  qs("#annSubmit").textContent = a ? "Uložit změny" : "Zveřejnit";
  qs("#announcementSummary").textContent = a ? "Úprava zprávy" : "+ Nová zpráva";
  qs("#announcementBox").open = Boolean(a);
  if (a) qs("#announcementBox").scrollIntoView({ behavior: "smooth", block: "start" });
}
qs("#annCancel").addEventListener("click", () => editAnnouncement(null));
qs("#announcementForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const id = qs("#annId").value;
  const body = { title: qs("#annTitle").value.trim(), text: qs("#annText").value.trim(), revirId: qs("#annRevir").value || null, pinned: qs("#annPinned").checked, validFrom: dateField("annFrom", "Zobrazit od"), validTo: dateField("annTo", "Zobrazit do") };
  await api(id ? `/manage/announcements/${id}` : "/manage/announcements", { method: id ? "PUT" : "POST", body });
  showToast(id ? "Zpráva upravena." : "Zpráva zveřejněna.");
  editAnnouncement(null);
  loadAnnouncements();
}));

// ---------- sezony a uzavření ----------
const SEASON_STATES = { upcoming: ["Připravená", "info"], open: ["Otevřená", "ok"], closed: ["Uzavřená", "off"] };
let seasonToday = "";
// Sezona, která pro revír právě platí: otevřená, jinak nejbližší připravená, jinak poslední uzavřená.
function revirSeason(seasons, revirId) {
  const own = seasons.filter((s) => !s.revirId || s.revirId === revirId);
  return own.find((s) => s.state === "open") || own.filter((s) => s.state === "upcoming").sort((a, b) => a.opensOn.localeCompare(b.opensOn))[0] || own.find((s) => s.state === "closed") || null;
}
function seasonPeriod(s) {
  if (s.state === "upcoming") return `otevírá se ${shortDate(s.opensOn)}`;
  if (s.closesOn && s.closesOn < s.opensOn) return "uzavřena před otevřením";
  return `${shortDate(s.opensOn)} – ${s.closesOn ? `poslední den ${shortDate(s.closesOn)}` : "do uzavření"}`;
}
function renderRevirStatus(seasons) {
  qs("#revirStatus").innerHTML = config.reviry.map((r) => {
    const s = revirSeason(seasons, r.id);
    const [label, tone] = s ? SEASON_STATES[s.state] : ["Otevřeno celoročně", "ok"];
    const period = s
      ? `${esc(s.name)}${s.revirId ? "" : ' <small class="muted-inline">(všechny revíry)</small>'}<br><small class="muted-inline">${esc(seasonPeriod(s))}</small>`
      : '<small class="muted-inline">Bez sezony – místenky se prodávají celý rok.</small>';
    const closable = s && (s.state === "open" || s.state === "upcoming");
    return `<div class="revir-status-card"><div class="revir-status-head"><b>${esc(r.name)}</b><span class="badge badge-${tone}">${label}</span></div><p>${period}</p>
      ${closable ? `<button class="secondary-button toggle-close" type="button">Uzavřít sezonu ▾</button>
      <form class="close-season-form hidden" data-id="${s.id}" data-name="${esc(s.name)}" novalidate>
        <label class="radio-row"><input type="radio" name="when" value="now" checked> <span>Ihned – od dneška se místenky neprodávají</span></label>
        <label class="radio-row"><input type="radio" name="when" value="date"> <span>Od data</span> <input class="date-input close-from" inputmode="numeric" maxlength="10" placeholder="dd.mm.rrrr"></label>
        <p class="field-help">Posledním dnem lovu bude den před uzavřením. Vystavené místenky platí dál.</p>
        <button class="danger-button" type="submit">Uzavřít</button>
      </form>` : ""}</div>`;
  }).join("");
  qsa(".toggle-close").forEach((b) => b.addEventListener("click", () => b.nextElementSibling.classList.toggle("hidden")));
  qsa(".close-season-form").forEach((form) => {
    qs(".close-from", form).addEventListener("focus", () => { form.when.value = "date"; });
    form.addEventListener("submit", (event) => submitForm(event, async () => {
      let from = seasonToday;
      if (form.when.value === "date") {
        from = parseCzDate(qs(".close-from", form).value.trim());
        if (!from) throw new Error("Zadejte datum uzavření ve tvaru den.měsíc.rok.");
      }
      if (!window.confirm(`Uzavřít „${form.dataset.name}“ ${from === seasonToday ? "ihned" : `od ${shortDate(from)}`}?`)) return;
      await api(`/manage/seasons/${form.dataset.id}/close`, { method: "POST", body: { from } });
      showToast("Sezona uzavřena.");
      loadSeasons();
    }));
  });
}
async function loadSeasons() {
  try {
    const [{ seasons }, { closures }, cfg] = await Promise.all([api("/manage/seasons"), api("/manage/closures"), api("/config")]);
    seasonToday = cfg.today;
    renderRevirStatus(seasons);
    qs("#seasonList").innerHTML = seasons.length ? `<table class="data-table"><thead><tr><th>Sezona</th><th>Revír</th><th>Období</th><th>Stav</th><th></th></tr></thead><tbody>${seasons.map((s) => {
      const [label, tone] = SEASON_STATES[s.state];
      return `<tr><td data-label="Sezona"><b>${esc(s.name)}</b></td><td data-label="Revír">${esc(s.revirName)}</td><td data-label="Období">${esc(shortDate(s.opensOn))} – ${esc(shortDate(s.closesOn) || "do uzavření")}</td><td data-label="Stav"><span class="badge badge-${tone}">${label}</span></td>
        <td class="row-actions"><button class="text-button delete-season" type="button" data-id="${s.id}">Smazat</button></td></tr>`;
    }).join("")}</tbody></table>` : '<p class="muted">Zatím žádná sezona.</p>';
    qsa(".delete-season").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Smazat sezonu? Revír bez sezony je otevřený celý rok.")) return;
      try { await api(`/manage/seasons/${b.dataset.id}`, { method: "DELETE" }); loadSeasons(); } catch (error) { showToast(error.message); }
    }));
    qs("#closureList").innerHTML = closures.length ? `<table class="data-table"><thead><tr><th>Dny</th><th>Revír</th><th>Důvod</th><th></th></tr></thead><tbody>${closures.map((c) => `
      <tr><td data-label="Dny"><b>${esc(shortDate(c.dateFrom))}${c.dateTo !== c.dateFrom ? ` – ${esc(shortDate(c.dateTo))}` : ""}</b></td><td data-label="Revír">${esc(c.revirName)}</td><td data-label="Důvod">${esc(c.reason)}</td>
      <td><button class="text-button delete-closure" type="button" data-id="${c.id}">Zrušit</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádná uzavření.</p>';
    qsa(".delete-closure").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Zrušit uzavření? Na tyto dny půjde znovu kupovat místenky.")) return;
      try { await api(`/manage/closures/${b.dataset.id}`, { method: "DELETE" }); loadSeasons(); } catch (error) { showToast(error.message); }
    }));
  } catch (error) { qs("#revirStatus").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
function toggleSeasonForm(show) {
  qs("#seasonForm").classList.toggle("hidden", !show);
  qs("#openSeasonButton").classList.toggle("hidden", show);
  if (show) {
    qs("#seasonForm").reset();
    fillRevirSelects();
    qs("#seasonFrom").value = shortDate(seasonToday); // výchozí otevření = dnes
    qs("#seasonFrom").focus();
  }
}
qs("#openSeasonButton").addEventListener("click", () => toggleSeasonForm(true));
qs("#cancelSeasonForm").addEventListener("click", () => toggleSeasonForm(false));
qs("#seasonForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const opensOn = dateField("seasonFrom", "Otevřít od");
  if (!opensOn) throw new Error("Zadejte datum otevření.");
  const { season } = await api("/manage/seasons", { method: "POST", body: { name: qs("#seasonName").value.trim(), revirId: qs("#seasonRevir").value || null, opensOn, closesOn: dateField("seasonTo", "Plánované uzavření") } });
  showToast(`${season.name} otevřena.`);
  toggleSeasonForm(false);
  loadSeasons();
}));
qs("#closureForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const result = await api("/manage/closures", { method: "POST", body: { dateFrom: dateField("closureFrom", "Od"), dateTo: dateField("closureTo", "Do"), revirId: qs("#closureRevir").value || null, reason: qs("#closureReason").value.trim() } });
  qs("#closureForm").reset();
  fillRevirSelects();
  const n = result.affectedTickets.length;
  showToast(n ? `Revír uzavřen. ${n} dotčených místenek dostalo e-mail – vrácení peněz vyřiďte ručně.` : "Revír uzavřen. Žádná prodaná místenka se ho netýká.");
  loadSeasons();
}));

// ---------- zálohy a audit (jen admin) ----------
const KIND_LABELS = { daily: ["denní", "info"], season: ["po uzávěrce", "ok"], manual: ["ruční", "off"], "pre-restore": ["před obnovou", "warn"] };
const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);
async function loadBackups() {
  const list = qs("#backupList");
  try {
    const { backups, totalBytes } = await api("/manage/backups");
    const base = (window.MISTENKA_ENV && window.MISTENKA_ENV.apiBase) || "/api";
    list.innerHTML = backups.length ? `<p class="field-help">Celkem ${backups.length} záloh, ${size(totalBytes)}.</p><table class="data-table"><thead><tr><th>Vytvořeno</th><th>Typ</th><th>Poznámka</th><th>Velikost</th><th></th></tr></thead><tbody>${backups.map((b) => {
      const [label, tone] = KIND_LABELS[b.kind] || [b.kind, "off"];
      return `<tr><td data-label="Vytvořeno">${esc(czDateTime(b.createdAt))}</td><td data-label="Typ"><span class="badge badge-${tone}">${label}</span></td><td data-label="Poznámka">${esc(b.note)}</td><td data-label="Velikost">${esc(size(b.sizeBytes))}${b.exists ? "" : ' <b class="over-budget">soubor chybí</b>'}</td>
        <td class="row-actions">${b.exists ? `<a class="text-link" href="${esc(`${base}/manage/backups/${b.id}/download`)}" download>Stáhnout</a><button class="text-button restore-backup" type="button" data-id="${b.id}" data-created="${esc(czDateTime(b.createdAt))}">Obnovit</button>` : ""}<button class="text-button delete-backup" type="button" data-id="${b.id}">Smazat</button></td></tr>`;
    }).join("")}</tbody></table>` : '<p class="muted">Zatím žádné zálohy.</p>';
    qsa(".restore-backup", list).forEach((b) => b.addEventListener("click", async () => {
      const confirmText = window.prompt(`Obnovit databázi ze zálohy ${b.dataset.created}?

Všechna data (místenky, platby, účty, nastavení) se vrátí do stavu zálohy; novější změny se ztratí. Přihlášení zůstanou. Těsně předtím se vytvoří pojistná záloha.

Pro potvrzení napište OBNOVIT:`);
      if (confirmText === null) return;
      const otp = window.prompt("Kód z ověřovací aplikace (2FA):");
      if (otp === null) return;
      b.disabled = true;
      try {
        const result = await api(`/manage/backups/${b.dataset.id}/restore`, { method: "POST", body: { confirm: confirmText.trim().toUpperCase(), otp: otp.trim() } });
        showToast(`Obnoveno ze zálohy ${result.file}. Pojistná záloha: ${result.safetyBackup.file}.`);
        loadBackups();
      } catch (error) { showToast(error.message); b.disabled = false; }
    }));
    qsa(".delete-backup", list).forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Smazat zálohu? Nelze vrátit.")) return;
      try { await api(`/manage/backups/${b.dataset.id}`, { method: "DELETE" }); loadBackups(); } catch (error) { showToast(error.message); }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#createBackup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const note = window.prompt("Poznámka k záloze (volitelné):", "");
  if (note === null) return;
  button.disabled = true;
  try { await api("/manage/backups", { method: "POST", body: { note } }); showToast("Záloha vytvořena."); loadBackups(); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
const ACTION_LABELS = { roles_changed: "změna rolí", roles_forced: "role (příkazová řádka)", staff_invited: "pozvání do správy", admin_setup: "založení admina", settings_changed: "nastavení", ticket_seized: "zadržení místenky", ticket_cancelled: "zrušení místenky",
  payment_resolved: "vyřešení platby", member_blocked: "blokace člena", member_blocked_auto: "automatická blokace", member_unblocked: "zrušení blokace", backup_created: "záloha", backup_deleted: "smazání zálohy", season_created: "sezona", season_updated: "úprava sezony", season_deleted: "smazání sezony",
  closure_created: "uzavření revíru", closure_deleted: "zrušení uzavření", announcement_created: "nová zpráva", announcement_updated: "úprava zprávy", announcement_deleted: "smazání zprávy", vouchers_created: "nové poukazy", voucher_voided: "zneplatnění poukazu",
  stocking_created: "zarybnění", stocking_updated: "úprava zarybnění", stocking_deleted: "smazání zarybnění", stocking_budget_set: "rozpočet zarybnění", report_created: "uzávěrka", season_report_created: "uzávěrka sezony",
  account_verified: "ověření účtu", account_deleted: "smazání účtu", password_reset: "obnova hesla", password_changed: "změna hesla", email_changed: "změna e-mailu", two_factor_enabled: "zapnutí 2FA", two_factor_disabled: "vypnutí 2FA" };
async function loadAudit() {
  const list = qs("#auditList");
  try {
    const { events } = await api("/manage/audit", { query: { limit: 300 } });
    list.innerHTML = events.length ? `<table class="data-table"><thead><tr><th>Kdy</th><th>Kdo</th><th>Akce</th><th>Cíl</th><th>Podrobnosti</th></tr></thead><tbody>${events.map((e) => `
      <tr><td data-label="Kdy">${esc(czDateTime(e.at))}</td><td data-label="Kdo">${esc(e.actor)}</td><td data-label="Akce">${esc(ACTION_LABELS[e.action] || e.action)}</td><td data-label="Cíl">${esc([e.targetType, e.targetId].filter(Boolean).join(" "))}</td>
      <td data-label="Podrobnosti"><small class="muted-inline">${e.detail ? esc(JSON.stringify(e.detail).slice(0, 160)) : ""}</small></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné záznamy.</p>';
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}

// ---------- start ----------
(async function init() {
  try { config = await loadConfig(); applyBranding(config); fillRevirSelects(); } catch { /* bez konfigurace */ }
  me = await initUserMenu();
  if (!me) return deny('Pro vstup do správy se <a href="account.html">přihlaste</a>.');
  if (!isStaff(me)) return deny('Manažerský portál je jen pro správce a adminy. <a href="./">Zpět na uživatelský portál</a>');
  if (me.mfaRequired) return deny('Jako admin musíte mít zapnuté dvoufázové ověření. <a href="account.html#2fa">Nastavit 2FA →</a>');
  qs("#loadingState").classList.add("hidden");
  qs("#portal").classList.remove("hidden");
  qsa(".admin-only").forEach((el) => el.classList.toggle("hidden", !hasRole(me, "admin")));
  qs("#rolesHelp").textContent = hasRole(me, "admin")
    ? "Jako admin jmenujete porybné, správce i další adminy. Posledního admina nelze odebrat. Role lze dát jen účtu s ověřeným e-mailem."
    : "Jako správce můžete jmenovat a odvolávat porybné. Správce a adminy jmenuje admin.";
  loadTickets();
  api("/manage/payments").then(({ payments }) => updatePaymentCount(payments.length)).catch(() => {});
  // Odkaz přímo na sekci: manage.html#seasons
  const target = qs(`.manage-nav-item[data-section="${CSS.escape(location.hash.slice(1).split("/")[0])}"]`);
  if (target && !target.classList.contains("hidden")) target.click();
})();
