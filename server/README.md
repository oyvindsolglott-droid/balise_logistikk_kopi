# SDE server

Dette er et første serverskjelett for serverstyrt fler-enhetsmodell i SDE / Skien
sporplan.

Serveren er ikke koblet til PWA-en ennå. `index.html`, SDE-motor, score,
dataflyt og klientens `localStorage` er urørt. I denne fasen eksponerer serveren
read-only endepunkter, et test-only write-endepunkt og en enkel Server-Sent
Events-stream.

## Krav

- Node.js 24 eller nyere
- npm

Serveren bruker Express og Node sin innebygde SQLite-modul (`node:sqlite`).

## Installasjon

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
npm install
npm start
```

Serveren starter som standard på port `8787`. Bruk `PORT` for å velge annen port.
Databasen opprettes som standard i `server/data/sde-server.sqlite3`. Bruk
`SDE_SERVER_DB_PATH` for å velge annen databasefil.

## Lokal drift på Mac mini

Bruk repoet `/Users/solglottsr/balise_logistikk_kopi` og servermappen
`/Users/solglottsr/balise_logistikk_kopi/server` for lokal serverdrift, patch,
commit og push. Ikke bruk klonen i `/Users/solglottsr/Downloads/balise_logistikk_kopi`
til dette.

Serveren lytter på port `8787`. Hvis `npm start` feiler med `EADDRINUSE`, betyr
det vanligvis at en server allerede kjører på porten. Det er ikke nødvendigvis
en feil. Identifiser prosessen før eventuell stopp:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Ikke stopp en riktig serverprosess blindt.

## Testkommandoer

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/server/status
curl http://localhost:8787/api/state
curl http://localhost:8787/api/state/revision
curl http://localhost:8787/api/events
curl -N http://localhost:8787/api/stream
curl -X POST http://localhost:8787/api/actions/test-note \
  -H 'Content-Type: application/json' \
  -d '{"expectedRevision":1,"note":"test fra curl"}'
```

For LAN-test, bruk Mac mini sin aktuelle LAN-IP:

```bash
curl http://<mac-mini-lan-ip>:8787/api/health
```

`192.168.10.235` og `192.168.10.151` er observerte eksempler, ikke evige fasiter.

## Repo- og filhygiene

- `server/package-lock.json` skal være versjonert.
- `server/node_modules/` skal ikke committes.
- `server/data/sde-server.sqlite3` skal ikke committes.
- `server/data/sde-server.sqlite3-wal` skal ikke committes.
- `server/data/sde-server.sqlite3-shm` skal ikke committes.

## Endepunkter i denne fasen

- `GET /api/health`
- `GET /api/server/status`
- `GET /api/state`
- `GET /api/state/revision`
- `GET /api/events?sinceRevision=N`
- `GET /api/stream`
- `POST /api/actions/test-note`
- `POST /api/actions/action-contract-test`

`POST /api/actions/test-note` er kun en server-write-test og er deaktivert som
standard. Den krever `SDE_ENABLE_TEST_WRITES=1`, `expectedRevision`, returnerer
`409 Conflict` ved revision-konflikt og skal ikke kobles til PWA-en. Test-write
bør kjøres mot separat testdatabase, for eksempel med
`SDE_SERVER_DB_PATH=/tmp/sde-server-b1-test.sqlite3`. Produksjonsserveren skal
ikke bruke test-writes med mindre dette er en bevisst kontrollert test. Det
finnes ingen operative write-endepunkter ennå.

`POST /api/actions/action-contract-test` er kun en B8B test-only
kontraktstest. Den er deaktivert uten `SDE_ENABLE_ACTION_CONTRACT_TESTS=1` og
skal bare kjøres på separat testserver og separat testdatabase. Endpointet
avviser produksjonsport `8787`, manglende `SDE_SERVER_DB_PATH` og
produksjonsdatabasen. Den skriver bare testfeltet `actionContractTest` og
eventtype `action_contract.test`; den skal aldri skrive `operationalState`,
aldri kobles til PWA og aldri brukes som ekte SDE-action.

`GET /api/server/status` er et read-only drift/status-endepunkt. Det er ikke en
PWA-kontrakt.

## Drift, restart og backup

All serverdrift skal gjøres fra repoet `/Users/solglottsr/balise_logistikk_kopi`
og servermappen `/Users/solglottsr/balise_logistikk_kopi/server`. Ikke bruk
klonen i `/Users/solglottsr/Downloads/balise_logistikk_kopi` til drift, patch,
commit, push, backup eller restore.

Produksjonsruntime kjører foreløpig i en detached `screen`-sesjon:
`sde-server-8787`. Dette er ikke et permanent serviceoppsett.

B16D-B viste at direkte background-start fra Codex-shell ikke skal brukes som
varig runtime: prosessen startet, men ble ikke stående etter shell-blokken.
B16D-B-R gjenopprettet runtime korrekt med detached `screen`. Inntil en egen
launchd/service-fase eventuelt godkjennes, er `screen` den dokumenterte
runtime-metoden for port `8787`.

Trygg statuskontroll:

```bash
cd /Users/solglottsr/balise_logistikk_kopi
git status -sb
git log --oneline --decorate -8
screen -ls
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -a -p <PID> -d cwd
curl --max-time 5 -sS http://localhost:8787/api/health
curl --max-time 5 -sS http://localhost:8787/api/server/status
curl --max-time 5 -sS http://localhost:8787/api/state/revision
```

Stopp, start og restart skal bare gjøres etter at riktig PID, port og cwd er
bekreftet. Stopp kun bekreftet riktig PID eller riktig `screen`-sesjon. Start
alltid fra riktig servermappe, i detached `screen`, uten write-/migrationflagg,
og med production-port `8787`.

Startkommandoen skal bruke ren env og fjerne kjente write-/migrationflagg:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
screen -dmS sde-server-8787 bash -lc '
cd /Users/solglottsr/balise_logistikk_kopi/server || exit 1
exec env \
  -u SDE_ENABLE_SERVER_NOTE_ACTIONS \
  -u SDE_ENABLE_SCHEMA_MIGRATIONS \
  -u SDE_ENABLE_OPERATIONAL_WRITES \
  -u SDE_ENABLE_TEST_WRITES \
  -u SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES \
  PORT=8787 \
  /opt/homebrew/bin/node src/index.js
'
```

Etter start eller restart skal postcheck kun bruke GET:

```bash
curl --max-time 5 -sS http://localhost:8787/api/health
curl --max-time 5 -sS http://localhost:8787/api/server/status
curl --max-time 5 -sS http://localhost:8787/api/state/revision
curl --max-time 5 -sS http://localhost:8787/api/events
```

`server/status` skal vise at ny kode er lastet uten å åpne writeflater:

- `serverNoteActionsEnabled: false`
- `migrationsEnabled: false`
- `testWritesEnabled: false`
- `actionsTableTestWritesEnabled: false`
- `pwaConnected: false`
- `operationalWritesEnabled: false`
- `actionsSchemaReady: true`
- `migrationRequired: false`

Revision skal fortsatt være forventet revision, og events skal ikke endres av
start/restart alene. For nå er forventet production-baseline `revision: 1` og
`events: []`.

Stopp restart/recovery hvis repo ikke er rent, HEAD ikke er forventet, port/cwd
eller PID er uklar, port `8787` ikke lytter etter start, GET-postcheck feiler,
`serverNoteActionsEnabled` blir `true`, `migrationsEnabled` blir `true`, revision
eller events endres, eller loggen viser uventet serverfeil.

Røde soner for runtime-drift: ingen POST mot `8787`, ingen production-write,
ingen migration/runner, ingen PWA/serverkobling, ingen operational write, ingen
ekte SDE-action, ingen packageendring, ingen frontend/`index.html`, og ingen
launchd/service-oppsett uten egen fase.

SQLite-backup skal tas med SQLite sin `.backup`, ikke ved vanlig shell-kopi av
`.sqlite3`, `-wal` og `-shm` som hovedmetode. Backup legges utenfor repo, for
eksempel i `/Users/solglottsr/sde-server-backups/`, og skal ikke committes.
Bruk timestamp og revision i filnavnet, for eksempel:
`sde-server-rev-1-YYYYMMDD-HHMMSS.sqlite3`.

Prinsipp:

```bash
sqlite3 /Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3 \
  ".backup '/Users/solglottsr/sde-server-backups/sde-server-rev-1-YYYYMMDD-HHMMSS.sqlite3'"
sqlite3 /Users/solglottsr/sde-server-backups/sde-server-rev-1-YYYYMMDD-HHMMSS.sqlite3 \
  "PRAGMA integrity_check;"
sqlite3 /Users/solglottsr/sde-server-backups/sde-server-rev-1-YYYYMMDD-HHMMSS.sqlite3 \
  "SELECT revision, updated_at FROM app_state WHERE id = 'main';"
