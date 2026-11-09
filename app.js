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
  if (valid) qs("#license").classList.remove("license-invalid");
});
qs("#continueButton").addEventListener("click", () => {
  if (qs("#license").value.trim().length < 6) {
    const license = qs("#license");
    license.classList.add("license-invalid");
    license.scrollIntoView({ behavior: "smooth", block: "center" });
    license.focus({ preventScroll: true });
    return showToast("Nejdřív zadejte číslo rybářského lístku.");
  }
  if (!qs("#declaration").checked) {
    const declarationLabel = qs("#declarationLabel");
    declarationLabel.classList.add("declaration-invalid");
    declarationLabel.scrollIntoView({ behavior: "smooth", block: "center" });
    qs("#declaration").focus({ preventScroll: true });
    return showToast("Potvrďte čestné prohlášení a podmínky rezervace.");
  }
  purchase = { license: qs("#license").value.trim().toUpperCase(), date: selectedDate() };
  showPanel("person");
});
qs("#declaration").addEventListener("change", (event) => {
  if (event.target.checked) qs("#declarationLabel").classList.remove("declaration-invalid");
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
qs("#email").addEventListener("input", () => qs("#email").classList.remove("email-invalid"));
let voucherState = { code: "", valid: false };
qs("#voucherCode").addEventListener("input", () => {
  const input = qs("#voucherCode");
  const code = input.value.trim().toUpperCase();
  input.value = code;
  voucherState = { code, valid: false };
  input.classList.remove("voucher-invalid", "voucher-valid");
  if (!code) return updateSummaryTotal(false);
});
qs("#verifyVoucher").addEventListener("click", async () => {
  const input = qs("#voucherCode");
  const verifyButton = qs("#verifyVoucher");
  if (voucherState.valid) {
    input.value = "";
    input.disabled = false;
    input.classList.remove("voucher-invalid", "voucher-valid");
    voucherState = { code: "", valid: false };
    verifyButton.textContent = "Ověřit";
    updateSummaryTotal(false);
    qs("#paymentHelp").textContent = "Na platební stránce zobrazíte platební údaje a dokončíte demo platbu.";
    input.focus();
    return;
  }
  const code = input.value.trim().toUpperCase();
  input.value = code;
  voucherState = { code, valid: false };
  input.classList.remove("voucher-invalid", "voucher-valid");
  if (!/^[A-Z0-9]{16}$/.test(code)) {
    input.classList.add("voucher-invalid");
    showToast("Zadejte 16 znaků A–Z nebo 0–9");
    updateSummaryTotal(false);
    input.focus();
    return;
  }
  verifyButton.disabled = true;
  verifyButton.innerHTML = '<span class="voucher-spinner" aria-label="Ověřuji"></span>';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const responsePromise = fetch(`/api/vouchers/${code}`, { signal: controller.signal });
    const response = await responsePromise;
    const result = await response.json();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (!result.valid) throw new Error(result.usedAt ? "Poukaz už byl použit." : "Poukaz není platný.");
    voucherState = { code, valid: true };
    input.classList.add("voucher-valid");
    input.disabled = true;
    verifyButton.disabled = false;
    verifyButton.textContent = "Zrušit";
    updateSummaryTotal(true);
    qs("#paymentHelp").textContent = "Místenka bude vystavena zdarma, bez zadávání platebních údajů.";
    showToast("Poukaz je platný, místenka je zdarma!");
  } catch (error) {
    input.classList.add("voucher-invalid");
    updateSummaryTotal(false);
    showToast(error.name === "AbortError" ? "Ověření poukazu trvalo příliš dlouho." : error.message);
  } finally {
    window.clearTimeout(timeout);
    if (!voucherState.valid) {
      verifyButton.disabled = false;
      verifyButton.innerHTML = "Ověřit";
    }
  }
});
function updateSummaryTotal(isFree) {
  qs("#summaryTotal").textContent = isFree ? "ZDARMA" : "200 Kč";
}
qs("#startPayment").addEventListener("click", () => {
  const email = qs("#email").value.trim();
  if (!email || !email.includes("@")) {
    const emailInput = qs("#email");
    emailInput.classList.add("email-invalid");
    emailInput.scrollIntoView({ behavior: "smooth", block: "center" });
    emailInput.focus({ preventScroll: true });
    return showToast("Zadejte platný e-mail pro potvrzení.");
  }
  qs("#email").classList.remove("email-invalid");
  purchase.email = email;
  if (qs("#voucherCode").value.trim() && (!voucherState.valid || voucherState.code !== qs("#voucherCode").value.trim().toUpperCase())) return showToast("Ověřte platnost dárkového poukazu.");
  purchase.voucherCode = voucherState.valid ? voucherState.code : "";
  purchase.total = voucherState.valid ? 0 : 200;
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
    if (ticket.status === "future") throw new Error("Tuto místenku není možné odevzdat před datem lovu.");
    if (ticket.status === "expired_returned") throw new Error("Tato místenka už byla odevzdána.");
    window.location.href = `return.html?code=${encodeURIComponent(ticket.code)}`;
  } catch (error) { showToast(error.message); }
});
qs("#checkButton").addEventListener("click", async () => {
  const code = qs("#checkCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showToast("Zadejte platný šestimístný kód místenky.");
  window.location.href = `status.html?code=${encodeURIComponent(code)}`;
});
qs("#loginButton").addEventListener("click", () => showToast("Přihlášení bude dostupné v další verzi pilotu."));

function scrollToHash() {
  const target = window.location.hash ? document.querySelector(window.location.hash) : null;
  if (target) window.setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
}
window.addEventListener("hashchange", scrollToHash);
scrollToHash();
