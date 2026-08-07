#!/usr/bin/env python3
"""Promote one verified SDE challenger after explicit human approval."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import sys
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def artifact_hash(artifact: dict[str, Any]) -> str:
    unsigned = dict(artifact)
    unsigned.pop("artifactHash", None)
    return hashlib.sha256(canonical_json(unsigned).encode("utf-8")).hexdigest()


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def promote(challenger: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    if challenger.get("status") != "CHALLENGER":
        raise ValueError("Only a CHALLENGER can be promoted")
    calculated = artifact_hash(challenger)
    if calculated != challenger.get("artifactHash"):
        raise ValueError("Challenger artifact hash mismatch")
    required = ("approvedArtifactHash", "approvedBy", "approvedAt", "approvalReason", "comparedToChampion")
    if any(not approval.get(name) for name in required):
        raise ValueError("Approval manifest is incomplete")
    if approval["approvedArtifactHash"] != challenger["artifactHash"]:
        raise ValueError("Approval does not bind this challenger artifact")
    if not valid_timestamp(approval["approvedAt"]):
        raise ValueError("approvedAt must be an ISO-8601 timestamp")

    champion = json.loads(json.dumps(challenger))
    champion["status"] = "CHAMPION"
    champion["promotion"] = {
        "sourceArtifactHash": challenger["artifactHash"],
        "approvedBy": str(approval["approvedBy"]),
        "approvedAt": str(approval["approvedAt"]),
        "approvalReason": str(approval["approvalReason"]),
        "comparedToChampion": str(approval["comparedToChampion"]),
    }
    champion["artifactHash"] = artifact_hash(champion)
    return champion


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--challenger", required=True, type=pathlib.Path)
    parser.add_argument("--approval", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    challenger = json.loads(args.challenger.read_text(encoding="utf-8"))
    approval = json.loads(args.approval.read_text(encoding="utf-8"))
    champion = promote(challenger, approval)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(champion, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": champion["status"], "modelVersion": champion["modelVersion"], "artifactHash": champion["artifactHash"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
