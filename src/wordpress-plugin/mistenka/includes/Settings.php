<?php
// Nastavení organizace v databázi (src/node/lib/settings.js). Soubor konfigurace zůstává výchozími hodnotami;
// každá změna z manažerského portálu se uloží jako nová verze celé části (scope) s autorem.
// Části: organization | payment | revir:<id> | species:<odkaz na soubor pravidel>
namespace Mistenka;

defined('ABSPATH') || exit;

final class Settings
{
    private const ORG_KEYS = ['organization', 'publicCheck', 'limitPolicy', 'penaltyPolicy', 'privacy'];
    private const PAYMENT_KEYS = ['accountNumber', 'bankCode', 'recipientName', 'reservationMinutes', 'messagePrefix'];

    private App $app;
    private array $source;

    public function __construct(App $app, array $source)
    {
        $this->app = $app;
        $this->source = $source;
    }

    // Sestaví platnou konfiguraci při startu požadavku (soubor + uložené verze).
    public function boot(): array
    {
        if ($this->latestRows()) {
            try {
                return $this->build();
            } catch (ApiError $e) {
                throw new \RuntimeException('Uložené nastavení není platné (' . $e->getMessage() . '). Opravte ho, nebo smažte poslední verzi v tabulce settings_versions.');
            }
        }
        return Config::build($this->source['raw'], $this->source['species']);
    }

    private static function pick($object, array $keys): array
    {
        $out = [];
        if (!is_array($object)) return $out;
        foreach ($keys as $key) if (array_key_exists($key, $object)) $out[$key] = $object[$key];
        return $out;
    }

    private function latestRows(): array
    {
        return Db::all('SELECT v.* FROM {p}settings_versions v JOIN (SELECT scope, MAX(id) AS id FROM {p}settings_versions GROUP BY scope) m ON m.id = v.id');
    }

    private function latest(string $scope): ?array
    {
        return Db::row('SELECT * FROM {p}settings_versions WHERE scope = ? ORDER BY id DESC LIMIT 1', $scope);
    }

    private function fileDoc(string $scope)
    {
        $raw = $this->source['raw'];
        if ($scope === 'organization') return self::pick($raw, self::ORG_KEYS);
        if ($scope === 'payment') return self::pick($raw['payment'] ?? [], self::PAYMENT_KEYS);
        if (str_starts_with($scope, 'revir:')) {
            foreach ($raw['reviry'] as $revir) {
                if ($revir['id'] === substr($scope, 6)) {
                    unset($revir['id']);
                    return $revir;
                }
            }
            return null;
        }
        if (str_starts_with($scope, 'species:')) return $this->source['species'][substr($scope, 8)] ?? null;
        return null;
    }

    // Zdroj + uložené verze (+ navrhovaná změna) → data pro Config::build.
    private function effective(array $overrides = []): array
    {
        $docs = [];
        foreach ($this->latestRows() as $row) $docs[$row['scope']] = json_decode($row['data'], true);
        foreach ($overrides as $scope => $data) $docs[$scope] = $data;
        $raw = $this->source['raw'];
        if (isset($docs['organization'])) foreach (self::ORG_KEYS as $key) if (array_key_exists($key, $docs['organization'])) $raw[$key] = $docs['organization'][$key];
        if (isset($docs['payment'])) $raw['payment'] = array_merge($docs['payment'], ['provider' => $this->source['raw']['payment']['provider'] ?? 'fake']);
        foreach ($docs as $scope => $data) {
            if (!str_starts_with($scope, 'revir:')) continue;
            $revir = array_merge(is_array($data) ? $data : [], ['id' => substr($scope, 6)]);
            $index = null;
            foreach ($raw['reviry'] as $i => $r) if ($r['id'] === $revir['id']) $index = $i;
            if ($index !== null) $raw['reviry'][$index] = $revir; else $raw['reviry'][] = $revir;
        }
        $species = $this->source['species'];
        foreach ($docs as $scope => $data) if (str_starts_with($scope, 'species:')) $species[substr($scope, 8)] = $data;
        return ['raw' => $raw, 'species' => $species];
    }

    private function build(array $overrides = []): array
    {
        $e = $this->effective($overrides);
        try {
            return Config::build($e['raw'], $e['species']);
        } catch (ConfigError $error) {
            throw new ApiError(400, 'invalid_settings', preg_replace('/^Chybná konfigurace: /u', '', $error->getMessage()));
        }
    }

