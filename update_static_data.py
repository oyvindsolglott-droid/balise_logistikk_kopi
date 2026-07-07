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
MATERIAL_TYPE_RE = re.compile(
    r"\b(?:materiell(?:type)?|type|togsett|kjøretøytype)\s*:?\s*(?:BM|Type\s*)?(69|70|74|75)\b",
    re.IGNORECASE,
)
MATERIAL_CLASS_RE = re.compile(r"\b(69|70|74|75)\s*E?\b", re.IGNORECASE)


def normalize_train_no(value: object) -> str:
    s = str(value or "").strip()
    m = re.search(r"\d{2,6}", s)
    return m.group(0) if m else ""


def unique_material_hits(text: str) -> List[str]:
    return list(dict.fromkeys(MATERIAL_RE.findall(text or "")))


def material_type_hits(text: str) -> List[str]:
    hits = []
    for match in MATERIAL_TYPE_RE.finditer(text or ""):
        material_type = match.group(1)
        value = f"{material_type}/ukjent individ"
        hits.append(value)
    if hits:
        return hits

    for match in MATERIAL_CLASS_RE.finditer(text or ""):
        material_type = match.group(1)
        value = f"{material_type}/ukjent individ"
        hits.append(value)
    return hits


def material_or_type_hits(text: str) -> List[str]:
    return unique_material_hits(text) or material_type_hits(text)


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
            hits = material_or_type_hits(line)
            if hits:
                return hits

    return []


def find_first_material_route_line(
    text: str,
    origin_keywords: Iterable[str] = (),
    destination_keywords: Iterable[str] = (),
    route_keywords: Iterable[str] = (),
) -> List[str]:
    if not text:
        return []

    origin_list = [str(k).lower() for k in origin_keywords if str(k).strip()]
    destination_list = [str(k).lower() for k in destination_keywords if str(k).strip()]
    route_list = [str(k).lower() for k in route_keywords if str(k).strip()]

    for raw_line in text.splitlines():
        line = str(raw_line or "").strip()
        if not line:
            continue

        prefix = line.split(":", 1)[0].strip()
        match = re.match(r"^(.+?)\s*-\s*(.+)$", prefix)
        if not match:
            continue

        route_lower = prefix.lower()
        origin_lower = match.group(1).strip().lower()
        destination_lower = match.group(2).strip().lower()
        origin_match = bool(origin_list) and any(
            keyword in origin_lower for keyword in origin_list
        )
        destination_match = bool(destination_list) and any(
            keyword in destination_lower for keyword in destination_list
        )
        route_match = bool(route_list) and any(
            keyword in route_lower for keyword in route_list
        )

        if origin_match or destination_match or route_match:
            hits = material_or_type_hits(line)
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
        if 2400 <= number <= 2499:
            candidates.append(f"9{train}")
            candidates.append(f"1{train}")

    return list(dict.fromkeys(candidates))


def has_arrival_route_to_skien_or_porsgrunn(text: str) -> bool:
    """Sjekk om Balise-teksten tydelig viser en ankomst mot Skien/Porsgrunn."""
    if not text:
        return False

    for raw_line in text.splitlines():
        line = str(raw_line or "").strip()
        if not line:
            continue

        prefix = line.split(":", 1)[0].strip()
        match = re.match(r"^(.+?)\s*-\s*(.+)$", prefix)
        if not match:
            continue

        destination_lower = match.group(2).strip().lower()
        if "skien" in destination_lower or "porsgrunn" in destination_lower:
            return True

    return False


def first_time_value(text: object) -> Optional[str]:
    match = re.search(r"\b\d{1,2}:\d{2}\b", str(text or ""))
    return match.group(0) if match else None


