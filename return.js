const qs = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
const code = (params.get("code") || "").trim().toUpperCase();
const fishWeightFactors = {
  kapr: 1.5,
  štika: 1.0,
  candát: 1.2,
  amur: 1.4,
  sumec: 1.2,
  lín: 1.6,
  bolen: 1.1,
  "pstruh duhový": 1.6,
  "pstruh potočný (obecný)": 1.6,
  "siven americký": 1.6,
  okoun: 1.3
};
const minimumLengths = {
  kapr: 40,
  štika: 50,
  candát: 45,
  amur: 50,
  sumec: 70,
  lín: 20,
  bolen: 40,
  "pstruh duhový": 25,
  "pstruh potočný (obecný)": 25,
  "siven americký": 25,
  okoun: 15
};
const fishNames = Object.keys(fishWeightFactors);
const toast = (message) => { qs("#toast").textContent = message; qs("#toast").classList.add("show"); window.setTimeout(() => qs("#toast").classList.remove("show"), 2800); };

function addRow() {
  const row = document.createElement("div");
  row.className = "catch-row catch-grid";
  row.innerHTML = `<div class="fish-field"><input class="fish-name" placeholder="např. kapr" autocomplete="off"><div class="fish-suggestions" role="listbox"></div></div><div><input class="fish-length" type="number" min="1" step="1" placeholder="cm"><span class="length-error">Vyplňte délku</span></div><div class="weight-field"><input class="fish-weight" type="number" min="0" step="0.01" placeholder="dopočítá se"><span class="weight-note">~</span></div><button class="remove-catch" type="button" aria-label="Odstranit řádek">×</button>`;
  qs("#catchRows").append(row);
  const fishInput = row.querySelector(".fish-name");
  const suggestions = row.querySelector(".fish-suggestions");
  let activeSuggestion = -1;
  const renderSuggestions = () => {
    const query = fishInput.value.trim().toLowerCase();
    const matches = fishNames.filter((name) => !query || name.includes(query));
    suggestions.innerHTML = matches.map((name) => `<button type="button" role="option">${name}</button>`).join("");
    suggestions.classList.toggle("visible", matches.length > 0);
    activeSuggestion = -1;
    suggestions.querySelectorAll("button").forEach((button) => button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      fishInput.value = button.textContent;
      suggestions.classList.remove("visible");
      updateWeight(row);
    }));
  };
  const chooseSuggestion = (index) => {
    const buttons = [...suggestions.querySelectorAll("button")];
    if (!buttons[index]) return;
    fishInput.value = buttons[index].textContent;
    suggestions.classList.remove("visible");
    activeSuggestion = -1;
    fishInput.focus();
    updateWeight(row);
  };
  fishInput.addEventListener("keydown", (event) => {
    const buttons = suggestions.querySelectorAll("button");
    if (!suggestions.classList.contains("visible") || !buttons.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestion = event.key === "ArrowDown"
        ? (activeSuggestion + 1) % buttons.length
        : (activeSuggestion - 1 + buttons.length) % buttons.length;
      buttons.forEach((button, index) => button.classList.toggle("active", index === activeSuggestion));
      buttons[activeSuggestion].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault();
      chooseSuggestion(activeSuggestion);
    } else if (event.key === "Escape") {
      suggestions.classList.remove("visible");
      activeSuggestion = -1;
    }
  });
  fishInput.addEventListener("focus", renderSuggestions);
  fishInput.addEventListener("input", () => { renderSuggestions(); validateLength(row); updateWeight(row); });
  fishInput.addEventListener("blur", () => window.setTimeout(() => suggestions.classList.remove("visible"), 120));
  row.querySelector(".fish-length").addEventListener("input", () => { validateLength(row); updateWeight(row); });
  row.querySelector(".fish-weight").addEventListener("input", () => row.querySelector(".weight-note").classList.add("hidden"));
  row.querySelector(".remove-catch").addEventListener("click", () => { if (qs("#catchRows").children.length > 1) row.remove(); });
}
function validateLength(row) {
  const species = row.querySelector(".fish-name").value.trim().toLowerCase();
  const lengthInput = row.querySelector(".fish-length");
  const error = row.querySelector(".length-error");
  const length = Number(lengthInput.value);
  const minimum = minimumLengths[species];
  if (!length) {
    lengthInput.classList.remove("invalid");
    error.textContent = "Vyplňte délku";
    return false;
  }
  if (minimum && length < minimum) {
    lengthInput.classList.add("invalid");
    error.textContent = `Podměrečná ryba (minimum ${minimum} cm)`;
    return false;
  }
  lengthInput.classList.remove("invalid");
  error.textContent = "Vyplňte délku";
  return true;
}
function updateWeight(row) {
  const fish = row.querySelector(".fish-name").value.trim().toLowerCase();
  const length = Number(row.querySelector(".fish-length").value);
  const weight = row.querySelector(".fish-weight");
  if (fishWeightFactors[fish] && length > 0) {
    weight.value = (fishWeightFactors[fish] * Math.pow(length, 3) / 100000).toFixed(2);
    row.querySelector(".weight-note").classList.remove("hidden");
  }
}
async function loadTicket() {
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Chybí platný kód místenky.");
  const response = await fetch(`/api/tickets/${code}`);
  const ticket = await response.json();
  if (!response.ok) throw new Error(ticket.error);
  if (ticket.status !== "active") throw new Error("Tato místenka už není aktivní.");
  qs("#ticketSummary").innerHTML = `<div><span class="section-kicker">Místenka ${ticket.code}</span><strong>${ticket.firstName} ${ticket.lastName}</strong><span>${ticket.date} · Petrůvka 1 A</span></div><span class="ticket-status">● Aktivní</span>`;
  qs("#ticketSummary").classList.remove("hidden");
  qs("#catchPageForm").classList.remove("hidden");
  addRow();
}
qs("#addCatch").addEventListener("click", addRow);
qs("#submitReturn").addEventListener("click", async () => {
  const rows = [...document.querySelectorAll(".catch-row")];
  let valid = true;
  let undersized = false;
  const catches = rows.map((row) => {
    const species = row.querySelector(".fish-name").value.trim();
    const length = Number(row.querySelector(".fish-length").value);
    const weight = Number(row.querySelector(".fish-weight").value);
    if (!species || !length) {
      row.querySelector(".fish-length").classList.add("invalid");
      row.querySelector(".length-error").textContent = "Vyplňte délku";
      valid = false;
    } else if (!validateLength(row)) {
      undersized = true;
      valid = false;
    }
    return { species, length, weight: weight || null };
  });
  if (undersized) return toast("Nelze odevzdat místenku: zkontrolujte podměrečnou rybu.");
  if (!valid) return toast("Doplňte délku u každého úlovku.");
  if (!qs("#returnDeclaration").checked) return toast("Potvrďte úplnost údajů.");
  const button = qs("#submitReturn");
  button.disabled = true;
  try {
    const response = await fetch(`/api/tickets/${code}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ catches }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    qs("#catchPageForm").classList.add("hidden");
    qs("#returnedState").classList.remove("hidden");
  } catch (error) { toast(error.message); button.disabled = false; }
});
loadTicket().catch((error) => { qs("#returnError").textContent = error.message; qs("#returnError").classList.remove("hidden"); });
