# SDE nattplanmodell

`production-model.json` er det registrerte produksjonsartefaktet. Det starter med
status `INSUFFICIENT_DATA` fordi repositoriet ikke inneholder et autoritativt,
utfallsmerket produksjonsdatasett. Det er derfor ingen skjult eller syntetisk
MachineLearningScore i produksjon.

Kontrollert dataflyt:

1. Autoritative `AUTHORITATIVE_EXECUTED_RESULT`-records eksporteres fra godkjent
   historikk uten personidentitet og med tidspunkter for feature- og labelkunnskap.
2. `scripts/train_sde_night_model.py` filtrerer mot gjeldende safety-kontrakt,
   bygger tidsbasert train/validation/test-split og skriver bare en `CHALLENGER`.
3. Metrics, proveniens, versjoner og artifact-hash kontrolleres utenfor runtime.
4. `scripts/promote_sde_night_model.py` krever en separat, eksplisitt approval-fil
   bundet til challenger-hashen før den kan skrive et `CHAMPION`-artefakt.
5. Godkjent champion og eksakt hash registreres i `model-registry.json` før deploy.

Frontend trener aldri og kan ikke selvpromotere en modell. Ved manglende, ukjent
eller korrupt artifact brukes deterministisk beslutningsstøtte og eventuell
menneskelig erfaring. Modellrollback er en vanlig tilbakeføring av det registrerte
artifactet og registry-pekeren; det endrer ingen operativ togtilstand.
