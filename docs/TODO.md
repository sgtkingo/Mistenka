- DONE: V "Emailoví klienti" přejmenovat "Upozornění správcům" na "Upozornění správců", dále pokud je sezona uzavřená, povolit přihlášení, ale jen Adminům a Správcům.  V Ceny a místa smazat "Kolik dní dopředu se místenky prodávají, nastavíte pro celou organizaci v sekci Sezona a uzavření. Nový revír založíte v sekci Revíry.". Tlačítko uzavřít sezonu červeně s ikonou. 

- DONE: Zaved také mechanismus "Nahlásit chybu" s ikonou brouka, dej to do horního panelu nalevo od loginu. 

Nahlásit chybu bude formulář s logem posledních událostí, timestsmp a uživatelským popisem + volitelný screen. Přijde do manažer portálu - Admin sekce -> nová sekce "Hlášení chyb". Tak půjde chyby vyřešit, označit prioritou, posunout do github issues.

Chyba také přijde na email admina - založ tomu v "Emailoví klienti
" novou položku.

- DONE: Zaved různá barevná pozadí pro notifikace/emaily: 
-- Obecná notifikace: modrá, stejná jako doszd
-- Upozornění: oranžová/červená dle závažnosti
-- Úspěch: zelená (např. úspěšně vystaveno, odevdáno)

- DONE: Při odevzdání místenky už neověřovat úplnost question boxem: checkbox stačí

- DONE: Přidat hlídání teoretických maximálních mír a vah - dal bych do Míry, váhy a hájení jednotné nastavení (checkbox) "Hlídat nereálné míry a váhy". Tato funkce by hlídala zjednodušeně jen aby obecná míra byla pod určitou úroven a stejně i váha + upozornovala na odlehlé pozorování. Obecná hranice může být vysoká, třeba 1000 cm a 1000 kg na rybu, je to spíše numerické omezení. Ale hlídání odlehlých pozorování by měo být založeno na skutečných "Lovné míry a váhy" - pokud by byla ryba příliš mimo tabulku, rybář u odevzdání dostane výstrahu a v systému bude místenka vedená jako podezřelá. 

- DONE: Zobrazování "Místenky člena" při kontrole porybným bych defaultně nedělal, je to příliš inforací. Ale už t máme hotovo, takže dáme do nastavení přepínač, a defaultně ho dáme false. Vytvoř novou sekci "Kontroly" v "Rybáři" a tam to dej. 