// Jednostránkové PDF místenky bez externích knihoven (písmo Helvetica, text bez diakritiky).
(function () {
  const pdfText = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").replace(/([\\()])/g, "\\$1");

  function download({ ticket, revir, organization, checkUrl, hours }) {
    const { czDate, qrMatrix } = window.Mistenka;
    const content = [];
    const text = (value, x, y, size, color = "0.15 0.14 0.13") => content.push(`${color} rg`, "BT", `/F1 ${size} Tf`, `${x} ${y} Td`, `(${pdfText(value)}) Tj`, "ET");
    const rect = (x, y, w, h, color, stroke = false) => content.push(`${color} ${stroke ? "RG" : "rg"}`, `${x} ${y} ${w} ${h} re`, stroke ? "S" : "f");
    const muted = "0.42 0.45 0.48";
    const brand = "0.02 0.32 0.58";

    rect(0, 0, 595, 842, "0.97 0.98 0.99");
    rect(42, 48, 511, 746, "1 1 1");
    rect(42, 730, 511, 64, brand);
    text("MISTENKA", 68, 762, 20, "1 1 1");
    text(organization.shortName, 68, 745, 9, "0.82 0.91 0.97");
    const sub = window.Mistenka.subdistrictLabel(revir);
    text(`${revir.name}${revir.number ? `  |  ${revir.number}` : ""}${sub ? `  |  ${(revir.ticketSubdistricts || []).length > 1 ? "podreviry" : "podrevir"} ${sub}` : ""}`, 68, 700, 11, brand);
    text("DIGITALNI RYBARSKA MISTENKA", 68, 680, 8, muted);
    rect(68, 602, 285, 58, "0.95 0.98 1");
    text("KOD MISTENKY", 82, 643, 8, muted);
    text(ticket.code, 82, 617, 25, brand);

    // QR kód s odkazem na kontrolu místenky.
    const qr = qrMatrix(checkUrl);
    const box = 112;
    const cell = box / (qr.size + 4);
    const left = 392;
    const top = 695;
    rect(left, top - box, box, box, "1 1 1");
    for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) {
      if (qr.isDark(row, col)) rect((left + (col + 2) * cell).toFixed(2), (top - (row + 3) * cell).toFixed(2), cell.toFixed(2), cell.toFixed(2), "0 0 0");
    }
    text("Kontrola mistenky", 410, 570, 7, muted);

    text("RYBAR", 68, 548, 8, muted);
    text(`${ticket.firstName} ${ticket.lastName}`, 68, 528, 13);
    text("DATUM LOVU", 68, 490, 8, muted);
    text(czDate(ticket.date, { weekday: true }), 68, 470, 13);
    text("CISLO CLENSKE LEGITIMACE", 330, 490, 8, muted);
    text(ticket.memberId, 330, 470, 11);
    rect(68, 425, 436, 1, "0.86 0.88 0.9");
    text("PRAVIDLA LOVU", 68, 395, 11, brand);
    const rules = ["Mistenka plati pouze pro uvedene datum lovu a revir."];
    if (hours) rules.push(`Doba lovu v tento den: ${hours}.`);
    rules.push("Odevzdejte ji ihned po ukonceni lovu v danem dni.", `Pozdejsi odevzdani do ${revir.lateReturnDays} dnu bude oznaceno jako opozdene, pak se mistenka uzavre.`, "Kazdy ulovek ihned zapisujte do povolenky.");
    rules.forEach((rule, index) => text(`- ${rule}`, 78, 372 - index * 18, 9));
    rect(68, 270, 436, 1, "0.86 0.88 0.9");
    text("Mistenka nenahrazuje rybarsky listek ani povolenku.", 68, 242, 9, muted);
    text(`Vystaveno elektronicky | ${organization.shortName}`, 68, 76, 8, muted);
    text(checkUrl, 68, 61, 7, muted);

    const stream = content.join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `mistenka-${ticket.code}.pdf`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.MistenkaPdf = { download };
})();
