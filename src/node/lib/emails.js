"use strict";
// Šablony e-mailů. Ve WordPressu budou stejné texty odesílány přes wp_mail().
const fs = require("node:fs");
const { ticketSubdistrictLabel, subdistrictName, fishingPlace, gpsText, mapyUrl } = require("./config");
// Podrevír místenky (vybraný při nákupu), u starších místenek podrevíry revíru.
const ticketSub = (ticket, revir) => (ticket.subdistrict ? { title: "Podrevír", label: subdistrictName(revir, ticket.subdistrict) } : ticketSubdistrictLabel(revir) ? { title: revir.ticketSubdistricts.length > 1 ? "Podrevíry" : "Podrevír", label: ticketSubdistrictLabel(revir) } : null);
const path = require("node:path");

const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const czDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d}. ${MONTHS[m - 1]} ${y}`; };
const czk = (halere) => `${(halere / 100).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;
const czDateTime = (iso) => new Date(iso).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------- vzhled e-mailů ----------
// Tabulkové rozvržení a inline styly – spolehlivé v Gmailu, Outlooku i mobilních klientech. Barvy jako aplikace.
// „Místo“ s neviditelným znakem (U+200C): Gmail jinak slovo považuje za obec Místo a udělá z něj odkaz na Google Mapy.
const NO_PLACE_LINK = "Mí‌sto";
const C = { brand: "#0075de", brandDark: "#005bab", ink: "#252321", muted: "#6d6862", line: "#e6e4e0", soft: "#f6f5f4", okBg: "#eef8f1", ok: "#17803f", warnBg: "#fff6e5", warn: "#8a5a00" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Barva hlavičky podle typu zprávy: info modrá, success zelená (vystaveno, uloženo),
// warning oranžová (upozornění, je potřeba něco udělat), danger červená (zrušeno, zadrženo, blokace).
const TONES = { info: ["#0075de", "#cfe5fb"], success: ["#1a8245", "#d3f0dc"], warning: ["#c2610c", "#fde3c8"], danger: ["#c8302a", "#f9d2cf"] };
// Testovací režim nebo falešná banka: každý e-mail nese varování, předmět začíná „[TEST]“.
const TEST_NOTE = "Testovací verze Místenky – platby se jen simulují a vystavené místenky neopravňují k lovu.";
const testMode = (config) => Boolean(config.payment?.testMode) || config.payment?.provider === "fake";
// layout(config, typ, nadpis, obsah, patička, { preheader }) – preheader = náhled v seznamu zpráv.
function layout(config, tone, title, rowsHtml, footerHtml = "", { preheader = "" } = {}) {
  const [toneBg, toneSub] = TONES[tone] || TONES.info;
  const org = config.organization;
  const contact = [org.contact?.email && `<a href="mailto:${esc(org.contact.email)}" style="color:${C.muted}">${esc(org.contact.email)}</a>`, org.contact?.phone && esc(org.contact.phone)].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.soft};font-family:${FONT};color:${C.ink};-webkit-text-size-adjust:100%">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${esc(preheader || title)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:${toneBg};border-radius:12px 12px 0 0;padding:18px 24px">
  <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:7px;background:#fff;color:${toneBg};font-weight:700;font-size:18px;vertical-align:middle">⌁</span>
  <span style="color:#fff;font-size:18px;font-weight:700;vertical-align:middle;margin-left:8px">Místenka</span>
  <span style="color:${toneSub};font-size:13px;vertical-align:middle;margin-left:8px">${esc(org.shortName)}</span>
</td></tr>
<tr><td style="background:#fff;border:1px solid ${C.line};border-top:0;border-radius:0 0 12px 12px;padding:28px 24px 24px">
  ${testMode(config) ? `<p style="margin:0 0 18px;padding:12px 14px;background:${C.warnBg};border:1px solid #f3d9a4;border-radius:8px;font-size:14px;color:${C.warn}"><b>${esc(TEST_NOTE)}</b></p>` : ""}
  <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:${C.ink}">${esc(title)}</h1>
  <div style="font-size:15px;line-height:1.55">${rowsHtml}${footerHtml}</div>
</td></tr>
<tr><td style="padding:16px 8px;color:${C.muted};font-size:12px;line-height:1.5;text-align:center">
  ${esc(org.name || org.shortName)}${contact ? `<br>${contact}` : ""}<br>Tato zpráva byla odeslána automaticky, neodpovídejte na ni.
</td></tr></table></td></tr></table></body></html>`;
}
const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:9px 12px 9px 0;color:${C.muted};border-bottom:1px solid ${C.line};width:42%;vertical-align:top">${esc(k)}</td><td style="padding:9px 0;font-weight:600;border-bottom:1px solid ${C.line}">${esc(v)}</td></tr>`).join("")}</table>`;
const button = (href, label, secondary = false) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="border-radius:8px;background:${secondary ? "#fff" : C.brand};${secondary ? `border:1px solid ${C.brand};` : ""}"><a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${secondary ? C.brand : "#fff"};text-decoration:none;border-radius:8px">${esc(label)}</a></td></tr></table>`;
// Zvýrazněný blok (kód místenky, částka, termín).
const highlight = (label, value, sub = "", tone = "brand") => {
  const bg = tone === "warn" ? C.warnBg : tone === "ok" ? C.okBg : "#eef6fe";
  const color = tone === "warn" ? C.warn : tone === "ok" ? C.ok : C.brandDark;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:${bg};border-radius:10px;padding:16px 18px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">${esc(label)}</div>
  <div style="font-size:28px;font-weight:700;letter-spacing:.12em;color:${color};margin-top:4px">${esc(value)}</div>${sub ? `<div style="font-size:14px;color:${C.ink};margin-top:4px">${esc(sub)}</div>` : ""}</td></tr></table>`;
};
const checklist = (items) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;font-size:14px">${items.map((item) => `<tr><td style="width:22px;vertical-align:top;color:${C.ok};font-weight:700;padding:3px 0">✓</td><td style="padding:3px 0">${esc(item)}</td></tr>`).join("")}</table>`;
// Mapa revíru (jen když je zakreslená): schematický náhled s odkazem na interaktivní mapu.
// Místo lovu (podrevír místenky, jinak celý revír) zvýrazněné s GPS a odkazem na interaktivní mapu
// (mapa jen jako odkaz – podklad Mapy.com se do e-mailu vkládat nesmí).
const placeBlock = (place, links) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:#eef6fe;border:2px solid ${C.brand};border-radius:10px;padding:14px 18px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">${NO_PLACE_LINK} lovu</div>
  <div style="font-size:20px;font-weight:700;color:${C.brandDark};margin-top:4px">${esc(place.title)}</div>
  ${place.gps ? `<div style="font-size:14px;margin-top:6px">GPS <a href="${esc(mapyUrl(place.gps))}" style="color:${C.brand};font-weight:600">${esc(gpsText(place.gps))}</a></div>` : ""}
  ${links.map ? `<div style="font-size:14px;margin-top:6px"><a href="${esc(links.map)}" style="color:${C.brand};font-weight:600">Interaktivní mapa revíru →</a> <span style="color:${C.muted}">hranice podrevírů, parkování, WC</span></div>` : ""}
</td></tr></table>`;
const placeText = (place, links) => [`Místo lovu: ${place.title}`, ...(place.gps ? [`GPS: ${gpsText(place.gps)} (${mapyUrl(place.gps)})`] : []), ...(links.map ? [`Mapa revíru: ${links.map}`] : [])];
const noteBox = (text) => `<p style="margin:0 0 16px;padding:12px 14px;background:${C.soft};border-radius:8px;font-size:13px;color:${C.muted}">${esc(text)}</p>`;
const textBlock = (lines) => lines.filter((line) => line !== null).join("\n");
// Doba lovu v den lovu podle revíru (fishingHours).
function huntingHours(revir, isoDate) {
  const month = Number(isoDate.slice(5, 7));
  const rule = (revir.fishingHours || []).find((item) => item.months.includes(month));
  return rule ? `${rule.from}–${rule.to}` : "";
}
const weekday = (iso) => ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"][new Date(`${iso}T12:00:00Z`).getUTCDay()];

function paymentInstructions(config, { ticket, revir, links }) {
  const sub = ticketSub(ticket, revir);
  const rows = [["Revír", revir.name], ...(sub ? [[sub.title, sub.label]] : []), ["Datum lovu", `${weekday(ticket.fishing_date)} ${czDate(ticket.fishing_date)}`], ["Číslo účtu", `${config.payment.accountNumber}/${config.payment.bankCode}`], ["Variabilní symbol", ticket.variable_symbol], ["Zaplaťte do", czDateTime(ticket.reserved_until)]];
  return {
    subject: `Místenka ${ticket.code} – pokyny k platbě`,
    html: layout(config, "info", "Dokončete platbu místenky", `<p style="margin:0 0 16px">${NO_PLACE_LINK} na revíru <b>${esc(revir.name)}</b> je pro vás rezervované. Místenku vystavíme hned po připsání platby a pošleme vám ji e-mailem.</p>
      ${highlight("K úhradě", czk(ticket.amount_due_halere), `VS ${ticket.variable_symbol}`)}${table(rows)}${button(links.payment, "Zobrazit QR platbu")}
      ${noteBox("Nejrychlejší je zaplatit načtením QR kódu v bankovní aplikaci – údaje se vyplní samy. Při ručním převodu nezapomeňte variabilní symbol.")}`, "", { preheader: `Zaplaťte ${czk(ticket.amount_due_halere)} do ${czDateTime(ticket.reserved_until)}, VS ${ticket.variable_symbol}` }),
    text: textBlock(["Dokončete platbu místenky.", `Částka: ${czk(ticket.amount_due_halere)}`, ...rows.map(([k, v]) => `${k}: ${v}`), `QR platba: ${links.payment}`])
  };
}

function ticketIssued(config, { ticket, revir, links }) {
  const sub = ticketSub(ticket, revir);
  const place = fishingPlace(revir, ticket.subdistrict);
  const hours = huntingHours(revir, ticket.fishing_date);
  const rows = [["Revír", [revir.name, revir.number].filter(Boolean).join(" · ")], ...(sub ? [[sub.title, sub.label]] : []), ["Datum lovu", `${weekday(ticket.fishing_date)} ${czDate(ticket.fishing_date)}`], ...(hours ? [["Doba lovu", hours]] : []), ["Rybář", `${ticket.first_name} ${ticket.last_name}`], ["Číslo členské legitimace", ticket.member_id]];
  return {
    subject: `Místenka ${ticket.code} – ${revir.name}, ${czDate(ticket.fishing_date)}`,
    html: layout(config, "success", "Vaše místenka je vystavena", `${highlight("Kód místenky", ticket.code, `${weekday(ticket.fishing_date)} ${czDate(ticket.fishing_date)} · ${revir.name}`, "ok")}${placeBlock(place, links)}${table(rows)}
      ${button(links.ticket, "Zobrazit místenku a QR kód")}
      <p style="margin:0 0 8px;font-weight:600">Než vyrazíte</p>${checklist(["Platný rybářský lístek a povolenka – místenka je nenahrazuje.", "Místenka v telefonu nebo vytištěná (QR kód pro kontrolu).", "Každou ponechanou rybu ihned zapište do povolenky."])}
      <p style="margin:0 0 8px;font-weight:600">Po skončení lovu</p><p style="margin:0 0 8px">Místenku odevzdejte ještě týž den a zapište ponechané ryby (nebo „žádná ponechaná ryba“). Opožděně ji lze odevzdat do ${esc(revir.lateReturnDays)} dnů, pak se uzavře jako neodevzdaná.</p>
      ${button(links.return, "Odevzdat místenku", true)}`, "", { preheader: `Kód ${ticket.code} · ${weekday(ticket.fishing_date)} ${czDate(ticket.fishing_date)} · ${revir.name}${hours ? ` · lov ${hours}` : ""}` }),
    text: textBlock(["Vaše místenka je vystavena.", `Kód místenky: ${ticket.code}`, ...placeText(place, links), ...rows.map(([k, v]) => `${k}: ${v}`), "Místenka nenahrazuje rybářský lístek ani povolenku.", `Místenka: ${links.ticket}`, `Odevzdání po lovu: ${links.return}`])
  };
}

function returnReminder(config, { ticket, revir, links, deadline }) {
  return {
    subject: `Místenka ${ticket.code} – nezapomeňte ji odevzdat`,
    html: layout(config, "warning", "Odevzdejte prosím místenku", `<p style="margin:0 0 16px">Lov na revíru <b>${esc(revir.name)}</b> dne ${esc(czDate(ticket.fishing_date))} skončil a místenka <b>${esc(ticket.code)}</b> ještě nebyla odevzdána.</p>
      ${highlight("Odevzdejte nejpozději", czDateTime(deadline), "Odevzdání po dni lovu se označí jako opožděné.", "warn")}${button(links.return, "Odevzdat místenku")}
      ${noteBox("Po této lhůtě se místenka automaticky uzavře jako neodevzdaná, bez úlovku. Pokud jste si nic neponechali, zvolte při odevzdání „Žádná ponechaná ryba“.")}`, "", { preheader: `Místenku ${ticket.code} odevzdejte do ${czDateTime(deadline)}` }),
    text: textBlock([`Místenka ${ticket.code} ještě nebyla odevzdána.`, `Odevzdání je možné do ${czDateTime(deadline)} (opožděně). Poté se místenka automaticky uzavře jako neodevzdaná, bez úlovku.`, `Odevzdat: ${links.return}`])
  };
}

function ticketClosed(config, { ticket, revir }) {
  const contact = config.organization.contact || {};
  const contactLine = [contact.email, contact.phone].filter(Boolean).join(", ");
  return {
    subject: `Místenka ${ticket.code} byla uzavřena jako neodevzdaná`,
    html: layout(config, "danger", "Místenka byla uzavřena jako neodevzdaná", `<p>Místenku <b>${esc(ticket.code)}</b> na revír ${esc(revir.name)} (den lovu ${esc(czDate(ticket.fishing_date))}) jste neodevzdali ani v prodloužené lhůtě. Byla proto automaticky uzavřena jako <b>neodevzdaná, bez zapsaného úlovku</b>.</p><p>Pokud jste na revíru něco ulovili nebo jde o omyl, kontaktujte prosím hospodáře${contactLine ? `: ${esc(contactLine)}` : ""}.</p>`),
    text: textBlock([`Místenka ${ticket.code} (${revir.name}, ${czDate(ticket.fishing_date)}) byla automaticky uzavřena jako neodevzdaná, bez zapsaného úlovku.`, `Pokud jde o omyl, kontaktujte hospodáře${contactLine ? `: ${contactLine}` : ""}.`])
  };
}

// ---------- zadržení místenky (B2) ----------
function ticketSeized(config, { ticket, revir, links, deadline }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Zadrženo", czDateTime(ticket.seized_at)], ["Důvod", ticket.seized_reason], ...(ticket.seized_place ? [[NO_PLACE_LINK, ticket.seized_place]] : [])];
  return {
    subject: `Místenka ${ticket.code} byla zadržena rybářskou stráží`,
    html: layout(config, "danger", "Místenka byla zadržena", `<p>Rybářská stráž zadržela vaši místenku. <b>Místenka od této chvíle neopravňuje k lovu.</b></p>${table(rows)}<p>Místenku musíte i tak odevzdat a zapsat všechny úlovky, nejpozději do <b>${esc(czDateTime(deadline))}</b>.</p>${button(links.return, "Odevzdat místenku")}`),
    text: textBlock(["Rybářská stráž zadržela vaši místenku. Místenka od této chvíle neopravňuje k lovu.", ...rows.map(([k, v]) => `${k}: ${v}`), `Místenku musíte i tak odevzdat s úlovky do ${czDateTime(deadline)}: ${links.return}`])
  };
}
function seizureNotice(config, { ticket, revir, links, wardenName }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Držitel", `${ticket.first_name} ${ticket.last_name}`], ["Č. legitimace", ticket.member_id], ["Porybný", wardenName], ["Zadrženo", czDateTime(ticket.seized_at)], ["Důvod", ticket.seized_reason], ...(ticket.seized_place ? [[NO_PLACE_LINK, ticket.seized_place]] : [])];
  return {
    subject: `Zadržená místenka ${ticket.code} – ${ticket.first_name} ${ticket.last_name}`,
    html: layout(config, "warning", "Porybný zadržel místenku", `<p>Pro informaci: místenka byla zadržena. Zadržení není potřeba potvrzovat.</p>${table(rows)}${button(links.status, "Stav místenky")}`),
    text: textBlock(["Porybný zadržel místenku (není potřeba potvrzovat).", ...rows.map(([k, v]) => `${k}: ${v}`), `Stav: ${links.status}`])
  };
}

// ---------- limity úlovků (B3) ----------
const PERIOD_LABEL = { day: "den", week: "týden", month: "měsíc" };
const limitLine = (l) => `${l.label}: ${l.count} ks za ${PERIOD_LABEL[l.period]} (limit ${l.maxCount} ks${l.period === "day" ? "" : `, ${czDate(l.from)} – ${czDate(l.to)}`})`;
function limitExceeded(config, { ticket, revir, links, limits }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Držitel", `${ticket.first_name} ${ticket.last_name}`], ["Č. legitimace", ticket.member_id]];
  return {
    subject: `Překročený limit úlovků – ${ticket.first_name} ${ticket.last_name} (${ticket.code})`,
    html: layout(config, "warning", "Překročený limit úlovků", `<p>Při odevzdání místenky byly podle místenek v Místence překročeny limity:</p><ul>${limits.map((l) => `<li>${esc(limitLine(l))}</li>`).join("")}</ul>${table(rows)}<p style="color:#5b6b64;font-size:13px">Místenka vidí jen úlovky ze svých místenek; limity platí na všech revírech svazu dohromady.</p>${button(links.status, "Stav místenky")}`),
    text: textBlock(["Překročené limity úlovků (podle místenek v Místence):", ...limits.map((l) => `- ${limitLine(l)}`), ...rows.map(([k, v]) => `${k}: ${v}`), `Stav: ${links.status}`])
  };
}
function memberBlocked(config, { ticket, block, limits }) {
  const until = block.until ? `do ${czDate(block.until)}` : "do odvolání";
  return {
    subject: "Místenka – nákup místenek je pozastaven",
    html: layout(config, "danger", "Nákup místenek je pozastaven", `<p>Nákup místenek na číslo legitimace <b>${esc(ticket.member_id)}</b> je pozastaven <b>${esc(until)}</b>.</p><p>Důvod: ${esc(block.reason)}</p>${limits?.length ? `<ul>${limits.map((l) => `<li>${esc(limitLine(l))}</li>`).join("")}</ul>` : ""}<p>Pokud jde o omyl, kontaktujte správce organizace${config.organization.contact?.email ? ` (${esc(config.organization.contact.email)})` : ""}.</p>`),
    text: textBlock([`Nákup místenek na číslo legitimace ${ticket.member_id} je pozastaven ${until}.`, `Důvod: ${block.reason}`, "Pokud jde o omyl, kontaktujte správce organizace."])
  };
}

// ---------- uzávěrka sezony (B6) ----------
function seasonReport(config, { name, revir, data, link }) {
  const s = data.summary;
  const rows = [["Revír", revir], ["Období", `${czDate(data.from)} – ${czDate(data.to)}`], ["Prodané místenky", String(s.sold)], ["Rybářů", String(s.anglers)], ["Tržby", czk(s.revenueHalere)], ["Odevzdané / neodevzdané", `${s.returned} / ${s.unreturned}`], ["Úlovky", `${data.catches.total} ks, ${data.catches.weightKg} kg`], ["Zarybnění", czk(data.stocking.costHalere)]];
  return {
    subject: `Uzávěrka – ${name}`,
    html: layout(config, "success", `Uzávěrka: ${name}`, `<p>Sezona skončila, uzávěrka je vytvořená a uložená v manažerském portálu.</p>${table(rows)}${button(link, "Otevřít uzávěrku")}`),
    text: textBlock([`Uzávěrka: ${name}`, ...rows.map(([k, v]) => `${k}: ${v}`), `Uzávěrka: ${link}`])
  };
}

// ---------- automatická obnova databáze (B7) ----------
function databaseAutoRestored(config, info) {
  const rows = [["Kdy", czDateTime(info.at)], ["Obnoveno ze zálohy", info.from], ["Problém", info.problem], ["Poškozený soubor", info.corruptFile]];
  return {
    subject: "Místenka – databáze byla automaticky obnovena ze zálohy",
    html: layout(config, "danger", "Databáze obnovena ze zálohy", `<p>Při startu serveru byla databáze poškozená a automaticky se obnovila z nejnovější platné zálohy. <b>Data vzniklá po této záloze chybí</b> – zkontrolujte poslední objednávky a platby (fronta plateb se z banky načte znovu).</p>${table(rows)}`),
    text: textBlock(["Databáze byla při startu poškozená a automaticky se obnovila ze zálohy. Data po záloze chybí – zkontrolujte poslední objednávky a platby.", ...rows.map(([k, v]) => `${k}: ${v}`)])
  };
}

// Testovací režim zapnut / vypnut (všem adminům, z provozu).
function testModeChanged(config, { enabled, actorName, payments, at, appUrl }) {
  const rows = [["Kdy", czDateTime(at)], ["Kdo", actorName], ...(enabled ? [["Platby v testu", payments === "fio" ? "ostré přes Fio (testovací variabilní symboly)" : "simulované"]] : [])];
  const intro = enabled
    ? "<p>Web teď běží nad <b>testovací databází</b>. Rybáři vidí testovací verzi – místenky z ní neopravňují k lovu a provozní místenky v ní nejsou (ani pro kontrolu porybným). Platby a e-maily provozu se zpracovávají dál.</p>"
    : "<p>Web zase běží nad <b>provozní databází</b>. Testovací data zůstávají odděleně pro příští test.</p>";
  return {
    subject: enabled ? "Místenka – zapnut testovací režim" : "Místenka – testovací režim vypnut",
    html: layout(config, enabled ? "warning" : "success", enabled ? "Zapnut testovací režim" : "Testovací režim vypnut", `${intro}${table(rows)}${button(`${appUrl}/manage.html#testing`, "Otevřít Testování")}`),
    text: textBlock([enabled ? "Web teď běží nad testovací databází – místenky z ní neopravňují k lovu, provozní místenky v ní nejsou." : "Web zase běží nad provozní databází.", ...rows.map(([k, v]) => `${k}: ${v}`), `${appUrl}/manage.html#testing`])
  };
}

