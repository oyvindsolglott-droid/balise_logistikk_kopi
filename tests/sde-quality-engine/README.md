# SDE Quality Engine

## Kritisk brukerflyt

Releaseporten `CRITICAL-USER-FLOW-AGGREGATE` er GREEN bare når disse fem
underportene er GREEN: `CORE-UI-MODULE-ISOLATION`, `TURSATT-RENDER-E2E`,
`HTR-ASSET-DELIVERY`, `HTR-WORKER-INITIALIZATION` og
`HTR-SYNTHETIC-IMPORT-E2E`.

Kjør `npm run test:sde:qe:critical-user-flow` på en ren, committet kandidat.
Kommandoen oppretter en disponibel detached worktree, binder evidensen til
base-SHA, kandidat-SHA og tree, og bruker isolert appserver, tempdatabase,
syntetisk bilde og testbrowser. Den sender ingen produksjonswrite og bruker
ingen private brukerdata. Falsk-GREEN-, determinisme- og mutasjonsscenariene
ligger i `fixtures/critical-user-flow-scenarios.json`.

SDE Quality Engine er en selvstendig kvalitetsmotor som inventariserer hele
SDE, kobler produktfunksjoner til maskinlesbare GREEN-kontrakter og
orkestrerer de eksisterende permanente testene uten å kopiere
produksjonslogikk inn i testen.

Motoren endrer aldri produksjonsstate. En produksjonskontroll kan bare bruke
`GET` og `HEAD`; `POST`, `PUT`, `PATCH` og `DELETE` stoppes av en teknisk guard
før `fetch`.

## Obligatorisk lokal pre-push-port

Repositoryets versjonsstyrte hookkilde er `.githooks/pre-push`, og den
versjonsstyrte runneren er `scripts/sde-prepush-gate.cjs`. Installer fra en ren,
committet checkout med `npm run sde:prepush:install`. Installeren kopierer begge
filene til `sde-qe-prepush/` under Git common directory, lagrer kildecommit,
tree og SHA-256 for kilde- og installasjonsfiler, setter et repository-lokalt
absolutt `core.hooksPath` og nekter å overskrive en ukjent eksisterende hook.
`npm run sde:prepush:doctor` verifiserer at porten faktisk er aktiv i alle
worktrees.

En støttet branch-push fryses som eksakt kandidat-SHA i et midlertidig detached,
read-only identitetsworktree. Testene kjøres mot en byteidentisk, read-only
execution-mirror materialisert fra dette worktreeets tracked index; bare en
ignored `server/node_modules`-symlink kan legges til for repositoryets allerede
installerte, låste serveravhengigheter. P0 live-data continuity kjøres først fra
en eksplisitt repository-produsert evidensfil; porten gjør ingen egen
produksjonsinnhenting.
Deretter kjøres QE unit/policy, strict, permanente kontrakter, determinisme,
mutasjonsaudit, generator-/sync-regresjoner, server- og Browserguard-kontrakter,
JSON/schema-, Node-, Python- og workflow-syntaks, `git diff --check`, samt
skip-, bypass-, secret- og test-svekkingskontroller. Konkrete P0-motsigelser
blokkerer. Når P0 bare er eksternt blokkert uten motsigelse, er rapportfeltet
`READY_FOR_BRANCH_PUSH_APPROVAL` den maskinelle autoriteten for lokal
branch-godkjenning.

Første push stoppes alltid. En godkjennbar rapport oppgir eksakt request-ID,
kandidat-SHA, rapporthash og approve-kommando. `npm run sde:prepush:approve --
--request-id <id> --candidate <sha>` oppretter en owner-only engangsgodkjenning
med maksimalt 60 minutters levetid. Neste push må ha identisk SHA/tree,
remote-URL, lokal/remote ref, remote old SHA, gateversjon, profilversjon og
rapporthash; godkjenningen konsumeres atomisk før Git får fortsette.

Git kan bevisst omgå lokale hooks med `--no-verify`; derfor er pull request og
GitHub CI fortsatt uavhengige sikkerhetslag før `main`. Repositoryets egne
scripts, dokumentasjon og Codex-instruksjoner skannes og kan ikke bruke dette
flagget som pushmekanisme.

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

## P0 live-data continuity

`LIVE-DATA-FRESHNESS-P0` er en tellende, kritisk aggregatport. Den blir bare
`GREEN` når ekstern kilde, eksakt Europe/Oslo-datovindu, godkjent
kode/runtime-identitet, scheduler, apply-readiness, faktisk sync, privat
readback, autentisert offentlig readback, faktisk UI og genererings-/
publiseringsproveniens alle er bevist. `up_to_date` kan gjøre scheduler og
readiness grønne, men gjør aldri `ACTUAL_SYNC_APPLIED` grønn alene.

Runneren krever én eksplisitt `sde-live-data-continuity/v1`-evidensfil og
trusted Git-input. Manglende offentlig autentisert kontroll, actual-sync eller
kritisk evidens gir fail-closed `HOLD`; en konkret byte-, dato-, Git- eller
UI-motsigelse gir `NO-GO`. Ingen del av porten endrer SDE, data eller runtime.

```sh
node tests/sde-quality-engine/run.cjs --suite ci \
  --live-data-evidence /absolutt/evidence.json \
  --live-data-runtime-repository /absolutt/runtime-worktree \
  --live-data-approved-sha <40-heksadesimal-git-sha> \
  --live-data-approved-tree <40-heksadesimalt-git-tree> \
  --live-data-approved-main-ref refs/remotes/origin/main
```

