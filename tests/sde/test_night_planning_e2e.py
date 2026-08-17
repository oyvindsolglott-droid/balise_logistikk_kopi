from __future__ import annotations

import contextlib
import base64
import functools
import hashlib
import http.server
import json
import pathlib
import tempfile
import threading
import unittest
import uuid
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE_ROOT = ROOT / "tests" / "sde" / "fixtures" / "night-plan"


def load_ocr_fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8"))


def tesseract_data(fixture: dict[str, object]) -> dict[str, object]:
    ocr = fixture["ocr"]
    grouped: dict[int, list[dict[str, object]]] = {}
    for token in ocr["tokens"]:
        grouped.setdefault(int(token.get("lineIndex", 0)), []).append(token)
    lines = []
    for line_index in sorted(grouped):
        tokens = sorted(grouped[line_index], key=lambda token: token["bbox"]["x0"])
        bbox = {
            "x0": min(token["bbox"]["x0"] for token in tokens),
            "y0": min(token["bbox"]["y0"] for token in tokens),
            "x1": max(token["bbox"]["x1"] for token in tokens),
            "y1": max(token["bbox"]["y1"] for token in tokens),
        }
        lines.append({
            "text": " ".join(str(token["text"]) for token in tokens),
            "bbox": bbox,
            "words": tokens,
        })
    return {
        "text": "\n".join(line["text"] for line in lines),
        "confidence": float(ocr["confidence"]) * 100,
        "blocks": [{"paragraphs": [{"lines": lines}]}],
        "tableGeometry": ocr["tableGeometry"],
    }


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
    def test_explicit_server_save_and_memory_only_image_flow(self):
        with static_server() as base_url, tempfile.TemporaryDirectory() as temporary, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            context.add_init_script(
                """
                window.__nightStorageWrites=[];
                window.__nightIndexedDbCalls=[];
                window.__nightCacheWrites=[];
                const original=Storage.prototype.setItem;
                Storage.prototype.setItem=function(key,value){
                  if(String(key).startsWith('sde_night')) {
                    window.__nightStorageWrites.push((this === sessionStorage ? 'session:' : 'local:') + String(key));
                  }
                  return original.call(this,key,value);
                };
                if(window.indexedDB){
                  const open=window.indexedDB.open.bind(window.indexedDB);
                  const remove=window.indexedDB.deleteDatabase.bind(window.indexedDB);
                  window.indexedDB.open=function(){ window.__nightIndexedDbCalls.push('open'); return open(...arguments); };
                  window.indexedDB.deleteDatabase=function(){ window.__nightIndexedDbCalls.push('delete'); return remove(...arguments); };
                }
                if(window.Cache){
                  for(const method of ['put','add','addAll','delete']){
                    const originalMethod=Cache.prototype[method];
                    if(typeof originalMethod === 'function') Cache.prototype[method]=function(){
                      window.__nightCacheWrites.push(method);
                      return originalMethod.apply(this,arguments);
                    };
                  }
                }
                """
            )
            page = context.new_page()
            business_writes: list[str] = []
            page_errors: list[str] = []
            posted_payloads: list[dict[str, object]] = []
            stored: dict[str, dict[str, object]] = {}
            idempotent_responses: dict[str, dict[str, object]] = {}
            fail_readback_once = {"enabled": False}

            def canonical(value: object) -> str:
                return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

            def night_plan_api(route) -> None:
                request = route.request
                parsed = urlparse(request.url)
                parts = [part for part in parsed.path.split("/") if part]
                if request.method == "POST":
                    payload = request.post_data_json
                    posted_payloads.append(payload)
                    replay = idempotent_responses.get(payload["idempotencyKey"])
                    if replay:
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({**replay, "idempotentReplay": True}))
                        return
                    plan_id = payload.get("planId") or str(uuid.uuid4())
                    revision = int(payload.get("expectedRevision", 0)) + 1
                    image = payload.get("image")
                    image_bytes = base64.b64decode(image["bytesBase64"]) if image else b""
                    image_id = str(uuid.uuid4()) if image else None
                    form_sha = hashlib.sha256(canonical(payload["form"]).encode()).hexdigest()
                    image_sha = hashlib.sha256(image_bytes).hexdigest() if image else None
                    readback = {
                        "ok": True,
                        "mode": "night_plan_documentation",
                        "schemaVersion": "sde-night-plan-storage-v1",
                        "planId": plan_id,
                        "revision": revision,
                        "form": payload["form"],
                        "sourceType": payload["source"]["sourceType"],
                        "status": "SAVED",
                        "createdAt": payload["createdAt"],
                        "savedAt": "2026-08-17T10:00:00.000Z",
                        "savedBy": "e2e-verified-subject",
                        "storedImageId": image_id,
                        "storedImageSha256": image_sha,
                        "storedImageByteCount": len(image_bytes),
                        "storedImageMimeType": image["mimeType"] if image else None,
                        "finalFormSha256": form_sha,
                        "provenance": {**payload["source"], "sourceImageSha256": image_sha},
                        "learningSource": "HUMAN_CORRECTED_FORM",
                        "operationalAuthority": False,
                        "operationalStateMutation": False,
                    }
                    stored[plan_id] = {"readback": readback, "image": image_bytes}
                    response = {
                        **readback,
                        "learningRecordId": str(uuid.uuid4()),
                        "learningStatus": "READY",
                    }
                    idempotent_responses[payload["idempotencyKey"]] = response
                    route.fulfill(status=201, content_type="application/json", body=json.dumps(response))
                    return
                if request.method == "GET" and len(parts) == 2:
                    plans = [
                        {
                            "planId": value["readback"]["planId"],
                            "revision": value["readback"]["revision"],
                            "planDate": value["readback"]["form"]["planDate"],
                            "signature": value["readback"]["form"]["signature"],
                            "sourceType": value["readback"]["sourceType"],
                            "finalFormSha256": value["readback"]["finalFormSha256"],
                        }
                        for value in stored.values()
                    ]
                    route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "plans": plans}))
                    return
                if request.method == "GET" and len(parts) == 3:
                    value = stored.get(parts[2])
                    if value and fail_readback_once["enabled"]:
                        fail_readback_once["enabled"] = False
                        mismatched = {**value["readback"], "finalFormSha256": "0" * 64}
                        route.fulfill(status=200, content_type="application/json", body=json.dumps(mismatched))
                        return
                    route.fulfill(
                        status=200 if value else 404,
                        content_type="application/json",
                        body=json.dumps(value["readback"] if value else {"ok": False}),
                    )
                    return
                if request.method == "GET" and len(parts) == 5 and parts[3] == "images":
                    value = stored.get(parts[2])
                    route.fulfill(
                        status=200 if value else 404,
                        content_type=value["readback"]["storedImageMimeType"] if value else "application/json",
                        body=value["image"] if value else b"",
                    )
                    return
                route.fulfill(status=404, content_type="application/json", body='{"ok":false}')

            context.route("**/api/night-plans**", night_plan_api)
            page.on(
                "request",
                lambda request: business_writes.append(f"{request.method} {request.url}")
                if request.method not in {"GET", "HEAD", "OPTIONS"}
                else None,
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            historical_fixture = load_ocr_fixture("historical-togplassering-skien.json")
            fixture_a = load_ocr_fixture("synthetic-fixture-a.json")
            fixture_b = load_ocr_fixture("synthetic-fixture-b.json")
            failed_fixture = {
                "ocr": {
                    "confidence": 0.8,
                    "tableGeometry": fixture_a["ocr"]["tableGeometry"],
                    "tokens": [
                        *[token for token in fixture_a["ocr"]["tokens"] if token.get("lineIndex") == 2],
                        next(token for token in fixture_a["ocr"]["tokens"] if token["text"] == "4M"),
                        *[
                            {
                                "text": f"NOISE-{index}", "confidence": 0.8,
                                "bbox": {"x0": -200, "y0": 300 + index, "x1": -100, "y1": 320 + index},
                                "lineIndex": 10 + index,
                            }
                            for index in range(24)
                        ],
                    ],
                },
            }
            historical_image = FIXTURE_ROOT / historical_fixture["image"]["file"]
            image_a = FIXTURE_ROOT / fixture_a["image"]["file"]
            image_b = FIXTURE_ROOT / fixture_b["image"]["file"]

            def install_ocr(target_page, fixture: dict[str, object]) -> None:
                target_page.evaluate(
                    """data => {
                      window.__nextOcrData=data;
                      window.Tesseract={version:'e2e-local-structured',createWorker:async()=>({
                        recognize:async(_image,_options,output)=>{
                          window.__lastOcrOutput=output;
                          return {data:window.__nextOcrData};
                        },
                        terminate:async()=>{}
                      })};
                    }""",
                    tesseract_data(fixture),
                )

            def select_fixture(target_page, input_selector: str, image: pathlib.Path, fixture: dict[str, object]) -> None:
                install_ocr(target_page, fixture)
                target_page.locator(input_selector).set_input_files(str(image))
                target_page.locator("#sdeNightPlanStatus").filter(has_text="holdes bare midlertidig").wait_for()

            page.goto(f"{base_url}/?tab=sdeNattplanErfaring", wait_until="domcontentloaded")
            page.wait_for_function("typeof window.SdeNightIntelligence === 'object'")
            page.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            page.evaluate(
                """
                const panel=document.getElementById('sdeNattplanErfaring');
                panel.hidden=false; panel.inert=false; panel.setAttribute('aria-hidden','false');
                document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
                panel.classList.add('active');
                window.renderSdeNightPlanningWorkspace();
                """
            )
            page.locator("#sdeNightPlanRows tr").first.wait_for()
            self.assertEqual(page.locator("#sdeNightPlanRows tr").count(), 29)
            self.assertEqual(page.locator(".sde-night-editor th").count(), 6)

            image_input = page.locator("#sdeNightImageInput")
            self.assertEqual(image_input.get_attribute("accept"), ".jpg,.jpeg,.png,image/jpeg,image/png")
            self.assertIsNone(image_input.get_attribute("capture"))
            self.assertEqual(page.locator("#sdeNightCameraInput").get_attribute("capture"), "environment")

            legacy_store = {
                "schemaVersion": "sde-night-plan-store-v1",
                "plans": [{
                    "planId": "legacy-e2e",
                    "operationalDate": "2026-08-19",
                    "createdAt": "2026-08-17T07:00:00.000Z",
                    "createdBy": "LEGACY E2E",
                    "sourceType": "HUMAN_MANUAL_PLAN",
                    "planStatus": "CONFIRMED",
                    "entries": [{"vehicleId": "75-53", "desiredSlot": "5M", "notes": "legacy kontroll"}],
                }],
            }
            legacy_json = json.dumps(legacy_store, separators=(",", ":"))
            page.evaluate("value => localStorage.setItem('sde_night_plans_v1', value)", legacy_json)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            page.evaluate(
                """
                const panel=document.getElementById('sdeNattplanErfaring');
                panel.hidden=false; panel.inert=false; panel.setAttribute('aria-hidden','false');
                document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
                panel.classList.add('active'); window.renderSdeNightPlanningWorkspace();
                """
            )
            self.assertEqual(posted_payloads, [], "legacy records must never auto-upload")
            self.assertEqual(page.evaluate("localStorage.getItem('sde_night_plans_v1')"), legacy_json)
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])

            select_fixture(page, "#sdeNightCameraInput", historical_image, historical_fixture)
            self.assertEqual(posted_payloads, [], "camera selection must not upload")
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.locator("#sdeNightOcrProgress").filter(has_text="FORM_MAPPING_COMPLETE").wait_for()
            self.assertEqual(posted_payloads, [], "OCR result and form must remain memory-only before save")
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])
            self.assertEqual(page.evaluate("window.__nightIndexedDbCalls"), [])
            self.assertEqual(page.evaluate("window.__nightCacheWrites"), [])
            self.assertEqual(page.evaluate("window.__lastOcrOutput"), {"text": True, "blocks": True})
            self.assertEqual(page.get_by_label("Fra tog linje 1", exact=True).input_value(), "851")
            self.assertEqual(page.get_by_label("Til tog linje 1", exact=True).input_value(), "REP")
            self.assertEqual(page.get_by_label("Settnr linje 1", exact=True).input_value(), "74-08")
            self.assertEqual(page.get_by_label("Til spor linje 1", exact=True).input_value(), "8S")
            historical_report = page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().mappingReport")
            self.assertEqual(historical_report["mappingStatus"], "FORM_MAPPING_COMPLETE")
            self.assertGreater(historical_report["mappedCellCount"], 1)
            self.assertGreater(historical_report["detectedRowCount"], 1)

            select_fixture(page, "#sdeNightImageInput", image_a, fixture_a)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_function("document.querySelector('[aria-label=\"Fra tog linje 1\"]').value === 'A101'")
            self.assertEqual(page.get_by_label("Fra tog linje 1", exact=True).input_value(), "A101")
            self.assertEqual(page.get_by_label("Settnr linje 1", exact=True).input_value(), "TEST-A-01")
            self.assertEqual(page.get_by_label("Merknad linje 3", exact=True).input_value(), fixture_a["expected"]["row3Notes"])

            select_fixture(page, "#sdeNightImageInput", image_b, fixture_b)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_function("document.querySelector('[aria-label=\"Fra tog linje 1\"]').value === 'B501'")
            self.assertEqual(page.get_by_label("Fra tog linje 1", exact=True).input_value(), "B501")
            self.assertEqual(page.get_by_label("Settnr linje 1", exact=True).input_value(), "TEST-B-99")
            visible_b = page.evaluate("JSON.stringify(window.SdeNightPlanUiTestApi.getUnsavedState().visibleForm)")
            self.assertNotIn("A101", visible_b)
            self.assertNotIn("TEST-A-01", visible_b)
            self.assertNotIn("8S", visible_b)

            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            page.evaluate(
                """
                const panel=document.getElementById('sdeNattplanErfaring');
                panel.hidden=false; panel.inert=false; panel.setAttribute('aria-hidden','false');
                document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
                panel.classList.add('active'); window.renderSdeNightPlanningWorkspace();
                """
            )
            self.assertEqual(page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().hasImage"), False)
            self.assertEqual(page.get_by_label("Settnr linje 1", exact=True).input_value(), "")
            self.assertEqual(page.evaluate("localStorage.getItem('sde_night_plans_v1')"), legacy_json)
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])

            page.get_by_label("Fra tog linje 1", exact=True).fill("833")
            page.get_by_label("Til tog linje 1", exact=True).fill("802")
            page.get_by_label("Settnr linje 1", exact=True).fill("74-38")
            page.get_by_label("Til spor linje 1", exact=True).fill("12S")
            page.get_by_label("Wc/vann linje 1", exact=True).fill("*")
            page.get_by_label("Merknad linje 1", exact=True).fill("kontrollert")
            page.locator("#sdeNightConfirmedBy").fill("E2E TEST")
            page.locator("#sdeNightDs").fill("ds-e2e")

            self.assertEqual(posted_payloads, [])
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])

            page.locator("#sdeNightValidateBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="Read-only analyse fullført").wait_for(timeout=30_000)
            self.assertIn("0.0.0-cold-start", page.locator("#sdeNightModelStatus").inner_text())
            self.assertIn("INSUFFICIENT_DATA", page.locator("#sdeNightModelStatus").inner_text())
            self.assertIn("Kun beslutningsstøtte", page.locator("#sdeNightAnalysisResults").inner_text())
            self.assertEqual(posted_payloads, [])

            page.evaluate("document.getElementById('sdeNightSaveBtn').click(); document.getElementById('sdeNightSaveBtn').click()")
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret og verifisert fra server").wait_for()
            self.assertEqual(len(posted_payloads), 1)
            manual_payload = posted_payloads[0]
            self.assertEqual(manual_payload["source"]["sourceType"], "MANUAL")
            self.assertIsNone(manual_payload["image"])
            self.assertEqual(len(manual_payload["form"]["rows"]), 29)
            self.assertEqual(manual_payload["form"]["rows"][0]["vehicleId"], "74-38")
            self.assertEqual(manual_payload["form"]["rows"][0]["wcWater"], "*")
            self.assertFalse(manual_payload.get("operationalState"))
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])

            page.locator("#sdeNightNewManualBtn").click()
            select_fixture(page, "#sdeNightImageInput", image_a, fixture_a)
            self.assertEqual(len(posted_payloads), 1, "image selection must not upload")
            self.assertEqual(page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().hasImage"), True)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_function("document.querySelector('[aria-label=\"Fra tog linje 1\"]').value === 'A101'")
            page.locator("#sdeNightConfirmedBy").evaluate("node => { node.value='E2E IMAGE'; }")
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="ikke kontrollert etter bildeimport").wait_for()
            self.assertEqual(len(posted_payloads), 1, "unreviewed mapped form must not save")
            page.locator("#sdeNightEditBtn").click()
            page.locator("#sdeNightConfirmedBy").fill("E2E IMAGE")
            page.get_by_label("Settnr linje 1", exact=True).fill("TEST-A-CORRECTED")
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret og verifisert fra server").wait_for()
            self.assertEqual(len(posted_payloads), 2)
            image_payload = posted_payloads[1]
            self.assertEqual(image_payload["source"]["sourceType"], "DEVICE_FILE")
            self.assertEqual(image_payload["source"]["ocrEngine"], "tesseract.js-local")
            self.assertEqual(image_payload["source"]["mappingStatus"], "FORM_MAPPING_COMPLETE")
            self.assertGreater(image_payload["source"]["mappingReport"]["mappedCellCount"], 1)
            self.assertEqual(image_payload["form"]["rows"][0]["vehicleId"], "TEST-A-CORRECTED")
            self.assertEqual(base64.b64decode(image_payload["image"]["bytesBase64"]), image_a.read_bytes())
            self.assertEqual(page.evaluate("window.__nightStorageWrites"), [])

            page.locator("#sdeNightNewManualBtn").click()
            select_fixture(page, "#sdeNightImageInput", image_b, failed_fixture)
            page.locator("#sdeNightAnalyzeImageBtn").click()
            page.wait_for_function("window.SdeNightPlanUiTestApi.getUnsavedState().importStatus === 'MAPPING_FAILED'")
            self.assertEqual(page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().mappingReport.mappedCellCount"), 1)
            page.locator("#sdeNightConfirmedBy").evaluate("node => { node.value='E2E FAILED MAPPING'; }")
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="ikke kontrollert etter bildeimport").wait_for()
            self.assertEqual(len(posted_payloads), 2, "failed mapping must not save before human review")
            page.locator("#sdeNightEditBtn").click()
            page.locator("#sdeNightConfirmedBy").fill("E2E FAILED MAPPING")
            page.get_by_label("Fra tog linje 1", exact=True).fill("B501")
            page.get_by_label("Settnr linje 1", exact=True).fill("HUMAN-B-01")
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret og verifisert fra server").wait_for()
            self.assertEqual(len(posted_payloads), 3)
            failed_mapping_payload = posted_payloads[2]
            self.assertEqual(failed_mapping_payload["source"]["mappingStatus"], "MAPPING_FAILED")
            self.assertEqual(failed_mapping_payload["source"]["mappingReport"]["mappedCellCount"], 1)
            self.assertEqual(failed_mapping_payload["form"]["rows"][0]["fromTrain"], "B501")
            self.assertEqual(failed_mapping_payload["form"]["rows"][0]["vehicleId"], "HUMAN-B-01")
            self.assertEqual(base64.b64decode(failed_mapping_payload["image"]["bytesBase64"]), image_b.read_bytes())

            page.locator("#sdeNightNewManualBtn").click()
            image_input.set_input_files(str(image_a))
            page.locator("#sdeNightEditBtn").click()
            page.get_by_label("Merknad linje 1", exact=True).fill("skal slettes")
            page.locator("#sdeNightRemoveImageBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="alle ulagrede endringer er fjernet").wait_for()
            self.assertEqual(page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().hasImage"), False)
            self.assertEqual(page.get_by_label("Merknad linje 1", exact=True).input_value(), "")

            page.locator("#sdeNightConfirmedBy").fill("E2E RETRY")
            page.get_by_label("Merknad linje 1", exact=True).fill("idempotent retry")
            fail_readback_once["enabled"] = True
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="readback_mismatch").wait_for()
            first_retry_key = posted_payloads[-1]["idempotencyKey"]
            page.locator("#sdeNightSaveBtn").click()
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret og verifisert fra server").wait_for()
            self.assertEqual(posted_payloads[-1]["idempotencyKey"], first_retry_key)

            posts_before_legacy = len(posted_payloads)
            page.locator("[data-sde-night-open-legacy='0']").click()
            self.assertEqual(len(posted_payloads), posts_before_legacy, "selecting legacy must not upload")
            page.evaluate("document.getElementById('sdeNightSaveBtn').click(); document.getElementById('sdeNightSaveBtn').click()")
            page.locator("#sdeNightPlanStatus").filter(has_text="lagret og verifisert fra server").wait_for()
            self.assertEqual(len(posted_payloads), posts_before_legacy + 1, "double click must produce one save request")
            self.assertEqual(posted_payloads[-1]["source"]["sourceType"], "LEGACY_LOCAL")
            self.assertEqual(page.evaluate("localStorage.getItem('sde_night_plans_v1')"), legacy_json)

            page.locator("#sdeNightNewManualBtn").click()
            image_input.set_input_files(str(image_a))
            page.locator("#sdeNightEditBtn").click()
            page.get_by_label("Merknad linje 1", exact=True).fill("forsvinner ved fanelukking")
            page.close()
            reopened = context.new_page()
            reopened.goto(f"{base_url}/?tab=sdeNattplanErfaring", wait_until="domcontentloaded")
            reopened.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            reopened.evaluate(
                """
                const panel=document.getElementById('sdeNattplanErfaring');
                panel.hidden=false; panel.inert=false; panel.setAttribute('aria-hidden','false');
                document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
                panel.classList.add('active'); window.renderSdeNightPlanningWorkspace();
                """
            )
            self.assertEqual(reopened.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().hasImage"), False)
            self.assertEqual(reopened.get_by_label("Merknad linje 1", exact=True).input_value(), "")
            self.assertEqual(reopened.evaluate("localStorage.getItem('sde_night_plans_v1')"), legacy_json)
            reopened.close()

            mobile = context.new_page()
            mobile.on("pageerror", lambda error: page_errors.append(str(error)))
            mobile.set_viewport_size({"width": 390, "height": 844})
            mobile.goto(f"{base_url}/?tab=sdeNattplanErfaring", wait_until="domcontentloaded")
            mobile.wait_for_function("typeof window.renderSdeNightPlanningWorkspace === 'function'")
            mobile.evaluate(
                """
                const panel=document.getElementById('sdeNattplanErfaring');
                panel.hidden=false; panel.inert=false; panel.setAttribute('aria-hidden','false');
                document.querySelectorAll('.panel').forEach(item=>item.classList.remove('active'));
                panel.classList.add('active'); window.renderSdeNightPlanningWorkspace();
                """
            )
            self.assertEqual(mobile.locator("#sdeNightPlanRows tr").count(), 29)
            self.assertLessEqual(mobile.evaluate("document.documentElement.scrollWidth"), 390)
            select_fixture(mobile, "#sdeNightImageInput", image_a, fixture_a)
            mobile.locator("#sdeNightAnalyzeImageBtn").click()
            mobile.wait_for_function("document.querySelector('[aria-label=\"Fra tog linje 1\"]').value === 'A101'")
            self.assertTrue(mobile.locator("#sdeNightPlanStatus").is_visible())
            self.assertTrue(mobile.locator("#sdeNightOcrProgress").is_visible())
            self.assertEqual(mobile.evaluate("window.__nightStorageWrites"), [])
            mobile.close()

            self.assertEqual(len([write for write in business_writes if "/api/night-plans" in write]), 6)
            self.assertEqual(page_errors, [])
            context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
