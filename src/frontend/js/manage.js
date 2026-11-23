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
  if (section === "species") window.MistenkaSettings.load("species", "species");
  if (section === "bank") window.MistenkaSettings.load(decodeURIComponent(location.hash.split("/")[1] || ""), "bank");
  if (section === "maps") window.MistenkaMapEditor.load(decodeURIComponent(location.hash.split("/")[1] || ""));
  if (section === "reviry") window.MistenkaSettings.load(decodeURIComponent(location.hash.split("/")[1] || ""), "reviry");
  if (section === "payments") loadPayments();
  if (section === "vouchers") loadVouchers();
  if (section === "users") loadUsers();
  if (section === "limits") loadLimits();
  if (section === "checks") loadChecks();
  if (section === "announcements") loadAnnouncements();
  if (section === "seasons") loadSeasons();
  if (section === "pricing") loadPricing();
  if (section === "bugs") loadBugs(location.hash.startsWith("#bugs/") ? location.hash.split("/")[1] : "");
  if (section === "email") loadEmail();
  if (section === "notifications") loadNotifications();
}));

// ---------- uživatelé a role ----------
// Správce mění jen roli porybného, admin i správce a adminy (server to vynucuje, UI jen nenabízí).
const editableRoles = () => (hasRole(me, "admin") ? ["warden", "manager", "admin"] : ["warden"]);

// Záložky Admin / Správce / Porybný / Rybář (filtr na serveru, počty u záložek). Hledání platí v aktivní záložce.
let userRole = "admin";
let userQuery = "";
const ROLE_EMPTY = { admin: "Žádný admin.", manager: "Žádný správce.", warden: "Zatím žádný porybný.", member: "Žádný rybář." };
qsa("#roleTabs .tab").forEach((tab) => tab.addEventListener("click", () => {
  userRole = tab.dataset.role;
  qsa("#roleTabs .tab").forEach((other) => { other.classList.toggle("active", other === tab); other.setAttribute("aria-selected", String(other === tab)); });
  loadUsers(userQuery);
}));
async function loadUsers(q = userQuery) {
  userQuery = q;
  const list = qs("#userList");
  list.innerHTML = '<p class="muted">Načítám…</p>';
  try {
    const { users, counts } = await api("/manage/users", { query: { q, role: userRole } });
    qsa("#roleTabs .tab").forEach((tab) => { qs(".tab-count", tab).textContent = counts?.[tab.dataset.role] ?? ""; });
    if (!users.length) { list.innerHTML = `<p class="muted">${q ? "Nikoho jsme nenašli." : ROLE_EMPTY[userRole]}</p>`; return; }
    const editable = editableRoles();
    list.innerHTML = `<table class="data-table"><thead><tr><th>Uživatel</th><th>Č. legitimace</th><th>Role</th><th></th></tr></thead><tbody>${users.map((user) => `
      <tr data-user="${esc(user.id)}">
        <td data-label="Uživatel"><b>${esc(`${user.firstName} ${user.lastName}`)}</b> <span class="user-roles">${window.Mistenka.roleBadges(user.roles, { member: Boolean(user.memberId) })}</span><br><small class="muted-inline">${esc(user.email)}${user.emailVerified ? "" : " · neověřený"}${user.twoFactor ? " · 2FA" : ""}</small></td>
        <td data-label="Legitimace">${user.memberId ? esc(user.memberId) : '<span class="muted-inline">účet pro správu</span>'}</td>
        <td data-label="Role"><div class="role-toggles">${["warden", "manager", "admin"].map((role) => `<label class="role-toggle role-${role}${editable.includes(role) ? "" : " locked"}"><input type="checkbox" value="${role}"${user.roles.includes(role) ? " checked" : ""}${editable.includes(role) && user.emailVerified ? "" : " disabled"}> ${esc(ROLE_LABELS[role])}</label>`).join("")}</div></td>
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
          showToast(`${user.firstName} ${user.lastName}: ${user.roles.map((role) => ROLE_LABELS[role]).join(", ")}`, "success");
          if (user.id === me.id) location.reload();
        } catch (error) {
          showToast(error.message, "error");
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
    showToast(`Pozvánka odeslána na ${user.email}.`, "success");
    loadUsers();
  } catch (error) {
    showToast(error.message, "error");
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
// Pravidla následků (uložená v nastavení organizace: limitPolicy + penaltyPolicy).
const LIMITS_TIP = "Platí jen při zapnutém hlídání limitů v sekci Míry, váhy a hájení. Když jsou limity vypnuté, překročení se nezaznamenává a toto pravidlo nic nedělá.";
let penaltyOrg = null;
async function loadPenaltyRules() {
  const box = qs("#penaltyRules");
  try {
    penaltyOrg = (await api("/manage/settings")).organization.data;
    const lp = penaltyOrg.limitPolicy || {};
    const pp = penaltyOrg.penaltyPolicy || {};
    const late = pp.lateReturn || {};
    qs("#lateReturnDays").value = penaltyOrg.returnPolicy?.lateReturnDays ?? 7;
    const seizure = pp.seizure || {};
    // Přepínač zapnuto/vypnuto; vypnuté pravidlo se uloží s počtem 0, pole se zašedí.
    const row = (key, label, help, count, days, extra = "") => {
      const on = count > 0;
      return `<tr class="penalty-row${on ? "" : " off"}" data-key="${key}"><td data-label="Porušení"><b>${label}</b><br><small class="muted-inline">${help}</small>${extra}</td>
      <td data-label="Pravidlo"><label class="switch"><input type="checkbox" class="penalty-on" id="${key}On"${on ? " checked" : ""}><span class="switch-track" aria-hidden="true"></span><span class="switch-text">${on ? "Zapnuto" : "Vypnuto"}</span></label></td>
      <td data-label="Blokovat po"><div class="input-suffix"><input class="penalty-input" id="${key}Count" type="number" min="1" max="50" value="${esc(on ? count : 2)}"${on ? "" : " disabled"}><span>případech</span></div></td>
      <td data-label="Blokace"><div class="input-suffix"><input class="penalty-input" id="${key}Days" type="number" min="1" max="3650" value="${esc(days ?? "")}" placeholder="do konce roku"${on ? "" : " disabled"}><span>dní</span></div></td></tr>`;
    };
    box.innerHTML = `<table class="data-table penalty-table"><thead><tr><th>Porušení</th><th>Pravidlo</th><th>Blokovat po (za rok)${window.Mistenka.infoTip("Počítá se kalendářní rok podle dne lovu.")}</th><th>Délka blokace</th></tr></thead><tbody>
      ${row("limits", `Překročení limitů úlovků <span class="info-tip" tabindex="0" role="img" aria-label="${LIMITS_TIP}" data-tip="${LIMITS_TIP}">i</span>`, "místenky s překročeným denním, týdenním nebo měsíčním limitem", lp.violationsBeforeBlock, lp.blockDays)}
      ${row("late", "Pozdní odevzdání", "odevzdání po skončení dne lovu", late.count, late.blockDays, `<label class="checkbox-label penalty-check"><input type="checkbox" id="lateUnreturned"${late.includeUnreturned !== false ? " checked" : ""}> <span>počítat i neodevzdané (uzavřené po lhůtě)</span></label>`)}
      ${row("seizure", "Zadržení porybným", "místenka zadržená rybářskou stráží", seizure.count, seizure.blockDays)}
      </tbody></table>
      <p class="field-help">Po dosažení počtu se nákup místenek automaticky pozastaví; bez délky blokace platí do konce roku. Držitel dostane e-mail, blokaci vidíte níže a můžete ji zrušit. Odevzdání místenek blokace nikdy nebrání.</p>
      <button class="primary-button" type="submit">Uložit pravidla</button>`;
    qsa(".penalty-on", box).forEach((toggle) => toggle.addEventListener("change", () => {
      const tr = toggle.closest("tr");
      tr.classList.toggle("off", !toggle.checked);
      qs(".switch-text", tr).textContent = toggle.checked ? "Zapnuto" : "Vypnuto";
      qsa(".penalty-input", tr).forEach((input) => { input.disabled = !toggle.checked; });
    }));
  } catch (error) { box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#penaltyForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const int = (id, label, optional = false) => {
    const raw = qs(`#${id}`).value.trim();
    if (raw === "" && optional) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label}: zadejte celé číslo.`);
    return n;
  };
  // Vypnuté pravidlo = počet 0 (tak ho chápe server); u zapnutého je počet aspoň 1.
  const count = (key, label) => {
    if (!qs(`#${key}On`).checked) return 0;
    const n = int(`${key}Count`, `${label} – počet`);
    if (n < 1) throw new Error(`${label}: počet případů musí být aspoň 1, nebo pravidlo vypněte.`);
    return n;
  };
  const days = (key, label) => (qs(`#${key}On`).checked ? int(`${key}Days`, `${label} – délka blokace`, true) : null);
  const data = structuredClone(penaltyOrg);
  data.limitPolicy = { violationsBeforeBlock: count("limits", "Limity úlovků"), blockDays: days("limits", "Limity úlovků") };
  data.penaltyPolicy = {
    lateReturn: { count: count("late", "Pozdní odevzdání"), blockDays: days("late", "Pozdní odevzdání"), includeUnreturned: qs("#lateUnreturned").checked },
    seizure: { count: count("seizure", "Zadržení"), blockDays: days("seizure", "Zadržení") }
  };
  await api("/manage/settings/organization", { method: "PUT", body: { data, note: "Pravidla při porušení" } });
  showToast("Pravidla uložena.", "success");
  loadPenaltyRules();
}));

