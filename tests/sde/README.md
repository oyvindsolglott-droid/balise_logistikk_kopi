# SDE permanent regression firewall

Strict tester alltid den faktiske `index.html` i den aktuelle worktree-en og
godtar ingen forventede feil:

```sh
npm test
# identisk eksplisitt kommando:
npm run test:sde:strict
```

Strict returnerer non-zero for hver brutt invariant. Den aktive lukkede
baselinen er 67/67 PASS med et tomt `failIds`-sett. Baseline-audit kjører strict
tre ganger og blir bare grønn når alle kjøringene har exit 0, eksakt samme
normaliserte semantikk, unike invariant-ID-er og 67/67 PASS:

```sh
npm run test:sde:baseline-audit
```

De 13 feilene fra production-commit `8b9f122d…` er bevart som inaktivt,
historisk bevis i `strict/baseline-expected-failures.json`; de er aldri en aktiv
godkjenningsliste. `INV-REROUTE-001`–`008` låser separat `canRetarget`,
kontekstuelt VN-avslag, sikker reranking, atomisk planrevision og mandatory
recovery. Fail-closed-semantikken til qualification-porten verifiseres
permanent av `strict/qualification-contract-meta.cjs` og inngår i determinism-
og mutation-auditene:

`INV-EGRESS-001`–`015` låser komplette, deterministiske frigjøringskjeder for
innklemte kjøretøy: alle forutsetningsflytt, hovedflytt og obligatoriske
returer, fulle avhengigheter og ruteressurser, sikker retarget i alle uutførte
ledd, fail-closed ved manglende komplett løsning og fersk actual-state ved
replanlegging, recursive grafiske bestillinger, handlingsklare mid-chain-suffix
og null-sikker reduced-motion-lesing. Mutasjonsscenariene Y1–Y10 skal alle
drepes av disse invariantene.

`INV-EGRESS-016`–`021` låser den faktiske prerequisite-cancellation-banen:
parent-intenten består, den komplette kjeden replannes atomisk fra fersk actual,
avvist target/kjede kan ikke returnere, fallback til nytt hovedmål er synlig,
no-solution er planavgrenset diagnostic-only, og andre grafiske drag forblir
operative. Continuity-fixturen beviser først at den uavhengige positive ruten
`12S → VN` er fysisk gyldig med `VS`, `12N` og `VN` ledige. Den opprinnelige
belagte `VS`/`12N`-tilstanden er bevart som en negativ safety-case som skal
avvises med null operative outcomes, kort, reservasjoner, overlays og adaptere.
Mutasjonene Z1–Z5 skal alle drepes av disse invariantene.

`INV-EGRESS-022` låser skjermbilderegresjonen 74-10 `5M → 6S`: et gammelt
annullert frigjøringssteg for 74-12 kan ikke gjenbrukes som aktiv identitet.
Planleggeren må velge en ny komplett release/main/recovery-kjede og bevare det
eksakte brukerbestilte hovedmålet.

Produksjons-UI viser alle fysisk validerte og bestilte kjedesteg: det aktive
steget, dependency-sperrede fremtidige steg og et annullert kort mens den røde
5+2-sekunders smuldre-/reflow-livssyklusen pågår. Bare kort med
`status=actionable`, klar handleradapter og minst én tillatt operativ handling
får `Utført`/`Annullert`; fremtidige steg har ingen handlingskontroller.
Handler-sperrede og diagnostic-only kandidater rendres ikke som operative kort.
Retarget kan fortsatt valideres i canonical-modellen, men produksjonskortene og
det grafiske verktøyet eksponerer ingen «Velg annet spor»-meny eller retarget-mål.

Rutetilgjengelighet skal vurderes per mulig adkomstende. Én sperret ende er ikke
en hard ruteblokk når en annen ende er fri. Det samme kriteriet brukes når et
kort tilbys, når `Utført` kvitteres og når et ledig mål velges med grafisk drag.
Mål som faktisk er belagt, og kilder som er fysisk sperret i alle ender, beholder
de eksisterende fail-closed-vaktene.

```sh
npm run test:sde:contracts
npm run test:sde:mutations
npm run test:sde:determinism
npm run test:sde:qualification
```

Strict-driverne leser `index.html`, trekker ut inline-skriptene og evaluerer de
faktiske production-funksjonene i en isolert VM. De kopierer ikke funksjonene
som testes. I og L er dokumenterte read-only audits. R er kjørbar gjennom
`INV-CANCEL-010`–`013`, X gjennom `INV-REROUTE-001`–`008`, og Y gjennom
`INV-EGRESS-001`–`015`, og Z gjennom `INV-EGRESS-016`–`021`.

CI-jobben har stabilt navn `permanent-regressions`, kjører
`npm run test:sde:strict`, har read-only permissions og feiler når én invariant
feiler. GitHub Actions kjører etter at en direkte push er
mottatt. For å blokkere endringer på `main` må repository-reglene kreve pull
request og statuschecken
`SDE permanent regression firewall / permanent-regressions`. Denne eksterne
regelen kan først aktiveres når workflowen finnes på default branch.
