const qs = (selector) => document.querySelector(selector);
const purchase = JSON.parse(localStorage.getItem("mistenkaPurchase") || "null");
let attempt = 0;
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

if (!purchase) {
  window.location.href = "/";
} else {
  qs("#paymentDate").textContent = purchase.date;
  qs("#paymentPerson").textContent = `${purchase.firstName} ${purchase.lastName}`;
}

function renderTicket(ticket) {
  qs("#ticketCard").innerHTML = `<div class="ticket-top"><span class="section-kicker">Petrůvka 1 A · 471 115</span><span class="ticket-status">● Aktivní</span></div><div class="ticket-code">${ticket.code}</div><div class="ticket-details"><span><small>Rybář</small><b>${ticket.firstName} ${ticket.lastName}</b></span><span><small>Datum lovu</small><b>${ticket.date}</b></span><span><small>Číslo lístku</small><b>${ticket.license}</b></span></div><div class="ticket-qr"><div class="fake-qr"><span></span></div><small>Kód pro kontrolu místenky</small></div>`;
}
qs("#payNow").addEventListener("click", async () => {
  qs("#paymentForm").classList.add("hidden");
  qs("#checkingState").classList.remove("hidden");
  const timer = window.setInterval(() => {
    attempt += 1;
    qs("#checkingMessage").textContent = `Ověření platby ${attempt} / 3…`;
    qs("#checkProgress").style.width = `${Math.min(attempt, 3) * 33.333}%`;
  }, 850);
  await wait(2550);
  window.clearInterval(timer);
  try {
    const response = await fetch("/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(purchase) });
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error || "Platbu se nepodařilo ověřit.");
    renderTicket(ticket);
    qs("#checkingState").classList.add("hidden");
    qs("#successState").classList.remove("hidden");
    qs("#paymentKicker").textContent = "Nákup dokončen";
    qs("#paymentTitle").textContent = "Vaše místenka je připravená";
    qs("#paymentStep").textContent = "4 / 4";
    localStorage.removeItem("mistenkaPurchase");
  } catch (error) {
    window.alert(error.message);
    qs("#checkingState").classList.add("hidden");
    qs("#paymentForm").classList.remove("hidden");
  }
});
qs("#cancelPayment").addEventListener("click", () => {
  localStorage.removeItem("mistenkaPurchase");
  qs("#paymentForm").classList.add("hidden");
  qs("#cancelledState").classList.remove("hidden");
  qs("#paymentKicker").textContent = "Objednávka zrušena";
  qs("#paymentTitle").textContent = "Platba nebyla dokončena";
  qs("#paymentStep").textContent = "Zrušeno";
});
