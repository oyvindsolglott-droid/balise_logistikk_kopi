"""Permanent security and browser probes for the protected browser guard."""

from __future__ import annotations

import json
import shutil
import stat
import sys
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from guard import (  # noqa: E402
    AUDIT_FIELDS,
    GuardInitializationError,
    GuardPolicyError,
    MANDATORY_BLOCKED_METHODS,
    ProtectedBrowserHarness,
    _qualification_wait_for_timeout,
    is_protected_websocket_url,
    normalize_http_origin,
    secure_temp_directory,
    validate_report_shape,
)
from qualify import _fetch_probe, _websocket_probe, run_qualification  # noqa: E402
from sentinel import SentinelServer  # noqa: E402


class _MissingHttpBarrier(ProtectedBrowserHarness):
    def _install_http_barrier(self) -> bool:
        return False


class _MissingWebSocketBarrier(ProtectedBrowserHarness):
    def _install_websocket_barrier(self) -> bool:
        return False


class _ServiceWorkerAllowedMutant(ProtectedBrowserHarness):
    def _context_options(self):
        options = super()._context_options()
        options["service_workers"] = "allow"
        return options


class _EarlyPageMutant(ProtectedBrowserHarness):
    def _before_barrier_installation(self) -> None:
        self._context.new_page()


class _AllowPostMutant(ProtectedBrowserHarness):
    def _is_http_allowed(self, method: str) -> bool:
        return method == "POST" or super()._is_http_allowed(method)


class _ConnectWebSocketMutant(ProtectedBrowserHarness):
    def _websocket_route_handler(self, route) -> None:
        route.connect_to_server()


class BrowserGuardQualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.outcome = run_qualification()
        cls.report = cls.outcome["report"]
        cls.protected_requests = cls.outcome["protectedRequests"]
        cls.control_requests = cls.outcome["controlRequests"]
        cls.probes = cls.outcome["probeResults"]

    def test_01_barriers_are_installed_before_first_page(self) -> None:
        self.assertTrue(self.report["httpBarrierInstalled"])
        self.assertTrue(self.report["webSocketBarrierInstalled"])
        self.assertTrue(self.report["barriersInstalledBeforeFirstPage"])

    def test_02_get_reaches_only_local_protected_sentinel(self) -> None:
        self.assertTrue(self.probes["GET"]["resolved"])
        self.assertIn("GET", [item["method"] for item in self.protected_requests])
        self.assertEqual(self.report["targetOrigin"].split("://", 1)[1].split(":", 1)[0], "127.0.0.1")

    def test_03_head_reaches_only_local_protected_sentinel(self) -> None:
        self.assertTrue(self.probes["HEAD"]["resolved"])
        self.assertIn("HEAD", [item["method"] for item in self.protected_requests])

    def _assert_blocked(self, label: str) -> None:
        self.assertIn(label, self.report["blockedMethods"])
        self.assertTrue(self.probes["NEGATIVE GREEN"][label])

    def test_04_post_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("POST")

    def test_05_put_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("PUT")

    def test_06_patch_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("PATCH")

    def test_07_delete_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("DELETE")

    def test_08_options_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("OPTIONS")

    def test_09_xhr_post_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("XHR POST")

    def test_10_form_post_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("FORM POST")

    def test_11_send_beacon_is_blocked_before_sentinel(self) -> None:
        self._assert_blocked("SENDBEACON")

    def test_12_popup_first_request_and_post_are_context_protected(self) -> None:
        popup_entries = [item for item in self.report["audit"] if item["path"] == "/popup.html"]
        self.assertTrue(popup_entries)
        self.assertTrue(popup_entries[0]["allowed"])
        self.assertNotEqual(popup_entries[0]["pageIdentity"], "page-1")
        self.assertFalse(self.probes["POPUP POST"]["resolved"])
        self.assertTrue(self.report["popupCoverage"])

    def test_13_other_pages_in_context_are_protected(self) -> None:
        self.assertFalse(self.probes["SECOND PAGE POST"]["resolved"])
        page_identities = {item["pageIdentity"] for item in self.report["audit"]}
        self.assertGreaterEqual(len([item for item in page_identities if item.startswith("page-")]), 3)

    def test_14_service_worker_cannot_activate_or_reach_sentinel(self) -> None:
        self.assertTrue(self.report["serviceWorkersBlocked"])
        self.assertEqual(self.report["serviceWorkerProbeStatus"], "GREEN")
        self.assertFalse(self.probes["SERVICE WORKER"]["installing"])
        self.assertFalse(self.probes["SERVICE WORKER"]["waiting"])
        self.assertFalse(self.probes["SERVICE WORKER"]["active"])
        self.assertFalse(self.probes["SERVICE WORKER"]["controller"])
        self.assertNotIn("/sw.js", [item["path"] for item in self.protected_requests])

    def test_15_websocket_is_blocked_before_handshake_or_message(self) -> None:
        self.assertEqual(self.report["webSocketProbeStatus"], "GREEN")
        self.assertGreaterEqual(self.report["webSocketsBlocked"], 1)
        self.assertEqual(sum(1 for item in self.protected_requests if item["webSocketHandshake"]), 0)

    def test_16_exact_origin_matching_does_not_confuse_ports(self) -> None:
        self.assertTrue(self.probes["EXACT ORIGIN GREEN"])
        self.assertIn("POST", [item["method"] for item in self.control_requests])
        self.assertTrue(is_protected_websocket_url("ws://127.0.0.1:18181/socket", "http://127.0.0.1:18181"))
        self.assertFalse(is_protected_websocket_url("ws://127.0.0.1:18182/socket", "http://127.0.0.1:18181"))
        self.assertNotEqual(normalize_http_origin("http://example.invalid:81"), normalize_http_origin("http://example.invalid:82"))

    def test_17_missing_http_routing_is_blocked(self) -> None:
        self._assert_start_blocked(_MissingHttpBarrier)

    def test_18_missing_websocket_routing_is_blocked(self) -> None:
        self._assert_start_blocked(_MissingWebSocketBarrier)

    def test_19_missing_service_worker_blocking_is_blocked(self) -> None:
        self._assert_start_blocked(_ServiceWorkerAllowedMutant)

    def _assert_start_blocked(self, harness_type) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-blocked-test-")
        sentinel = SentinelServer().start()
        harness = harness_type(sentinel.origin, evidence_directory=evidence)
        try:
            with self.assertRaises(GuardInitializationError):
                harness.start()
            self.assertEqual(harness.report()["overallStatus"], "BLOCKED")
            self.assertEqual(sentinel.requests(), [])
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)

    def test_20_audit_log_is_strictly_sanitized(self) -> None:
        serialized = json.dumps(self.report["audit"], sort_keys=True).lower()
        for entry in self.report["audit"]:
            self.assertEqual(set(entry), AUDIT_FIELDS)
            self.assertNotIn("?", entry["path"])
        for forbidden in (
            "query-value-must-not-be-logged",
            "discarded-local-probe",
            "authorization",
            "cookie",
            "token",
            "requestbody",
            "responsebody",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_21_temporary_profile_is_private_and_deleted(self) -> None:
        self.assertTrue(self.report["profileDirectoryDeleted"])
        self.assertTrue(self.report["downloadsIsolated"])

    def test_22_no_sentinel_browser_or_child_process_leaks(self) -> None:
        self.assertEqual(self.outcome["protectedSentinel"]["exitStatus"], 0)
        self.assertEqual(self.outcome["controlSentinel"]["exitStatus"], 0)
        self.assertFalse(self.outcome["protectedSentinel"]["threadAlive"])
        self.assertFalse(self.outcome["controlSentinel"]["threadAlive"])
        self.assertTrue(self.report["browserDisconnected"])

    def test_23_no_production_origin_is_present_in_runtime_evidence(self) -> None:
        runtime_evidence = json.dumps(self.outcome, sort_keys=True)
        forbidden_host = "sde." + "oyvind-solglott.no"
        self.assertNotIn(forbidden_host, runtime_evidence)

    def test_24_overall_status_cannot_be_green_without_every_barrier(self) -> None:
        self.assertEqual(self.report["overallStatus"], "GREEN")
        self.assertTrue(MANDATORY_BLOCKED_METHODS.issubset(set(self.report["blockedMethods"])))
        schema = json.loads(
            (REPO_ROOT / "tests/sde-quality-engine/contracts/sde-production-readonly-browser-guard-v1.schema.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(validate_report_shape(self.report, schema), [])

    def test_25_page_local_routes_cannot_weaken_context_guard(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-page-route-test-")
        sentinel = SentinelServer().start()
        harness = ProtectedBrowserHarness(sentinel.origin, evidence_directory=evidence)
        try:
            harness.start()
            page = harness.new_page()
            with self.assertRaises(GuardPolicyError):
                getattr(page, "route")
            with self.assertRaises(GuardPolicyError):
                getattr(page, "unroute")
            with self.assertRaises(GuardPolicyError):
                getattr(page, "context")
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)

    def test_26_unknown_non_readonly_method_is_also_blocked(self) -> None:
        self.assertFalse(self.probes["OTHER METHOD"]["resolved"])
        self.assertTrue(self.probes["NEGATIVE GREEN"]["OTHER METHOD"])
        self.assertNotIn("PROPFIND", [item["method"] for item in self.protected_requests])

    def test_27_synthetic_human_gate_preserves_context_without_export(self) -> None:
        self.assertTrue(self.probes["SYNTHETIC GATE PRESERVED"])
        source = (HERE / "guard.py").read_text(encoding="utf-8") + (HERE / "qualify.py").read_text(encoding="utf-8")
        self.assertNotIn("storage_state(", source)
        self.assertNotIn("record_har", source)
        self.assertNotIn("tracing.start", source)

    def test_28_headed_and_headless_modes_are_explicitly_supported(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-headed-option-test-")
        harness = ProtectedBrowserHarness("http://127.0.0.1:9", headless=False, evidence_directory=evidence)
        try:
            self.assertFalse(harness.headless)
            mode = stat.S_IMODE(harness.profile_directory.lstat().st_mode)
            self.assertEqual(mode, 0o700)
        finally:
            harness.close()
            shutil.rmtree(evidence)


class BrowserGuardMutationTests(unittest.TestCase):
    def test_mutant_a_allow_post_is_killed(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-mutant-a-")
        sentinel = SentinelServer().start()
        harness = _AllowPostMutant(sentinel.origin, evidence_directory=evidence)
        try:
            harness.start()
            page = harness.new_page()
            page.goto(f"{sentinel.origin}/sentinel.html")
            observed = _fetch_probe(page, f"{sentinel.origin}/mutant-post", "POST")
            _qualification_wait_for_timeout(page, 100)
            harness.complete_local_probes(
                sentinel_green=False,
                service_worker_green=True,
                websocket_green=True,
                popup_green=True,
            )
            self.assertTrue(observed["resolved"])
            self.assertIn("POST", sentinel.reached_methods())
            self.assertEqual(harness.report()["overallStatus"], "RED")
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)

    def test_mutant_b_page_before_context_route_is_killed(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-mutant-b-")
        sentinel = SentinelServer().start()
        harness = _EarlyPageMutant(sentinel.origin, evidence_directory=evidence)
        try:
            with self.assertRaises(GuardInitializationError):
                harness.start()
            self.assertEqual(harness.report()["overallStatus"], "BLOCKED")
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)

    def test_mutant_c_service_workers_not_blocked_is_killed(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-mutant-c-")
        sentinel = SentinelServer().start()
        harness = _ServiceWorkerAllowedMutant(sentinel.origin, evidence_directory=evidence)
        try:
            with self.assertRaises(GuardInitializationError):
                harness.start()
            self.assertEqual(harness.report()["overallStatus"], "BLOCKED")
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)

    def test_mutant_d_websocket_connection_is_killed(self) -> None:
        evidence = secure_temp_directory("sde-qe-browserguard-mutant-d-")
        sentinel = SentinelServer().start()
        harness = _ConnectWebSocketMutant(sentinel.origin, evidence_directory=evidence)
        try:
            harness.start()
            page = harness.new_page()
            page.goto(f"{sentinel.origin}/sentinel.html")
            observed = _websocket_probe(page, f"{sentinel.websocket_origin}/mutant-websocket")
            _qualification_wait_for_timeout(page, 200)
            harness.complete_local_probes(
                sentinel_green=True,
                service_worker_green=True,
                websocket_green=False,
                popup_green=True,
            )
            self.assertTrue(observed["opened"])
            self.assertGreaterEqual(sentinel.web_socket_handshake_count(), 1)
            self.assertEqual(harness.report()["overallStatus"], "RED")
        finally:
            harness.close()
            sentinel.close()
            shutil.rmtree(evidence)


if __name__ == "__main__":
    unittest.main(verbosity=2)
