"use strict";
// Hesla, náhodné tokeny a 2FA (TOTP, RFC 6238). Jen vestavěný node:crypto.
// Ve WordPressu hesla a relace řeší WP (wp_hash_password, auth cookies); TOTP bude stejné.
const crypto = require("node:crypto");

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// ---------- hesla: scrypt$N$r$p$salt$hash ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64url"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}
// Porovnání při neexistujícím účtu, aby doba odpovědi neprozradila, zda e-mail existuje.
const DUMMY_HASH = hashPassword(randomToken(16));

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[\s=]/g, "")) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error("Neplatný base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}
const totpStep = (atMs) => Math.floor(atMs / 30_000);
const totp = (secret, atMs) => hotp(secret, totpStep(atMs));

// Ověří kód v okně ±1 krok (30 s). Vrátí použitý krok, nebo null. Krok <= lastStep se odmítne (opakované použití).
function verifyTotp(secret, code, atMs, lastStep = null) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean) || !secret) return null;
  const now = totpStep(atMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}
const otpauthUrl = ({ secret, account, issuer }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { sha256, randomToken, hashPassword, verifyPassword, DUMMY_HASH, newTotpSecret, totp, verifyTotp, otpauthUrl, base32Encode, base32Decode };
