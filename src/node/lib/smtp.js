"use strict";
// Vlastní SMTP klient (bez knihoven): odeslání jednoho e-mailu přes účet z „Emailoví klienti“.
// Stejné chování má PHP plugin (includes/Smtp.php).
//
//   šifrování "ssl"  – TLS hned po připojení (obvykle port 465)
//             "tls"  – STARTTLS po EHLO (obvykle port 587), bez podpory serveru = chyba
//             "none" – nešifrované spojení (port 25, jen pro vnitřní sítě)
//   přihlášení AUTH PLAIN, jinak AUTH LOGIN (podle nabídky serveru); bez jména se nepřihlašuje.
//
// Zpráva: multipart/alternative (text + HTML), UTF-8, base64, hlavičky podle RFC 2047.
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const os = require("node:os");

const TIMEOUT_MS = 20_000;

const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");
const wrap76 = (text) => text.replace(/.{1,76}/g, "$&\r\n");
// RFC 2047: ne-ASCII text v hlavičce jako =?UTF-8?B?…?= (po částech, aby řádek nebyl moc dlouhý).
function encodeHeader(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const parts = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) { parts.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) parts.push(chunk);
  return parts.map((part) => `=?UTF-8?B?${b64(part)}?=`).join("\r\n ");
}
function address(email, name) {
  if (!name) return `<${email}>`;
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${String(name).replace(/["\\]/g, "")}"` : encodeHeader(name);
  return `${display} <${email}>`;
}
const domainOf = (email) => String(email).split("@")[1] || "localhost";

// Sestaví celou zprávu (hlavičky + tělo) s CRLF konci řádků.
function buildMessage({ from, to, subject, text, html, date = new Date() }) {
  const boundary = `=_mistenka_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `From: ${address(from.email, from.name)}`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${domainOf(from.email)}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body || "")).trimEnd()].join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", text)}\r\n${part("text/html", html)}\r\n--${boundary}--\r\n`;
}

// Spojení s řádkovým čtením odpovědí serveru („250-…“ pokračuje, „250 …“ končí).
function connection(socket) {
  let buffer = "";
  let waiting = null;
  let failure = null;
  const lines = [];
  const flush = () => {
    if (!waiting) return;
    if (failure) { const w = waiting; waiting = null; w.reject(failure); return; }
    const end = lines.findIndex((line) => /^\d{3}(?: |$)/.test(line));
    if (end === -1) return;
    const reply = lines.splice(0, end + 1);
    const w = waiting;
    waiting = null;
    w.resolve({ code: Number(reply[end].slice(0, 3)), lines: reply.map((line) => line.slice(4)), text: reply.join(" | ") });
  };
  const attach = (s) => {
    s.setEncoding("utf8");
    s.setTimeout(TIMEOUT_MS, () => { failure = new Error("Server SMTP neodpověděl včas."); s.destroy(); flush(); });
    s.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) > -1) { lines.push(buffer.slice(0, index).replace(/\r$/, "")); buffer = buffer.slice(index + 1); }
      flush();
    });
    s.on("error", (error) => { failure = error; flush(); });
    s.on("close", () => { failure ||= new Error("Server SMTP ukončil spojení."); flush(); });
  };
  attach(socket);
  return {
    get socket() { return socket; },
    read: () => new Promise((resolve, reject) => { waiting = { resolve, reject }; flush(); }),
    write: (data) => socket.write(data),
    replace(next) { socket.removeAllListeners("data"); socket.removeAllListeners("close"); socket.removeAllListeners("error"); socket = next; buffer = ""; failure = null; attach(next); }
  };
}

function connect({ host, port, encryption }) {
  return new Promise((resolve, reject) => {
    const options = { host, port, servername: host, timeout: TIMEOUT_MS };
    const socket = encryption === "ssl" ? tls.connect(options) : net.connect(options);
    const fail = (error) => reject(new Error(`Nelze se připojit k ${host}:${port} – ${error.message}`));
    socket.once("error", fail);
    socket.once("timeout", () => { socket.destroy(); fail(new Error("vypršel čas připojení")); });
    socket.once(encryption === "ssl" ? "secureConnect" : "connect", () => { socket.removeListener("error", fail); socket.setTimeout(0); resolve(socket); });
  });
}

// Odešle jeden e-mail. account = { host, port, encryption, username, password }, from = { email, name }.
async function sendMail({ account, from, to, subject, text, html, heloName }) {
  const conn = connection(await connect(account));
  const expect = async (codes, step) => {
    const reply = await conn.read();
    if (!codes.includes(reply.code)) throw new Error(`${step}: ${reply.text}`);
    return reply;
  };
  const command = async (line, codes, step = line.split(" ")[0]) => { conn.write(`${line}\r\n`); return expect(codes, step); };
  const helo = heloName || domainOf(from.email) || os.hostname();
  try {
    await expect([220], "Pozdrav serveru");
    let ehlo = await command(`EHLO ${helo}`, [250], "EHLO");
    if (account.encryption === "tls") {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new Error("Server nenabízí STARTTLS – zvolte šifrování SSL nebo žádné.");
      await command("STARTTLS", [220]);
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: conn.socket, servername: account.host }, () => resolve(s));
        s.once("error", (error) => reject(new Error(`STARTTLS: ${error.message}`)));
      });
      conn.replace(secure);
      ehlo = await command(`EHLO ${helo}`, [250], "EHLO");
    }
    if (account.username) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || "";
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await command(`AUTH PLAIN ${b64(`\0${account.username}\0${account.password || ""}`)}`, [235], "Přihlášení (AUTH PLAIN)");
      } else {
        await command("AUTH LOGIN", [334], "Přihlášení (AUTH LOGIN)");
        await command(b64(account.username), [334], "Přihlášení – jméno");
        await command(b64(account.password || ""), [235], "Přihlášení – heslo");
      }
    }
    await command(`MAIL FROM:<${from.email}>`, [250], "MAIL FROM");
    await command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await command("DATA", [354]);
    // Tečka na začátku řádku se zdvojí (jinak by ukončila zprávu).
    const body = buildMessage({ from, to, subject, text, html }).replace(/^\./gm, "..");
    conn.write(`${body}.\r\n`);
    await expect([250], "Odeslání zprávy");
    conn.write("QUIT\r\n");
  } finally {
    setTimeout(() => conn.socket.destroy(), 200).unref?.();
  }
}

// Mailer pro server: odesílá přes SMTP účet; e-mail bez účtu odeslat nejde (výchozí odesílání neexistuje).
function createSmtpMailer() {
  return {
    delivery: "smtp",
    async send({ to, subject, html, text, from, account }) {
      if (!account) throw new Error("Chybí poštovní účet odesílatele (Admin → Emailoví klienti).");
      await sendMail({ account, from, to, subject, text, html });
    }
  };
}

module.exports = { sendMail, buildMessage, encodeHeader, createSmtpMailer };
