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

Přihlášený uživatel nepotřebuje token ani číslo legitimace k místenkám, které patří k jeho účtu (viz Účty).

### Omezení počtu požadavků (na IP)

| Skupina | Limit |
| --- | --- |
| `POST /orders` | 10 / min |
| `GET /vouchers/{code}` | 20 / min |
| `GET /tickets/{code}` | 60 / min |
| neúspěšný přístup držitele (403/404) | 10 / 10 min, pak `429` i pro správné údaje |
| `POST /auth/register`, `/auth/magic-link`, `/auth/password-reset` (+ opakované `email_not_verified`) | 5 / 10 min |
| neúspěšné přihlášení (`invalid_credentials`, `invalid_otp`, `invalid_link`) | 10 / 10 min, pak `429` pro všechny `/auth/*` kromě odhlášení |

Překročení → `429 rate_limited`. Ve vývojovém režimu lze limity vypnout (testy).

## Konfigurace MO a revírů

Všechno, co se liší mezi organizacemi a revíry, je v konfiguraci (Node: `config/organization.json`, jiný soubor přes `MISTENKA_CONFIG`; WordPress: nastavení pluginu). Jedna instalace = jedna MO s jedním nebo více revíry. Struktura viz `config/organization.json`; klíčové položky revíru:

| Položka | Význam |
| --- | --- |
| `id` | stálý identifikátor (`a-z0-9-`), ukládá se k místence |
| `priceCzk` | cena za den v Kč |
| `dailyCapacity` | max. počet místenek na den (vydané + nezaplacené s platnou rezervací) |
| `bookingDaysAhead` | jen pro čtení: kolik dní dopředu lze kupovat (dnešek + N). Jedna hodnota pro celou MO – `salesPolicy.bookingDaysAhead` v nastavení organizace (portál → Ceny a místa, výchozí 3); starší konfigurace převezmou hodnotu prvního revíru |
| `lateReturnDays` | jen pro čtení: kolik dní po konci dne lovu lze místenku odevzdat opožděně; pak se automaticky uzavře jako neodevzdaná. Hodnota je jedna pro celou MO – `returnPolicy.lateReturnDays` v nastavení organizace (portál → Limity a blokace, výchozí 7); starší konfigurace s lhůtou u revíru převezmou hodnotu prvního revíru |
| `subdistrictList`, `ticketSubdistricts` | podrevíry revíru `[{ number, name, area, priceCzk?, dailyCapacity? }]` a čísla podrevírů **v prodeji** (např. `[1]` nebo `[1, 2]`). Místenka platí pro **jeden** podrevír, který rybář vybere při nákupu; každý má vlastní cenu a počet míst na den (bez nich platí `priceCzk` / `dailyCapacity` revíru). Jediný podrevír v prodeji se vybere automaticky. Bez `ticketSubdistricts` je místenka na celý revír (cena a místa revíru). `GET /config` má u revíru navíc `saleSubdistricts: [{ number, name, area, priceCzk, dailyCapacity }]` (efektivní hodnoty). Podrevír se zobrazuje v rekapitulaci, na místence, v PDF, v e-mailech a při kontrole. Portál: ceny a místa v sekci Ceny a místa |
| `speciesRules` | volitelně jiný soubor pravidel druhů ryb než organizační |
| `speciesOverrides` | úpravy jednotlivých druhů pro revír, např. `[{ "id": "lin-obecny", "minLength": 30 }]` |
| `fishingHours`, `rules`, `notice`, `permitNote`, … | texty a pravidla pro UI |

Organizace: `limitPolicy` – automatická blokace (viz Limity). Konfigurace **nenastavuje e-maily**: odesílatele i příjemce upozornění správcům nastaví admin v portálu (E-mailoví klienti); starší klíče `organization.managerEmail` a `email` se ignorují.

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

`dailyLimits`: `[{ id, label, species: [id…], maxCount }]` – nejvýše `maxCount` přisvojených kusů uvedených druhů na jednu místenku.

`periodLimits`: `[{ id, label, species: [id…], period: "week" | "month", maxCount, maxAreaHa?, source }]` – týdenní (kalendářní týden po–ne) a měsíční limity podle **všech vystavených místenek téhož čísla legitimace** v období dne lovu, i bez účtu. `maxAreaHa`: limit platí jen na místenkách, jejichž voda (největší z podrevírů místenky, jinak výměra revíru, údaj `area` „1,7 ha“) má nejvýš tuto výměru – např. kapr 2 ks týdně do 5 ha.

`limitsEnabled` (výchozí false), `sizeRulesEnabled` (výchozí true): hlídání limitů úlovků a lovných měr (nejmenší míra, hájení, povinné vrácení). Odhad hmotnosti podle `weightFactor` funguje vždy. Vypnuté limity se nepočítají nikde (odevzdání, kontrola porybným, místenka, účet) a nevedou k blokaci; vypnuté míry se nekontrolují při odevzdání a pravidla revíru je neukazují. Ve správě Nastavení → Ryby a limity.

**Překročení žádného limitu (denního, týdenního ani měsíčního) neblokuje odevzdání ani nákup.** Místenka vidí jen své místenky; limity svazu platí na všech revírech dohromady.

### Limity v odpovědích

`OwnerTicket.limits` (u všech kromě zrušených; v `GET /me/tickets` se kvůli výkonu nevrací) a `WardenTicket.limits`:

```jsonc
[{ "id": "vyznamne-tyden", "label": "kapr, štika, … dohromady", "period": "week", "from": "2026-06-08", "to": "2026-06-14",
   "maxCount": 4, "count": 5, "exceeded": true, "source": "BPVRP bod 1 …" }]   // period "day" = jen tato místenka
```

Při odevzdání se překročené limity zapíšou (`limit_violations`) a správci dostanou e-mail `limit_exceeded` (příjemci upozornění z Emailoví klienti).

### Blokace nákupu

Aktivní blokace čísla legitimace → `POST /orders` vrátí `403 member_blocked` (zpráva s datem konce a důvodem). Blokaci zakládá správce ručně, nebo automaticky pravidlo `limitPolicy` v konfiguraci: `{ violationsBeforeBlock: 2, blockDays: 30 }` = po 2 místenkách s překročeným limitem v kalendářním roce blokace na 30 dní včetně dneška (`blockDays: null` = do konce roku; `violationsBeforeBlock: 0` = vypnuto). Automatická blokace pošle držiteli e-mail `member_blocked`.

**Další pravidla následků** (`penaltyPolicy` v nastavení organizace, portál → Limity a blokace): `{ lateReturn: { count, blockDays, includeUnreturned }, seizure: { count, blockDays } }` – po `count` opožděně odevzdaných (a při `includeUnreturned` i neodevzdaných, uzavřených po lhůtě) nebo zadržených místenkách v kalendářním roce (den lovu) se nákup automaticky zablokuje na `blockDays` dní včetně dneška (`null` = do konce roku; `count: 0` = vypnuto). Blokace má příčinu `cause`: `limits` | `late_return` | `seizure` | `manual` (v `GET /manage/blocks`). Odevzdání se nikdy neblokuje.

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
| `seized` | zadržená porybným (B2): neopravňuje k lovu, ale lze a je nutné ji odevzdat do `returnDeadline`; po dni lovu `late: true`. Po lhůtě → `closed_unreturned` |

`seized: true` v `PublicTicket` zůstává i po odevzdání nebo uzavření (místenka byla zadržena). Důvod a místo zadržení vidí jen držitel (`OwnerTicket.seizure: { at, reason, place } | null`) a porybný.

Místenka vzniká vždy jako objednávka. S poukazem nebo při ceně 0 Kč je rovnou `issued`, jinak `pending_payment` s rezervací na `payment.reservationMinutes`. **Místenka neopravňuje k lovu, dokud není vystavena.**

## Předpověď počasí

