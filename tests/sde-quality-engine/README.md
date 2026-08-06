# SDE Quality Engine

SDE Quality Engine er en selvstendig kvalitetsmotor som inventariserer hele
SDE, kobler produktfunksjoner til maskinlesbare GREEN-kontrakter og
orkestrerer de eksisterende permanente testene uten å kopiere
produksjonslogikk inn i testen.

Motoren endrer aldri produksjonsstate. En produksjonskontroll kan bare bruke
`GET` og `HEAD`; `POST`, `PUT`, `PATCH` og `DELETE` stoppes av en teknisk guard
før `fetch`.

## Hovedkommando

```sh
npm run test:sde:all
```

Denne kjører:

- schema- og funksjonsmatrisevalidering
- kilde-, rute-, nivå- og testinventar
- Tursatt/Balise-paritet
- Quality Engine-enhetstester
- Python-/generator-/Balise-regresjoner
- eksisterende permanent SDE qualification
- eksisterende serverkontrakter
- rapport-selvtest og fire rapportformater

Installer først serverkontraktenes låste avhengigheter i en fersk checkout:

```sh
npm ci --prefix server
```

Fokuserte suiter:

```sh
npm run test:sde:balise
npm run test:sde:integration
npm run test:sde:e2e
npm run test:sde:regression
npm run test:sde:report
```

CI-porten er:

```sh
npm run test:sde:qe:ci
```

Den krever ingen produksjonshemmeligheter og gjør ingen produksjonskall.

CI skiller tre uavhengige domener: intern Quality Engine-kvalifikasjon,
ekstern SDE-/datavalidering og workflow-/infrastrukturintegritet. Den
opprinnelige QE-runneren beholder sin fail-closed exitkode. Workflowen fanger
exitkoden, validerer den maskinlesbare rapporten mot commitidentitet og
regnskap, og lar bare den separate CI-policyen avgjøre workflowresultatet.

En gyldig rapport med intern `GREEN`, null kritisk `RED` og kritisk ekstern
`BLOCKED` blir derfor synlig `QUALITY_ENGINE_SUCCESS_EXTERNAL_HOLD`. Dette er
en teknisk grønn QE-kvalifikasjon med eksplisitt ekstern HOLD, ikke full SDE
GREEN og ikke en bekreftet produktfeil. Intern testfeil, bekreftet kritisk
ekstern RED, manglende/ugyldig rapport, feil commitidentitet og uenighet mellom
rapport og exitkode feiler fortsatt workflowen.

Den permanente policytestsuiten kan kjøres isolert med:

```sh
npm run test:sde:qe:policy
```

CI skriver i tillegg `reports/ci-policy.json` og `reports/ci-policy.md`, mens
den opprinnelige JSON-/Markdown-/JUnit-/HTML-rapporten bevares uendret. Hele
rapportkatalogen lastes opp med `if: always()` og commit-/run-bundet
artifactnavn.

## Produksjonskontroll

Produksjonskontrollen må aktiveres eksplisitt:

```sh
SDE_QE_PRODUCTION_URL="https://sde.example.invalid" \
  npm run test:sde:production-readonly
```

Allowlisten ligger i `lib/production-readonly.cjs`. Bare relative,
same-origin-endepunkter og metodene `GET`/`HEAD` godtas. Alle observerte kall
føres i rapportens request-ledger. Manglende URL gir `BLOCKED`, ikke falsk
GREEN.

### Beskyttet browserguard-kandidat

Den permanente browserguard-komponenten ligger i `browserguard/` og bruker
repositoryets deklarerte Python Playwright-runtime. Den installerer både HTTP-
og WebSocket-routing på `BrowserContext` før første side opprettes, blokkerer
service workers og nekter page-lokale route-overstyringer. For det eksakte
beskyttede originet tillates bare `GET` og `HEAD`; alle andre HTTP-metoder
avbrytes før nettverk. En rutet WebSocket kobles aldri til serveren.

Den dokumenterte sideflaten er en eksplisitt allowlistet `GuardedPage`-fasade.
Den tilbyr bare navigasjon med et sanitert immutable resultat, tekstlesing,
allowlistede synlige attributter (`alt`, `class`, `id`, `role`, `title` og
`aria-*`), locator-antall, synlighet, viewport, scrolling, kontrollert
skjermbilde, venting på lastetilstand og lukking. Ukjente operasjoner avvises;
det finnes ingen generell attributt- eller metodevideresending til Playwright.
Navigasjon returnerer `NavigationResult`, skjermbilder returnerer
`ScreenshotResult`, og popup-er returnerer en ny `GuardedPage`.

Den offentlige flaten tilbyr ingen callback- eller eventregistrering. Interne
Playwright-events og callbackargumenter behandles bare inne i implementasjonen
og eksporteres ikke. Rå `Browser`, `BrowserContext`, `Page`, `Frame`,
`APIRequestContext`, `WebSocketRoute`, `Request` eller `Response` er ikke
offentlige returverdier. De permanente strukturelle testene inventariserer
fasaden og traverserer resultater, collections og nested verdier for slike
forbudte typer.

