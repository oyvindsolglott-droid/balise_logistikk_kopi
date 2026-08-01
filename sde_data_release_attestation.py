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


def build_attestation(manifest_path: Path, commit: str, tree: str, repository: str, run_id: str) -> dict:
    raw_manifest = manifest_path.read_bytes()
    manifest = json.loads(raw_manifest.decode("utf-8"))
    return {
        "schema": "sde-data-release-attestation/v1",
        "generationId": manifest.get("generationId"),
        "generationManifest": {
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
        "git": {"repository": repository, "commit": commit, "tree": tree},
        "workflow": {"runId": run_id or None},
        "publication": {
            "state": "DATA_COMMIT_PUSHED",
            "attestedAt": datetime.now(ZoneInfo("Europe/Oslo")).isoformat(timespec="seconds"),
            "pagesDeploymentId": None,
            "deployedCommit": None,
            "pagesConclusion": "PENDING_EXTERNAL_VERIFICATION",
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
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    attestation = build_attestation(
        args.manifest, args.commit, args.tree, args.repository, args.run_id
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(dataset_json_bytes(attestation))


if __name__ == "__main__":
    main()
