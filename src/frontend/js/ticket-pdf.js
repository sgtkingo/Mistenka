// PDF místenky bez externích knihoven: místenka se vykreslí na plátno (systémové písmo → plná česká diakritika),
// vloží se do jednostránkového PDF (A4) jako obrázek JPEG a odkaz na kontrolu zůstane klikací.
// Nad obrázkem je neviditelná textová vrstva (jako u PDF s OCR): každý text na stejném místě a se stejnými
// šířkami znaků, takže údaje jdou označit, kopírovat i vyhledat (Unicode přes ToUnicode, vč. diakritiky).
(function () {
  const W = 1240; // A4 při ~150 DPI
  const H = 1754;
  const PT = 595 / W; // převod px plátna → body PDF
  const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const COL = { brand: "#0075de", brandDark: "#005bab", ink: "#252321", muted: "#6d6862", line: "#e6e4e0", soft: "#f6f5f4", okBg: "#eef8f1", ok: "#17803f" };
  // Razítko pro místenky, které už neplatí pro lov.
  const STAMPS = { expired_returned: ["ODEVZDANÁ", "#17803f"], seized: ["ZADRŽENÁ", "#b52f27"], cancelled: ["ZRUŠENÁ", "#b52f27"], closed_unreturned: ["NEODEVZDANÁ", "#b52f27"], payment_expired: ["NEZAPLACENÁ", "#b52f27"] };

  function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }
  let textRuns = []; // textová vrstva PDF: { chars: [[znak, šířka px]], x, y, size, m (transformace plátna) }
  function text(ctx, value, x, y, { size = 24, weight = 400, color = COL.ink, align = "left", spacing = 0 } = {}) {
    const str = String(value ?? "");
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(str, x, y);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    if (!str.trim()) return;
    // Šířky znaků pro textovou vrstvu (stejné písmo a proložení jako na plátně).
    const chars = Array.from(str).map((ch) => [ch, ctx.measureText(ch).width + spacing]);
    const width = chars.reduce((sum, [, w]) => sum + w, 0);
    const startX = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
    const t = ctx.getTransform();
    textRuns.push({ chars, x: startX, y, size, m: [t.a, t.b, t.c, t.d, t.e, t.f] });
  }
  // Zalomení textu do šířky; vrátí y pod posledním řádkem.
  function wrap(ctx, value, x, y, maxWidth, { size = 22, lineHeight = 1.45, color = COL.ink, weight = 400 } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const words = String(value).split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        text(ctx, line, x, y, { size, color, weight });
        y += size * lineHeight;
        line = word;
      } else line = test;
    }
    if (line) { text(ctx, line, x, y, { size, color, weight }); y += size * lineHeight; }
    return y;
  }
  function field(ctx, label, value, x, y, width) {
    text(ctx, label.toUpperCase(), x, y, { size: 17, weight: 600, color: COL.muted, spacing: 1.5 });
    return wrap(ctx, value, x, y + 36, width, { size: 27, weight: 600 });
  }

  function drawTicket({ ticket, revir, organization, checkUrl, hours }) {
    const { czDate, qrMatrix, subdistrictLabel, subdistrictTitle, czk } = window.Mistenka;
    textRuns = [];
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    // Hlavička
    const M = 80;
    roundRect(ctx, M, 70, W - 2 * M, 120, 22, COL.brand);
    roundRect(ctx, M + 34, 104, 52, 52, 12, "#fff");
    text(ctx, "⌁", M + 60, 145, { size: 38, weight: 700, color: COL.brand, align: "center" });
    text(ctx, "Místenka", M + 106, 142, { size: 38, weight: 700, color: "#fff" });
    text(ctx, organization.shortName, W - M - 34, 128, { size: 22, color: "#d6e9fd", align: "right" });
    text(ctx, "rybářská místenka", W - M - 34, 158, { size: 20, color: "#d6e9fd", align: "right" });

    // Revír
    let y = 268;
    text(ctx, [revir.name, revir.number].filter(Boolean).join(" · "), M, y, { size: 40, weight: 700 });
    const sub = subdistrictLabel(revir, ticket);
    const kind = [revir.kind, revir.union].filter(Boolean).join(" · ");
    y += 40;
    if (sub || kind) text(ctx, [sub && `${subdistrictTitle(revir, ticket)} ${sub}`, kind].filter(Boolean).join("  ·  "), M, y, { size: 22, color: COL.muted });

    // Kód + QR
    y = 350;
    const qrSize = 330;
    const qrX = W - M - qrSize;
    roundRect(ctx, M, y, qrX - M - 40, qrSize, 20, COL.okBg);
    text(ctx, "KÓD MÍSTENKY", M + 36, y + 62, { size: 19, weight: 600, color: COL.muted, spacing: 2 });
    text(ctx, ticket.code, M + 36, y + 160, { size: 96, weight: 700, color: COL.ok, spacing: 14 });
    text(ctx, czDate(ticket.date, { weekday: true }), M + 36, y + 232, { size: 32, weight: 600 });
    if (hours) text(ctx, `Doba lovu ${hours}`, M + 36, y + 280, { size: 24, color: COL.muted });

    roundRect(ctx, qrX, y, qrSize, qrSize, 20, "#fff", COL.line);
    const qr = qrMatrix(checkUrl);
    const cell = (qrSize - 40) / qr.size;
    ctx.fillStyle = "#000";
    for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.isDark(r, c)) ctx.fillRect(qrX + 20 + c * cell, y + 20 + r * cell, Math.ceil(cell), Math.ceil(cell));
    text(ctx, "Naskenujte pro kontrolu místenky", qrX + qrSize / 2, y + qrSize + 34, { size: 18, color: COL.muted, align: "center" });

    // Údaje
    y = 790;
    ctx.fillStyle = COL.line;
    ctx.fillRect(M, y - 50, W - 2 * M, 2);
    const colW = (W - 2 * M - 40) / 2;
    const left = field(ctx, "Rybář", `${ticket.firstName} ${ticket.lastName}`, M, y, colW);
    const right = field(ctx, "Číslo členské legitimace", ticket.memberId, M + colW + 40, y, colW);
    y = Math.max(left, right) + 34;
    const price = ticket.voucherUsed ? "dárkový poukaz" : czk(ticket.priceHalere);
    const issued = ticket.issuedAt ? new Date(ticket.issuedAt).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const left2 = field(ctx, "Cena", price, M, y, colW);
    const right2 = field(ctx, "Vystaveno", issued, M + colW + 40, y, colW);
    y = Math.max(left2, right2) + 40;

    // Než vyrazíte / po lovu
    ctx.fillStyle = COL.line;
    ctx.fillRect(M, y - 20, W - 2 * M, 2);
    y += 34;
    text(ctx, "Než vyrazíte", M, y, { size: 26, weight: 700 });
    y += 44;
    const checks = ["Mějte u sebe platný rybářský lístek a povolenku – místenka je nenahrazuje.", "Místenka platí jen pro uvedený den a revír" + (sub ? ` (${subdistrictTitle(revir, ticket).toLowerCase()} ${sub}).` : "."), "Každý úlovek ihned zapište do povolenky."];
    for (const item of checks) {
      text(ctx, "✓", M, y, { size: 24, weight: 700, color: COL.ok });
      y = wrap(ctx, item, M + 38, y, W - 2 * M - 38, { size: 22 }) + 6;
    }
    y += 18;
    text(ctx, "Po skončení lovu", M, y, { size: 26, weight: 700 });
    y += 44;
    y = wrap(ctx, `Místenku odevzdejte ještě týž den: na webu zvolte „Vrátit místenku“, načtěte tento QR kód nebo zadejte kód ${ticket.code} a zapište úlovky (nebo „bez úlovku“). Opožděně ji lze odevzdat do ${revir.lateReturnDays} dnů, pak se uzavře jako neodevzdaná.`, M, y, W - 2 * M, { size: 22 });

    // Patička
    roundRect(ctx, M, H - 190, W - 2 * M, 110, 16, COL.soft);
    text(ctx, organization.name || organization.shortName, M + 30, H - 145, { size: 19, weight: 600 });
    const contact = [organization.contact?.email, organization.contact?.phone].filter(Boolean).join(" · ");
    if (contact) text(ctx, contact, M + 30, H - 117, { size: 18, color: COL.muted });
    text(ctx, checkUrl, M + 30, H - 92, { size: 16, color: COL.brand });

    // Razítko stavu (místenka už neplatí pro lov)
    const stamp = STAMPS[ticket.status];
    if (stamp) {
      // Přes blok s kódem, ne přes QR (ten musí zůstat čitelný).
      ctx.save();
      ctx.translate(M + (qrX - M - 40) / 2, 350 + qrSize / 2);
      ctx.rotate(-0.14);
      ctx.globalAlpha = 0.88;
      // Písmo se zmenší, aby se razítko vešlo do bloku s kódem.
      const maxW = qrX - M - 100;
      const measure = (px) => { ctx.font = `800 ${px}px ${FONT}`; if ("letterSpacing" in ctx) ctx.letterSpacing = "4px"; const w = ctx.measureText(stamp[0]).width; if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"; return w; };
      const size = Math.min(72, Math.floor(72 * maxW / (measure(72) + 60)));
      const tw = measure(size) + 60;
      roundRect(ctx, -tw / 2, -size * 1.05, tw, size * 1.5, 14, "rgba(255,255,255,.75)");
      ctx.strokeStyle = stamp[1];
      ctx.lineWidth = 7;
      ctx.strokeRect(-tw / 2, -size * 1.05, tw, size * 1.5);
      text(ctx, stamp[0], 0, size * 0.32, { size, weight: 800, color: stamp[1], align: "center", spacing: 4 });
      ctx.restore();
    }
    // Klikací oblasti v PDF (QR a odkaz) v pixelech plátna.
    return { canvas, runs: textRuns, links: [{ x: qrX, y, w: qrSize, h: qrSize, url: checkUrl, top: 350 }, { x: M + 30, y: H - 110, w: W - 2 * M - 60, h: 26, url: checkUrl }] };
  }

  // Neviditelná textová vrstva: písmo s vlastním 8bitovým kódováním (kód → znak přes ToUnicode), text režim 3
  // (nevykresluje se), polohy a šířky znaků podle plátna (TJ s posunem každého znaku na změřenou šířku).
  function textLayer(runs) {
    const codes = new Map();
    for (const run of runs) for (const [ch] of run.chars) if (!codes.has(ch) && codes.size < 254) codes.set(ch, codes.size + 1);
    const hex = (n, len = 2) => n.toString(16).toUpperCase().padStart(len, "0");
    const utf16 = (ch) => Array.from(ch).map((c) => { const cp = c.codePointAt(0); if (cp < 0x10000) return hex(cp, 4); const v = cp - 0x10000; return hex(0xd800 + (v >> 10), 4) + hex(0xdc00 + (v & 0x3ff), 4); }).join("");
    const entries = [...codes].map(([ch, code]) => `<${hex(code)}> <${utf16(ch)}>`);
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Mistenka-UCS def /CMapType 2 def\n1 begincodespacerange <01> <FF> endcodespacerange\n";
    for (let i = 0; i < entries.length; i += 100) cmap += `${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join("\n")}\nendbfchar\n`;
    cmap += "endcmap CMapName currentdict /CMap defineresource pop end end";
    const n = Math.max(1, codes.size);
    const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 1 /LastChar ${n} /Widths [${Array(n).fill(500).join(" ")}] /Encoding << /Type /Encoding /Differences [1 ${Array.from({ length: n }, (_, i) => `/g${i + 1}`).join(" ")}] >> /ToUnicode TOUNICODE >>`;
    const f = (v) => (Math.round(v * 1000) / 1000).toString();
    let content = "BT 3 Tr\n";
    for (const run of runs) {
      const [a, b, c, d, e, g] = run.m;
      const px = (a * run.x + c * run.y + e) * PT;
      const py = 842 - (b * run.x + d * run.y + g) * PT;
      // Směr textu z plátna (osa y dolů) do PDF (osa y nahoru).
      content += `/F1 ${f(run.size * PT)} Tf ${f(a)} ${f(-b)} ${f(-c)} ${f(d)} ${f(px)} ${f(py)} Tm [`;
      for (const [ch, w] of run.chars) {
        const code = codes.get(ch);
        if (!code) continue;
        content += `<${hex(code)}>${f(500 - (w / run.size) * 1000)}`;
      }
      content += "] TJ\n";
    }
    content += "ET";
    return { font, cmap, content };
  }

  // Jednostránkové PDF s obrázkem JPEG (DCTDecode), neviditelnou textovou vrstvou a odkazy.
  function buildPdf(jpegBytes, links, runs = []) {
    const enc = new TextEncoder();
    const parts = [];
    let length = 0;
    const offsets = [];
    const push = (part) => { const bytes = typeof part === "string" ? enc.encode(part) : part; parts.push(bytes); length += bytes.length; };
    const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };
    const layer = textLayer(runs);
    const first = 8; // 6 = písmo, 7 = ToUnicode, od 8 odkazy
    const annots = links.map((_, i) => `${first + i} 0 R`).join(" ");
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R /Annots [${annots}] >>`);
    offsets[4] = length;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
    push(jpegBytes);
    push("\nendstream\nendobj\n");
    const draw = `q 595 0 0 842 0 0 cm /Im1 Do Q\n${layer.content}`;
    obj(5, `<< /Length ${enc.encode(draw).length} >>\nstream\n${draw}\nendstream`);
    obj(6, layer.font.replace("TOUNICODE", "7 0 R"));
    obj(7, `<< /Length ${enc.encode(layer.cmap).length} >>\nstream\n${layer.cmap}\nendstream`);
    links.forEach((link, i) => {
      const x1 = (link.x * PT).toFixed(1);
      const y1 = (842 - (link.top ?? link.y) * PT - link.h * PT).toFixed(1);
      const x2 = ((link.x + link.w) * PT).toFixed(1);
      const y2 = (842 - (link.top ?? link.y) * PT).toFixed(1);
      obj(first + i, `<< /Type /Annot /Subtype /Link /Rect [${x1} ${y1} ${x2} ${y2}] /Border [0 0 0] /A << /S /URI /URI (${link.url.replace(/([\\()])/g, "\\$1")}) >> >>`);
    });
    const count = first + links.length;
    const xref = length;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: "application/pdf" });
  }

  async function download(options) {
    if (document.fonts?.ready) await document.fonts.ready;
    const { canvas, links, runs } = drawTicket(options);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    const pdf = buildPdf(new Uint8Array(await jpeg.arrayBuffer()), links, runs);
    const url = URL.createObjectURL(pdf);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mistenka-${options.ticket.code}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  window.MistenkaPdf = { download, drawTicket, buildPdf };
})();