Schemaet ligger i
`contracts/sde-live-data-continuity-v1.schema.json`. Historisk rapporttekst og
manuell attestasjon kan ikke overstyre fersk motstridende readback. Pakken er
kanonisk SHA-256-bundet til den repository-eide observatørversjonen, og
kildens station-/vehicle-hasher må samsvare med genereringsproveniensen;
håndredigert eller ukjent produsentevidens feiler kontrollert til `HOLD`.

## Flerbrukerevidens

`MULTIUSER-LIVE-001` er én tellende, kritisk aggregatport. Live-readonly,
isolated-write, integritet, proveniens, secret-free og code binding er
ikke-tellende underresultater. Uten eksplisitt evidens er aggregatet
`BLOCKED`; installasjon av Quality Engine-koden alene kan derfor aldri gjøre
porten grønn.

Evidens oppgis deterministisk på kommandolinjen sammen med den godkjente
produktkodeidentiteten:

```sh
node tests/sde-quality-engine/run.cjs --suite multiuser \
  --multiuser-evidence /absolutt/evidens/evidence-package.json \
  --multiuser-approved-sha <40-heksadesimal-git-sha> \
  --multiuser-approved-tree <40-heksadesimalt-git-tree> \
  --multiuser-subject-repository /absolutt/lokalt/git-repository \
  --multiuser-subject-mode SYNTHETIC_GIT_FIXTURE
```

Det finnes ingen URL-, «nyeste fil»-, narrativ- eller håndredigert
statusfallback. Input åpnes read-only; manglende fil, symlink, flere pakker,
ukjent schema/produsent, stale observasjoner, ugyldig manifest eller feil
kildehash/kodebinding gir fail-closed `BLOCKED`. Beviste secrets,
identitets-/sessionlekkasjer og produksjons-business-write gir kritisk `RED`.

En repository-eid pack-builder lager et deterministisk manifest fra to
allerede sanitiserte maskinproducerte kildeartefakter. Alle tre filer må ligge
direkte i samme evidensmappe:

```sh
node tests/sde-quality-engine/tools/build-multiuser-evidence.cjs \
  --live /absolutt/evidens/live-observations.json \
  --isolated /absolutt/evidens/isolated-write-results.json \
  --output /absolutt/evidens/evidence-package.json \
  --approved-sha <40-heksadesimal-git-sha> \
  --approved-tree <40-heksadesimalt-git-tree> \
  --subject-repository /absolutt/lokalt/git-repository \
  --runtime-sha <40-heksadesimal-git-sha>
```

Kontraktene er dokumentert i
`contracts/sde-multiuser-evidence-v1.schema.json`,
`contracts/sde-multiuser-live-observations-v1.schema.json` og
`contracts/sde-multiuser-isolated-write-results-v1.schema.json`. Quality
Engine beregner kritiske assertions fra validerte observasjoner; felter som
`canonicalGateStatus` eller `subjectsDifferent` godtas ikke som ferdige
utfall. Manuell attestasjon kan dokumentere testvindu eller menneskelig login,
men kan ikke erstatte maskinreadback.

Hashkjeden beviser filintegritet, produsentversjonen binder format og
innsamlingsmekanisme, og eksakt SHA/tree eller dokumentert data-only descendant
bindes til godkjent kode. Subject-repositoryet er et eksplisitt trusted lokalt
CLI-input og kan ikke velges av evidensfilen. Commitobjekter, trees, ancestry,
alle mellomcommits, faktiske endrede filer og kode-/assethash verifiseres
read-only mot dette repositoryet uten fetch. Shallow, manglende, ikke-relatert
eller tvetydig mergehistorikk feiler lukket. Den tillatte descendantlisten er begrenset til
`data/api_idag.json`, `data/api_imorgen.json` og
`data/sde-data-provenance.json`; kode/assets må være byteidentiske. Prosjektet
har ingen kryptografisk signering av slike lokale pakker, så dette gir ikke
non-repudiation. Gjenværende tillitsforutsetning er at den repository-eide
produsenten og dens lokale kjøremiljø kontrolleres av den autoriserte
testemaskinoperatøren.

Rapportene skiller tre identitetsdomener: Quality Engine-evaluatoren,
subject-koden og evidence-produsenten. En syntetisk subject skal merkes
`SYNTHETIC_GIT_FIXTURE`; kontraktkvalifisering rapporteres separat fra
`PRODUCTION MULTIUSER LIVE STATUS`, som forblir `NOT_EVALUATED` uten en egen
autorisert produksjonskjøring. JSON, HTML og JUnit eksponerer samme evaluator
SHA/tree lest direkte fra den aktuelle Git-checkouten.

`multiuser`-suiten kjører den kanoniske gate-, regnskaps- og
JSON/Markdown/JUnit/HTML-pipelinen uten Balise-live eller andre
produksjonsendepunkter. De bredere `all`, `balise`, `integration` og `report`
suitevariantene beholder sin eksisterende Balise-liveport og skal ikke brukes
som produksjonsfri flerbrukerkvalifisering.

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

Ekte fleridentitetsbevis krever fortsatt en separat, autorisert og write-fri
testflate som produserer kontraktsgyldig evidens. Den komplette autentiserte
visuelle produksjonsmatrisen er en separat port. Begge forblir `BLOCKED` når
evidensen mangler. Simulerte revisjons- og idempotencytester fortsetter å
dekke de autoritative serverkontraktene.