// ---------- nastavení (B5) ----------
function paymentSettingsChanged(config, { actorName, before, after, at }) {
  const labels = { accountNumber: "Číslo účtu", bankCode: "Kód banky", iban: "IBAN", recipientName: "Příjemce", reservationMinutes: "Rezervace (min)", messagePrefix: "Zpráva pro příjemce", fioToken: "Token Fio (párování plateb)" };
  const rows = Object.keys(labels).filter((key) => String(before?.[key] ?? "") !== String(after?.[key] ?? "")).map((key) => [labels[key], `${before?.[key] ?? "—"} → ${after?.[key] ?? "—"}`]);
  return {
    subject: "Místenka – změněny platební údaje",
    html: layout(config, "warning", "Změněny platební údaje", `<p>${esc(actorName)} změnil(a) ${esc(czDateTime(at))} platební údaje Místenky. Nové objednávky se platí podle nových údajů.</p>${table(rows.length ? rows : [["Změna", "beze změny hodnot"]])}<p><b>Pokud o změně nevíte, okamžitě ji prověřte</b> – změna účtu je nejčastější podvod.</p>`),
    text: textBlock([`${actorName} změnil(a) ${czDateTime(at)} platební údaje Místenky.`, ...rows.map(([k, v]) => `${k}: ${v}`), "Pokud o změně nevíte, okamžitě ji prověřte."])
  };
}

