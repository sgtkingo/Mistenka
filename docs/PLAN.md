# Místenka – validace záměru a plán realizace

Stav podkladů: 6. 11. 2026, aktualizace platformy 17. 11. 2026. Jde o návrh pro pilot jednoho revíru, nikoli o potvrzení právní ani provozní způsobilosti. Ceny a podmínky služeb před spuštěním znovu ověřit.

## Aktualizace 17. 11. 2026: platforma WordPress

Cílová platforma se mění z Cloudflare Workers + D1 na **WordPress plugin** na webu organizace. Sekce „Doporučený tech stack“ níže je tím nahrazena; validace plateb, párování, právních otázek a datového modelu zůstává platná.

### Prostředí (hotovo a ověřeno)

| Položka | Stav |
| --- | --- |
| Web | `rybarikarvina.cz`, Active24 (administrace Websupport), WordPress 7.1.4, PHP 8.3, OPcache, šablona Graphene 2.9.6 |
| Aplikace | `mistenka.rybarikarvina.cz` – alias stejné instalace WP, plugin podle hostu vykreslí aplikaci místo webu; wildcard DNS a certifikát Let's Encrypt; HTTP cache vypnutá |
| Test | `test.rybarikarvina.cz` – samostatná kopie webu a DB (`rybarikarv_test`), neindexovaná; každou změnu ověřit nejdřív zde |
| REST API | WordPress nemá „hezké“ trvalé odkazy → volat `/?rest_route=/mistenka/v1/...`, ne `/wp-json/...` |
| E-mail | WP Mail SMTP, odesílatel `mistenka@rybarikarvina.cz` (`smtp.websupport.cz:465`, SSL); SPF, DKIM a DMARC nastaveny; doručení do Gmailu ověřeno. Plugin volá jen `wp_mail()` |
| Ověřovací plugin | `src/wordpress-plugin/mistenka-demo` (v0.2.0) – subdoména, REST, zápis do DB a e-mail ověřeny na ostrém webu |
| Sestavení | `python scripts/build-plugin.py [plugin]` → `dist/<plugin>.zip` |

### Způsob vývoje: dvojí implementace

- **Node.js (`server.js`, SQLite)** slouží k rychlému lokálnímu vývoji a ověřování UX. **PHP plugin** je produkční implementace stejného chování.
- Frontend (HTML/JS/CSS) existuje **jen v jedné kopii**; plugin ho při sestavení převezme. Rozdíl mezi prostředími řeší jediná konfigurační hodnota s prefixem API (`/api` vs. `/?rest_route=/mistenka/v1`).
- Rozjetí obou verzí brání **smlouva API** (`docs/API.md`) a **sdílené testy API** spustitelné proti oběma serverům (`node test/api.test.js --base=<url>`). Změna chování = změna smlouvy + testu + obou implementací v jednom commitu.
- Node verze nemá odchylky „jen pro demo“, které by PHP neumělo: stejné stavy, validace, chybové kódy a formát dat.

### Úkoly v Node verzi před převodem do WordPressu

Pořadí odpovídá závislostem. Položky A jsou podmínkou převodu, B mohou následovat.

> **Stav 17. 11. 2026: A1–A6 hotovo v Node verzi** (13 sdílených testů API prochází). Platby běží přes falešnou banku; adaptér Fio je napsaný, ale neověřený proti skutečnému účtu. Rozhodnutí při implementaci:
> - Repozitář rozdělen na `src/frontend/` (jediná kopie UI), `src/node/`, `src/wordpress-plugin/` a `config/`. MO a revíry jsou plně v konfiguraci; více revírů = výběr na úvodní stránce (`?revir=<id>`), jiná MO = jiný konfigurační soubor.
> - Držitel se identifikuje **číslem členské legitimace** (8 číslic pod čárovým kódem), ne číslem rybářského lístku. Odevzdání a detail: token z odkazu v e-mailu **nebo** číslo legitimace. Neúspěšné pokusy jsou omezené na IP.
> - Kontrola: lehkou kontrolu stavu smí provést kdokoli (jméno a maskované číslo legitimace, `publicCheck`), nic nemění. Po zavedení uživatelských účtů bude rybářská stráž moci místenku **zadržet** (B2).
> - Odevzdání: včas do konce dne lovu, opožděně do `lateReturnDays` (**7 dní**). Pak se místenka automaticky uzavře jako neodevzdaná, bez úlovku (`closed_unreturned`) a držitel dostane e-mail; připomínka po dni lovu na uzavření upozorňuje předem. **Další následky neodevzdání zatím nejsou definované.**
> - Pozdní platba po vypršení rezervace se přijme automaticky, jen pokud den lovu neuplynul a místo je volné; jinak jde k ručnímu řešení.
> - Předpověď počasí je skutečná: Open-Meteo podle GPS revíru, přímo z prohlížeče (bez API klíče; licence Open-Meteo je pro nekomerční užití – před ostrým provozem ověřit). Ukázkové počty míst nahradila skutečná dostupnost; e-mail se zadává už ve druhém kroku.
> - GitHub Pages se už nepoužívají (workflow odstraněn).
> - Druhy ryb a pravidla v samostatném souboru `config/species/crs-smas-mp-2026-2027.json` (44 druhů, míry podle BPVRP ÚS SMaS 2026–2027 a vyhlášky 197/2004 Sb., hájení, denní limity 2 ks významných / 3 ks lososovitých / 5 ks ostroretky). Kontroluje se při odevzdání na serveru i ve formuláři. Týdenní/měsíční/roční limity čekají na uživatelské účty (historie člena). Koeficienty pro odhad hmotnosti jsou orientační.