Lokal kvalifisering kjøres bare mot to dynamiske loopback-origins:

```sh
npm run test:sde:qe:browserguard
```

En enkelt maskinlesbar kvalifiseringsrapport med sanitert evidens kan opprettes
under en unik katalog i `/private/tmp` med:

```sh
python3 tests/sde-quality-engine/browserguard/orchestrate.py
```

Rapporten følger
`contracts/sde-production-readonly-browser-guard-v1.schema.json`. Auditloggen
inneholder bare timestamp, metode, origin, path uten query, resource type,
allow/block-resultat, barrier reason og en lokal sideidentitet. Request bodies,
response bodies, headers, cookies, tokens, Authorization-data, storage state,
HAR og rå trace lagres ikke.

Kandidaten åpner ikke produksjonsoriginet og gjennomfører ingen autentisering.
En senere separat produksjonsfase kan bruke headed modus og bevare den levende,
midlertidige browserkonteksten mens brukeren logger inn selv. Profilen skal da
ligge under `/private/tmp`, ingen storage state skal eksporteres, og profilen
skal slettes når kontrollen avsluttes. Produksjonsnavigasjon skal fortsatt være
fail-closed dersom én obligatorisk barriere eller sentinel-preflight mangler.

### Separat Browserguard-broker

Den godkjente orkestratorgrensen er nå `browserguard/client.py`; denne modulen
og den frosne inngangen `browserguard/orchestrate.py` importerer ikke
Playwright. `guard.py` og Playwright er broker-interne implementasjonsdetaljer
og skal ikke importeres av en senere produksjonsmatrise. Alternative
browserscript, direkte Playwright-bruk og generell metodevideresending er
forbudt i den fasen.

Brokeren lever i en separat, langlivet prosess og eier Browser, BrowserContext,
alle Page-objekter, nettverksbarrierer, profil, screenshots, rapporter og
opprydding. Klienten kommuniserer over en broker-opprettet Unix-socket i en
`0700`-katalog med socketmodus `0600`. Meldinger bruker en lengdebegrenset,
versjonert JSON-protokoll med session-, command-, response- og sekvens-ID.
Protokollhashen må samsvare før første kommando, og alle protokollobjekter har
`additionalProperties: false`.

Human gate kan bare startes i den eksplisitt headed broker-modusen. Begin
oppretter en ugjennomsiktig gate-ID og en obligatorisk timeout på 1–300
sekunder. Complete og abort må sende samme gate-ID. Complete bevarer broker,
context og aktiv page; abort, timeout, klientdisconnect, shutdown og støttede
SIGINT-, SIGTERM- og SIGHUP-baner bruker samme idempotente, maksimalt
15-sekunders shutdownkoordinator og rydder profil, socket, IPC-katalog, browser,
context, driver, downloads, tempfiler og sentinel også under delvis
initialisering. Signalhandleren registrerer bare shutdownforespørselen; selve
cleanupen skjer i den felles koordinatoren. SIGKILL omfattes uttrykkelig ikke av
cleanup-løftet. CI kjører Browserguard-porten under `xvfb-run` slik at
headed-banen testes reelt.

Produksjonssikkerhetsløftet gjelder den godkjente, frosne Quality
Engine-orkestratoren. Brokeren er ikke en generell OS-sandbox mot en
ondsinnet lokal prosess med samme brukerrettigheter.

Screenshots, rapporter og manifester bruker én directory-FD-basert writer.
Klienten sender bare en sanitert artifact-ID; den kan ikke sende filsti.
Writeren avviser eksisterende og dangling symlink, katalog, FIFO og andre
uventede typer. Den prøver maksimalt åtte nye, broker-genererte kryptografiske
tempnavn ved `EEXIST`, skriver en eksklusiv `0600`-tempfil i samme katalog,
fsyncer bytes, revaliderer målentryet, bruker atomisk replace og fsyncer
parentdirectory. En kolliderende fremmed entry endres aldri, og failure-cleanup
unlinker bare en tempentry hvis device, inode og mode fortsatt matcher entryen
som operasjonens egen `O_EXCL`-open opprettet.

Read-only-operasjoner er bundet til
`contracts/sde-browserguard-readonly-interaction-plan-v1.schema.json`.
Klienten sender bare committed action-, target-, viewport- og page-ID-er, aldri
selectors eller URL-er. Meny, fane, read-only-detalj, overlay-close, fokus og
sikre taster valideres både mot planen og elementets runtime-semantikk. Form,
submit, upload, contenteditable, drag-and-drop og kjente muterende
handlingskategorier avvises. HTTP-/WebSocket-barrieren er fortsatt siste
sperre.

