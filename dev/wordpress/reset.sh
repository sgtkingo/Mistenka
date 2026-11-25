#!/bin/sh
# Smaže data pluginu Místenka (tabulky, nastavení, zálohy) a znovu ho aktivuje – čistý stav pro sdílené testy:
#   sh dev/wordpress/reset.sh && node test/api.test.js --base "http://localhost:8088/?rest_route=/mistenka/v1"
set -e
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
docker compose run --rm -T cli wp eval 'Mistenka\Db::uninstall(); Mistenka\Db::useTest(true); Mistenka\Db::uninstall(); Mistenka\Db::useTest(false); foreach (["mistenka_test_mode","mistenka_test_db_version","mistenka_fake_bank_queue_test","mistenka_last_payment_sync_test","mistenka_db_version","mistenka_dev_clock","mistenka_fake_bank_queue","mistenka_last_payment_sync","mistenka_app_url","mistenka_app_url_check","mistenka_last_hosting_cron"] as $o) delete_option($o);' 2>&1 | grep -v Container || true
docker compose exec -T wordpress sh -c 'rm -rf /var/www/mistenka-data/backups /var/www/mistenka-data/outbox /var/www/mistenka-data/test; mkdir -p /var/www/mistenka-data; chown -R www-data:www-data /var/www/mistenka-data'
docker compose run --rm -T cli wp plugin deactivate mistenka 2>&1 | grep -v Container || true
docker compose run --rm -T cli wp plugin activate mistenka 2>&1 | grep -v Container
