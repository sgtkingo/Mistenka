<?php
// Testovací režim (odpovídá src/node/lib/test-mode.js).
//
// Celý web dočasně běží nad oddělenou testovací databází – tabulky {prefix}mistenka_test_* místo {prefix}mistenka_*,
// zálohy a e-maily v podsložce test/ datové složky. Provozní data test nikdy nevidí ani nezmění. Přepíná admin
// v portálu (Admin → Testování); na ostrém webu ho zakáže define('MISTENKA_TEST_MODE', false) ve wp-config.php.
//
// - Testovací databáze vzniká kopií provozní konfigurace (nastavení, revíry, mapy, sezony, zarybnění, vývěska,
//   e-mailové účty, účty správců s relacemi) bez místenek, plateb, úlovků, rybářských účtů, hlášení a auditu.
// - Platby v testu: simulované (falešná banka), nebo ostré přes Fio. Fio vydá každou transakci jen jednou,
//   proto banku stahuje jen provoz – i během testu – a transakci s testovacím VS (začíná 9) předá testu.
// - Stav přepínače je v options (mimo obě databáze).
namespace Mistenka;

defined('ABSPATH') || exit;

final class TestMode
{
    public const OPTION = 'mistenka_test_mode';
    public const DB_OPTION = 'mistenka_test_db_version';
    public const PAYMENTS = ['fake', 'fio'];
    // Variabilní symboly: provoz 1000000000–8999999999, test 9000000000–9999999999.
    public const VS_RANGES = ['production' => [1000000000, 8999999999], 'test' => [9000000000, 9999999999]];
    private const CLEARED_TABLES = ['tickets', 'ticket_tokens', 'ticket_checks', 'catches', 'bank_transactions', 'email_outbox', 'bug_reports',
        'limit_violations', 'member_blocks', 'season_reports', 'backups', 'auth_tokens', 'audit_events', 'warden_requests', 'vouchers', 'rate_limits'];
    private const CLEARED_META = ['setup_token', 'last_daily_backup', 'last_retention', 'fio_token']; // token Fio jen v provozu
    private const STAFF = "(CONCAT(',', roles, ',') LIKE '%,admin,%' OR CONCAT(',', roles, ',') LIKE '%,manager,%' OR CONCAT(',', roles, ',') LIKE '%,warden,%')";

    public static function locked(): bool
    {
        return defined('MISTENKA_TEST_MODE') && !MISTENKA_TEST_MODE;
    }

    public static function state(): array
    {
        $state = get_option(self::OPTION, []);
        $state = array_merge(['enabled' => false, 'payments' => 'fake', 'since' => null, 'by' => null, 'seededAt' => null], is_array($state) ? $state : []);
        $state['enabled'] = !empty($state['enabled']) && !self::locked();
        return $state;
    }

    public static function enabled(): bool
    {
        return self::state()['enabled'];
    }

    public static function payments(): string
    {
        return self::state()['payments'];
    }

    // Otázka po aktualizaci ze starší verze (dřív zvláštní balíček s falešnou bankou): dokud admin webu neodpoví.
    public static function answered(): bool
    {
        return get_option(self::OPTION, null) !== null;
    }

    // Odpověď na otázku po aktualizaci (wp-admin): ostrý web, nebo testovací web (zapne testovací režim).
    public static function answer(bool $testSite): void
    {
        if ($testSite) self::set(null, ['enabled' => true]);
        else self::save(['enabled' => false]);
    }

    private static function save(array $changes): void
    {
        $raw = get_option(self::OPTION, []);
        update_option(self::OPTION, array_merge(is_array($raw) ? $raw : [], $changes), false);
    }

    public static function isTestVs($vs): bool
    {
        return (bool) preg_match('/^9\d{9}$/', ltrim(Js::str($vs), '0'));
    }

    // Spustí $fn nad provozní (false) nebo testovací (true) databází a vrátí původní stav.
    public static function withMode(bool $test, callable $fn)
    {
        $before = Db::isTest();
        Db::useTest($test);
        try {
            return $fn();
        } finally {
            Db::useTest($before);
        }
    }