def extract_skien_station_stop(text: str) -> Dict[str, Optional[str]]:
    """Returner planlagt ankomst/avgang fra Balise-raden for Skien/SKN."""
    result: Dict[str, Optional[str]] = {"arrival": None, "departure": None}
    if not text:
        return result

    for raw_line in text.splitlines():
        parts = [part.strip() for part in str(raw_line or "").split("\t")]
        if len(parts) < 5:
            continue

        for index, part in enumerate(parts):
            station = part.lstrip("- ").strip().lower()
            if station not in {"skien", "skn"}:
                continue

            arrival_index = index + 2
            departure_index = index + 4
            if arrival_index < len(parts):
                result["arrival"] = first_time_value(parts[arrival_index])
            if departure_index < len(parts):
                result["departure"] = first_time_value(parts[departure_index])
            return result

    return result


def has_arrival_stop_at_skien(text: str) -> bool:
    return bool(extract_skien_station_stop(text).get("arrival"))


def has_departure_stop_at_skien(text: str) -> bool:
    return bool(extract_skien_station_stop(text).get("departure"))


def has_balise_train_content(text: str) -> bool:
    """Sjekk om Balise-siden finnes for tog/dato selv om materiell mangler."""
    if not text or "Fant ingen tog på denne datoen" in text:
        return False

    return bool(re.search(r"\b(Skien|Porsgrunn|Eidsvoll|Notodden)\b", text))


def extract_vehicle_hits_from_balise_text(text: str) -> Tuple[List[str], List[str], List[str]]:
    general_route_hits = (
        find_first_material_route_line(text, destination_keywords=["Skien"])
        or find_first_material_route_line(text, origin_keywords=["Skien"])
        or find_first_material_route_line(text, origin_keywords=["Porsgrunn"])
        or find_first_material_route_line(text, destination_keywords=["Porsgrunn"])
    )
    general_hits = general_route_hits or unique_material_hits(text) or material_type_hits(text)

    departure_hits = (
        find_first_material_route_line(text, origin_keywords=["Skien"])
    )

    arrival_hits = (
        find_first_material_route_line(text, destination_keywords=["Skien"])
        or find_first_material_route_line(text, destination_keywords=["Porsgrunn"])
        or find_first_material_line(text, ["Porsgrunn:"])
    )

    return general_hits, departure_hits, arrival_hits


