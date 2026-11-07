Projekt "Mistenka"

Webová aplikace pro online prodej, sběr a správu rybářských místenek. Musí běžet jako standalone online app, cílem je snadná uživatelská obsluha. Místenka je vždy na jeden konkterétní revír. Druhá stránka aplikace je určená pro správce a hospodáře revíru - "zarybňování", uzávěrky, bilance, statistiky, exporty. 

UI (pro uživatele):
Tři velké ikony "Zakoupit", "Vrátit" a "Zkontrolovat". Pod nimi deatily revíru ke kterému se vztahuje (název, číslo, informace, omzení, konktakty na svaz pod který patří, mapa a odkaz na mapu). Na stránce by se také měla objevit novinka či důležitá informace - např. že sezona začala, ryby nasazeny, systém bude v údržbě. Nahoře v pravém ohu bude přihlášení - uživatel může mít roli admina, správce nebo člena. 

"Zakoupit": Jednoduchý formulář, rozložení mobil/tablet/PC. Uživatel prvně vyplní číslo rybářského lístku (automaticky se ověří platnost, až poté to uživatele pustí dále, na stále sejné stránce). Poté si uživatel vybere z kalendáře datum na které místenku chce (maximálně týden dopředu) - datum se ukazuje v přátelském formátu (např. Dnes (pondělí), pod tím skutečné datum; Zítra (úterý), pod tím skutečné datum). Poté uživatel klikne na "Potvrzuji" a stránka se přepne na rekapitulaci a platbu. Platba proběhne QR kodem / převodem na banku. Na stránce platby zadá také uživatel své jméno, přijmení, datum narození a email. Pokud je přihlášen, pak se všechny tyto údaje (včetně čísla rybářského lístku) vyplní automaticky (kontrola lístku proběhne i tak). Po zaplacení uživatel obdží potvrzení na webu i do emailu, včetně místenky samotné. 

"Vrátit": Po skončení platnosti místenky má rybář 24 hod na online vrácení místenky. To probíhá tak že uživatel klikne na "Vrátit" (neo v upomínkovém mailu na vrátit), otevře se mu formulář kde zadá kod místenky (nebo načte QR kod místenky), ta se otevře a umožní mu vyplnit sumář úlovků a místenku vrátit. Sumář ulovků je interaktivní tabulka, kde uživatel zadá název ryby (field bude napovídat), její délku v cm a volitelně váhu v kg (váha se deffaultně okamžitě dopočítá sama dle tabulky vah). Po vyplnění sumáře může kliknout na "Odevzdat" - systém se rybáře zeptá zda je opravdu vše vyplněno a zda chce místenku odevzdat. Ppoté se objeví zelená fajfka a místenka se označí jak odevzdaná. 

"Zkontrolovat": Tato sekce je pro porybného - rychlá kontrola zda je místenka platná. Porybný načte přes appku QR kod místenky nebo vyplní ručně její kod. Systém mu přehledně ukáže zda je platná (zeleně) nebo ne (červeně) - stav (aktivní, odevzdaná, propadlá, zrušená), na které datum je zakoupená a také jméno rybáře + číslo ryb. lístku.  

UI (pro správce):
Správce vidí přehledně seznam zakoupených místenek, oodevzdané, neodevzdané, sumáře úlovků, účetní úávěrky za jednotlivé období, finanční bilanci. Správce může otevřít, uzavří sezonu, může vyhlást mimořádný stav, zrušit/vrátit místenku, odblokovat/zablokovat uživatele. Správce může "zarybnit revír", poslat uživatelům hromadnou zprávu, vystavit zprávu.

UI (admi): 
Admin může vše co správce, ale navíc může spravovat jednotlivé uživatele a ustanovit nové správce/rušit staré. 

UI (místenka):
Místenka je na určité datum, jméno, číslo ryb. lístku. Místenka má svůj unikátní krátký alfanumerický kod (6 pozic, velkým) a stínový QR kod (webový link který otevře tuto konkterétní místenku v režimu "Zkontrlovat"). Místenka chodí do mailu, po zaplacení se objeví i přímo ve webovém formuláři k vytištění / uložení PDF. Zakoupené místenky také zůstavájí v historii uživatelského účtu, pokud uživatel existuje. 

Uživatelský účet: 
Obsahuje jméno, příjmení, datum narození, číslo ryb. lístku, email a heslo. Při registraci uživael odsouhlasí GDPR které zde může odvolat, či účet smazat. V účtu vidí historii místenek, které jdou odud otevřít. 

Dárkové poukazy: 
Místo platby může použít uživatel dárkový poukaz který dostane. Jednorázově, poté poukaz odepíše a nepůjde použít. Dárkové poukazy může vydat správce nebo admin. Pro správu poukazů navrhneme samostatnou sekci.

TECHSTACK:
Lowcost, ideálně free. Vlastní levná doména, napr mistenka.eu Infra na Cloudflare Free Tier (D1, Workers), emaily přes freetier Brevo. Pilotní nasazení, časem můžeme navýšit kapacity. QR platby přes bankovvní API, bránu zatím ne. Očekáváme maximálně 100 chytajích denně, 500 unikátních uživatelů. 

Projekt by měl být stavěn tak, aby byl časem nasaditelný i na pro jiné organizace. 

