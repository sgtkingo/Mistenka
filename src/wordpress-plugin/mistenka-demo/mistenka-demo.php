<?php
/**
 * Plugin Name: Místenka Demo
 * Description: Testovací plugin pro ověření subdomény, databáze, REST API a odesílání e-mailů před nasazením aplikace Místenka.
 * Version: 0.2.0
 * Requires PHP: 7.4
 * Author: Místenka
 * Text Domain: mistenka-demo
 */

if (!defined('ABSPATH')) {
    exit;
}

define('MISTENKA_DEMO_VERSION', '0.2.0');
define('MISTENKA_DEMO_OPTION', 'mistenka_demo_settings');

function mistenka_demo_table() {
    global $wpdb;
    return $wpdb->prefix . 'mistenka_demo';
}

function mistenka_demo_settings() {
    $defaults = [
        'app_host'   => 'mistenka.rybarikarvina.cz',
        'from_email' => 'mistenka@rybarikarvina.cz',
        'from_name'  => 'Místenka',
    ];
    return wp_parse_args((array) get_option(MISTENKA_DEMO_OPTION, []), $defaults);
}

/* ---------- Aktivace: vytvoření testovací tabulky ---------- */

register_activation_hook(__FILE__, function () {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = mistenka_demo_table();
    $charset = $wpdb->get_charset_collate();
    dbDelta("CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        message VARCHAR(200) NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY  (id)
    ) {$charset};");
    add_option(MISTENKA_DEMO_OPTION, mistenka_demo_settings());
});

/* ---------- Detekce subdomény ---------- */

function mistenka_demo_is_app_host() {
    $host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
    $app  = strtolower(trim(mistenka_demo_settings()['app_host']));
    return $app !== '' && $host === $app;
}

// WordPress by jinak přesměroval subdoménu na hlavní doménu.
add_filter('redirect_canonical', function ($redirect) {
    return mistenka_demo_is_app_host() ? false : $redirect;
});

// Na subdoméně místo webu vykreslíme samostatnou stránku aplikace.
add_action('template_redirect', function () {
    if (!mistenka_demo_is_app_host()) {
        return;
    }
    status_header(200);
    nocache_headers();
    header('Content-Type: text/html; charset=utf-8');
    echo mistenka_demo_page(true);
    exit;
});

// Shortcode pro test na běžné stránce hlavního webu: [mistenka_demo]
add_shortcode('mistenka_demo', function () {
    return mistenka_demo_page(false);
});