// ---------- hlášení chyby (všem adminům) ----------
function bugReport(config, { report, link }) {
  const who = report.user ? `${report.user.name} <${report.user.email}>` : report.contactEmail ? `nepřihlášený, odpověď na ${report.contactEmail}` : "nepřihlášený uživatel";
  const rows = [["Hlášení", `#${report.id}`], ["Čas", czDateTime(report.createdAt)], ["Nahlásil", who], ["Stránka", report.url || "—"], ["Snímek obrazovky", report.hasScreenshot ? "ano" : "ne"]];
  return {
    subject: `Místenka – nahlášená chyba #${report.id}`,
    html: layout(config, "warning", "Nahlášená chyba", `<p style="margin:0 0 16px;white-space:pre-wrap">${esc(report.description)}</p>${table(rows)}${button(link, "Otevřít v portálu")}`),
    text: textBlock(["Nahlášená chyba", "", report.description, "", ...rows.map(([k, v]) => `${k}: ${v}`), `Portál: ${link}`])
  };
}

// ---------- zrušení správcem (B4) ----------
function ticketCancelled(config, { ticket, revir }) {
  const contact = [config.organization.contact?.email, config.organization.contact?.phone].filter(Boolean).join(", ");
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Důvod", ticket.cancel_reason]];
  return {
    subject: `Místenka ${ticket.code} byla zrušena`,
    html: layout(config, "danger", "Místenka byla zrušena", `<p>Správce organizace vaši místenku zrušil. <b>Místenka neplatí a neopravňuje k lovu.</b></p>${table(rows)}<p>Pokud máte nárok na vrácení peněz, vyřídí ho správce převodem${contact ? `; kontakt: ${esc(contact)}` : ""}.</p>`),
    text: textBlock(["Správce organizace vaši místenku zrušil. Místenka neplatí a neopravňuje k lovu.", ...rows.map(([k, v]) => `${k}: ${v}`), `Vrácení peněz vyřídí správce${contact ? ` (${contact})` : ""}.`])
  };
}