Není součástí API. Frontend ji načítá přímo z [Open-Meteo](https://open-meteo.com) podle `gps` revíru (`src/frontend/js/weather.js`); bez `gps` nebo při chybě se nezobrazí.

## Endpointy

### `GET /config`
Veřejná konfigurace: `organization` (`name`, `shortName`, `web`, `privacyUrl`, `contact`), `payment` (`mode`: `fake` | `fio`, `reservationMinutes`), `reviry[]` (včetně `species`), `today` (Praha), `now`, `devMode`, `service: { launched, seasonOpen }` (viz Spuštění služby; `seasonOpen` = dnes je otevřená některá sezona). Nikdy neobsahuje číslo účtu, IBAN ani tokeny.

### `GET /reviry/{id}/availability`
`{ revirId, today, days: [{ date, capacity, taken, available, subdistricts: [{ number, name, priceCzk, capacity, taken, available }], closed, closedReason, closedCode }] }` pro dnešek až `bookingDaysAhead`. U revíru s podrevíry v prodeji jsou místa po podrevírech a `capacity` / `taken` / `available` dne jsou jejich součty; jinak je `subdistricts` prázdné. Uzavřený den (mimo sezonu nebo mimořádně uzavřený, viz Provoz) má `closed: true`, `available: 0`, důvod a kód (`out_of_season` | `revir_closed`); otevřený den má `closedReason` i `closedCode` `null`. Když jsou všechny dny `out_of_season`, úvodní stránka ukáže „sezona je uzavřená“. Neznámý revír → `404 unknown_revir`.

### `GET /announcements?revirId=`
Důležité zprávy pro úvodní stránku: `{ announcements: [{ id, revirId, title, text, validFrom, validTo, pinned }] }` – nejvýš 3 aktivní (platné dnes) pro revír nebo celou MO (`revirId: null`), připnuté první, pak nejnovější.

### `POST /orders`
Tělo: `{ revirId, date, subdistrict?, memberId, firstName, lastName, birthDate, email, declaration: true, voucherCode? }`. `subdistrict` = číslo podrevíru – povinné u revíru s více podrevíry v prodeji (cena a kapacita podle podrevíru), u jediného se doplní samo, u revíru bez podrevírů se ignoruje. Místenka (`<PublicTicket>` a odvozené tvary) má `subdistrict: { number, label } | null` (`label` např. „2 – Dolní nádrž“). Objednávka přihlášeného uživatele se uloží k jeho účtu (bez ohledu na zadané údaje; frontend je předvyplní z účtu).

Odpověď `201`: `{ token, ticket: <OwnerTicket> }`. U nezaplacené objednávky obsahuje `ticket.payment` (viz níže). Server odešle e-mail s pokyny k platbě, nebo rovnou s místenkou.

| Chyba | `code` |
| --- | --- |
| 400 | `unknown_revir`, `invalid_subdistrict` (chybí nebo neprodávaný podrevír), `invalid_date` (mimo dnešek…`bookingDaysAhead`), `invalid_member_id` (8 číslic), `invalid_name`, `invalid_birth_date`, `invalid_email`, `declaration_required`, `invalid_voucher` |
| 403 | `member_blocked` |
| 409 | `sold_out` (v revíru, příp. ve vybraném podrevíru), `voucher_used`, `out_of_season`, `revir_closed` |

Kapacita, poukaz i vytvoření se provádějí v jedné transakci; poukaz se odepíše jen při úspěšném vytvoření.

### `GET /orders/{code}` 🔒
`<OwnerTicket>` – úplné údaje pro držitele.

### `POST /orders/{code}/cancel` 🔒
Zruší nezaplacenou objednávku (`pending_payment` nebo `payment_expired`) a uvolní místo. Jinak `409 not_cancellable`.

### `GET /tickets/{code}`
Veřejná kontrola – smí ji provést kdokoli (QR kód na místence, ruční zadání kódu), vrací jen `<PublicTicket>` a nic nemění. Plnou kontrolu a zadržení má porybný (viz Porybný).  Neexistuje → `404 not_found`, špatný formát → `400 invalid_code`.

### `POST /tickets/{code}/return` 🔒
Tělo: `{ noCatch: boolean, catches: [{ species, length, weight?, weightEstimated? }] }`

- `noCatch: true` ⇒ `catches` musí být prázdné; jinak alespoň jeden úlovek (`catches_required`).
- `species` 1–60 znaků; známý druh (název nebo alias) se zapíše jako `name` z pravidel. Neznámý druh se přijme tak, jak je zadán. `length` 0–400 cm; `weight` volitelně 0–300 kg; `weightEstimated` = váha je odhad z délky.
- Doba hájení (podle dne lovu), `minLength` a `releaseFromLength` odevzdání **neblokují** – rozhodují pravidla v RIS. Úlovek s možným porušením má v `catches[].warning` text upozornění (jinak `null`); stejně ho vidí porybný (`GET /warden/tickets/:code`) a správce v detailu místenky. Počítá se podle aktuálních pravidel revíru, při `sizeRulesEnabled: false` je vždy `null`. Překročený limit (denní, týdenní, měsíční) odevzdání **neblokuje**: odpověď nese `limits` s `exceeded: true`, správce dostane e-mail.
- Odevzdat lze stav `active` a `expired_unreturned`, tj. do `returnDeadline` (= konec dne lovu + `lateReturnDays`). Odevzdání po konci dne lovu má `late: true`. Stav `closed_unreturned` → `409 return_closed`.

| Chyba | `code` |
| --- | --- |
| 400 | `invalid_catches`, `catches_required` |
| 409 | `not_issued`, `too_early`, `already_returned`, `return_closed` |

Odpověď `200`: `<OwnerTicket>` se stavem `expired_returned`.

### `GET /vouchers/{code}`
`{ code, valid, usedAt, revirId }` (`revirId: null` = platí pro všechny revíry). Špatný formát (≠ 16 znaků `A–Z0–9`) → `400 invalid_voucher`.

## Účty

Nákup bez účtu funguje dál. Účet předvyplňuje formulář, drží historii místenek a nese role.

### Role

Sada oprávnění (`roles: ["member", …]`), ne žebříček. `member` má každý účet.

| Role | Přiděluje | Oprávnění |
| --- | --- | --- |
| `member` | registrace | vlastní účet a místenky |
| `warden` | `manager` nebo `admin` | plná kontrola a zadržení místenky (B2) |
| `manager` | `admin` | manažerský portál (`/manage/*`) |
| `admin` | `admin` | jako `manager` + přidělování rolí `manager`/`admin` |

- Admin **musí** mít zapnutou 2FA; bez ní vrací všechny `/manage/*` `403 mfa_required` a `user.mfaRequired = true`. Pro ostatní je 2FA volitelná, ale když ji mají zapnutou, kód je povinný při každém přihlášení (heslem, odkazem, obnovou hesla).
- Posledního admina nelze odebrat ani smazat (`409 last_admin`). Role kromě `member` lze dát jen účtu s ověřeným e-mailem (`409 user_not_verified`).
- Prvního admina zakládá **průvodce prvním spuštěním** (viz níže); ve WordPressu odkaz na průvodce vygeneruje administrátor webu v Nastavení → Místenka.
- **Účet jen pro správu:** `memberId` a `birthDate` jsou u účtu s rolí `manager`/`admin` volitelné (`staffOnly: true`, když číslo legitimace chybí). Běžný uživatel je mít musí. Správce si je může doplnit a pak z účtu kupovat místenky.

### Přihlášení, relace a CSRF

- Relace je v cookie `mistenka_session` (`HttpOnly`, `SameSite=Lax`, na HTTPS `Secure`), na serveru jen SHA-256 hash. Platnost 30 dní, pro správce a adminy 12 hodin.
- Každá **měnící** žádost (ne `GET`) s platnou relací musí mít hlavičku `X-Mistenka-Csrf` s hodnotou `csrf` z `GET /auth/me` nebo z odpovědi na přihlášení; jinak `403 csrf_failed`. Výjimkou jsou endpointy, které relaci vytvářejí nebo ji nepotřebují (`/auth/login`, `/auth/register`, `/auth/verify`, `/auth/magic-link`, `/auth/magic`, `/auth/password-reset`, `/auth/password-reset/confirm`, `/auth/email/confirm`, `/setup`, `/requests/view`, `/requests/decide`). WordPress plugin má vlastní účty, relace i CSRF token (tabulky pluginu) – rybáři nejsou uživateli WordPressu a cookie přihlášení do WordPressu se nepoužívá.
- Odpovědi neprozrazují existenci účtu: `register` pro existující ověřený e-mail vrátí totéž a pošle e-mail `account_exists`; `magic-link` a `password-reset` vrací vždy `{ sent: true }`. Výjimka: obsazené číslo legitimace → `409 member_id_taken`.
- Odkazy z e-mailů vedou na `account.html#<druh>=<token>` (token ve fragmentu). Jsou jednorázové; nový odkaz stejného účelu ruší starý. Neplatný, použitý nebo prošlý → `400 invalid_link`.

| Odkaz | Fragment | Platnost |
| --- | --- | --- |
| ověření registrace | `#verify=` | 48 h |
| přihlášení bez hesla | `#login=` | 15 min |
| obnova hesla | `#reset=` | 60 min |
| potvrzení nového e-mailu | `#email=` | 24 h |

- Heslo je volitelné (bez něj jen přihlášení odkazem), jinak 8–200 znaků (`400 weak_password`). E-mail se porovnává bez ohledu na velikost písmen.
- Ověření e-mailu (i přihlášení odkazem nebo obnova hesla, které vlastnictví adresy také prokazují) připojí k účtu dřívější místenky bez účtu se **stejným číslem legitimace a e-mailem**.
- Neověřené účty se plánovanou úlohou smažou po 48 h; jejich číslo legitimace se tím uvolní.

### Průvodce prvním spuštěním

Dokud neexistuje žádný admin, server při startu vypíše do konzole jednorázový odkaz `setup.html#<token>` (platí 60 min, každý start vytvoří nový a předchozí zneplatní; nouzově `npm run user -- setup`). Ve WordPressu odkaz vygeneruje administrátor webu tlačítkem v Nastavení → Místenka. Kdo nemá přístup ke konzoli ani k administraci webu, admina nezaloží. Admin vzniká rovnou s ověřeným e-mailem a zapnutou 2FA; pak je průvodce vypnutý.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /setup` | – | `{ needed }` |
| `POST /setup/2fa` | `{ token }` | `{ secret, otpauthUrl }`; `400 invalid_setup_token`, `404 setup_closed` |
| `POST /setup` | `{ token, email, firstName, lastName, password, otp }` | `{ user, csrf }` + cookie; `400 invalid_otp`, `weak_password`, …; `409 two_factor_not_setup`, `email_taken`; `404 setup_closed` |

### Endpointy účtu

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /auth/me` | – | `{ user: <User> \| null, csrf }` (vždy `200`) |
| `POST /auth/register` | `{ email, firstName, lastName, birthDate, memberId, password?, consent: true, wardenRequest? }` (`wardenRequest: true` = „Jsem porybný“, žádost se odešle po ověření e-mailu) | `{ sent: true }`; `400 invalid_email`, `invalid_name`, `invalid_birth_date`, `invalid_member_id`, `weak_password`, `consent_required`; `409 member_id_taken`, `409 service_not_launched` (před spuštěním služby) |
| `POST /auth/verify` | `{ token }` | `{ user, csrf }` + cookie; `400 invalid_link` |
| `POST /auth/login` | `{ email, password, otp? }` | `{ user, csrf }` + cookie; `401 invalid_credentials`, `401 otp_required`, `401 invalid_otp`, `403 email_not_verified` (pošle nový ověřovací odkaz), `409 service_not_launched` (rybář před spuštěním služby), `409 season_closed` (rybář při uzavřené sezoně – dnes není otevřená žádná sezona); správce a admin se přihlásí vždy. Registrace vrací stejné kódy, žádosti o odkaz rybářům v té době nic nepošlou |
| `POST /auth/magic-link` | `{ email }` | `{ sent: true }` |
| `POST /auth/magic` | `{ token, otp? }` | `{ user, csrf }` + cookie; `400 invalid_link`, `401 otp_required`/`invalid_otp` (odkaz pak zůstává platný) |
| `POST /auth/password-reset` | `{ email }` | `{ sent: true }` |
| `POST /auth/password-reset/confirm` | `{ token, password, otp? }` | `{ user, csrf }` + cookie; odhlásí ostatní relace |
| `POST /auth/email/confirm` | `{ token }` | `{ user }`; `409 email_taken` |
| `POST /auth/logout` | – | `{ ok: true }`, smaže cookie |
| `PATCH /me` 👤 | `{ firstName?, lastName?, birthDate?, memberId?, email? }` | `{ user, emailChangePending }` – nový e-mail se změní až po potvrzení odkazem; `409 member_id_taken`, `email_taken` |
| `PUT /me/password` 👤 | `{ currentPassword, newPassword }` (`currentPassword` jen pokud účet heslo má) | `{ user }`; `400 wrong_password`; odhlásí ostatní relace |
| `POST /me/delete` 👤 | `{ confirm: true, password? }` | `{ deleted: true }` + smaže cookie; místenky zůstanou bez vazby na účet; `400 confirm_required`, `wrong_password`; `409 last_admin` |
| `GET /me/tickets` 👤 | – | `{ tickets: [<OwnerTicket>] }`, nejnovější den lovu první |
| `POST /me/warden-request` 👤 | `{ note? }` | `{ user }` – žádost „Jsem porybný“ (viz Notifikace); `409 already_warden`, `request_pending` |
| `GET /me/limits?revirId=` 👤 | – | `{ date, revirId, limits: [...], blocked }` – týdenní a měsíční limity člena k dnešku (bez čísla legitimace prázdné) |
| `GET /me/stats` 👤 | – | `{ visits, returned, catches, totalWeight, successRate, biggest, heaviest, bestTrip, species: [{ species, count, maxLength }], years: [{ year, visits, catches }] }` – osobní statistika z vystavených místenek účtu, jejichž den lovu nastal. `biggest`/`heaviest`: `{ species, length, weight, date, revir, subdistrict }`; `bestTrip` (nejvíc úlovků): `{ date, revir, subdistrict, catches, weight }`; `successRate` = % odevzdaných místenek s úlovkem (null bez odevzdání) |
| `POST /me/2fa/setup` 👤 | – | `{ secret, otpauthUrl }` (TOTP, SHA-1, 6 číslic, 30 s); `409 two_factor_enabled` |
| `POST /me/2fa/enable` 👤 | `{ otp }` | `{ user }`; `400 invalid_otp`, `409 two_factor_not_setup` |
| `POST /me/2fa/disable` 👤 | `{ otp }` | `{ user }`; admin → `409 two_factor_required` |
| `GET /manage/users?q=&role=` 🛠 | – | `{ users: [<StaffUser>], counts: { admin, manager, warden, member } }` (max. 100, hledá v e-mailu, jménu a čísle legitimace; `role` = `admin` \| `manager` \| `warden` – účty s touto rolí, `member` – rybáři bez další role; jinak `400 invalid_roles`) |
| `POST /manage/users` 🛠 (jen admin) | `{ email, firstName, lastName, roles: ["manager"] \| ["admin"] }` | `201 { user: <StaffUser> }` – účet jen pro správu s ověřeným e-mailem; pozvaný dostane e-mail `staff_invite` s odkazem `account.html#invite=<token>` (72 h), heslo nastaví přes `POST /auth/password-reset/confirm`; `400 invalid_roles`, `403 forbidden_role`, `409 email_taken` |
| `GET /manage/violations` 🛠 | – | `{ violations: [{ id, code, date, memberId, holder, label, period, from, to, count, maxCount, createdAt, blocked }] }` (posledních 200) |
| `GET /manage/blocks` 🛠 | – | `{ blocks: [{ id, memberId, holder, reason, until, source: "manual" \| "auto", createdAt, liftedAt, active }] }` |
| `POST /manage/blocks` 🛠 | `{ memberId, reason, until? }` (`until` YYYY-MM-DD včetně, bez = do zrušení) | `201 { block }`; `400 invalid_member_id`, `invalid_reason`, `invalid_date`; `409 already_blocked` |
| `POST /manage/blocks/{id}/lift` 🛠 | – | `{ block }`; `404`, `409 already_lifted` |
| `PUT /manage/users/{id}/roles` 🛠 | `{ roles: [...] }` | `{ user: <StaffUser> }`; `400 invalid_roles`, `403 forbidden_role` (správce mění jen `warden`), `404`, `409 last_admin`, `user_not_verified`; změna se zapíše do auditu |

👤 = přihlášený uživatel (jinak `401 unauthorized`). 🛠 = `manager` nebo `admin` (jinak `403 forbidden_role`, admin bez 2FA `403 mfa_required`). TOTP kód lze použít jen jednou (ochrana proti opakování), tolerance ±30 s.

```jsonc
// User
{ "id": 7, "email": "eva@example.cz", "firstName": "Eva", "lastName": "Nováková", "birthDate": "1988-02-03", "memberId": "12345678",
  "staffOnly": false, "roles": ["member", "warden"], "emailVerified": true, "hasPassword": true, "twoFactor": false, "mfaRequired": false,
  "wardenRequest": null /* poslední žádost „Jsem porybný“: { id, status: "pending" | "approved" | "rejected", createdAt, decidedAt, decisionNote } */, "createdAt": "…" }
// StaffUser = User bez birthDate, hasPassword, mfaRequired a wardenRequest
```

## Notifikace

Žádosti a upozornění, které čekají na rozhodnutí správce (portál → **Notifikace**, e-mail příjemcům upozornění z E-mailových klientů). Každá notifikace má `kind`; zatím existuje jediný druh `warden_request`, další mohou přibýt se stejnými endpointy (frontend zobrazí neznámý druh obecně).

### Žádost „Jsem porybný“ (`warden_request`)

Uživatel může při registraci nebo v účtu zaškrtnout **„Jsem porybný“** (smí jen porybný – rybářská stráž MO nebo státní rybářská stráž). Žádost dostane správce:

- v manažerském portálu, sekce **Notifikace** (správce i admin; počet čekajících je v menu),
- e-mailem `warden_request` (příjemci upozornění z Emailoví klienti) s tlačítky **Schválit** / **Zamítnout** a odkazem do portálu. Tlačítka vedou na `request.html#t=<token>&a=approve|reject`, kde se rozhodnutí teprve potvrdí (samotné otevření odkazu nic nemění – poštovní skenery odkazy otevírají). Token platí 7 dní a jde použít jen jednou.

Žádost z registrace se odešle až po ověření e-mailu. Schválení přidá roli `warden` (zapíše se do auditu jako změna rolí); žadatel dostane e-mail `warden_request_approved` / `warden_request_rejected` s případnou poznámkou správce.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/notifications` 🛠 | – | `{ notifications: [<Notification>], pending }` – čekající první, max. 200 |
| `POST /manage/notifications/{id}/approve`, `/reject` 🛠 | `{ note? }` | `{ notification }`; `404`, `409 already_decided` |
| `POST /requests/view` | `{ token }` | `{ notification }` – náhled z odkazu v e-mailu (bez přihlášení); `400 invalid_link` (neplatný, prošlý nebo vyřízený) |
| `POST /requests/decide` | `{ token, action: "approve" \| "reject", note? }` | `{ notification }`; `400 invalid_action`, `invalid_link` |

Neúspěšné pokusy s tokenem se počítají do limitu neúspěšných přihlášení (10 / 10 min).

```jsonc
// Notification
{ "id": 3, "kind": "warden_request", "status": "pending", "note": "Rybářská stráž MO", "createdAt": "…",
  "user": { "id": 7, "name": "Eva Nováková", "email": "…", "memberId": "12345678", "roles": ["member"] },
  "decidedAt": null, "decidedBy": "", "decidedVia": null /* portal | email */, "decisionNote": "" }
```

## E-mailoví klienti (SMTP účty)

Portál → **Admin → Emailoví klienti**. Organizace může mít víc poštovních účtů; každá skupina e-mailů má svého odesílatele:

| Skupina | E-maily |
| --- | --- |
| `tickets` – Místenky | `payment_instructions`, `ticket_issued`, `return_reminder`, `ticket_closed`, `ticket_seized`, `ticket_cancelled`, `closure_notice`, `member_blocked` |
| `accounts` – Účty | `account_verify`, `account_exists`, `magic_link`, `password_reset`, `email_change`, `staff_invite`, `account_deleted`, `warden_request_approved`, `warden_request_rejected` |
| `notices` – Upozornění správců | `warden_request`, `seizure_notice`, `limit_exceeded`, `season_report`, `payment_settings_changed`, `database_auto_restored` |
| `bugs` – Hlášení chyb | `bug_report` (všem adminům) |

- Účty zakládá, upravuje, testuje a maže **jen admin**; odesílatele skupin může vybrat správce i admin (API), v UI je sekce jen pro admina.
- Odesílatelem skupiny může být jen **ověřený** účet = úspěšně odeslaný testovací e-mail. Změna adresy odesílatele, serveru, portu, šifrování, přihlašovacího jména nebo hesla ověření zruší; neověřený přiřazený účet se nepoužije, dokud ho admin znovu neotestuje.
- **Výchozí odesílání neexistuje.** E-mail skupiny bez ověřeného odesílatele neodejde: ve frontě dostane chybu „Skupina … nemá odesílatele“ a odejde, jakmile správce odesílatele nastaví. Ostatní skupiny neblokuje.
- **Příjemci upozornění správcům** (`noticeRecipients`, 1–10 adres) dostávají e-maily skupiny `notices` určené správě: `warden_request`, `seizure_notice`, `limit_exceeded`, `season_report`. (`payment_settings_changed` a `database_auto_restored` chodí všem adminům.)
- `ready` = všechny skupiny mají ověřeného odesílatele a je nastaven aspoň jeden příjemce upozornění; `missing` = co chybí (`tickets`, `accounts`, `notices`, `noticeRecipients`). Bez `ready` nejde otevřít první sezonu (viz Spuštění služby).
- Heslo se ukládá šifrovaně (AES-256-GCM, klíč `MISTENKA_SECRET_KEY`, jinak vygenerovaný soubor v datové složce) a **nikdy se nevrací** do API. Prázdné heslo při úpravě = beze změny.
- Odesílá vlastní SMTP klient bez knihoven (Node `lib/smtp.js`, WordPress `includes/Smtp.php` – nezávisle na `wp_mail()`, PHPMaileru i pluginech typu WP Mail SMTP): `ssl` = TLS hned po připojení (465), `tls` = STARTTLS (587, server ho musí nabízet), `none` = bez šifrování (25); přihlášení AUTH PLAIN, jinak LOGIN; certifikát serveru se ověřuje. Zpráva multipart/alternative (text + HTML), UTF-8. Vývoj (`MISTENKA_MAIL_TRANSPORT=file`, v Node výchozí s `MISTENKA_DEV`) e-maily jen ukládá do `outbox/` v datové složce, i test účtu.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/email/accounts` 🛠 | – | `{ accounts: [<EmailAccount>], senders: { tickets, accounts, notices }, noticeRecipients: [e-mail], groups: [{ id, label, help }], ready, missing: [..], delivery: "smtp" \| "file", canEdit }` |
| `POST /manage/email/accounts` 🛠 (jen admin) | `{ label?, fromEmail, fromName?, host, port, encryption: "ssl" \| "tls" \| "none", username?, password? }` | `201 { account }`; `400 invalid_email`, `invalid_host`, `invalid_port`, `invalid_encryption`, `invalid_label`; `403 forbidden_role` |
| `PUT /manage/email/accounts/{id}` 🛠 (jen admin) | totéž | `{ account }`; `404` |
| `DELETE /manage/email/accounts/{id}` 🛠 (jen admin) | – | `{ deleted: true }`; skupiny, které účet používaly, zůstanou bez odesílatele |
| `POST /manage/email/accounts/{id}/verify` 🛠 (jen admin) | `{ to? }` (výchozí e-mail admina) | `{ account }` s `verified: true`; `400 smtp_failed` se zprávou serveru (uloží se do `lastError`) |
| `PUT /manage/email/senders` 🛠 | `{ tickets?, accounts?, notices?, noticeRecipients? }` (id účtu nebo `null` = bez odesílatele; příjemci jako pole nebo text oddělený čárkami, malá písmena, bez duplicit) | jako `GET`; `400 invalid_email`, `404`, `409 account_not_verified` |

```jsonc
// EmailAccount
{ "id": 1, "label": "Místenka", "fromEmail": "mistenka@…", "fromName": "Místenka – MO Karviná", "host": "smtp.websupport.cz", "port": 465, "encryption": "ssl",
  "username": "mistenka@…", "hasPassword": true, "verified": true, "verifiedAt": "…", "verifiedTo": "admin@…", "lastError": null, "usedFor": ["tickets"], "createdAt": "…", "updatedAt": "…" }
```

## Hlášení chyb

Tlačítko s broukem v horním panelu (nalevo od přihlášení) otevře formulář: popis (povinný), e-mail pro odpověď (jen nepřihlášený), volitelný snímek obrazovky (soubor nebo vložení ze schránky; prohlížeč ho zmenší a převede na JPEG) a automaticky čas, stránka, prohlížeč, velikost okna a záznam posledních událostí (posledních 60 v rámci záložky: načtení stránek, volání API s výsledkem a dobou, chyby skriptů, zobrazené hlášky; bez parametrů adres, s maskovanými kódy místenek, bez těl požadavků). Každé hlášení dostanou e-mailem všichni admini (skupina `bugs` – Hlášení chyb v E-mailových klientech). Portál: **Admin → Hlášení chyb**.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `POST /bug-reports` | `{ description, contactEmail?, url, userAgent, viewport, clientTime, log: [{ at, type, message, page }], screenshot? }` (`screenshot` = data URL PNG/JPEG/WebP do ~1,5 MB; `url` se uloží bez parametrů a kotvy; přihlášený uživatel se připojí automaticky) | `201 { id }`; `400 invalid_description` (10–4000 znaků), `invalid_email`, `invalid_screenshot`; `429` (5 / 10 min) |
| `GET /manage/bug-reports?status=` 🛡 admin | `status`: `new` \| `in_progress` \| `resolved` \| `wontfix` (prázdné = vše) | `{ reports: [{ id, createdAt, status, priority, description, url, user, contactEmail, hasScreenshot, githubUrl, note, updatedAt, resolvedAt }], counts: { new, in_progress, resolved, wontfix }, github: { configured, repo } }` |
| `GET /manage/bug-reports/{id}` 🛡 admin | – | `{ report }` navíc s `userAgent`, `viewport`, `clientTime`, `log`, `screenshot` |
| `PATCH /manage/bug-reports/{id}` 🛡 admin | `{ status?, priority?: "low" \| "normal" \| "high" \| "critical", note?, githubUrl? }` | `{ report }`; `400 invalid_status`, `invalid_priority`, `invalid_github_url` (jen `https://github.com/…/issues/N`) |
| `POST /manage/bug-reports/{id}/github` 🛡 admin | – | `{ report }` s `githubUrl` (založí issue přes GitHub API, bez osobních údajů a snímku; nové hlášení přejde na `in_progress`); `409 github_not_configured`, `409 already_on_github`, `502 github_failed` |

GitHub: Node proměnné `MISTENKA_GITHUB_TOKEN` (token s právem zakládat issues) a `MISTENKA_GITHUB_REPO` (`vlastník/repozitář`), WordPress stejnojmenné konstanty ve `wp-config.php`. Bez nich portál nabídne zkopírování textu pro ruční založení issue. Uchovávání: snímek obrazovky se maže po 90 dnech, vyřízené hlášení (`resolved`, `wontfix`) rok po vyřízení.

## Provoz (B4)

Správa pro `manager`/`admin` (🛠, jinak `401`/`403 forbidden_role`). `revirId: null` = všechny revíry organizace. Mazání je měkké a zapisuje se do auditu.

**Důležité zprávy** – nahrazují `notice` v konfiguraci (při prvním spuštění se převedou do DB).

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/announcements` | – | `{ announcements: [{ …, revirName, active, createdAt, updatedAt }], maxPublic: 3 }` |
| `POST /manage/announcements` | `{ title, text?, revirId?, validFrom?, validTo?, pinned? }` | `201 { announcement }`; `400 invalid_title` (1–120), `invalid_text` (≤ 1000), `invalid_date`, `unknown_revir` |
| `PUT /manage/announcements/{id}` | totéž | `{ announcement }`; `404` |
| `DELETE /manage/announcements/{id}` | – | `{ deleted: true }` |

**Sezony** – místenky lze kupovat jen na dny uvnitř některé sezony revíru nebo celé MO (`409 out_of_season`). **Revír bez sezony je zavřený.** Předčasné uzavření = změna `closesOn`.

**Spuštění služby** – čerstvá instalace je zavřená: `GET /config` má `service.launched: false`, všechny dny jsou `out_of_season` s důvodem „Sezona zatím nebyla otevřena“, `POST /auth/register` vrací `409 service_not_launched` a přihlásit se (heslem, odkazem, obnovou hesla, ověřením e-mailu) může jen správce nebo admin – rybáři `409 service_not_launched`, žádosti o odkaz jim nic nepošlou. Službu spustí **ruční otevření první sezony** (`POST /manage/seasons`), které vyžaduje nastavené e-maily (`ready` v E-mailových klientech), jinak `409 email_not_ready`. Spuštění je trvalé (meta `service_launched_at`, audit `service_launched`); pozdější smazání sezon jen zavře prodej. Instalace z verze < 16, které už měly místenky nebo sezony, se při aktualizaci označí jako spuštěné.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/seasons` | – | `{ seasons: [{ id, revirId, revirName, name, opensOn, closesOn, state: "upcoming" \| "open" \| "closed" }] }` |
| `POST /manage/seasons`, `PUT /manage/seasons/{id}` | `{ name?, revirId?, opensOn, closesOn? }` (`name` prázdné = „Sezona <rok otevření>“, `closesOn` prázdné = do uzavření) | `201 { season }` / `{ season }`; `400 invalid_name`, `invalid_date`; `409 email_not_ready` (první sezona bez nastavených e-mailů) |
| `POST /manage/seasons/{id}/close` | `{ from }` – uzavřít od data včetně (nejdřív dnes = ihned); posledním dnem lovu je den předtím, vystavené místenky platí dál | `{ season }`; `400 invalid_date`, `404`, `409 already_closing` |
| `DELETE /manage/seasons/{id}` | – | `{ deleted: true }` |

**Mimořádná uzavření** – zablokují nákup na dny `dateFrom`–`dateTo` (`409 revir_closed`, má přednost před sezonou). Držitelé už vystavených neodevzdaných místenek a platných rezervací na tyto dny dostanou e-mail `closure_notice`; vrácení peněz řeší správce ručně.

| Endpoint | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/closures` | – | `{ closures: [{ id, revirId, revirName, dateFrom, dateTo, reason, createdAt }] }` |
| `POST /manage/closures` | `{ dateFrom, dateTo?, revirId?, reason }` (důvod 3–300) | `201 { closure, affectedTickets: [{ code, date, holder, status }] }` |
| `DELETE /manage/closures/{id}` | – | `{ deleted: true }` |

**Místenky, platby a poukazy**

| Endpoint | Tělo / parametry | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/tickets` | `?q=&status=&revirId=&from=&to=&limit=100&offset=0` – `q` hledá kód, číslo legitimace, jméno, e-mail, VS; `status` = stav v API; `from`/`to` = den lovu | `{ total, tickets: [{ code, date, revirId, revir, firstName, lastName, memberId, email, status, late, seized, priceHalere, amountDueHalere, voucherUsed, catchCount, noCatch, createdAt, paidAt, returnedAt, account }] }`; `400 invalid_status`, `invalid_date` |
| `GET /manage/tickets.csv` | stejné filtry | `text/csv` UTF-8 s BOM, oddělovač `;` (Excel v češtině) |
| `GET /manage/tickets/{code}` | – | `{ ticket: <OwnerTicket> + variableSymbol, account, payments: [<Payment>], checks, violations, emails: [{ kind, to, subject, createdAt, sentAt, error }], cancellation, cancellable }` |
| `POST /manage/tickets/{code}/cancel` | `{ reason }` (3–300) | detail jako výše; zruší objednávku nebo vystavenou neodevzdanou místenku (i zadrženou), uvolní místo, držitel vystavené dostane e-mail `ticket_cancelled`. Peníze se nevracejí automaticky. `409 not_cancellable` |
| `GET /manage/payments` | `?state=open` (k vyřešení, výchozí) \| `all` | `{ payments: [<Payment>] }` |
| `POST /manage/payments/{id}/resolve` | `{ action: "assign" \| "refunded" \| "ignored", note?, ticketCode? }` | `{ payment }`. `assign` vystaví místenku k objednávce (`ticketCode`, jinak ta podle VS) bez kontroly částky a kapacity – rozhoduje správce. `400 invalid_action`, `ticket_required`; `409 already_resolved`, `already_paid`, `not_assignable` |
| `GET /manage/vouchers` | – | `{ vouchers: [{ code, revirId, revir, note, createdAt, usedAt, ticketCode, voidedAt, state: "valid" \| "used" \| "voided" }] }` |
| `POST /manage/vouchers` | `{ count: 1–50, revirId?, note? }` | `201 { vouchers }`; `400 invalid_count`, `unknown_revir` |
| `POST /manage/vouchers/{code}/void` | – | `{ voucher }`; zneplatněný poukaz je neplatný (`GET /vouchers` → `valid: false`, objednávka → `400 invalid_voucher`); `409 not_voidable` |

```jsonc
// Payment
{ "id": 12, "provider": "fio", "transactionId": "…", "bookedAt": "…", "amountHalere": 15000, "currency": "CZK", "variableSymbol": "7583019737",
  "counterAccount": "…", "counterName": "…", "message": "…", "result": "amount_mismatch", "note": "očekáváno 20000 haléřů CZK", "createdAt": "…",
  "ticket": { "code": "D4KM3R", "holder": "Eva Štiková" }, "needsAction": true, "resolution": null /* { action, note, at } */ }
```

## Nastavení (B5)

Konfigurace = soubor (`config/organization.json` + pravidla druhů, ve WordPressu výchozí hodnoty pluginu) **+ poslední uložená verze každé části z manažerského portálu**. Každé uložení vytvoří novou verzi celé části s autorem a poznámkou (`settings_versions`); změna platí okamžitě (i pro `GET /config`), před uložením se zkontroluje celá konfigurace. Obnovení starší verze nebo výchozích hodnot ze souboru = uložení kopie jako nové verze, historie se nepřepisuje. Zdroj plateb (`fake` / `fio`) a Fio token zůstávají jen v konfiguraci serveru.

| Část (`scope`) | Obsah | Kdo |
| --- | --- | --- |
| `organization` | `{ organization (vč. contact), returnPolicy: { lateReturnDays }, salesPolicy: { bookingDaysAhead }, publicCheck, limitPolicy, penaltyPolicy, privacy }` (e-maily ne – viz E-mailoví klienti) | správce, admin |
| `payment` | `{ accountNumber, bankCode, recipientName, reservationMinutes, messagePrefix }` – po změně dostanou všichni admini e-mail `payment_settings_changed`; v portálu **Admin → Bankovní spojení** (podsekce Platební brána je zatím jen připravená, nepodporováno) | **jen admin** |
| `revir:<id>` | revír bez `id` a odvozených `fishRules` (cena, kapacita, podrevíry, doba lovu, texty, pravidla, `speciesOverrides`, …) | správce, admin |
| `species:<odkaz>` | dokument pravidel druhů (druhy, míry, hájení, `dailyLimits`, `periodLimits`) | správce, admin |

| Endpoint 🛠 | Tělo | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/settings` | – | `{ organization: { data, version, source: "file" \| "database", updatedAt, updatedBy }, payment: { data, iban, provider, … }, reviry: [{ id, data, … }], species: [{ ref, data, … }], canEditPayment }` |
| `PUT /manage/settings/organization` | `{ data, note? }` | `{ scope, version, settings }`; `400 invalid_settings` (zpráva říká co je špatně) |
| `PUT /manage/settings/payment` | `{ data, note? }` | totéž; `403 forbidden_role` pro správce |
| `POST /manage/settings/reviry` | `{ id, data, note? }` | `201`; nový revír (id `a-z0-9-`, nelze změnit); `409 revir_exists` |
| `PUT /manage/settings/reviry/{id}` | `{ data, note? }` | `200`; `404` |
| `PUT /manage/settings/species` | `{ ref, data, note? }` | `200`; `404` |
| `GET /manage/settings/history?scope=` | – | `{ scope, versions: [{ version, note, createdAt, createdBy }], hasFile }` |
| `GET /manage/settings/versions/{id}` | – | `{ scope, version, data, createdAt }` |
| `POST /manage/settings/versions/{id}/restore` | – | jako uložení |
| `POST /manage/settings/reset` | `{ scope }` | výchozí hodnoty ze souboru jako nová verze |
| `GET /manage/settings/export` (jen admin) | – | `{ organization, species, exportedAt }` – platná konfigurace ve tvaru souborů (záloha, převod do WordPressu) |

Odevzdaná místenka si ukládá verzi pravidel, podle které byla zkontrolována (`rulesVersion`, např. `crs-smas-mp-2026-2027@v12` nebo `…@soubor`; vidí ji správce v detailu místenky). Cena se ukládá k objednávce, změna ceny platí jen pro nové objednávky.

## Zarybnění a přehledy (B6)

Pro `manager`/`admin` (🛠).

**Zarybnění** – skutečné nasazení (`planned: false`) i plán (`planned: true`, datum = předpoklad). Realizace plánu = úprava záznamu na `planned: false` se skutečnými údaji. Druh se převede na kanonický název podle pravidel revíru (neznámý se přijme, jak je zadán).

| Endpoint | Tělo / parametry | Odpověď / chyby |
| --- | --- | --- |
| `GET /manage/stocking` | `?year=&revirId=&planned=0\|1` | `{ stocking: [{ id, revirId, revir, subdistrict, date, planned, speciesId, species, ageClass, kg, pieces, costHalere, supplier, note, … }], ageClasses }` |
| `POST /manage/stocking`, `PUT /manage/stocking/{id}` | `{ revirId, date, species, subdistrict?, ageClass?, kg?, pieces?, costCzk?, supplier?, note?, planned? }` (kg nebo kusy povinné) | `201 { stocking }` / `{ stocking }`; `400 unknown_revir`, `invalid_date`, `invalid_species`, `invalid_amount`, `invalid_number`, `invalid_subdistrict` |
| `DELETE /manage/stocking/{id}` | – | `{ deleted: true }` |
| `GET /manage/stocking/budget?year=` | – | `{ year, budgets: [{ revirId, revir, amountHalere, note, spentHalere, plannedHalere, total }] }` – poslední řádek `total: true` (`revirId: null`) je součet revírů |
| `PUT /manage/stocking/budget` | `{ year, revirId, amountCzk (null = smazat), note? }` – jen pro revír (`400 unknown_revir` bez revíru) | jako GET |

**Přehledy** – `GET /manage/stats?seasonId=` (přehled **za sezonu**: období od otevření do uzavření, neuzavřená do dneška, revír podle sezony; neznámá → `404`), nebo `GET /manage/stats?from=&to=&revirId=` (vlastní období, klidně přes více sezon; den lovu / den zarybnění v období). Odpověď vždy říká, z jaké sezony je: `season` (sezona přehledu, nebo `null` u vlastního období) a `seasons` (všechny sezony, do kterých období zasahuje: `[{ id, name, revirId, revir, opensOn, closesOn }]`). `groups` = úlovky a bilance po podrevírech (`[{ revirId, revir, subdistrict, label, catches: { total, weightKg, bySpecies }, balance }]`, `subdistrict: null` = celý revír), prázdné, když žádné úlovky ani zarybnění podrevír nemají. `bySubdistrict` = tržby po podrevírech (v portálu tabulka „Tržby“):

```jsonc
{ "from": "2026-01-01", "to": "2026-12-31", "revirId": null, "revir": "Všechny revíry", "generatedAt": "…",
  "summary": { "sold": 120, "returned": 110, "returnedLate": 6, "noCatch": 40, "awaitingReturn": 2, "returnDeadline": "2026-12-07", "unreturned": 2, "upcoming": 6, "seized": 1,
               "cancelled": 2 /* zaplacené a zrušené */, "vouchers": 3, "revenueHalere": 2340000, "anglers": 61 },
  "catches": { "total": 95, "weightKg": 180.4, "bySpecies": [{ "species": "kapr obecný", "count": 50, "weightKg": 140.2, "weighed": 44, "estimated": 30, "avgLength": 52.1, "maxLength": 69 }] },
  "stocking": { "costHalere": 2120000, "bySpecies": [{ "species": "kapr obecný", "pieces": 300, "kg": 150, "costHalere": 1800000 }] },
  "balance": [{ "species": "kapr obecný", "caughtCount": 50, "caughtKg": 140.2, "stockedPieces": 300, "stockedKg": 150, "balanceKg": 9.8 }],   // uloveno vs. nasazeno
  "byMonth": [{ "month": "2026-11", "tickets": 4, "catches": 5, "revenueHalere": 80000, "stockingHalere": 2120000 }],
  "bySubdistrict": [{ "revirId": "petruvka-1a", "revir": "Petrůvka 1 A", "number": "1", "label": "1 – Petr 1", "tickets": 4, "revenueHalere": 80000, "catches": 5 }] }   // jen místenky na podrevír
```

Hmotnost úlovků se sčítá jen z vyplněných nebo dopočtených hodnot (`weighed` z `count`). Neodevzdané místenky po dni lovu se dělí: `awaitingReturn` = lhůta pro odevzdání ještě běží (lze je odevzdat nejpozději `returnDeadline`, poslední den nejzazší lhůty; jinak `null`), `unreturned` = uzavřené po lhůtě jako neodevzdané. `upcoming` = den lovu dnes nebo později. Platí `sold = returned + awaitingReturn + unreturned + upcoming`. Dokud je `awaitingReturn > 0`, statistika není konečná (portál to u přehledu i uložené uzávěrky upozorní).

**Uzávěrky** – uložená statistika za období. Automatická (`kind: "season"`) vznikne plánovanou úlohou (jednou) až po lhůtě pro odevzdání posledního dne sezony – den po `closesOn + lateReturnDays`, takže je konečná se všemi odevzdanými úlovky; příjemci upozornění dostanou e-mail `season_report` a vznikne trvalá záloha; ruční (`kind: "manual"`) za libovolné období.

| Endpoint | Tělo | Odpověď |
| --- | --- | --- |
| `GET /manage/reports` | – | `{ reports: [{ id, name, kind, seasonId, season (název sezony nebo null), revirId, revir, from, to, createdAt }] }` |
| `POST /manage/reports` | `{ seasonId, name? }` (uzávěrka za sezonu, výchozí název „Uzávěrka – <sezona>“), nebo `{ from, to, revirId?, name? }` (vlastní období) | `201` uzávěrka s `data` (tvar jako `/manage/stats`); `404` neznámá sezona |
| `GET /manage/reports/{id}` | – | uzávěrka s `data` |

## Zálohy a audit (B7)

Jen `admin` (jinak `403 forbidden_role`; bez 2FA `403 mfa_required`).

- **Denní záloha** během sezony (dnes je otevřená některá sezona, nebo žádná sezona není nastavená): plánovaná úloha jednou za den (Praha); drží se **poslední a aktuální** (2), starší se smažou.
- **Po každé uzávěrce sezony** jedna trvalá záloha (`kind: "season"`, poznámka = název uzávěrky).
- **Ruční** záloha admina, trvalá do smazání.
- Node: konzistentní kopie SQLite (`VACUUM INTO`) do `DATA_DIR/backups/`. WordPress: export všech tabulek pluginu (konzistentní snímek) jako JSON komprimovaný gzipem (`*.json.gz`) do datové složky mimo veřejný přístup (`MISTENKA_DATA_DIR`, výchozí `wp-content/mistenka-data` s `.htaccess` deny), stejná pravidla.
- **Obnova z portálu** (`POST /manage/backups/{id}/restore` `{ confirm: "OBNOVIT", otp }`): znovu se ověří kód 2FA (`401 otp_required` / `invalid_otp`), bez potvrzení `400 confirm_required`, poškozená záloha `409 backup_corrupt`. Nejdřív vznikne pojistná záloha (`kind: "pre-restore"`), záloha se převede na aktuální schéma a data se přepíší v jedné transakci; nepřepisují se přihlášení (`sessions`), seznam záloh a technická metadata. Nastavení se znovu načte. Odpověď `{ restored, file, safetyBackup, rows }`.
- **Automatická obnova při startu** (jen Node/SQLite; MySQL ve WordPressu hlídá hosting): pokud kontrola integrity databáze selže, server ji odloží do `DATA_DIR/corrupt/`, nahradí nejnovější platnou zálohou, zapíše do auditu (`database_auto_restored`) a pošle všem adminům e-mail `database_auto_restored`. Bez platné zálohy server nenastartuje.

| Endpoint | Tělo | Odpověď |
| --- | --- | --- |
| `GET /manage/backups` | – | `{ backups: [{ id, kind: "daily" \| "season" \| "manual", file, sizeBytes, note, reportId, createdAt, exists }], dailyKeep: 2, totalBytes }` |
| `POST /manage/backups` | `{ note? }` | `201 { backup }` |
| `GET /manage/backups/{id}/download` | – | soubor zálohy (Node `application/vnd.sqlite3`, WordPress `application/gzip`) |
| `DELETE /manage/backups/{id}` | – | `{ deleted: true }` |
| `GET /manage/audit?limit=200&action=` | – | `{ events: [{ id, at, action, actor, targetType, targetId, detail }] }` – změny rolí, nastavení, plateb, zadržení, blokace, zálohy … |

## Ochrana osobních údajů (GDPR)

- Stránka `privacy.html` – obecné zásady pro místní organizaci rybářského svazu; správce, kontakt a lhůty se doplní z konfigurace (`GET /config` → `organization.address`, `organization.ico`, `privacy`).
- `privacy` v nastavení organizace (`organization` scope): `{ contactEmail, ticketYears: 3, accountingYears: 10, emailDays: 90, auditYears: 5, backupYears: 3 }`.
- Plánovaná úloha jednou denně:
  - místenky z let `<= aktuální rok − ticketYears − 1` → anonymizace údajů držitele (jméno, e-mail, datum narození, číslo legitimace, vazba na účet, důvody zadržení/zrušení), smazání tokenů a obsahu jejich e-mailů; úlovky, ceny a VS zůstávají (`anonymized_at`),
  - ukončené blokace starší než lhůta místenek → smazat,
  - bankovní transakce starší než `accountingYears` → odstranit účet, jméno a zprávu plátce,
  - odeslané e-maily starší než `emailDays` → smazat,
  - audit starší než `auditYears` → smazat,
  - zálohy (všechny druhy) starší než `backupYears` → smazat.
- Registrace: pole `consent: true` znamená potvrzení, že se uživatel seznámil se zásadami (právní základ účtu je smlouva, ne souhlas).

## Porybný (B2)

Veřejná kontrola (`GET /tickets/{code}`) zůstává pro každého. Přihlášený uživatel s rolí `warden` navíc (jinak `401 unauthorized` / `403 forbidden_role`; admin bez 2FA `403 mfa_required`):

### `GET /warden/tickets/{code}`
Plná kontrola. Každé otevření se zapíše do záznamu kontrol (`ticket_checks`: porybný, čas, stav); opakované otevření stejným porybným do 10 minut se nezapisuje znovu. Nevystavená místenka → `409 not_issued`.

```jsonc
// WardenTicket = PublicTicket bez "holder" +
{ "firstName": "Jan", "lastName": "Novák", "birthDate": "1980-05-15", "memberId": "12345678",
  "returnedAt": null, "noCatch": false, "catches": [],
  "seizable": true,                       // jen stav active
  "memberRoles": ["member", "warden"],    // funkce držitele: role jeho účtu (podle účtu místenky nebo čísla legitimace), bez účtu ["member"]
  "seizure": null,                        // { at, reason, place, wardenName }
  "checks": [{ "wardenName": "Petr Strážný", "at": "…", "status": "active" }],   // nejnovější první, max. 20
  "memberHistory": {                      // vystavené místenky téhož čísla legitimace v týdnu (po–ne) a měsíci dne lovu
    "week": { "from": "2026-06-08", "to": "2026-06-14" }, "month": { "from": "2026-06-01", "to": "2026-06-30" },
    "tickets": [{ "code": "…", "date": "…", "revir": "Petrůvka 1 A", "status": "active", "current": true, "inWeek": true, "inMonth": true, "noCatch": false, "catches": [] }]
  } }
```

### `POST /warden/tickets/{code}/seize`
Tělo `{ reason, place? }` (důvod 3–500 znaků, místo do 200). Zadržet lze jen stav `active` (`409 not_seizable`), jednou (`409 already_seized`). Lov okamžitě končí, stav `seized`. Držitel dostane e-mail `ticket_seized` s odkazem na odevzdání, správci upozornění `seizure_notice` (příjemci upozornění z Emailoví klienti). Zapíše se do záznamu kontrol a auditu. Odpověď: `<WardenTicket>`. Chyby: `400 invalid_reason`, `invalid_place`.

Připomínka odevzdání chodí i zadrženým místenkám (po skončení dne lovu).

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
5. úklid účtů: smazání neověřených účtů starších 48 h, prošlých relací a odkazů,
6. automatické uzávěrky skončených sezon (+ trvalá záloha),
7. denní záloha během sezony,
8. uchovávání osobních údajů (anonymizace a mazání po lhůtách),
9. odeslání fronty e-mailů.

`POST /jobs/run` vyžaduje hlavičku `X-Mistenka-Cron-Key` s tajným klíčem z konfigurace serveru; bez něj `404`.

## E-maily

| Druh | Kdy | Odkaz |
| --- | --- | --- |
| `payment_instructions` | nová nezaplacená objednávka | `payment.html?code=…#t=<token>` |
| `ticket_issued` | místenka vystavena | místenka + `return.html?code=…#t=<token>` |
| `return_reminder` | po dni lovu, neodevzdaná, lhůta běží; upozorní na automatické uzavření | `return.html?code=…#t=<token>` |
| `ticket_closed` | místenka uzavřena jako neodevzdaná | kontakt na hospodáře |
| `account_verify` | registrace, přihlášení neověřeného účtu | `account.html#verify=<token>` |
| `account_exists` | registrace s e-mailem existujícího ověřeného účtu | `account.html` |
| `magic_link` | žádost o přihlášení bez hesla | `account.html#login=<token>` |
| `password_reset` | žádost o obnovu hesla | `account.html#reset=<token>` |
| `email_change` | změna e-mailu v profilu (jde na novou adresu) | `account.html#email=<token>` |
| `ticket_seized` | porybný zadržel místenku | `return.html?code=…#t=<token>` |
| `seizure_notice` | totéž, příjemcům upozornění správcům | `status.html?code=…` |
| `limit_exceeded` | odevzdání s překročeným limitem, příjemcům upozornění správcům | `status.html?code=…` |
| `member_blocked` | automatická blokace po opakovaném porušení limitů (držiteli) | – |
| `ticket_cancelled` | správce zrušil vystavenou místenku | – |
| `season_report` | automatická uzávěrka po skončení sezony, příjemcům upozornění správcům | `manage.html#reports/<id>` |
| `database_auto_restored` | databáze obnovena ze zálohy při startu (všem adminům) | – |
| `payment_settings_changed` | admin změnil platební údaje (všem adminům) | – |
| `closure_notice` | mimořádné uzavření revíru na den místenky | `status.html?code=…` |
| `staff_invite` | admin pozval správce/admina | `account.html#invite=<token>` |
| `warden_request` | žádost „Jsem porybný“, příjemcům upozornění správcům | `request.html#t=<token>&a=approve\|reject`, `manage.html#notifications` |
| `warden_request_approved` / `_rejected` | správce žádost vyřídil (žadateli) | – |
| `account_deleted` | smazání účtu | – |

Odesílají se přes frontu (tabulka `email_outbox`, sloupec `sender` = přes který účet odešel; detail místenky ho ukazuje). Odcházejí výhradně přes SMTP účet skupiny (viz E-mailoví klienti); skupina bez odesílatele počká. E-maily vzniklé během požadavku odejdou hned po odeslání odpovědi (WordPress), ostatní plánovanou úlohou. Neúspěšné odeslání se zkusí znovu (WordPress nejvýš jednou za hodinu, e-maily starší 7 dní se už neposílají).

## Vývojové endpointy

Jen pro vývoj a testy. Na produkci musí být nedostupné (`404`).

| Endpoint | Dostupnost | Účel |
| --- | --- | --- |
| `POST /dev/payments` `{ code }` nebo `{ variableSymbol, amountHalere, currency? }` | `payment.provider = fake` | simulace příchozí platby → `{ result }` |
| `POST /dev/clock` `{ now: ISO \| null }` | vývojový režim | posun času serveru (a spuštění úloh) |
| `POST /dev/vouchers` `{ code?, revirId? }` | vývojový režim | vytvoření poukazu |
| `POST /dev/jobs` | vývojový režim | okamžité spuštění plánovaných úloh |
| `POST /dev/users/roles` `{ email, roles }` | vývojový režim | nastavení rolí bez kontroly oprávnění (testy) |
| `POST /dev/setup-token` | vývojový režim, žádný admin | nový token průvodce `{ token }` (testy) |
| `GET /dev/outbox?to=<email>` | vývojový režim | posledních 20 e-mailů pro adresu `{ emails: [{ kind, to, subject, text, createdAt }] }` (testy čtou odkazy s tokeny) |