function mistenka_demo_page($standalone) {
    // Relativní cesta, aby volání šlo na stejný host (subdoménu). Bez „hezkých“
    // trvalých odkazů /wp-json/ nefunguje, proto fallback na ?rest_route=.
    $api = get_option('permalink_structure') ? '/wp-json/mistenka-demo/v1' : '/?rest_route=/mistenka-demo/v1';
    ob_start();
    if ($standalone) : ?>
<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Místenka – test</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f5;color:#1d2a25}
main{max-width:640px;margin:0 auto;padding:32px 16px}
</style>
</head>
<body><main>
<?php endif; ?>
<div class="mistenka-demo" style="font-family:system-ui,sans-serif">
  <style>
    .mistenka-demo h1{font-size:1.6rem;margin:0 0 4px}
    .mistenka-demo .card{background:#fff;border:1px solid #d9e0dc;border-radius:10px;padding:16px;margin:16px 0}
    .mistenka-demo .row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #eef1ef}
    .mistenka-demo .ok{color:#1b7a43;font-weight:600}.mistenka-demo .err{color:#b42318;font-weight:600}
    .mistenka-demo button{background:#1f6f4a;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:1rem;cursor:pointer}
    .mistenka-demo input{padding:9px;border:1px solid #c4ccc8;border-radius:8px;font-size:1rem;width:100%;box-sizing:border-box;margin-bottom:8px}
    .mistenka-demo ul{padding-left:18px}
  </style>
  <h1>Místenka – technický test</h1>
  <p>Ověření běhu pluginu, REST API a databáze.</p>

  <div class="card" id="md-status"><b>Stav serveru</b><div>Načítám…</div></div>

  <div class="card">
    <b>Test zápisu do databáze</b>
    <input id="md-msg" maxlength="200" placeholder="Testovací zpráva" value="Ahoj z Místenky">
    <button id="md-write" type="button">Zapsat do DB</button>
    <ul id="md-list"></ul>
  </div>
</div>
<script>
(function () {
  var api = <?php echo wp_json_encode($api); ?>;
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function row(k, v, ok) { return '<div class="row"><span>' + esc(k) + '</span><span class="' + (ok === false ? 'err' : ok ? 'ok' : '') + '">' + esc(v) + '</span></div>'; }
  function load() {
    fetch(api + '/ping').then(function (r) { return r.json(); }).then(function (d) {
      document.querySelector('#md-status div').innerHTML =
        row('Plugin', d.plugin, true) + row('Host požadavku', d.host) + row('HTTPS', d.https ? 'ano' : 'ne', d.https) +
        row('Databáze', d.db ? 'připojeno (' + d.rows + ' záznamů)' : 'tabulka chybí', d.db) +
        row('PHP', d.php) + row('WordPress', d.wp) + row('Čas serveru', d.time);
      document.getElementById('md-list').innerHTML = (d.latest || []).map(function (e) {
        return '<li>' + esc(e.created_at) + ' – ' + esc(e.message) + '</li>';
      }).join('');
    }).catch(function (e) {
      document.querySelector('#md-status div').innerHTML = '<span class="err">REST API nedostupné: ' + esc(e.message) + '</span>';
    });
  }
  document.getElementById('md-write').addEventListener('click', function () {
    fetch(api + '/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: document.getElementById('md-msg').value }) })
      .then(function (r) { return r.json(); }).then(load);
  });
  load();
})();
</script>
<?php if ($standalone) : ?>
</main></body></html>
<?php endif;
    return ob_get_clean();
}

/* ---------- REST API ---------- */

add_action('rest_api_init', function () {
    register_rest_route('mistenka-demo/v1', '/ping', [
        'methods'             => 'GET',
        'permission_callback' => '__return_true',
        'callback'            => function () {
            global $wpdb;
            $table  = mistenka_demo_table();
            $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;
            return [
                'plugin' => MISTENKA_DEMO_VERSION,
                'host'   => sanitize_text_field($_SERVER['HTTP_HOST'] ?? ''),
                'https'  => is_ssl(),
                'db'     => $exists,
                'rows'   => $exists ? (int) $wpdb->get_var("SELECT COUNT(*) FROM {$table}") : 0,
                'latest' => $exists ? $wpdb->get_results("SELECT message, created_at FROM {$table} ORDER BY id DESC LIMIT 5") : [],
                'php'    => PHP_VERSION,
                'wp'     => get_bloginfo('version'),
                'time'   => current_time('mysql'),
            ];
        },
    ]);

    register_rest_route('mistenka-demo/v1', '/entries', [
        'methods'             => 'POST',
        'permission_callback' => '__return_true',
        'callback'            => function (WP_REST_Request $request) {
            global $wpdb;
            $message = mb_substr(sanitize_text_field((string) $request->get_param('message')), 0, 200);
            if ($message === '') {
                return new WP_Error('empty', 'Zpráva je prázdná.', ['status' => 400]);
            }
            // Ochrana proti zahlcení: max. 1 zápis za 5 s z jedné IP.
            $key = 'mistenka_demo_rl_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
            if (get_transient($key)) {
                return new WP_Error('rate_limited', 'Zkuste to za chvíli.', ['status' => 429]);
            }
            set_transient($key, 1, 5);
            $wpdb->insert(mistenka_demo_table(), ['message' => $message, 'created_at' => current_time('mysql')]);
            return ['ok' => true, 'id' => (int) $wpdb->insert_id];
        },
    ]);
});

/* ---------- E-mail ----------
 * Odesílání zajišťuje plugin WP Mail SMTP; tento plugin jen volá wp_mail().
 */

function mistenka_demo_smtp_active() {
    return function_exists('wp_mail_smtp');
}

/* ---------- Administrace: nastavení a test e-mailu ---------- */

add_action('admin_menu', function () {
    add_management_page('Místenka demo', 'Místenka demo', 'manage_options', 'mistenka-demo', 'mistenka_demo_admin_page');
});

$mistenka_demo_mail_error = null;
add_action('wp_mail_failed', function ($error) {
    global $mistenka_demo_mail_error;
    $mistenka_demo_mail_error = $error->get_error_message();
});

function mistenka_demo_admin_page() {
    global $mistenka_demo_mail_error;
    if (!current_user_can('manage_options')) {
        return;
    }
    $notice = '';

    if (isset($_POST['mistenka_demo_save']) && check_admin_referer('mistenka_demo_save')) {
        update_option(MISTENKA_DEMO_OPTION, [
            'app_host'   => sanitize_text_field(wp_unslash($_POST['app_host'] ?? '')),
            'from_email' => sanitize_email(wp_unslash($_POST['from_email'] ?? '')),
            'from_name'  => sanitize_text_field(wp_unslash($_POST['from_name'] ?? '')),
        ]);
        $notice = '<div class="notice notice-success"><p>Nastavení uloženo.</p></div>';
    }

    $s = mistenka_demo_settings();

    if (isset($_POST['mistenka_demo_mail']) && check_admin_referer('mistenka_demo_mail')) {
        $to = sanitize_email(wp_unslash($_POST['to'] ?? ''));
        $headers = [
            'Content-Type: text/html; charset=UTF-8',
            sprintf('From: %s <%s>', $s['from_name'], $s['from_email']),
        ];
        $body = '<p>Dobrý den,</p><p>toto je testovací e-mail z pluginu <b>Místenka demo</b>.</p>'
              . '<p>Odesláno: ' . esc_html(current_time('mysql')) . '<br>Server: ' . esc_html(home_url()) . '</p>'
              . '<p style="color:#777">Tato zpráva byla odeslána automaticky, neodpovídejte na ni.</p>';
        $sent = is_email($to) && wp_mail($to, 'Místenka – testovací e-mail', $body, $headers);
        $notice = $sent
            ? '<div class="notice notice-success"><p>E-mail odeslán na ' . esc_html($to) . '. Zkontrolujte doručenou poštu i spam.</p></div>'
            : '<div class="notice notice-error"><p>Odeslání selhalo' . ($mistenka_demo_mail_error ? ': ' . esc_html($mistenka_demo_mail_error) : '.') . '</p></div>';
    }
    ?>
    <div class="wrap">
        <h1>Místenka demo</h1>
        <?php echo $notice; // phpcs:ignore -- vytvořeno výše s escapováním ?>

        <h2>Nastavení</h2>
        <form method="post">
            <?php wp_nonce_field('mistenka_demo_save'); ?>
            <table class="form-table">
                <tr><th><label for="app_host">Doména aplikace</label></th>
                    <td><input class="regular-text" id="app_host" name="app_host" value="<?php echo esc_attr($s['app_host']); ?>">
                    <p class="description">Na této (sub)doméně se místo webu zobrazí stránka aplikace. Na hlavním webu lze použít shortcode <code>[mistenka_demo]</code>.</p></td></tr>
                <tr><th><label for="from_email">Odesílatel – e-mail</label></th>
                    <td><input class="regular-text" id="from_email" name="from_email" type="email" value="<?php echo esc_attr($s['from_email']); ?>"></td></tr>
                <tr><th><label for="from_name">Odesílatel – jméno</label></th>
                    <td><input class="regular-text" id="from_name" name="from_name" value="<?php echo esc_attr($s['from_name']); ?>"></td></tr>
            </table>
            <p><button class="button button-primary" name="mistenka_demo_save" value="1">Uložit</button></p>
        </form>

        <h2>Test e-mailu</h2>
        <form method="post">
            <?php wp_nonce_field('mistenka_demo_mail'); ?>
            <p><input class="regular-text" name="to" type="email" required placeholder="vas@email.cz"
                      value="<?php echo esc_attr(wp_get_current_user()->user_email); ?>">
               <button class="button" name="mistenka_demo_mail" value="1">Poslat testovací e-mail</button></p>
            <p class="description">
                <?php if (mistenka_demo_smtp_active()) : ?>
                    <span style="color:#1b7a43">✔ Odesílá se přes plugin WP Mail SMTP.</span>
                <?php else : ?>
                    <span style="color:#b42318">✘ Plugin WP Mail SMTP není aktivní – e-maily jdou přes PHP mail() a mohou končit ve spamu.</span>
                <?php endif; ?>
            </p>
        </form>

        <h2>Rychlé odkazy</h2>
        <ul>
            <li><a href="<?php echo esc_url('https://' . $s['app_host'] . '/'); ?>" target="_blank">Otevřít aplikaci na <?php echo esc_html($s['app_host']); ?></a></li>
            <li><a href="<?php echo esc_url(rest_url('mistenka-demo/v1/ping')); ?>" target="_blank">REST endpoint /ping</a></li>
        </ul>
    </div>
    <?php
}
