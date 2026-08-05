#!/usr/bin/env python3
"""Verify the exact Python, Playwright and Chromium Browserguard runtime."""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any, Dict


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE / "runtime-contract.json"


class RuntimeContractError(RuntimeError):
    """Raised when the current interpreter/runtime is not the locked one."""


def load_contract() -> Dict[str, Any]:
    value = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != "sde-browserguard-runtime/v1":
        raise RuntimeContractError("invalid Browserguard runtime contract")
    return value


def _playwright_browsers_manifest() -> Dict[str, Any]:
    specification = importlib.util.find_spec("playwright")
    if specification is None or not specification.submodule_search_locations:
        raise RuntimeContractError("Playwright is not installed in the Browserguard runtime")
    package = Path(next(iter(specification.submodule_search_locations)))
    path = package / "driver" / "package" / "browsers.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeContractError("Playwright browsers.json could not be read") from error


def verify_runtime() -> Dict[str, Any]:
    contract = load_contract()
    errors = []
    actual_python = platform.python_version()
    if actual_python != contract["pythonVersion"]:
        errors.append(f"python expected {contract['pythonVersion']}, got {actual_python}")

    expected_packages = {
        "playwright": contract["playwrightVersion"],
        **contract["dependencies"],
    }
    actual_packages: Dict[str, str] = {}
    for package, expected in expected_packages.items():
        distribution = package.replace("_", "-")
        try:
            actual = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            errors.append(f"{package} is not installed")
            continue
        actual_packages[package] = actual
        if actual != expected:
            errors.append(f"{package} expected {expected}, got {actual}")

    manifest = _playwright_browsers_manifest()
    chromium = next(
        (item for item in manifest.get("browsers", []) if item.get("name") == "chromium"),
        None,
    )
    if chromium is None:
        errors.append("Playwright manifest has no Chromium entry")
    else:
        if chromium.get("revision") != contract["chromiumRevision"]:
            errors.append(
                f"chromium revision expected {contract['chromiumRevision']}, got {chromium.get('revision')}"
            )
        if chromium.get("browserVersion") != contract["chromiumVersion"]:
            errors.append(
                f"chromium version expected {contract['chromiumVersion']}, got {chromium.get('browserVersion')}"
            )

    browser_root_value = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
    browser_root = Path(browser_root_value) if browser_root_value else None
    expected_install = (
        browser_root / f"chromium-{contract['chromiumRevision']}" / "INSTALLATION_COMPLETE"
        if browser_root is not None
        else None
    )
    if browser_root is None or not browser_root.is_absolute():
        errors.append("PLAYWRIGHT_BROWSERS_PATH must be an explicit absolute path")
    elif expected_install is None or not expected_install.is_file():
        errors.append("the locked Chromium revision is not installed in PLAYWRIGHT_BROWSERS_PATH")

    if errors:
        raise RuntimeContractError("; ".join(errors))
    return {
        "schemaVersion": contract["schemaVersion"],
        "pythonVersion": actual_python,
        "packages": actual_packages,
        "chromiumRevision": contract["chromiumRevision"],
        "chromiumVersion": contract["chromiumVersion"],
        "browserRoot": str(browser_root),
        "status": "GREEN",
    }


def main() -> int:
    try:
        result = verify_runtime()
    except RuntimeContractError as error:
        print(json.dumps({"status": "BLOCKED", "error": str(error)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