    // ---------- čtení ----------
    private function versionMeta(string $scope): array
    {
        $row = $this->latest($scope);
        if (!$row) return ['version' => null, 'source' => 'file'];
        $by = $row['created_by'] ? Db::row('SELECT first_name, last_name FROM {p}users WHERE id = ?', $row['created_by']) : null;
        return ['version' => $row['id'], 'source' => 'database', 'updatedAt' => $row['created_at'], 'updatedBy' => $by ? $by['first_name'] . ' ' . $by['last_name'] : ''];
    }

    private static function rolesOf(?array $user): array
    {
        return explode(',', (string) ($user['roles'] ?? ''));
    }

    public function view(?array $actor): array
    {
        $config = $this->app->config;
        $species = $this->effective()['species'];
        $reviry = [];
        foreach ($config['reviry'] as $revir) {
            $data = $revir;
            unset($data['fishRules'], $data['id']);
            $reviry[] = array_merge(['id' => $revir['id'], 'data' => Js::obj($data)], $this->versionMeta('revir:' . $revir['id']));
        }
        $speciesList = [];
        foreach ($species as $ref => $doc) $speciesList[] = array_merge(['ref' => $ref, 'data' => $doc], $this->versionMeta('species:' . $ref));
        return [
            'organization' => array_merge(['data' => Js::obj(self::pick($config, self::ORG_KEYS))], $this->versionMeta('organization')),
            'payment' => array_merge(['data' => Js::obj(self::pick($config['payment'], self::PAYMENT_KEYS)), 'iban' => $config['iban'], 'provider' => $config['payment']['provider']], $this->versionMeta('payment')),
            'reviry' => $reviry,
            'species' => $speciesList,
            'canEditPayment' => in_array('admin', self::rolesOf($actor), true),
        ];
    }

    // ---------- uložení ----------
    private function checkScope(string $scope, ?array $actor, bool $creating): void
    {
        if ($scope === 'organization') return;
        if ($scope === 'payment') {
            if (!in_array('admin', self::rolesOf($actor), true)) throw new ApiError(403, 'forbidden_role', 'Platební údaje smí měnit jen admin.');
            return;
        }
        if (str_starts_with($scope, 'revir:')) {
            $id = substr($scope, 6);
            if (!preg_match('/^[a-z0-9-]{1,40}$/', $id)) throw new ApiError(400, 'invalid_settings', 'Identifikátor revíru smí obsahovat jen a–z, 0–9 a pomlčku.');
            $exists = (bool) Config::getRevir($this->app->config, $id);
            if ($creating && $exists) throw new ApiError(409, 'revir_exists', 'Revír s tímto identifikátorem už existuje.');
            if (!$creating && !$exists) throw new ApiError(404, 'not_found', 'Revír neexistuje.');
            return;
        }
        if (str_starts_with($scope, 'species:')) {
            if (empty($this->effective()['species'][substr($scope, 8)])) throw new ApiError(404, 'not_found', 'Pravidla druhů neexistují.');
            return;
        }
        throw new ApiError(400, 'invalid_scope', 'Neznámá část nastavení.');
    }

    private function normalize(string $scope, $data): array
    {
        if (!is_array($data) || ($data && !Js::isAssoc($data))) throw new ApiError(400, 'invalid_settings', 'Nastavení musí být objekt.');
        if ($scope === 'organization') return self::pick($data, self::ORG_KEYS);
        if ($scope === 'payment') return self::pick($data, self::PAYMENT_KEYS);
        if (str_starts_with($scope, 'revir:')) {
            unset($data['id'], $data['fishRules']);
            return $data;
        }
        return $data;
    }

