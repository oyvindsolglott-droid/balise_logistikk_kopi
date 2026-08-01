"""Machine-readable provenance for the static Balise datasets.

Hash contracts (schema ``sde-data-provenance/v1``):

* ``rawStation*Sha256`` hashes a deterministic length-prefixed sequence of
  the exact HTTP response bytes returned by the Balise stops endpoint. Items
  are ordered by ``mode``, operational date, train number, route id and
  capture ordinal. No JSON re-encoding is involved in these source hashes.
* ``vehicleSha256`` hashes UTF-8 RFC-8259 JSON produced with sorted keys and
  compact separators from the normalized vehicle rows in the same ordering.
* Dataset hashes cover the exact UTF-8 bytes atomically written to disk.

The manifest never stores raw Balise responses, cookies, request headers,
tokens or authentication material.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo


OSLO_TZ = ZoneInfo("Europe/Oslo")
SCHEMA = "sde-data-provenance/v1"


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def dataset_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _length_prefixed_hash(parts: Iterable[bytes]) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(struct.pack(">Q", len(part)))
        digest.update(part)
    return digest.hexdigest()


@dataclass
class RouteCapture:
    mode: str
    operational_date: str
    train_number: str
    route_id: str
    ordinal: int
    station_before: bytes
    station_after: bytes
    vehicle_rows: List[Dict[str, object]]
    observed_at: str
    stable: bool
    attempts: int

    def identity(self) -> bytes:
        return canonical_json_bytes({
            "mode": self.mode,
            "operationalDate": self.operational_date,
            "trainNumber": self.train_number,
            "routeId": self.route_id,
            "ordinal": self.ordinal,
        })


@dataclass
class GenerationProvenance:
    started_at: datetime = field(default_factory=lambda: datetime.now(OSLO_TZ))
    generation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    captures: List[RouteCapture] = field(default_factory=list)

    def add_capture(
        self,
        *,
        mode: str,
        operational_date: str,
        train_number: str,
        route_id: str,
        station_before: bytes,
        station_after: bytes,
        vehicle_rows: List[Dict[str, object]],
        observed_at: str,
        stable: bool,
        attempts: int,
    ) -> None:
        self.captures.append(RouteCapture(
            mode=mode,
            operational_date=operational_date,
            train_number=train_number,
            route_id=route_id,
            ordinal=len(self.captures),
            station_before=station_before,
            station_after=station_after,
            vehicle_rows=vehicle_rows,
            observed_at=observed_at,
            stable=stable,
            attempts=attempts,
        ))

    def _ordered(self) -> List[RouteCapture]:
        return sorted(self.captures, key=lambda item: (
            item.mode,
            item.operational_date,
            item.train_number,
            item.route_id,
            item.ordinal,
        ))

    def build_manifest(
        self,
        payloads: Dict[str, Dict[str, object]],
        serialized_payloads: Dict[str, bytes],
        completed_at: Optional[datetime] = None,
    ) -> Dict[str, object]:
        completed = completed_at or datetime.now(OSLO_TZ)
        ordered = self._ordered()
        before_parts: List[bytes] = []
        after_parts: List[bytes] = []
        normalized_vehicles: List[Dict[str, object]] = []
        for capture in ordered:
            identity = capture.identity()
            before_parts.extend((identity, capture.station_before))
            after_parts.extend((identity, capture.station_after))
            normalized_vehicles.append({
                "identity": json.loads(identity.decode("utf-8")),
                "rows": capture.vehicle_rows,
            })

        raw_before = _length_prefixed_hash(before_parts)
        raw_after = _length_prefixed_hash(after_parts)
        observed = [item.observed_at for item in ordered if item.observed_at]
        intended_cycle_hour = os.environ.get("SDE_INTENDED_CYCLE_HOUR") or None
        intended_cycle_date = os.environ.get("SDE_INTENDED_CYCLE_DATE") or None
        intended_cycle_id = (
            f"{intended_cycle_date}T{intended_cycle_hour}:00@Europe/Oslo"
            if intended_cycle_date and intended_cycle_hour
            else None
        )
        intended_cycle_boundary = None
        if intended_cycle_date and intended_cycle_hour:
            intended_cycle_boundary = datetime.fromisoformat(
                f"{intended_cycle_date}T{intended_cycle_hour}:00:00"
            ).replace(tzinfo=OSLO_TZ).isoformat(timespec="seconds")

        datasets = {}
        for mode, filename in (("idag", "api_idag.json"), ("imorgen", "api_imorgen.json")):
            payload = payloads[mode]
            exact = serialized_payloads[mode]
            datasets[mode] = {
                "path": f"data/{filename}",
                "operationalDate": str(payload.get("date") or ""),
                "sha256": sha256_bytes(exact),
                "bytes": len(exact),
                "recordCount": len(payload.get("departures") or {}) + len(payload.get("arrivals") or {}),
            }

        return {
            "schema": SCHEMA,
            "generationId": self.generation_id,
            "timeZone": "Europe/Oslo",
            "startedAt": self.started_at.isoformat(timespec="seconds"),
            "completedAt": completed.isoformat(timespec="seconds"),
            "intendedCycle": {
                "id": intended_cycle_id,
                "date": intended_cycle_date,
                "hour": intended_cycle_hour,
                "firstAttemptMinute": 7,
                "effectiveBoundary": intended_cycle_boundary,
                "derivation": "latest_operational_cycle_or_explicit_manual",
            },
            "workflow": {
                "event": os.environ.get("GITHUB_EVENT_NAME") or "local",
                "runId": os.environ.get("GITHUB_RUN_ID") or None,
                "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT") or None,
                "scheduledFor": intended_cycle_id,
                "actualWorkflowStart": os.environ.get("SDE_ACTUAL_WORKFLOW_START") or None,
                "actualGeneratorStart": self.started_at.isoformat(timespec="seconds"),
                "generatorExecuted": True,
            },
            "source": {
                "provider": "balise.no",
                "stationEndpointTemplate": "https://balise.no/api/train/stops?route={routeId}",
                "vehicleEndpointTemplate": "https://balise.no/api/train/vehicles?route={routeId}",
                "observedAt": max(observed) if observed else None,
                "rawStationSha256": raw_after,
                "rawStationBeforeSha256": raw_before,
                "rawStationAfterSha256": raw_after,
                "vehicleCount": sum(len(item.vehicle_rows) for item in ordered),
                "vehicleSha256": sha256_bytes(canonical_json_bytes(normalized_vehicles)),
                "routeCaptureCount": len(ordered),
                "snapshotStable": bool(ordered) and all(item.stable for item in ordered),
                "maxCaptureAttempts": max((item.attempts for item in ordered), default=0),
            },
            "datasets": datasets,
            "git": {"commit": None, "tree": None},
            "publication": {
                "state": "UNATTESTED_GENERATION",
                "pagesDeploymentId": None,
                "deployedCommit": None,
                "customDomainObservability": "NOT_EVALUATED",
            },
            "hashContract": {
                "algorithm": "SHA-256",
                "sourceStation": "exact HTTP body bytes in deterministic length-prefixed identity order",
                "vehicles": "UTF-8 canonical JSON; sorted keys; compact separators; deterministic capture order",
                "datasets": "exact UTF-8 bytes atomically written; ensure_ascii=false; indent=2; no trailing newline",
            },
        }
