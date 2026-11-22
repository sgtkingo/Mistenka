<?php
// Načtení a kontrola konfigurace MO (src/node/lib/config.js). Výchozí hodnoty = config/organization.json
// v pluginu (jiný soubor přes MISTENKA_CONFIG), změny z portálu ukládá Settings jako verze v databázi.
namespace Mistenka;

defined('ABSPATH') || exit;

final class ConfigError extends \Exception
{
}

final class Config
{
    private static function fail(string $message): void
    {
        throw new ConfigError('Chybná konfigurace: ' . $message);
    }

    private static function readJson(string $file)
    {
        $text = @file_get_contents($file);
        if ($text === false) throw new ConfigError("Chybná konfigurace: soubor {$file} nelze načíst");
        $data = json_decode($text, true);
        if (!is_array($data)) throw new ConfigError("Chybná konfigurace: {$file} není platný JSON");
        return $data;
    }

    // Zdroj: soubor MO + soubory pravidel druhů ryb, na které odkazuje (speciesRules).
    public static function readSource(?string $file = null): array
    {
        $file = $file ?: Env::configFile();
        $raw = self::readJson($file);
        $baseDir = dirname($file);
        $refs = [];
        if (!empty($raw['speciesRules'])) $refs[] = $raw['speciesRules'];
        foreach ($raw['reviry'] ?? [] as $revir) if (!empty($revir['speciesRules'])) $refs[] = $revir['speciesRules'];
        $species = [];
        foreach (array_unique($refs) as $ref) {
            $path = $baseDir . '/' . $ref;
            try {
                $species[$ref] = self::readJson($path);
            } catch (ConfigError $e) {
                self::fail("nelze načíst pravidla {$ref}");
            }
        }
        return ['file' => $file, 'raw' => $raw, 'species' => $species];
    }

    private static function emailOk($value): bool
    {
        return (bool) preg_match(Validate::EMAIL_RE, (string) $value);
    }

    private static function present(array $a, string $key): bool
    {
        return array_key_exists($key, $a) && $a[$key] !== null && $a[$key] !== '';
    }

