#!/usr/bin/env python3
"""Test-only local probes; executable use delegates to the broker client."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Type

if __name__ != "__main__":
    from evidence import EvidenceWriter
    from guard import (
        MANDATORY_BLOCKED_METHODS,
        ProtectedBrowserHarness,
        _qualification_click,
        _qualification_evaluate,
        _qualification_wait_for_timeout,
        secure_temp_directory,
    )
    from sentinel import SentinelServer


def _json_probe(page: Any, expression: str, argument: Any) -> Any:
    return _qualification_evaluate(page, expression, argument)


def _fetch_probe(page: Any, url: str, method: str) -> Dict[str, Any]:
    return _json_probe(
        page,
        """async ({url, method}) => {
          try {
            const options = {method, cache: 'no-store'};
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) options.body = 'discarded-local-probe';
            const response = await fetch(url, options);
            return {resolved: true, status: response.status};
          } catch (error) {
            return {resolved: false, errorName: error && error.name ? error.name : 'Error'};
          }
        }""",
        {"url": url, "method": method},
    )


def _xhr_post_probe(page: Any, url: str) -> Dict[str, Any]:
    return _json_probe(
        page,
        """url => new Promise(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url);
          xhr.onload = () => resolve({resolved: true, status: xhr.status});
          xhr.onerror = () => resolve({resolved: false, event: 'error'});
          xhr.send('discarded-local-probe');
        })""",
        url,
    )


def _form_post_probe(page: Any, url: str) -> None:
    _qualification_evaluate(
        page,
        """url => {
          const frame = document.createElement('iframe');
          frame.name = 'local-post-target';
          frame.hidden = true;
          document.body.appendChild(frame);
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = url;
          form.target = frame.name;
          const field = document.createElement('input');
          field.name = 'localProbe';
          field.value = 'discarded';
          form.appendChild(field);
          document.body.appendChild(form);
          form.submit();
        }""",
        url,
    )
    _qualification_wait_for_timeout(page, 250)


def _send_beacon_probe(page: Any, url: str) -> bool:
    result = _qualification_evaluate(
        page,
        """url => navigator.sendBeacon(url, new Blob(['discarded-local-probe'], {type:'text/plain'}))""",
        url,
    )
    _qualification_wait_for_timeout(page, 250)
    return bool(result)


def _websocket_probe(page: Any, url: str) -> Dict[str, Any]:
    return _qualification_evaluate(
        page,
        """url => new Promise(resolve => {
          const state = {opened: false, closed: false, error: false, messageSent: false};
          const socket = new WebSocket(url);
          const finish = () => resolve(state);
          socket.onopen = () => {
            state.opened = true;
            socket.send('discarded-local-probe');
            state.messageSent = true;
          };
          socket.onerror = () => { state.error = true; };
          socket.onclose = () => { state.closed = true; finish(); };
          setTimeout(finish, 1000);
        })""",
        url,
    )


def _blocked_count(harness: ProtectedBrowserHarness) -> int:
    return int(harness.report()["blockedRequestCount"])


def _confirm_blocked_label(
    harness: ProtectedBrowserHarness,
    protected: SentinelServer,
    label: str,
    blocked_before: int,
    reached_before: int,
) -> bool:
    blocked_after = _blocked_count(harness)
    reached_after = len(protected.requests())
    return (
        blocked_after > blocked_before
        and reached_after == reached_before
        and label in harness.report()["blockedMethods"]
    )


def _write_json(path: Path, value: Any) -> None:
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with EvidenceWriter(path.parent) as writer:
        writer.write_named(path.name, payload)


def _write_manifest(evidence_directory: Path) -> None:
    entries = []
    for path in sorted(item for item in evidence_directory.iterdir() if item.name != "SHA256SUMS"):
        if path.is_file() and not path.is_symlink():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            entries.append(f"{digest}  {path.name}")
    with EvidenceWriter(evidence_directory) as writer:
        writer.write_named("SHA256SUMS", ("\n".join(entries) + "\n").encode("utf-8"))


def _run_test_qualification(
    *,
    evidence_directory: Optional[Path] = None,
    harness_type: Optional[Type[Any]] = None,
) -> Dict[str, Any]:
    if harness_type is None:
        raise RuntimeError("test qualification requires an explicit internal harness type")
    evidence = evidence_directory or secure_temp_directory("sde-qe-browserguard-qualification-")
    if any(evidence.iterdir()):
        raise RuntimeError("browserguard evidence directory must be empty")
    protected = SentinelServer().start()
    control = SentinelServer().start()
    harness = harness_type(
        protected.origin,
        headless=True,
        evidence_directory=evidence,
        allowed_auxiliary_origins=(control.origin,),
    )
    probe_results: Dict[str, Any] = {}
    protected_log: list[Dict[str, Any]] = []
    control_log: list[Dict[str, Any]] = []
    try:
        harness.start()
        main_page = harness.new_page()
        main_page.goto(f"{protected.origin}/sentinel.html?query-value-must-not-be-logged")

        protected_methods_before = protected.reached_methods()
        probe_results["GET"] = _fetch_probe(
            main_page, f"{protected.origin}/allowed-get?query-value-must-not-be-logged", "GET"
        )
        probe_results["HEAD"] = _fetch_probe(
            main_page, f"{protected.origin}/allowed-head?query-value-must-not-be-logged", "HEAD"
        )
        _qualification_wait_for_timeout(main_page, 100)
        protected_methods_after = protected.reached_methods()
        get_reached = protected_methods_after.count("GET") > protected_methods_before.count("GET")
        head_reached = protected_methods_after.count("HEAD") > protected_methods_before.count("HEAD")

        negative_green: Dict[str, bool] = {}
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            blocked_before = _blocked_count(harness)
            reached_before = len(protected.requests())
            probe_results[method] = _fetch_probe(
                main_page,
                f"{protected.origin}/blocked-{method.lower()}?query-value-must-not-be-logged",
                method,
            )
            _qualification_wait_for_timeout(main_page, 100)
            negative_green[method] = _confirm_blocked_label(
                harness, protected, method, blocked_before, reached_before
            )

        blocked_before = _blocked_count(harness)
        reached_before = len(protected.requests())
        probe_results["XHR POST"] = _xhr_post_probe(
            main_page, f"{protected.origin}/blocked-xhr?query-value-must-not-be-logged"
        )
        _qualification_wait_for_timeout(main_page, 100)
        negative_green["XHR POST"] = _confirm_blocked_label(
            harness, protected, "XHR POST", blocked_before, reached_before
        )

        blocked_before = _blocked_count(harness)
        reached_before = len(protected.requests())
        _form_post_probe(main_page, f"{protected.origin}/blocked-form?query-value-must-not-be-logged")
        negative_green["FORM POST"] = _confirm_blocked_label(
            harness, protected, "FORM POST", blocked_before, reached_before
        )

        blocked_before = _blocked_count(harness)
        reached_before = len(protected.requests())
        probe_results["SENDBEACON"] = _send_beacon_probe(
            main_page, f"{protected.origin}/blocked-beacon?query-value-must-not-be-logged"
        )
        negative_green["SENDBEACON"] = _confirm_blocked_label(
            harness, protected, "SENDBEACON", blocked_before, reached_before
        )

        blocked_before = _blocked_count(harness)
        reached_before = len(protected.requests())
        probe_results["OTHER METHOD"] = _fetch_probe(
            main_page, f"{protected.origin}/blocked-propfind?query-value-must-not-be-logged", "PROPFIND"
        )
        _qualification_wait_for_timeout(main_page, 100)
        negative_green["OTHER METHOD"] = (
            _blocked_count(harness) > blocked_before and len(protected.requests()) == reached_before
        )

        popup = harness.open_popup(
            main_page, f"{protected.origin}/popup.html?query-value-must-not-be-logged"
        )
        popup.wait_until_loaded("domcontentloaded")
        popup_blocked_before = _blocked_count(harness)
        popup_reached_before = len(protected.requests())
        probe_results["POPUP POST"] = _fetch_probe(
            popup, f"{protected.origin}/blocked-popup?query-value-must-not-be-logged", "POST"
        )
        _qualification_wait_for_timeout(popup, 100)
        popup_green = (
            _blocked_count(harness) > popup_blocked_before
            and len(protected.requests()) == popup_reached_before
            and any(
                item["path"] == "/popup.html" and item["allowed"] and item["pageIdentity"] != "page-1"
                for item in harness.report()["audit"]
            )
        )

        second_page = harness.new_page()
        second_page.goto(f"{protected.origin}/second-page.html")
        second_blocked_before = _blocked_count(harness)
        second_reached_before = len(protected.requests())
        probe_results["SECOND PAGE POST"] = _fetch_probe(
            second_page, f"{protected.origin}/blocked-second-page", "POST"
        )
        _qualification_wait_for_timeout(second_page, 100)
        second_page_green = (
            _blocked_count(harness) > second_blocked_before
            and len(protected.requests()) == second_reached_before
        )

        sw_paths_before = [item["path"] for item in protected.requests()]
        probe_results["SERVICE WORKER"] = _qualification_evaluate(
            main_page,
            """async url => {
              if (!('serviceWorker' in navigator)) return {supported:false, registrationResolved:false};
              try {
                const registration = await navigator.serviceWorker.register(url);
                await new Promise(resolve => setTimeout(resolve, 250));
                return {
                  supported:true,
                  registrationResolved:true,
                  installing:Boolean(registration.installing),
                  waiting:Boolean(registration.waiting),
                  active:Boolean(registration.active),
                  controller:Boolean(navigator.serviceWorker.controller)
                };
              } catch (error) {
                return {
                  supported:true,
                  registrationResolved:false,
                  installing:false,
                  waiting:false,
                  active:false,
                  controller:false,
                  errorName:error && error.name ? error.name : 'Error'
                };
              }
            }""",
            f"{protected.origin}/sw.js?query-value-must-not-be-logged",
        )
        _qualification_wait_for_timeout(main_page, 250)
        sw_paths_after = [item["path"] for item in protected.requests()]
        service_worker_green = (
            probe_results["SERVICE WORKER"].get("supported") is True
            and probe_results["SERVICE WORKER"].get("installing") is False
            and probe_results["SERVICE WORKER"].get("waiting") is False
            and probe_results["SERVICE WORKER"].get("active") is False
            and probe_results["SERVICE WORKER"].get("controller") is False
            and harness.service_worker_count() == 0
            and sw_paths_after.count("/sw.js") == sw_paths_before.count("/sw.js")
        )

        ws_before = harness.report()["webSocketsBlocked"]
        ws_handshakes_before = protected.web_socket_handshake_count()
        probe_results["WEBSOCKET"] = _websocket_probe(
            main_page, f"{protected.websocket_origin}/socket?query-value-must-not-be-logged"
        )
        _qualification_wait_for_timeout(main_page, 100)
        websocket_green = (
            harness.report()["webSocketsBlocked"] > ws_before
            and protected.web_socket_handshake_count() == ws_handshakes_before
        )

        control_page = harness.new_page()
        control_page.goto(f"{control.origin}/login.html")
        control_reached_before = len(control.requests())
        probe_results["CONTROL ORIGIN POST"] = _fetch_probe(
            control_page, f"{control.origin}/control-write", "POST"
        )
        _qualification_wait_for_timeout(control_page, 100)
        exact_origin_green = (
            len(control.requests()) > control_reached_before and "POST" in control.reached_methods()
        )
        _qualification_click(control_page, "#gate")
        gate_before = _qualification_evaluate(control_page, "window.localHumanGate === true")
        _qualification_wait_for_timeout(control_page, 100)
        gate_after = _qualification_evaluate(control_page, "window.localHumanGate === true")
        gate_preserved = bool(gate_before and gate_after)
        control_page.screenshot("local-synthetic-gate.png")

        protected_reached_methods = protected.reached_methods()
        mutating_reached = sorted(
            set(protected_reached_methods).intersection({"POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"})
        )
        sentinel_green = bool(
            get_reached
            and head_reached
            and all(negative_green.values())
            and second_page_green
            and exact_origin_green
            and not mutating_reached
        )
        security_warnings = []
        if not gate_preserved:
            security_warnings.append("synthetic_human_gate_context_not_preserved")
        harness.complete_local_probes(
            sentinel_green=sentinel_green,
            service_worker_green=service_worker_green,
            websocket_green=websocket_green,
            popup_green=popup_green and second_page_green,
            security_warnings=security_warnings,
        )
        probe_results["NEGATIVE GREEN"] = negative_green
        probe_results["EXACT ORIGIN GREEN"] = exact_origin_green
        probe_results["SYNTHETIC GATE PRESERVED"] = gate_preserved
        probe_results["MANDATORY BLOCKED LABELS"] = sorted(MANDATORY_BLOCKED_METHODS)
    finally:
        harness.close()
        protected.close()
        control.close()
        protected_log = protected.requests()
        control_log = control.requests()

    report = harness.report()
    harness.write_report(evidence / "browserguard-report.json")
    _write_json(
        evidence / "sentinel-log.json",
        {
            "protected": {"metadata": protected.metadata(), "requests": protected_log},
            "control": {"metadata": control.metadata(), "requests": control_log},
        },
    )
    _write_json(evidence / "probe-results.json", probe_results)
    _write_manifest(evidence)
    return {
        "evidenceDirectory": str(evidence),
        "report": report,
        "protectedSentinel": protected.metadata(),
        "controlSentinel": control.metadata(),
        "protectedRequests": protected_log,
        "controlRequests": control_log,
        "probeResults": probe_results,
    }


def main() -> int:
    from orchestrate import run_synthetic_orchestration

    outcome = run_synthetic_orchestration()
    print(json.dumps(outcome, sort_keys=True))
    return 0 if outcome.get("shutdown", {}).get("state") == "CLOSED" else 1


if __name__ == "__main__":
    sys.exit(main())
