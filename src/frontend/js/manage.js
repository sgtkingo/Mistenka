// Manažerský portál (správce a admin). Zatím sekce Uživatelé a role (B1); další sekce podle docs/PLAN.md.
const { qs, qsa, esc, api, loadConfig, showToast, applyBranding, initUserMenu, hasRole, isStaff, ROLE_LABELS, czDate, parseCzDate } = window.Mistenka;

let me = null;

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
  if (section === "limits") loadLimits();
  if (section === "soon") {
    qs("#soonTitle").textContent = item.dataset.title;
    qs("#soonStep").textContent = `Krok ${item.dataset.step}`;
  }
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

// ---------- start ----------
(async function init() {
  try { applyBranding(await loadConfig()); } catch { /* bez konfigurace */ }
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
  loadUsers();
})();
