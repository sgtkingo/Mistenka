"use strict";
// Uživatelské účty, přihlášení a role (B1). Smlouva v docs/API.md, sekce „Účty“.
// Ve WordPressu nahradí uživatele, hesla a relace WP (vlastní role a capability); API zůstává stejné.
const { transaction, serviceLaunched, seasonOpen } = require("./db");
const time = require("./time");
const emails = require("./emails");
const { noticeRecipients } = require("./mail-accounts");
const sec = require("./security");
const { ApiError, normalizeEmail, validEmail, validMemberId, validName, validBirthDate } = require("./validate");

const ROLES = ["member", "warden", "manager", "admin"];
const STAFF_ROLES = ["manager", "admin"];
const SESSION_DAYS = 30;          // běžný uživatel
const STAFF_SESSION_HOURS = 12;   // správce a admin
const UNVERIFIED_HOURS = 48;      // neověřený účet se pak smaže
const TOKEN_MINUTES = { verify_email: 48 * 60, magic_link: 15, password_reset: 60, change_email: 24 * 60, invite: 72 * 60 };
const SETUP_MINUTES = 60;         // jednorázový odkaz průvodce prvním spuštěním
const ROLE_NAMES = { manager: "správce", admin: "admin" };
const PASSWORD_MIN = 8;

const iso = (date) => date.toISOString();
const rolesOf = (user) => String(user?.roles || "").split(",").filter(Boolean);
const hasRole = (user, role) => rolesOf(user).includes(role);
const isStaff = (user) => STAFF_ROLES.some((role) => hasRole(user, role));
// Před spuštěním služby (první otevřená sezona) se registrovat ani přihlásit nemohou rybáři – jen správa.
const NOT_LAUNCHED = "Místenka zatím nebyla spuštěna – registrace a přihlášení se otevřou s první sezonou.";
// Při uzavřené sezoně (dnes není otevřená žádná sezona) se přihlásí jen správci a admini.
const SEASON_CLOSED = "Sezona je uzavřená – přihlásit se teď mohou jen správci a admini. Místenku vrátíte i bez přihlášení (kód místenky a číslo legitimace).";
// Admin musí mít zapnutou 2FA, jinak nesmí nic spravovat.
const mfaRequired = (user) => hasRole(user, "admin") && !user.totp_enabled_at;

function validPassword(value) {
  const password = String(value ?? "");
  if (password.length < PASSWORD_MIN || password.length > 200) throw new ApiError(400, "weak_password", `Heslo musí mít alespoň ${PASSWORD_MIN} znaků.`);
  return password;
}

