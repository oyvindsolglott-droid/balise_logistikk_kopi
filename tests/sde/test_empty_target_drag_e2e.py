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
          state.txpUnavailableSlots=[];
          state.sharedSporplanDraftAppliedRevision=1;
          state.sharedSporplanDraftAppliedAt='2026-08-13T00:00:00.000Z';
          computeInndataCachedRows=null;
          computeInndataCacheDepth=0;
          getSdeShiftShowcaseData=()=>({
            score:100,baseScore:100,needs:[],moves:[],scoreMoves:[],unresolved:[],
            flexibleUnknownParking:[],filteredPastDepartureNeeds:[],totalArrivals:0,
            solvedArrivals:0,totalDepartures:0,securedDepartures:0,unresolvedCount:0,
            flexibleUnknownCount:0,baseMoveCount:0,adaptiveMoveCount:0
          });
          getSdeTomorrowJsonReadinessForScore=()=>({ready:true,reason:'TEST_FIXTURE_READY'});
          sdeNightPlacementDropMessage=null;
          sdeNightPlacementBlockedMoveRequest=null;
          sdeNightPlacementSelectedSlot='';
          sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false,score:0};
          sdeShiftViewMode=SDE_SHIFT_VIEW_MODE_GRAPHIC_PLAN;
          activateTab('sdeSkiftebevegelser');
          sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false,score:100};
        }""",
        placements,
    )
    page.locator("#sdeNightPlacementPanel").wait_for(timeout=30_000)


def actual_pointer_drag(page: Page, source_slot: str, target_slot: str) -> dict[str, object]:
    source = page.locator(f'[data-sde-night-placement-slot="{source_slot}"][data-sde-night-placement-draggable="1"]')
    target = page.locator(f'[data-sde-night-placement-slot="{target_slot}"]')
    source.scroll_into_view_if_needed()
    source_box = source.bounding_box()
    if source_box is None:
        raise AssertionError("drag source or target has no browser bounding box")
    source_point = (source_box["x"] + source_box["width"] / 2, source_box["y"] + source_box["height"] / 2)
    page.mouse.move(*source_point)
    page.mouse.down()
    page.mouse.move(source_point[0] + 8, source_point[1] + 8)
    target.scroll_into_view_if_needed()
    target_box = target.bounding_box()
    if target_box is None:
        page.mouse.up()
        raise AssertionError("drag source or target has no browser bounding box")
    target_point = (target_box["x"] + target_box["width"] / 2, target_box["y"] + target_box["height"] / 2)
    page.mouse.move(*target_point, steps=12)
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
                                messageText:sdeNightPlacementDropMessage?.text||'',
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
                                counts:{
                                  outcomes:reader.canonicalPlan.candidateOutcomes.length,
                                  cards:cards.length,
                                  reservations:reader.reservationProjection.reservations.length,
                                  overlays:reader.graphicProjection.activeOverlays.length+reader.graphicProjection.deferredOverlays.length,
                                  adapters:Object.keys(reader.handlerAdapters||{}).length,
                                  integrity:reader.integrityReport.status
                                },
                                metadata:Boolean(override?.vehicle&&override?.fromSlot&&override?.toSlot&&override?.direction
                                  && override?.actualStateRevision&&override?.intentIdentity&&override?.planRevision),
                                expectedRecovery
                              };
                            }""",
                            scenario["recovery"],
                        )
                        self.assertEqual(result["messageType"], "info", result)
                        self.assertEqual(result["messageState"], "AVAILABLE_WITH_RELIEF_PLANNING")
                        self.assertEqual(result["rejected"], 0)
                        self.assertEqual(result["ghost"], 0)
                        self.assertEqual(result["selected"], "")
                        self.assertEqual(result["cardStatuses"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                        self.assertEqual(result["roles"], ["prerequisite", "dependent", "return"])
                        self.assertEqual(result["recovery"], scenario["recovery"])
                        self.assertTrue(result["postMain"])
                        self.assertTrue(result["complete"], result)
                        self.assertTrue(result["metadata"])
                        self.assertEqual(page.evaluate("JSON.stringify(state.grunnoppstilling)"), actual_before)
                        self.assertEqual(page_errors, [])

                        page.reload(wait_until="domcontentloaded")
                        hydrated = page.evaluate(
                            """() => {
                              getSdeShiftShowcaseData=()=>({
                                score:100,baseScore:100,needs:[],moves:[],scoreMoves:[],unresolved:[],
                                flexibleUnknownParking:[],filteredPastDepartureNeeds:[],totalArrivals:0,
                                solvedArrivals:0,totalDepartures:0,securedDepartures:0,unresolvedCount:0,
                                flexibleUnknownCount:0,baseMoveCount:0,adaptiveMoveCount:0
                              });
                              getSdeTomorrowJsonReadinessForScore=()=>({ready:true,reason:'TEST_FIXTURE_READY'});
                              state.sharedSporplanDraftAppliedRevision=1;
                              sdeShiftViewMode=SDE_SHIFT_VIEW_MODE_GRAPHIC_PLAN;
                              activateTab('sdeSkiftebevegelser');
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

    def test_vn_priority_and_automatic_actual_state_replan_on_desktop_and_390(self) -> None:
        historical = [["6S", "VN-BROWSER-MAIN"], ["6N", "VN-BROWSER-BLOCKER"], ["1N", "OCCUPIED-ORDINARY"]]
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((1280, 900), (390, 844)):
                with self.subTest(width=width):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page_errors: list[str] = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.goto(base_url, wait_until="domcontentloaded")

                    reset_graphic_fixture(page, historical)
                    actual_before = page.evaluate("JSON.stringify(state.grunnoppstilling)")
                    hover = actual_pointer_drag(page, "6S", "11S")
                    self.assertEqual(hover["state"], "AVAILABLE_WITH_RELIEF_PLANNING")
                    self.assertFalse(hover["red"])
                    historical_result = page.evaluate(
                        """() => {
                          const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId);
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          return {
                            path:rows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),
                            statuses:cards.map(card=>card.status),
                            complete:rows.length===3&&cards.length===3&&reader.integrityReport.status==='PASS',
                            messageType:sdeNightPlacementDropMessage?.type||'',
                            selected:sdeNightPlacementSelectedSlot,
                            ghost:document.querySelectorAll('.dragging,.drop-rejected').length,
                            overrides:Object.keys(state.sdeNightPlacementManualOverrides||{}).length
                          };
                        }"""
                    )
                    self.assertEqual(
                        historical_result["path"],
                        [["6N", "VN", "prerequisite"], ["6S", "11S", "dependent"], ["VN", "6S", "return"]],
                    )
                    self.assertEqual(historical_result["statuses"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                    self.assertTrue(historical_result["complete"], historical_result)
                    self.assertEqual(historical_result["messageType"], "info")
                    self.assertEqual(historical_result["selected"], "")
                    self.assertEqual(historical_result["ghost"], 0)
                    self.assertEqual(historical_result["overrides"], 1)
                    self.assertEqual(page.evaluate("JSON.stringify(state.grunnoppstilling)"), actual_before)

                    replan_fixture = [*historical, ["VS", "INITIAL-VS-BLOCKER"]]
                    reset_graphic_fixture(page, replan_fixture)
                    actual_pointer_drag(page, "6S", "11S")
                    pre_change = page.evaluate(
                        """() => {
                          const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false});
                          return rows.find(row=>row.sdePhysicalDependencyRole==='prerequisite')?.toSlot||'';
                        }"""
                    )
                    self.assertNotEqual(pre_change, "VN")
                    self.assertNotEqual(pre_change, "1N")
                    replanned = page.evaluate(
                        """oldTarget => {
                          delete state.grunnoppstilling.VS;
                          state.grunnoppstilling[oldTarget]='LATE-TEMP-OCCUPANT';
                          state.sharedSporplanDraftAppliedRevision=Number(state.sharedSporplanDraftAppliedRevision||0)+1;
                          renderSdeSkiftebevegelser();
                          const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId);
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          return {
                            path:rows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),
                            statuses:cards.map(card=>card.status),
                            complete:rows.length===3&&cards.length===3
                              && reader.canonicalPlan.candidateOutcomes.length===3
                              && reader.reservationProjection.reservations.length===3
                              && (reader.graphicProjection.activeOverlays.length+reader.graphicProjection.deferredOverlays.length)===3
                              && Object.keys(reader.handlerAdapters||{}).length===3
                              && reader.integrityReport.status==='PASS',
                            overrideCount:Object.keys(state.sdeNightPlacementManualOverrides||{}).length,
                            overrideTarget:Object.values(state.sdeNightPlacementManualOverrides||{})[0]?.toSlot||'',
                            messageType:sdeNightPlacementDropMessage?.type||'',
                            messageText:sdeNightPlacementDropMessage?.text||'',
                            selected:sdeNightPlacementSelectedSlot,
                            ghost:document.querySelectorAll('.dragging,.drop-rejected').length,
                            actualOldTarget:getSdeVehicleInSlot(oldTarget),
                            actualMain:getSdeVehicleInSlot('6S')
                          };
                        }""",
                        pre_change,
                    )
                    self.assertEqual(
                        replanned["path"],
                        [["6N", "VN", "prerequisite"], ["6S", "11S", "dependent"], ["VN", "6S", "return"]],
                    )
                    self.assertEqual(replanned["statuses"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                    self.assertTrue(replanned["complete"], replanned)
                    self.assertEqual(replanned["overrideCount"], 1)
                    self.assertEqual(replanned["overrideTarget"], "11S")
                    self.assertNotIn("REPLAN_REQUIRED", replanned["messageText"])
                    self.assertNotEqual(replanned["messageType"], "error")
                    self.assertEqual(replanned["selected"], "")
                    self.assertEqual(replanned["ghost"], 0)
                    self.assertEqual(replanned["actualOldTarget"], "LATE-TEMP-OCCUPANT")
                    self.assertEqual(replanned["actualMain"], "VN-BROWSER-MAIN")
                    self.assertEqual(page_errors, [])
                    context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
