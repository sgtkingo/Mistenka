const { qs, qsa, esc, api, loadConfig, selectedRevir, revirUrl, czDate, dayInfo, czk, plural, subdistrictLabel, subdistrictTitle, normalizeMemberId, isMemberId, saveToken, rememberMemberId, showToast, applyBranding } = window.Mistenka;

const panels = { buy: qs("#buyPanel"), person: qs("#personPanel"), return: qs("#returnPanel"), check: qs("#checkPanel"), payment: qs("#paymentPanel") };
let config = null;
let revir = null;
let selectedDate = "";
let purchase = {};
let voucherState = { code: "", valid: false };
let weatherDays = null; // předpověď podle data, null = nedostupná

function showPanel(name) {
  Object.values(panels).forEach((panel) => panel.classList.add("hidden"));
  panels[name].classList.remove("hidden");
  const titles = { buy: "Vyberte si den u vody", person: "Kdo bude na místenku?", return: "Vraťte svou místenku", check: "Je vaše místenka platná?", payment: "Zkontrolujte objednávku" };
  qs("#panelTitle").textContent = titles[name];
  qs("#panelKicker").textContent = name === "return" ? "Ukončení lovu" : name === "check" ? "Kontrola" : "Nákup místenky";
  qs("#stepBadge").textContent = { buy: "1 / 3", person: "2 / 3", payment: "3 / 3" }[name] || "Rychlá akce";
  qs("#flowPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function markInvalid(input, className, message) {
  input.classList.add(className);
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus({ preventScroll: true });
  showToast(message);
}

// ---------- výběr revíru ----------
function renderPicker() {
  qs("#revirPicker").classList.remove("hidden");
  qs("#revirList").innerHTML = config.reviry.map((item) => `
    <a class="action-card" href="?revir=${encodeURIComponent(item.id)}">
      <span class="action-icon">⌁</span>
      <span class="action-content"><strong>${esc(item.name)}</strong><small>${esc([item.number, item.kind, czk(Math.round(item.priceCzk * 100)) + " / den"].filter(Boolean).join(" · "))}</small></span>
      <span class="card-arrow">→</span>
    </a>`).join("");
}

// ---------- údaje revíru ----------
function renderRevir() {
  document.title = `Místenka · ${revir.name}`;
  qsa("[data-revir-name]").forEach((el) => { el.textContent = revir.name; });
  if (config.reviry.length > 1) qs("#changeRevir").classList.remove("hidden");
  const meta = [revir.area && `<span><strong>${esc(revir.area)}</strong> vodní plochy</span>`, revir.subdistrictCount && `<span><strong>${esc(revir.subdistrictCount)}</strong> ${plural(revir.subdistrictCount, "podrevír", "podrevíry", "podrevírů")}</span>`, `<span><strong>${esc(czk(Math.round(revir.priceCzk * 100)))} / den</strong></span>`].filter(Boolean);
  qs("#heroMeta").innerHTML = meta.join('<span class="meta-divider"></span>');
  const [first, ...rest] = revir.name.split(" ");
  qs("#artLabel").innerHTML = `${esc(first)}<br><span>${esc(rest.join(" "))}</span>`;
  const days = revir.bookingDaysAhead;
  qs("#buyHint").textContent = days > 0 ? `Rezervujte si místo až ${days} ${plural(days, "den", "dny", "dní")} dopředu` : "Rezervujte si místo na dnešek";
  qs("#permitNote").textContent = revir.permitNote || "Pro lov musíte mít platný rybářský lístek a povolenku. Místenka povolenku nenahrazuje.";
  if (revir.notice?.title) {
    qs("#noticeTitle").textContent = revir.notice.title;
    qs("#noticeText").textContent = revir.notice.text || "";
    qs("#noticeCard").classList.remove("hidden");
  }
  qs("#revirSubtitle").textContent = [revir.number, revir.union, revir.kind].filter(Boolean).join(" · ");
  const details = [];
  if (revir.subdistricts) details.push(["⌖", "Podrevíry", esc(revir.subdistricts)]);
  if (revir.gps) details.push(["◷", "GPS", `<a href="https://mapy.cz/zakladni?x=${encodeURIComponent(revir.gps.lon)}&y=${encodeURIComponent(revir.gps.lat)}&z=16" target="_blank" rel="noreferrer">${esc(revir.gps.label || `${revir.gps.lat}, ${revir.gps.lon}`)} ↗</a>`]);
  if (revir.restrictions) details.push(["!", "Omezení", esc(revir.restrictions)]);
  qs("#revirDetails").innerHTML = details.map(([icon, title, body]) => `<div><span class="detail-icon">${icon}</span><span><b>${title}</b><br>${body}</span></div>`).join("");
  const rulesHref = revirUrl("rules.html", revir, config);
  qsa(".rules-link").forEach((link) => { link.href = rulesHref; });
  qs("#revirLinks").innerHTML = [revir.cardUrl && `<a class="map-link" href="${esc(revir.cardUrl)}" target="_blank" rel="noreferrer">Otevřít kartu revíru <span>↗</span></a>`, `<a class="map-link" href="${esc(rulesHref)}">Pravidla revíru <span>→</span></a>`].filter(Boolean).join("");
}

function renderContact() {
  const contact = config.organization.contact || {};
  const parts = [contact.label && esc(contact.label), contact.email && `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`, contact.phone && `<a href="tel:${esc(contact.phone.replace(/\s+/g, ""))}">${esc(contact.phone)}</a>`].filter(Boolean);
  qs("#contactLine").innerHTML = parts.join(" · ");
}

async function renderDates() {
  const grid = qs("#dateGrid");
  try {
    const { days, today } = await api(`/reviry/${encodeURIComponent(revir.id)}/availability`);
    const firstFree = days.find((day) => day.available > 0);
    selectedDate = firstFree ? firstFree.date : "";
    grid.innerHTML = days.map((day) => {
      const info = dayInfo(day.date, today);
      const soldOut = day.available <= 0;
      return `<button class="date-option${day.date === selectedDate ? " selected" : ""}${soldOut ? " sold-out" : ""}" type="button" data-date="${esc(day.date)}"${soldOut ? " disabled" : ""}><span class="date-weather hidden"></span><b>${esc(info.label)}</b><span>${esc(info.short)}</span><i>${soldOut ? "obsazeno" : `${day.available} ${plural(day.available, "místo", "místa", "míst")}`}</i></button>`;
    }).join("");
    qs("#availabilityNote").textContent = firstFree ? "● Dostupná místa" : "Všechny dny jsou obsazené";
    applyWeather();
    qsa(".date-option:not([disabled])").forEach((option) => option.addEventListener("click", () => {
      qsa(".date-option").forEach((item) => item.classList.remove("selected"));
      option.classList.add("selected");
      selectedDate = option.dataset.date;
    }));
  } catch (error) {
    grid.innerHTML = `<p class="status-error">${esc(error.message)}</p>`;
  }
}

// ---------- počasí ----------
async function loadWeather() {
  try { weatherDays = await window.MistenkaWeather.forecast(revir); } catch { weatherDays = null; }
  applyWeather();
}
function applyWeather() {
  if (!weatherDays) return;
  qsa(".date-option").forEach((option) => {
    const day = weatherDays[option.dataset.date];
    const slot = option.querySelector(".date-weather");
    if (!day || !slot) return;
    slot.innerHTML = `${esc(day.icon)} <b>${esc(day.max)}° / ${esc(day.min)}°</b>`;
    slot.title = day.label;
    slot.classList.remove("hidden");
  });
}
function renderWeatherCard(date) {
  const day = weatherDays?.[date];
  qs("#weatherCard").classList.toggle("hidden", !day);
  if (!day) return;
  qs("#weatherIcon").textContent = day.icon;
  qs("#weatherTitle").textContent = `Předpověď pro ${revir.name}`;
  qs("#weatherMain").textContent = `${day.label} · ${day.max} °C / ${day.min} °C`;
  qs("#weatherDetail").textContent = [`Vítr ${day.wind} km/h`, day.precipitation !== null && `pravděpodobnost srážek ${day.precipitation} %`].filter(Boolean).join(" · ");
}

// ---------- nákup ----------
qsa(".action-card[data-panel]").forEach((card) => card.addEventListener("click", () => {
  qsa(".action-card[data-panel]").forEach((item) => item.classList.remove("active"));
  card.classList.add("active");
  showPanel(card.dataset.panel);
}));
qs("#memberId").addEventListener("input", (event) => {
  const valid = isMemberId(event.target.value);
  qs("#memberIdStatus").textContent = valid ? "Formát ověřen" : "Čeká na ověření";
  qs("#memberIdStatus").classList.toggle("valid", valid);
  if (valid) qs("#memberId").classList.remove("member-invalid");
});
qs("#declaration").addEventListener("change", (event) => { if (event.target.checked) qs("#declarationLabel").classList.remove("declaration-invalid"); });
qs("#continueButton").addEventListener("click", () => {
  const memberId = normalizeMemberId(qs("#memberId").value);
  if (!isMemberId(memberId)) return markInvalid(qs("#memberId"), "member-invalid", "Zadejte 8místné číslo členské legitimace (pod čárovým kódem).");
  if (!selectedDate) return showToast("Vyberte den s volnými místy.");
  if (!qs("#declaration").checked) {
    qs("#declarationLabel").classList.add("declaration-invalid");
    qs("#declarationLabel").scrollIntoView({ behavior: "smooth", block: "center" });
    return showToast("Potvrďte čestné prohlášení a podmínky rezervace.");
  }
  purchase = { revirId: revir.id, memberId, date: selectedDate, declaration: true };
  showPanel("person");
});
qs("#backToStart").addEventListener("click", () => showPanel("buy"));
qs("#email").addEventListener("input", () => qs("#email").classList.remove("email-invalid"));
qs("#continuePerson").addEventListener("click", () => {
  const firstName = qs("#firstName").value.trim();
  const lastName = qs("#lastName").value.trim();
  const birthDate = qs("#birthDate").value;
  const email = qs("#email").value.trim();
  if (!firstName || !lastName || !birthDate) return showToast("Vyplňte jméno, příjmení a datum narození.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return markInvalid(qs("#email"), "email-invalid", "Zadejte platný e-mail pro zaslání místenky.");
  Object.assign(purchase, { firstName, lastName, birthDate, email });
  qs("#summaryDate").textContent = czDate(purchase.date, { weekday: true });
  qs("#summaryPerson").textContent = `${firstName} ${lastName}`;
  qs("#summaryEmail").textContent = email;
  qs("#summaryNumber").textContent = revir.number || "";
  qs("#summaryNumberRow").classList.toggle("hidden", !revir.number);
  qs("#summarySubdistrictTitle").textContent = subdistrictTitle(revir);
  qs("#summarySubdistrict").textContent = subdistrictLabel(revir);
  qs("#summarySubdistrictRow").classList.toggle("hidden", !subdistrictLabel(revir));
  updateSummaryTotal();
  renderWeatherCard(purchase.date);
  showPanel("payment");
});
qs("#backButton").addEventListener("click", () => showPanel("person"));

function updateSummaryTotal() {
  const free = voucherState.valid || revir.priceCzk === 0;
  qs("#summaryTotal").textContent = free ? "ZDARMA" : czk(Math.round(revir.priceCzk * 100));
  qs("#paymentHelp").textContent = free
    ? "Místenka bude vystavena ihned, bez platby."
    : `Po odeslání zobrazíme QR platbu. Místo držíme ${config.payment.reservationMinutes} minut; místenku vystavíme po připsání platby.`;
  qs("#startPayment").firstChild.textContent = free ? "Vystavit místenku " : "Objednat a zaplatit ";
}

qs("#voucherCode").addEventListener("input", () => {
  const input = qs("#voucherCode");
  input.value = input.value.trim().toUpperCase();
  voucherState = { code: input.value, valid: false };
  input.classList.remove("voucher-invalid", "voucher-valid");
  updateSummaryTotal();
});
qs("#verifyVoucher").addEventListener("click", async () => {
  const input = qs("#voucherCode");
  const button = qs("#verifyVoucher");
  if (voucherState.valid) {
    input.value = "";
    input.disabled = false;
    input.classList.remove("voucher-invalid", "voucher-valid");
    voucherState = { code: "", valid: false };
    button.textContent = "Ověřit";
    updateSummaryTotal();
    return input.focus();
  }
  const code = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{16}$/.test(code)) {
    input.classList.add("voucher-invalid");
    return showToast("Zadejte 16 znaků A–Z nebo 0–9.");
  }
  button.disabled = true;
  button.innerHTML = '<span class="voucher-spinner" aria-label="Ověřuji"></span>';
  try {
    const result = await api(`/vouchers/${code}`);
    if (!result.valid) throw new Error(result.usedAt ? "Poukaz už byl použit." : "Poukaz není platný.");
    if (result.revirId && result.revirId !== revir.id) throw new Error("Poukaz neplatí pro tento revír.");
    voucherState = { code, valid: true };
    input.classList.add("voucher-valid");
    input.disabled = true;
    button.textContent = "Zrušit";
    showToast("Poukaz je platný, místenka je zdarma!");
  } catch (error) {
    input.classList.add("voucher-invalid");
    button.textContent = "Ověřit";
    showToast(error.message);
  } finally {
    button.disabled = false;
    updateSummaryTotal();
  }
});

qs("#startPayment").addEventListener("click", async () => {
  if (qs("#voucherCode").value.trim() && !voucherState.valid) return showToast("Ověřte platnost dárkového poukazu, nebo kód smažte.");
  const button = qs("#startPayment");
  button.disabled = true;
  try {
    const { token, ticket } = await api("/orders", { method: "POST", body: { ...purchase, voucherCode: voucherState.valid ? voucherState.code : "" } });
    saveToken(ticket.code, token);
    window.location.href = `payment.html?code=${encodeURIComponent(ticket.code)}`;
  } catch (error) {
    showToast(error.message);
    if (error.code === "sold_out") { renderDates(); showPanel("buy"); }
    button.disabled = false;
  }
});

// ---------- odevzdání a kontrola ----------
qs("#returnFind").addEventListener("click", async () => {
  const code = qs("#returnCode").value.trim().toUpperCase();
  const memberId = normalizeMemberId(qs("#returnMemberId").value);
  if (!/^[A-Z0-9]{6}$/.test(code)) return showToast("Zadejte šestimístný kód místenky.");
  if (!isMemberId(memberId)) return showToast("Zadejte 8místné číslo členské legitimace.");
  try {
    const ticket = await api(`/orders/${code}`, { memberId });
    if (ticket.status === "expired_returned") throw new Error("Tato místenka už byla odevzdána.");
    if (ticket.status === "future") throw new Error("Místenku není možné odevzdat před dnem lovu.");
    if (!ticket.returnable) throw new Error(ticket.status === "closed_unreturned" ? "Lhůta pro odevzdání uplynula, místenka byla uzavřena jako neodevzdaná. Kontaktujte hospodáře." : "Tuto místenku nelze odevzdat.");
    rememberMemberId(code, memberId);
    window.location.href = `return.html?code=${encodeURIComponent(code)}`;
  } catch (error) { showToast(error.message); }
});
qs("#returnMemberId").addEventListener("keydown", (event) => { if (event.key === "Enter") qs("#returnFind").click(); });
qs("#checkButton").addEventListener("click", () => {
  const code = qs("#checkCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showToast("Zadejte platný šestimístný kód místenky.");
  window.location.href = `status.html?code=${encodeURIComponent(code)}`;
});
qs("#checkCode").addEventListener("keydown", (event) => { if (event.key === "Enter") qs("#checkButton").click(); });
qs("#loginButton").addEventListener("click", () => showToast("Přihlášení bude dostupné v další verzi pilotu."));

// ---------- start ----------
(async function init() {
  qs("#year").textContent = new Date().getFullYear();
  try {
    config = await loadConfig();
  } catch (error) {
    qs("#appError").textContent = error.message;
    qs("#appError").classList.remove("hidden");
    return;
  }
  applyBranding(config);
  renderContact();
  revir = selectedRevir(config);
  if (!revir) return renderPicker();
  qs("#revirContent").classList.remove("hidden");
  renderRevir();
  renderDates();
  loadWeather();
  const target = window.location.hash && window.location.hash.length > 1 ? document.querySelector(window.location.hash) : null;
  if (target) window.setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
})();
