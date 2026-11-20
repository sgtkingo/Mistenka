<?php
// Provoz revírů (src/node/lib/operations.js): důležité zprávy, sezony, mimořádná uzavření.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Operations
{
    private const MAX_PUBLIC_ANNOUNCEMENTS = 3;
    private const SCOPE_SQL = '(revir_id IS NULL OR revir_id = ?)';

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    // Jednorázový převod oznámení z konfigurace (revir.notice) do databáze.
    public function importNotices(): void
    {
        if (Db::metaGet('notices_imported') !== null) return;
        $now = Time::nowIso();
        foreach ($this->app->config['reviry'] as $revir) {
            if (!empty($revir['notice']['title'])) Db::exec('INSERT INTO {p}announcements (revir_id, title, text, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', $revir['id'], $revir['notice']['title'], $revir['notice']['text'] ?? '', $now, $now);
        }
        Db::metaSet('notices_imported', $now);
    }

    private function audit(?array $actor, string $action, string $targetType, $targetId, $detail = null): void
    {
        Db::exec('INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
            Time::nowIso(), $actor['id'] ?? null, $action, $targetType, Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    private function validRevir($value): ?string
    {
        if ($value === null || $value === '') return null; // null = všechny revíry organizace
        if (!Config::getRevir($this->app->config, Js::str($value))) throw new ApiError(400, 'unknown_revir', 'Revír neexistuje.');
        return Js::str($value);
    }

    private function validDate($value, bool $required = false, string $label = 'Datum'): ?string
    {
        if ($value === null || $value === '') {
            if ($required) throw new ApiError(400, 'invalid_date', "{$label} je povinné.");
            return null;
        }
        if (!Time::isIsoDate(Js::str($value))) throw new ApiError(400, 'invalid_date', "{$label} musí být platné datum.");
        return Js::str($value);
    }

    private function validText($value, int $min, int $max, string $code, string $label): string
    {
        $text = trim(Js::str($value));
        $len = Js::len($text);
        if ($len < $min || $len > $max) throw new ApiError(400, $code, $min ? "{$label}: {$min}–{$max} znaků." : "{$label}: nejvýše {$max} znaků.");
        return $text;
    }

    public function revirName(?string $id): string
    {
        if (!$id) return 'Všechny revíry';
        return Config::getRevir($this->app->config, $id)['name'] ?? $id;
    }

    // ---------- důležité zprávy ----------
    private function announcementShape(array $a, ?string $today = null): array
    {
        $today ??= Time::pragueToday();
        return [
            'id' => $a['id'], 'revirId' => $a['revir_id'], 'revirName' => $this->revirName($a['revir_id']), 'title' => $a['title'], 'text' => $a['text'],
            'validFrom' => $a['valid_from'], 'validTo' => $a['valid_to'], 'pinned' => (bool) $a['pinned'],
            'active' => (!$a['valid_from'] || $a['valid_from'] <= $today) && (!$a['valid_to'] || $a['valid_to'] >= $today), 'createdAt' => $a['created_at'], 'updatedAt' => $a['updated_at'],
        ];
    }

    // Veřejně: nejvýš 3 aktivní zprávy pro revír (připnuté první, pak nejnovější).
    public function activeAnnouncements(string $revirId): array
    {
        $today = Time::pragueToday();
        $rows = Db::all('SELECT * FROM {p}announcements WHERE deleted_at IS NULL AND ' . self::SCOPE_SQL . ' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)
            ORDER BY pinned DESC, COALESCE(valid_from, SUBSTRING(created_at, 1, 10)) DESC, id DESC LIMIT ?', $revirId, $today, $today, self::MAX_PUBLIC_ANNOUNCEMENTS);
        return ['announcements' => array_map(function ($a) use ($today) {
            $s = $this->announcementShape($a, $today);
            return ['id' => $s['id'], 'revirId' => $s['revirId'], 'title' => $s['title'], 'text' => $s['text'], 'validFrom' => $s['validFrom'], 'validTo' => $s['validTo'], 'pinned' => $s['pinned']];
        }, $rows)];
    }

    public function listAnnouncements(): array
    {
        $today = Time::pragueToday();
        return ['announcements' => array_map(fn($a) => $this->announcementShape($a, $today), Db::all('SELECT * FROM {p}announcements WHERE deleted_at IS NULL ORDER BY pinned DESC, id DESC')), 'maxPublic' => self::MAX_PUBLIC_ANNOUNCEMENTS];
    }

    public function saveAnnouncement(array $actor, ?string $id, array $body): array
    {
        $title = $this->validText($body['title'] ?? null, 1, 120, 'invalid_title', 'Nadpis');
        $text = $this->validText($body['text'] ?? null, 0, 1000, 'invalid_text', 'Text');
        $revirId = $this->validRevir($body['revirId'] ?? null);
        $validFrom = $this->validDate($body['validFrom'] ?? null, false, 'Začátek platnosti');
        $validTo = $this->validDate($body['validTo'] ?? null, false, 'Konec platnosti');
        if ($validFrom && $validTo && $validTo < $validFrom) throw new ApiError(400, 'invalid_date', 'Konec platnosti musí být po začátku.');
        $pinned = ($body['pinned'] ?? null) === true ? 1 : 0;
        return Db::transaction(function () use ($actor, $id, $title, $text, $revirId, $validFrom, $validTo, $pinned) {
            $now = Time::nowIso();
            if ($id) {
                $existing = Db::row('SELECT * FROM {p}announcements WHERE id = ? AND deleted_at IS NULL', (int) $id);
                if (!$existing) throw new ApiError(404, 'not_found', 'Zpráva neexistuje.');
                Db::exec('UPDATE {p}announcements SET revir_id = ?, title = ?, text = ?, valid_from = ?, valid_to = ?, pinned = ?, updated_at = ? WHERE id = ?', $revirId, $title, $text, $validFrom, $validTo, $pinned, $now, $existing['id']);
                $rowId = $existing['id'];
            } else {
                $rowId = Db::insert('INSERT INTO {p}announcements (revir_id, title, text, valid_from, valid_to, pinned, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', $revirId, $title, $text, $validFrom, $validTo, $pinned, $actor['id'], $now, $now);
            }
            $this->audit($actor, $id ? 'announcement_updated' : 'announcement_created', 'announcement', $rowId, ['title' => $title]);
            return ['announcement' => $this->announcementShape(Db::row('SELECT * FROM {p}announcements WHERE id = ?', $rowId))];
        });
    }

    public function deleteAnnouncement(array $actor, string $id): array
    {
        if (!Db::exec('UPDATE {p}announcements SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Time::nowIso(), (int) $id)) throw new ApiError(404, 'not_found', 'Zpráva neexistuje.');
        $this->audit($actor, 'announcement_deleted', 'announcement', $id);
        return ['deleted' => true];
    }

    // ---------- sezony ----------
    private function seasonShape(array $s, ?string $today = null): array
    {
        $today ??= Time::pragueToday();
        if ($s['closes_on'] && $s['closes_on'] < $s['opens_on']) $state = 'closed';
        elseif ($s['opens_on'] > $today) $state = 'upcoming';
        elseif (!$s['closes_on'] || $s['closes_on'] >= $today) $state = 'open';
        else $state = 'closed';
        return ['id' => $s['id'], 'revirId' => $s['revir_id'], 'revirName' => $this->revirName($s['revir_id']), 'name' => $s['name'], 'opensOn' => $s['opens_on'], 'closesOn' => $s['closes_on'], 'state' => $state];
    }

    private function seasonsFor(string $revirId): array
    {
        return Db::all('SELECT * FROM {p}seasons WHERE deleted_at IS NULL AND ' . self::SCOPE_SQL . ' ORDER BY opens_on', $revirId);
    }

    public function listSeasons(): array
    {
        $today = Time::pragueToday();
        return ['seasons' => array_map(fn($s) => $this->seasonShape($s, $today), Db::all('SELECT * FROM {p}seasons WHERE deleted_at IS NULL ORDER BY opens_on DESC, id DESC'))];
    }

    public function saveSeason(array $actor, ?string $id, array $body): array
    {
        $revirId = $this->validRevir($body['revirId'] ?? null);
        $opensOn = $this->validDate($body['opensOn'] ?? null, true, 'Otevření sezony');
        $name = $this->validText($body['name'] ?? null, 0, 80, 'invalid_name', 'Název') ?: 'Sezona ' . substr($opensOn, 0, 4);
        $closesOn = $this->validDate($body['closesOn'] ?? null, false, 'Uzavření sezony');
        if ($closesOn && $closesOn < $opensOn) throw new ApiError(400, 'invalid_date', 'Uzavření sezony musí být po jejím otevření.');
        return Db::transaction(function () use ($actor, $id, $revirId, $opensOn, $name, $closesOn) {
            $now = Time::nowIso();
            if ($id) {
                $existing = Db::row('SELECT * FROM {p}seasons WHERE id = ? AND deleted_at IS NULL', (int) $id);
                if (!$existing) throw new ApiError(404, 'not_found', 'Sezona neexistuje.');
                Db::exec('UPDATE {p}seasons SET revir_id = ?, name = ?, opens_on = ?, closes_on = ?, updated_at = ? WHERE id = ?', $revirId, $name, $opensOn, $closesOn, $now, $existing['id']);
                $rowId = $existing['id'];
            } else {
                $rowId = Db::insert('INSERT INTO {p}seasons (revir_id, name, opens_on, closes_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', $revirId, $name, $opensOn, $closesOn, $actor['id'], $now, $now);
            }
            $this->audit($actor, $id ? 'season_updated' : 'season_created', 'season', $rowId, ['name' => $name, 'opensOn' => $opensOn, 'closesOn' => $closesOn, 'revirId' => $revirId]);
            return ['season' => $this->seasonShape(Db::row('SELECT * FROM {p}seasons WHERE id = ?', $rowId))];
        });
    }

    // Uzavření sezony od data (včetně): posledním dnem lovu je den předtím.
    public function closeSeason(array $actor, string $id, array $body): array
    {
        $from = $this->validDate($body['from'] ?? null, true, 'Datum uzavření');
        if ($from < Time::pragueToday()) throw new ApiError(400, 'invalid_date', 'Sezonu lze uzavřít nejdříve ode dneška.');
        return Db::transaction(function () use ($actor, $id, $from) {
            $season = Db::row('SELECT * FROM {p}seasons WHERE id = ? AND deleted_at IS NULL', (int) $id);
            if (!$season) throw new ApiError(404, 'not_found', 'Sezona neexistuje.');
            $closesOn = Time::addDays($from, -1);
            if ($season['closes_on'] && $season['closes_on'] < $closesOn) throw new ApiError(409, 'already_closing', 'Sezona už končí dříve.');
            Db::exec('UPDATE {p}seasons SET closes_on = ?, updated_at = ? WHERE id = ?', $closesOn, Time::nowIso(), $season['id']);
            $this->audit($actor, 'season_closed', 'season', $season['id'], ['from' => $from, 'closesOn' => $closesOn]);
            return ['season' => $this->seasonShape(Db::row('SELECT * FROM {p}seasons WHERE id = ?', $season['id']))];
        });
    }

    public function deleteSeason(array $actor, string $id): array
    {
        if (!Db::exec('UPDATE {p}seasons SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Time::nowIso(), (int) $id)) throw new ApiError(404, 'not_found', 'Sezona neexistuje.');
        $this->audit($actor, 'season_deleted', 'season', $id);
        return ['deleted' => true];
    }

    // ---------- mimořádná uzavření ----------
    private function closureShape(array $c): array
    {
        return ['id' => $c['id'], 'revirId' => $c['revir_id'], 'revirName' => $this->revirName($c['revir_id']), 'dateFrom' => $c['date_from'], 'dateTo' => $c['date_to'], 'reason' => $c['reason'], 'createdAt' => $c['created_at']];
    }

    public function listClosures(): array
    {
        return ['closures' => array_map([$this, 'closureShape'], Db::all('SELECT * FROM {p}closures WHERE deleted_at IS NULL ORDER BY date_from DESC, id DESC LIMIT 200'))];
    }

    // Místenky na uzavřené dny (vystavené a rezervované) dostanou e-mail; vrácení peněz řeší správce ručně.
    public function createClosure(array $actor, array $body): array
    {
        $revirId = $this->validRevir($body['revirId'] ?? null);
        $dateFrom = $this->validDate($body['dateFrom'] ?? null, true, 'Datum od');
        $dateTo = $this->validDate($body['dateTo'] ?? null, false, 'Datum do') ?: $dateFrom;
        if ($dateTo < $dateFrom) throw new ApiError(400, 'invalid_date', 'Datum do musí být po datu od.');
        $reason = $this->validText($body['reason'] ?? null, 3, 300, 'invalid_reason', 'Důvod');
        return Db::transaction(function () use ($actor, $revirId, $dateFrom, $dateTo, $reason) {
            $now = Time::nowIso();
            $id = Db::insert('INSERT INTO {p}closures (revir_id, date_from, date_to, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', $revirId, $dateFrom, $dateTo, $reason, $actor['id'], $now);
            $closure = Db::row('SELECT * FROM {p}closures WHERE id = ?', $id);
            $affected = Db::all("SELECT * FROM {p}tickets WHERE fishing_date BETWEEN ? AND ? AND (? IS NULL OR revir_id = ?)
                AND ((status = 'issued' AND returned_at IS NULL) OR (status = 'pending_payment' AND reserved_until > ?))", $dateFrom, $dateTo, $revirId, $revirId, $now);
            foreach ($affected as $ticket) {
                $revir = Config::getRevir($this->app->config, $ticket['revir_id']) ?? ['name' => $ticket['revir_id']];
                $mail = Emails::closureNotice($this->app->config, ['ticket' => $ticket, 'revir' => $revir, 'closure' => $this->closureShape($closure), 'links' => ['status' => $this->app->appUrl . '/status.html?code=' . $ticket['code']]]);
                $this->app->queueEmail($ticket['id'], 'closure_notice', $ticket['email'], $mail);
            }
            $this->audit($actor, 'closure_created', 'closure', $id, ['revirId' => $revirId, 'dateFrom' => $dateFrom, 'dateTo' => $dateTo, 'reason' => $reason, 'affected' => count($affected)]);
            return ['closure' => $this->closureShape($closure), 'affectedTickets' => array_map(fn($t) => ['code' => $t['code'], 'date' => $t['fishing_date'], 'holder' => "{$t['first_name']} {$t['last_name']}", 'status' => $t['status']], $affected)];
        });
    }

    public function deleteClosure(array $actor, string $id): array
    {
        if (!Db::exec('UPDATE {p}closures SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Time::nowIso(), (int) $id)) throw new ApiError(404, 'not_found', 'Uzavření neexistuje.');
        $this->audit($actor, 'closure_deleted', 'closure', $id);
        return ['deleted' => true];
    }

    // Je den otevřený pro nákup? Uzavření má přednost; pak sezona. Revír bez sezony je otevřený celý rok.
    public function dayStatus(string $revirId, string $date): array
    {
        $closure = Db::row('SELECT * FROM {p}closures WHERE deleted_at IS NULL AND ' . self::SCOPE_SQL . ' AND ? BETWEEN date_from AND date_to ORDER BY id DESC LIMIT 1', $revirId, $date);
        if ($closure) return ['open' => false, 'code' => 'revir_closed', 'reason' => $closure['reason']];
        $seasons = $this->seasonsFor($revirId);
        if ($seasons) {
            $inside = false;
            foreach ($seasons as $s) if ($s['opens_on'] <= $date && (!$s['closes_on'] || $date <= $s['closes_on'])) $inside = true;
            if (!$inside) {
                $next = null;
                foreach ($seasons as $s) if ($s['opens_on'] > $date) { $next = $s; break; }
                $reason = $next ? 'Mimo sezonu – otevírá se ' . implode('. ', array_map('intval', array_reverse(explode('-', $next['opens_on'])))) : 'Mimo sezonu';
                return ['open' => false, 'code' => 'out_of_season', 'reason' => $reason, 'opensOn' => $next['opens_on'] ?? null];
            }
        }
        return ['open' => true];
    }
}