    public function save(?array $actor, string $scope, $data, string $note = '', bool $creating = false): array
    {
        $this->checkScope($scope, $actor, $creating);
        $doc = $this->normalize($scope, $data);
        return Db::transaction(function () use ($actor, $scope, $doc, $note) {
            $config = $this->app->config;
            $before = $scope === 'payment' ? array_merge(self::pick($config['payment'], self::PAYMENT_KEYS), ['iban' => $config['iban']]) : null;
            $next = $this->build([$scope => $doc]); // kontrola celé konfigurace, než se cokoli uloží
            $now = Time::nowIso();
            $noteText = Js::slice(trim($note), 0, 200);
            $id = Db::insert('INSERT INTO {p}settings_versions (scope, data, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)', $scope, wp_json_encode(Js::obj($doc)), $noteText !== '' ? $noteText : null, $actor['id'] ?? null, $now);
            $this->app->config = $next;
            Db::exec("INSERT INTO {p}audit_events (at, actor_user_id, action, target_type, target_id, detail) VALUES (?, ?, 'settings_changed', 'settings', ?, ?)", $now, $actor['id'] ?? null, $scope, wp_json_encode(['version' => $id, 'note' => $note]));
            // Změna účtu pro platby je nejcitlivější změna – dozví se o ní všichni admini.
            if ($scope === 'payment') {
                $after = array_merge(self::pick($next['payment'], self::PAYMENT_KEYS), ['iban' => $next['iban']]);
                $actorName = $actor ? "{$actor['first_name']} {$actor['last_name']} ({$actor['email']})" : 'systém';
                $mail = Emails::paymentSettingsChanged($next, ['actorName' => $actorName, 'before' => $before, 'after' => $after, 'at' => $now]);
                foreach (Db::all("SELECT email FROM {p}users WHERE FIND_IN_SET('admin', roles) > 0") as $admin) {
                    $this->app->queueEmail(null, 'payment_settings_changed', $admin['email'], $mail);
                }
            }
            return ['scope' => $scope, 'version' => $id, 'settings' => $this->view($actor)];
        });
    }

    public function history(string $scope): array
    {
        $rows = Db::all('SELECT v.id, v.note, v.created_at, u.first_name, u.last_name FROM {p}settings_versions v LEFT JOIN {p}users u ON u.id = v.created_by WHERE v.scope = ? ORDER BY v.id DESC LIMIT 100', $scope);
        $versions = array_map(fn($r) => ['version' => $r['id'], 'note' => $r['note'] ?? '', 'createdAt' => $r['created_at'], 'createdBy' => $r['first_name'] ? $r['first_name'] . ' ' . $r['last_name'] : ''], $rows);
        return ['scope' => $scope, 'versions' => $versions, 'hasFile' => (bool) $this->fileDoc($scope)];
    }

    public function versionData($versionId): array
    {
        $row = Db::row('SELECT * FROM {p}settings_versions WHERE id = ?', (int) $versionId);
        if (!$row) throw new ApiError(404, 'not_found', 'Verze neexistuje.');
        return ['scope' => $row['scope'], 'version' => $row['id'], 'data' => Js::obj(json_decode($row['data'], true)), 'createdAt' => $row['created_at']];
    }

    // Obnovení starší verze = uložení její kopie jako nové verze (historie se nepřepisuje).
    public function restore(?array $actor, $versionId): array
    {
        $version = $this->versionData($versionId);
        $data = $version['data'] instanceof \stdClass ? [] : $version['data'];
        return $this->save($actor, $version['scope'], $data, 'Obnovena verze #' . $version['version']);
    }

    public function resetToFile(?array $actor, $scope): array
    {
        $scope = Js::str($scope);
        $doc = $this->fileDoc($scope);
        if (!$doc) throw new ApiError(404, 'not_found', 'Tato část nemá výchozí hodnoty v souboru.');
        return $this->save($actor, $scope, $doc, 'Obnoveny výchozí hodnoty ze souboru');
    }

    // Export platné konfigurace ve tvaru souborů.
    public function exportAll(): array
    {
        $e = $this->effective();
        return ['organization' => $e['raw'], 'species' => Js::obj($e['species']), 'exportedAt' => Time::nowIso()];
    }

    // Verze pravidel druhů pro revír – ukládá se k odevzdané místence.
    public function rulesVersion(string $revirId): string
    {
        $config = $this->app->config;
        $revir = Config::getRevir($config, $revirId);
        $ref = $revir['speciesRules'] ?? ($config['speciesRules'] ?? null);
        $row = $ref ? $this->latest('species:' . $ref) : null;
        return ($revir['fishRules']['id'] ?? ($ref ?: '?')) . '@' . ($row ? 'v' . $row['id'] : 'soubor');
    }

    // Po obnově databáze: nastavení se znovu sestaví z obnovených verzí.
    public function reload(): void
    {
        $this->app->config = $this->latestRows() ? $this->build() : Config::build($this->source['raw'], $this->source['species']);
    }
}