    // Sestaví a zkontroluje konfiguraci z dat MO (tvar organization.json) a pravidel druhů (ref → dokument).
    public static function build(array $raw, array $speciesDocs): array
    {
        $config = $raw;
        if (empty($config['organization']['shortName'])) self::fail('chybí organization.shortName');
        if (!isset($config['reviry']) || !is_array($config['reviry']) || !$config['reviry'] || Js::isAssoc($config['reviry'])) self::fail('chybí seznam reviry');
        if (empty($config['payment']['accountNumber']) || empty($config['payment']['bankCode'])) self::fail('chybí payment.accountNumber nebo payment.bankCode');
        // Lhůta pro opožděné odevzdání je jedna pro celou MO (portál → Limity a blokace, výchozí 7 dní).
        // Starší konfigurace ji měly u revíru – převezme se hodnota prvního revíru.
        $legacyDays = null;
        foreach ($config['reviry'] as $r) if (is_array($r) && Js::isInteger($r['lateReturnDays'] ?? null)) { $legacyDays = $r['lateReturnDays']; break; }
        $config['returnPolicy'] = array_merge(['lateReturnDays' => $legacyDays ?? 7], is_array($config['returnPolicy'] ?? null) ? $config['returnPolicy'] : []);
        $days = $config['returnPolicy']['lateReturnDays'];
        if (!Js::isInteger($days) || $days < 0 || $days > 60) self::fail('lhůta pro opožděné odevzdání musí být 0–60 dní');
        foreach ($config['reviry'] as $i => $r) if (is_array($r)) $config['reviry'][$i]['lateReturnDays'] = $days;
        // Prodej dopředu je také jeden pro celou MO (portál → Ceny a místa, výchozí 3 dny).
        $legacyAhead = null;
        foreach ($config['reviry'] as $r) if (is_array($r) && Js::isInteger($r['bookingDaysAhead'] ?? null)) { $legacyAhead = $r['bookingDaysAhead']; break; }
        $config['salesPolicy'] = array_merge(['bookingDaysAhead' => $legacyAhead ?? 3], is_array($config['salesPolicy'] ?? null) ? $config['salesPolicy'] : []);
        $ahead = $config['salesPolicy']['bookingDaysAhead'];
        if (!Js::isInteger($ahead) || $ahead < 0 || $ahead > 60) self::fail('prodej dopředu musí být 0–60 dní');
        foreach ($config['reviry'] as $i => $r) if (is_array($r)) $config['reviry'][$i]['bookingDaysAhead'] = $ahead;
        $ids = [];
        foreach ($config['reviry'] as $revir) {
            $id = is_array($revir) ? Js::str($revir['id'] ?? '') : '';
            if (!preg_match('/^[a-z0-9-]+$/', $id)) self::fail("revír má neplatné id: {$id}");
            if (isset($ids[$id])) self::fail("duplicitní id revíru: {$id}");
            $ids[$id] = true;
            foreach (['name', 'priceCzk', 'dailyCapacity', 'bookingDaysAhead', 'lateReturnDays'] as $key) {
                if (!self::present($revir, $key)) self::fail("revír {$id}: chybí {$key}");
            }
            if (!Js::isInteger($revir['dailyCapacity']) || $revir['dailyCapacity'] < 1) self::fail("revír {$id}: denní kapacita musí být kladné celé číslo");
            if (!(Js::isNumber($revir['priceCzk']) && $revir['priceCzk'] >= 0)) self::fail("revír {$id}: cena musí být číslo >= 0");
            if (!Js::isInteger($revir['bookingDaysAhead']) || $revir['bookingDaysAhead'] < 0 || $revir['bookingDaysAhead'] > 60) self::fail("revír {$id}: prodej dopředu musí být 0–60 dní");
            if (!Js::isInteger($revir['lateReturnDays']) || $revir['lateReturnDays'] < 0 || $revir['lateReturnDays'] > 60) self::fail("revír {$id}: lhůta pro opožděné odevzdání musí být 0–60 dní");
            if (array_key_exists('ticketSubdistricts', $revir)) {
                if (!is_array($revir['ticketSubdistricts']) || Js::isAssoc($revir['ticketSubdistricts']) && $revir['ticketSubdistricts']) self::fail("revír {$id}: ticketSubdistricts musí být seznam čísel podrevírů");
                foreach ($revir['ticketSubdistricts'] as $number) {
                    if (isset($revir['subdistrictList']) && is_array($revir['subdistrictList'])) {
                        $found = false;
                        foreach ($revir['subdistrictList'] as $s) if (Js::str($s['number'] ?? '') === Js::str($number)) $found = true;
                        if (!$found) self::fail("revír {$id}: podrevír " . Js::str($number) . ' z ticketSubdistricts není v subdistrictList');
                    }
                }
            }
        }
        if (empty($config['payment']['reservationMinutes'])) $config['payment']['reservationMinutes'] = 60;
        $rm = $config['payment']['reservationMinutes'];
        if (!Js::isInteger($rm) || $rm < 10 || $rm > 24 * 60) self::fail('rezervace před platbou musí být 10–1440 minut');
        if (empty($config['payment']['provider'])) $config['payment']['provider'] = 'fake';
        if (empty($config['publicCheck'])) $config['publicCheck'] = ['showFullName' => true, 'memberIdVisibleChars' => 4];
        $config['limitPolicy'] = array_merge(['violationsBeforeBlock' => 0, 'blockDays' => null], is_array($config['limitPolicy'] ?? null) ? $config['limitPolicy'] : []);
        $lp = $config['limitPolicy'];
        if (!Js::isInteger($lp['violationsBeforeBlock']) || $lp['violationsBeforeBlock'] < 0) self::fail('počet porušení před blokací musí být celé číslo >= 0');
        if ($lp['blockDays'] !== null && !(Js::isInteger($lp['blockDays']) && $lp['blockDays'] > 0)) self::fail('délka blokace musí být kladný počet dní, nebo prázdná (do konce roku)');
        $config['privacy'] = array_merge(['contactEmail' => '', 'ticketYears' => 3, 'accountingYears' => 10, 'emailDays' => 90, 'auditYears' => 5, 'backupYears' => 3], is_array($config['privacy'] ?? null) ? $config['privacy'] : []);
        foreach ([['ticketYears', 1, 20, 'uchování místenek'], ['accountingYears', 5, 20, 'účetní lhůta'], ['emailDays', 7, 3650, 'uchování e-mailů'], ['auditYears', 1, 20, 'uchování auditu'], ['backupYears', 1, 20, 'uchování záloh']] as [$key, $min, $max, $label]) {
            $v = $config['privacy'][$key];
            if (!Js::isInteger($v) || $v < $min || $v > $max) self::fail("{$label} musí být celé číslo {$min}–{$max}");
        }
        if (!empty($config['privacy']['contactEmail']) && !self::emailOk($config['privacy']['contactEmail'])) self::fail('neplatný e-mail pro ochranu osobních údajů');
        $pp = is_array($config['penaltyPolicy'] ?? null) ? $config['penaltyPolicy'] : [];
        $config['penaltyPolicy'] = [
            'lateReturn' => array_merge(['count' => 0, 'blockDays' => null, 'includeUnreturned' => true], is_array($pp['lateReturn'] ?? null) ? $pp['lateReturn'] : []),
            'seizure' => array_merge(['count' => 0, 'blockDays' => null], is_array($pp['seizure'] ?? null) ? $pp['seizure'] : []),
        ];
        foreach ([['lateReturn', 'pozdní odevzdání'], ['seizure', 'zadržení']] as [$key, $label]) {
            $rule = $config['penaltyPolicy'][$key];
            if (!Js::isInteger($rule['count']) || $rule['count'] < 0 || $rule['count'] > 50) self::fail("{$label}: počet případů musí být celé číslo 0–50");
            if ($rule['blockDays'] !== null && !(Js::isInteger($rule['blockDays']) && $rule['blockDays'] > 0 && $rule['blockDays'] <= 3650)) self::fail("{$label}: délka blokace musí být 1–3650 dní, nebo prázdná (do konce roku)");
        }
        // E-maily (odesílatelé, příjemci upozornění) nastavuje admin v portálu (Emailoví klienti), ne konfigurace.
        unset($config['organization']['managerEmail'], $config['email']);
        $contactEmail = $config['organization']['contact']['email'] ?? '';
        if ($contactEmail && !self::emailOk($contactEmail)) self::fail('neplatný veřejný e-mail');
        // Podrevír v prodeji může mít vlastní cenu a počet míst (jinak platí hodnoty revíru).
        foreach ($config['reviry'] as $i => $r) {
            foreach (is_array($r['subdistrictList'] ?? null) ? $r['subdistrictList'] : [] as $s) {
                $n = Js::str($s['number'] ?? '');
                if (array_key_exists('priceCzk', $s) && $s['priceCzk'] !== null && !(Js::isNumber($s['priceCzk']) && $s['priceCzk'] >= 0)) self::fail("revír {$r['id']}, podrevír {$n}: cena musí být číslo >= 0");
                if (array_key_exists('dailyCapacity', $s) && $s['dailyCapacity'] !== null && !(Js::isInteger($s['dailyCapacity']) && $s['dailyCapacity'] >= 1)) self::fail("revír {$r['id']}, podrevír {$n}: počet míst musí být kladné celé číslo");
            }
            $config['reviry'][$i]['saleSubdistricts'] = self::saleSubdistricts($r);
        }
        $orgRules = self::speciesRulesFor($speciesDocs, $config['speciesRules'] ?? null, 'organizace');
        foreach ($config['reviry'] as $i => $revir) {
            $rules = !empty($revir['speciesRules']) ? self::speciesRulesFor($speciesDocs, $revir['speciesRules'], 'revír ' . $revir['id']) : $orgRules;
            $config['reviry'][$i]['fishRules'] = self::applyOverrides($rules, is_array($revir['speciesOverrides'] ?? null) ? $revir['speciesOverrides'] : [], $revir['id']);
        }
        $config['iban'] = self::czIban(Js::str($config['payment']['accountNumber']), Js::str($config['payment']['bankCode']));
        return $config;
    }

