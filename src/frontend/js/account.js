// Uživatelský portál: přihlášení, registrace a klientská zóna (B1).
const { qs, qsa, esc, api, loadConfig, czDate, normalizeMemberId, isMemberId, showToast, applyBranding, loadSession, setSession, setSessionUser, isStaff, ticketState, ROLE_LABELS, qrSvg, parseCzDate, formatCzDate, passwordProblem, limitsHtml } = window.Mistenka;

let user = null;
let pendingMagicToken = "";
let pendingResetToken = "";

const show = (id, visible = true) => qs(`#${id}`).classList.toggle("hidden", !visible);
function message(text, tone = "info") {
  const box = qs("#authMessage");
  box.textContent = text;
  box.className = `info-box${tone === "error" ? " info-error" : ""}`;
}
const clearMessage = () => qs("#authMessage").classList.add("hidden");
// Tlačítko během požadavku zablokuje, aby nešlo odeslat dvakrát.
async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; }
}

// ---------- nepřihlášený ----------
function showAuthForm(name) {
  ["loginForm", "registerForm", "resetForm", "magicOtpForm"].forEach((id) => show(id, id === name));
  const tabbed = name === "loginForm" || name === "registerForm";
  qs(".tabs").classList.toggle("hidden", !tabbed);
  qsa(".tab").forEach((tab) => tab.classList.toggle("active", `${tab.dataset.tab}Form` === name));
  qs("#authTitle").textContent = { loginForm: "Přihlášení", registerForm: "Registrace", resetForm: "Nové heslo", magicOtpForm: "Dvoufázové ověření" }[name];
}
qsa(".tab").forEach((tab) => tab.addEventListener("click", () => { clearMessage(); showAuthForm(`${tab.dataset.tab}Form`); }));

function loggedIn(data, note) {
  setSession(data);
  user = data.user;
  if (note) showToast(note);
  renderAccount();
}

qs("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.submitter || qs("#loginForm button[type=submit]");
  busy(button, async () => {
    const body = { email: qs("#loginEmail").value.trim(), password: qs("#loginPassword").value, otp: qs("#loginOtp").value.trim() || undefined };
    if (!body.email || !body.password) return message("Vyplňte e-mail a heslo, nebo si nechte poslat odkaz pro přihlášení.", "error");
    try {
      loggedIn(await api("/auth/login", { method: "POST", body }));
    } catch (error) {
      if (error.code === "otp_required" || error.code === "invalid_otp") { show("loginOtpField"); qs("#loginOtp").focus(); }
      message(error.message, "error");
    }
  });
});
qs("#sendMagicLink").addEventListener("click", (event) => busy(event.currentTarget, async () => {
  const email = qs("#loginEmail").value.trim();
  if (!email) { qs("#loginEmail").focus(); return message("Vyplňte e-mail, na který vám pošleme odkaz.", "error"); }
  try {
    await api("/auth/magic-link", { method: "POST", body: { email } });
    message(`Pokud účet s adresou ${email} existuje, poslali jsme na ni odkaz pro přihlášení. Platí 15 minut.`);
  } catch (error) { message(error.message, "error"); }
}));
qs("#sendReset").addEventListener("click", (event) => busy(event.currentTarget, async () => {
  const email = qs("#loginEmail").value.trim();
  if (!email) { qs("#loginEmail").focus(); return message("Vyplňte e-mail, na který vám pošleme odkaz pro obnovu hesla.", "error"); }
  try {
    await api("/auth/password-reset", { method: "POST", body: { email } });
    message(`Pokud účet s adresou ${email} existuje, poslali jsme na ni odkaz pro nastavení nového hesla.`);
  } catch (error) { message(error.message, "error"); }
}));

