# SDE permanent regression firewall

Strict tester alltid den faktiske `index.html` i den aktuelle worktree-en og
godtar ingen forventede feil:

```sh
npm test
# identisk eksplisitt kommando:
npm run test:sde:strict
```

Strict returnerer non-zero for hver brutt invariant. Den aktive lukkede
baselinen er 229/229 PASS med et tomt `failIds`-sett. Baseline-audit kjører strict
tre ganger og blir bare grønn når alle kjøringene har exit 0, eksakt samme
normaliserte semantikk, unike invariant-ID-er og 229/229 PASS:

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

`INV-EMPTY-DROP-001`–`009` låser at en fysisk tom, operativ target er
droppable som plan-intent selv når direkte adkomst er sperret. Target får
`AVAILABLE_WITH_RELIEF_PLANNING`, ikke rød fysisk-utilgjengelig status; draget
når canonical planner, begge adkomstretninger vurderes, og en gyldig løsning
projiseres atomisk som release/main/recovery med post-main recovery og uendret
actual-state før autorisert fullføring.

`INV-EGRESS-022` låser skjermbilderegresjonen 74-10 `5M → 6S`: et gammelt
annullert frigjøringssteg for 74-12 kan ikke gjenbrukes som aktiv identitet.
Planleggeren må velge en ny komplett release/main/recovery-kjede og bevare det
eksakte brukerbestilte hovedmålet.

De 14 `suffix-persistence`-invariantene låser fullført prefix og den gjenværende
MAIN/RECOVERY-suffixen etter autorisert fullføring av RELEASE. De dekker alle
seks slottene `4M`, `5M`, `6S`, `10S`, `11S` og `12S`, automatisk atomisk
replan fra fersk actual-state, trygg VN-prioritering via VS og uendret actual
placement før autorisert fullføring.

`INV-MULTILEG-001`–`026` låser den historiske fixturen
`SDE-ROUTE-12N-VIA-VS-TO-6S-V1`: nordlig adkomst til 6S er tilstrekkelig,
75-76 får midlertidig VN-holding via VS, MAIN beholder 12N→6S-intenten med
vending i VS, og RECOVERY returnerer VN→6N via VS. Den samme VS-ruteressursen
kan gjenbrukes dependency-sekvensielt som ACTIVE/DEFERRED uten samtidig
konflikt. Fjorten fokuserte multileg-mutanter må alle drepes uten timeout-kill.

`INV-ACTUAL-DRAG-001`–`010` låser den eksakte fixturen
`SDE-FALSE-ALREADY-AT-TARGET-12N-11N-V1`: grafisk source, canonical actual
source og planner bruker samme revision; reservasjon, planoverlay og historiske
kort er aldri actual placement; stale source repareres automatisk uten å miste
intent; duplikatplassering feiler lukket; og både 12N→11N og den eksisterende
12N→6S RELEASE→MAIN→RECOVERY-fixturen når canonical planner.

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

Helkjeden må i tillegg bevare den fysiske ruten gjennom hver mellomtilstand.
Den permanente route-continuity-testen låser den rapporterte 74-10-bestillingen
`10S → 5M`: 74-11 kan ikke flyttes midlertidig fra `5S` til `4M`, fordi 4M
er adkomstressurs for spor 5 og dermed ville sperret neste bestilte steg. SDE må
velge en annen komplett release/main/recovery-kjede, eller forbli diagnostic-only
dersom ingen slik kjede finnes.

## Gjenopprettede historiske kontrakter

Seks permanente harness-kontrakter hadde referanser til Git-objekter som ikke
lenger finnes lokalt eller på `origin`. De opprinnelige SHA-ene er bevart som
`UNAVAILABLE_HISTORICAL_REFERENCE`-proveniens i
`fixtures/historical-contract-recovery.json`; de brukes ikke lenger som
kjørbare input.

Hver kontrakt er i stedet bundet til den eksakte førsteforelderen til committen
som både reparerte produksjonsfeilen og registrerte harnesset i dagens lineære
repositoryhistorikk. Testen validerer ved hver kjøring at:

- pre-fix-baselinen er reparasjonscommittens eksakte førsteforelder,
- reparasjonscommitten er en forfader av kandidaten,
- commitdiffen omfatter `index.html`, kontraktregisteret og riktig harness,
- historisk `index.html` har låst SHA-256,
- dagens kilde består harnesset, og den historiske pre-fix-kilden blir drept.

Dette gjør kontraktene reproduserbare fra en full fersk klon uten private
objektlagre, uten syntetisk historikk og uten å gjøre manglende historikk til
PASS. De seks opprinnelige regresjonsformålene, symbolene, feilmønstrene og
historiske SHA-ene er dokumentert i recovery-registeret.

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
`INV-EGRESS-001`–`015`, Z gjennom `INV-EGRESS-016`–`021`, og empty-drop-
kontrakten gjennom `INV-EMPTY-DROP-001`–`009`.

CI-jobben har stabilt navn `permanent-regressions`, kjører
`npm run test:sde:strict`, har read-only permissions og feiler når én invariant
feiler. GitHub Actions kjører etter at en direkte push er
mottatt. For å blokkere endringer på `main` må repository-reglene kreve pull
request og statuschecken
`SDE permanent regression firewall / permanent-regressions`. Denne eksterne
regelen kan først aktiveres når workflowen finnes på default branch.
