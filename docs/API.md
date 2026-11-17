# Místenka – smlouva API

Závazný popis chování serveru. Platí pro obě implementace:

- **Node.js** (`src/node/`) – lokální vývoj, prefix `/api`,
- **PHP plugin pro WordPress** (`src/wordpress-plugin/`) – produkce, prefix `/?rest_route=/mistenka/v1` (web nemá „hezké“ trvalé odkazy).

Frontend zná jen prefix (`src/frontend/js/env.js`). Shodu ověřují sdílené testy `test/api.test.js`, které se spouští proti oběma serverům. **Změna chování = změna tohoto dokumentu + testu + obou implementací v jednom commitu.**

## Obecně

- Požadavky i odpovědi jsou JSON v UTF-8. Odpovědi API mají `Cache-Control: no-store`.
- Chyba: HTTP stav + `{ "error": "Česká zpráva pro uživatele", "code": "strojovy_kod" }`. Frontend zobrazuje `error` a rozhoduje se podle `code`.
- Kód místenky: 6 znaků `A–Z0–9`; generují se jen znaky `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Na vstupu se převádí na velká písmena.
- Datum lovu `date`: `YYYY-MM-DD`, kalendářní den v pásmu **Europe/Prague**. Okamžiky (`validFrom`, `reservedUntil`, …) jsou ISO 8601 v UTC.
- Částky jsou v **haléřích** (`amountHalere`, `priceHalere`), měna CZK.
- Držitel se identifikuje **číslem členské legitimace** (`memberId`): přesně 8 číslic (číslo pod čárovým kódem). Mezery se ignorují (`1234 5678` → `12345678`).

### Přístup držitele místenky

Operace s osobními údaji vyžadují jednu z hlaviček:

| Hlavička | Hodnota |
| --- | --- |
| `X-Mistenka-Token` | token z odpovědi `POST /orders` nebo z odkazu v e-mailu (`#t=…`) |
| `X-Mistenka-Member-Id` | číslo členské legitimace, na kterou je místenka vystavena |

Tokeny jsou náhodné (≥ 32 znaků base64url), server ukládá jen jejich SHA-256 hash. Jedna místenka může mít víc tokenů (prohlížeč, každý e-mail). Token v odkazu je ve fragmentu URL, takže se neposílá serveru ani do logů. Chybný přístup → `403 forbidden`.

### Omezení počtu požadavků (na IP)

| Skupina | Limit |
| --- | --- |
| `POST /orders` | 10 / min |
| `GET /vouchers/{code}` | 20 / min |
| `GET /tickets/{code}` | 60 / min |
| neúspěšný přístup držitele (403/404) | 10 / 10 min, pak `429` i pro správné údaje |

Překročení → `429 rate_limited`. Ve vývojovém režimu lze limity vypnout (testy).

## Konfigurace MO a revírů

Všechno, co se liší mezi organizacemi a revíry, je v konfiguraci (Node: `config/organization.json`, jiný soubor přes `MISTENKA_CONFIG`; WordPress: nastavení pluginu). Jedna instalace = jedna MO s jedním nebo více revíry. Struktura viz `config/organization.json`; klíčové položky revíru:

| Položka | Význam |
| --- | --- |
| `id` | stálý identifikátor (`a-z0-9-`), ukládá se k místence |
| `priceCzk` | cena za den v Kč |
| `dailyCapacity` | max. počet místenek na den (vydané + nezaplacené s platnou rezervací) |
| `bookingDaysAhead` | kolik dní dopředu lze kupovat (0 = jen dnes) |
| `lateReturnDays` | kolik dní po konci dne lovu lze místenku odevzdat opožděně (7); pak se automaticky uzavře jako neodevzdaná |
| `subdistrictList`, `ticketSubdistricts` | podrevíry revíru `[{ number, name, area }]` a čísla podrevírů, pro které místenka platí (např. `[1]` nebo `[1, 2]`); bez `ticketSubdistricts` platí pro celý revír. Zobrazují se v rekapitulaci, na místence, v PDF a v e-mailu |
| `speciesRules` | volitelně jiný soubor pravidel druhů ryb než organizační |
| `speciesOverrides` | úpravy jednotlivých druhů pro revír, např. `[{ "id": "lin-obecny", "minLength": 30 }]` |
| `fishingHours`, `rules`, `notice`, `permitNote`, … | texty a pravidla pro UI |

