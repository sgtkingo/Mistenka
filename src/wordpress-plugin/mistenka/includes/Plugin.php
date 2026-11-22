<?php
// Životní cyklus pluginu: aktivace, aktualizace schématu, servírování aplikace na subdoméně,
// pravidla .htaccess, plánované úlohy (záložní WP-cron) a stránka v administraci (Nastavení → Místenka).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Plugin
{
    private const DB_OPTION = 'mistenka_db_version';
    private const HTACCESS_MARKER = 'Mistenka';
    private const STATIC_TYPES = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'ico' => 'image/x-icon', 'json' => 'application/json; charset=utf-8', 'txt' => 'text/plain; charset=utf-8'];

    public static function boot(): void
    {
        add_filter('rest_pre_dispatch', [App::class, 'preDispatch'], 0, 3);
        add_action('rest_api_init', [self::class, 'registerRoutes']);
        add_filter('redirect_canonical', fn($redirect) => self::isAppHost() ? false : $redirect);
        add_action('init', [self::class, 'serveApp'], 0);
        add_filter('cron_schedules', [self::class, 'cronSchedules']);
        add_action('mistenka_jobs', [self::class, 'wpCronJobs']);
        add_action('admin_menu', [Admin::class, 'menu']);
        add_action('admin_init', [self::class, 'maybeUpgrade']);
    }

    // Trasa jen kvůli přehledu v /wp-json – požadavky obslouží App::preDispatch dřív.
    public static function registerRoutes(): void
    {
        register_rest_route(App::NS, '/(?P<path>.*)', ['methods' => \WP_REST_Server::ALLMETHODS, 'permission_callback' => '__return_true', 'callback' => fn() => new \WP_REST_Response(['error' => 'Nenalezeno.', 'code' => 'not_found'], 404)]);
    }

    public static function activate(): void
    {
        Db::install();
        update_option(self::DB_OPTION, Db::SCHEMA_VERSION, false);
        Env::dataDir();
        self::writeHtaccess();
        if (!wp_next_scheduled('mistenka_jobs')) wp_schedule_event(time() + 60, 'mistenka_5min', 'mistenka_jobs');
    }

    public static function deactivate(): void
    {
        wp_clear_scheduled_hook('mistenka_jobs');
        self::removeHtaccess();
    }

    public static function maybeUpgrade(): void
    {
        if ((int) get_option(self::DB_OPTION, 0) !== Db::SCHEMA_VERSION) {
            Db::install();
            update_option(self::DB_OPTION, Db::SCHEMA_VERSION, false);
        }
    }

    public static function cronSchedules(array $schedules): array
    {
        $schedules['mistenka_5min'] = ['interval' => 300, 'display' => 'Místenka – každých 5 minut'];
        return $schedules;
    }

    // Záloha za cron hostingu (WP-cron běží jen při návštěvě webu); souběhu brání zámek v App::runJobs.
    public static function wpCronJobs(): void
    {
        try { App::get()->runJobs(); } catch (\Throwable $e) { error_log('[Místenka WP-cron] ' . $e->getMessage()); }
    }

    // ---------- aplikace na subdoméně ----------
    public static function appUrl(): string
    {
        try {
            return App::appUrlFrom(Config::readSource()['raw']);
        } catch (\Throwable $e) {
            return defined('MISTENKA_APP_URL') ? rtrim((string) MISTENKA_APP_URL, '/') : home_url();
        }
    }

    // host[:port] adresy aplikace.
    public static function appHost(): string
    {
        $parts = wp_parse_url(self::appUrl());
        return strtolower(($parts['host'] ?? '') . (isset($parts['port']) ? ':' . $parts['port'] : ''));
    }

    public static function isAppHost(): bool
    {
        $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
        $app = self::appHost();
        if ($app === '' || $host === '') return false;
        return $host === $app || preg_replace('/:(80|443)$/', '', $host) === preg_replace('/:(80|443)$/', '', $app);
    }

    // Sestavený plugin má frontend ve složce frontend/; vývoj (Docker) ho čte přímo z repozitáře (MISTENKA_FRONTEND_DIR).
    public static function frontendDir(): string
    {
        return rtrim(defined('MISTENKA_FRONTEND_DIR') ? (string) MISTENKA_FRONTEND_DIR : MISTENKA_DIR . 'frontend', '/\\');
    }

    // Na subdoméně aplikace vykreslí soubory frontendu místo webu (záloha, když nefungují pravidla .htaccess).
    public static function serveApp(): void
    {
        if (!self::isAppHost() || isset($_GET['rest_route']) || (defined('REST_REQUEST') && REST_REQUEST)) return;
        $path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
        $home = (string) wp_parse_url(home_url('/'), PHP_URL_PATH);
        if ($home !== '/' && str_starts_with($path, rtrim($home, '/'))) $path = substr($path, strlen(rtrim($home, '/')));
        if (str_starts_with($path, '/wp-') || $path === '/index.php' || str_starts_with($path, '/xmlrpc')) return; // administrace a přihlášení WordPressu
        $file = $path === '/' || $path === '' ? 'index.html' : ltrim(rawurldecode($path), '/');
        if ($file === 'js/env.js') self::sendStatic('js', self::envJs());
        if (!preg_match('#^(?:[a-z0-9-]+\.html|[a-z0-9-]+\.css|(?:js|vendor)/[A-Za-z0-9._-]+\.(?:js|txt|LICENSE))$#i', $file)) self::notFound();
        $full = self::frontendDir() . '/' . $file;
        if (!is_file($full)) self::notFound();
        $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));
        self::sendStatic(isset(self::STATIC_TYPES[$ext]) ? $ext : 'txt', (string) file_get_contents($full));
    }

    // Prefix API vůči adrese aplikace (podle trvalých odkazů WordPressu).
    public static function apiPath(): string
    {
        return get_option('permalink_structure') ? '/wp-json/' . App::NS : '/?rest_route=/' . App::NS;
    }

    // Jediný rozdíl frontendu mezi prostředími: prefix API (web nemá „hezké“ trvalé odkazy).
    public static function envJs(): string
    {
        $api = self::apiPath();
        return "// Vygenerováno pluginem Místenka.\nwindow.MISTENKA_ENV = { apiBase: " . wp_json_encode($api) . " };\n";
    }

    private static function sendStatic(string $ext, string $content): void
    {
        status_header(200);
        header('Content-Type: ' . self::STATIC_TYPES[$ext]);
        header('Cache-Control: no-cache');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        echo $content;
        exit;
    }

    private static function notFound(): void
    {
        status_header(404);
        nocache_headers();
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><meta charset="utf-8"><title>Nenalezeno</title><p style="font-family:system-ui;padding:24px">Stránka nebyla nalezena. <a href="./">Místenka</a></p>';
        exit;
    }

    // ---------- .htaccess ----------
    // Na subdoméně aplikace Apache servíruje statické soubory frontendu přímo ze složky pluginu (rychlé),
    // js/env.js a vše ostatní předá WordPressu. Blok je na začátku .htaccess a týká se jen hostu aplikace.
    public static function htaccessLines(): array
    {
        $host = self::appHost();
        $root = wp_normalize_path(ABSPATH);
        if ($host === '' || !str_starts_with(wp_normalize_path(self::frontendDir()), $root)) return []; // frontend mimo web – servíruje ho WordPress
        $hostRe = '^' . preg_quote(preg_replace('/:\d+$/', '', $host), null) . '(:\d+)?$';
        $rel = ltrim(substr(wp_normalize_path(self::frontendDir()), strlen($root)), '/');
        return [
            '<IfModule mod_rewrite.c>',
            'RewriteEngine On',
            "RewriteCond %{HTTP_HOST} {$hostRe} [NC]",
            'RewriteCond %{QUERY_STRING} !(^|&)rest_route=',
            "RewriteRule ^$ {$rel}/index.html [L]",
            "RewriteCond %{HTTP_HOST} {$hostRe} [NC]",
            'RewriteRule ^js/env\.js$ index.php [L]',
            "RewriteCond %{HTTP_HOST} {$hostRe} [NC]",
            "RewriteRule ^((js|vendor)/[A-Za-z0-9._-]+\.js|[a-z0-9-]+\.(html|css))$ {$rel}/$1 [L]",
            '</IfModule>',
        ];
    }

    private static function htaccessFile(): string
    {
        return ABSPATH . '.htaccess';
    }

    public static function htaccessStatus(): string
    {
        $file = self::htaccessFile();
        if (!self::htaccessLines()) return 'not_needed';
        if (!file_exists($file)) return 'missing';
        $content = (string) file_get_contents($file);
        if (!str_contains($content, '# BEGIN ' . self::HTACCESS_MARKER)) return 'absent';
        return str_contains($content, implode("\n", self::htaccessLines())) ? 'ok' : 'outdated';
    }

    public static function writeHtaccess(): bool
    {
        $file = self::htaccessFile();
        $lines = self::htaccessLines();
        if (!$lines) return false;
        $content = file_exists($file) ? (string) file_get_contents($file) : '';
        if ($content !== '' && !is_writable($file)) return false;
        if ($content === '' && !is_writable(ABSPATH)) return false;
        $content = self::stripBlock($content);
        $block = '# BEGIN ' . self::HTACCESS_MARKER . "\n# Aplikace Místenka na své subdoméně (spravuje plugin, neupravujte ručně).\n" . implode("\n", $lines) . "\n# END " . self::HTACCESS_MARKER . "\n\n";
        return file_put_contents($file, $block . ltrim($content)) !== false;
    }

    public static function removeHtaccess(): void
    {
        $file = self::htaccessFile();
        if (file_exists($file) && is_writable($file)) file_put_contents($file, ltrim(self::stripBlock((string) file_get_contents($file))));
    }

    private static function stripBlock(string $content): string
    {
        $marker = preg_quote(self::HTACCESS_MARKER, '/');
        return preg_replace("/# BEGIN {$marker}\\n.*?# END {$marker}\\n*/s", '', $content);
    }
}
