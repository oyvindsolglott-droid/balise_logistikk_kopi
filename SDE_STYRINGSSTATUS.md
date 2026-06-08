# Skien sporplan / SDE – styrende status og videre arbeid

Prosjektet er `oyvindsolglott-droid/balise_logistikk_kopi`, lokal mappe `~/Downloads/balise_logistikk_kopi`, hovedfil `index.html`.

Arbeid skal gjøres kirurgisk med små endringer:
- `git diff --check`
- eksplisitt staging med `git add index.html`
- test før commit og push
- aldri `git add .`

## Baseline

Nyeste baseline: commit `0908eec` – "Samle spor 3-sekvens for 802 og 852", pushet til `origin/main`, repo rent.

Viktig tidligere baseline: `c776edc` – "Avvis nordlig førstefylling og reserver 1S for 855".

## SDE Skiftebevegelser

SDE Skiftebevegelser har nå korrekt samlet spor 3-produksjonssekvens:

- 802/1 → 3S
- 802/2 → 3M
- 852/1 → 3N

Disse skal behandles som samlet Spor 3-produksjonsbehov, ikke blandes med vanlig ankomstbasert nattparkering.

## Nordlig førstefylling

4N avvises når 4M/4S er ledige, og 5N avvises når 5M/5S er ledige, fordi innskifting normalt skjer fra nord/vaskemaskinen og N først kan blokkere dypere posisjoner.

4M/5M vurderes forsiktig når S er ledig. 4S/5S er dype/sørlige plasseringer som kan bevare fleksibilitet.

## 855/10855-regel

Når 855 faktisk finnes som ankomst i datagrunnlaget, skal 1S reserveres.

855 skal skiftes inn i spor 1 etter ankomst i spor 2 eller 3, stå i 1S og gå videre som 10855 kl. 20:14.

1S skal da ikke foreslås til andre kjøretøy i konflikt med denne flyten.

## SDE-prioritering

Før spor reserveres skal behov prioriteres slik:

1. servicebehov
2. tidlig avgang
3. kjent avgang
4. ukoblet/fleksibel nattparkering

Ukoblet/fleksibel nattparkering skal ikke blokkere viktig produksjon.

## Videre arbeid nå

Vi lager en profesjonell PowerPoint-introduksjon for SDE/DROPS, ikke en PDF først.

Godkjente sider:

1. SDE / Skien Decision Engine – “Fra fragmentert samhandling til ett felles operativt grensesnitt”.
2. Dagens utfordring – Vy får togproduksjonen til å fungere, men koordinering er avhengig av menneskelig oversikt, muntlig kommunikasjon og spredt informasjon. Den egentlige utfordringen er å forstå helheten raskt nok.
3. Små beslutninger. Store ringvirkninger. Feil sporvalg under hensetting kan påvirke neste skiftebevegelse, neste avgang, verkstedflyt, materielltilgjengelighet og ressursbruk.
4. SDE samler det operative bildet – kjøretøy, tursatte avganger, skiftebehov, verkstedflyt, verkstedbestillinger og umiddelbare kjøretøystatusendringer. DROPS/TXP får bedre statusoversikt. Verksted skal ha avgrenset grensesnitt for sitt ansvar, ikke full operativ flyt.
5. Riktig informasjon til riktig rolle – DROPS/TXP, skiftere og verksted får relevant informasjon innenfor eget ansvar.

Senere i presentasjonen skal vi ha egne sider om:
- datagrunnlag/input
- hvorfor dagens kildegrunnlag ikke er holdbart for operativ drift
- verkstedtid, kost–nytteanalyse og ressursutnyttelse
- hvorfor SDE/DROPS ikke erstatter Tog i ro
