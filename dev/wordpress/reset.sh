#!/bin/sh
# Smaže data pluginu Místenka (tabulky, nastavení, zálohy) a znovu ho aktivuje – čistý stav pro sdílené testy:
#   sh dev/wordpress/reset.sh && node test/api.test.js --base "http://localhost:8088/?rest_route=/mistenka/v1"
set -e
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
docker compose run --rm -T cli wp eval 'Mistenka\Db::uninstall(); foreach (["mistenka_db_version","mistenka_dev_clock","mistenka_fake_bank_queue","mistenka_last_payment_sync"] as $o) delete_option($o);' 2>&1 | grep -v Container || true
docker compose exec -T wordpress sh -c 'rm -rf /var/www/mistenka-data/backups /var/www/mistenka-data/outbox; mkdir -p /var/www/mistenka-data; chown -R www-data:www-data /var/www/mistenka-data'
docker compose run --rm -T cli wp plugin deactivate mistenka 2>&1 | grep -v Container || true
docker compose run --rm -T cli wp plugin activate mistenka 2>&1 | grep -v Container