qs("#returnPolicyForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const days = Number(qs("#lateReturnDays").value);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new Error("Lhůta pro odevzdání musí být celé číslo 0–60 dní.");
  const data = { ...structuredClone(penaltyOrg), returnPolicy: { lateReturnDays: days } };
  await api("/manage/settings/organization", { method: "PUT", body: { data, note: "Lhůta pro odevzdání" } });
  showToast(`Lhůta pro odevzdání: ${days} dní.`, "success");
  loadPenaltyRules();
}));

// ---------- kontroly porybným (nastavení organizace: checkPolicy) ----------
let checksOrg = null;
async function loadChecks() {
  const box = qs("#checksBox");
  try {
    checksOrg = (await api("/manage/settings")).organization.data;
    const on = checksOrg.checkPolicy?.memberHistory === true;
    box.innerHTML = `<label class="checkbox-label settings-check"><input type="checkbox" id="cpMemberHistory"${on ? " checked" : ""}> <span><b>Zobrazovat „Místenky člena“</b> – při kontrole porybný uvidí všechny místenky téhož čísla legitimace v týdnu a měsíci dne lovu, s úlovky (podklad pro týdenní a měsíční limity).${window.Mistenka.infoTip("Výchozí vypnuto – je to hodně informací navíc. Bez této volby porybný vidí jen kontrolovanou místenku, její úlovky, limity úlovků a záznam kontrol.")}</span></label>
      <button class="primary-button" type="submit">Uložit</button>`;
  } catch (error) { box.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#checksForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const data = { ...structuredClone(checksOrg), checkPolicy: { ...(checksOrg.checkPolicy || {}), memberHistory: qs("#cpMemberHistory").checked } };
  await api("/manage/settings/organization", { method: "PUT", body: { data, note: "Kontroly porybným" } });
  showToast("Nastavení kontrol uloženo.", "success");
  loadChecks();
}));

