# Místenka · Petrůvka 1 A

Demo webová aplikace pro rezervaci a kontrolu místenek pro rybářský revír **Petrůvka 1 A (471 115)**.

## Live demo

[Otevřít aplikaci na GitHub Pages](https://sgtkingo.github.io/Mistenka/)

## Funkce

- výběr data lovu a zobrazení dostupnosti,
- nákupní workflow s čestným prohlášením a údaji rybáře,
- simulace ověření platby,
- vystavení místenky s pravidly rybolovu,
- kontrola stavu místenky,
- ukončení lovu a interaktivní zápis úlovků,
- našeptávač druhů ryb s ovládáním klávesnicí,
- kontrola minimální délky ryb,
- odkaz na GPS revíru v Mapy.cz.

## Lokální spuštění

Pro plný demo workflow se SQLite databází je potřeba Node.js 25 nebo novější:

```bash
node server.js
```

Aplikace bude dostupná na [http://localhost:3000](http://localhost:3000).

## GitHub Pages

GitHub Pages nasazuje statickou část aplikace pomocí workflow [`deploy-pages.yml`](.github/workflows/deploy-pages.yml). Na GitHub Pages není dostupný Node.js server ani SQLite databáze, takže stránky a UI lze prohlížet, ale serverové operace vyžadují lokální spuštění.

## Stav projektu

Projekt je demonstrační prototyp. Platba není skutečně prováděna a údaje v předpovědi počasí i výpočtu hmotnosti úlovku jsou pouze demo data.