Den reproduserbare Browserguard-runtimeen er låst separat til Python 3.11.15,
Playwright 1.62.0 og Chromium revision 1234. Root-`requirements.txt` brukes
ikke til Browserguard-porten. Lokal og CI-installasjon bruker:

```sh
python3.11 -m pip install --require-hashes \
  -r tests/sde-quality-engine/browserguard/requirements.lock
PLAYWRIGHT_BROWSERS_PATH=/absolutt/isolert/browsersti \
  python3.11 -m playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/absolutt/isolert/browsersti \
  npm run test:sde:qe:browserguard:runtime
PLAYWRIGHT_BROWSERS_PATH=/absolutt/isolert/browsersti \
  npm run test:sde:qe:browserguard
```

Den committed planen er kun syntetisk loopback. Produksjonsorigin,
autentiseringsorigins og produksjonsselectors må innføres i en separat,
uavhengig auditert plan før noen produksjonskjøring er mulig.

## Statusmodell

| Status | Betydning |
|---|---|
| `GREEN` | Kontrakten er bevist med fersk, reproduserbar evidens. |
| `AMBER` | Delvis bevis eller ikke-kritisk avvik. |
| `RED` | Kontrakten er motbevist eller testen feiler. |
| `BLOCKED` | Testbarhet, autorisasjon eller sikker testflate mangler. |
| `UNKNOWN` | Ingen tilstrekkelig evidens finnes. |

Kritisk `RED` gir `NO-GO`. Kritisk `BLOCKED` eller `UNKNOWN` gir `HOLD`.
Ikke-kritiske dokumenterte hull kan gi `GO MED AVVIK`. Ingen av statusene
`AMBER`, `BLOCKED` eller `UNKNOWN` konverteres til GREEN.

## Kontrakter og funksjonsmatrise

- `contracts/green-contract.json` definerer hva GREEN betyr.
- `matrix/function-matrix.json` inventariserer brukerfunksjoner, datakilder,
  forventet atferd, testtyper og kontraktkoblinger.
- `recommendations/catalog.json` gir handlingsorienterte standardanbefalinger.

En ny produktfunksjon skal:

1. registreres i funksjonsmatrisen
2. kobles til minst én eksisterende eller ny GREEN-kontrakt
3. få en test som kjører faktisk produksjonskode eller autoritativ readback
4. dokumenteres som `BLOCKED – MANGLER TESTBARHET` dersom punkt 3 ikke kan
   oppfylles sikkert

## Tursatt/Balise-paritet

Balise-suiten verifiserer:

- `api_idag` og `api_imorgen` mot en felles effektiv Europe/Oslo-grense: første planlagte forsøk pluss publiseringsgrace
- `updatedAt` med korrekt sommer-/vintertid
- unik `occurrenceId`, `operationalDate` og tognummer
- forekomstbundet materiell og unike dobbeltsett
- actual plattformspor med kilde, råfelt, source timestamp og provenance
- eksplisitt skille mellom override og rådata
- deterministiske DST- og grense-fixtures

Quality Engine endrer aldri datafilene for å få kontrollene grønne.

## Rapporter

Hver kjøring skriver:

- `reports/latest.json`
- `reports/latest.md`
- `reports/latest.junit.xml`
- `reports/latest.html`

Rapportene genereres fra samme resultatmodell og inneholder commit,
funksjonsmatrise, statusfordeling, evidens, produksjonsledger og prioriterte
anbefalinger. De er lokale build-artefakter og er gitignorert. CI laster dem
opp som artefakt også når porten feiler.

## Bevarte tester

Quality Engine erstatter eller svekker ikke:

- strict firewall
- determinism audit
- mutation audit
- permanente kontrakter/harnesser
- Python-/generator-/Balise-tester
- serverkontrakter

Eksisterende porter kjøres som egne prosesser og deres exitstatus er
autoritative. Ingen skip, xfail eller forventet aktiv feil introduseres.
Den samlede qualification-porten har et standardbudsjett på 45 minutter,
fordi determinisme og mutasjonsaudit med vilje kjører sekvensielt. Budsjettet
kan overstyres eksplisitt med `SDE_QE_QUALIFICATION_TIMEOUT_MS`.
De fire historiske servertestene som tidligere var låst til én absolutt
checkout-sti bruker nå sin egen filplassering som repoanker. Den foreldede
migrasjonstesten oppretter en deterministisk pre-migration-fixture under
`/tmp` i stedet for å avhenge av produksjonsdatabasens nåværende schema.

## Kjente testbarhetsgrenser

Ekte fleridentitets-race og en komplett autentisert visuell produksjonsmatrise
krever en separat, autorisert og write-fri testflate. De rapporteres eksplisitt
som `BLOCKED` inntil slik evidens finnes. Simulerte revisjons- og
idempotencytester fortsetter å dekke de autoritative serverkontraktene.
