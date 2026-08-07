from __future__ import annotations

import contextlib
import functools
import http.server
import pathlib
import tempfile
import threading
import unittest

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def static_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class NightPlanningBrowserTests(unittest.TestCase):
    def test_manual_image_and_read_only_decision_support_flow(self):
        with static_server() as base_url, tempfile.TemporaryDirectory() as temporary, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            business_writes: list[str] = []
            page_errors: list[str] = []
            page.on(
                "request",
                lambda request: business_writes.append(f"{request.method} {request.url}")
                if request.method not in {"GET", "HEAD", "OPTIONS"}
                else None,
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            page.goto(f"{base_url}/?tab=sdeNattplanErfaring", wait_until="domcontentloaded")
            page.wait_for_function("typeof window.SdeNightIntelligence === 'object'")
            page.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            page.locator('[data-tab="sdeNattplanErfaring"]').click()
            page.locator("#sdeNightPlanRows tr").first.wait_for()

            image_input = page.locator("#sdeNightImageInput")
            self.assertEqual(image_input.get_attribute("accept"), ".jpg,.jpeg,.png,image/jpeg,image/png")
            self.assertEqual(image_input.get_attribute("capture"), "environment")

            page.get_by_label("Tid linje 1").fill("22:53")
            page.get_by_label("Fra tog linje 1").fill("833")
            page.get_by_label("Til tog linje 1").fill("802")
            page.get_by_label("Kjøretøy linje 1").fill("74-38")
            page.get_by_label("Ønsket spor linje 1").fill("12S")
            page.get_by_label("Oppgave linje 1").fill("VANN_WC")
            page.get_by_label("Kritiske felt kontrollert for linje 1").check()
            page.locator("#sdeNightConfirmedBy").fill("E2E TEST")

            page.locator("#sdeNightValidateBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="Read-only analyse fullført").wait_for(timeout=30_000)
            self.assertIn("0.0.0-cold-start", page.locator("#sdeNightModelStatus").inner_text())
            self.assertIn("INSUFFICIENT_DATA", page.locator("#sdeNightModelStatus").inner_text())
            self.assertIn("Kun beslutningsstøtte", page.locator("#sdeNightAnalysisResults").inner_text())

            page.locator("#sdeNightConfirmPlanBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret som CONFIRMED").wait_for()
            saved_text = page.locator("#sdeNightSavedPlans").inner_text()
            self.assertIn("CONFIRMED", saved_text)
            self.assertIn("E2E TEST", saved_text)

            image_path = pathlib.Path(temporary) / "nattplan.png"
            fixture_page = context.new_page()
            fixture_page.set_viewport_size({"width": 1400, "height": 360})
            fixture_page.set_content(
                "<style>body{margin:0;background:white;color:black;font:700 54px Arial;padding:45px;line-height:1.6}</style>"
                "<div>22:53 Fra 833 Til 802 74-38 12S WC VANN</div>"
                "<div>00:50 Fra 837 Til 808 74-47 6N VERKSTED</div>"
            )
            fixture_page.screenshot(path=str(image_path), full_page=True)
            fixture_page.close()

            image_input.set_input_files(str(image_path))
            page.locator("#sdeNightPlanStatus").filter(has_text="holdes bare midlertidig").wait_for()
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="Bildet er tolket").wait_for(timeout=120_000)
            self.assertGreaterEqual(page.locator("#sdeNightPlanRows tr").count(), 1)
            self.assertIn("råbildet er ikke lagret", page.locator("#sdeNightOcrProgress").inner_text())

            page.get_by_label("Kjøretøy linje 1").fill("74-38")
            page.get_by_label("Ønsket spor linje 1").fill("12S")
            page.get_by_label("Kritiske felt kontrollert for linje 1").check()
            ocr_row_count = page.locator("#sdeNightPlanRows tr").count()
            page.locator("#sdeNightAddEntryBtn").click()
            self.assertEqual(page.locator("#sdeNightPlanRows tr").count(), ocr_row_count + 1)
            page.locator(f'[data-sde-night-remove="{ocr_row_count}"]').click()
            self.assertEqual(page.locator("#sdeNightPlanRows tr").count(), ocr_row_count)
            page.locator("#sdeNightRemoveImageBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="Råbildet er fjernet").wait_for()

            self.assertEqual(business_writes, [])
            self.assertEqual(page_errors, [])
            context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