```

Restore skal ikke gjøres som del av vanlig drift eller B4. Restore krever egen
eksplisitt godkjenning. Før restore skal serveren stoppes kontrollert, og det
skal tas en ekstra pre-restore backup av nåværende database. Etter restore skal
serveren startes igjen og verifiseres read-only med `health`, `server/status`
og `state/revision`. Rollback er å stoppe serveren og sette tilbake
pre-restore-backupen.

Stopp prosessen hvis repo eller cwd er feil, `HEAD` ikke er forventet,
arbeidstreet ikke er rent, PID/cwd ikke matcher riktig servermappe,
`/api/server/status` viser `testWritesEnabled: true`, revision er uventet,
backup-path peker inn i feil klon eller repo, eller restore forsøkes uten egen
godkjenning.

## Fremtidig action-kontrakt

Dette er design for fremtidige server-writes. Det er ikke implementert som
operativ SDE-funksjon, PWA-write er ikke koblet, og
`operationalWritesEnabled` skal fortsatt være `false`.

Alle fremtidige operative actions skal sendes som en action envelope:

```json
{
  "actionId": "uuid-or-stable-client-id",
  "actionType": "sde.example-action",
  "actor": "operator-or-role",
  "deviceId": "client-device-id",
  "expectedRevision": 1,
  "createdAt": "client-timestamp-if-useful",
  "payload": {},
  "clientContext": {}
}
```

`serverTimestamp` skal settes av serveren og være autoritativ tid i eventlogg
og audit. `createdAt` fra klient kan beholdes som klientkontekst, men skal ikke
erstatte serverens tidspunkt.

`actionId` er idempotency key. Samme `actionId` skal ikke kunne skrive samme
handling dobbelt. Retry med samme `actionId` skal gi en trygg respons, mens en
ny handling skal ha ny `actionId`.

`actor` identifiserer hvem eller hvilken rolle som utfører handlingen.
`deviceId` identifiserer klienten eller enheten. Ingen anonym operativ write
skal innføres senere. Auth og roller implementeres ikke nå, men kontrakten skal
være forberedt på at de kommer.

Alle operative writes skal kreve `expectedRevision`. Hvis klientens revision
ikke matcher serverens nåværende revision, skal serveren returnere
`409 Conflict`. Klienten må da lese ny state før retry eller ny vurdering. Det
skal ikke finnes blind overskriving av serverstate.

Responsprinsipp:

- `400 Bad Request` ved ugyldig payload eller manglende påkrevde felt.
- `403 Forbidden` hvis write-flaten ikke er aktivert.
- `409 Conflict` ved revision-konflikt.
- `200 OK` ved idempotent retry av allerede utført action.
- `201 Created` eller `200 OK` ved ny vellykket handling, avklares før første
  ekte action.
- `500 Internal Server Error` kun ved faktisk serverfeil.

Alle vellykkede fremtidige actions skal gi audit/event. Eventen skal knyttes
til revision, `actionId`, `actionType`, `actor`, `deviceId`, server timestamp
og et relevant payload-sammendrag. Eventloggen skal kunne brukes for senere
feilsøking.

State update, revision-økning og eventlogg skal skje i samme SQLite-transaksjon.
Revision skal økes atomisk. Det skal ikke finnes halvveis action der state er
oppdatert uten event, eller event finnes uten state update.

Retry-regler:

- Retry med samme `actionId` skal være trygg.
- Retry etter `409 Conflict` krever ny state-lesing.
- Klienten skal ikke automatisk presse gjennom konflikt.

Rollback for ekte action skal være en eksplisitt ny handling, ikke usynlig
databasesletting. Database-restore er et driftstiltak, ikke normal operativ
undo, og krever egen godkjenning.

Før første ekte action skal testmodellen verifiseres på separat testdatabase og
testserver:

- stale `expectedRevision`
- idempotent retry med samme `actionId`
- ugyldig payload
- eventlogg/audit
- revision-økning
- ingen produksjonsrevision endres før eksplisitt godkjenning

Første fremtidige action bør fortsatt analyseres separat. En ufarlig
server-action på separat testdatabase kan være første kandidat, men endelig
endpoint og payload skal ikke låses før egen designrunde.

Røde soner for denne fasen: PWA-read og PWA-write er ikke koblet, ekte SDE
Utført/Annullert er ikke implementert, og manuell overstyring, DROPS-order, TXP
unavailable, reset-day og import-data er ikke implementert.

## Fremtidig kontraktstest

Dette er testplan/design for en senere action-kontraktstest. Det er ingen
kodeimplementering i denne fasen, ingen endpoint legges til, og ingen writeflate
åpnes. En eventuell B8-implementering må vurderes og godkjennes separat.

En senere test skal kjøres på separat testserver og separat SQLite-fil, for
eksempel:

- `PORT=8795`
- `SDE_SERVER_DB_PATH=/tmp/sde-server-b7-action-contract.sqlite3`
- eksplisitt testflagg for action-kontraktstest
- aldri port `8787`
- aldri produksjonsdatabasen
- aldri PWA

Harde prod-guards for en eventuell senere test-action:

- avvis `PORT=8787`
- avvis databasepath som peker på
  `/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`
- krev eksplisitt testflagg
- avvis hvis separat `SDE_SERVER_DB_PATH` mangler
- aldri sett `operationalWritesEnabled: true` på produksjon
- aldri endre `operationalState`
- aldri bruk endpointet fra PWA

En senere B8 må bevise disse testcasene på testserver/testdatabase:

- `health` og `server/status` svarer på testserveren
- initial revision er `1`
- vellykket test-action gir revision `1 -> 2`
- duplicate `actionId` gir idempotent respons uten ny revision
- stale `expectedRevision` gir `409 Conflict`
- ugyldig payload gir `400 Bad Request`
- endpoint uten testflagg gir `403 Forbidden`
- eventlogg/audit inneholder action
- state update og eventlogg er atomiske og konsistente
- ingen halvveis write finnes
- produksjon `8787` sjekkes read-only før og etter, og revision forblir `1`

Produksjonschecks for en senere B8 skal bare være read-only:

```bash
curl --max-time 5 -sS http://localhost:8787/api/server/status
curl --max-time 5 -sS http://localhost:8787/api/state/revision
```

Status skal fortsatt vise `testWritesEnabled: false`,
`operationalWritesEnabled: false` og `pwaConnected: false`, og produksjonsrevision
skal være uendret.

Stopp en senere B8 hvis test-action kan kjøres på `8787`, kan peke på
produksjonsdatabasen, virker uten eksplisitt testflagg, endrer
produksjonsrevision, blander inn PWA, berører `index.html`, endrer
`operationalState`, eller krever schema/package-endring uten separat
godkjenning.

Røde soner: ingen PWA-read, ingen PWA-write, ingen ekte SDE Utført/Annullert,
ingen manuell overstyring mot server, ingen DROPS-order mot server, ingen TXP
unavailable mot server, ingen reset-day mot server, ingen import-data mot
server, ingen produksjonswrite og ingen schema/package-endring uten egen
analyse.

B7 kan bare lukkes som testplan når README tydelig sier at ingen kode er
implementert, B8 krever egen analyse og godkjenning, og prod-guards, testcases,
stoppsignaler og røde soner er definert.

## B8A test-only action-kontrakt

B8A er design-only dokumentasjon. Det implementeres ingen kode, ingen endpoint
legges til, ingen writeflate åpnes, og produksjonsserveren restartes ikke. En
eventuell B8B med test-only kode krever egen analyse og eksplisitt godkjenning.

Foreslått test-only endpoint for en senere B8B:

- `POST /api/actions/action-contract-test`
- endpointet skal kun være test-only
- `test-note` skal ikke gjenbrukes
- endpointet skal aldri brukes som ekte SDE-action

Foreslått testflagg:

- `SDE_ENABLE_ACTION_CONTRACT_TESTS=1`
- flagget skal være separat fra `SDE_ENABLE_TEST_WRITES`

Absolutte prod-guards for en eventuell B8B:

- serveren skal nekte testflagg sammen med `PORT=8787`
- serveren skal nekte testflagg sammen med produksjonsdatabasen
  `/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`
- serveren skal nekte testflagg hvis `SDE_SERVER_DB_PATH` mangler
- endpointet skal også returnere `403 Forbidden` hvis guardene ikke er oppfylt
- test-action skal aldri skrive til `operationalState`
- test-action skal aldri sette `operationalWritesEnabled: true`
- test-action skal aldri være tilgjengelig for PWA

Foreslått minimumspayload:

```json
{
  "actionId": "b8b-test-001",
  "actionType": "action_contract.test",
  "actor": {
    "id": "local-test-operator",
    "role": "developer"
  },
  "deviceId": "mac-mini-b8b-test",
  "expectedRevision": 1,
  "payload": {
    "testNote": "contract test write"
  },
  "clientContext": {
    "source": "b8b-testserver"
  }
}
```

Responsmodell:

- `201 Created` ved ny vellykket test-action
- `200 OK` ved idempotent retry med samme `actionId`, uten ny revision
- `400 Bad Request` ved ugyldig payload
- `403 Forbidden` når testflagg mangler eller prod-guard stopper
- `409 Conflict` ved `expectedRevision`-mismatch
- `500 Internal Server Error` kun ved reell serverfeil

Idempotency uten schemaendring:

- `actionId` kan i B8B-test sjekkes via eksisterende events/event-payload
- dette er akseptabelt kun på separat testserver og separat testdatabase
- dette er ikke produksjonsklar idempotency under parallell samtidighet
- hvis B8B krever unik indeks, ny tabell eller schemaendring, skal B8B stoppes
  og erstattes av egen schemaanalyse

Foreslått statefelt og eventtype:

- statefelt: `actionContractTest`
- eventtype: `action_contract.test`
- aldri `operationalState`
- aldri SDE Utført/Annullert
- aldri manuell overstyring, DROPS-order, TXP unavailable, reset-day eller
  import-data

Testplan for en eventuell senere B8B:

- read-only produksjonsprecheck på `8787` med `/api/server/status` og
  `/api/state/revision`
- produksjonsrevision skal være uendret før og etter
- separat testserver, for eksempel `PORT=8795`
- separat testdatabase, for eksempel
  `/tmp/sde-server-b8-action-contract.sqlite3`
- testflagg kun på testserver: `SDE_ENABLE_ACTION_CONTRACT_TESTS=1`
- endpoint uten testflagg skal gi `403 Forbidden`
- invalid payload skal gi `400 Bad Request`
- ny success-action skal gi `201 Created` og revision `1 -> 2`
- duplicate `actionId` skal gi `200 OK` og ingen ny revision
- stale `expectedRevision` skal gi `409 Conflict`
- `/api/events?sinceRevision=1` skal vise `action_contract.test`
- testserver skal stoppes etterpå

Stoppsignaler for B8B:

- test-action kan kjøres på `8787`
- test-action kan peke på produksjonsdatabasen
- test-action virker uten eksplisitt testflagg
- `operationalState` røres
- schemaendring kreves
- packageendring kreves
- produksjonsrevision endres
- PWA eller `index.html` blandes inn
- duplicate `actionId` lager ny revision
- stale revision gir noe annet enn `409 Conflict`
- endpoint gir `200 OK` eller `201 Created` der `403`, `400` eller `409`
  forventes

Rollback-prinsipp:

- for B8A README-only er rollback å reverte dokumentasjonscommit hvis designet
  er feil
- for eventuell senere B8B-kode er rollback å reverte commit før
  produksjonsrestart
- produksjonsserver `8787` skal ikke restartes i B8B uten egen godkjenning
- testserver stoppes, og `/tmp`-testdatabase slettes eller beholdes etter
  eksplisitt avklaring

## B8B test-only action-kontrakt

B8B er server-only testkode for action-kontrakten. Det er ikke PWA-kobling,
ikke produksjonswrite og ikke ekte SDE-action. Produksjonsserver `8787` skal
ikke restartes som del av B8B uten egen godkjenning.

Endpointet `POST /api/actions/action-contract-test` krever
`SDE_ENABLE_ACTION_CONTRACT_TESTS=1`. Når flagget er satt, skal serveren nekte
oppstart hvis `PORT=8787`, hvis `SDE_SERVER_DB_PATH` mangler, eller hvis
databasepath peker på produksjonsdatabasen:
`/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`.
Endpointet har samme guard internt og returnerer `403 Forbidden` hvis miljøet
ikke er trygt.

B8B bruker eksisterende `app_state` og `events`. Den endrer ikke schema og
legger ikke til dependencies. Idempotency sjekkes via `actionId` i eksisterende
event-payload, og er bare akseptabelt på separat testserver og testdatabase.
Dette er ikke produksjonsklar idempotency under parallell samtidighet.

Vellykket ny test-action gir `201 Created`, øker revision og skriver
`actionContractTest` samt eventtype `action_contract.test`. Idempotent retry
med samme `actionId` og samme payload gir `200 OK` uten ny revision. Samme
`actionId` med annen payload gir `409 Conflict`. Stale `expectedRevision` gir
`409 Conflict`.

Testkjøring skal bruke separat port og testdatabase, for eksempel:

```bash
PORT=8795 \
SDE_SERVER_DB_PATH=/tmp/sde-server-b8-action-contract.sqlite3 \
SDE_ENABLE_ACTION_CONTRACT_TESTS=1 \
npm start
```

Røde soner for B8B: ingen `index.html`, ingen PWA, ingen `operationalState`,
ingen ekte SDE Utført/Annullert, ingen manuell overstyring, ingen DROPS-order,
ingen TXP unavailable, ingen reset-day, ingen import-data, ingen produksjonsDB,
ingen schemaendring og ingen packageendring.

## B9B produksjonsklar idempotency-design

B9B er README-only design. Det implementeres ingen kode, schemaendring,
migration, produksjonswrite eller produksjonsrestart i denne fasen.

B8B er fortsatt test-only fordi idempotency sjekkes via `events.payload_json`.
Det er akseptabelt på separat testserver og separat testdatabase, men er ikke
produksjonsklar under parallell samtidighet. Produksjonsmodellen skal ikke
avhenge av parsing av eventlogg, og B8B-modellen skal ikke gjenbrukes som
produksjonsmodell.

Foreslått produksjonsklar action-tabell:

```sql
CREATE TABLE actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  device_id TEXT,
  expected_revision INTEGER,
  request_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  resulting_revision INTEGER,
  event_id INTEGER,
  server_created_at TEXT NOT NULL,
  completed_at TEXT
);
```

Dette er design, ikke implementert schema. `action_id` må være unik. Samme
`action_id` med samme canonical request skal gi idempotent replay. Samme
`action_id` med annen request eller annen hash skal gi
`409 action_id_conflict`. Idempotency skal ikke kreve søk eller parsing i
`events.payload_json`.

Requesten må canonicaliseres stabilt før hash beregnes. `payload_hash` bør
beregnes av canonical request. Node sin innebygde `node:crypto` kan trolig
brukes senere, så hashing bør ikke kreve packageendring. Ustabil
canonicalisering er en risiko og må testes separat før produksjonswrite.

`expectedRevision`-regler:

- ny action skal sjekke `expectedRevision` mot nåværende revision
- stale revision skal gi `409 revision_conflict`
- idempotent replay av samme action skal returnere tidligere resultat, ikke
  feile fordi current revision senere har økt
- samme `actionId` med endret `expectedRevision` regnes som annen request og
  skal gi `409 action_id_conflict`

Ønsket atomisk transaksjonsmodell:

1. `BEGIN IMMEDIATE`
2. sjekk eksisterende `action_id`
3. ved samme request: returner tidligere resultat uten ny write
4. ved samme `action_id` med annen request/hash: returner
   `409 action_id_conflict`
5. sjekk `expectedRevision`
6. oppdater state og revision
7. insert event
8. insert/update action-record med `resulting_revision` og `event_id`
9. `COMMIT`
10. rollback ved feil

Action-record, eventlogg og state-revision må holdes atomisk sammen. Det skal
ikke finnes vellykket action uten event, event uten state update, eller revision
uten action-record.

Responsmodell for produksjonsklar actionflate:

- `201 Created` ved ny action/write
- `200 OK` ved idempotent replay uten ny revision
- `400 Bad Request` med `invalid_payload`
- `403 Forbidden` med `forbidden` eller `disabled`
- `409 Conflict` med `revision_conflict`
- `409 Conflict` med `action_id_conflict`
- `500 Internal Server Error` med `server_error`, kun ved reell serverfeil

Migrasjon og rollback:

- første schemaendring krever egen fase
- før schemaendring må backup tas og verifiseres
- migration må testes på separat database først
- rollback må være definert før produksjon berøres
- restore skal ikke skje automatisk
- B5-backup skal ikke brukes uten egen eksplisitt restore-godkjenning

Testplan for senere B9C/B10 på separat testdatabase:

- opprett `actions`-tabell på separat testdatabase
- verifiser unik `action_id`
- verifiser canonical hash
- verifiser idempotent replay
- verifiser `action_id_conflict`
- verifiser `revision_conflict`
- verifiser at action, event og state er atomiske sammen
- verifiser rollback ved feil
- produksjon `8787` sjekkes kun read-only før og etter

Røde soner for B9B: ingen PWA, ingen `index.html`, ingen ekte SDE-action,
ingen operational writes, ingen produksjonswrite, ingen produksjonsrestart,
ingen SDE-motor, ingen DROPS/Tursatt/Vaktplan/localStorage, ikke bruk B8B
eventpayload-idempotency som produksjonsmodell, ingen schemaendring og ingen
packageendring.

## B9D migration-plan for actions-schema

B9D er plan, ikke implementering. Det gjøres ingen kodeendring, schemaendring,
migration, serverstart, databasewrite eller produksjonsrestart i denne fasen.
Målet er å gjøre en senere B10A test-only schema/migration på separat
testdatabase nesten mekanisk. B10A krever egen eksplisitt godkjenning.

B10A starter ikke ennå fordi første schemaendring er et større driftsmessig
steg. B9B låste idempotency-retningen, men ikke konkret migration. Migration
må ha precheck, idempotent oppførsel, rollback og testkriterier før kode.

Schema-versjonering:

- `schemaVersion` inne i state JSON er ikke nok som DB-migrasjonsstyring.
- B10A må vite nøyaktig hvilken schema-versjon den starter fra og ender på.
- `PRAGMA user_version` bør brukes som enkel SQLite-native versjonering.
- En senere `schema_migrations`-tabell kan vurderes hvis vi trenger detaljert
  historikk over flere migrations.
- B10A bør ikke blande flere versjoneringsmekanismer uten egen begrunnelse.

Foreslått actions-DDL for senere testfase:

```sql
CREATE TABLE actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  device_id TEXT,
  expected_revision INTEGER,
  request_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  resulting_revision INTEGER,
  event_id INTEGER,
  server_created_at TEXT NOT NULL,
  completed_at TEXT
);
```

Dette er design, ikke implementert schema. `event_id` bør i første runde være
et auditfelt uten foreign key. SQLite foreign keys krever bevisst
`PRAGMA foreign_keys=ON`; FK kan gi falsk trygghet hvis den ikke er aktivert
konsekvent. Foreign key-policy bør tas som egen analyse før FK innføres.

Idempotent migration-regel:

- hvis `actions` ikke finnes: opprett den
- hvis `actions` finnes med forventet schema: migration er OK/no-op
- hvis `actions` finnes med uventet schema: stopp hardt og ikke reparer
  automatisk
- `CREATE TABLE IF NOT EXISTS` alene er ikke nok, fordi det kan skjule feil
  tabellform

Precheck før migration:

- bekreft riktig DB-path
- avvis produksjonsDB i testfase
- `PRAGMA integrity_check`
- `PRAGMA user_version`
- list eksisterende tabeller
- `PRAGMA table_info(actions)` hvis tabellen finnes
- `PRAGMA index_list(actions)` hvis tabellen finnes
- les `app_state` revision/status
- les events-status uten å skrive

Verifisering etter migration:

- `PRAGMA integrity_check` skal gi `ok`
- `PRAGMA user_version` skal være forventet ny versjon
- `PRAGMA table_info(actions)` skal matche forventet kolonneliste
- `PRAGMA index_list(actions)` skal vise unik primary key på `action_id`
- test av unik `action_id`
- test av at feil duplicate avvises
- bekreft at eksisterende `app_state` og `events` ikke er skadet

Index-strategi:

- `PRIMARY KEY(action_id)` er minimum
- indexer på `event_id`, `resulting_revision` eller `action_type` kan vurderes
  senere
- ikke overindekser før faktisk querybehov er kjent

Rollbackstrategi:

- i test skal feil gi transaksjonsrollback
- før eventuell produksjonsmigration skal backup tas og verifiseres
- restore skal ikke skje automatisk
- etter produksjonsmigration krever rollback egen eksplisitt godkjenning
- forward-fix kan være tryggere enn restore hvis produksjon har gått videre
- B5-backup skal ikke brukes uten separat restore-godkjenning

Separat testdatabase-plan for senere B10A:

- B10A skal bare bruke separat testdatabase
- produksjon `8787` skal kun sjekkes read-only før og etter
- testdatabase kan ligge i `/tmp`, for eksempel
  `/tmp/sde-server-b10-actions-migration.sqlite3`
- test må dekke fresh DB
- test må dekke DB som allerede har forventet `actions`-tabell
- test må dekke DB med feil `actions`-tabell og bekrefte hard stopp

Stoppsignaler for B10A:

- schema/packageendring blir bredere enn planlagt
- migration kan treffe produksjonsDB
- migration skjuler feil eksisterende `actions`-tabell
- `PRAGMA integrity_check` er ikke `ok`
- unik `action_id` kan ikke verifiseres
- `user_version` oppdateres eller valideres ikke riktig
- `app_state` eller `events` påvirkes utilsiktet
- produksjonsrevision endres
- produksjonsserver må restartes uten egen godkjenning

Røde soner for B9D: ingen PWA, ingen `index.html`, ingen ekte SDE-action,
ingen operational writes, ingen produksjonswrite, ingen produksjonsrestart,
ingen schemaendring i B9D, ingen migration i B9D, ingen packageendring, ingen
DB-write, ingen POST, ingen serverstart, ingen testserverstart, ingen SDE-motor,
score, sortering, DROPS, Tursatt, Vaktplan eller localStorage.

## B10B test-only actions migration

B10B er test-only schema/migration mot separat SQLite-fil. Den er ikke koblet
til normal serveroppstart, `openDatabase()` eller PWA, og den skal ikke kjøres
mot produksjonsdatabasen.

Test-only helperen ligger i `server/src/actionsMigration.js`, og eksplisitt
testscript ligger i `server/scripts/test-actions-migration.js`. Kjøring skal
bare gjøres som en avgrenset test:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
node scripts/test-actions-migration.js
```

Scriptet bruker separat testdatabase:
`/tmp/sde-server-b10-actions-migration.sqlite3`, og en egen feil-schema-DB for
hard-stop-test. Det har guard mot produksjonsdatabasen:
`/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`.

B10B-testen skal bevise:

- fresh test-DB får `actions`-tabell
- `PRAGMA user_version` går til `1`
- `PRAGMA integrity_check` gir `ok`
- ny kjøring mot korrekt eksisterende `actions`-tabell er OK/no-op
- feil eksisterende `actions`-tabell stopper hardt og repareres ikke
- unique `action_id` virker
- `PRAGMA table_info(actions)` og `PRAGMA index_list(actions)` matcher
  forventet schema

Røde soner for B10B: ingen produksjonsDB, ingen serverstart, ingen
testserverstart, ingen POST, ingen PWA, ingen `index.html`, ingen ekte
SDE-action, ingen `operationalState`, ingen packageendring og ingen
produksjonsrestart.

## B10D runtime-migration-design

B10D er runtime-/deploy-design, ikke implementering. Det gjøres ingen
kodeendring, schemaendring, migration, serverstart, databasewrite eller
produksjonsrestart i denne fasen.

`actionsMigration` er fortsatt ikke koblet til `openDatabase()` eller
serverruntime. Normal serverstart skal ikke auto-migrere schema, og en vanlig
produksjonsrestart skal aldri kunne gi utilsiktet schemaendring.

En eventuell senere runtime-migration må kreve eksplisitt deploy- eller
testflagg. Testserver-runtime skal bare kunne brukes med separat testdatabase,
separat port og egne guards mot port `8787` og produksjonsdatabasen:
`/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`.

Produksjonsmigration må være en egen senere fase med eksplisitt godkjenning.
Før produksjon berøres må det foreligge verifisert backup, read-only precheck,
klart rollback-prinsipp og postcheck. Restore skal ikke skje automatisk og
krever egen eksplisitt godkjenning.

Fremtidig `/api/server/status` kan utvides med read-only schemafelter, for
eksempel:

- `schemaUserVersion`
- `actionsSchemaReady`
- `migrationRequired`
- `migrationsEnabled`

Disse feltene skal i første omgang være status/readiness, ikke et signal om at
serveren kan skrive schema ved normal oppstart.

Stoppsignaler for senere runtime-migration:

- migration kan kjøres ved vanlig serverstart uten eksplisitt flagg
- produksjonsrestart kan endre schema automatisk
- testserver-runtime kan bruke port `8787`
- testserver-runtime kan peke på produksjonsdatabasen
- `openDatabase()` kobles til write-migration uten egen godkjenning
- `/api/server/status` skjuler at migration mangler eller er deaktivert
- rollback-plan mangler før produksjon vurderes
- produksjonsrevision, `app_state` eller `events` påvirkes utilsiktet

Røde soner for B10D: ingen kodeendring, ingen schemaendring, ingen migration,
ingen serverstart, ingen testserverstart, ingen produksjonsrestart, ingen POST,
ingen DB-write, ingen PWA, ingen `index.html`, ingen packageendring, ingen ekte
SDE-action og ingen operational writes.

Filer som fortsatt ikke skal røres i B10D: `server/src/*.js`,
`server/scripts/*.js`, `server/package.json`, `server/package-lock.json`,
`index.html`, runtime databasefiler og `node_modules`.

## B11 read-only schema/status

B11 utvider `GET /api/server/status` med read-only schema/readiness-felter. Det
gjøres ingen migration, ingen schema-write, ingen state/revision-endring og ingen
PWA-kobling.

Statusfeltene er:

- `schemaUserVersion`
- `actionsTablePresent`
- `actionsSchemaReady`
- `migrationRequired`
- `migrationsEnabled`

`migrationsEnabled` skal være `false` i B11. `actionsSchemaReady` er bare `true`
hvis `actions`-tabellen finnes og matcher forventet read-only struktur. Hvis
produksjonsdatabasen ikke har `actions`-tabell ennå, er forventet status
`actionsTablePresent: false`, `actionsSchemaReady: false` og
`migrationRequired: true`. Det er readiness-informasjon, ikke en runtime-feil.

B11 skal ikke koble `actionsMigration` til `openDatabase()` eller serverruntime,
og normal serverstart skal fortsatt ikke auto-migrere schema.

## B12 test-only runtime-migration

B12 legger til test-only runtime-migration for `actions`-schema. Dette er ikke
produksjonsmigration, ikke PWA og ikke ekte SDE-action. Normal serverstart uten
eksplisitt flagg skal fortsatt ikke migrere schema.

Runtime-migration krever:

- `SDE_ENABLE_SCHEMA_MIGRATIONS=1`
- port forskjellig fra `8787`
- eksplisitt `SDE_SERVER_DB_PATH`
- databasefil under `/tmp/`
- databasepath som ikke er produksjonsdatabasen
- kjøring fra `/Users/solglottsr/balise_logistikk_kopi/server`

Hvis flagget mangler, starter serveren normalt uten migration og
`migrationsEnabled:false`. Hvis flagget er aktivt og guardene er oppfylt,
kjøres actions-migration mot testdatabasen, og `/api/server/status` skal vise
`migrationsEnabled:true`.