**A1. Smlouva API a testy**
- Sepsat `docs/API.md`: endpointy, vstupy, výstupy, stavy místenky, chybové kódy a texty.
- Sdílená sada testů API (nákup, poukaz, kontrola, odevzdání, chybové stavy, souběh).
- Konfigurovatelný prefix API ve frontendu.

**A2. Opravy datového modelu**
- Datum lovu ukládat jako ISO datum (`YYYY-MM-DD`), ne český text. Současné `ticketDate()` doplňuje aktuální rok, takže místenky přes přelom roku se vyhodnotí špatně. Formátování „8. listopadu“ jen v UI.
- Časové výpočty platnosti v pásmu Europe/Prague (začátek a konec dne, změna času).
- Cenu, údaje revíru (název, číslo, účet) a kapacitu přesunout z kódu (`200 Kč`, `Petrůvka 1 A · 471 115`) do konfigurace nebo tabulky; částky v haléřích.
- Denní kapacitu hlídat na serveru atomicky v transakci, ne jen v UI.

**A3. Ochrana osobních údajů a přístupu**
- `GET /api/tickets/{code}` teď vrací e-mail a datum narození komukoli, kdo zná šestimístný kód. Veřejná kontrola smí vracet jen stav, datum a minimum identifikace (dle rozhodnutí o kontrole, viz REPLY níže, např. jméno a zkrácené číslo lístku).
- Odevzdání (`PATCH`) chránit samostatným dlouhým náhodným tokenem z e-mailu a stránky místenky (uložený jako hash), ne jen kódem. Omezit počet pokusů o hádání kódů.
- Escapovat všechna data vkládaná přes `innerHTML` (jména, kódy, druhy ryb) – `app.js`, `payment.js`, `return.js`, `status.js`.
- Odebrat `Access-Control-Allow-Origin: *`; WordPress bude same-origin.

**A4. Platba převodem (QR + Fio)**
- Nový tok: objednávka → stav `pending_payment` s **číselným VS** (kód místenky je hex, do VS nepatří) a expirací rezervace → platba → `issued`. Místenka se nevydá před připsáním platby (dnes se vytváří hned po odeslání formuláře).
- QR Platba (SPAYD): IBAN organizace, částka, VS, zpráva; vedle QR ruční údaje. Generovat na serveru ze stejné objednávky.
- Adaptér Fio API: token jen pro čtení v konfiguraci serveru (Node `.env`, WP `wp-config.php`), nikdy v repozitáři ani v logu; dotaz `last` max. 1× za 30 s; deduplikace podle ID transakce (unikátní index); párování VS + částka + CZK.
- Výjimky do fronty k ručnímu řešení: chybný/chybějící VS, jiná částka, duplicita, platba po expiraci.
- Stránka čekání na platbu s průběžnou kontrolou stavu (dotaz na náš server, ne na banku).
- Pro vývoj: simulovaný zdroj transakcí (fixture JSON) se stejným rozhraním jako Fio adaptér.
- WordPress: plánovaná úloha přes **skutečný cron Active24** volající endpoint chráněný tajným klíčem; na `wp-cron` (spouští se jen při návštěvě) nespoléhat.

**A5. Místenka a e-maily**
- Skutečný QR kód místenky (odkaz na kontrolu, bez tokenu pro odevzdání) místo `fake-qr` v UI i v PDF.
- E-mail po zaplacení: kód, datum, odkaz na místenku a na odevzdání (s tokenem). V Node verzi zápis do souboru nebo SMTP přes `.env`; ve WP `wp_mail()`.
- Připomínka odevzdání po skončení platnosti (plánovaná úloha).

