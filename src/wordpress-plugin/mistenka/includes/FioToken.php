<?php
// Token Fio API (jen pro čtení) pro automatické párování plateb (odpovídá src/node/lib/fio-token.js).
//
// Zdroj tokenu: konstanta MISTENKA_FIO_TOKEN ve wp-config.php (má přednost, v portálu ji nejde změnit), jinak token
// zadaný adminem v portálu (Bankovní spojení → Párování s bankou). Ten je v provozní databázi jen zašifrovaný
// (meta fio_token, klíč MISTENKA_SECRET_KEY / secret.key v datové složce) a server ho nikdy nevrací. Testovací
// databáze ho nedostane – banku stahuje vždy jen provoz (viz TestMode).
namespace Mistenka;

defined('ABSPATH') || exit;

final class FioToken
{
    private const META = 'fio_token';
    private const TOKEN_RE = '/^[A-Za-z0-9]{20,128}$/';

    private static function stored(): ?array
    {
        $raw = TestMode::withMode(false, fn() => Db::metaGet(self::META));
        $data = $raw ? json_decode($raw, true) : null;
        return is_array($data) ? $data : null;
    }

    public static function token(): string
    {
        if (Env::fioToken() !== '') return Env::fioToken();
        $s = self::stored();
        return !empty($s['enc']) ? Security::decrypt($s['enc']) : ''; // jiný klíč → prázdné, token je potřeba zadat znovu
    }

    public static function status(): array
    {
        if (Env::fioToken() !== '') return ['configured' => true, 'source' => 'env', 'updatedAt' => null, 'updatedBy' => null];
        $s = self::stored();
        $has = !empty($s['enc']);
        $readable = $has && self::token() !== '';
        return ['configured' => $readable, 'source' => $has ? 'portal' : null, 'updatedAt' => $s['updatedAt'] ?? null, 'updatedBy' => $s['updatedBy'] ?? null, 'unreadable' => $has && !$readable];
    }

    // Uložení / smazání (prázdný token). Audit a e-mail všem adminům jako u změny platebních údajů – v provozní databázi.
    public static function set(?array $actor, array $body): array
    {
        if (Env::fioToken() !== '') throw new ApiError(409, 'fio_token_env', 'Token je nastavený ve wp-config.php (MISTENKA_FIO_TOKEN) – v portálu ho nejde změnit.');
        $value = trim(Js::str($body['token'] ?? ''));
        if ($value !== '' && !preg_match(self::TOKEN_RE, $value)) throw new ApiError(400, 'invalid_fio_token', 'Token Fio má 20–128 písmen a číslic (vygenerujte ho v internetovém bankovnictví Fio: Nastavení → API, jen pro čtení).');
        $before = self::status()['configured'];
        $now = Time::nowIso();
        $actorName = $actor ? (trim(($actor['first_name'] ?? '') . ' ' . ($actor['last_name'] ?? '')) ?: (string) $actor['email']) : 'systém';
        TestMode::withMode(false, function () use ($value, $now, $actorName, $actor, $before) {
            if ($value !== '') Db::metaSet(self::META, wp_json_encode(['enc' => Security::encrypt($value), 'updatedAt' => $now, 'updatedBy' => $actorName]));
            else Db::metaDelete(self::META);
            Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'settings', 'fio_token', NULL)", $now, $actor['id'] ?? null, $value !== '' ? 'fio_token_changed' : 'fio_token_removed');
            $app = App::get();
            $mail = Emails::paymentSettingsChanged($app->config, ['actorName' => $actor ? "{$actorName} ({$actor['email']})" : $actorName, 'before' => ['fioToken' => $before ? 'nastaven' : 'nenastaven'], 'after' => ['fioToken' => $value !== '' ? ($before ? 'nastaven (nový)' : 'nastaven') : 'nenastaven'], 'at' => $now]);
            foreach (Db::all("SELECT email FROM {p}users WHERE CONCAT(',', roles, ',') LIKE '%,admin,%'") as $admin) $app->queueEmail(null, 'payment_settings_changed', $admin['email'], $mail);
        });
        return self::status();
    }

    // Ověření bez posunu zarážky „last“: pohyby za dnešek (endpoint periods). Fio povoluje 1 dotaz za 30 s na token.
    public static function verify(array $config): array
    {
        $token = self::token();
        if ($token === '') throw new ApiError(400, 'fio_token_missing', 'Token Fio není nastavený.');
        $day = Time::pragueToday();
        $response = wp_remote_get('https://fioapi.fio.cz/v1/rest/periods/' . rawurlencode($token) . "/{$day}/{$day}/transactions.json", ['timeout' => 20]);
        if (is_wp_error($response)) return ['ok' => false, 'message' => 'Fio API není dostupné – zkuste to později.']; // bez detailu – URL obsahuje token
        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status === 409) return ['ok' => false, 'message' => 'Fio povoluje jeden dotaz za 30 sekund na token (platby se právě stahují) – zkuste to za chvíli.'];
        if ($status < 200 || $status >= 300) return ['ok' => false, 'message' => "Fio token odmítlo (HTTP {$status}) – zkontrolujte, že je platný a má oprávnění jen pro čtení."];
        $info = json_decode(wp_remote_retrieve_body($response), true)['accountStatement']['info'] ?? [];
        $account = !empty($info['accountId']) ? $info['accountId'] . '/' . ($info['bankId'] ?? '') : '';
        $expected = $config['payment']['accountNumber'] . '/' . $config['payment']['bankCode'];
        $core = fn($number) => ltrim((string) array_slice(explode('-', (string) $number), -1)[0], '0'); // bez předčíslí a úvodních nul
        $matches = $account !== '' ? $core($info['accountId']) === $core($config['payment']['accountNumber']) && (string) ($info['bankId'] ?? '') === (string) $config['payment']['bankCode'] : null;
        $message = $account === '' ? 'Token funguje.' : ($matches === false ? "Token funguje, ale patří účtu {$account} – v Bankovním spojení je {$expected}." : "Token funguje – účet {$account}.");
        return ['ok' => true, 'account' => $account, 'matchesAccount' => $matches, 'message' => $message];
    }
}
