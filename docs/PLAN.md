# Místenka – validace záměru a plán realizace

Stav podkladů: 6. 11. 2026. Jde o návrh pro pilot jednoho revíru, nikoli o potvrzení právní ani provozní způsobilosti. Ceny a podmínky služeb před spuštěním znovu ověřit.

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
