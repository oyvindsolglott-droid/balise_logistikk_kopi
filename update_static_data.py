#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import argparse
import tempfile
import time
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
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


def normalize_balise_platform_track(value: object) -> Optional[str]:
    match = re.fullmatch(r"(?:spor\s*)?([23])", str(value or "").strip(), re.IGNORECASE)
    return match.group(1) if match else None


def extract_skien_station_stop(text: str) -> Dict[str, Optional[str]]:
    """Returner bakoverkompatible tider og eksplisitt spor fra Skien-raden."""
    result: Dict[str, Optional[str]] = {
        "arrival": None,
        "departure": None,
        "platformTrack": None,
        "rawTrackField": None,
        "rawTrackValue": None,
    }
    if not text:
        return result

    for raw_line in text.splitlines():
        parts = [part.strip() for part in str(raw_line or "").split("\t")]
        if len(parts) < 2:
            continue

        for index, part in enumerate(parts):
            station = part.lstrip("- ").strip().lower()
            if station not in {"skien", "skn"}:
                continue

            track_index = index + 1
            arrival_index = index + 2
            departure_index = index + 4
            if track_index < len(parts):
                raw_track = parts[track_index]
                result["rawTrackField"] = "stop_track" if raw_track else None
                result["rawTrackValue"] = raw_track or None
                result["platformTrack"] = normalize_balise_platform_track(raw_track)
            if arrival_index < len(parts):
                result["arrival"] = first_time_value(parts[arrival_index])
            if departure_index < len(parts):
                result["departure"] = first_time_value(parts[departure_index])
            return result

    return result


def extract_balise_route_info(html: str) -> Dict[str, str]:
    """Les den forekomstspesifikke ruteidentiteten fra Balise-sidepayloaden."""
    source = str(html or "")

    def string_field(name: str) -> str:
        match = re.search(rf"\b{re.escape(name)}:\s*\"([^\"]*)\"", source)
        return match.group(1).strip() if match else ""

    def number_field(name: str) -> str:
        match = re.search(rf"\b{re.escape(name)}:\s*(\d+)", source)
        return match.group(1) if match else ""

    return {
        "routeId": string_field("route_id"),
        "trainNumber": number_field("route_number"),
        "operationalDate": string_field("route_date"),
        "origin": string_field("origin"),
        "destination": string_field("destination"),
    }


def normalize_balise_source_datetime(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return raw
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=OSLO_TZ)
    return parsed.astimezone(OSLO_TZ).isoformat(timespec="seconds")


