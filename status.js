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
    qs("#statusBanner").className = `status-banner ${active ? "status-active" : "status-returned"}`;
    qs("#statusBanner").innerHTML = `<span>${active ? "✓" : "!"}</span><div><strong>${active ? "Místenka je platná" : "Místenka je odevzdaná"}</strong><small>${active ? "Místenka je připravena pro kontrolu u revíru." : "Tato místenka už není aktivní."}</small></div>`;
    qs("#ticketStatusCard").innerHTML = `<span class="section-kicker">Místenka ${ticket.code}</span><h2>Petrůvka 1 A</h2><dl class="summary-list"><div><dt>Rybář</dt><dd>${ticket.firstName} ${ticket.lastName}</dd></div><div><dt>Datum lovu</dt><dd>${ticket.date}</dd></div><div><dt>Číslo lístku</dt><dd>${ticket.license}</dd></div><div><dt>Stav</dt><dd>${active ? "Aktivní" : "Odevzdaná"}</dd></div></dl>`;
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
