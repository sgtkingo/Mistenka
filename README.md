# Místenka

Webová aplikace pro online prodej, kontrolu a odevzdání rybářských místenek. Jedna instalace slouží jedné místní organizaci (MO) s jedním nebo více revíry; vše, co se liší mezi organizacemi a revíry, je v konfiguraci.

## Struktura

| Složka | Obsah |
| --- | --- |
| `src/frontend/` | uživatelské rozhraní (HTML, JS, CSS) – **jediná kopie**, sdílená oběma servery |
| `src/node/` | Node.js server se SQLite pro lokální vývoj |
| `src/wordpress-plugin/` | PHP plugin pro WordPress – produkční nasazení |
| `config/organization.json` | konfigurace MO: kontakty, účet, revíry (cena, kapacita, pravidla) |
| `config/species/` | pravidla druhů ryb organizace: seznam druhů, lovné míry, hájení, denní limity |
| `test/` | sdílené testy API pro Node i PHP |
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
- E-maily se neodesílají, ukládají se do `data/outbox/` (HTML a text).
- Další proměnné prostředí jsou popsané v hlavičce [src/node/server.js](src/node/server.js).

## Účty a role

Registrace a přihlášení na `account.html` (heslem nebo odkazem z e-mailu; odkazy z e-mailů najdete v `data/outbox/`). Manažerský portál je na `manage.html`.

**První admin:** dokud žádný není, server při startu vypíše jednorázový odkaz na průvodce (`setup.html#…`, platí 60 minut). V průvodci vyplníte údaje, heslo a rovnou nastavíte dvoufázové ověření. Admin je účet jen pro správu, bez čísla legitimace.

Další správce a adminy admin **pozve** v portálu (Uživatelé a role → Pozvat), porybné jmenuje správce i admin. Nouzové příkazy:

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

1. Zkopírujte `config/organization.json` a upravte `organization`, `payment`, `email` a seznam `reviry`.
   Pravidla druhů ryb: odkaz `speciesRules` na soubor v `config/species/` (míry a hájení podle BPVRP svazu); zpřísnění pro jednotlivý revír přes `speciesOverrides`.
2. Spusťte s vlastním souborem: `MISTENKA_CONFIG=cesta/k/konfiguraci.json npm start`.
3. Jeden revír → aplikace ho rovnou zobrazí; více revírů → úvodní stránka nabídne výběr (`?revir=<id>`).

Identifikátor revíru (`id`) se ukládá k místenkám, po spuštění ho neměňte.

## Platby

Rybář platí převodem podle QR platby (SPAYD) s jedinečným variabilním symbolem. Místenka se vystaví po spárování platby. Napojení na skutečný účet: `"provider": "fio"` v konfiguraci a token Fio API (jen pro čtení) v proměnné `FIO_TOKEN`. Adaptér pro Fio je připravený, ale zatím neověřený proti skutečnému účtu.

## Stav projektu

Pilotní vývoj. Node verze implementuje úkoly A1–A6 z [docs/PLAN.md](docs/PLAN.md); převod do WordPress pluginu je další krok.

## Licence

Proprietární software, © 2026 Ing. Jiří Konečný. Všechna práva vyhrazena – užití pouze na základě písemné licenční smlouvy, viz [LICENSE.md](LICENSE.md).
