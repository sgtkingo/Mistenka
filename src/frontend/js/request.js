// Žádost „Jsem porybný“ z odkazu v e-mailu správci (request.html#t=<token>&a=approve|reject).
// Otevřením odkazu se nic nerozhodne (poštovní skenery odkazy samy otevírají) – rozhoduje až tlačítko.
const { qs, esc, api, czDateTime, initUserMenu } = window.Mistenka;

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("t") || "";
const preferred = params.get("a") === "reject" ? "reject" : "approve";
history.replaceState(null, "", location.pathname); // token z adresy pryč (historie, sdílení)

function fail(message) {
  qs("#requestLoading").classList.add("hidden");
  qs("#requestContent").classList.add("hidden");
  qs("#requestError").innerHTML = `${esc(message)} <a href="manage.html#notifications">Otevřít notifikace v portálu →</a>`;
  qs("#requestError").classList.remove("hidden");
}

function render(n, done = "") {
  const box = qs("#requestContent");
  const u = n.user || {};
  const rows = [["Žadatel", u.name || "účet byl smazán"], ["E-mail", u.email || "—"], ["Č. legitimace", u.memberId || "—"], ["Podáno", czDateTime(n.createdAt)], ...(n.note ? [["Poznámka", n.note]] : [])];
  box.innerHTML = `<p class="panel-intro">Uživatel uvádí, že je porybný (rybářská stráž MO nebo státní rybářská stráž). Po schválení uvidí při kontrole místenky plné údaje rybáře a bude moct místenku zadržet. Žadatel dostane e-mail s výsledkem.</p>
    <table class="data-table"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
    ${done ? `<div class="info-box">${esc(done)}</div>` : `
    <label class="field-label" for="decisionNote">Poznámka pro žadatele <span class="optional">(volitelné)</span></label>
    <input id="decisionNote" maxlength="300" class="full-width-input">
    <div class="row-actions request-actions">
      <button class="${preferred === "approve" ? "primary-button" : "secondary-button"}" type="button" data-action="approve">Schválit</button>
      <button class="${preferred === "reject" ? "primary-button" : "secondary-button"}" type="button" data-action="reject">Zamítnout</button>
    </div>`}`;
  box.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
    box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const { notification } = await api("/requests/decide", { method: "POST", body: { token, action: button.dataset.action, note: qs("#decisionNote").value.trim() } });
      render(notification, notification.status === "approved" ? "Schváleno – uživatel má funkci porybného a dostal e-mail." : "Zamítnuto – žadatel dostal e-mail.");
    } catch (error) { fail(error.message); }
  }));
  qs("#requestLoading").classList.add("hidden");
  box.classList.remove("hidden");
}

(async function init() {
  initUserMenu();
  if (!token) return fail("V odkazu chybí údaje žádosti.");
  try { render((await api("/requests/view", { method: "POST", body: { token } })).notification); } catch (error) { fail(error.message); }
})();
