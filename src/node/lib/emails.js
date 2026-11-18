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

// ---------- zadržení místenky (B2) ----------
function ticketSeized(config, { ticket, revir, links, deadline }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Zadrženo", czDateTime(ticket.seized_at)], ["Důvod", ticket.seized_reason], ...(ticket.seized_place ? [["Místo", ticket.seized_place]] : [])];
  return {
    subject: `Místenka ${ticket.code} byla zadržena rybářskou stráží`,
    html: layout(config, "Místenka byla zadržena", `<p>Rybářská stráž zadržela vaši místenku. <b>Místenka od této chvíle neopravňuje k lovu.</b></p>${table(rows)}<p>Místenku musíte i tak odevzdat a zapsat všechny úlovky, nejpozději do <b>${esc(czDateTime(deadline))}</b>.</p>${button(links.return, "Odevzdat místenku")}`),
    text: textBlock(["Rybářská stráž zadržela vaši místenku. Místenka od této chvíle neopravňuje k lovu.", ...rows.map(([k, v]) => `${k}: ${v}`), `Místenku musíte i tak odevzdat s úlovky do ${czDateTime(deadline)}: ${links.return}`])
  };
}
function seizureNotice(config, { ticket, revir, links, wardenName }) {
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Držitel", `${ticket.first_name} ${ticket.last_name}`], ["Č. legitimace", ticket.member_id], ["Porybný", wardenName], ["Zadrženo", czDateTime(ticket.seized_at)], ["Důvod", ticket.seized_reason], ...(ticket.seized_place ? [["Místo", ticket.seized_place]] : [])];
  return {
    subject: `Zadržená místenka ${ticket.code} – ${ticket.first_name} ${ticket.last_name}`,
    html: layout(config, "Porybný zadržel místenku", `<p>Pro informaci: místenka byla zadržena. Zadržení není potřeba potvrzovat.</p>${table(rows)}${button(links.status, "Stav místenky")}`),
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
    html: layout(config, "Překročený limit úlovků", `<p>Při odevzdání místenky byly podle místenek v Místence překročeny limity:</p><ul>${limits.map((l) => `<li>${esc(limitLine(l))}</li>`).join("")}</ul>${table(rows)}<p style="color:#5b6b64;font-size:13px">Místenka vidí jen úlovky ze svých místenek; limity platí na všech revírech svazu dohromady.</p>${button(links.status, "Stav místenky")}`),
    text: textBlock(["Překročené limity úlovků (podle místenek v Místence):", ...limits.map((l) => `- ${limitLine(l)}`), ...rows.map(([k, v]) => `${k}: ${v}`), `Stav: ${links.status}`])
  };
}
function memberBlocked(config, { ticket, block, limits }) {
  const until = block.until ? `do ${czDate(block.until)}` : "do odvolání";
  return {
    subject: "Místenka – nákup místenek je pozastaven",
    html: layout(config, "Nákup místenek je pozastaven", `<p>Nákup místenek na číslo legitimace <b>${esc(ticket.member_id)}</b> je pozastaven <b>${esc(until)}</b>.</p><p>Důvod: ${esc(block.reason)}</p>${limits?.length ? `<ul>${limits.map((l) => `<li>${esc(limitLine(l))}</li>`).join("")}</ul>` : ""}<p>Pokud jde o omyl, kontaktujte správce organizace${config.organization.contact?.email ? ` (${esc(config.organization.contact.email)})` : ""}.</p>`),
    text: textBlock([`Nákup místenek na číslo legitimace ${ticket.member_id} je pozastaven ${until}.`, `Důvod: ${block.reason}`, "Pokud jde o omyl, kontaktujte správce organizace."])
  };
}

