"use strict";
// Chyby API a validace sdílené službami (místenky, účty).
const time = require("./time");

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Číslo členské legitimace: 8 číslic pod čárovým kódem; mezery se ignorují.
const MEMBER_ID_RE = /^\d{8}$/;
const normalizeMemberId = (value) => String(value || "").replace(/\s+/g, "");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

function validEmail(value, code = "invalid_email") {
  const email = String(value || "").trim();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new ApiError(400, code, "Zadejte platný e-mail.");
  return email;
}
function validMemberId(value) {
  const memberId = normalizeMemberId(value);
  if (!MEMBER_ID_RE.test(memberId)) throw new ApiError(400, "invalid_member_id", "Zadejte 8místné číslo členské legitimace (pod čárovým kódem).");
  return memberId;
}
function validName(firstValue, lastValue) {
  const firstName = String(firstValue || "").trim();
  const lastName = String(lastValue || "").trim();
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) throw new ApiError(400, "invalid_name", "Vyplňte jméno a příjmení.");
  return { firstName, lastName };
}
function validBirthDate(value) {
  const birthDate = String(value || "");
  if (!time.isIsoDate(birthDate) || birthDate >= time.pragueToday() || birthDate < "1900-01-01") throw new ApiError(400, "invalid_birth_date", "Zadejte platné datum narození.");
  return birthDate;
}

module.exports = { ApiError, EMAIL_RE, MEMBER_ID_RE, normalizeMemberId, normalizeEmail, validEmail, validMemberId, validName, validBirthDate };
