<?php
// Životní cyklus pluginu: aktivace, aktualizace schématu, servírování aplikace na subdoméně,
// pravidla .htaccess, plánované úlohy (záložní WP-cron) a stránka v administraci (Nastavení → Místenka).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Plugin
{
    private const DB_OPTION = 'mistenka_db_version';
    public const APP_URL_OPTION = 'mistenka_app_url';            // adresa aplikace z průvodce (nastavení instalace, ne MO)
    public const APP_URL_CHECK_OPTION = 'mistenka_app_url_check'; // výsledek posledního ověření adresy
    public const CRON_OPTION = 'mistenka_last_hosting_cron';      // čas posledního běhu z cronu hostingu (cron.php, /jobs/run)
    private const ACTIVATION_REDIRECT = 'mistenka_activation_redirect';
    private const VERIFY_PARAM = 'mistenka_verify';
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
        add_action('admin_init', [self::class, 'activationRedirect']);
        add_action('admin_notices', [Admin::class, 'pluginsNotice']);
    }

    // Trasa jen kvůli přehledu v /wp-json – požadavky obslouží App::preDispatch dřív.
    public static function registerRoutes(): void
    {
        register_rest_route(App::NS, '/(?P<path>.*)', ['methods' => \WP_REST_Server::ALLMETHODS, 'permission_callback' => '__return_true', 'callback' => fn() => new \WP_REST_Response(['error' => 'Nenalezeno.', 'code' => 'not_found'], 404)]);
    }

    public static function activate(): void
    {
        $fresh = !get_option(self::DB_OPTION); // nová instalace = ostrý web; po aktualizaci se průvodce zeptá (TestMode::answered)
        Db::install();
        if ($fresh && !TestMode::answered()) TestMode::answer(false);
        update_option(self::DB_OPTION, Db::SCHEMA_VERSION, false);
        Env::dataDir();
        self::writeHtaccess();
        if (!wp_next_scheduled('mistenka_jobs')) wp_schedule_event(time() + 60, 'mistenka_5min', 'mistenka_jobs');
        set_transient(self::ACTIVATION_REDIRECT, 1, 60);
    }

    // Po aktivaci jednou otevře průvodce nastavením (ne při hromadné aktivaci více pluginů).
    public static function activationRedirect(): void
    {
        if (!get_transient(self::ACTIVATION_REDIRECT)) return;
        delete_transient(self::ACTIVATION_REDIRECT);
        if (wp_doing_ajax() || is_network_admin() || isset($_GET['activate-multi']) || !current_user_can('manage_options')) return;
        wp_safe_redirect(admin_url('options-general.php?page=mistenka&tab=pruvodce'));
        exit;
    }

    public static function deactivate(): void
    {
        wp_clear_scheduled_hook('mistenka_jobs');
        self::removeHtaccess();
    }

    public static function maybeUpgrade(): void
    {
        if ((int) get_option(self::DB_OPTION, 0) !== Db::SCHEMA_VERSION) {
            TestMode::withMode(false, fn() => Db::install());
            update_option(self::DB_OPTION, Db::SCHEMA_VERSION, false);
        }
        // Testovací databáze (pokud existuje) dostane stejné schéma.
        if ((int) get_option(TestMode::DB_OPTION, Db::SCHEMA_VERSION) !== Db::SCHEMA_VERSION && TestMode::testDatabaseExists()) {
            TestMode::withMode(true, fn() => Db::install());
            update_option(TestMode::DB_OPTION, Db::SCHEMA_VERSION, false);
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
        try { App::runAllJobs(); } catch (\Throwable $e) { error_log('[Místenka WP-cron] ' . $e->getMessage()); }
    }

    // ---------- aplikace na subdoméně ----------
    // Adresa nastavená pro tuto instalaci: konstanta ve wp-config.php, jinak průvodce. Prázdná = jen z konfigurace.
    public static function configuredAppUrl(): string
    {
        if (defined('MISTENKA_APP_URL') && (string) MISTENKA_APP_URL !== '') return rtrim((string) MISTENKA_APP_URL, '/');
        return rtrim((string) get_option(self::APP_URL_OPTION, ''), '/');
    }

    public static function appUrl(): string
    {
        $url = self::configuredAppUrl();
        if ($url !== '') return $url; // bez čtení konfigurace (volá se při každém požadavku)
        try {
            return App::appUrlFrom(Config::readSource()['raw']);
        } catch (\Throwable $e) {
            return home_url();
        }
    }

    // Odkud je adresa: constant (wp-config) | option (průvodce) | config (organization.appUrl) | site (adresa webu).
    public static function appUrlSource(): string
    {
        if (defined('MISTENKA_APP_URL') && (string) MISTENKA_APP_URL !== '') return 'constant';
        if ((string) get_option(self::APP_URL_OPTION, '') !== '') return 'option';
        try {
            if ((string) (Config::readSource()['raw']['organization']['appUrl'] ?? '') !== '') return 'config';
        } catch (\Throwable $e) {
        }
        return 'site';
    }

    // Adresu je potřeba nastavit v průvodci: chybí, nebo je vzorová z obecného balíčku (*.example.cz).
    public static function appUrlNeedsSetup(): bool
    {
        $source = self::appUrlSource();
        if ($source === 'constant' || $source === 'option') return false;
        if ($source === 'site') return true;
        if (str_ends_with(strtolower((string) wp_parse_url(self::appUrl(), PHP_URL_HOST)), 'example.cz')) return true;
        // Adresa z konfigurace v ZIPu může patřit jiné instalaci (např. produkční adresa na testovacím webu) – platí až po ověření.
        $check = self::lastAppUrlCheck();
        return !($check && $check['ok']);
    }

    // Zadanou adresu převede na tvar https://host[:port]; při chybě vrátí text chyby v $error.
    public static function normalizeAppUrl(string $input, ?string &$error = null): ?string
    {
        $input = trim($input);
        if ($input === '') { $error = 'Zadejte adresu aplikace.'; return null; }
        if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $input)) $input = 'https://' . $input;
        $parts = wp_parse_url($input);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || !preg_match('/^[a-z0-9.-]+$/', $host)) { $error = 'Neplatná adresa – zadejte například https://mistenka.example.cz.'; return null; }
        if (isset($parts['user']) || isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true)) {
            $error = 'Aplikace běží na vlastní (sub)doméně – adresa nesmí obsahovat cestu ani parametry (jen https://mistenka.example.cz).';
            return null;
        }
        return $scheme . '://' . $host . (isset($parts['port']) ? ':' . (int) $parts['port'] : '');
    }

    // Návrh adresy pro průvodce: dosavadní adresa, pokud nejde o vzorovou ani o adresu samotného webu, jinak mistenka.<doména webu>.
    public static function suggestAppUrl(): string
    {
        $current = self::appUrl();
        $host = strtolower((string) wp_parse_url($current, PHP_URL_HOST));
        if ($host !== '' && !str_ends_with($host, 'example.cz') && !self::sameHostAsSite($current)) return $current;
        $site = preg_replace('/^www\./', '', strtolower((string) wp_parse_url(home_url(), PHP_URL_HOST)));
        return 'https://mistenka.' . $site;
    }

    // Aplikace na stejném hostu jako web převezme jeho úvodní stránku (vhodné jen pro WordPress vyhrazený Místence).
    public static function sameHostAsSite(string $url): bool
    {
        $a = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        return $a !== '' && $a === strtolower((string) wp_parse_url(home_url(), PHP_URL_HOST));
    }

    // Ověří, že adresa míří na tento WordPress s Místenkou: stáhne z ní js/env.js (generuje ho jen plugin).
    public static function verifyAppUrl(string $url): array
    {
        // Náhodná výzva: odpověď (HMAC s klíčem z wp-config) umí spočítat jen tato instalace – jiný web s Místenkou ne.
        $nonce = wp_generate_password(24, false);
        $response = wp_remote_get($url . '/js/env.js?' . self::VERIFY_PARAM . '=' . $nonce, ['timeout' => 10, 'redirection' => 0, 'headers' => ['Cache-Control' => 'no-cache']]);
        if (is_wp_error($response)) {
            $message = $response->get_error_message();
            $hint = stripos($message, 'ssl') !== false || stripos($message, 'certificate') !== false
                ? 'Chyba HTTPS certifikátu – zapněte pro subdoménu SSL (Let\'s Encrypt) v administraci hostingu.'
                : 'Adresa není dostupná – zkontrolujte, že subdoména existuje a míří do složky tohoto WordPressu (změna DNS se může projevit až za několik hodin).';
            $result = ['ok' => false, 'message' => $hint . ' (' . $message . ')'];
        } else {
            $code = (int) wp_remote_retrieve_response_code($response);
            $body = (string) wp_remote_retrieve_body($response);
            $proof = (string) wp_remote_retrieve_header($response, 'x-mistenka-proof');
            if ($code === 200 && str_contains($body, 'MISTENKA_ENV') && hash_equals(self::verifyProof($nonce), $proof)) $result = ['ok' => true, 'message' => 'Adresa funguje – odpovídá tento WordPress s Místenkou.'];
            elseif ($code === 200 && str_contains($body, 'MISTENKA_ENV')) $result = ['ok' => false, 'message' => 'Na adrese běží Místenka jiné instalace (jiný web) – zadejte adresu tohoto webu. Odkazy v e-mailech by jinak vedly na cizí instalaci.'];
            elseif ($code >= 300 && $code < 400) $result = ['ok' => false, 'message' => 'Adresa přesměrovává jinam (HTTP ' . $code . ': ' . wp_remote_retrieve_header($response, 'location') . ') – zkontrolujte přesměrování na hostingu, případně zadejte cílovou adresu.'];
            else $result = ['ok' => false, 'message' => 'Na adrese odpovídá jiný web (HTTP ' . $code . ') – subdoména musí mířit do složky tohoto WordPressu.'];
        }
        $result += ['url' => $url, 'at' => time()];
        update_option(self::APP_URL_CHECK_OPTION, $result, false);
        return $result;
    }

    // Uloží adresu z průvodce, přepíše pravidla .htaccess pro nový host a adresu ověří.
    public static function saveAppUrl(string $url): array
    {
        update_option(self::APP_URL_OPTION, $url, true);
        if (self::htaccessStatus() !== 'not_needed') self::writeHtaccess();
        return self::verifyAppUrl($url);
    }

    // Odpověď na výzvu z ověření adresy. Klíč je odvozený ze solí wp-config.php a slouží jen k tomuto účelu.
    private static function verifyProof(string $nonce): string
    {
        return hash_hmac('sha256', $nonce, hash_hmac('sha256', 'mistenka-app-url-verify', wp_salt('auth')));
    }

    public static function lastAppUrlCheck(): ?array
    {
        $check = get_option(self::APP_URL_CHECK_OPTION, null);
        return is_array($check) && ($check['url'] ?? '') === self::appUrl() ? $check : null;
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
        if ($file === 'js/env.js') {
            $nonce = (string) ($_GET[self::VERIFY_PARAM] ?? '');
            if ($nonce !== '' && strlen($nonce) <= 64) header('X-Mistenka-Proof: ' . self::verifyProof($nonce));
            self::sendStatic('js', self::envJs());
        }
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
