<?php
// Databáze pluginu (MySQL/MariaDB přes $wpdb). Tabulky {prefix}mistenka_* odpovídají src/node/lib/db.js.
// SQL se píše s placeholdery „?“ a prefixem {p}; hodnoty se escapují zde (null → NULL).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Db
{
    public const SCHEMA_VERSION = 19;

    // Sloupce, které se z $wpdb (vrací řetězce) převádějí na čísla – výstup API musí mít čísla jako Node.
    private const INT = ['id', 'ticket_id', 'user_id', 'price_halere', 'amount_due_halere', 'return_late', 'no_catch', 'seized_by', 'cancelled_by',
        'totp_last_step', 'amount_halere', 'resolved_by', 'created_by', 'count', 'max_count', 'size_bytes', 'report_id', 'season_id', 'planned',
        'pieces', 'cost_halere', 'pinned', 'weight_estimated', 'lifted_by', 'updated_by', 'actor_user_id', 'n', 's', 'port', 'reset_at', 'decided_by'];
    private const FLOAT = ['length_cm', 'weight_kg', 'kg'];

    private static int $depth = 0;

    public static function prefix(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'mistenka_';
    }

    public static function table(string $name): string
    {
        return self::prefix() . $name;
    }

    private static function literal($value): string
    {
        global $wpdb;
        if ($value === null) return 'NULL';
        if (is_bool($value)) return $value ? '1' : '0';
        if (is_int($value)) return (string) $value;
        if (is_float($value)) {
            if (!is_finite($value)) return 'NULL';
            return rtrim(rtrim(sprintf('%.10F', $value), '0'), '.') ?: '0';
        }
        $text = (string) $value;
        $escaped = $wpdb->dbh instanceof \mysqli ? mysqli_real_escape_string($wpdb->dbh, $text) : addslashes($text);
        return "'" . $escaped . "'";
    }

    // Nahradí {p} prefixem a každé „?“ (mimo řetězce v SQL) escapovanou hodnotou.
    public static function prepare(string $sql, array $params): string
    {
        $sql = str_replace('{p}', self::prefix(), $sql);
        if (!$params) return $sql;
        $out = '';
        $i = 0;
        $quote = null;
        $len = strlen($sql);
        for ($k = 0; $k < $len; $k++) {
            $ch = $sql[$k];
            if ($quote !== null) {
                $out .= $ch;
                if ($ch === $quote) $quote = null;
                continue;
            }
            if ($ch === "'" || $ch === '"' || $ch === '`') { $quote = $ch; $out .= $ch; continue; }
            if ($ch === '?') {
                if (!array_key_exists($i, $params)) throw new \RuntimeException('Chybí hodnota parametru SQL.');
                $out .= self::literal($params[$i++]);
                continue;
            }
            $out .= $ch;
        }
        if ($i !== count($params)) throw new \RuntimeException('Nadbytečné parametry SQL.');
        return $out;
    }

    private static function check(string $sql): void
    {
        global $wpdb;
        if ($wpdb->last_error) {
            $error = $wpdb->last_error;
            $wpdb->last_error = '';
            throw new \RuntimeException('Chyba databáze: ' . $error . ' [' . substr($sql, 0, 300) . ']');
        }
    }

    private static function cast(array $row): array
    {
        foreach ($row as $key => $value) {
            if ($value === null) continue;
            if (in_array($key, self::INT, true)) $row[$key] = (int) $value;
            elseif (in_array($key, self::FLOAT, true)) $row[$key] = (float) $value;
        }
        return $row;
    }

    public static function all(string $sql, ...$params): array
    {
        global $wpdb;
        $query = self::prepare($sql, $params);
        $rows = $wpdb->get_results($query, ARRAY_A);
        self::check($query);
        return array_map([self::class, 'cast'], $rows ?: []);
    }

    public static function row(string $sql, ...$params): ?array
    {
        $rows = self::all($sql, ...$params);
        return $rows[0] ?? null;
    }

    public static function val(string $sql, ...$params)
    {
        $row = self::row($sql, ...$params);
        return $row ? reset($row) : null;
    }

    // UPDATE/DELETE/INSERT → počet změněných řádků.
    public static function exec(string $sql, ...$params): int
    {
        global $wpdb;
        $query = self::prepare($sql, $params);
        $result = $wpdb->query($query);
        self::check($query);
        return (int) $result;
    }

    // INSERT → id nového řádku.
    public static function insert(string $sql, ...$params): int
    {
        global $wpdb;
        self::exec($sql, ...$params);
        return (int) $wpdb->insert_id;
    }

    // Transakce se zámkem pro zápis (obdoba BEGIN IMMEDIATE v SQLite): kapacita, poukazy, párování plateb.
    // Vnořené volání běží uvnitř vnější transakce.
    public static function transaction(callable $fn)
    {
        global $wpdb;
        if (self::$depth > 0) {
            self::$depth++;
            try { return $fn(); } finally { self::$depth--; }
        }
        $lock = self::lockName('tx');
        if ((int) $wpdb->get_var(self::prepare('SELECT GET_LOCK(?, 20)', [$lock])) !== 1) {
            throw new ApiError(503, 'busy', 'Server je právě vytížený, zkuste to prosím znovu.');
        }
        self::$depth = 1;
        try {
            $wpdb->query('START TRANSACTION');
            $result = $fn();
            $wpdb->query('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            $wpdb->query('ROLLBACK');
            throw $error;
        } finally {
            self::$depth = 0;
            $wpdb->query(self::prepare('SELECT RELEASE_LOCK(?)', [$lock]));
        }
    }

    // Pojmenovaný zámek bez čekání (plánované úlohy, odesílání e-mailů): vrátí false, pokud ho drží jiný proces.
    public static function tryLock(string $name): bool
    {
        global $wpdb;
        return (int) $wpdb->get_var(self::prepare('SELECT GET_LOCK(?, 0)', [self::lockName($name)])) === 1;
    }

    public static function unlock(string $name): void
    {
        global $wpdb;
        $wpdb->query(self::prepare('SELECT RELEASE_LOCK(?)', [self::lockName($name)]));
    }

    private static function lockName(string $name): string
    {
        global $wpdb;
        return substr('mistenka_' . $name . '_' . DB_NAME . '_' . $wpdb->prefix, 0, 64);
    }

    public static function metaGet(string $name): ?string
    {
        $value = self::val('SELECT value FROM {p}meta WHERE name = ?', $name);
        return $value === null ? null : (string) $value;
    }

    public static function metaSet(string $name, string $value): void
    {
        self::exec('INSERT INTO {p}meta (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', $name, $value);
    }

    // Spuštění služby: čerstvá instalace je zavřená (sezona uzavřena, registrace a přihlášení rybářů vypnuté),
    // dokud správce ručně neotevře první sezonu. Stav je v meta (obnova ze zálohy ho nemění).
    public static function serviceLaunched(): bool
    {
        return (string) self::metaGet('service_launched_at') !== '';
    }

    // Je dnes otevřená některá sezona? Při uzavřené sezoně se přihlásí jen správci a admini.
    public static function seasonOpen(string $today): bool
    {
        return (bool) self::val('SELECT 1 FROM {p}seasons WHERE deleted_at IS NULL AND opens_on <= ? AND (closes_on IS NULL OR closes_on >= ?) LIMIT 1', $today, $today);
    }

    public static function markLaunched(string $at): void
    {
        if (!self::serviceLaunched()) self::metaSet('service_launched_at', $at);
    }

    public static function metaDelete(string $name): void
    {
        self::exec('DELETE FROM {p}meta WHERE name = ?', $name);
    }

    // Tabulky pluginu bez prefixu (pořadí = pořadí vytvoření).
    public static function tables(): array
    {
        return ['meta', 'users', 'sessions', 'auth_tokens', 'audit_events', 'tickets', 'settings_versions', 'stocking_events', 'stocking_budgets',
            'backups', 'season_reports', 'ticket_checks', 'limit_violations', 'member_blocks', 'announcements', 'seasons', 'closures',
            'ticket_tokens', 'catches', 'vouchers', 'bank_transactions', 'email_outbox', 'email_accounts', 'warden_requests', 'rate_limits'];
    }

    // Vytvoření a aktualizace tabulek (dbDelta) – při aktivaci a po aktualizaci pluginu.
    public static function install(): void
    {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $c = $wpdb->get_charset_collate();
        $p = self::prefix();
        $ts = 'VARCHAR(30)';   // ISO okamžik v UTC (2026-06-10T08:00:00.000Z)
        $d = 'VARCHAR(10)';    // YYYY-MM-DD
        $sql = [];
        $sql[] = "CREATE TABLE {$p}meta (
  name VARCHAR(64) NOT NULL,
  value LONGTEXT NULL,
  PRIMARY KEY  (name)
) $c;";
        $sql[] = "CREATE TABLE {$p}users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(191) NOT NULL,
  email_verified_at $ts NULL,
  password_hash VARCHAR(255) NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  birth_date $d NULL,
  member_id VARCHAR(20) NULL,
  roles VARCHAR(100) NOT NULL DEFAULT 'member',
  totp_secret VARCHAR(64) NULL,
  totp_enabled_at $ts NULL,
  totp_last_step BIGINT NULL,
  created_at $ts NOT NULL,
  updated_at $ts NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY email (email),
  UNIQUE KEY member_id (member_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}sessions (
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  csrf VARCHAR(64) NOT NULL,
  created_at $ts NOT NULL,
  expires_at $ts NOT NULL,
  PRIMARY KEY  (token_hash),
  KEY user_id (user_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}auth_tokens (
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(30) NOT NULL,
  new_email VARCHAR(191) NULL,
  created_at $ts NOT NULL,
  expires_at $ts NOT NULL,
  used_at $ts NULL,
  PRIMARY KEY  (token_hash),
  KEY user_purpose (user_id,purpose)
) $c;";
        $sql[] = "CREATE TABLE {$p}audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at $ts NOT NULL,
  actor_user_id BIGINT NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id VARCHAR(191) NULL,
  detail LONGTEXT NULL,
  PRIMARY KEY  (id),
  KEY action (action)
) $c;";
        $sql[] = "CREATE TABLE {$p}tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(6) NOT NULL,
  revir_id VARCHAR(40) NOT NULL,
  subdistrict VARCHAR(20) NULL,
  fishing_date $d NOT NULL,
  member_id VARCHAR(20) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  birth_date VARCHAR(10) NOT NULL,
  email VARCHAR(200) NOT NULL,
  price_halere INT NOT NULL,
  amount_due_halere INT NOT NULL,
  variable_symbol VARCHAR(10) NULL,
  voucher_code VARCHAR(16) NULL,
  status VARCHAR(20) NOT NULL,
  created_at $ts NOT NULL,
  reserved_until $ts NULL,
  paid_at $ts NULL,
  issued_at $ts NULL,
  cancelled_at $ts NULL,
  returned_at $ts NULL,
  closed_at $ts NULL,
  return_late TINYINT NOT NULL DEFAULT 0,
  no_catch TINYINT NOT NULL DEFAULT 0,
  reminder_sent_at $ts NULL,
  user_id BIGINT UNSIGNED NULL,
  seized_at $ts NULL,
  seized_by BIGINT NULL,
  seized_reason VARCHAR(500) NULL,
  seized_place VARCHAR(200) NULL,
  cancel_reason VARCHAR(300) NULL,
  cancelled_by BIGINT NULL,
  rules_version VARCHAR(120) NULL,
  anonymized_at $ts NULL,
  suspicious TINYINT NOT NULL DEFAULT 0,
  suspicion_cleared_at $ts NULL,
  suspicion_cleared_by BIGINT NULL,
  suspicion_note VARCHAR(300) NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY code (code),
  UNIQUE KEY variable_symbol (variable_symbol),
  KEY capacity (revir_id,fishing_date,status),
  KEY member (member_id,fishing_date),
  KEY user_id (user_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}settings_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope VARCHAR(120) NOT NULL,
  data LONGTEXT NOT NULL,
  note VARCHAR(200) NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  PRIMARY KEY  (id),
  KEY scope (scope,id)
) $c;";
        $sql[] = "CREATE TABLE {$p}stocking_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revir_id VARCHAR(40) NOT NULL,
  subdistrict VARCHAR(20) NULL,
  date $d NOT NULL,
  planned TINYINT NOT NULL DEFAULT 0,
  species_id VARCHAR(60) NULL,
  species_name VARCHAR(60) NOT NULL,
  age_class VARCHAR(30) NULL,
  kg DOUBLE NULL,
  pieces INT NULL,
  cost_halere BIGINT NULL,
  supplier VARCHAR(120) NULL,
  note VARCHAR(500) NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  updated_at $ts NOT NULL,
  deleted_at $ts NULL,
  PRIMARY KEY  (id),
  KEY date (date)
) $c;";
        $sql[] = "CREATE TABLE {$p}stocking_budgets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  year VARCHAR(4) NOT NULL,
  revir_id VARCHAR(40) NULL,
  amount_halere BIGINT NOT NULL,
  note VARCHAR(300) NULL,
  updated_by BIGINT NULL,
  updated_at $ts NOT NULL,
  PRIMARY KEY  (id),
  KEY year (year)
) $c;";
        $sql[] = "CREATE TABLE {$p}backups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind VARCHAR(20) NOT NULL,
  file VARCHAR(191) NOT NULL,
  size_bytes BIGINT NOT NULL,
  note VARCHAR(200) NULL,
  report_id BIGINT NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  PRIMARY KEY  (id)
) $c;";
        $sql[] = "CREATE TABLE {$p}season_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  season_id BIGINT NULL,
  revir_id VARCHAR(40) NULL,
  date_from $d NOT NULL,
  date_to $d NOT NULL,
  data LONGTEXT NOT NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  PRIMARY KEY  (id)
) $c;";
        $sql[] = "CREATE TABLE {$p}ticket_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT NULL,
  warden_name VARCHAR(201) NOT NULL,
  at $ts NOT NULL,
  status VARCHAR(30) NOT NULL,
  PRIMARY KEY  (id),
  KEY ticket (ticket_id,at)
) $c;";
        $sql[] = "CREATE TABLE {$p}limit_violations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  member_id VARCHAR(20) NOT NULL,
  limit_id VARCHAR(60) NOT NULL,
  label VARCHAR(200) NOT NULL,
  period VARCHAR(10) NOT NULL,
  period_from $d NOT NULL,
  period_to $d NOT NULL,
  count INT NOT NULL,
  max_count INT NOT NULL,
  created_at $ts NOT NULL,
  PRIMARY KEY  (id),
  KEY member (member_id,created_at)
) $c;";
        $sql[] = "CREATE TABLE {$p}member_blocks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  until_date $d NULL,
  source VARCHAR(10) NOT NULL,
  cause VARCHAR(20) NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  lifted_at $ts NULL,
  lifted_by BIGINT NULL,
  PRIMARY KEY  (id),
  KEY member (member_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}announcements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revir_id VARCHAR(40) NULL,
  title VARCHAR(120) NOT NULL,
  text TEXT NOT NULL,
  valid_from $d NULL,
  valid_to $d NULL,
  pinned TINYINT NOT NULL DEFAULT 0,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  updated_at $ts NOT NULL,
  deleted_at $ts NULL,
  PRIMARY KEY  (id)
) $c;";
        $sql[] = "CREATE TABLE {$p}seasons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revir_id VARCHAR(40) NULL,
  name VARCHAR(80) NOT NULL,
  opens_on $d NOT NULL,
  closes_on $d NULL,
  closed_report_at $ts NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  updated_at $ts NOT NULL,
  deleted_at $ts NULL,
  PRIMARY KEY  (id)
) $c;";
        $sql[] = "CREATE TABLE {$p}closures (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revir_id VARCHAR(40) NULL,
  date_from $d NOT NULL,
  date_to $d NOT NULL,
  reason VARCHAR(300) NOT NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  deleted_at $ts NULL,
  PRIMARY KEY  (id)
) $c;";
        $sql[] = "CREATE TABLE {$p}ticket_tokens (
  token_hash CHAR(64) NOT NULL,
  ticket_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(10) NOT NULL,
  created_at $ts NOT NULL,
  PRIMARY KEY  (token_hash),
  KEY ticket_id (ticket_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}catches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  species VARCHAR(60) NOT NULL,
  length_cm DOUBLE NOT NULL,
  weight_kg DOUBLE NULL,
  weight_estimated TINYINT NOT NULL DEFAULT 0,
  suspect VARCHAR(300) NULL,
  PRIMARY KEY  (id),
  KEY ticket_id (ticket_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}vouchers (
  code VARCHAR(16) NOT NULL,
  revir_id VARCHAR(40) NULL,
  used_at $ts NULL,
  ticket_code VARCHAR(6) NULL,
  created_at $ts NULL,
  created_by BIGINT NULL,
  note VARCHAR(200) NULL,
  voided_at $ts NULL,
  PRIMARY KEY  (code)
) $c;";
        $sql[] = "CREATE TABLE {$p}bank_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider VARCHAR(20) NOT NULL,
  transaction_id VARCHAR(100) NOT NULL,
  booked_at VARCHAR(40) NULL,
  amount_halere BIGINT NOT NULL,
  currency VARCHAR(10) NOT NULL,
  variable_symbol VARCHAR(20) NULL,
  counter_account VARCHAR(100) NULL,
  counter_name VARCHAR(200) NULL,
  message VARCHAR(500) NULL,
  ticket_id BIGINT UNSIGNED NULL,
  result VARCHAR(30) NOT NULL,
  note VARCHAR(300) NULL,
  created_at $ts NOT NULL,
  resolution VARCHAR(20) NULL,
  resolution_note VARCHAR(300) NULL,
  resolved_at $ts NULL,
  resolved_by BIGINT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY provider_tx (provider,transaction_id),
  KEY ticket_id (ticket_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}email_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NULL,
  kind VARCHAR(40) NOT NULL,
  to_email VARCHAR(200) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body_html LONGTEXT NOT NULL,
  body_text LONGTEXT NOT NULL,
  created_at $ts NOT NULL,
  sent_at $ts NULL,
  error VARCHAR(500) NULL,
  sender VARCHAR(120) NULL,
  PRIMARY KEY  (id),
  KEY pending (sent_at,id),
  KEY ticket_id (ticket_id)
) $c;";
        $sql[] = "CREATE TABLE {$p}email_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  label VARCHAR(80) NOT NULL,
  from_email VARCHAR(200) NOT NULL,
  from_name VARCHAR(100) NULL,
  host VARCHAR(253) NOT NULL,
  port INT NOT NULL,
  encryption VARCHAR(10) NOT NULL,
  username VARCHAR(200) NULL,
  password_enc TEXT NULL,
  verified_at $ts NULL,
  verified_to VARCHAR(200) NULL,
  last_error VARCHAR(500) NULL,
  created_by BIGINT NULL,
  created_at $ts NOT NULL,
  updated_at $ts NOT NULL,
  deleted_at $ts NULL,
  PRIMARY KEY  (id)
) $c;";
        // Hlášení chyb z webu (tlačítko s broukem). Snímek obrazovky jako data URL, záznam událostí jako JSON.
        $sql[] = "CREATE TABLE {$p}bug_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at $ts NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  contact_email VARCHAR(200) NULL,
  description TEXT NOT NULL,
  url VARCHAR(500) NULL,
  user_agent VARCHAR(400) NULL,
  viewport VARCHAR(40) NULL,
  client_time VARCHAR(40) NULL,
  log MEDIUMTEXT NULL,
  screenshot MEDIUMTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  note TEXT NULL,
  github_url VARCHAR(300) NULL,
  resolved_at $ts NULL,
  updated_at $ts NULL,
  updated_by BIGINT UNSIGNED NULL,
  PRIMARY KEY  (id),
  KEY status (status)
) $c;";
        // Žádosti „Jsem porybný“ (notifikace pro správce). unverified = čeká na ověření e-mailu žadatele.
        $sql[] = "CREATE TABLE {$p}warden_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL,
  note VARCHAR(300) NULL,
  created_at $ts NOT NULL,
  submitted_at $ts NULL,
  decided_at $ts NULL,
  decided_by BIGINT NULL,
  decided_via VARCHAR(10) NULL,
  decision_note VARCHAR(300) NULL,
  action_token_hash CHAR(64) NULL,
  action_expires_at $ts NULL,
  PRIMARY KEY  (id),
  KEY user_id (user_id,id),
  KEY action_token (action_token_hash)
) $c;";
        $sql[] = "CREATE TABLE {$p}rate_limits (
  bucket VARCHAR(191) NOT NULL,
  count INT NOT NULL,
  reset_at BIGINT NOT NULL,
  PRIMARY KEY  (bucket)
) $c;";
        $previous = 0;
        global $wpdb;
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->prefix . 'mistenka_meta'))) $previous = (int) self::metaGet('schema_version');
        dbDelta($sql);
        // v16: instalace, která už prodávala (má místenky nebo sezony), je spuštěná – nové pravidlo ji nezavře.
        if ($previous && $previous < 16 && (self::val('SELECT 1 FROM {p}tickets LIMIT 1') || self::val('SELECT 1 FROM {p}seasons WHERE deleted_at IS NULL LIMIT 1'))) {
            self::markLaunched(Time::nowIso());
        }
        self::metaSet('schema_version', (string) self::SCHEMA_VERSION);
    }

    public static function uninstall(): void
    {
        global $wpdb;
        foreach (array_reverse(self::tables()) as $table) {
            $wpdb->query('DROP TABLE IF EXISTS `' . self::table($table) . '`');
        }
    }
}
