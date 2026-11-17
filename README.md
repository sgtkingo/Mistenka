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
