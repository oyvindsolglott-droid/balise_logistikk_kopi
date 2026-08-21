# npm-testkommandoer

Dette dokumentet forklarer hva hver kommando i `package.json` sin `scripts`-blokk
faktisk dekker. Det endrer ikke selve kommandoene eller CI-workflowene — det er
ren dokumentasjon for å gjøre det lettere å vite hvilken kommando man skal kjøre
og hvorfor.

Kommandonavnene selv skal ikke endres uten videre, siden flere av dem er
referert eksakt i `.github/workflows/sde-regression-firewall.yml` og i
`.githooks/pre-push` / `scripts/sde-prepush-gate.cjs`.

## Hovedport (kjøres alltid)

| Kommando | Hva den gjør |
| --- | --- |
| `npm test` / `npm run test:sde:strict` | Kjører `tests/sde/strict/strict-runner.cjs` — den permanente regresjonsbrannmuren for SDE sine kanoniske A–W-kontrakter. Dette er hovedporten og kjøres i CI på hver push/PR til `main`. |
| `npm run test:sde:baseline-audit` | Kjører `tests/sde/strict/baseline-audit.cjs`, en frittstående revisjon av baseline-tilstanden bak strict-runneren. |
| `npm run test:sde:determinism` | Kjører `tests/sde/strict/determinism-audit.cjs` — bekrefter at samme input alltid gir samme SDE-forslag/score. |
| `npm run test:sde:contracts` | Kjører `tests/sde/firewall.test.cjs` (med `--test-concurrency=1`) — de permanente kontraktstestene for brannmuren. |
| `npm run test:sde:qualification` | Kjeder `determinism` → `contracts` → `mutations`. Brukes som en samlet kvalifiseringssjekk før en kandidat regnes som trygg. |
| `npm run test:sde:mutations` | Kjører 12 separate `*-mutation-audit.cjs`-skript (fokusert-final, multileg-rute, actual-drag-source, vehicle-id-policy, topology-complete-drag, night-plan-ocr-save, handwriting-recognition, handwriting-model-quality, tursatt-alignment, tursatt-post-arrival, input-sporplan-ui-cleanup). Hver av dem beviser at en injisert feil (mutasjon) faktisk får testene til å slå rødt — dette er "false-green"-forsvaret. |

## Funksjonsspesifikke testbunter

| Kommando | Hva den dekker |
| --- | --- |
| `npm run test:sde:htr-quality` | Håndskriftgjenkjenning (HTR) end-to-end: unit-tester, kvalitetsporter for modellen, gjenopprettingsflyt, asset-kontrakt, statisk asset-levering (`server/scripts/test-static-asset-delivery.js`), invariant-sjekk av HTR-kildefilene, og til slutt Python-basert læringspipeline-test (`test_handwriting_learning_pipeline.py`). |
| `npm run test:sde:htr-and-tursatt-alignment` | Kombinert regresjon for håndskriftgjenkjenning og at Tursatt-visningen forblir riktig justert mot den. |
| `npm run test:sde:input-sporplan-cleanup` | Regresjon for TXP Input Sporplan-opprydding: UI-invarianter, delete-authority for delt sporplan, og en Python e2e-test. |
| `npm run test:sde:tursatt-post-arrival` | Tursatt post-ankomst skiftekort: shift-test, tombstone-test for delt sporplan, og en egen gate-sjekk. |
| `npm run test:sde:tursatt-post-arrival:mutations` | Mutasjonsrevisjon spesifikt for Tursatt post-ankomst-logikken. |

## SDE Quality Engine (`tests/sde-quality-engine/`)

En selvstendig kvalitetsmotor som inventariserer hele SDE og kobler produktfunksjoner
til maskinlesbare GREEN-kontrakter, se `tests/sde-quality-engine/README.md`.

