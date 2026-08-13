from __future__ import annotations

import contextlib
import functools
import http.server
import json
import pathlib
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import Page, sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]


class SdeEmptyDropHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "SdeEmptyDropTest/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/api/auth/capabilities":
            payload = json.dumps(
                {
                    "ok": True,
                    "roleResolved": True,
                    "roles": ["drops", "txp", "sde_skiftere", "verksted", "agila"],
                    "capabilities": {},
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


@contextlib.contextmanager
def static_server():
    handler = functools.partial(SdeEmptyDropHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def reset_graphic_fixture(page: Page, placements: list[list[str]]) -> None:
    page.evaluate(
        """placements => {
          state.grunnoppstilling=Object.fromEntries(placements);
          state.grunnoppstillingRep={};
          state.sdeMoveActions={};
          state.sdeActiveMoveOutcomes={};
          state.sdeNightPlacementManualOverrides={};
          state.sdePhysicalReleaseReplans={};
          state.sdeVnRecoveryObligations={};
          state.sdeCanonicalRetargetIntents={};
          state.planSkifteRows=[];
          state.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
          sdeNightPlacementDropMessage=null;
          sdeNightPlacementBlockedMoveRequest=null;
          sdeNightPlacementSelectedSlot='';
          sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false,score:0};
          sdeShiftViewMode=SDE_SHIFT_VIEW_MODE_GRAPHIC_PLAN;
          renderSdeSkiftebevegelser();
        }""",
        placements,
    )
    page.locator("#sdeNightPlacementPanel").wait_for(timeout=30_000)


def actual_pointer_drag(page: Page, source_slot: str, target_slot: str) -> dict[str, object]:
    source = page.locator(f'[data-sde-night-placement-slot="{source_slot}"][data-sde-night-placement-draggable="1"]')
    target = page.locator(f'[data-sde-night-placement-slot="{target_slot}"]')
    source.scroll_into_view_if_needed()
    target.scroll_into_view_if_needed()
    source_box = source.bounding_box()
    target_box = target.bounding_box()
    if source_box is None or target_box is None:
        raise AssertionError("drag source or target has no browser bounding box")
    source_point = (source_box["x"] + source_box["width"] / 2, source_box["y"] + source_box["height"] / 2)
    target_point = (target_box["x"] + target_box["width"] / 2, target_box["y"] + target_box["height"] / 2)
    page.mouse.move(*source_point)
    page.mouse.down()
    page.mouse.move(source_point[0] + 8, source_point[1] + 8)
    page.mouse.move(*target_point)
    hover = target.evaluate(
        """element => ({
          state:element.dataset.sdeDropTargetState||'',
          dragOver:element.classList.contains('drag-over'),
          relief:element.classList.contains('drop-plan-relief'),
          red:element.classList.contains('drop-unavailable')||element.classList.contains('drop-rejected')
        })"""
    )
    page.mouse.up()
    page.locator(".sde-night-placement-confirmation").wait_for(timeout=30_000)
    return hover


class SdeEmptyTargetDragBrowserTests(unittest.TestCase):
    def test_actual_drag_accepts_empty_relief_target_on_desktop_and_390(self) -> None:
        scenarios = (
            {
                "name": "blocked-target-access",
                "placements": [["9", "BROWSER-MAIN"], ["12N", "BROWSER-BLOCKER"]],
                "source": "9",
                "target": "12S",
                "recovery": "12N",
            },
            {
                "name": "blocked-source-egress",
                "placements": [["12S", "BROWSER-MAIN"], ["12N", "BROWSER-BLOCKER"]],
                "source": "12S",
                "target": "9",
                "recovery": "12S",
            },
        )
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((1280, 900), (390, 844)):
                for scenario in scenarios:
                    with self.subTest(width=width, scenario=scenario["name"]):
                        context = browser.new_context(viewport={"width": width, "height": height})
                        page = context.new_page()
                        page_errors: list[str] = []
                        page.on("pageerror", lambda error: page_errors.append(str(error)))
                        page.goto(base_url, wait_until="domcontentloaded")
                        reset_graphic_fixture(page, scenario["placements"])
                        actual_before = page.evaluate("JSON.stringify(state.grunnoppstilling)")
                        hover = actual_pointer_drag(page, scenario["source"], scenario["target"])
                        self.assertEqual(hover["state"], "AVAILABLE_WITH_RELIEF_PLANNING")
                        self.assertTrue(hover["dragOver"])
                        self.assertTrue(hover["relief"])
                        self.assertFalse(hover["red"])

                        result = page.evaluate(
                            """expectedRecovery => {
                              const reader=buildSdeCanonicalProductionReader();
                              const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                              const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false}).filter(row=>row?.sdePhysicalChainId);
                              const recovery=rows.find(row=>row.sdePhysicalDependencyRole==='return');
                              const override=Object.values(state.sdeNightPlacementManualOverrides||{})[0]||null;
                              return {
                                messageType:sdeNightPlacementDropMessage?.type||'',
                                messageState:sdeNightPlacementDropMessage?.targetAvailabilityState||'',
                                rejected:document.querySelectorAll('.sde-night-placement-slot.drop-rejected').length,
                                ghost:document.querySelectorAll('.sde-night-placement-slot.dragging,.sde-night-placement-proposal.dragging').length,
                                selected:sdeNightPlacementSelectedSlot,
                                cardStatuses:cards.map(card=>card.status),
                                roles:rows.map(row=>row.sdePhysicalDependencyRole),
                                recovery:recovery?.toSlot||'',
                                postMain:recovery?.sdeRecoveryUsesPostMainTopology===true,
                                complete:reader.canonicalPlan.candidateOutcomes.length===3
                                  && cards.length===3
                                  && reader.reservationProjection.reservations.length===3
                                  && (reader.graphicProjection.activeOverlays.length+reader.graphicProjection.deferredOverlays.length)===3
                                  && Object.keys(reader.handlerAdapters||{}).length===3
                                  && reader.integrityReport.status==='PASS',
                                metadata:Boolean(override?.vehicle&&override?.fromSlot&&override?.toSlot&&override?.direction
                                  && override?.actualStateRevision&&override?.intentIdentity&&override?.planRevision),
                                expectedRecovery
                              };
                            }""",
                            scenario["recovery"],
                        )
                        self.assertEqual(result["messageType"], "info")
                        self.assertEqual(result["messageState"], "AVAILABLE_WITH_RELIEF_PLANNING")
                        self.assertEqual(result["rejected"], 0)
                        self.assertEqual(result["ghost"], 0)
                        self.assertEqual(result["selected"], "")
                        self.assertEqual(result["cardStatuses"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                        self.assertEqual(result["roles"], ["prerequisite", "dependent", "return"])
                        self.assertEqual(result["recovery"], scenario["recovery"])
                        self.assertTrue(result["postMain"])
                        self.assertTrue(result["complete"])
                        self.assertTrue(result["metadata"])
                        self.assertEqual(page.evaluate("JSON.stringify(state.grunnoppstilling)"), actual_before)
                        self.assertEqual(page_errors, [])

                        page.reload(wait_until="domcontentloaded")
                        hydrated = page.evaluate(
                            """() => {
                              sdeShiftViewMode=SDE_SHIFT_VIEW_MODE_GRAPHIC_PLAN;
                              renderSdeSkiftebevegelser();
                              const reader=buildSdeCanonicalProductionReader();
                              const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                              return {cards:cards.map(card=>card.status),integrity:reader.integrityReport.status,
                                overrides:Object.keys(state.sdeNightPlacementManualOverrides||{}).length};
                            }"""
                        )
                        self.assertEqual(hydrated["cards"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                        self.assertEqual(hydrated["integrity"], "PASS")
                        self.assertEqual(hydrated["overrides"], 1)

                        reset_graphic_fixture(page, scenario["placements"])
                        second_hover = actual_pointer_drag(page, scenario["source"], scenario["target"])
                        self.assertFalse(second_hover["red"])
                        self.assertEqual(
                            page.evaluate(
                                """() => {
                                  const reader=buildSdeCanonicalProductionReader();
                                  return (reader.cardProjection.actionableCards.length+reader.cardProjection.blockedChainCards.length);
                                }"""
                            ),
                            3,
                        )
                        self.assertEqual(page_errors, [])
                        context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