    public static function testDatabaseExists(): bool
    {
        global $wpdb;
        return (bool) $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like(Db::prefixFor(true) . 'meta')));
    }

    // Založí testovací databázi znovu jako kopii provozní a vyprázdní provozní data.
    public static function seed(): void
    {
        global $wpdb;
        $prod = Db::prefixFor(false);
        $test = Db::prefixFor(true);
        foreach (array_reverse(Db::tables()) as $table) $wpdb->query("DROP TABLE IF EXISTS `{$test}{$table}`");
        foreach (Db::tables() as $table) {
            $wpdb->query("CREATE TABLE `{$test}{$table}` LIKE `{$prod}{$table}`");
            if (!in_array($table, self::CLEARED_TABLES, true)) $wpdb->query("INSERT INTO `{$test}{$table}` SELECT * FROM `{$prod}{$table}`");
        }
        $wpdb->query("DELETE FROM `{$test}users` WHERE NOT " . self::STAFF);
        $wpdb->query("DELETE FROM `{$test}sessions` WHERE user_id NOT IN (SELECT id FROM `{$test}users`)");
        foreach (self::CLEARED_META as $key) $wpdb->query($wpdb->prepare("DELETE FROM `{$test}meta` WHERE name = %s", $key));
        update_option(self::DB_OPTION, Db::SCHEMA_VERSION, false);
        delete_option('mistenka_fake_bank_queue_test');
        delete_option('mistenka_last_payment_sync_test');
        self::save(['seededAt' => Time::nowIso()]);
    }

    // Při zapnutí: správci z provozu do testu (i do starší testovací databáze) – podle e-mailu se doplní nebo aktualizují
    // (role, heslo, 2FA) a dostanou své relace, aby admin po přepnutí zůstal přihlášený a mohl režim zase vypnout.
    private static function syncStaff(): void
    {
        global $wpdb;
        $prod = Db::prefixFor(false);
        $test = Db::prefixFor(true);
        foreach ((array) $wpdb->get_results("SELECT * FROM `{$prod}users` WHERE " . self::STAFF, ARRAY_A) as $user) {
            $prodId = (int) $user['id'];
            unset($user['id']);
            $testId = (int) $wpdb->get_var($wpdb->prepare("SELECT id FROM `{$test}users` WHERE LOWER(email) = LOWER(%s)", $user['email']));
            if ($testId) $wpdb->update("{$test}users", $user, ['id' => $testId]);
            else { $wpdb->insert("{$test}users", $user); $testId = (int) $wpdb->insert_id; }
            if (!$testId) continue;
            $wpdb->query($wpdb->prepare("INSERT IGNORE INTO `{$test}sessions` (token_hash, user_id, csrf, created_at, expires_at) SELECT token_hash, %d, csrf, created_at, expires_at FROM `{$prod}sessions` WHERE user_id = %d", $testId, $prodId));
        }
    }

    private static function fioAvailable(): bool
    {
        return FioToken::token() !== '' || Env::dev(); // ve vývoji zastoupí banku provozu falešná banka (/dev/payments)
    }

    private static function actorName(array $user): string
    {
        $name = trim(($user['first_name'] ?? $user['firstName'] ?? '') . ' ' . ($user['last_name'] ?? $user['lastName'] ?? ''));
        return $name !== '' ? $name : (string) ($user['email'] ?? '');
    }

    public static function view(): array
    {
        $s = self::state();
        return ['enabled' => $s['enabled'], 'payments' => $s['payments'], 'locked' => self::locked(), 'since' => $s['enabled'] ? $s['since'] : null, 'by' => $s['enabled'] ? $s['by'] : null,
            'seededAt' => self::testDatabaseExists() ? $s['seededAt'] : null, 'fioAvailable' => self::fioAvailable()];
    }

    public static function set(?array $actor, array $body): array
    {
        $before = self::state();
        $enabled = array_key_exists('enabled', $body) ? $body['enabled'] === true : $before['enabled'];
        $payments = array_key_exists('payments', $body) ? Js::str($body['payments']) : $before['payments'];
        if (!in_array($payments, self::PAYMENTS, true)) throw new ApiError(400, 'invalid_payments', 'Platby v testu musí být „fake“ (simulované) nebo „fio“ (ostré).');
        if ($payments === 'fio' && !self::fioAvailable()) throw new ApiError(400, 'fio_unavailable', 'Ostré platby v testu potřebují platby přes Fio (MISTENKA_FIO_TOKEN).');
        if ($enabled && self::locked()) throw new ApiError(403, 'test_mode_locked', 'Testovací režim je na tomto webu zakázaný (MISTENKA_TEST_MODE ve wp-config.php).');
        $name = $actor ? self::actorName($actor) : 'administrátor webu';
        $changes = ['enabled' => $enabled, 'payments' => $payments];
        if ($enabled && !$before['enabled']) $changes += ['since' => Time::nowIso(), 'by' => $name];
        if ($enabled && !self::testDatabaseExists()) self::seed();
        self::save($changes);
        if ($enabled && !$before['enabled']) self::syncStaff();
        $action = $enabled !== $before['enabled'] ? ($enabled ? 'test_mode_enabled' : 'test_mode_disabled') : ($payments !== $before['payments'] ? 'test_mode_payments' : null);
        if ($action) self::notify($actor, $action, ['payments' => $payments, 'by' => $name]);
        return self::view();
    }

    public static function reset(?array $actor): array
    {
        self::seed();
        self::notify($actor, 'test_mode_reset', ['by' => $actor ? self::actorName($actor) : 'administrátor webu']);
        return self::view();
    }

    // Audit a e-mail adminům vždy v provozní databázi.
    private static function notify(?array $actor, string $action, array $detail): void
    {
        self::withMode(false, fn() => App::get()->accounts->notifyTestMode($actor, $action, $detail));
    }

    // Ostré platby v testu: provoz předá transakci s testovacím VS testovací databázi (null = zpracuje ji provoz).
    public static function forward(array $tx): ?string
    {
        if (Db::isTest()) return null;
        $s = self::state();
        if (!$s['enabled'] || $s['payments'] !== 'fio' || !self::isTestVs($tx['variableSymbol'] ?? '')) return null;
        $vs = ltrim(Js::str($tx['variableSymbol']), '0');
        if (Db::row('SELECT 1 AS x FROM {p}tickets WHERE variable_symbol = ?', $vs)) return null; // starší provozní místenka s VS na 9
        return self::withMode(true, fn() => App::get()->service->processTransaction($tx));
    }
}
