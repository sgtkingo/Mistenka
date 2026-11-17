# WordPress plugin (PHP)

Produkční implementace Místenky. Node verze v `src/node/` je referenční; PHP musí dodržet [docs/API.md](../../docs/API.md) a projít testy z `test/`.

| Plugin | Stav |
| --- | --- |
| `mistenka-demo/` | ověřovací plugin (subdoména, REST, DB, e-mail) – nasazen na rybarikarvina.cz |
| `mistenka/` | plný plugin – zatím nevznikl, viz postup níže |

## Postup převodu

1. **Frontend:** plugin převezme `src/frontend/` při sestavení (`scripts/build-plugin.py`) a místo `js/env.js` vloží `{ apiBase: "/?rest_route=/mistenka/v1" }`. Na subdoméně aplikace vykreslí `src/frontend/*.html` (detekce hostu jako v `mistenka-demo`).
2. **Konfigurace:** obsah `config/organization.json` jako nastavení pluginu (JSON v `wp_options` + administrace). Token Fio a klíč cronu v `wp-config.php` (`MISTENKA_FIO_TOKEN`, `MISTENKA_CRON_KEY`), nikdy v databázi ani v repozitáři.
3. **Databáze:** tabulky podle `src/node/lib/db.js` s prefixem `{$wpdb->prefix}mistenka_`, vytvoření přes `dbDelta()` při aktivaci. Transakce pro kapacitu, poukazy a párování (`START TRANSACTION` + `SELECT … FOR UPDATE`).
4. **REST:** namespace `mistenka/v1`, endpointy a chybové kódy podle API.md. Logika podle `src/node/lib/service.js`, čas podle `src/node/lib/time.js` (`DateTimeImmutable` + `Europe/Prague`).
5. **E-maily:** fronta `email_outbox`, odeslání přes `wp_mail()` (SMTP zajišťuje WP Mail SMTP). Šablony podle `src/node/lib/emails.js`.
6. **Cron:** cron hostingu volá `POST /?rest_route=/mistenka/v1/jobs/run` s hlavičkou `X-Mistenka-Cron-Key`; na `wp-cron` nespoléhat.
7. **Vývojový režim:** konstanta `MISTENKA_DEV` zapne endpointy `/dev/*` – jen na `test.rybarikarvina.cz`.
8. **Testy:** na testovacím webu s konfigurací `test/fixtures/organization.test.json`:
   `node test/api.test.js --base "https://test.rybarikarvina.cz/?rest_route=/mistenka/v1"`
