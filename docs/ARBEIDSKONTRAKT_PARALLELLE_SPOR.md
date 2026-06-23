# Arbeidskontrakt: parallelle spor

Denne kontrakten gjelder for videre arbeid med SDE / Skien sporplan.

Hovedregelen er enkel: frontend-løsningen og server-løsningen skal behandles som to parallelle opplegg inntil serverløsningen er komplett, testet og eksplisitt godkjent for kobling.

Denne kontrakten er en stoppregel. Hvis et arbeid kan blande sporene, skal arbeidet stoppes og avklares før endring.

## Status

- Frontend/GitHub Pages er fungerende bruksopplegg.
- Server er foundation-/testspor.
- Det finnes ingen godkjent kobling mellom frontend og server.
- Ingen senere fase skal anta at server er production-avhengighet for frontend.

## Spor A: stabil frontend / GitHub Pages

Dette er løsningen som skal fungere i daglig bruk.

- Frontend skal kunne brukes uten server.
- `index.html` og statiske data skal fortsatt være selvstendig fungerende.
- Ytelse, visning, SDE Skiftebevegelser, diagnosepaneler og operativ ergonomi prioriteres her.
- Frontend skal ikke få avhengighet til server før egen go/no-go-fase.
- PWA/serverkobling skal ikke aktiveres som bieffekt av annet arbeid.

Tillatte typiske filer:

- `index.html`
- `data/api_idag.json`
- `data/api_imorgen.json`
- frontend-dokumentasjon

Frontendarbeid skal ikke:

- endre `server/`
- starte, stoppe eller restarte server
- kjøre server-migration eller runner
- aktivere POST/write mot server
- koble PWA eller frontend til server

## Spor B: server foundation

Dette er et separat utviklings- og testspor.

- Serverarbeid skal foregå isolert fra den fungerende frontend-løsningen.
- Testserver skal bruke egen port, aldri production-port `8787`.
- Testserver skal bruke egen testdatabase, aldri production DB.
- Testflagg skal bare settes i eksplisitte testserver-faser.
- Production-write, migration, runner og operational writes krever egne go/no-go-faser.
- Serverarbeid skal ikke endre frontendens daglige virkemåte.

Tillatte typiske filer:

- `server/`
- server-dokumentasjon
- server-testverktøy

Serverarbeid skal ikke:

- endre `index.html`
- endre frontendens statiske dataflyt
- gjøre frontend avhengig av server
- kjøre testserver på production-port `8787`
- bruke production DB som testdatabase
- aktivere operational writes uten egen go/no-go

## Ikke koble sporene uten eksplisitt godkjenning

Følgende skal ikke gjøres uten egen, tydelig go/no-go:

- koble frontend/PWA til server
- gjøre server til krav for at frontend virker
- sende ekte SDE-actions fra frontend til server
- aktivere operational writes
- bruke production DB til test
- starte, stoppe eller restarte production som del av frontendarbeid
- blande frontendpatch og serverpatch i samme fase uten eksplisitt avtale

## Arbeidsregel for nye faser

Hver ny fase skal si hvilket spor den gjelder:

- `Frontend`: server røres ikke.
- `Server`: frontend røres ikke.
- `Integrasjon`: bare etter eksplisitt go/no-go.

Hvis en fase ikke sier dette tydelig, skal arbeidet stoppes og avklares før endring.

Før endring skal baseline avklares:

- riktig repo/path
- ren Git-status
- forventet HEAD/baseline
- hvilke filer som kan endres
- hvilke røde soner som gjelder

Hvis repo/path ikke matcher oppdraget, skal det rapporteres som NO-GO i stedet for å bruke en annen klon som erstatning.

## Koblingskriterier for senere integrasjon

Før frontend og server kan kobles, må minst dette være sant:

- frontend fungerer fortsatt stabilt alene
- server har egen testserver-plan og egen testdatabase
- server guards mot production-port og production-DB er verifisert
- production-status kan kontrolleres read-only før og etter
- rollback/avkobling er beskrevet
- score, sortering, kandidatmotor og aktive SDE-kort påvirkes ikke uten egen godkjenning

Inntil dette er godkjent, er riktig strategi: to parallelle opplegg som begge er tilgjengelige, men ikke avhengige av hverandre.

## Praktisk beslutning

Når det er tvil:

- Bevar fungerende frontend først.
- Hold serverarbeid isolert.
- Ikke koble sporene for å "bare teste".
- Ikke bruk production som testmiljø.
- Ikke la en serverfase endre brukeropplevelsen i frontend.
