<?php
// Kontext požadavku (platná konfigurace + moduly) a REST API mistenka/v1 podle docs/API.md
// (router odpovídá src/node/server.js). Odpovědi mají tvar Node: chyba = { error, code } s HTTP stavem.
namespace Mistenka;

defined('ABSPATH') || exit;

final class App
{
    public const NS = 'mistenka/v1';
    private const SESSION_COOKIE = 'mistenka_session';
    // Endpointy, které relaci vytvářejí nebo ji nepotřebují (bez kontroly CSRF).
    private const CSRF_EXEMPT = ['/auth/login', '/auth/register', '/auth/verify', '/auth/magic-link', '/auth/magic', '/auth/password-reset', '/auth/password-reset/confirm', '/auth/email/confirm', '/jobs/run', '/setup', '/setup/2fa', '/requests/view', '/requests/decide'];

    private static ?App $instance = null;

    public array $config;
    public string $appUrl;
    public Settings $settings;
    public Operations $operations;
    public Service $service;
    public Accounts $accounts;
    public Reports $reports;
    public Backups $backups;
    public Retention $retention;
    public Mailer $mailer;
    public Bugs $bugs;
    private bool $outboxDirty = false;

    public static function get(): App
    {
        return self::$instance ??= new App();
    }

    private function __construct()
    {
        global $wpdb;
        $wpdb->suppress_errors(true);
        Plugin::maybeUpgrade();
        $source = Config::readSource();
        $this->settings = new Settings($this, $source);
        $this->config = $this->settings->boot();
        $this->appUrl = self::appUrlFrom($this->config);
        $this->operations = new Operations($this);
        $this->service = new Service($this);
        $this->accounts = new Accounts($this);
        $this->reports = new Reports($this);
        $this->backups = new Backups($this);
        $this->retention = new Retention($this);
        $this->mailer = new Mailer($this);
        $this->bugs = new Bugs($this);
        $this->operations->importNotices();
    }

    // Adresa aplikace (odkazy v e-mailech, detekce subdomény): MISTENKA_APP_URL, jinak organization.appUrl, jinak web.
    public static function appUrlFrom(array $config): string
    {
        $url = defined('MISTENKA_APP_URL') ? (string) MISTENKA_APP_URL : (string) ($config['organization']['appUrl'] ?? '');
        return rtrim($url !== '' ? $url : home_url(), '/');
    }

