<?php
// Hlášení chyb (tlačítko s broukem → portál, Admin → Hlášení chyb). Smlouva: docs/API.md; referenční
// chování src/node/lib/bugs.js. GitHub issue jen s konstantami MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO.
// Snímek obrazovky se po 90 dnech maže a vyřízené hlášení rok po vyřízení (Retention).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Bugs
{
    private const STATUSES = ['new', 'in_progress', 'resolved', 'wontfix'];
    private const PRIORITIES = ['low', 'normal', 'high', 'critical'];
    private const MAX_LOG = 100;
    private const MAX_SCREENSHOT = 2000000; // znaků data URL (~1,5 MB obrázku)
    private const SCREENSHOT_RE = '#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$#';
    private const GITHUB_URL_RE = '#^https://github\.com/[\w.-]+/[\w.-]+/issues/\d+$#';

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    private static function text($value, int $max): string
    {
        return Js::slice(trim(str_replace(["\r\n", "\r"], "\n", Js::s($value))), 0, $max);
    }

    // Jen stránka bez parametrů a kotvy (kód místenky, tokeny z odkazů v e-mailu se neukládají).
    private static function pageOf($value): string
    {
        return preg_split('/[?#]/', self::text($value, 500))[0];
    }

    private static function githubRepo(): string
    {
        return defined('MISTENKA_GITHUB_REPO') ? (string) MISTENKA_GITHUB_REPO : '';
    }

    private static function githubToken(): string
    {
        return defined('MISTENKA_GITHUB_TOKEN') ? (string) MISTENKA_GITHUB_TOKEN : '';
    }

    private static function githubConfigured(): bool
    {
        return self::githubRepo() !== '' && self::githubToken() !== '';
    }

    private function audit(?array $actor, string $action, $id, $detail = null): void
    {
        Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'bug_report', ?, ?)",
            Time::nowIso(), $actor['id'] ?? null, $action, Js::str($id), $detail === null ? null : wp_json_encode($detail));
    }

    private function shape(array $r, bool $full = false): array
    {
        $u = $r['user_id'] ? Db::row('SELECT first_name, last_name, email, roles FROM {p}users WHERE id = ?', $r['user_id']) : null;
        $out = [
            'id' => (int) $r['id'], 'createdAt' => $r['created_at'], 'status' => $r['status'], 'priority' => $r['priority'], 'description' => $r['description'], 'url' => $r['url'],
            'user' => $u ? ['name' => trim(($u['first_name'] ?? '') . ' ' . ($u['last_name'] ?? '')), 'email' => $u['email'], 'roles' => array_values(array_filter(explode(',', (string) $u['roles'])))] : null,
            'contactEmail' => $r['contact_email'] ?: null, 'hasScreenshot' => (bool) $r['screenshot'], 'githubUrl' => $r['github_url'] ?: null, 'note' => $r['note'] ?? '',
            'updatedAt' => $r['updated_at'], 'resolvedAt' => $r['resolved_at'],
        ];
        if ($full) {
            $out += ['userAgent' => $r['user_agent'] ?? '', 'viewport' => $r['viewport'] ?? '', 'clientTime' => $r['client_time'] ?: null, 'log' => json_decode($r['log'] ?: '[]', true) ?: [], 'screenshot' => $r['screenshot'] ?: null];
        }
        return $out;
    }

    private function find($id): array
    {
        $row = Db::row('SELECT * FROM {p}bug_reports WHERE id = ?', (int) $id);
        if (!$row) throw new ApiError(404, 'not_found', 'Hlášení neexistuje.');
        return $row;
    }

    // ---------- nahlášení (veřejné) ----------
    public function create(array $input, ?array $user): array
    {
        $description = self::text($input['description'] ?? null, 4000);
        if (Js::len($description) < 10) throw new ApiError(400, 'invalid_description', 'Popište prosím, co se stalo (aspoň 10 znaků).');
        $contactEmail = Js::lower(self::text($input['contactEmail'] ?? null, 200));
        if ($contactEmail !== '' && !preg_match(Validate::EMAIL_RE, $contactEmail)) throw new ApiError(400, 'invalid_email', 'Zadejte platný e-mail pro odpověď, nebo pole nechte prázdné.');
        $screenshot = Js::truthy($input['screenshot'] ?? null) ? Js::s($input['screenshot']) : null;
        if ($screenshot !== null && (strlen($screenshot) > self::MAX_SCREENSHOT || !preg_match(self::SCREENSHOT_RE, $screenshot))) throw new ApiError(400, 'invalid_screenshot', 'Snímek obrazovky musí být obrázek PNG, JPEG nebo WebP do 1,5 MB.');
        $log = [];
        foreach (array_slice(is_array($input['log'] ?? null) ? $input['log'] : [], -self::MAX_LOG) as $e) {
            $e = is_array($e) ? $e : [];
            $log[] = ['at' => self::text($e['at'] ?? null, 40), 'type' => self::text($e['type'] ?? null, 20), 'message' => self::text($e['message'] ?? null, 500), 'page' => self::text($e['page'] ?? null, 200)];
        }
        $now = Time::nowIso();
        $clientTime = self::text($input['clientTime'] ?? null, 40);
        $id = Db::insert("INSERT INTO {p}bug_reports (created_at, user_id, contact_email, description, url, user_agent, viewport, client_time, log, screenshot, status, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'normal', ?)",
            $now, $user['id'] ?? null, $contactEmail !== '' ? $contactEmail : null, $description, self::pageOf($input['url'] ?? null), self::text($input['userAgent'] ?? null, 400),
            self::text($input['viewport'] ?? null, 40), $clientTime !== '' ? $clientTime : null, wp_json_encode($log), $screenshot, $now);
        // E-mail všem adminům (skupina „Hlášení chyb“ v Emailoví klienti).
        $mail = Emails::bugReport($this->app->config, ['report' => $this->shape($this->find($id)), 'link' => $this->app->appUrl . '/manage.html#bugs/' . $id]);
        foreach (Db::all("SELECT email FROM {p}users WHERE CONCAT(',', roles, ',') LIKE '%,admin,%'") as $admin) $this->app->queueEmail(null, 'bug_report', $admin['email'], $mail);
        return ['id' => (int) $id];
    }

    // ---------- správa (admin) ----------
    public function list(string $status): array
    {
        if ($status !== '' && !in_array($status, self::STATUSES, true)) throw new ApiError(400, 'invalid_status', 'Neznámý stav.');
        $rows = $status !== '' ? Db::all('SELECT * FROM {p}bug_reports WHERE status = ? ORDER BY id DESC LIMIT 500', $status) : Db::all('SELECT * FROM {p}bug_reports ORDER BY id DESC LIMIT 500');
        $counts = [];
        foreach (self::STATUSES as $s) $counts[$s] = (int) Db::val('SELECT COUNT(*) FROM {p}bug_reports WHERE status = ?', $s);
        return ['reports' => array_map(fn($r) => $this->shape($r), $rows), 'counts' => $counts, 'github' => ['configured' => self::githubConfigured(), 'repo' => self::githubRepo() ?: null]];
    }

    public function get($id): array
    {
        return ['report' => $this->shape($this->find($id), true)];
    }

    public function update(array $actor, $id, array $body): array
    {
        $row = $this->find($id);
        $status = array_key_exists('status', $body) ? Js::s($body['status']) : $row['status'];
        if (!in_array($status, self::STATUSES, true)) throw new ApiError(400, 'invalid_status', 'Neznámý stav.');
        $priority = array_key_exists('priority', $body) ? Js::s($body['priority']) : $row['priority'];
        if (!in_array($priority, self::PRIORITIES, true)) throw new ApiError(400, 'invalid_priority', 'Neznámá priorita.');
        $note = array_key_exists('note', $body) ? self::text($body['note'], 2000) : ($row['note'] ?? '');
        $githubUrl = array_key_exists('githubUrl', $body) ? self::text($body['githubUrl'], 300) : ($row['github_url'] ?? '');
        if ($githubUrl !== '' && !preg_match(self::GITHUB_URL_RE, $githubUrl)) throw new ApiError(400, 'invalid_github_url', 'Odkaz musí vést na GitHub issue (https://github.com/…/issues/123).');
        $now = Time::nowIso();
        $resolvedAt = in_array($status, ['resolved', 'wontfix'], true) ? ($row['resolved_at'] ?: $now) : null;
        Db::exec('UPDATE {p}bug_reports SET status = ?, priority = ?, note = ?, github_url = ?, resolved_at = ?, updated_at = ?, updated_by = ? WHERE id = ?',
            $status, $priority, $note !== '' ? $note : null, $githubUrl !== '' ? $githubUrl : null, $resolvedAt, $now, $actor['id'], $row['id']);
        $this->audit($actor, 'bug_report_updated', $row['id'], ['status' => $status, 'priority' => $priority]);
        return $this->get($row['id']);
    }

    // Tělo GitHub issue (bez osobních údajů a snímku – ten zůstává v portálu).
    private function issueBody(array $r): string
    {
        $lines = [$r['description'], '', "- Hlášení: #{$r['id']} ({$this->app->appUrl}/manage.html#bugs/{$r['id']})", "- Čas: {$r['created_at']}", '- Stránka: ' . ($r['url'] ?: '—'),
            '- Prohlížeč: ' . ($r['user_agent'] ?: '—'), '- Okno: ' . ($r['viewport'] ?: '—'), "- Priorita: {$r['priority']}", '- Snímek obrazovky: ' . ($r['screenshot'] ? 'ano (v portálu)' : 'ne')];
        $log = json_decode($r['log'] ?: '[]', true) ?: [];
        if ($log) {
            $lines = array_merge($lines, ['', '<details><summary>Poslední události</summary>', '', '```'], array_map(fn($e) => trim("{$e['at']} {$e['type']} " . ($e['page'] ?? '') . " {$e['message']}"), $log), ['```', '</details>']);
        }
        return implode("\n", $lines);
    }

    public function toGithub(array $actor, $id): array
    {
        $row = $this->find($id);
        if (!self::githubConfigured()) throw new ApiError(409, 'github_not_configured', 'GitHub není nastaven (MISTENKA_GITHUB_TOKEN a MISTENKA_GITHUB_REPO ve wp-config.php).');
        if ($row['github_url']) throw new ApiError(409, 'already_on_github', 'Hlášení už má GitHub issue.');
        $title = '[Místenka #' . $row['id'] . '] ' . Js::slice(explode("\n", $row['description'])[0], 0, 100);
        $response = wp_remote_post('https://api.github.com/repos/' . self::githubRepo() . '/issues', [
            'timeout' => 20,
            'headers' => ['Authorization' => 'Bearer ' . self::githubToken(), 'Accept' => 'application/vnd.github+json', 'Content-Type' => 'application/json', 'User-Agent' => 'mistenka'],
            'body' => wp_json_encode(['title' => $title, 'body' => $this->issueBody($row), 'labels' => ['bug']]),
        ]);
        if (is_wp_error($response)) throw new ApiError(502, 'github_failed', 'GitHub je nedostupný: ' . $response->get_error_message());
        $code = (int) wp_remote_retrieve_response_code($response);
        $data = json_decode((string) wp_remote_retrieve_body($response), true) ?: [];
        if ($code < 200 || $code >= 300 || empty($data['html_url'])) throw new ApiError(502, 'github_failed', "GitHub issue se nepodařilo založit ({$code}" . (!empty($data['message']) ? ': ' . $data['message'] : '') . ').');
        Db::exec("UPDATE {p}bug_reports SET github_url = ?, status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, updated_at = ?, updated_by = ? WHERE id = ?", $data['html_url'], Time::nowIso(), $actor['id'], $row['id']);
        $this->audit($actor, 'bug_report_github', $row['id'], ['url' => $data['html_url']]);
        return $this->get($row['id']);
    }
}