qs("#registerForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.submitter, async () => {
    const memberId = normalizeMemberId(qs("#regMemberId").value);
    const body = {
      firstName: qs("#regFirstName").value.trim(), lastName: qs("#regLastName").value.trim(), birthDate: parseCzDate(qs("#regBirthDate").value),
      memberId, email: qs("#regEmail").value.trim(), password: qs("#regPassword").value || undefined, consent: qs("#regConsent").checked
    };
    if (!body.firstName || !body.lastName || !body.email) return message("Vyplňte jméno, příjmení a e-mail.", "error");
    if (!body.birthDate) return message("Zadejte datum narození ve tvaru den.měsíc.rok, např. 3.2.1988.", "error");
    if (!isMemberId(memberId)) return message("Zadejte 8místné číslo členské legitimace (pod čárovým kódem).", "error");
    const passwordError = (body.password || qs("#regPassword2").value) && passwordProblem(qs("#regPassword").value, qs("#regPassword2").value);
    if (passwordError) return message(passwordError, "error");
    if (!body.consent) return message("Pro registraci potvrďte souhlas se zpracováním osobních údajů.", "error");
    try {
      await api("/auth/register", { method: "POST", body });
      qs("#registerForm").reset();
      showAuthForm("loginForm");
      qs("#loginEmail").value = body.email;
      message(`Poslali jsme vám e-mail na ${body.email}. Účet aktivujete kliknutím na odkaz v něm (platí 48 hodin).`);
    } catch (error) { message(error.message, "error"); }
  });
});

qs("#resetForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.submitter, async () => {
    const passwordError = passwordProblem(qs("#resetPassword").value, qs("#resetPassword2").value);
    if (passwordError) return message(passwordError, "error");
    try {
      loggedIn(await api("/auth/password-reset/confirm", { method: "POST", body: { token: pendingResetToken, password: qs("#resetPassword").value, otp: qs("#resetOtp").value.trim() || undefined } }), "Heslo je uložené, jste přihlášeni.");
    } catch (error) {
      if (error.code === "otp_required" || error.code === "invalid_otp") { show("resetOtpField"); qs("#resetOtp").focus(); }
      message(error.message, "error");
    }
  });
});
qs("#magicOtpForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.submitter, async () => {
    try {
      loggedIn(await api("/auth/magic", { method: "POST", body: { token: pendingMagicToken, otp: qs("#magicOtp").value.trim() } }), "Jste přihlášeni.");
    } catch (error) { message(error.message, "error"); }
  });
});

// Odkazy z e-mailů: #verify=, #login=, #reset=, #email= (token ve fragmentu se neposílá serveru ani do logů).
async function handleLinkFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const [kind] = ["verify", "login", "reset", "invite", "email"].filter((key) => params.get(key));
  if (!kind) return false;
  const token = params.get(kind);
  history.replaceState(null, "", location.pathname + location.search);
  try {
    if (kind === "verify") { loggedIn(await api("/auth/verify", { method: "POST", body: { token } }), "E-mail je ověřený, vítejte!"); return true; }
    if (kind === "login") {
      try { loggedIn(await api("/auth/magic", { method: "POST", body: { token } }), "Jste přihlášeni."); return true; }
      catch (error) {
        if (error.code !== "otp_required") throw error;
        pendingMagicToken = token;
        renderAuth("magicOtpForm");
        return true;
      }
    }
    if (kind === "reset" || kind === "invite") {
      pendingResetToken = token;
      renderAuth("resetForm");
      if (kind === "invite") {
        qs("#authTitle").textContent = "Vítejte ve správě";
        qs("#resetIntro").textContent = "Byli jste pozváni do správy Místenky. Nastavte si heslo – pak se přihlásíte e-mailem a tímto heslem.";
      }
      return true;
    }
    if (kind === "email") {
      await api("/auth/email/confirm", { method: "POST", body: { token } });
      showToast("Nový e-mail je potvrzený.");
      return false; // pokračuje běžné načtení (přihlášený / nepřihlášený)
    }
  } catch (error) {
    renderAuth("loginForm");
    message(error.message, "error");
    return true;
  }
  return false;
}