def select_balise_candidate_result(train_no: str, candidate_results: List[Dict[str, object]]):
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
                and result.get("skien_departure_time")
                and (result["departure_hits"] or result["general_hits"])
            ),
            None,
        )

        if selected is not None:
            return selected

        selected = next(
            (
                result
                for result in candidate_results
                if result["lookup_train_no"] != train_no
                and result.get("skien_departure_time")
            ),
            None,
        )

        if selected is not None:
            return selected

    if should_prefer_alternate_arrival:
        selected = next(
            (
                result
                for result in candidate_results
                if result["lookup_train_no"] != train_no
                and result.get("skien_arrival_time")
                and (result["arrival_hits"] or result["general_hits"])
            ),
            None,
        )

        if selected is not None:
            return selected

        selected = next(
            (
                result
                for result in candidate_results
                if result["lookup_train_no"] != train_no
                and result.get("skien_arrival_time")
            ),
            None,
        )

        if selected is not None:
            return selected

    return candidate_results[0] if candidate_results else None


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
    validated_departure_display_numbers: Dict[str, str] = {}
    validated_arrival_display_numbers: Dict[str, str] = {}
    departure_times: Dict[str, str] = {}
    arrival_times: Dict[str, str] = {}

    train_list = [normalize_train_no(train) for train in train_numbers]
    train_list = [train for train in train_list if train]

    if not train_list:
        return (
            vehicles,
            departure_vehicles,
            arrival_vehicles,
            errors,
            display_train_numbers,
            validated_departure_display_numbers,
            validated_arrival_display_numbers,
            departure_times,
            arrival_times,
        )

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
                    skien_stop = extract_skien_station_stop(text)

                    if general_hits or departure_hits or arrival_hits or has_train_content:
                        candidate_results.append(
                            {
                                "lookup_train_no": lookup_train_no,
                                "general_hits": general_hits,
                                "departure_hits": departure_hits,
                                "arrival_hits": arrival_hits,
                                "has_train_content": has_train_content,
                                "skien_arrival_time": skien_stop.get("arrival"),
                                "skien_departure_time": skien_stop.get("departure"),
                            }
                        )

                    last_error = f"Fant ingen kjøretøy i siden {lookup_train_no}"

                except Exception as exc:  # noqa: BLE001
                    last_error = f"{lookup_train_no}: {exc}"

            selected = select_balise_candidate_result(train_no, candidate_results)

            if selected is not None:
                lookup_train_no = selected["lookup_train_no"]
                if lookup_train_no != train_no:
                    display_train_numbers[train_no] = lookup_train_no

                if selected.get("skien_departure_time"):
                    validated_departure_display_numbers[train_no] = str(lookup_train_no)
                    departure_times[train_no] = str(selected["skien_departure_time"])

                if selected.get("skien_arrival_time"):
                    validated_arrival_display_numbers[train_no] = str(lookup_train_no)
                    arrival_times[train_no] = str(selected["skien_arrival_time"])

                if selected["general_hits"]:
                    vehicles[train_no] = ", ".join(selected["general_hits"])

                if selected.get("skien_departure_time"):
                    departure_hits = selected["departure_hits"] or selected["general_hits"]
                    if departure_hits:
                        departure_vehicles[train_no] = ", ".join(departure_hits)

                if selected.get("skien_arrival_time"):
                    arrival_hits = selected["arrival_hits"] or selected["general_hits"]
                    if arrival_hits:
                        arrival_vehicles[train_no] = ", ".join(arrival_hits)

            if (
                train_no not in vehicles
                and train_no not in departure_vehicles
                and train_no not in arrival_vehicles
                and train_no not in departure_times
                and train_no not in arrival_times
            ):
                lookup_train_no = selected["lookup_train_no"] if selected is not None else ""
                errors[train_no] = (
                    f"Fant ingen kjøretøy i siden {lookup_train_no}"
                    if lookup_train_no
                    else last_error or "Fant ingen kjøretøy i siden"
                )

        browser.close()

    return (
        vehicles,
        departure_vehicles,
        arrival_vehicles,
        errors,
        display_train_numbers,
        validated_departure_display_numbers,
        validated_arrival_display_numbers,
        departure_times,
        arrival_times,
    )


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
        validated_departure_display_numbers,
        validated_arrival_display_numbers,
        departure_times,
        arrival_times,
    ) = fetch_vehicle_maps_for_trains(trains, run_date, deadline_at=deadline_at)
    validated_departures = {
        train_no: departure_times[train_no]
        for train_no in HARDCODED_DEPARTURES
        if train_no in validated_departure_display_numbers
    }
    validated_arrivals = {
        train_no: {
            "time": arrival_times[train_no],
            "nextDay": bool(HARDCODED_ARRIVALS.get(train_no, {}).get("nextDay", False)),
        }
        for train_no in HARDCODED_ARRIVALS
        if train_no in validated_arrival_display_numbers
    }
    departure_display_map = {
        train_no: display_train
        for train_no, display_train in validated_departure_display_numbers.items()
        if train_no in HARDCODED_DEPARTURES
        and display_train != train_no
    }
    arrival_display_map = {
        train_no: display_train
        for train_no, display_train in validated_arrival_display_numbers.items()
        if train_no in HARDCODED_ARRIVALS
        and display_train != train_no
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
        "arrivalVehicles": remap_train_keys(arrival_vehicles, arrival_display_map),
        "vehicleErrors": remap_train_keys(vehicle_errors, departure_display_map),
        "departures": remap_train_keys(validated_departures, departure_display_map),
        "arrivalDisplayTrainNumbers": arrival_display_map,
        "arrivals": remap_train_keys(validated_arrivals, arrival_display_map),
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
