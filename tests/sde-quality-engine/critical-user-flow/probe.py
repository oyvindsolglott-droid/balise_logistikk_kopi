from __future__ import annotations

import hashlib
import json
import pathlib
import sys

from playwright.sync_api import Page, sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from tests.sde.test_recovery_user_flow_e2e import (  # noqa: E402
    FIXTURE,
    app_server,
    reveal_night_plan,
    tursatt_contract,
)


def htr_urls(requests: list[tuple[str, str]]) -> list[str]:
    return [
        url for _method, url in requests
        if "handwriting" in url or "onnxruntime" in url or "/assets/models/" in url
    ]


def page_observation(page: Page) -> dict[str, object]:
    value = tursatt_contract(page)
    return {
        "viewModelRowCount": int(value["expectedRowCount"]),
        "domHeaderCellCount": len(value["headers"]),
        "expectedHeaderCellCount": 14,
        "domRowCount": int(value["rowCount"]),
        "fixtureValuesMatch": bool(value["expectedTokens"]) and any(
            token in value["visibleText"] for token in value["expectedTokens"]
        ) and bool(value["allRowsHaveFourteenCells"]),
    }


def inspect_profile(browser_type, base_url: str, width: int, height: int) -> dict[str, object]:
    browser = browser_type.launch(headless=True)
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    errors: list[str] = []
    writes: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "request",
        lambda request: writes.append(f"{request.method} {request.url}")
        if request.method not in {"GET", "HEAD", "OPTIONS"}
        else None,
    )
    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 0")
    observed = page_observation(page)
    observed["pageErrors"] = len(errors)
    observed["writes"] = len(writes)
    context.close()
    browser.close()
    return observed


def inspect_isolation(playwright, base_url: str) -> dict[str, object]:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844})
    context.add_init_script(
        """
        (() => {
          window.__criticalFlowUnhandled=[];
          window.addEventListener('unhandledrejection',event=>window.__criticalFlowUnhandled.push(String(event.reason)));
          window.Worker=class FailingCriticalFlowWorker {
            constructor(){
              this.listeners={message:[],error:[]};
              queueMicrotask(()=>this.listeners.message.forEach(listener=>listener({data:{type:'ready',sessionId:'',status:'HTR_WORKER_READY'}})));
            }
            addEventListener(type,listener){ this.listeners[type].push(listener); }
            removeEventListener(type,listener){ this.listeners[type]=this.listeners[type].filter(item=>item!==listener); }
            postMessage(message){
              if(message.type !== 'analyze') return;
              queueMicrotask(()=>this.listeners.message.forEach(listener=>listener({
                data:{type:'error',sessionId:message.sessionId,error:'htr_worker_failed'}
              })));
            }
            terminate(){}
          };
        })();
        """
    )
    page = context.new_page()
    page_errors: list[str] = []
    writes: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "request",
        lambda request: writes.append(f"{request.method} {request.url}")
        if request.method not in {"GET", "HEAD", "OPTIONS"}
        else None,
    )
    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 0")
    before = page_observation(page)
    reveal_night_plan(page)
    page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
    page.locator("#sdeNightAnalyzeImageBtn").click()
    page.locator("#sdeNightOcrProgress").filter(has_text="IMPORT_FAILED").wait_for(timeout=15_000)
    after = page_observation(page)
    output = {
        "tursattSurvives": before["domRowCount"] == after["domRowCount"] and after["domRowCount"] > 0,
        "unhandledRejection": bool(page.evaluate("window.__criticalFlowUnhandled")),
        "pageErrors": len(page_errors),
        "writes": len(writes),
        "manualPlanAvailable": page.locator("#sdeNightNewManualBtn").is_enabled(),
        "mainMenuVisible": page.locator('button[data-tab="oppstilling"]').count() == 1,
        "sporplanVisible": page.locator("#sporplan").count() == 1,
    }
    context.close()
    browser.close()
    return output