// ---------- nastavení (B5) ----------
function paymentSettingsChanged(config, { actorName, before, after, at }) {
  const labels = { accountNumber: "Číslo účtu", bankCode: "Kód banky", iban: "IBAN", recipientName: "Příjemce", reservationMinutes: "Rezervace (min)", messagePrefix: "Zpráva pro příjemce" };
  const rows = Object.keys(labels).filter((key) => String(before?.[key] ?? "") !== String(after?.[key] ?? "")).map((key) => [labels[key], `${before?.[key] ?? "—"} → ${after?.[key] ?? "—"}`]);
  return {
    subject: "Místenka – změněny platební údaje",
    html: layout(config, "Změněny platební údaje", `<p>${esc(actorName)} změnil(a) ${esc(czDateTime(at))} platební údaje Místenky. Nové objednávky se platí podle nových údajů.</p>${table(rows.length ? rows : [["Změna", "beze změny hodnot"]])}<p><b>Pokud o změně nevíte, okamžitě ji prověřte</b> – změna účtu je nejčastější podvod.</p>`),
    text: textBlock([`${actorName} změnil(a) ${czDateTime(at)} platební údaje Místenky.`, ...rows.map(([k, v]) => `${k}: ${v}`), "Pokud o změně nevíte, okamžitě ji prověřte."])
  };
}

// ---------- zrušení správcem (B4) ----------
function ticketCancelled(config, { ticket, revir }) {
  const contact = [config.organization.contact?.email, config.organization.contact?.phone].filter(Boolean).join(", ");
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Důvod", ticket.cancel_reason]];
  return {
    subject: `Místenka ${ticket.code} byla zrušena`,
    html: layout(config, "Místenka byla zrušena", `<p>Správce organizace vaši místenku zrušil. <b>Místenka neplatí a neopravňuje k lovu.</b></p>${table(rows)}<p>Pokud máte nárok na vrácení peněz, vyřídí ho správce převodem${contact ? `; kontakt: ${esc(contact)}` : ""}.</p>`),
    text: textBlock(["Správce organizace vaši místenku zrušil. Místenka neplatí a neopravňuje k lovu.", ...rows.map(([k, v]) => `${k}: ${v}`), `Vrácení peněz vyřídí správce${contact ? ` (${contact})` : ""}.`])
  };
}

// ---------- mimořádné uzavření (B4) ----------
function closureNotice(config, { ticket, revir, closure, links }) {
  const range = closure.dateFrom === closure.dateTo ? czDate(closure.dateFrom) : `${czDate(closure.dateFrom)} – ${czDate(closure.dateTo)}`;
  const contact = [config.organization.contact?.email, config.organization.contact?.phone].filter(Boolean).join(", ");
  const rows = [["Kód místenky", ticket.code], ["Revír", revir.name], ["Datum lovu", czDate(ticket.fishing_date)], ["Uzavřeno", range], ["Důvod", closure.reason]];
  return {
    subject: `Revír ${revir.name} je mimořádně uzavřen – místenka ${ticket.code}`,
    html: layout(config, "Revír je mimořádně uzavřen", `<p>Na den vaší místenky je revír mimořádně uzavřen. <b>Lovit v tento den nelze.</b></p>${table(rows)}<p>Ohledně vrácení peněz nebo náhradního termínu kontaktujte prosím správce${contact ? `: ${esc(contact)}` : ""}.</p>${button(links.status, "Stav místenky")}`),
    text: textBlock(["Revír je na den vaší místenky mimořádně uzavřen. Lovit v tento den nelze.", ...rows.map(([k, v]) => `${k}: ${v}`), `Vrácení peněz nebo náhradní termín: kontaktujte správce${contact ? ` (${contact})` : ""}.`])
  };
}

// ---------- účty ----------
const validFor = (minutes) => (minutes >= 120 ? `${Math.round(minutes / 60)} hodin` : `${minutes} minut`);
function accountMail(config, { subject, title, intro, link, label, minutes, outro }) {
  const note = minutes ? `Odkaz platí ${validFor(minutes)} a lze ho použít jen jednou.` : "";
  return {
    subject,
    html: layout(config, title, `<p>${esc(intro)}</p>${link ? button(link, label) : ""}${note ? `<p style="color:#5b6b64;font-size:13px">${esc(note)}</p>` : ""}<p style="color:#5b6b64;font-size:13px">${esc(outro || "Pokud jste o nic nežádali, zprávu ignorujte.")}</p>`),
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

module.exports = { paymentInstructions, ticketIssued, returnReminder, ticketClosed, ticketSeized, seizureNotice, limitExceeded, memberBlocked, closureNotice, ticketCancelled, paymentSettingsChanged, accountVerify, accountExists, magicLink, passwordReset, emailChange, staffInvite, accountDeleted, createFileMailer, czDate };