Forventet status på fresh testdatabase før migration er
`schemaUserVersion:0`, `actionsTablePresent:false`, `actionsSchemaReady:false`
og `migrationRequired:true`. Etter vellykket test-only migration er forventet
status `schemaUserVersion:1`, `actionsTablePresent:true`,
`actionsSchemaReady:true` og `migrationRequired:false`.

B12 skal aldri kjøres mot port `8787` eller produksjonsdatabasen:
`/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`.

## B13E production migration-runner-design

B13E dokumenterer bare design og policy for en mulig senere one-shot
production migration-runner. Det implementeres ingen runner, det kjøres ingen
production migration, og produksjonsdatabasen endres ikke i B13E.

Nåværende status:

- production migration er ikke gjort
- production `schemaUserVersion` er fortsatt `0`
- production `actionsTablePresent` er fortsatt `false`
- B13B har bare bevist migration på en SQLite `.backup`-kopi i `/tmp`
- B13C ga NO-GO til production migration med dagens tooling
- B13D anbefaler one-shot runner som fremtidig metode

Dagens tooling skal ikke brukes direkte for production migration:

- runtime migration-mode blokkerer port `8787`
- runtime migration-mode blokkerer produksjonsdatabasen
- `actionsMigration` blokkerer produksjonsdatabasen
- dette er ønskede guards, ikke feil
- manuell SQL mot produksjonsdatabasen er NO-GO fordi det omgår testet
  migrasjonskode og guard-disiplin

Anbefalt fremtidig metode er en one-shot production migration-runner:

- runneren skal ikke starte driftserver
- runneren skal ikke binde port
- runneren skal bare kjøre actions schema-migration
- runneren skal avslutte etter migration
- runneren skal aldri være del av normal `openDatabase()`
- normal serverstart skal fortsatt ikke auto-migrere schema

Flagg-policy for en eventuell senere runner:

- `SDE_ENABLE_SCHEMA_MIGRATIONS=1` er ikke nok for production
- det må kreves et eget eksplisitt production-only flagg, for eksempel
  `SDE_ALLOW_PRODUCTION_SCHEMA_MIGRATION_ONCE=1`
- production DB-path må være eksakt:
  `/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`
- cwd må være bekreftet:
  `/Users/solglottsr/balise_logistikk_kopi/server`
- runneren skal nekte samtidige test-write/action-contract-test-flagg
- runneren skal ikke åpne PWA, POST eller operational write
- production-migration-flagg skal bare brukes i én eksplisitt migrationfase
  og skal ikke ligge igjen i normal runtime

Backupkrav før eventuell production migration:

- production server skal stoppes før migration, med mindre en senere fase
  eksplisitt begrunner noe annet
- ta fersk SQLite `.backup` rett før migration
- legg backupfil utenfor repo
- kjør `PRAGMA integrity_check` på backupfilen
- logg backupfilnavnet
- restore-plan må være bestemt før migration
- forward-fix skal vurderes før restore dersom serveren har kjørt videre etter
  migration

Stoppkriterier før migration:

- feil repo
- dirty Git
- uventet HEAD
- production health feiler
- production revision er ikke `1`
- production events er ikke `[]`
- production `schemaUserVersion` er ikke `0`
- `actions`-tabell finnes allerede
- backup feiler
- backup integrity er ikke `ok`
- production server er ikke stoppet
- miljøflagg er uklare
- PWA, POST eller operational write blandes inn

Etterkontroll etter eventuell production migration:

- `/api/health` er OK
- `/api/server/status` er OK
- `schemaUserVersion: 1`
- `actionsTablePresent: true`
- `actionsSchemaReady: true`
- `migrationRequired: false`
- normal runtime etterpå viser `migrationsEnabled: false`
- `/api/state/revision` viser fortsatt `revision: 1`
- `/api/events` viser fortsatt `events: []`
- production `PRAGMA user_version` er `1`
- `actions`-tabell finnes
- Git er fortsatt rent

Røde soner:

- ingen production migration uten egen eksplisitt go/no-go
- ingen manuell SQL mot production
- ingen runtime escape hatch i B13E
- ingen PWA
- ingen POST
- ingen ekte SDE-action
- ingen operational write
- ingen revision- eller events-endring
- ingen package- eller `index.html`-endring i B13E

Neste steg etter B13E skal være en separat vurdering av kodepatch for one-shot
runner. Den fasen skal fortsatt ikke kjøre production migration. Production
migration kommer først i en senere egen fase etter at runneren er designet,
implementert, testet på kopi og eksplisitt godkjent.

## B13F one-shot production migration-runner

B13F legger til selve runner-verktøyet, men kjører det ikke mot production.
Runneren er et separat CLI-verktøy og er ikke del av normal driftserver,
`openDatabase()`, PWA eller `/api/*`.

Runnerfil:

```bash
server/scripts/runProductionActionsMigration.js
```

Scriptkommando:

```bash
npm run migrate:production:actions
```

Runneren skal ikke kjøres uten en senere eksplisitt production migration-fase.
Den krever alle disse miljøvariablene:

```bash
SDE_ALLOW_PRODUCTION_SCHEMA_MIGRATION_ONCE=1
SDE_SERVER_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3
SDE_CONFIRM_PRODUCTION_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3
SDE_PRODUCTION_SCHEMA_BACKUP_PATH=<fersk-backupfil-utenfor-repo>
```

Runneren nekter å kjøre hvis:

- cwd ikke er `/Users/solglottsr/balise_logistikk_kopi/server`
- production server fortsatt lytter på port `8787`
- `PORT` er satt
- `SDE_ENABLE_SCHEMA_MIGRATIONS=1` er satt
- `SDE_ENABLE_TEST_WRITES=1` er satt
- `SDE_ENABLE_ACTION_CONTRACT_TESTS=1` er satt
- production DB-path ikke matcher eksakt forventet path
- backupfil mangler, ligger inne i repo eller ikke har `PRAGMA integrity_check`
  lik `ok`
- backup ikke representerer pre-migration-state
- production DB ikke har `schemaUserVersion: 0`
- production DB allerede har `actions`-tabell

Runneren bruker eksisterende actions-migration-logikk med en eksplisitt intern
`allowProductionDatabase`-opsjon. Default for eksisterende test/runtime-kall er
fortsatt å blokkere production DB. Runtime migration-mode blokkerer fortsatt
production DB og port `8787`, og normal serverstart kan fortsatt ikke migrere
production.

B13F er ikke production migration. Før runneren noen gang brukes mot production
må det komme en separat go/no-go med fersk backup, stoppet production server,
eksakt rollback-plan og etterkontroll.

## B13H production migration-runner-test

B13H legger til et smalt testscript for runner-verifikasjon på en SQLite
`.backup`-kopi i `/tmp`. Testen er ikke production migration og skal ikke bruke
production DB som target.

Testscript:

```bash
npm run test:production-actions-migration-runner
```

Testscriptet:

- lager en `/tmp`-kopi av production DB med SQLite `.backup`
- verifiserer at kopien har `PRAGMA integrity_check = ok`
- verifiserer at kopien starter med `PRAGMA user_version = 0`
- verifiserer at `actions`-tabell mangler før migration
- kjører delt runner-/migration-logikk kun mot `/tmp`-kopien
- verifiserer `PRAGMA user_version = 1` og `actions`-schema etter første run
- kjører en andre gang mot samme `/tmp`-kopi og verifiserer idempotens
- avviser production DB som test-target

B13H endrer ikke `openDatabase()`, `npm start`, runtime migration-mode eller
production-runnerens production-guards. Production migration krever fortsatt en
egen eksplisitt go/no-go og skal ikke regnes som utført av B13H-testen.

## B13J production actions-schema migration runbook

B13J dokumenterer bare prosedyren for en mulig senere production
actions-schema migration. B13J kjører ikke migration, skriver ikke production DB,
stopper ikke serveren og endrer ikke runtime. Production migration er fortsatt
ikke gjort.

Actions-schema migration skal kun kjøres som eksplisitt one-shot production
migration. Normal runtime skal ikke migrere schema, `openDatabase()` skal ikke
migrere, og `npm start` skal ikke migrere. PWA, POST, operational write,
state-write, revision-endring og events-endring er ikke del av migrationen.

Røde soner for execution-fasen:

- ingen manuell SQL mot production
- ingen runtime escape hatch
- ingen PWA-kobling
- ingen POST
- ingen ekte SDE-action
- ingen operational write
- ingen state-write
- ingen revision- eller events-endring
- ingen `index.html`-endring
- ingen packageendring i execution-fasen
- ingen production migration uten fersk validert backup
- ingen production migration uten eksplisitt go/no-go
- ingen restore uten egen eksplisitt godkjenning

Read-only precheck før en senere migration skal bekrefte:

- riktig repo: `/Users/solglottsr/balise_logistikk_kopi`
- rent Git og forventet HEAD
- production health OK
- production PID og cwd peker på riktig servermappe
- production `/api/state/revision` viser `revision: 1`
- production `/api/events` viser `events: []`
- `/api/server/status` viser `schemaUserVersion: 0`
- `/api/server/status` viser `actionsTablePresent: false`
- `/api/server/status` viser `actionsSchemaReady: false`
- `/api/server/status` viser `migrationRequired: true`
- `/api/server/status` viser `migrationsEnabled: false`
- production SQLite `PRAGMA user_version` er `0`
- production SQLite har ingen `actions`-tabell

Backupkrav før runneren kjøres:

- ta fersk SQLite `.backup` rett før migration
- bruk `.backup`, ikke vanlig shell-kopi av sqlite3/-wal/-shm som hovedmetode
- legg backupfilen utenfor repo
- bruk backupnavn med timestamp
- kjør `PRAGMA integrity_check` på backupfilen
- dokumenter backup-path i sluttrapporten
- ikke commit backupfilen

SQLite `.backup` er tryggere enn vanlig `cp`. Hvis production uansett skal
stoppes for migration, kan siste backup tas rett før stopp eller etter stopp,
men valget skal være eksplisitt i execution-prompten. Minimumskravet er at
backupen er fersk, validert og utenfor repo før runneren kjøres.

Production server skal stoppes kontrollert før migration-runneren kjøres:

- identifiser PID på port `8787`
- bekreft cwd:
  `/Users/solglottsr/balise_logistikk_kopi/server`
- stopp kun bekreftet riktig PID/prosess
- verifiser at port `8787` ikke lytter
- ikke stopp ukjent prosess
- ikke start ny serverprosess før migration og direkte DB-postcheck er ferdig

Runneren skal kjøres med clean/eksplisitt miljø. Før runneren kjøres:

```bash
unset PORT
unset SDE_ENABLE_SCHEMA_MIGRATIONS
unset SDE_ENABLE_TEST_WRITES
unset SDE_ENABLE_ACTION_CONTRACT_TESTS

export SDE_ALLOW_PRODUCTION_SCHEMA_MIGRATION_ONCE=1
export SDE_SERVER_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3
export SDE_CONFIRM_PRODUCTION_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3
export SDE_PRODUCTION_SCHEMA_BACKUP_PATH=<fersk-validert-backupfil-utenfor-repo>
```

`SDE_PRODUCTION_SCHEMA_BACKUP_PATH` er det faktiske flaggnavnet i koden. Disse
flaggene skal ikke ligge igjen i normal runtime etter migration.

Runnerkommando for en senere eksplisitt execution-fase:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
npm run migrate:production:actions
```

Kommandoen skal bare kjøres etter egen godkjent execution-prompt. Den skal ikke
kjøres i B13J, ikke kjøres mens `8787` lytter, og ikke brukes til PWA, POST eller
action-write.

Direkte SQLite-postcheck skal gjøres etter migration og før normal restart:

```bash
sqlite3 -readonly /Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3 "PRAGMA user_version;"
sqlite3 -readonly /Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3 "SELECT name FROM sqlite_master WHERE type='table' AND name='actions';"
```

Forventet etter vellykket migration er `PRAGMA user_version: 1` og at
`actions`-tabellen finnes.

Etter migration skal production startes normalt, uten migrationflagg:

- `SDE_ALLOW_PRODUCTION_SCHEMA_MIGRATION_ONCE` ikke satt
- `SDE_PRODUCTION_SCHEMA_BACKUP_PATH` ikke satt
- `SDE_ENABLE_SCHEMA_MIGRATIONS` ikke satt
- `SDE_ENABLE_TEST_WRITES` ikke satt
- `SDE_ENABLE_ACTION_CONTRACT_TESTS` ikke satt
- `PORT=8787`
- `SDE_SERVER_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`

Normal runtime skal fortsatt vise `migrationsEnabled: false`.

GET-postcheck etter normal restart skal bekrefte:

- `/api/health` OK
- `/api/server/status` OK
- `schemaUserVersion: 1`
- `actionsTablePresent: true`
- `actionsSchemaReady: true`
- `migrationRequired: false`
- `migrationsEnabled: false`
- `testWritesEnabled: false`
- `pwaConnected: false`
- `operationalWritesEnabled: false`
- `/api/state/revision` viser fortsatt `revision: 1`
- `/api/events` viser fortsatt `events: []`
- Git er fortsatt rent

Rollback og forward-fix-policy:

- restore fra backup er ikke automatisk
- restore krever egen eksplisitt godkjenning
- rollback-beslutning skal være definert før migration
- hvis server har kjørt etter migration, skal forward-fix vurderes før restore
- backupfilen skal bevares til migration er verifisert og senere fase er lukket

Stoppkriterier:

- feil repo
- dirty Git
- uventet HEAD
- production health feiler
- revision er ikke `1` før migration
- events er ikke `[]`
- schemaUserVersion er ikke `0` før migration
- `actions`-tabell finnes allerede før migration
- backup feiler
- backup integrity er ikke `ok`
- production server lytter fortsatt på `8787`
- env-flagg avviker
- runner feiler
- direkte DB-postcheck feiler
- normal restart feiler
- `/api/server/status` viser uventede verdier
- revision eller events endres
- Git blir dirty

Etter B13J kan neste fase være separat B13K/B13R go/no-go eller
execution-prompt. Production migration krever egen eksplisitt godkjenning.

## B14C test-only actions-table action

B14C legger til kodegrunnlag for en senere test-only write som faktisk bruker
`actions`-tabellen som idempotency-kilde. B14C kjører ikke testen, starter ikke
testserver, gjør ingen POST og skriver ikke production DB.

Ny test-only route:

```text
POST /api/actions/actions-table-test
```

Ruten er bare tilgjengelig med eksplisitt testflagg:

```text
SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES=1
```

Ruten skal aldri brukes på production. Den blokkerer port `8787`, krever
eksplisitt `SDE_SERVER_DB_PATH`, og blokkerer production DB:

```text
/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3
```

B14C-testaction bruker:

- `actions.action_id` som idempotency-kilde
- canonical JSON av requesten
- SHA-256 `payload_hash`
- `409 action_id_conflict` ved samme `action_id` med annen request/hash
- `409 revision_conflict` ved stale `expectedRevision`
- én SQLite-transaksjon for action-record, state/revision update og eventlogg
- ufarlig testfelt i state: `serverTestActionsTable`
- eventtype: `actions_table.test`

Ny action gir `201 Created` og `mode: "created"`. Idempotent replay av samme
canonical request gir `200 OK` og `mode: "replayed"` uten ny revision, state eller
event.

B14C er fortsatt ikke PWA, ikke ekte SDE-action og ikke operational write. Neste
fase må være en separat B14D go/no-go/execution-prompt på separat testserver og
separat testdatabase i `/tmp`. Production skal bare sjekkes read-only før og
etter, og production revision/events skal forbli uendret.

## B15B2B actions-table write-test

B15B2B beviste `actions`-tabell-basert test-write i isolert testmiljø. Testen
brukte separat testserver på port `8788` og separat SQLite-fil:

```text
/tmp/sde-server-b15b2-actions-table-test.sqlite3
```

Production på port `8787` ble bare lest med GET. Production PID og `startedAt`
var uendret, revision var fortsatt `1`, og `/api/events` var fortsatt tom.

Testen krever en todelt modell:

1. Bootstrap actions-schema på testdatabasen med
   `SDE_ENABLE_SCHEMA_MIGRATIONS=1`.
2. Stopp bootstrap-serveren.
3. Start write-testserveren mot samme `/tmp`-database med
   `SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES=1`.

Disse flaggene skal ikke blandes i samme serverprosess. Bootstrap viste
`schemaUserVersion: 1`, `actionsTablePresent: true`,
`actionsSchemaReady: true`, `migrationRequired: false` og
`migrationsEnabled: true`. Write-testserveren viste
`actionsTableTestWritesEnabled: true` og `migrationsEnabled: false`.

Korrekt minimumspayload for test-ruten er:

```json
{
  "actionId": "b15b2-action-001",
  "actionType": "actions_table.test",
  "actor": {
    "id": "b15b-operator",
    "role": "test"
  },
  "deviceId": "b15b-test-device",
  "expectedRevision": 1,
  "payload": {
    "testNote": "B15B2 created test"
  }
}
```

`payload.testNote` er feltet som brukes av ruten. `payload.note` er ikke
kontrakten for `POST /api/actions/actions-table-test`.

B15B2B bekreftet response-matrisen:

- ny action gir HTTP `201`, `mode: "created"`, `previousRevision: 1`,
  `resultingRevision: 2`, `payloadHash` og eventtype `actions_table.test`
- replay av samme canonical request gir HTTP `200`, `mode: "replayed"` og
  uendret revision
- samme `actionId` med annen canonical request gir HTTP `409` og
  `error: "action_id_conflict"`
- ny `actionId` med stale `expectedRevision` gir HTTP `409` og
  `error: "revision_conflict"`

SQLite-verifisering på testdatabasen viste `integrity_check: ok`,
`user_version: 1`, en rad i `actions`, en rad i `events`, og action-raden:

```text
b15b2-action-001 | actions_table.test | 2 | completed
```

B15B2B beviser ikke production-write, ekte SDE-action, operational write,
PWA-read, PWA-write, auth/roller eller en permanent automatisert test. Ruten er
fortsatt test-only og skal ikke brukes på port `8787` eller mot production DB.

Røde soner videre: ingen POST mot `8787`, ingen production-write, ingen
production restart uten egen godkjenning, ingen PWA-kobling, ingen
`index.html`-endring, ingen ekte SDE-action og ingen operational write.

## B15D actions-table regression script

B15D legger til et test-only regressjonsscript for B15B2B-flyten:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
node scripts/test-actions-table-regression.js
```

