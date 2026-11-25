<?php
// Stránka v administraci WordPressu (Nastavení → Místenka):
//   Průvodce – adresa aplikace (uloží se do wp_options, ověří se), pravidla .htaccess, cron hostingu, první admin;
//   Stav     – přehled instalace (konfigurace, platby, e-maily, mapa, vývojový režim).
// Po aktivaci pluginu se průvodce otevře sám (Plugin::activationRedirect).
// Vše ostatní (organizace, revíry, e-maily, role) se spravuje v manažerském portálu aplikace.
namespace Mistenka;

defined('ABSPATH') || exit;

final class Admin
{
    private const PAGE = 'mistenka';
    private const CRON_FRESH = 15 * MINUTE_IN_SECONDS; // cron hostingu běží každou minutu – po 15 minutách bez běhu varovat

    public static function menu(): void
    {
        add_options_page('Místenka', 'Místenka', 'manage_options', self::PAGE, [self::class, 'page']);
    }

    // Upozornění na Pluginech a Nástěnce, dokud není nastavená adresa aplikace (např. obecný balíček se vzorovou adresou).
    public static function pluginsNotice(): void
    {
        $screen = function_exists('get_current_screen') ? get_current_screen() : null;
        if (!$screen || !in_array($screen->id, ['plugins', 'dashboard'], true) || !current_user_can('manage_options')) return;
        if (!TestMode::answered()) echo '<div class="notice notice-warning"><p><b>Místenka:</b> je tento web ostrý, nebo testovací? Odpovězte v <a href="' . esc_url(self::url('stav')) . '">Nastavení → Místenka</a>.</p></div>';
        if (!Plugin::appUrlNeedsSetup()) return;
        echo '<div class="notice notice-warning"><p><b>Místenka:</b> dokončete nastavení – zadejte nebo potvrďte adresu aplikace v <a href="' . esc_url(self::url('pruvodce')) . '">průvodci</a>.</p></div>';
    }

    private static function url(string $tab): string
    {
        return admin_url('options-general.php?page=' . self::PAGE . '&tab=' . $tab);
    }

    private static function row(string $label, string $valueHtml, ?bool $ok = null): string
    {
        return '<tr><th scope="row">' . esc_html($label) . '</th><td>' . self::mark($ok) . $valueHtml . '</td></tr>';
    }

    private static function mark(?bool $ok): string
    {
        return $ok === null ? '' : ($ok ? '<span style="color:#1b7a43">✔</span> ' : '<span style="color:#b42318">✘</span> ');
    }

    private static function notice(string $type, string $html): string
    {
        return '<div class="notice notice-' . $type . '"><p>' . $html . '</p></div>';
    }

    private static function stepStart(int $n, string $title, bool $done): void
    {
        $color = $done ? '#1b7a43' : '#2271b1';
        echo '<div style="background:#fff;border:1px solid #c3c4c7;border-left:4px solid ' . $color . ';padding:4px 16px 12px;margin:0 0 14px;max-width:900px">';
        echo '<h2 style="display:flex;gap:10px;align-items:center"><span style="display:inline-flex;width:26px;height:26px;border-radius:50%;background:' . $color . ';color:#fff;font-size:14px;align-items:center;justify-content:center">' . ($done ? '✔' : $n) . '</span>' . esc_html($title) . '</h2>';
    }

    private static function stepEnd(): void
    {
        echo '</div>';
    }

