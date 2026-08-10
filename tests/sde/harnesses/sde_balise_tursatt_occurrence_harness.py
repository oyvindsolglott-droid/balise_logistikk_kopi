#!/usr/bin/env python3
"""Permanent occurrence-bound Balise/Tursatt regression contract."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
from typing import Any, Dict, Iterable, List


ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = ROOT / "tests" / "sde" / "fixtures" / "balise-tursatt-false-negatives-20260810.json"
SOURCE_PATH = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "update_static_data.py"
INVARIANT_IDS = [f"INV-BALISE-{number:03d}" for number in range(1, 13)]


def load_generator(path: Path):
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    if "playwright.sync_api" not in sys.modules:
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.sync_playwright = lambda: None
        playwright.sync_api = sync_api
        sys.modules["playwright"] = playwright
        sys.modules["playwright.sync_api"] = sync_api
    spec = importlib.util.spec_from_file_location("sde_balise_candidate_generator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load generator source {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def station_stop(name: str, index: int, departure_time: str = "") -> Dict[str, object]:
    refs = {"Skien": "SKN", "Porsgrunn": "PG", "Nisterud": "NIS", "Notodden": "NOT"}
    stop: Dict[str, object] = {
        "station_name": name,
        "station_ref": refs.get(name, name[:3].upper()),
        "stop_id": f"stop-{index}-{name.lower()}",
    }
    if departure_time:
        stop["stop_planned_departure"] = departure_time
    return stop


def route_station_names(occurrence: Dict[str, object]) -> List[str]:
    origin = str(occurrence["origin"])
    destination = str(occurrence["destination"])
    if origin == "Skien":
        return ["Skien", "Nisterud", destination]
    if destination == "Porsgrunn":
        return [origin, "Skien", "Porsgrunn"]
    return [origin, "Skien", "Nisterud", destination]


def build_candidate(
    occurrence: Dict[str, object],
    *,
    include_vehicle: bool = True,
    stop_departure_time: str | None = None,
    arrival_only: bool = False,
) -> Dict[str, object]:
    route_id = str(occurrence["routeId"])
    departure_time = str(occurrence["departureTime"])
    station_names = route_station_names(occurrence)
    stops: List[Dict[str, object]] = []
    for index, name in enumerate(station_names):
        planned_departure = (stop_departure_time if stop_departure_time is not None else departure_time) if name == "Skien" else ""
        stop = station_stop(name, index, planned_departure)
        if arrival_only and name == "Skien":
            stop.pop("stop_planned_departure", None)
            stop["stop_planned_arrival"] = departure_time
        stops.append(stop)

    skien_index = station_names.index("Skien")
    next_station = station_names[skien_index + 1]
    vehicle = str(occurrence["sourceVehicle"])
    vehicle_rows: List[Dict[str, object]] = []
    if include_vehicle:
        vehicle_rows = [
            {"sv_route": route_id, "station_name": "Skien", "vehicle": vehicle, "position": 1},
            {"sv_route": route_id, "station_name": next_station, "vehicle": vehicle, "position": 1},
        ]

    return {
        "lookup_train_no": str(occurrence["trainNumber"]),
        "general_hits": [vehicle] if include_vehicle else [],
        "departure_hits": [vehicle] if include_vehicle else [],
        "arrival_hits": [vehicle] if include_vehicle else [],
        "route_vehicle_hits": [vehicle] if include_vehicle else [],
        "route_vehicle_rows": vehicle_rows,
        "route_stops": stops,
        "has_train_content": True,
        "skien_arrival_time": None,
        "skien_departure_time": departure_time,
        "route_info": {
            "trainNumber": str(occurrence["trainNumber"]),
            "operationalDate": str(occurrence["serviceDate"]),
            "routeId": route_id,
            "origin": str(occurrence["origin"]),
            "destination": str(occurrence["destination"]),
            "trainPart": "1",
        },
    }


def resolve(module, occurrence: Dict[str, object], **options: object) -> Dict[str, object]:
    result = module.resolve_departure_candidate(
        str(occurrence["trainNumber"]),
        str(occurrence["serviceDate"]),
        build_candidate(occurrence, **options),
    )
    return result or {}


def passed_resolution(result: Dict[str, object], occurrence: Dict[str, object]) -> bool:
    return (
        result.get("vehicleIds") == [occurrence["sourceVehicle"]]
        and not str(result.get("error") or "").strip()
        and result.get("routeId") == occurrence["routeId"]
        and result.get("departureTime") == occurrence["departureTime"]
    )


def add_result(results: List[Dict[str, str]], invariant_id: str, passed: bool, detail: str) -> None:
    results.append({"id": invariant_id, "status": "PASS" if passed else "FAIL", "detail": detail})


def next_date(value: str) -> str:
    year, month, day = (int(part) for part in value.split("-"))
    return f"{year:04d}-{month:02d}-{day + 1:02d}"


def unique(values: Iterable[str]) -> bool:
    items = list(values)
    return len(items) == len(set(items))


def main() -> int:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    module = load_generator(SOURCE_PATH)
    occurrences: List[Dict[str, object]] = fixture["occurrences"]
    resolved = [(occurrence, resolve(module, occurrence)) for occurrence in occurrences]
    incident = [(occurrence, result) for occurrence, result in resolved if occurrence["serviceDate"] == fixture["expected"]["incidentDate"]]
    results: List[Dict[str, str]] = []

    train_2470 = next(item for item in occurrences if item["serviceDate"] == "2026-08-10" and item["trainNumber"] == "2470")
    train_2473 = next(item for item in occurrences if item["serviceDate"] == "2026-08-10" and item["trainNumber"] == "2473")
    add_result(results, INVARIANT_IDS[0], passed_resolution(resolve(module, train_2470), train_2470), "2470 resolves 69-63 without a universal Porsgrunn requirement")
    add_result(results, INVARIANT_IDS[1], passed_resolution(resolve(module, train_2473), train_2473), "2473 binds to the exact Skien station event even when route origin is Notodden")
    add_result(
        results,
        INVARIANT_IDS[2],
        len(incident) == fixture["expected"]["incidentFalseNegatives"] and all(passed_resolution(result, occurrence) for occurrence, result in incident),
        "all eight incident-date false negatives resolve to their occurrence-bound source vehicle",
    )

    actual_distribution = {
        service_date: sum(1 for occurrence, _ in resolved if occurrence["serviceDate"] == service_date)
        for service_date in fixture["dateDistribution"]
    }
    add_result(
        results,
        INVARIANT_IDS[3],
        len(resolved) == fixture["expected"]["historicalOccurrences"]
        and actual_distribution == fixture["dateDistribution"]
        and all(passed_resolution(result, occurrence) for occurrence, result in resolved),
        "the exact 40-occurrence, seven-date historical matrix resolves without gaps",
    )

    occurrence_keys = [
        f"{occurrence['serviceDate']}|{occurrence['trainNumber']}|{occurrence['routeId']}|{occurrence['departureTime']}"
        for occurrence in occurrences
    ]
    wrong_assignments = sum(
        1 for occurrence, result in resolved
        if result.get("vehicleIds") and result.get("vehicleIds") != [occurrence["sourceVehicle"]]
    )
    add_result(
        results,
        INVARIANT_IDS[4],
        unique(occurrence_keys) and wrong_assignments == fixture["expected"]["wrongAssignments"],
        "date, train, route, Skien stop/time and source remain occurrence-bound with zero wrong assignments",
    )

    missing_source = resolve(module, train_2470, include_vehicle=False)
    add_result(
        results,
        INVARIANT_IDS[5],
        missing_source.get("vehicleIds") == [] and bool(str(missing_source.get("error") or "").strip()),
        "missing same-route source evidence remains explicitly unresolved",
    )

    ambiguous_a = build_candidate(train_2470)
    ambiguous_occurrence = {**train_2470, "routeId": f"{train_2470['routeId']}-other"}
    ambiguous_b = build_candidate(ambiguous_occurrence)
    ambiguous_selection = module.select_balise_candidate_result("2470", [ambiguous_a, ambiguous_b], "2026-08-10")
    add_result(results, INVARIANT_IDS[6], ambiguous_selection is None, "two distinct exact occurrences fail closed instead of choosing the first candidate")

    wrong_date = module.resolve_departure_candidate("2470", next_date(str(train_2470["serviceDate"])), build_candidate(train_2470)) or {}
    wrong_time = resolve(module, train_2470, stop_departure_time="05:28")
    arrival_only = resolve(module, train_2470, arrival_only=True)
    add_result(
        results,
        INVARIANT_IDS[7],
        wrong_date.get("vehicleIds") == []
        and wrong_time.get("vehicleIds") == []
        and arrival_only.get("vehicleIds") == [],
        "cross-date, nearest-time and arrival-only station-event fallbacks are rejected",
    )

    porsgrunn_relevant = resolve(module, train_2473)
    add_result(
        results,
        INVARIANT_IDS[8],
        passed_resolution(porsgrunn_relevant, train_2473)
        and passed_resolution(resolve(module, train_2470), train_2470),
        "Porsgrunn is used when it is the actual next stop and is irrelevant when another stop follows Skien",
    )

    five_digit = any(len(str(item["trainNumber"])) == 5 for item in occurrences)
    four_digit = any(len(str(item["trainNumber"])) == 4 for item in occurrences)
    before_0700 = any(str(item["departureTime"]) < "07:00" for item in occurrences)
    after_0700 = any(str(item["departureTime"]) > "07:00" for item in occurrences)
    exactly_0700 = {**train_2470, "routeId": f"{train_2470['routeId']}-0700", "departureTime": "07:00"}
    all_series_69_or_70 = all(str(item["sourceVehicle"]).startswith(("69-", "70-")) for item in occurrences)
    add_result(
        results,
        INVARIANT_IDS[9],
        five_digit and four_digit and before_0700 and after_0700 and all_series_69_or_70
        and passed_resolution(resolve(module, exactly_0700), exactly_0700),
        "four/five-digit trains, series 69/70 and before/at/after 07:00 use the same occurrence contract",
    )

    split_occurrence = {**train_2473, "routeId": f"{train_2473['routeId']}-split"}
    split_candidate = build_candidate(split_occurrence)
    split_candidate["route_vehicle_rows"].insert(
        1,
        {"sv_route": split_occurrence["routeId"], "station_name": "Skien", "vehicle": "70-06", "position": 2},
    )
    split_result = module.resolve_departure_candidate("2473", "2026-08-10", split_candidate) or {}
    add_result(
        results,
        INVARIANT_IDS[10],
        split_result.get("vehicleIds") == [train_2473["sourceVehicle"]]
        and split_result.get("detachedAtSkien") == ["70-06"],
        "the first actual stop after Skien preserves the continuing subset and records detached material",
    )

    same_occurrence_duplicate = build_candidate(train_2470)
    same_occurrence_selection = module.select_balise_candidate_result("2470", [build_candidate(train_2470), same_occurrence_duplicate], "2026-08-10")
    add_result(
        results,
        INVARIANT_IDS[11],
        same_occurrence_selection is not None
        and module.candidate_matches_exact_departure_occurrence(same_occurrence_selection, "2026-08-10")
        and ambiguous_selection is None,
        "duplicate observations of one key are tolerated while first-candidate wins across keys is forbidden",
    )

    fail_ids = [item["id"] for item in results if item["status"] == "FAIL"]
    report = {
        "schemaVersion": "sde-balise-tursatt-occurrence-harness-v1",
        "problemIds": ["BALISE_TURSATT_UNIVERSAL_PORSGRUNN_FALSE_NEGATIVE", "BALISE_TURSATT_ORIGIN_SKIEN_FALSE_NEGATIVE"],
        "sourcePath": str(SOURCE_PATH),
        "counts": {"total": len(results), "pass": len(results) - len(fail_ids), "fail": len(fail_ids)},
        "fixtureCounts": {
            "incident": len(incident),
            "historical": len(occurrences),
            "dates": len(fixture["dateDistribution"]),
            "wrongAssignments": wrong_assignments,
        },
        "failIds": fail_ids,
        "results": results,
    }
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    return 1 if fail_ids else 0


if __name__ == "__main__":
    raise SystemExit(main())
