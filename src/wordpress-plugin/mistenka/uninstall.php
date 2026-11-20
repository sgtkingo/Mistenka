<?php
// Smazání pluginu v administraci. Data (místenky, platby, účty) se mažou jen tehdy, když je ve wp-config.php
// define('MISTENKA_UNINSTALL_DELETE_DATA', true) – místenky podléhají evidenci a účetním lhůtám.
// Zálohy v datové složce zůstávají vždy.
defined('WP_UNINSTALL_PLUGIN') || exit;

foreach (['mistenka_db_version', 'mistenka_dev_clock', 'mistenka_fake_bank_queue', 'mistenka_last_payment_sync'] as $option) delete_option($option);
wp_clear_scheduled_hook('mistenka_jobs');

if (defined('MISTENKA_UNINSTALL_DELETE_DATA') && MISTENKA_UNINSTALL_DELETE_DATA) {
    define('MISTENKA_DIR', plugin_dir_path(__FILE__));
    require_once MISTENKA_DIR . 'includes/Util.php';
    require_once MISTENKA_DIR . 'includes/Db.php';
    Mistenka\Db::uninstall();
}
