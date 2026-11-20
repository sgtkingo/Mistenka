<?php
// Zálohy (src/node/lib/backups.js). WordPress: export všech tabulek pluginu do JSON komprimovaného gzipem
// v datové složce (mimo veřejný přístup). Pravidla: denní záloha během sezony (drží se 2), trvalá po uzávěrce
// sezony, ruční záloha admina; obnova z portálu v jedné transakci.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Backups
{
    private const DAILY_KEEP = 2;
    private const FORMAT = 'mistenka-backup';
    // Při obnově se nepřepisují: přihlášení, seznam záloh, technická metadata, limity požadavků.
    private const RESTORE_SKIP = ['sessions', 'backups', 'meta', 'rate_limits'];

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    private function dir(): string
    {
        $dir = Env::dataDir() . '/backups';
        if (!is_dir($dir)) wp_mkdir_p($dir);
        return $dir;
    }

    private function audit(?array $actor, string $action, $targetId, $detail = null): void
    {
        Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, 'backup', ?, ?)",
            Time::nowIso(), $actor['id'] ?? null, $action, Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    private function shape(array $b): array
    {
        return ['id' => $b['id'], 'kind' => $b['kind'], 'file' => $b['file'], 'sizeBytes' => $b['size_bytes'], 'note' => $b['note'] ?? '', 'reportId' => $b['report_id'], 'createdAt' => $b['created_at'], 'exists' => file_exists($this->dir() . '/' . $b['file'])];
    }

    // Konzistentní snímek: čtení v transakci REPEATABLE READ.
    private function export(): string
    {
        global $wpdb;
        $tables = [];
        $wpdb->query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        try {
            foreach (Db::tables() as $name) {
                if ($name === 'backups' || $name === 'rate_limits') continue;
                $rows = $wpdb->get_results('SELECT * FROM `' . Db::table($name) . '`', ARRAY_A) ?: [];
                $tables[$name] = $rows;
            }
        } finally {
            $wpdb->query('COMMIT');
        }
        $json = wp_json_encode(['format' => self::FORMAT, 'schema' => Db::SCHEMA_VERSION, 'createdAt' => Time::nowIso(), 'site' => home_url(), 'tables' => $tables], JSON_UNESCAPED_UNICODE);
        return gzencode($json, 6);
    }

    private function create(string $kind, string $note = '', ?int $reportId = null, ?array $actor = null): array
    {
        $now = Time::now();
        $stamp = substr(str_replace(['-', ':', 'T'], ['', '', '-'], Time::iso($now)), 0, 15);
        $dir = $this->dir();
        $file = "mistenka-{$stamp}-{$kind}.json.gz";
        for ($i = 2; file_exists("{$dir}/{$file}"); $i++) $file = "mistenka-{$stamp}-{$kind}-{$i}.json.gz";
        $data = $this->export();
        if (@file_put_contents("{$dir}/{$file}", $data) === false) throw new ApiError(500, 'backup_failed', 'Zálohu se nepodařilo zapsat do datové složky.');
        $id = Db::insert('INSERT INTO {p}backups (kind, file, size_bytes, note, report_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', $kind, $file, strlen($data), $note !== '' ? $note : null, $reportId, $actor['id'] ?? null, Time::iso($now));
        $this->audit($actor, 'backup_created', $id, ['kind' => $kind, 'file' => $file]);
        return $this->shape(Db::row('SELECT * FROM {p}backups WHERE id = ?', $id));
    }

    private function removeRow(array $row): void
    {
        @unlink($this->dir() . '/' . $row['file']);
        Db::exec('DELETE FROM {p}backups WHERE id = ?', $row['id']);
    }

    // Je dnes sezona? Ano, když je otevřená některá sezona, nebo když žádná sezona není nastavená.
    private function inSeason(string $today): bool
    {
        $seasons = Db::all('SELECT opens_on, closes_on FROM {p}seasons WHERE deleted_at IS NULL');
        if (!$seasons) return true;
        foreach ($seasons as $s) if ($s['opens_on'] <= $today && (!$s['closes_on'] || $today <= $s['closes_on'])) return true;
        return false;
    }

    public function daily(): array
    {
        $today = Time::pragueToday();
        if (Db::metaGet('last_daily_backup') === $today || !$this->inSeason($today)) return ['created' => false];
        $backup = $this->create('daily');
        Db::metaSet('last_daily_backup', $today);
        $old = array_slice(Db::all("SELECT * FROM {p}backups WHERE kind = 'daily' ORDER BY id DESC"), self::DAILY_KEEP);
        foreach ($old as $row) $this->removeRow($row);
        return ['created' => true, 'file' => $backup['file'], 'removed' => count($old)];
    }

    public function afterSeasonReport(array $report): array
    {
        return $this->create('season', $report['name'], $report['id']);
    }

    public function list(): array
    {
        $rows = Db::all('SELECT * FROM {p}backups ORDER BY id DESC');
        return ['backups' => array_map([$this, 'shape'], $rows), 'dailyKeep' => self::DAILY_KEEP, 'totalBytes' => array_sum(array_column($rows, 'size_bytes'))];
    }

    public function manual(array $actor, array $body): array
    {
        return ['backup' => $this->create('manual', Js::slice(trim(Js::s($body['note'] ?? null)), 0, 200), null, $actor)];
    }

    private function find($id): array
    {
        $row = Db::row('SELECT * FROM {p}backups WHERE id = ?', (int) $id);
        if (!$row) throw new ApiError(404, 'not_found', 'Záloha neexistuje.');
        return $row;
    }

    public function filePath($id): array
    {
        $row = $this->find($id);
        $full = $this->dir() . '/' . $row['file'];
        if (!file_exists($full)) throw new ApiError(404, 'not_found', 'Soubor zálohy chybí.');
        return ['file' => $row['file'], 'full' => $full, 'size' => filesize($full)];
    }

    public function remove(array $actor, $id): array
    {
        $row = $this->find($id);
        $this->removeRow($row);
        $this->audit($actor, 'backup_deleted', $row['id'], ['file' => $row['file'], 'kind' => $row['kind']]);
        return ['deleted' => true];
    }

    // Načte zálohu; vrátí [data, null] nebo [null, popis problému].
    private function read(string $full): array
    {
        $raw = @file_get_contents($full);
        if ($raw === false) return [null, 'soubor nelze přečíst'];
        $json = @gzdecode($raw);
        if ($json === false) return [null, 'poškozený archiv'];
        $data = json_decode($json, true);
        if (!is_array($data) || ($data['format'] ?? '') !== self::FORMAT || !isset($data['tables']) || !is_array($data['tables'])) return [null, 'neplatný formát zálohy'];
        return [$data, null];
    }

    // Obnova ze zálohy (admin): pojistná záloha → přepis tabulek v jedné transakci (jen společné sloupce).
    public function restore(array $actor, $id, array $body): array
    {
        if (($body['confirm'] ?? null) !== 'OBNOVIT') throw new ApiError(400, 'confirm_required', 'Pro obnovu napište OBNOVIT.');
        $path = $this->filePath($id);
        [$data, $problem] = $this->read($path['full']);
        if ($problem) throw new ApiError(409, 'backup_corrupt', 'Záloha je poškozená: ' . $problem);
        $safety = $this->create('pre-restore', 'Před obnovou ze zálohy ' . $path['file'], null, $actor);
        global $wpdb;
        $result = Db::transaction(function () use ($data, $wpdb) {
            $rows = 0;
            $tables = 0;
            foreach (Db::tables() as $name) {
                if (in_array($name, self::RESTORE_SKIP, true)) continue;
                $table = Db::table($name);
                $columns = array_flip($wpdb->get_col("SHOW COLUMNS FROM `{$table}`"));
                Db::exec("DELETE FROM `{$table}`");
                $tables++;
                foreach ($data['tables'][$name] ?? [] as $row) {
                    $row = array_intersect_key($row, $columns);
                    if (!$row) continue;
                    $names = implode(', ', array_map(fn($c) => "`{$c}`", array_keys($row)));
                    Db::exec("INSERT INTO `{$table}` ({$names}) VALUES (" . implode(', ', array_fill(0, count($row), '?')) . ')', ...array_values($row));
                    $rows++;
                }
            }
            return ['tables' => $tables, 'rows' => $rows];
        });
        $this->audit($actor, 'backup_restored', $id, ['file' => $path['file'], 'safety' => $safety['file'], 'tables' => $result['tables'], 'rows' => $result['rows']]);
        $this->app->settings->reload();
        return ['restored' => true, 'file' => $path['file'], 'safetyBackup' => $safety, 'rows' => $result['rows']];
    }

    // Uchovávání (GDPR): zálohy obsahují osobní údaje, po lhůtě se mažou všechny včetně trvalých.
    public function removeOlderThan(string $cutoffIso): int
    {
        $old = Db::all('SELECT * FROM {p}backups WHERE created_at <= ?', $cutoffIso);
        foreach ($old as $row) $this->removeRow($row);
        if ($old) $this->audit(null, 'backups_expired', count($old), ['files' => array_column($old, 'file')]);
        return count($old);
    }
}