def fetch_balise_route_stops(
    page,
    route_id: str,
    deadline_at: Optional[float] = None,
) -> Tuple[List[Dict[str, object]], str]:
    """Hent read-only stoppdata for nøyaktig ruteidentitet."""
    clean_route_id = str(route_id or "").strip()
    if not clean_route_id:
        return [], ""

    response = page.context.request.get(
        f"https://balise.no/api/train/stops?route={clean_route_id}",
        timeout=remaining_timeout_ms(deadline_at),
    )
    try:
        if not response.ok:
            return [], ""
        payload = response.json()
        rows = payload.get("data") if isinstance(payload, dict) else None
        source_updated_at = normalize_balise_source_datetime(response.headers.get("date"))
        return ([row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []), source_updated_at
    finally:
        response.dispose()


def extract_route_vehicle_hits(
    rows: Iterable[Dict[str, object]],
    route_id: str,
    station_name: str = "Skien",
) -> List[str]:
    """Returner kjøretøyrekkefølgen for ett bestemt stopp på én Balise-rute."""
    clean_route_id = str(route_id or "").strip()
    clean_station = str(station_name or "").strip().lower()
    if not clean_route_id or not clean_station:
        return []

    matching_rows = [
        row
        for row in rows
        if isinstance(row, dict)
        and str(row.get("sv_route") or "").strip() == clean_route_id
        and str(row.get("station_name") or "").strip().lower() == clean_station
    ]
    matching_rows.sort(
        key=lambda row: (
            int(row.get("position"))
            if str(row.get("position") if row.get("position") is not None else "").strip().isdigit()
            else 999999,
            str(row.get("vehicle") or ""),
        )
    )

    hits = []
    for row in matching_rows:
        vehicle = str(row.get("vehicle") or "").strip()
        if MATERIAL_RE.fullmatch(vehicle) and vehicle not in hits:
            hits.append(vehicle)
    return hits


def route_has_station(
    stops: Iterable[Dict[str, object]],
    station_name: str,
    station_ref: str = "",
) -> bool:
    clean_name = str(station_name or "").strip().lower()
    clean_ref = str(station_ref or "").strip().upper()
    return any(
        isinstance(row, dict)
        and (
            (clean_name and str(row.get("station_name") or "").strip().lower() == clean_name)
            or (clean_ref and str(row.get("station_ref") or "").strip().upper() == clean_ref)
        )
        for row in stops
    )


def resolve_departure_vehicle_composition(
    selected: Dict[str, object],
    route_info: Dict[str, str],
) -> Dict[str, object]:
    """Avgrens faktisk Skien-avgang med samme routeId observert ved Porsgrunn."""
    route_id = str(route_info.get("routeId") or "").strip()
    skien_vehicles = list(selected.get("route_vehicle_hits") or [])
    route_vehicle_rows_present = "route_vehicle_rows" in selected
    route_stops_present = "route_stops" in selected

    # Eldre, direkte enhetstestkandidater mangler rå radkontekst. De beholder
    # den allerede forekomstbundne Skien-kontrakten; productionkandidater har
    # alltid begge nøklene og går fail-closed dersom API-konteksten mangler.
    if not route_vehicle_rows_present and not route_stops_present:
        return {
            "vehiclesObservedAtSkien": skien_vehicles,
            "vehiclesContinuingAtPorsgrunn": [],
            "departureVehicles": skien_vehicles,
            "detachedAtSkien": [],
            "vehicleResolutionSource": "skien_occurrence_compatibility",
            "vehicleError": "",
        }

    route_vehicle_rows = list(selected.get("route_vehicle_rows") or [])
    route_stops = list(selected.get("route_stops") or [])
    skien_vehicles = extract_route_vehicle_hits(route_vehicle_rows, route_id, "Skien")
    porsgrunn_vehicles = extract_route_vehicle_hits(route_vehicle_rows, route_id, "Porsgrunn")
    base = {
        "vehiclesObservedAtSkien": skien_vehicles,
        "vehiclesContinuingAtPorsgrunn": porsgrunn_vehicles,
        "departureVehicles": [],
        "detachedAtSkien": [],
        "vehicleResolutionSource": "unresolved_porsgrunn_occurrence",
        "vehicleError": "",
    }

    if not route_has_station(route_stops, "Porsgrunn", "PG"):
        base["vehicleError"] = (
            f"Uavklart forekomstbundet materiell: routeId {route_id}; "
            "samme togforekomst kan ikke bindes til et Porsgrunn-stopp."
        )
        return base
    if not skien_vehicles:
        base["vehicleError"] = (
            f"Uavklart forekomstbundet materiell: routeId {route_id}; "
            "den eksakte Skien-avgangen har ingen kjøretøydata."
        )
        return base
    if not porsgrunn_vehicles:
        base["vehicleError"] = (
            f"Uavklart forekomstbundet materiell: routeId {route_id}; "
            "Porsgrunn-sammensetningen mangler for samme togforekomst."
        )
        return base

    skien_set = set(skien_vehicles)
    if not set(porsgrunn_vehicles).issubset(skien_set):
        base["vehicleError"] = (
            f"Uavklart forekomstbundet materiell: routeId {route_id}; "
            "Porsgrunn-sammensetningen er ikke en gyldig delmengde av Skien-sammensetningen."
        )
        return base

    base["departureVehicles"] = porsgrunn_vehicles
    base["detachedAtSkien"] = [
        vehicle
        for vehicle in skien_vehicles
        if vehicle not in set(porsgrunn_vehicles)
    ]
    base["vehicleResolutionSource"] = "porsgrunn_occurrence_subset"
    return base


def fetch_balise_route_vehicles(
    page,
    route_id: str,
    deadline_at: Optional[float] = None,
) -> Tuple[List[Dict[str, object]], str]:
    """Hent read-only materiell for nøyaktig routeId, uavhengig av DOM-timing."""
    clean_route_id = str(route_id or "").strip()
    if not clean_route_id:
        return [], ""

    response = page.context.request.get(
        f"https://balise.no/api/train/vehicles?route={clean_route_id}",
        timeout=remaining_timeout_ms(deadline_at),
    )
    try:
        if not response.ok:
            return [], ""
        payload = response.json()
        rows = payload.get("data") if isinstance(payload, dict) else None
        source_updated_at = normalize_balise_source_datetime(response.headers.get("date"))
        return ([row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []), source_updated_at
    finally:
        response.dispose()


def build_skien_movement_context(
    route_info: Dict[str, str],
    stops: Iterable[Dict[str, object]],
    source_observed_at: str,
    source_updated_at: str = "",
) -> Optional[Dict[str, object]]:
    """Bind faktisk Skien-spor til én rute- og stoppforekomst, ellers fail-close."""
    skien_stops = [
        row
        for row in stops
        if str(row.get("station_ref") or "").strip().upper() == "SKN"
        or str(row.get("station_name") or "").strip().lower() == "skien"
    ]
    if len(skien_stops) != 1:
        return None

    stop = skien_stops[0]
    route_id = str(route_info.get("routeId") or "").strip()
    train_number = normalize_train_no(route_info.get("trainNumber"))
    operational_date = str(route_info.get("operationalDate") or "").strip()
    stop_id = str(stop.get("stop_id") or "").strip()
    planned_arrival = str(stop.get("stop_planned_arrival") or "").strip()
    planned_arrival_time = first_time_value(planned_arrival)
    if not route_id or not train_number or not operational_date or not stop_id or not planned_arrival_time:
        return None

    raw_track = str(stop.get("stop_track") or "").strip()
    actual_arrival = str(stop.get("stop_actual_arrival") or "").strip()
    estimated_arrival = str(stop.get("stop_estimated_arrival") or "").strip()
    actual_departure = str(stop.get("stop_actual_departure") or "").strip()
    estimated_departure = str(stop.get("stop_estimated_departure") or "").strip()
    planned_departure = str(stop.get("stop_planned_departure") or "").strip()
    movement_status = (
        "actual_arrival"
        if actual_arrival
        else "estimated_arrival"
        if estimated_arrival
        else "planned_arrival"
    )

    return {
        "operationalDate": operational_date,
        "trainNumber": train_number,
        "occurrenceId": f"{operational_date}|arrival|{train_number}|{planned_arrival_time}",
        "routeId": route_id,
        "stopId": stop_id,
        "stationName": str(stop.get("station_name") or "").strip(),
        "stationRef": str(stop.get("station_ref") or "").strip().upper(),
        "origin": str(route_info.get("origin") or "").strip(),
        "destination": str(route_info.get("destination") or "").strip(),
        "plannedArrival": planned_arrival,
        "estimatedArrival": estimated_arrival or None,
        "actualArrival": actual_arrival or None,
        "plannedDeparture": planned_departure or None,
        "estimatedDeparture": estimated_departure or None,
        "actualDeparture": actual_departure or None,
        "platformTrack": normalize_balise_platform_track(raw_track),
        "rawTrackField": "stop_track",
        "rawTrackValue": raw_track or None,
        "movementStatus": movement_status,
        "sourceObservedAt": str(source_observed_at or "").strip(),
        "sourceUpdatedAt": str(source_updated_at or "").strip() or None,
        "trackProvenance": "balise.no/api/train/stops.stop_track",
    }


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


def candidate_matches_exact_departure_occurrence(
    result: Dict[str, object],
    operational_date: object,
) -> bool:
    route_info = result.get("route_info")
    if not isinstance(route_info, dict):
        return False

    lookup_train_no = normalize_train_no(result.get("lookup_train_no"))
    return bool(
        lookup_train_no
        and normalize_train_no(route_info.get("trainNumber")) == lookup_train_no
        and str(route_info.get("operationalDate") or "").strip() == str(operational_date or "").strip()
        and str(route_info.get("routeId") or "").strip()
        and str(route_info.get("origin") or "").strip().lower() == "skien"
        and str(route_info.get("destination") or "").strip()
        and result.get("skien_departure_time")
    )


def resolve_departure_candidate(
    train_no: str,
    operational_date: object,
    selected: Optional[Dict[str, object]],
) -> Optional[Dict[str, object]]:
    """Bind tid og materiell til samme Balise-forekomst, ellers fail-close per tog."""
    if not selected or not selected.get("skien_departure_time"):
        return None

    requested_train_no = normalize_train_no(train_no)
    display_train_no = normalize_train_no(selected.get("lookup_train_no")) or requested_train_no
    route_info = selected.get("route_info") if isinstance(selected.get("route_info"), dict) else {}
    exact_occurrence = candidate_matches_exact_departure_occurrence(selected, operational_date)
    departure_time = str(selected.get("skien_departure_time") or "").strip()
    route_id = str(route_info.get("routeId") or "").strip()
    composition = (
        resolve_departure_vehicle_composition(selected, route_info)
        if exact_occurrence
        else {
            "vehiclesObservedAtSkien": [],
            "vehiclesContinuingAtPorsgrunn": [],
            "departureVehicles": [],
            "detachedAtSkien": [],
            "vehicleResolutionSource": "unresolved_occurrence_identity",
            "vehicleError": "",
        }
    )
    vehicle_ids = list(composition["departureVehicles"])

    error = ""
    if not exact_occurrence:
        error = (
            "Uavklart forekomstbundet materiell: "
            f"tog {display_train_no}, dato {operational_date}, routeId {route_id or 'mangler'}; "
            "forekomstidentiteten er ufullstendig eller avviker."
        )
    elif composition["vehicleError"]:
        error = str(composition["vehicleError"])
    elif not vehicle_ids:
        error = (
            "Uavklart forekomstbundet materiell: "
            f"tog {display_train_no}, dato {operational_date}, routeId {route_id}; "
            "den eksakte Skien-avgangen har ingen kjøretøydata."
        )

    return {
        "operationalDate": str(operational_date or "").strip(),
        "requestedTrainNumber": requested_train_no,
        "displayTrainNumber": display_train_no,
        "routeId": route_id,
        "origin": str(route_info.get("origin") or "").strip(),
        "destination": str(route_info.get("destination") or "").strip(),
        "station": "Skien",
        "departureTime": departure_time,
        "vehicleIds": vehicle_ids,
        "error": error,
        "vehiclesObservedAtSkien": list(composition["vehiclesObservedAtSkien"]),
        "vehiclesContinuingAtPorsgrunn": list(composition["vehiclesContinuingAtPorsgrunn"]),
        "departureVehicles": vehicle_ids,
        "detachedAtSkien": list(composition["detachedAtSkien"]),
        "vehicleResolutionSource": str(composition["vehicleResolutionSource"]),
        "vehicleError": error,
    }


def select_balise_candidate_result(
    train_no: str,
    candidate_results: List[Dict[str, object]],
    operational_date: object = None,
):
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

    candidate_rank = {
        candidate: index
        for index, candidate in enumerate(get_balise_train_lookup_candidates(train_no))
    }
    ordered_results = sorted(
        candidate_results,
        key=lambda result: (
            candidate_rank.get(str(result.get("lookup_train_no") or ""), 999999),
            str(result.get("lookup_train_no") or ""),
        ),
    )

    if should_prefer_alternate_departure:
        departure_candidates = [
            result
            for result in ordered_results
            if result["lookup_train_no"] != train_no
            and result.get("skien_departure_time")
        ]
        if operational_date is not None:
            exact_candidates = [
                result
                for result in departure_candidates
                if candidate_matches_exact_departure_occurrence(result, operational_date)
            ]
            if exact_candidates:
                departure_candidates = exact_candidates

        selected = next(
            (
                result
                for result in departure_candidates
                if (
                    result.get("route_vehicle_hits")
                    if operational_date is not None
                    else (result["departure_hits"] or result["general_hits"])
                )
            ),
            None,
        )

        if selected is not None:
            return selected

        selected = next(
            iter(departure_candidates),
            None,
        )

        if selected is not None:
            return selected

    if should_prefer_alternate_arrival:
        selected = next(
            (
                result
                for result in ordered_results
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
                for result in ordered_results
                if result["lookup_train_no"] != train_no
                and result.get("skien_arrival_time")
            ),
            None,
        )

        if selected is not None:
            return selected

    return ordered_results[0] if ordered_results else None


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
    Dict[str, Dict[str, object]],
    Dict[str, Dict[str, object]],
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
    arrival_movement_contexts: Dict[str, Dict[str, object]] = {}
    departure_occurrence_contexts: Dict[str, Dict[str, object]] = {}

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
            arrival_movement_contexts,
            departure_occurrence_contexts,
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
                    navigation_response = page.goto(url, wait_until="networkidle", timeout=timeout_ms)
                    text = page.locator("body").inner_text()
                    general_hits, departure_hits, arrival_hits = extract_vehicle_hits_from_balise_text(text)
                    has_train_content = has_balise_train_content(text)
                    skien_stop = extract_skien_station_stop(text)
                    route_info = extract_balise_route_info(
                        navigation_response.text() if navigation_response is not None else page.content()
                    )
                    route_vehicle_rows = []
                    route_vehicle_hits = []
                    route_stops = []
                    route_stops_source_updated_at = ""
                    if route_info.get("routeId"):
                        try:
                            route_vehicle_rows, _vehicle_source_updated_at = fetch_balise_route_vehicles(
                                page,
                                route_info["routeId"],
                                deadline_at=deadline_at,
                            )
                            route_vehicle_hits = extract_route_vehicle_hits(
                                route_vehicle_rows,
                                route_info["routeId"],
                                "Skien",
                            )
                        except Exception:  # noqa: BLE001
                            # Materiell må aldri fylles fra en annen rute ved API-feil.
                            # En validert avgang blir i stedet eksplisitt uløst nedenfor.
                            route_vehicle_rows = []
                            route_vehicle_hits = []
                        try:
                            route_stops, route_stops_source_updated_at = fetch_balise_route_stops(
                                page,
                                route_info["routeId"],
                                deadline_at=deadline_at,
                            )
                        except Exception:  # noqa: BLE001
                            # Uten samme forekomsts stoppsekvens kan Porsgrunn ikke
                            # brukes som actual-kontroll. Avgangen blir fail-closed.
                            route_stops = []
                    movement_context = None
                    if skien_stop.get("arrival") and route_info.get("routeId"):
                        try:
                            movement_context = build_skien_movement_context(
                                route_info,
                                route_stops,
                                datetime.now(OSLO_TZ).isoformat(timespec="seconds"),
                                route_stops_source_updated_at,
                            )
                            if movement_context:
                                skien_stop["arrival"] = first_time_value(movement_context.get("plannedArrival"))
                                planned_departure = first_time_value(movement_context.get("plannedDeparture"))
                                if planned_departure:
                                    skien_stop["departure"] = planned_departure
                        except Exception:  # noqa: BLE001
                            # Rå stoppdata er et valgfritt canonical-tillegg. Legacy-feltene
                            # fra den ferdig lastede siden skal fortsatt publiseres ved feil.
                            movement_context = None

                    if general_hits or departure_hits or arrival_hits or has_train_content:
                        candidate_results.append(
                            {
                                "lookup_train_no": lookup_train_no,
                                "general_hits": general_hits,
                                "departure_hits": departure_hits,
                                "arrival_hits": arrival_hits,
                                "route_vehicle_hits": route_vehicle_hits,
                                "route_vehicle_rows": route_vehicle_rows,
                                "route_stops": route_stops,
                                "has_train_content": has_train_content,
                                "skien_arrival_time": skien_stop.get("arrival"),
                                "skien_departure_time": skien_stop.get("departure"),
                                "skien_platform_track": skien_stop.get("platformTrack"),
                                "skien_movement_context": movement_context,
                                "route_info": route_info,
                            }
                        )

                    last_error = f"Fant ingen kjøretøy i siden {lookup_train_no}"

                except Exception as exc:  # noqa: BLE001
                    last_error = f"{lookup_train_no}: {exc}"

            selected = select_balise_candidate_result(
                train_no,
                candidate_results,
                operational_date=run_date.isoformat(),
            )

            if selected is not None:
                lookup_train_no = selected["lookup_train_no"]
                if lookup_train_no != train_no:
                    display_train_numbers[train_no] = lookup_train_no

                departure_resolution = resolve_departure_candidate(
                    train_no,
                    run_date.isoformat(),
                    selected,
                )
                if departure_resolution is not None:
                    validated_departure_display_numbers[train_no] = str(lookup_train_no)
                    departure_times[train_no] = str(departure_resolution["departureTime"])
                    departure_occurrence_contexts[train_no] = departure_resolution

                    occurrence_vehicle_ids = list(departure_resolution.get("vehicleIds") or [])
                    if occurrence_vehicle_ids:
                        occurrence_vehicle_text = ", ".join(occurrence_vehicle_ids)
                        departure_vehicles[train_no] = occurrence_vehicle_text
                        vehicles[train_no] = occurrence_vehicle_text
                    else:
                        errors[train_no] = str(departure_resolution.get("error") or "").strip()

                if selected.get("skien_arrival_time"):
                    validated_arrival_display_numbers[train_no] = str(lookup_train_no)
                    arrival_times[train_no] = str(selected["skien_arrival_time"])

                if (
                    departure_resolution is None
                    and selected["general_hits"]
                    and train_no not in vehicles
                ):
                    vehicles[train_no] = ", ".join(selected["general_hits"])

                if selected.get("skien_arrival_time"):
                    arrival_hits = selected["arrival_hits"] or selected["general_hits"]
                    if arrival_hits:
                        arrival_vehicles[train_no] = ", ".join(arrival_hits)
                    movement_context = selected.get("skien_movement_context")
                    if isinstance(movement_context, dict):
                        exact_context = dict(movement_context)
                        exact_context["vehicleIds"] = list(arrival_hits)
                        exact_context["consistContext"] = (
                            "single_set"
                            if len(arrival_hits) == 1
                            else "double_set"
                            if len(arrival_hits) > 1
                            else "unknown"
                        )
                        arrival_movement_contexts[train_no] = exact_context

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
        arrival_movement_contexts,
        departure_occurrence_contexts,
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
    fetched = fetch_vehicle_maps_for_trains(trains, run_date, deadline_at=deadline_at)
    if len(fetched) == 11:
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
            arrival_movement_contexts,
            departure_occurrence_contexts,
        ) = fetched
    elif len(fetched) == 10:
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
            arrival_movement_contexts,
        ) = fetched
        departure_occurrence_contexts = {}
    else:
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
        ) = fetched
        arrival_movement_contexts = {}
        departure_occurrence_contexts = {}
    validated_departures = {
        train_no: departure_times[train_no]
        for train_no in HARDCODED_DEPARTURES
        if train_no in validated_departure_display_numbers
    }
    validated_arrivals = {}
    for train_no in HARDCODED_ARRIVALS:
        if train_no not in validated_arrival_display_numbers:
            continue
        arrival_payload = {
            "time": arrival_times[train_no],
            "nextDay": bool(HARDCODED_ARRIVALS.get(train_no, {}).get("nextDay", False)),
        }
        movement_context = arrival_movement_contexts.get(train_no)
        if isinstance(movement_context, dict):
            arrival_payload["movementContext"] = movement_context
        validated_arrivals[train_no] = arrival_payload
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
        "departureOccurrences": remap_train_keys(departure_occurrence_contexts, departure_display_map),
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

    departures = payload.get("departures") if isinstance(payload.get("departures"), dict) else {}
    departure_vehicles = (
        payload.get("departureVehicles")
        if isinstance(payload.get("departureVehicles"), dict)
        else {}
    )
    vehicle_errors = payload.get("vehicleErrors") if isinstance(payload.get("vehicleErrors"), dict) else {}
    departure_occurrences = (
        payload.get("departureOccurrences")
        if isinstance(payload.get("departureOccurrences"), dict)
        else {}
    )

    for display_train_no, departure_time in departures.items():
        train_key = str(display_train_no or "").strip()
        material = str(departure_vehicles.get(display_train_no) or "").strip()
        error = str(vehicle_errors.get(display_train_no) or "").strip()
        if not material and not error:
            raise ValueError(
                f"{mode} departure {train_key} has neither occurrence-bound material nor vehicleError"
            )

        occurrence = departure_occurrences.get(display_train_no)
        if material and not isinstance(occurrence, dict):
            raise ValueError(f"{mode} departure {train_key} is missing occurrence identity")
        if not isinstance(occurrence, dict):
            continue

        expected_fields = {
            "displayTrainNumber": train_key,
            "operationalDate": str(payload.get("date") or "").strip(),
            "departureTime": str(departure_time or "").strip(),
        }
        for field, expected in expected_fields.items():
            actual = str(occurrence.get(field) or "").strip()
            if actual != expected:
                raise ValueError(
                    f"{mode} departure {train_key} occurrence {field} mismatch: {actual!r} != {expected!r}"
                )

        if material:
            material_ids = [part.strip() for part in material.split(",") if part.strip()]
            occurrence_ids = [str(value or "").strip() for value in occurrence.get("vehicleIds") or []]
            if material_ids != occurrence_ids:
                raise ValueError(f"{mode} departure {train_key} occurrence material mismatch")

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
