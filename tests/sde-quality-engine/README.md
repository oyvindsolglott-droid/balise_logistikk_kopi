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

- `api_idag` og `api_imorgen` mot Europe/Oslo og 07:00/15:00-vinduene
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
