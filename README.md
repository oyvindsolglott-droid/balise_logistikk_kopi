# Balise-logistikkprototype

Dette er en første prototype for å bygge en lokal logistikkoversikt basert på publiserte sider fra Balise.

## Hva den gjør

- henter liste over sett for en materielltype, for eksempel Type 70
- henter sammensetning for ett eller flere sett, for eksempel 70-12
- henter togside for valgte tognummer og datoer
- lagrer alt til en lokal SQLite-database
- viser resultatet i et enkelt webdashboard

## Viktige forbehold

Dette er bevisst bygget som et **observasjonssystem**, ikke som en full fasit.

- Balise opplyser at ikke alle tog er synlige offentlig.
- HTML-strukturen kan endres.
- Noen togvisninger ser ut til å laste rutedetaljer dynamisk, så stopp-tabellen kan bli tom selv når tog/materiell er funnet.
- URL-mønster og datoformat på togvisningene kan måtte justeres videre når du tester mot de togene du faktisk følger.

## Installering

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Hent data

Eksempel:

```bash
python update_data.py --vehicle-type 70 --vehicle-set 70-12 --train 2470 --train 856 --days 5
```

Dette oppretter eller oppdaterer databasen `balise_logistikk.db`.

## Start dashboard

```bash
python app.py
```

Åpne deretter `http://127.0.0.1:5000` i nettleseren.

## Forslag til neste steg

1. Legg til en scheduler, for eksempel cron eller Task Scheduler.
2. Lag en tabell for endringshistorikk, slik at systemet varsler når materiell på et tog skifter.
3. Utvid med egne regler for togene du bryr deg om mest.
4. Bytt parseren over til en mer direkte JSON-kilde dersom du senere finner et stabilt API eller nettverkskall.

## Filer

- `balise_client.py` – henting, parsing og databasefunksjoner
- `update_data.py` – kommandolinjejobb for oppdatering
- `app.py` – enkelt dashboard i Flask
- `requirements.txt` – avhengigheter