// ---------- oprava úlovků správcem ----------
const czNum = (n) => String(n).replace(".", ",");
const catchesText = (part) => (part.noCatch ? "nic neponecháno" : part.catches.map((c) => `${c.species} ${czNum(c.length)} cm${c.weight ? ` · ${czNum(c.weight)} kg` : ""}`).join(", ") || "—");
function catchesCorrected(config, { ticket, revir, reason, before, after }) {
  const contact = [config.organization.contact?.email, config.organization.contact?.phone].filter(Boolean).join(", ");
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Důvod opravy", reason], ["Původně", catchesText(before)], ["Nově", catchesText(after)]];
  return {
    subject: `Místenka ${ticket.code} – správce opravil úlovky`,
    html: layout(config, "info", "Správce opravil úlovky", `<p>Správce organizace opravil úlovky, které jste uvedl/a při odevzdání místenky. Místenka zůstává odevzdaná, nic dalšího dělat nemusíte.</p>${table(rows)}<p>Pokud s opravou nesouhlasíte, ozvěte se hospodáři${contact ? ` (${esc(contact)})` : ""}.</p>`),
    text: textBlock(["Správce organizace opravil úlovky, které jste uvedl/a při odevzdání místenky. Místenka zůstává odevzdaná.", ...rows.map(([k, v]) => `${k}: ${v}`), `Pokud s opravou nesouhlasíte, ozvěte se hospodáři${contact ? ` (${contact})` : ""}.`])
  };
}