Scriptet bruker en egen SQLite-fil under `/tmp`, starter en bootstrap-server med
`SDE_ENABLE_SCHEMA_MIGRATIONS=1`, stopper den, starter deretter en write-testserver
med `SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES=1`, og verifiserer created/replayed,
`action_id_conflict`, `revision_conflict`, SQLite integrity, `user_version`,
action count og event count.

Scriptet skal printe `PASS_B15D_ACTIONS_TABLE_REGRESSION` ved grønn test. Det er
ikke production-write, ikke PWA, ikke ekte SDE-action og ikke operational write.
Det skal ikke sende request til port `8787` eller bruke production DB.

## B16-B første ekte action-kontrakt

B16-B dokumenterer kontrakten for første ekte action uten å implementere kode.
Dette er README-only: ingen endpoint legges til, ingen POST kjøres, ingen
production-write åpnes, og PWA-en kobles ikke til serveren.

Valgt første action er en ikke-operativ server-note/annotation action. Den skal
bevise produksjonsklar action-kontrakt uten å påvirke SDE-motor, score,
sortering, kandidatgeneratorer, DROPS, Tursatt, SDE Vaktplan, localStorage eller
`operationalState`.

Foreslått endpoint for en senere fase:

```text
POST /api/actions/server-note
```

Kontrakten skal bruke:

- `actionType: "server_note.create"`
- `eventType: "server_note.created"`
- statefelt: `serverNotes`
- `actions`-tabellen som idempotency-kilde
- canonical JSON av validert request
- SHA-256 `payload_hash`
- `expectedRevision`
- atomisk action/event/state-transaksjon

Minimumspayload:

```json
{
  "actionId": "server-note-uuid",
  "actionType": "server_note.create",
  "actor": {
    "id": "operator-id",
    "role": "operator"
  },
  "deviceId": "device-id",
  "expectedRevision": 1,
  "payload": {
    "note": "Kort ikke-operativt servernotat",
    "category": "ops",
    "severity": "info"
  },
  "clientContext": {
    "source": "manual-server-test"
  }
}
```

Validering bør minst kreve `actionId`, `actionType`, `actor.id`,
`actor.role`, `deviceId`, `expectedRevision` og `payload.note`.
`payload.category`, `payload.severity` og `clientContext` kan være avgrensede
eller valgfrie felt. `payload.note` bør ha en tydelig maksgrense før eventuell
kode implementeres.

Idempotency-regler:

- ny `actionId` og korrekt `expectedRevision` gir ny action
- samme `actionId` og samme canonical request gir idempotent replay
- samme `actionId` med endret request/hash gir `409 action_id_conflict`
- idempotent replay skal returnere tidligere resultat uten ny revision, state
  eller event
- idempotency skal ikke avhenge av parsing av `events.payload_json`

`expectedRevision`-regler:

- ny action skal kreve match mot nåværende serverrevision
- stale revision skal gi `409 revision_conflict`
- idempotent replay av samme request skal ikke feile bare fordi current revision
  senere har økt
- samme `actionId` med endret `expectedRevision` er en annen request og skal gi
  `409 action_id_conflict`

Responsmodell:

- `201 Created` ved ny server-note action
- `200 OK` ved idempotent replay
- `400 invalid_payload`
- `403 disabled` eller `forbidden`
- `409 revision_conflict`
- `409 action_id_conflict`
- `500 server_error` bare ved reell serverfeil

Transaksjonsmodellen skal holde action-record, eventlogg og state/revision
atomisk sammen. En senere implementering bør bruke samme prinsipp som
B15D-testen: sjekk eksisterende `actions.action_id`, sjekk revision, skriv
state, skriv event, oppdater action-record med `resulting_revision` og
`event_id`, og commit alt samlet. Ingen halvveis action skal være akseptabel.

Sikkerhetsflagg for en senere implementering skal være smalt og ikke-operativt,
for eksempel:

```text
SDE_ENABLE_SERVER_NOTE_ACTIONS=1
```

`SDE_ENABLE_OPERATIONAL_WRITES=1` skal ikke brukes i denne fasen. Det flagget
reserveres til en senere operational-write fase.

Første test av en senere implementering skal skje på separat testserver og
separat testdatabase i `/tmp`, ikke på port `8787` og ikke mot production DB.
Testplanen skal minst dekke:

- production read-only precheck: `/api/server/status`, `/api/state/revision`,
  `/api/events`
- schema/status på testserver
- ny action gir `201` og revision `1 -> 2`
- replay av samme request gir `200` og uendret revision
- samme `actionId` med annen request gir `409 action_id_conflict`
- stale `expectedRevision` gir `409 revision_conflict`
- eventtype `server_note.created` finnes i testeventlogg
- `serverNotes` finnes i teststate
- production read-only postcheck viser fortsatt revision `1` og tom eventlogg

Røde soner for B16-B og første senere implementering: ingen PWA-read, ingen
PWA-write, ingen `index.html`, ingen POST mot `8787`, ingen production-write,
ingen production restart uten egen godkjenning, ingen ekte SDE-action, ingen
operational write, ingen `operationalState`, ingen packageendring og ingen bruk
av `SDE_ENABLE_OPERATIONAL_WRITES=1`.

## B16C-B server-note testimplementering

B16C-B legger til en server-only, ikke-operativ `server-note` action som bruker
`actions`-tabellen. Dette er fortsatt testserver/testdatabase-only: production
på port `8787` skal ikke motta POST, og PWA-en er fortsatt ikke koblet til
serveren.

Ny route:

```text
POST /api/actions/server-note
```

Ruten krever eksplisitt flagg:

```text
SDE_ENABLE_SERVER_NOTE_ACTIONS=1
```

B16C-B skal ikke bruke `SDE_ENABLE_OPERATIONAL_WRITES=1`. Ruten blokkerer port
`8787`, production DB, manglende eksplisitt `SDE_SERVER_DB_PATH` og DB-path som
ikke ligger under `/tmp` i test/dev-modus. Senere production-bruk krever et
ekstra smalt production-flagg og er ikke operational write.

Payload-kontrakten er:

```json
{
  "actionId": "b16c-server-note-001",
  "actionType": "server_note.create",
  "actor": {
    "id": "b16c-regression",
    "role": "test"
  },
  "deviceId": "b16c-test-device",
  "expectedRevision": 1,
  "payload": {
    "note": "B16C server note created test",
    "category": "ops",
    "severity": "info"
  },
  "clientContext": {
    "source": "test-server-note-action"
  }
}
```

`payload.category` er avgrenset til `ops`, `test` og `maintenance`.
`payload.severity` er avgrenset til `info` og `warning`. `payload.note` kan være
maks 500 tegn.

Ny action gir `201 Created`, eventtype `server_note.created`, en rad i
`actions`, en rad i `events`, og statefeltet `serverNotes` med bounded struktur:
`count` og `lastNote`. Replay av samme canonical request gir `200 OK` og
`mode: "replayed"` uten ny revision, state eller event. Samme `actionId` med
annen request gir `409 action_id_conflict`. Stale `expectedRevision` gir
`409 revision_conflict`.

Regresjonstest:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
node scripts/test-server-note-action.js
```

Scriptet bruker en egen SQLite-fil under `/tmp`, bootstrapper actions-schema med
`SDE_ENABLE_SCHEMA_MIGRATIONS=1`, stopper bootstrap-serveren, verifiserer at
ruten gir `403` uten `SDE_ENABLE_SERVER_NOTE_ACTIONS`, starter deretter
write-testserver med `SDE_ENABLE_SERVER_NOTE_ACTIONS=1`, og tester created,
replay, `action_id_conflict`, `revision_conflict`, `serverNotes`, SQLite
integrity, `user_version`, action count og event count.

B16C-B beviser ikke production-write, PWA-read, PWA-write, ekte SDE-action,
operational write eller auth/roller. Production skal bare sjekkes read-only før
og etter, og production revision/events skal forbli uendret.

## B19-B production server-note write-runbook

B19-B er kun dokumentasjon. Denne runbooken er ikke en godkjenning til å kjøre
production write. En eventuell execution må ha egen separat go/no-go etter at
dokumentasjonen er committet og pushet.

Formålet med en senere production server-note write er å teste første smale,
ikke-operative production write. `server-note` er ikke en SDE-skifteaction, ikke
operational write, skal ikke påvirke frontend/PWA og skal ikke brukes som
snarvei til PWA/serverkobling.

Absolutte forutsetninger før en senere execution:

- egen separat execution-go/no-go foreligger
- repo er rent og synkronisert med `origin/main`
- production kjører i detached `screen`-sesjon `sde-server-8787`
- production revision er kjent rett før write
- `events` er `[]` før første write dersom det fortsatt er baselinekravet
- `schemaUserVersion: 1`
- `actionsTablePresent: true`
- `actionsSchemaReady: true`
- `migrationRequired: false`
- `migrationsEnabled: false`
- `pwaConnected: false`
- `operationalWritesEnabled: false`
- `serverNoteActionsEnabled: false` før eventuell kontrollert aktivering
- ingen PWA/frontendendring gjøres i samme fase

Backupkrav før en eventuell write:

- ta fersk SQLite-backup utenfor repo før server-note write
- navngi backup med revision og timestamp, for eksempel
  `sde-server-rev-1-YYYYMMDD-HHMMSS.sqlite3`
- verifiser backup read-only med `PRAGMA integrity_check;`
- les `app_state` revision fra backup
- les `events` count fra backup
- les `actions` count fra backup
- ta hensyn til SQLite WAL/SHM ved å bruke `.backup`, ikke vanlig shell-kopi som
  hovedmetode
- ikke gjør restore som del av write uten egen rollback-go/no-go

Runtime- og screenkrav:

- production skal fortsatt kjøres i detached `screen`
- ikke bruk direkte background-start fra Codex-shell som varig runtime
- en eventuell write krever ikke restart dersom `serverNoteActionsEnabled`
  allerede er aktivert i en kontrollert executionfase
- dersom aktivering av `SDE_ENABLE_SERVER_NOTE_ACTIONS=1` krever restart, må det
  være en egen eksplisitt restartfase/go-no-go
- B19-B skal ikke stoppe, starte eller restarte production

Flagg og miljo:

- `SDE_ENABLE_SERVER_NOTE_ACTIONS=1` er det smale flagget for server-note
- production server-note krever i tillegg
  `SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS=1`
- `/api/server/status` skal vise både `serverNoteActionsEnabled` og
  `serverNoteProductionActionsEnabled`
- ikke bruk `SDE_ENABLE_OPERATIONAL_WRITES=1`
- ikke bruk `SDE_ENABLE_SCHEMA_MIGRATIONS=1`
- ikke aktiver testflagg i production
- ikke bland server-note write med migration, runner eller operational writes

GET-only precheck for en senere execution:

```bash
git status -sb
git log --oneline -8
screen -ls
lsof -nP -iTCP:8787 -sTCP:LISTEN
curl --max-time 5 -sS http://localhost:8787/api/health
curl --max-time 5 -sS http://localhost:8787/api/state/revision
curl --max-time 5 -sS http://localhost:8787/api/events
curl --max-time 5 -sS http://localhost:8787/api/server/status
```

`expectedRevision` skal hentes rett før write. Hvis revision har endret seg fra
precheck til write, stopp. Ved `409 revision_conflict` skal man ikke retrye
blindt; det krever ny go/no-go eller ny vurdering.

Payloadkrav:

- `actionId` må være unik og stabil idempotency key
- `actionType` skal være `server_note.create`
- `actor.id` kreves
- `actor.role` kreves
- `deviceId` kreves
- `expectedRevision` kreves
- `payload.note` kreves og kan være maks 500 tegn
- `payload.category` kan være `ops`, `test` eller `maintenance`
- `payload.severity` kan være `info` eller `warning`
- `clientContext` er valgfritt, men må være gyldig type etter kodekontrakten

FREMTIDIG EKSEMPEL - IKKE KJOR I B19-B:

```bash
curl -i -sS -X POST http://localhost:8787/api/actions/server-note \
  -H 'Content-Type: application/json' \
  -d '{
    "actionId": "server-note-YYYYMMDD-HHMMSS-operator",
    "actionType": "server_note.create",
    "actor": {
      "id": "operator-id",
      "role": "operator"
    },
    "deviceId": "mac-mini-production",
    "expectedRevision": 1,
    "payload": {
      "note": "Kort ikke-operativt production server-notat",
      "category": "ops",
      "severity": "info"
    },
    "clientContext": {
      "source": "manual-production-runbook"
    }
  }'
```

Forventede responser ved en senere write:

- `201 Created` ved ny action
- `200 OK` og `mode: "replayed"` ved identisk replay
- `409 action_id_conflict` ved samme `actionId` med endret canonical request
- `409 revision_conflict` ved stale `expectedRevision`
- `400 invalid_payload` ved ugyldig payload
- `403` ved disabled flagg eller guard

Postcheck etter en eventuell future execution:

- `GET /api/state/revision`
- `GET /api/events`
- `GET /api/server/status`
- verifiser at revision oker nøyaktig som forventet
- verifiser eventtype `server_note.created`
- verifiser `serverNotes` i state
- verifiser `pwaConnected: false`
- verifiser `operationalWritesEnabled: false`
- verifiser at ingen frontend/PWA-endring er gjort

Rollback/forward-fix-prinsipp:

- etter en committed production write skal rollback ikke improviseres
- restore fra backup er egen separat rollback-go/no-go
- ved gyldig, men uonsket testnote kan foretrukket vei være forward-fix eller
  ny korrigerende action dersom kontrakten tillater det senere
- hvis DB-integritet feiler eller uventet write skjer: stopp og ikke gjør flere
  writes

Stoppkriterier:

- repo er ikke rent
- remote har nye commits uten vurdering
- production svarer ikke
- revision er ikke forventet
- events er ikke forventet
- schema er ikke klart
- `migrationsEnabled: true`
- `pwaConnected: true`
- `operationalWritesEnabled: true`
- feil port eller DB
- backup er ikke tatt og verifisert
- `expectedRevision` matcher ikke
- POST gir annet enn forventet respons
- production events/revision endres uventet

Rode soner: dette åpner fortsatt ikke for PWA/serverkobling, ekte SDE-action,
operational write, frontendendring, migration, runner, packageendring,
launchd/service-oppsett eller generelle writes.


## B26-B SDE recommendation acknowledgement test action

B26-B legger til en server-only, test-only operational-action-design for
`POST /api/actions/sde-recommendation-ack`. Dette er ikke Utført/Annullert,
ikke en SDE-skifteaction, ikke PWA-kobling og ikke serverstate som operativ
sannhetskilde. Actionen skal bare bevise at en smal SDE-anbefaling kan
acknowledges via `actions`-tabellen på testserver og `/tmp`-database.

Kontrakt:

- endpoint: `POST /api/actions/sde-recommendation-ack`
- actionType: `sde_recommendation_ack.create`
- eventType: `sde_recommendation_ack.created`
- statefelt: `sdeRecommendationAcks`
- statusfelt: `sdeRecommendationAckActionsEnabled`
- production-statusfelt: `sdeRecommendationAckProductionActionsEnabled`

Tillatte `ackStatus`-verdier er bare ikke-utførende ord:

- `seen`
- `assessed`
- `not_relevant`
- `needs_manual_review`

Ord som `executed`, `annulled`, `followed`, `completed`, `cancelled`, `utført`
og `annullert` skal avvises. Actionen skal ikke påvirke SDE-motor, score,
sortering, kandidatgeneratorer, DROPS, Tursatt, Vaktplan, localStorage eller
operativ dataflyt.

Payload minimum:

```json
{
  "actionId": "b26b-sde-ack-001",
  "actionType": "sde_recommendation_ack.create",
  "actor": {
    "id": "operator-or-test-id",
    "role": "test"
  },
  "deviceId": "test-device",
  "expectedRevision": 1,
  "payload": {
    "serviceDate": "2026-06-24",
    "recommendationKey": "sde-card-or-need-key",
    "ackStatus": "assessed",
    "note": "Valgfri kort tekst"
  },
  "clientContext": {
    "source": "test"
  }
}
```

Idempotency og transaksjon følger samme production-klare prinsipp som
server-note:

- `actions.action_id` er idempotency-kilde
- canonical request gir SHA-256 `payload_hash`
- identisk replay gir `200` og `mode: "replayed"`
- samme `actionId` med annen request gir `409 action_id_conflict`
- stale `expectedRevision` gir `409 revision_conflict`
- ny action gir `201` og `mode: "created"`
- action-record, state, event og action-completion skjer atomisk i samme SQLite-
  transaksjon

Guards:

- testmodus krever `SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS=1`
- testmodus krever eksplisitt `/tmp`-database og ikke-production port
- production DB og port `8787` er blokkert i testmodus
- senere production-modus krever i tillegg
  `SDE_ENABLE_PRODUCTION_SDE_RECOMMENDATION_ACK_ACTIONS=1`
- `SDE_ENABLE_OPERATIONAL_WRITES=1` skal fortsatt blokkeres i denne første ack-
  fasen
- actionen skal ikke kombineres med migration/test/server-note-flagg

Regresjonstest:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
node scripts/test-sde-recommendation-ack-action.js
```

Scriptet bootstrapper actions-schema på en `/tmp`-database, tester disabled
`403`, `201 created`, `200 replayed`, `409 action_id_conflict`,
`409 revision_conflict`, valideringsfeil, bounded `recent`, statusfelt og SQLite
integrity. Production `8787` sjekkes bare med GET før/etter, og production
revision/events/serverNotes skal forbli uendret.

Rode soner etter B26-B: ingen POST mot production `8787`, ingen production-write,
ingen PWA/serverkobling, ingen operational write, ingen `operationalState`, ingen
migration/runner, ingen packageendring og ingen SDE-motor/score/dataflytendring.

## B37-A minimal operational state write-kontrakt

B37-A er design-only. Det legges ikke til endpoint, serverkode, frontend-write,
DB-write, operational write eller production write i denne fasen. Formålet er å
dokumentere neste kontrollerte steg mot synkronisering av avgrenset lokal
operativ frontend-state mellom enheter.

