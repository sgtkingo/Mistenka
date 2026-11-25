# WordPress plugin (PHP)

Produkční implementace Místenky. Chování je stejné jako u Node verze v `src/node/`: obě dodržují [docs/API.md](../../docs/API.md) a procházejí stejnými testy z `test/` (49 testů, ověřeno proti WordPressu 7.1.4 / PHP 8.3 v Dockeru).

| Plugin | Stav |
| --- | --- |
| `mistenka/` | plný plugin |

## Jak plugin funguje

- **Aplikace na subdoméně.** Na hostu adresy aplikace plugin místo webu vykreslí frontend. Adresa se zadává v **průvodci** (Nastavení → Místenka, otevře se sám po aktivaci) a ukládá se do `wp_options`; pořadí: konstanta `MISTENKA_APP_URL` (volitelné pevné nastavení) → průvodce → `organization.appUrl` z konfigurace → adresa webu. Při aktivaci zapíše na začátek `.htaccess` blok `# BEGIN Mistenka`, který se týká jen tohoto hostu: stránky, styly a skripty servíruje Apache přímo ze složky `frontend/` pluginu, `js/env.js` (prefix API) a REST jdou přes WordPress. Bez pravidel aplikace funguje také, jen soubory servíruje PHP. Stav a pravidla pro ruční vložení: **Nastavení → Místenka**. Změna adresy v průvodci pravidla přepíše pro nový host.
- **REST** `mistenka/v1` (`/?rest_route=/mistenka/v1/...`, web nemá „hezké“ trvalé odkazy). Požadavky obslouží vlastní router dřív, než je WordPress zpracuje (chyby mají tvar `{ error, code }`); CORS hlavičky WordPressu se pro aplikaci vypínají.
- **Účty jsou vlastní** (tabulky `{prefix}mistenka_*`): rybáři ani správci nejsou uživateli WordPressu a nedostanou se do wp-admin. Relace v cookie `mistenka_session` + hlavička `X-Mistenka-Csrf`, hesla `password_hash()`, 2FA (TOTP).
- **Databáze**: tabulky `{prefix}mistenka_*` vytvoří `dbDelta()` při aktivaci a po aktualizaci pluginu (verze schématu v `Db::SCHEMA_VERSION`). Zápisy, které hlídají kapacitu, poukazy a párování plateb, běží v transakci se zámkem `GET_LOCK`.
- **E-maily**: fronta `email_outbox`; odesílá vlastní SMTP klient pluginu (`includes/Smtp.php`, nezávisle na `wp_mail()`, PHPMaileru i pluginech typu WP Mail SMTP) přes účty z portálu (**Admin → Emailoví klienti** – víc účtů, každá skupina e-mailů vlastní odesílatel, příjemci upozornění správcům). Výchozí odesílání neexistuje: skupina bez odesílatele čeká. E-maily vzniklé během požadavku odejdou hned po odeslání odpovědi.
- **Spuštění služby**: čerstvá instalace je zavřená – úvodní stránka ukáže uzavřenou sezonu, rybáři se nemohou registrovat ani přihlásit (správa ano). Službu spustí admin ručním otevřením první sezony, které jde až s nastavenými Emailovými klienty. `organization.json` e-maily nenastavuje.
- **Zálohy**: export tabulek pluginu (`*.json.gz`) do datové složky mimo web; obnova z portálu.
- **Konfigurace**: výchozí hodnoty `config/organization.json` + pravidla ryb (v ZIPu pluginu), změny z portálu se ukládají jako verze do databáze.

## Instalace

