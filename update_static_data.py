#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

HARDCODED_DEPARTURES: Dict[str, str] = {
    "802": "04:10",
    "852": "04:29",
    "804": "05:11",
    "854": "05:25",
    "2470": "05:27",
    "862": "05:37",
    "806": "06:07",
    "864": "06:17",
    "856": "06:25",
    "2472": "06:49",
    "808": "07:09",
    "2473": "07:31",
    "2474": "07:59",
    "810": "08:09",
    "2475": "09:00",
    "812": "09:09",
    "2477": "10:01",
    "814": "10:09",
    "816": "11:09",
    "2478": "12:01",
    "818": "12:09",
    "820": "13:09",
    "2480": "13:21",
    "2481": "14:04",
    "822": "14:09",
    "2482": "14:55",
    "824": "15:09",
    "2483": "15:39",
    "826": "16:08",
    "2484": "16:20",
    "2485": "17:03",
    "828": "17:08",
    "2486": "18:01",
    "830": "18:08",
    "2487": "19:02",
    "832": "19:09",
    "834": "20:09",
    "836": "21:09",
    "838": "22:09",
    "840": "23:09",
}

HARDCODED_ARRIVALS: Dict[str, Dict[str, object]] = {
    "2472": {"time": "06:47", "nextDay": False},
    "2473": {"time": "07:30", "nextDay": False},
    "873": {"time": "07:42", "nextDay": False},
    "2474": {"time": "07:57", "nextDay": False},
    "803": {"time": "08:07", "nextDay": False},
    "805": {"time": "08:53", "nextDay": False},
    "2475": {"time": "08:59", "nextDay": False},
    "807": {"time": "09:53", "nextDay": False},
    "2477": {"time": "10:00", "nextDay": False},
    "809": {"time": "10:53", "nextDay": False},
    "811": {"time": "11:53", "nextDay": False},
    "2478": {"time": "11:59", "nextDay": False},
    "813": {"time": "12:53", "nextDay": False},
    "2480": {"time": "13:19", "nextDay": False},
    "815": {"time": "13:53", "nextDay": False},
    "2481": {"time": "14:02", "nextDay": False},
    "2482": {"time": "14:49", "nextDay": False},
    "817": {"time": "14:53", "nextDay": False},
    "2483": {"time": "15:38", "nextDay": False},
    "819": {"time": "15:53", "nextDay": False},
    "2484": {"time": "16:18", "nextDay": False},
    "821": {"time": "16:30", "nextDay": False},
    "2485": {"time": "17:02", "nextDay": False},
    "853": {"time": "17:30", "nextDay": False},
    "861": {"time": "17:42", "nextDay": False},
    "823": {"time": "17:53", "nextDay": False},
    "2486": {"time": "17:59", "nextDay": False},
    "855": {"time": "18:30", "nextDay": False},
    "863": {"time": "18:42", "nextDay": False},
    "825": {"time": "18:53", "nextDay": False},
    "2487": {"time": "19:01", "nextDay": False},
    "827": {"time": "19:53", "nextDay": False},
    "829": {"time": "20:53", "nextDay": False},
    "2489": {"time": "20:59", "nextDay": False},
    "831": {"time": "21:53", "nextDay": False},
    "833": {"time": "22:53", "nextDay": False},
    "835": {"time": "23:53", "nextDay": False},
    "837": {"time": "00:50", "nextDay": True},
    "839": {"time": "01:45", "nextDay": True},
}

ALLOWED_MATERIAL_PREFIXES = ["69", "70", "74", "75"]
MATERIAL_RE = re.compile(r"\b(?:69|70|74|75)-\d{2}\b")


def normalize_train_no(value: object) -> str:
    s = str(value or "").strip()
    m = re.search(r"\d{2,6}", s)
    return m.group(0) if m else ""


def unique_material_hits(text: str) -> List[str]:
    return list(dict.fromkeys(MATERIAL_RE.findall(text or "")))


def find_first_material_line(text: str, keywords: Iterable[str]) -> List[str]:
    if not text:
        return []

    keyword_list = [str(k).lower() for k in keywords if str(k).strip()]
    if not keyword_list:
        return []

    for raw_line in text.splitlines():
        line = str(raw_line or "").strip()
        if not line:
            continue

        line_lower = line.lower()
        if any(keyword in line_lower for keyword in keyword_list):
            hits = unique_material_hits(line)
            if hits:
                return hits

    return []


