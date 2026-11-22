const { qs, qsa, esc, api, loadConfig, revirUrl, czDate, czDateTime, plural, findSpecies, catchProblem, credentialsFor, rememberMemberId, normalizeMemberId, isMemberId, showToast, applyBranding, loadSession, limitsHtml } = window.Mistenka;

const code = (new URLSearchParams(location.search).get("code") || "").trim().toUpperCase();
let credentials = credentialsFor(code);
let config = null;
let ticket = null;
let rules = null; // pravidla druhů ryb revíru (míry, hájení, limity)

const show = (id) => ["loadingState", "accessForm", "catchPageForm", "returnedState", "returnError"].forEach((name) => qs(`#${name}`).classList.toggle("hidden", name !== id));
function showError(message) { qs("#returnError").textContent = message; show("returnError"); }

function addRow() {
  const row = document.createElement("div");
  row.className = "catch-row catch-grid";
  row.innerHTML = `<div class="fish-field"><input class="fish-name" placeholder="např. kapr" autocomplete="off" maxlength="60"><div class="fish-suggestions" role="listbox"></div></div><div><input class="fish-length" type="number" min="1" step="1" placeholder="cm"><span class="length-error">Vyplňte délku</span></div><div class="weight-field"><input class="fish-weight" type="number" min="0" step="0.01" placeholder="dopočítá se"><span class="weight-note hidden">~</span></div><button class="remove-catch" type="button" aria-label="Odstranit řádek">×</button>`;
  qs("#catchRows").append(row);
  row.dataset.estimated = "false";
  const fishInput = row.querySelector(".fish-name");
  const suggestions = row.querySelector(".fish-suggestions");
  let active = -1;
  const choose = (name) => { fishInput.value = name; suggestions.classList.remove("visible"); active = -1; validateLength(row); updateWeight(row); };
  const renderSuggestions = () => {
    const query = fishInput.value.trim().toLowerCase();
    const matches = (rules?.species || []).filter((s) => !query || s.name.toLowerCase().includes(query) || (s.aliases || []).some((a) => a.toLowerCase().includes(query)));
    suggestions.innerHTML = matches.map((s) => `<button type="button" role="option" data-name="${esc(s.name)}">${esc(s.name)}${s.minLength && rules.sizeRulesEnabled !== false ? ` <small>min. ${esc(s.minLength)} cm</small>` : ""}</button>`).join("");
    suggestions.classList.toggle("visible", matches.length > 0);
    active = -1;
    suggestions.querySelectorAll("button").forEach((button) => button.addEventListener("mousedown", (event) => { event.preventDefault(); choose(button.dataset.name); }));
  };
  fishInput.addEventListener("keydown", (event) => {
    const buttons = suggestions.querySelectorAll("button");
    if (!suggestions.classList.contains("visible") || !buttons.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = event.key === "ArrowDown" ? (active + 1) % buttons.length : (active - 1 + buttons.length) % buttons.length;
      buttons.forEach((button, index) => button.classList.toggle("active", index === active));
      buttons[active].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(buttons[active].dataset.name);
    } else if (event.key === "Escape") {
      suggestions.classList.remove("visible");
    }
  });
  fishInput.addEventListener("focus", renderSuggestions);
  fishInput.addEventListener("input", () => { renderSuggestions(); validateLength(row); updateWeight(row); });
  fishInput.addEventListener("blur", () => window.setTimeout(() => suggestions.classList.remove("visible"), 120));
  row.querySelector(".fish-length").addEventListener("input", () => { validateLength(row); updateWeight(row); });
  row.querySelector(".fish-weight").addEventListener("input", () => { row.dataset.estimated = "false"; row.querySelector(".weight-note").classList.add("hidden"); });
  row.querySelector(".remove-catch").addEventListener("click", () => { if (qs("#catchRows").children.length > 1) row.remove(); });
}

// Míra, hájení v den lovu a povinné vrácení: možné porušení jen vyznačí (červené pole + text), odevzdání nebrání –
// rozhodují pravidla v RIS, údaje v Místence nemusí být aktuální. Vrací, zda je délka vyplněná.
function validateLength(row) {
  const known = findSpecies(rules, row.querySelector(".fish-name").value);
  const input = row.querySelector(".fish-length");
  const error = row.querySelector(".length-error");
  const length = Number(input.value);
  error.textContent = "Vyplňte délku";
  // Lovné míry lze ve správě vypnout (sizeRulesEnabled) – pak se míra, hájení ani vrácení nekontroluje.
  const problem = known && rules.sizeRulesEnabled !== false && catchProblem(known, length, ticket.date);
  const warn = Boolean(problem && (length || problem.startsWith("Celoročně") || problem.startsWith("V době")));
  row.classList.toggle("catch-warning", warn);
  if (warn) {
    input.classList.add("invalid");
    error.textContent = `Možné porušení pravidel: ${problem}`;
    return Boolean(length);
  }
  input.classList.remove("invalid");
  return Boolean(length);
}

// Orientační odhad hmotnosti podle koeficientu druhu v konfiguraci revíru.
function updateWeight(row) {
  const known = findSpecies(rules, row.querySelector(".fish-name").value);
  const length = Number(row.querySelector(".fish-length").value);
  const weight = row.querySelector(".fish-weight");
  if (known?.weightFactor && length > 0 && (row.dataset.estimated === "true" || !weight.value)) {
    weight.value = (known.weightFactor * Math.pow(length, 3) / 100000).toFixed(2);
    row.dataset.estimated = "true";
    row.querySelector(".weight-note").classList.remove("hidden");
  }
}

