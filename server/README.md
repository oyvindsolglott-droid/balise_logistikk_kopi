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
