# Testovací databáze

Ukázková data vytváří `npm run seed`. Databázi `data/mistenka.sqlite` smaže a naplní znovu, a to **relativně k dnešnímu dni**, takže stavy místenek nezastarají. Použije se první revír z konfigurace.

Přístup k místence (odevzdání, detail) je přes číslo členské legitimace v tabulce, nebo přes odkaz z e-mailu.

| Kód | Legitimace | Rybář | Den lovu | Stav |
| --- | --- | --- | --- | --- |
| `TST001` | `20260000` | Petra Svobodová | zítra | budoucí |
| `TST002` | `20260001` | Martin Dvořák | pozítří | budoucí |
| `TST003` | `20260002` | Tomáš Procházka | dnes | aktivní |
| `TST004` | `20260003` | Alena Veselá | dnes | odevzdaná bez úlovku |
| `EXP001` | `20260004` | Karel Beneš | včera | neodevzdaná, lze odevzdat opožděně (do 7 dnů) |
| `EXP002` | `20260005` | Ivana Šimková | před 9 dny | po 7denní lhůtě – po spuštění úloh uzavřená jako neodevzdaná |
| `EXP003` | `20260006` | Jan Novák | před 2 dny | odevzdaná včas (kapr 55 cm) |
| `EXP004` | `20260007` | Anna Malá | před 4 dny | odevzdaná opožděně |
| `PAY001` | `20260008` | Pavel Hruška | zítra | čeká na platbu (lze simulovat platbu) |
| `PAY002` | `20260009` | Marek Jelínek | zítra | rezervace vypršela |

## Dárkové poukazy

Poukaz má 16 znaků a vystaví místenku zdarma. Odepíše se při vytvoření objednávky.

| Kód | Stav |
| --- | --- |
| `DEMO16ADBEFA9755` | nepoužitý |
| `DEMODE0D3AC759F9` | nepoužitý |
| `DEMO360008F96605` | nepoužitý |
| `DEMO03DCA6CD2460` | použitý |

Automatizované testy (`npm test`) používají vlastní dočasnou databázi a konfiguraci `test/fixtures/organization.test.json`, tato data neovlivní.
