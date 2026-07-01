# Skien sporplan

Dette repoet inneholder den fungerende nettversjonen av Skien sporplan.

## Status nå

- Nettsiden kjører via GitHub Pages
- Data leses fra statiske JSON-filer
- Oppdatering av data skjer via GitHub Actions
- Løsningen fungerer uten at Mac eller terminal må stå på

## SDE 100 closure / overleveringsstatus

SDE Shared Workspace / Skien sporplan er closure-ready innen dagens låste scope. SDE-100-PRE fant ingen konkrete SDE-100-FIX-blokker før overlevering. Produktet kan regnes som ferdigstilt for lokal/static SDE-beslutningsstøtte med read-only serverreadback.

Dette betyr ikke operational authority, production-write eller runtime-auth implementation. Serverstate er fortsatt ikke generell operativ sannhetskilde.

### Ferdige hovedområder

- Sporplan
- TXP Input Sporplan
- SDE Skiftebevegelser
- SDE natt/turnering
- SDE Vaktplan
- DROPS
- Verksted/Input verksted
- Tursatt
- Vaskesporet VN/VS
- Shared Workspace readback
- Server read-only status/readback

### SDE Skiftebevegelser / beslutningsstøtte

Dagens scope dekker skifteforslag/kort, score/diagnostikk, skiftevindu, rute-/blokkering, buttsporlogikk, lokal Utført/Annullert der relevant, historikk/selvlæring der relevant, Feil spor / alternativ vurdering der relevant og diagnoseblokker.

Dette er beslutningsstøtte. Det er ikke skifteordre og ikke operational authority.

### Sporplan og lokale regler

Sporplanen dekker spor 1-12, N/S/M-slotlogikk der relevant, buttspor 10/11/12, nord/sør-blokkering, plattformspor, verkstedhall, spor 6/fylle-tømme og Vaskesporet VN/VS.

VN/VS er avgrenset og skal ikke behandles som ordinær parkering.

### DROPS / verksted

DROPS og verkstedstatus brukes som beslutningsstøtte. Dette inkluderer bestilt ut, driftsklar, arbeid fullført og notat der relevant, samt skille mellom SDE-forslag og manuell vurdering.

Ingen server-write eller operational authority er åpnet.

### Tursatt/data

Tursatt-prioritet inngår i visning og vurdering. Dagens datagrunnlag bruker døgnskille 07:00, ankomster i dag / avganger i morgen og filter for passert avgang.

Data er beslutningsgrunnlag, ikke server-side operational authority.

### Server/read-only

Låst production read-only status ved SDE-100-DOC:

- Production runtime revision: `8`
- Operational-state events: id `5`, `6`, `7`
- Event id `7`: `operational_state.snapshot.production_pilot`
- Scope/readback: `manual-assessments-notes`
- Alle write/operational/production/migration-flagg er av
- `serverStateAuthority:false`
- `operationalAuthority:false`
- `migrationRequired:false`

Serverreadback er audit/status/readback. Det er ikke operativ sannhetskilde.

### B48/auth closure

B48 er lukket GREEN som design/testmodell-readiness. Production runtime-auth implementation er `0 %`.

Ikke godkjent eller aktivert:

- runtime-import
- middleware
- endpoint enforcement
- private readback
- identity-source
- operational authority/write

### Eksplisitt HOLD / ikke aktivert

Disse punktene er bevisst holdt utenfor SDE-100 closure:

- runtime-auth implementation
- role/server-side enforcement
- private readback activation
- production-write
- operational authority
- DB/schema/migration
- Cloudflare/CORS/transportendring
- løpende write/sync
- feltmessig brukeraksept i drift
- eventuell B49 runtime-auth strategy

### Hva 100 % betyr her

100 % betyr produktclosure innen dagens låste scope. Det betyr ikke at alle fremtidige server-, auth- eller write-muligheter er implementert.

SDE er ferdig som lokal/static beslutningsstøtte med read-only serverreadback. Operational authority/write er fortsatt `0 %`.

### Neste trygge steg

Det finnes ingen automatisk neste tekniske fase etter closure. Runtime-auth, write og authority står fortsatt på HOLD.

Hvis ny runtimefase ønskes senere, start med `B49-PRE` som read-only runtime-auth implementation strategy preflight.

Hvis brukererfaring avdekker konkret feil, opprett en ny smal FIX med avgrenset filscope.

## Viktige filer

- `index.html` – selve nettsiden
- `data/api_idag.json` – statiske data for idag
- `data/api_imorgen.json` – statiske data for imorgen
- `.github/workflows/update-static-data.yml` – oppdaterer de statiske datafilene

## Viktig regel

Ikke gjør store arkitekturendringer uten god grunn.

Frontend og server skal holdes som to parallelle spor inntil serverløsningen er komplett og eksplisitt godkjent for kobling. Se:
- `docs/ARBEIDSKONTRAKT_PARALLELLE_SPOR.md`

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
