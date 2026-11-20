#!/bin/sh
# Instalace WordPressu a aktivace pluginu v lokálním Dockeru (jednou po prvním `docker compose up -d`).
# Reset: docker compose down -v && docker compose up -d && sh setup.sh
set -e
export MSYS_NO_PATHCONV=1  # Git Bash na Windows jinak přepisuje cesty v kontejneru
cd "$(dirname "$0")"
until docker compose exec -T wordpress test -f /var/www/html/wp-config.php; do sleep 2; done
docker compose exec -T wordpress sh -c 'chown www-data:www-data /var/www/mistenka-data'
wp() { docker compose run --rm -T cli wp "$@"; }
wp core is-installed 2>/dev/null || wp core install --url=http://localhost:8088 --title="Místenka (vývoj)" --admin_user=admin --admin_password=admin --admin_email=admin@example.cz --skip-email
wp language core install cs_CZ --activate >/dev/null 2>&1 || true
wp plugin activate mistenka
wp option get siteurl
