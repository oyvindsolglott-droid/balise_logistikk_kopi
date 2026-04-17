# Skien sporplan

Dette repoet inneholder den fungerende nettversjonen av Skien sporplan.

## Status nå

- Nettsiden kjører via GitHub Pages
- Data leses fra statiske JSON-filer
- Oppdatering av data skjer via GitHub Actions
- Løsningen fungerer uten at Mac eller terminal må stå på

## Viktige filer

- `index.html` – selve nettsiden
- `data/api_idag.json` – statiske data for idag
- `data/api_imorgen.json` – statiske data for imorgen
- `.github/workflows/update-static-data.yml` – oppdaterer de statiske datafilene

## Viktig regel

Ikke gjør store arkitekturendringer uten god grunn.

Ikke rør disse filene uten å vite nøyaktig hvorfor:
- `index.html`
- `data/api_idag.json`
- `data/api_imorgen.json`
- `.github/workflows/update-static-data.yml`

## Rydding i 7_0

Gamle backup- og testfiler er flyttet til:
- `archive_7_0/`

## Lokal utvikling

Arbeidsmappe:
- `balise_logistikk-kopi`

GitHub-repo:
- `balise_logistikk_kopi`

## Neste prinsipp

Små, trygge endringer.
Bevar fungerende nettløsning først.
