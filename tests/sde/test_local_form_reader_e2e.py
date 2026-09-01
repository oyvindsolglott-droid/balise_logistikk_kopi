"""Browser guard for reading a night plan without a paid remote service.

The import surface must transcribe through the local reader, keep every value the
operator has not confirmed marked for review, and never call the remote scan
route.
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

SCANNER_STATUS = {
    "ok": True,
    "engine": "togplassering-skien-scanner-v0.3",
    "localReader": "local-pp-ocrv5",
    "clientApiKey": False,
    "persistsImages": False,
}

GEOMETRY = {
    "ok": True,
    "metrics": {
        "vertical_lines": 9,
        "horizontal_lines": 31,
        "vertical_rmse": 1.46,
        "horizontal_rmse": 0.73,
        "confidence": "high",
    },
    "corners": [[13.0, 22.0], [383.0, 4.0], [389.0, 622.0], [43.0, 629.0]],
    "preview": {},
}

FIELDS = ["klokken", "fra_tog", "til_tog", "setter", "til_spor", "vd_vann", "info", "merknad"]


def _row(row_no: int, row_type: str, values: dict[str, str], confidence: dict[str, str]) -> dict:
    row = {"row_no": row_no, "row_type": row_type, "review_reason": "", "confidence": {}}
    for field in FIELDS:
        row[field] = values.get(field, "")
        row["confidence"][field] = confidence.get(field, "high")
    row["til_spor_normalized"] = row["til_spor"]
    row["til_spor_valid"] = True
    return row


# Shaped exactly like a real local read: certain structured values, free text
# always held back for review.
READ_RESULT = {
    "ok": True,
    "engine": "local-pp-ocrv5",
    "form_title": "TOGPLASSERING SKIEN",
    "date_raw": "21.08.2026",
    "ai_double_checked": False,
    "conflicts": [],
    "warnings": ["Lokal lesing uten AI-tjeneste."],
    "needs_review": True,
    "geometry": GEOMETRY["metrics"],
    "preview": {},
    "rows": (
        [
            _row(
                1,
                "train",
                {"klokken": "16:30", "fra_tog": "851", "til_tog": "852", "setter": "74-04", "til_spor": "5"},
                {"til_spor": "low"},
            ),
            _row(
                2,
                "train",
                {"klokken": "16:53", "fra_tog": "821/1", "til_tog": "816/2", "setter": "74-41", "info": "vask"},
                {"info": "low"},
            ),
        ]
        + [_row(index, "train", {}, {}) for index in range(3, 17)]
        + [_row(index, "note", {}, {}) for index in range(1, 4)]
    ),
}


def make_handler():
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
                self._json(200, SCANNER_STATUS)
                return
            super().do_GET()

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            if path == "/api/togplassering-scanner/geometry":
                self._json(200, GEOMETRY)
                return
            if path == "/api/togplassering-scanner/read":
                self._json(200, READ_RESULT)
                return
            self._json(404, {"ok": False, "error": "not_found"})

    return Handler


@contextlib.contextmanager
def static_server():
    handler = functools.partial(make_handler(), directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class LocalFormReaderBrowserTests(unittest.TestCase):
    def test_import_reads_locally_and_holds_unconfirmed_values_for_review(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_context(viewport={"width": 1440, "height": 1100}).new_page()
            errors: list[str] = []
            calls: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on(
                "request",
                lambda request: calls.append(urlsplit(request.url).path)
                if "togplassering-scanner" in request.url
                else None,
            )
            page.goto(base_url, wait_until="domcontentloaded")
            page.locator('[data-tab="sdeNattplanErfaring"]').wait_for(timeout=30_000)
            page.locator("#accessLevelSelect").select_option("2")
            page.locator('[data-tab="sdeNattplanErfaring"]').click()
            page.wait_for_timeout(150)

            read_button = page.locator("#sdeNightScanAiBtn")
            self.assertEqual(read_button.inner_text(), "Les skjema")

            page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
            page.wait_for_timeout(300)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_timeout(3000)
            self.assertFalse(read_button.is_disabled())

            read_button.click()
            page.wait_for_timeout(3000)

            progress = page.locator("#sdeNightOcrProgress").inner_text()
            self.assertIn("LEST", progress)
            self.assertIn("local-pp-ocrv5", progress)

            state = page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState()")
            rows = state["visibleForm"]["rows"]
            self.assertEqual(state["visibleForm"]["planDate"], "2026-08-21")
            self.assertEqual(rows[0]["fromTrain"], "851")
            self.assertEqual(rows[0]["vehicleId"], "74-04")
            self.assertEqual(rows[0]["toTrack"], "5")

            # A certain structured value is mapped; uncertain ones are held back
            # and marked in the table the operator reads.
            uncertain = page.evaluate(
                """() => {
                  const marked = [...document.querySelectorAll('[data-sde-night-uncertain="true"]')];
                  const cell = (index, field) => {
                    const input = document.querySelector(
                      `[data-sde-night-index="${index}"][data-sde-night-field="${field}"]`
                    );
                    return input ? input.dataset.sdeNightUncertain === 'true' : null;
                  };
                  return {
                    count: marked.length,
                    firstRowFromTrain: cell(0, 'arrivalOccurrence'),
                    firstRowToTrack: cell(0, 'desiredSlot'),
                    secondRowInfo: cell(1, 'info')
                  };
                }"""
            )
            self.assertGreater(uncertain["count"], 0)
            self.assertFalse(uncertain["firstRowFromTrain"])
            self.assertTrue(uncertain["firstRowToTrack"])
            # Free text is never presented as confirmed.
            self.assertTrue(uncertain["secondRowInfo"])

            # The paid route must not be reachable from the import surface.
            self.assertNotIn("/api/togplassering-scanner/scan", calls)
            self.assertEqual(
                calls,
                [
                    "/api/togplassering-scanner/status",
                    "/api/togplassering-scanner/geometry",
                    "/api/togplassering-scanner/read",
                ],
            )
            self.assertEqual(errors, [])
            browser.close()


if __name__ == "__main__":
    unittest.main()
