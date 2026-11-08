const qs = (selector) => document.querySelector(selector);
const purchase = JSON.parse(localStorage.getItem("mistenkaPurchase") || "null");
let attempt = 0;
let issuedTicket = null;
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

if (!purchase) {
  window.location.href = "/";
} else {
  qs("#paymentDate").textContent = purchase.date;
  qs("#paymentPerson").textContent = `${purchase.firstName} ${purchase.lastName}`;
}

function renderTicket(ticket) {
  issuedTicket = ticket;
  qs("#ticketCard").innerHTML = `<div class="ticket-top"><span class="section-kicker">Petrůvka 1 A · 471 115</span><span class="ticket-status">● Aktivní</span></div><div class="ticket-code">${ticket.code}</div><div class="ticket-details"><span><small>Rybář</small><b>${ticket.firstName} ${ticket.lastName}</b></span><span><small>Datum lovu</small><b>${ticket.date}</b></span><span><small>Číslo lístku</small><b>${ticket.license}</b></span></div><div class="ticket-qr"><div class="fake-qr"><span></span></div><small>Kód pro kontrolu místenky</small></div>`;
}
const pdfText = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "").replace(/([\\()])/g, "\\$1");
function downloadTicketPdf() {
  if (!issuedTicket) return;
  const content = [];
  const text = (value, x, y, size, color = "0.15 0.14 0.13") => {
    content.push(`${color} rg`, "BT", `/F1 ${size} Tf`, `${x} ${y} Td`, `(${pdfText(value)}) Tj`, "ET");
  };
  const rect = (x, y, width, height, color, stroke = false) => {
    content.push(`${color} ${stroke ? "RG" : "rg"}`, `${x} ${y} ${width} ${height} re`, `${stroke ? "S" : "f"}`);
  };
  rect(0, 0, 595, 842, "0.97 0.98 0.99");
  rect(42, 48, 511, 746, "1 1 1");
  rect(42, 730, 511, 64, "0.02 0.32 0.58");
  rect(64, 744, 38, 38, "1 1 1");
  text("CRS", 67, 757, 11, "0.02 0.32 0.58");
  text("MISTENKA", 116, 762, 20, "1 1 1");
  text("RYBARI A MORAVSKOSLEZSKY US", 116, 745, 8, "0.82 0.91 0.97");
  text("PETRUVKA 1 A  |  471 115", 68, 700, 11, "0.02 0.32 0.58");
  text("DIGITALNI RYBARSKA MISTENKA", 68, 680, 8, "0.42 0.45 0.48");
  rect(68, 602, 285, 58, "0.95 0.98 1");
  text("KOD MISTENKY", 82, 643, 8, "0.42 0.45 0.48");
  text(issuedTicket.code, 82, 617, 25, "0.02 0.32 0.58");
  rect(392, 583, 112, 112, "1 1 1", true);
  rect(400, 591, 18, 18, "0 0 0");
  rect(478, 591, 18, 18, "0 0 0");
  rect(400, 669, 18, 18, "0 0 0");
  rect(430, 620, 10, 10, "0 0 0");
  rect(448, 638, 10, 10, "0 0 0");
  rect(470, 617, 9, 9, "0 0 0");
  rect(435, 596, 8, 8, "0 0 0");
  text("QR PLACEHOLDER", 408, 570, 7, "0.42 0.45 0.48");
  text("RYBAR", 68, 548, 8, "0.42 0.45 0.48");
  text(`${issuedTicket.firstName} ${issuedTicket.lastName}`, 68, 528, 13);
  text("DATUM LOVU", 68, 490, 8, "0.42 0.45 0.48");
  text(issuedTicket.date, 68, 470, 13);
  text("RYBARSKY LISTEK", 300, 490, 8, "0.42 0.45 0.48");
  text(issuedTicket.license, 300, 470, 11);
  rect(68, 425, 436, 1, "0.86 0.88 0.9");
  text("PRAVIDLA LOVU", 68, 395, 11, "0.02 0.32 0.58");
  text("- Mistenka plati pouze pro uvedene datum lovu.", 78, 372, 9);
  text("- Odevzdejte ji ihned po ukonceni lovu v danem dni.", 78, 354, 9);
  text("- Pozdejsi odevzdani je mozne, ale bude oznaceno jako opozdene.", 78, 336, 9);
  text("- Kazdy ulovek ihned zapisujte do povolenky.", 78, 318, 9);
  text("Povinna vybava: podberak, mira, pean / vyprostovac.", 78, 300, 9);
  rect(68, 270, 436, 1, "0.86 0.88 0.9");
  text("Mistenka nenahrazuje rybarsky listek ani povolenku.", 68, 242, 9, "0.42 0.45 0.48");
  text("Vystaveno elektronicky | Demo aplikace Mistenka", 68, 76, 8, "0.42 0.45 0.48");
  text("CRS  |  Petrůvka 1 A  |  mistenka.example", 68, 61, 8, "0.42 0.45 0.48");
  const contentString = content.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${contentString.length} >>\nstream\n${contentString}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `mistenka-${issuedTicket.code}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
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
    qs("#paymentHeading").classList.add("hidden");
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
  qs("#paymentHeading").classList.add("hidden");
  qs("#paymentKicker").textContent = "Objednávka zrušena";
  qs("#paymentTitle").textContent = "Platba nebyla dokončena";
  qs("#paymentStep").textContent = "Zrušeno";
});
qs("#downloadTicket").addEventListener("click", downloadTicketPdf);
qs("#printTicket").addEventListener("click", () => window.print());