| Kommando | Suite / dekning |
| --- | --- |
| `npm run test:sde:all` | Kjører `run.cjs --suite all` — alle QE-sjekker samlet. |
| `npm run test:sde:multiuser` | `--suite multiuser` — flerbruker-/samtidighetsscenarioer. |
| `npm run test:sde:balise` | `--suite balise` — balisedata-spesifikke kontrakter. |
| `npm run test:sde:integration` | `--suite integration` — integrasjonssjekker mellom moduler. |
| `npm run test:sde:e2e` | `--suite e2e` — ende-til-ende-scenarioer. |
| `npm run test:sde:regression` | `--suite regression` — regresjonssjekker. |
| `npm run test:sde:production-readonly` | `--suite production-readonly` — bekrefter at produksjonskontroller bare bruker `GET`/`HEAD` (aldri write). |
| `npm run test:sde:report` | `--suite report` — genererer rapportene i `tests/sde-quality-engine/reports/`. |
| `npm run test:sde:qe:ci` | `--suite ci` — den suiten som faktisk kjøres i GitHub Actions. |
| `npm run test:sde:qe:critical-user-flow` | Den dedikerte svart-boks-releaseporten `CRITICAL-USER-FLOW-AGGREGATE` (lagt til i PR #31): kjerne-UI-isolasjon fra HTR-feil, Tursatt DOM-rendring, HTR-asset-levering, HTR-worker-init og syntetisk HTR-import. Kjøres i en disponibel, detached git-worktree. |
| `npm run test:sde:qe:unit` | Unit-tester for selve QE-motorens bibliotek (`tests/sde-quality-engine/unit/*.test.cjs`). |
| `npm run test:sde:qe:policy` | Unit-test for CI-policy-logikken (`ci-policy.test.cjs`). |
| `npm run test:sde:qe:provenance` | Unit-test for proveniens-sjekkene (`provenance.test.cjs`). |
| `npm run test:sde:qe:attestation-identity` | Unit-test for attestasjons-identitetslogikken (`attestation-identity.test.cjs`). |

## Browserguard (isolert Playwright-sandkasse)

| Kommando | Hva den gjør |
| --- | --- |
| `npm run test:sde:qe:browserguard:runtime` | Kjører `runtime_contract.py` — verifiserer selve Browserguard-kjøretidskontrakten. |
| `npm run test:sde:qe:browserguard:foundation` | Kjører broker-fundament- og evidence-writer-testene. |
| `npm run test:sde:qe:browserguard:orchestrate` | Kjører `orchestrate.py` — orkestrerer en full Browserguard-kjøring. |
| `npm run test:sde:qe:browserguard` | Kjører alle `test_*.py`-testene i Browserguard-mappen. |

## Nettleser-e2e (Playwright via Python)

| Kommando | Hva den tester |
| --- | --- |
| `npm run test:sde:menu-browser` | Menylayout og -tilgang i faktisk nettleser. |
| `npm run test:sde:empty-target-browser` | Drag-and-drop til tomt spor ("empty-target relief"). |
| `npm run test:sde:chain-liveness-browser` | At kandidat-kjeder forblir "levende" gjennom en drag-operasjon. |
| `npm run test:sde:htr-browser` | Håndskriftgjenkjenning, nattplanlegging, Tursatt-justering og gjenopprettingsflyt — alt i faktisk nettleser. |

## Pre-push-port (lokal git-hook)

| Kommando | Hva den gjør |
| --- | --- |
| `npm run sde:prepush:install` | Installerer den versjonsstyrte `pre-push`-hooken (`.githooks/pre-push` + `scripts/sde-prepush-gate.cjs`) i alle worktrees. |
| `npm run sde:prepush:doctor` | Bekrefter at pre-push-porten faktisk er aktiv. |
| `npm run sde:prepush:approve` | Oppretter en tidsbegrenset (60 min), owner-only engangsgodkjenning for én spesifikk kandidat-SHA, brukt når porten stopper en push som må godkjennes manuelt. |
| `npm run test:sde:prepush` | Unit-test for selve prepush-gate-logikken (`prepush-gate.test.cjs`). |

## Hvor disse brukes

- `.github/workflows/sde-regression-firewall.yml` kjører `test:sde:menu-browser`,
  `test:sde:empty-target-browser`, `test:sde:chain-liveness-browser`,
  `test:sde:htr-browser`, `test:sde:qe:critical-user-flow`, `test:sde:strict`,
  `test:sde:htr-quality`, `test:sde:tursatt-post-arrival` og `test:sde:qe:ci`.
- `scripts/sde-prepush-gate.cjs` kjører en større samling av disse lokalt før en
  branch-push i det hele tatt slipper gjennom.
