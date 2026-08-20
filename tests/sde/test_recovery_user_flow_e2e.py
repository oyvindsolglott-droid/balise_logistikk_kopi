from __future__ import annotations

import contextlib
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

from playwright.sync_api import Page, sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]
SERVER_ROOT = ROOT / "server"
FIXTURE = ROOT / "tests" / "sde" / "fixtures" / "night-plan" / "synthetic-htr-varied.png"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@contextlib.contextmanager
def app_server():
    port = free_port()
    with tempfile.TemporaryDirectory() as temporary:
        environment = os.environ.copy()
        environment["PORT"] = str(port)
        environment["SDE_SERVER_DB_PATH"] = str(pathlib.Path(temporary) / "recovery.sqlite3")
        process = subprocess.Popen(
            ["node", "src/index.js"],
            cwd=SERVER_ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        base_url = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    output = process.stdout.read() if process.stdout else ""
                    raise RuntimeError(f"isolated appserver exited early\n{output}")
                try:
                    with urllib.request.urlopen(f"{base_url}/api/health", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("isolated appserver did not become healthy")
            yield base_url
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()


def reveal_night_plan(page: Page) -> None:
    page.evaluate(
        """
        () => {
          const panel=document.getElementById('sdeNattplanErfaring');
          panel.hidden=false;
          panel.inert=false;
          panel.setAttribute('aria-hidden','false');
          document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
          panel.classList.add('active');
          window.renderSdeNightPlanningWorkspace();
        }
        """
    )


def tursatt_contract(page: Page) -> dict[str, object]:
    return page.evaluate(
        """
        () => {
          const viewModel=buildTursattViewModel();
          const table=document.getElementById('oppstillingTable');
          const headers=Array.from(table.querySelectorAll('thead tr:nth-child(2) th')).map(cell=>cell.textContent.trim());
          const rows=Array.from(table.querySelectorAll('tbody tr'));
          const cells=rows.map(row=>Array.from(row.children).map(cell=>{
            const input=cell.querySelector('input');
            return input ? input.value : cell.textContent.trim();
          }));
          const expectedTokens=[...viewModel.arrivalRows,...viewModel.departureRows]
            .flatMap(row=>[row && row.train,row && (row.displayTime || row.time)])
            .map(value=>String(value || '').trim()).filter(Boolean);
          return {
            headers,
            rowCount:rows.length,
            expectedRowCount:viewModel.visibleRowCount,
            allRowsHaveFourteenCells:cells.every(row=>row.length === 14),
            expectedTokens,
            visibleText:table.textContent,
          };
        }
        """
    )


class RecoveryUserFlowBrowserTests(unittest.TestCase):
    def test_appserver_core_boot_tursatt_and_real_htr_import(self) -> None:
        with app_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            requests: list[tuple[str, str]] = []
            responses: dict[str, tuple[int, str, str]] = {}
            page_errors: list[str] = []
            writes: list[str] = []
            page.on("request", lambda request: requests.append((request.method, request.url)))
            page.on("request", lambda request: writes.append(f"{request.method} {request.url}") if request.method not in {"GET", "HEAD", "OPTIONS"} else None)
            page.on("response", lambda response: responses.__setitem__(response.url, (
                response.status,
                response.headers.get("content-type", ""),
                response.headers.get("content-length", ""),
            )))
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            page.goto(base_url, wait_until="domcontentloaded")
            page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 0")
            before_htr = [url for _method, url in requests if "handwriting" in url or "onnxruntime" in url or "/assets/models/" in url]
            self.assertEqual(before_htr, [], "HTR must not participate in core boot")

            tursatt = tursatt_contract(page)
            self.assertEqual(len(tursatt["headers"]), 14)
            self.assertEqual(tursatt["rowCount"], tursatt["expectedRowCount"])
            self.assertTrue(tursatt["allRowsHaveFourteenCells"])
            self.assertTrue(tursatt["expectedTokens"])
            self.assertTrue(any(token in tursatt["visibleText"] for token in tursatt["expectedTokens"]))

            reveal_night_plan(page)
            page.evaluate(
                """
                () => {
                  window.__recoveryHtrProgress=[];
                  const target=document.getElementById('sdeNightOcrProgress');
                  new MutationObserver(()=>window.__recoveryHtrProgress.push(target.textContent))
                    .observe(target,{childList:true,subtree:true,characterData:true});
                }
                """
            )
            page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
            after_selection = [url for _method, url in requests if "handwriting" in url or "onnxruntime" in url or "/assets/models/" in url]
            self.assertEqual(after_selection, [], "image selection must remain lazy")
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_function(
                "!/IMPORT_FAILED/.test(document.getElementById('sdeNightOcrProgress').textContent) && /FORM_MAPPING_(?:COMPLETE|REQUIRES_REVIEW)/.test(document.getElementById('sdeNightOcrProgress').textContent)",
                timeout=60_000,
            )

            progress = page.evaluate("window.__recoveryHtrProgress")
            for required in ["HTR_WORKER_READY", "HTR_ASSET_DOWNLOAD_COMPLETE", "HTR_ASSET_HASH_VERIFIED"]:
                self.assertTrue(any(required in value for value in progress), (required, progress))
            report = page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().mappingReport")
            self.assertIn(report["mappingStatus"], {"FORM_MAPPING_COMPLETE", "FORM_MAPPING_REQUIRES_REVIEW"})
            self.assertEqual(report["cellCount"], 29 * 6)

            for suffix, expected_type in [
                ("/assets/models/gigapdf-ocr-handwriting/manifest.json", "application/json"),
                ("/assets/models/gigapdf-ocr-handwriting/model.onnx", "application/octet-stream"),
                ("/assets/models/gigapdf-ocr-handwriting/dict.txt", "text/plain"),
            ]:
                matching = [value for url, value in responses.items() if url.split("?", 1)[0].endswith(suffix)]
                self.assertEqual(len(matching), 1, suffix)
                status, content_type, content_length = matching[0]
                self.assertEqual(status, 200)
                self.assertTrue(content_type.startswith(expected_type), (suffix, content_type))
                self.assertGreater(int(content_length), 0)

            self.assertEqual(tursatt_contract(page)["rowCount"], tursatt["rowCount"])
            self.assertEqual(writes, [])
            self.assertEqual(page_errors, [])
            context.close()
            browser.close()

    def test_all_htr_failures_stay_local_while_tursatt_survives(self) -> None:
        scenarios = [
            "htr_asset_http_404",
            "htr_asset_timeout",
            "htr_asset_content_length_mismatch",
            "htr_asset_hash_mismatch",
            "htr_wasm_initialization_failed",
            "htr_worker_failed",
            "htr_model_session_failed",
            "htr_inference_failed",
        ]
        with app_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for scenario in scenarios:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                context.add_init_script(
                    f"""
                    (() => {{
                      const failure={json.dumps(scenario)};
                      window.__recoveryUnhandled=[];
                      window.addEventListener('unhandledrejection',event=>window.__recoveryUnhandled.push(String(event.reason)));
                      window.Worker=class FailingHtrWorker {{
                        constructor(){{
                          if(failure === 'htr_worker_failed') throw new Error(failure);
                          this.listeners={{message:[],error:[]}};
                          queueMicrotask(()=>this.listeners.message.forEach(listener=>listener({{data:{{type:'ready',sessionId:'',status:'HTR_WORKER_READY'}}}})));
                        }}
                        addEventListener(type,listener){{ this.listeners[type].push(listener); }}
                        removeEventListener(type,listener){{ this.listeners[type]=this.listeners[type].filter(item=>item!==listener); }}
                        postMessage(message){{
                          if(message.type !== 'analyze') return;
                          queueMicrotask(()=>this.listeners.message.forEach(listener=>listener({{
                            data:{{type:'error',sessionId:message.sessionId,error:failure}}
                          }})));
                        }}
                        terminate(){{}}
                      }};
                    }})();
                    """
                )
                page = context.new_page()
                errors: list[str] = []
                writes: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: writes.append(f"{request.method} {request.url}") if request.method not in {"GET", "HEAD", "OPTIONS"} else None)
                page.goto(base_url, wait_until="domcontentloaded")
                page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 0")
                before = tursatt_contract(page)
                reveal_night_plan(page)
                page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
                page.locator("#sdeNightAnalyzeImageBtn").click()
                page.locator("#sdeNightOcrProgress").filter(has_text="IMPORT_FAILED").wait_for(timeout=15_000)
                self.assertIn("Lokal bildeanalyse feilet", page.locator("#sdeNightPlanStatus").inner_text())
                self.assertTrue(page.locator("#sdeNightNewManualBtn").is_enabled())
                page.locator('button[data-tab="oppstilling"]').click()
                after = tursatt_contract(page)
                self.assertEqual(after["headers"], before["headers"], scenario)
                self.assertEqual(after["rowCount"], before["rowCount"], scenario)
                self.assertEqual(page.evaluate("window.__recoveryUnhandled"), [], scenario)
                self.assertEqual(errors, [], scenario)
                self.assertEqual(writes, [], scenario)
                context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
