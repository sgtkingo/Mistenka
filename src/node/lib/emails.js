"use strict";
// Šablony e-mailů. Ve WordPressu budou stejné texty odesílány přes wp_mail().
const fs = require("node:fs");
const { ticketSubdistrictLabel } = require("./config");
const path = require("node:path");

const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const czDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d}. ${MONTHS[m - 1]} ${y}`; };
const czk = (halere) => `${(halere / 100).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;
const czDateTime = (iso) => new Date(iso).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

function layout(config, title, rowsHtml, footerHtml = "") {
  const org = config.organization;
  return `<!doctype html><html lang="cs"><body style="margin:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1d2a25">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #d9e0dc;border-radius:10px;padding:24px">
<p style="margin:0 0 4px;color:#5b6b64;font-size:13px">${esc(org.shortName)} · Místenka</p>
<h1 style="margin:0 0 16px;font-size:22px">${esc(title)}</h1>${rowsHtml}${footerHtml}
</div><p style="color:#7a8781;font-size:12px;margin:16px 0 0">Tato zpráva byla odeslána automaticky, neodpovídejte na ni.${org.contact?.email ? ` Kontakt: ${esc(org.contact.email)}` : ""}</p></div></body></html>`;
}
const table = (rows) => `<table style="width:100%;border-collapse:collapse;margin:0 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5b6b64;width:45%">${esc(k)}</td><td style="padding:6px 0;font-weight:bold">${esc(v)}</td></tr>`).join("")}</table>`;
const button = (href, label) => `<p style="margin:16px 0"><a href="${esc(href)}" style="display:inline-block;background:#1f6f4a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${esc(label)}</a></p>`;
const textBlock = (lines) => lines.filter((line) => line !== null).join("\n");

function paymentInstructions(config, { ticket, revir, links }) {
  const rows = [["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Částka", czk(ticket.amount_due_halere)], ["Číslo účtu", `${config.payment.accountNumber}/${config.payment.bankCode}`], ["Variabilní symbol", ticket.variable_symbol], ["Zaplaťte do", czDateTime(ticket.reserved_until)]];
  return {
    subject: `Místenka ${ticket.code} – pokyny k platbě`,
    html: layout(config, "Dokončete platbu místenky", `<p>Místo na revíru je pro vás rezervované. Místenku vystavíme po připsání platby.</p>${table(rows)}${button(links.payment, "Zobrazit QR platbu")}`),
    text: textBlock(["Dokončete platbu místenky.", ...rows.map(([k, v]) => `${k}: ${v}`), `QR platba: ${links.payment}`])
  };
}

function ticketIssued(config, { ticket, revir, links }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ...(revir.number ? [["Číslo revíru", revir.number]] : []), ...(ticketSubdistrictLabel(revir) ? [[revir.ticketSubdistricts.length > 1 ? "Podrevíry" : "Podrevír", ticketSubdistrictLabel(revir)]] : []), ["Datum lovu", czDate(ticket.fishing_date)], ["Rybář", `${ticket.first_name} ${ticket.last_name}`], ["Číslo členské legitimace", ticket.member_id]];
  return {
    subject: `Místenka ${ticket.code} – ${revir.name}, ${czDate(ticket.fishing_date)}`,
    html: layout(config, "Vaše místenka je vystavena", `${table(rows)}<p>Místenka nenahrazuje rybářský lístek ani povolenku.</p>${button(links.ticket, "Zobrazit místenku")}<p>Po skončení lovu místenku odevzdejte a zapište úlovky:</p>${button(links.return, "Odevzdat místenku")}`),
    text: textBlock(["Vaše místenka je vystavena.", ...rows.map(([k, v]) => `${k}: ${v}`), `Místenka: ${links.ticket}`, `Odevzdání: ${links.return}`])
  };
}

function returnReminder(config, { ticket, revir, links, deadline }) {
  return {
    subject: `Místenka ${ticket.code} – nezapomeňte ji odevzdat`,
    html: layout(config, "Odevzdejte prosím místenku", `<p>Lov na revíru ${esc(revir.name)} dne ${esc(czDate(ticket.fishing_date))} skončil a místenka ještě nebyla odevzdána.</p><p>Odevzdat ji můžete do <b>${esc(czDateTime(deadline))}</b>; odevzdání po skončení dne lovu se označí jako opožděné. <b>Po této lhůtě se místenka automaticky uzavře jako neodevzdaná, bez úlovku.</b></p>${button(links.return, "Odevzdat místenku")}`),
    text: textBlock([`Místenka ${ticket.code} ještě nebyla odevzdána.`, `Odevzdání je možné do ${czDateTime(deadline)} (opožděně). Poté se místenka automaticky uzavře jako neodevzdaná, bez úlovku.`, `Odevzdat: ${links.return}`])
  };
}

function ticketClosed(config, { ticket, revir }) {
  const contact = config.organization.contact || {};
  const contactLine = [contact.email, contact.phone].filter(Boolean).join(", ");
  return {
    subject: `Místenka ${ticket.code} byla uzavřena jako neodevzdaná`,
    html: layout(config, "Místenka byla uzavřena jako neodevzdaná", `<p>Místenku <b>${esc(ticket.code)}</b> na revír ${esc(revir.name)} (den lovu ${esc(czDate(ticket.fishing_date))}) jste neodevzdali ani v prodloužené lhůtě. Byla proto automaticky uzavřena jako <b>neodevzdaná, bez zapsaného úlovku</b>.</p><p>Pokud jste na revíru něco ulovili nebo jde o omyl, kontaktujte prosím hospodáře${contactLine ? `: ${esc(contactLine)}` : ""}.</p>`),
    text: textBlock([`Místenka ${ticket.code} (${revir.name}, ${czDate(ticket.fishing_date)}) byla automaticky uzavřena jako neodevzdaná, bez zapsaného úlovku.`, `Pokud jde o omyl, kontaktujte hospodáře${contactLine ? `: ${contactLine}` : ""}.`])
  };
}

// Vývojové doručení: e-maily se ukládají jako soubory do data/outbox/.
function createFileMailer(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async send({ id, to, subject, html, text }) {
      const base = path.join(dir, `${String(id).padStart(5, "0")}`);
      fs.writeFileSync(`${base}.html`, html);
      fs.writeFileSync(`${base}.txt`, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
      console.log(`[e-mail] ${to} · ${subject} → ${base}.html`);
    }
  };
}

module.exports = { paymentInstructions, ticketIssued, returnReminder, ticketClosed, createFileMailer, czDate };
