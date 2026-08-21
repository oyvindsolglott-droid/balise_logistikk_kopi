from __future__ import annotations

import contextlib
import functools
import http.server
import pathlib
import threading
import unittest

from playwright.sync_api import BrowserType, Page, sync_playwright


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


def open_tursatt(browser_type: BrowserType, base_url: str, width: int, height: int, dpr: int = 1):
    browser = browser_type.launch(headless=True)
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=dpr,
    )
    page = context.new_page()
    page.goto(base_url)
    page.locator('button[data-tab="oppstilling"]').click()
    page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 2")
    return browser, context, page


def geometry(page: Page) -> dict[str, object]:
    return page.evaluate(
        """
        () => {
          const table = document.querySelector('#oppstillingTable');
          const headers = Array.from(table.querySelectorAll('thead tr:nth-child(2) th'));
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          const chosen = [rows[0], rows[Math.floor(rows.length / 2)], rows.at(-1)];
          const rect = element => {
            const value = element.getBoundingClientRect();
            return {left:value.left, right:value.right, width:value.width, center:(value.left + value.right) / 2};
          };
          const body = chosen.map(row => Array.from(row.children).map(rect));
          const group = Array.from(table.querySelectorAll('thead tr:first-child th')).map(rect);
          return {
            tableCount: document.querySelectorAll('#oppstilling table').length,
            colCount: table.querySelectorAll('colgroup col').length,
            headers: headers.map(rect),
            body,
            group,
            rowCount: rows.length,
            documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        }
        """
    )


def paint_geometry(page: Page) -> dict[str, object]:
    return page.evaluate(
        """
        () => {
          const wrap = document.querySelector('#oppstilling .zoom-wrap');
          const zoom = document.querySelector('#apiCombinedZoom');
          const table = document.querySelector('#oppstillingTable');
          const samples = [
            table.querySelector('thead tr:first-child th'),
            table.querySelector('thead tr:nth-child(2) th'),
            table.querySelector('tbody tr:first-child td:first-child'),
          ];
          const rect = element => {
            const value = element.getBoundingClientRect();
            return {left:value.left, right:value.right, width:value.width};
          };
          const textRect = element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while(node && !node.textContent.trim()) node = walker.nextNode();
            if(!node) return null;
            const range = document.createRange();
            range.selectNodeContents(node);
            const value = range.getBoundingClientRect();
            return {left:value.left, right:value.right, width:value.width};
          };
          return {
            wrap: rect(wrap),
            zoom: rect(zoom),
            table: rect(table),
            samples: samples.map(element => ({box:rect(element), text:textRect(element)})),
          };
        }
        """
    )


def row_data(page: Page) -> list[list[str]]:
    return page.evaluate(
        """
        () => Array.from(document.querySelectorAll('#oppstillingTable tbody tr')).map(row =>
          Array.from(row.children).map(cell => {
            const input = cell.querySelector('input');
            return input ? input.value : cell.textContent.trim();
          })
        )
        """
    )


class TursattAlignmentBrowserTests(unittest.TestCase):
    def assert_geometry(self, measured: dict[str, object], tolerance: float) -> None:
        self.assertEqual(measured["tableCount"], 1)
        self.assertEqual(measured["colCount"], 14)
        self.assertEqual(len(measured["headers"]), 14)
        self.assertGreaterEqual(measured["rowCount"], 3)
        for cells in measured["body"]:
            self.assertEqual(len(cells), 14)
            for index, header in enumerate(measured["headers"]):
                cell = cells[index]
                for key in ["left", "right", "width", "center"]:
                    self.assertLessEqual(abs(float(header[key]) - float(cell[key])), tolerance, (index, key, header, cell))
        arrivals = measured["headers"][:7]
        departures = measured["headers"][7:]
        self.assertLessEqual(abs(float(measured["group"][0]["left"]) - float(arrivals[0]["left"])), tolerance)
        self.assertLessEqual(abs(float(measured["group"][0]["right"]) - float(arrivals[-1]["right"])), tolerance)
        self.assertLessEqual(abs(float(measured["group"][1]["left"]) - float(departures[0]["left"])), tolerance)
        self.assertLessEqual(abs(float(measured["group"][1]["right"]) - float(departures[-1]["right"])), tolerance)

    def assert_painted_text_is_in_scroll_viewport(self, measured: dict[str, object], width: int) -> None:
        wrap = measured["wrap"]
        table = measured["table"]
        expected_unscaled_width = max(980 if width <= 700 else 1120, float(wrap["width"]))
        scale = float(measured["zoom"]["width"]) / float(table["width"])
        self.assertLessEqual(
            float(table["width"]),
            expected_unscaled_width * scale + 2,
            measured,
        )
        for sample in measured["samples"]:
            text = sample["text"]
            self.assertIsNotNone(text, sample)
            self.assertGreater(float(text["width"]), 0, sample)
            self.assertGreater(float(text["right"]), float(wrap["left"]), sample)
            self.assertLess(float(text["left"]), float(wrap["right"]), sample)

    def test_tursatt_width_is_bounded_and_representative_text_is_actually_painted(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            for browser_type, width, height in [
                (playwright.chromium, 1280, 800),
                (playwright.webkit, 1440, 900),
                (playwright.chromium, 390, 844),
            ]:
                browser, context, page = open_tursatt(browser_type, base_url, width, height)
                self.assert_painted_text_is_in_scroll_viewport(paint_geometry(page), width)
                context.close()
                browser.close()

    def test_desktop_header_body_share_exact_tracks_at_required_widths_and_dpr(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            for width, height, dpr in [(1280, 800, 1), (1440, 900, 1), (1920, 1080, 1), (1440, 900, 2)]:
                browser, context, page = open_tursatt(playwright.chromium, base_url, width, height, dpr)
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                before = row_data(page)
                self.assert_geometry(geometry(page), 2 if dpr == 2 else 1)
                page.evaluate("document.documentElement.style.zoom = '1.25'")
                self.assert_geometry(geometry(page), 2)
                page.evaluate("document.documentElement.style.zoom = ''")
                page.set_viewport_size({"width": width - 40, "height": height})
                page.set_viewport_size({"width": width, "height": height})
                self.assertEqual(row_data(page), before)
                self.assertEqual(errors, [])
                context.close()
                browser.close()

    def test_webkit_desktop_and_mobile_390_keep_one_scroll_context_without_write(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            for browser_type, width, height in [
                (playwright.webkit, 1440, 900),
                (playwright.chromium, 390, 844),
            ]:
                browser, context, page = open_tursatt(browser_type, base_url, width, height)
                writes: list[str] = []
                page.on("request", lambda request: writes.append(request.method) if request.method not in {"GET", "HEAD"} else None)
                before = row_data(page)
                self.assert_geometry(geometry(page), 2 if width == 390 else 1)
                page.evaluate(
                    """
                    () => {
                      const wrap = document.querySelector('#oppstilling .zoom-wrap');
                      wrap.scrollLeft = Math.min(240, wrap.scrollWidth - wrap.clientWidth);
                    }
                    """
                )
                self.assert_geometry(geometry(page), 2 if width == 390 else 1)
                self.assertEqual(row_data(page), before)
                if width == 390:
                    self.assertLessEqual(int(geometry(page)["documentOverflow"]), 1)
                self.assertEqual(writes, [])
                context.close()
                browser.close()


if __name__ == "__main__":
    unittest.main()
