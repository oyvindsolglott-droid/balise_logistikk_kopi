from __future__ import annotations

import contextlib
import datetime as dt
import functools
import http.server
import json
import pathlib
import threading
import unittest

from playwright.sync_api import BrowserType, Route, sync_playwright


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


def source_revision(context: dict[str, object]) -> str:
    return str(
        context.get("sourceRevision")
        or context.get("sourceUpdatedAt")
        or context.get("sourceObservedAt")
        or ""
    )


def shifted(value: str, minutes: int) -> str:
    parsed = dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    return (parsed + dt.timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")


def build_readback() -> tuple[dict[str, object], dict[str, int]]:
    payload = json.loads((ROOT / "data" / "api_idag.json").read_text(encoding="utf-8"))
    delays = {"835": 2, "837": 4, "839": -1}
    records = []
    for train, arrival in payload["arrivals"].items():
        context = arrival.get("movementContext") or {}
        if not context:
            continue
        delay = delays.get(train)
        estimated = shifted(context["plannedArrival"], delay) if delay is not None else ""
        records.append(
            {
                "operationalDate": context["operationalDate"],
                "trainNumber": context["trainNumber"],
                "stationRef": context["stationRef"],
                "direction": "arrival",
                "plannedArrival": context["plannedArrival"],
                "routeId": context["routeId"],
                "stopId": context["stopId"],
                "occurrenceId": context["occurrenceId"],
                "sourceRevision": source_revision(context),
                "estimatedArrival": estimated,
                "actualArrival": "",
                "delayMinutes": delay,
                "delaySource": "estimated_arrival_at_skien" if delay is not None else "",
                "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "freshness": "fresh" if delay is not None else "unavailable",
                "status": "live" if delay is not None else "live_time_not_available",
            }
        )
    return {
        "ok": True,
        "contract": "sde-tursatt-live-arrivals-v1",
        "operationalDate": payload["date"],
        "writePerformed": False,
        "records": records,
    }, delays


def open_tursatt(browser_type: BrowserType, base_url: str, width: int, height: int):
    browser = browser_type.launch(headless=True)
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    readback, delays = build_readback()

    def live_arrivals(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body=json.dumps(readback))

    page.route("**/api/tursatt/live-arrivals?*", live_arrivals)
    methods: list[str] = []
    page.on("request", lambda request: methods.append(request.method))
    page.goto(base_url)
    page.locator('button[data-tab="oppstilling"]').click()
    page.wait_for_function(
        "document.querySelectorAll('#oppstillingTable td[data-live-arrival-status=LIVE]').length >= 3"
    )
    return browser, context, page, methods, delays


def arrival_row(page, train: str):
    return page.locator("#oppstillingTable tbody tr").filter(
        has=page.locator("td:first-child", has_text=train)
    ).first


class TursattLiveArrivalBrowserTests(unittest.TestCase):
    def verify_surface(self, browser_type: BrowserType, base_url: str, width: int, height: int) -> None:
        browser, context, page, methods, _delays = open_tursatt(browser_type, base_url, width, height)
        try:
            row_835 = arrival_row(page, "835")
            row_837 = arrival_row(page, "837")
            row_839 = arrival_row(page, "839")

            self.assertEqual(row_835.locator("td:nth-child(2) .tursatt-planned-arrival").inner_text(), "23:53")
            self.assertEqual(row_835.locator("td:nth-child(2) .tursatt-live-arrival-delay").inner_text(), "+2")
            self.assertIn("short-delay", row_835.locator("td:nth-child(2) .tursatt-live-arrival-delay").get_attribute("class"))

            self.assertEqual(row_837.locator("td:nth-child(2) .tursatt-planned-arrival").inner_text(), "00:50 +1")
            self.assertEqual(row_837.locator("td:nth-child(2) .tursatt-live-arrival-delay").inner_text(), "+4")
            self.assertIn("long-delay", row_837.locator("td:nth-child(2) .tursatt-live-arrival-delay").get_attribute("class"))

            self.assertEqual(row_839.locator("td:nth-child(2) .tursatt-planned-arrival").inner_text(), "01:45 +1")
            self.assertEqual(row_839.locator("td:nth-child(2) .tursatt-live-arrival-delay").count(), 0)
            self.assertEqual(row_839.locator("td:nth-child(2)").get_attribute("data-live-arrival-status"), "LIVE")

            forced_rows = [row_835, row_837, row_839]
            parking_diagnostic = page.evaluate(
                """() => {
                  const bindings = buildSdeTursattVehicleBindings();
                  const plan = buildSdeTursattPostArrivalShiftNeeds(bindings);
                  const markers = refreshTursattPostArrivalParkingMarkers();
                  return {
                    bindings: bindings.filter(row => row.role === "arrival" && ["835", "837", "839"].includes(row.train)).map(row => ({
                      train: row.train,
                      occurrenceId: row.occurrenceId,
                      vehicle: row.vehicle,
                      part: row.part,
                      canonicalOccurrencePartKey: row.canonicalOccurrencePartKey
                    })),
                    needs: plan.needs.filter(need => need.forcedTrainRule).map(need => ({
                      train: need.arrivalTrainNumber,
                      vehicle: need.vehicleId,
                      part: need.part,
                      sourceOccurrenceId: need.sourceOccurrenceId
                    })),
                    markerKeys: Array.from(markers.keys())
                  };
                }"""
            )
            for row in forced_rows:
                markers = row.locator('[data-tursatt-post-arrival-parking="true"]')
                actual_vehicles = row.locator("td:nth-child(3) input, td:nth-child(6) input").evaluate_all(
                    "elements => elements.filter(element => /^(69|70|72|74|75)-\\d{2}$/.test(element.value)).length"
                )
                self.assertEqual(markers.count(), actual_vehicles, parking_diagnostic)
                self.assertEqual(markers.locator(".opp-split-remove-hint").all_text_contents(), ["PARKERES"] * actual_vehicles)

            time_geometry = row_837.locator("td:nth-child(2)").evaluate(
                "element => ({clientWidth:element.clientWidth, scrollWidth:element.scrollWidth, whiteSpace:getComputedStyle(element).whiteSpace})"
            )
            self.assertEqual(time_geometry["whiteSpace"], "nowrap")
            self.assertLessEqual(time_geometry["scrollWidth"], time_geometry["clientWidth"] + 1)
            self.assertTrue(all(method in {"GET", "HEAD"} for method in methods), methods)
        finally:
            context.close()
            browser.close()

    def test_live_delay_and_parking_markers_on_desktop_webkit_and_mobile(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            for browser_type, width, height in [
                (playwright.chromium, 1440, 900),
                (playwright.webkit, 1440, 900),
                (playwright.chromium, 390, 844),
            ]:
                with self.subTest(browser=browser_type.name, width=width):
                    self.verify_surface(browser_type, base_url, width, height)


if __name__ == "__main__":
    unittest.main()
