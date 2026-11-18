"use strict";
// Uživatelské účty, přihlášení a role (B1). Smlouva v docs/API.md, sekce „Účty“.
// Ve WordPressu nahradí uživatele, hesla a relace WP (vlastní role a capability); API zůstává stejné.
const { transaction } = require("./db");
const time = require("./time");
const emails = require("./emails");
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
      createdAt: user.created_at
    };
  }
  const staffUser = (user) => {
    const { hasPassword, mfaRequired: _m, birthDate, ...rest } = publicUser(user);
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
  function register(input = {}) {
    const email = normalizeEmail(validEmail(input.email));
    const memberId = validMemberId(input.memberId);
    const { firstName, lastName } = validName(input.firstName, input.lastName);
    const birthDate = validBirthDate(input.birthDate);
    const password = input.password ? validPassword(input.password) : null;
    if (input.consent !== true) throw new ApiError(400, "consent_required", "Pro registraci je nutné potvrdit souhlas se zpracováním osobních údajů.");
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
      sendVerification(user);
      return { sent: true };
    });
  }

  function verifyEmail({ token } = {}) {
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, "verify_email");
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
    if (user) transaction(db, () => queueEmail(user.email, "magic_link", emails.magicLink(config, { link: link("login", issueAuthToken(user, "magic_link")), minutes: TOKEN_MINUTES.magic_link })));
    return { sent: true };
  }
  function magicLogin({ token, otp } = {}) {
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, "magic_link");
      checkOtp(user, otp); // při chybě kódu odkaz zůstává platný
      useAuthToken(row);
      markVerified(user); // odkaz z e-mailu prokazuje vlastnictví adresy
      return loggedIn(userById(user.id));
    });
  }

  function requestPasswordReset({ email } = {}) {
    validEmail(email);
    const user = userByEmail(email);
    if (user) transaction(db, () => queueEmail(user.email, "password_reset", emails.passwordReset(config, { link: link("reset", issueAuthToken(user, "password_reset")), minutes: TOKEN_MINUTES.password_reset })));
    return { sent: true };
  }
  function resetPassword({ token, password, otp } = {}) {
    const newPassword = validPassword(password);
    return transaction(db, () => {
      const { row, user } = findAuthToken(token, ["password_reset", "invite"]);
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
  // Audit změn (jen admin): role, platby, nastavení, zálohy, zadržení, blokace …
  function listAudit(ctx, { limit = 200, action = "" } = {}) {
    requireAdmin(ctx);
    const rows = db.prepare(`SELECT a.*, u.first_name, u.last_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE (? = '' OR a.action = ?) ORDER BY a.id DESC LIMIT ?`).all(String(action), String(action), Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return { events: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actor: r.first_name ? `${r.first_name} ${r.last_name}` : r.actor_user_id ? `#${r.actor_user_id}` : "systém", targetType: r.target_type, targetId: r.target_id, detail: r.detail ? JSON.parse(r.detail) : null })) };
  }

  function listUsers(ctx, { q = "" } = {}) {
    requireManager(ctx);
    const term = `%${String(q).trim().toLowerCase().slice(0, 100)}%`;
    const rows = db.prepare(`SELECT * FROM users WHERE lower(email) LIKE ? OR lower(first_name || ' ' || last_name) LIKE ? OR member_id LIKE ?
      ORDER BY (roles != 'member') DESC, last_name, first_name LIMIT 100`).all(term, term, term);
    return { users: rows.map(staffUser) };
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
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(iso(now));
    db.prepare("DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at <= ?").run(iso(now), iso(new Date(now.getTime() - 86_400_000)));
    return { unverified };
  }

  return {
    resolveSession, register, verifyEmail, login, requestMagicLink, magicLogin, requestPasswordReset, resetPassword, logout,
    me, updateProfile, confirmEmailChange, changePassword, deleteAccount, twoFactorSetup, twoFactorEnable, twoFactorDisable,
    listUsers, setRoles, inviteStaff, requireWarden, requireManager, requireAdmin, listAudit, forceRoles, cleanup, requireUser,
    setupStatus, createSetupToken, setupTwoFactor, completeSetup
  };
}

module.exports = { createAccounts, ROLES, rolesOf, hasRole };