    public static function page(): void
    {
        if (!current_user_can('manage_options')) return;
        $notice = '';
        $setupLink = null;
        $typedUrl = null; // po chybě zůstane v poli, co uživatel zadal

        // Akce se zpracují před App::get() – instance si adresu aplikace načte při vytvoření.
        if (isset($_POST['mistenka_app_url_save']) && check_admin_referer('mistenka_admin')) {
            $error = null;
            $typed = sanitize_text_field(wp_unslash($_POST['mistenka_app_url'] ?? ''));
            $url = Plugin::normalizeAppUrl($typed, $error);
            if ($url === null) {
                $typedUrl = $typed;
                $notice = self::notice('error', esc_html($error));
            } else {
                $check = Plugin::saveAppUrl($url);
                $notice = self::notice($check['ok'] ? 'success' : 'warning', 'Adresa <b>' . esc_html($url) . '</b> uložena. ' . esc_html($check['message']));
            }
        }
        if (isset($_POST['mistenka_app_url_verify']) && check_admin_referer('mistenka_admin')) {
            $check = Plugin::verifyAppUrl(Plugin::appUrl());
            $notice = self::notice($check['ok'] ? 'success' : 'warning', esc_html($check['message']));
        }
        if (isset($_POST['mistenka_site_kind']) && check_admin_referer('mistenka_admin')) {
            try {
                TestMode::answer($_POST['mistenka_site_kind'] === 'test');
                $notice = self::notice('success', $_POST['mistenka_site_kind'] === 'test' ? 'Testovací režim zapnut – web běží nad testovací databází (kopie nastavení a účtů správců z provozu).' : 'Uloženo: ostrý web.');
            } catch (ApiError $e) {
                $notice = self::notice('error', esc_html($e->getMessage()));
            }
        }
        if (isset($_POST['mistenka_htaccess']) && check_admin_referer('mistenka_admin')) {
            $notice = Plugin::writeHtaccess()
                ? self::notice('success', 'Pravidla .htaccess zapsána.')
                : self::notice('error', 'Soubor .htaccess nelze zapsat – vložte pravidla ručně na jeho začátek (viz níže).');
        }

        $app = null;
        $appError = null;
        try {
            $app = App::get();
        } catch (\Throwable $e) {
            $appError = $e->getMessage();
        }
        if ($app && isset($_POST['mistenka_setup']) && check_admin_referer('mistenka_admin')) {
            $setupLink = $app->accounts->createSetupToken();
            if (!$setupLink) $notice = self::notice('warning', 'Admin Místenky už existuje.');
        }

        $appUrl = Plugin::appUrl();
        $htaccess = Plugin::htaccessStatus();
        $cronAt = (int) get_option(Plugin::CRON_OPTION, 0);
        $done = [
            'url' => !Plugin::appUrlNeedsSetup(),
            'htaccess' => in_array($htaccess, ['ok', 'not_needed'], true),
            'cron' => $cronAt > 0 && time() - $cronAt < self::CRON_FRESH,
            'admin' => $app && !$app->accounts->setupNeeded(),
        ];
        $allDone = !in_array(false, $done, true);
        $tab = sanitize_key($_GET['tab'] ?? '');
        if (!in_array($tab, ['pruvodce', 'stav'], true)) $tab = $allDone ? 'stav' : 'pruvodce';
        ?>
        <div class="wrap">
            <h1>Místenka</h1>
            <?php echo $notice; // phpcs:ignore -- sestaveno výše s escapováním ?>
            <?php if ($appError) : ?>
                <div class="notice notice-error"><p><b>Aplikace se nenačetla:</b> <?php echo esc_html($appError); ?></p></div>
            <?php endif; ?>
            <?php if (!TestMode::answered()) : ?>
                <div class="notice notice-warning" style="padding:10px 12px">
                    <p><b>Je tento web ostrý, nebo testovací?</b> Místenka už nemá zvláštní balíček s falešnou bankou – testovací web zapne <b>testovací režim</b> (oddělená testovací databáze, simulované nebo ostré platby; přepíná ho pak admin v portálu, Admin → Testování).</p>
                    <form method="post" style="display:flex;gap:8px;flex-wrap:wrap">
                        <?php wp_nonce_field('mistenka_admin'); ?>
                        <button class="button button-primary" name="mistenka_site_kind" value="production">Ostrý web</button>
                        <button class="button" name="mistenka_site_kind" value="test"<?php echo TestMode::locked() ? ' disabled' : ''; ?>>Testovací web – zapnout testovací režim</button>
                    </form>
                </div>
            <?php endif; ?>
            <nav class="nav-tab-wrapper" style="margin-bottom:16px">
                <a href="<?php echo esc_url(self::url('pruvodce')); ?>" class="nav-tab<?php echo $tab === 'pruvodce' ? ' nav-tab-active' : ''; ?>">Průvodce nastavením<?php echo $allDone ? '' : ' (' . count(array_filter($done)) . '/' . count($done) . ')'; ?></a>
                <a href="<?php echo esc_url(self::url('stav')); ?>" class="nav-tab<?php echo $tab === 'stav' ? ' nav-tab-active' : ''; ?>">Stav</a>
            </nav>
            <?php
            if ($tab === 'pruvodce') self::wizard($app, $appUrl, $htaccess, $cronAt, $done, $allDone, $setupLink, $typedUrl);
            else self::status($app, $appUrl, $htaccess);
            ?>
        </div>
        <?php
    }

