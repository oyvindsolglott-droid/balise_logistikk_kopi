TOGPLASSERING SKIEN – SKANNER v0.3
==================================

Hva som er nytt i v0.3
----------------------
- Den gamle, jevnt fordelte «rad-zoomen» er fjernet.
- Programmet finner de FAKTISKE trykte tabellstrekene først.
- Det krever 9 kolonnelinjer og 31 horisontale linjer for denne skjema-malen.
- Perspektivet beregnes fra de fysiske linjene og arket rettes ut.
- AI får bare eksakte rad-/celleutsnitt etter geometrikontroll.
- LOW geometri sperrer AI-lesing (fail-closed).
- Ved dobbel AI-lesing skjules ikke uenigheter: de markeres for menneskelig kontroll.

Start på Mac
------------
1. Pakk ut ZIP-filen.
2. Dobbeltklikk Start_Togplassering_Scanner.command.
3. Første oppstart kan installere Python-pakker og krever internett.
4. Nettleseren åpner http://127.0.0.1:8788

Bruk
----
1. Velg bilde eller «Bruk eksempelbildet».
2. Trykk «Kontroller geometri».
3. Se fanen «Linjer på original». Grønne kolonnelinjer og oransje radlinjer skal ligge på de faktiske strekene.
4. Bare hvis geometrien er HIGH/MEDIUM aktiveres «Les skjema med AI».
5. Legg inn OpenAI API-nøkkel, eller sett OPENAI_API_KEY i terminalmiljøet.
6. Kontroller markerte felt etter skanning, og eksporter CSV/JSON.

Avgrensning
-----------
v0.3 er spesialisert for den faste «TOGPLASSERING SKIEN»-malen. Ved sterkt beskåret,
rotert eller delvis skjult skjema skal den heller feile enn å late som geometri er korrekt.
Det er tilsiktet.