function createAccounts({ db, config, appUrl }) {
  const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const userByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));

  // ---------- výstupní tvary ----------
  function publicUser(user) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      birthDate: user.birth_date || null,
      memberId: user.member_id || null,
      staffOnly: !user.member_id,          // účet jen pro správu, bez rybářských údajů
      roles: rolesOf(user),
      emailVerified: Boolean(user.email_verified_at),
      hasPassword: Boolean(user.password_hash),
      twoFactor: Boolean(user.totp_enabled_at),
      mfaRequired: mfaRequired(user),
      wardenRequest: latestWardenRequest(user.id),
      createdAt: user.created_at
    };
  }
  // Poslední žádost „Jsem porybný“ (stav pro účet), nebo null.
  function latestWardenRequest(userId) {
    const r = db.prepare("SELECT * FROM warden_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
    return r ? { id: r.id, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note || "" } : null;
  }
  const staffUser = (user) => {
    const { hasPassword, mfaRequired: _m, birthDate, wardenRequest: _w, ...rest } = publicUser(user);
    return rest;
  };

  // ---------- pomocné ----------
  function audit(actorId, action, targetType, targetId, detail = null) {
    db.prepare("INSERT INTO audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(iso(time.now()), actorId ?? null, action, targetType, targetId === undefined || targetId === null ? null : String(targetId), detail ? JSON.stringify(detail) : null);
  }
  function queueEmail(to, kind, mail) {
    db.prepare("INSERT INTO email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)")
      .run(kind, to, mail.subject, mail.html, mail.text, iso(time.now()));
  }
  // Jednorázový odkaz. Předchozí nepoužité odkazy stejného účelu se zneplatní.
  function issueAuthToken(user, purpose, newEmail = null) {
    const now = time.now();
    db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(user.id, purpose);
    const token = sec.randomToken();
    db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, new_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sec.sha256(token), user.id, purpose, newEmail, iso(now), iso(new Date(now.getTime() + TOKEN_MINUTES[purpose] * 60_000)));
    return token;
  }
  function findAuthToken(token, purpose) {
    const purposes = [].concat(purpose);
    const row = token ? db.prepare(`SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose IN (${purposes.map(() => "?").join(",")})`).get(sec.sha256(token), ...purposes) : null;
    if (!row || row.used_at || new Date(row.expires_at) <= time.now()) throw new ApiError(400, "invalid_link", "Odkaz je neplatný nebo už vypršel. Nechte si poslat nový.");
    const user = userById(row.user_id);
    if (!user) throw new ApiError(400, "invalid_link", "Odkaz je neplatný nebo už vypršel. Nechte si poslat nový.");
    return { row, user };
  }
  const useAuthToken = (row) => db.prepare("UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?").run(iso(time.now()), row.token_hash);
  const link = (fragment, token) => `${appUrl}/account.html#${fragment}=${token}`;

  function sendVerification(user) {
    const token = issueAuthToken(user, "verify_email");
    queueEmail(user.email, "account_verify", emails.accountVerify(config, { link: link("verify", token), minutes: TOKEN_MINUTES.verify_email }));
  }
  // Ověření e-mailu připojí dřívější místenky se stejným e-mailem a číslem legitimace.
  function markVerified(user) {
    if (user.email_verified_at) return;
    const now = iso(time.now());
    db.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?").run(now, now, user.id);
    if (user.member_id) db.prepare("UPDATE tickets SET user_id = ? WHERE user_id IS NULL AND member_id = ? AND lower(email) = ?").run(user.id, user.member_id, user.email);
    for (const request of db.prepare("SELECT * FROM warden_requests WHERE user_id = ? AND status = 'unverified'").all(user.id)) submitWardenRequest(request, userById(user.id));
  }
  // 2FA: pokud je zapnutá, je kód povinný při každém přihlášení.
  function checkOtp(user, otp) {
    if (!user.totp_enabled_at) return;
    if (!String(otp || "").trim()) throw new ApiError(401, "otp_required", "Zadejte šestimístný kód z ověřovací aplikace.");
    const step = sec.verifyTotp(user.totp_secret, otp, time.now().getTime(), user.totp_last_step);
    if (step === null) throw new ApiError(401, "invalid_otp", "Kód z ověřovací aplikace nesouhlasí.");
    db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, user.id);
  }
  function ensureMemberIdFree(memberId, exceptUserId = 0) {
    if (db.prepare("SELECT 1 FROM users WHERE member_id = ? AND id != ?").get(memberId, exceptUserId)) {
      throw new ApiError(409, "member_id_taken", "Toto číslo členské legitimace už patří jinému účtu. Pokud je vaše, kontaktujte správce.");
    }
  }

  // ---------- relace ----------
  function createSession(user) {
    const now = time.now();
    const token = sec.randomToken();
    const csrf = sec.randomToken(18);
    const ms = isStaff(user) ? STAFF_SESSION_HOURS * 3600_000 : SESSION_DAYS * 86_400_000;
    const expiresAt = new Date(now.getTime() + ms);
    db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(sec.sha256(token), user.id, csrf, iso(now), iso(expiresAt));
    return { token, csrf, expiresAt, maxAgeSeconds: Math.floor(ms / 1000) };
  }
  // Vrátí { user, session } pro token z cookie, nebo null.
  function resolveSession(token) {
    if (!token) return null;
    const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sec.sha256(token));
    if (!session) return null;
    if (new Date(session.expires_at) <= time.now()) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
      return null;
    }
    const user = userById(session.user_id);
    return user ? { user, session } : null;
  }
  const loggedIn = (user) => ({ user: publicUser(user), session: createSession(user) });
  function requireUser(ctx) {
    if (!ctx?.user) throw new ApiError(401, "unauthorized", "Pro tuto akci se přihlaste.");
    return ctx.user;
  }

  // ---------- registrace a přihlášení ----------
  // Kdo se smí přihlásit: správa vždy; rybáři jen po spuštění služby a při otevřené sezoně.
  const closedReason = () => (!serviceLaunched(db) ? ["service_not_launched", NOT_LAUNCHED] : !seasonOpen(db, time.pragueToday()) ? ["season_closed", SEASON_CLOSED] : null);
  const requireLaunchedFor = (user) => {
    const closed = isStaff(user) ? null : closedReason();
    if (closed) throw new ApiError(409, closed[0], closed[1]);
  };
  const mayLogIn = (user) => isStaff(user) || !closedReason();
  function register(input = {}) {
    const closed = closedReason();
    if (closed) throw new ApiError(409, closed[0], closed[1]);
    const email = normalizeEmail(validEmail(input.email));
    const memberId = validMemberId(input.memberId);
    const { firstName, lastName } = validName(input.firstName, input.lastName);
    const birthDate = validBirthDate(input.birthDate);
    const password = input.password ? validPassword(input.password) : null;
    if (input.consent !== true) throw new ApiError(400, "consent_required", "Pro registraci potvrďte, že jste se seznámili se zásadami zpracování osobních údajů.");
    return transaction(db, () => {
      const now = iso(time.now());
      const existing = userByEmail(email);
      // Existující ověřený účet: neprozrazujeme to, majitel dostane e-mail.
      if (existing?.email_verified_at) {
        queueEmail(email, "account_exists", emails.accountExists(config, { link: `${appUrl}/account.html` }));
        return { sent: true };
      }
      ensureMemberIdFree(memberId, existing?.id || 0);
      const hash = password ? sec.hashPassword(password) : null;
      let user;
      if (existing) {
        db.prepare("UPDATE users SET first_name = ?, last_name = ?, birth_date = ?, member_id = ?, password_hash = ?, updated_at = ? WHERE id = ?")
          .run(firstName, lastName, birthDate, memberId, hash, now, existing.id);
        user = userById(existing.id);
      } else {
        const result = db.prepare("INSERT INTO users (email, password_hash, first_name, last_name, birth_date, member_id, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?)")
          .run(email, hash, firstName, lastName, birthDate, memberId, now, now);
        user = userById(Number(result.lastInsertRowid));
      }
      db.prepare("DELETE FROM warden_requests WHERE user_id = ? AND status = 'unverified'").run(user.id);
      if (input.wardenRequest === true) db.prepare("INSERT INTO warden_requests (user_id, status, created_at) VALUES (?, 'unverified', ?)").run(user.id, now);
      sendVerification(user);
      return { sent: true };
    });
  }

  function verifyEmail({ token } = {}) {
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, "verify_email");
      requireLaunchedFor(user);
      useAuthToken(row);
      markVerified(user);
      audit(user.id, "account_verified", "user", user.id);
      return loggedIn(userById(user.id));
    });
  }

  function login({ email, password, otp } = {}) {
    const user = email ? userByEmail(email) : null;
    const ok = sec.verifyPassword(String(password || ""), user?.password_hash || sec.DUMMY_HASH);
    if (!user || !user.password_hash || !ok) throw new ApiError(401, "invalid_credentials", "Nesprávný e-mail nebo heslo.");
    requireLaunchedFor(user);
    if (!user.email_verified_at) {
      transaction(db, () => sendVerification(user));
      throw new ApiError(403, "email_not_verified", "E-mail ještě není ověřený. Poslali jsme vám nový ověřovací odkaz.");
    }
    return transaction(db, () => {
      checkOtp(user, otp);
      return loggedIn(user);
    });
  }

  // Odkaz pro přihlášení bez hesla. Odpověď je vždy stejná, aby neprozradila existenci účtu.
  function requestMagicLink({ email } = {}) {
    validEmail(email);
    const user = userByEmail(email);
    if (user && mayLogIn(user)) transaction(db, () => queueEmail(user.email, "magic_link", emails.magicLink(config, { link: link("login", issueAuthToken(user, "magic_link")), minutes: TOKEN_MINUTES.magic_link })));
    return { sent: true };
  }
  function magicLogin({ token, otp } = {}) {
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, "magic_link");
      requireLaunchedFor(user);
      checkOtp(user, otp); // při chybě kódu odkaz zůstává platný
      useAuthToken(row);
      markVerified(user); // odkaz z e-mailu prokazuje vlastnictví adresy
      return loggedIn(userById(user.id));
    });
  }

  function requestPasswordReset({ email } = {}) {
    validEmail(email);
    const user = userByEmail(email);
    if (user && mayLogIn(user)) transaction(db, () => queueEmail(user.email, "password_reset", emails.passwordReset(config, { link: link("reset", issueAuthToken(user, "password_reset")), minutes: TOKEN_MINUTES.password_reset })));
    return { sent: true };
  }
  function resetPassword({ token, password, otp } = {}) {
    const newPassword = validPassword(password);
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, ["password_reset", "invite"]);
      requireLaunchedFor(user);
      checkOtp(user, otp);
      useAuthToken(row);
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(sec.hashPassword(newPassword), iso(time.now()), user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id); // odhlásit všechna zařízení
      markVerified(user);
      audit(user.id, "password_reset", "user", user.id);
      return loggedIn(userById(user.id));
    });
  }

  function logout(token) {
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sec.sha256(token));
    return { ok: true };
  }

  // ---------- vlastní účet ----------
  function me(ctx) {
    return { user: ctx?.user ? publicUser(ctx.user) : null, csrf: ctx?.session?.csrf || null };
  }

  function updateProfile(ctx, input = {}) {
    const user = requireUser(ctx);
    // Rybářské údaje jsou povinné pro běžného uživatele; účet správce je mít nemusí (prázdná hodnota = bez nich).
    const fisher = !isStaff(user);
    const memberInput = input.memberId === undefined ? user.member_id : input.memberId;
    const birthInput = input.birthDate === undefined ? user.birth_date : input.birthDate;
    const memberId = fisher || String(memberInput || "").trim() ? validMemberId(memberInput) : null;
    const birthDate = fisher || String(birthInput || "").trim() ? validBirthDate(birthInput) : null;
    const { firstName, lastName } = validName(input.firstName ?? user.first_name, input.lastName ?? user.last_name);
    const email = input.email === undefined ? user.email : normalizeEmail(validEmail(input.email));
    return transaction(db, () => {
      if (memberId) ensureMemberIdFree(memberId, user.id);
      db.prepare("UPDATE users SET first_name = ?, last_name = ?, birth_date = ?, member_id = ?, updated_at = ? WHERE id = ?")
        .run(firstName, lastName, birthDate, memberId, iso(time.now()), user.id);
      let emailChangePending = null;
      if (email !== user.email) {
        if (userByEmail(email)) throw new ApiError(409, "email_taken", "Tento e-mail už používá jiný účet.");
        const token = issueAuthToken(user, "change_email", email);
        queueEmail(email, "email_change", emails.emailChange(config, { link: link("email", token), minutes: TOKEN_MINUTES.change_email }));
        emailChangePending = email;
      }
      return { user: publicUser(userById(user.id)), emailChangePending };
    });
  }

  function confirmEmailChange({ token } = {}) {
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, "change_email");
      if (userByEmail(row.new_email)) throw new ApiError(409, "email_taken", "Tento e-mail už používá jiný účet.");
      useAuthToken(row);
      db.prepare("UPDATE users SET email = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?").run(row.new_email, iso(time.now()), iso(time.now()), user.id);
      audit(user.id, "email_changed", "user", user.id, { from: user.email, to: row.new_email });
      return { user: publicUser(userById(user.id)) };
    });
  }

  function changePassword(ctx, { currentPassword, newPassword } = {}) {
    const user = requireUser(ctx);
    const password = validPassword(newPassword);
    if (user.password_hash && !sec.verifyPassword(String(currentPassword || ""), user.password_hash)) throw new ApiError(400, "wrong_password", "Současné heslo nesouhlasí.");
    return transaction(db, () => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(sec.hashPassword(password), iso(time.now()), user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, ctx.session.token_hash); // ostatní zařízení odhlásit
      audit(user.id, "password_changed", "user", user.id);
      return { user: publicUser(userById(user.id)) };
    });
  }

  function adminCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").get().n;
  }

  // Smazání účtu. Místenky zůstávají kvůli evidenci, jen se odpojí od účtu.
  function deleteAccount(ctx, { password, confirm } = {}) {
    const user = requireUser(ctx);
    if (confirm !== true) throw new ApiError(400, "confirm_required", "Potvrďte smazání účtu.");
    if (user.password_hash && !sec.verifyPassword(String(password || ""), user.password_hash)) throw new ApiError(400, "wrong_password", "Heslo nesouhlasí.");
    return transaction(db, () => {
      if (hasRole(user, "admin") && adminCount() <= 1) throw new ApiError(409, "last_admin", "Jste jediný admin. Před smazáním účtu jmenujte jiného admina.");
      db.prepare("UPDATE tickets SET user_id = NULL WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM warden_requests WHERE user_id = ?").run(user.id);
      db.prepare("UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = ?").run(user.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      audit(null, "account_deleted", "user", user.id);
      queueEmail(user.email, "account_deleted", emails.accountDeleted(config));
      return { deleted: true };
    });
  }

  // ---------- 2FA (TOTP) ----------
  function twoFactorSetup(ctx) {
    const user = requireUser(ctx);
    if (user.totp_enabled_at) throw new ApiError(409, "two_factor_enabled", "Dvoufázové ověření už máte zapnuté.");
    const secret = sec.newTotpSecret();
    db.prepare("UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?").run(secret, iso(time.now()), user.id);
    return { secret, otpauthUrl: sec.otpauthUrl({ secret, account: user.email, issuer: `Místenka ${config.organization.shortName}` }) };
  }
  function twoFactorEnable(ctx, { otp } = {}) {
    const user = requireUser(ctx);
    if (user.totp_enabled_at) throw new ApiError(409, "two_factor_enabled", "Dvoufázové ověření už máte zapnuté.");
    if (!user.totp_secret) throw new ApiError(409, "two_factor_not_setup", "Nejdřív si vygenerujte klíč pro ověřovací aplikaci.");
    const step = sec.verifyTotp(user.totp_secret, otp, time.now().getTime());
    if (step === null) throw new ApiError(400, "invalid_otp", "Kód z ověřovací aplikace nesouhlasí.");
    const now = iso(time.now());
    db.prepare("UPDATE users SET totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?").run(now, step, now, user.id);
    audit(user.id, "two_factor_enabled", "user", user.id);
    return { user: publicUser(userById(user.id)) };
  }
  function twoFactorDisable(ctx, { otp } = {}) {
    const user = requireUser(ctx);
    if (!user.totp_enabled_at) throw new ApiError(409, "two_factor_disabled", "Dvoufázové ověření nemáte zapnuté.");
    if (hasRole(user, "admin")) throw new ApiError(409, "two_factor_required", "Admin musí mít dvoufázové ověření zapnuté.");
    const step = sec.verifyTotp(user.totp_secret, otp, time.now().getTime(), user.totp_last_step);
    if (step === null) throw new ApiError(400, "invalid_otp", "Kód z ověřovací aplikace nesouhlasí.");
    db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?").run(iso(time.now()), user.id);
    audit(user.id, "two_factor_disabled", "user", user.id);
    return { user: publicUser(userById(user.id)) };
  }

  // ---------- správa uživatelů (manažerský portál) ----------
  function requireManager(ctx) {
    const user = requireUser(ctx);
    if (!isStaff(user)) throw new ApiError(403, "forbidden_role", "Na tuto akci nemáte oprávnění.");
    if (mfaRequired(user)) throw new ApiError(403, "mfa_required", "Nejdřív si v účtu zapněte dvoufázové ověření (2FA).");
    return user;
  }

  // Porybný (B2): plná kontrola a zadržení.
  function requireWarden(ctx) {
    const user = requireUser(ctx);
    if (!hasRole(user, "warden")) throw new ApiError(403, "forbidden_role", "Plnou kontrolu a zadržení smí jen porybný.");
    if (mfaRequired(user)) throw new ApiError(403, "mfa_required", "Nejdřív si v účtu zapněte dvoufázové ověření (2FA).");
    return user;
  }

  function requireAdmin(ctx) {
    const user = requireManager(ctx);
    if (!hasRole(user, "admin")) throw new ApiError(403, "forbidden_role", "Tuto část spravuje jen admin.");
    return user;
  }
  // Citlivá akce (obnova databáze): znovu ověřit kód 2FA.
  function confirmOtp(ctx, otp) {
    const user = requireAdmin(ctx);
    transaction(db, () => checkOtp(userById(user.id), otp));
    return user;
  }
  // Automatická obnova při startu: audit + e-mail všem adminům.
  function notifyAutoRestore(info) {
    const now = iso(time.now());
    db.prepare("INSERT INTO audit_events (at, action, target_type, target_id, detail) VALUES (?, 'database_auto_restored', 'backup', ?, ?)").run(now, info.from, JSON.stringify(info));
    const mail = emails.databaseAutoRestored(config, info);
    for (const admin of db.prepare("SELECT email FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").all()) queueEmail(admin.email, "database_auto_restored", mail);
  }
  // Testovací režim zapnut / vypnut / obnoven: audit a e-mail všem adminům (volá se nad provozní databází).
  function notifyTestMode(actor, action, detail) {
    audit(actor?.id ?? null, action, "test_mode", null, detail);
    if (action !== "test_mode_enabled" && action !== "test_mode_disabled") return; // změna plateb a obnova jen do auditu
    const mail = emails.testModeChanged(config, { enabled: action === "test_mode_enabled", actorName: detail?.by || "systém", payments: detail?.payments, at: iso(time.now()), appUrl });
    for (const admin of db.prepare("SELECT email FROM users WHERE ',' || roles || ',' LIKE '%,admin,%'").all()) queueEmail(admin.email, "test_mode_changed", mail);
  }
  // Audit změn (jen admin): role, platby, nastavení, zálohy, zadržení, blokace …
  function listAudit(ctx, { limit = 200, action = "" } = {}) {
    requireAdmin(ctx);
    const rows = db.prepare(`SELECT a.*, u.first_name, u.last_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE (? = '' OR a.action = ?) ORDER BY a.id DESC LIMIT ?`).all(String(action), String(action), Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return { events: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actor: r.first_name ? `${r.first_name} ${r.last_name}` : r.actor_user_id ? `#${r.actor_user_id}` : "systém", targetType: r.target_type, targetId: r.target_id, detail: r.detail ? JSON.parse(r.detail) : null })) };
  }

  // role: admin | manager | warden (účty s touto rolí) | member (rybáři bez další role) | "" (všichni).
  const ROLE_FILTERS = {
    admin: "',' || roles || ',' LIKE '%,admin,%'", manager: "',' || roles || ',' LIKE '%,manager,%'",
    warden: "',' || roles || ',' LIKE '%,warden,%'", member: "roles = 'member'"
  };
  function listUsers(ctx, { q = "", role = "" } = {}) {
    requireManager(ctx);
    if (role && !ROLE_FILTERS[role]) throw new ApiError(400, "invalid_roles", "Filtr role musí být admin, manager, warden nebo member.");
    const term = `%${String(q).trim().toLowerCase().slice(0, 100)}%`;
    const search = "(lower(email) LIKE ? OR lower(first_name || ' ' || last_name) LIKE ? OR member_id LIKE ?)";
    const rows = db.prepare(`SELECT * FROM users WHERE ${search}${role ? ` AND ${ROLE_FILTERS[role]}` : ""}
      ORDER BY (roles != 'member') DESC, last_name, first_name LIMIT 100`).all(term, term, term);
    const counts = Object.fromEntries(Object.entries(ROLE_FILTERS).map(([key, sql]) => [key, db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${sql}`).get().n]));
    return { users: rows.map(staffUser), counts };
  }

  // Správce smí měnit jen roli porybného; správce a adminy jmenuje a odvolává admin.
  function setRoles(ctx, targetId, { roles } = {}) {
    const actor = requireManager(ctx);
    if (!Array.isArray(roles) || roles.some((role) => !ROLES.includes(role))) throw new ApiError(400, "invalid_roles", `Role musí být z: ${ROLES.join(", ")}.`);
    return transaction(db, () => {
      const target = userById(Number(targetId));
      if (!target) throw new ApiError(404, "not_found", "Uživatel neexistuje.");
      const before = rolesOf(target);
      const after = ROLES.filter((role) => role === "member" || roles.includes(role));
      const changed = ROLES.filter((role) => before.includes(role) !== after.includes(role));
      for (const role of changed) {
        if (role === "member") continue;
        if (role !== "warden" && !hasRole(actor, "admin")) throw new ApiError(403, "forbidden_role", "Správce a adminy může jmenovat jen admin.");
      }
      if (changed.length && after.some((role) => role !== "member") && !target.email_verified_at) throw new ApiError(409, "user_not_verified", "Uživatel ještě nemá ověřený e-mail.");
      if (before.includes("admin") && !after.includes("admin") && adminCount() <= 1) throw new ApiError(409, "last_admin", "Posledního admina nelze odebrat.");
      if (changed.length) {
        db.prepare("UPDATE users SET roles = ?, updated_at = ? WHERE id = ?").run(after.join(","), iso(time.now()), target.id);
        audit(actor.id, "roles_changed", "user", target.id, { from: before, to: after });
      }
      return { user: staffUser(userById(target.id)) };
    });
  }

  // Admin pozve správce nebo admina: účet jen pro správu (bez rybářských údajů), heslo si nastaví z odkazu.
  function inviteStaff(ctx, input = {}) {
    const actor = requireManager(ctx);
    if (!hasRole(actor, "admin")) throw new ApiError(403, "forbidden_role", "Správce a adminy může zvát jen admin.");
    const email = normalizeEmail(validEmail(input.email));
    const { firstName, lastName } = validName(input.firstName, input.lastName);
    const roles = Array.isArray(input.roles) ? input.roles : [];
    if (!roles.length || roles.some((role) => !STAFF_ROLES.includes(role))) throw new ApiError(400, "invalid_roles", "Zvolte roli správce nebo admin.");
    return transaction(db, () => {
      if (userByEmail(email)) throw new ApiError(409, "email_taken", "Účet s tímto e-mailem už existuje – roli mu přidělte v seznamu uživatelů.");
      const now = iso(time.now());
      const after = ROLES.filter((role) => role === "member" || roles.includes(role));
      // E-mail je ověřený pozvánkou: účet se dá použít jen přes odkaz, který na adresu přijde.
      const result = db.prepare("INSERT INTO users (email, email_verified_at, first_name, last_name, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(email, now, firstName, lastName, after.join(","), now, now);
      const user = userById(Number(result.lastInsertRowid));
      const roleLabel = roles.includes("admin") ? ROLE_NAMES.admin : ROLE_NAMES.manager;
      queueEmail(email, "staff_invite", emails.staffInvite(config, { link: link("invite", issueAuthToken(user, "invite")), minutes: TOKEN_MINUTES.invite, roleLabel }));
      audit(actor.id, "staff_invited", "user", user.id, { roles: after });
      return { user: staffUser(user) };
    });
  }

  // ---------- žádost „Jsem porybný“ a notifikace správcům ----------
  // Žádost z registrace se odešle až po ověření e-mailu. Správce ji vyřídí v portálu (Notifikace), nebo
  // odkazem z e-mailu (stránka request.html s potvrzením; token platí 7 dní a jde použít jen jednou).
  const REQUEST_TOKEN_DAYS = 7;
  function submitWardenRequest(request, user) {
    const now = time.now();
    const token = sec.randomToken();
    db.prepare("UPDATE warden_requests SET status = 'pending', submitted_at = ?, action_token_hash = ?, action_expires_at = ? WHERE id = ?")
      .run(iso(now), sec.sha256(token), iso(new Date(now.getTime() + REQUEST_TOKEN_DAYS * 86_400_000)), request.id);
    audit(user.id, "warden_requested", "user", user.id, { requestId: request.id });
    const page = (action) => `${appUrl}/request.html#t=${token}&a=${action}`;
    const mail = emails.wardenRequest(config, {
      name: `${user.first_name} ${user.last_name}`, email: user.email, memberId: user.member_id, note: request.note || "",
      links: { approve: page("approve"), reject: page("reject"), open: `${appUrl}/manage.html#notifications` }
    });
    for (const to of noticeRecipients(db)) queueEmail(to, "warden_request", mail);
  }
  function requestWarden(ctx, input = {}) {
    const user = requireUser(ctx);
    if (hasRole(user, "warden")) throw new ApiError(409, "already_warden", "Funkci porybného už máte.");
    const note = String(input.note || "").trim().slice(0, 300);
    return transaction(db, () => {
      if (db.prepare("SELECT 1 FROM warden_requests WHERE user_id = ? AND status IN ('pending', 'unverified')").get(user.id)) throw new ApiError(409, "request_pending", "Žádost už čeká na schválení správcem.");
      const id = Number(db.prepare("INSERT INTO warden_requests (user_id, status, note, created_at) VALUES (?, 'unverified', ?, ?)").run(user.id, note || null, iso(time.now())).lastInsertRowid);
      submitWardenRequest(db.prepare("SELECT * FROM warden_requests WHERE id = ?").get(id), user);
      return { user: publicUser(userById(user.id)) };
    });
  }
  function notificationShape(r) {
    const user = userById(r.user_id);
    const by = r.decided_by ? userById(r.decided_by) : null;
    return {
      id: r.id, kind: "warden_request", status: r.status, note: r.note || "", createdAt: r.submitted_at || r.created_at,
      user: user ? { id: user.id, name: `${user.first_name} ${user.last_name}`, email: user.email, memberId: user.member_id || null, roles: rolesOf(user) } : null,
      decidedAt: r.decided_at, decidedBy: by ? `${by.first_name} ${by.last_name}` : r.decided_via === "email" ? "odkazem z e-mailu" : "", decidedVia: r.decided_via || null, decisionNote: r.decision_note || ""
    };
  }
  function listNotifications(ctx) {
    requireManager(ctx);
    const rows = db.prepare("SELECT * FROM warden_requests WHERE status != 'unverified' ORDER BY (status = 'pending') DESC, id DESC LIMIT 200").all();
    return { notifications: rows.map(notificationShape), pending: rows.filter((r) => r.status === "pending").length };
  }
  // Schválení přidá roli porybného; žadatel dostane e-mail s výsledkem.
  function decideRequest(request, action, note, actor, via) {
    if (!["approve", "reject"].includes(action)) throw new ApiError(400, "invalid_action", "Akce musí být approve nebo reject.");
    if (request.status !== "pending") throw new ApiError(409, "already_decided", "Žádost už je vyřízená.");
    const user = userById(request.user_id);
    const now = iso(time.now());
    const status = action === "approve" && user ? "approved" : "rejected";
    const cleanNote = String(note || "").trim().slice(0, 300);
    db.prepare("UPDATE warden_requests SET status = ?, decided_at = ?, decided_by = ?, decided_via = ?, decision_note = ?, action_token_hash = NULL, action_expires_at = NULL WHERE id = ?")
      .run(status, now, actor?.id ?? null, via, cleanNote || null, request.id);
    if (status === "approved" && !hasRole(user, "warden")) {
      const before = rolesOf(user);
      const after = ROLES.filter((role) => role === "warden" || before.includes(role));
      db.prepare("UPDATE users SET roles = ?, updated_at = ? WHERE id = ?").run(after.join(","), now, user.id);
      audit(actor?.id ?? null, "roles_changed", "user", user.id, { from: before, to: after, requestId: request.id, via });
    }
    audit(actor?.id ?? null, status === "approved" ? "warden_request_approved" : "warden_request_rejected", "user", request.user_id, { requestId: request.id, via, note: cleanNote });
    if (user) queueEmail(user.email, `warden_request_${status}`, emails.wardenRequestDecided(config, { approved: status === "approved", note: cleanNote, link: `${appUrl}/` }));
    return notificationShape(db.prepare("SELECT * FROM warden_requests WHERE id = ?").get(request.id));
  }
  function decideNotification(ctx, id, action, { note } = {}) {
    const actor = requireManager(ctx);
    return transaction(db, () => {
      const request = db.prepare("SELECT * FROM warden_requests WHERE id = ? AND status != 'unverified'").get(Number(id));
      if (!request) throw new ApiError(404, "not_found", "Notifikace neexistuje.");
      return { notification: decideRequest(request, action, note, actor, "portal") };
    });
  }
  function requestByToken(token) {
    const row = token ? db.prepare("SELECT * FROM warden_requests WHERE action_token_hash = ?").get(sec.sha256(String(token))) : null;
    if (!row || new Date(row.action_expires_at) <= time.now()) throw new ApiError(400, "invalid_link", "Odkaz je neplatný, vypršel, nebo už je žádost vyřízená. Otevřete notifikace v portálu.");
    return row;
  }
  const viewRequestByToken = ({ token } = {}) => ({ notification: notificationShape(requestByToken(token)) });
  function decideRequestByToken({ token, action, note } = {}) {
    return transaction(db, () => ({ notification: decideRequest(requestByToken(token), String(action || ""), note, null, "email") }));
  }

  // ---------- průvodce prvním spuštěním ----------
  // Dokud není žádný admin, server vypíše do konzole jednorázový odkaz (setup.html#<token>).
  // Kdo nemá přístup ke konzoli serveru, admina nezaloží. Admin vzniká rovnou se zapnutou 2FA.
  const metaGet = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  const metaSet = (key, value) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  const setupNeeded = () => adminCount() === 0;
  function createSetupToken() {
    if (!setupNeeded()) return null;
    const token = sec.randomToken();
    metaSet("setup_token", JSON.stringify({ hash: sec.sha256(token), expiresAt: iso(new Date(time.now().getTime() + SETUP_MINUTES * 60_000)), totpSecret: null }));
    return { token, link: `${appUrl}/setup.html#${token}`, minutes: SETUP_MINUTES };
  }
  function checkSetupToken(token) {
    if (!setupNeeded()) throw new ApiError(404, "setup_closed", "Admin už existuje. Přihlaste se.");
    const state = JSON.parse(metaGet("setup_token") || "null");
    if (!state || !token || sec.sha256(token) !== state.hash || new Date(state.expiresAt) <= time.now()) {
      throw new ApiError(400, "invalid_setup_token", "Odkaz pro založení admina je neplatný nebo vypršel. Restartujte server – vypíše nový.");
    }
    return state;
  }
  const setupStatus = () => ({ needed: setupNeeded() });
  function setupTwoFactor({ token } = {}) {
    const state = checkSetupToken(token);
    state.totpSecret = sec.newTotpSecret();
    metaSet("setup_token", JSON.stringify(state));
    return { secret: state.totpSecret, otpauthUrl: sec.otpauthUrl({ secret: state.totpSecret, account: "admin", issuer: `Místenka ${config.organization.shortName}` }) };
  }
  function completeSetup({ token, email, firstName, lastName, password, otp } = {}) {
    const cleanEmail = normalizeEmail(validEmail(email));
    const names = validName(firstName, lastName);
    const pass = validPassword(password);
    return transaction(db, () => {
      const state = checkSetupToken(token);
      if (!state.totpSecret) throw new ApiError(409, "two_factor_not_setup", "Nejdřív si nastavte ověřovací aplikaci.");
      const step = sec.verifyTotp(state.totpSecret, otp, time.now().getTime());
      if (step === null) throw new ApiError(400, "invalid_otp", "Kód z ověřovací aplikace nesouhlasí.");
      if (userByEmail(cleanEmail)) throw new ApiError(409, "email_taken", "Účet s tímto e-mailem už existuje. Použijte jiný e-mail, nebo účet nejdřív smažte.");
      const now = iso(time.now());
      const result = db.prepare(`INSERT INTO users (email, email_verified_at, password_hash, first_name, last_name, roles, totp_secret, totp_enabled_at, totp_last_step, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'member,admin', ?, ?, ?, ?, ?)`).run(cleanEmail, now, sec.hashPassword(pass), names.firstName, names.lastName, state.totpSecret, now, step, now, now);
      db.prepare("DELETE FROM meta WHERE key = 'setup_token'").run();
      const user = userById(Number(result.lastInsertRowid));
      audit(user.id, "admin_setup", "user", user.id);
      return loggedIn(user);
    });
  }

  // Jen vývoj, testy a příkazová řádka (prvotní admin): bez kontroly oprávnění.
  function forceRoles(email, roles) {
    const user = userByEmail(email);
    if (!user) throw new ApiError(404, "not_found", "Uživatel neexistuje.");
    const after = ROLES.filter((role) => role === "member" || (roles || []).includes(role));
    db.prepare("UPDATE users SET roles = ?, updated_at = ? WHERE id = ?").run(after.join(","), iso(time.now()), user.id);
    audit(null, "roles_forced", "user", user.id, { to: after });
    return staffUser(userById(user.id));
  }

  // Plánovaná úloha: úklid neověřených účtů, prošlých relací a odkazů.
  function cleanup() {
    const now = time.now();
    const unverified = db.prepare("DELETE FROM users WHERE email_verified_at IS NULL AND created_at <= ? AND id NOT IN (SELECT user_id FROM tickets WHERE user_id IS NOT NULL)")
      .run(iso(new Date(now.getTime() - UNVERIFIED_HOURS * 3600_000))).changes;
    db.prepare("DELETE FROM warden_requests WHERE user_id NOT IN (SELECT id FROM users)").run();
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(iso(now));
    db.prepare("DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at <= ?").run(iso(now), iso(new Date(now.getTime() - 86_400_000)));
    return { unverified };
  }

  return {
    resolveSession, register, verifyEmail, login, requestMagicLink, magicLogin, requestPasswordReset, resetPassword, logout,
    me, updateProfile, confirmEmailChange, changePassword, deleteAccount, twoFactorSetup, twoFactorEnable, twoFactorDisable,
    listUsers, setRoles, inviteStaff, requireWarden, requireManager, requireAdmin, listAudit, confirmOtp, notifyAutoRestore, notifyTestMode, forceRoles, cleanup, requireUser,
    setupStatus, createSetupToken, setupTwoFactor, completeSetup,
    requestWarden, listNotifications, decideNotification, viewRequestByToken, decideRequestByToken
  };
}

module.exports = { createAccounts, ROLES, rolesOf, hasRole };