// ---------- mimořádné uzavření (B4) ----------
function closureNotice(config, { ticket, revir, closure, links }) {
  const range = closure.dateFrom === closure.dateTo ? czDate(closure.dateFrom) : `${czDate(closure.dateFrom)} – ${czDate(closure.dateTo)}`;
  const contact = [config.organization.contact?.email, config.organization.contact?.phone].filter(Boolean).join(", ");
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Uzavřeno", range], ["Důvod", closure.reason]];
  return {
    subject: `Revír ${revir.name} je mimořádně uzavřen – místenka ${ticket.code}`,
    html: layout(config, "warning", "Revír je mimořádně uzavřen", `<p>Na den vaší místenky je revír mimořádně uzavřen. <b>Lovit v tento den nelze.</b></p>${table(rows)}<p>Ohledně vrácení peněz nebo náhradního termínu kontaktujte prosím správce${contact ? `: ${esc(contact)}` : ""}.</p>${button(links.status, "Stav místenky")}`),
    text: textBlock(["Revír je na den vaší místenky mimořádně uzavřen. Lovit v tento den nelze.", ...rows.map(([k, v]) => `${k}: ${v}`), `Vrácení peněz nebo náhradní termín: kontaktujte správce${contact ? ` (${contact})` : ""}.`])
  };
}

