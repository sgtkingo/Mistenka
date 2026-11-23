<?php
/**
 * Plugin Name: Místenka
 * Description: Online rybářské místenky – prodej, platba převodem (QR + Fio), kontrola, odevzdání úlovků a manažerský portál. Aplikace běží na vlastní (sub)doméně.
 * Version: 1.3.1
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * Author: Ing. Jiří Konečný
 * License: Proprietární – viz LICENSE.md
 * Text Domain: mistenka
 */

defined('ABSPATH') || exit;

define('MISTENKA_VERSION', '1.3.1');
define('MISTENKA_DIR', plugin_dir_path(__FILE__));

foreach (['Util', 'Time', 'Db', 'Config', 'Settings', 'Emails', 'Smtp', 'Mailer', 'Payments', 'Accounts', 'Operations', 'Service', 'Reports', 'Backups', 'Retention', 'Bugs', 'App', 'Plugin', 'Admin'] as $mistenka_file) {
    require_once MISTENKA_DIR . 'includes/' . $mistenka_file . '.php';
}
unset($mistenka_file);

register_activation_hook(__FILE__, [Mistenka\Plugin::class, 'activate']);
register_deactivation_hook(__FILE__, [Mistenka\Plugin::class, 'deactivate']);
Mistenka\Plugin::boot();