const CAUSE_LABELS = { limits: "limity úlovků", late_return: "pozdní odevzdání", seizure: "zadržení porybným", manual: "ručně" };
async function loadLimits() {
  loadPenaltyRules();
  const blocks = qs("#blockList");
  const violations = qs("#violationList");
  try {
    const [b, v] = await Promise.all([api("/manage/blocks"), api("/manage/violations")]);
    blocks.innerHTML = b.blocks.length ? `<table class="data-table"><thead><tr><th>Člen</th><th>Důvod</th><th>Do</th><th>Stav</th><th></th></tr></thead><tbody>${b.blocks.map((x) => `
      <tr><td data-label="Člen"><b>${esc(x.memberId)}</b><br><small class="muted-inline">${esc(x.holder)}</small></td><td data-label="Důvod">${esc(x.reason)}<br><small class="muted-inline">${x.source === "auto" ? `automaticky – ${esc(CAUSE_LABELS[x.cause] || x.cause)}` : "ručně"}</small></td>
      <td data-label="Do">${x.until ? esc(czDate(x.until)) : "do zrušení"}</td><td data-label="Stav"><span class="badge badge-${x.active ? "bad" : "off"}">${x.active ? "Aktivní" : x.liftedAt ? "Zrušená" : "Vypršela"}</span></td>
      <td>${x.active ? `<button class="secondary-button lift-block" type="button" data-id="${esc(x.id)}">Zrušit</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné blokace.</p>';
    qsa(".lift-block", blocks).forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Zrušit blokaci nákupu?")) return;
      button.disabled = true;
      try { await api(`/manage/blocks/${button.dataset.id}/lift`, { method: "POST" }); showToast("Blokace zrušena.", "success"); loadLimits(); }
      catch (error) { showToast(error.message, "error"); button.disabled = false; }
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
  if (untilRaw && !until) return showToast("Datum zadejte ve tvaru den.měsíc.rok.", "warning");
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/manage/blocks", { method: "POST", body: { memberId: qs("#blockMemberId").value, reason: qs("#blockReason").value.trim(), until } });
    qs("#blockForm").reset();
    showToast("Člen je zablokován.", "success");
    loadLimits();
  } catch (error) { showToast(error.message, "error"); }
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
  try { await fn(); } catch (error) { showToast(error.message, "error"); } finally { if (button) button.disabled = false; }
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
  try { filters = currentFilters(); } catch (error) { return showToast(error.message, "error"); }
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
        <td data-label="Revír">${esc(t.revir)}${t.subdistrict ? `<br><small class="muted-inline">${esc(t.subdistrict)}</small>` : ""}</td><td data-label="Stav"><span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span>${t.seized && t.status !== "seized" ? ' <span class="badge badge-bad">zadržena</span>' : ""}${t.suspicious ? ' <span class="badge badge-warn" title="Neobvyklé míry nebo váhy úlovků">podezřelá</span>' : ""}</td>
        <td data-label="Úlovky">${t.status === "expired_returned" ? (t.noCatch ? "nic neponecháno" : esc(t.catchCount)) : ""}</td><td data-label="Cena">${t.voucherUsed ? "poukaz" : esc(czk(t.priceHalere))}</td></tr>`;
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
    // Úlovky: jeden seznam pro zobrazení i opravu správcem. „Opravit“ přepne řádky na pole (druh, délka, hmotnost);
    // upozornění zůstávají pod řádkem (po uložení se vyhodnotí znovu). Povinný důvod; historie oprav z auditu.
    const cz = (n) => String(n).replace(".", ",");
    const notes = (c) => `${c.warning ? `<div class="catch-note catch-note-rule">⚠ Možné porušení pravidel: ${esc(c.warning)}</div>` : ""}${c.suspect ? `<div class="catch-note catch-note-suspect">⚠ Neobvyklý údaj: ${esc(c.suspect)}</div>` : ""}`;
    const editFields = (c = {}) => `<div class="catch-edit"><div class="fish-field"><input class="cr-species" value="${esc(c.species ?? "")}" placeholder="druh" maxlength="60" aria-label="Druh"></div><div class="input-suffix"><input class="cr-length" type="number" min="1" step="any" value="${esc(c.length ?? "")}" aria-label="Délka"><span>cm</span></div><div class="input-suffix"><input class="cr-weight" type="number" min="0" step="0.01" value="${esc(c.weight ?? "")}" placeholder="—" aria-label="Hmotnost"><span>kg</span></div><button class="text-button cr-remove" type="button" aria-label="Odebrat úlovek">✕</button></div>`;
    const catchItem = (c = {}) => `<li class="catch-item" data-estimated="${c.weightEstimated ? "true" : "false"}" data-weight="${esc(c.weight ?? "")}">${c.species ? `<div class="catch-main"><b>${esc(c.species)}</b><span>${esc(cz(c.length))} cm</span>${c.weight ? `<span>${esc(cz(c.weight))} kg${c.weightEstimated ? ' <small class="muted-inline">odhad</small>' : ""}</span>` : ""}</div>` : ""}${d.correctable ? editFields(c) : ""}${notes(c)}</li>`;
    // Našeptávač druhů vlastní (nativní datalist se v modálním dialogu vykresluje mimo pole).
    const revirSpecies = () => config.reviry.find((r) => r.id === t.revir.id)?.fishRules?.species || [];
    const partText = (p) => (!p ? "—" : p.noCatch ? "nic neponecháno" : p.catches.map((c) => `${c.species} ${cz(c.length)} cm${c.weight ? ` · ${cz(c.weight)} kg` : ""}`).join(", ") || "—");
    const catchesBlock = t.returnedAt || t.catches.length ? `<section class="catches-section" id="catchesSection">
      <div class="catches-head"><h3>Úlovky ${t.catches.length ? `<small class="muted-inline">${t.catches.length} ks</small>` : ""}</h3>${d.correctable ? '<button class="text-button view-only" type="button" id="correctStart">✎ Opravit úlovky</button>' : ""}</div>
      ${d.correctable ? `<p class="field-help edit-only">Např. překlep ověřený s rybářem. Úlovky se znovu vyhodnotí (pravidla, neobvyklé údaje), přepočítají se limity této místenky a rybář dostane e-mail s původními a novými údaji. Původní údaje zůstanou v historii.</p>` : ""}
      <ul class="catch-detail-list" id="catchList">${t.catches.map(catchItem).join("")}${t.catches.length ? "" : `<li class="catch-empty view-only">${t.noCatch ? "Nic neponecháno" : "—"}</li>`}</ul>
      ${d.correctable ? `<div class="edit-only"><button class="text-button" type="button" id="correctAdd">+ Úlovek</button>
      <label class="checkbox-label settings-check"><input type="checkbox" id="correctNoCatch"${t.noCatch ? " checked" : ""}> <span>Žádná ponechaná ryba</span></label>
      <label class="field-label req" for="correctReason">Důvod opravy</label><input id="correctReason" class="correct-reason" maxlength="300" placeholder="např. ověřeno telefonicky – délka 38 cm, ne 78 cm">
      <div class="correct-actions"><button class="primary-button" type="button" id="correctSave">Uložit opravu</button><button class="secondary-button" type="button" id="correctCancel">Zrušit</button></div></div>` : ""}
    </section>` : "";
    const correctionsBlock = d.corrections?.length ? `<h3>Opravy úlovků</h3><ul class="correction-list">${d.corrections.map((c) => `<li><div><b>${esc(czDateTime(c.at))}</b>${c.by ? ` · ${esc(c.by)}` : ""} · ${esc(c.reason)}</div><div class="muted-inline">Původně: ${esc(partText(c.before))}</div><div>Nově: ${esc(partText(c.after))}</div></li>`).join("")}</ul>` : "";
    body.innerHTML = `
      <div class="dialog-head"><div><span class="section-kicker">Místenka</span><h2>${esc(t.code)} <span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span>${t.suspicious ? ' <span class="badge badge-warn">podezřelá</span>' : ""}</h2></div><button class="text-button" type="button" id="closeDialog">Zavřít ✕</button></div>
      <dl class="summary-list">
        <div><dt>Rybář</dt><dd>${esc(`${t.firstName} ${t.lastName}`)}${t.account ? " (účet)" : ""}</dd></div>
        <div><dt>Č. legitimace · narozen</dt><dd>${esc(t.memberId)} · ${esc(czDate(t.birthDate))}</dd></div>
        <div><dt>E-mail</dt><dd>${esc(t.email)}</dd></div>
        <div><dt>Revír · den lovu</dt><dd>${esc(t.revir.name)}${t.subdistrict ? ` (${esc(t.subdistrict.label)})` : ""} · ${esc(czDate(t.date, { weekday: true }))}</dd></div>
        <div><dt>Cena</dt><dd>${esc(czk(t.priceHalere))}${t.voucherUsed ? " · poukaz" : ""}${t.variableSymbol ? ` · VS ${esc(t.variableSymbol)}` : ""}</dd></div>
        <div><dt>Vytvořeno · vystaveno</dt><dd>${esc(czDateTime(t.createdAt))}${t.issuedAt ? ` · ${esc(czDateTime(t.issuedAt))}` : ""}</dd></div>
        ${t.returnedAt ? `<div><dt>Odevzdáno</dt><dd>${esc(czDateTime(t.returnedAt))}${t.late ? " · opožděně" : ""}</dd></div>` : ""}
      </dl>
      ${catchesBlock}
      ${correctionsBlock}
      ${t.seizure ? `<div class="status-error"><b>Zadrženo ${esc(czDateTime(t.seizure.at))}</b><br>${esc(t.seizure.reason)}${t.seizure.place ? ` · ${esc(t.seizure.place)}` : ""}</div>` : ""}
      ${t.suspicious ? `<div class="suspicion-box"><div class="suspicion-head"><b>Podezřelá místenka</b><span>Neobvyklé míry nebo váhy úlovků – viz oranžová upozornění výše. Po prověření příznak zrušte; důvody u úlovků zůstanou v historii.</span></div>
        <label class="field-label" for="suspicionNote">Poznámka k prověření <small class="muted-inline">(volitelné)</small></label>
        <div class="suspicion-row"><input id="suspicionNote" maxlength="300" placeholder="např. ověřeno s rybářem – překlep v délce"><button class="secondary-button" type="button" id="clearSuspicion">Zrušit příznak</button></div></div>` : ""}
      ${d.suspicionReview ? `<p class="suspicion-done">✓ Prověřeno ${esc(czDateTime(d.suspicionReview.at))}${d.suspicionReview.by ? ` · ${esc(d.suspicionReview.by)}` : ""} – příznak podezřelá zrušen.${d.suspicionReview.note ? `<br><small>${esc(d.suspicionReview.note)}</small>` : ""}</p>` : ""}
      ${d.cancellation ? `<div class="status-error"><b>Zrušeno ${esc(czDateTime(d.cancellation.at))}</b>${d.cancellation.byManager ? " správcem" : ""}<br>${esc(d.cancellation.reason)}</div>` : ""}
      ${limitsHtml(t.limits, { title: "Limity úlovků" })}
      ${d.violations.length ? `<p class="field-help">Zapsané překročení: ${d.violations.map((v) => `${esc(v.label)} ${esc(v.count)}/${esc(v.maxCount)}`).join(", ")}</p>` : ""}
      <h3>Platby</h3>${d.payments.length ? `<ul class="plain-list">${d.payments.map((p) => `<li>${esc(czDateTime(p.createdAt))} · ${esc(czk(p.amountHalere))} · ${esc(RESULT_LABELS[p.result] || p.result)}${p.resolution ? ` → ${esc(RESOLUTION_LABELS[p.resolution.action])}` : ""}</li>`).join("")}</ul>` : '<p class="muted">Žádné.</p>'}
      <h3>Kontroly porybným</h3>${d.checks.length ? `<ul class="plain-list">${d.checks.map((c) => `<li>${esc(czDateTime(c.at))} · ${esc(c.wardenName)}${c.status === "seized" ? " · zadržení" : ""}</li>`).join("")}</ul>` : '<p class="muted">Žádné.</p>'}
      <h3>E-maily</h3><ul class="plain-list">${d.emails.map((e) => `<li>${esc(czDateTime(e.createdAt))} · ${esc(e.subject)}${e.sentAt ? "" : e.error ? " · <b>chyba</b>" : " · čeká"}</li>`).join("") || "<li>—</li>"}</ul>
      ${d.cancellable ? `<details class="seize-box"><summary>Zrušit místenku</summary><p class="field-help">Místenka přestane platit a uvolní místo. ${t.payment === null && !t.voucherUsed ? "Peníze se nevracejí automaticky – vraťte je v bankovnictví. " : ""}Držitel vystavené místenky dostane e-mail.</p>
        <label class="field-label req" for="cancelReason">Důvod</label><input id="cancelReason" maxlength="300"><button class="danger-button" type="button" id="cancelTicket">Zrušit místenku</button></details>` : ""}`;
    qs("#closeDialog").addEventListener("click", () => dialog.close());
    // Oprava úlovků v seznamu.
    const section = qs("#catchesSection");
    const suggest = (row) => window.Mistenka.attachSpeciesSuggest(qs(".cr-species", row), revirSpecies);
    qsa("#catchList .catch-item", section || document).forEach((row) => { if (qs(".cr-species", row)) suggest(row); });
    const syncNoCatch = () => { const off = qs("#correctNoCatch").checked; qsa("#catchList input, #correctAdd", section).forEach((el) => { el.disabled = off; }); section.classList.toggle("no-catch", off); };
    qs("#correctStart")?.addEventListener("click", () => { section.classList.add("editing"); syncNoCatch(); if (!qs("#catchList .catch-item")) qs("#correctAdd").click(); });
    qs("#correctCancel")?.addEventListener("click", () => openTicket(t.code));
    qs("#correctNoCatch")?.addEventListener("change", syncNoCatch);
    qs("#correctAdd")?.addEventListener("click", () => { qs("#catchList").insertAdjacentHTML("beforeend", catchItem()); const row = qs("#catchList .catch-item:last-child"); suggest(row); qs(".cr-species", row).focus(); });
    qs("#catchList")?.addEventListener("click", (event) => { if (event.target.classList.contains("cr-remove")) event.target.closest(".catch-item").remove(); });
    qs("#correctSave")?.addEventListener("click", async (event) => {
      const noCatch = qs("#correctNoCatch").checked;
      const catches = noCatch ? [] : qsa("#catchList .catch-item").map((row) => {
        const weightRaw = qs(".cr-weight", row).value.trim();
        const weight = weightRaw === "" ? null : Number(weightRaw.replace(",", "."));
        // Nezměněná odhadnutá hmotnost zůstane označená jako odhad.
        return { species: qs(".cr-species", row).value.trim(), length: Number(qs(".cr-length", row).value.replace(",", ".")), weight, weightEstimated: row.dataset.estimated === "true" && weightRaw === row.dataset.weight };
      }).filter((c) => c.species || c.length);
      const reason = qs("#correctReason").value.trim();
      if (!noCatch && !catches.length) return showToast("Zapište aspoň jeden úlovek, nebo zaškrtněte „Žádná ponechaná ryba“.", "warning");
      if (reason.length < 3) { qs("#correctReason").focus(); return showToast("Uveďte důvod opravy.", "warning"); }
      const button = event.currentTarget;
      button.disabled = true;
      try { await api(`/manage/tickets/${t.code}/catches`, { method: "PUT", body: { noCatch, catches, reason } }); showToast("Úlovky opraveny, rybář dostane e-mail.", "success"); openTicket(t.code); loadTickets(); }
      catch (error) { showToast(error.message, "error"); button.disabled = false; }
    });
    qs("#clearSuspicion")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await api(`/manage/tickets/${t.code}/clear-suspicion`, { method: "POST", body: { note: qs("#suspicionNote").value.trim() } }); showToast("Příznak podezřelá zrušen.", "success"); openTicket(t.code); loadTickets(); }
      catch (error) { showToast(error.message, "error"); button.disabled = false; }
    });
    qs("#cancelTicket")?.addEventListener("click", async (event) => {
      const reason = qs("#cancelReason").value.trim();
      if (reason.length < 3) return showToast("Uveďte důvod zrušení.", "warning");
      if (!window.confirm(`Opravdu zrušit místenku ${t.code}?`)) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await api(`/manage/tickets/${t.code}/cancel`, { method: "POST", body: { reason } }); showToast("Místenka zrušena.", "success"); openTicket(t.code); loadTickets(); }
      catch (error) { showToast(error.message, "error"); button.disabled = false; }
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
      try { await api(`/manage/payments/${form.dataset.id}/resolve`, { method: "POST", body }); showToast("Platba vyřešena.", "success"); loadPayments(); }
      catch (error) { showToast(error.message, "error"); event.submitter.disabled = false; }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
function updatePaymentCount(n) {
  qs("#paymentCount").textContent = n;
  qs("#paymentCount").classList.toggle("hidden", !n);
}
qs("#showAllPayments").addEventListener("change", loadPayments);

// ---------- poukazy ----------
const VOUCHER_STATES = { valid: ["Platný", "ok"], used: ["Použitý", "off"], voided: ["Zneplatněný", "off"] };
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
      try { await api(`/manage/vouchers/${b.dataset.code}/void`, { method: "POST" }); loadVouchers(); } catch (error) { showToast(error.message, "error"); }
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
      try { await api(`/manage/announcements/${b.dataset.id}`, { method: "DELETE" }); showToast("Zpráva smazána.", "success"); loadAnnouncements(); } catch (error) { showToast(error.message, "error"); }
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
  showToast(id ? "Zpráva upravena." : "Zpráva zveřejněna.", "success");
  editAnnouncement(null);
  loadAnnouncements();
}));