Kontrakten er readback/auditbar state-sync først. Den er ikke en skifteordre, og
serverstate skal ikke bli operativ sannhetskilde for SDE-motoren ennå. Dagens
SDE-motor, score, sortering, kandidatmotor, DROPS og Tursatt-logikk skal fortsette
å kjøre fra lokal/static frontend-data inntil en egen senere fase eksplisitt
godkjenner noe annet.

Ikke-mål:

- ikke koble `Utført` eller `Annullert` til server som endelig operasjon
- ikke la SDE-motoren lese operativ sannhet fra serverstate
- ikke automatic write eller background sync
- ikke CORS-write
- ikke production write uten egen go/no-go
- ikke operational truth/source-of-authority ennå
- ikke silent retry etter konflikt

Første minimale state-scope:

- TXP Input Sporplan / `grunnoppstilling`
- SDE Nattplassering manuelle overrides
- SDE generated/overridden move actions som lokal intensjon/readback
- completed/locked lokale SDE-plasseringer som frontend-state, ikke skifteordre
- reset/clear events for samme avgrensede state

Foreslåtte endepunktnavn for en senere kodefase, ikke implementert i B37-A:

- `GET /api/operational-state`
- `POST /api/operational-state/snapshot`
- eventuelt `GET /api/operational-state/events`

Payload-prinsipper for fremtidig snapshot-write:

```json
{
  "serviceDate": "2026-06-29",
  "actor": {
    "id": "operator-or-test-id",
    "role": "operator"
  },
  "device": {
    "id": "mac-mini-or-ipad",
    "label": "Kort enhetsnavn"
  },
  "clientRevision": "frontend-or-build-revision",
  "expectedServerRevision": 1,
  "idempotencyKey": "operational-state-YYYYMMDD-HHMMSS-device",
  "stateScope": [
    "txp-input-sporplan",
    "sde-night-placement-manual-overrides"
  ],
  "stateSnapshot": {},
  "clientContext": {
    "source": "manual-pilot",
    "note": "State-sync/readback, ikke skifteordre"
  },
  "createdAt": "2026-06-29T12:00:00.000Z"
}
```

Concurrency og idempotency:

- alle writes skal bruke optimistic concurrency med server revision
- stale `expectedServerRevision` skal gi `409 Conflict`
- alle writes skal ha idempotency key
- identisk replay kan returnere tidligere resultat uten ny revision
- samme idempotency key med annet payload skal gi konflikt
- klienten skal ikke retrye silently etter `409`; ny readback og ny vurdering
  kreves

Feature flags:

- `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
- `SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1`
- begge skal kreves for production/port `8787`
- default er alltid av

Production guards:

- production write er av som default
- same-origin-only for write
- ingen CORS write
- ingen DB-mutasjon hvis flagg mangler
- ingen production write hvis bare testflagg er satt
- backup skal tas og verifiseres før eventuell production pilot
- production pilot krever egen go/no-go og separat runbook

Audit og readback:

- hver vellykket write skal gi audit event
- readback i UI skal merkes som state-sync/readback
- UI-tekst må si tydelig at dette ikke er skifteordre
- readback skal vise actor, device, serviceDate, stateScope, server revision og
  createdAt der det er relevant
- serverstatus/PWA-serverstate skal fortsatt ikke være operativ sannhetskilde
  uten egen senere godkjenning

Rollback-prinsipp:

- disable writeflagg
- restore verifisert DB-backup ved behov og bare etter egen rollback-go/no-go
- revert endpoint/frontend-commit hvis kodefase introduserer feil
- klient skal falle tilbake til lokal frontend-state
- stopp videre writes hvis revision, events eller audit ikke matcher forventet

Testplan for senere kodefase:

- `403` uten nødvendige flagg
- testserver write med testflagg og `/tmp`-database
- production guard på port `8787`
- idempotency replay og idempotency conflict
- revision conflict
- readback og audit event
- ingen POST fra GitHub/static
- ingen `Utført`/`Annullert`-kobling
- ingen CORS-write
- ingen SDE-motorlesing fra serverstate

Faseinndeling etter B37-A:

- B37-B: test-only server endpoint skeleton, ingen frontend
- B37-C: readback i serverhostet app, ingen writeknapp
- B37-D: controlled pilot senere, med backup og egen go/no-go

Rode soner etter B37-A: ingen `index.html`, ingen `server/src`, ingen `data/`,
ingen packageendring, ingen migration, ingen restart, ingen POST, ingen DB-write,
ingen operational write, ingen production write, ingen Cloudflare-endring, ingen
SDE-motor/score/sortering/kandidatmotor/DROPS/Tursatt-endring.

## B37-B test-only operational-state endpoint skeleton

B37-B implementerer kun en test-only server-skeleton for operational-state
readback. Det er fortsatt ingen frontend-kobling, ingen PWA-write, ingen
SDE-motorlesing fra serverstate, ingen operational truth/source-of-authority og
ingen production write åpnet.

Endepunkter:

- `GET /api/operational-state`
- `GET /api/operational-state/events`
- `POST /api/operational-state/snapshot`

`GET`-endepunktene er read-only og skal tydelig rapportere at dette er
state-sync/readback, ikke skifteordre, ikke SDE-motor-kilde og ikke operativ
sannhetskilde. `POST /api/operational-state/snapshot` er deaktivert som default
og returnerer `403` uten eksplisitt flagg.

Write-guard:

- `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1` kreves alltid for snapshot-write
- production-port `8787` krever i tillegg
  `SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1`
- test/dev-write uten production-flagg krever eksplisitt `SDE_SERVER_DB_PATH`
  under `/tmp`
- test/dev-write avviser production-database
- ingen CORS-write er lagt til

Snapshot-payload validerer minimum `serviceDate`, `idempotencyKey`, `actor`,
`device`, `stateScope` og `stateSnapshot`. `expectedServerRevision` er valgfri
i test-skeleton, men hvis den sendes og ikke matcher serverrevision, returneres
`409 Conflict`. Samme `idempotencyKey` med identisk payload er idempotent
replay; samme key med annet payload returnerer `409`.

State lagres kun som `operationalStateReadback` i `app_state` på testserveren og
som audit-event `operational_state.snapshot.test`. Feltet er eksplisitt
readback/test-data og skal ikke brukes av SDE-motor, score, sortering,
kandidatmotor, DROPS, Tursatt eller Vaktplan.

Test:

```bash
cd /Users/solglottsr/balise_logistikk_kopi
node server/scripts/test-operational-state.js
```

Testskriptet bruker midlertidig `/tmp`-database og ikke-production-port. Det
sjekker startup guards, disabled `403`, invalid `400`, created `201`, replay
`200`, idempotency conflict `409`, readback, events og production `8787` med
GET-only før/etter. Testen skal aldri POSTe mot production `8787`.

Rode soner etter B37-B: ingen `index.html`, ingen `data/`, ingen
packageendring, ingen migration, ingen serverrestart, ingen POST mot production
`8787`, ingen production DB-write, ingen operational write, ingen Cloudflare,
ingen SDE-motor/score/sortering/kandidatmotor/DROPS/Tursatt/Vaktplan-endring.

## B37-F production pilot-readiness / runbook

B37-F er documentation-only. Denne seksjonen åpner ingen flagg, kjører ingen
pilot, sender ingen POST, restarter ikke production og skriver ikke til DB.

Formål:

- første senere production pilot skal kun skrive én avgrenset
  operational-state snapshot
- snapshotet er state-sync/readback, ikke skifteordre
- snapshotet er ikke `Utført` eller `Annullert`
- serverstate skal ikke bli SDE-motor-kilde
- serverstate skal ikke bli operativ sannhetskilde
- ingen frontend-write eller automatisk sync skal kobles inn i denne piloten

Preconditions før en senere pilot:

- repo er rent, på forventet HEAD, og `origin/main` er synket
- production health er OK på port `8787`
- `GET /api/operational-state` svarer OK
- `GET /api/operational-state/events` er tom eller matcher eksplisitt forventet
  pilot-baseline
- `operationalStateWritesEnabled:false` før enable
- `operationalStateProductionWritesEnabled:false` før enable
- `operationalStateWritesAllowed:false` før enable
- `operationalStateOperationalWritesAllowed:false` før enable
- `operationalWritesEnabled:false`
- `migrationsEnabled:false`
- ingen uventet POST i browser/network
- Cloudflare tunnel og Access er grønn uten policyendring
- verifisert SQLite backup er tatt utenfor repo

Backup før pilot:

- finn production DB-path fra `/api/server/status`, process cwd/config og
  dokumentert serveroppsett
- ta SQLite `.backup` til mappe utenfor repo, for eksempel
  `/Users/solglottsr/sde-server-backups/`
- bruk timestamp og revision i filnavnet
- verifiser at backupfil finnes og er større enn 0 bytes
- kjør `PRAGMA integrity_check;` mot backupfilen
- verifiser `app_state` revision i backupfilen
- ikke fortsett hvis backup, integrity check eller revision-kontroll feiler

Eksempelkommandoer for en senere pilot, ikke kjør som del av B37-F:

```bash
backup_dir="/Users/solglottsr/sde-server-backups"
stamp="$(date +%Y%m%d-%H%M%S)"
db="/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3"
backup="$backup_dir/sde-server-rev-5-$stamp.sqlite3"
mkdir -p "$backup_dir"
sqlite3 "$db" ".backup '$backup'"
test -s "$backup"
sqlite3 "$backup" "PRAGMA integrity_check;"
sqlite3 "$backup" "SELECT revision, updated_at FROM app_state WHERE id = 'main';"
```

Flagging for senere pilot:

- production pilot krever begge flagg:
  `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
- production pilot krever også:
  `SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1`
- begge flagg skal være av som default
- testflagget alene skal aldri åpne production-write på port `8787`
- production-flagget skal aldri brukes uten testflagget og egen go/no-go
- `SDE_ENABLE_OPERATIONAL_WRITES` skal fortsatt ikke brukes for denne piloten

Restart/enable-sekvens for senere pilot:

- precheck repo, health, DB-path, backup og Cloudflare før stopp
- stopp production kontrollert
- start production i dokumentert runtime-metode med begge operational-state
  flaggene eksplisitt satt
- ikke sett migration-, server-note-, SDE-ack- eller andre writeflagg
- verifiser `/api/server/status` viser operational-state writes tillatt
- verifiser fortsatt `operationalWritesEnabled:false`
- verifiser ingen frontend-write er koblet
- kjør kun én manuell, kontrollert testpayload fra terminal eller godkjent
  testverktøy

Minimal pilotpayload:

```json
{
  "serviceDate": "2026-06-29",
  "idempotencyKey": "b37-production-pilot-YYYYMMDD-HHMMSS",
  "actor": {
    "id": "production-pilot-operator",
    "role": "test"
  },
  "device": {
    "id": "mac-mini-production-pilot",
    "label": "Mac mini production pilot"
  },
  "stateScope": [
    "operational-state-production-pilot-readback-only"
  ],
  "stateSnapshot": {
    "note": "Production pilot snapshot. State-sync/readback only, not a switching order.",
    "manualOverrides": {}
  },
  "clientRevision": "production-pilot-manual",
  "clientContext": {
    "phase": "B37-G-or-later",
    "purpose": "controlled-production-operational-state-pilot",
    "notSwitchingOrder": true
  }
}
```

Payload-regler:

- `stateScope` skal være array
- `idempotencyKey` skal være unik for første POST
- payload skal tydelig si test/pilot/readback-only
- payload skal ikke beskrive en operativ ordre
- payload skal ikke representere `Utført`, `Annullert` eller skifteordre
- payload skal ikke brukes av SDE-motor, score, sortering, DROPS, Tursatt eller
  Vaktplan

Pilot-testsekvens for en senere fase:

- kjør GET `/api/operational-state` før POST
- kjør GET `/api/operational-state/events` før POST
- send nøyaktig én POST med unik `idempotencyKey`
- forvent `201 Created`
- kjør GET `/api/operational-state` etter POST og verifiser readback
- kjør GET `/api/operational-state/events` etter POST og verifiser én
  `operational_state.snapshot.test`
- replay samme payload og forvent idempotent `200`
- ikke test conflict i production med samme key og endret payload uten egen
  eksplisitt GO
- ikke koble frontend
- ikke bruk browserknapp eller automatisk sync

Stoppkriterier:

- backup mangler, er tom, eller integrity check feiler
- DB-path er feil eller uklar
- health feiler før eller etter enable
- writeflagg er uventet av eller på
- migration blir aktiv
- `operationalWritesEnabled` blir `true`
- POST gir `500` eller uventet status
- revision øker mer enn forventet
- readback mangler etter `201`
- event mangler etter `201`
- browser/network viser uventet POST
- Cloudflare eller Access endres
- frontend prøver å bruke serverstate operativt
- SDE-motor, score, sortering, DROPS, Tursatt eller Vaktplan leser serverstate
  som sannhet

Rollback:

- slå av begge operational-state flagg
- restart production tilbake til read-only
- verifiser `operationalStateWritesEnabled:false`
- verifiser `operationalStateProductionWritesEnabled:false`
- verifiser `operationalStateWritesAllowed:false`
- verifiser `operationalStateOperationalWritesAllowed:false`
- verifiser `operationalWritesEnabled:false`
- hvis nødvendig, stopp server og restore verifisert SQLite backup etter egen
  rollback-go/no-go
- revert eventuell pilot-kodecommit hvis en senere kodefase introduserer feil
- public app skal falle tilbake til lokal/read-only state

Etterpilot-status:

- dokumenter timestamp, HEAD, revision før/etter, event-id og payload hash eller
  idempotencyKey
- dokumenter at det ikke ble bred brukeråpning
- dokumenter at ingen iPad/iPhone-write ble åpnet
- dokumenter at `Utført` og `Annullert` fortsatt ikke er koblet
- dokumenter at SDE-motoren fortsatt ikke bruker serverstate som operativ
  sannhetskilde

Neste fase etter B37-F:

- B37-G kan være dry-run pilot command review
- B37-G kan alternativt være controlled production pilot
- begge alternativer krever egen eksplisitt GO
- B37-F i seg selv åpner ingenting

## B37-I production pilot closure

B37-H2 er gjennomført og grønn. Det ble skrevet én kontrollert production
operational-state snapshot via terminal/runbook, og dette var en avgrenset
pilot-write til readback/test-sync. Dette var ikke en skifteordre, ikke
`Utført`/`Annullert`, ikke SDE-motor-kilde og ikke en åpning av løpende
operational write.

Resultat:

- én kontrollert production operational-state snapshot ble skrevet
- `POST /api/operational-state/snapshot` returnerte `201 Created`
- revision gikk fra `5` til `6`
- event id `5` ble opprettet
- event type var `operational_state.snapshot.test`

Backup:

- backup path:
  `/Users/solglottsr/sde_db_backups/20260629_201832_b37h2/sde-server.sqlite3`
- integrity check: `ok`
- backup ble tatt før flagged restart og før POST

Payload/idempotency:

- idempotency key: `b37h2-production-pilot-20260629201852`
- payload var pilot/readback-only
- payload var ikke skifteordre
- payload var ikke `Utført` eller `Annullert`
- payload var ikke SDE-motor-kilde

Readback etter pilot:

- readback count: `1`
- revision: `6`
- event viste:
  - `readbackOnly:true`
  - `serverStateAuthority:false`
  - `operationalAuthority:false`
  - `notSwitchingOrder:true`

Final read-only status:

- server ble restartet tilbake uten operational-state flags
- final PID: `29596`
- final health: OK
- final revision: `6`
- alle operational-state/write/production/migration flags var av
- operational write er ikke løpende åpnet

Browser/frontend:

- public app åpnet
- serverstatus viste `rev 6`, `writes av`, `operational av` og `readback ok`
- ingen browser POST ble observert
- ingen writeknapp ble koblet til operational-state snapshot
- frontend er fortsatt read-only for operational-state

Ikke gjort:

- ingen Cloudflare-endring
- ingen kodeendring
- ingen git-endring under piloten
- ingen data-refresh
- ingen migration
- ingen frontend-write
- ingen `Utført`/`Annullert`-kobling
- serverstate er ikke operativ sannhetskilde

Neste fase:

- B37-J eller senere må ha egen eksplisitt GO
- mulige neste steg er frontend readback-polering, test av second pilot/replay
  plan, eller design for første ekte frontend-write
- ingen automatisk åpning av operational write

## B38-A first frontend sync scope

B38-A låser første minimale frontend-state-scope for en senere syncfase. Dette
er documentation-only og åpner ingen write, ingen frontend-submit og ingen
serverstate som operativ sannhetskilde.

Valgt første scope:

```json
["sde-night-placement-manual-overrides"]
```

Hvorfor dette scope er smalest:

- SDE Nattplassering har én avgrenset persistent frontend-state:
  `state.sdeNightPlacementManualOverrides`
- feltet er allerede lokalt avgrenset til simulerte manuelle nattplasseringer
- drag/drop-resultatet er arbeidsstate/readback, ikke skifteordre
- scope berører ikke `Utført`, `Annullert`, SDE-score, sortering,
  kandidatmotor, DROPS, Tursatt eller Vaktplan
- serverstate skal fortsatt ikke bli operativ sannhetskilde

Frontend-state som kan synkes senere:

- nøkkel: `state.sdeNightPlacementManualOverrides`
- struktur: object/map fra stabil override-key til override-objekt
- key bygges normalt fra kjøretøy + originalt fra-spor, for eksempel
  `night-placement-step|BM75-42|12`
- eksempelverdi:

```json
{
  "night-placement-step|BM75-42|12": {
    "id": "night-drag-1782757173000",
    "vehicle": "BM75-42",
    "originalFromSlot": "12",
    "fromSlot": "12",
    "currentFromSlot": "12",
    "toSlot": "15",
    "createdAt": "2026-06-29T18:19:33.142Z",
    "updatedAt": "2026-06-29T18:19:33.142Z",
    "source": "night-placement-drag",
    "stableActionKey": "night-placement-drag|bm75-42|12|15|night-drag-1782757173000",
    "needKey": "night-placement-drag-need|night-placement-drag|bm75-42|12|15|night-drag-1782757173000",
    "moveKey": "night-placement-drag|bm75-42|12|15|night-drag-1782757173000",
    "hasMatchedSdeMove": false,
    "isManualOnly": true,
    "payloadFromSlot": "12",
    "payloadSlot": "12",
    "earliestMoveTime": "",
    "latestMoveTime": "",
    "sourceEvent": "",
    "nextRequiredUse": "",
    "targetSlotOccupant": "",
    "timeStatus": "UNKNOWN_TIME_MANUAL_REVIEW",
    "conflicts": [],
    "affectedVehicles": [],
    "note": "simulert ønsket sluttplassering"
  }
}
```