function renderTicket() {
  const revir = config.reviry.find((item) => item.id === ticket.revir.id);
  rules = revir?.fishRules || null;
  qs("#homeLink").href = revirUrl("./", revir, config);
  qs("#returnedHome").href = revirUrl("./", revir, config);
  let status;
  if (ticket.status === "seized") {
    status = `<span class="ticket-status late-return"><span>! Zadržená místenka</span><small>${esc(ticket.seizure?.reason || "")} · odevzdejte do ${esc(czDateTime(ticket.returnDeadline))}</small></span>`;
  } else if (ticket.status === "expired_unreturned") {
    const hoursLeft = Math.max(0, Math.ceil((new Date(ticket.returnDeadline) - Date.now()) / 3600000));
    const left = hoursLeft >= 48 ? `${Math.floor(hoursLeft / 24)} ${plural(Math.floor(hoursLeft / 24), "den", "dny", "dní")}` : `${hoursLeft} ${plural(hoursLeft, "hodina", "hodiny", "hodin")}`;
    status = `<span class="ticket-status late-return late-warn"><span>! Opožděné odevzdání</span><small>do ${esc(czDateTime(ticket.returnDeadline))} (zbývá ${left}), pak se místenka uzavře jako neodevzdaná</small></span>`;
  } else {
    status = '<span class="ticket-status timely-return">● Včasné odevzdání</span>';
  }
  qs("#ticketSummary").innerHTML = `<div><span class="section-kicker">Místenka ${esc(ticket.code)}</span><strong>${esc(`${ticket.firstName} ${ticket.lastName}`)}</strong><span>${esc(czDate(ticket.date, { weekday: true }))} · ${esc(ticket.revir.name)}</span></div>${status}`;
  qs("#ticketSummary").classList.remove("hidden");
  if (!qs("#catchRows").children.length) addRow();
  show("catchPageForm");
}

async function loadTicket() {
  try {
    ticket = await api(`/orders/${code}`, credentials);
  } catch (error) {
    if (error.code === "forbidden") { qs("#ticketSummary").classList.add("hidden"); show("accessForm"); if (credentials.memberId) showToast(error.message, "error"); return; }
    throw error;
  }
  if (ticket.status === "expired_returned") return showError("Tato místenka už byla odevzdána.");
  if (ticket.status === "future") return showError("Místenku není možné odevzdat před dnem lovu.");
  if (!ticket.returnable) return showError(ticket.status === "closed_unreturned" ? "Lhůta pro odevzdání uplynula, místenka byla uzavřena jako neodevzdaná. Kontaktujte hospodáře." : "Tuto místenku nelze odevzdat.");
  renderTicket();
}

qs("#accessButton").addEventListener("click", () => {
  const memberId = normalizeMemberId(qs("#accessMemberId").value);
  if (!isMemberId(memberId)) return showToast("Zadejte 8místné číslo členské legitimace.", "warning");
  credentials = { memberId };
  rememberMemberId(code, memberId);
  loadTicket().catch((error) => showError(error.message));
});
qs("#accessMemberId").addEventListener("keydown", (event) => { if (event.key === "Enter") qs("#accessButton").click(); });
qs("#noCatch").addEventListener("change", (event) => qs("#catchSection").classList.toggle("hidden", event.target.checked));
qs("#addCatch").addEventListener("click", addRow);

qs("#submitReturn").addEventListener("click", async () => {
  const noCatch = qs("#noCatch").checked;
  let catches = [];
  if (!noCatch) {
    let valid = true;
    catches = qsa(".catch-row").map((row) => {
      const name = row.querySelector(".fish-name").value.trim();
      const length = Number(row.querySelector(".fish-length").value);
      const weight = Number(row.querySelector(".fish-weight").value);
      if (!name || !length) {
        row.querySelector(".fish-length").classList.add("invalid");
        valid = false;
      } else {
        validateLength(row);
      }
      return { species: name, length, weight: weight || null, weightEstimated: Boolean(weight) && row.dataset.estimated === "true" };
    });
    if (!valid) return showToast("Doplňte druh a délku u každého úlovku, nebo zvolte „Bez úlovku“.", "warning");
  }
  if (!qs("#returnDeclaration").checked) return showToast("Potvrďte úplnost údajů.", "warning");
  const button = qs("#submitReturn");
  button.disabled = true;
  try {
    ticket = await api(`/tickets/${code}/return`, { method: "POST", body: { noCatch, catches }, ...credentials });
    qs("#returnedText").textContent = ticket.late
      ? "Místenka je odevzdaná. Odevzdání proběhlo po skončení dne lovu, a je proto označeno jako opožděné."
      : "Děkujeme za vyplnění sumáře úlovků. Místenka je nyní označena jako odevzdaná.";
    // Překročený limit odevzdání neblokuje – rybář dostane upozornění (správce e-mail).
    const warned = (ticket.catches || []).filter((c) => c.warning);
    qs("#returnedLimits").innerHTML = (warned.length ? `<div class="warn-box catch-warning-box"><b>Možné porušení pravidel u ${warned.length === 1 ? "úlovku" : "úlovků"}</b><ul>${warned.map((c) => `<li>${esc(c.species)} ${esc(c.length)} cm: ${esc(c.warning)}</li>`).join("")}</ul><small>Místenka je odevzdaná. Rozhodují pravidla v RIS – údaje v Místence nemusí být aktuální. Porybný i správce upozornění uvidí.</small></div>` : "")
      + limitsHtml(ticket.limits, { title: "Upozornění na limity úlovků" });
    qs("#ticketSummary").classList.add("hidden");
    show("returnedState");
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
});

(async function init() {
  try {
    config = await loadConfig();
    applyBranding(config);
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Chybí platný kód místenky.");
    if (!credentials.token && !credentials.memberId && !(await loadSession())) return show("accessForm");
    await loadTicket();
  } catch (error) { showError(error.message); }
})();