    private static function speciesRulesFor(array $docs, $ref, string $owner): array
    {
        if (!$ref) self::fail("{$owner}: chybí odkaz speciesRules na pravidla druhů ryb");
        if (empty($docs[$ref])) self::fail("{$owner}: pravidla {$ref} nejsou načtená");
        return self::validateSpeciesRules($docs[$ref], (string) $ref);
    }

    private static function validateSpeciesRules(array $rules, string $file): array
    {
        if (!isset($rules['species']) || !is_array($rules['species']) || !$rules['species']) self::fail("{$file}: chybí seznam species");
        $ids = [];
        foreach ($rules['species'] as $s) {
            $sid = Js::str($s['id'] ?? '');
            if (!preg_match('/^[a-z0-9-]+$/', $sid) || empty($s['name'])) self::fail("{$file}: druh musí mít id (a-z0-9-) a name");
            if (isset($ids[$sid])) self::fail("{$file}: duplicitní druh {$sid}");
            $ids[$sid] = true;
            foreach (['minLength', 'releaseFromLength', 'weightFactor'] as $key) {
                if (array_key_exists($key, $s) && $s[$key] !== null && !(Js::isNumber($s[$key]) && $s[$key] >= 0)) self::fail("{$file}: {$s['name']} – {$key} musí být číslo >= 0");
            }
            foreach ($s['closedSeasons'] ?? [] as $season) {
                if (!preg_match('/^\d{2}-\d{2}$/', Js::str($season['from'] ?? '')) || !preg_match('/^\d{2}-\d{2}$/', Js::str($season['to'] ?? ''))) self::fail("{$file}: {$s['name']} má neplatnou dobu hájení (MM-DD)");
            }
        }
        foreach ($rules['dailyLimits'] ?? [] as $limit) {
            if (!(Js::isInteger($limit['maxCount'] ?? null) && $limit['maxCount'] > 0)) self::fail("{$file}: denní limit " . Js::str($limit['id'] ?? '') . ' musí mít maxCount > 0');
            foreach ($limit['species'] ?? [] as $id) if (!isset($ids[$id])) self::fail("{$file}: denní limit {$limit['id']} odkazuje na neznámý druh {$id}");
        }
        foreach ($rules['periodLimits'] ?? [] as $limit) {
            if (!in_array($limit['period'] ?? '', ['week', 'month'], true)) self::fail("{$file}: limit " . Js::str($limit['id'] ?? '') . ' má neplatné období (week | month)');
            if (!(Js::isInteger($limit['maxCount'] ?? null) && $limit['maxCount'] > 0)) self::fail("{$file}: limit {$limit['id']} musí mít maxCount > 0");
            foreach ($limit['species'] ?? [] as $id) if (!isset($ids[$id])) self::fail("{$file}: limit {$limit['id']} odkazuje na neznámý druh {$id}");
        }
        // Hlídání limitů úlovků (výchozí vypnuto) a lovných měr – míra, hájení, povinné vrácení (výchozí zapnuto); přepíná se ve správě.
        foreach (['limitsEnabled', 'sizeRulesEnabled'] as $key) {
            if (array_key_exists($key, $rules) && !is_bool($rules[$key])) self::fail("{$file}: {$key} musí být true/false");
        }
        return [
            'id' => $rules['id'] ?? null, 'name' => $rules['name'] ?? null, 'validFrom' => $rules['validFrom'] ?? null, 'validTo' => $rules['validTo'] ?? null,
            'sources' => $rules['sources'] ?? [], 'dailyLimits' => $rules['dailyLimits'] ?? [], 'periodLimits' => $rules['periodLimits'] ?? [], 'species' => $rules['species'],
            'limitsEnabled' => ($rules['limitsEnabled'] ?? false) === true, 'sizeRulesEnabled' => ($rules['sizeRulesEnabled'] ?? true) !== false,
        ];
    }

