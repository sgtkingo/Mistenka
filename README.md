# Místenka

Webová aplikace pro online prodej, kontrolu a odevzdání rybářských místenek. Jedna instalace slouží jedné místní organizaci (MO) s jedním nebo více revíry; vše, co se liší mezi organizacemi a revíry, je v konfiguraci.

## Struktura

| Složka | Obsah |
| --- | --- |
| `src/frontend/` | uživatelské rozhraní (HTML, JS, CSS) – **jediná kopie**, sdílená oběma servery |
| `src/node/` | Node.js server se SQLite pro lokální vývoj |
| `src/wordpress-plugin/` | PHP plugin pro WordPress – produkční nasazení ([návod](src/wordpress-plugin/README.md)) |
| `config/organization.json` | konfigurace vaší MO: kontakty, účet, revíry (cena, kapacita, pravidla) – **jen lokálně, není v repu** (`.gitignore`) |
| `config/organization.json.example` | vzor konfigurace pro novou MO (všechny klíče, revír se dvěma podrevíry s vlastní cenou a kapacitou); bez `organization.json` ho Node verze použije sama |
| `config/species/` | pravidla druhů ryb organizace: seznam druhů, lovné míry, hájení, denní limity |
| `test/` | sdílené testy API pro Node i PHP |
| `dev/wordpress/` | Docker: WordPress 7.1.4 + PHP 8.3 pro vývoj a testy pluginu |
| `docs/` | smlouva API (`API.md`), plán (`PLAN.md`), zadání a design |

Obě implementace musí dodržet [docs/API.md](docs/API.md) a projít stejnými testy. Frontend se liší jen prefixem API v `src/frontend/js/env.js`.

## Lokální vývoj

Potřeba Node.js 22.13 nebo novější (vestavěné `node:sqlite`), žádné závislosti se neinstalují.

```bash
npm run seed    # ukázková data relativně k dnešku (místenky ve všech stavech, poukazy)
npm start       # http://localhost:3000
npm test        # sdílené testy API (spustí vlastní server s testovací konfigurací)
```

- Platby jsou v konfiguraci nastavené na falešnou banku (`"provider": "fake"`). Na platební stránce je tlačítko **Simulovat příchozí platbu**.
- S `MISTENKA_DEV=1` se e-maily neodesílají, ukládají se do `data/outbox/` (HTML a text). Bez něj je odešle vlastní SMTP klient přes poštovní účty z portálu (Admin → Emailoví klienti). Výchozí odesílání neexistuje: skupina e-mailů bez odesílatele čeká ve frontě.
- **Čerstvá databáze je zavřená** (sezona uzavřena, rybáři se nemohou registrovat ani přihlásit). Admin v portálu nastaví Emailoví klienti (odesílatele všech skupin a příjemce upozornění) a otevře první sezonu – tím službu spustí. `npm run seed` vytvoří rovnou spuštěnou službu s celoroční sezonou a ukázkovým poštovním účtem.
- Další proměnné prostředí jsou popsané v hlavičce [src/node/server.js](src/node/server.js).

## Účty a role

Registrace a přihlášení na `account.html` (heslem nebo odkazem z e-mailu; odkazy z e-mailů najdete v `data/outbox/`). Manažerský portál je na `manage.html`.

**První admin:** dokud žádný není, server při startu vypíše jednorázový odkaz na průvodce (`setup.html#…`, platí 60 minut). V průvodci vyplníte údaje, heslo a rovnou nastavíte dvoufázové ověření. Admin je účet jen pro správu, bez čísla legitimace.

Další správce a adminy admin **pozve** v portálu (Uživatelé a role → Pozvat), porybné jmenuje správce i admin. Uživatel může sám požádat zaškrtnutím **„Jsem porybný“** (při registraci nebo v účtu); žádost přijde do portálu (Notifikace) a e-mailem příjemcům upozornění (Emailoví klienti), který ji schválí nebo zamítne i přímo z e-mailu. Nouzové příkazy:

```bash
npm run user -- list                      # přehled účtů
npm run user -- setup                     # nový odkaz na průvodce (jen když žádný admin není)
npm run user -- roles vas@email.cz admin  # ruční přidělení role
```

## Nastavení v portálu

