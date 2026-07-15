# SDE permanent regression firewall

Strict tester alltid den faktiske `index.html` i den aktuelle worktree-en og
godtar ingen forventede feil:

```sh
npm test
# identisk eksplisitt kommando:
npm run test:sde:strict
```

Strict returnerer non-zero for hver brutt invariant. Den aktive lukkede
baselinen er 37/37 PASS med et tomt `failIds`-sett. Baseline-audit kjører strict
tre ganger og blir bare grønn når alle kjøringene har exit 0, eksakt samme
normaliserte semantikk, unike invariant-ID-er og 37/37 PASS:

```sh
npm run test:sde:baseline-audit
```

De 13 feilene fra production-commit `8b9f122d…` er bevart som inaktivt,
historisk bevis i `strict/baseline-expected-failures.json`; de er aldri en aktiv
godkjenningsliste. Fail-closed-semantikken til qualification-porten verifiseres
permanent av `strict/qualification-contract-meta.cjs` og inngår i determinism-
og mutation-auditene:

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