// ---------- žádost „Jsem porybný“ ----------
function wardenRequest(config, { name, email, memberId, note, links }) {
  const rows = [["Žadatel", name], ["E-mail", email], ["Č. legitimace", memberId || "—"], ...(note ? [["Poznámka", note]] : [])];
  return {
    subject: `Žádost o funkci porybného – ${name}`,
    html: layout(config, "info", "Žádost o funkci porybného", `<p>Uživatel Místenky uvádí, že je porybný (rybářská stráž MO nebo státní rybářská stráž), a žádá o funkci porybného v aplikaci. Po schválení uvidí při kontrole místenky plné údaje a bude moct místenku zadržet.</p>${table(rows)}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="padding-right:8px">${button(links.approve, "Schválit")}</td><td>${button(links.reject, "Zamítnout", true)}</td></tr></table>
      <p style="margin:0 0 16px"><a href="${esc(links.open)}" style="color:${C.brand}">Otevřít notifikace v portálu</a></p>
      ${noteBox("Tlačítka otevřou stránku s potvrzením rozhodnutí. Odkaz platí 7 dní a lze ho použít jen jednou; žádost můžete vyřídit i v portálu (Notifikace).")}`, "", { preheader: `${name} žádá o funkci porybného` }),
    text: textBlock(["Žádost o funkci porybného.", ...rows.map(([k, v]) => `${k}: ${v}`), `Schválit: ${links.approve}`, `Zamítnout: ${links.reject}`, `Portál: ${links.open}`])
  };
}
function wardenRequestDecided(config, { approved, note, link }) {
  const title = approved ? "Funkce porybného schválena" : "Žádost o funkci porybného zamítnuta";
  const intro = approved
    ? "Vaše žádost byla schválena. Po přihlášení uvidíte při kontrole místenky plné údaje rybáře a můžete místenku zadržet."
    : "Vaše žádost o funkci porybného nebyla schválena. Pokud jde o omyl, kontaktujte správce organizace.";
  return {
    subject: `Místenka – ${title.toLowerCase()}`,
    html: layout(config, (approved ? "success" : "info"), title, `<p>${esc(intro)}</p>${note ? table([["Poznámka správce", note]]) : ""}${approved ? button(link, "Otevřít Místenku") : ""}`),
    text: textBlock([title, intro, note ? `Poznámka správce: ${note}` : null, approved ? link : null])
  };
}

