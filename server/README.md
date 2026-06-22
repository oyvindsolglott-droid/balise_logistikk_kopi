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

`POST /api/actions/test-note` er kun en server-write-test og er deaktivert som
standard. Den krever `SDE_ENABLE_TEST_WRITES=1`, `expectedRevision`, returnerer
`409 Conflict` ved revision-konflikt og skal ikke kobles til PWA-en. Test-write
bør kjøres mot separat testdatabase, for eksempel med
`SDE_SERVER_DB_PATH=/tmp/sde-server-b1-test.sqlite3`. Produksjonsserveren skal
ikke bruke test-writes med mindre dette er en bevisst kontrollert test. Det
finnes ingen operative write-endepunkter ennå.

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
