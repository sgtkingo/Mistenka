const { qs, esc, api, loadConfig, fishingPlace, gpsLink, revirUrl, czDate, czk, czDateTime, fishingHours, subdistrictLabel, subdistrictTitle, plural, credentialsFor, qrSvg, ticketCheckUrl, showToast, applyBranding, loadSession, limitsHtml } = window.Mistenka;

const code = (new URLSearchParams(location.search).get("code") || "").trim().toUpperCase();
const credentials = credentialsFor(code);
let config = null;
let ticket = null;
let pollTimer = null;
let countdownTimer = null;

const show = (id) => ["loadingState", "paymentForm", "successState", "endedState", "errorState"].forEach((name) => qs(`#${name}`).classList.toggle("hidden", name !== id));
const revirOf = (t) => config.reviry.find((item) => item.id === t.revir.id) || { ...t.revir, fishingHours: [], lateReturnDays: 7 };

function setHeading(kicker, title, step) {
  // Stav "vystaveno" a "ukončeno" má vlastní nadpis v obsahu, horní hlavičku pak skryjeme.
  qs("#paymentHeading").classList.toggle("hidden", step !== "Platba");
  qs("#paymentKicker").textContent = kicker;
  qs("#paymentTitle").textContent = title;
  qs("#paymentStep").textContent = step;
}

function renderPending() {
  const p = ticket.payment;
  setHeading("Platba místenky", "Dokončete platbu", "Platba");
  qs("#paymentRevir").textContent = ticket.revir.name;
  const revir = revirOf(ticket);
  qs("#paymentNumber").textContent = ticket.revir.number || "";
  qs("#paymentNumberRow").classList.toggle("hidden", !ticket.revir.number);
  qs("#paymentSubdistrictTitle").textContent = subdistrictTitle(revir, ticket);
  qs("#paymentSubdistrict").textContent = subdistrictLabel(revir, ticket);
  qs("#paymentSubdistrictRow").classList.toggle("hidden", !subdistrictLabel(revir, ticket));
  // Zvýrazněné místo lovu: podrevír místenky (s jeho GPS), jinak celý revír.
  const place = fishingPlace(revir, ticket.subdistrict?.number);
  qs("#paymentSubdistrictRow").classList.toggle("summary-place", place.subdistrict);
  qs("#paymentRevirRow").classList.toggle("summary-place", !place.subdistrict);
  qs("#paymentSubdistrictGps").innerHTML = place.subdistrict && place.gps ? `GPS ${gpsLink(place.gps)}` : "";
  qs("#paymentRevirGps").innerHTML = !place.subdistrict ? `Celý revír${place.gps ? ` · GPS ${gpsLink(place.gps)}` : ""}` : "";
  qs("#paymentDate").textContent = czDate(ticket.date, { weekday: true });
  qs("#paymentPerson").textContent = `${ticket.firstName} ${ticket.lastName}`;
  qs("#paymentAmount").textContent = czk(p.amountHalere);
  qs("#paymentQr").innerHTML = qrSvg(p.spayd, "QR platba");
  qs("#bankAccount").textContent = p.accountNumber;
  qs("#bankAmount").textContent = czk(p.amountHalere);
  qs("#bankVs").textContent = p.variableSymbol;
  qs("#bankMessage").textContent = p.message;
  qs("#simulatePayment").classList.toggle("hidden", config.payment.mode !== "fake");
  const updateCountdown = () => {
    const minutes = Math.max(0, Math.ceil((new Date(p.reservedUntil) - Date.now()) / 60000));
    qs("#reservationNote").textContent = `Místo držíme do ${czDateTime(p.reservedUntil)} (zbývá ${minutes} min). Zaplaťte prosím přesnou částku se správným variabilním symbolem.`;
  };
  updateCountdown();
  window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(updateCountdown, 30000);
  show("paymentForm");
  schedulePoll();
}

