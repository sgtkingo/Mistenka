"use strict";
// Zdroje příchozích plateb. Každý adaptér vrací pole transakcí ve stejném tvaru:
// { transactionId, bookedAt, amountHalere, currency, variableSymbol, counterAccount, counterName, message }
// Párování a vydání místenky řeší služba (service.js), adaptér jen čte z banky.

// Falešná banka pro vývoj: transakce se vkládají přes /api/dev/payments.
function createFakeProvider() {
  const queue = [];
  let counter = 0;
  return {
    name: "fake",
    minIntervalMs: 0,
    push({ variableSymbol, amountHalere, currency = "CZK", message = "", counterAccount = "123456789/0800", counterName = "Testovací plátce" }) {
      counter += 1;
      queue.push({ transactionId: `FAKE-${Date.now()}-${counter}`, bookedAt: new Date().toISOString(), amountHalere, currency, variableSymbol: String(variableSymbol || ""), counterAccount, counterName, message });
    },
    async fetchTransactions() {
      return queue.splice(0, queue.length);
    }
  };
}

// Fio API Bankovnictví – endpoint "last" vrací pohyby od posledního úspěšného stažení.
// Token jen pro čtení, z proměnné prostředí FIO_TOKEN; nikdy ho nelogovat (je součástí URL).
// Banka povoluje 1 dotaz za 30 s na token. NEOVĚŘENO proti skutečnému účtu – ověřit před spuštěním.
function createFioProvider({ token, fetchImpl = fetch }) {
  if (!token) throw new Error("Pro platby přes Fio nastavte proměnnou FIO_TOKEN.");
  return {
    name: "fio",
    minIntervalMs: 31000,
    async fetchTransactions() {
      const response = await fetchImpl(`https://fioapi.fio.cz/v1/rest/last/${encodeURIComponent(token)}/transactions.json`);
      if (response.status === 409) return []; // příliš častý dotaz – zkusíme příště
      if (!response.ok) throw new Error(`Fio API odpovědělo stavem ${response.status}.`);
      const data = await response.json();
      const list = data?.accountStatement?.transactionList?.transaction || [];
      return list.map((tx) => {
        const col = (n) => tx[`column${n}`]?.value ?? null;
        const amount = Number(col(1));
        return {
          transactionId: String(col(22)),
          bookedAt: col(0) ? String(col(0)) : null,
          amountHalere: Math.round(amount * 100),
          currency: String(col(14) || ""),
          variableSymbol: col(5) ? String(col(5)).replace(/^0+/, "") : "",
          counterAccount: [col(2), col(3)].filter(Boolean).join("/"),
          counterName: col(10) ? String(col(10)) : "",
          message: col(16) ? String(col(16)) : ""
        };
      });
    }
  };
}

function createProvider(config, env = process.env) {
  if (config.payment.provider === "fio") return createFioProvider({ token: env.FIO_TOKEN });
  if (config.payment.provider === "fake") return createFakeProvider();
  throw new Error(`Neznámý poskytovatel plateb: ${config.payment.provider}`);
}

// QR Platba (formát SPAYD, standard ČBA). Hodnoty bez diakritiky a bez znaku "*".
function asciiSafe(value, max) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").replace(/\*/g, " ").trim().slice(0, max);
}
function spayd({ iban, amountHalere, variableSymbol, message, recipientName }) {
  const parts = ["SPD", "1.0", `ACC:${iban}`, `AM:${(amountHalere / 100).toFixed(2)}`, "CC:CZK", `X-VS:${variableSymbol}`];
  if (message) parts.push(`MSG:${asciiSafe(message, 60)}`);
  if (recipientName) parts.push(`RN:${asciiSafe(recipientName, 35)}`);
  return parts.join("*");
}

module.exports = { createProvider, createFakeProvider, createFioProvider, spayd };