Transient UI-state som ikke skal synkes:

- `sdeNightPlacementDragPayload`
- `sdeNightPlacementSelectedSlot`
- `sdeNightPlacementDropMessage`
- hover/drag CSS-state som `drag-over`, `dragging` og `drop-rejected`
- koordinatdrag internstate
- åpne/lukkede infopaneler og annen visuell paneltilstand

Første senere sync skal inkludere:

- `serviceDate`
- `stateScope:["sde-night-placement-manual-overrides"]`
- `stateSnapshot.sdeNightPlacementManualOverrides`
- unik `idempotencyKey`
- actor/device
- client context som sier readback-only og ikke operativ ordre
- `clientRevision` som string hvis feltet skal bevares av nåværende endpoint

Første senere sync skal ikke inkludere:

- `Utført` eller `Annullert`
- completed operational action
- SDE-score
- sortering eller kandidatmotor
- TXP full state
- DROPS, Tursatt eller Vaktplan
- serverstate som sannhetskilde
- drag payload, selected slot eller transient hover/drag state

Eksempel på senere payload, ikke POST i B38-A:

```json
{
  "serviceDate": "YYYY-MM-DD",
  "idempotencyKey": "sde-night-placement-manual-overrides-YYYYMMDD-HHMMSS-device",
  "actor": {
    "id": "operator-id",
    "role": "txp"
  },
  "device": {
    "id": "device-id",
    "label": "serverhosted app"
  },
  "stateScope": [
    "sde-night-placement-manual-overrides"
  ],
  "stateSnapshot": {
    "sdeNightPlacementManualOverrides": {}
  },
  "clientRevision": "sde-night-placement-local-1",
  "clientContext": {
    "phase": "B38-later-frontend-sync",
    "notOperationalOrder": true,
    "notCompletedCancelled": true,
    "notSdeMotorSource": true
  }
}
```

Senere UI-tekst må være tydelig på:

- "Synkroniserer arbeidsstate/readback"
- "Ikke skifteordre"
- "Ikke Utført/Annullert"
- "Serverstate er ikke operativ sannhetskilde"

Minste trygge neste kodefase:

- B38-B bør være frontend read-only payload builder for dette scope, uten POST
- payload-builderen kan lese `state.sdeNightPlacementManualOverrides` og vise
  preview/readback-diff
- ingen production submit, ingen writeknapp og ingen automatisk sync i B38-B

Stoppkriterier for senere faser:

- hvis scope utvides til "alt"
- hvis `Utført`/`Annullert` foreslås
- hvis frontend kobles til POST uten egen eksplisitt GO
- hvis serverstate brukes som SDE-motor-kilde eller operativ sannhetskilde
- hvis DROPS, Tursatt, Vaktplan, score, sortering eller kandidatmotor blandes inn

## B38-E frontend-write pilot-runbook

B38-E dokumenterer runbook og GO/NO-GO for en senere kontrollert
frontend-write pilot for nattplassering-sync. Dette er documentation-only.
Etter B38-E er frontend-write fortsatt ikke implementert.

Formål:

- forberede en senere kontrollert frontend-write pilot
- scope er kun `["sde-night-placement-manual-overrides"]`
- piloten gjelder bare readback/simulert arbeidsstate for SDE Nattplassering
- payload er ikke skifteordre
- payload er ikke `Utført` eller `Annullert`
- payload er ikke SDE-motor, score eller sortering
- serverstate skal ikke bli operativ sannhetskilde

Ikke-mål:

- ikke generell frontend sync
- ikke TXP full state
- ikke DROPS
- ikke Tursatt
- ikke Vaktplan
- ikke `Utført` eller `Annullert`
- ikke automatisk sync
- ikke retry eller kø
- ikke localStorage serverkø
- ikke CORS-write
- ikke GitHub Pages/static write
- ikke operational authority

GO-vilkår før en senere pilot:

- egen eksplisitt bruker-GO for akkurat piloten
- fersk git clean/sync
- production health OK
- revision kjent og notert
- operational-state events før pilot dokumentert
- fersk SQLite backup utenfor repo
- backup integrity OK
- flags åpnes bare i et kontrollert runtimevindu
- nøyaktig en frontend-initiert POST
- Network-panel verifiseres under piloten
- events etter pilot verifiseres
- server restartes tilbake read-only etter piloten
- public app refresh viser `write_not_available` igjen etter piloten
- ingen automatisk retry

NO-GO:

- remote ahead/behind
- uren arbeidskopi
- health-feil
- uventede events
- writeflagg allerede på før pilotvindu
- payload scope mismatch
- payload inkluderer drag payload, selected slot eller transient state
- payload gjelder `Utført` eller `Annullert`
- payload gjør serverstate til sannhetskilde
- ingen backup
- backup integrity feiler
- uklar `idempotencyKey`
- mer enn én POST er nødvendig
- Network viser flere POST
- console errors
- Cloudflare/tunnel ustabil
- bruker er usikker/trøtt og vil ikke eksplisitt godkjenne pilot

Mulig pilotmodell senere:

- B38-F kan eventuelt være test-only frontend submit bak hard dev/pilot-gate,
  men ikke production
- B38-G kan eventuelt være dry-run/review av payload og pilotprosedyre
- B38-H kan eventuelt være en kontrollert frontend production pilot med
  backup og flags, dersom eksplisitt GO
- etter B38-H skal runtime tilbake read-only

Idempotency:

- hver pilot skal ha unik `idempotencyKey`
- gjenbruk av nøkkel skal bare gi idempotent replay hvis payload er identisk
- idempotency conflict skal stoppe piloten

Rollback:

- frontend rollback: revert commit som legger til writeknapp/submit hvis den
  senere blir laget
- runtime rollback: restart uten flags
- DB rollback: restore backup kun ved dokumentert behov og etter eksplisitt GO
- normal safe rollback etter vellykket pilot er å slå av flags og restarte
  read-only, ikke å slette pilot-event

UI-krav hvis writeknapp noen gang lages:

- knappen må bare vises når readiness er eksplisitt pilot-enabled
- knappen må aldri vises på GitHub Pages/static holding page
- knappen må bare brukes på same-origin serverhosted `/app`
- teksten må inneholde:
  - "Pilot"
  - "Én manuell sending"
  - "Ikke skifteordre"
  - "Ikke Utført/Annullert"
  - "Serverstate er ikke operativ sannhetskilde"
- drag/drop må aldri auto-sende
- reload må aldri auto-sende
- bakgrunnsjobb må aldri sende

Stoppunkt:

- etter B38-E er frontend-write fortsatt ikke implementert
- operational write er fortsatt ikke løpende åpnet
- production skal fortsatt være read-only

## B38-G test-only frontend-submit result

B38-G verifiserte at B38-F sin test-only submit-gate kan sende én
frontend-initiert operational-state snapshot til en lokal testserver med temp
SQLite DB. Dette var ikke production, ikke production DB, ikke Cloudflare og
ikke en kodeendring.

Formål:

- verifisere én frontend-initiert snapshot-submit fra test-gaten
- bruke bare testserver og temp DB
- holde production 8787 urørt
- ikke endre kode, committe eller pushe i selve B38-G

Testmiljø:

- test root: `/tmp/sde-b38g-frontend-submit-4bkcvg`
- test DB: `/tmp/sde-b38g-frontend-submit-4bkcvg/sde-test.sqlite3`
- testserver PID: `39245`
- browser origin:
  `http://localhost:8791/app?sdeOperationalStateTestSubmit=1&b38g=1782762580326`

Testserver før POST:

- `operationalStateWritesAllowed:true`
- `operationalStateProductionWritesEnabled:false`
- `operationalStateOperationalWritesAllowed:false`
- events: `[]`

Frontend-test:

- manuell nattplassering: `74-49` fra `10N` til `12N`
- scope: `["sde-night-placement-manual-overrides"]`
- submitknapper: nøyaktig `1`
- klikk: nøyaktig én gang
- UI-resultat: `test_submit_result HTTP 201: ok`
- console errors: nei

Etter POST:

- testserver event id: `1`
- testserver event type: `operational_state.snapshot.test`
- testserver readback scope: `["sde-night-placement-manual-overrides"]`
- temp DB: `PRAGMA integrity_check = ok`
- DB eventrad:
  `1|operational_state.snapshot.test|2026-06-29T19:51:53.113Z`

Production etter test:

- revision fortsatt `6`
- events fortsatt kun B37-H2 pilot-event id `5`
- alle write/operational/production/migration-flagg fortsatt av
- ingen production POST
- ingen production restart
- ingen production DB-write

Opprydding:

- testserver stoppet
- port `8791` ikke lenger lyttende
- git final: `## main...origin/main`
- ingen commit/push i selve B38-G
- ingen Cloudflare-endring

Konklusjon:

- B38-G er grønn
- test-only frontend submit virker mot temp DB
- production er urørt
- neste fase må være separat dry-run/GO for production pilot, ikke direkte
  ukontrollert write

## B38-H0 production-pilot dry-run result

B38-H0 var en production-pilot dry-run / GO-review for
nattplassering-sync. Den gjennomførte ingen production-pilot og ingen write.

Konklusjon:

- `B38-H0 GREEN — production pilot may be prepared, but not executed`
- ingen production-pilot ble kjørt
- ingen POST, restart, DB-write, flags eller Cloudflare-endring

Repo/runtime-status:

- repo var clean/synced: `## main...origin/main`
- HEAD var `b2de49e B38-G: Dokumenter test-only frontend-submit`
- production health OK før og etter dry-run
- production revision fortsatt `6`
- port `8787` stabil og lyttende
- testserver `8791` ikke lyttende
- alle write/operational/production/migration-flagg av
- events før og etter fortsatt kun B37-H2 pilot-event id `5`
- readback fortsatt B37-H2 scope:
  `["operational-state-production-pilot"]`

Browser dry-run:

- public app åpnet med `sdeOperationalStateTestSubmit=1`
- lokal reset av manuelle nattplasseringer ble gjort i browseren
- lokal nattplassering opprettet: `74-54` fra `5M` til `4M`
- payload-preview viste ett override
- scope var `["sde-night-placement-manual-overrides"]`
- compare viste `server-scope-different`, som forventet
- readiness viste `blocked_server_read_only`
- availability var `write_not_available`
- test-gate viste `test_submit_blocked`
- gate-kontroller hadde `0` knapper
- ingen production submit/sync/snapshot-knapp
- ingen console errors
- ingen Network POST
- events var uendret etter dry-run

Payload-sikkerhet:

- ingen drag payload
- ingen selected slot
- ingen `Utført` eller `Annullert`
- ikke SDE-motor, score eller sortering
- ikke skifteordre
- serverstate er fortsatt ikke operativ sannhetskilde

Krav før eventuell B38-H1:

- eksplisitt ny bruker-GO
- fersk SQLite-backup utenfor repo
- backup integrity OK
- kontrollert flaggvindu
- nøyaktig én frontend-initiert POST
- Network-verifikasjon
- events/readback før og etter
- restart tilbake read-only etterpå
- stopp hvis bruker er trøtt/usikker

Stoppunkt:

- etter B38-H0-DOC er production-write fortsatt ikke gjennomført
- operational write er fortsatt ikke løpende åpnet

## B38-H1B production-pilot preflight backup result

B38-H1B var en production-pilot preflight med fersk SQLite-backup og
browser dry-run av production-pilot gate. Den gjennomførte ingen
production-pilot og ingen write.

Konklusjon:

- `B38-H1B GREEN — backup/preflight complete, production pilot still not executed`
- ingen production-pilot ble kjørt
- ingen POST, restart, DB-write, flags eller Cloudflare-endring

Backup:

- backup root:
  `/Users/solglottsr/sde_db_backups/20260629_224312_b38h1b_preflight`
- backup DB:
  `/Users/solglottsr/sde_db_backups/20260629_224312_b38h1b_preflight/sde-server.sqlite3`
- source DB resolved read-only via process/lsof:
  `/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`
- `PRAGMA integrity_check: ok`
- `PRAGMA user_version: 1`
- backup event snapshot:
  - id `1`-`4` var historiske note/ack events
  - id `5` var `operational_state.snapshot.test`
  - id `5` timestamp var `2026-06-29T18:19:33.142Z`

Production før/etter:

- health OK
- revision `6`
- alle write/operational/production/migration-flagg fortsatt av
- `/api/operational-state/events` fortsatt kun B37-H2 pilot-event id `5`
- testserver port `8791` ikke lyttende
- git final: `## main...origin/main`

Browser dry-run:

- public app åpnet med `sdeOperationalStateProductionPilot=1`
- payload-preview viste scope:
  `["sde-night-placement-manual-overrides"]`
- lokal manuell nattplassering i preview: `74-54`, `5M -> 4M`
- gate-status: `production_pilot_blocked`
- availability: `write_not_available`
- production-pilot submitknapper: `0`
- operational test-submitknapper: `0`
- console errors: nei
- Network POST: nei
- events uendret

Stoppunkt:

- etter B38-H1B-DOC er production-pilot fortsatt ikke kjørt
- operational write er fortsatt ikke løpende åpnet
- eventuell B38-H1C/H1 krever ny eksplisitt bruker-GO

## B38-H1D production-pilot runbook

B38-H1D er en runbook for en senere, ekstremt smal production-pilot. Dette
er dokumentasjon, ikke execution. Ingen pilot skal kjøres i B38-H1D.

Konklusjon fra B38-H1C:

- `GO for B38-H1D runbook`
- dette er ikke GO for write
- production-pilot er fortsatt ikke utført
- operational write er fortsatt ikke løpende åpnet

Tillatt pilot:

- eksakt én frontend-initiert production-write
- endpoint: `POST /api/operational-state/snapshot`
- tillatt payload scope: `["sde-night-placement-manual-overrides"]`
- pilotkandidat fra preview: `74-54`, `5M -> 4M`
- dette er ikke skifteordre
- dette er ikke `Utført` eller `Annullert`
- dette er ikke SDE-motor-kilde
- serverstate blir fortsatt ikke operativ sannhetskilde
- dette åpner ikke løpende operational write

Midlertidig flaggvindu for senere pilot:

- `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
- `SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1`

Kun operational-state snapshot write åpnes midlertidig. Alle andre
operational/action/production write-flagg holdes av.

Flags som fortsatt skal være av:

- migrations
- server-note actions
- SDE recommendation ack actions
- alle andre production/action write-flagg

Forventet DB-endring ved senere pilot:

- nøyaktig én ny relevant `operational_state.snapshot.test` event
- revision øker fra `6` til `7`
- readback viser nattplassering-scope
- ingen schemaendring
- ingen migration
- ingen ekstra events/actions
- ingen writes til andre subsystemer

Før-POST abortkriterier:

- repo er ikke `## main...origin/main`
- HEAD er ikke forventet H1B-DOC-baseline eller nyere eksplisitt godkjent
- production er ikke revision `6`
- events er ikke kun B37-H2 id `5`
- backup finnes ikke eller integrity er ikke dokumentert OK
- port `8791` lytter
- payload scope er feil
- payload inneholder drag/transient state
- payload inneholder selected slot
- payload inneholder `Utført` eller `Annullert`
- payload inneholder SDE-motor, score eller sortering
- payload har skifteordre-semantikk
- submitknapp-count er større enn `1`
- bruker gir ikke eksplisitt GO for selve write-vinduet

Etter-POST abortkriterier:

- HTTP er ikke forventet success
- mer enn én POST observeres
- revision blir ikke nøyaktig `7`
- mer enn én ny relevant event dukker opp
- event type, scope eller idempotency er feil
- serverstatus viser operational authority på
- migration/schema endres
- console/network viser uventede writes
- frontend ser ut til å auto-sende eller retrye

Rollback/recovery:

- korrigerende event er riktig når write er gyldig, men metadata/readback
  trenger audit-korrigering
- DB-restore vurderes bare ved feil write som ikke trygt kan korrigeres
  auditmessig
- DB-restore vurderes også ved flere uventede events/actions,
  integrity/schema-skade eller inkonsistent idempotency/revision
- rollback skal ikke gjøres bare fordi piloten lykkes
- normal safe rollback etter vellykket pilot er å lukke runtime tilbake
  read-only uten flags, ikke å slette pilot-event

Dokumentasjonskrav etter eventuell senere pilot:

- eksakt payload
- endpoint
- flags-vindu
- HTTP-resultat
- before/after revision
- before/after events
- readback
- network POST count
- backup brukt
- at runtime ble lukket tilbake read-only
- konklusjon GO/NO-GO for videre arbeid

Forbud i B38-H1D:

- ikke kjør pilot
- ikke POST
- ikke sett flags
- ikke restart
- ikke DB-write
- ikke Cloudflare
- ikke endre `index.html`
- ikke endre serverkode
- ikke lag ny backup/preflight i runbook-fasen
- ikke bland runbook og execution

## B38-H1E production-pilot write result

B38-H1E gjennomførte første kontrollerte frontend-initierte
production-pilot write for nattplassering-sync. Dette var én avgrenset
production-write, ikke løpende operational write.

Konklusjon:

- `B38-H1E GREEN — first controlled production-pilot write executed`
- production-pilot ble utført med nøyaktig én frontend-initiert POST
- runtime ble lukket tilbake read-only umiddelbart etter POST
- ingen schemaendring, migration, Cloudflare-endring, commit/push eller
  filendring i selve execution-steget

Før/etter:

- revision: `6 -> 7`
- før events: kun id `5` B37-H2
- etter events: id `5` + ny id `6`
- ny event: `6|operational_state.snapshot.test|previousRevision 6|revision 7`

Endpoint og HTTP-resultat:

- endpoint: `POST /api/operational-state/snapshot`
- HTTP-resultat: `production_pilot_result HTTP 201: ok`

Network:

- `1` frontend-initiert POST
- ingen retry
- ingen ekstra events

Runtime:

- åpnet midlertidig med kun:
  - `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
  - `SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1`
- alle andre write/action/migration-flagg var av
- runtime ble lukket tilbake read-only umiddelbart etter POST
- read-only runtime startet igjen og svarte på port `8787`
- alle write/operational/production/migration-flagg var av etterpå

Payload/readback:

- `serviceDate`: `2026-06-29`
- `idempotencyKey`:
  `sde-night-placement-manual-overrides-production-pilot-2026-06-29-20260629211129`
- `actor.id`: `serverhosted-production-pilot`
- `device.id`: `serverhosted-app-production-pilot`
- `stateScope`: `["sde-night-placement-manual-overrides"]`
- kandidat: `74-54`, `5M -> 4M`
- `clientContext.phase`: `B38-H1-production-pilot`
- `clientContext.notOperationalOrder`: `true`
- `clientContext.notCompletedCancelled`: `true`
- `clientContext.notSdeMotorSource`: `true`
- `clientContext.source`: `frontend-production-pilot-gate`
- `clientContext.oneManualSubmit`: `true`
- `clientContext.noAutomaticSubmit`: `true`
- `clientContext.serverStateAuthority`: `false`
- `clientContext.operationalAuthority`: `false`

Verifikasjon:

- readback viste nattplassering-scope
- DB integrity: `ok`
- `user_version`: fortsatt `1`
- schema hash matchet H1B-backup
- actions count matchet H1B-backup: `4 -> 4`
- event count: `5 -> 6`
- port `8791`: ikke lyttende
- git status: `## main...origin/main`
- ingen filendringer, commit/push, Cloudflare, serverkode, `index.html`,
  schemaendring eller migration

Audit-note:

Payloaden inneholdt drag-avledet intern metadata/navngiving:

- `source: night-placement-drag`
- `id: night-drag-...`
- `stableActionKey`, `needKey` og `moveKey` med `night-placement-drag`

Dette er ikke rollback-grunn for B38-H1E fordi:

- writen var nøyaktig én POST
- scope var riktig
- readback var riktig
- DB integrity var OK
- schema og `user_version` var uendret
- actions count var uendret
- runtime ble lukket tilbake read-only

Forbehold før eventuell videre pilot:

- vurder payload-sanitizing/normalisering
- skill tydeligere mellom manuell nattplassering og drag-avledet UI-metadata
- ikke åpne løpende operational write basert på H1E alene

## B39-B SDE Shared Workspace architecture

B39-B etablerer SDE Shared Workspace som designkontrakt. Retningen er
serverbasert shared readback/eventlogg først, ikke operativ sannhetskilde.
H1E viser at write-mekanikken virker for ett smalt scope. Det viser ikke at
semantikken er trygg for bred drift eller løpende operational write.

Overordnet mål:

- SDE Shared Workspace skal gi felles synkron serverbasert readback på tvers
  av relevante funksjoner/moduler
- serverstate er fortsatt ikke generell operativ sannhetskilde
- operational-authority krever alltid egen senere GO
- løpende operational write er fortsatt ikke åpnet

Hovedprinsipp for tilgang og synk:

- tilgangsnivå bestemmer hvilke funksjoner/moduler brukeren har
- en funksjon/modul kan tildeles flere nivåer
- alle nivåer som har samme funksjon/modul, skal se samme synkrone
  serverbaserte informasjon i den funksjonen
- rettigheter innen funksjonen kan variere: read-only, write-draft,
  test-write, production-pilot-write, admin/pilot eller senere
  operational-authority
- samme modul + samme `serviceDate` + samme `scope` = samme synkrone
  informasjon for alle nivåer som har modulen
- samme informasjon betyr ikke samme mulighet til å endre

Moduler/domener:

- Sporplan
- Input Sporplan
- TXP uvirksom infrastruktur
- SDE nattplassering
- SDE Skiftebevegelser
- SDE Vaktplan
- DROPS materiellstyring
- Verksted/materiellstatus
- manuelle vurderinger/notater
- audit/historikk

Scope-katalog:

- `sporplan-readback`
- `input-sporplan-draft`
- `txp-infrastructure-status`
- `sde-night-placement-manual-overrides`
- `sde-shift-movement-assessments`
- `sde-vaktplan-coverage`
- `drops-material-control`
- `workshop-material-status`
- `manual-assessments-notes`
- `shared-workspace-audit-log`

Scopes som krever særskilt senere GO:

- `sde-shift-orders`
- `sde-shift-completion-status`
- `txp-operational-blocks`
- `drops-dispatch-decisions`
- `operational-authority-state`

Disse må ikke smugles inn i generiske notes/scopes.

Foreløpig nivå-/funksjonsmatrise:

- `Agila`: Sporplan
- `TXP`: Sporplan, Input Sporplan, TXP uvirksom infrastruktur
- `DROPS`: Sporplan, SDE readback, DROPS materiellstyring,
  verkstedstatus
- `Verksted`: Sporplan, DROPS-relevante behov, verksted/materiellstatus
- `SDE/skiftere`: Sporplan, Input Sporplan readback, SDE
  Skiftebevegelser, SDE nattplassering, DROPS/verksted readback
- `Vaktplan/ledelse`: Sporplan, SDE Vaktplan, relevant SDE/DROPS/verksted
  readback
- `Admin/pilot`: alle moduler som eksplisitt er tildelt, samt begrenset
  pilotstyring

Dette er en foreløpig modell. Faktiske nivånavn og modulrettigheter skal
dokumenteres eksplisitt før implementering.

Rettighetsregel for skriving:

- skriving styres av nivå
- skriving styres av funksjon
- skriving styres av scope
- skriving styres av miljøflagg
- skriving styres av idempotency
- skriving styres av `expectedRevision`/revision guard
- skriving må audit-logges
- skriving krever eksplisitt fase-GO

Begreper som skal holdes adskilt:

- funksjonstilgang
- synkron state per funksjon
- rettigheter innen funksjon
- shared readback
- input til vurdering
- lokal UI-state
- SDE-forslag
- DROPS-status
- verkstedstatus
- skifteordre
- `Utført`/`Annullert`
- operativ sannhet

Minste datakontrakt per scope-event/snapshot:

- `serviceDate`
- `scope`
- `actor`
- `device`
- `updatedAt`
- `revision`
- `source`
- `payload`
- `clientContext`

Tilleggskrav for production writes:

- `idempotencyKey`
- `expectedRevision`
- `schemaVersion`
- `scopeVersion`
- `sourceModule`
- `writeIntent`
- `readbackOnly` eller eksplisitt authority-flagg

Felter som må ekskluderes eller normaliseres:

- drag/transient UI-state
- `selectedSlot`
- hover/focus/modal-state
- scroll/filter/sort som UI-state
- intern score som sannhet
- midlertidige diagnoseobjekter
- transient warnings uten normalisert vurdering
- skifteordre-semantikk i ikke-skifteordre-scope
- `Utført`/`Annullert`-semantikk uten egen godkjent modul

Normaliseringskrav:

- slot/track ids
- vehicle ids
- timestamps
- source module
- confidence/status som vurdering, ikke fakta
- manuelle overrides med stabil nøkkel uten UI-event-navn som drag

Synkmodell:

- alle klienter bør kunne lese latest snapshot per scope
- alle klienter bør kunne lese revision
- alle klienter bør kunne lese eventlogg
- alle klienter bør kunne lese actor/device
- alle klienter bør kunne lese last-known-good
- alle klienter bør kunne lese conflict status

Konfliktregler:

- `expectedRevision` mismatch gir `409 Conflict`
- samme idempotency + identisk payload gir idempotent replay
- samme idempotency + ulik payload gir conflict
- to writes til samme scope må serialiseres eller gi conflict-readback
- kryss-scope endringer skal ikke automatisk overskrive hverandre

Read-only først:

- alle scopes
- audit-log
- cross-module readback dashboard
- function-level views
- level/function-filtered views

Test-only write senere:

- `manual-assessments-notes`
- `txp-infrastructure-status`
- `workshop-material-status`
- `sde-vaktplan-coverage`

Production-pilot senere:

- ett scope av gangen
- `sde-night-placement-manual-overrides` kan videreføres etter
  payload-sanitizing
- `txp-infrastructure-status` og `workshop-material-status` kan være gode
  kandidater fordi de er status/readback, ikke ordre

Ikke write uten egen GO:

- skifteordre
- `Utført`/`Annullert`
- DROPS dispatch-beslutninger
- reset/import
- operational authority
- alt som styrer SDE-motor som sannhetskilde

Hjemmebruk over nett krever senere:

- autentisering
- nivå-/funksjonstilgang
- rolle/scope-filter
- Cloudflare Access eller tilsvarende tilgangskontroll
- audit på actor/device
- session/device identity
- LAN/VPN/tunnel-stabilitet
- CSRF/rate limit
- rollback/recovery-runbook
- read-only unless explicitly opened runtime-policy
- tydelig UI for stale/conflict/read-only/pilot mode

Faseplan:

- B39 shared architecture og scope-/tilgangskontrakt
- B40 read-only shared workspace preview i serverapp
- B41 modulvis test-write med temp DB/testserver
- B42 modulvis production-pilot, ett scope av gangen
- B43 access/auth/hjemmebruk med nivå-/funksjonsfilter
- B44 gradvis operational-authority vurdering

Risikotekst:

- største risiko er at shared state glir over til operativ sannhet uten modne
  nivåer, funksjonstilganger, konfliktregler og audit
- nest største risiko er at UI-transient state og interne scorefelt deles og
  senere tolkes som fakta
- H1E viser at write-mekanikken virker, ikke at semantikken er trygg for bred
  drift

Fremdriftsrapportering etter push i Shared Workspace-løpet:

- rapporter fase-status
- rapporter fremdriftsindikator
- rapporter hvor mye som gjenstår
- rapporter neste trygge steg
- skill mellom aktuell fase, Shared Workspace totalt og
  operational-authority/løpende write

## B41-A manual-assessments-notes test-write contract

Status: design-only kontrakt. Ingen endpoint, UI-knapp, POST, flagg,
serverrestart, testserver, production-pilot, rollefilter, auth eller
operational authority er implementert i B41-A.

Scope: `manual-assessments-notes`.

Første modus: senere test-only mot temp DB/testserver. Ikke production,
ikke port 8787, ikke Cloudflare og ikke løpende operational write.

Formål:

- dele manuelle vurderinger/notater som shared readback
- støtte felles situasjonsbilde
- gi auditspor for vurderinger
- ikke styre operativ handling

`manual-assessments-notes` skal aldri i denne kontrakten være:

- skifteordre
- `Utfoert`/`Annullert`
- SDE-motor-source
- operational authority
- DROPS dispatch
- TXP operational block
- verksted binding/frigjøring
- automatisk sync/write

Tillatt innhold:

- kort notat
- kategori
- relatert modul/scope
- `serviceDate`
- `actor`
- `device`
- timestamp
- optional related vehicle/slot/train når relevant
- confidence/status som vurdering, ikke fakta
- `clientContext` med ikke-operativ kontrakt

Minimum payload-kontrakt:

```json
{
  "serviceDate": "YYYY-MM-DD",
  "scope": "manual-assessments-notes",
  "idempotencyKey": "...",
  "expectedRevision": 7,
  "schemaVersion": 1,
  "scopeVersion": 1,
  "actor": {
    "id": "...",
    "role": "..."
  },
  "device": {
    "id": "...",
    "label": "..."
  },
  "sourceModule": "shared-workspace-manual-note",
  "writeIntent": "test_manual_assessment_note",
  "readbackOnly": true,
  "payload": {
    "category": "...",
    "text": "...",
    "relatedScope": "...",
    "relatedVehicle": "",
    "relatedSlot": "",
    "relatedTrain": "",
    "assessmentStatus": "observation|question|risk_note|manual_followup",
    "validForServiceDate": "YYYY-MM-DD"
  },
  "clientContext": {
    "notOperationalOrder": true,
    "notCompletedCancelled": true,
    "notSdeMotorSource": true,
    "serverStateAuthority": false,
    "operationalAuthority": false,
    "noAutomaticSubmit": true,
    "oneManualSubmit": true
  }
}
```

Eksplisitt ekskludert:

- ordretekst som `utfoer`
- `Utfoert`
- `Annullert`
- `godkjent skift`
- `send tog`
- `frigitt materiell`
- `tursatt`
- `operativ blokk`
- drag/transient UI-state
- `selectedSlot`
- hover/focus/modal-state
- intern score som sannhet
- diagnoseobjekter dumpet rått
- lokal UI filter/sort/scroll-state

Normalisering:

- `category` må være kontrollert enum
- `assessmentStatus` må være kontrollert enum
- tekstlengde må begrenses
- vehicle/slot/train må normaliseres som strenger når brukt
- `relatedScope` må være kjent scope fra Shared Workspace-katalogen
- HTML/script er ikke tillatt
- fritekst som kan tolkes som ordre er ikke tillatt uten kategori og
  ikke-operativ kontrakt

Foreslåtte enum-verdier:

- `category`: `observation`, `question`, `risk`, `followup`,
  `coordination`, `data_quality`
- `assessmentStatus`: `observation`, `question`, `risk_note`,
  `manual_followup`

Idempotency/revision:

- senere test-write må kreve `idempotencyKey`
- senere test-write må kreve `expectedRevision`
- samme idempotency + samme payload gir idempotent replay
- samme idempotency + ulik payload gir conflict
- `expectedRevision` mismatch gir `409 Conflict`
- ingen auto-retry

Foreløpig rolle/funksjon:

- readback kan vises for nivåer som har relevant modul
- skriveadgang senere gis bare til eksplisitt tildelte nivåer
- Agila skal ikke kunne skrive notater hvis Agila kun har Sporplan
- Admin/pilot kan eventuelt testskrive senere med eksplisitt flagg
- faktisk rollemodell må låses før production-pilot

Test-only senere:

- bruk temp DB/testserver
- ikke production
- ikke port 8787
- ikke Cloudflare
- ikke operational authority
- ikke direkte klientwrite til `shared-workspace-audit-log`
- skap maksimalt en test-event/snapshot innen `manual-assessments-notes`
- verifiser readback
- verifiser conflict/idempotency hvis fasen tillater det

Absolutt ikke del av B41-A:

- endpoint-implementering
- UI-knapp
- POST
- flaggsetting
- serverrestart
- production-pilot
- auth-implementering
- rollefilter-implementering
- operational authority

Foreløpige abortkriterier for senere test-write:

- feil scope
- payload inneholder ordre/`Utfoert`/`Annullert`
- payload mangler non-authority context
- `idempotencyKey` mangler
- `expectedRevision` mangler
- mer enn én write
- uventet revision jump
- event havner i feil scope
- audit-log kan skrives direkte fra klient
- retry/auto-submit oppdages

Neste B41-faser:

- B41-A: kontrakt/dokumentasjon
- B41-B: test-only serverkontrakt/runbook
- B41-C: test-only endpoint eller eksisterende endpoint-vurdering med temp DB
- B41-D: test-only write
- B41-E: readback/verifisering
- production-pilot først senere, med egen GO

Risikotekst:

Største risiko er at manuelle notater brukes som skjult operativ ordre.
Nest største risiko er at fritekst blir tolket som sannhet av SDE eller
mennesker. Derfor må kontrakten være readback/audit først, med eksplisitte
`notOperationalOrder`, `notCompletedCancelled`, `notSdeMotorSource`,
`serverStateAuthority:false` og `operationalAuthority:false`.

## B41-B manual-assessments-notes test-only runbook

Status: README/design/runbook-only. B41-B kjører ikke testserver, setter ingen
flagg, sender ingen POST, implementerer ingen endpoint og åpner ingen
write/sync/operational-authority.

Formål:

- teste shared workspace write-mekanikk for lavrisiko
  `manual-assessments-notes`
- teste payload-kontrakt, idempotency, `expectedRevision` og readback
- ikke teste production
- ikke teste operational authority

Hovedprinsipp:

- test-write skal aldri gå mot production DB
- test-write skal aldri gå mot port 8787
- test-write skal aldri gi operational authority
- test-write skal aldri bli skifteordre
- test-write skal aldri bli `Utført`/`Annullert`
- test-write skal aldri bli SDE-motor-source
- test-write skal aldri bli DROPS dispatch
- test-write skal aldri bli TXP operational block
- test-write skal aldri bli verksted binding/frigjøring

Test-only miljø for senere B41-C/B41-D:

- temp DB utenfor production DB
- testserver på ikke-production port, for eksempel 8791
- production port 8787 restartes ikke
- production DB røres ikke
- Cloudflare røres ikke
- production runtime forblir read-only

Tillatt scope:

- `manual-assessments-notes`

Tillatt senere test-write:

- nøyaktig én test-event/snapshot innen `manual-assessments-notes`
- ikke direkte klientwrite til `shared-workspace-audit-log`
- ikke writes til andre scopes

Påkrevd ikke-operativ `clientContext`:

- `notOperationalOrder: true`
- `notCompletedCancelled: true`
- `notSdeMotorSource: true`
- `serverStateAuthority: false`
- `operationalAuthority: false`
- `noAutomaticSubmit: true`
- `oneManualSubmit: true`

Eksempelnotat for senere test:

```json
{
  "category": "observation",
  "assessmentStatus": "observation",
  "relatedScope": "manual-assessments-notes",
  "text": "Testnotat for Shared Workspace readback. Ikke operativ ordre.",
  "relatedVehicle": "",
  "relatedSlot": "",
  "relatedTrain": ""
}
```

Minimum payload for senere test-write:

- `serviceDate`
- `scope: "manual-assessments-notes"`
- `idempotencyKey`
- `expectedRevision`
- `schemaVersion`
- `scopeVersion`
- `actor`
- `device`
- `sourceModule`
- `writeIntent`
- `readbackOnly: true`
- `payload`
- `clientContext`

Normalisering før senere test-write:

- `category` må være kontrollert enum
- `assessmentStatus` må være kontrollert enum
- `relatedScope` må være kjent scope
- tekstlengde må være begrenset
- HTML/script er ikke tillatt
- ordreformulering er ikke tillatt
- `Utført`/`Annullert` er ikke tillatt
- SDE-score som sannhet er ikke tillatt
- raw diagnose dump er ikke tillatt
- drag/transient UI-state er ikke tillatt
- `selectedSlot`, hover, focus, modal, scroll, filter og sort state er ikke
  tillatt