function renderIssued() {
  window.clearTimeout(pollTimer);
  window.clearInterval(countdownTimer);
  const revir = revirOf(ticket);
  const hours = fishingHours(revir, ticket.date);
  setHeading("Místenka vystavena", "Vaše místenka je připravená", "Hotovo");
  // Rovnou na odevzdání této místenky (přístup si stránka odevzdání vezme z prohlížeče); jen když odevzdat jde.
  const returnable = ticket.status === "active" || ((ticket.status === "expired_unreturned" || ticket.status === "seized") && ticket.returnable);
  qs("#returnNow").href = `return.html?code=${encodeURIComponent(ticket.code)}`;
  qs("#returnNow").classList.toggle("hidden", !returnable);
  const statusLabel = { future: "● Platí od dne lovu", active: "● Aktivní", expired_unreturned: "! Neodevzdaná", closed_unreturned: "× Uzavřená, neodevzdaná", expired_returned: "↩ Odevzdaná", seized: "! Zadržená – odevzdejte" }[ticket.status] || ticket.status;
  qs("#ticketCard").innerHTML = `<div class="ticket-top"><span class="section-kicker">${esc([ticket.revir.name, ticket.revir.number].filter(Boolean).join(" · "))}</span><span class="ticket-status">${esc(statusLabel)}</span></div>
    <div class="ticket-code">${esc(ticket.code)}</div>
    <div class="ticket-details"><span><small>Rybář</small><b>${esc(`${ticket.firstName} ${ticket.lastName}`)}</b></span>${subdistrictLabel(revir, ticket) ? `<span><small>${esc(subdistrictTitle(revir, ticket))}</small><b>${esc(subdistrictLabel(revir, ticket))}</b></span>` : ""}<span><small>Datum lovu</small><b>${esc(czDate(ticket.date, { weekday: true }))}</b></span><span><small>Č. legitimace</small><b>${esc(ticket.memberId)}</b></span></div>
    ${placeHtml(revir)}
    <div class="ticket-qr">${qrSvg(ticketCheckUrl(ticket.code), "QR kód pro kontrolu místenky")}<small>Kód pro kontrolu místenky</small></div>`;
  qs("#ticketLimits").innerHTML = limitsHtml((ticket.limits || []).filter((l) => l.period !== "day" || ticket.status === "expired_returned"), { title: "Vaše limity úlovků" });
  const rules = [];
  if (hours) rules.push(`Doba lovu v tento den: <b>${esc(hours)}</b>.`);
  (revir.fishingHours || []).forEach((rule) => rules.push(`${esc(rule.label || rule.months.join(", "))}: ${esc(rule.from)}–${esc(rule.to)}`));
  rules.push("Mějte u sebe platný rybářský lístek a povolenku.", "Každou ponechanou rybu je nutné ihned zapsat do povolenky.", `Místenku odevzdejte ihned po ukončení lovu v daný den. Pozdější odevzdání je možné nejpozději do ${esc(revir.lateReturnDays)} ${plural(revir.lateReturnDays, "dne", "dnů", "dnů")} a bude označeno jako opožděné; pak se místenka automaticky uzavře jako neodevzdaná.`);
  qs("#ticketRules").innerHTML = rules.map((rule) => `<li>${rule}</li>`).join("");
  qs("#emailNote").textContent = `Potvrzení jsme poslali na ${ticket.email}. Najdete v něm i odkaz pro odevzdání místenky po skončení lovu.`;
  show("successState");
}

// Místo lovu na vystavené místence: podrevír (nebo celý revír), GPS a odkaz na interaktivní mapu.
function placeHtml(revir) {
  const place = fishingPlace(revir, ticket.subdistrict?.number);
  const map = revir.map?.features ? `<a href="map.html?revir=${encodeURIComponent(revir.id)}">Interaktivní mapa revíru →</a>` : "";
  return `<div class="ticket-place"><small>Místo lovu</small><b>${esc(place.title)}</b><span>${[place.gps && `GPS ${gpsLink(place.gps)}`, map].filter(Boolean).join(" · ")}</span></div>`;
}

