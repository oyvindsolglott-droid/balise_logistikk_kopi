# SDE permanent regression firewall

Kjør alle permanente A–W-kontrakter fra reporoten:

```sh
npm test
```

Testløpet dekker gjeldende implementerte faser, tidligere generatorregresjoner
og negative kjøringer mot den historiske production-baselinen før hver relevant
rettelse. I og L er dokumenterte read-only audits. R er eksplisitt reservert og
ikke implementert; testen gjør dette gapet synlig i stedet for å late som det
finnes production-atferd å teste.

CI-jobben har stabilt navn `permanent-regressions`, read-only permissions og
feiler når én test feiler. GitHub Actions kjører etter at en direkte push er
mottatt. For å blokkere endringer på `main` må repository-reglene kreve pull
request og statuschecken
`SDE permanent regression firewall / permanent-regressions`. Denne eksterne
regelen kan først aktiveres når workflowen finnes på default branch.