// ---------- hlášení chyb (jen admin) ----------
const BUG_STATUS = { new: ["Nové", "warn"], in_progress: ["Řeší se", "info"], resolved: ["Vyřešené", "ok"], wontfix: ["Nebude se řešit", "off"] };
const BUG_PRIORITY = { low: ["Nízká", "off"], normal: ["Běžná", "info"], high: ["Vysoká", "warn"], critical: ["Kritická", "bad"] };
let bugFilter = "new";
let bugGithub = { configured: false, repo: null };
const bugBadge = (map, key) => `<span class="badge badge-${map[key]?.[1] || "off"}">${esc(map[key]?.[0] || key)}</span>`;
async function loadBugs(openId = "") {
  try {
    const data = await api("/manage/bug-reports", { query: bugFilter ? { status: bugFilter } : {} });
    bugGithub = data.github;
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    qs("#bugCount").textContent = data.counts.new || "";
    qs("#bugCount").classList.toggle("hidden", !data.counts.new);
    qs("#bugTabs").innerHTML = [...Object.entries(BUG_STATUS).map(([k, [label]]) => [k, label, data.counts[k]]), ["", "Vše", total]]
      .map(([k, label, n]) => `<button type="button" class="tab${k === bugFilter ? " active" : ""}" data-filter="${k}">${esc(label)} <span class="tab-count">${n}</span></button>`).join("");
    qsa("#bugTabs .tab").forEach((b) => b.addEventListener("click", () => { bugFilter = b.dataset.filter; qs("#bugDetail").innerHTML = ""; loadBugs(); }));
    qs("#bugList").innerHTML = data.reports.length ? `<table class="data-table bug-table"><thead><tr><th>#</th><th>Nahlášeno</th><th>Popis</th><th>Nahlásil</th><th>Priorita</th><th>Stav</th></tr></thead><tbody>${data.reports.map((r) => `
      <tr class="clickable" data-bug="${r.id}"><td data-label="#">${r.id}</td><td data-label="Nahlášeno">${esc(czDateTime(r.createdAt))}<br><small class="muted-inline">${esc(r.url || "")}</small></td>
      <td data-label="Popis">${esc(r.description.length > 110 ? `${r.description.slice(0, 110)}…` : r.description)}${r.hasScreenshot ? ' <span class="muted-inline">📷</span>' : ""}${r.githubUrl ? ' <span class="muted-inline">GitHub</span>' : ""}</td>
      <td data-label="Nahlásil">${r.user ? esc(r.user.name || r.user.email) : r.contactEmail ? esc(r.contactEmail) : '<span class="muted-inline">anonymně</span>'}</td>
      <td data-label="Priorita">${bugBadge(BUG_PRIORITY, r.priority)}</td><td data-label="Stav">${bugBadge(BUG_STATUS, r.status)}</td></tr>`).join("")}</tbody></table>`
      : '<p class="muted">Žádná hlášení v tomto stavu.</p>';
    qsa("tr[data-bug]").forEach((row) => row.addEventListener("click", () => showBug(row.dataset.bug)));
    if (openId) showBug(openId);
  } catch (error) { qs("#bugList").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
// Text pro GitHub issue (bez osobních údajů a snímku), když GitHub není na serveru nastaven.
const bugMarkdown = (r) => [r.description, "", `- Hlášení: #${r.id}`, `- Čas: ${r.createdAt}`, `- Stránka: ${r.url || "—"}`, `- Prohlížeč: ${r.userAgent || "—"}`, `- Okno: ${r.viewport || "—"}`, `- Priorita: ${r.priority}`,
  ...(r.log.length ? ["", "<details><summary>Poslední události</summary>", "", "```", ...r.log.map((e) => `${e.at} ${e.type} ${e.page || ""} ${e.message}`), "```", "</details>"] : [])].join("\n");
async function showBug(id) {
  const box = qs("#bugDetail");
  try {
    const { report: r } = await api(`/manage/bug-reports/${id}`);
    history.replaceState(null, "", `#bugs/${r.id}`);
    const options = (map, current) => Object.entries(map).map(([k, [label]]) => `<option value="${k}"${k === current ? " selected" : ""}>${esc(label)}</option>`).join("");
    box.innerHTML = `<div class="bug-detail">
      <div class="bug-detail-head"><h2>Hlášení #${r.id}</h2>${bugBadge(BUG_PRIORITY, r.priority)} ${bugBadge(BUG_STATUS, r.status)}</div>
      <p class="bug-description">${esc(r.description)}</p>
      <dl class="summary-list">
        <div><dt>Nahlášeno</dt><dd>${esc(czDateTime(r.createdAt))}</dd></div>
        <div><dt>Nahlásil</dt><dd>${r.user ? `${esc(r.user.name)} · <a class="text-link" href="mailto:${esc(r.user.email)}">${esc(r.user.email)}</a>` : r.contactEmail ? `nepřihlášený · <a class="text-link" href="mailto:${esc(r.contactEmail)}">${esc(r.contactEmail)}</a>` : "anonymně"}</dd></div>
        <div><dt>Stránka</dt><dd>${esc(r.url || "—")}</dd></div>
        <div><dt>Prohlížeč</dt><dd><small>${esc(r.userAgent || "—")}</small></dd></div>
        <div><dt>Okno</dt><dd>${esc(r.viewport || "—")}</dd></div>
      </dl>
      ${r.screenshot ? `<h3>Snímek obrazovky</h3><a href="${esc(r.screenshot)}" download="hlaseni-${r.id}.jpg" title="Stáhnout"><img class="bug-screenshot" src="${esc(r.screenshot)}" alt="Snímek obrazovky k hlášení ${r.id}"></a>` : ""}
      <h3>Poslední události <small class="muted-inline">(${r.log.length})</small></h3>
      ${r.log.length ? `<table class="data-table bug-log-table"><thead><tr><th>Čas</th><th>Typ</th><th>Stránka</th><th>Událost</th></tr></thead><tbody>${r.log.map((e) => `<tr class="log-${esc(e.type)}"><td data-label="Čas">${esc(e.at ? czDateTime(e.at) : "")}</td><td data-label="Typ">${esc(e.type)}</td><td data-label="Stránka">${esc(e.page)}</td><td data-label="Událost">${esc(e.message)}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Bez záznamu událostí.</p>'}
      <h3>Řešení</h3>
      <form id="bugForm" class="settings-form" novalidate>
        <div class="form-two-col"><div><label class="field-label" for="bugStatus">Stav</label><select id="bugStatus">${options(BUG_STATUS, r.status)}</select></div><div><label class="field-label" for="bugPriority">Priorita</label><select id="bugPriority">${options(BUG_PRIORITY, r.priority)}</select></div></div>
        <label class="field-label" for="bugNote">Poznámka</label><textarea id="bugNote" rows="3" maxlength="2000">${esc(r.note)}</textarea>
        <label class="field-label" for="bugGithubUrl">GitHub issue</label><input id="bugGithubUrl" type="url" maxlength="300" value="${esc(r.githubUrl || "")}" placeholder="https://github.com/…/issues/123">
        <div class="bug-actions"><button class="primary-button" type="submit">Uložit</button>
          ${r.githubUrl ? `<a class="secondary-button" href="${esc(r.githubUrl)}" target="_blank" rel="noreferrer">Otevřít na GitHubu ↗</a>`
            : bugGithub.configured ? `<button class="secondary-button" type="button" id="bugToGithub">Vytvořit GitHub issue (${esc(bugGithub.repo)})</button>`
              : '<button class="secondary-button" type="button" id="bugCopy">Zkopírovat pro GitHub</button>'}</div>
        ${!r.githubUrl && !bugGithub.configured ? '<p class="field-help">Automatické zakládání issue zapne nastavení MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO na serveru. Do té doby text zkopírujte, založte issue ručně a odkaz vložte výše.</p>' : ""}
      </form></div>`;
    qs("#bugForm").addEventListener("submit", (event) => submitForm(event, async () => {
      await api(`/manage/bug-reports/${r.id}`, { method: "PATCH", body: { status: qs("#bugStatus").value, priority: qs("#bugPriority").value, note: qs("#bugNote").value, githubUrl: qs("#bugGithubUrl").value.trim() } });
      showToast("Hlášení uloženo.", "success");
      loadBugs(r.id);
    }));
    qs("#bugToGithub")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try { await api(`/manage/bug-reports/${r.id}/github`, { method: "POST" }); showToast("GitHub issue založeno.", "success"); loadBugs(r.id); } catch (error) { showToast(error.message, "error"); event.currentTarget.disabled = false; }
    });
    qs("#bugCopy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(bugMarkdown(r)); showToast("Text pro GitHub zkopírován.", "success"); } catch { showToast("Kopírování se nepodařilo – označte text ručně.", "warning"); }
    });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { showToast(error.message, "error"); }
}

// ---------- ceny a místa ----------
// Prodejní údaje v jedné tabulce: revír s podrevíry v prodeji má cenu a místa po podrevírech (místenka platí
// pro jeden podrevír), jinak za celý revír. Ukládá se jako nová verze nastavení revíru (PUT /manage/settings/reviry/{id}).
async function loadPricing() {
  loadSalesPolicy();
  const panel = qs("#pricingPanel");
  try {
    const view = await api("/manage/settings");
    const input = (cls, value, attrs) => `<input class="${cls}" type="number" value="${esc(value ?? "")}" ${attrs}>`;
    const activeSubs = (r) => (r.data.ticketSubdistricts || []).map((n) => ({ number: n, ...((r.data.subdistrictList || []).find((s) => String(s.number) === String(n)) || {}) }));
    const row = (r, s = null) => `
      <tr data-revir="${esc(r.id)}"${s ? ` data-sub="${esc(s.number)}"` : ""}><td data-label="Revír">${s ? `<span class="pricing-sub">${esc(s.name ? `${s.number} – ${s.name}` : `Podrevír ${s.number}`)}</span>` : `<b>${esc(r.data.name)}</b><br><small class="muted-inline">celý revír</small>`}</td>
      <td data-label="Cena za den (Kč)">${input("pr-price", s ? s.priceCzk ?? r.data.priceCzk : r.data.priceCzk, 'min="0" step="1"')}</td>
      <td data-label="Míst na den">${input("pr-capacity", s ? s.dailyCapacity ?? r.data.dailyCapacity : r.data.dailyCapacity, 'min="1" step="1"')}</td>
      <td class="row-actions"><button class="primary-button pr-save" type="button">Uložit</button></td></tr>`;
    panel.innerHTML = `<table class="data-table pricing-table"><thead><tr><th>Revír / podrevír</th><th>Cena za den (Kč)</th><th>Míst na den</th><th></th></tr></thead><tbody>${view.reviry.map((r) => {
      const subs = activeSubs(r);
      return subs.length ? `<tr class="pricing-revir"><td colspan="4"><b>${esc(r.data.name)}</b> <small class="muted-inline">místenka na jeden podrevír${subs.length === 1 ? " (vybere se automaticky)" : ""}</small></td></tr>${subs.map((s) => row(r, s)).join("")}` : row(r);
    }).join("")}</tbody></table>
      <p class="field-help">Které podrevíry se prodávají, určíte v sekci Revíry (sloupec „Platí místenka“). Podrevír v prodeji má vlastní cenu a počet míst; místenka platí pro jeden vybraný podrevír.</p>
`;
    qsa("tr[data-revir]", panel).forEach((row) => qs(".pr-save", row).addEventListener("click", async (event) => {
      const revir = view.reviry.find((r) => r.id === row.dataset.revir);
      const num = (cls, label, int = true) => {
        const value = Number(qs(cls, row).value);
        if (qs(cls, row).value.trim() === "" || !Number.isFinite(value) || (int && !Number.isInteger(value))) throw new Error(`${revir.data.name}: ${label} – zadejte ${int ? "celé " : ""}číslo.`);
        return value;
      };
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const price = num(".pr-price", "cena", false);
        const capacity = num(".pr-capacity", "míst na den");
        const data = structuredClone(revir.data);
        if (row.dataset.sub) {
          data.subdistrictList = (data.subdistrictList || []).map((s) => (String(s.number) === row.dataset.sub ? { ...s, priceCzk: price, dailyCapacity: capacity } : s));
        } else Object.assign(data, { priceCzk: price, dailyCapacity: capacity });
        delete data.lateReturnDays; // lhůta pro odevzdání a prodej dopředu jsou u MO
        delete data.bookingDaysAhead;
        await api(`/manage/settings/reviry/${encodeURIComponent(revir.id)}`, { method: "PUT", body: { data, note: "Ceny a místa" } });
        showToast(`${revir.data.name}${row.dataset.sub ? `, podrevír ${row.dataset.sub}` : ""}: uloženo.`, "success");
        loadPricing();
      } catch (error) { showToast(error.message, "error"); button.disabled = false; }
    }));
  } catch (error) { panel.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}

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
    const [label, tone] = s ? SEASON_STATES[s.state] : ["Zavřeno", "warn"];
    const period = s
      ? `${esc(s.name)}${s.revirId ? "" : ' <small class="muted-inline">(všechny revíry)</small>'}<br><small class="muted-inline">${esc(seasonPeriod(s))}</small>`
      : '<small class="muted-inline">Bez sezony – místenky se neprodávají.</small>';
    const closable = s && (s.state === "open" || s.state === "upcoming");
    return `<div class="revir-status-card"><div class="revir-status-head"><b>${esc(r.name)}</b><span class="badge badge-${tone}">${label}</span></div><p>${period}</p>
      ${closable ? `<button class="danger-button toggle-close" type="button">${window.Mistenka.icon("lock")} Uzavřít sezonu ▾</button>
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
      showToast("Sezona uzavřena.", "success");
      loadSeasons();
    }));
  });
}
// Prodej dopředu – jeden údaj pro celou organizaci (nastavení organizace: salesPolicy).
let salesOrg = null;
async function loadSalesPolicy() {
  try {
    salesOrg = (await api("/manage/settings")).organization.data;
    qs("#bookingDaysAhead").value = salesOrg.salesPolicy?.bookingDaysAhead ?? 3;
  } catch (error) { showToast(error.message, "error"); }
}
qs("#salesPolicyForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const days = Number(qs("#bookingDaysAhead").value);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new Error("Prodej dopředu musí být celé číslo 0–60 dní.");
  await api("/manage/settings/organization", { method: "PUT", body: { data: { ...structuredClone(salesOrg), salesPolicy: { bookingDaysAhead: days } }, note: "Prodej dopředu" } });
  showToast(days ? `Místenky se prodávají ${days} dní dopředu.` : "Místenky se prodávají jen na dnešek.", "success");
  loadSalesPolicy();
}));
async function loadSeasons() {
  try {
    const [{ seasons }, { closures }, cfg] = await Promise.all([api("/manage/seasons"), api("/manage/closures"), api("/config")]);
    seasonToday = cfg.today;
    // Před spuštěním: první sezonu otevře správa až s nastavenými e-maily (server to hlídá: email_not_ready).
    const note = qs("#launchNote");
    note.classList.toggle("hidden", Boolean(cfg.service?.launched));
    if (!cfg.service?.launched) note.innerHTML = "<b>Místenka zatím není spuštěná.</b> Rybáři vidí uzavřenou sezonu a nemohou se registrovat ani přihlásit. Otevřením první sezony službu spustíte – předtím musí admin v <b>Admin → Emailoví klienti</b> nastavit odesílatele všech skupin e-mailů a příjemce upozornění.";
    renderRevirStatus(seasons);
    qs("#seasonList").innerHTML = seasons.length ? `<table class="data-table"><thead><tr><th>Sezona</th><th>Revír</th><th>Období</th><th>Stav</th><th></th></tr></thead><tbody>${seasons.map((s) => {
      const [label, tone] = SEASON_STATES[s.state];
      return `<tr><td data-label="Sezona"><b>${esc(s.name)}</b></td><td data-label="Revír">${esc(s.revirName)}</td><td data-label="Období">${esc(shortDate(s.opensOn))} – ${esc(shortDate(s.closesOn) || "do uzavření")}</td><td data-label="Stav"><span class="badge badge-${tone}">${label}</span></td>
        <td class="row-actions"><button class="text-button delete-season" type="button" data-id="${s.id}">Smazat</button></td></tr>`;
    }).join("")}</tbody></table>` : '<p class="muted">Zatím žádná sezona.</p>';
    qsa(".delete-season").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Smazat sezonu? Revír bez sezony je zavřený – místenky se na něj neprodávají.")) return;
      try { await api(`/manage/seasons/${b.dataset.id}`, { method: "DELETE" }); loadSeasons(); } catch (error) { showToast(error.message, "error"); }
    }));
    qs("#closureList").innerHTML = closures.length ? `<table class="data-table"><thead><tr><th>Dny</th><th>Revír</th><th>Důvod</th><th></th></tr></thead><tbody>${closures.map((c) => `
      <tr><td data-label="Dny"><b>${esc(shortDate(c.dateFrom))}${c.dateTo !== c.dateFrom ? ` – ${esc(shortDate(c.dateTo))}` : ""}</b></td><td data-label="Revír">${esc(c.revirName)}</td><td data-label="Důvod">${esc(c.reason)}</td>
      <td><button class="text-button delete-closure" type="button" data-id="${c.id}">Zrušit</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádná uzavření.</p>';
    qsa(".delete-closure").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Zrušit uzavření? Na tyto dny půjde znovu kupovat místenky.")) return;
      try { await api(`/manage/closures/${b.dataset.id}`, { method: "DELETE" }); loadSeasons(); } catch (error) { showToast(error.message, "error"); }
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
  showToast(`${season.name} otevřena.`, "success");
  toggleSeasonForm(false);
  loadSeasons();
}));
qs("#closureForm").addEventListener("submit", (event) => submitForm(event, async () => {
  const result = await api("/manage/closures", { method: "POST", body: { dateFrom: dateField("closureFrom", "Od"), dateTo: dateField("closureTo", "Do"), revirId: qs("#closureRevir").value || null, reason: qs("#closureReason").value.trim() } });
  qs("#closureForm").reset();
  fillRevirSelects();
  const n = result.affectedTickets.length;
  showToast(n ? `Revír uzavřen. ${n} dotčených místenek dostalo e-mail – vrácení peněz vyřiďte ručně.` : "Revír uzavřen. Žádná prodaná místenka se ho netýká.", "success");
  loadSeasons();
}));

