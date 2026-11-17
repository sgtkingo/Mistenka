<?php
// Spustí se při smazání pluginu v administraci: odstraní testovací tabulku a nastavení.
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
global $wpdb;
$wpdb->query("DROP TABLE IF EXISTS {$wpdb->prefix}mistenka_demo");
delete_option('mistenka_demo_settings');