// ---------- účty ----------
const validFor = (minutes) => (minutes >= 120 ? `${Math.round(minutes / 60)} hodin` : `${minutes} minut`);
function accountMail(config, { subject, title, intro, link, label, minutes, outro }) {
  const note = minutes ? `Odkaz platí ${validFor(minutes)} a lze ho použít jen jednou.` : "";
  return {
    subject,
    html: layout(config, "info", title, `<p>${esc(intro)}</p>${link ? button(link, label) : ""}${note ? `<p style="color:#5b6b64;font-size:13px">${esc(note)}</p>` : ""}<p style="color:#5b6b64;font-size:13px">${esc(outro || "Pokud jste o nic nežádali, zprávu ignorujte.")}</p>`),
    text: textBlock([title, intro, link ? `${label}: ${link}` : null, note || null, outro || "Pokud jste o nic nežádali, zprávu ignorujte."])
  };
}
const accountVerify = (config, { link, minutes }) => accountMail(config, { subject: "Místenka – potvrďte registraci", title: "Potvrďte svůj e-mail", intro: "Děkujeme za registraci. Účet aktivujete kliknutím na tlačítko níže.", link, label: "Potvrdit e-mail", minutes });
const accountExists = (config, { link }) => accountMail(config, { subject: "Místenka – účet už existuje", title: "Účet s tímto e-mailem už máte", intro: "Někdo (pravděpodobně vy) se pokusil znovu zaregistrovat s tímto e-mailem. Přihlaste se, případně si nechte poslat odkaz pro přihlášení nebo obnovu hesla.", link, label: "Přihlásit se" });
const magicLink = (config, { link, minutes }) => accountMail(config, { subject: "Místenka – odkaz pro přihlášení", title: "Přihlášení do Místenky", intro: "Kliknutím na tlačítko se přihlásíte bez hesla.", link, label: "Přihlásit se", minutes });
const passwordReset = (config, { link, minutes }) => accountMail(config, { subject: "Místenka – obnova hesla", title: "Nastavte si nové heslo", intro: "Obdrželi jsme žádost o obnovu hesla k vašemu účtu.", link, label: "Nastavit nové heslo", minutes });
const emailChange = (config, { link, minutes }) => accountMail(config, { subject: "Místenka – potvrďte nový e-mail", title: "Potvrďte změnu e-mailu", intro: "Tuto adresu jste zadali jako nový e-mail svého účtu. Změna se projeví po potvrzení.", link, label: "Potvrdit nový e-mail", minutes });
const staffInvite = (config, { link, minutes, roleLabel }) => accountMail(config, { subject: `Místenka – pozvánka do správy (${roleLabel})`, title: "Pozvánka do správy Místenky", intro: `Byli jste pozváni jako ${roleLabel} organizace ${config.organization.shortName}. Kliknutím na tlačítko si nastavíte heslo a přihlásíte se.`, link, label: "Nastavit heslo", minutes, outro: "Pokud pozvánku nečekáte, zprávu ignorujte – bez nastavení hesla se účet nepoužije." });
const accountDeleted = (config) => accountMail(config, { subject: "Místenka – účet byl smazán", title: "Váš účet byl smazán", intro: "Účet a jeho přihlašovací údaje jsme smazali. Vystavené místenky uchováváme po dobu stanovenou pro evidenci, už ale nejsou spojené s účtem.", outro: "Pokud jste účet nemazali vy, kontaktujte prosím organizaci." });

