# Testovací databáze

Lokální testovací záznamy v `data/mistenka.sqlite`. Datum aplikace pro testy: **8. listopadu 2026**.

## Aktivní místenky

| Kód | Rybář | Datum lovu | Stav |
|---|---|---|---|
| `TST002` | Petra Svobodová | 9. listopadu 2026 | active |
| `TST003` | Martin Dvořák | 10. listopadu 2026 | active |
| `TST004` | Lucie Králová | 11. listopadu 2026 | active |
| `TST005` | Tomáš Procházka | 8. listopadu 2026 | active |
| `TST006` | Alena Veselá | 8. listopadu 2026 | active |

## Propadlé, ale v databázi stále aktivní

Tyto záznamy mají datum lovu před 8. listopadem 2026, ale záměrně stav `active`. Slouží pro test budoucí automatické kontroly expirace a pro přípravu integrace s RS.

| Kód | Rybář | Datum lovu | Stav |
|---|---|---|---|
| `EXP005` | Karel Beneš | 7. listopadu 2026 | active |
| `EXP006` | Ivana Šimková | 6. listopadu 2026 | active |
| `EXP007` | Robert Tichý | 2. listopadu 2026 | active |
| `EXP008` | Nina Horáková | 30. října 2026 | active |

## Ostatní historické záznamy

| Kód | Rybář | Datum lovu | Stav |
|---|---|---|---|
| `EXP001` | Eva Bílková | 1. listopadu 2026 | expired |
| `EXP002` | Pavel Hruška | 31. října 2026 | expired |
| `EXP003` | Marek Jelínek | 25. října 2026 | expired |
| `EXP004` | Anna Malá | 18. října 2026 | expired |
| `TST001` | Jan Novák | 8. listopadu 2026 | returned |

## Testovací scénáře

- `TST002`–`TST006`: platná aktivní nebo budoucí místenka podle data lovu.
- `EXP005`–`EXP008`: datumově propadlá místenka, která je stále vedena jako `active`.
- `EXP001`–`EXP004`: místenka se stavem `expired`.
- `TST001`: vrácená místenka se stavem `returned`.
