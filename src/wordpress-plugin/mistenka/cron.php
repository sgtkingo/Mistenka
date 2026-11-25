<?php
/**
 * Plánované úlohy Místenky pro „PHP CRON“ hostingu (spouští se z příkazové řádky, ne z webu):
 *
 *   php wp-content/plugins/mistenka/cron.php
 *
 * Dělá totéž co POST /jobs/run s klíčem MISTENKA_CRON_KEY (platby, připomínky, uzávěrky, zálohy, e-maily),
 * jen bez HTTP – klíč není potřeba, protože skript jde spustit jen na serveru. Volat každou minutu.
 * Volitelný parametr: cesta k wp-load.php, když plugin neleží ve wp-content/plugins.
 */

// Z webu nic: soubor leží ve veřejné složce pluginu, spustit ho smí jen cron/CLI.
if (PHP_SAPI !== 'cli' && isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

$wpLoad = $argv[1] ?? dirname(__DIR__, 3) . '/wp-load.php';
if (!is_file($wpLoad)) {
    fwrite(STDERR, "Místenka cron: nenalezen wp-load.php ({$wpLoad}).\n");
    exit(1);
}

// Některé části WordPressu (a jiné pluginy) počítají s hlavičkami požadavku.
$_SERVER['HTTP_HOST'] = $_SERVER['HTTP_HOST'] ?? 'localhost';
$_SERVER['SERVER_NAME'] = $_SERVER['SERVER_NAME'] ?? 'localhost';
$_SERVER['REQUEST_URI'] = $_SERVER['REQUEST_URI'] ?? '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
define('DOING_CRON', true);

require $wpLoad;

if (!class_exists(\Mistenka\App::class)) {
    fwrite(STDERR, "Místenka cron: plugin Místenka není aktivní.\n");
    exit(1);
}

try {
    update_option(\Mistenka\Plugin::CRON_OPTION, time(), false);
    $result = \Mistenka\App::get()->runJobs(); // souběhu s WP-cronem a /jobs/run brání zámek v runJobs
    echo wp_json_encode($result), "\n";
} catch (\Throwable $e) {
    error_log('[Místenka cron] ' . $e->getMessage());
    fwrite(STDERR, 'Místenka cron: ' . $e->getMessage() . "\n");
    exit(1);
}