    private static function wizard(?App $app, string $appUrl, string $htaccess, int $cronAt, array $done, bool $allDone, ?array $setupLink, ?string $typedUrl): void
    {
        $source = Plugin::appUrlSource();
        $check = Plugin::lastAppUrlCheck();
        $cronUrl = $appUrl . '/?rest_route=/' . App::NS . '/jobs/run';
        if ($allDone) {
            echo self::notice('success', 'Instalace je nastavená. Organizaci, revíry, e-maily a role spravujete v <a href="' . esc_url($appUrl . '/manage.html') . '" target="_blank">manažerském portálu</a>.'); // phpcs:ignore
        } else {
            echo '<p>Aplikace běží na vlastní subdoméně (například <code>mistenka.vasemo.cz</code>), která míří do složky tohoto WordPressu. Projděte kroky níže; organizaci, revíry a e-maily pak nastavíte v manažerském portálu.</p>';
        }

        // 1. Adresa aplikace
        self::stepStart(1, 'Adresa aplikace', $done['url']);
        echo '<p>Subdoménu nejdřív založte v administraci hostingu tak, aby mířila do složky tohoto WordPressu, a zapněte pro ni HTTPS. Na adrese se pak místo webu zobrazí Místenka; používá se i v odkazech v e-mailech.</p>';
        if ($source === 'constant') {
            echo '<p>' . self::mark(true) . 'Adresa <a href="' . esc_url($appUrl . '/') . '" target="_blank"><b>' . esc_html($appUrl) . '</b></a> je pevně nastavená ve <code>wp-config.php</code> (<code>MISTENKA_APP_URL</code>). Pro změnu v průvodci konstantu odstraňte.</p>';
        } else {
            $value = $typedUrl ?? ($source === 'option' ? $appUrl : Plugin::suggestAppUrl());
            ?>
            <form method="post">
                <?php wp_nonce_field('mistenka_admin'); ?>
                <p>
                    <input type="text" name="mistenka_app_url" class="regular-text code" value="<?php echo esc_attr($value); ?>" placeholder="https://mistenka.vasemo.cz" spellcheck="false">
                    <button class="button button-primary" name="mistenka_app_url_save" value="1">Uložit a ověřit</button>
                </p>
            </form>
            <?php
            if ($source === 'config') echo '<p class="description">Teď se používá adresa z konfigurace pluginu: <code>' . esc_html($appUrl) . '</code>' . (str_ends_with(strtolower((string) wp_parse_url($appUrl, PHP_URL_HOST)), 'example.cz') ? ' – je to vzorová adresa, zadejte vlastní.' : ($done['url'] ? '. Uložením ji pevně nastavíte pro tuto instalaci.' : '. Potvrďte ji uložením – ověří se, že patří tomuto webu (ZIP může nést adresu jiné instalace, např. produkce na testovacím webu).')) . '</p>';
            if ($source === 'site') echo '<p class="description">Adresa zatím není nastavená – používá se adresa webu.</p>';
        }
        if ($source !== 'constant' && Plugin::sameHostAsSite($appUrl) && $source !== 'site') {
            echo '<p style="color:#b42318">Adresa je stejná jako adresa webu – Místenka převezme jeho úvodní stránku. Hodí se jen pro WordPress vyhrazený Místence.</p>';
        }
        if ($check) {
            echo '<p>' . self::mark($check['ok']) . esc_html($check['message']) . ' <span class="description">(ověřeno ' . esc_html(human_time_diff($check['at'])) . ' zpět)</span></p>';
        }
        if ($done['url']) {
            echo '<form method="post">';
            wp_nonce_field('mistenka_admin');
            echo '<p><button class="button" name="mistenka_app_url_verify" value="1">Ověřit znovu</button> <a class="button" href="' . esc_url($appUrl . '/') . '" target="_blank">Otevřít aplikaci</a></p></form>';
        }
        self::stepEnd();

        // 2. Pravidla .htaccess
        self::stepStart(2, 'Pravidla .htaccess', $done['htaccess']);
        $labels = ['not_needed' => 'nejsou potřeba (frontend leží mimo složku webu, soubory servíruje WordPress)', 'ok' => 'zapsaná a aktuální', 'outdated' => 'zastaralá – zapište je znovu', 'absent' => 'chybí', 'missing' => 'soubor .htaccess neexistuje'];
        echo '<p>Na subdoméně aplikace servíruje Apache stránky a skripty přímo ze složky pluginu (rychlejší). Bez pravidel aplikace funguje také, jen pomaleji.</p>';
        echo '<p>' . self::mark($done['htaccess']) . 'Stav: ' . esc_html($labels[$htaccess]) . '</p>';
        if ($htaccess !== 'not_needed') {
            echo '<form method="post">';
            wp_nonce_field('mistenka_admin');
            echo '<p><button class="button' . ($done['htaccess'] ? '' : ' button-primary') . '" name="mistenka_htaccess" value="1">Zapsat pravidla .htaccess</button></p></form>';
            echo '<details><summary>Pravidla pro ruční vložení</summary><p class="description">Na začátek souboru <code>' . esc_html(ABSPATH . '.htaccess') . '</code>.</p>';
            echo '<pre style="background:#f6f7f7;padding:12px;border:1px solid #ccd0d4;overflow:auto">' . esc_html(implode("\n", Plugin::htaccessLines())) . '</pre></details>';
        }
        self::stepEnd();

        // 3. Cron hostingu
        self::stepStart(3, 'Plánované úlohy (cron hostingu)', $done['cron']);
        echo '<p>Platby, připomínky, uzávěrky, zálohy a e-maily zpracovává úloha, kterou má cron hostingu spouštět <b>každou minutu</b>.</p>';
        echo '<p><b>PHP cron</b> (doporučeno, bez klíče – skript nejde spustit z webu), PHP soubor:</p>';
        echo '<pre style="background:#f6f7f7;padding:12px;border:1px solid #ccd0d4;overflow:auto">' . esc_html(MISTENKA_DIR . 'cron.php') . '</pre>';
        echo '<p><b>Nebo příkaz</b> (cron, který umí POST s hlavičkou; potřebuje konstantu <code>MISTENKA_CRON_KEY</code> ve wp-config.php):</p>';
        echo '<pre style="background:#f6f7f7;padding:12px;border:1px solid #ccd0d4;overflow:auto">curl -fsS -X POST -H "X-Mistenka-Cron-Key: &lt;MISTENKA_CRON_KEY&gt;" "' . esc_html($cronUrl) . '"</pre>';
        if ($cronAt > 0) echo '<p>' . self::mark($done['cron']) . 'Poslední běh z cronu hostingu: před ' . esc_html(human_time_diff($cronAt)) . ($done['cron'] ? '' : ' – cron neběží pravidelně, zkontrolujte jeho nastavení.') . '</p>';
        else echo '<p>' . self::mark(false) . 'Cron hostingu zatím neběžel. Po nastavení stránku obnovte.</p>';
        echo '<p class="description">Jako záloha běží úlohy i přes WP-cron každých 5 minut (jen když web někdo navštíví).</p>';
        self::stepEnd();

        // 4. První admin
        self::stepStart(4, 'První admin Místenky', $done['admin']);
        if (!$app) {
            echo '<p>' . self::mark(false) . 'Aplikace se nenačetla – viz chyba nahoře.</p>';
        } elseif ($done['admin']) {
            echo '<p>' . self::mark(true) . 'Admin existuje. Přihlášení: <a href="' . esc_url($appUrl . '/manage.html') . '" target="_blank">manažerský portál</a>.</p>';
        } else {
            echo '<p>Vygenerujte jednorázový odkaz na průvodce (platí 60 minut, jen jednou); admin vznikne rovnou s dvoufázovým ověřením.' . ($done['url'] ? '' : ' <b>Nejdřív nastavte adresu aplikace</b> – odkaz na ní vede.') . '</p>';
            if ($setupLink) {
                echo '<p><input type="text" class="large-text code" readonly value="' . esc_attr($setupLink['link']) . '" onclick="this.select()"></p>';
                echo '<p><a class="button button-primary" href="' . esc_url($setupLink['link']) . '" target="_blank">Otevřít průvodce</a></p>';
            } else {
                echo '<form method="post">';
                wp_nonce_field('mistenka_admin');
                echo '<p><button class="button button-primary" name="mistenka_setup" value="1">Vygenerovat odkaz</button></p></form>';
            }
        }
        self::stepEnd();
    }

