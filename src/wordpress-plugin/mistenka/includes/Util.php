<?php
// Společné pomocné třídy: prostředí (wp-config.php), chyby API, validace, hesla, tokeny a 2FA (TOTP).
// Odpovídá src/node/lib/validate.js a security.js.
namespace Mistenka;

defined('ABSPATH') || exit;

// Konfigurace serveru z wp-config.php (nikdy z databáze ani z repozitáře):
//   MISTENKA_CRON_KEY      tajný klíč pro POST /jobs/run (cron hostingu)
//   MISTENKA_FIO_TOKEN     token Fio API jen pro čtení (payment.provider = "fio")
//   MISTENKA_SECRET_KEY    klíč pro šifrování hesel SMTP účtů (jinak se vygeneruje do datové složky)
//   MISTENKA_APP_URL       adresa aplikace – volitelné; jinak průvodce ve wp-admin, pak organization.appUrl
//   MISTENKA_CONFIG        cesta ke konfiguraci MO (jinak config/organization.json pluginu)
//   MISTENKA_DATA_DIR      složka pro zálohy a soubory (jinak wp-content/mistenka-data)
//   MISTENKA_MAIL_TRANSPORT  smtp (výchozí) | file – e-maily jen do datové složky (vývoj, testy)
//   MISTENKA_DEV           true = vývojové endpointy /dev/* (jen vývoj!)
//   MISTENKA_TEST_MODE     false = testovací režim (Admin → Testování) nejde zapnout – ostrý web
//   MISTENKA_RATE_LIMIT    false = vypnout omezení počtu požadavků (jen testy)
final class Env
{
    private static function constant(string $name, $default = null)
    {
        return defined($name) ? constant($name) : $default;
    }

    public static function dev(): bool
    {
        return (bool) self::constant('MISTENKA_DEV', false);
    }

    public static function cronKey(): string
    {
        return (string) self::constant('MISTENKA_CRON_KEY', '');
    }

    public static function fioToken(): string
    {
        return (string) self::constant('MISTENKA_FIO_TOKEN', '');
    }

    public static function rateLimits(): bool
    {
        $value = self::constant('MISTENKA_RATE_LIMIT', true);
        return !($value === false || $value === 0 || $value === '0');
    }

    public static function mailTransport(): string
    {
        return self::constant('MISTENKA_MAIL_TRANSPORT', 'smtp') === 'file' ? 'file' : 'smtp';
    }

    // Klíč Mapy.com pro podklad interaktivní mapy (používá se v prohlížeči; bez něj OpenStreetMap).
    public static function mapyApiKey(): string
    {
        return (string) self::constant('MISTENKA_MAPY_API_KEY', '');
    }

    public static function configFile(): string
    {
        return (string) self::constant('MISTENKA_CONFIG', MISTENKA_DIR . 'config/organization.json');
    }

    // Datová složka podle režimu: testovací režim má zálohy a e-maily v podsložce test/ (klíč hesel je společný).
    public static function modeDataDir(): string
    {
        $dir = self::dataDir();
        if (!Db::isTest()) return $dir;
        if (!is_dir($dir . '/test')) wp_mkdir_p($dir . '/test');
        return $dir . '/test';
    }

    public static function dataDir(): string
    {
        $dir = rtrim((string) self::constant('MISTENKA_DATA_DIR', WP_CONTENT_DIR . '/mistenka-data'), '/\\');
        if (!is_dir($dir)) wp_mkdir_p($dir);
        // Složka nesmí být dostupná z webu.
        if (is_dir($dir) && !file_exists($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
            @file_put_contents($dir . '/index.php', "<?php // Tichý přístup.\n");
        }
        return $dir;
    }

    public static function secretKey(): string
    {
        $fromConstant = (string) self::constant('MISTENKA_SECRET_KEY', '');
        if ($fromConstant !== '') return hash('sha256', $fromConstant, true);
        $file = self::dataDir() . '/secret.key';
        if (!file_exists($file)) {
            @file_put_contents($file, base64_encode(random_bytes(32)));
            @chmod($file, 0600);
        }
        $stored = file_exists($file) ? base64_decode(trim((string) file_get_contents($file)), true) : false;
        if ($stored && strlen($stored) === 32) return $stored;
        return hash('sha256', wp_salt('secure_auth') . 'mistenka-smtp', true); // nouzově, když nejde zapisovat
    }
}

class ApiError extends \Exception
{
    public int $status;
    public string $apiCode;

