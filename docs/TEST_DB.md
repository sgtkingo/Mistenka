# Testovací databáze

Lokální testovací záznamy v `data/mistenka.sqlite`. Datum aplikace pro testy: **8. listopadu 2026**.

## Budoucí místenky

| Kód | Rybář | Datum lovu | Stav |
|---|---|---|---|
| `TST002` | Petra Svobodová | 9. listopadu 2026 | future |
| `TST003` | Martin Dvořák | 10. listopadu 2026 | future |
| `TST004` | Lucie Králová | 11. listopadu 2026 | future |

## Aktivní místenka

| Kód | Rybář | Datum lovu | Stav API |
|---|---|---|---|
| `TST005` | Tomáš Procházka | 8. listopadu 2026 | active |
| `TST006` | Alena Veselá | 8. listopadu 2026 | returned |

## Propadlé, ale neodevzdané

| Kód | Rybář | Datum lovu | Stav API |
|---|---|---|---|
| `EXP005` | Karel Beneš | 7. listopadu 2026 | expired_unreturned, late |
| `EXP006` | Ivana Šimková | 6. listopadu 2026 | expired_unreturned, late |
| `EXP007` | Robert Tichý | 2. listopadu 2026 | expired_unreturned, late |
| `EXP008` | Nina Horáková | 30. října 2026 | expired_unreturned, late |

Tyto místenky jsou v databázi záměrně vedené jako neodevzdané. Odevzdání je možné i později, ale každé odevzdání po skončení dne lovu se označí jako opožděné.

## Ostatní historické záznamy

| Kód | Rybář | Datum lovu | Stav API |
|---|---|---|---|
| `EXP001` | Eva Bílková | 1. listopadu 2026 | expired_unreturned, late |
| `EXP002` | Pavel Hruška | 31. října 2026 | expired_unreturned, late |
| `EXP003` | Marek Jelínek | 25. října 2026 | expired_unreturned, late |
| `EXP004` | Anna Malá | 18. října 2026 | expired_unreturned, late |
| `TST001` | Jan Novák | 8. listopadu 2026 | expired_returned |
## Dárkové poukazy

Poukazy mají vždy 16 znaků. Platný poukaz změní cenu místenky na `ZDARMA`; odečte se až při vystavení místenky a v databázi zůstává s časem použití.

| Kód | Stav |
|---|---|
| `DEMO03DCA6CD2460` | použitý při testu místenky `C6AC38`, `used_at: 2026-11-08 21:59:53` |
| `DEMOBD4EEEB9BCB5` | použitý při testu místenky 248303 |
| `DEMO16ADBEFA9755` | nepoužitý |
| `DEMODE0D3AC759F9` | nepoužitý |
| `DEMO360008F96605` | nepoužitý |