    // Úpravy pro konkrétní revír („na vybraných revírech je zvýšena lovná míra …“).
    private static function applyOverrides(array $rules, array $overrides, string $revirId): array
    {
        $species = $rules['species'];
        foreach ($overrides as $override) {
            $index = null;
            foreach ($species as $i => $s) if (($s['id'] ?? null) === ($override['id'] ?? null)) $index = $i;
            if ($index === null) self::fail("revír {$revirId}: speciesOverrides odkazuje na neznámý druh " . Js::str($override['id'] ?? ''));
            $species[$index] = array_merge($species[$index], $override);
        }
        $rules['species'] = $species;
        return $rules;
    }

    public static function getRevir(array $config, $id): ?array
    {
        foreach ($config['reviry'] as $revir) if ($revir['id'] === $id) return $revir;
        return null;
    }

    // Podrevíry v prodeji (ticketSubdistricts): místenka platí pro jeden z nich, každý má cenu a počet míst
    // (vlastní, jinak revíru). Prázdné = místenka na celý revír.
    public static function saleSubdistricts(array $revir): array
    {
        $out = [];
        foreach (is_array($revir['ticketSubdistricts'] ?? null) ? $revir['ticketSubdistricts'] : [] as $number) {
            $s = [];
            foreach ($revir['subdistrictList'] ?? [] as $item) if (Js::str($item['number'] ?? '') === Js::str($number)) $s = $item;
            $out[] = [
                'number' => $number, 'name' => $s['name'] ?? '', 'area' => $s['area'] ?? '',
                'priceCzk' => Js::isNumber($s['priceCzk'] ?? null) ? $s['priceCzk'] : $revir['priceCzk'],
                'dailyCapacity' => Js::isInteger($s['dailyCapacity'] ?? null) ? $s['dailyCapacity'] : $revir['dailyCapacity'],
            ];
        }
        return $out;
    }