    public function __construct(int $status, string $code, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->apiCode = $code;
    }
}

// Sémantika JavaScriptu tam, kde na ní závisí validace (Number(), Number.isInteger, String()).
final class Js
{
    public static function number($value): float
    {
        if (is_int($value) || is_float($value)) return (float) $value;
        if (is_bool($value)) return $value ? 1.0 : 0.0;
        if ($value === null) return 0.0;
        if (is_string($value)) {
            $trimmed = trim($value);
            if ($trimmed === '') return 0.0;
            return is_numeric($trimmed) ? (float) $trimmed : NAN;
        }
        return NAN;
    }

    // Number.isInteger bez převodu (řetězec "3" není celé číslo).
    public static function isInteger($value): bool
    {
        if (is_int($value)) return true;
        return is_float($value) && is_finite($value) && floor($value) == $value;
    }

    // Number.isInteger(Number(value)).
    public static function isIntegerish($value): bool
    {
        if ($value === null) return false;
        $n = self::number($value);
        return is_finite($n) && floor($n) == $n;
    }

    public static function isNumber($value): bool
    {
        return is_int($value) || is_float($value);
    }

    public static function str($value): string
    {
        if ($value === null) return '';
        if (is_bool($value)) return $value ? 'true' : 'false';
        if (is_float($value)) return floor($value) == $value && abs($value) < 1e15 ? (string) (int) $value : (string) $value;
        if (is_array($value)) return '';
        return (string) $value;
    }

    // Hodnota je „pravdivá“ jako v JS (prázdný řetězec, 0, null, false = nepravdivé; "0" a [] pravdivé).
    public static function truthy($value): bool
    {
        if (is_array($value) || $value === '0') return true;
        if (is_float($value) && is_nan($value)) return false;
        return (bool) $value;
    }

    // String(value || "")
    public static function s($value): string
    {
        return self::truthy($value) ? self::str($value) : '';
    }

    // Math.round (polovina nahoru).
    public static function round(float $value): float
    {
        return floor($value + 0.5);
    }

    public static function round2(float $value): float
    {
        return floor($value * 100 + 0.5) / 100;
    }

    public static function round1(float $value): float
    {
        return floor($value * 10 + 0.5) / 10;
    }

    public static function len(string $text): int
    {
        return mb_strlen($text, 'UTF-8');
    }

    public static function lower(string $text): string
    {
        return mb_strtolower($text, 'UTF-8');
    }

    public static function slice(string $text, int $start, ?int $length = null): string
    {
        return mb_substr($text, $start, $length, 'UTF-8');
    }

    // Objekt (asociativní pole) v JSON: prázdné pole se zakóduje jako {}.
    public static function obj($value)
    {
        return is_array($value) && !$value ? new \stdClass() : $value;
    }

    public static function isAssoc($value): bool
    {
        return is_array($value) && ($value === [] || array_keys($value) !== range(0, count($value) - 1));
    }
}

final class Validate
{
    public const EMAIL_RE = '/^[^\s@]+@[^\s@]+\.[^\s@]+$/u';
    public const MEMBER_ID_RE = '/^\d{8}$/';

    public static function normalizeMemberId($value): string
    {
        return preg_replace('/\s+/u', '', Js::s($value));
    }

    public static function normalizeEmail($value): string
    {
        return Js::lower(trim(Js::s($value)));
    }

    public static function email($value, string $code = 'invalid_email'): string
    {
        $email = trim(Js::s($value));
        if (!preg_match(self::EMAIL_RE, $email) || Js::len($email) > 200) throw new ApiError(400, $code, 'Zadejte platný e-mail.');
        return $email;
    }

    public static function memberId($value): string
    {
        $memberId = self::normalizeMemberId($value);
        if (!preg_match(self::MEMBER_ID_RE, $memberId)) throw new ApiError(400, 'invalid_member_id', 'Zadejte 8místné číslo členské legitimace (pod čárovým kódem).');
        return $memberId;
    }

    public static function name($first, $last): array
    {
        $firstName = trim(Js::s($first));
        $lastName = trim(Js::s($last));
        if ($firstName === '' || $lastName === '' || Js::len($firstName) > 100 || Js::len($lastName) > 100) throw new ApiError(400, 'invalid_name', 'Vyplňte jméno a příjmení.');
        return [$firstName, $lastName];
    }

