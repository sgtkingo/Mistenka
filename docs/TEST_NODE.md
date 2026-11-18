# Ruční test Node verze

Postup pro vyzkoušení celé aplikace před převodem do WordPressu. Automatické testy API (`npm test`) pokrývají pravidla; tady jde o průchod očima uživatele, porybného, správce a admina.

## Příprava

```bash
npm run seed            # ukázkové místenky ve všech stavech (smaže lokální databázi!)
MISTENKA_DEV=1 npm start
```

- `MISTENKA_DEV=1` zapne pomocné funkce: tlačítko **Simulovat příchozí platbu** na stránce platby a vývojové endpointy.
- E-maily se neposílají – najdete je v `data/outbox/` (HTML i text, odkazy z nich fungují).
- Server při startu vypíše **odkaz na průvodce založením admina** (platí 60 minut). Nový odkaz: `npm run user -- setup`.
- Na 2FA potřebujete v mobilu ověřovací aplikaci (Google/Microsoft Authenticator, Aegis…).

## 1. Admin a role
- [ ] Průvodce (`setup.html#…`): údaje, heslo 2×, QR kód do aplikace, kód → admin je přihlášený.
- [ ] Odhlásit, přihlásit heslem + kódem 2FA. Totéž odkazem z e-mailu („Poslat odkaz pro přihlášení“).
- [ ] Portál → Uživatelé a role → Pozvat správce (jiný e-mail) → odkaz z `data/outbox/` → nastavení hesla.

## 2. Rybář (uživatelský portál)
- [ ] Bez účtu: koupit místenku → QR platba → Simulovat platbu → místenka, PDF, e-mail.
- [ ] Registrace (heslo nepovinné, datum narození jako 3.2.1988) → ověřovací odkaz → předvyplněný formulář nákupu.
- [ ] Dřívější nákup se stejným e-mailem a legitimací se po ověření objeví v Můj účet.
- [ ] Odevzdání s úlovky: podměrečná ryba / hájení se odmítne; 3 kapři → upozornění na limit, odevzdání projde.
- [ ] Můj účet: limity týden/měsíc, změna údajů, změna e-mailu (potvrzení), heslo, 2FA, smazání účtu.

## 3. Porybný
- [ ] Správce jmenuje uživatele porybným. Porybný otevře QR / kód místenky → panel „Kontrola porybného“ (plné údaje, místenky člena, limity, záznam kontrol).
- [ ] Zadržení aktivní místenky → stav Zadržená ve veřejné kontrole; e-mail držiteli a správci (`managerEmail`).

## 4. Správce (manažerský portál)
- [ ] Místenky: hledání, filtry, detail, zrušení, export CSV (otevřít v Excelu).
- [ ] Platby: simulace platby se špatnou částkou → fronta → Přiřadit a vystavit / Vráceno.
- [ ] Poukazy: vytvořit, použít při nákupu, zneplatnit.
- [ ] Limity a blokace: ruční blokace → nákup se odmítne; zrušení.
- [ ] Důležité: 3+ zprávy, připnutí, platnost od–do → úvodní stránka (tečky).
- [ ] Sezona a uzavření: sezona od zítřka → dnešek „uzavřeno“; mimořádné uzavření → e-mail držitelům.
- [ ] Nastavení: změna ceny a kapacity revíru → hned na úvodní stránce; historie → Obnovit; ryby a limity (lovná míra).
- [ ] Platby v nastavení: jako správce jen ke čtení; jako admin změna → e-mail všem adminům.
- [ ] Zarybnění: záznam, plán, rozpočet; Přehledy: období, uložit uzávěrku, Tisk / PDF.

## 5. Admin – provoz
- [ ] Zálohy: Zálohovat nyní, stáhnout, Obnovit (OBNOVIT + kód 2FA) → data se vrátí, vznikne pojistná záloha.
- [ ] Automatická obnova: zastavit server, poškodit `data/mistenka.sqlite` (např. přepsat začátek souboru), spustit → server obnoví poslední zálohu, poškozený soubor je v `data/corrupt/`, admini mají e-mail.
- [ ] Audit změn: role, nastavení, zálohy.
- [ ] Ochrana osobních údajů: patička → `privacy.html`; v Nastavení → Organizace doplnit sídlo, IČO, e-mail pro žádosti a lhůty.

## Posun času

Datum a čas serveru lze ve vývojovém režimu posunout (konec dne lovu, lhůty odevzdání, konec sezony → automatická uzávěrka, lhůty uchování):

```bash
curl -X POST localhost:3000/api/dev/clock -H "Content-Type: application/json" -d '{"now":"2026-12-01T08:00:00Z"}'
curl -X POST localhost:3000/api/dev/clock -H "Content-Type: application/json" -d '{"now":null}'   # zpět na skutečný čas
```

Nalezené chyby si zapisujte i s krokem, který k nim vedl, a stránkou (adresou).