// ---------- zálohy a audit (jen admin) ----------
const KIND_LABELS = { daily: ["denní", "info"], season: ["po uzávěrce", "ok"], manual: ["ruční", "off"], "pre-restore": ["před obnovou", "info"] };
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
        showToast(`Obnoveno ze zálohy ${result.file}. Pojistná záloha: ${result.safetyBackup.file}.`, "success");
        loadBackups();
      } catch (error) { showToast(error.message, "error"); b.disabled = false; }
    }));
    qsa(".delete-backup", list).forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Smazat zálohu? Nelze vrátit.")) return;
      try { await api(`/manage/backups/${b.dataset.id}`, { method: "DELETE" }); loadBackups(); } catch (error) { showToast(error.message, "error"); }
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#createBackup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const note = window.prompt("Poznámka k záloze (volitelné):", "");
  if (note === null) return;
  button.disabled = true;
  try { await api("/manage/backups", { method: "POST", body: { note } }); showToast("Záloha vytvořena.", "success"); loadBackups(); } catch (error) { showToast(error.message, "error"); } finally { button.disabled = false; }
});
const ACTION_LABELS = { roles_changed: "změna rolí", roles_forced: "role (příkazová řádka)", staff_invited: "pozvání do správy", admin_setup: "založení admina", settings_changed: "nastavení", ticket_seized: "zadržení místenky", ticket_cancelled: "zrušení místenky", ticket_catches_corrected: "oprava úlovků", ticket_suspicion_cleared: "zrušení příznaku podezřelá",
  payment_resolved: "vyřešení platby", member_blocked: "blokace člena", member_blocked_auto: "automatická blokace", member_unblocked: "zrušení blokace", backup_created: "záloha", backup_deleted: "smazání zálohy", season_created: "sezona", season_updated: "úprava sezony", season_deleted: "smazání sezony",
  closure_created: "uzavření revíru", closure_deleted: "zrušení uzavření", announcement_created: "nová zpráva", announcement_updated: "úprava zprávy", announcement_deleted: "smazání zprávy", vouchers_created: "nové poukazy", voucher_voided: "zneplatnění poukazu",
  stocking_created: "zarybnění", stocking_updated: "úprava zarybnění", stocking_deleted: "smazání zarybnění", stocking_budget_set: "rozpočet zarybnění", report_created: "uzávěrka", season_report_created: "uzávěrka sezony",
  account_verified: "ověření účtu", account_deleted: "smazání účtu", password_reset: "obnova hesla", password_changed: "změna hesla", email_changed: "změna e-mailu", two_factor_enabled: "zapnutí 2FA", two_factor_disabled: "vypnutí 2FA",
  email_account_created: "nový e-mailový účet", email_account_updated: "úprava e-mailového účtu", email_account_deleted: "smazání e-mailového účtu", email_account_verified: "ověření e-mailového účtu",
  email_account_verify_failed: "neúspěšný test e-mailového účtu", email_senders_changed: "odesílatelé e-mailů",
  warden_requested: "žádost o porybného", warden_request_approved: "schválení porybného", warden_request_rejected: "zamítnutí porybného" };