**A6. Odevzdání úlovků**
- Povolit nulové hlášení („bez úlovku“) – dnes API vyžaduje alespoň jeden úlovek.
- Lhůta 24 h po konci platnosti vynucená na serveru; pozdní odevzdání označit (`late`).

#### Část B: účty, porybný, limity a správa (rozhodnuto 17. 11. 2026)

Vše nejdřív v Node verzi. WordPress (WP uživatelé s vlastními rolemi, přihlášení na subdoméně, nonce) se řeší až po dokončení Node verze.

**Role a portály.** Role jsou sada oprávnění, ne žebříček:

| Role | Kdo ji přiděluje | Co může |
| --- | --- | --- |
| `member` (uživatel) | registrace | uživatelský portál: aktuální místenka, klientská zóna, vlastní údaje (předvyplní se při nákupu), historie místenek |
| `warden` (porybný) | správce nebo admin | navíc plná kontrola místenky a zadržení |
| `manager` (správce) | admin | uživatelský portál + přepnutí do manažerského portálu |
| `admin` | admin | jako správce + jmenuje a odvolává správce a adminy, mění platební údaje, spravuje zálohy |

- Manažerský portál je součástí stejného frontendu (`manage.html`), ne stránka ve wp-admin, aby ho měla i Node verze.
- 2FA (TOTP): pro admina povinná, pro správce volitelná. Zatím jediný admin je autor projektu, správců se čeká do 10. Posledního admina nelze odebrat.
- Přihlášení heslem **i** odkazem z e-mailu (bez hesla). Nákup bez účtu dál funguje.
- Číslo členské legitimace je unikátní na účet. Po ověření e-mailu se k účtu připojí dřívější místenky se stejným e-mailem a číslem legitimace.

**B1. Uživatelské účty a uživatelský portál** – *hotovo v Node verzi 17. 11. 2026 (20 sdílených testů API).* Prvního admina zakládá průvodce prvním spuštěním (jednorázový odkaz z konzole, admin vzniká rovnou s 2FA); správce a adminy admin zve e-mailem. Účty správců nemusí mít rybářské údaje. Relace v HttpOnly cookie + hlavička `X-Mistenka-Csrf`; ve WP se mapuje na nonce `wp_rest`.
- Registrace s ověřením e-mailu (heslo volitelné, min. 8 znaků, zadává se dvakrát; datum narození v českém tvaru d. m. rrrr), přihlášení heslem nebo odkazem, obnova hesla, odhlášení. Neověřené účty se po 48 h mažou.
- Klientská zóna (`account.html`): aktuální místenka, historie místenek, úprava údajů (změna e-mailu s ověřením), změna hesla, 2FA, smazání účtu. Místenky zůstávají kvůli evidenci, jen se odpojí od účtu.
- Přihlášenému se formulář nákupu předvyplní. Místenka koupená přihlášeným se uloží k účtu a držitel ji otevře bez tokenu.
- Správa rolí (`manage.html` → Uživatelé): správce jmenuje porybné, admin správce a adminy. Každá změna role jde do auditu.

**B2. Porybný: plná kontrola a zadržení** – *hotovo v Node verzi 17. 11. 2026.* Porybný kontroluje na stránce kontroly (QR z místenky), správce upozorňuje e-mail na `organization.managerEmail`. Upozornění na limity při kontrole doplní B3.
- Veřejná kontrola zůstává (jméno a maskované číslo legitimace). Porybný (platí pro celou MO) po přihlášení navíc uvidí celé číslo legitimace, datum narození a úlovky člena v aktuálním týdnu a měsíci, včetně upozornění na překročené limity.
- Každá kontrola porybného se zaznamená (kdo, kdy, která místenka), obdoba zápisu stráže do povolenky.
- **Zadržení** = nový stav `seized` s důvodem a místem. Lov končí okamžitě, místenka neplatí. Držitel ji i tak musí odevzdat s úlovky. Držitel dostane e-mail, správce jen upozornění (zadržení nepotvrzuje).

