<?php
// Zarybnění, přehledy a uzávěrky (src/node/lib/reports.js).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Reports
{
    public const AGE_CLASSES = ['plůdek', 'K0', 'K1', 'K2', 'K3', 'K4', 'tržní', 'generační', 'jiné'];

    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    private function revirName(?string $id): string
    {
        if (!$id) return 'Všechny revíry';
        return Config::getRevir($this->app->config, $id)['name'] ?? $id;
    }

    private function audit(?array $actor, string $action, string $targetType, $targetId, $detail = null): void
    {
        Db::exec('INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
            Time::nowIso(), $actor['id'] ?? null, $action, $targetType, Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    private function validRevir($value, bool $required = false): ?string
    {
        if ($value === null || $value === '') {
            if ($required) throw new ApiError(400, 'unknown_revir', 'Vyberte revír.');
            return null;
        }
        if (!Config::getRevir($this->app->config, Js::str($value))) throw new ApiError(400, 'unknown_revir', 'Revír neexistuje.');
        return Js::str($value);
    }

    private static function validRange($from, $to): array
    {
        $from = Js::s($from);
        $to = Js::s($to);
        if (!Time::isIsoDate($from) || !Time::isIsoDate($to)) throw new ApiError(400, 'invalid_date', 'Zadejte období od–do.');
        if ($to < $from) throw new ApiError(400, 'invalid_date', 'Konec období musí být po začátku.');
        return ['from' => $from, 'to' => $to];
    }

    // Kanonický název druhu podle pravidel revíru.
    private function speciesOf(string $revirId, $value): array
    {
        $config = $this->app->config;
        $revir = Config::getRevir($config, $revirId) ?? $config['reviry'][0];
        $key = Js::lower(trim(Js::s($value)));
        foreach ($revir['fishRules']['species'] ?? [] as $s) {
            $match = $s['id'] === $key || Js::lower($s['name']) === $key;
            foreach ($s['aliases'] ?? [] as $alias) if (Js::lower($alias) === $key) $match = true;
            if ($match) return ['id' => $s['id'], 'name' => $s['name']];
        }
        if ($key === '' || Js::len($key) > 60) throw new ApiError(400, 'invalid_species', 'Vyplňte druh ryby.');
        return ['id' => null, 'name' => trim(Js::str($value))];
    }

    private static function optionalNumber($value, string $label, bool $int = false): ?float
    {
        if ($value === null || $value === '') return null;
        $n = Js::number($value);
        if (!is_finite($n) || $n < 0 || ($int && floor($n) != $n)) throw new ApiError(400, 'invalid_number', "{$label} musí být " . ($int ? 'celé ' : '') . 'číslo ≥ 0.');
        return $n;
    }

    // ---------- zarybnění ----------
    private function stockingShape(array $s): array
    {
        return [
            'id' => $s['id'], 'revirId' => $s['revir_id'], 'revir' => $this->revirName($s['revir_id']), 'subdistrict' => $s['subdistrict'], 'date' => $s['date'], 'planned' => (bool) $s['planned'],
            'speciesId' => $s['species_id'], 'species' => $s['species_name'], 'ageClass' => $s['age_class'], 'kg' => $s['kg'], 'pieces' => $s['pieces'], 'costHalere' => $s['cost_halere'],
            'supplier' => $s['supplier'] ?? '', 'note' => $s['note'] ?? '', 'createdAt' => $s['created_at'], 'updatedAt' => $s['updated_at'],
        ];
    }

    public function listStocking(string $year, string $revirId, string $planned): array
    {
        $where = ['deleted_at IS NULL'];
        $params = [];
        if ($year !== '') { $where[] = 'SUBSTRING(date, 1, 4) = ?'; $params[] = $year; }
        if ($revirId !== '') { $where[] = 'revir_id = ?'; $params[] = $revirId; }
        if ($planned === '1' || $planned === '0') { $where[] = 'planned = ?'; $params[] = (int) $planned; }
        return ['stocking' => array_map([$this, 'stockingShape'], Db::all('SELECT * FROM {p}stocking_events WHERE ' . implode(' AND ', $where) . ' ORDER BY date DESC, id DESC LIMIT 1000', ...$params)), 'ageClasses' => self::AGE_CLASSES];
    }

    private function stockingInput(array $body): array
    {
        $revirId = $this->validRevir($body['revirId'] ?? null, true);
        if (!Time::isIsoDate(Js::s($body['date'] ?? null))) throw new ApiError(400, 'invalid_date', 'Zadejte datum (u plánu předpokládané).');
        $species = $this->speciesOf($revirId, $body['species'] ?? null);
        $ageClass = trim(Js::s($body['ageClass'] ?? null));
        if (Js::len($ageClass) > 30) throw new ApiError(400, 'invalid_age_class', 'Věková kategorie je příliš dlouhá.');
        $kg = self::optionalNumber($body['kg'] ?? null, 'Hmotnost');
        $pieces = self::optionalNumber($body['pieces'] ?? null, 'Počet kusů', true);
        if ($kg === null && $pieces === null) throw new ApiError(400, 'invalid_amount', 'Zadejte hmotnost nebo počet kusů.');
        $costCzk = self::optionalNumber($body['costCzk'] ?? null, 'Cena');
        $sub = $body['subdistrict'] ?? null;
        $subdistrict = $sub === null || $sub === '' ? null : Js::str($sub);
        $revir = Config::getRevir($this->app->config, $revirId);
        if ($subdistrict !== null && isset($revir['subdistrictList']) && is_array($revir['subdistrictList'])) {
            $found = false;
            foreach ($revir['subdistrictList'] as $s) if (Js::str($s['number'] ?? '') === $subdistrict) $found = true;
            if (!$found) throw new ApiError(400, 'invalid_subdistrict', 'Podrevír neexistuje.');
        }
        return [
            'revirId' => $revirId, 'date' => Js::str($body['date']), 'species' => $species, 'ageClass' => $ageClass !== '' ? $ageClass : null, 'kg' => $kg, 'pieces' => $pieces === null ? null : (int) $pieces,
            'costHalere' => $costCzk === null ? null : (int) Js::round($costCzk * 100), 'supplier' => Js::slice(trim(Js::s($body['supplier'] ?? null)), 0, 120), 'note' => Js::slice(trim(Js::s($body['note'] ?? null)), 0, 500),
            'subdistrict' => $subdistrict, 'planned' => ($body['planned'] ?? null) === true ? 1 : 0,
        ];
    }

    public function saveStocking(array $actor, ?string $id, array $body): array
    {
        $v = $this->stockingInput($body);
        return Db::transaction(function () use ($actor, $id, $v) {
            $now = Time::nowIso();
            if ($id) {
                if (!Db::row('SELECT 1 AS x FROM {p}stocking_events WHERE id = ? AND deleted_at IS NULL', (int) $id)) throw new ApiError(404, 'not_found', 'Záznam neexistuje.');
                Db::exec('UPDATE {p}stocking_events SET revir_id = ?, subdistrict = ?, date = ?, planned = ?, species_id = ?, species_name = ?, age_class = ?, kg = ?, pieces = ?, cost_halere = ?, supplier = ?, note = ?, updated_at = ? WHERE id = ?',
                    $v['revirId'], $v['subdistrict'], $v['date'], $v['planned'], $v['species']['id'], $v['species']['name'], $v['ageClass'], $v['kg'], $v['pieces'], $v['costHalere'], $v['supplier'], $v['note'], $now, (int) $id);
                $rowId = (int) $id;
            } else {
                $rowId = Db::insert('INSERT INTO {p}stocking_events (revir_id, subdistrict, date, planned, species_id, species_name, age_class, kg, pieces, cost_halere, supplier, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    $v['revirId'], $v['subdistrict'], $v['date'], $v['planned'], $v['species']['id'], $v['species']['name'], $v['ageClass'], $v['kg'], $v['pieces'], $v['costHalere'], $v['supplier'], $v['note'], $actor['id'], $now, $now);
            }
            $this->audit($actor, $id ? 'stocking_updated' : 'stocking_created', 'stocking', $rowId, ['planned' => (bool) $v['planned'], 'species' => $v['species']['name']]);
            return ['stocking' => $this->stockingShape(Db::row('SELECT * FROM {p}stocking_events WHERE id = ?', $rowId))];
        });
    }

    public function deleteStocking(array $actor, string $id): array
    {
        if (!Db::exec('UPDATE {p}stocking_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Time::nowIso(), (int) $id)) throw new ApiError(404, 'not_found', 'Záznam neexistuje.');
        $this->audit($actor, 'stocking_deleted', 'stocking', $id);
        return ['deleted' => true];
    }

    // Rozpočet zarybnění na rok (revíry + součet za MO).
    public function getBudget($year): array
    {
        $year = Js::s($year);
        if (!preg_match('/^\d{4}$/', $year)) throw new ApiError(400, 'invalid_year', 'Zadejte rok.');
        $rows = Db::all('SELECT * FROM {p}stocking_budgets WHERE year = ?', $year);
        $spent = fn($revirId, $planned) => (int) Db::val('SELECT COALESCE(SUM(cost_halere), 0) AS s FROM {p}stocking_events WHERE deleted_at IS NULL AND planned = ? AND SUBSTRING(date, 1, 4) = ? AND (? IS NULL OR revir_id = ?)', $planned, $year, $revirId, $revirId);
        $budgets = [];
        foreach ($this->app->config['reviry'] as $r) {
            $row = null;
            foreach ($rows as $b) if ($b['revir_id'] === $r['id']) $row = $b;
            $budgets[] = ['revirId' => $r['id'], 'revir' => $r['name'], 'amountHalere' => $row ? $row['amount_halere'] : null, 'note' => $row['note'] ?? '', 'spentHalere' => $spent($r['id'], 0), 'plannedHalere' => $spent($r['id'], 1), 'total' => false];
        }
        $amounts = array_filter($budgets, fn($b) => $b['amountHalere'] !== null);
        $budgets[] = [
            'revirId' => null, 'revir' => 'Všechny revíry', 'amountHalere' => $amounts ? array_sum(array_column($amounts, 'amountHalere')) : null, 'note' => '',
            'spentHalere' => array_sum(array_column($budgets, 'spentHalere')), 'plannedHalere' => array_sum(array_column($budgets, 'plannedHalere')), 'total' => true,
        ];
        return ['year' => $year, 'budgets' => $budgets];
    }

    public function setBudget(array $actor, array $body): array
    {
        $year = Js::s($body['year'] ?? null);
        if (!preg_match('/^\d{4}$/', $year)) throw new ApiError(400, 'invalid_year', 'Zadejte rok.');
        $revirId = $this->validRevir($body['revirId'] ?? null, true);
        $amount = self::optionalNumber($body['amountCzk'] ?? null, 'Rozpočet');
        $note = Js::slice(trim(Js::s($body['note'] ?? null)), 0, 300);
        Db::transaction(function () use ($actor, $year, $revirId, $amount, $note) {
            Db::exec("DELETE FROM {p}stocking_budgets WHERE year = ? AND COALESCE(revir_id, '') = ?", $year, $revirId ?? '');
            if ($amount !== null) Db::exec('INSERT INTO {p}stocking_budgets (year, revir_id, amount_halere, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', $year, $revirId, (int) Js::round($amount * 100), $note !== '' ? $note : null, $actor['id'], Time::nowIso());
            $this->audit($actor, 'stocking_budget_set', 'budget', $year . ':' . ($revirId ?: 'mo'), ['amount' => $amount]);
        });
        return $this->getBudget($year);
    }

    // ---------- přehledy ----------
    // Místenky na podrevír (revíry s podrevíry v prodeji): počet, tržby, úlovky.
    private function bySubdistrict(array $issued): array
    {
        $rows = [];
        foreach ($issued as $t) {
            if (empty($t['subdistrict'])) continue;
            $key = $t['revir_id'] . '|' . $t['subdistrict'];
            if (!isset($rows[$key])) $rows[$key] = ['revirId' => $t['revir_id'], 'revir' => $this->revirName($t['revir_id']), 'number' => Js::str($t['subdistrict']), 'label' => Config::subdistrictName(Config::getRevir($this->app->config, $t['revir_id']), $t['subdistrict']), 'tickets' => 0, 'revenueHalere' => 0, 'catches' => 0];
            $rows[$key]['tickets']++;
            if ($t['paid_at']) $rows[$key]['revenueHalere'] += (int) $t['amount_due_halere'];
            $rows[$key]['catches'] += (int) Db::val('SELECT COUNT(*) FROM {p}catches WHERE ticket_id = ?', $t['id']);
        }
        return array_values($rows);
    }

    public function stats($from, $to, $revirId): array
    {
        $range = self::validRange($from, $to);
        $revir = $this->validRevir($revirId);
        $scope = '(? IS NULL OR revir_id = ?)';
        $tickets = Db::all("SELECT * FROM {p}tickets WHERE fishing_date BETWEEN ? AND ? AND {$scope}", $range['from'], $range['to'], $revir, $revir);
        $issued = array_values(array_filter($tickets, fn($t) => $t['status'] === 'issued'));
        $today = Time::pragueToday();
        $count = fn(callable $fn, array $list) => count(array_filter($list, $fn));
        // Poslední den, kdy jde místenku ještě odevzdat (den lovu + lhůta revíru); po něm ji úloha uzavře jako neodevzdanou.
        $lastReturnDay = fn(array $t) => Time::addDays($t['fishing_date'], (int) (Config::getRevir($this->app->config, $t['revir_id'])['lateReturnDays'] ?? 7));
        $open = array_values(array_filter($issued, fn($t) => !$t['returned_at'] && !$t['closed_at'] && $t['fishing_date'] < $today && $lastReturnDay($t) >= $today));
        $openIds = array_column($open, 'id');
        $deadlines = array_map($lastReturnDay, $open);
        sort($deadlines);
        $summary = [
            'sold' => count($issued),
            'returned' => $count(fn($t) => (bool) $t['returned_at'], $issued),
            'returnedLate' => $count(fn($t) => $t['returned_at'] && $t['return_late'], $issued),
            'noCatch' => $count(fn($t) => $t['returned_at'] && $t['no_catch'], $issued),
            // Čeká na odevzdání (lhůta běží) vs. uzavřené po lhůtě jako neodevzdané.
            'awaitingReturn' => count($open),
            'returnDeadline' => $deadlines ? end($deadlines) : null,
            'unreturned' => $count(fn($t) => !$t['returned_at'] && $t['fishing_date'] < $today && !in_array($t['id'], $openIds, true), $issued),
            'upcoming' => $count(fn($t) => !$t['returned_at'] && $t['fishing_date'] >= $today, $issued),
            'seized' => $count(fn($t) => (bool) $t['seized_at'], $issued),
            'cancelled' => $count(fn($t) => $t['status'] === 'cancelled' && $t['paid_at'], $tickets),
            'vouchers' => $count(fn($t) => (bool) $t['voucher_code'], $issued),
            'revenueHalere' => array_sum(array_map(fn($t) => $t['paid_at'] ? $t['amount_due_halere'] : 0, $issued)),
            'anglers' => count(array_unique(array_column($issued, 'member_id'))),
        ];
        $catches = $issued ? Db::all("SELECT c.*, t.fishing_date FROM {p}catches c JOIN {p}tickets t ON t.id = c.ticket_id WHERE t.status = 'issued' AND t.fishing_date BETWEEN ? AND ? AND (? IS NULL OR t.revir_id = ?)", $range['from'], $range['to'], $revir, $revir) : [];
        $bySpecies = [];
        foreach ($catches as $c) {
            $s = $bySpecies[$c['species']] ?? ['species' => $c['species'], 'count' => 0, 'weightKg' => 0.0, 'weighed' => 0, 'estimated' => 0, 'lengthSum' => 0.0, 'maxLength' => 0];
            $s['count']++;
            $s['lengthSum'] += $c['length_cm'];
            $s['maxLength'] = max($s['maxLength'], $c['length_cm']);
            if ($c['weight_kg']) { $s['weightKg'] += $c['weight_kg']; $s['weighed']++; if ($c['weight_estimated']) $s['estimated']++; }
            $bySpecies[$c['species']] = $s;
        }
        $catchRows = [];
        foreach ($bySpecies as $s) {
            $avg = Js::round1($s['lengthSum'] / $s['count']);
            unset($s['lengthSum']);
            $s['weightKg'] = Js::round2($s['weightKg']);
            $s['avgLength'] = $avg;
            $catchRows[] = $s;
        }
        usort($catchRows, fn($a, $b) => $b['count'] <=> $a['count']);
        $stocking = Db::all("SELECT * FROM {p}stocking_events WHERE deleted_at IS NULL AND planned = 0 AND date BETWEEN ? AND ? AND {$scope}", $range['from'], $range['to'], $revir, $revir);
        $stocked = [];
        foreach ($stocking as $s) {
            $row = $stocked[$s['species_name']] ?? ['species' => $s['species_name'], 'pieces' => 0, 'kg' => 0.0, 'costHalere' => 0];
            $row['pieces'] += $s['pieces'] ?? 0;
            $row['kg'] += $s['kg'] ?? 0;
            $row['costHalere'] += $s['cost_halere'] ?? 0;
            $stocked[$s['species_name']] = $row;
        }
        // Uloveno vs. nasazeno.
        $names = array_unique(array_merge(array_map('strval', array_keys($bySpecies)), array_map('strval', array_keys($stocked))));
        $catchByName = [];
        foreach ($catchRows as $c) $catchByName[$c['species']] = $c;
        $balance = [];
        foreach ($names as $species) {
            $caught = $catchByName[$species] ?? null;
            $st = $stocked[$species] ?? null;
            $balance[] = ['species' => $species, 'caughtCount' => $caught['count'] ?? 0, 'caughtKg' => $caught['weightKg'] ?? 0, 'stockedPieces' => $st['pieces'] ?? 0, 'stockedKg' => Js::round2($st['kg'] ?? 0), 'balanceKg' => Js::round2(($st['kg'] ?? 0) - ($caught['weightKg'] ?? 0))];
        }
        usort($balance, fn($a, $b) => ($b['caughtKg'] <=> $a['caughtKg']) ?: ($b['stockedKg'] <=> $a['stockedKg']));
        $months = [];
        $month = function (string $date) use (&$months) {
            $key = substr($date, 0, 7);
            if (!isset($months[$key])) $months[$key] = ['month' => $key, 'tickets' => 0, 'catches' => 0, 'revenueHalere' => 0, 'stockingHalere' => 0];
            return $key;
        };
        foreach ($issued as $t) { $k = $month($t['fishing_date']); $months[$k]['tickets']++; if ($t['paid_at']) $months[$k]['revenueHalere'] += $t['amount_due_halere']; }
        foreach ($catches as $c) { $k = $month($c['fishing_date']); $months[$k]['catches']++; }
        foreach ($stocking as $s) { $k = $month($s['date']); $months[$k]['stockingHalere'] += $s['cost_halere'] ?? 0; }
        ksort($months);
        return array_merge($range, [
            'revirId' => $revir, 'revir' => $this->revirName($revir), 'generatedAt' => Time::nowIso(), 'summary' => $summary,
            'bySubdistrict' => $this->bySubdistrict($issued),
            'catches' => ['total' => count($catches), 'weightKg' => Js::round2(array_sum(array_column($catchRows, 'weightKg'))), 'bySpecies' => $catchRows],
            'stocking' => ['costHalere' => array_sum(array_column($stocked, 'costHalere')), 'bySpecies' => array_values(array_map(fn($s) => array_merge($s, ['kg' => Js::round2($s['kg'])]), $stocked))],
            'balance' => $balance,
            'byMonth' => array_values($months),
        ]);
    }

    // ---------- uzávěrky ----------
    private function reportMeta(array $r): array
    {
        return ['id' => $r['id'], 'name' => $r['name'], 'kind' => $r['kind'], 'seasonId' => $r['season_id'], 'revirId' => $r['revir_id'], 'revir' => $this->revirName($r['revir_id']), 'from' => $r['date_from'], 'to' => $r['date_to'], 'createdAt' => $r['created_at']];
    }

    public function listReports(): array
    {
        return ['reports' => array_map([$this, 'reportMeta'], Db::all('SELECT * FROM {p}season_reports ORDER BY id DESC LIMIT 200'))];
    }

    public function getReport($id): array
    {
        $row = Db::row('SELECT * FROM {p}season_reports WHERE id = ?', (int) $id);
        if (!$row) throw new ApiError(404, 'not_found', 'Uzávěrka neexistuje.');
        return array_merge($this->reportMeta($row), ['data' => json_decode($row['data'], true)]);
    }

    private function insertReport(string $name, string $kind, ?int $seasonId, ?string $revirId, string $from, string $to, ?array $actor): array
    {
        $data = $this->stats($from, $to, $revirId);
        $id = Db::insert('INSERT INTO {p}season_reports (name, kind, season_id, revir_id, date_from, date_to, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $name, $kind, $seasonId, $revirId ?: null, $from, $to, wp_json_encode($data), $actor['id'] ?? null, Time::nowIso());
        return ['id' => $id, 'data' => $data];
    }

    public function createReport(array $actor, array $body): array
    {
        $range = self::validRange($body['from'] ?? null, $body['to'] ?? null);
        $revirId = $this->validRevir($body['revirId'] ?? null);
        $name = Js::slice(trim(Js::s($body['name'] ?? null)), 0, 120) ?: "Uzávěrka {$range['from']} – {$range['to']}";
        return Db::transaction(function () use ($actor, $range, $revirId, $name) {
            $id = $this->insertReport($name, 'manual', null, $revirId, $range['from'], $range['to'], $actor)['id'];
            $this->audit($actor, 'report_created', 'report', $id, array_merge($range, ['revirId' => $revirId]));
            return $this->getReport($id);
        });
    }

    // Plánovaná úloha: po skončení sezony automatická uzávěrka, e-mail správci a trvalá záloha.
    public function closeSeasons(): array
    {
        $today = Time::pragueToday();
        // Uzávěrka je konečná až po lhůtě pro odevzdání posledního dne sezony (lateReturnDays revíru, u sezony MO nejdelší).
        $returnDays = function (array $season): int {
            $reviry = $season['revir_id'] ? [Config::getRevir($this->app->config, $season['revir_id'])] : $this->app->config['reviry'];
            return max(0, ...array_map(fn($r) => (int) ($r['lateReturnDays'] ?? 7), $reviry));
        };
        $due = array_values(array_filter(Db::all('SELECT * FROM {p}seasons WHERE deleted_at IS NULL AND closes_on IS NOT NULL AND closes_on < ? AND closed_report_at IS NULL', $today),
            fn($season) => Time::addDays($season['closes_on'], $returnDays($season)) < $today));
        $created = [];
        foreach ($due as $season) {
            Db::transaction(function () use ($season, &$created) {
                $report = $this->insertReport('Uzávěrka – ' . $season['name'], 'season', $season['id'], $season['revir_id'], $season['opens_on'], $season['closes_on'], null);
                Db::exec('UPDATE {p}seasons SET closed_report_at = ? WHERE id = ?', Time::nowIso(), $season['id']);
                $this->audit(null, 'season_report_created', 'report', $report['id'], ['seasonId' => $season['id']]);
                $recipients = Mailer::noticeRecipients();
                if ($recipients) {
                    $mail = Emails::seasonReport($this->app->config, ['name' => $season['name'], 'revir' => $this->revirName($season['revir_id']), 'data' => $report['data'], 'link' => $this->app->appUrl . '/manage.html#reports/' . $report['id']]);
                    foreach ($recipients as $to) $this->app->queueEmail(null, 'season_report', $to, $mail);
                }
                $created[] = $report['id'];
            });
        }
        foreach ($created as $id) {
            try { $this->app->backups->afterSeasonReport($this->getReport($id)); } catch (\Throwable $e) { error_log('[Místenka uzávěrka] ' . $e->getMessage()); }
        }
        return ['created' => count($created)];
    }
}
