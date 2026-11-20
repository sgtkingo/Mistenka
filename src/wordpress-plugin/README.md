# WordPress plugin (PHP)

Produkční implementace Místenky. Chování je stejné jako u Node verze v `src/node/`: obě dodržují [docs/API.md](../../docs/API.md) a procházejí stejnými testy z `test/` (47 testů, ověřeno proti WordPressu 7.1.4 / PHP 8.3 v Dockeru).

| Plugin | Stav |
| --- | --- |
| `mistenka/` | plný plugin (v1.0.0) |
| `mistenka-demo/` | ověřovací plugin z 11/2026 (subdoména, REST, DB, e-mail) – po nasazení `mistenka` odinstalovat |

## Jak plugin funguje

- **Aplikace na subdoméně.** Na hostu z `organization.appUrl` (nebo `MISTENKA_APP_URL`) plugin místo webu vykreslí frontend. Při aktivaci zapíše na začátek `.htaccess` blok `# BEGIN Mistenka`, který se týká jen tohoto hostu: stránky, styly a skripty servíruje Apache přímo ze složky `frontend/` pluginu, `js/env.js` (prefix API) a REST jdou přes WordPress. Bez pravidel aplikace funguje také, jen soubory servíruje PHP. Stav a pravidla pro ruční vložení: **Nastavení → Místenka**.
- **REST** `mistenka/v1` (`/?rest_route=/mistenka/v1/...`, web nemá „hezké“ trvalé odkazy). Požadavky obslouží vlastní router dřív, než je WordPress zpracuje (chyby mají tvar `{ error, code }`); CORS hlavičky WordPressu se pro aplikaci vypínají.
- **Účty jsou vlastní** (tabulky `{prefix}mistenka_*`): rybáři ani správci nejsou uživateli WordPressu a nedostanou se do wp-admin. Relace v cookie `mistenka_session` + hlavička `X-Mistenka-Csrf`, hesla `password_hash()`, 2FA (TOTP).
- **Databáze**: tabulky `{prefix}mistenka_*` vytvoří `dbDelta()` při aktivaci a po aktualizaci pluginu (verze schématu v `Db::SCHEMA_VERSION`). Zápisy, které hlídají kapacitu, poukazy a párování plateb, běží v transakci se zámkem `GET_LOCK`.
- **E-maily**: fronta `email_outbox`; odesílá se přes SMTP účty z portálu (**Admin → Emailoví klienti**, PHPMailer z WordPressu – víc účtů, každá skupina e-mailů vlastní odesílatel), skupina bez účtu přes `wp_mail()`. Plugin WP Mail SMTP už není potřeba. E-maily vzniklé během požadavku odejdou hned po odeslání odpovědi.
- **Zálohy**: export tabulek pluginu (`*.json.gz`) do datové složky mimo web; obnova z portálu.
- **Konfigurace**: výchozí hodnoty `config/organization.json` + pravidla ryb (v ZIPu pluginu), změny z portálu se ukládají jako verze do databáze.

## Instalace

1. `python scripts/build-plugin.py` → `dist/mistenka.zip` (PHP + frontend + výchozí konfigurace).
2. Před sestavením zkontrolujte `config/organization.json`: `organization.appUrl` (adresa subdomény), `payment` (účet, **`provider: "fio"`** pro ostrý provoz – `fake` je jen pro vývoj).
3. wp-config.php (nad řádek „That's all, stop editing!“):

   ```php
   define('MISTENKA_CRON_KEY', '…dlouhý náhodný řetězec…');   // POST /jobs/run z cronu hostingu
   define('MISTENKA_FIO_TOKEN', '…token Fio jen pro čtení…');   // jen při provider = "fio"
   define('MISTENKA_SECRET_KEY', '…dlouhý náhodný řetězec…');  // šifrování hesel SMTP účtů (doporučeno; jinak soubor v datové složce)
   // volitelně:
   // define('MISTENKA_APP_URL', 'https://mistenka.rybarikarvina.cz');
   // define('MISTENKA_DATA_DIR', '/cesta/mimo/web/mistenka-data');  // výchozí wp-content/mistenka-data (+ .htaccess deny)
   ```

   Nikdy nedávejte do produkce `MISTENKA_DEV`, `MISTENKA_RATE_LIMIT = false` ani `MISTENKA_MAIL_TRANSPORT = 'file'`.
4. Nahrát ZIP (Pluginy → Instalace pluginů → Nahrát) a aktivovat.
5. **Nastavení → Místenka**: zkontrolovat stav (konfigurace, datová složka, .htaccess, cron, Fio) a tlačítkem **Vygenerovat odkaz** založit prvního admina Místenky (průvodce s 2FA, odkaz platí 60 minut).
6. Cron hostingu každou minutu:

   ```
   curl -fsS -X POST -H "X-Mistenka-Cron-Key: <MISTENKA_CRON_KEY>" "https://mistenka.rybarikarvina.cz/?rest_route=/mistenka/v1/jobs/run"
   ```

   Záložně běží úlohy i přes WP-cron každých 5 minut (jen při návštěvě webu).
7. V portálu: **Admin → Emailoví klienti** – přidat SMTP účet(y) (např. `smtp.websupport.cz`, 465, SSL), otestovat a přiřadit skupinám e-mailů.

Postup ověřit nejdřív na `test.rybarikarvina.cz`. Smazání pluginu data nemaže (místenky podléhají evidenci); úplné smazání jen s `define('MISTENKA_UNINSTALL_DELETE_DATA', true)`.

## Lokální vývoj a testy (Docker)

Prostředí ve [dev/wordpress](../../dev/wordpress): WordPress 7.1.4 + PHP 8.3 (jako produkce) a MariaDB. Plugin, frontend i testovací konfigurace jsou přimountované z repozitáře, změny platí hned.

```bash
cd dev/wordpress
docker compose up -d && sh setup.sh      # http://localhost:8088 (aplikace), /wp-admin (admin / admin)
sh reset.sh                              # čistá data pluginu (sdílené testy počítají s prázdnou databází)
node ../../test/api.test.js --base "http://localhost:8088/?rest_route=/mistenka/v1"
```

V Dockeru je zapnutý vývojový režim (`MISTENKA_DEV`, falešná banka, e-maily jen do datové složky, vypnuté limity požadavků). Ladicí log PHP: `docker compose exec wordpress tail /var/www/html/wp-content/debug.log`.

Struktura `mistenka/includes/` odpovídá modulům Node: `Service` (místenky, platby, limity, porybný, správa) ↔ `service.js`, `Accounts` ↔ `accounts.js`, `Operations`, `Settings`, `Reports`, `Backups`, `Retention`, `Mailer` ↔ `mail-accounts.js`, `Emails` (šablony), `App` (router ↔ `server.js`), `Plugin` (aktivace, subdoména, .htaccess), `Admin` (stránka ve wp-admin).