**B3. Týdenní a měsíční limity úlovků** – *hotovo v Node verzi 17. 11. 2026 (28 sdílených testů API).* Pravidla v `periodLimits` souboru druhů, automatická blokace v `limitPolicy` (zatím v konfiguraci, do portálu v B5); „sezona“ pro počítání porušení = kalendářní rok, dokud nebudou sezony (B4).
- Počítají se podle čísla legitimace, tedy i u nákupů bez účtu. Pravidla podle BPVRP ÚS SMaS: kapr, štika, candát, amur, bolen, sumec, lín a parma dohromady 4 ks týdně a 10 ks měsíčně (krátkodobé povolenky); ostroretka 15 ks týdně; kapr 2 ks týdně na revíru nebo podrevíru do 5 ha (Petr 1 má 1,7 ha → platí). Týden je kalendářní (po–ne). Podrevíry dostanou výměru, pravidla podmínku `maxAreaHa`.
- Limity platí na všech revírech svazu dohromady, my vidíme jen místenky. V UI proto vždy „podle místenek v Místence“.
- **Překročení nikdy neblokuje odevzdání ani nákup.** Rybář dostane upozornění, správce e-mail na kontaktní adresu správce (nová položka organizace, nastavitelná v portálu), porybný upozornění při kontrole. Stejně se bude chovat i denní limit (dnes `400 daily_limit` → upozornění). Lovné míry a hájení dál odevzdání blokují (taková ryba se nesmí přisvojit).
- Správce může člena ručně zablokovat (nákup místenek) a nastavit automatické pravidlo, např. „po 2 porušeních v sezoně blokace na N dní / do konce sezony“.

**B4. Manažerský portál: provoz** – *hotovo v Node verzi 18. 11. 2026 (35 sdílených testů API).*
- Seznam místenek s filtry a detailem, zrušení, fronta nespárovaných plateb, zadržené místenky, porušení limitů, blokace členů, poukazy, export CSV.
- **„Důležité“:** zprávy pro MO nebo konkrétní revír, volitelně platnost od–do, jinak do smazání. Na úvodní stránce nejvýš 3 aktivní (přepínání tečkami). Nahradí `notice` v konfiguraci.
- Sezona: otevření a uzavření, mimořádné uzavření jednotlivých dní.

**B5. Manažerský portál: nastavení** – *hotovo v Node verzi 18. 11. 2026 (38 sdílených testů API).* Revír nelze z portálu smazat (id je u místenek); pole, která formulář nenabízí, upraví admin jako JSON.
- Organizace, revíry, ceny, kapacity, kontakty (včetně e-mailu správce), pravidla revíru a tabulka ryb. `config/organization.json` zůstane jako výchozí data a import, změny se ukládají do DB s historií. Pravidla úlovků se verzují a místenka si pamatuje verzi, podle které se kontrolovala.
- Platební údaje (účet/IBAN) smí měnit jen admin; změna se audituje a oznámí e-mailem všem adminům. Fio token zůstává mimo DB.

**B6. Zarybnění, přehledy a uzávěrky** – *hotovo v Node verzi 18. 11. 2026 (41 sdílených testů API).* Uzávěrka se tiskne do PDF z prohlížeče.
- Zarybnění: datum, podrevír, druh, věková kategorie (K1–K3 …), kg, ks, cena, dodavatel. Plán zarybnění s rozpočtem, porovnání „uloveno vs. nasazeno“.
- Přehledy (sčoty): úlovky po druzích a obdobích, tržby, poukazy.
- **Automatická uzávěrka po ukončení sezony** (úlovky, tržby, zarybnění, docházka), uložená a exportovatelná.

**B7. Provoz a zálohy** – *hotovo v Node verzi 18. 11. 2026 (44 sdílených testů API): zálohy, obnova z portálu i automatická při poškození, audit, obecné zásady GDPR (`privacy.html`) a automatické lhůty uchování. Znění zásad a lhůty schvaluje výbor MO.* Další krok: ruční test Node verze (`docs/TEST_NODE.md`), pak převod do WordPress pluginu.
- Automatická záloha DB jednou denně během sezony; drží se poslední a aktuální. Po každé uzávěrce sezony jedna trvalá záloha. Spravovat, stahovat a mazat zálohy smí jen admin.
- Audit změn stavů a rolí, retenční lhůty osobních údajů, informace o zpracování osobních údajů na webu.

### Převod do WordPress pluginu

1. Plugin `src/wordpress-plugin/mistenka` (demo plugin zůstává jako šablona a pak se odstraní): aktivace vytvoří tabulky přes `dbDelta()`, odinstalace je volitelně smaže.
2. REST `mistenka/v1` podle `docs/API.md`; `$wpdb->prepare()`, transakce pro kapacitu, poukazy a párování.
3. Frontend převzatý z kořene repozitáře, vykreslený na `mistenka.rybarikarvina.cz` (detekce hostu jako v demo pluginu).
4. Sdílené testy API proti `test.rybarikarvina.cz`, pak ruční průchod nákup → platba (malá skutečná částka) → místenka → kontrola → odevzdání.
5. Nasazení na ostrý web, sledování prvních plateb a e-mailů.

