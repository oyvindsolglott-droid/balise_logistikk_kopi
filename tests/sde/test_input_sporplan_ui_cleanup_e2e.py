from __future__ import annotations

import contextlib
import functools
import http.server
import json
import pathlib
import threading
import unittest
from urllib.parse import urlparse

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


def shared_readback(revision: int, mapping: dict[str, str]) -> dict[str, object]:
    return {
        "ok": True,
        "mode": "shared_sporplan_draft",
        "revision": revision,
        "updatedAt": "2026-08-19T05:00:00.000Z",
        "serverStateAuthority": False,
        "operationalAuthority": False,
        "writesRepresentOperationalAuthority": False,
        "draft": {"grunnoppstilling": mapping, "grunnoppstillingRep": {}},
        "audit": {"updatedByActor": "test", "updatedByDevice": "browser", "clientContext": {}},
    }


class InputSporplanUiCleanupBrowserTests(unittest.TestCase):
    def run_surface(
        self,
        viewport: dict[str, int],
        exercise_delete: bool,
        authorized: bool = True,
    ) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport=viewport, has_touch=viewport["width"] <= 390)
            page = context.new_page()
            page_errors: list[str] = []
            console_errors: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            posted: list[dict[str, object]] = []
            mutating_requests: list[str] = []
            shared = {"revision": 1, "mapping": {"5M": "74-54", "4S": "75-76"}}

            def api(route) -> None:
                request = route.request
                path = urlparse(request.url).path
                if request.method not in {"GET", "HEAD", "OPTIONS"}:
                    mutating_requests.append(f"{request.method} {path}")
                if path == "/api/auth/capabilities":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({
                        "ok": True,
                        "roleResolved": True,
                        "roles": ["txp"] if authorized else ["drops"],
                        "capabilities": {"input_sporplan.delete": {
                            "allowed": authorized,
                            "decision": "ALLOW" if authorized else "DENY",
                        }},
                    }))
                    return
                if path == "/api/shared-sporplan-draft" and request.method == "GET":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(
                        shared_readback(shared["revision"], shared["mapping"])
                    ))
                    return
                if path == "/api/shared-sporplan-draft" and request.method == "POST":
                    payload = request.post_data_json
                    posted.append(payload)
                    self.assertEqual(payload["expectedRevision"], shared["revision"])
                    self.assertEqual(payload["draft"]["grunnoppstilling"], {"__shared_sporplan_reset__": "SDE-SYNC-M"})
                    shared["revision"] += 1
                    shared["mapping"] = {"__shared_sporplan_reset__": "SDE-SYNC-M"}
                    route.fulfill(status=201, content_type="application/json", body=json.dumps(
                        shared_readback(shared["revision"], shared["mapping"])
                    ))
                    return
                if path == "/api/vehicle-status":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({
                        "ok": True, "revision": 0, "items": [], "faults": [], "notifications": []
                    }))
                    return
                if path == "/api/vehicle-status/analytics":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))
                    return
                if path.startswith("/api/"):
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))
                    return
                route.continue_()

            page.route("**/*", api)
            page.goto(f"{base_url}/index.html?tab=grunnoppstilling", wait_until="domcontentloaded")
            page.wait_for_selector("#grunnoppstilling.active")
            if authorized:
                page.wait_for_function("document.querySelector('#deleteSporplanBtn')?.disabled === false")
            else:
                page.wait_for_function("document.querySelector('#deleteSporplanBtn')?.disabled === true")

            body_text = page.locator("body").inner_text()
            self.assertNotIn("Grunnoppstilling er fysisk registrert tomtestatus", body_text)
            self.assertNotIn("Delt sporplan aktiv", body_text)
            self.assertNotIn("Les delt draft", body_text)
            self.assertNotIn("Lagre delt parkert-hvor", body_text)
            self.assertNotIn("5M → 74-54", body_text)
            self.assertNotIn("4S → 75-76", body_text)
            self.assertEqual(page.get_by_role("button", name="Les delt draft").count(), 0)
            self.assertEqual(page.get_by_role("button", name="Lagre delt parkert-hvor").count(), 0)
            self.assertEqual(page.locator("#sharedSporplanDraftStatus, #sharedSporplanDraftReadback, #sharedSporplanDraftWriteState").count(), 0)
            self.assertEqual(page.locator('#grunnoppstilling [aria-label="Delt sporplan-draft"]').count(), 0)

            disclosure = page.locator("#txpUnavailableInfrastructurePanel details")
            summary = disclosure.locator("summary")
            first_track_control = page.locator("[data-txp-unavailable-track='1']")
            self.assertEqual(disclosure.count(), 1)
            self.assertEqual(summary.inner_text(), "TXP driftsbegrensning / uvirksom infrastruktur")
            self.assertFalse(disclosure.evaluate("element => element.open"))
            self.assertEqual(summary.get_attribute("aria-expanded"), "false")
            self.assertFalse(first_track_control.is_visible())
            self.assertFalse(first_track_control.evaluate(
                "element => { element.focus(); return document.activeElement === element; }"
            ))

            actual_before_ui_cleanup = page.evaluate("JSON.stringify(state.grunnoppstilling)")
            if viewport["width"] <= 390:
                summary.tap()
            else:
                summary.click()
            page.wait_for_function(
                "document.querySelector('#txpUnavailableInfrastructurePanel summary')?.getAttribute('aria-expanded') === 'true'"
            )
            self.assertTrue(disclosure.evaluate("element => element.open"))
            self.assertEqual(summary.get_attribute("aria-expanded"), "true")
            original_track_choice = first_track_control.is_checked()
            first_track_control.click()
            self.assertNotEqual(first_track_control.is_checked(), original_track_choice)
            if viewport["width"] <= 390:
                summary.tap()
            else:
                summary.click()
            page.wait_for_function(
                "document.querySelector('#txpUnavailableInfrastructurePanel summary')?.getAttribute('aria-expanded') === 'false'"
            )
            self.assertFalse(disclosure.evaluate("element => element.open"))
            self.assertEqual(summary.get_attribute("aria-expanded"), "false")
            self.assertFalse(first_track_control.is_visible())

            summary.focus()
            summary.press("Space" if viewport["width"] <= 390 else "Enter")
            page.wait_for_function(
                "document.querySelector('#txpUnavailableInfrastructurePanel summary')?.getAttribute('aria-expanded') === 'true'"
            )
            self.assertTrue(disclosure.evaluate("element => element.open"))
            self.assertEqual(summary.get_attribute("aria-expanded"), "true")
            self.assertTrue(first_track_control.is_visible())
            self.assertNotEqual(first_track_control.is_checked(), original_track_choice)
            first_track_control.click()
            self.assertEqual(first_track_control.is_checked(), original_track_choice)

            page.evaluate("buildGrunnoppstilling()")
            self.assertTrue(disclosure.evaluate("element => element.open"))
            self.assertEqual(summary.get_attribute("aria-expanded"), "true")
            page.wait_for_timeout(1000)
            self.assertEqual(mutating_requests, [], "opening, closing or rerendering the panel must not perform a server write")
            self.assertEqual(
                page.evaluate("JSON.stringify(state.grunnoppstilling)"),
                actual_before_ui_cleanup,
                "removing the projection and using the disclosure must preserve underlying placement input",
            )
            self.assertLessEqual(
                page.evaluate("document.documentElement.scrollWidth"),
                page.evaluate("document.documentElement.clientWidth") + 1,
                "the Input Sporplan surface must not create horizontal page overflow",
            )

            delete_button = page.locator("#deleteSporplanBtn")
            self.assertEqual(delete_button.inner_text(), "Slett Sporplan")
            self.assertEqual(delete_button.count(), 1)
            if not authorized:
                self.assertFalse(delete_button.is_visible())
                self.assertTrue(delete_button.is_disabled())
                self.assertEqual(delete_button.get_attribute("tabindex"), "-1")
                delete_button.evaluate("element => element.click()")
                page.wait_for_timeout(100)
                self.assertEqual(posted, [], "unauthorized delete must not write")
                self.assertEqual(page_errors, [])
                self.assertEqual(console_errors, [])
                context.close()
                browser.close()
                return

            self.assertTrue(delete_button.is_visible())
            vehicle_5m = page.locator("#grunnoppstillingTable tr").filter(has_text="5M").locator("input").first
            self.assertEqual(vehicle_5m.input_value(), "74-54")

            if exercise_delete:
                dialogs: list[str] = []
                dialog_actions = ["dismiss", "accept", "accept"]

                def handle_dialog(dialog) -> None:
                    dialogs.append(dialog.message)
                    action = dialog_actions.pop(0)
                    dialog.dismiss() if action == "dismiss" else dialog.accept()

                page.on("dialog", handle_dialog)
                delete_button.click()
                page.wait_for_timeout(100)
                self.assertEqual(posted, [], "cancelled confirmation must not write")
                self.assertEqual(len(dialogs), 1)
                delete_button.click()
                page.wait_for_function("document.querySelector('#grunnoppstillingTable tr:nth-child(1)') !== null")
                page.wait_for_function("!Array.from(document.querySelectorAll('#grunnoppstillingTable input')).some(input => input.value === '74-54')")
                self.assertEqual(len(posted), 1)
                self.assertIn("Faktisk plassering og øvrig operativ tilstand endres ikke", dialogs[0])
                self.assertGreaterEqual(len(dialogs), 3)
                self.assertEqual(shared["revision"], 2)
                self.assertEqual(vehicle_5m.input_value(), "")
                self.assertEqual(mutating_requests, ["POST /api/shared-sporplan-draft"])

            self.assertEqual(page_errors, [])
            self.assertEqual(console_errors, [])

            context.close()
            browser.close()

    def test_desktop_surface_and_authorized_delete_readback(self) -> None:
        self.run_surface({"width": 1440, "height": 1000}, exercise_delete=True)

    def test_mobile_390_surface_is_collapsed_reachable_and_noise_free(self) -> None:
        self.run_surface({"width": 390, "height": 844}, exercise_delete=False)

    def test_unauthorized_user_cannot_activate_delete(self) -> None:
        self.run_surface({"width": 1440, "height": 1000}, exercise_delete=False, authorized=False)


if __name__ == "__main__":
    unittest.main()