def fetch_vehicle_maps_for_trains(train_numbers: Iterable[str], run_date: date) -> Tuple[Dict[str, str], Dict[str, str], Dict[str, str], Dict[str, str]]:
    vehicles: Dict[str, str] = {}
    departure_vehicles: Dict[str, str] = {}
    arrival_vehicles: Dict[str, str] = {}
    errors: Dict[str, str] = {}

    train_list = [normalize_train_no(train) for train in train_numbers]
    train_list = [train for train in train_list if train]

    if not train_list:
        return vehicles, departure_vehicles, arrival_vehicles, errors

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        for train_no in train_list:
            url = f"https://balise.no/tog/{train_no}/{run_date.isoformat()}"

            try:
                page.goto(url, wait_until="networkidle", timeout=30000)
                text = page.locator("body").inner_text()

                general_route_hits = (
                    find_first_material_line(text, ["Skien - Eidsvoll:"])
                    or find_first_material_line(text, ["Skien - Notodden:"])
                    or find_first_material_line(text, ["Porsgrunn - Eidsvoll:"])
                    or find_first_material_line(text, ["Porsgrunn - Notodden:"])
                    or find_first_material_line(text, ["Eidsvoll - Skien:"])
                    or find_first_material_line(text, ["Notodden - Skien:"])
                    or find_first_material_line(text, ["Eidsvoll - Porsgrunn:"])
                    or find_first_material_line(text, ["Notodden - Porsgrunn:"])
                )
                general_hits = general_route_hits or unique_material_hits(text)

                departure_hits = (
                    find_first_material_line(text, ["Porsgrunn - Eidsvoll:"])
                    or find_first_material_line(text, ["Porsgrunn - Notodden:"])
                    or find_first_material_line(text, ["Porsgrunn:"])
                    or general_hits
                )

                arrival_hits = (
                    find_first_material_line(text, ["Eidsvoll - Porsgrunn:"])
                    or find_first_material_line(text, ["Notodden - Porsgrunn:"])
                    or find_first_material_line(text, ["Porsgrunn:"])
                    or general_hits
                )

                if general_hits:
                    vehicles[train_no] = ", ".join(general_hits)
                else:
                    errors[train_no] = "Fant ingen kjøretøy i siden"

                if departure_hits:
                    departure_vehicles[train_no] = ", ".join(departure_hits)

                if arrival_hits:
                    arrival_vehicles[train_no] = ", ".join(arrival_hits)

            except Exception as exc:  # noqa: BLE001
                errors[train_no] = str(exc)

        browser.close()

    return vehicles, departure_vehicles, arrival_vehicles, errors


def all_relevant_trains() -> List[str]:
    return sorted(
        set(HARDCODED_DEPARTURES) | set(HARDCODED_ARRIVALS),
        key=lambda x: (int(x) if x.isdigit() else 999999, x),
    )


def build_payload(mode: str) -> Dict[str, object]:
    run_date = date.today() + timedelta(days=1) if mode == "imorgen" else date.today()
    trains = all_relevant_trains()
    vehicles, departure_vehicles, arrival_vehicles, vehicle_errors = fetch_vehicle_maps_for_trains(trains, run_date)

    return {
        "ok": True,
        "updatedAt": datetime.now().strftime("%d.%m.%Y %H:%M:%S"),
        "mode": mode,
        "date": run_date.isoformat(),
        "source": "balise.no",
        "requestedTrains": trains,
        "vehicles": vehicles,
        "departureVehicles": departure_vehicles,
        "arrivalVehicles": arrival_vehicles,
        "vehicleErrors": vehicle_errors,
        "departures": HARDCODED_DEPARTURES,
        "arrivals": HARDCODED_ARRIVALS,
        "allowedMaterialPrefixes": ALLOWED_MATERIAL_PREFIXES,
        "materialFormat": ["69-xx", "70-xx", "74-xx", "75-xx"],
    }


def write_payload(filename: str, payload: Dict[str, object]) -> None:
    path = DATA_DIR / filename
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {path}")


def main() -> None:
    write_payload("api_idag.json", build_payload("idag"))
    write_payload("api_imorgen.json", build_payload("imorgen"))


if __name__ == "__main__":
    main()