### Otevřená rozhodnutí s organizací

- ~~Kontrola místenek: volná, nebo jen přihlášený porybný~~ → rozhodnuto: veřejná kontrola s minimem údajů + přihlášený porybný s plnými údaji a zadržením (B2).
- Číslo účtu Fio a souhlas s API tokenem jen pro čtení; kdo bude řešit nespárované platby a vracení peněz.
- Cena, denní kapacita, délka rezervace před zaplacením, pravidla storna.
- Odesílatel e-mailů: WP Mail SMTP má zapnuté „Force From Email“, takže z `mistenka@` jdou i systémové e-maily webu (obnova hesla apod.). Případně zřídit obecnou adresu webu.

## Závěr

Projekt je technicky realizovatelný na Cloudflare Workers a D1. Pro automatické párování převodů doporučuji **účet organizace u Fio banky a její API Bankovnictví**, s ručním řešením výjimek. QR platbu si aplikace generuje sama; bankovní API potřebuje až ke čtení příchozích plateb. Potvrzení není garantováno okamžitě.

Dvě věci podmiňují zahájení ostrého prodeje: určit právní postavení místenky vůči povolence a získat skutečný způsob ověření oprávnění rybáře. Z čísla rybářského lístku samotného nelze jeho platnost spolehlivě vyvodit; dostupné veřejné API pro tento účel se nepodařilo doložit. Automatické ověření je tedy zatím neověřený požadavek, nikoli hotová vlastnost návrhu.

## Banky a platební metoda

### Co přesně potřebujeme

