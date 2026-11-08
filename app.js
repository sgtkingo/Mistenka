const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];
const panels = { buy: qs("#buyPanel"), person: qs("#personPanel"), return: qs("#returnPanel"), check: qs("#checkPanel"), payment: qs("#paymentPanel"), success: qs("#successPanel") };
const panelTitle = qs("#panelTitle");
const stepBadge = qs("#stepBadge");
const panelKicker = qs("#panelKicker");
let purchase = {};

function showToast(message) {
  const toast = qs("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2800);
}
function showPanel(name) {
  Object.values(panels).forEach((panel) => panel.classList.add("hidden"));
  panels[name].classList.remove("hidden");
  const titles = { buy: "Vyberte si den u vody", person: "Kdo bude na místenku?", return: "Vraťte svou místenku", check: "Je vaše místenka platná?", payment: "Dokončete rezervaci", success: "Místenka vystavena" };
  panelTitle.textContent = titles[name];
  panelKicker.textContent = name === "return" ? "Ukončení lovu" : name === "check" ? "Kontrola" : "Nákup místenky";
  stepBadge.textContent = name === "buy" ? "1 / 4" : name === "person" ? "2 / 4" : name === "payment" ? "3 / 4" : name === "success" ? "4 / 4" : "Rychlá akce";
  qs("#flowPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function resetPurchase() {
  ["license", "firstName", "lastName", "birthDate"].forEach((id) => { qs(`#${id}`).value = ""; });
  qs("#declaration").checked = false;
  showPanel("buy");
}
function selectedDate() {
  return qs(".date-option.selected").dataset.date;
}

qsa(".action-card").forEach((card) => card.addEventListener("click", () => {
  qsa(".action-card").forEach((item) => item.classList.remove("active"));
  card.classList.add("active");
  showPanel(card.dataset.panel);
}));
qsa(".date-option").forEach((option) => option.addEventListener("click", () => {
  qsa(".date-option").forEach((item) => item.classList.remove("selected"));
  option.classList.add("selected");
}));
qs("#license").addEventListener("input", (event) => {
  const status = qs("#licenseStatus");
  const valid = event.target.value.trim().length >= 6;
  status.textContent = valid ? "Formát ověřen" : "Čeká na ověření";
  status.classList.toggle("valid", valid);
});
qs("#continueButton").addEventListener("click", () => {
  if (qs("#license").value.trim().length < 6) return showToast("Nejdřív zadejte číslo rybářského lístku.");
  if (!qs("#declaration").checked) return showToast("Potvrďte čestné prohlášení a podmínky rezervace.");
  purchase = { license: qs("#license").value.trim().toUpperCase(), date: selectedDate() };
  showPanel("person");
});
qs("#backToLicense").addEventListener("click", () => showPanel("buy"));
qs("#continuePerson").addEventListener("click", () => {
  if (!qs("#firstName").value.trim() || !qs("#lastName").value.trim() || !qs("#birthDate").value) return showToast("Vyplňte jméno, příjmení a datum narození.");
  purchase.firstName = qs("#firstName").value.trim();
  purchase.lastName = qs("#lastName").value.trim();
  purchase.birthDate = qs("#birthDate").value;
  localStorage.setItem("mistenkaPurchase", JSON.stringify(purchase));
  qs("#summaryDate").textContent = purchase.date;
  qs("#summaryPerson").textContent = `${purchase.firstName} ${purchase.lastName}`;
  showPanel("payment");
});
qs("#backButton").addEventListener("click", () => showPanel("person"));
qs("#startPayment").addEventListener("click", () => {
  const email = qs("#email").value.trim();
  if (!email || !email.includes("@")) return showToast("Zadejte platný e-mail pro potvrzení.");
  purchase.email = email;
  localStorage.setItem("mistenkaPurchase", JSON.stringify(purchase));
  window.location.href = "payment.html";
});
function renderTicket(ticket) {
  qs("#ticketCard").innerHTML = `<div class="ticket-top"><span class="section-kicker">Petrůvka 1 A · 471 115</span><span class="ticket-status">● Aktivní</span></div><div class="ticket-code">${ticket.code}</div><div class="ticket-details"><span><small>Rybář</small><b>${ticket.firstName} ${ticket.lastName}</b></span><span><small>Datum lovu</small><b>${ticket.date}</b></span><span><small>Číslo lístku</small><b>${ticket.license}</b></span></div><div class="ticket-qr"><div class="fake-qr"><span></span></div><small>Kód pro kontrolu místenky</small></div>`;
  const month = Number(ticket.date.match(/\d+/)?.[0] || 11);
  qs("#ticketHours").textContent = month >= 4 && month <= 9 ? "04:00–24:00" : "05:00–22:00";
}
qs("#newPurchase").addEventListener("click", resetPurchase);
qs("#returnFind").addEventListener("click", async () => {
  const code = qs("#returnCode").value.trim().toUpperCase();
  if (!code) return showToast("Zadejte kód místenky.");
  try {
    const response = await fetch(`/api/tickets/${code}`);
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error);
    if (ticket.status !== "active") throw new Error("Tato místenka už není aktivní.");
    window.location.href = `return.html?code=${encodeURIComponent(ticket.code)}`;
  } catch (error) { showToast(error.message); }
});
qs("#checkButton").addEventListener("click", async () => {
  const code = qs("#checkCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showToast("Zadejte platný šestimístný kód místenky.");
  window.location.href = `status.html?code=${encodeURIComponent(code)}`;
});
qs("#loginButton").addEventListener("click", () => showToast("Přihlášení bude dostupné v další verzi pilotu."));
