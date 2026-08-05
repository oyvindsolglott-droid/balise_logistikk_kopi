#!/usr/bin/env python3
"""Frozen synthetic Browserguard orchestrator; imports only the narrow client."""

from __future__ import annotations

import json
import sys
from typing import Any, Dict

from client import BrowserguardClient


def run_synthetic_orchestration() -> Dict[str, Any]:
    client = BrowserguardClient().start()
    outcome: Dict[str, Any] = {}
    try:
        outcome["startup"] = client.status()
        outcome["navigation"] = client.navigate("open-matrix")
        outcome["desktop"] = client.set_viewport("desktop")
        outcome["gateBegin"] = client.begin_human_gate()
        outcome["gateComplete"] = client.complete_human_gate()
        outcome["screenshot"] = client.capture_screenshot("synthetic-matrix")
        outcome["report"] = client.write_report("synthetic-session")
    finally:
        outcome["shutdown"] = client.close()
    return outcome


def main() -> int:
    outcome = run_synthetic_orchestration()
    print(json.dumps(outcome, sort_keys=True))
    return 0 if outcome.get("shutdown", {}).get("state") == "CLOSED" else 1


if __name__ == "__main__":
    sys.exit(main())
