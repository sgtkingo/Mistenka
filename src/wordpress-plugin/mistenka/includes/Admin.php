<?php
// Stránka v administraci WordPressu (Nastavení → Místenka): stav instalace, pravidla .htaccess,
// návod pro cron hostingu a jednorázový odkaz na založení prvního admina Místenky.
// Vše ostatní (organizace, revíry, e-maily, role) se spravuje v manažerském portálu aplikace.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Admin
{
    public static function menu(): void
    {
        add_options_page('Místenka', 'Místenka', 'manage_options', 'mistenka', [self::class, 'page']);
    }

    private static function row(string $label, string $valueHtml, ?bool $ok = null): string
    {
        $mark = $ok === null ? '' : ($ok ? '<span style="color:#1b7a43">✔</span> ' : '<span style="color:#b42318">✘</span> ');
        return '<tr><th scope="row">' . esc_html($label) . '</th><td>' . $mark . $valueHtml . '</td></tr>';
    }

    public static function page(): void
    {
        if (!current_user_can('manage_options')) return;
        $notice = '';
        $setupLink = null;
        if (isset($_POST['mistenka_htaccess']) && check_admin_referer('mistenka_admin')) {
            $notice = Plugin::writeHtaccess()
                ? '<div class="notice notice-success"><p>Pravidla .htaccess zapsána.</p></div>'
                : '<div class="notice notice-error"><p>Soubor .htaccess nelze zapsat – vložte pravidla níže ručně na jeho začátek.</p></div>';
        }
        $app = null;
        $error = null;
        try {
            $app = App::get();
        } catch (\Throwable $e) {
            $error = $e->getMessage();
        }
        if ($app && isset($_POST['mistenka_setup']) && check_admin_referer('mistenka_admin')) {
            $setupLink = $app->accounts->createSetupToken();
            if (!$setupLink) $notice = '<div class="notice notice-warning"><p>Admin Místenky už existuje.</p></div>';
        }
        $appUrl = Plugin::appUrl();
        $htaccess = Plugin::htaccessStatus();
        $cronUrl = $appUrl . '/?rest_route=/' . App::NS . '/jobs/run';
        $dataDir = Env::dataDir();
        ?>
        <div class="wrap">
            <h1>Místenka</h1>
            <?php echo $notice; // phpcs:ignore -- sestaveno výše ?>
            <?php if ($error) : ?>
                <div class="notice notice-error"><p><b>Aplikace se nenačetla:</b> <?php echo esc_html($error); ?></p></div>
            <?php endif; ?>
            <p>Aplikace běží na vlastní adrese; organizaci, revíry, e-mailové účty a role spravujete v <a href="<?php echo esc_url($appUrl . '/manage.html'); ?>" target="_blank">manažerském portálu</a>.</p>

            <h2>Stav</h2>
            <table class="form-table" role="presentation">
                <?php
                echo self::row('Adresa aplikace', '<a href="' . esc_url($appUrl . '/') . '" target="_blank">' . esc_html($appUrl) . '</a> <span class="description">(organization.appUrl v konfiguraci nebo konstanta MISTENKA_APP_URL)</span>');
                echo self::row('Verze', esc_html(MISTENKA_VERSION . ' · schéma ' . Db::SCHEMA_VERSION . ' · PHP ' . PHP_VERSION));
                echo self::row('Konfigurace', esc_html(Env::configFile()), is_readable(Env::configFile()));
                echo self::row('Datová složka (zálohy)', esc_html($dataDir), is_dir($dataDir) && is_writable($dataDir));
                echo self::row('Platby', $app ? esc_html($app->config['payment']['provider'] === 'fio' ? 'Fio API' . (Env::fioToken() ? '' : ' – chybí MISTENKA_FIO_TOKEN') : 'falešná banka (vývoj)') : '—', $app ? ($app->config['payment']['provider'] !== 'fio' || Env::fioToken() !== '') : null);
                echo self::row('Klíč pro cron', Env::cronKey() !== '' ? 'nastaven' : 'chybí konstanta <code>MISTENKA_CRON_KEY</code> ve wp-config.php', Env::cronKey() !== '');
                echo self::row('Odesílání e-mailů', Env::mailTransport() === 'file' ? 'jen do datové složky (MISTENKA_MAIL_TRANSPORT = file)' : 'SMTP účty z portálu (Admin → Emailoví klienti), jinak wp_mail()');
                echo self::row('Vývojový režim', Env::dev() ? '<b>zapnutý</b> (MISTENKA_DEV) – jen pro testovací web!' : 'vypnutý', !Env::dev());
                $labels = ['not_needed' => 'nepoužívají se (frontend mimo složku webu)', 'ok' => 'v pořádku', 'outdated' => 'zastaralá – zapište znovu', 'absent' => 'chybí', 'missing' => 'soubor .htaccess neexistuje'];
                echo self::row('Pravidla .htaccess', esc_html($labels[$htaccess]), in_array($htaccess, ['ok', 'not_needed'], true));
                ?>
            </table>

            <form method="post">
                <?php wp_nonce_field('mistenka_admin'); ?>
                <p><button class="button" name="mistenka_htaccess" value="1">Zapsat pravidla .htaccess</button></p>
            </form>
            <details><summary>Pravidla .htaccess pro ruční vložení</summary>
                <p class="description">Na začátek souboru <code><?php echo esc_html(ABSPATH . '.htaccess'); ?></code>. Bez nich aplikace funguje také (soubory servíruje WordPress), jen pomaleji.</p>
                <pre style="background:#fff;padding:12px;border:1px solid #ccd0d4;overflow:auto"><?php echo esc_html(implode("\n", Plugin::htaccessLines())); ?></pre>
            </details>

            <h2>Plánované úlohy (cron hostingu)</h2>
            <p>Platby, připomínky, uzávěrky, zálohy a e-maily zpracovává úloha, kterou má volat cron hostingu každou minutu:</p>
            <pre style="background:#fff;padding:12px;border:1px solid #ccd0d4;overflow:auto">curl -fsS -X POST -H "X-Mistenka-Cron-Key: &lt;MISTENKA_CRON_KEY&gt;" "<?php echo esc_html($cronUrl); ?>"</pre>
            <p class="description">Jako záloha běží úlohy i přes WP-cron každých 5 minut (jen když web někdo navštíví).</p>

            <?php if ($app && $app->accounts->setupNeeded()) : ?>
                <h2>První admin Místenky</h2>
                <p>Zatím neexistuje žádný admin aplikace. Vygenerujte jednorázový odkaz na průvodce (platí 60 minut, jen jednou); admin vznikne rovnou s dvoufázovým ověřením.</p>
                <?php if ($setupLink) : ?>
                    <p><input type="text" class="large-text code" readonly value="<?php echo esc_attr($setupLink['link']); ?>" onclick="this.select()"></p>
                    <p><a class="button button-primary" href="<?php echo esc_url($setupLink['link']); ?>" target="_blank">Otevřít průvodce</a></p>
                <?php else : ?>
                    <form method="post"><?php wp_nonce_field('mistenka_admin'); ?><p><button class="button button-primary" name="mistenka_setup" value="1">Vygenerovat odkaz</button></p></form>
                <?php endif; ?>
            <?php endif; ?>
        </div>
        <?php
    }
}