Organizaci, revíry (cena, kapacita, podrevíry, doba lovu, pravidla), ryby a limity mění správce v manažerském portálu (Nastavení), platební údaje jen admin. Změny se ukládají jako verze do databáze a mají přednost před konfiguračním souborem, který zůstává výchozími hodnotami. Admin si může platnou konfiguraci stáhnout (export JSON).

## Zálohy

Během sezony se databáze zálohuje jednou denně (drží se poslední dvě), po každé uzávěrce sezony vznikne trvalá záloha. Zálohy jsou v `data/backups/`; admin je v portálu stahuje, maže a může zálohovat ručně. Admin může kteroukoli zálohu obnovit z portálu (potvrzení kódem 2FA, předtím vznikne pojistná záloha). Poškozenou databázi server při startu sám obnoví z nejnovější platné zálohy (poškozený soubor odloží do `data/corrupt/`) a upozorní adminy e-mailem.

## Ochrana osobních údajů

Obecné zásady jsou na `privacy.html` (odkaz v patičce). Sídlo, IČO, kontakt a lhůty uchování se nastavují v portálu (Nastavení → Organizace); po uplynutí lhůt se údaje automaticky anonymizují nebo smažou.

## Ruční test

Scénář pro vyzkoušení celé aplikace: [docs/TEST_NODE.md](docs/TEST_NODE.md).

## Jiná MO nebo jiný revír

1. Zkopírujte `config/organization.json.example` jako `config/organization.json` a upravte `organization`, `payment` a seznam `reviry`. E-maily se nenastavují v souboru, ale v portálu (Emailoví klienti).
   Pravidla druhů ryb: odkaz `speciesRules` na soubor v `config/species/` (míry a hájení podle BPVRP svazu); zpřísnění pro jednotlivý revír přes `speciesOverrides`.
2. Spusťte s vlastním souborem: `MISTENKA_CONFIG=cesta/k/konfiguraci.json npm start`.
3. Jeden revír → aplikace ho rovnou zobrazí; více revírů → úvodní stránka nabídne výběr (`?revir=<id>`).

Identifikátor revíru (`id`) se ukládá k místenkám, po spuštění ho neměňte.

## Platby

Rybář platí převodem podle QR platby (SPAYD) s jedinečným variabilním symbolem. Místenka se vystaví po spárování platby. Napojení na skutečný účet: `"provider": "fio"` v konfiguraci a token Fio API (jen pro čtení) v proměnné `FIO_TOKEN`. Adaptér pro Fio je připravený, ale zatím neověřený proti skutečnému účtu.

## WordPress

Produkční plugin je v `src/wordpress-plugin/mistenka`: `python scripts/build-plugin.py` → `dist/mistenka.zip` s vaší lokální `config/organization.json` (balíček pro vlastní MO; `--example` místo ní zabalí vzor).

Obecné balíčky pro GitHub release (konfigurace ze vzoru, bez údajů konkrétní MO): `python scripts/build-plugin.py --release` → `dist/mistenka.zip` (WP, Fio), `dist/mistenka-fake-bank.zip` (WP, testovací web) a `dist/mistenka-node.zip` (Node verze z commitu HEAD; samotný `--node`). Instalace, konstanty ve wp-config.php, cron a lokální Docker: [src/wordpress-plugin/README.md](src/wordpress-plugin/README.md).

```bash
cd dev/wordpress && docker compose up -d && sh setup.sh && sh reset.sh
node test/api.test.js --base "http://localhost:8088/?rest_route=/mistenka/v1"   # z kořene repozitáře
```

## Stav projektu

Pilotní vývoj. Node verze i WordPress plugin implementují úkoly A1–A6 a B1–B7 z [docs/PLAN.md](docs/PLAN.md) a procházejí stejnými 47 testy API. Další krok: nasazení pluginu na `test.rybarikarvina.cz` a ruční průchod s malou skutečnou platbou.

## Licence

Proprietární software, © 2026 Ing. Jiří Konečný. Všechna práva vyhrazena – užití pouze na základě písemné licenční smlouvy, viz [LICENSE.md](LICENSE.md). Šablona licenční smlouvy: [docs/LICENCNI_SMLOUVA.md](docs/LICENCNI_SMLOUVA.md) (ke stažení jako [Word](docs/LICENCNI_SMLOUVA.docx)).
