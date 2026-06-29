#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import argparse
import tempfile
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
PAYLOAD_FILENAMES = {
    "idag": "api_idag.json",
    "imorgen": "api_imorgen.json",
}
DEFAULT_PAGE_GOTO_TIMEOUT_MS = 30000

OSLO_TZ = ZoneInfo("Europe/Oslo")
ARRIVAL_DAY_CUTOFF_HOUR = 7
DEPARTURE_NEXT_DAY_CUTOFF_HOUR = 15


def deadline_from_seconds(deadline_seconds: Optional[float]) -> Optional[float]:
    if deadline_seconds is None:
        return None

    if deadline_seconds <= 0:
        raise ValueError("--deadline-seconds must be greater than 0")

    return time.monotonic() + deadline_seconds


def remaining_timeout_ms(
    deadline_at: Optional[float],
    default_timeout_ms: int = DEFAULT_PAGE_GOTO_TIMEOUT_MS,
) -> int:
    if deadline_at is None:
        return default_timeout_ms

    remaining_seconds = deadline_at - time.monotonic()
    if remaining_seconds <= 0:
        raise TimeoutError("Static data refresh deadline exceeded")

    return max(1000, min(default_timeout_ms, int(remaining_seconds * 1000)))


def get_operational_tursatt_dates(now=None):
    """Returnerer operative datoer for Tursatt-grunnlag i Skien.

    00:00-06:59:
      ankomst = forrige kalenderdato
      avgang  = dagens kalenderdato

    07:00-14:59:
      ankomst = dagens kalenderdato
      avgang  = dagens kalenderdato

    15:00-23:59:
      ankomst = dagens kalenderdato
      avgang  = neste kalenderdato
    """
    current = now or datetime.now(OSLO_TZ)

    if current.hour < ARRIVAL_DAY_CUTOFF_HOUR:
        return {
            "arrival_date": current.date() - timedelta(days=1),
            "departure_date": current.date(),
            "window": "night_before_07",
        }

    if current.hour < DEPARTURE_NEXT_DAY_CUTOFF_HOUR:
        return {
            "arrival_date": current.date(),
            "departure_date": current.date(),
            "window": "day_07_to_15",
        }

    return {
        "arrival_date": current.date(),
        "departure_date": current.date() + timedelta(days=1),
        "window": "after_15",
    }


def get_operational_base_date(now=None):
    """Bakoverkompatibel alias: operativ ankomstdato."""
    return get_operational_tursatt_dates(now)["arrival_date"]


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
    "851": {"time": "16:30", "nextDay": False},
"821": {"time": "16:53", "nextDay": False},
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


def get_balise_train_lookup_candidates(train_no: str) -> List[str]:
    """Returner tognummer som skal prøves mot Balise for samme planlagte tog."""
    train = normalize_train_no(train_no)
    if not train:
        return []

    candidates = [train]

    if train.isdigit():
        number = int(train)
        if 800 <= number <= 899:
            candidates.append(f"80{train}")
            candidates.append(f"90{train}")

    return list(dict.fromkeys(candidates))


def has_arrival_route_to_skien_or_porsgrunn(text: str) -> bool:
    """Sjekk om Balise-teksten tydelig viser en ankomst mot Skien/Porsgrunn."""
    if not text:
        return False

    for raw_line in text.splitlines():
        line = str(raw_line or "").strip().lower()
        if not line:
            continue

        if re.search(r"-\s*(skien|porsgrunn)\s*:", line):
            return True

    return False


def has_balise_train_content(text: str) -> bool:
    """Sjekk om Balise-siden finnes for tog/dato selv om materiell mangler."""
    if not text or "Fant ingen tog på denne datoen" in text:
        return False

    return bool(re.search(r"\b(Skien|Porsgrunn|Eidsvoll|Notodden)\b", text))


def extract_vehicle_hits_from_balise_text(text: str) -> Tuple[List[str], List[str], List[str]]:
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

    return general_hits, departure_hits, arrival_hits


