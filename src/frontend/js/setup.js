// Průvodce prvním spuštěním: založení admina jednorázovým odkazem z konzole serveru (setup.html#<token>).
const { qs, esc, api, loadConfig, applyBranding, setSession, passwordProblem, qrSvg } = window.Mistenka;

// Token z fragmentu URL se hned odstraní z adresního řádku (neposílá se serveru v URL ani do historie).
const token = location.hash.slice(1);
if (token) history.replaceState(null, "", location.pathname);
let details = null;
let twoFactorReady = false;

const show = (id, visible = true) => qs(`#${id}`).classList.toggle("hidden", !visible);
function message(html, tone = "info") {
  const box = qs("#setupMessage");
  box.innerHTML = html;
  box.className = `info-box${tone === "error" ? " info-error" : ""}`;
}
function step(name) {
  show("detailsForm", name === "details");
  show("twoFactorForm", name === "twoFactor");
  qs("#stepBadge").textContent = name === "details" ? "1 / 2" : "2 / 2";
}

qs("#detailsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const firstName = qs("#firstName").value.trim();
  const lastName = qs("#lastName").value.trim();
  const email = qs("#email").value.trim();
  const password = qs("#password").value;
  if (!firstName || !lastName) return message("Vyplňte jméno a příjmení.", "error");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return message("Zadejte platný e-mail.", "error");
  const problem = passwordProblem(password, qs("#password2").value);
  if (problem) return message(problem, "error");
  details = { firstName, lastName, email, password };
  qs("#setupMessage").classList.add("hidden");
  if (!twoFactorReady) {
    const button = event.submitter;
    button.disabled = true;
    try {
      const setup = await api("/setup/2fa", { method: "POST", body: { token } });
      qs("#qrHolder").innerHTML = qrSvg(setup.otpauthUrl, "QR kód pro ověřovací aplikaci");
      qs("#secret").textContent = setup.secret.replace(/(.{4})/g, "$1 ").trim();
      twoFactorReady = true;
    } catch (error) {
      return message(esc(error.message), "error");
    } finally {
      button.disabled = false;
    }
  }
  step("twoFactor");
  qs("#otp").focus();
});
qs("#backToDetails").addEventListener("click", () => step("details"));

qs("#twoFactorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api("/setup", { method: "POST", body: { token, ...details, otp: qs("#otp").value.trim() } });
    setSession(result);
    show("twoFactorForm", false);
    qs("#stepBadge").textContent = "Hotovo";
    message(`Admin <b>${esc(result.user.email)}</b> je založený a přihlášený. <a href="manage.html">Přejít do manažerského portálu →</a>`);
  } catch (error) {
    message(esc(error.message), "error");
    if (error.code === "email_taken" || error.code === "weak_password" || error.code === "invalid_email") step("details");
  } finally {
    button.disabled = false;
  }
});

(async function init() {
  try { applyBranding(await loadConfig()); } catch { /* bez konfigurace */ }
  let status;
  try { status = await api("/setup"); } catch (error) { return message(esc(error.message), "error"); }
  if (!status.needed) return message('Admin už existuje, průvodce je vypnutý. <a href="account.html">Přihlásit se →</a>');
  if (!token) return message("Chybí jednorázový odkaz. Najdete ho ve výpisu serveru při startu (nebo <code>npm run user -- setup</code>).", "error");
  step("details");
})();