Test-only flagg for senere B41-D:

- `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
- eventuelt eget test-only flagg dersom eksisterende serverkontrakt krever det
- production-write flagg skal være av
- migration-flagg skal være av
- alle andre action/write-flagg skal være av

B41-B setter ingen flagg. Senere B41-D må eksplisitt vise hvilke flagg som
brukes i testservervinduet.

Før-test abortkriterier for senere test-write:

- repo er ikke rent/synkronisert
- feil HEAD
- production port 8787 er ikke read-only
- production flags er ikke av
- testserver peker mot production DB
- testserver bruker port 8787
- temp DB er ikke isolert
- payload mangler `idempotencyKey`
- payload mangler `expectedRevision`
- feil scope
- payload inneholder ordre/`Utført`/`Annullert`/operational authority
- mer enn én test-submit kan skje
- auto-submit/retry finnes
- audit-log kan skrives direkte fra klient

Forventet resultat for senere B41-D:

- nøyaktig én ny test-event/snapshot i temp DB
- scope er `manual-assessments-notes`
- readback viser testnotatet
- revision øker nøyaktig én gang i test DB
- production revision forblir 7
- production events forblir id 5 og id 6
- production DB er uendret
- ingen schema/migration
- ingen writes til andre scopes
- ingen operational authority

Etter-test abort/incident for senere B41-D:

- production DB endres
- production revision endres
- mer enn én test-event
- feil scope
- feil payload
- retry/auto-submit
- `expectedRevision` ignoreres
- idempotency virker ikke
- event havner i audit-log direkte fra klient
- schema/migration endres
- operational authority blir true

Idempotency/conflict test senere:

- samme idempotency + samme payload = replay
- samme idempotency + ulik payload = conflict
- `expectedRevision` mismatch = `409 Conflict`
- ingen auto-retry

Readback-verifisering senere:

- GET/readback viser notatet
- eventlogg viser actor/device/sourceModule/writeIntent
- `clientContext` viser ikke-operativ kontrakt
- notatet vises som readback/audit, ikke handling
- ingen UI tolker notatet som ordre

Rollback/recovery for test-only temp DB:

- normal cleanup er å slette temp DB etter dokumentert test hvis ønskelig
- ingen production rollback skal være nødvendig
- hvis production påvirkes, stopp umiddelbart og rapporter incident
- ikke forsøk å fikse med ny write uten egen GO

B41-faseplan:

- B41-A: kontrakt/dokumentasjon - GREEN
- B41-B: test-only runbook - denne fasen
- B41-C: test-only server/endpoint vurdering eller minimal
  implementeringsplan
- B41-D: test-only write mot temp DB/testserver
- B41-E: readback/verifisering
- B41-F: dokumentasjon av test-resultat
- eventuell production-pilot senere, egen GO

Eksplisitt ikke del av B41-B:

- endpoint
- serverkode
- frontendknapp
- POST
- flagg
- testserverstart
- production-pilot
- Cloudflare
- auth-implementering
- rollefilter-implementering
- operational authority

Risikotekst:

Største risiko er at manuelle vurderinger/notater blir tolket som operativ
ordre. Nest største risiko er at en test-write ved feil peker mot production
DB. Derfor må testserver/temp DB, non-authority `clientContext`,
idempotency, `expectedRevision` og abortkriterier være eksplisitte før noen
write.

## B41-F manual-assessments-notes test-resultat

B41-F dokumenterer B41-D/B41-E-resultatet. Dette er dokumentasjon av en
isolert test-only write og read-only verifisering. Det er ikke ny execution,
ikke production-write og ikke operational authority.

B41-D resultat:

- status: GREEN
- endpoint: `POST http://localhost:8791/api/operational-state/snapshot`
- temp DB: `/tmp/sde-b41d-manual-notes-fLS24E/sde-test.sqlite3`
- testserver port: `8791`
- HTTP-resultat: `201 Created`
- POST count: `1`
- retry count: `0`
- test DB revision: `1 -> 2`
- event id: `1`
- event type: `operational_state.snapshot.test`
- scope: `manual-assessments-notes`

Payload/readback-resultat:

- `category: observation`
- `assessmentStatus: observation`
- `relatedScope: manual-assessments-notes`
- `text: Delt readback-notat for isolert test.`
- `relatedVehicle: 74-54`
- `relatedSlot: 5M`
- `readbackOnly:true`
- `serverStateAuthority:false`
- `operationalAuthority:false`

B41-E read-only verifisering:

- status: GREEN
- production health OK
- production revision fortsatt `7`
- production events fortsatt kun id `5` og id `6`
- alle production write/operational/production/migration-flagg av
- `serverStateAuthority:false`
- `operationalAuthority:false`
- ingen production DB-write

Temp DB read-only bevis:

- `PRAGMA integrity_check: ok`
- `PRAGMA user_version: 0`
- `app_state revision: 2`
- `events count: 1`
- event:
  `1|operational_state.snapshot.test|1|2|2026-06-30T08:51:04.832Z`
- event/readback scope: `manual-assessments-notes`
- readback inneholdt notatet som audit/readback
- ingen andre scopes observert
- actions-tabell var ikke nødvendig for denne operational-state-only testen

Eksplisitte avgrensninger:

B41-D/B41-E var ikke:

- production-write
- operational authority
- løpende write/sync
- skifteordre
- Utført/Annullert
- SDE-motor-source
- TXP operational block
- DROPS dispatch
- verksted binding/frigjøring
- Cloudflare-endring
- migration/schemaendring
- `index.html`-endring

Ikke-testet i B41-D/B41-E:

- idempotency replay er ikke testet
- revision-conflict er ikke testet
- disse skal ikke omtales som verifisert eller utført
- idempotency/revision-conflict kan planlegges som egen senere B41-E2
  test-only fase

Videre faseplan:

- B41-F dokumentasjon: denne fasen
- eventuell B41-E2: idempotency/revision-conflict test-only, egen GO
- eventuell production-pilot senere: egen GO
- operational authority / løpende write: `0 %`, ikke åpnet

## B41-E2 manual-assessments-notes idempotency/revision-resultat

Status: B41-E2 GREEN.

B41-E2 dokumenterer en isolert test-only idempotency/revision-verifisering
for `manual-assessments-notes`. Testen ble kjørt mot testserver/temp DB, ikke
production. Den åpnet ikke operational authority og etablerer ikke løpende
write/sync.

Testmiljø:

- testserver port: `8791`
- temp DB: `/tmp/sde-b41e2-manual-notes-GDKPDC/sde-test.sqlite3`
- eneste flagg satt: `SDE_ENABLE_OPERATIONAL_STATE_WRITES=1`
- production-write flagg: av
- operational authority: false

POST-plan/resultat:

- planlagt POST count: `4`
- faktisk POST count: `4`
- retry count: `0`

POST 1, valid create:

- resultat: `201 Created`
- revision: `1 -> 2`
- event id: `1`

POST 2, identisk idempotency replay:

- resultat: `200 OK`
- `mode: replayed`
- revision fortsatt `2`
- ingen ny event

POST 3, samme idempotencyKey med endret payload:

- resultat: `409 idempotency_key_conflict`
- ingen ny event
- ingen revision bump

POST 4, ny idempotencyKey med stale `expectedRevision:1`:

- resultat: `409 revision_conflict`
- current revision: `2`
- ingen ny event
- ingen revision bump

Temp DB/readback-bevis:

- `PRAGMA integrity_check: ok`
- `PRAGMA user_version: 0`
- `app_state revision: 2`
- `events count: 1`
- event:
  `1|operational_state.snapshot.test|1|2|2026-06-30T09:16:09.764Z`
- scope: `manual-assessments-notes`
- `readbackOnly:true`
- `serverStateAuthority:false`
- `operationalAuthority:false`

Production postcheck:

- production port `8787` uendret
- production revision fortsatt `7`
- production events fortsatt kun id `5` og id `6`
- alle write/operational/production/migration-flagg av
- `serverStateAuthority:false`
- `operationalAuthority:false`
- ingen production DB-write

Eksplisitte avgrensninger:

B41-E2 var ikke:

- production-write
- operational authority
- løpende write/sync
- skifteordre
- Utført/Annullert
- SDE-motor-source
- TXP operational block
- DROPS dispatch
- verksted binding/frigjøring
- Cloudflare-endring
- migration/schemaendring
- `index.html`-endring

Videre fase:

- B41 test-write preparation: ca. `97 %`
- B41 er svært nær ferdig som test-write preparation
- SDE Shared Workspace totalt: ca. `55 %`
- neste mulige steg etter dokumentasjon er B41 avslutningsreview / B41-GREEN
  vurdering
- eventuell production-pilot krever egen senere GO
- operational authority / løpende write: `0 %`, ikke åpnet

## B42-A manual-assessments-notes production-pilot plan/runbook

Status: README-only plan/runbook. B42-A dokumenterer en senere kontrollert
production-pilot for `manual-assessments-notes`. Dette er ikke execution,
ikke production-write, ikke flaggåpning og ikke operational authority.

Formål:

- gjennomføre én senere production-pilot for `manual-assessments-notes`
- skrive delt readback/audit-only state, ikke operativ sannhetskilde
- verifisere at production kan ta imot ett ikke-operativt manual-note snapshot
  med `expectedRevision` og idempotency
- fortsatt ikke skifteordre
- fortsatt ikke Utført/Annullert
- fortsatt ikke SDE-motor-source
- fortsatt ikke TXP/DROPS/verksted-operativ beslutning
- fortsatt ikke løpende write/sync

Forutsetninger før senere B42 execution:

- HEAD må være eksplisitt låst baseline for B42 execution
- repo må være rent: `## main...origin/main`
- production må svare på port `8787`
- production revision må være `7`, eller nyere avvik må være låst og forklart
  før pilot
- production events må være id `5` og id `6`, eller nyere avvik må være låst
  og forklart før pilot
- alle write/operational/production/migration-flagg må være av før
  pilotvinduet åpnes
- `serverStateAuthority:false`
- `operationalAuthority:false`
- ingen Cloudflare-endring
- ingen migration/schemaendring

Backup/preflight før senere execution:

- ta fersk production DB backup utenfor repo
- dokumenter backup path og kilde-DB path
- kjør `PRAGMA integrity_check` på backup og forvent `ok`
- dokumenter `PRAGMA user_version`
- kjør production GET før pilot:
  - `/api/health`
  - `/api/server/status`
  - `/api/operational-state/events`
- hent `expectedRevision` fra production rett før POST
- bekreft at port/DB-scope er production `8787` og production DB, ikke testserver
- bekreft at ingen testserver på `8791` brukes i B42 execution

Production-pilot write-vindu:

Et senere B42 execution-steg kan bare åpne et kort, eksplisitt pilotvindu for:

- nøyaktig én POST
- endpoint: `POST /api/operational-state/snapshot`
- scope: `manual-assessments-notes`
- én idempotencyKey
- `expectedRevision` hentet fra production rett før POST
- ingen retry
- ingen auto-submit
- ingen løpende write/sync
- production-write flagg bare hvis egen B42 execution-GO eksplisitt tillater
  nøyaktig flaggvindu og rollbackplan
- alle flags skal lukkes tilbake til read-only umiddelbart etter POST

Payloadkrav:

Production-pilot payload skal være konservativ og ikke-operativ:

- scope eksakt `manual-assessments-notes`
- `schemaVersion:1`
- `scopeVersion:1`
- `sourceModule:"shared-workspace-manual-note"`
- `readbackOnly:true`
- `expectedRevision`
- `idempotencyKey`
- actor/device
- non-authority `clientContext`
- tekst som er tydelig ikke-operativ
- `serverStateAuthority:false`
- `operationalAuthority:false`
- `notOperationalOrder:true`
- `notCompletedCancelled:true`
- `notSdeMotorSource:true`
- `noAutomaticSubmit:true`
- `oneManualSubmit:true`

Kodekontrakt:

- testkontrakten bruker `writeIntent:"test_manual_assessment_note"` og
  eventtype `operational_state.snapshot.test`
- production-pilot-kontrakten bruker
  `writeIntent:"production_pilot_manual_assessment_note"` og eventtype
  `operational_state.snapshot.production_pilot`
- eventtype velges server-side fra validert `writeIntent`
- klienten kan ikke sende valgfri eventtype
- begge kontrakter bruker samme scope-, revision-, idempotency-,
  readbackOnly-, non-authority- og språk/feltguards

Innholdsforbud:

B42 execution skal abortere hvis payload eller UI-kilde inneholder:

- ordre
- Utført
- Annullert
- skift som instruks
- TXP operational block
- DROPS dispatch
- verksted binding/frigjøring
- tursatt/operativ beslutning
- SDE-motor-source
- authority-termer
- raw diagnose
- drag/selected/hover/focus/modal/scroll/filter/sort/score/transient UI-state
- skifteordre-semantikk i notatfelt, metadata eller clientContext

Abortkriterier før senere B42 POST:

- feil HEAD
- urent repo
- production revision/events avviker uten låst forklaring
- production svarer ikke
- writeflagg er allerede på før pilot
- `migrationRequired:true` eller schemaavvik som ikke er forstått
- `serverStateAuthority:true`
- `operationalAuthority:true`
- payload scope er ikke eksakt `manual-assessments-notes`
- manglende `expectedRevision`
- manglende idempotencyKey
- payload har operativt språk
- mer enn én POST-mulighet
- retry/auto-submit
- Cloudflare/port/DB-scope uklart
- backup mangler
- rollback/recovery-plan mangler
- `writeIntent` eller eventtype avviker fra faktisk kodekontrakt

Forventet senere pilotresultat:

Hvis B42 execution senere godkjennes og alle prechecks er grønne, forventes:

- HTTP `201 Created`
- production revision øker nøyaktig `+1`
- nøyaktig én ny event
- event type følger faktisk kodekontrakt:
  `operational_state.snapshot.production_pilot`
- scope `manual-assessments-notes`
- readback viser notatet som audit/readback
- `serverStateAuthority:false`
- `operationalAuthority:false`
- alle flags lukkes tilbake etter pilot
- ingen writes til andre scopes
- ingen migration/schemaendring
- ingen Cloudflare-endring
- ingen løpende write/sync

Recovery/rollback:

- ikke slett historisk event som standard
- hvis feil production-write skjer: stopp videre write, lukk flags, behold DB for
  audit og sammenlign mot backup
- DB-restore vurderes bare etter eksplisitt incident-GO
- korrigerende event vurderes bare hvis write er gyldig, men trenger auditmessig
  oppfølging
- recovery skal ikke improviseres i samme steg som pilot
- normal safe close etter vellykket pilot er read-only runtime uten flags, ikke
  sletting av pilot-event

Videre faseplan:

- B42-A: README-only plan/runbook
- B42-B: read-only review av runbook og kodekontrakt
- B42-C: production preflight/backup, egen GO
- B42-D: eventuell én production-pilot write, egen GO
- B42-E: readback/verifisering
- B42-F: dokumentasjon
- operational authority / løpende write: `0 %`, ikke åpnet

## B42-F manual-assessments-notes production-pilot resultat

Status: README-only dokumentasjon. B42-F dokumenterer resultatet fra B42-D
production-pilot og B42-E read-only verifisering. Dette er ikke ny execution,
ikke ny POST, ikke flaggåpning og ikke operational authority.

B42-D GREEN:

- én kontrollert production-pilot POST ble utført
- endpoint: `POST http://localhost:8787/api/operational-state/snapshot`
- HTTP: `201 Created`
- POST count: `1`
- Retry count: `0`
- revision `7 -> 8`
- ny event: id `7`
- eventtype: `operational_state.snapshot.production_pilot`
- scope: `manual-assessments-notes`
- idempotencyKey:
  `manual-assessments-notes-production-pilot-20260630-b42d-001`

Payload/kontrakt:

- `writeIntent:"production_pilot_manual_assessment_note"`
- `readbackOnly:true`
- `serverStateAuthority:false`
- `operationalAuthority:false`
- non-authority `clientContext`
- notatet var readback/audit-only
- ikke skifteordre
- ikke Utført/Annullert
- ikke SDE-motor-source
- ikke TXP/DROPS/verksted/tursatt-operativ beslutning

B42-E GREEN:

- production revision: `8`
- operational-state events: id `5`, `6`, `7`
- event id `7` verifisert som
  `operational_state.snapshot.production_pilot`
- readback viser `manual-assessments-notes`
- readback viser
  `writeIntent:"production_pilot_manual_assessment_note"`
- readback viser `readbackOnly:true`
- readback viser `serverStateAuthority:false`
- readback viser `operationalAuthority:false`
- runtime fortsatt read-only
- alle write/operational/production/migration-flagg av
- `migrationRequired:false`

DB sanity etter pilot:

- `PRAGMA integrity_check: ok`
- `PRAGMA user_version: 1`
- events count: `7`
- actions count: `4`

Runtime etter lukking:

- port `8787`
- read-only PID etter lukking: `24002`
- screen-session: `sde-server-8787`
- production DB:
  `/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3`

B42-D/E åpnet ikke:

- operational authority
- løpende write/sync
- auto-submit
- retry
- writes til andre scopes
- Cloudflare
- migration/schemaendring
- `index.html`
- serverkodeendring
- testserver

Videre faseplan:

- B42-F: README-only dokumentasjon
- B42-G: avslutningsreview / B42 GREEN-vurdering
- eventuell videre production-utvidelse krever egen GO
- operational authority / løpende write: fortsatt `0 %`, ikke åpnet

## Neste fase

Dette er fortsatt servergrunnmurfasen, og PWA-en er ikke koblet til serveren.
Før operative handlinger flyttes, må action-format,
`expectedRevision`, `409 Conflict` ved revision-konflikter og audit-logg
verifiseres med små, avgrensede server-writes.

Planlagte write-endepunkter senere:

- `POST /api/actions/sde-move-action`
- `POST /api/actions/sde-manual-override`
- `POST /api/actions/txp-unavailable`
- `POST /api/actions/grunnoppstilling`
- `POST /api/actions/drops-order`
- `POST /api/actions/drops-mode`
- `POST /api/actions/reset-day`
- `POST /api/actions/import-data`
