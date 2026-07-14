# SDE permanent regression firewall

Strict tester alltid den faktiske `index.html` i den aktuelle worktree-en og
godtar ingen forventede feil:

```sh
npm test
# identisk eksplisitt kommando:
npm run test:sde:strict
```

Strict returnerer non-zero for hver brutt invariant og er med hensikt rød på
den låste production-baselinen. Den separate analysekommandoen kjører nøyaktig
samme strict-tester og blir grønn bare når det faktiske FAIL-settet er identisk
med den versjonerte baseline-listen:

```sh
npm run test:sde:baseline-audit
```

Baseline-audit er aldri en CI-statuskontroll. Historiske A–W-kontrakter og deres
negative historiske snapshots er bevart separat:

```sh
npm run test:sde:contracts
npm run test:sde:mutations
npm run test:sde:determinism
npm run test:sde:qualification
```

Strict-driverne leser `index.html`, trekker ut inline-skriptene og evaluerer de
faktiske production-funksjonene i en isolert VM. De kopierer ikke funksjonene
som testes. I og L er dokumenterte read-only audits. R er kjørbar gjennom
`INV-CANCEL-010`–`013`.

CI-jobben har stabilt navn `permanent-regressions`, kjører
`npm run test:sde:strict`, har read-only permissions og feiler når én invariant
feiler. GitHub Actions kjører etter at en direkte push er
mottatt. For å blokkere endringer på `main` må repository-reglene kreve pull
request og statuschecken
`SDE permanent regression firewall / permanent-regressions`. Denne eksterne
regelen kan først aktiveres når workflowen finnes på default branch.
