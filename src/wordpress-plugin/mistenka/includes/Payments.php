<?php
// Zdroje příchozích plateb (src/node/lib/payments.js). Každý adaptér vrací transakce ve stejném tvaru:
// [transactionId, bookedAt, amountHalere, currency, variableSymbol, counterAccount, counterName, message]
// Párování a vydání místenky řeší Service, adaptér jen čte z banky.
namespace Mistenka;

defined('ABSPATH') || exit;

interface PaymentProvider
{
    public function name(): string;
    public function minIntervalMs(): int;
    public function fetchTransactions(): array;
}

// Falešná banka pro vývoj: transakce se vkládají přes /dev/payments (fronta v options, PHP nemá stav mezi požadavky).
final class FakeProvider implements PaymentProvider
{
    private const OPTION = 'mistenka_fake_bank_queue';

    public function name(): string { return 'fake'; }
    public function minIntervalMs(): int { return 0; }

    public function push(array $tx): void
    {
        $queue = get_option(self::OPTION, []);
        if (!is_array($queue)) $queue = [];
        $queue[] = [
            'transactionId' => 'FAKE-' . (int) (microtime(true) * 1000) . '-' . wp_rand(1000, 9999),
            'bookedAt' => Time::iso(new \DateTimeImmutable('now', Time::utc())),
            'amountHalere' => (int) $tx['amountHalere'],
            'currency' => $tx['currency'] ?? 'CZK',
            'variableSymbol' => Js::str($tx['variableSymbol'] ?? ''),
            'counterAccount' => '123456789/0800',
            'counterName' => 'Testovací plátce',
            'message' => '',
        ];
        update_option(self::OPTION, $queue, false);
    }

    public function fetchTransactions(): array
    {
        $queue = get_option(self::OPTION, []);
        delete_option(self::OPTION);
        return is_array($queue) ? $queue : [];
    }
}

// Fio API Bankovnictví – endpoint "last" vrací pohyby od posledního stažení. Token jen pro čtení
// (MISTENKA_FIO_TOKEN ve wp-config.php); nikdy ho nelogovat (je součástí URL). Banka povoluje 1 dotaz za 30 s.
final class FioProvider implements PaymentProvider
{
    private string $token;

    public function __construct(string $token)
    {
        if ($token === '') throw new \RuntimeException('Pro platby přes Fio nastavte ve wp-config.php konstantu MISTENKA_FIO_TOKEN.');
        $this->token = $token;
    }

    public function name(): string { return 'fio'; }
    public function minIntervalMs(): int { return 31000; }

    public function fetchTransactions(): array
    {
        $response = wp_remote_get('https://fioapi.fio.cz/v1/rest/last/' . rawurlencode($this->token) . '/transactions.json', ['timeout' => 25]);
        if (is_wp_error($response)) throw new \RuntimeException('Fio API je nedostupné.'); // bez detailu – obsahuje URL s tokenem
        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status === 409) return []; // příliš častý dotaz – zkusíme příště
        if ($status < 200 || $status >= 300) throw new \RuntimeException("Fio API odpovědělo stavem {$status}.");
        $data = json_decode(wp_remote_retrieve_body($response), true);
        $list = $data['accountStatement']['transactionList']['transaction'] ?? [];
        $out = [];
        foreach ($list as $tx) {
            $col = fn($n) => $tx['column' . $n]['value'] ?? null;
            $amount = (float) $col(1);
            $out[] = [
                'transactionId' => Js::str($col(22)),
                'bookedAt' => $col(0) ? Js::str($col(0)) : null,
                'amountHalere' => (int) round($amount * 100),
                'currency' => Js::str($col(14) ?? ''),
                'variableSymbol' => $col(5) ? ltrim(Js::str($col(5)), '0') : '',
                'counterAccount' => implode('/', array_filter([Js::str($col(2)), Js::str($col(3))])),
                'counterName' => $col(10) ? Js::str($col(10)) : '',
                'message' => $col(16) ? Js::str($col(16)) : '',
            ];
        }
        return $out;
    }
}

final class Payments
{
    public static function provider(array $config): PaymentProvider
    {
        $name = $config['payment']['provider'];
        if ($name === 'fio') return new FioProvider(Env::fioToken());
        if ($name === 'fake') return new FakeProvider();
        throw new \RuntimeException("Neznámý poskytovatel plateb: {$name}");
    }

    // QR Platba (SPAYD, standard ČBA). Hodnoty bez diakritiky a bez znaku "*".
    public static function asciiSafe($value, int $max): string
    {
        $text = Js::str($value);
        if (function_exists('remove_accents')) $text = remove_accents($text);
        $text = preg_replace('/[^\x20-\x7E]/', '', $text);
        return substr(trim(str_replace('*', ' ', $text)), 0, $max);
    }

    public static function spayd(string $iban, int $amountHalere, string $variableSymbol, string $message, ?string $recipientName): string
    {
        $parts = ['SPD', '1.0', "ACC:{$iban}", 'AM:' . number_format($amountHalere / 100, 2, '.', ''), 'CC:CZK', "X-VS:{$variableSymbol}"];
        if ($message !== '') $parts[] = 'MSG:' . self::asciiSafe($message, 60);
        if ($recipientName) $parts[] = 'RN:' . self::asciiSafe($recipientName, 35);
        return implode('*', $parts);
    }
}
