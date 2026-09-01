"""Browser guard for the v0.3 scanner import path in Registrer Plan i SDE.

A scanner that exists but refuses us (401/403/503) must fail closed, because the
legacy detector's failure text reads like a verdict on the photo and would hide
an authorization or configuration fault. A scanner route that is absent entirely
(404/501, or no API at all on the static public build) may still fall back, but
the result must say which engine produced it.
"""
from __future__ import annotations

import contextlib
import functools
import http.server
import json
import pathlib
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "sde" / "fixtures" / "night-plan" / "historical-togplassering-skien.png"

CAPABILITIES = {
    "ok": True,
    "roleResolved": True,
    "roles": ["drops", "txp", "sde_skiftere", "verksted", "agila"],
    "capabilities": {"night_plan.read": {"allowed": True}},
}

SCANNER_OK = {
    "ok": True,
    "engine": "togplassering-skien-scanner-v0.3",
    "clientApiKey": False,
    "persistsImages": False,
}

GEOMETRY_HIGH = {
    "ok": True,
    "metrics": {
        "vertical_lines": 9,
        "horizontal_lines": 31,
        "vertical_rmse": 1.46,
        "horizontal_rmse": 0.731,
        "confidence": "high",
    },
    "corners": [[13.0, 22.0], [383.0, 4.0], [389.0, 622.0], [43.0, 629.0]],
    "preview": {},
}


def make_handler(status_code: int, status_body: dict, geometry: dict | None):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            return

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/auth/capabilities":
                self._json(200, CAPABILITIES)
                return
            if path == "/api/togplassering-scanner/status":
                self._json(status_code, status_body)
                return
            super().do_GET()

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            if path == "/api/togplassering-scanner/geometry" and geometry is not None:
                self._json(200, geometry)
                return
            self._json(status_code, status_body)

    return Handler


@contextlib.contextmanager
def static_server(status_code: int, status_body: dict, geometry: dict | None = None):
    handler = functools.partial(make_handler(status_code, status_body, geometry), directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class ScannerUnavailableFailClosedTests(unittest.TestCase):
    def _import_attempt(self, base_url: str):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_context(viewport={"width": 1440, "height": 1100}).new_page()
            errors: list[str] = []
            scanner_calls: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on(
                "request",
                lambda request: scanner_calls.append(urlsplit(request.url).path)
                if "togplassering-scanner" in request.url
                else None,
            )
            page.goto(base_url, wait_until="domcontentloaded")
            page.locator('[data-tab="sdeNattplanErfaring"]').wait_for(timeout=30_000)
            page.locator("#accessLevelSelect").select_option("2")
            page.locator('[data-tab="sdeNattplanErfaring"]').click()
            page.wait_for_timeout(150)
            page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
            page.wait_for_timeout(300)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_timeout(6000)
            result = {
                "progress": page.locator("#sdeNightOcrProgress").inner_text().strip(),
                "scan_disabled": page.locator("#sdeNightScanAiBtn").is_disabled(),
                "badge": page.locator("#sdeNightGeomBadge").inner_text().strip(),
                "calls": scanner_calls,
                "errors": errors,
            }
            browser.close()
            return result

    def test_unavailable_scanner_reports_its_own_cause(self) -> None:
        body = {"ok": False, "error": "access_identity_configuration_missing"}
        with static_server(503, body) as base_url:
            result = self._import_attempt(base_url)

        self.assertIn("SCANNER_UNAVAILABLE", result["progress"])
        self.assertIn("HTTP 503", result["progress"])
        self.assertIn("access_identity_configuration_missing", result["progress"])
        # The legacy detector's verdict on the photo must not appear.
        self.assertNotIn("TEMPLATE_UNKNOWN", result["progress"])
        self.assertNotIn("radlinjer", result["progress"])
        self.assertTrue(result["scan_disabled"])
        self.assertEqual(result["calls"], ["/api/togplassering-scanner/status"])
        self.assertEqual(result["errors"], [])

    def test_missing_scanner_route_labels_the_engine_that_produced_the_result(self) -> None:
        body = {"ok": False, "error": "not_found"}
        with static_server(404, body) as base_url:
            result = self._import_attempt(base_url)

        self.assertIn("V03_UNAVAILABLE", result["progress"])
        self.assertIn("HTTP 404", result["progress"])
        self.assertIn("GAMMEL DETEKTOR", result["progress"])
        # The legacy run still reports its own outcome behind the label.
        self.assertNotIn("SCANNER_UNAVAILABLE", result["progress"])
        self.assertEqual(result["calls"], ["/api/togplassering-scanner/status"])
        self.assertEqual(result["errors"], [])

    def test_available_scanner_unlocks_ai_reading_on_high_geometry(self) -> None:
        with static_server(200, SCANNER_OK, GEOMETRY_HIGH) as base_url:
            result = self._import_attempt(base_url)

        self.assertEqual(result["badge"], "HIGH")
        self.assertIn("AI-lesing er tilgjengelig", result["progress"])
        self.assertFalse(result["scan_disabled"])
        self.assertEqual(
            result["calls"],
            ["/api/togplassering-scanner/status", "/api/togplassering-scanner/geometry"],
        )
        self.assertEqual(result["errors"], [])


if __name__ == "__main__":
    unittest.main()