### Pravidla druhů ryb

Seznam druhů, lovné míry, doby hájení a denní limity jsou v samostatném souboru, na který odkazuje konfigurace MO (`speciesRules`, např. `config/species/crs-smas-mp-2026-2027.json`, sestaveno podle Soupisu mimopstruhových revírů ÚS SMaS 2026–2027 a vyhlášky 197/2004 Sb.). Revír může použít jiný soubor nebo přepsat jednotlivé druhy (`speciesOverrides`). Výsledná pravidla revíru jsou v `GET /config` jako `reviry[].fishRules`:

| Položka druhu | Význam |
| --- | --- |
| `id`, `name`, `aliases`, `latin` | identifikace; při odevzdání se název i alias (bez ohledu na velikost písmen) převede na `name` |
| `minLength` | nejmenší lovná míra v cm (přísnější z vyhlášky a BPVRP) |
| `releaseFromLength` | ryba této délky a delší se musí vrátit (kapr od 70 cm) |
| `closedSeasons` | doby hájení `[{ from: "MM-DD", to: "MM-DD" }]` včetně, mohou přecházet přes konec roku; posuzuje se den lovu místenky |
| `weightFactor` | orientační koeficient odhadu hmotnosti: kg = k × délka³ / 100 000 |
| `invasive`, `note` | informace pro rybáře |

`dailyLimits`: `[{ id, label, species: [id…], maxCount }]` – nejvýše `maxCount` přisvojených kusů uvedených druhů na jednu místenku. Týdenní, měsíční a roční limity vyžadují historii člena a zatím se nekontrolují.

## Stavy místenky

Uložený stav (`pending_payment`, `issued`, `payment_expired`, `cancelled`) + čas určují stav v API (`status`):

| `status` | Kdy |
| --- | --- |
| `pending_payment` | objednávka čeká na platbu a rezervace ještě platí |
| `payment_expired` | rezervace vypršela bez spárované platby |
| `cancelled` | držitel nezaplacenou objednávku zrušil |
| `future` | vystavená, den lovu ještě nezačal |
| `active` | vystavená, probíhá den lovu (00:00–24:00 Praha) |
| `expired_unreturned` | den lovu skončil, neodevzdaná, lhůta pro opožděné odevzdání běží (`late: true`) |
| `closed_unreturned` | lhůta `lateReturnDays` uplynula bez odevzdání – uzavřena jako neodevzdaná, bez úlovku (`late: true`, `closedAt`) |
| `expired_returned` | odevzdaná (i během dne lovu); `late: true`, pokud po skončení dne lovu |

Místenka vzniká vždy jako objednávka. S poukazem nebo při ceně 0 Kč je rovnou `issued`, jinak `pending_payment` s rezervací na `payment.reservationMinutes`. **Místenka neopravňuje k lovu, dokud není vystavena.**

## Předpověď počasí

