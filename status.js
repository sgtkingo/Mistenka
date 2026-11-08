const qs = (selector) => document.querySelector(selector);
const code = (new URLSearchParams(window.location.search).get("code") || "").trim().toUpperCase();

function showError(message) {
  qs("#statusLoading").classList.add("hidden");
  qs("#statusError").textContent = message;
  qs("#statusError").classList.remove("hidden");
}

async function loadStatus() {
  if (!/^[A-Z0-9]{6}$/.test(code)) return showError("Chybí platný šestimístný kód místenky.");
  try {
    const response = await fetch(`/api/tickets/${code}`);
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error);
    const active = ticket.status === "active";
    const future = ticket.status === "future";
    const returned = ticket.status === "expired_returned";
    const label = future ? "Budoucí" : active ? "Aktivní" : returned ? "Odevzdaná" : "Propadlá, neodevzdaná";
    const message = future ? "Místenka začne platit v den uvedený na místance." : active ? "Místenka je platná pouze pro datum lovu." : returned ? (ticket.late ? "Místenka byla odevzdána po skončení dne lovu." : "Místenka byla odevzdána.") : "Místenka už není platná pro lov. Odevzdání je stále možné, ale bude označeno jako opožděné.";
    qs("#statusBanner").className = `status-banner ${future ? "status-future" : active ? "status-active" : returned ? "status-returned" : "status-expired"}`;
    qs("#statusBanner").innerHTML = `<span>${future ? "→" : active ? "✓" : returned ? "↩" : "!"}</span><div><strong>${label}</strong><small>${message}</small></div>`;
    qs("#ticketStatusCard").innerHTML = `<span class="section-kicker">Místenka ${ticket.code}</span><h2>Petrůvka 1 A</h2><dl class="summary-list"><div><dt>Rybář</dt><dd>${ticket.firstName} ${ticket.lastName}</dd></div><div><dt>Datum lovu</dt><dd>${ticket.date}</dd></div><div><dt>Číslo lístku</dt><dd>${ticket.license}</dd></div><div><dt>Stav</dt><dd>${label}</dd></div></dl>`;
    qs("#statusLoading").classList.add("hidden");
    qs("#statusContent").classList.remove("hidden");
  } catch (error) {
    showError(error.message);
  }
}

qs("#nextCheck").addEventListener("click", () => {
  const nextCode = qs("#nextCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(nextCode)) return qs("#nextCode").focus();
  window.location.href = `status.html?code=${encodeURIComponent(nextCode)}`;
});
qs("#nextCode").addEventListener("keydown", (event) => {
  if (event.key === "Enter") qs("#nextCheck").click();
});
loadStatus();