    private static function status(?App $app, string $appUrl, string $htaccess): void
    {
        $dataDir = Env::dataDir();
        $sources = ['constant' => 'konstanta MISTENKA_APP_URL ve wp-config.php', 'option' => 'nastaveno v průvodci', 'config' => 'z konfigurace pluginu (organization.appUrl)', 'site' => 'adresa webu – nastavte v průvodci'];
        echo '<p>Organizaci, revíry, e-mailové účty a role spravujete v <a href="' . esc_url($appUrl . '/manage.html') . '" target="_blank">manažerském portálu</a>.</p>';
        echo '<table class="form-table" role="presentation">';
        echo self::row('Adresa aplikace', '<a href="' . esc_url($appUrl . '/') . '" target="_blank">' . esc_html($appUrl) . '</a> <span class="description">(' . esc_html($sources[Plugin::appUrlSource()]) . ' · <a href="' . esc_url(self::url('pruvodce')) . '">změnit</a>)</span>', !Plugin::appUrlNeedsSetup());
        echo self::row('Verze', esc_html(MISTENKA_VERSION . ' · schéma ' . Db::SCHEMA_VERSION . ' · PHP ' . PHP_VERSION));
        echo self::row('Konfigurace', esc_html(Env::configFile()), is_readable(Env::configFile()));
        echo self::row('Datová složka (zálohy)', esc_html($dataDir), is_dir($dataDir) && is_writable($dataDir));
        $fio = $app && $app->config['payment']['provider'] === 'fio';
        // Falešná banka mimo vývojový režim = kdokoli může „zaplatit“ místenku přes /dev/payments.
        echo self::row('Platby', $app ? esc_html($fio ? 'Fio API' . (Env::fioToken() ? '' : ' – chybí MISTENKA_FIO_TOKEN') : 'falešná banka – jen pro vývoj, platby jde simulovat!') : '—', $app ? ($fio ? Env::fioToken() !== '' : Env::dev()) : null);
        echo self::row('Podklad mapy revíru', Env::mapyApiKey() !== '' ? 'Mapy.com (MISTENKA_MAPY_API_KEY)' : 'OpenStreetMap – pro Mapy.com doplňte konstantu <code>MISTENKA_MAPY_API_KEY</code> ve wp-config.php', Env::mapyApiKey() !== '' ? true : null);
        echo self::row('Klíč pro cron', Env::cronKey() !== '' ? 'nastaven' : 'není (stačí PHP cron; pro volání přes URL doplňte <code>MISTENKA_CRON_KEY</code> ve wp-config.php)', Env::cronKey() !== '' ? true : null);
        $cronAt = (int) get_option(Plugin::CRON_OPTION, 0);
        echo self::row('Cron hostingu', $cronAt ? 'poslední běh před ' . esc_html(human_time_diff($cronAt)) : 'zatím neběžel', $cronAt > 0 && time() - $cronAt < self::CRON_FRESH);
        $missing = Mailer::missing();
        echo self::row('Odesílání e-mailů', esc_html((Env::mailTransport() === 'file' ? 'jen do datové složky (MISTENKA_MAIL_TRANSPORT = file)' : 'vlastní SMTP klient přes účty z portálu (Admin → Emailoví klienti)') . ($missing ? ' – nenastaveno: chybí odesílatelé nebo příjemci upozornění' : ' – nastaveno')), !$missing);
        echo self::row('Spuštění služby', Db::serviceLaunched() ? 'spuštěno' : 'zatím ne – rybáři vidí uzavřenou sezonu; službu spustí otevření první sezony v portálu (po nastavení e-mailů)', Db::serviceLaunched());
        $tm = TestMode::state();
        $tmText = TestMode::locked() ? 'zakázaný na tomto webu (MISTENKA_TEST_MODE ve wp-config.php)'
            : ($tm['enabled'] ? '<b>zapnutý</b> – web běží nad testovací databází, platby v testu: ' . ($tm['payments'] === 'fio' ? 'ostré přes Fio' : 'simulované') : 'vypnutý')
            . (TestMode::locked() ? '' : ' <span class="description">(přepíná admin v portálu: Admin → Testování)</span>');
        echo self::row('Testovací režim', $tmText, $tm['enabled'] ? false : null);
        echo self::row('Vývojový režim', Env::dev() ? '<b>zapnutý</b> (MISTENKA_DEV) – jen pro testovací web!' : 'vypnutý', !Env::dev());
        $labels = ['not_needed' => 'nepoužívají se (frontend mimo složku webu)', 'ok' => 'v pořádku', 'outdated' => 'zastaralá – zapište znovu v průvodci', 'absent' => 'chybí – zapište v průvodci', 'missing' => 'soubor .htaccess neexistuje'];
        echo self::row('Pravidla .htaccess', esc_html($labels[$htaccess]), in_array($htaccess, ['ok', 'not_needed'], true));
        echo '</table>';
    }
}
