# SDE serverarkitektur

## 1. Mål

Målet er å gå fra en statisk PWA der hver klient har sin egen lokale operative
state, til en modell der mange operative klienter samhandler med én
autoritativ lokal server hos brukeren.

Serveren skal være sannhetskilde for operativ state. Klientene skal etter hvert:

- lese autoritativ state fra server
- sende konkrete endringsforespørsler som actions
- få avvist actions som bygger på gammel revision
- motta live-varsel når state endres
- bruke `localStorage` kun til lokal UI-state og cache

Dette skal gjøre det mulig å bruke iPhone, iPad, Mac, operativ skjerm, TXP-visning,
DROPS-visning og skifter-visning samtidig uten at hver enhet bygger sin egen
lokale sannhet.

## 2. Ikke-mål

Dette er ikke en modell med én fysisk kontrollenhet. Flere operative klienter kan
ha skriverett samtidig, men alle writes skal gå via samme server.

Dette er heller ikke en plan om å flytte hele SDE-motoren først. Første serverfaser
bør la dagens klientberegning leve videre, og kun flytte utvalgte operative writes
til server.

Ikke-mål i første implementering:

- ingen parallell SDE-motor
- ingen ny scorelogikk
- ingen ny kandidatgenerator
- ingen endring av sortering eller anbefalt spor
- ingen direkte felles JSON-fil som klienter skriver til
- ingen bruk av GitHub Pages eller klient-`localStorage` som autoritativ state

## 3. Målarkitektur

Foreslått målmodell:

```text
Klienter: iPhone / iPad / Mac / skjerm / TXP / DROPS / skifter
    |
    | GET state, POST actions, SSE stream
    v
Lokal autoritativ server
    |
    | SQLite
    v
app_state + events + devices + data_sources
```

Første server bør være enkel:

- Node.js/Express
- SQLite
- REST API for writes
- Server-Sent Events for live sync
- revision på autoritativ state
- audit/event-logg for alle operative writes
- JSON-validering på action-input
- backup/export av SQLite eller state/event-logg

Mac mini kan være første naturlige server dersom den allerede brukes i miljøet.
Den bør da behandles som autoritativ state-node på lokalt nett, ikke bare som en
watchdog for statiske filer.

## 4. State-eierskap

### Server-autoritativ operativ state

Disse delene bør på sikt eies av server:

- `grunnoppstilling`
- `grunnoppstillingRep`
- TXP uvirksom infrastruktur
- `planSkifteRows`
- `turneringKveld`
- `turneringNatt`
- SDE Utført / Annullert
- SDE Overprøv
- SDE-læring
- SDE reset snapshot / dagresetgrunnlag
- DROPS / verkstedordre
- DROPS-logg
- `dropsDecisionMode`
- manuelle Tursatt-overstyringer
- manuell kjøretøyimport dersom den brukes operativt
- reset- og dagreset-hendelser
- bruker-/enhetsroller
- audit-logg

### Klientlokal UI-state

Dette kan forbli lokalt:

- aktiv fane
- åpne/lukkede paneler
- diagnose-expand/collapse
- zoom/compact
- scroll
- lokal visningspreferanse
- midlertidige UI-toggles
- PWA-cache

### Serverdata/cache

Serveren bør etter hvert eie eller bygge:

- Balise/API-data for i dag
- Balise/API-data for i morgen
- normaliserte avgangs- og ankomstmapper
- datakilde, dato og generatedAt
- importerte datagrunnlag
- historikk over dataoppdateringer

### Senere vurdering

SDE `sde_shift_last_snapshot_v1` er i dag lokal observasjonsstate. Den kan forbli
lokal i tidlige faser. Senere bør "Endringer siden sist" heller kunne bygges fra
server-revisioner eller event-logg.

SDE-beregningen kan vurderes flyttet server-side senere, men først etter at
state-, action- og revision-modellen er stabil.

## 5. Foreslått SQLite-modell

Første modell bør prioritere enkel drift og tydelig audit fremfor full
normalisering.

### `app_state`

Én rad med autoritativ state.

Felter:

- `id` - fast verdi, for eksempel `main`
- `revision` - monoton økende heltall
- `state_json` - autoritativ operativ state som JSON
- `updated_at` - ISO-tidspunkt
- `updated_by` - actor/device som sist skrev

Dette gjør migreringen enkel fordi serveren kan starte med samme grove state-form
som dagens klient, men med serveren som eier.

### `events`

Append-only audit-logg.

Felter:

- `id` - unik event-id
- `revision` - revision etter at eventet er brukt
- `previous_revision` - revision action bygget på
- `type` - actiontype, for eksempel `sde.move.completed`
- `payload_json` - validert action-payload
- `before_json` - relevant før-bilde der det er nyttig
- `after_json` - relevant etter-bilde der det er nyttig
- `actor` - bruker/rolle hvis kjent
- `device_id` - klient/enhet
- `created_at` - ISO-tidspunkt

### `devices`

Klient- og rolleoversikt.

Felter:

- `device_id`
- `name`
- `role`
- `last_seen_at`
- `created_at`
- `disabled_at`

### `data_sources`

Datagrunnlag serveren har hentet eller importert.

Felter:

- `key` - for eksempel `balise:idag` eller `balise:imorgen`
- `mode` - `idag` / `imorgen`
- `date`
- `generated_at`
- `payload_json`
- `updated_at`
- `source`

## 6. API-forslag

Alle operative `POST`-endepunkter bør ta `expectedRevision`. Serveren skal validere
mot gjeldende revision og returnere `409 Conflict` ved mismatch.

### `GET /api/state`

Formål: returnere autoritativ state.

Input: ingen, eventuelt rolle/device-token.

Output:

- `revision`
- `updatedAt`
- `state`
- eventuelt `serverTime`

State som endres: ingen.

Validering: lesetilgang.

Audit-logg: normalt ingen, eventuelt tilgangslogg senere.

### `GET /api/state/revision`

Formål: lettvekts sjekk av gjeldende revision.

Input: ingen.

Output:

- `revision`
- `updatedAt`

State som endres: ingen.

Validering: lesetilgang.

Audit-logg: ingen.

### `GET /api/events?sinceRevision=N`

Formål: hente hendelser etter kjent revision.

Input:

- `sinceRevision`

Output:

- liste med events
- siste `revision`

State som endres: ingen.

Validering: lesetilgang.

Audit-logg: ingen.

### `GET /api/stream`

Formål: live sync med Server-Sent Events.

Input: rolle/device-identifikasjon.

Output: SSE-hendelser, for eksempel:

```json
{ "type": "state_changed", "revision": 42 }
```

State som endres: ingen.

Validering: lesetilgang.

Audit-logg: eventuelt device `last_seen_at`.

### `POST /api/actions/sde-move-action`

Formål: registrere SDE Utført eller Annullert.

Input:

- `expectedRevision`
- `action`: `completed` eller `cancelled`
- `moveKey`
- `reason`
- `comment`

Output:

- ny `revision`
- oppdatert relevant action-record
- event-id

State som endres:

- SDE move actions
- SDE-læringslogg
- ved Utført: relevant sporplan/grunnoppstilling dersom dagens klientlogikk fortsatt
  krever det i state

Validering:

- rolle har skriverett
- revision matcher
- move finnes i gjeldende state/beregningsgrunnlag
- action er ikke allerede registrert
- målspor er fortsatt gyldig ved Utført

Audit-logg:

- actiontype
- move snapshot
- reason
- actor/device
- før/etter for berørte statefelt

### `POST /api/actions/sde-manual-override`

Formål: registrere SDE Overprøv.

Input:

- `expectedRevision`
- `needKey`
- `overrideSlot`
- metadata om valgt kandidat fra klientens eksisterende vurdering

Output:

- ny `revision`
- override-record
- event-id

State som endres:

- SDE manual overrides
- SDE-læringslogg for override

Validering:

- rolle har skriverett
- revision matcher
- behov finnes
- overrideSlot er gyldig og ikke samme som opprinnelig anbefaling
- server kan validere slot mot autoritativ state

Audit-logg:

- opprinnelig anbefaling
- valgt override
- tilgjengelige kandidater ved beslutning
- actor/device

### `POST /api/actions/txp-unavailable`