1. `python scripts/build-plugin.py` → `dist/mistenka.zip` (PHP + frontend + konfigurace MO z lokálního `config/organization.json`, který není v repu – vytvořte ho z `config/organization.json.example`). Obecný balíček se vzorem: `--example` (tak se staví GitHub release).
2. Adresu subdomény stačí zadat po aktivaci v průvodci (`organization.appUrl` v konfiguraci je jen výchozí hodnota; obecný balíček má vzorovou `mistenka.example.cz`, kterou průvodce označí k přepsání). Ostatní údaje (účet, e-maily, GDPR) jdou změnit i v portálu. ZIP má vždy `payment.provider: "fio"`, i když repo nechává `fake` pro lokální Node. Balíček je jeden pro ostrý i testovací web: **testovací web** zapne v portálu testovací režim (Admin → Testování – oddělená testovací databáze, simulované nebo ostré platby; viz [docs/API.md](../../docs/API.md#testovací-režim)). Na ostrém webu ho lze úplně zakázat konstantou `MISTENKA_TEST_MODE` (níže).
3. wp-config.php (nad řádek „That's all, stop editing!“):

   ```php
   define('MISTENKA_CRON_KEY', '…dlouhý náhodný řetězec…');   // POST /jobs/run z cronu hostingu
   // define('MISTENKA_FIO_TOKEN', '…token Fio jen pro čtení…');  // volitelné – jinak admin zadá token v portálu (Bankovní spojení → Automatické párování, uloží se zašifrovaný)
   define('MISTENKA_SECRET_KEY', '…dlouhý náhodný řetězec…');  // šifrování hesel SMTP účtů a tokenu Fio z portálu (doporučeno; jinak soubor v datové složce)
   // volitelně:
   // define('MISTENKA_APP_URL', 'https://mistenka.rybarikarvina.cz');  // pevná adresa aplikace (jinak průvodce)
   // define('MISTENKA_GITHUB_TOKEN', '…');  // hlášení chyb → GitHub issues (s MISTENKA_GITHUB_REPO)
   // define('MISTENKA_GITHUB_REPO', 'vlastnik/repozitar');
   // define('MISTENKA_TEST_MODE', false);  // ostrý web: testovací režim nejde zapnout
   // define('MISTENKA_MAPY_API_KEY', '…');  // podklad interaktivní mapy revíru z Mapy.com (jinak OpenStreetMap); omezte klíč na doménu
   // define('MISTENKA_DATA_DIR', '/cesta/mimo/web/mistenka-data');  // výchozí wp-content/mistenka-data (+ .htaccess deny)
   ```

   Nikdy nedávejte do produkce `MISTENKA_DEV`, `MISTENKA_RATE_LIMIT = false` ani `MISTENKA_MAIL_TRANSPORT = 'file'`.
4. Nahrát ZIP (Pluginy → Instalace pluginů → Nahrát) a aktivovat.
5. Po aktivaci se otevře **Nastavení → Místenka → Průvodce nastavením**: (1) adresa aplikace – uloží se a hned ověří (plugin si z ní stáhne `js/env.js` s náhodnou výzvou, na kterou správně odpoví jen tato instalace; upozorní na neexistující subdoménu, chybu HTTPS, jiný web i Místenku jiné instalace – např. produkční adresu z ZIPu na testovacím webu). Adresa převzatá z konfigurace v ZIPu platí až po tomto ověření, (2) pravidla .htaccess, (3) cron hostingu – průvodce ukáže čas posledního běhu, (4) tlačítkem **Vygenerovat odkaz** první admin Místenky (průvodce s 2FA, odkaz platí 60 minut). Záložka **Stav** shrnuje instalaci (konfigurace, datová složka, Fio, e-maily, mapa).
6. Cron hostingu každou minutu. Doporučená je **PHP úloha** (Websupport: typ „PHP 8.3 CRON“), PHP soubor `wp-content/plugins/mistenka/cron.php`. Klíč není potřeba, protože skript z webu vrací 404. Pokud hosting umí jen příkaz s POST:

   ```
   curl -fsS -X POST -H "X-Mistenka-Cron-Key: <MISTENKA_CRON_KEY>" "https://mistenka.rybarikarvina.cz/?rest_route=/mistenka/v1/jobs/run"
   ```

   Záložně běží úlohy i přes WP-cron každých 5 minut (jen při návštěvě webu).
7. V portálu: **Admin → Emailoví klienti** – přidat SMTP účet(y) (např. `smtp.websupport.cz`, 465, SSL), otestovat, přiřadit všem skupinám e-mailů a vyplnit příjemce upozornění správcům.
8. **Provoz → Sezona a uzavření → Otevřít sezonu** – první otevřená sezona spustí službu (do té doby je pro rybáře zavřeno).

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
