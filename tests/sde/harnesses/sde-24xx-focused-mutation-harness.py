#!/usr/bin/env python3
"""Structured, deterministic kills for the two 24xx binding mutants."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "update_static_data.py")
SCENARIO = sys.argv[2] if len(sys.argv) > 2 else ""
FIXTURE = json.loads((ROOT / "tests/fixtures/balise_24xx_occurrence_binding.json").read_text())


def load_module():
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("sde_mutated_static_data", SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("mutert generator kunne ikke lastes")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_candidate(module, occurrence):
    route_info = dict(occurrence["routeInfo"])
    rows = list(occurrence.get("vehicleRows") or [])
    return {
        "lookup_train_no": occurrence["lookupTrainNumber"],
        "general_hits": [],
        "departure_hits": [],
        "arrival_hits": [],
        "route_vehicle_hits": module.extract_route_vehicle_hits(
            rows, route_info["routeId"], "Skien"
        ),
        "route_vehicle_rows": rows,
        "route_stops": list(occurrence.get("routeStops") or []),
        "route_stops_source_updated_at": occurrence["sourceRevision"],
        "source_revision": occurrence["sourceRevision"],
        "has_train_content": True,
        "skien_arrival_time": None,
        "skien_departure_time": occurrence["plannedDeparture"],
        "route_info": route_info,
    }


def execute():
    if SCENARIO == "TRAIN_NUMBER_ONLY_VEHICLE_LOOKUP":
        text = SOURCE.read_text()
        forbidden = re.compile(r"[\"']24\d{2}[\"']\s*:\s*[\"'](?:69|70|74|75)-\d{2}")
        passed = not forbidden.search(text) and "TRAIN_NUMBER_ONLY_VEHICLE_LOOKUP" not in text
        return passed, {
            "observed": "ingen tognummer-til-kjøretøy-tabell" if passed else "tognummerbasert kjøretøylookup funnet",
            "expected": "materiell må bindes til full forekomstidentitet",
        }
    if SCENARIO == "CROSS_DATE_24XX_ASSIGNMENT_LEAK":
        module = load_module()
        occurrence = FIXTURE["occurrences"][0]
        resolution = module.resolve_departure_candidate(
            FIXTURE["logicalTrain"],
            "2026-08-14",
            make_candidate(module, occurrence),
        )
        vehicles = list((resolution or {}).get("vehicleIds") or [])
        passed = not vehicles and "forekomstidentiteten" in str((resolution or {}).get("error") or "")
        return passed, {
            "observed": vehicles,
            "expected": [],
            "sourceDate": occurrence["operationalDate"],
            "requestedDate": "2026-08-14",
        }
    raise RuntimeError(f"ukjent mutation scenario: {SCENARIO}")


try:
    ok, evidence = execute()
    report = {
        "schemaVersion": "sde-24xx-focused-mutation-harness-v1",
        "invariantId": SCENARIO,
        "status": "PASS" if ok else "FAIL",
        "structured": True,
        "evidence": evidence,
    }
except Exception as error:  # fail closed, but keep the failure machine-readable
    report = {
        "schemaVersion": "sde-24xx-focused-mutation-harness-v1",
        "invariantId": SCENARIO,
        "status": "ERROR",
        "structured": True,
        "error": str(error),
    }

print(json.dumps(report, ensure_ascii=False, sort_keys=True))
raise SystemExit(0 if report["status"] == "PASS" else 1)
