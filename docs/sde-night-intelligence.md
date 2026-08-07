# SDE – erfaringsbasert nattplanlegging og kontrollert ML

## Authority og beslutningsrekkefølge

Funksjonen er rådgivende. Den kan ikke endre actual placement, status, disposition, faults, repair requests, meldinger, acknowledgements, kø, reservasjoner, skiftekort, godkjenning eller `Utført`.

En kandidat går først gjennom den eksisterende `evaluateSdeAbsoluteTargetSlotSafety`-porten og den eksisterende deterministiske `scoreSdeArrivalParkingCandidate`-motoren. Canonical actual, fysisk occupancy, rute, reservations, eksisterende kort/kø, Tursatt/occurrence og operative behov beholder authority. Ved gate-feil returneres `REJECTED_BY_ABSOLUTE_GATE`; deterministisk score, `HumanExperienceScore`, `MachineLearningScore` og samlet score er da `null`.

Etter bestått port vises tre separate signaler:

1. eksisterende operativ/heuristisk score;
2. forklarbar menneskelig erfaring;
3. forklarbar maskinlæringsvurdering.

Vektene ligger versjonert i `config/sde-night-intelligence.json`. Manglende signaler tas ut og de gjenværende vektene renormaliseres. Uenighet mellom menneskelig erfaring og ML vises eksplisitt.

## Canonical nattplan og bildebehandling

Bildeimport og manuell registrering ender i `sde-night-plan-v1`. Planstatus er `DRAFT`, `CONFIRMED` eller `ARCHIVED`; `EXECUTED` finnes ikke som planstatus. Hver tolket feltverdi bevarer `rawValue`, `normalizedValue`, `confidence`, `sourceRegion` og `validationState`. Hver linje har `UNCONFIRMED`, `CONFIRMED` eller `EXCLUDED`.

JPG/JPEG og PNG analyseres lokalt i nettleseren med selvhostet Tesseract.js 7, norsk og engelsk språkdata. Ingen ekstern OCR-tjeneste eller hemmelig API-nøkkel brukes. Råbildet holdes i en kortlivet object URL, kan fjernes/avbrytes, revokes ved unload og persisteres aldri. En SHA-256-fingerprint kan lagres som proveniens; piksler, håndskrift, navn eller andre uvedkommende bildeelementer blir ikke treningsdata.

OCR er aldri truth. Ukjent `vehicleId` opprettes ikke, ugyldig slot blir ikke gyldig target, og kritiske felt må valideres og bekreftes menneskelig. Brukeren kan korrigere, endre rekkefølge, legge til, fjerne, ekskludere og gjenoppta linjer. Bekreftelse krever gyldig kjent kjøretøy, gyldig slot, menneskelig kontroll og bekrefteridentitet/rolle.

Planer lagres i en egen browserbasert plan-/erfaringspersistence (`sde_night_plans_v1`). Teknisk inferenceaudit lagres separat (`sde_night_inference_audit_v1`). Ingen av nøklene leses av den operative state-/write-pipelinen.

## Menneskelig erfaring

`HUMAN_IMPORTED_PLAN` og `HUMAN_MANUAL_PLAN` representerer planlagt erfaring og får svakere basisvekt. Bare `AUTHORITATIVE_EXECUTED_RESULT` representerer bevist gjennomføring og kan få full vekt. `SDE_RECOMMENDATION` ekskluderes. `REPLAN_REQUIRED`, avbrudd og feil faktisk sluttplassering blir ikke behandlet som suksess.

`HumanExperienceScore` bruker sammenlignbar slot/materielltype og tidsvekting med 180 dagers halveringstid. Resultatet inneholder counts, replan-count, faktisk datert evidence, anvendt vekt og forklaring. Produksjonsartifacten leveres uten et autoritativt historisk outcome-datasett; derfor fabrikeres ingen gjennomført erfaring.

## Offline maskinlæring

Trening skjer bare eksplisitt med `scripts/train_sde_night_model.py`, aldri ved sidevisning, polling, bildeimport eller inference. Implementasjonen bruker deterministisk, regularisert full-batch logistisk/lineær regresjon uten tungt ML-rammeverk, stokastisk runtime eller reinforcement learning.

Tillatte features er eksplisitt allowlistet. Identitet/e-post, uverifisert OCR, tilfeldige frontenddata, syntetiske produksjonsrecords og uutførte SDE-anbefalinger avvises. Alle features må ha `knownAt <= decisionAt`; outcomes må være kjent etter beslutningen. Historikk som feiler dagens safety-regler filtreres. Missing numeric values mean-imputeres som standardisert null; ukjente kategorier blir all-zero.

Targets er separate:

- `replanProbability`
- `morningConflictProbability`
- `expectedMoveCount`
- `departureBlockingProbability`
- `planCompletionProbability`

Splitt skjer kronologisk per driftsdato i 70/15/15 training/validation/test. Artifacten rapporterer Brier score, precision, recall, calibration og MAE, samt record-ID-hasher, perioder, operational revisions og eksklusjonsårsaker.

Minimumskontrakten er 60 autoritative outcomes over minst 20 driftsdøgn og minst åtte utfall i hver binære klasse. Begrunnelsen ligger i den versjonerte konfigurasjonen. Dette er en cold-start-sperre, ikke et kvalitetsløfte.

## Artifact, champion og fallback

`models/sde/production-model.json` er en integritetskontrollert cold-start-artifact med status `INSUFFICIENT_DATA`; `MachineLearningScore` er derfor `null` og får ingen vekt. Artifact-hash er SHA-256 over canonical JSON uten hashfeltet.

Trening produserer bare `CHALLENGER`. `scripts/promote_sde_night_model.py` krever en separat, eksplisitt godkjenningsmanifest bundet til challenger-hashen. Bare en registrert `CHAMPION` med gyldig hash, promotion-binding, modelVersion og featureVersion kan gi inference, og caller må legge ved bevis på bestått absolutt port.

Manglende, korrupt, uregistrert eller ikke-godkjent artifact gir `ML_DISABLED`. Manglende datagrunnlag gir `INSUFFICIENT_DATA`. Begge faller tilbake til deterministisk SDE og eventuell menneskelig erfaring uten å endre safety gates.

Drift vurderes separat med versjonert Brier-degraderingsgrense. `MODEL_DRIFT` deaktiverer ML-vekt og krever kontrollert retraining; runtime-retraining trigges aldri automatisk.

## Rollback og drift

Frontendfiler, config, registry og modellartifact deployes som statiske, versjonerte filer. Rollback er å gjenopprette siste kjente grønne sett av disse filene med en vanlig reviewbar Git-endring. En tidligere champion må fortsatt ha samsvarende registry-binding og artifact-hash. Ingen database- eller server-schemaendring inngår.

Fokustester:

```text
node --test tests/sde/intelligent-night-planning.test.cjs
python3 -m unittest -v tests/sde/test_sde_night_model.py
python3 -m unittest -v tests/sde/test_night_planning_e2e.py
```

Quality Engine kjører de permanente JS- og ML-kontraktene via `tests/sde-quality-engine/unit/night-intelligence.test.cjs`. Browser-E2E starter en isolert lokal static server og Chromium, registrerer alle request-metoder og krever null business-write.
