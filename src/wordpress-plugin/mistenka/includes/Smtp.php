<?php
// Vlastní SMTP klient (bez PHPMaileru a wp_mail): odeslání jednoho e-mailu přes účet z „Emailoví klienti“.
// Referenční chování: src/node/lib/smtp.js.
//
//   šifrování "ssl"  – TLS hned po připojení (obvykle port 465)
//             "tls"  – STARTTLS po EHLO (obvykle port 587), bez podpory serveru = chyba
//             "none" – nešifrované spojení (port 25, jen pro vnitřní sítě)
//   přihlášení AUTH PLAIN, jinak AUTH LOGIN (podle nabídky serveru); bez jména se nepřihlašuje.
//
// Zpráva: multipart/alternative (text + HTML), UTF-8, base64, hlavičky podle RFC 2047.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Smtp
{
    private const TIMEOUT = 20;

    /** @var resource */
    private $socket;

    // RFC 2047: ne-ASCII text v hlavičce jako =?UTF-8?B?…?= (po částech, aby řádek nebyl moc dlouhý).
    public static function encodeHeader(string $value): string
    {
        $text = preg_replace('/[\r\n]+/', ' ', $value);
        if (preg_match('/^[\x20-\x7e]*$/', $text)) return $text;
        $parts = [];
        $chunk = '';
        foreach (preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
            if (strlen($chunk . $ch) > 45) { $parts[] = $chunk; $chunk = ''; }
            $chunk .= $ch;
        }
        if ($chunk !== '') $parts[] = $chunk;
        return implode("\r\n ", array_map(fn($p) => '=?UTF-8?B?' . base64_encode($p) . '?=', $parts));
    }

    private static function address(string $email, string $name): string
    {
        if ($name === '') return "<{$email}>";
        $display = preg_match('/^[\x20-\x7e]*$/', $name) ? '"' . str_replace(['"', '\\'], '', $name) . '"' : self::encodeHeader($name);
        return "{$display} <{$email}>";
    }

    private static function domainOf(string $email): string
    {
        $at = strrchr($email, '@');
        return $at === false || $at === '@' ? 'localhost' : substr($at, 1);
    }

    // Sestaví celou zprávu (hlavičky + tělo) s CRLF konci řádků.
    public static function buildMessage(array $from, string $to, string $subject, string $text, string $html): string
    {
        $boundary = '=_mistenka_' . bin2hex(random_bytes(12));
        $headers = [
            'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
            'From: ' . self::address($from['email'], (string) ($from['name'] ?? '')),
            "To: <{$to}>",
            'Subject: ' . self::encodeHeader($subject),
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . self::domainOf($from['email']) . '>',
            'MIME-Version: 1.0',
            "Content-Type: multipart/alternative; boundary=\"{$boundary}\"",
        ];
        $part = fn(string $type, string $body) => implode("\r\n", ["--{$boundary}", "Content-Type: {$type}; charset=UTF-8", 'Content-Transfer-Encoding: base64', '', rtrim(chunk_split(base64_encode($body), 76, "\r\n"))]);
        return implode("\r\n", $headers) . "\r\n\r\n" . $part('text/plain', $text) . "\r\n" . $part('text/html', $html) . "\r\n--{$boundary}--\r\n";
    }

    // Odešle jeden e-mail. $account = [host, port, encryption, username, password], $from = [email, name].
    public static function send(array $account, array $from, string $to, string $subject, string $text, string $html): void
    {
        $client = new self();
        $client->connect($account);
        try {
            $client->deliver($account, $from, $to, $subject, $text, $html);
        } finally {
            if (is_resource($client->socket)) fclose($client->socket);
        }
    }

    private function connect(array $account): void
    {
        $host = (string) $account['host'];
        $port = (int) $account['port'];
        $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host, 'SNI_enabled' => true]]);
        $target = ($account['encryption'] === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client($target, $errno, $errstr, self::TIMEOUT, STREAM_CLIENT_CONNECT, $context);
        if (!$socket) {
            $last = error_get_last();
            throw new \RuntimeException("Nelze se připojit k {$host}:{$port} – " . ($errstr !== '' ? $errstr : ($last['message'] ?? 'neznámá chyba')));
        }
        stream_set_timeout($socket, self::TIMEOUT);
        $this->socket = $socket;
    }

    // Odpověď serveru: „250-…“ pokračuje, „250 …“ končí.
    private function read(): array
    {
        $lines = [];
        while (true) {
            $line = fgets($this->socket, 4096);
            if ($line === false) {
                $meta = stream_get_meta_data($this->socket);
                throw new \RuntimeException(!empty($meta['timed_out']) ? 'Server SMTP neodpověděl včas.' : 'Server SMTP ukončil spojení.');
            }
            $line = rtrim($line, "\r\n");
            $lines[] = $line;
            if (preg_match('/^\d{3}(?: |$)/', $line)) break;
        }
        $last = end($lines);
        return ['code' => (int) substr($last, 0, 3), 'lines' => array_map(fn($l) => substr($l, 4), $lines), 'text' => implode(' | ', $lines)];
    }

    private function write(string $data): void
    {
        $length = strlen($data);
        for ($written = 0; $written < $length; $written += $n) {
            $n = fwrite($this->socket, substr($data, $written));
            if ($n === false || $n === 0) throw new \RuntimeException('Zápis na server SMTP selhal.');
        }
    }

    private function expect(array $codes, string $step): array
    {
        $reply = $this->read();
        if (!in_array($reply['code'], $codes, true)) throw new \RuntimeException("{$step}: {$reply['text']}");
        return $reply;
    }

    private function command(string $line, array $codes, ?string $step = null): array
    {
        $this->write($line . "\r\n");
        return $this->expect($codes, $step ?? explode(' ', $line)[0]);
    }

    private function deliver(array $account, array $from, string $to, string $subject, string $text, string $html): void
    {
        $helo = self::domainOf($from['email']);
        $this->expect([220], 'Pozdrav serveru');
        $ehlo = $this->command("EHLO {$helo}", [250], 'EHLO');
        if ($account['encryption'] === 'tls') {
            if (!preg_grep('/^STARTTLS\b/i', $ehlo['lines'])) throw new \RuntimeException('Server nenabízí STARTTLS – zvolte šifrování SSL nebo žádné.');
            $this->command('STARTTLS', [220]);
            $method = STREAM_CRYPTO_METHOD_TLS_CLIENT;
            if (defined('STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT')) $method |= STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
            if (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT')) $method |= STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
            if (!@stream_socket_enable_crypto($this->socket, true, $method)) {
                $last = error_get_last();
                throw new \RuntimeException('STARTTLS: ' . ($last['message'] ?? 'šifrované spojení se nepodařilo navázat'));
            }
            $ehlo = $this->command("EHLO {$helo}", [250], 'EHLO');
        }
        $username = (string) ($account['username'] ?? '');
        if ($username !== '') {
            $password = (string) ($account['password'] ?? '');
            $auth = implode(' ', preg_grep('/^AUTH\b/i', $ehlo['lines']) ?: []);
            if (preg_match('/\bPLAIN\b/i', $auth) || !preg_match('/\bLOGIN\b/i', $auth)) {
                $this->command('AUTH PLAIN ' . base64_encode("\0{$username}\0{$password}"), [235], 'Přihlášení (AUTH PLAIN)');
            } else {
                $this->command('AUTH LOGIN', [334], 'Přihlášení (AUTH LOGIN)');
                $this->command(base64_encode($username), [334], 'Přihlášení – jméno');
                $this->command(base64_encode($password), [235], 'Přihlášení – heslo');
            }
        }
        $this->command("MAIL FROM:<{$from['email']}>", [250], 'MAIL FROM');
        $this->command("RCPT TO:<{$to}>", [250, 251], 'RCPT TO');
        $this->command('DATA', [354]);
        // Tečka na začátku řádku se zdvojí (jinak by ukončila zprávu).
        $body = preg_replace('/^\./m', '..', self::buildMessage($from, $to, $subject, $text, $html));
        $this->write($body . ".\r\n");
        $this->expect([250], 'Odeslání zprávy');
        try { $this->write("QUIT\r\n"); } catch (\Throwable $e) { /* zpráva už je přijatá */ }
    }
}
