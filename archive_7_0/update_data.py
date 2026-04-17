from __future__ import annotations

import argparse
import sqlite3
from datetime import date, timedelta

from balise_client import (
    BaliseClient,
    init_db,
    upsert_train_bundle,
    upsert_vehicle_composition,
    upsert_vehicle_sets,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hent tog- og materielloversikter fra Balise til lokal SQLite-database.")
    parser.add_argument("--db", default="balise_logistikk.db", help="Sti til SQLite-database")
    parser.add_argument("--vehicle-type", default="70", help="Materielltype som skal hentes, f.eks. 70")
    parser.add_argument("--vehicle-set", action="append", default=["70-12"], help="Ett eller flere sett-id-er, kan oppgis flere ganger")
    parser.add_argument("--train", action="append", default=["2470"], help="Ett eller flere tognumre, kan oppgis flere ganger")
    parser.add_argument("--days", type=int, default=3, help="Hvor mange dager frem fra i dag som skal forsøkes hentet for tog")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    conn = sqlite3.connect(args.db)
    init_db(conn)

    client = BaliseClient()

    sets = client.fetch_type_sets(args.vehicle_type)
    upsert_vehicle_sets(conn, sets)
    print(f"Lagret {len(sets)} sett for type {args.vehicle_type}")

    for set_id in sorted(set(args.vehicle_set)):
        composition, last_seen = client.fetch_composition(set_id)
        upsert_vehicle_composition(conn, composition, last_seen=last_seen)
        print(f"Lagret sammensetning for {set_id}: {len(composition)} vogner")

    today = date.today()
    for offset in range(args.days):
        run_date = today + timedelta(days=offset)
        for train_no in sorted(set(args.train)):
            try:
                run, links, stops = client.fetch_train(train_no, run_date)
                upsert_train_bundle(conn, run, links, stops)
                print(f"Lagret tog {train_no} {run_date.isoformat()}: {len(links)} materiellkoblinger, {len(stops)} stopp")
            except Exception as exc:
                print(f"ADVARSEL: kunne ikke hente tog {train_no} {run_date.isoformat()}: {exc}")

    conn.close()


if __name__ == "__main__":
    main()