async function loadAudit() {
  const list = qs("#auditList");
  try {
    const { events } = await api("/manage/audit", { query: { limit: 300 } });
    list.innerHTML = events.length ? `<table class="data-table"><thead><tr><th>Kdy</th><th>Kdo</th><th>Akce</th><th>Cíl</th><th>Podrobnosti</th></tr></thead><tbody>${events.map((e) => `
      <tr><td data-label="Kdy">${esc(czDateTime(e.at))}</td><td data-label="Kdo">${esc(e.actor)}</td><td data-label="Akce">${esc(ACTION_LABELS[e.action] || e.action)}</td><td data-label="Cíl">${esc([e.targetType, e.targetId].filter(Boolean).join(" "))}</td>
      <td data-label="Podrobnosti"><small class="muted-inline">${e.detail ? esc(JSON.stringify(e.detail).slice(0, 160)) : ""}</small></td></tr>`).join("")}</tbody></table>` : '<p class="muted">Žádné záznamy.</p>';
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}

// ---------- e-mailoví klienti (SMTP účty) ----------
// Admin účty zakládá, upravuje, testuje a maže; správce vybírá odesílatele skupin (jen ověřené účty).
const ENCRYPTION_LABELS = { ssl: "SSL/TLS (465)", tls: "STARTTLS (587)", none: "bez šifrování" };
async function loadEmail() {
  const panel = qs("#emailPanel");
  try {
    const { accounts, senders, groups, noticeRecipients, ready, missing, canEdit, delivery } = await api("/manage/email/accounts");
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const missingLabels = missing.map((id) => (id === "noticeRecipients" ? "příjemci upozornění" : `odesílatel – ${groups.find((g) => g.id === id)?.label || id}`));
    const groupRow = (g) => {
      const current = senders[g.id] ? byId.get(senders[g.id]) : null;
      const options = ['<option value="">— nepřiřazeno (e-maily neodejdou) —</option>', ...accounts.filter((a) => a.verified || a.id === senders[g.id]).map((a) => `<option value="${a.id}"${a.id === senders[g.id] ? " selected" : ""}>${esc(`${a.label} – ${a.fromEmail}`)}${a.verified ? "" : " (neověřený)"}</option>`)];
      const warn = current && !current.verified ? '<small class="over-budget">Účet není ověřený – e-maily této skupiny neodejdou, dokud ho admin znovu neotestuje.</small>' : !current ? '<small class="over-budget">Bez odesílatele – e-maily této skupiny čekají ve frontě.</small>' : "";
      return `<div class="email-group"><label class="field-label" for="sender-${g.id}">${esc(g.label)}</label><select id="sender-${g.id}" data-group="${g.id}">${options.join("")}</select><small class="muted-inline">${esc(g.help)}</small>${warn}</div>`;
    };
    const status = (a) => (a.verified ? `<span class="badge badge-ok">ověřeno</span><br><small class="muted-inline">${esc(czDateTime(a.verifiedAt))} → ${esc(a.verifiedTo || "")}</small>`
      : a.lastError ? `<span class="badge badge-bad">chyba</span><br><small class="muted-inline">${esc(a.lastError.slice(0, 160))}</small>` : '<span class="badge badge-off">neověřeno</span>');
    const used = (a) => a.usedFor.map((id) => groups.find((g) => g.id === id)?.label || id).join(", ");
    panel.innerHTML = `
      ${delivery === "file" ? '<p class="field-help">Vývojový server: e-maily se neodesílají, ukládají se do složky <code>data/outbox</code> (i test účtu).</p>' : ""}
      <div class="email-ready ${ready ? "ok" : "warn"}">${ready ? "✓ E-maily jsou nastavené – všechny skupiny mají odesílatele a upozornění mají příjemce." : `<b>E-maily nejsou nastavené.</b> Chybí: ${esc(missingLabels.join(", "))}. Dokud to nedoplníte, e-maily dotčených skupin neodejdou a nejde otevřít první sezonu.`}</div>
      <h2 class="manage-h2">Odesílatelé podle druhu e-mailu</h2>
      <form id="senderForm" class="settings-form" novalidate>${groups.map(groupRow).join("")}
        <div class="email-group"><label class="field-label" for="noticeRecipients">Příjemci upozornění správcům</label><textarea id="noticeRecipients" rows="2" maxlength="2100" placeholder="spravce@…, predseda@…">${esc(noticeRecipients.join(", "))}</textarea><small class="muted-inline">Komu chodí upozornění: žádosti „Jsem porybný“, zadržení, překročené limity, uzávěrka sezony. Více adres oddělte čárkou (nejvýše 10).</small></div>
        <button class="primary-button" type="submit">Uložit odesílatele a příjemce</button></form>
      <h2 class="manage-h2">Poštovní účty</h2>
      ${canEdit ? `<details class="invite-box" id="accountBox"><summary>+ Přidat účet</summary>${accountForm()}</details>` : '<p class="field-help">Účty zakládá a ověřuje admin.</p>'}
      ${accounts.length ? `<table class="data-table"><thead><tr><th>Účet</th><th>Server</th><th>Stav</th><th>Používá se pro</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${accounts.map((a) => `
        <tr data-account="${a.id}"><td data-label="Účet"><b>${esc(a.label)}</b><br><small class="muted-inline">${esc(a.fromName ? `${a.fromName} <${a.fromEmail}>` : a.fromEmail)}</small></td>
        <td data-label="Server">${esc(`${a.host}:${a.port}`)}<br><small class="muted-inline">${esc(ENCRYPTION_LABELS[a.encryption] || a.encryption)}${a.username ? ` · ${esc(a.username)}` : ""}</small></td>
        <td data-label="Stav">${status(a)}</td><td data-label="Používá se pro">${esc(used(a)) || '<span class="muted-inline">—</span>'}</td>
        ${canEdit ? '<td class="row-actions"><button class="text-button test-account" type="button">Otestovat</button><button class="text-button edit-account" type="button">Upravit</button><button class="text-button delete-account" type="button">Smazat</button></td>' : ""}</tr>`).join("")}</tbody></table>`
        : '<p class="muted">Zatím žádný účet – Místenka neodešle žádný e-mail.</p>'}`;

    qs("#senderForm").addEventListener("submit", (event) => submitForm(event, async () => {
      const body = Object.fromEntries(qsa("#senderForm select").map((select) => [select.dataset.group, select.value ? Number(select.value) : null]));
      body.noticeRecipients = qs("#noticeRecipients").value;
      await api("/manage/email/senders", { method: "PUT", body });
      showToast("Odesílatelé a příjemci uloženi.", "success");
      loadEmail();
    }));
    if (!canEdit) return;
    const form = qs("#accountForm");
    form.addEventListener("submit", (event) => submitForm(event, async () => {
      const id = form.dataset.id;
      const body = { label: qs("#aLabel").value.trim(), fromEmail: qs("#aFrom").value.trim(), fromName: qs("#aName").value.trim(), host: qs("#aHost").value.trim(), port: Number(qs("#aPort").value), encryption: qs("#aEnc").value, username: qs("#aUser").value.trim(), password: qs("#aPass").value };
      await api(id ? `/manage/email/accounts/${id}` : "/manage/email/accounts", { method: id ? "PUT" : "POST", body });
      showToast(id ? "Účet upraven. Pokud se změnilo připojení, otestujte ho znovu." : "Účet přidán. Ověřte ho testovacím e-mailem.", "success");
      loadEmail();
    }));
    // Obvyklý port podle šifrování (jen pokud uživatel nezadal vlastní).
    qs("#aEnc").addEventListener("change", (event) => { const port = qs("#aPort"); if (["465", "587", "25", ""].includes(port.value)) port.value = { ssl: 465, tls: 587, none: 25 }[event.target.value]; });
    qsa("tr[data-account]", panel).forEach((row) => {
      const account = byId.get(Number(row.dataset.account));
      qs(".edit-account", row).addEventListener("click", () => {
        qs("#accountBox").open = true;
        form.dataset.id = account.id;
        qs("#aLabel").value = account.label; qs("#aFrom").value = account.fromEmail; qs("#aName").value = account.fromName; qs("#aHost").value = account.host;
        qs("#aPort").value = account.port; qs("#aEnc").value = account.encryption; qs("#aUser").value = account.username; qs("#aPass").value = "";
        qs("#aPass").placeholder = account.hasPassword ? "beze změny" : "";
        qs("#accountSubmit").textContent = "Uložit změny";
        qs("#aLabel").focus();
      });
      qs(".test-account", row).addEventListener("click", async (event) => {
        const to = window.prompt("Na jakou adresu poslat testovací e-mail?", me.email);
        if (to === null) return;
        event.currentTarget.disabled = true;
        try { await api(`/manage/email/accounts/${account.id}/verify`, { method: "POST", body: { to: to.trim() } }); showToast(`Testovací e-mail odeslán na ${to.trim()}. Účet je ověřený.`, "success"); } catch (error) { showToast(error.message, "error"); }
        loadEmail();
      });
      qs(".delete-account", row).addEventListener("click", async () => {
        if (!window.confirm(`Smazat účet ${account.label}?${account.usedFor.length ? " Skupiny, které ho používají, zůstanou bez odesílatele a jejich e-maily neodejdou." : ""}`)) return;
        try { await api(`/manage/email/accounts/${account.id}`, { method: "DELETE" }); showToast("Účet smazán.", "success"); loadEmail(); } catch (error) { showToast(error.message, "error"); }
      });
    });
  } catch (error) { panel.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
function accountForm() {
  const f = (id, label, attrs = "", req = false) => `<div><label class="field-label${req ? " req" : ""}" for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
  return `<form id="accountForm" novalidate>
    <div class="form-two-col">${f("aLabel", "Název účtu", 'maxlength="80" placeholder="např. Místenka – místenky"')}${f("aName", "Jméno odesílatele", 'maxlength="100" placeholder="Místenka – MO Karviná"')}</div>
    <div class="form-two-col">${f("aFrom", "Adresa odesílatele", 'type="email" maxlength="200" placeholder="mistenka@…"', true)}${f("aHost", "Server SMTP", 'maxlength="253" placeholder="smtp.websupport.cz"', true)}</div>
    <div class="form-two-col"><div><label class="field-label req" for="aEnc">Šifrování</label><select id="aEnc">${Object.entries(ENCRYPTION_LABELS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div>${f("aPort", "Port", 'type="number" min="1" max="65535" value="465"', true)}</div>
    <div class="form-two-col">${f("aUser", "Přihlašovací jméno", 'maxlength="200" autocomplete="off" placeholder="obvykle celá e-mailová adresa"')}${f("aPass", "Heslo", 'type="password" maxlength="500" autocomplete="new-password"')}</div>
    <p class="field-help">Heslo se ukládá šifrovaně a už se nikdy nezobrazí. Adresa odesílatele musí patřit k tomuto poštovnímu účtu (SPF/DKIM), jinak e-maily skončí ve spamu.</p>
    <p class="req-legend"><span class="required">*</span> povinné údaje</p>
    <button class="primary-button" type="submit" id="accountSubmit">Přidat účet</button>
  </form>`;
}

// ---------- notifikace (žádosti ke schválení; zatím „Jsem porybný“) ----------
const REQUEST_STATES = { pending: ["čeká na schválení", "warn"], approved: ["schváleno", "ok"], rejected: ["zamítnuto", "off"] };
// Texty podle druhu notifikace – nový druh = nový záznam (server vrací kind).
const NOTIFICATION_KINDS = {
  warden_request: { title: "Žádost o funkci porybného", approved: "Schváleno – uživatel je porybný a dostal e-mail.", rejected: "Zamítnuto – žadatel dostal e-mail." }
};
const notificationKind = (kind) => NOTIFICATION_KINDS[kind] || { title: "Notifikace", approved: "Schváleno.", rejected: "Zamítnuto." };
function updateNotificationCount(n) {
  const badge = qs("#notificationCount");
  badge.textContent = n;
  badge.classList.toggle("hidden", !n);
}
async function loadNotifications() {
  const list = qs("#notificationList");
  try {
    const { notifications, pending } = await api("/manage/notifications");
    updateNotificationCount(pending);
    const showAll = qs("#showAllNotifications").checked;
    const rows = notifications.filter((n) => showAll || n.status === "pending");
    list.innerHTML = rows.length ? rows.map((n) => {
      const [label, tone] = REQUEST_STATES[n.status] || [n.status, "off"];
      const who = n.user ? `<b>${esc(n.user.name)}</b> <small class="muted-inline">${esc(n.user.email)}${n.user.memberId ? ` · legitimace ${esc(n.user.memberId)}` : ""}</small>` : '<span class="muted-inline">účet byl smazán</span>';
      const decided = n.decidedAt ? `<p class="field-help">${esc(label)} ${esc(czDateTime(n.decidedAt))}${n.decidedBy ? ` · ${esc(n.decidedBy)}` : ""}${n.decisionNote ? ` · „${esc(n.decisionNote)}“` : ""}</p>` : "";
      return `<article class="notification-card" data-id="${n.id}" data-kind="${esc(n.kind)}">
        <div class="notification-head"><span class="badge badge-${tone}">${esc(label)}</span><span class="muted-inline">${esc(czDateTime(n.createdAt))}</span></div>
        <p class="notification-title">${esc(notificationKind(n.kind).title)} – ${who}</p>
        ${n.note ? `<p class="notification-note">„${esc(n.note)}“</p>` : ""}${decided}
        ${n.status === "pending" ? `<div class="row-actions"><input class="decision-note" maxlength="300" placeholder="Poznámka pro žadatele (volitelné)"><button class="primary-button decide" type="button" data-action="approve">Schválit</button><button class="secondary-button decide" type="button" data-action="reject">Zamítnout</button></div>` : ""}
      </article>`;
    }).join("") : `<p class="muted">${showAll ? "Žádné notifikace." : "Nic nečeká na vyřízení."}</p>`;
    qsa(".decide", list).forEach((button) => button.addEventListener("click", async () => {
      const card = button.closest(".notification-card");
      qsa("button", card).forEach((b) => { b.disabled = true; });
      try {
        await api(`/manage/notifications/${card.dataset.id}/${button.dataset.action}`, { method: "POST", body: { note: qs(".decision-note", card).value.trim() } });
        const texts = notificationKind(card.dataset.kind);
        showToast(button.dataset.action === "approve" ? texts.approved : texts.rejected, "success");
      } catch (error) { showToast(error.message, "error"); }
      loadNotifications();
    }));
  } catch (error) { list.innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#showAllNotifications").addEventListener("change", loadNotifications);

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
  // Uživatelé a role: správce hlavně jmenuje porybné z rybářů → výchozí záložka Rybář, admin začíná u Admin.
  userRole = hasRole(me, "admin") ? "admin" : "member";
  qsa("#roleTabs .tab").forEach((tab) => { tab.classList.toggle("active", tab.dataset.role === userRole); tab.setAttribute("aria-selected", String(tab.dataset.role === userRole)); });
  qs("#rolesHelp").textContent = hasRole(me, "admin")
    ? "Jako admin jmenujete porybné, správce i další adminy. Posledního admina nelze odebrat. Role lze dát jen účtu s ověřeným e-mailem."
    : "Jako správce můžete jmenovat a odvolávat porybné. Správce a adminy jmenuje admin.";
  loadTickets();
  api("/manage/payments").then(({ payments }) => updatePaymentCount(payments.length)).catch(() => {});
  api("/manage/notifications").then(({ pending }) => updateNotificationCount(pending)).catch(() => {});
  // Odkaz přímo na sekci: manage.html#seasons
  const target = qs(`.manage-nav-item[data-section="${CSS.escape(location.hash.slice(1).split("/")[0])}"]`);
  if (target && !target.classList.contains("hidden")) target.click();
})();