function renderEnded(kind) {
  window.clearTimeout(pollTimer);
  window.clearInterval(countdownTimer);
  const expired = kind === "payment_expired";
  setHeading(expired ? "Rezervace vypršela" : "Objednávka zrušena", "Platba nebyla dokončena", expired ? "Vypršelo" : "Zrušeno");
  qs("#endedKicker").textContent = expired ? "Rezervace vypršela" : "Objednávka zrušena";
  qs("#endedTitle").textContent = expired ? "Platba nedorazila včas" : "Objednávka byla zrušena";
  qs("#endedText").textContent = expired
    ? "Místo jsme uvolnili. Pokud jste už zaplatili, platbu dohledáme – kontaktujte prosím hospodáře. Jinak vytvořte novou objednávku."
    : "Objednávka byla bezpečně zrušena. Můžete vytvořit novou.";
  show("endedState");
}

function render() {
  qs("#homeLink").href = revirUrl("./", revirOf(ticket), config);
  qs("#endedLink").href = revirUrl("./", revirOf(ticket), config);
  if (ticket.status === "pending_payment") return renderPending();
  if (ticket.status === "payment_expired" || ticket.status === "cancelled") return renderEnded(ticket.status);
  return renderIssued();
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => {
    try {
      ticket = await api(`/orders/${code}`, credentials);
      if (ticket.status !== "pending_payment") return render();
    } catch { /* výpadek sítě – zkusíme znovu */ }
    schedulePoll();
  }, 5000);
}

qs("#simulatePayment").addEventListener("click", async () => {
  const button = qs("#simulatePayment");
  button.disabled = true;
  try {
    const { result } = await api("/dev/payments", { method: "POST", body: { code } });
    if (result !== "matched") showToast(`Platba nebyla spárována (${result}).`, "warning");
    ticket = await api(`/orders/${code}`, credentials);
    render();
  } catch (error) { showToast(error.message, "error"); } finally { button.disabled = false; }
});
qs("#cancelPayment").addEventListener("click", async () => {
  if (!window.confirm("Opravdu zrušit objednávku? Pokud jste už zaplatili, objednávku nerušte.")) return;
  try {
    ticket = await api(`/orders/${code}/cancel`, { method: "POST", ...credentials });
    render();
  } catch (error) { showToast(error.message, "error"); }
});
qs("#downloadTicket").addEventListener("click", () => {
  const revir = revirOf(ticket);
  // Má-li revír zakreslenou mapu, PDF obsahuje klikací odkaz na interaktivní mapu.
  const mapUrl = revir.map?.features ? new URL(`map.html?revir=${encodeURIComponent(revir.id)}`, location.href).href : "";
  window.MistenkaPdf.download({ ticket, revir, organization: config.organization, checkUrl: ticketCheckUrl(ticket.code), hours: fishingHours(revir, ticket.date), testMode: config.payment.mode === "fake", mapUrl });
});
qs("#printTicket").addEventListener("click", () => window.print());

(async function init() {
  try {
    config = await loadConfig();
    applyBranding(config);
    // Falešná banka (testovací web): jasně říct, že místenky nejsou platné.
    qs("#testModeBanner").classList.toggle("hidden", config.payment.mode !== "fake");
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Chybí platný kód objednávky.");
    if (!credentials.token && !credentials.memberId && !(await loadSession())) throw new Error("Objednávku otevřete odkazem z e-mailu, nebo ji zkontrolujte na stránce kontroly místenky.");
    ticket = await api(`/orders/${code}`, credentials);
    render();
  } catch (error) {
    qs("#errorState").innerHTML = `${esc(error.message)}${/^[A-Z0-9]{6}$/.test(code) ? ` <a href="status.html?code=${esc(code)}">Zkontrolovat stav místenky →</a>` : ""}`;
    show("errorState");
  }
})();