def fetch_vehicle_maps_for_trains(
    train_numbers: Iterable[str],
    run_date: date,
    deadline_at: Optional[float] = None,
) -> Tuple[
    Dict[str, str],
    Dict[str, str],
    Dict[str, str],
    Dict[str, str],
    Dict[str, str],
]:
    vehicles: Dict[str, str] = {}
    departure_vehicles: Dict[str, str] = {}
    arrival_vehicles: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    display_train_numbers: Dict[str, str] = {}

    train_list = [normalize_train_no(train) for train in train_numbers]
    train_list = [train for train in train_list if train]

    if not train_list:
        return vehicles, departure_vehicles, arrival_vehicles, errors, display_train_numbers

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        for train_no in train_list:
            remaining_timeout_ms(deadline_at)
            last_error = ""
            candidate_results = []

            for lookup_train_no in get_balise_train_lookup_candidates(train_no):
                timeout_ms = remaining_timeout_ms(deadline_at)
                url = f"https://balise.no/tog/{lookup_train_no}/{run_date.isoformat()}"

                try:
                    page.goto(url, wait_until="networkidle", timeout=timeout_ms)
                    text = page.locator("body").inner_text()

                    general_hits, departure_hits, arrival_hits = extract_vehicle_hits_from_balise_text(text)
                    has_train_content = has_balise_train_content(text)

                    if general_hits or departure_hits or arrival_hits or has_train_content:
                        candidate_results.append(
                            {
                                "lookup_train_no": lookup_train_no,
                                "general_hits": general_hits,
                                "departure_hits": departure_hits,
                                "arrival_hits": arrival_hits,
                                "has_train_content": has_train_content,
                                "is_arrival_route_to_base": has_arrival_route_to_skien_or_porsgrunn(text),
                            }
                        )

                    last_error = f"Fant ingen kjøretøy i siden {lookup_train_no}"

                except Exception as exc:  # noqa: BLE001
                    last_error = f"{lookup_train_no}: {exc}"

            selected = None

            train_number = int(train_no) if train_no.isdigit() else None
            should_prefer_alternate_departure = (
                train_number is not None
                and 800 <= train_number <= 899
                and train_no in HARDCODED_DEPARTURES
            )

            should_prefer_alternate_arrival = (
                train_number is not None
                and 800 <= train_number <= 899
                and train_no in HARDCODED_ARRIVALS
            )

            if should_prefer_alternate_departure:
                selected = next(
                    (
                        result
                        for result in candidate_results
                        if result["lookup_train_no"] != train_no
                        and result["departure_hits"]
                    ),
                    None,
                )

                if selected is None:
                    selected = next(
                        (
                            result
                            for result in candidate_results
                            if result["lookup_train_no"] != train_no
                            and result["has_train_content"]
                        ),
                        None,
                    )

            if selected is None and should_prefer_alternate_arrival:
                selected = next(
                    (
                        result
                        for result in candidate_results
                        if result["lookup_train_no"] != train_no
                        and result["is_arrival_route_to_base"]
                    ),
                    None,
                )

            if selected is None and candidate_results:
                selected = candidate_results[0]

            if selected is not None:
                lookup_train_no = selected["lookup_train_no"]
                if lookup_train_no != train_no:
                    display_train_numbers[train_no] = lookup_train_no

                if selected["general_hits"]:
                    vehicles[train_no] = ", ".join(selected["general_hits"])

                if selected["departure_hits"]:
                    departure_vehicles[train_no] = ", ".join(selected["departure_hits"])

                if selected["arrival_hits"]:
                    arrival_vehicles[train_no] = ", ".join(selected["arrival_hits"])

            if train_no not in vehicles and train_no not in departure_vehicles and train_no not in arrival_vehicles:
                lookup_train_no = selected["lookup_train_no"] if selected is not None else ""
                errors[train_no] = (
                    f"Fant ingen kjøretøy i siden {lookup_train_no}"
                    if lookup_train_no
                    else last_error or "Fant ingen kjøretøy i siden"
                )

        browser.close()

    return vehicles, departure_vehicles, arrival_vehicles, errors, display_train_numbers


def remap_train_keys(data: Dict[str, str], display_train_numbers: Dict[str, str]) -> Dict[str, str]:
    return {
        display_train_numbers.get(train_no, train_no): value
        for train_no, value in data.items()
    }


def all_relevant_trains() -> List[str]:
    return sorted(
        set(HARDCODED_DEPARTURES) | set(HARDCODED_ARRIVALS),
        key=lambda x: (int(x) if x.isdigit() else 999999, x),
    )


