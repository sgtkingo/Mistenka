<?php
// Doménová logika místenek (src/node/lib/service.js). Stejné chování, stavy, validace a chybové kódy – viz docs/API.md.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Service
{
    private const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    private const CODE_RE = '/^[A-Z0-9]{6}$/';
    private const VOUCHER_RE = '/^[A-Z0-9]{16}$/';
    private const TICKET_FILTER_STATES = ['pending_payment', 'payment_expired', 'cancelled', 'future', 'active', 'expired_unreturned', 'closed_unreturned', 'expired_returned', 'seized'];
    private const OPEN_RESULTS = ['unmatched', 'amount_mismatch', 'duplicate_payment', 'late'];
    private const PENALTY_LABELS = ['limits' => 'překročení limitů úlovků', 'late_return' => 'pozdní odevzdání místenky', 'seizure' => 'zadržení místenky porybným'];

    private App $app;
    private ?PaymentProvider $provider = null;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    private function config(): array
    {
        return $this->app->config;
    }

    public function provider(): PaymentProvider
    {
        return $this->provider ??= Payments::provider($this->config());
    }

    public static function normalizeCode($value): string
    {
        return strtoupper(trim(Js::s($value)));
    }

    private static function randomCode(int $length): string
    {
        $out = '';
        for ($i = 0; $i < $length; $i++) $out .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
        return $out;
    }

    // ---------- pravidla druhů ryb ----------
    private static function findSpecies(?array $rules, $name): ?array
    {
        $key = Js::lower(trim(Js::s($name)));
        if ($key === '' || !$rules) return null;
        foreach ($rules['species'] as $s) {
            if (Js::lower($s['name']) === $key) return $s;
            foreach ($s['aliases'] ?? [] as $alias) if (Js::lower($alias) === $key) return $s;
        }
        return null;
    }

    // Doba hájení MM-DD včetně; rozsah může přecházet přes konec roku.
    private static function inClosedSeason(array $species, string $isoDate): ?array
    {
        $md = substr($isoDate, 5);
        foreach ($species['closedSeasons'] ?? [] as $season) {
            $from = $season['from'];
            $to = $season['to'];
            if ($from <= $to ? ($md >= $from && $md <= $to) : ($md >= $from || $md <= $to)) return $season;
        }
        return null;
    }

    private static function czMonthDay(string $md): string
    {
        return (int) substr($md, 3) . '. ' . (int) substr($md, 0, 2) . '.';
    }

    private static function catchProblem(array $species, float $length, string $fishingDate): ?array
    {
        $season = self::inClosedSeason($species, $fishingDate);
        if ($season) {
            $message = $season['from'] === '01-01' && $season['to'] === '12-31'
                ? "{$species['name']} je celoročně hájen(a) – rybu je nutné vrátit."
                : "{$species['name']} je v době hájení (" . self::czMonthDay($season['from']) . '–' . self::czMonthDay($season['to']) . ') – rybu je nutné vrátit.';
            return ['code' => 'closed_season', 'message' => $message];
        }
        if (!empty($species['minLength']) && $length < $species['minLength']) return ['code' => 'undersized', 'message' => "{$species['name']} pod nejmenší lovnou mírou (" . Js::str($species['minLength']) . ' cm) – rybu je nutné vrátit.'];
        if (!empty($species['releaseFromLength']) && $length >= $species['releaseFromLength']) return ['code' => 'must_release', 'message' => "{$species['name']} od " . Js::str($species['releaseFromLength']) . ' cm se musí vrátit zpět do revíru.'];
        return null;
    }

    // ---------- pomocné ----------
    private function makeCode(): string
    {
        for (;;) {
            $code = self::randomCode(6);
            if (!Db::row('SELECT 1 AS x FROM {p}tickets WHERE code = ?', $code)) return $code;
        }
    }

    private function makeVariableSymbol(): string
    {
        for (;;) {
            $vs = (string) random_int(1000000000, 9999999999);
            if (!Db::row('SELECT 1 AS x FROM {p}tickets WHERE variable_symbol = ?', $vs)) return $vs;
        }
    }

    private function issueToken(int $ticketId, string $purpose): string
    {
        $token = Security::randomToken(24);
        Db::exec('INSERT INTO {p}ticket_tokens (token_hash, ticket_id, purpose, created_at) VALUES (?, ?, ?, ?)', Security::sha256($token), $ticketId, $purpose, Time::nowIso());
        return $token;
    }

    private function ticketById(int $id): ?array
    {
        return Db::row('SELECT * FROM {p}tickets WHERE id = ?', $id);
    }

    private function revirOf(array $ticket): array
    {
        return Config::getRevir($this->config(), $ticket['revir_id']) ?? ['id' => $ticket['revir_id'], 'name' => $ticket['revir_id'], 'lateReturnDays' => 7];
    }

    // Okno platnosti v ms: začátek a konec dne lovu, konec lhůty pro opožděné odevzdání.
    private function windowOf(array $ticket): array
    {
        $start = Time::ms(Time::pragueLocalToDate($ticket['fishing_date'], '00:00'));
        $end = Time::ms(Time::pragueLocalToDate($ticket['fishing_date'], '24:00'));
        $deadline = $end + (int) Js::number($this->revirOf($ticket)['lateReturnDays'] ?? 7) * 86400000;
        return ['start' => $start, 'end' => $end, 'deadline' => $deadline];
    }

    public function stateOf(array $ticket, ?int $at = null): string
    {
        $at ??= Time::ms(Time::now());
        if ($ticket['status'] === 'pending_payment') return Time::msOf($ticket['reserved_until']) <= $at ? 'payment_expired' : 'pending_payment';
        if ($ticket['status'] !== 'issued') return $ticket['status'];
        if ($ticket['returned_at']) return 'expired_returned';
        $w = $this->windowOf($ticket);
        // Zadržená: neplatí pro lov, ale do konce lhůty ji lze (a je nutné) odevzdat.
        if ($ticket['seized_at']) return $at < $w['deadline'] && !$ticket['closed_at'] ? 'seized' : 'closed_unreturned';
        if ($at < $w['start']) return 'future';
        if ($at < $w['end']) return 'active';
        if ($at < $w['deadline'] && !$ticket['closed_at']) return 'expired_unreturned';
        return 'closed_unreturned';
    }

    private function isReturnable(array $ticket, ?int $at = null): bool
    {
        return in_array($this->stateOf($ticket, $at), ['active', 'expired_unreturned', 'seized'], true);
    }

    // Obsazená místa: v revíru, nebo jen v podrevíru (místenky na podrevír).
    private function takenSeats(string $revirId, string $date, int $excludeId = 0, ?string $subdistrict = null): int
    {
        if ($subdistrict !== null) return (int) Db::val("SELECT COUNT(*) AS n FROM {p}tickets WHERE revir_id = ? AND fishing_date = ? AND id != ? AND subdistrict = ? AND (status = 'issued' OR (status = 'pending_payment' AND reserved_until > ?))", $revirId, $date, $excludeId, $subdistrict, Time::nowIso());
        return (int) Db::val("SELECT COUNT(*) AS n FROM {p}tickets WHERE revir_id = ? AND fishing_date = ? AND id != ? AND (status = 'issued' OR (status = 'pending_payment' AND reserved_until > ?))", $revirId, $date, $excludeId, Time::nowIso());
    }

    // Podrevír v prodeji (cena a kapacita), nebo null = místenka na celý revír.
    private static function saleOf(array $revir, $subdistrict): ?array
    {
        if ($subdistrict === null || $subdistrict === '') return null;
        foreach ($revir['saleSubdistricts'] ?? [] as $s) if (Js::str($s['number']) === Js::str($subdistrict)) return $s;
        return null;
    }

    private static function capacityOf(array $revir, ?string $subdistrict): int
    {
        return (int) (self::saleOf($revir, $subdistrict)['dailyCapacity'] ?? $revir['dailyCapacity']);
    }

    private function findTicket($code): array
    {
        $normalized = self::normalizeCode($code);
        if (!preg_match(self::CODE_RE, $normalized)) throw new ApiError(400, 'invalid_code', 'Kód místenky má 6 znaků A–Z a 0–9.');
        $ticket = Db::row('SELECT * FROM {p}tickets WHERE code = ?', $normalized);
        if (!$ticket) throw new ApiError(404, 'not_found', 'Místenka nebyla nalezena.');
        return $ticket;
    }

    // Držitel se prokáže tokenem, číslem členské legitimace, nebo je přihlášený k účtu, ke kterému místenka patří.
    private function authorize(array $ticket, array $credentials, ?array $user): void
    {
        if ($user && $ticket['user_id'] === $user['id']) return;
        if ($credentials['token'] !== '') {
            if (Db::row('SELECT 1 AS x FROM {p}ticket_tokens WHERE token_hash = ? AND ticket_id = ?', Security::sha256($credentials['token']), $ticket['id'])) return;
        }
        if ($credentials['memberId'] !== '' && Validate::normalizeMemberId($credentials['memberId']) === $ticket['member_id'] && $ticket['member_id'] !== '') return;
        throw new ApiError(403, 'forbidden', $credentials['token'] !== '' || $credentials['memberId'] !== '' ? 'Údaje pro přístup k místence nesouhlasí.' : 'Pro tuto akci zadejte číslo členské legitimace nebo použijte odkaz z e-mailu.');
    }

    private function maskMemberId(string $memberId): string
    {
        $visible = (int) ($this->config()['publicCheck']['memberIdVisibleChars'] ?? 4);
        if ($visible <= 0) return '•••';
        return str_repeat('•', max(3, strlen($memberId) - $visible)) . substr($memberId, -$visible);
    }

    private function links(array $ticket, ?string $token): array
    {
        $base = $this->app->appUrl;
        $ticketLink = $token ? "{$base}/payment.html?code={$ticket['code']}#t={$token}" : "{$base}/status.html?code={$ticket['code']}";
        return [
            'status' => "{$base}/status.html?code={$ticket['code']}",
            'ticket' => $ticketLink,
            'payment' => $ticketLink,
            'return' => $token ? "{$base}/return.html?code={$ticket['code']}#t={$token}" : "{$base}/return.html?code={$ticket['code']}",
        ] + $this->mapLinks($ticket['revir_id']);
    }

    // Odkaz na interaktivní mapu revíru (jen když je mapa zakreslená).
    private function mapLinks(string $revirId): array
    {
        $map = $this->config()['maps'][$revirId] ?? null;
        if (empty($map['features'])) return [];
        return ['map' => $this->app->appUrl . '/map.html?revir=' . rawurlencode($revirId)];
    }

    private function enqueueEmail(array $ticket, string $kind, ?string $token, array $extra = []): void
    {
        $revir = $this->revirOf($ticket);
        $render = ['payment_instructions' => 'paymentInstructions', 'ticket_issued' => 'ticketIssued', 'return_reminder' => 'returnReminder', 'ticket_closed' => 'ticketClosed', 'ticket_seized' => 'ticketSeized',
            'seizure_notice' => 'seizureNotice', 'limit_exceeded' => 'limitExceeded', 'member_blocked' => 'memberBlocked', 'ticket_cancelled' => 'ticketCancelled'][$kind];
        $mail = Emails::$render($this->config(), array_merge(['ticket' => $ticket, 'revir' => $revir, 'links' => $this->links($ticket, $token)], $extra));
        $this->app->queueEmail($ticket['id'], $kind, $extra['to'] ?? $ticket['email'], $mail);
    }

    private function audit(?array $actor, string $action, string $targetType, $targetId, $detail = null): void
    {
        Db::exec('INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
            Time::nowIso(), $actor['id'] ?? null, $action, $targetType, Js::str($targetId), $detail === null ? null : wp_json_encode($detail));
    }

    // ---------- výstupní tvary ----------
    private function paymentInfo(array $ticket): array
    {
        $config = $this->config();
        $p = $config['payment'];
        $message = (($p['messagePrefix'] ?? '') ?: 'Mistenka') . " {$ticket['code']} {$ticket['fishing_date']}";
        return [
            'iban' => $config['iban'],
            'accountNumber' => "{$p['accountNumber']}/{$p['bankCode']}",
            'recipientName' => ($p['recipientName'] ?? '') ?: $config['organization']['shortName'],
            'variableSymbol' => $ticket['variable_symbol'],
            'amountHalere' => $ticket['amount_due_halere'],
            'message' => $message,
            'reservedUntil' => $ticket['reserved_until'],
            'spayd' => Payments::spayd($config['iban'], $ticket['amount_due_halere'], (string) $ticket['variable_symbol'], $message, $p['recipientName'] ?? null),
        ];
    }

    private function publicTicket(array $ticket): array
    {
        $revir = $this->revirOf($ticket);
        $status = $this->stateOf($ticket);
        $w = $this->windowOf($ticket);
        $issued = $ticket['status'] === 'issued';
        $full = !empty($this->config()['publicCheck']['showFullName']);
        $name = $full ? "{$ticket['first_name']} {$ticket['last_name']}" : $ticket['first_name'] . ' ' . Js::slice($ticket['last_name'], 0, 1) . '.';
        $now = Time::ms(Time::now());
        return [
            'code' => $ticket['code'],
            'revir' => ['id' => $revir['id'], 'name' => $revir['name'], 'number' => $revir['number'] ?? ''],
            'subdistrict' => ($ticket['subdistrict'] ?? null) ? ['number' => Js::str($ticket['subdistrict']), 'label' => Config::subdistrictName($revir, $ticket['subdistrict'])] : null,
            'date' => $ticket['fishing_date'],
            'status' => $status,
            'late' => $status === 'expired_unreturned' || $status === 'closed_unreturned' || ($status === 'expired_returned' && (bool) $ticket['return_late']) || ($status === 'seized' && $now >= $w['end']),
            'seized' => (bool) $ticket['seized_at'],
            'holder' => $issued ? ['name' => $name, 'memberId' => $this->maskMemberId($ticket['member_id'])] : null,
            'validFrom' => Time::iso(Time::fromMs($w['start'])),
            'validTo' => Time::iso(Time::fromMs($w['end'])),
        ];
    }

    // Možné porušení pravidel u úlovku (míra, hájení, povinné vrácení) podle aktuálních pravidel revíru – jen upozornění.
    private function catchWarning(array $ticket, string $species, float $length): ?string
    {
        $rules = $this->revirOf($ticket)['fishRules'] ?? null;
        if (!$rules || ($rules['sizeRulesEnabled'] ?? true) === false) return null;
        $known = self::findSpecies($rules, $species);
        $problem = $known ? self::catchProblem($known, $length, $ticket['fishing_date']) : null;
        return $problem ? $problem['message'] : null;
    }

    private function catchesOf(array $ticket): array
    {
        return array_map(fn($c) => ['species' => $c['species'], 'length' => $c['length_cm'], 'weight' => $c['weight_kg'], 'weightEstimated' => (bool) $c['weight_estimated'],
            'warning' => $this->catchWarning($ticket, $c['species'], Js::number($c['length_cm']))],
            Db::all('SELECT species, length_cm, weight_kg, weight_estimated FROM {p}catches WHERE ticket_id = ? ORDER BY id', $ticket['id']));
    }

    private function ownerTicket(array $ticket, bool $withLimits = true): array
    {
        $base = $this->publicTicket($ticket);
        unset($base['holder']);
        $w = $this->windowOf($ticket);
        $out = array_merge($base, [
            'firstName' => $ticket['first_name'], 'lastName' => $ticket['last_name'], 'birthDate' => $ticket['birth_date'], 'email' => $ticket['email'], 'memberId' => $ticket['member_id'],
            'priceHalere' => $ticket['price_halere'], 'amountDueHalere' => $ticket['amount_due_halere'], 'voucherUsed' => (bool) $ticket['voucher_code'],
            'createdAt' => $ticket['created_at'], 'issuedAt' => $ticket['issued_at'], 'returnedAt' => $ticket['returned_at'], 'noCatch' => (bool) $ticket['no_catch'],
            'returnable' => $this->isReturnable($ticket), 'returnDeadline' => Time::iso(Time::fromMs($w['deadline'])), 'closedAt' => $ticket['closed_at'],
            'seizure' => $ticket['seized_at'] ? ['at' => $ticket['seized_at'], 'reason' => $ticket['seized_reason'], 'place' => $ticket['seized_place'] ?? ''] : null,
            'catches' => $this->catchesOf($ticket),
            'payment' => $base['status'] === 'pending_payment' ? $this->paymentInfo($ticket) : null,
        ]);
        if ($withLimits && $ticket['status'] !== 'cancelled') $out['limits'] = $this->limitsFor($ticket);
        return $out;
    }

    // ---------- veřejné operace ----------
    public function availability(string $revirId): array
    {
        $revir = Config::getRevir($this->config(), $revirId);
        if (!$revir) throw new ApiError(404, 'unknown_revir', 'Revír neexistuje.');
        $today = Time::pragueToday();
        $days = [];
        for ($offset = 0; $offset <= $revir['bookingDaysAhead']; $offset++) {
            $date = Time::addDays($today, $offset);
            $day = $this->app->operations->dayStatus($revir['id'], $date);
            // Revír s podrevíry v prodeji: místa a cena po podrevírech, den = součet.
            $subs = [];
            foreach ($revir['saleSubdistricts'] ?? [] as $s) {
                $t = $this->takenSeats($revir['id'], $date, 0, Js::str($s['number']));
                $subs[] = ['number' => $s['number'], 'name' => $s['name'], 'priceCzk' => $s['priceCzk'], 'capacity' => $s['dailyCapacity'], 'taken' => $t, 'available' => $day['open'] ? max(0, $s['dailyCapacity'] - $t) : 0];
            }
            $capacity = $subs ? array_sum(array_column($subs, 'capacity')) : $revir['dailyCapacity'];
            $taken = $subs ? array_sum(array_column($subs, 'taken')) : $this->takenSeats($revir['id'], $date);
            $available = $subs ? array_sum(array_column($subs, 'available')) : ($day['open'] ? max(0, $capacity - $taken) : 0);
            $days[] = ['date' => $date, 'capacity' => $capacity, 'taken' => $taken, 'available' => $available, 'subdistricts' => $subs, 'closed' => !$day['open'], 'closedReason' => $day['open'] ? null : $day['reason'], 'closedCode' => $day['open'] ? null : $day['code']];
        }
        return ['revirId' => $revir['id'], 'today' => $today, 'days' => $days];
    }

    private function validateOrder(array $input): array
    {
        $revir = Config::getRevir($this->config(), Js::s($input['revirId'] ?? null));
        if (!$revir) throw new ApiError(400, 'unknown_revir', 'Vyberte revír.');
        $today = Time::pragueToday();
        $date = Js::s($input['date'] ?? null);
        if (!Time::isIsoDate($date) || $date < $today || $date > Time::addDays($today, $revir['bookingDaysAhead'])) throw new ApiError(400, 'invalid_date', "Datum lovu musí být mezi dneškem a {$revir['bookingDaysAhead']}. dnem dopředu.");
        $memberId = Validate::memberId($input['memberId'] ?? null);
        [$firstName, $lastName] = Validate::name($input['firstName'] ?? null, $input['lastName'] ?? null);
        $birthDate = Validate::birthDate($input['birthDate'] ?? null);
        $email = Validate::email($input['email'] ?? null);
        if (($input['declaration'] ?? null) !== true) throw new ApiError(400, 'declaration_required', 'Potvrďte čestné prohlášení a podmínky rezervace.');
        $voucherCode = self::normalizeCode($input['voucherCode'] ?? null);
        if ($voucherCode !== '' && !preg_match(self::VOUCHER_RE, $voucherCode)) throw new ApiError(400, 'invalid_voucher', 'Kód poukazu musí mít 16 znaků A–Z nebo 0–9.');
        // Revír s podrevíry v prodeji: místenka platí pro jeden vybraný podrevír; jediný se vybere automaticky.
        $subdistrict = null;
        $sales = $revir['saleSubdistricts'] ?? [];
        if ($sales) {
            $wanted = $input['subdistrict'] ?? null;
            $sale = count($sales) === 1 && ($wanted === null || $wanted === '') ? $sales[0] : self::saleOf($revir, $wanted);
            if (!$sale) throw new ApiError(400, 'invalid_subdistrict', 'Vyberte podrevír, na který místenku kupujete.');
            $subdistrict = Js::str($sale['number']);
        }
        return compact('revir', 'date', 'memberId', 'firstName', 'lastName', 'birthDate', 'email', 'voucherCode', 'subdistrict');
    }

    public function createOrder(array $input, ?array $user): array
    {
        $order = $this->validateOrder($input);
        return Db::transaction(function () use ($order, $user) {
            $revir = $order['revir'];
            $day = $this->app->operations->dayStatus($revir['id'], $order['date']);
            if (!$day['open']) throw new ApiError(409, $day['code'], $day['code'] === 'revir_closed' ? "Revír je v tento den mimořádně uzavřen: {$day['reason']}" : "{$day['reason']}. Místenku na tento den nelze koupit.");
            $block = $this->activeBlock($order['memberId']);
            if ($block) {
                $until = $block['until_date'] ? 'do ' . implode('. ', array_map('intval', array_reverse(explode('-', $block['until_date'])))) : 'do odvolání';
                throw new ApiError(403, 'member_blocked', "Nákup místenek je pro toto číslo legitimace pozastaven {$until}. Důvod: {$block['reason']}. Kontaktujte správce organizace.");
            }
            if ($this->takenSeats($revir['id'], $order['date'], 0, $order['subdistrict']) >= self::capacityOf($revir, $order['subdistrict'])) throw new ApiError(409, 'sold_out', $order['subdistrict'] !== null ? 'Na vybraný den už v tomto podrevíru nejsou volná místa.' : 'Na vybraný den už nejsou volná místa.');
            if ($order['voucherCode'] !== '') {
                $voucher = Db::row('SELECT * FROM {p}vouchers WHERE code = ?', $order['voucherCode']);
                if (!$voucher || ($voucher['revir_id'] && $voucher['revir_id'] !== $revir['id'])) throw new ApiError(400, 'invalid_voucher', 'Poukaz není platný.');
                if ($voucher['voided_at']) throw new ApiError(400, 'invalid_voucher', 'Poukaz není platný.');
                if ($voucher['used_at']) throw new ApiError(409, 'voucher_used', 'Poukaz už byl použit.');
            }
            $now = Time::now();
            $nowIso = Time::iso($now);
            $price = (int) Js::round(Js::number(self::saleOf($revir, $order['subdistrict'])['priceCzk'] ?? $revir['priceCzk']) * 100);
            $due = $order['voucherCode'] !== '' ? 0 : $price;
            $free = $due === 0;
            $code = $this->makeCode();
            $ticketId = Db::insert('INSERT INTO {p}tickets (code, revir_id, subdistrict, fishing_date, member_id, first_name, last_name, birth_date, email, price_halere, amount_due_halere, variable_symbol, voucher_code, status, created_at, reserved_until, paid_at, issued_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                $code, $revir['id'], $order['subdistrict'], $order['date'], $order['memberId'], $order['firstName'], $order['lastName'], $order['birthDate'], $order['email'],
                $price, $due, $free ? null : $this->makeVariableSymbol(), $order['voucherCode'] !== '' ? $order['voucherCode'] : null, $free ? 'issued' : 'pending_payment', $nowIso,
                $free ? null : Time::iso(Time::addMinutes($now, (int) $this->config()['payment']['reservationMinutes'])), null, $free ? $nowIso : null, $user['id'] ?? null);
            if ($order['voucherCode'] !== '') {
                if (!Db::exec('UPDATE {p}vouchers SET used_at = ?, ticket_code = ? WHERE code = ? AND used_at IS NULL', $nowIso, $code, $order['voucherCode'])) throw new ApiError(409, 'voucher_used', 'Poukaz už byl použit.');
            }
            $ticket = $this->ticketById($ticketId);
            $token = $this->issueToken($ticketId, 'order');
            $this->enqueueEmail($ticket, $free ? 'ticket_issued' : 'payment_instructions', $token);
            return ['token' => $token, 'ticket' => $this->ownerTicket($ticket)];
        });
    }

    public function getPublicTicket($code): array
    {
        return $this->publicTicket($this->findTicket($code));
    }

    public function getOwnerTicket($code, array $credentials, ?array $user): array
    {
        $ticket = $this->findTicket($code);
        $this->authorize($ticket, $credentials, $user);
        return $this->ownerTicket($ticket);
    }

    public function ticketsForUser(array $user): array
    {
        return array_map(fn($t) => $this->ownerTicket($t, false), Db::all('SELECT * FROM {p}tickets WHERE user_id = ? ORDER BY fishing_date DESC, id DESC LIMIT 200', $user['id']));
    }

    public function cancelOrder($code, array $credentials, ?array $user): array
    {
        $ticket = $this->findTicket($code);
        $this->authorize($ticket, $credentials, $user);
        return Db::transaction(function () use ($ticket) {
            $fresh = $this->ticketById($ticket['id']);
            if ($fresh['status'] !== 'pending_payment' && $fresh['status'] !== 'payment_expired') throw new ApiError(409, 'not_cancellable', 'Zrušit lze jen nezaplacenou objednávku.');
            Db::exec("UPDATE {p}tickets SET status = 'cancelled', cancelled_at = ?, reserved_until = NULL WHERE id = ?", Time::nowIso(), $ticket['id']);
            return $this->ownerTicket($this->ticketById($ticket['id']));
        });
    }

    public function submitReturn($code, array $credentials, array $body, ?array $user): array
    {
        $ticket = $this->findTicket($code);
        $this->authorize($ticket, $credentials, $user);
        $noCatch = ($body['noCatch'] ?? null) === true;
        $items = isset($body['catches']) && is_array($body['catches']) && !Js::isAssoc($body['catches']) ? $body['catches'] : [];
        if ($noCatch && $items) throw new ApiError(400, 'invalid_catches', 'Při hlášení bez úlovku neuvádějte žádné úlovky.');
        if (!$noCatch && !$items) throw new ApiError(400, 'catches_required', 'Zapište alespoň jeden úlovek, nebo zvolte „Bez úlovku“.');
        if (count($items) > 100) throw new ApiError(400, 'invalid_catches', 'Příliš mnoho úlovků.');
        $rules = $this->revirOf($ticket)['fishRules'] ?? null;
        $catches = [];
        foreach ($items as $index => $item) {
            $item = is_array($item) ? $item : [];
            $name = trim(Js::s($item['species'] ?? null));
            $length = Js::number($item['length'] ?? null);
            $rawWeight = $item['weight'] ?? null;
            $weight = $rawWeight === null || $rawWeight === '' ? null : Js::number($rawWeight);
            $row = 'Úlovek ' . ($index + 1);
            if ($name === '' || Js::len($name) > 60) throw new ApiError(400, 'invalid_catches', "{$row}: vyplňte druh ryby.");
            if (!array_key_exists('length', $item) || !($length > 0 && $length <= 400)) throw new ApiError(400, 'invalid_catches', "{$row}: vyplňte délku v cm.");
            if ($weight !== null && !($weight > 0 && $weight <= 300)) throw new ApiError(400, 'invalid_catches', "{$row}: neplatná hmotnost.");
            // Míra, hájení a povinné vrácení odevzdání nebrání – rozhodují pravidla v RIS; možné porušení se jen
            // vyznačí u úlovku (catches[].warning) rybáři, porybnému i správci.
            $known = self::findSpecies($rules, $name);
            $catches[] = ['species' => $known ? $known['name'] : $name, 'length' => $length, 'weight' => $weight, 'weightEstimated' => $weight !== null && ($item['weightEstimated'] ?? null) === true];
        }
        return Db::transaction(function () use ($ticket, $catches, $noCatch) {
            $fresh = $this->ticketById($ticket['id']);
            $now = Time::ms(Time::now());
            $state = $this->stateOf($fresh, $now);
            if ($fresh['status'] !== 'issued') throw new ApiError(409, 'not_issued', 'Místenka nebyla vystavena.');
            if ($state === 'expired_returned') throw new ApiError(409, 'already_returned', 'Místenka už byla odevzdána.');
            if ($state === 'future') throw new ApiError(409, 'too_early', 'Místenku není možné odevzdat před dnem lovu.');
            if ($state === 'closed_unreturned') throw new ApiError(409, 'return_closed', 'Lhůta pro odevzdání uplynula, místenka byla uzavřena jako neodevzdaná. Kontaktujte hospodáře.');
            foreach ($catches as $c) Db::exec('INSERT INTO {p}catches (ticket_id, species, length_cm, weight_kg, weight_estimated) VALUES (?, ?, ?, ?, ?)', $fresh['id'], $c['species'], $c['length'], $c['weight'], $c['weightEstimated'] ? 1 : 0);
            Db::exec('UPDATE {p}tickets SET returned_at = ?, return_late = ?, no_catch = ?, rules_version = ? WHERE id = ?', Time::iso(Time::fromMs($now)), $now >= $this->windowOf($fresh)['end'] ? 1 : 0, $noCatch ? 1 : 0, $this->app->settings->rulesVersion($fresh['revir_id']), $fresh['id']);
            $returned = $this->ticketById($fresh['id']);
            $this->recordViolations($returned);
            if ($returned['return_late']) $this->applyPenalty($returned, 'late_return');
            return $this->ownerTicket($returned);
        });
    }

    // ---------- limity úlovků (B3) ----------
    private static function parseHa($text): ?float
    {
        if (preg_match('/(\d+(?:\.\d+)?)\s*ha/u', str_replace(',', '.', Js::s($text)), $m)) return (float) $m[1];
        return null;
    }

    // Výměra vody, na kterou místenka platí: její podrevír, jinak největší z podrevírů v prodeji, jinak výměra revíru.
    private function ticketAreaHa(array $ticket): ?float
    {
        $revir = $this->revirOf($ticket);
        if (!empty($ticket['subdistrict'])) {
            foreach ($revir['subdistrictList'] ?? [] as $s) {
                if (Js::str($s['number'] ?? '') === Js::str($ticket['subdistrict'])) { $own = self::parseHa($s['area'] ?? null); if ($own !== null) return $own; }
            }
        }
        $numbers = isset($revir['ticketSubdistricts']) && is_array($revir['ticketSubdistricts']) ? $revir['ticketSubdistricts'] : [];
        $areas = [];
        foreach ($numbers as $n) {
            $area = null;
            foreach ($revir['subdistrictList'] ?? [] as $s) if (Js::str($s['number'] ?? '') === Js::str($n)) $area = self::parseHa($s['area'] ?? null);
            $areas[] = $area;
        }
        if ($areas && !in_array(null, $areas, true)) return max($areas);
        return self::parseHa($revir['area'] ?? null);
    }

    private function limitApplies(array $limit, array $ticket): bool
    {
        if (!isset($limit['maxAreaHa'])) return true;
        $area = $this->ticketAreaHa($ticket);
        return ($area ?? INF) <= $limit['maxAreaHa'];
    }

    private static function periodRange(string $period, string $date): array
    {
        if ($period === 'week') { $from = Time::weekStart($date); return ['from' => $from, 'to' => Time::addDays($from, 6)]; }
        if ($period === 'month') return ['from' => substr($date, 0, 8) . '01', 'to' => Time::monthEnd($date)];
        return ['from' => $date, 'to' => $date];
    }

    // Přehled limitů pro místenku: denní (jen tato místenka) + týdenní a měsíční (všechny místenky člena v období).
    private function limitsFor(array $ticket): array
    {
        $revir = $this->revirOf($ticket);
        $rules = $revir['fishRules'] ?? null;
        if (!$rules || empty($rules['limitsEnabled'])) return [];
        $speciesIdOf = fn($name) => self::findSpecies($rules, $name)['id'] ?? null;
        $own = array_map(fn($c) => $speciesIdOf($c['species']), Db::all('SELECT species FROM {p}catches WHERE ticket_id = ?', (int) $ticket['id']));
        $out = [];
        foreach ($rules['dailyLimits'] ?? [] as $limit) {
            $count = count(array_filter($own, fn($id) => $id && in_array($id, $limit['species'], true)));
            $out[] = ['id' => $limit['id'], 'label' => $limit['label'], 'period' => 'day', 'from' => $ticket['fishing_date'], 'to' => $ticket['fishing_date'], 'maxCount' => $limit['maxCount'], 'count' => $count, 'exceeded' => $count > $limit['maxCount'], 'source' => $limit['source'] ?? ''];
        }
        foreach ($rules['periodLimits'] ?? [] as $limit) {
            if (!$this->limitApplies($limit, $ticket)) continue;
            $range = self::periodRange($limit['period'], $ticket['fishing_date']);
            $tickets = array_filter(Db::all("SELECT id, revir_id, subdistrict FROM {p}tickets WHERE member_id = ? AND status = 'issued' AND fishing_date BETWEEN ? AND ?", $ticket['member_id'], $range['from'], $range['to']),
                fn($t) => $this->limitApplies($limit, $t));
            $count = 0;
            foreach ($tickets as $t) {
                foreach (Db::all('SELECT species FROM {p}catches WHERE ticket_id = ?', $t['id']) as $c) if (in_array($speciesIdOf($c['species']), $limit['species'], true)) $count++;
            }
            $out[] = array_merge(['id' => $limit['id'], 'label' => $limit['label'], 'period' => $limit['period']], $range, ['maxCount' => $limit['maxCount'], 'count' => $count, 'exceeded' => $count > $limit['maxCount'], 'source' => $limit['source'] ?? '']);
        }
        return $out;
    }

    private function activeBlock(string $memberId): ?array
    {
        return Db::row('SELECT * FROM {p}member_blocks WHERE member_id = ? AND lifted_at IS NULL AND (until_date IS NULL OR until_date >= ?) ORDER BY id DESC LIMIT 1', $memberId, Time::pragueToday());
    }

    // Při odevzdání: zapíše překročené limity, upozorní správce, případně automaticky zablokuje.
    private function recordViolations(array $ticket): array
    {
        $exceeded = array_values(array_filter($this->limitsFor($ticket), fn($l) => $l['exceeded']));
        if (!$exceeded) return [];
        $now = Time::nowIso();
        foreach ($exceeded as $l) {
            Db::exec('INSERT INTO {p}limit_violations (ticket_id, member_id, limit_id, label, period, period_from, period_to, count, max_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                $ticket['id'], $ticket['member_id'], $l['id'], $l['label'], $l['period'], $l['from'], $l['to'], $l['count'], $l['maxCount'], $now);
        }
        foreach (Mailer::noticeRecipients() as $to) $this->enqueueEmail($ticket, 'limit_exceeded', null, ['to' => $to, 'limits' => $exceeded]);
        $this->applyPenalty($ticket, 'limits', ['limits' => $exceeded]);
        return $exceeded;
    }

    // Následky porušení pravidel: po N případech v kalendářním roce (dle dne lovu) automatická blokace nákupu.
    private function penaltyRule(string $cause): array
    {
        $config = $this->config();
        if ($cause === 'limits') {
            $p = $config['limitPolicy'] ?? [];
            return ['count' => $p['violationsBeforeBlock'] ?? 0, 'blockDays' => $p['blockDays'] ?? null];
        }
        if ($cause === 'late_return') return $config['penaltyPolicy']['lateReturn'];
        return $config['penaltyPolicy']['seizure'];
    }

    private function penaltyCount(string $memberId, string $year, string $cause): int
    {
        if ($cause === 'limits') return (int) Db::val('SELECT COUNT(DISTINCT v.ticket_id) AS n FROM {p}limit_violations v JOIN {p}tickets t ON t.id = v.ticket_id WHERE v.member_id = ? AND SUBSTRING(t.fishing_date, 1, 4) = ?', $memberId, $year);
        if ($cause === 'seizure') return (int) Db::val('SELECT COUNT(*) AS n FROM {p}tickets WHERE member_id = ? AND seized_at IS NOT NULL AND SUBSTRING(fishing_date, 1, 4) = ?', $memberId, $year);
        $unreturned = !empty($this->config()['penaltyPolicy']['lateReturn']['includeUnreturned']) ? ' OR (closed_at IS NOT NULL AND returned_at IS NULL)' : '';
        return (int) Db::val("SELECT COUNT(*) AS n FROM {p}tickets WHERE member_id = ? AND status = 'issued' AND SUBSTRING(fishing_date, 1, 4) = ? AND ((returned_at IS NOT NULL AND return_late = 1){$unreturned})", $memberId, $year);
    }

    private function applyPenalty(array $ticket, string $cause, array $extra = []): ?array
    {
        $rule = $this->penaltyRule($cause);
        if (!(($rule['count'] ?? 0) > 0) || !$ticket['member_id'] || $this->activeBlock($ticket['member_id'])) return null;
        $year = substr($ticket['fishing_date'], 0, 4);
        $count = $this->penaltyCount($ticket['member_id'], $year, $cause);
        if ($count < $rule['count']) return null;
        $now = Time::nowIso();
        $until = !empty($rule['blockDays']) ? Time::addDays(Time::pragueToday(), (int) $rule['blockDays'] - 1) : "{$year}-12-31";
        $reason = 'Opakované ' . self::PENALTY_LABELS[$cause] . " ({$count}× v roce {$year})";
        $id = Db::insert("INSERT INTO {p}member_blocks (member_id, reason, until_date, source, cause, created_at) VALUES (?, ?, ?, 'auto', ?, ?)", $ticket['member_id'], $reason, $until, $cause, $now);
        $block = Db::row('SELECT * FROM {p}member_blocks WHERE id = ?', $id);
        Db::exec("INSERT INTO {p}audit_events (at, action, target_type, target_id, detail) VALUES (?, 'member_blocked_auto', 'member', ?, ?)", $now, $ticket['member_id'], wp_json_encode(['cause' => $cause, 'count' => $count, 'until' => $until]));
        $this->enqueueEmail($ticket, 'member_blocked', null, array_merge(['block' => $block], $extra));
        return $block;
    }

    // ---------- správa limitů a blokací ----------
    private function blockShape(array $b): array
    {
        $holder = Db::row('SELECT first_name, last_name FROM {p}tickets WHERE member_id = ? ORDER BY id DESC LIMIT 1', $b['member_id']);
        return [
            'id' => $b['id'], 'memberId' => $b['member_id'], 'holder' => $holder ? "{$holder['first_name']} {$holder['last_name']}" : '', 'reason' => $b['reason'], 'until' => $b['until_date'], 'source' => $b['source'],
            'cause' => $b['cause'] ?: ($b['source'] === 'manual' ? 'manual' : 'limits'), 'createdAt' => $b['created_at'], 'liftedAt' => $b['lifted_at'],
            'active' => !$b['lifted_at'] && (!$b['until_date'] || $b['until_date'] >= Time::pragueToday()),
        ];
    }

    public function listViolations(): array
    {
        $rows = Db::all('SELECT v.*, t.code, t.first_name, t.last_name, t.fishing_date FROM {p}limit_violations v JOIN {p}tickets t ON t.id = v.ticket_id ORDER BY v.id DESC LIMIT 200');
        return ['violations' => array_map(fn($v) => [
            'id' => $v['id'], 'code' => $v['code'], 'date' => $v['fishing_date'], 'memberId' => $v['member_id'], 'holder' => "{$v['first_name']} {$v['last_name']}", 'label' => $v['label'], 'period' => $v['period'],
            'from' => $v['period_from'], 'to' => $v['period_to'], 'count' => $v['count'], 'maxCount' => $v['max_count'], 'createdAt' => $v['created_at'], 'blocked' => (bool) $this->activeBlock($v['member_id']),
        ], $rows)];
    }

    public function listBlocks(): array
    {
        return ['blocks' => array_map([$this, 'blockShape'], Db::all('SELECT * FROM {p}member_blocks ORDER BY (lifted_at IS NULL) DESC, id DESC LIMIT 200'))];
    }

    public function createBlock(array $actor, array $body): array
    {
        $memberId = preg_replace('/\s+/', '', Js::s($body['memberId'] ?? null));
        if (!preg_match('/^\d{8}$/', $memberId)) throw new ApiError(400, 'invalid_member_id', 'Zadejte 8místné číslo členské legitimace.');
        $reason = trim(Js::s($body['reason'] ?? null));
        if (Js::len($reason) < 3 || Js::len($reason) > 500) throw new ApiError(400, 'invalid_reason', 'Uveďte důvod blokace (3–500 znaků).');
        $until = Js::truthy($body['until'] ?? null) ? Js::str($body['until']) : null;
        if ($until && (!Time::isIsoDate($until) || $until < Time::pragueToday())) throw new ApiError(400, 'invalid_date', 'Datum konce blokace musí být dnes nebo později.');
        return Db::transaction(function () use ($actor, $memberId, $reason, $until) {
            if ($this->activeBlock($memberId)) throw new ApiError(409, 'already_blocked', 'Toto číslo legitimace už je zablokované.');
            $now = Time::nowIso();
            $id = Db::insert("INSERT INTO {p}member_blocks (member_id, reason, until_date, source, cause, created_by, created_at) VALUES (?, ?, ?, 'manual', 'manual', ?, ?)", $memberId, $reason, $until, $actor['id'], $now);
            Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'member_blocked', 'member', ?, ?)", $now, $actor['id'], $memberId, wp_json_encode(['reason' => $reason, 'until' => $until]));
            return ['block' => $this->blockShape(Db::row('SELECT * FROM {p}member_blocks WHERE id = ?', $id))];
        });
    }

    public function liftBlock(array $actor, string $id): array
    {
        return Db::transaction(function () use ($actor, $id) {
            $block = Db::row('SELECT * FROM {p}member_blocks WHERE id = ?', (int) $id);
            if (!$block) throw new ApiError(404, 'not_found', 'Blokace neexistuje.');
            if ($block['lifted_at']) throw new ApiError(409, 'already_lifted', 'Blokace už byla zrušena.');
            $now = Time::nowIso();
            Db::exec('UPDATE {p}member_blocks SET lifted_at = ?, lifted_by = ? WHERE id = ?', $now, $actor['id'], $block['id']);
            Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id) VALUES (?, ?, 'member_unblocked', 'member', ?)", $now, $actor['id'], $block['member_id']);
            return ['block' => $this->blockShape(Db::row('SELECT * FROM {p}member_blocks WHERE id = ?', $block['id']))];
        });
    }

    // Limity přihlášeného člena pro dnešek (týden/měsíc) na zvoleném revíru.
    public function limitsForMember(array $user, string $revirId): array
    {
        if (!$user['member_id']) return ['date' => Time::pragueToday(), 'limits' => [], 'blocked' => null];
        $config = $this->config();
        $revir = Config::getRevir($config, $revirId) ?? $config['reviry'][0];
        $date = Time::pragueToday();
        $limits = array_values(array_filter($this->limitsFor(['id' => 0, 'member_id' => $user['member_id'], 'fishing_date' => $date, 'revir_id' => $revir['id']]), fn($l) => $l['period'] !== 'day'));
        $block = $this->activeBlock($user['member_id']);
        return ['date' => $date, 'revirId' => $revir['id'], 'limits' => $limits, 'blocked' => $block ? $this->blockShape($block) : null];
    }

    // Osobní statistika rybáře z místenek jeho účtu (vystavené, den lovu už nastal).
    // Docházka = místenka; úspěšnost = podíl odevzdaných místenek s alespoň jedním úlovkem.
    public function statsForUser(array $user): array
    {
        $tickets = Db::all("SELECT id, fishing_date, revir_id, subdistrict, returned_at FROM {p}tickets WHERE user_id = ? AND status = 'issued' AND fishing_date <= ? ORDER BY fishing_date, id", $user['id'], Time::pragueToday());
        $round = fn($n) => round($n * 100) / 100;
        $where = function (array $t) { $revir = $this->revirOf($t); return ['date' => $t['fishing_date'], 'revir' => $revir['name'], 'subdistrict' => Config::subdistrictName($revir, $t['subdistrict'])]; };
        $out = ['visits' => count($tickets), 'returned' => 0, 'catches' => 0, 'totalWeight' => 0, 'avgLength' => null, 'successRate' => null, 'biggest' => null, 'heaviest' => null, 'bestTrip' => null, 'species' => [], 'years' => []];
        $species = [];
        $years = [];
        $successful = 0;
        $lengthSum = 0;
        foreach ($tickets as $t) {
            $catches = Db::all('SELECT species, length_cm, weight_kg FROM {p}catches WHERE ticket_id = ? ORDER BY id', $t['id']);
            $year = substr($t['fishing_date'], 0, 4);
            $years[$year] = $years[$year] ?? ['year' => $year, 'visits' => 0, 'catches' => 0];
            $years[$year]['visits']++;
            $years[$year]['catches'] += count($catches);
            if ($t['returned_at']) { $out['returned']++; if ($catches) $successful++; }
            $weight = 0;
            $tripLength = 0;
            foreach ($catches as $c) {
                $length = Js::number($c['length_cm']);
                $w = $c['weight_kg'] === null ? null : Js::number($c['weight_kg']);
                $out['catches']++;
                $weight += $w ?? 0;
                $tripLength += $length;
                $item = array_merge(['species' => $c['species'], 'length' => $length, 'weight' => $w], $where($t));
                $big = $out['biggest'];
                if (!$big || $length > $big['length'] || ($length == $big['length'] && ($w ?? 0) > ($big['weight'] ?? 0))) $out['biggest'] = $item;
                if ($w && (!$out['heaviest'] || $w > $out['heaviest']['weight'])) $out['heaviest'] = $item;
                $s = $species[$c['species']] ?? ['species' => $c['species'], 'count' => 0, 'maxLength' => 0];
                $s['count']++;
                $s['maxLength'] = max($s['maxLength'], $length);
                $species[$c['species']] = $s;
            }
            $out['totalWeight'] += $weight;
            $lengthSum += $tripLength;
            $best = $out['bestTrip'];
            if ($catches && (!$best || count($catches) > $best['catches'] || (count($catches) === $best['catches'] && $weight > $best['weight']))) {
                $out['bestTrip'] = array_merge($where($t), ['catches' => count($catches), 'weight' => $round($weight), 'avgLength' => round($tripLength / count($catches), 1)]);
            }
        }
        $out['totalWeight'] = $round($out['totalWeight']);
        $out['avgLength'] = $out['catches'] ? round($lengthSum / $out['catches'], 1) : null;
        $out['successRate'] = $out['returned'] ? (int) round($successful / $out['returned'] * 100) : null;
        $species = array_values($species);
        usort($species, fn($a, $b) => ($b['count'] <=> $a['count']) ?: ($b['maxLength'] <=> $a['maxLength']));
        $out['species'] = array_slice($species, 0, 5);
        krsort($years, SORT_STRING);
        $out['years'] = array_values($years);
        return $out;
    }

    // „Jak se posledně dařilo ostatním?“ – souhrn bez osobních údajů za všechny revíry MO:
    // poslední den lovu před dneškem s odevzdanými místenkami + celkové rekordy (největší ryba, nejúspěšnější lov).
    public function communityStats(): array
    {
        $config = $this->config();
        if (($config['statsPolicy']['community'] ?? true) === false) return ['enabled' => false];
        $round = fn($n) => round($n * 100) / 100;
        $where = function (array $t) { $revir = $this->revirOf($t); return ['date' => $t['fishing_date'], 'revir' => $revir['name'], 'subdistrict' => Config::subdistrictName($revir, $t['subdistrict'])]; };
        $date = Db::val("SELECT MAX(fishing_date) AS d FROM {p}tickets WHERE status = 'issued' AND returned_at IS NOT NULL AND fishing_date < ?", Time::pragueToday());
        $lastDay = null;
        if ($date) {
            $tickets = Db::all("SELECT id FROM {p}tickets WHERE status = 'issued' AND returned_at IS NOT NULL AND fishing_date = ? ORDER BY id", $date);
            $catches = 0; $weight = 0; $lengthSum = 0; $maxLength = 0; $maxPerTicket = 0; $successful = 0;
            foreach ($tickets as $t) {
                $rows = Db::all('SELECT length_cm, weight_kg FROM {p}catches WHERE ticket_id = ?', $t['id']);
                if ($rows) $successful++;
                $maxPerTicket = max($maxPerTicket, count($rows));
                foreach ($rows as $c) {
                    $length = Js::number($c['length_cm']);
                    $catches++; $weight += $c['weight_kg'] === null ? 0 : Js::number($c['weight_kg']); $lengthSum += $length; $maxLength = max($maxLength, $length);
                }
            }
            $record = Db::row("SELECT COUNT(c.id) AS n FROM {p}tickets t JOIN {p}catches c ON c.ticket_id = t.id WHERE t.status = 'issued' GROUP BY t.fishing_date ORDER BY n DESC LIMIT 1");
            $n = count($tickets);
            // Rybářský tlak: vystavené místenky toho dne vůči místům na revírech otevřených ten den (podrevíry v prodeji, jinak revír).
            $issued = (int) Db::val("SELECT COUNT(*) AS n FROM {p}tickets WHERE status = 'issued' AND fishing_date = ?", $date);
            $capacityOf = fn($r) => !empty($r['saleSubdistricts']) ? array_sum(array_column($r['saleSubdistricts'], 'dailyCapacity')) : $r['dailyCapacity'];
            $open = array_values(array_filter($config['reviry'], fn($r) => $this->app->operations->dayStatus($r['id'], $date)['open']));
            $capacity = array_sum(array_map($capacityOf, $open ?: $config['reviry']));
            $lastDay = [
                'date' => $date, 'anglers' => $n, 'issued' => $issued, 'capacity' => $capacity, 'pressure' => $capacity ? (int) round($issued / $capacity * 100) : null,
                'catches' => $catches, 'totalWeight' => $round($weight),
                'avgPerAngler' => $n ? round($catches / $n, 1) : 0, 'avgLength' => $catches ? round($lengthSum / $catches, 1) : null,
                'successRate' => $n ? (int) round($successful / $n * 100) : null,
                'maxLength' => $maxLength, 'maxPerTicket' => $maxPerTicket, 'recordDayCatches' => $record ? (int) $record['n'] : 0,
            ];
        }
        $big = Db::row("SELECT c.species, c.length_cm, c.weight_kg, t.fishing_date, t.revir_id, t.subdistrict FROM {p}catches c JOIN {p}tickets t ON t.id = c.ticket_id WHERE t.status = 'issued' ORDER BY c.length_cm DESC, COALESCE(c.weight_kg, 0) DESC, t.fishing_date, c.id LIMIT 1");
        $trip = Db::row("SELECT t.id, t.fishing_date, t.revir_id, t.subdistrict, COUNT(c.id) AS n, SUM(COALESCE(c.weight_kg, 0)) AS w, SUM(c.length_cm) AS l
            FROM {p}tickets t JOIN {p}catches c ON c.ticket_id = t.id WHERE t.status = 'issued' GROUP BY t.id, t.fishing_date, t.revir_id, t.subdistrict ORDER BY n DESC, w DESC, t.fishing_date, t.id LIMIT 1");
        return [
            'enabled' => true,
            'lastDay' => $lastDay,
            'biggest' => $big ? array_merge(['species' => $big['species'], 'length' => Js::number($big['length_cm']), 'weight' => $big['weight_kg'] === null ? null : Js::number($big['weight_kg'])], $where($big)) : null,
            'bestTrip' => $trip ? array_merge($where($trip), ['catches' => (int) $trip['n'], 'weight' => $round(Js::number($trip['w'])), 'avgLength' => round(Js::number($trip['l']) / (int) $trip['n'], 1)]) : null,
        ];
    }

    // ---------- porybný (B2) ----------
    private function wardenView(array $ticket): array
    {
        $base = $this->publicTicket($ticket);
        unset($base['holder']);
        $weekFrom = Time::weekStart($ticket['fishing_date']);
        $week = ['from' => $weekFrom, 'to' => Time::addDays($weekFrom, 6)];
        $month = ['from' => substr($ticket['fishing_date'], 0, 8) . '01', 'to' => Time::monthEnd($ticket['fishing_date'])];
        $from = $week['from'] < $month['from'] ? $week['from'] : $month['from'];
        $to = $week['to'] > $month['to'] ? $week['to'] : $month['to'];
        $history = array_map(fn($t) => [
            'code' => $t['code'], 'date' => $t['fishing_date'], 'revir' => $this->revirOf($t)['name'], 'status' => $this->stateOf($t), 'current' => $t['id'] === $ticket['id'],
            'inWeek' => $t['fishing_date'] >= $week['from'] && $t['fishing_date'] <= $week['to'], 'inMonth' => $t['fishing_date'] >= $month['from'] && $t['fishing_date'] <= $month['to'],
            'noCatch' => (bool) $t['no_catch'], 'catches' => $this->catchesOf($t),
        ], Db::all("SELECT * FROM {p}tickets WHERE member_id = ? AND status = 'issued' AND fishing_date BETWEEN ? AND ? ORDER BY fishing_date, id", $ticket['member_id'], $from, $to));
        $checks = array_map(fn($c) => ['wardenName' => $c['warden_name'], 'at' => $c['at'], 'status' => $c['status']], Db::all('SELECT warden_name, at, status FROM {p}ticket_checks WHERE ticket_id = ? ORDER BY at DESC LIMIT 20', $ticket['id']));
        $seizure = null;
        if ($ticket['seized_at']) {
            $by = $ticket['seized_by'] ? Db::row('SELECT first_name, last_name FROM {p}users WHERE id = ?', $ticket['seized_by']) : null;
            $seizure = ['at' => $ticket['seized_at'], 'reason' => $ticket['seized_reason'], 'place' => $ticket['seized_place'] ?? '', 'wardenName' => $by ? "{$by['first_name']} {$by['last_name']}" : ''];
        }
        $block = $this->activeBlock($ticket['member_id']);
        return array_merge($base, [
            'firstName' => $ticket['first_name'], 'lastName' => $ticket['last_name'], 'birthDate' => $ticket['birth_date'], 'memberId' => $ticket['member_id'],
            'returnedAt' => $ticket['returned_at'], 'noCatch' => (bool) $ticket['no_catch'], 'catches' => $this->catchesOf($ticket),
            'seizable' => $this->stateOf($ticket) === 'active', 'memberRoles' => $this->memberRolesOf($ticket), 'seizure' => $seizure, 'checks' => $checks,
            'memberHistory' => ['week' => $week, 'month' => $month, 'tickets' => $history],
            'limits' => $this->limitsFor($ticket), 'blocked' => $block ? $this->blockShape($block) : null,
        ]);
    }

    // Funkce držitele místenky (role jeho účtu – podle účtu místenky, jinak podle čísla legitimace). Bez účtu jen rybář.
    private function memberRolesOf(array $ticket): array
    {
        $account = $ticket['user_id'] ? Db::row('SELECT roles FROM {p}users WHERE id = ?', $ticket['user_id']) : null;
        if (!$account && $ticket['member_id'] !== '') $account = Db::row('SELECT roles FROM {p}users WHERE member_id = ?', $ticket['member_id']);
        return $account ? array_values(array_filter(explode(',', (string) $account['roles']))) : ['member'];
    }

    private static function wardenName(array $user): string
    {
        return "{$user['first_name']} {$user['last_name']}";
    }

    // Každé otevření místenky porybným je kontrola; opakované otevření do 10 minut se nezapisuje znovu.
    public function wardenCheck($code, array $warden): array
    {
        $ticket = $this->findTicket($code);
        if ($ticket['status'] !== 'issued') throw new ApiError(409, 'not_issued', 'Místenka nebyla vystavena (nezaplacená nebo zrušená) a neopravňuje k lovu.');
        $now = Time::ms(Time::now());
        $recent = Db::row('SELECT 1 AS x FROM {p}ticket_checks WHERE ticket_id = ? AND user_id = ? AND at > ?', $ticket['id'], $warden['id'], Time::iso(Time::fromMs($now - 600000)));
        if (!$recent) Db::exec('INSERT INTO {p}ticket_checks (ticket_id, user_id, warden_name, at, status) VALUES (?, ?, ?, ?, ?)', $ticket['id'], $warden['id'], self::wardenName($warden), Time::iso(Time::fromMs($now)), $this->stateOf($ticket, $now));
        return $this->wardenView($ticket);
    }

    public function seizeTicket($code, array $warden, array $body): array
    {
        $reason = trim(Js::s($body['reason'] ?? null));
        $place = trim(Js::s($body['place'] ?? null));
        if (Js::len($reason) < 3 || Js::len($reason) > 500) throw new ApiError(400, 'invalid_reason', 'Uveďte důvod zadržení (3–500 znaků).');
        if (Js::len($place) > 200) throw new ApiError(400, 'invalid_place', 'Místo může mít nejvýše 200 znaků.');
        $ticket = $this->findTicket($code);
        return Db::transaction(function () use ($ticket, $warden, $reason, $place) {
            $fresh = $this->ticketById($ticket['id']);
            $state = $this->stateOf($fresh);
            if ($fresh['seized_at']) throw new ApiError(409, 'already_seized', 'Místenka už byla zadržena.');
            if ($state !== 'active') throw new ApiError(409, 'not_seizable', 'Zadržet lze jen místenku platnou v den lovu.');
            $now = Time::nowIso();
            Db::exec('UPDATE {p}tickets SET seized_at = ?, seized_by = ?, seized_reason = ?, seized_place = ? WHERE id = ?', $now, $warden['id'], $reason, $place !== '' ? $place : null, $fresh['id']);
            Db::exec("INSERT INTO {p}ticket_checks (ticket_id, user_id, warden_name, at, status) VALUES (?, ?, ?, ?, 'seized')", $fresh['id'], $warden['id'], self::wardenName($warden), $now);
            Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'ticket_seized', 'ticket', ?, ?)", $now, $warden['id'], $fresh['code'], wp_json_encode(['reason' => $reason, 'place' => $place]));
            $seized = $this->ticketById($fresh['id']);
            // Držitel: e-mail s odkazem na odevzdání. Správce: jen upozornění (nepotvrzuje).
            $this->enqueueEmail($seized, 'ticket_seized', $this->issueToken($seized['id'], 'email'), ['deadline' => Time::iso(Time::fromMs($this->windowOf($seized)['deadline']))]);
            $this->applyPenalty($seized, 'seizure');
            foreach (Mailer::noticeRecipients() as $to) $this->enqueueEmail($seized, 'seizure_notice', null, ['to' => $to, 'wardenName' => self::wardenName($warden)]);
            return $this->wardenView($seized);
        });
    }

    public function checkVoucher($code): array
    {
        $normalized = self::normalizeCode($code);
        if (!preg_match(self::VOUCHER_RE, $normalized)) throw new ApiError(400, 'invalid_voucher', 'Kód poukazu musí mít 16 znaků A–Z nebo 0–9.');
        $voucher = Db::row('SELECT * FROM {p}vouchers WHERE code = ?', $normalized);
        return ['code' => $normalized, 'valid' => (bool) ($voucher && !$voucher['used_at'] && !$voucher['voided_at']), 'usedAt' => $voucher['used_at'] ?? null, 'revirId' => $voucher['revir_id'] ?? null];
    }

    // Vývojový endpoint /dev/vouchers.
    public function createVoucher(array $input): array
    {
        $normalized = self::normalizeCode($input['code'] ?? null) ?: self::randomCode(16);
        if (!preg_match(self::VOUCHER_RE, $normalized)) throw new ApiError(400, 'invalid_voucher', 'Kód poukazu musí mít 16 znaků A–Z nebo 0–9.');
        $revirId = Js::truthy($input['revirId'] ?? null) ? Js::str($input['revirId']) : null;
        if ($revirId && !Config::getRevir($this->config(), $revirId)) throw new ApiError(400, 'unknown_revir', 'Revír neexistuje.');
        if (Db::row('SELECT 1 AS x FROM {p}vouchers WHERE code = ?', $normalized)) throw new ApiError(409, 'voucher_exists', 'Poukaz už existuje.');
        Db::exec('INSERT INTO {p}vouchers (code, revir_id) VALUES (?, ?)', $normalized, $revirId);
        return $this->checkVoucher($normalized);
    }

    // ---------- správa místenek, plateb a poukazů (B4) ----------
    private function manageRow(array $t): array
    {
        $status = $this->stateOf($t);
        return [
            'code' => $t['code'], 'date' => $t['fishing_date'], 'revirId' => $t['revir_id'], 'revir' => $this->revirOf($t)['name'], 'subdistrict' => !empty($t['subdistrict']) ? Config::subdistrictName($this->revirOf($t), $t['subdistrict']) : null, 'firstName' => $t['first_name'], 'lastName' => $t['last_name'], 'memberId' => $t['member_id'], 'email' => $t['email'],
            'status' => $status, 'late' => $this->publicTicket($t)['late'], 'seized' => (bool) $t['seized_at'], 'priceHalere' => $t['price_halere'], 'amountDueHalere' => $t['amount_due_halere'], 'voucherUsed' => (bool) $t['voucher_code'],
            'catchCount' => (int) Db::val('SELECT COUNT(*) AS n FROM {p}catches WHERE ticket_id = ?', $t['id']), 'noCatch' => (bool) $t['no_catch'], 'createdAt' => $t['created_at'], 'paidAt' => $t['paid_at'], 'returnedAt' => $t['returned_at'], 'account' => (bool) $t['user_id'],
        ];
    }

    private function searchTickets(array $filters): array
    {
        $where = [];
        $params = [];
        if ($filters['revirId'] !== '') { $where[] = 'revir_id = ?'; $params[] = $filters['revirId']; }
        if ($filters['from'] !== '') { if (!Time::isIsoDate($filters['from'])) throw new ApiError(400, 'invalid_date', 'Neplatné datum od.'); $where[] = 'fishing_date >= ?'; $params[] = $filters['from']; }
        if ($filters['to'] !== '') { if (!Time::isIsoDate($filters['to'])) throw new ApiError(400, 'invalid_date', 'Neplatné datum do.'); $where[] = 'fishing_date <= ?'; $params[] = $filters['to']; }
        $q = Js::lower(trim($filters['q']));
        if ($q !== '') {
            $where[] = "(LOWER(code) = ? OR member_id LIKE ? OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE ? OR LOWER(email) LIKE ? OR variable_symbol = ?)";
            array_push($params, $q, '%' . preg_replace('/\s+/', '', $q) . '%', "%{$q}%", "%{$q}%", $q);
        }
        if ($filters['status'] !== '' && !in_array($filters['status'], self::TICKET_FILTER_STATES, true)) throw new ApiError(400, 'invalid_status', 'Neznámý stav.');
        $rows = Db::all('SELECT * FROM {p}tickets ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY fishing_date DESC, id DESC LIMIT 5000', ...$params);
        if ($filters['status'] !== '') $rows = array_values(array_filter($rows, fn($t) => $this->stateOf($t) === $filters['status']));
        return $rows;
    }

    public function listTickets(array $filters): array
    {
        $rows = $this->searchTickets($filters);
        $limitN = Js::number($filters['limit']);
        $limit = (int) min(max(is_nan($limitN) || !$limitN ? 100 : $limitN, 1), 500);
        $offsetN = Js::number($filters['offset']);
        $offset = (int) max(is_nan($offsetN) ? 0 : $offsetN, 0);
        return ['total' => count($rows), 'tickets' => array_map([$this, 'manageRow'], array_slice($rows, $offset, $limit))];
    }

    public function ticketsCsv(array $filters): string
    {
        $cell = function ($value) {
            $text = Js::str($value);
            return preg_match('/[;"\n\r]/', $text) ? '"' . str_replace('"', '""', $text) . '"' : $text;
        };
        $money = fn($halere) => str_replace('.', ',', number_format($halere / 100, 2, '.', ''));
        $header = ['Kód', 'Revír', 'Podrevír', 'Datum lovu', 'Jméno', 'Příjmení', 'Č. legitimace', 'E-mail', 'Stav', 'Opožděně', 'Zadržena', 'Cena Kč', 'Zaplaceno Kč', 'Poukaz', 'Úlovky', 'Bez úlovku', 'Vytvořeno', 'Zaplaceno', 'Odevzdáno'];
        $lines = [];
        foreach ($this->searchTickets($filters) as $t) {
            $r = $this->manageRow($t);
            $catches = implode(', ', array_map(fn($c) => "{$c['species']} " . Js::str($c['length_cm']) . ' cm' . ($c['weight_kg'] ? ' ' . Js::str($c['weight_kg']) . ' kg' : ''), Db::all('SELECT species, length_cm, weight_kg FROM {p}catches WHERE ticket_id = ? ORDER BY id', $t['id'])));
            $lines[] = implode(';', array_map($cell, [$r['code'], $r['revir'], $r['subdistrict'] ?? '', $r['date'], $r['firstName'], $r['lastName'], $r['memberId'], $r['email'], $r['status'], $r['late'] ? 'ano' : '', $r['seized'] ? 'ano' : '',
                $money($r['priceHalere']), $money($t['paid_at'] ? $r['amountDueHalere'] : 0), $r['voucherUsed'] ? 'ano' : '', $catches, $r['noCatch'] ? 'ano' : '', $r['createdAt'], $r['paidAt'] ?? '', $r['returnedAt'] ?? '']));
        }
        return "\u{FEFF}" . implode("\r\n", array_merge([implode(';', $header)], $lines)) . "\r\n"; // BOM + středník: Excel v češtině
    }

    public function ticketDetail($code): array
    {
        $ticket = $this->findTicket($code);
        $payments = array_map([$this, 'paymentShape'], Db::all('SELECT * FROM {p}bank_transactions WHERE ticket_id = ? ORDER BY id', $ticket['id']));
        $checks = array_map(fn($c) => ['wardenName' => $c['warden_name'], 'at' => $c['at'], 'status' => $c['status']], Db::all('SELECT warden_name, at, status FROM {p}ticket_checks WHERE ticket_id = ? ORDER BY at DESC', $ticket['id']));
        $violations = array_map(fn($v) => ['label' => $v['label'], 'period' => $v['period'], 'from' => $v['period_from'], 'to' => $v['period_to'], 'count' => $v['count'], 'maxCount' => $v['max_count']],
            Db::all('SELECT label, period, period_from, period_to, count, max_count FROM {p}limit_violations WHERE ticket_id = ? ORDER BY id', $ticket['id']));
        $emails = array_map(fn($e) => ['kind' => $e['kind'], 'to' => $e['to_email'], 'subject' => $e['subject'], 'createdAt' => $e['created_at'], 'sentAt' => $e['sent_at'], 'error' => $e['error'], 'sender' => $e['sender'] ?: null],
            Db::all('SELECT kind, to_email, subject, created_at, sent_at, error, sender FROM {p}email_outbox WHERE ticket_id = ? ORDER BY id', $ticket['id']));
        $cancellation = $ticket['cancelled_at'] ? ['at' => $ticket['cancelled_at'], 'reason' => $ticket['cancel_reason'] ?: 'zrušeno držitelem před zaplacením', 'byManager' => (bool) $ticket['cancelled_by']] : null;
        return [
            'ticket' => array_merge($this->ownerTicket($ticket), ['variableSymbol' => $ticket['variable_symbol'], 'account' => (bool) $ticket['user_id'], 'rulesVersion' => $ticket['rules_version'] ?: null]),
            'payments' => $payments, 'checks' => $checks, 'violations' => $violations, 'emails' => $emails, 'cancellation' => $cancellation,
            'cancellable' => in_array($this->stateOf($ticket), ['pending_payment', 'payment_expired', 'future', 'active', 'expired_unreturned', 'seized'], true),
        ];
    }

    // Zrušení správcem: vystavená neodevzdaná místenka nebo objednávka. Peníze se nevracejí automaticky.
    public function cancelByManager(array $actor, $code, array $body): array
    {
        $reason = trim(Js::s($body['reason'] ?? null));
        if (Js::len($reason) < 3 || Js::len($reason) > 300) throw new ApiError(400, 'invalid_reason', 'Uveďte důvod zrušení (3–300 znaků).');
        $ticket = $this->findTicket($code);
        return Db::transaction(function () use ($actor, $ticket, $reason) {
            $fresh = $this->ticketById($ticket['id']);
            $state = $this->stateOf($fresh);
            if (!in_array($state, ['pending_payment', 'payment_expired', 'future', 'active', 'expired_unreturned', 'seized'], true)) throw new ApiError(409, 'not_cancellable', 'Zrušit nelze odevzdanou, uzavřenou ani už zrušenou místenku.');
            Db::exec("UPDATE {p}tickets SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, cancelled_by = ?, reserved_until = NULL WHERE id = ?", Time::nowIso(), $reason, $actor['id'], $fresh['id']);
            $cancelled = $this->ticketById($fresh['id']);
            if ($fresh['status'] === 'issued') $this->enqueueEmail($cancelled, 'ticket_cancelled', null);
            $this->audit($actor, 'ticket_cancelled', 'ticket', $fresh['code'], ['reason' => $reason, 'previous' => $state, 'paid' => (bool) $fresh['paid_at']]);
            return $this->ticketDetail($fresh['code']);
        });
    }

    private function paymentShape(array $p): array
    {
        $ticket = $p['ticket_id'] ? Db::row('SELECT code, first_name, last_name, status FROM {p}tickets WHERE id = ?', $p['ticket_id']) : null;
        return [
            'id' => $p['id'], 'provider' => $p['provider'], 'transactionId' => $p['transaction_id'], 'bookedAt' => $p['booked_at'], 'amountHalere' => $p['amount_halere'], 'currency' => $p['currency'], 'variableSymbol' => $p['variable_symbol'],
            'counterAccount' => $p['counter_account'], 'counterName' => $p['counter_name'], 'message' => $p['message'], 'result' => $p['result'], 'note' => $p['note'], 'createdAt' => $p['created_at'],
            'ticket' => $ticket ? ['code' => $ticket['code'], 'holder' => "{$ticket['first_name']} {$ticket['last_name']}"] : null,
            'needsAction' => in_array($p['result'], self::OPEN_RESULTS, true) && !$p['resolved_at'],
            'resolution' => $p['resolved_at'] ? ['action' => $p['resolution'], 'note' => $p['resolution_note'], 'at' => $p['resolved_at']] : null,
        ];
    }

    public function listPayments(string $state): array
    {
        if ($state === 'all') {
            $rows = Db::all('SELECT * FROM {p}bank_transactions ORDER BY id DESC LIMIT 500');
        } else {
            $placeholders = implode(',', array_fill(0, count(self::OPEN_RESULTS), '?'));
            $rows = Db::all("SELECT * FROM {p}bank_transactions WHERE resolved_at IS NULL AND result IN ({$placeholders}) ORDER BY id", ...self::OPEN_RESULTS);
        }
        return ['payments' => array_map([$this, 'paymentShape'], $rows)];
    }

    // Ruční vyřešení: assign = vystavit místenku k objednávce, refunded = peníze vráceny, ignored = bez akce.
    public function resolvePayment(array $actor, string $id, array $body): array
    {
        $action = Js::s($body['action'] ?? null);
        if (!in_array($action, ['assign', 'refunded', 'ignored'], true)) throw new ApiError(400, 'invalid_action', 'Akce musí být assign, refunded nebo ignored.');
        $note = Js::slice(trim(Js::s($body['note'] ?? null)), 0, 300);
        return Db::transaction(function () use ($actor, $id, $body, $action, $note) {
            $payment = Db::row('SELECT * FROM {p}bank_transactions WHERE id = ?', (int) $id);
            if (!$payment) throw new ApiError(404, 'not_found', 'Platba neexistuje.');
            if ($payment['resolved_at'] || !in_array($payment['result'], self::OPEN_RESULTS, true)) throw new ApiError(409, 'already_resolved', 'Platba už je vyřešená.');
            $ticketId = $payment['ticket_id'];
            if ($action === 'assign') {
                $ticket = Js::truthy($body['ticketCode'] ?? null) ? $this->findTicket($body['ticketCode']) : ($ticketId ? $this->ticketById($ticketId) : null);
                if (!$ticket) throw new ApiError(400, 'ticket_required', 'Zadejte kód místenky, ke které platba patří.');
                if ($ticket['status'] === 'issued' || $ticket['paid_at']) throw new ApiError(409, 'already_paid', 'Místenka už je zaplacená – platbu vraťte.');
                if (!in_array($ticket['status'], ['pending_payment', 'payment_expired', 'cancelled'], true)) throw new ApiError(409, 'not_assignable', 'K této místence nelze platbu přiřadit.');
                $this->issuePaid($ticket);
                $ticketId = $ticket['id'];
            }
            Db::exec('UPDATE {p}bank_transactions SET resolution = ?, resolution_note = ?, resolved_at = ?, resolved_by = ?, ticket_id = ? WHERE id = ?', $action === 'assign' ? 'assigned' : $action, $note !== '' ? $note : null, Time::nowIso(), $actor['id'], $ticketId, $payment['id']);
            $this->audit($actor, 'payment_resolved', 'payment', $payment['id'], ['action' => $action, 'note' => $note, 'ticketId' => $ticketId]);
            return ['payment' => $this->paymentShape(Db::row('SELECT * FROM {p}bank_transactions WHERE id = ?', $payment['id']))];
        });
    }

    private function voucherShape(array $v): array
    {
        return [
            'code' => $v['code'], 'revirId' => $v['revir_id'], 'revir' => $v['revir_id'] ? (Config::getRevir($this->config(), $v['revir_id'])['name'] ?? $v['revir_id']) : 'Všechny revíry',
            'note' => $v['note'] ?? '', 'createdAt' => $v['created_at'], 'usedAt' => $v['used_at'], 'ticketCode' => $v['ticket_code'], 'voidedAt' => $v['voided_at'],
            'state' => $v['voided_at'] ? 'voided' : ($v['used_at'] ? 'used' : 'valid'),
        ];
    }

    public function listVouchers(): array
    {
        return ['vouchers' => array_map([$this, 'voucherShape'], Db::all("SELECT * FROM {p}vouchers ORDER BY (used_at IS NULL AND voided_at IS NULL) DESC, COALESCE(created_at, '') DESC, code LIMIT 1000"))];
    }

    public function generateVouchers(array $actor, array $body): array
    {
        $raw = array_key_exists('count', $body) && $body['count'] !== null ? $body['count'] : 1;
        $count = Js::number($raw);
        if (!Js::isIntegerish($raw) || $count < 1 || $count > 50) throw new ApiError(400, 'invalid_count', 'Počet poukazů 1–50.');
        $revirId = Js::truthy($body['revirId'] ?? null) ? Js::str($body['revirId']) : null;
        if ($revirId && !Config::getRevir($this->config(), $revirId)) throw new ApiError(400, 'unknown_revir', 'Revír neexistuje.');
        $note = Js::slice(trim(Js::s($body['note'] ?? null)), 0, 200);
        return Db::transaction(function () use ($actor, $count, $revirId, $note) {
            $now = Time::nowIso();
            $codes = [];
            while (count($codes) < $count) {
                $code = self::randomCode(16);
                if (Db::row('SELECT 1 AS x FROM {p}vouchers WHERE code = ?', $code)) continue;
                Db::exec('INSERT INTO {p}vouchers (code, revir_id, created_at, created_by, note) VALUES (?, ?, ?, ?, ?)', $code, $revirId, $now, $actor['id'], $note !== '' ? $note : null);
                $codes[] = $code;
            }
            $this->audit($actor, 'vouchers_created', 'voucher', count($codes), ['revirId' => $revirId, 'note' => $note, 'codes' => $codes]);
            return ['vouchers' => array_map(fn($c) => $this->voucherShape(Db::row('SELECT * FROM {p}vouchers WHERE code = ?', $c)), $codes)];
        });
    }

    public function voidVoucher(array $actor, $code): array
    {
        $normalized = self::normalizeCode($code);
        $voucher = Db::row('SELECT * FROM {p}vouchers WHERE code = ?', $normalized);
        if (!$voucher) throw new ApiError(404, 'not_found', 'Poukaz neexistuje.');
        if ($voucher['used_at'] || $voucher['voided_at']) throw new ApiError(409, 'not_voidable', 'Použitý nebo už zneplatněný poukaz nelze zneplatnit.');
        Db::exec('UPDATE {p}vouchers SET voided_at = ? WHERE code = ?', Time::nowIso(), $normalized);
        $this->audit($actor, 'voucher_voided', 'voucher', $normalized);
        return ['voucher' => $this->voucherShape(Db::row('SELECT * FROM {p}vouchers WHERE code = ?', $normalized))];
    }

    // ---------- platby ----------
    private function issuePaid(array $ticket): void
    {
        $now = Time::nowIso();
        Db::exec("UPDATE {p}tickets SET status = 'issued', paid_at = ?, issued_at = ?, reserved_until = NULL WHERE id = ?", $now, $now, $ticket['id']);
        $issued = $this->ticketById($ticket['id']);
        $this->enqueueEmail($issued, 'ticket_issued', $this->issueToken($issued['id'], 'email'));
    }

    public function processTransaction(array $tx): string
    {
        $providerName = $this->provider()->name();
        return Db::transaction(function () use ($tx, $providerName) {
            if (Db::row('SELECT 1 AS x FROM {p}bank_transactions WHERE provider = ? AND transaction_id = ?', $providerName, $tx['transactionId'])) return 'already_processed';
            $note = null;
            $ticketId = null;
            if (!($tx['amountHalere'] > 0)) {
                $result = 'ignored';
            } else {
                $vs = ltrim(Js::s($tx['variableSymbol'] ?? null), '0');
                $ticket = $vs !== '' ? Db::row('SELECT * FROM {p}tickets WHERE variable_symbol = ?', $vs) : null;
                if (!$ticket) {
                    $result = 'unmatched';
                } else {
                    $ticketId = $ticket['id'];
                    if ($tx['currency'] !== 'CZK' || $tx['amountHalere'] !== $ticket['amount_due_halere']) {
                        $result = 'amount_mismatch';
                        $note = "očekáváno {$ticket['amount_due_halere']} haléřů CZK";
                    } elseif ($ticket['status'] === 'issued' || $ticket['paid_at']) {
                        $result = 'duplicate_payment';
                    } elseif ($ticket['status'] === 'cancelled') {
                        $result = 'late';
                        $note = 'objednávka byla zrušena';
                    } else {
                        $pending = $this->stateOf($ticket) === 'pending_payment';
                        $dayNotOver = Time::pragueToday() <= $ticket['fishing_date'];
                        $revir = $this->revirOf($ticket);
                        $sub = !empty($ticket['subdistrict']) ? Js::str($ticket['subdistrict']) : null;
                        $seatFree = $dayNotOver && $this->takenSeats($ticket['revir_id'], $ticket['fishing_date'], (int) $ticket['id'], $sub) < self::capacityOf($revir, $sub);
                        if ($pending || $seatFree) {
                            $this->issuePaid($ticket);
                            $result = 'matched';
                        } else {
                            $result = 'late';
                            $note = $dayNotOver ? 'rezervace vypršela a místo už není volné' : 'den lovu už uplynul';
                        }
                    }
                }
            }
            Db::exec('INSERT INTO {p}bank_transactions (provider, transaction_id, booked_at, amount_halere, currency, variable_symbol, counter_account, counter_name, message, ticket_id, result, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                $providerName, $tx['transactionId'], $tx['bookedAt'], $tx['amountHalere'], $tx['currency'], ($tx['variableSymbol'] ?? '') !== '' ? $tx['variableSymbol'] : null,
                ($tx['counterAccount'] ?? '') ?: null, ($tx['counterName'] ?? '') ?: null, ($tx['message'] ?? '') ?: null, $ticketId, $result, $note, Time::nowIso());
            return $result;
        });
    }

    // Respektuje minimální odstup dotazů na banku (Fio 30 s) – i mezi souběžnými procesy.
    public function syncPayments(bool $force = false): array
    {
        $provider = $this->provider();
        $nowMs = (int) (microtime(true) * 1000);
        $last = (int) get_option('mistenka_last_payment_sync', 0);
        if (!$force && $nowMs - $last < $provider->minIntervalMs()) return ['skipped' => true, 'results' => []];
        update_option('mistenka_last_payment_sync', $nowMs, false);
        $results = [];
        foreach ($provider->fetchTransactions() as $tx) $results[] = $this->processTransaction($tx);
        return ['skipped' => false, 'results' => $results];
    }

    public function expireReservations(): int
    {
        return Db::exec("UPDATE {p}tickets SET status = 'payment_expired' WHERE status = 'pending_payment' AND reserved_until <= ?", Time::nowIso());
    }

    public function sendReminders(): int
    {
        $now = Time::ms(Time::now());
        $candidates = Db::all("SELECT * FROM {p}tickets WHERE status = 'issued' AND returned_at IS NULL AND reminder_sent_at IS NULL AND fishing_date <= ?", Time::pragueToday(Time::fromMs($now)));
        $sent = 0;
        foreach ($candidates as $ticket) {
            $state = $this->stateOf($ticket, $now);
            $w = $this->windowOf($ticket);
            if (!($state === 'expired_unreturned' || ($state === 'seized' && $now >= $w['end'])) || !$this->isReturnable($ticket, $now)) continue;
            Db::transaction(function () use ($ticket, $w, $now) {
                $this->enqueueEmail($ticket, 'return_reminder', $this->issueToken($ticket['id'], 'email'), ['deadline' => Time::iso(Time::fromMs($w['deadline']))]);
                Db::exec('UPDATE {p}tickets SET reminder_sent_at = ? WHERE id = ?', Time::iso(Time::fromMs($now)), $ticket['id']);
            });
            $sent++;
        }
        return $sent;
    }

    // Po uplynutí lhůty pro opožděné odevzdání se místenka uzavře jako neodevzdaná (bez úlovku), držitel dostane e-mail.
    public function closeOverdue(): int
    {
        $now = Time::ms(Time::now());
        $candidates = Db::all("SELECT * FROM {p}tickets WHERE status = 'issued' AND returned_at IS NULL AND closed_at IS NULL AND fishing_date <= ?", Time::pragueToday(Time::fromMs($now)));
        $closed = 0;
        foreach ($candidates as $ticket) {
            if ($now < $this->windowOf($ticket)['deadline']) continue;
            Db::transaction(function () use ($ticket, $now) {
                Db::exec('UPDATE {p}tickets SET closed_at = ? WHERE id = ? AND closed_at IS NULL AND returned_at IS NULL', Time::iso(Time::fromMs($now)), $ticket['id']);
                $closedTicket = $this->ticketById($ticket['id']);
                $this->enqueueEmail($closedTicket, 'ticket_closed', null);
                if (!empty($this->config()['penaltyPolicy']['lateReturn']['includeUnreturned'])) $this->applyPenalty($closedTicket, 'late_return');
            });
            $closed++;
        }
        return $closed;
    }

    // Jen falešná banka: simulace příchozí platby.
    public function simulatePayment(array $input): array
    {
        $provider = $this->provider();
        if (!$provider instanceof FakeProvider) throw new ApiError(404, 'not_found', 'Simulace plateb je dostupná jen s falešnou bankou.');
        $variableSymbol = Js::s($input['variableSymbol'] ?? null);
        $amountHalere = $input['amountHalere'] ?? null;
        if (Js::truthy($input['code'] ?? null)) {
            $ticket = $this->findTicket($input['code']);
            if ($variableSymbol === '') $variableSymbol = (string) ($ticket['variable_symbol'] ?? '');
            $amountHalere ??= $ticket['amount_due_halere'];
        }
        if ($variableSymbol === '' || !(Js::number($amountHalere) > 0)) throw new ApiError(400, 'invalid_payment', 'Zadejte kód místenky nebo variabilní symbol a částku.');
        $provider->push(['variableSymbol' => $variableSymbol, 'amountHalere' => (int) Js::number($amountHalere), 'currency' => Js::truthy($input['currency'] ?? null) ? $input['currency'] : 'CZK']);
        $report = $this->app->runJobs(true);
        return ['result' => $report['payments']['results'][0] ?? null];
    }
}
