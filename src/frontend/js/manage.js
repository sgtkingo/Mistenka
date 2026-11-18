// Manažerský portál (správce a admin). Zatím sekce Uživatelé a role (B1); další sekce podle docs/PLAN.md.
const { qs, qsa, esc, api, loadConfig, showToast, applyBranding, initUserMenu, hasRole, isStaff, ROLE_LABELS, czDate, parseCzDate } = window.Mistenka;

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
  if (section !== "soon") history.replaceState(null, "", section === "users" ? location.pathname : `#${section}`);
  if (section === "limits") loadLimits();
  if (section === "announcements") loadAnnouncements();
  if (section === "seasons") loadSeasons();
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
async function loadSeasons() {
  try {
    const [{ seasons }, { closures }] = await Promise.all([api("/manage/seasons"), api("/manage/closures")]);
    qs("#seasonList").innerHTML = seasons.length ? `<table class="data-table"><thead><tr><th>Sezona</th><th>Revír</th><th>Období</th><th>Stav</th><th></th></tr></thead><tbody>${seasons.map((s) => {
      const [label, tone] = SEASON_STATES[s.state];
      return `<tr><td data-label="Sezona"><b>${esc(s.name)}</b></td><td data-label="Revír">${esc(s.revirName)}</td><td data-label="Období">${esc(shortDate(s.opensOn))} – ${esc(shortDate(s.closesOn) || "do uzavření")}</td><td data-label="Stav"><span class="badge badge-${tone}">${label}</span></td>
        <td class="row-actions">${s.state === "open" ? `<button class="secondary-button close-season" type="button" data-id="${s.id}">Uzavřít dnes</button>` : ""}<button class="text-button delete-season" type="button" data-id="${s.id}">Smazat</button></td></tr>`;
    }).join("")}</tbody></table>` : '<p class="muted">Žádná sezona – revíry jsou otevřené celý rok.</p>';
    qsa(".close-season").forEach((b) => b.addEventListener("click", async () => {
      const s = seasons.find((x) => x.id === Number(b.dataset.id));
      if (!window.confirm(`Uzavřít „${s.name}“ ke dnešku? Místenky na další dny pak nepůjde koupit.`)) return;
      const today = (await api("/config")).today;
      try { await api(`/manage/seasons/${s.id}`, { method: "PUT", body: { name: s.name, revirId: s.revirId, opensOn: s.opensOn, closesOn: today } }); showToast("Sezona uzavřena."); loadSeasons(); } catch (error) { showToast(error.message); }
    }));
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
  } catch (error) { qs("#seasonList").innerHTML = `<p class="status-error">${esc(error.message)}</p>`; }
}
qs("#seasonForm").addEventListener("submit", (event) => submitForm(event, async () => {
  await api("/manage/seasons", { method: "POST", body: { name: qs("#seasonName").value.trim(), revirId: qs("#seasonRevir").value || null, opensOn: dateField("seasonFrom", "Otevření"), closesOn: dateField("seasonTo", "Uzavření") } });
  qs("#seasonForm").reset();
  fillRevirSelects();
  showToast("Sezona uložena.");
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
  loadUsers();
  // Odkaz přímo na sekci: manage.html#seasons
  const target = qs(`.manage-nav-item[data-section="${CSS.escape(location.hash.slice(1))}"]`);
  if (target && !target.classList.contains("hidden")) target.click();
})();