function renderAuth(form = "loginForm") {
  show("loadingState", false);
  show("accountView", false);
  show("authView");
  showAuthForm(form);
}

// ---------- přihlášený ----------
function renderAccount() {
  show("loadingState", false);
  show("authView", false);
  show("accountView");
  qs("#accountName").textContent = `${user.firstName} ${user.lastName}`;
  qs("#roleBadges").innerHTML = user.roles.filter((role) => role !== "member").map((role) => `<span class="badge badge-info">${esc(ROLE_LABELS[role] || role)}</span>`).join("");
  qsa("[data-manage-link]").forEach((el) => el.classList.toggle("hidden", !isStaff(user)));
  show("mfaWarning", user.mfaRequired);
  // Údaje
  qs("#pFirstName").value = user.firstName;
  qs("#pLastName").value = user.lastName;
  qs("#pBirthDate").value = formatCzDate(user.birthDate);
  qs("#pMemberId").value = user.memberId;
  qs("#pEmail").value = user.email;
  // Účet správce nemusí mít rybářské údaje (číslo legitimace, datum narození).
  qsa(".staff-optional").forEach((el) => el.classList.toggle("hidden", !isStaff(user)));
  qs("#profileIntro").textContent = isStaff(user) && user.staffOnly
    ? "Účet jen pro správu. Číslo legitimace a datum narození doplňte, pokud chcete z účtu kupovat místenky."
    : "Použijeme je k předvyplnění místenky. Na již vystavených místenkách se nezmění.";
  // Heslo: účet bez hesla si ho nastaví bez zadání současného.
  show("currentPasswordWrap", user.hasPassword);
  show("deletePasswordWrap", user.hasPassword);
  qs("#newPasswordLabel").textContent = user.hasPassword ? "Nové heslo" : "Heslo (alespoň 8 znaků)";
  qs("#passwordSubmit").textContent = user.hasPassword ? "Změnit heslo" : "Nastavit heslo";
  qs("#passwordTitle").textContent = user.hasPassword ? "Heslo" : "Nastavit heslo";
  renderTwoFactor();
  loadTickets();
  loadLimits();
  if (location.hash === "#2fa") openTwoFactorSetup();
}

// Odkaz account.html#2fa (z manažerského portálu): rovnou otevře nastavení 2FA.
function openTwoFactorSetup() {
  history.replaceState(null, "", location.pathname + location.search);
  qs("#twoFactorCard").scrollIntoView({ behavior: "smooth", block: "start" });
  qs("#setup2fa")?.click();
}
document.addEventListener("click", (event) => {
  if (event.target.closest("#mfaLink")) { event.preventDefault(); openTwoFactorSetup(); }
});

function ticketLink(ticket) {
  const code = encodeURIComponent(ticket.code);
  if ((ticket.status === "expired_unreturned" || ticket.status === "seized") && ticket.returnable) return { href: `return.html?code=${code}`, label: "Odevzdat" };
  if (ticket.status === "active") return { href: `return.html?code=${code}`, label: "Odevzdat" };
  if (ticket.status === "pending_payment") return { href: `payment.html?code=${code}`, label: "Zaplatit" };
  return { href: `payment.html?code=${code}`, label: "Zobrazit" };
}

// Limity úlovků člena v tomto týdnu a měsíci (jen účty s číslem legitimace).
async function loadLimits() {
  const box = qs("#myLimits");
  if (!user.memberId) { box.innerHTML = ""; return; }
  try {
    const data = await api("/me/limits");
    const blocked = data.blocked ? `<div class="status-error">Nákup místenek je pozastaven ${data.blocked.until ? `do ${esc(czDate(data.blocked.until))}` : "do odvolání"}. Důvod: ${esc(data.blocked.reason)}</div>` : "";
    box.innerHTML = blocked + limitsHtml(data.limits, { mode: "all", title: "Moje úlovky a limity" });
  } catch { box.innerHTML = ""; }
}