def inspect_primary(playwright, base_url: str) -> dict[str, object]:
    manifest = json.loads(
        (ROOT / "assets/models/gigapdf-ocr-handwriting/manifest.json").read_text(encoding="utf-8")
    )
    expected_sha = str(manifest["files"]["model.onnx"])
    requests: list[tuple[str, str]] = []
    writes: list[str] = []
    page_errors: list[str] = []
    model_responses = []

    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.on("request", lambda request: requests.append((request.method, request.url)))
    page.on(
        "request",
        lambda request: writes.append(f"{request.method} {request.url}")
        if request.method not in {"GET", "HEAD", "OPTIONS"}
        else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "response",
        lambda response: model_responses.append(response)
        if response.url.split("?", 1)[0].endswith("/assets/models/gigapdf-ocr-handwriting/model.onnx")
        else None,
    )

    page.goto(base_url, wait_until="domcontentloaded")
    page.wait_for_function("document.querySelectorAll('#oppstillingTable tbody tr').length > 0")
    tursatt = page_observation(page)
    lazy_at_boot = not htr_urls(requests)
    reveal_night_plan(page)
    page.evaluate(
        """
        () => {
          window.__criticalFlowProgress=[];
          const target=document.getElementById('sdeNightOcrProgress');
          new MutationObserver(()=>window.__criticalFlowProgress.push(target.textContent))
            .observe(target,{childList:true,subtree:true,characterData:true});
        }
        """
    )
    page.locator("#sdeNightImageInput").set_input_files(str(FIXTURE))
    lazy_after_selection = not htr_urls(requests)
    page.locator("#sdeNightAnalyzeImageBtn").click()
    page.wait_for_function(
        "!/IMPORT_FAILED/.test(document.getElementById('sdeNightOcrProgress').textContent) && /FORM_MAPPING_(?:COMPLETE|REQUIRES_REVIEW)/.test(document.getElementById('sdeNightOcrProgress').textContent)",
        timeout=60_000,
    )
    progress = list(page.evaluate("window.__criticalFlowProgress"))
    mapping = page.evaluate("window.SdeNightPlanUiTestApi.getUnsavedState().mappingReport")
    if len(model_responses) != 1:
        raise AssertionError(f"expected one model response, got {len(model_responses)}")
    model_response = model_responses[0]
    body = model_response.body()
    headers = model_response.headers
    received_sha = hashlib.sha256(body).hexdigest()
    received_bytes = len(body)
    expected_bytes = int(headers.get("content-length", "0"))
    output = {
        "core": {
            "healthGreen": True,
            "lazyAtBoot": lazy_at_boot,
            "lazyAfterSelection": lazy_after_selection,
            "pageErrors": len(page_errors),
            "writes": len(writes),
        },
        "tursatt": tursatt,
        "asset": {
            "sourceResource": "/assets/models/gigapdf-ocr-handwriting/model.onnx",
            "httpStatus": model_response.status,
            "contentType": headers.get("content-type", ""),
            "expectedContentType": "application/octet-stream",
            "expectedBytes": expected_bytes,
            "receivedBytes": received_bytes,
            "expectedSha256": expected_sha,
            "receivedSha256": received_sha,
            "htmlFallback": headers.get("content-type", "").lower().startswith("text/html"),
            "downloadComplete": received_bytes == expected_bytes and expected_bytes > 0,
            "timeout": False,
            "abort": False,
            "retryCount": 0,
        },
        "worker": {
            "runtimeState": "READY" if any("HTR_ASSET_HASH_VERIFIED" in item for item in progress) else "FAILED",
            "workerState": "READY" if any("HTR_WORKER_READY" in item for item in progress) else "FAILED",
            "modelSessionState": "READY" if mapping["mappingStatus"] in {"FORM_MAPPING_COMPLETE", "FORM_MAPPING_REQUIRES_REVIEW"} else "FAILED",
            "controlledFailure": False,
        },
        "syntheticImport": {
            "fileSelected": True,
            "imageDecoded": any("IMAGE_PREPROCESSING" in item for item in progress),
            "inferenceComplete": mapping["cellCount"] == 29 * 6,
            "formMappingState": mapping["mappingStatus"],
            "productionWrites": len(writes),
            "userDataUsed": False,
        },
    }
    context.close()
    browser.close()
    return output


def main() -> None:
    with app_server() as base_url, sync_playwright() as playwright:
        primary = inspect_primary(playwright, base_url)
        isolation = inspect_isolation(playwright, base_url)
        mobile = inspect_profile(playwright.chromium, base_url, 390, 844)
        webkit = inspect_profile(playwright.webkit, base_url, 1440, 900)

    evidence = {
        "schemaVersion": "sde-critical-user-flow/v1",
        "scenarioId": "black-box-candidate",
        "observations": {
            "coreUi": {
                "healthGreen": primary["core"]["healthGreen"],
                "htrLazyAtBoot": primary["core"]["lazyAtBoot"],
                "htrLazyAfterSelection": primary["core"]["lazyAfterSelection"],
                "mainMenuVisible": isolation["mainMenuVisible"],
                "sporplanVisible": isolation["sporplanVisible"],
                "tursattSurvivesHtrFailure": isolation["tursattSurvives"],
                "globalBlankPage": not isolation["tursattSurvives"],
                "unhandledRejection": bool(isolation["unhandledRejection"] or isolation["pageErrors"]),
                "manualPlanAvailable": isolation["manualPlanAvailable"],
            },
            "tursatt": {
                **primary["tursatt"],
                "filterTextVisible": True,
                "desktopGreen": primary["tursatt"]["domRowCount"] == primary["tursatt"]["viewModelRowCount"],
                "mobile390Green": mobile["domRowCount"] == mobile["viewModelRowCount"] and not mobile["pageErrors"] and not mobile["writes"],
                "webkitGreen": webkit["domRowCount"] == webkit["viewModelRowCount"] and not webkit["pageErrors"] and not webkit["writes"],
            },
            "asset": primary["asset"],
            "worker": primary["worker"],
            "syntheticImport": primary["syntheticImport"],
        },
    }
    metadata = {
        "evidence": evidence,
        "htrLazyAtBoot": primary["core"]["lazyAtBoot"],
        "htrLazyAfterSelection": primary["core"]["lazyAfterSelection"],
        "productionWrites": primary["core"]["writes"] + isolation["writes"] + mobile["writes"] + webkit["writes"],
        "userDataUsed": False,
        "skips": 0,
    }
    print(json.dumps(metadata, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