1. Aplikace vytvoří českou QR Platbu podle [standardu ČBA](https://qr-platba.cz/wp-content/uploads/QR_platba_standard_CBA.pdf): účet příjemce ve formátu IBAN, částka v CZK a jedinečný variabilní symbol (VS). Vedle QR zobrazí i údaje pro ruční převod. QR kód je jen předvyplněný příkaz, nikoli potvrzení provedení platby.
2. Rybář platbu potvrdí ve své bankovní aplikaci. Ruční převod funguje i bez podpory QR. Před pilotem otestovat načtení QR a předání VS ve vybraných aplikacích zákazníků; nelze automaticky předpokládat podporu všech bank a zařízení. Na stejném mobilu nabídnout uložení či sdílení QR a ruční údaje, konkrétní chování ověřit na zařízeních.
3. Server pravidelně čte **zaúčtované příchozí transakce účtu organizace**, podle VS, částky, měny a účtu je přiřadí objednávce a teprve pak vystaví místenku. Banka plátce a banka příjemce jsou dvě odlišné otázky: napojit potřebujeme účet příjemce, nikoli API každé banky rybáře.

| Banka účtu příjemce | Ověřená možnost čtení pohybů | Vhodnost pro pilot |
| --- | --- | --- |
| **Fio banka** | [API Bankovnictví](https://www1.fio.cz/bankovni-sluzby/api-bankovnictvi) zdarma, token z internetového bankovnictví, JSON a další formáty. [Dokumentace](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf) uvádí minimální odstup 30 sekund na token. | **Doporučeno**: nejpřímočařejší doložené řešení; ověřit, že konkrétní organizace může účet a API používat. |
| **Komerční banka** | [Business API](https://www.kb.cz/cs/kbapi/caste-dotazy-rozcestnik/caste-dotazy) poskytuje pohyby ADAA; banka doporučuje dotaz jednou za 61 minut. [Přímé napojení](https://www.kb.cz/cs/podnikatele-a-firmy/sektorova-nabidka/nabidka-pro-e-commerce-male-firmy/api-psd2-sluzby) vyžaduje kvalifikovaný certifikát; dostupnost podle typu subjektu a sazebníku. | Možné, ale hodinová frekvence a podmínky nejsou vhodné pro rychlý prodej. Nezaměňovat s PSD2 API pro licencované třetí strany. |
| **Raiffeisenbank** | [Premium API](https://www.rb.cz/podnikatele/ucty-a-platebni-styk/prime-bankovnictvi/premium-api) umí pohyby a transakční historii, používá certifikát; příslušná oprávnění jsou dle banky zpoplatněna. | Potenciální další adaptér; předem zjistit podmínky konkrétního účtu, cenu, frekvenci a technickou dostupnost z Workers. |
| **Česká spořitelna** | [Premium API](https://www.csas.cz/cs/otevrene-bankovnictvi/premium-api) nabízí transakční historii a propojení firemních účtů. | Potenciální adaptér; přístup, cenu, oprávnění a frekvenci pro vlastní aplikaci je nutné ověřit u banky. |
| **ČSOB** | [Katalog API](https://www.csob.cz/csob/otevrene-bankovnictvi-csob/pro-vyvojare/seznam-api) uvádí PSD2 AIS a reporting; pro ostrá PSD2 data vyžaduje příslušné oprávnění/certifikaci. | Přímý jednoduchý přístup pro tento projekt a jeho cenu zatím nemáme potvrzené; ověřit reporting zvlášť. |
| **Air Bank** | [Banka výslovně uvádí](https://www.airbank.cz/pro-verejnost/), že API pro vlastní účely a e-shopy neposkytuje, přístup dává licencovaným a certifikovaným aplikacím třetích stran. | Vlastní přímý adaptér pro pilot na tomto základě neplánovat; případně prověřit licencovaného agregátora. |

Tabulka se týká **účtu příjemce**, není to seznam bank podporujících skenování QR u plátce ani úplný přehled českých bank. PSD2 přístup licencované třetí strany není totéž jako vlastní klientské či business API; [KB například u PSD2](https://www.kb.cz/cs/kbapi/psd2/registrace-do-sluzeb-psd2-kbsk-api) požaduje licenci a certifikát. Multibankovní agregátor může počet integrací snížit, ale jeho cenu, souhlasy a oprávnění je třeba ověřit; pro pilot není nutný.

### Bezpečné párování a výjimky

- VS přidělit unikátně na úrovni účtu příjemce, ukládat jako řetězec a po dobu retenční a reklamační lhůty jej znovu nepoužívat. Částky ukládat v haléřích. QR a ruční údaje generovat ze stejné objednávky.
- Přiřazovat pouze příchozí zaúčtovanou platbu se správným VS, CZK a přesnou částkou; jedinečný identifikátor bankovní transakce uložit s unikátním omezením. Opakované načtení ani souběh nesmí vydat druhou místenku. Jméno plátce není spolehlivý identifikátor.
- Chybějící či změněný VS, chybnou částku, duplicitu a nejednoznačnost zařadit k ručnímu prověření. Zaznamenat rozhodnutí správce. Vrácení peněz řeší oprávněná osoba v bankovnictví; samotné zrušení místenky převod nevrací.
- Rezervace kapacity vznikne před platbou a má jasně zobrazenou dobu expirace. Platba doručená po expiraci **automaticky nepřidělí již obsazené místo**: správce nabídne náhradní řešení či vrácení. Délku rezervace a chování při platbě v den lovu musí organizace schválit. Při výpadku banky nezobrazovat platbu jako potvrzenou.
- Fio číst centrálním plánovaným úkolem, například jednou za minutu, nikoli každým prohlížečem. Respektovat 30sekundový limit i při retry a souběhu; zacházet s HTTP 409 a výpadky s prodlevou. Interval není záruka rychlosti platby ani dostupnosti API. Použít překrývající se časový rozsah a deduplikaci, obnovu po výpadku a upozornění správci. Ověřit konkrétní API endpoint, časová omezení a kompletnost výsledků integračním testem.
- Token pouze pro čtení a jen na serveru jako secret; nevkládat jej do klienta, repozitáře ani logů. Fio používá token v URL: potlačit logování celé URL a citlivých odpovědí, připravit rotaci a odebrání tokenu.

## Validace funkčních požadavků

- **Právní význam:** Je místenka doplňkovou rezervací, nebo má představovat povolenku? [ČRS rozlišuje rybářský lístek a povolenku](https://www.rybsvaz.cz/jak-se-stat-rybarem); jejich potřebnost a požadované záznamy musí pro konkrétní revír ověřit jeho uživatel. Místenku nepovažovat automaticky za náhradu povolenky ani její evidence. REPLY: Místenka doplňkovou rezervací, platná povolenka a rybářský lístek nutností.
- **Ověření lístku:** [RIS zobrazuje údaje o lístku a povolenkách](https://ris.rybsvaz.cz/karta-rybare-rybarsky-listek-a-povolenky), což samo o sobě nedokládá veřejné integrační API ani přístup třetí strany. Zjistit u ČRS / správce oprávněný zdroj, právní titul, rozsah, dostupnost a smluvní podmínky. Bez něj lze ověřit pouze syntaxi a použít správce k doložené kontrole či výslovné prohlášení rybáře, pokud to organizace schválí; nesmí se tvrdit, že platnost byla automaticky ověřena. Pokud je skutečná automatická kontrola podmínkou prodeje, pilot spustit až po jejím zajištění. REPLY: pokud nebude API, pak jen čestné prohlášení rybáře, nebo obrazová kontrola dokladu. 
- **Kapacita a datum:** Schválit denní kapacitu, cenu, hranici „týden dopředu“ (včetně dneška nebo sedm dalších dní), začátek a konec platnosti a časové pásmo Europe/Prague. Datumy ukládat odděleně od časových okamžiků; atomicky chránit kapacitu i během souběžných objednávek.
- **Odevzdání:** Upřesnit začátek 24 hodin, zpracování pozdních odevzdání, připomínky a možnost hlášení bez úlovku. Ryby, které se evidují, délku a hmotnost určí správce podle pravidel revíru. Odhad hmotnosti musí být viditelně odhad, založený na verzované tabulce/metodice a upravitelný; bez spolehlivého zdroje vyžadovat skutečný údaj, je-li povinný.
- **Kontrola a bezpečnost:** Šestimístný kód není tajemství a sám neopravňuje zobrazovat osobní údaje ani měnit záznamy. Kontrolu se jménem a číslem lístku zpřístupnit jen přihlášené pověřené rybářské stráži/správci. Odevzdání a zobrazení pro držitele chránit samostatným dlouhým náhodným tokenem v odkazu, s expirací/obnovou a omezením pokusů; v QR uvést odkaz pro kontrolu, nikoli token pro odevzdání. Na veřejném endpointu minimalizovat údaje a zamezit procházení kódů. Online kontrola vyžaduje signál; režim offline není v pilotu slíben.
REPLY: Dohodnout se svazem zda musí mít porybný účet porybného nebo zda umožnit kontrolu komunkoliv. Osobně se přkládám k volné kontrole, bez možnosti měnit údaje. V případě striktní kontoly porybným, zavést ronou i mechanismus "zadržení místenky".

- **Účty a ochrana dat:** Nákup bez účtu musí fungovat. Hesla ukládat pouze jako bezpečné hash hodnoty, přihlášení správce chránit MFA, role a oprávnění vynucovat na serveru. Správci spravují provoz, admin přiděluje role. Prověřit právní tituly, informační povinnost, smlouvy se zpracovateli, retenční lhůty a způsob vyřízení žádostí. Smazání účtu nemusí znamenat okamžitý výmaz účetních či jiných zákonem uchovávaných záznamů; „souhlas s GDPR“ není univerzální právní základ. Marketingový souhlas řešit odděleně od provozních e-mailů.
- **Poukazy:** Jednorázové uplatnění provést atomicky spolu s rezervací/vystavením, s auditem, platností, pravidly storna a ochranou náhodného kódu. Patří až po stabilním platebním toku.

## Doporučený tech stack

> **Nahrazeno 17. 11. 2026** – platformou WordPress, viz „Aktualizace 17. 11. 2026“ nahoře. Ponecháno pro kontext rozhodnutí; požadavky na platby, zálohy a oddělení prostředí platí i pro WordPress.

| Vrstva | Volba pro pilot | Podmínka / riziko |
| --- | --- | --- |
| Web | TypeScript, React + Vite, responzivní a přístupné rozhraní | Statické soubory na Workers; formuláře fungují na mobilu. |
| Backend | Cloudflare Workers, TypeScript, Hono, validační schémata Zod | API, autorizace, plánované úlohy a serverové generování QR; nepředpokládat neomezené CPU. |
| Data | Cloudflare D1 (SQLite), verzované migrace | Unikátní omezení, atomické operace, indexy, zálohy a test obnovy; provozní data neukládat do KV jako zdroj pravdy. |
| Platby | Fio API Bankovnictví, český standard QR Platba | Serverové čtení, párování a výjimky výše; adaptér oddělený od objednávek. |
| E-mail | Brevo transakční API | Ověřit doménu a doručitelnost; fronta v D1, opakování, stav a monitoring. Přijetí poskytovatelem není důkaz doručení. |
| Dokument | Tisková HTML stránka místenky a tisk/uložení do PDF v prohlížeči | Otestovat mobil i tisk. Automatická PDF příloha je samostatná položka po ověření nákladů a limitů runtime. |
| Provoz | Vlastní doména, Cloudflare DNS, Workers Cron, Git a CI | Oddělené testovací a produkční prostředí, secrets, monitoring, obnova a postup při výpadku. |

Limity [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) zahrnují 100 000 požadavků denně a 10 ms CPU na vyvolání; D1 má 5 milionů přečtených a 100 000 zapsaných řádků za den. [D1 limity](https://developers.cloudflare.com/d1/platform/limits/) uvádějí 500 MB na databázi a 7 dní Time Travel ve Free; [při vyčerpání limitů](https://developers.cloudflare.com/d1/reference/faq/) mohou databázové dotazy selhávat. Uvedené objemy jsou sdílené a vhodnost je nutné změřit, zejména indexy, opakované kontroly a generování dokumentů. Time Travel není náhradou pravidelné nezávislé zálohy a ověřené obnovy.

[Brevo Free](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) uvádí 300 odeslání denně. Při 100 nákupech a 100 připomínkách je to asi 200 zpráv, bez registrací, obnovy hesla, výjimek a hromadných sdělení; 500 příjemců hromadného sdělení limit samo překročí. Prioritizovat transakční zprávy, hromadné rozesílání dávkovat podle pravidel poskytovatele a počítat s placeným tarifem. Doména a případné bankovní služby mohou být placené; nulové celkové náklady nejsou zaručené.

## Datový model a stavy

- `organization`, `revir`, `season`, `daily_capacity`, `announcement`: organizace, revír, pravidla, kapacity a zprávy. V pilotu jeden revír; doménový model počítá s více organizacemi, ale plný multitenant provoz odložit.
- `user`, `membership/role`, `session`: identity a oprávnění v rámci organizace. Nákup hosta evidovat bez vytvoření účtu.
- `order`, `reservation`, `payment`, `bank_transaction`: cena, VS, časové limity, bankovní identifikátor a historie. Objednávka čeká na platbu → zaplacena → dokončena, případně expirována/zrušena; pozdní a nesouladné platby čekají na řešení. Rezervace se atomicky mění v potvrzené místo.
- `ticket`, `catch_report`, `catch_item`: místenka má oddělený stav vydána / zrušena a odvozenou časovou platnost; odevzdání je samostatný stav, aby skončení platnosti neztratilo informaci o vrácení. QR a kód mají unikátní omezení, citlivé tokeny ukládat jako hash.
- `voucher`, `stocking_event`, `audit_event`, `email_outbox`: poukazy, zarybnění, audit a spolehlivé odesílání; stavové změny a zprávy zapsat atomicky tam, kde to platforma dovoluje.

## Fáze a ověřitelné výsledky

1. **Rozhodnutí před vývojem:** s organizací potvrdit právní charakter, kontrolu oprávnění, možnosti Fio účtu, cenu, pravidla kapacit a vracení, odpovědnou osobu a ochranu dat. Výsledek: písemně schválená pravidla a rozhodnutí, zda smí pilot bez automatického ověření běžet.
2. **Platební a technický prototyp:** testovací Workers/D1, skutečný QR převod malé částky na účet pilotní organizace, načtení přes Fio, párování VS a výjimek. Změřit prodlevy, odzkoušet více aplikací plátců, chybnou a pozdní platbu i nedostupnost banky. Nepovažovat testovací peníze za produkční objednávky.
3. **MVP pro prodej a kontrolu:** stránka revíru, rezervace kapacity, objednávka hosta, párování, místenka, e-mail, tisk, autorizovaná kontrola, jednoduchá správa a ruční řešení výjimek. Test souběžného nákupu posledního místa a opakovaného načítání plateb je podmínkou dokončení.
4. **Odevzdání a provoz:** úlovky včetně nulového hlášení, připomínky, správa sezony, přehledy a exporty, audit, zálohy, upozornění na chyby a provozní postup. Otestovat konec platnosti, 24hodinovou lhůtu i změnu času.
5. **Rozšíření:** uživatelské účty a historie, poukazy, zarybnění, statistiky, hromadná sdělení a další bankovní adaptéry podle skutečných potřeb. Před více organizacemi doplnit a otestovat izolaci dat, správu secrets a oprávnění pro každou organizaci.

**Kritéria pilotního spuštění:** schválená pravidla a odpovědnosti; ověřená možnost kontroly oprávnění; úspěšná platba a zpracování výjimek; prokázaná ochrana kapacity a osobních údajů; test zálohy a obnovy; funkční upozornění na výpadky; ověřená dostupnost správce pro ruční řešení plateb. Před uvedením do provozu doplnit konkrétní provozní limity a kontakty.
