<?php
// Uchovávání osobních údajů (GDPR) – src/node/lib/retention.js. Jednou denně po uplynutí lhůt anonymizuje nebo maže.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Retention
{
    private App $app;

    public function __construct(App $app)
    {
        $this->app = $app;
    }

    public function run(bool $force = false): array
    {
        $today = Time::pragueToday();
        if (!$force && Db::metaGet('last_retention') === $today) return ['skipped' => true];
        $p = $this->app->config['privacy'];
        $report = [];
        Db::transaction(function () use ($today, $p, &$report) {
            $now = Time::nowIso();
            // Místenky z let <= rok − ticketYears − 1: anonymizace držitele; úlovky, ceny a VS zůstávají.
            $lastYear = (int) substr($today, 0, 4) - (int) $p['ticketYears'] - 1;
            $old = array_column(Db::all('SELECT id FROM {p}tickets WHERE anonymized_at IS NULL AND SUBSTRING(fishing_date, 1, 4) <= ?', (string) $lastYear), 'id');
            foreach ($old as $id) {
                Db::exec("UPDATE {p}tickets SET first_name = 'Anonymizováno', last_name = '', birth_date = '', email = '', member_id = '', user_id = NULL, seized_reason = CASE WHEN seized_reason IS NULL THEN NULL ELSE 'anonymizováno' END, seized_place = NULL, cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE 'anonymizováno' END, anonymized_at = ? WHERE id = ?", $now, $id);
                Db::exec('DELETE FROM {p}ticket_tokens WHERE ticket_id = ?', $id);
                Db::exec("UPDATE {p}limit_violations SET member_id = '' WHERE ticket_id = ?", $id);
                Db::exec("UPDATE {p}email_outbox SET to_email = '', body_html = '', body_text = '' WHERE ticket_id = ?", $id);
            }
            $report['ticketsAnonymized'] = count($old);
            $blockCutoff = "{$lastYear}-12-31";
            $report['blocksDeleted'] = Db::exec('DELETE FROM {p}member_blocks WHERE (lifted_at IS NOT NULL AND SUBSTRING(lifted_at, 1, 10) <= ?) OR (until_date IS NOT NULL AND until_date <= ?)', $blockCutoff, $blockCutoff);
            $report['paymentsAnonymized'] = Db::exec('UPDATE {p}bank_transactions SET counter_account = NULL, counter_name = NULL, message = NULL WHERE created_at <= ? AND (counter_account IS NOT NULL OR counter_name IS NOT NULL OR message IS NOT NULL)', Time::iso(Time::yearsAgo((int) $p['accountingYears'])));
            $report['emailsDeleted'] = Db::exec('DELETE FROM {p}email_outbox WHERE sent_at IS NOT NULL AND created_at <= ?', Time::iso(Time::fromMs(Time::ms(Time::now()) - (int) $p['emailDays'] * 86400000)));
            // Hlášení chyb: snímek obrazovky po 90 dnech, vyřízená hlášení rok po vyřízení.
            $report['bugScreenshotsDeleted'] = Db::exec('UPDATE {p}bug_reports SET screenshot = NULL WHERE screenshot IS NOT NULL AND created_at <= ?', Time::iso(Time::fromMs(Time::ms(Time::now()) - 90 * 86400000)));
            $report['bugReportsDeleted'] = Db::exec('DELETE FROM {p}bug_reports WHERE resolved_at IS NOT NULL AND resolved_at <= ?', Time::iso(Time::yearsAgo(1)));
            $report['auditDeleted'] = Db::exec('DELETE FROM {p}audit_events WHERE at <= ?', Time::iso(Time::yearsAgo((int) $p['auditYears'])));
            Db::metaSet('last_retention', $today);
        });
        $report['backupsDeleted'] = $this->app->backups->removeOlderThan(Time::iso(Time::yearsAgo((int) $p['backupYears'])));
        return $report;
    }
}