    // Zápis do fronty e-mailů; po dokončení požadavku se fronta hned odešle (viz deliverPending).
    public function queueEmail(?int $ticketId, string $kind, string $to, array $mail): void
    {
        Db::exec('INSERT INTO {p}email_outbox (ticket_id, kind, to_email, subject, body_html, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            $ticketId, $kind, $to, $mail['subject'], $mail['html'], $mail['text'], Time::nowIso());
        $this->outboxDirty = true;
    }

    public function deliverPending(): void
    {
        if (!$this->outboxDirty) return;
        $this->outboxDirty = false;
        try { $this->mailer->deliverOutbox(); } catch (\Throwable $e) { error_log('[Místenka e-maily] ' . $e->getMessage()); }
    }

    // Plánované úlohy v pořadí podle docs/API.md. Cron hostingu je spouští přes POST /jobs/run.
    public function runJobs(bool $force = false): array
    {
        if (!Db::tryLock('jobs')) return ['skipped' => 'běží jiný běh úloh'];
        $report = [];
        try {
            $step = function (string $name, callable $fn) use (&$report) {
                try { $report[$name] = $fn(); } catch (\Throwable $e) { $report[$name] = ['error' => $e->getMessage()]; error_log("[Místenka úloha {$name}] " . $e->getMessage()); }
            };
            $step('expired', fn() => $this->service->expireReservations());
            $step('payments', fn() => $this->service->syncPayments($force));
            $step('reminders', fn() => $this->service->sendReminders());
            $step('closed', fn() => $this->service->closeOverdue());
            $step('accounts', fn() => $this->accounts->cleanup());
            $step('seasons', fn() => $this->reports->closeSeasons());
            $step('backups', fn() => $this->backups->daily());
            $step('retention', fn() => $this->retention->run());
            $step('rateLimits', fn() => Db::exec('DELETE FROM {p}rate_limits WHERE reset_at <= ?', (int) (microtime(true) * 1000)));
            $step('emails', fn() => $this->mailer->deliverOutbox());
        } finally {
            Db::unlock('jobs');
        }
        $this->outboxDirty = false;
        return $report;
    }

    // ---------- omezení počtu požadavků (na IP, v databázi) ----------
    private function rateLimited(string $ip, string $bucket, int $limit, int $windowMs, bool $consume = true): bool
    {
        if (!Env::rateLimits()) return false;
        $key = substr($bucket . ':' . $ip, 0, 191);
        $nowMs = (int) (microtime(true) * 1000);
        $entry = Db::row('SELECT * FROM {p}rate_limits WHERE bucket = ?', $key);
        if (!$entry || $entry['reset_at'] <= $nowMs) {
            Db::exec('INSERT INTO {p}rate_limits (bucket, count, reset_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE count = 0, reset_at = VALUES(reset_at)', $key, $nowMs + $windowMs);
            $entry = ['count' => 0];
        }
        if ($entry['count'] >= $limit) return true;
        if ($consume) Db::exec('UPDATE {p}rate_limits SET count = count + 1 WHERE bucket = ?', $key);
        return false;
    }

    private static function clientIp(): string
    {
        return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    }

    // ---------- REST ----------
    // Požadavky na mistenka/v1 obslouží router dřív, než WordPress parsuje JSON a parametry (vlastní tvar chyb).
    public static function preDispatch($result, $server, \WP_REST_Request $request)
    {
        $route = $request->get_route();
        if (!str_starts_with($route, '/' . self::NS . '/') && $route !== '/' . self::NS) return $result;
        // WordPress by u REST odrážel Origin s povolenými cookies (CORS) – aplikace je same-origin.
        remove_filter('rest_pre_serve_request', 'rest_send_cors_headers');
        header_remove('Access-Control-Allow-Origin');
        header_remove('Access-Control-Allow-Credentials');
        $path = substr($route, strlen('/' . self::NS));
        $path = $path === '' ? '/' : $path;
        try {
            $app = self::get();
            $response = $app->handle($request, $path);
        } catch (ApiError $e) {
            $response = self::json($e->status, ['error' => $e->getMessage(), 'code' => $e->apiCode]);
        } catch (\Throwable $e) {
            error_log('[Místenka] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            $response = self::json(500, ['error' => 'Server nedokázal požadavek dokončit.', 'code' => 'server_error']);
        }
        if (isset($app)) add_action('shutdown', [self::class, 'afterResponse'], 1);
        return $response;
    }

    // Po odeslání odpovědi (PHP-FPM) odešle e-maily vzniklé během požadavku – rybář nečeká na SMTP.
    public static function afterResponse(): void
    {
        if (!self::$instance) return;
        if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
        self::$instance->deliverPending();
    }

    private static function json(int $status, $body, array $headers = []): \WP_REST_Response
    {
        $response = new \WP_REST_Response($body, $status);
        $response->set_headers(array_merge(['Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'], $headers));
        return $response;
    }

    private function cookieAttrs(): string
    {
        return 'Path=/; HttpOnly; SameSite=Lax' . (str_starts_with($this->appUrl, 'https://') || is_ssl() ? '; Secure' : '');
    }

    private function sendLogin(array $result): \WP_REST_Response
    {
        $s = $result['session'];
        header('Set-Cookie: ' . self::SESSION_COOKIE . '=' . $s['token'] . '; Max-Age=' . $s['maxAgeSeconds'] . '; ' . $this->cookieAttrs(), false);
        return self::json(200, ['user' => $result['user'], 'csrf' => $s['csrf']]);
    }

    private function clearCookie(): void
    {
        header('Set-Cookie: ' . self::SESSION_COOKIE . '=; Max-Age=0; ' . $this->cookieAttrs(), false);
    }

    private static function body(\WP_REST_Request $request, int $maxBytes = 64 * 1024): array
    {
        $raw = (string) $request->get_body();
        if (strlen($raw) > $maxBytes) throw new ApiError(413, 'payload_too_large', 'Požadavek je příliš velký.');
        if (trim($raw) === '') return [];
        $data = json_decode($raw, true);
        if (json_last_error() !== JSON_ERROR_NONE) throw new ApiError(400, 'invalid_json', 'Neplatný formát požadavku.');
        return is_array($data) ? $data : [];
    }

    // Obrázek (náhled mapy revíru) – mimo JSON server WordPressu, lze ho cachovat (adresa obsahuje otisk).
    private static function image(string $contentType, string $content): void
    {
        status_header(200);
        header('Content-Type: ' . $contentType);
        header('Content-Length: ' . strlen($content));
        header('Cache-Control: public, max-age=86400');
        header('X-Content-Type-Options: nosniff');
        echo $content;
        exit;
    }

    // Surová odpověď (CSV, soubor zálohy) – mimo JSON server WordPressu.
    private static function raw(string $contentType, string $filename, string $content): void
    {
        status_header(200);
        header('Content-Type: ' . $contentType);
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Content-Length: ' . strlen($content));
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo $content;
        exit;
    }

    private function handle(\WP_REST_Request $request, string $path): \WP_REST_Response
    {
        $method = strtoupper($request->get_method());
        $q = fn(string $key) => Js::str($request->get_query_params()[$key] ?? '');
        $header = fn(string $name) => (string) ($request->get_header($name) ?? '');
        $ip = self::clientIp();
        $m = null;
        $match = function (string $re) use ($path, &$m): bool { return (bool) preg_match($re, $path, $m); };
        $sessionToken = (string) ($_COOKIE[self::SESSION_COOKIE] ?? '');

        // Přihlášený uživatel (nebo null). Měnící požadavky s relací musí nést CSRF token z /auth/me.
        $ctx = $this->accounts->resolveSession($sessionToken);
        if ($ctx && $method !== 'GET' && $method !== 'HEAD' && !in_array($path, self::CSRF_EXEMPT, true) && !str_starts_with($path, '/dev/')) {
            if (!hash_equals($ctx['session']['csrf'], $header('X-Mistenka-Csrf'))) throw new ApiError(403, 'csrf_failed', 'Platnost stránky vypršela. Načtěte ji prosím znovu.');
        }
        $user = $ctx['user'] ?? null;
        $acc = $this->accounts;
        $svc = $this->service;

        if ($path === '/config' && $method === 'GET') return self::json(200, Config::publicConfig($this->config, ['today' => Time::pragueToday(), 'now' => Time::nowIso(), 'devMode' => Env::dev(), 'service' => ['launched' => Db::serviceLaunched(), 'seasonOpen' => Db::seasonOpen(Time::pragueToday())]]));
        if ($match('#^/reviry/([a-z0-9-]+)/availability$#') && $method === 'GET') return self::json(200, $svc->availability($m[1]));
        // Mapa revíru (veřejná): zakreslené plochy a body + otisk náhledu; náhled PNG pro e-mail a PDF zvlášť.
        if ($match('#^/maps/([a-z0-9-]+)$#') && $method === 'GET') {
            if (!Config::getRevir($this->config, $m[1])) throw new ApiError(404, 'unknown_revir', 'Revír neexistuje.');
            $map = $this->config['maps'][$m[1]] ?? null;
            return self::json(200, ['revirId' => $m[1], 'map' => Config::mapWithoutPreview($map), 'preview' => Config::mapPreviewHash($map)]);
        }
        if ($match('#^/maps/([a-z0-9-]+)/preview\.png$#') && $method === 'GET') {
            $preview = $this->config['maps'][$m[1]]['preview'] ?? null;
            if (!$preview) throw new ApiError(404, 'not_found', 'Náhled mapy neexistuje.');
            self::image('image/png', (string) base64_decode(substr($preview, strpos($preview, ',') + 1)));
        }
        // Hlášení chyby (kdokoli; snímek obrazovky až ~1,5 MB).
        if ($path === '/bug-reports' && $method === 'POST') {
            if ($this->rateLimited($ip, 'bug_report', 5, 600000)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho hlášení, zkuste to za chvíli.');
            return self::json(201, $this->bugs->create(self::body($request, 3 * 1024 * 1024), $user)); // se snímkem obrazovky
        }
        if ($path === '/announcements' && $method === 'GET') return self::json(200, $this->operations->activeAnnouncements($q('revirId')));
        if ($path === '/orders' && $method === 'POST') {
            if ($this->rateLimited($ip, 'order', 10, 60000)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho objednávek, zkuste to za chvíli.');
            return self::json(201, $svc->createOrder(self::body($request), $user));
        }
        if ($match('#^/vouchers/([^/]+)$#') && $method === 'GET') {
            if ($this->rateLimited($ip, 'voucher', 20, 60000)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho pokusů, zkuste to za chvíli.');
            return self::json(200, $svc->checkVoucher($m[1]));
        }
        if ($match('#^/tickets/([^/]+)$#') && $method === 'GET') {
            if ($this->rateLimited($ip, 'lookup', 60, 60000)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho dotazů, zkuste to za chvíli.');
            return self::json(200, $svc->getPublicTicket($m[1]));
        }

        // Operace držitele místenky (token nebo číslo členské legitimace).
        if (preg_match('#^/orders/([^/]+)(/cancel)?$#', $path, $owner) || preg_match('#^/tickets/([^/]+)(/return)$#', $path, $owner)) {
            if ($this->rateLimited($ip, 'auth_fail', 10, 600000, false)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho neúspěšných pokusů, zkuste to později.');
            $credentials = ['token' => $header('X-Mistenka-Token'), 'memberId' => $header('X-Mistenka-Member-Id')];
            $sub = $owner[2] ?? '';
            try {
                if ($sub === '' && $method === 'GET') return self::json(200, $svc->getOwnerTicket($owner[1], $credentials, $user));
                if ($sub === '/cancel' && $method === 'POST') return self::json(200, $svc->cancelOrder($owner[1], $credentials, $user));
                if ($sub === '/return' && $method === 'POST') return self::json(200, $svc->submitReturn($owner[1], $credentials, self::body($request), $user));
            } catch (ApiError $e) {
                if ($e->apiCode === 'forbidden' || $e->apiCode === 'not_found') $this->rateLimited($ip, 'auth_fail', 10, 600000);
                throw $e;
            }
        }

        // ---------- účty ----------
        if ($path === '/auth/me' && $method === 'GET') return self::json(200, $acc->me($ctx));
        if (str_starts_with($path, '/auth/') && $method === 'POST') {
            $action = substr($path, strlen('/auth/'));
            if (in_array($action, ['register', 'magic-link', 'password-reset'], true) && $this->rateLimited($ip, 'account_mail', 5, 600000)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho požadavků, zkuste to později.');
            if ($action !== 'logout' && $this->rateLimited($ip, 'auth_fail', 10, 600000, false)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho neúspěšných pokusů, zkuste to později.');
            $body = self::body($request);
            try {
                if ($action === 'register') return self::json(200, $acc->register($body));
                if ($action === 'verify') return $this->sendLogin($acc->verifyEmail($body));
                if ($action === 'login') return $this->sendLogin($acc->login($body));
                if ($action === 'magic-link') return self::json(200, $acc->requestMagicLink($body));
                if ($action === 'magic') return $this->sendLogin($acc->magicLogin($body));
                if ($action === 'password-reset') return self::json(200, $acc->requestPasswordReset($body));
                if ($action === 'password-reset/confirm') return $this->sendLogin($acc->resetPassword($body));
                if ($action === 'email/confirm') return self::json(200, $acc->confirmEmailChange($body));
                if ($action === 'logout') { $result = $acc->logout($sessionToken); $this->clearCookie(); return self::json(200, $result); }
            } catch (ApiError $e) {
                if (in_array($e->apiCode, ['invalid_credentials', 'invalid_otp', 'invalid_link'], true)) $this->rateLimited($ip, 'auth_fail', 10, 600000);
                if ($e->apiCode === 'email_not_verified') $this->rateLimited($ip, 'account_mail', 5, 600000);
                throw $e;
            }
        }
        // ---------- průvodce prvním spuštěním ----------
        if ($path === '/setup' && $method === 'GET') return self::json(200, $acc->setupStatus());
        if (($path === '/setup' || $path === '/setup/2fa') && $method === 'POST') {
            if ($this->rateLimited($ip, 'auth_fail', 10, 600000, false)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho neúspěšných pokusů, zkuste to později.');
            $body = self::body($request);
            try {
                if ($path === '/setup/2fa') return self::json(200, $acc->setupTwoFactor($body));
                return $this->sendLogin($acc->completeSetup($body));
            } catch (ApiError $e) {
                if (in_array($e->apiCode, ['invalid_setup_token', 'invalid_otp'], true)) $this->rateLimited($ip, 'auth_fail', 10, 600000);
                throw $e;
            }
        }
        if ($path === '/me' && $method === 'PATCH') return self::json(200, $acc->updateProfile($ctx, self::body($request)));
        if ($path === '/me/password' && $method === 'PUT') return self::json(200, $acc->changePassword($ctx, self::body($request)));
        if ($path === '/me/delete' && $method === 'POST') { $result = $acc->deleteAccount($ctx, self::body($request)); $this->clearCookie(); return self::json(200, $result); }
        if ($path === '/me/tickets' && $method === 'GET') return self::json(200, ['tickets' => $svc->ticketsForUser($acc->requireUser($ctx))]);
        if ($path === '/me/community' && $method === 'GET') { $acc->requireUser($ctx); return self::json(200, $svc->communityStats()); }
        if ($path === '/me/stats' && $method === 'GET') return self::json(200, $svc->statsForUser($acc->requireUser($ctx)));
        if ($path === '/me/limits' && $method === 'GET') return self::json(200, $svc->limitsForMember($acc->requireUser($ctx), $q('revirId')));
        if ($path === '/me/warden-request' && $method === 'POST') return self::json(200, $acc->requestWarden($ctx, self::body($request)));
        // Žádost „Jsem porybný“ z odkazu v e-mailu správci (bez přihlášení, token z request.html).
        if (($path === '/requests/view' || $path === '/requests/decide') && $method === 'POST') {
            if ($this->rateLimited($ip, 'auth_fail', 10, 600000, false)) throw new ApiError(429, 'rate_limited', 'Příliš mnoho neúspěšných pokusů, zkuste to později.');
            $body = self::body($request);
            try {
                return self::json(200, $path === '/requests/view' ? $acc->viewRequestByToken($body) : $acc->decideRequestByToken($body));
            } catch (ApiError $e) {
                if ($e->apiCode === 'invalid_link') $this->rateLimited($ip, 'auth_fail', 10, 600000);
                throw $e;
            }
        }
        if ($path === '/me/2fa/setup' && $method === 'POST') return self::json(200, $acc->twoFactorSetup($ctx));
        if ($path === '/me/2fa/enable' && $method === 'POST') return self::json(200, $acc->twoFactorEnable($ctx, self::body($request)));
        if ($path === '/me/2fa/disable' && $method === 'POST') return self::json(200, $acc->twoFactorDisable($ctx, self::body($request)));

        // ---------- porybný ----------
        if ($match('#^/warden/tickets/([^/]+)$#') && $method === 'GET') return self::json(200, $svc->wardenCheck($m[1], $acc->requireWarden($ctx)));
        if ($match('#^/warden/tickets/([^/]+)/seize$#') && $method === 'POST') return self::json(200, $svc->seizeTicket($m[1], $acc->requireWarden($ctx), self::body($request)));

        // ---------- manažerský portál ----------
        if ($match('#^/manage/seasons/(\d+)/close$#') && $method === 'POST') return self::json(200, $this->operations->closeSeason($acc->requireManager($ctx), $m[1], self::body($request)));
        if (preg_match('#^/manage/(announcements|seasons|closures)(?:/(\d+))?$#', $path, $ops)) {
            $actor = $acc->requireManager($ctx);
            $kind = $ops[1];
            $id = $ops[2] ?? '';
            $o = $this->operations;
            if ($method === 'GET' && $id === '') return self::json(200, $kind === 'announcements' ? $o->listAnnouncements() : ($kind === 'seasons' ? $o->listSeasons() : $o->listClosures()));
            if ($method === 'POST' && $id === '') {
                $body = self::body($request);
                return self::json(201, $kind === 'announcements' ? $o->saveAnnouncement($actor, null, $body) : ($kind === 'seasons' ? $o->saveSeason($actor, null, $body) : $o->createClosure($actor, $body)));
            }
            if ($method === 'PUT' && $id !== '' && $kind !== 'closures') {
                $body = self::body($request);
                return self::json(200, $kind === 'announcements' ? $o->saveAnnouncement($actor, $id, $body) : $o->saveSeason($actor, $id, $body));
            }
            if ($method === 'DELETE' && $id !== '') return self::json(200, $kind === 'announcements' ? $o->deleteAnnouncement($actor, $id) : ($kind === 'seasons' ? $o->deleteSeason($actor, $id) : $o->deleteClosure($actor, $id)));
        }
        // Nastavení (B5). Platební údaje jen admin (kontrola v Settings::save).
        if (str_starts_with($path, '/manage/settings')) {
            $actor = $acc->requireManager($ctx);
            $sub = substr($path, strlen('/manage/settings'));
            $st = $this->settings;
            if ($sub === '' && $method === 'GET') return self::json(200, $st->view($actor));
            if ($sub === '/organization' && $method === 'PUT') { $b = self::body($request); return self::json(200, $st->save($actor, 'organization', $b['data'] ?? null, Js::s($b['note'] ?? null))); }
            if ($sub === '/payment' && $method === 'PUT') { $b = self::body($request); return self::json(200, $st->save($actor, 'payment', $b['data'] ?? null, Js::s($b['note'] ?? null))); }
            if ($sub === '/reviry' && $method === 'POST') { $b = self::body($request); return self::json(201, $st->save($actor, 'revir:' . Js::s($b['id'] ?? null), $b['data'] ?? null, Js::s($b['note'] ?? null), true)); }
            if (preg_match('#^/reviry/([a-z0-9-]+)$#', $sub, $rm) && $method === 'PUT') { $b = self::body($request); return self::json(200, $st->save($actor, 'revir:' . $rm[1], $b['data'] ?? null, Js::s($b['note'] ?? null))); }
            if ($sub === '/species' && $method === 'PUT') { $b = self::body($request); return self::json(200, $st->save($actor, 'species:' . Js::s($b['ref'] ?? null), $b['data'] ?? null, Js::s($b['note'] ?? null))); }
            // Mapa revíru (GeoJSON + náhled PNG) – větší tělo požadavku.
            if (preg_match('#^/maps/([a-z0-9-]+)$#', $sub, $mm) && $method === 'PUT') { $b = self::body($request, 3 * 1024 * 1024); return self::json(200, $st->save($actor, 'map:' . $mm[1], $b['data'] ?? null, Js::s($b['note'] ?? null))); }
            if ($sub === '/history' && $method === 'GET') return self::json(200, $st->history($q('scope')));
            if (preg_match('#^/versions/(\d+)$#', $sub, $vm) && $method === 'GET') return self::json(200, $st->versionData($vm[1]));
            if (preg_match('#^/versions/(\d+)/restore$#', $sub, $vm) && $method === 'POST') return self::json(200, $st->restore($actor, $vm[1]));
            if ($sub === '/reset' && $method === 'POST') { $b = self::body($request); return self::json(200, $st->resetToFile($actor, $b['scope'] ?? null)); }
            if ($sub === '/export' && $method === 'GET') {
                if (!Accounts::hasRole($actor, 'admin')) throw new ApiError(403, 'forbidden_role', 'Export nastavení je jen pro admina.');
                return self::json(200, $st->exportAll(), ['Content-Disposition' => 'attachment; filename="mistenka-nastaveni-' . Time::pragueToday() . '.json"']);
            }
        }

        // Zálohy a audit (B7) – jen admin.
        if ($path === '/manage/backups' && $method === 'GET') { $acc->requireAdmin($ctx); return self::json(200, $this->backups->list()); }
        if ($path === '/manage/backups' && $method === 'POST') return self::json(201, $this->backups->manual($acc->requireAdmin($ctx), self::body($request)));
        if ($match('#^/manage/backups/(\d+)/download$#') && $method === 'GET') {
            $acc->requireAdmin($ctx);
            $backup = $this->backups->filePath($m[1]);
            self::raw('application/gzip', $backup['file'], (string) file_get_contents($backup['full']));
        }
        if ($match('#^/manage/backups/(\d+)/restore$#') && $method === 'POST') {
            $body = self::body($request);
            $admin = $acc->confirmOtp($ctx, $body['otp'] ?? null);
            return self::json(200, $this->backups->restore($admin, $m[1], $body));
        }
        if ($match('#^/manage/backups/(\d+)$#') && $method === 'DELETE') return self::json(200, $this->backups->remove($acc->requireAdmin($ctx), $m[1]));
        if ($path === '/manage/audit' && $method === 'GET') return self::json(200, $acc->listAudit($ctx, $q('limit'), $q('action')));

        // E-mailoví klienti: účty spravuje admin, odesílatele skupin vybírá správce i admin.
        if ($path === '/manage/email/accounts' && $method === 'GET') return self::json(200, $this->mailer->list($acc->requireManager($ctx)));
        if ($path === '/manage/email/accounts' && $method === 'POST') return self::json(201, $this->mailer->create($acc->requireManager($ctx), self::body($request)));
        if ($match('#^/manage/email/accounts/(\d+)$#')) {
            if ($method === 'PUT') return self::json(200, $this->mailer->update($acc->requireManager($ctx), $m[1], self::body($request)));
            if ($method === 'DELETE') return self::json(200, $this->mailer->remove($acc->requireManager($ctx), $m[1]));
        }
        if ($match('#^/manage/email/accounts/(\d+)/verify$#') && $method === 'POST') return self::json(200, $this->mailer->verify($acc->requireManager($ctx), $m[1], self::body($request)));
        // Hlášení chyb – jen admin.
        if ($path === '/manage/bug-reports' && $method === 'GET') { $acc->requireAdmin($ctx); return self::json(200, $this->bugs->list($q('status'))); }
        if ($match('#^/manage/bug-reports/(\d+)$#')) {
            if ($method === 'GET') { $acc->requireAdmin($ctx); return self::json(200, $this->bugs->get($m[1])); }
            if ($method === 'PATCH') return self::json(200, $this->bugs->update($acc->requireAdmin($ctx), $m[1], self::body($request)));
        }
        if ($match('#^/manage/bug-reports/(\d+)/github$#') && $method === 'POST') return self::json(200, $this->bugs->toGithub($acc->requireAdmin($ctx), $m[1]));
        if ($path === '/manage/email/senders' && $method === 'PUT') return self::json(200, $this->mailer->setSenders($acc->requireManager($ctx), self::body($request)));

        // Zarybnění, přehledy, uzávěrky (B6).
        if (str_starts_with($path, '/manage/stocking') || str_starts_with($path, '/manage/stats') || str_starts_with($path, '/manage/reports')) {
            $actor = $acc->requireManager($ctx);
            $r = $this->reports;
            if ($path === '/manage/stocking' && $method === 'GET') return self::json(200, $r->listStocking($q('year'), $q('revirId'), $q('planned')));
            if ($path === '/manage/stocking' && $method === 'POST') return self::json(201, $r->saveStocking($actor, null, self::body($request)));
            if ($path === '/manage/stocking/budget' && $method === 'GET') return self::json(200, $r->getBudget($q('year')));
            if ($path === '/manage/stocking/budget' && $method === 'PUT') return self::json(200, $r->setBudget($actor, self::body($request)));
            if ($match('#^/manage/stocking/(\d+)$#')) {
                if ($method === 'PUT') return self::json(200, $r->saveStocking($actor, $m[1], self::body($request)));
                if ($method === 'DELETE') return self::json(200, $r->deleteStocking($actor, $m[1]));
            }
            if ($path === '/manage/stats' && $method === 'GET') return self::json(200, $r->stats($q('from'), $q('to'), $q('revirId'), $q('seasonId')));
            if ($path === '/manage/reports' && $method === 'GET') return self::json(200, $r->listReports());
            if ($path === '/manage/reports' && $method === 'POST') return self::json(201, $r->createReport($actor, self::body($request)));
            if ($match('#^/manage/reports/(\d+)$#') && $method === 'GET') return self::json(200, $r->getReport($m[1]));
        }

        // Místenky, platby, poukazy (B4).
        $filters = fn() => ['status' => $q('status'), 'revirId' => $q('revirId'), 'from' => $q('from'), 'to' => $q('to'), 'q' => $q('q'), 'limit' => $q('limit'), 'offset' => $q('offset')];
        if ($path === '/manage/tickets' && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->listTickets($filters())); }
        if ($path === '/manage/tickets.csv' && $method === 'GET') {
            $acc->requireManager($ctx);
            self::raw('text/csv; charset=utf-8', 'mistenky-' . Time::pragueToday() . '.csv', $svc->ticketsCsv($filters()));
        }
        if ($match('#^/manage/tickets/([^/]+)$#') && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->ticketDetail($m[1])); }
        if ($match('#^/manage/tickets/([^/]+)/cancel$#') && $method === 'POST') return self::json(200, $svc->cancelByManager($acc->requireManager($ctx), $m[1], self::body($request)));
        if ($path === '/manage/payments' && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->listPayments($q('state') ?: 'open')); }
        if ($match('#^/manage/payments/(\d+)/resolve$#') && $method === 'POST') return self::json(200, $svc->resolvePayment($acc->requireManager($ctx), $m[1], self::body($request)));
        if ($path === '/manage/vouchers' && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->listVouchers()); }
        if ($path === '/manage/vouchers' && $method === 'POST') return self::json(201, $svc->generateVouchers($acc->requireManager($ctx), self::body($request)));
        if ($match('#^/manage/vouchers/([^/]+)/void$#') && $method === 'POST') return self::json(200, $svc->voidVoucher($acc->requireManager($ctx), $m[1]));
        if ($path === '/manage/violations' && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->listViolations()); }
        if ($path === '/manage/blocks' && $method === 'GET') { $acc->requireManager($ctx); return self::json(200, $svc->listBlocks()); }
        if ($path === '/manage/blocks' && $method === 'POST') return self::json(201, $svc->createBlock($acc->requireManager($ctx), self::body($request)));
        if ($match('#^/manage/blocks/(\d+)/lift$#') && $method === 'POST') return self::json(200, $svc->liftBlock($acc->requireManager($ctx), $m[1]));
        if ($path === '/manage/notifications' && $method === 'GET') return self::json(200, $acc->listNotifications($ctx));
        if ($match('#^/manage/notifications/(\d+)/(approve|reject)$#') && $method === 'POST') return self::json(200, $acc->decideNotification($ctx, $m[1], $m[2], self::body($request)));
        if ($path === '/manage/users' && $method === 'GET') return self::json(200, $acc->listUsers($ctx, $q('q'), $q('role')));
        if ($path === '/manage/users' && $method === 'POST') return self::json(201, $acc->inviteStaff($ctx, self::body($request)));
        if ($match('#^/manage/users/(\d+)/roles$#') && $method === 'PUT') return self::json(200, $acc->setRoles($ctx, $m[1], self::body($request)));

        // ---------- plánované úlohy a vývoj ----------
        if ($path === '/jobs/run' && $method === 'POST') {
            $key = Env::cronKey();
            if ($key === '' || !hash_equals($key, $header('X-Mistenka-Cron-Key'))) throw new ApiError(404, 'not_found', 'Nenalezeno.');
            return self::json(200, $this->runJobs());
        }
        if ($path === '/dev/payments' && $method === 'POST') return self::json(200, $svc->simulatePayment(self::body($request)));
        if (Env::dev()) {
            if ($path === '/dev/clock' && $method === 'POST') {
                $body = self::body($request);
                try { Time::setClock(Js::truthy($body['now'] ?? null) ? Js::str($body['now']) : null); } catch (\Throwable $e) { throw new ApiError(400, 'invalid_time', 'Neplatný čas.'); }
                $this->runJobs(true);
                return self::json(200, ['now' => Time::nowIso(), 'today' => Time::pragueToday()]);
            }
            if ($path === '/dev/vouchers' && $method === 'POST') return self::json(201, $svc->createVoucher(self::body($request)));
            if ($path === '/dev/users/roles' && $method === 'POST') { $b = self::body($request); return self::json(200, ['user' => $acc->forceRoles($b['email'] ?? '', $b['roles'] ?? [])]); }
            if ($path === '/dev/setup-token' && $method === 'POST') {
                $setup = $acc->createSetupToken();
                if (!$setup) throw new ApiError(404, 'setup_closed', 'Admin už existuje.');
                return self::json(200, ['token' => $setup['token']]);
            }
            if ($path === '/dev/outbox' && $method === 'GET') {
                $rows = Db::all('SELECT kind, to_email, subject, body_text, body_html, created_at FROM {p}email_outbox WHERE LOWER(to_email) = ? ORDER BY id DESC LIMIT 20', Js::lower($q('to')));
                return self::json(200, ['emails' => array_map(fn($r) => ['kind' => $r['kind'], 'to' => $r['to_email'], 'subject' => $r['subject'], 'text' => $r['body_text'], 'html' => $r['body_html'], 'createdAt' => $r['created_at']], $rows)]);
            }
            if ($path === '/dev/jobs' && $method === 'POST') return self::json(200, $this->runJobs(true));
        }
        throw new ApiError(404, 'not_found', 'Nenalezeno.');
    }
}