async function loadTickets() {
  try {
    const { tickets } = await api("/me/tickets");
    const current = tickets.find((t) => t.status === "seized") || tickets.find((t) => t.status === "active") || tickets.find((t) => t.status === "expired_unreturned" && t.returnable)
      || tickets.find((t) => t.status === "pending_payment") || tickets.filter((t) => t.status === "future").slice(-1)[0];
    if (current) {
      const state = ticketState(current);
      const link = ticketLink(current);
      const view = current.status === "active" ? `<a class="secondary-button" href="payment.html?code=${encodeURIComponent(current.code)}">Zobrazit místenku</a>` : "";
      qs("#currentTicket").innerHTML = `<div class="current-main"><span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span><strong>${esc(current.code)}</strong><span>${esc(current.revir.name)} · ${esc(czDate(current.date, { weekday: true }))}</span></div><div class="current-actions">${view}<a class="primary-button" href="${esc(link.href)}">${esc(link.label)} →</a></div>`;
    } else {
      qs("#currentTicket").innerHTML = '<p class="muted">Nemáte žádnou aktivní ani budoucí místenku.</p>';
    }
    qs("#ticketList").innerHTML = tickets.length
      ? `<table class="data-table"><thead><tr><th>Datum lovu</th><th>Revír</th><th>Kód</th><th>Stav</th><th></th></tr></thead><tbody>${tickets.map((ticket) => {
        const state = ticketState(ticket);
        const link = ticketLink(ticket);
        const catches = ticket.status === "expired_returned" ? (ticket.noCatch ? "bez úlovku" : `${ticket.catches.length} ${ticket.catches.length === 1 ? "úlovek" : ticket.catches.length < 5 ? "úlovky" : "úlovků"}`) : "";
        return `<tr><td data-label="Datum">${esc(czDate(ticket.date))}</td><td data-label="Revír">${esc(ticket.revir.name)}</td><td data-label="Kód"><b>${esc(ticket.code)}</b></td><td data-label="Stav"><span class="badge badge-${esc(state.tone)}">${esc(state.label)}</span>${catches ? ` <small class="muted-inline">${esc(catches)}</small>` : ""}</td><td><a class="text-link" href="${esc(link.href)}">${esc(link.label)} →</a></td></tr>`;
      }).join("")}</tbody></table>`
      : '<p class="muted">Zatím nemáte žádné místenky. Místenky koupené dříve bez účtu se připojí, pokud mají stejný e-mail a číslo legitimace.</p>';
  } catch (error) {
    qs("#ticketList").innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
}

qs("#profileForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.submitter, async () => {
    const birthRaw = qs("#pBirthDate").value.trim();
    const birthDate = birthRaw ? parseCzDate(birthRaw) : "";
    if ((birthRaw || !isStaff(user)) && !birthDate) return showToast("Zadejte datum narození ve tvaru den.měsíc.rok, např. 3.2.1988.");
    try {
      const result = await api("/me", { method: "PATCH", body: { firstName: qs("#pFirstName").value.trim(), lastName: qs("#pLastName").value.trim(), birthDate, memberId: normalizeMemberId(qs("#pMemberId").value), email: qs("#pEmail").value.trim() } });
      user = result.user;
      setSessionUser(user);
      renderAccount();
      showToast(result.emailChangePending ? `Údaje uloženy. Novou adresu ${result.emailChangePending} potvrďte odkazem z e-mailu.` : "Údaje uloženy.");
    } catch (error) { showToast(error.message); }
  });
});
qs("#passwordForm").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.submitter, async () => {
    const passwordError = passwordProblem(qs("#newPassword").value, qs("#newPassword2").value);
    if (passwordError) return showToast(passwordError);
    try {
      const result = await api("/me/password", { method: "PUT", body: { currentPassword: qs("#currentPassword").value, newPassword: qs("#newPassword").value } });
      user = result.user;
      qs("#passwordForm").reset();
      renderAccount();
      showToast("Heslo uloženo. Ostatní zařízení jsme odhlásili.");
    } catch (error) { showToast(error.message); }
  });
});

