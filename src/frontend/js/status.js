const { qs, esc, api, czDate, czDateTime } = window.Mistenka;
const code = (new URLSearchParams(location.search).get("code") || "").trim().toUpperCase();

// Stav -> [popisek, vysvětlení, CSS třída, ikona]
const STATES = {
  future: ["Budoucí", "Místenka začne platit v den lovu.", "status-future", "→"],
  active: ["Aktivní", "Místenka platí pro dnešní den lovu.", "status-active", "✓"],
  expired_returned: ["Odevzdaná", "Místenka byla odevzdána.", "status-returned", "↩"],
  expired_returned_late: ["Opožděné odevzdání", "Místenka byla odevzdána po skončení dne lovu.", "status-expired", "↩"],
  expired_unreturned: ["Propadlá, neodevzdaná", "Místenka už neplatí pro lov a nebyla odevzdána.", "status-expired", "!"],
  closed_unreturned: ["Uzavřená, neodevzdaná", "Místenka nebyla odevzdána ani v prodloužené lhůtě a byla automaticky uzavřena.", "status-expired", "×"],
  pending_payment: ["Čeká na platbu", "Místenka zatím nebyla zaplacena a neopravňuje k lovu.", "status-expired", "…"],
  payment_expired: ["Nezaplacená", "Objednávka nebyla včas zaplacena. Místenka neplatí.", "status-expired", "×"],
  cancelled: ["Zrušená", "Objednávka byla zrušena. Místenka neplatí.", "status-expired", "×"]
};

function showError(message) {
  qs("#statusLoading").classList.add("hidden");
  qs("#statusError").textContent = message;
  qs("#statusError").classList.remove("hidden");
}

async function loadStatus() {
  if (!/^[A-Z0-9]{6}$/.test(code)) return showError("Chybí platný šestimístný kód místenky.");
  try {
    const ticket = await api(`/tickets/${code}`);
    const key = ticket.status === "expired_returned" && ticket.late ? "expired_returned_late" : ticket.status;
    const [label, message, css, icon] = STATES[key] || [ticket.status, "", "status-expired", "!"];
    qs("#statusBanner").className = `status-banner ${css}`;
    qs("#statusBanner").innerHTML = `<span>${esc(icon)}</span><div><strong>${esc(label)}</strong><small>${esc(message)}</small></div>`;
    const rows = [["Datum lovu", czDate(ticket.date, { weekday: true })]];
    if (ticket.holder) rows.unshift(["Rybář", ticket.holder.name], ["Č. legitimace", ticket.holder.memberId]);
    if (ticket.status === "active") rows.push(["Platí do", czDateTime(ticket.validTo)]);
    rows.push(["Stav", label]);
    qs("#ticketStatusCard").innerHTML = `<span class="section-kicker">Místenka ${esc(ticket.code)}</span><h2>${esc([ticket.revir.name, ticket.revir.number].filter(Boolean).join(" · "))}</h2><dl class="summary-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
    document.title = `Místenka ${ticket.code} · ${label}`;
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
qs("#nextCode").addEventListener("keydown", (event) => { if (event.key === "Enter") qs("#nextCheck").click(); });
loadStatus();