Formål: registrere uvirksomt spor eller slot.

Input:

- `expectedRevision`
- `targetType`: `slot` eller `track`
- `target`
- `unavailable`: boolean

Output:

- ny `revision`
- oppdatert TXP uvirksom infrastruktur

State som endres:

- TXP uvirksom infrastruktur

Validering:

- rolle `txp` eller `admin`
- revision matcher
- gyldig slot/track

Audit-logg:

- før/etter for berørt slot/track
- actor/device

### `POST /api/actions/grunnoppstilling`

Formål: endre kjøretøy eller rep/drei-markering på slot.

Input:

- `expectedRevision`
- `slot`
- `vehicle`
- `repMarker`

Output:

- ny `revision`
- oppdatert slot

State som endres:

- `grunnoppstilling`
- `grunnoppstillingRep`

Validering:

- rolle `txp` eller `admin`
- revision matcher
- gyldig slot
- gyldig kjøretøyformat
- duplikatregler vurderes

Audit-logg:

- slot
- før/etter vehicle
- før/etter rep/drei
- actor/device

### `POST /api/actions/drops-order`

Formål: opprette, endre status på eller slette verkstedordre.

Input:

- `expectedRevision`
- `operation`: `create`, `approve`, `complete`, `ready`, `delete`, `note`, `routing-toggle`
- `orderId`
- ordredata ved create/update

Output:

- ny `revision`
- oppdatert ordre
- event-id

State som endres:

- DROPS/verkstedordre
- DROPS-logg

Validering:

- rolle `drops` eller `admin`
- revision matcher
- ordre finnes ved update/delete
- lovlig statusovergang
- gyldig kjøretøy og spor ved create

Audit-logg:

- ordre-id
- operation
- før/etter
- actor/device

### `POST /api/actions/drops-mode`

Formål: endre DROPS behandlingsmodus.

Input:

- `expectedRevision`
- `mode`: `manual` eller `sde`

Output:

- ny `revision`
- aktiv modus

State som endres:

- `dropsDecisionMode`
- eventuelle auto-godkjenninger hvis dette senere beholdes som regel

Validering:

- rolle `drops` eller `admin`
- revision matcher
- gyldig mode

Audit-logg:

- før/etter mode
- actor/device

### `POST /api/actions/reset-day`

Formål: kontrollert SDE dagreset.

Input:

- `expectedRevision`
- `scope`: for eksempel `sde-day`
- eksplisitt bekreftelse

Output:

- ny `revision`
- reset-oppsummering

State som endres:

- SDE actions
- SDE-læringslogg
- SDE manual overrides
- eventuelt gjenopprettet før-bilde for sporplan/grunnoppstilling

Validering:

- rolle `admin` eller særskilt autorisert rolle
- revision matcher
- nødvendig reset snapshot finnes
- reset-scope er støttet

Audit-logg:

- reset-scope
- oppsummering
- før/etter for berørte hovedfelt
- actor/device

### `POST /api/actions/import-data`

Formål: importere eller oppdatere datagrunnlag.

Input:

- `expectedRevision`
- `mode`: `idag` eller `imorgen`
- payload eller filreferanse

Output:

- ny `revision`
- datakilde-metadata
- normaliseringsoppsummering

State som endres:

- serverdata/cache
- eventuelt autoritativt datagrunnlag brukt av klientene

Validering:

- rolle `admin` eller datarolle
- revision matcher hvis import påvirker aktiv operativ state
- schema for payload
- dato/generation metadata

Audit-logg:

- datakilde
- mode
- dato
- antall avganger/ankomster/kjøretøy
- actor/device

## 7. Revision og konfliktmodell

All autoritativ state har en monoton `revision`.

Regler:

- alle operative writes sender `expectedRevision`
- server sammenligner `expectedRevision` med gjeldende revision
- mismatch gir `409 Conflict`
- første write vinner
- klient med konflikt må hente ny state før bruker kan prøve igjen
- ingen offline write-kø i første versjon

Dette er enklere og tryggere enn automatisk merge. Operativt er det bedre å tvinge
ny vurdering enn å akseptere en write fra gammel cache.

For kritiske actions skal serveren validere mer enn revision:

- SDE Utført må kontrollere at action fortsatt er gyldig
- reset må kontrollere at snapshot finnes
- DROPS status må kontrollere lovlig statusovergang
- grunnoppstilling må kontrollere slot/kjøretøy

## 8. Live sync

Førstevalg: Server-Sent Events.

Flyt:

1. Klient laster `GET /api/state`.
2. Klient åpner `GET /api/stream`.
3. En klient sender en action.
4. Server validerer, lagrer, øker revision og audit-logger.
5. Server sender `state_changed` med ny revision.
6. Klientene henter ny state.

WebSocket kan vurderes senere dersom klientene trenger mer interaktiv toveisflyt.
For første versjon er REST writes + SSE broadcast enklere og mer robust.

## 9. Roller

Minimumsroller:

- `admin` - reset, import, rolleoppsett, alle writes
- `txp` - TXP uvirksom infrastruktur og grunnoppstilling
- `drops` - DROPS/verkstedordre, status og behandlingsmodus
- `skifter` - SDE Utført/Annullert, eventuelt begrensede skiftehandlinger
- `viewer` - read-only

Første sikkerhetsmodell kan være enkel lokal token/rolle per enhet, men API-et bør
ikke stå åpent på nett. Tung autentisering kan komme senere, men serveren må fra
start skille read-only fra operative writes.

## 10. Migreringsplan

### Fase 0: dokumentasjon

Dokumenter målarkitektur, state-eierskap, API og migreringsrekkefølge. Ingen
runtime-endring.

### Fase 1: read-only server-state

Server returnerer autoritativt state snapshot. Klient kan lese og vise
server-state, men skriver fortsatt ikke til server.

Mål:

- bevise serverdrift
- etablere SQLite
- etablere revision
- etablere SSE
- ikke endre SDE-motor

### Fase 2: SDE actions som server-writes

Flytt:

- SDE Utført / Annullert
- SDE Overprøv

Dette er et godt første write-scope fordi handlingene er konkrete, audit-vennlige
og har klare valideringspunkter.

### Fase 3: TXP og DROPS som server-writes

Flytt:

- TXP uvirksom infrastruktur
- grunnoppstilling
- DROPS/verkstedordre
- `dropsDecisionMode`

Dette gjør den operative sannheten betydelig mer felles.

### Fase 4: server eier Balise/importdata

Server henter eller importerer datagrunnlag. Klientens `localStorage` brukes bare
til UI-state/cache. Klientene viser serverens datakontekst.

### Fase 5: vurder SDE-beregning server-side

Når autoritativ state og action-modell er stabil, vurder om SDE-beregningen også
skal kjøres server-side for helt identisk beregningsgrunnlag på alle klienter.
Dette bør ikke være første serversteg.

## 11. Rød sone

Ikke gjør først:

- ikke flytt hele SDE-motoren til server
- ikke bygg parallell SDE-motor
- ikke bruk felles JSON-fil uten validering og revision
- ikke bland servermigrering med ny score- eller motorlogikk
- ikke la GitHub Pages eller klient-`localStorage` være autoritativ state
- ikke bygg tung autentisering før state/revision er avklart
- ikke eksponer et åpent API på nett
- ikke lag lokal "kontrollenhet" som falsk løsning på fler-enhetsproblemet

## 12. Første implementeringskandidat

Minste trygge første server:

- Node.js/Express
- SQLite
- tabellene `app_state` og `events`
- `GET /api/state`
- `GET /api/state/revision`
- `GET /api/stream`
- ingen operative writes først, eller én ufarlig test-action
- kjører lokalt på Mac mini

Aksept for første serverprototype:

- server starter og viser helse/status
- klient eller testscript kan hente state snapshot
- revision er synlig
- SSE sender `state_changed` ved test-event
- ingen endring i `index.html`
- ingen endring i SDE-motor, score eller dataflyt

Åpne valg før implementering:

- nøyaktig state-shape i `app_state.state_json`
- hvordan eksisterende klientstate migreres inn første gang
- hvordan device-id og rolle skal utstedes
- hvor backup/export skal lagres
- om første klientintegrasjon skal være separat testside eller bak feature flagg
