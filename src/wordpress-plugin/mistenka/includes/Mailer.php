<?php
// SMTP účty (portál → Admin → Emailoví klienti) a odesílání e-mailů. Smlouva: docs/API.md, „E-mailoví klienti“;
// referenční chování src/node/lib/mail-accounts.js.
//
// Admin účty zakládá, upravuje, ověřuje testovacím e-mailem a maže; správce vybere pro každou skupinu e-mailů
// ověřený účet. E-mail skupiny bez účtu jde přes wp_mail() (výchozí odesílání webu) s odesílatelem
// z nastavení organizace. Odesílá se nativně přes PHPMailer, který je součástí WordPressu – nezávisle na
// pluginech typu WP Mail SMTP (každý e-mail dostane vlastní instanci s údaji svého účtu).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Mailer
{
    private const ENCRYPTIONS = ['ssl', 'tls', 'none'];
    public const GROUPS = [
        ['id' => 'tickets', 'label' => 'Místenky', 'help' => 'pokyny k platbě, vystavená místenka, připomínka a uzavření, zadržení, zrušení, uzavření revíru, blokace nákupu',
            'kinds' => ['payment_instructions', 'ticket_issued', 'return_reminder', 'ticket_closed', 'ticket_seized', 'ticket_cancelled', 'closure_notice', 'member_blocked']],
        ['id' => 'accounts', 'label' => 'Účty', 'help' => 'registrace, přihlášení odkazem, obnova hesla, změna e-mailu, pozvánka do správy, vyřízení žádosti o porybného, smazání účtu',
            'kinds' => ['account_verify', 'account_exists', 'magic_link', 'password_reset', 'email_change', 'staff_invite', 'account_deleted', 'warden_request_approved', 'warden_request_rejected']],
        ['id' => 'notices', 'label' => 'Upozornění správcům', 'help' => 'žádosti „Jsem porybný“, zadržení, překročené limity, uzávěrka sezony, změna platebních údajů, obnova databáze',
            'kinds' => ['seizure_notice', 'limit_exceeded', 'season_report', 'payment_settings_changed', 'database_auto_restored', 'warden_request']],
    ];
    private const CONNECTION_FIELDS = ['from_email', 'host', 'port', 'encryption', 'username', 'password_enc'];

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    public static function groupOf(string $kind): string
    {
        foreach (self::GROUPS as $g) if (in_array($kind, $g['kinds'], true)) return $g['id'];
        return 'tickets';
    }

    private function audit(?array $actor, string $action, $targetId, $detail = null): void
    {
        Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'email_account', ?, ?)",
            Time::nowIso(), $actor['id'] ?? null, $action, Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    private static function isAdmin(?array $actor): bool
    {
        return in_array('admin', explode(',', (string) ($actor['roles'] ?? '')), true);
    }

    private function requireAdminRole(?array $actor): void
    {
        if (!self::isAdmin($actor)) throw new ApiError(403, 'forbidden_role', 'E-mailové účty spravuje jen admin.');
    }

    private function find($id): ?array
    {
        return Db::row('SELECT * FROM {p}email_accounts WHERE id = ? AND deleted_at IS NULL', (int) $id);
    }

    public function senders(): array
    {
        $stored = json_decode(Db::metaGet('email_senders') ?: '{}', true) ?: [];
        $out = [];
        foreach (self::GROUPS as $g) $out[$g['id']] = !empty($stored[$g['id']]) ? (int) $stored[$g['id']] : null;
        return $out;
    }

    private function shape(array $a): array
    {
        $assigned = [];
        foreach ($this->senders() as $group => $id) if ($id === $a['id']) $assigned[] = $group;
        return [
            'id' => $a['id'], 'label' => $a['label'], 'fromEmail' => $a['from_email'], 'fromName' => $a['from_name'] ?? '', 'host' => $a['host'], 'port' => $a['port'], 'encryption' => $a['encryption'],
            'username' => $a['username'] ?? '', 'hasPassword' => (bool) $a['password_enc'], 'verified' => (bool) $a['verified_at'], 'verifiedAt' => $a['verified_at'], 'verifiedTo' => $a['verified_to'],
            'lastError' => $a['last_error'], 'usedFor' => $assigned, 'createdAt' => $a['created_at'], 'updatedAt' => $a['updated_at'],
        ];
    }

    // ---------- čtení (správce i admin) ----------
    public function list(?array $actor): array
    {
        $config = $this->app->config;
        return [
            'accounts' => array_map([$this, 'shape'], Db::all('SELECT * FROM {p}email_accounts WHERE deleted_at IS NULL ORDER BY label, id')),
            'senders' => $this->senders(),
            'groups' => array_map(fn($g) => ['id' => $g['id'], 'label' => $g['label'], 'help' => $g['help']], self::GROUPS),
            'fallback' => ['fromEmail' => $config['email']['fromEmail'] ?? '', 'fromName' => $config['email']['fromName'] ?? ''],
            'delivery' => Env::mailTransport() === 'file' ? 'file' : 'smtp',
            'canEdit' => self::isAdmin($actor),
        ];
    }

    // ---------- správa účtů (jen admin) ----------
    private function input(array $body, ?array $existing): array
    {
        $text = function ($value, int $max, string $code, string $label, bool $required = false): string {
            $out = trim(Js::str($value));
            if (($required && $out === '') || Js::len($out) > $max) throw new ApiError(400, $code, $required ? "{$label}: povinné, nejvýše {$max} znaků." : "{$label}: nejvýše {$max} znaků.");
            return $out;
        };
        $fromEmail = Js::lower($text($body['fromEmail'] ?? null, 200, 'invalid_email', 'Adresa odesílatele', true));
        if (!preg_match(Validate::EMAIL_RE, $fromEmail)) throw new ApiError(400, 'invalid_email', 'Zadejte platnou adresu odesílatele.');
        $host = strtolower($text($body['host'] ?? null, 253, 'invalid_host', 'Server SMTP', true));
        if (!preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/', $host)) throw new ApiError(400, 'invalid_host', 'Server SMTP zadejte jako název (např. smtp.websupport.cz).');
        $port = $body['port'] ?? null;
        $portNumber = Js::number($port);
        if ($port === null || !Js::isIntegerish($port) || $portNumber < 1 || $portNumber > 65535) throw new ApiError(400, 'invalid_port', 'Port musí být celé číslo 1–65535 (obvykle 465 nebo 587).');
        $encryption = Js::str($body['encryption'] ?? '');
        if (!in_array($encryption, self::ENCRYPTIONS, true)) throw new ApiError(400, 'invalid_encryption', 'Šifrování musí být ssl, tls nebo none.');
        $password = Js::str($body['password'] ?? '');
        if (strlen($password) > 500) throw new ApiError(400, 'invalid_password', 'Heslo je příliš dlouhé.');
        $label = $text($body['label'] ?? null, 80, 'invalid_label', 'Název');
        return [
            'label' => $label !== '' ? $label : $fromEmail,
            'from_email' => $fromEmail,
            'from_name' => $text($body['fromName'] ?? null, 100, 'invalid_name', 'Jméno odesílatele'),
            'host' => $host, 'port' => (int) $portNumber, 'encryption' => $encryption,
            'username' => $text($body['username'] ?? null, 200, 'invalid_username', 'Přihlašovací jméno'),
            // Prázdné heslo při úpravě = beze změny.
            'password_enc' => $password !== '' ? Security::encrypt($password) : ($existing['password_enc'] ?? null),
        ];
    }

    public function create(?array $actor, array $body): array
    {
        $this->requireAdminRole($actor);
        $v = $this->input($body, null);
        $now = Time::nowIso();
        $id = Db::insert('INSERT INTO {p}email_accounts (label, from_email, from_name, host, port, encryption, username, password_enc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $v['label'], $v['from_email'], $v['from_name'], $v['host'], $v['port'], $v['encryption'], $v['username'], $v['password_enc'], $actor['id'], $now, $now);
        $this->audit($actor, 'email_account_created', $id, ['label' => $v['label'], 'fromEmail' => $v['from_email'], 'host' => $v['host']]);
        return ['account' => $this->shape($this->find($id))];
    }

    public function update(?array $actor, $id, array $body): array
    {
        $this->requireAdminRole($actor);
        return Db::transaction(function () use ($actor, $id, $body) {
            $existing = $this->find($id);
            if (!$existing) throw new ApiError(404, 'not_found', 'E-mailový účet neexistuje.');
            $v = $this->input($body, $existing);
            $reset = false;
            foreach (self::CONNECTION_FIELDS as $field) if (Js::str($v[$field]) !== Js::str($existing[$field])) $reset = true;
            Db::exec('UPDATE {p}email_accounts SET label = ?, from_email = ?, from_name = ?, host = ?, port = ?, encryption = ?, username = ?, password_enc = ?, updated_at = ?' . ($reset ? ', verified_at = NULL, verified_to = NULL' : '') . ' WHERE id = ?',
                $v['label'], $v['from_email'], $v['from_name'], $v['host'], $v['port'], $v['encryption'], $v['username'], $v['password_enc'], Time::nowIso(), $existing['id']);
            $this->audit($actor, 'email_account_updated', $existing['id'], ['label' => $v['label'], 'verificationReset' => $reset]);
            return ['account' => $this->shape($this->find($existing['id']))];
        });
    }

    public function remove(?array $actor, $id): array
    {
        $this->requireAdminRole($actor);
        return Db::transaction(function () use ($actor, $id) {
            $existing = $this->find($id);
            if (!$existing) throw new ApiError(404, 'not_found', 'E-mailový účet neexistuje.');
            Db::exec('UPDATE {p}email_accounts SET deleted_at = ?, password_enc = NULL WHERE id = ?', Time::nowIso(), $existing['id']);
            $current = $this->senders();
            foreach ($current as $group => $value) if ($value === $existing['id']) $current[$group] = null;
            Db::metaSet('email_senders', wp_json_encode($current));
            $this->audit($actor, 'email_account_deleted', $existing['id'], ['label' => $existing['label']]);
            return ['deleted' => true];
        });
    }

    // Ověření = odeslání testovacího e-mailu přes účet. Úspěch účet označí jako ověřený, chyba se uloží a vrátí.
    public function verify(?array $actor, $id, array $body): array
    {
        $this->requireAdminRole($actor);
        $existing = $this->find($id);
        if (!$existing) throw new ApiError(404, 'not_found', 'E-mailový účet neexistuje.');
        $to = Js::lower(trim(Js::s(($body['to'] ?? null) ?: ($actor['email'] ?? ''))));
        if (!preg_match(Validate::EMAIL_RE, $to)) throw new ApiError(400, 'invalid_email', 'Zadejte platnou adresu pro testovací e-mail.');
        $org = $this->app->config['organization'];
        $at = Time::nowIso();
        $e = fn($v) => Emails::esc($v);
        $server = "{$existing['host']}:{$existing['port']} ({$existing['encryption']})";
        $mail = [
            'subject' => "Místenka – test odesílání ({$existing['label']})",
            'text' => "Testovací e-mail Místenky ({$org['shortName']}).\nÚčet: {$existing['label']}\nOdesílatel: {$existing['from_email']}\nServer: {$server}\nOdesláno: {$at}",
            'html' => '<p>Testovací e-mail Místenky (<b>' . $e($org['shortName']) . '</b>).</p><p>Účet: ' . $e($existing['label']) . '<br>Odesílatel: ' . $e($existing['from_email']) . '<br>Server: ' . $e($server) . '<br>Odesláno: ' . $e($at) . '</p><p>Pokud tento e-mail čtete, odesílání funguje.</p>',
        ];
        try {
            $this->send('test-' . $existing['id'] . '-' . time(), $to, $mail, $this->fromOf($existing), $this->accountForSending($existing));
        } catch (\Throwable $error) {
            $message = Js::slice($error->getMessage(), 0, 500);
            Db::exec('UPDATE {p}email_accounts SET last_error = ?, verified_at = NULL, verified_to = NULL WHERE id = ?', $message, $existing['id']);
            $this->audit($actor, 'email_account_verify_failed', $existing['id'], ['to' => $to, 'error' => $message]);
            throw new ApiError(400, 'smtp_failed', 'Testovací e-mail se nepodařilo odeslat: ' . $message);
        }
        Db::exec('UPDATE {p}email_accounts SET verified_at = ?, verified_to = ?, last_error = NULL WHERE id = ?', $at, $to, $existing['id']);
        $this->audit($actor, 'email_account_verified', $existing['id'], ['to' => $to]);
        return ['account' => $this->shape($this->find($existing['id']))];
    }

    // ---------- odesílatelé skupin (správce i admin) ----------
    public function setSenders(?array $actor, array $body): array
    {
        return Db::transaction(function () use ($actor, $body) {
            $current = $this->senders();
            foreach (self::GROUPS as $g) {
                if (!array_key_exists($g['id'], $body)) continue;
                $value = $body[$g['id']];
                if ($value === null || $value === '') { $current[$g['id']] = null; continue; }
                $account = $this->find($value);
                if (!$account) throw new ApiError(404, 'not_found', 'E-mailový účet neexistuje.');
                if (!$account['verified_at']) throw new ApiError(409, 'account_not_verified', "Účet {$account['label']} ještě není ověřený testovacím e-mailem.");
                $current[$g['id']] = $account['id'];
            }
            Db::metaSet('email_senders', wp_json_encode($current));
            $this->audit($actor, 'email_senders_changed', 'senders', $current);
            return $this->list($actor);
        });
    }

    // ---------- odeslání ----------
    private function fromOf(array $a): array
    {
        return ['email' => $a['from_email'], 'name' => $a['from_name'] ?? ''];
    }

    private function accountForSending(array $a): array
    {
        return ['id' => $a['id'], 'label' => $a['label'], 'host' => $a['host'], 'port' => $a['port'], 'encryption' => $a['encryption'], 'username' => $a['username'] ?? '', 'password' => Security::decrypt($a['password_enc'])];
    }

    // Odesílatel pro druh e-mailu: přiřazený ověřený účet skupiny, jinak výchozí odesílatel organizace.
    public function senderFor(string $kind): array
    {
        $id = $this->senders()[self::groupOf($kind)] ?? null;
        $account = $id ? $this->find($id) : null;
        if ($account && $account['verified_at']) return ['from' => $this->fromOf($account), 'account' => $this->accountForSending($account), 'label' => $account['label']];
        $email = $this->app->config['email'] ?? [];
        return ['from' => ['email' => $email['fromEmail'] ?? '', 'name' => $email['fromName'] ?? ''], 'account' => null, 'label' => 'výchozí'];
    }

    // Odeslání jednoho e-mailu. Chyba = výjimka se zprávou pro správce.
    public function send(string $id, string $to, array $mail, array $from, ?array $account): void
    {
        if (Env::mailTransport() === 'file') {
            $this->sendToFile($id, $to, $mail, $from, $account);
            return;
        }
        if ($account) {
            $this->sendSmtp($to, $mail, $from, $account);
            return;
        }
        $this->sendWpMail($to, $mail, $from);
    }

    // Vývoj a testy (MISTENKA_MAIL_TRANSPORT = file): e-mail jen do datové složky, jako Node data/outbox.
    private function sendToFile(string $id, string $to, array $mail, array $from, ?array $account): void
    {
        $dir = Env::dataDir() . '/outbox';
        if (!is_dir($dir)) wp_mkdir_p($dir);
        $base = $dir . '/' . str_pad($id, 5, '0', STR_PAD_LEFT);
        $sender = !empty($from['email']) ? (($from['name'] ?? '') !== '' ? $from['name'] . ' ' : '') . '<' . $from['email'] . '>' : '(výchozí)';
        $via = $account ? " · přes {$account['label']} ({$account['host']}:{$account['port']})" : '';
        if (@file_put_contents($base . '.html', $mail['html']) === false) throw new \RuntimeException('Nelze zapsat e-mail do ' . $dir);
        file_put_contents($base . '.txt', "From: {$sender}{$via}\nTo: {$to}\nSubject: {$mail['subject']}\n\n{$mail['text']}\n");
    }

    private static function loadPhpMailer(): void
    {
        if (!class_exists(\PHPMailer\PHPMailer\PHPMailer::class)) {
            require_once ABSPATH . WPINC . '/PHPMailer/PHPMailer.php';
            require_once ABSPATH . WPINC . '/PHPMailer/SMTP.php';
            require_once ABSPATH . WPINC . '/PHPMailer/Exception.php';
        }
    }

    private function sendSmtp(string $to, array $mail, array $from, array $account): void
    {
        self::loadPhpMailer();
        $m = new \PHPMailer\PHPMailer\PHPMailer(true);
        try {
            $m->isSMTP();
            $m->Host = $account['host'];
            $m->Port = (int) $account['port'];
            $m->Timeout = 20;
            $m->CharSet = 'UTF-8';
            $m->Encoding = 'base64';
            if ($account['encryption'] === 'ssl') {
                $m->SMTPSecure = \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
            } elseif ($account['encryption'] === 'tls') {
                $m->SMTPSecure = \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
            } else {
                $m->SMTPSecure = '';
                $m->SMTPAutoTLS = false;
            }
            if ($account['username'] !== '') {
                $m->SMTPAuth = true;
                $m->Username = $account['username'];
                $m->Password = $account['password'];
            }
            $m->setFrom($from['email'], $from['name'] ?? '', false);
            $m->Sender = $from['email']; // envelope sender = odesílatel (SPF)
            $m->addAddress($to);
            $m->Subject = $mail['subject'];
            $m->isHTML(true);
            $m->Body = $mail['html'];
            $m->AltBody = $mail['text'];
            $m->XMailer = ' ';
            $m->send();
        } catch (\PHPMailer\PHPMailer\Exception $e) {
            throw new \RuntimeException($m->ErrorInfo ?: $e->getMessage());
        }
    }

    // Výchozí odesílání webu (wp_mail – PHP mail() nebo SMTP plugin, pokud je na webu nainstalovaný).
    private function sendWpMail(string $to, array $mail, array $from): void
    {
        $headers = ['Content-Type: text/html; charset=UTF-8'];
        if (!empty($from['email'])) $headers[] = 'From: ' . (($from['name'] ?? '') !== '' ? '"' . str_replace('"', '', $from['name']) . '" ' : '') . '<' . $from['email'] . '>';
        $error = null;
        $alt = function ($phpmailer) use ($mail) { $phpmailer->AltBody = $mail['text']; };
        $fail = function ($wpError) use (&$error) { $error = $wpError->get_error_message(); };
        add_action('phpmailer_init', $alt);
        add_action('wp_mail_failed', $fail);
        try {
            $sent = wp_mail($to, $mail['subject'], $mail['html'], $headers);
        } finally {
            remove_action('phpmailer_init', $alt);
            remove_action('wp_mail_failed', $fail);
        }
        if (!$sent) throw new \RuntimeException($error ?: 'wp_mail() e-mail neodeslal.');
    }

    // Fronta e-mailů: odešle nejvýš 20 čekajících (plánovaná úloha nebo hned po požadavku).
    public function deliverOutbox(): int
    {
        if (!Db::tryLock('outbox')) return 0; // jiný proces právě odesílá
        try {
            $pending = Db::all('SELECT * FROM {p}email_outbox WHERE sent_at IS NULL AND error IS NULL ORDER BY id LIMIT 20');
            if (count($pending) < 20) {
                // Neúspěšné zkusit znovu, nejvýš jednou za hodinu (chyba se přepíše novou nebo smaže při úspěchu).
                $retry = Db::all('SELECT * FROM {p}email_outbox WHERE sent_at IS NULL AND error IS NOT NULL AND created_at > ? ORDER BY id LIMIT ?', Time::iso(Time::now()->modify('-2 days')), 20 - count($pending));
                foreach ($retry as $row) {
                    $last = get_transient('mistenka_retry_' . $row['id']);
                    if (!$last) $pending[] = $row;
                }
            }
            foreach ($pending as $mail) {
                $sender = $this->senderFor($mail['kind']);
                try {
                    $this->send((string) $mail['id'], $mail['to_email'], ['subject' => $mail['subject'], 'html' => $mail['body_html'], 'text' => $mail['body_text']], $sender['from'], $sender['account']);
                    Db::exec('UPDATE {p}email_outbox SET sent_at = ?, error = NULL, sender = ? WHERE id = ?', Time::nowIso(), $sender['label'], $mail['id']);
                } catch (\Throwable $error) {
                    Db::exec('UPDATE {p}email_outbox SET error = ?, sender = ? WHERE id = ?', Js::slice($error->getMessage(), 0, 500), $sender['label'], $mail['id']);
                    set_transient('mistenka_retry_' . $mail['id'], 1, HOUR_IN_SECONDS);
                }
            }
            return count($pending);
        } finally {
            Db::unlock('outbox');
        }
    }
}
