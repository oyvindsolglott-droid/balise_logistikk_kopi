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
alltid fra riktig servermappe, uten test-writes, og med produksjonsdatabasen:

```bash
cd /Users/solglottsr/balise_logistikk_kopi/server
unset SDE_ENABLE_TEST_WRITES
PORT=8787 SDE_SERVER_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3 \
  screen -dmS sde-server-8787 /bin/zsh -lc 'cd /Users/solglottsr/balise_logistikk_kopi/server || exit; unset SDE_ENABLE_TEST_WRITES; PORT=8787 SDE_SERVER_DB_PATH=/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3 /opt/homebrew/bin/node src/index.js >>/tmp/sde-server-8787.log 2>&1'
```

Etter start eller restart skal `health`, `server/status` og `state/revision`
verifiseres read-only. `testWritesEnabled` skal være `false`,
`pwaConnected` skal være `false`, og `operationalWritesEnabled` skal være
`false`.

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