    // Podrevír místenky, např. "1 – Petr 1" (null = celý revír).
    public static function subdistrictName(?array $revir, $number): ?string
    {
        if ($number === null || $number === '') return null;
        foreach ($revir['subdistrictList'] ?? [] as $s) if (Js::str($s['number'] ?? '') === Js::str($number) && !empty($s['name'])) return Js::str($number) . ' – ' . $s['name'];
        return Js::str($number);
    }

    // Podrevíry, na které se místenka vztahuje, např. "1 – Petr 1, 2 – Petr 2" (null = celý revír).
    public static function ticketSubdistrictLabel(array $revir): ?string
    {
        $numbers = isset($revir['ticketSubdistricts']) && is_array($revir['ticketSubdistricts']) ? $revir['ticketSubdistricts'] : [];
        if (!$numbers) return null;
        $parts = [];
        foreach ($numbers as $number) {
            $name = null;
            foreach ($revir['subdistrictList'] ?? [] as $s) if (Js::str($s['number'] ?? '') === Js::str($number)) $name = $s['name'] ?? null;
            $parts[] = $name ? Js::str($number) . ' – ' . $name : Js::str($number);
        }
        return implode(', ', $parts);
    }

    // Veřejná část konfigurace pro frontend – bez tajných a interních údajů.
    public static function publicConfig(array $config, array $extra = []): array
    {
        $org = $config['organization'];
        $reviry = [];
        foreach ($config['reviry'] as $revir) {
            unset($revir['speciesRules'], $revir['speciesOverrides']);
            $reviry[] = $revir;
        }
        return array_merge([
            'organization' => [
                'id' => $org['id'] ?? null, 'name' => $org['name'] ?? null, 'shortName' => $org['shortName'], 'web' => $org['web'] ?? '', 'privacyUrl' => $org['privacyUrl'] ?? '',
                'contact' => Js::obj($org['contact'] ?? []), 'address' => $org['address'] ?? '', 'ico' => $org['ico'] ?? '',
            ],
            'privacy' => $config['privacy'],
            'payment' => ['mode' => $config['payment']['provider'], 'reservationMinutes' => $config['payment']['reservationMinutes']],
            'reviry' => $reviry,
        ], $extra);
    }

    // Číslo účtu ve tvaru [předčíslí-]číslo + kód banky → IBAN (CZ).
    public static function czIban(string $accountNumber, string $bankCode): string
    {
        [$prefix, $number] = str_contains($accountNumber, '-') ? explode('-', $accountNumber, 2) : ['0', $accountNumber];
        if (!preg_match('/^\d{1,6}$/', $prefix) || !preg_match('/^\d{2,10}$/', $number) || !preg_match('/^\d{4}$/', $bankCode)) self::fail('neplatné číslo účtu nebo kód banky');
        $bban = $bankCode . str_pad($prefix, 6, '0', STR_PAD_LEFT) . str_pad($number, 10, '0', STR_PAD_LEFT);
        $numeric = $bban . '123500';
        $remainder = 0;
        foreach (str_split($numeric) as $digit) $remainder = ($remainder * 10 + (int) $digit) % 97;
        return 'CZ' . str_pad((string) (98 - $remainder), 2, '0', STR_PAD_LEFT) . $bban;
    }
}