def build_payload(mode: str, deadline_at: Optional[float] = None) -> Dict[str, object]:
    operational_dates = get_operational_tursatt_dates()
    run_date = operational_dates["departure_date"] if mode == "imorgen" else operational_dates["arrival_date"]
    trains = all_relevant_trains()
    (
        vehicles,
        departure_vehicles,
        arrival_vehicles,
        vehicle_errors,
        display_train_numbers,
    ) = fetch_vehicle_maps_for_trains(trains, run_date, deadline_at=deadline_at)
    departure_display_map = (
        {
            train_no: display_train
            for train_no, display_train in display_train_numbers.items()
            if train_no in HARDCODED_DEPARTURES
        }
        if mode == "imorgen"
        else {}
    )
    arrival_display_map = {
        train_no: display_train
        for train_no, display_train in display_train_numbers.items()
        if train_no in HARDCODED_ARRIVALS
    }

    return {
        "ok": True,
        "updatedAt": datetime.now(OSLO_TZ).strftime("%d.%m.%Y %H:%M:%S"),
        "mode": mode,
        "date": run_date.isoformat(),
        "source": "balise.no",
        "requestedTrains": trains,
        "vehicles": remap_train_keys(vehicles, departure_display_map),
        "departureVehicles": remap_train_keys(departure_vehicles, departure_display_map),
        "arrivalVehicles": remap_train_keys(arrival_vehicles, departure_display_map),
        "vehicleErrors": remap_train_keys(vehicle_errors, departure_display_map),
        "departures": remap_train_keys(HARDCODED_DEPARTURES, departure_display_map),
        "arrivalDisplayTrainNumbers": arrival_display_map,
        "arrivals": HARDCODED_ARRIVALS,
        "allowedMaterialPrefixes": ALLOWED_MATERIAL_PREFIXES,
        "materialFormat": ["69-xx", "70-xx", "74-xx", "75-xx"],
    }


def validate_payload(mode: str, payload: object) -> Dict[str, object]:
    if mode not in PAYLOAD_FILENAMES:
        raise ValueError(f"Unknown payload mode: {mode}")

    if not isinstance(payload, dict):
        raise ValueError(f"{mode} payload must be a dict")

    for key in ("date", "updatedAt"):
        if not str(payload.get(key) or "").strip():
            raise ValueError(f"{mode} payload is missing {key}")

    return payload


def build_payloads(
    build_func: Callable[..., Dict[str, object]] = build_payload,
    deadline_at: Optional[float] = None,
    log: Callable[[str], None] = print,
) -> Dict[str, Dict[str, object]]:
    payloads: Dict[str, Dict[str, object]] = {}

    for mode in ("idag", "imorgen"):
        log(f"Build start: {mode}")
        payload = build_func(mode, deadline_at=deadline_at)
        payloads[mode] = validate_payload(mode, payload)
        log(f"Build complete: {mode} date={payloads[mode].get('date')}")

    return payloads


def write_temp_payload(path: Path, payload: Dict[str, object]) -> Path:
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temp_file:
        temp_file.write(json.dumps(payload, ensure_ascii=False, indent=2))
        return Path(temp_file.name)


def atomic_write_payloads(
    payloads: Dict[str, Dict[str, object]],
    output_dir: Path = DATA_DIR,
    log: Callable[[str], None] = print,
) -> None:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    temp_paths: List[Path] = []
    planned_replacements: List[Tuple[Path, Path]] = []

    try:
        for mode in ("idag", "imorgen"):
            payload = validate_payload(mode, payloads.get(mode))
            final_path = output_dir / PAYLOAD_FILENAMES[mode]
            temp_path = write_temp_payload(final_path, payload)
            temp_paths.append(temp_path)
            planned_replacements.append((temp_path, final_path))

        log("Write phase start")
        for temp_path, final_path in planned_replacements:
            temp_path.replace(final_path)
            temp_paths.remove(temp_path)
            log(f"Wrote {final_path}")
        log("Write phase complete")

    finally:
        for temp_path in temp_paths:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def refresh_static_data(
    output_dir: Path = DATA_DIR,
    dry_run: bool = False,
    deadline_seconds: Optional[float] = None,
    build_func: Callable[..., Dict[str, object]] = build_payload,
    log: Callable[[str], None] = print,
) -> Dict[str, Dict[str, object]]:
    deadline_at = deadline_from_seconds(deadline_seconds)
    payloads = build_payloads(build_func=build_func, deadline_at=deadline_at, log=log)

    if dry_run:
        log("Dry-run complete: no data files replaced")
        return payloads

    atomic_write_payloads(payloads, output_dir=Path(output_dir), log=log)
    return payloads


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh static Balise data files.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and validate payloads without replacing data files.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DATA_DIR,
        help="Directory to write api_idag.json and api_imorgen.json.",
    )
    parser.add_argument(
        "--deadline-seconds",
        type=float,
        default=None,
        help="Optional global deadline for the whole refresh.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    refresh_static_data(
        output_dir=args.output_dir,
        dry_run=args.dry_run,
        deadline_seconds=args.deadline_seconds,
    )


if __name__ == "__main__":
    main()
