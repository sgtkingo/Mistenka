<?php
// Uživatelské účty, přihlášení a role (src/node/lib/accounts.js). Vlastní tabulky pluginu – rybáři nejsou
// uživateli WordPressu. Relace v cookie mistenka_session (na serveru jen hash) + CSRF hlavička.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Accounts
{
    public const ROLES = ['member', 'warden', 'manager', 'admin'];
    private const STAFF_ROLES = ['manager', 'admin'];
    // Před spuštěním služby (první otevřená sezona) se registrovat ani přihlásit nemohou rybáři – jen správa.
    private const NOT_LAUNCHED = 'Místenka zatím nebyla spuštěna – registrace a přihlášení se otevřou s první sezonou.';
    // Při uzavřené sezoně (dnes není otevřená žádná sezona) se přihlásí jen správci a admini.
    private const SEASON_CLOSED = 'Sezona je uzavřená – přihlásit se teď mohou jen správci a admini. Místenku vrátíte i bez přihlášení (kód místenky a číslo legitimace).';
    private const SESSION_DAYS = 30;
    private const STAFF_SESSION_HOURS = 12;
    private const UNVERIFIED_HOURS = 48;
    private const TOKEN_MINUTES = ['verify_email' => 2880, 'magic_link' => 15, 'password_reset' => 60, 'change_email' => 1440, 'invite' => 4320];
    private const SETUP_MINUTES = 60;
    private const ROLE_NAMES = ['manager' => 'správce', 'admin' => 'admin'];
    private const PASSWORD_MIN = 8;

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    public static function rolesOf(?array $user): array
    {
        return array_values(array_filter(explode(',', (string) ($user['roles'] ?? ''))));
    }

    public static function hasRole(?array $user, string $role): bool
    {
        return in_array($role, self::rolesOf($user), true);
    }

    private static function isStaff(?array $user): bool
    {
        foreach (self::STAFF_ROLES as $role) if (self::hasRole($user, $role)) return true;
        return false;
    }

    // Admin musí mít zapnutou 2FA, jinak nesmí nic spravovat.
    private static function mfaRequired(array $user): bool
    {
        return self::hasRole($user, 'admin') && !$user['totp_enabled_at'];
    }

    private static function validPassword($value): string
    {
        $password = $value === null ? '' : Js::str($value);
        $len = Js::len($password);
        if ($len < self::PASSWORD_MIN || $len > 200) throw new ApiError(400, 'weak_password', 'Heslo musí mít alespoň ' . self::PASSWORD_MIN . ' znaků.');
        return $password;
    }

    private function userById($id): ?array
    {
        return Db::row('SELECT * FROM {p}users WHERE id = ?', (int) $id);
    }

    private function userByEmail($email): ?array
    {
        return Db::row('SELECT * FROM {p}users WHERE email = ?', Validate::normalizeEmail($email));
    }

    // ---------- výstupní tvary ----------
    public function publicUser(array $user): array
    {
        return [
            'id' => $user['id'], 'email' => $user['email'], 'firstName' => $user['first_name'], 'lastName' => $user['last_name'],
            'birthDate' => $user['birth_date'] ?: null, 'memberId' => $user['member_id'] ?: null, 'staffOnly' => !$user['member_id'],
            'roles' => self::rolesOf($user), 'emailVerified' => (bool) $user['email_verified_at'], 'hasPassword' => (bool) $user['password_hash'],
            'twoFactor' => (bool) $user['totp_enabled_at'], 'mfaRequired' => self::mfaRequired($user), 'wardenRequest' => $this->latestWardenRequest($user['id']), 'createdAt' => $user['created_at'],
        ];
    }

    // Poslední žádost „Jsem porybný“ (stav pro účet), nebo null.
    private function latestWardenRequest(int $userId): ?array
    {
        $r = Db::row('SELECT * FROM {p}warden_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1', $userId);
        return $r ? ['id' => $r['id'], 'status' => $r['status'], 'createdAt' => $r['created_at'], 'decidedAt' => $r['decided_at'], 'decisionNote' => $r['decision_note'] ?? ''] : null;
    }

    private function staffUser(array $user): array
    {
        $out = $this->publicUser($user);
        unset($out['hasPassword'], $out['mfaRequired'], $out['birthDate'], $out['wardenRequest']);
        return $out;
    }

    // ---------- pomocné ----------
    private function audit($actorId, string $action, string $targetType, $targetId, $detail = null): void
    {
        Db::exec('INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
            Time::nowIso(), $actorId, $action, $targetType, $targetId === null ? null : Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    private function queueEmail(string $to, string $kind, array $mail): void
    {
        $this->app->queueEmail(null, $kind, $to, $mail);
    }

    // Jednorázový odkaz. Předchozí nepoužité odkazy stejného účelu se zneplatní.
    private function issueAuthToken(array $user, string $purpose, ?string $newEmail = null): string
    {
        $now = Time::now();
        Db::exec('DELETE FROM {p}auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL', $user['id'], $purpose);
        $token = Security::randomToken();
        Db::exec('INSERT INTO {p}auth_tokens (token_hash, user_id, purpose, new_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            Security::sha256($token), $user['id'], $purpose, $newEmail, Time::iso($now), Time::iso(Time::addMinutes($now, self::TOKEN_MINUTES[$purpose])));
        return $token;
    }

    private function findAuthToken($token, array $purposes): array
    {
        $row = null;
        if ($token) {
            $placeholders = implode(',', array_fill(0, count($purposes), '?'));
            $row = Db::row("SELECT * FROM {p}auth_tokens WHERE token_hash = ? AND purpose IN ({$placeholders})", Security::sha256(Js::str($token)), ...$purposes);
        }
        if (!$row || $row['used_at'] || Time::msOf($row['expires_at']) <= Time::ms(Time::now())) throw new ApiError(400, 'invalid_link', 'Odkaz je neplatný nebo už vypršel. Nechte si poslat nový.');
        $user = $this->userById($row['user_id']);
        if (!$user) throw new ApiError(400, 'invalid_link', 'Odkaz je neplatný nebo už vypršel. Nechte si poslat nový.');
        return [$row, $user];
    }

    private function useAuthToken(array $row): void
    {
        Db::exec('UPDATE {p}auth_tokens SET used_at = ? WHERE token_hash = ?', Time::nowIso(), $row['token_hash']);
    }

    private function link(string $fragment, string $token): string
    {
        return $this->app->appUrl . '/account.html#' . $fragment . '=' . $token;
    }

    private function sendVerification(array $user): void
    {
        $token = $this->issueAuthToken($user, 'verify_email');
        $this->queueEmail($user['email'], 'account_verify', Emails::accountVerify($this->app->config, $this->link('verify', $token), self::TOKEN_MINUTES['verify_email']));
    }

    // Ověření e-mailu připojí dřívější místenky se stejným e-mailem a číslem legitimace.
    private function markVerified(array $user): void
    {
        if ($user['email_verified_at']) return;
        $now = Time::nowIso();
        Db::exec('UPDATE {p}users SET email_verified_at = ?, updated_at = ? WHERE id = ?', $now, $now, $user['id']);
        if ($user['member_id']) Db::exec('UPDATE {p}tickets SET user_id = ? WHERE user_id IS NULL AND member_id = ? AND LOWER(email) = ?', $user['id'], $user['member_id'], $user['email']);
        foreach (Db::all("SELECT * FROM {p}warden_requests WHERE user_id = ? AND status = 'unverified'", $user['id']) as $request) $this->submitWardenRequest($request, $this->userById($user['id']));
    }

    // 2FA: pokud je zapnutá, je kód povinný při každém přihlášení.
    private function checkOtp(array $user, $otp): void
    {
        if (!$user['totp_enabled_at']) return;
        if (trim(Js::s($otp)) === '') throw new ApiError(401, 'otp_required', 'Zadejte šestimístný kód z ověřovací aplikace.');
        $step = Security::verifyTotp($user['totp_secret'], $otp, Time::ms(Time::now()), $user['totp_last_step']);
        if ($step === null) throw new ApiError(401, 'invalid_otp', 'Kód z ověřovací aplikace nesouhlasí.');
        Db::exec('UPDATE {p}users SET totp_last_step = ? WHERE id = ?', $step, $user['id']);
    }

    private function ensureMemberIdFree(string $memberId, int $exceptUserId = 0): void
    {
        if (Db::row('SELECT 1 AS x FROM {p}users WHERE member_id = ? AND id != ?', $memberId, $exceptUserId)) {
            throw new ApiError(409, 'member_id_taken', 'Toto číslo členské legitimace už patří jinému účtu. Pokud je vaše, kontaktujte správce.');
        }
    }

    // ---------- relace ----------
    private function createSession(array $user): array
    {
        $now = Time::now();
        $token = Security::randomToken();
        $csrf = Security::randomToken(18);
        $seconds = self::isStaff($user) ? self::STAFF_SESSION_HOURS * 3600 : self::SESSION_DAYS * 86400;
        Db::exec('INSERT INTO {p}sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
            Security::sha256($token), $user['id'], $csrf, Time::iso($now), Time::iso(Time::fromMs(Time::ms($now) + $seconds * 1000)));
        return ['token' => $token, 'csrf' => $csrf, 'maxAgeSeconds' => $seconds];
    }

    // ['user' => …, 'session' => …] pro token z cookie, nebo null.
    public function resolveSession(string $token): ?array
    {
        if ($token === '') return null;
        $session = Db::row('SELECT * FROM {p}sessions WHERE token_hash = ?', Security::sha256($token));
        if (!$session) return null;
        if (Time::msOf($session['expires_at']) <= Time::ms(Time::now())) {
            Db::exec('DELETE FROM {p}sessions WHERE token_hash = ?', $session['token_hash']);
            return null;
        }
        $user = $this->userById($session['user_id']);
        return $user ? ['user' => $user, 'session' => $session] : null;
    }

    private function loggedIn(array $user): array
    {
        return ['user' => $this->publicUser($user), 'session' => $this->createSession($user)];
    }

    public function requireUser(?array $ctx): array
    {
        if (empty($ctx['user'])) throw new ApiError(401, 'unauthorized', 'Pro tuto akci se přihlaste.');
        return $ctx['user'];
    }

    // ---------- registrace a přihlášení ----------
    // Kdo se smí přihlásit: správa vždy; rybáři jen po spuštění služby a při otevřené sezoně.
    private static function closedReason(): ?array
    {
        if (!Db::serviceLaunched()) return ['service_not_launched', self::NOT_LAUNCHED];
        if (!Db::seasonOpen(Time::pragueToday())) return ['season_closed', self::SEASON_CLOSED];
        return null;
    }

    private static function requireLaunchedFor(array $user): void
    {
        $closed = self::isStaff($user) ? null : self::closedReason();
        if ($closed) throw new ApiError(409, $closed[0], $closed[1]);
    }

    public function register(array $input): array
    {
        $closed = self::closedReason();
        if ($closed) throw new ApiError(409, $closed[0], $closed[1]);
        $email = Validate::normalizeEmail(Validate::email($input['email'] ?? null));
        $memberId = Validate::memberId($input['memberId'] ?? null);
        [$firstName, $lastName] = Validate::name($input['firstName'] ?? null, $input['lastName'] ?? null);
        $birthDate = Validate::birthDate($input['birthDate'] ?? null);
        $password = Js::truthy($input['password'] ?? null) ? self::validPassword($input['password']) : null;
        $wardenRequest = ($input['wardenRequest'] ?? null) === true;
        if (($input['consent'] ?? null) !== true) throw new ApiError(400, 'consent_required', 'Pro registraci potvrďte, že jste se seznámili se zásadami zpracování osobních údajů.');
        return Db::transaction(function () use ($email, $memberId, $firstName, $lastName, $birthDate, $password, $wardenRequest) {
            $now = Time::nowIso();
            $existing = $this->userByEmail($email);
            // Existující ověřený účet: neprozrazujeme to, majitel dostane e-mail.
            if ($existing && $existing['email_verified_at']) {
                $this->queueEmail($email, 'account_exists', Emails::accountExists($this->app->config, $this->app->appUrl . '/account.html'));
                return ['sent' => true];
            }
            $this->ensureMemberIdFree($memberId, $existing['id'] ?? 0);
            $hash = $password !== null ? Security::hashPassword($password) : null;
            if ($existing) {
                Db::exec('UPDATE {p}users SET first_name = ?, last_name = ?, birth_date = ?, member_id = ?, password_hash = ?, updated_at = ? WHERE id = ?', $firstName, $lastName, $birthDate, $memberId, $hash, $now, $existing['id']);
                $user = $this->userById($existing['id']);
            } else {
                $id = Db::insert("INSERT INTO {p}users (email, password_hash, first_name, last_name, birth_date, member_id, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?)", $email, $hash, $firstName, $lastName, $birthDate, $memberId, $now, $now);
                $user = $this->userById($id);
            }
            Db::exec("DELETE FROM {p}warden_requests WHERE user_id = ? AND status = 'unverified'", $user['id']);
            if ($wardenRequest) Db::exec("INSERT INTO {p}warden_requests (user_id, status, created_at) VALUES (?, 'unverified', ?)", $user['id'], $now);
            $this->sendVerification($user);
            return ['sent' => true];
        });
    }

    public function verifyEmail(array $input): array
    {
        return Db::transaction(function () use ($input) {
            [$row, $user] = $this->findAuthToken($input['token'] ?? null, ['verify_email']);
            self::requireLaunchedFor($user);
            $this->useAuthToken($row);
            $this->markVerified($user);
            $this->audit($user['id'], 'account_verified', 'user', $user['id']);
            return $this->loggedIn($this->userById($user['id']));
        });
    }

    public function login(array $input): array
    {
        $email = $input['email'] ?? null;
        $user = $email ? $this->userByEmail($email) : null;
        $ok = Security::verifyPassword(Js::s($input['password'] ?? null), $user['password_hash'] ?? Security::dummyHash());
        if (!$user || !$user['password_hash'] || !$ok) throw new ApiError(401, 'invalid_credentials', 'Nesprávný e-mail nebo heslo.');
        self::requireLaunchedFor($user);
        if (!$user['email_verified_at']) {
            Db::transaction(fn() => $this->sendVerification($user));
            throw new ApiError(403, 'email_not_verified', 'E-mail ještě není ověřený. Poslali jsme vám nový ověřovací odkaz.');
        }
        return Db::transaction(function () use ($user, $input) {
            $this->checkOtp($user, $input['otp'] ?? null);
            return $this->loggedIn($user);
        });
    }

    // Odkaz pro přihlášení bez hesla. Odpověď je vždy stejná, aby neprozradila existenci účtu.
    public function requestMagicLink(array $input): array
    {
        Validate::email($input['email'] ?? null);
        $user = $this->userByEmail($input['email']);
        if ($user && (self::isStaff($user) || !self::closedReason())) Db::transaction(fn() => $this->queueEmail($user['email'], 'magic_link', Emails::magicLink($this->app->config, $this->link('login', $this->issueAuthToken($user, 'magic_link')), self::TOKEN_MINUTES['magic_link'])));
        return ['sent' => true];
    }

    public function magicLogin(array $input): array
    {
        return Db::transaction(function () use ($input) {
            [$row, $user] = $this->findAuthToken($input['token'] ?? null, ['magic_link']);
            self::requireLaunchedFor($user);
            $this->checkOtp($user, $input['otp'] ?? null); // při chybě kódu odkaz zůstává platný
            $this->useAuthToken($row);
            $this->markVerified($user); // odkaz z e-mailu prokazuje vlastnictví adresy
            return $this->loggedIn($this->userById($user['id']));
        });
    }

    public function requestPasswordReset(array $input): array
    {
        Validate::email($input['email'] ?? null);
        $user = $this->userByEmail($input['email']);
        if ($user && (self::isStaff($user) || !self::closedReason())) Db::transaction(fn() => $this->queueEmail($user['email'], 'password_reset', Emails::passwordReset($this->app->config, $this->link('reset', $this->issueAuthToken($user, 'password_reset')), self::TOKEN_MINUTES['password_reset'])));
        return ['sent' => true];
    }

    public function resetPassword(array $input): array
    {
        $newPassword = self::validPassword($input['password'] ?? null);
        return Db::transaction(function () use ($input, $newPassword) {
            [$row, $user] = $this->findAuthToken($input['token'] ?? null, ['password_reset', 'invite']);
            self::requireLaunchedFor($user);
            $this->checkOtp($user, $input['otp'] ?? null);
            $this->useAuthToken($row);
            Db::exec('UPDATE {p}users SET password_hash = ?, updated_at = ? WHERE id = ?', Security::hashPassword($newPassword), Time::nowIso(), $user['id']);
            Db::exec('DELETE FROM {p}sessions WHERE user_id = ?', $user['id']); // odhlásit všechna zařízení
            $this->markVerified($user);
            $this->audit($user['id'], 'password_reset', 'user', $user['id']);
            return $this->loggedIn($this->userById($user['id']));
        });
    }

    public function logout(string $token): array
    {
        if ($token !== '') Db::exec('DELETE FROM {p}sessions WHERE token_hash = ?', Security::sha256($token));
        return ['ok' => true];
    }

    // ---------- vlastní účet ----------
    public function me(?array $ctx): array
    {
        return ['user' => !empty($ctx['user']) ? $this->publicUser($ctx['user']) : null, 'csrf' => $ctx['session']['csrf'] ?? null];
    }

    public function updateProfile(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        // Rybářské údaje jsou povinné pro běžného uživatele; účet správce je mít nemusí.
        $fisher = !self::isStaff($user);
        $memberInput = array_key_exists('memberId', $input) ? $input['memberId'] : $user['member_id'];
        $birthInput = array_key_exists('birthDate', $input) ? $input['birthDate'] : $user['birth_date'];
        $memberId = $fisher || trim(Js::s($memberInput)) !== '' ? Validate::memberId($memberInput) : null;
        $birthDate = $fisher || trim(Js::s($birthInput)) !== '' ? Validate::birthDate($birthInput) : null;
        [$firstName, $lastName] = Validate::name($input['firstName'] ?? $user['first_name'], $input['lastName'] ?? $user['last_name']);
        $email = array_key_exists('email', $input) ? Validate::normalizeEmail(Validate::email($input['email'])) : $user['email'];
        return Db::transaction(function () use ($user, $memberId, $birthDate, $firstName, $lastName, $email) {
            if ($memberId) $this->ensureMemberIdFree($memberId, $user['id']);
            Db::exec('UPDATE {p}users SET first_name = ?, last_name = ?, birth_date = ?, member_id = ?, updated_at = ? WHERE id = ?', $firstName, $lastName, $birthDate, $memberId, Time::nowIso(), $user['id']);
            $pending = null;
            if ($email !== $user['email']) {
                if ($this->userByEmail($email)) throw new ApiError(409, 'email_taken', 'Tento e-mail už používá jiný účet.');
                $token = $this->issueAuthToken($user, 'change_email', $email);
                $this->queueEmail($email, 'email_change', Emails::emailChange($this->app->config, $this->link('email', $token), self::TOKEN_MINUTES['change_email']));
                $pending = $email;
            }
            return ['user' => $this->publicUser($this->userById($user['id'])), 'emailChangePending' => $pending];
        });
    }

    public function confirmEmailChange(array $input): array
    {
        return Db::transaction(function () use ($input) {
            [$row, $user] = $this->findAuthToken($input['token'] ?? null, ['change_email']);
            if ($this->userByEmail($row['new_email'])) throw new ApiError(409, 'email_taken', 'Tento e-mail už používá jiný účet.');
            $this->useAuthToken($row);
            $now = Time::nowIso();
            Db::exec('UPDATE {p}users SET email = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', $row['new_email'], $now, $now, $user['id']);
            $this->audit($user['id'], 'email_changed', 'user', $user['id'], ['from' => $user['email'], 'to' => $row['new_email']]);
            return ['user' => $this->publicUser($this->userById($user['id']))];
        });
    }

    public function changePassword(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        $password = self::validPassword($input['newPassword'] ?? null);
        if ($user['password_hash'] && !Security::verifyPassword(Js::s($input['currentPassword'] ?? null), $user['password_hash'])) throw new ApiError(400, 'wrong_password', 'Současné heslo nesouhlasí.');
        return Db::transaction(function () use ($user, $password, $ctx) {
            Db::exec('UPDATE {p}users SET password_hash = ?, updated_at = ? WHERE id = ?', Security::hashPassword($password), Time::nowIso(), $user['id']);
            Db::exec('DELETE FROM {p}sessions WHERE user_id = ? AND token_hash != ?', $user['id'], $ctx['session']['token_hash']); // ostatní zařízení odhlásit
            $this->audit($user['id'], 'password_changed', 'user', $user['id']);
            return ['user' => $this->publicUser($this->userById($user['id']))];
        });
    }

    public function adminCount(): int
    {
        return (int) Db::val("SELECT COUNT(*) AS n FROM {p}users WHERE FIND_IN_SET('admin', roles) > 0");
    }

    // Smazání účtu. Místenky zůstávají kvůli evidenci, jen se odpojí od účtu.
    public function deleteAccount(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        if (($input['confirm'] ?? null) !== true) throw new ApiError(400, 'confirm_required', 'Potvrďte smazání účtu.');
        if ($user['password_hash'] && !Security::verifyPassword(Js::s($input['password'] ?? null), $user['password_hash'])) throw new ApiError(400, 'wrong_password', 'Heslo nesouhlasí.');
        return Db::transaction(function () use ($user) {
            if (self::hasRole($user, 'admin') && $this->adminCount() <= 1) throw new ApiError(409, 'last_admin', 'Jste jediný admin. Před smazáním účtu jmenujte jiného admina.');
            Db::exec('UPDATE {p}tickets SET user_id = NULL WHERE user_id = ?', $user['id']);
            Db::exec('UPDATE {p}audit_events SET actor_user_id = NULL WHERE actor_user_id = ?', $user['id']);
            Db::exec('DELETE FROM {p}sessions WHERE user_id = ?', $user['id']);
            Db::exec('DELETE FROM {p}auth_tokens WHERE user_id = ?', $user['id']);
            Db::exec('DELETE FROM {p}warden_requests WHERE user_id = ?', $user['id']);
            Db::exec('DELETE FROM {p}users WHERE id = ?', $user['id']);
            $this->audit(null, 'account_deleted', 'user', $user['id']);
            $this->queueEmail($user['email'], 'account_deleted', Emails::accountDeleted($this->app->config));
            return ['deleted' => true];
        });
    }

    // ---------- 2FA (TOTP) ----------
    public function twoFactorSetup(?array $ctx): array
    {
        $user = $this->requireUser($ctx);
        if ($user['totp_enabled_at']) throw new ApiError(409, 'two_factor_enabled', 'Dvoufázové ověření už máte zapnuté.');
        $secret = Security::newTotpSecret();
        Db::exec('UPDATE {p}users SET totp_secret = ?, updated_at = ? WHERE id = ?', $secret, Time::nowIso(), $user['id']);
        return ['secret' => $secret, 'otpauthUrl' => Security::otpauthUrl($secret, $user['email'], 'Místenka ' . $this->app->config['organization']['shortName'])];
    }

    public function twoFactorEnable(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        if ($user['totp_enabled_at']) throw new ApiError(409, 'two_factor_enabled', 'Dvoufázové ověření už máte zapnuté.');
        if (!$user['totp_secret']) throw new ApiError(409, 'two_factor_not_setup', 'Nejdřív si vygenerujte klíč pro ověřovací aplikaci.');
        $step = Security::verifyTotp($user['totp_secret'], $input['otp'] ?? null, Time::ms(Time::now()));
        if ($step === null) throw new ApiError(400, 'invalid_otp', 'Kód z ověřovací aplikace nesouhlasí.');
        $now = Time::nowIso();
        Db::exec('UPDATE {p}users SET totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?', $now, $step, $now, $user['id']);
        $this->audit($user['id'], 'two_factor_enabled', 'user', $user['id']);
        return ['user' => $this->publicUser($this->userById($user['id']))];
    }

    public function twoFactorDisable(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        if (!$user['totp_enabled_at']) throw new ApiError(409, 'two_factor_disabled', 'Dvoufázové ověření nemáte zapnuté.');
        if (self::hasRole($user, 'admin')) throw new ApiError(409, 'two_factor_required', 'Admin musí mít dvoufázové ověření zapnuté.');
        $step = Security::verifyTotp($user['totp_secret'], $input['otp'] ?? null, Time::ms(Time::now()), $user['totp_last_step']);
        if ($step === null) throw new ApiError(400, 'invalid_otp', 'Kód z ověřovací aplikace nesouhlasí.');
        Db::exec('UPDATE {p}users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', Time::nowIso(), $user['id']);
        $this->audit($user['id'], 'two_factor_disabled', 'user', $user['id']);
        return ['user' => $this->publicUser($this->userById($user['id']))];
    }

    // ---------- oprávnění ----------
    public function requireManager(?array $ctx): array
    {
        $user = $this->requireUser($ctx);
        if (!self::isStaff($user)) throw new ApiError(403, 'forbidden_role', 'Na tuto akci nemáte oprávnění.');
        if (self::mfaRequired($user)) throw new ApiError(403, 'mfa_required', 'Nejdřív si v účtu zapněte dvoufázové ověření (2FA).');
        return $user;
    }

    public function requireWarden(?array $ctx): array
    {
        $user = $this->requireUser($ctx);
        if (!self::hasRole($user, 'warden')) throw new ApiError(403, 'forbidden_role', 'Plnou kontrolu a zadržení smí jen porybný.');
        if (self::mfaRequired($user)) throw new ApiError(403, 'mfa_required', 'Nejdřív si v účtu zapněte dvoufázové ověření (2FA).');
        return $user;
    }

    public function requireAdmin(?array $ctx): array
    {
        $user = $this->requireManager($ctx);
        if (!self::hasRole($user, 'admin')) throw new ApiError(403, 'forbidden_role', 'Tuto část spravuje jen admin.');
        return $user;
    }

    // Citlivá akce (obnova databáze): znovu ověřit kód 2FA.
    public function confirmOtp(?array $ctx, $otp): array
    {
        $user = $this->requireAdmin($ctx);
        Db::transaction(fn() => $this->checkOtp($this->userById($user['id']), $otp));
        return $user;
    }

    // Audit změn (jen admin).
    public function listAudit(?array $ctx, $limit, string $action): array
    {
        $this->requireAdmin($ctx);
        $n = Js::number($limit);
        $limitValue = (int) min(max(is_nan($n) || !$n ? 200 : $n, 1), 1000);
        $rows = Db::all("SELECT a.*, u.first_name, u.last_name FROM {p}audit_events a LEFT JOIN {p}users u ON u.id = a.actor_user_id WHERE (? = '' OR a.action = ?) ORDER BY a.id DESC LIMIT ?", $action, $action, $limitValue);
        return ['events' => array_map(fn($r) => [
            'id' => $r['id'], 'at' => $r['at'], 'action' => $r['action'],
            'actor' => $r['first_name'] ? "{$r['first_name']} {$r['last_name']}" : ($r['actor_user_id'] ? '#' . $r['actor_user_id'] : 'systém'),
            'targetType' => $r['target_type'], 'targetId' => $r['target_id'], 'detail' => $r['detail'] ? json_decode($r['detail'], true) : null,
        ], $rows)];
    }

    // role: admin | manager | warden (účty s touto rolí) | member (rybáři bez další role) | "" (všichni).
    private const ROLE_FILTERS = ['admin' => "FIND_IN_SET('admin', roles) > 0", 'manager' => "FIND_IN_SET('manager', roles) > 0", 'warden' => "FIND_IN_SET('warden', roles) > 0", 'member' => "roles = 'member'"];

    public function listUsers(?array $ctx, string $q, string $role = ''): array
    {
        $this->requireManager($ctx);
        if ($role !== '' && !isset(self::ROLE_FILTERS[$role])) throw new ApiError(400, 'invalid_roles', 'Filtr role musí být admin, manager, warden nebo member.');
        $term = '%' . Js::slice(Js::lower(trim($q)), 0, 100) . '%';
        $filter = $role !== '' ? ' AND ' . self::ROLE_FILTERS[$role] : '';
        $rows = Db::all("SELECT * FROM {p}users WHERE (LOWER(email) LIKE ? OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE ? OR member_id LIKE ?){$filter} ORDER BY (roles != 'member') DESC, last_name, first_name LIMIT 100", $term, $term, $term);
        $counts = [];
        foreach (self::ROLE_FILTERS as $key => $sql) $counts[$key] = (int) Db::val("SELECT COUNT(*) AS n FROM {p}users WHERE {$sql}");
        return ['users' => array_map([$this, 'staffUser'], $rows), 'counts' => $counts];
    }

    // Správce smí měnit jen roli porybného; správce a adminy jmenuje a odvolává admin.
    public function setRoles(?array $ctx, $targetId, array $input): array
    {
        $actor = $this->requireManager($ctx);
        $roles = $input['roles'] ?? null;
        if (!is_array($roles) || Js::isAssoc($roles) && $roles) throw new ApiError(400, 'invalid_roles', 'Role musí být z: ' . implode(', ', self::ROLES) . '.');
        foreach ($roles as $role) if (!in_array($role, self::ROLES, true)) throw new ApiError(400, 'invalid_roles', 'Role musí být z: ' . implode(', ', self::ROLES) . '.');
        return Db::transaction(function () use ($actor, $targetId, $roles) {
            $target = $this->userById($targetId);
            if (!$target) throw new ApiError(404, 'not_found', 'Uživatel neexistuje.');
            $before = self::rolesOf($target);
            $after = array_values(array_filter(self::ROLES, fn($r) => $r === 'member' || in_array($r, $roles, true)));
            $changed = array_values(array_filter(self::ROLES, fn($r) => in_array($r, $before, true) !== in_array($r, $after, true)));
            foreach ($changed as $role) {
                if ($role === 'member') continue;
                if ($role !== 'warden' && !self::hasRole($actor, 'admin')) throw new ApiError(403, 'forbidden_role', 'Správce a adminy může jmenovat jen admin.');
            }
            $nonMember = array_filter($after, fn($r) => $r !== 'member');
            if ($changed && $nonMember && !$target['email_verified_at']) throw new ApiError(409, 'user_not_verified', 'Uživatel ještě nemá ověřený e-mail.');
            if (in_array('admin', $before, true) && !in_array('admin', $after, true) && $this->adminCount() <= 1) throw new ApiError(409, 'last_admin', 'Posledního admina nelze odebrat.');
            if ($changed) {
                Db::exec('UPDATE {p}users SET roles = ?, updated_at = ? WHERE id = ?', implode(',', $after), Time::nowIso(), $target['id']);
                $this->audit($actor['id'], 'roles_changed', 'user', $target['id'], ['from' => $before, 'to' => $after]);
            }
            return ['user' => $this->staffUser($this->userById($target['id']))];
        });
    }

    // Admin pozve správce nebo admina: účet jen pro správu, heslo si nastaví z odkazu.
    public function inviteStaff(?array $ctx, array $input): array
    {
        $actor = $this->requireManager($ctx);
        if (!self::hasRole($actor, 'admin')) throw new ApiError(403, 'forbidden_role', 'Správce a adminy může zvát jen admin.');
        $email = Validate::normalizeEmail(Validate::email($input['email'] ?? null));
        [$firstName, $lastName] = Validate::name($input['firstName'] ?? null, $input['lastName'] ?? null);
        $roles = is_array($input['roles'] ?? null) ? $input['roles'] : [];
        $invalid = !$roles;
        foreach ($roles as $role) if (!in_array($role, self::STAFF_ROLES, true)) $invalid = true;
        if ($invalid) throw new ApiError(400, 'invalid_roles', 'Zvolte roli správce nebo admin.');
        return Db::transaction(function () use ($actor, $email, $firstName, $lastName, $roles) {
            if ($this->userByEmail($email)) throw new ApiError(409, 'email_taken', 'Účet s tímto e-mailem už existuje – roli mu přidělte v seznamu uživatelů.');
            $now = Time::nowIso();
            $after = array_values(array_filter(self::ROLES, fn($r) => $r === 'member' || in_array($r, $roles, true)));
            // E-mail je ověřený pozvánkou: účet se dá použít jen přes odkaz, který na adresu přijde.
            $id = Db::insert('INSERT INTO {p}users (email, email_verified_at, first_name, last_name, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', $email, $now, $firstName, $lastName, implode(',', $after), $now, $now);
            $user = $this->userById($id);
            $roleLabel = in_array('admin', $roles, true) ? self::ROLE_NAMES['admin'] : self::ROLE_NAMES['manager'];
            $this->queueEmail($email, 'staff_invite', Emails::staffInvite($this->app->config, $this->link('invite', $this->issueAuthToken($user, 'invite')), self::TOKEN_MINUTES['invite'], $roleLabel));
            $this->audit($actor['id'], 'staff_invited', 'user', $user['id'], ['roles' => $after]);
            return ['user' => $this->staffUser($user)];
        });
    }


    // ---------- žádost „Jsem porybný“ a notifikace správcům ----------
    // Žádost z registrace se odešle až po ověření e-mailu. Správce ji vyřídí v portálu (Notifikace), nebo
    // odkazem z e-mailu (stránka request.html s potvrzením; token platí 7 dní a jde použít jen jednou).
    private const REQUEST_TOKEN_DAYS = 7;

    private function submitWardenRequest(array $request, array $user): void
    {
        $now = Time::now();
        $token = Security::randomToken();
        Db::exec("UPDATE {p}warden_requests SET status = 'pending', submitted_at = ?, action_token_hash = ?, action_expires_at = ? WHERE id = ?",
            Time::iso($now), Security::sha256($token), Time::iso(Time::fromMs(Time::ms($now) + self::REQUEST_TOKEN_DAYS * 86400000)), $request['id']);
        $this->audit($user['id'], 'warden_requested', 'user', $user['id'], ['requestId' => $request['id']]);
        $page = fn(string $action) => $this->app->appUrl . '/request.html#t=' . $token . '&a=' . $action;
        $mail = Emails::wardenRequest($this->app->config, [
            'name' => "{$user['first_name']} {$user['last_name']}", 'email' => $user['email'], 'memberId' => $user['member_id'] ?? '', 'note' => $request['note'] ?? '',
            'links' => ['approve' => $page('approve'), 'reject' => $page('reject'), 'open' => $this->app->appUrl . '/manage.html#notifications'],
        ]);
        foreach (Mailer::noticeRecipients() as $to) $this->queueEmail($to, 'warden_request', $mail);
    }

    public function requestWarden(?array $ctx, array $input): array
    {
        $user = $this->requireUser($ctx);
        if (self::hasRole($user, 'warden')) throw new ApiError(409, 'already_warden', 'Funkci porybného už máte.');
        $note = Js::slice(trim(Js::s($input['note'] ?? null)), 0, 300);
        return Db::transaction(function () use ($user, $note) {
            if (Db::row("SELECT 1 AS x FROM {p}warden_requests WHERE user_id = ? AND status IN ('pending', 'unverified')", $user['id'])) throw new ApiError(409, 'request_pending', 'Žádost už čeká na schválení správcem.');
            $id = Db::insert("INSERT INTO {p}warden_requests (user_id, status, note, created_at) VALUES (?, 'unverified', ?, ?)", $user['id'], $note !== '' ? $note : null, Time::nowIso());
            $this->submitWardenRequest(Db::row('SELECT * FROM {p}warden_requests WHERE id = ?', $id), $user);
            return ['user' => $this->publicUser($this->userById($user['id']))];
        });
    }

    private function notificationShape(array $r): array
    {
        $user = $this->userById($r['user_id']);
        $by = $r['decided_by'] ? $this->userById($r['decided_by']) : null;
        return [
            'id' => $r['id'], 'kind' => 'warden_request', 'status' => $r['status'], 'note' => $r['note'] ?? '', 'createdAt' => $r['submitted_at'] ?: $r['created_at'],
            'user' => $user ? ['id' => $user['id'], 'name' => "{$user['first_name']} {$user['last_name']}", 'email' => $user['email'], 'memberId' => $user['member_id'] ?: null, 'roles' => self::rolesOf($user)] : null,
            'decidedAt' => $r['decided_at'], 'decidedBy' => $by ? "{$by['first_name']} {$by['last_name']}" : ($r['decided_via'] === 'email' ? 'odkazem z e-mailu' : ''),
            'decidedVia' => $r['decided_via'] ?: null, 'decisionNote' => $r['decision_note'] ?? '',
        ];
    }

    public function listNotifications(?array $ctx): array
    {
        $this->requireManager($ctx);
        $rows = Db::all("SELECT * FROM {p}warden_requests WHERE status != 'unverified' ORDER BY (status = 'pending') DESC, id DESC LIMIT 200");
        return ['notifications' => array_map([$this, 'notificationShape'], $rows), 'pending' => count(array_filter($rows, fn($r) => $r['status'] === 'pending'))];
    }

    // Schválení přidá roli porybného; žadatel dostane e-mail s výsledkem.
    private function decideRequest(array $request, string $action, $note, ?array $actor, string $via): array
    {
        if (!in_array($action, ['approve', 'reject'], true)) throw new ApiError(400, 'invalid_action', 'Akce musí být approve nebo reject.');
        if ($request['status'] !== 'pending') throw new ApiError(409, 'already_decided', 'Žádost už je vyřízená.');
        $user = $this->userById($request['user_id']);
        $now = Time::nowIso();
        $status = $action === 'approve' && $user ? 'approved' : 'rejected';
        $cleanNote = Js::slice(trim(Js::s($note)), 0, 300);
        $actorId = $actor['id'] ?? null;
        Db::exec('UPDATE {p}warden_requests SET status = ?, decided_at = ?, decided_by = ?, decided_via = ?, decision_note = ?, action_token_hash = NULL, action_expires_at = NULL WHERE id = ?',
            $status, $now, $actorId, $via, $cleanNote !== '' ? $cleanNote : null, $request['id']);
        if ($status === 'approved' && !self::hasRole($user, 'warden')) {
            $before = self::rolesOf($user);
            $after = array_values(array_filter(self::ROLES, fn($r) => $r === 'warden' || in_array($r, $before, true)));
            Db::exec('UPDATE {p}users SET roles = ?, updated_at = ? WHERE id = ?', implode(',', $after), $now, $user['id']);
            $this->audit($actorId, 'roles_changed', 'user', $user['id'], ['from' => $before, 'to' => $after, 'requestId' => $request['id'], 'via' => $via]);
        }
        $this->audit($actorId, $status === 'approved' ? 'warden_request_approved' : 'warden_request_rejected', 'user', $request['user_id'], ['requestId' => $request['id'], 'via' => $via, 'note' => $cleanNote]);
        if ($user) $this->queueEmail($user['email'], 'warden_request_' . $status, Emails::wardenRequestDecided($this->app->config, $status === 'approved', $cleanNote, $this->app->appUrl . '/'));
        return $this->notificationShape(Db::row('SELECT * FROM {p}warden_requests WHERE id = ?', $request['id']));
    }

    public function decideNotification(?array $ctx, $id, string $action, array $input): array
    {
        $actor = $this->requireManager($ctx);
        return Db::transaction(function () use ($actor, $id, $action, $input) {
            $request = Db::row("SELECT * FROM {p}warden_requests WHERE id = ? AND status != 'unverified'", (int) $id);
            if (!$request) throw new ApiError(404, 'not_found', 'Notifikace neexistuje.');
            return ['notification' => $this->decideRequest($request, $action, $input['note'] ?? null, $actor, 'portal')];
        });
    }

    private function requestByToken($token): array
    {
        $row = Js::truthy($token) ? Db::row('SELECT * FROM {p}warden_requests WHERE action_token_hash = ?', Security::sha256(Js::str($token))) : null;
        if (!$row || Time::msOf($row['action_expires_at']) <= Time::ms(Time::now())) throw new ApiError(400, 'invalid_link', 'Odkaz je neplatný, vypršel, nebo už je žádost vyřízená. Otevřete notifikace v portálu.');
        return $row;
    }

    public function viewRequestByToken(array $input): array
    {
        return ['notification' => $this->notificationShape($this->requestByToken($input['token'] ?? null))];
    }

    public function decideRequestByToken(array $input): array
    {
        return Db::transaction(fn() => ['notification' => $this->decideRequest($this->requestByToken($input['token'] ?? null), Js::s($input['action'] ?? null), $input['note'] ?? null, null, 'email')]);
    }

    // ---------- průvodce prvním spuštěním ----------
    // Dokud není žádný admin, administrátor webu vygeneruje v administraci WordPressu (Nastavení → Místenka)
    // jednorázový odkaz setup.html#<token>. Admin Místenky vzniká rovnou se zapnutou 2FA.
    public function setupNeeded(): bool
    {
        return $this->adminCount() === 0;
    }

    public function createSetupToken(): ?array
    {
        if (!$this->setupNeeded()) return null;
        $token = Security::randomToken();
        Db::metaSet('setup_token', wp_json_encode(['hash' => Security::sha256($token), 'expiresAt' => Time::iso(Time::addMinutes(Time::now(), self::SETUP_MINUTES)), 'totpSecret' => null]));
        return ['token' => $token, 'link' => $this->app->appUrl . '/setup.html#' . $token, 'minutes' => self::SETUP_MINUTES];
    }

    private function checkSetupToken($token): array
    {
        if (!$this->setupNeeded()) throw new ApiError(404, 'setup_closed', 'Admin už existuje. Přihlaste se.');
        $state = json_decode(Db::metaGet('setup_token') ?: 'null', true);
        if (!$state || !$token || !hash_equals($state['hash'], Security::sha256(Js::str($token))) || Time::msOf($state['expiresAt']) <= Time::ms(Time::now())) {
            throw new ApiError(400, 'invalid_setup_token', 'Odkaz pro založení admina je neplatný nebo vypršel. Vygenerujte nový v administraci WordPressu (Nastavení → Místenka).');
        }
        return $state;
    }

    public function setupStatus(): array
    {
        return ['needed' => $this->setupNeeded()];
    }

    public function setupTwoFactor(array $input): array
    {
        $state = $this->checkSetupToken($input['token'] ?? null);
        $state['totpSecret'] = Security::newTotpSecret();
        Db::metaSet('setup_token', wp_json_encode($state));
        return ['secret' => $state['totpSecret'], 'otpauthUrl' => Security::otpauthUrl($state['totpSecret'], 'admin', 'Místenka ' . $this->app->config['organization']['shortName'])];
    }

    public function completeSetup(array $input): array
    {
        $email = Validate::normalizeEmail(Validate::email($input['email'] ?? null));
        [$firstName, $lastName] = Validate::name($input['firstName'] ?? null, $input['lastName'] ?? null);
        $password = self::validPassword($input['password'] ?? null);
        return Db::transaction(function () use ($input, $email, $firstName, $lastName, $password) {
            $state = $this->checkSetupToken($input['token'] ?? null);
            if (empty($state['totpSecret'])) throw new ApiError(409, 'two_factor_not_setup', 'Nejdřív si nastavte ověřovací aplikaci.');
            $step = Security::verifyTotp($state['totpSecret'], $input['otp'] ?? null, Time::ms(Time::now()));
            if ($step === null) throw new ApiError(400, 'invalid_otp', 'Kód z ověřovací aplikace nesouhlasí.');
            if ($this->userByEmail($email)) throw new ApiError(409, 'email_taken', 'Účet s tímto e-mailem už existuje. Použijte jiný e-mail, nebo účet nejdřív smažte.');
            $now = Time::nowIso();
            $id = Db::insert("INSERT INTO {p}users (email, email_verified_at, password_hash, first_name, last_name, roles, totp_secret, totp_enabled_at, totp_last_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'member,admin', ?, ?, ?, ?, ?)",
                $email, $now, Security::hashPassword($password), $firstName, $lastName, $state['totpSecret'], $now, $step, $now, $now);
            Db::metaDelete('setup_token');
            $user = $this->userById($id);
            $this->audit($user['id'], 'admin_setup', 'user', $user['id']);
            return $this->loggedIn($user);
        });
    }

    // Jen vývoj a testy: bez kontroly oprávnění.
    public function forceRoles($email, $roles): array
    {
        $user = $this->userByEmail(Js::str($email));
        if (!$user) throw new ApiError(404, 'not_found', 'Uživatel neexistuje.');
        $list = is_array($roles) ? $roles : [];
        $after = array_values(array_filter(self::ROLES, fn($r) => $r === 'member' || in_array($r, $list, true)));
        Db::exec('UPDATE {p}users SET roles = ?, updated_at = ? WHERE id = ?', implode(',', $after), Time::nowIso(), $user['id']);
        $this->audit(null, 'roles_forced', 'user', $user['id'], ['to' => $after]);
        return $this->staffUser($this->userById($user['id']));
    }

    // Plánovaná úloha: úklid neověřených účtů, prošlých relací a odkazů.
    public function cleanup(): array
    {
        $now = Time::now();
        $cutoff = Time::iso(Time::fromMs(Time::ms($now) - self::UNVERIFIED_HOURS * 3600000));
        $ids = array_column(Db::all('SELECT id FROM {p}users WHERE email_verified_at IS NULL AND created_at <= ? AND id NOT IN (SELECT user_id FROM {p}tickets WHERE user_id IS NOT NULL)', $cutoff), 'id');
        $unverified = 0;
        foreach ($ids as $id) {
            Db::exec('DELETE FROM {p}auth_tokens WHERE user_id = ?', $id);
            Db::exec('DELETE FROM {p}sessions WHERE user_id = ?', $id);
            Db::exec('DELETE FROM {p}warden_requests WHERE user_id = ?', $id);
            $unverified += Db::exec('DELETE FROM {p}users WHERE id = ?', $id);
        }
        Db::exec('DELETE FROM {p}sessions WHERE expires_at <= ?', Time::iso($now));
        Db::exec('DELETE FROM {p}auth_tokens WHERE expires_at <= ? OR used_at <= ?', Time::iso($now), Time::iso(Time::fromMs(Time::ms($now) - 86400000)));
        return ['unverified' => $unverified];
    }
}