    public static function birthDate($value): string
    {
        $birthDate = Js::s($value);
        if (!Time::isIsoDate($birthDate) || $birthDate >= Time::pragueToday() || $birthDate < '1900-01-01') throw new ApiError(400, 'invalid_birth_date', 'Zadejte platné datum narození.');
        return $birthDate;
    }
}

final class Security
{
    private static ?string $dummy = null;

    public static function sha256($value): string
    {
        return hash('sha256', (string) $value);
    }

    public static function randomToken(int $bytes = 32): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    public static function randomInt(int $min, int $maxExclusive): int
    {
        return random_int($min, $maxExclusive - 1);
    }

    public static function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    public static function verifyPassword(string $password, ?string $stored): bool
    {
        return $stored ? password_verify($password, $stored) : false;
    }

    // Porovnání při neexistujícím účtu, aby doba odpovědi neprozradila, zda e-mail existuje.
    public static function dummyHash(): string
    {
        return self::$dummy ??= password_hash(self::randomToken(16), PASSWORD_DEFAULT);
    }

    // ---------- TOTP (RFC 6238, SHA-1, 6 číslic, 30 s) ----------
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function base32Encode(string $bytes): string
    {
        $bits = 0;
        $value = 0;
        $out = '';
        foreach (str_split($bytes) as $byte) {
            $value = (($value << 8) | ord($byte)) & 0xFFFFFFFF;
            $bits += 8;
            while ($bits >= 5) {
                $out .= self::B32[($value >> ($bits - 5)) & 31];
                $bits -= 5;
            }
        }
        if ($bits > 0) $out .= self::B32[($value << (5 - $bits)) & 31];
        return $out;
    }

    public static function base32Decode(string $text): string
    {
        $bits = 0;
        $value = 0;
        $out = '';
        $clean = preg_replace('/[\s=]/', '', strtoupper($text));
        foreach (str_split($clean) as $ch) {
            $index = strpos(self::B32, $ch);
            if ($index === false) throw new \InvalidArgumentException('Neplatný base32.');
            $value = (($value << 5) | $index) & 0xFFFFFFFF;
            $bits += 5;
            if ($bits >= 8) {
                $out .= chr(($value >> ($bits - 8)) & 255);
                $bits -= 8;
            }
        }
        return $out;
    }

    public static function newTotpSecret(): string
    {
        return self::base32Encode(random_bytes(20));
    }

    public static function hotp(string $secret, int $counter): string
    {
        $mac = hash_hmac('sha1', pack('J', $counter), self::base32Decode($secret), true);
        $offset = ord($mac[19]) & 15;
        $code = ((ord($mac[$offset]) & 0x7f) << 24 | ord($mac[$offset + 1]) << 16 | ord($mac[$offset + 2]) << 8 | ord($mac[$offset + 3])) % 1000000;
        return str_pad((string) $code, 6, '0', STR_PAD_LEFT);
    }

    public static function totpStep(int $atMs): int
    {
        return intdiv($atMs, 30000);
    }

    // Ověří kód v okně ±1 krok. Vrátí použitý krok, nebo null. Krok <= lastStep se odmítne (opakované použití).
    public static function verifyTotp(?string $secret, $code, int $atMs, ?int $lastStep = null): ?int
    {
        $clean = preg_replace('/\s+/', '', Js::s($code));
        if (!preg_match('/^\d{6}$/', $clean) || !$secret) return null;
        $now = self::totpStep($atMs);
        foreach ([$now - 1, $now, $now + 1] as $step) {
            if ($lastStep !== null && $step <= $lastStep) continue;
            if (hash_equals(self::hotp($secret, $step), $clean)) return $step;
        }
        return null;
    }

    public static function otpauthUrl(string $secret, string $account, string $issuer): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $account) . '?secret=' . $secret . '&issuer=' . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
    }

    // ---------- šifrování hesel SMTP účtů (AES-256-GCM) ----------
    public static function encrypt(string $text): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $data = openssl_encrypt($text, 'aes-256-gcm', Env::secretKey(), OPENSSL_RAW_DATA, $iv, $tag);
        return 'v1:' . base64_encode($iv . $tag . $data);
    }

    public static function decrypt(?string $value): string
    {
        if (!$value) return '';
        $raw = base64_decode(substr($value, 3), true);
        if ($raw === false || strlen($raw) < 28) return '';
        $out = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', Env::secretKey(), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
        return $out === false ? '' : $out;
    }
}