// Vývojové doručení: e-maily se ukládají jako soubory do data/outbox/ (i ty, které by šly přes SMTP účet).
function createFileMailer(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    delivery: "file",
    async send({ id, to, subject, html, text, from, account }) {
      const base = path.join(dir, `${String(id).padStart(5, "0")}`);
      const sender = from?.email ? `${from.name ? `${from.name} ` : ""}<${from.email}>` : "(výchozí)";
      fs.writeFileSync(`${base}.html`, html);
      fs.writeFileSync(`${base}.txt`, `From: ${sender}${account ? ` · přes ${account.label} (${account.host}:${account.port})` : ""}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
      console.log(`[e-mail] ${to} · ${subject} → ${base}.html`);
    }
  };
}

const TEMPLATES = { bugReport, paymentInstructions, ticketIssued, returnReminder, ticketClosed, ticketSeized, seizureNotice, limitExceeded, memberBlocked, closureNotice, ticketCancelled, catchesCorrected, paymentSettingsChanged, seasonReport, databaseAutoRestored, testModeChanged, accountVerify, accountExists, magicLink, passwordReset, emailChange, staffInvite, accountDeleted, wardenRequest, wardenRequestDecided };
// V testovacím režimu doplní „[TEST]“ do předmětu a varování do textové verze (HTML ho má z layoutu).
const withTestNote = (fn) => (config, ...args) => {
  const mail = fn(config, ...args);
  return testMode(config) ? { ...mail, subject: `[TEST] ${mail.subject}`, text: `${TEST_NOTE}\n\n${mail.text}` } : mail;
};
module.exports = { ...Object.fromEntries(Object.entries(TEMPLATES).map(([name, fn]) => [name, withTestNote(fn)])), createFileMailer, czDate };