function renderTwoFactor(setup = null) {
  const box = qs("#twoFactor");
  if (user.twoFactor) {
    const required = user.roles.includes("admin");
    box.innerHTML = `<div class="two-factor-state"><span class="badge badge-ok">Zapnuto</span><span>Dvoufázové ověření chrání váš účet kódem z aplikace.</span></div>${required ? '<p class="field-help">Admin musí mít dvoufázové ověření zapnuté.</p>' : `<div class="code-row"><input id="disableOtp" class="otp-input" inputmode="numeric" maxlength="6" placeholder="Kód z aplikace"><button class="secondary-button" type="button" id="disable2fa">Vypnout</button></div>`}`;
    qs("#disable2fa")?.addEventListener("click", (event) => busy(event.currentTarget, async () => {
      try { user = (await api("/me/2fa/disable", { method: "POST", body: { otp: qs("#disableOtp").value.trim() } })).user; renderTwoFactor(); showToast("Dvoufázové ověření vypnuto."); }
      catch (error) { showToast(error.message); }
    }));
    return;
  }
  if (setup) {
    box.innerHTML = `<div class="two-factor-setup"><div class="qr-holder">${qrSvg(setup.otpauthUrl, "QR kód pro ověřovací aplikaci")}</div><div><p>1. Naskenujte QR kód aplikací (Google Authenticator, Microsoft Authenticator, Aegis…), nebo zadejte klíč ručně:</p><code class="secret">${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</code><p>2. Opište šestimístný kód z aplikace:</p><div class="code-row"><input id="enableOtp" class="otp-input" inputmode="numeric" maxlength="6" placeholder="123456"><button class="primary-button" type="button" id="enable2fa">Zapnout</button></div></div></div>`;
    qs("#enable2fa").addEventListener("click", (event) => busy(event.currentTarget, async () => {
      try { user = (await api("/me/2fa/enable", { method: "POST", body: { otp: qs("#enableOtp").value.trim() } })).user; renderAccount(); showToast("Dvoufázové ověření je zapnuté."); }
      catch (error) { showToast(error.message); }
    }));
    return;
  }
  box.innerHTML = `<div class="two-factor-state"><span class="badge badge-off">Vypnuto</span><span>${user.roles.includes("admin") ? "Pro admina je dvoufázové ověření povinné." : isStaff(user) ? "Doporučujeme zapnout – spravujete údaje ostatních." : "Volitelné zabezpečení přihlášení kódem z mobilní aplikace."}</span></div><button class="secondary-button" type="button" id="setup2fa">Nastavit dvoufázové ověření</button>`;
  qs("#setup2fa").addEventListener("click", (event) => busy(event.currentTarget, async () => {
    try { renderTwoFactor(await api("/me/2fa/setup", { method: "POST" })); }
    catch (error) { showToast(error.message); }
  }));
}

qs("#deleteForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!qs("#deleteConfirm").checked) return showToast("Potvrďte, že rozumíte nevratnosti smazání.");
  busy(event.submitter, async () => {
    try {
      await api("/me/delete", { method: "POST", body: { confirm: true, password: qs("#deletePassword").value } });
      setSession(null);
      user = null;
      renderAuth();
      message("Účet byl smazán.");
    } catch (error) { showToast(error.message); }
  });
});

qs("#logoutButton").addEventListener("click", (event) => busy(event.currentTarget, async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* odhlásit lokálně i při chybě */ }
  setSession(null);
  user = null;
  renderAuth();
  message("Byli jste odhlášeni.");
}));

// ---------- start ----------
(async function init() {
  try { applyBranding(await loadConfig()); } catch { /* stránka funguje i bez konfigurace */ }
  if (await handleLinkFragment()) return;
  user = await loadSession(true);
  setSessionUser(user);
  if (user) renderAccount(); else renderAuth();
})();