Není součástí API. Frontend ji načítá přímo z [Open-Meteo](https://open-meteo.com) podle `gps` revíru (`src/frontend/js/weather.js`); bez `gps` nebo při chybě se nezobrazí.

## Endpointy

### `GET /config`
Veřejná konfigurace: `organization` (`name`, `shortName`, `web`, `privacyUrl`, `contact`), `payment` (`mode`: `fake` | `fio`, `reservationMinutes`), `reviry[]` (včetně `species`), `today` (Praha), `now`, `devMode`. Nikdy neobsahuje číslo účtu, IBAN ani tokeny.

### `GET /reviry/{id}/availability`
`{ revirId, today, days: [{ date, capacity, taken, available }] }` pro dnešek až `bookingDaysAhead`. Neznámý revír → `404 unknown_revir`.

### `POST /orders`
Tělo: `{ revirId, date, memberId, firstName, lastName, birthDate, email, declaration: true, voucherCode? }`

Odpověď `201`: `{ token, ticket: <OwnerTicket> }`. U nezaplacené objednávky obsahuje `ticket.payment` (viz níže). Server odešle e-mail s pokyny k platbě, nebo rovnou s místenkou.

| Chyba | `code` |
| --- | --- |
| 400 | `unknown_revir`, `invalid_date` (mimo dnešek…`bookingDaysAhead`), `invalid_member_id` (8 číslic), `invalid_name`, `invalid_birth_date`, `invalid_email`, `declaration_required`, `invalid_voucher` |
| 409 | `sold_out`, `voucher_used` |

Kapacita, poukaz i vytvoření se provádějí v jedné transakci; poukaz se odepíše jen při úspěšném vytvoření.

### `GET /orders/{code}` 🔒
`<OwnerTicket>` – úplné údaje pro držitele.

### `POST /orders/{code}/cancel` 🔒
Zruší nezaplacenou objednávku (`pending_payment` nebo `payment_expired`) a uvolní místo. Jinak `409 not_cancellable`.

### `GET /tickets/{code}`
Veřejná kontrola – smí ji provést kdokoli (QR kód na místence, ruční zadání kódu), vrací jen `<PublicTicket>` a nic nemění. Zadržení místenky rybářskou stráží přibude s uživatelskými účty.  Neexistuje → `404 not_found`, špatný formát → `400 invalid_code`.

### `POST /tickets/{code}/return` 🔒
Tělo: `{ noCatch: boolean, catches: [{ species, length, weight?, weightEstimated? }] }`

- `noCatch: true` ⇒ `catches` musí být prázdné; jinak alespoň jeden úlovek (`catches_required`).
- `species` 1–60 znaků; známý druh (název nebo alias) se zapíše jako `name` z pravidel. Neznámý druh se přijme tak, jak je zadán. `length` 0–400 cm; `weight` volitelně 0–300 kg; `weightEstimated` = váha je odhad z délky.
- Známý druh v době hájení (podle dne lovu) → `400 closed_season`; pod `minLength` → `400 undersized`; od `releaseFromLength` → `400 must_release`; překročený denní limit → `400 daily_limit`.
- Odevzdat lze stav `active` a `expired_unreturned`, tj. do `returnDeadline` (= konec dne lovu + `lateReturnDays`). Odevzdání po konci dne lovu má `late: true`. Stav `closed_unreturned` → `409 return_closed`.

| Chyba | `code` |
| --- | --- |
| 400 | `invalid_catches`, `catches_required`, `undersized`, `must_release`, `closed_season`, `daily_limit` |
| 409 | `not_issued`, `too_early`, `already_returned`, `return_closed` |

Odpověď `200`: `<OwnerTicket>` se stavem `expired_returned`.

### `GET /vouchers/{code}`
`{ code, valid, usedAt, revirId }` (`revirId: null` = platí pro všechny revíry). Špatný formát (≠ 16 znaků `A–Z0–9`) → `400 invalid_voucher`.

## Tvary odpovědí

```jsonc
// PublicTicket – minimum údajů
{
  "code": "S7K4P2",
  "revir": { "id": "petruvka-1a", "name": "Petrůvka 1 A", "number": "471 115" },
  "date": "2026-11-17",
  "status": "active",
  "late": false,
  "holder": { "name": "Jan Novák", "memberId": "••••5678" }, // null, dokud není vystavena
  "validFrom": "2026-11-16T23:00:00.000Z",
  "validTo": "2026-11-17T23:00:00.000Z"
}

// OwnerTicket = PublicTicket bez "holder" + údaje držitele
{
  "firstName": "Jan", "lastName": "Novák", "birthDate": "1980-05-15", "email": "jan@example.cz", "memberId": "12345678",
  "priceHalere": 20000, "amountDueHalere": 20000, "voucherUsed": false,
  "createdAt": "…", "issuedAt": "…", "returnedAt": null,
  "noCatch": false, "returnable": true, "returnDeadline": "2026-11-24T23:00:00.000Z", "closedAt": null,
  "catches": [{ "species": "kapr", "length": 52, "weight": 2.1, "weightEstimated": true }],
  "payment": null // u pending_payment:
  // { "iban": "CZ…", "accountNumber": "2401876543/2010", "recipientName": "…", "variableSymbol": "8188232561",
  //   "amountHalere": 20000, "message": "Mistenka S7K4P2 2026-11-17", "reservedUntil": "…",
  //   "spayd": "SPD*1.0*ACC:CZ…*AM:200.00*CC:CZK*X-VS:8188232561*MSG:…*RN:…" }
}
```

Zobrazení jména a počtu viditelných znaků lístku ve veřejné kontrole řídí konfigurace `publicCheck` (`showFullName`, `memberIdVisibleChars`).

## Platby převodem

- Variabilní symbol: náhodné 10místné číslo, unikátní, nikdy se neopakuje. QR platba ve formátu SPAYD; IBAN se počítá z čísla účtu a kódu banky v konfiguraci. Texty v QR jsou bez diakritiky.
- Zdroj plateb (`payment.provider`): `fake` (vývoj; platby se vkládají přes `/dev/payments`) nebo `fio` (Fio API Bankovnictví, endpoint `last`, token jen pro čtení v proměnné prostředí / `wp-config.php`, max. 1 dotaz za 30 s).
- Párování každé příchozí transakce (deduplikace podle ID transakce):

| Výsledek | Kdy | Akce |
| --- | --- | --- |
| `matched` | VS + přesná částka + CZK, objednávka čeká; nebo rezervace vypršela, ale den lovu neuplynul a místo je volné | místenka vystavena, e-mail |
| `amount_mismatch` | VS sedí, částka/měna ne | ruční řešení |
| `duplicate_payment` | objednávka už zaplacená | ruční řešení (vrácení) |
| `late` | zrušená objednávka, nebo vypršelá rezervace bez volného místa / po dni lovu | ruční řešení |
| `unmatched` | VS nepatří žádné objednávce | ruční řešení |
| `ignored` | odchozí platba | – |

## Plánované úlohy

V tomto pořadí; Node je spouští v intervalu, WordPress cron hostingu přes `POST /jobs/run`:

1. vypršení rezervací (`pending_payment` → `payment_expired`),
2. stažení a párování plateb,
3. připomínky odevzdání (jednou, po skončení dne lovu, dokud běží lhůta),
4. uzavření neodevzdaných místenek po lhůtě `lateReturnDays` (stav `closed_unreturned`, bez úlovku) + e-mail držiteli,
5. odeslání fronty e-mailů.

`POST /jobs/run` vyžaduje hlavičku `X-Mistenka-Cron-Key` s tajným klíčem z konfigurace serveru; bez něj `404`.

## E-maily

| Druh | Kdy | Odkaz |
| --- | --- | --- |
| `payment_instructions` | nová nezaplacená objednávka | `payment.html?code=…#t=<token>` |
| `ticket_issued` | místenka vystavena | místenka + `return.html?code=…#t=<token>` |
| `return_reminder` | po dni lovu, neodevzdaná, lhůta běží; upozorní na automatické uzavření | `return.html?code=…#t=<token>` |
| `ticket_closed` | místenka uzavřena jako neodevzdaná | kontakt na hospodáře |

Odesílají se přes frontu (tabulka `email_outbox`). Node je ukládá do `data/outbox/`, WordPress odešle přes `wp_mail()`.

## Vývojové endpointy

Jen pro vývoj a testy. Na produkci musí být nedostupné (`404`).

| Endpoint | Dostupnost | Účel |
| --- | --- | --- |
| `POST /dev/payments` `{ code }` nebo `{ variableSymbol, amountHalere, currency? }` | `payment.provider = fake` | simulace příchozí platby → `{ result }` |
| `POST /dev/clock` `{ now: ISO \| null }` | vývojový režim | posun času serveru (a spuštění úloh) |
| `POST /dev/vouchers` `{ code?, revirId? }` | vývojový režim | vytvoření poukazu |
| `POST /dev/jobs` | vývojový režim | okamžité spuštění plánovaných úloh |
