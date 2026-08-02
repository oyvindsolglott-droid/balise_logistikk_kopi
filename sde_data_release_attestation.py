#!/usr/bin/env python3
"""Create a non-circular release attestation after the data commit is known.

The attestation is an Actions artifact, never an input to the data commit it
attests. A later read-only observer may add Pages deployment evidence; absence
of that evidence stays explicitly PENDING instead of being guessed.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sde_data_provenance import dataset_json_bytes, sha256_bytes


def build_attestation(
    manifest_path: Path,
    commit: str,
    tree: str,
    repository: str,
    run_id: str,
    workflow_context_sha: str = "",
) -> dict:
    raw_manifest = manifest_path.read_bytes()
    manifest = json.loads(raw_manifest.decode("utf-8"))
    source = manifest.get("source") or {}
    intended_cycle = manifest.get("intendedCycle") or {}
    workflow = manifest.get("workflow") or {}
    return {
        "schemaVersion": "sde-data-release-attestation/v2",
        "generationId": manifest.get("generationId"),
        "generation": {
            "generatorWorkflowRunId": run_id or workflow.get("runId") or None,
            "generatorWorkflowContextSha": workflow_context_sha or None,
            "sourceObservedAt": source.get("observedAt"),
            "sourceStationSha256": source.get("rawStationSha256"),
            "sourceVehicleSha256": source.get("vehicleSha256"),
            "intendedCycleId": intended_cycle.get("id"),
            "intendedCycleDate": intended_cycle.get("date"),
            "intendedCycleHour": intended_cycle.get("hour"),
        },
        "content": {
            "repository": repository,
            "dataCommit": commit,
            "dataTree": tree,
            "manifest": {
                "path": "data/sde-data-provenance.json",
                "sha256": sha256_bytes(raw_manifest),
            },
            "datasets": {
                mode: {
                    "path": details.get("path"),
                    "sha256": details.get("sha256"),
                    "bytes": details.get("bytes"),
                }
                for mode, details in (manifest.get("datasets") or {}).items()
            },
            "artifactSourceCommit": None,
            "pagesArtifactId": None,
            "pagesArtifactDigest": None,
        },
        "deployment": {
            "pagesWorkflowRunId": None,
            "pagesWorkflowContextSha": None,
            "pagesBuildVersion": None,
            "deploymentId": None,
            "deploymentApiSha": None,
            "publishedAt": None,
            "deployedArtifactId": None,
            "deployedArtifactDigest": None,
        },
        "publication": {
            "state": "DATA_COMMIT_PUSHED",
            "attestedAt": datetime.now(ZoneInfo("Europe/Oslo")).isoformat(timespec="seconds"),
            "observedAt": None,
            "manifestSha256": None,
            "datasets": {"idag": {"sha256": None}, "imorgen": {"sha256": None}},
            "responseHeaders": {},
            "customDomainObservability": "NOT_EVALUATED",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--workflow-context-sha", default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    attestation = build_attestation(
        args.manifest,
        args.commit,
        args.tree,
        args.repository,
        args.run_id,
        args.workflow_context_sha,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(dataset_json_bytes(attestation))


if __name__ == "__main__":
    main()
