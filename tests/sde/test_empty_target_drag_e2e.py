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
    def test_exact_12n_to_11n_pointer_drag_uses_rendered_canonical_source(self) -> None:
        placements = [["12N", "70-11"]]
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((1280, 900), (390, 844)):
                with self.subTest(width=width):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page_errors: list[str] = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.goto(base_url, wait_until="domcontentloaded")
                    reset_graphic_fixture(page, placements)

                    source_contract = page.locator(
                        '[data-sde-night-placement-slot="12N"]'
                        '[data-sde-night-placement-draggable="1"]'
                    ).evaluate(
                        """element => ({
                          vehicleId:element.dataset.sdeNightPlacementVehicleId||'',
                          renderedSourceSlot:element.dataset.sdeNightPlacementRenderedSourceSlot||'',
                          actualRevision:element.dataset.sdeNightPlacementActualRevision||'',
                          panelRevision:element.closest('#sdeNightPlacementPanel')?.dataset.sdeNightPlacementActualRevision||''
                        })"""
                    )
                    self.assertEqual(source_contract["vehicleId"], "70-11")
                    self.assertEqual(source_contract["renderedSourceSlot"], "12N")
                    self.assertTrue(source_contract["actualRevision"])
                    self.assertEqual(source_contract["actualRevision"], source_contract["panelRevision"])

                    actual_before = page.evaluate("JSON.stringify(state.grunnoppstilling)")
                    hover = actual_pointer_drag(page, "12N", "11N")
                    self.assertEqual(hover["state"], "DIRECTLY_AVAILABLE")
                    self.assertTrue(hover["dragOver"])
                    self.assertFalse(hover["red"])

                    result = page.evaluate(
                        """() => {
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          const exact=cards.find(card=>card.vehicleId==='70-11'&&card.sourceSlot==='12N'&&card.targetSlot==='11N')||null;
                          const override=Object.values(state.sdeNightPlacementManualOverrides||{})[0]||null;
                          return {
                            messageType:sdeNightPlacementDropMessage?.type||'',
                            messageText:sdeNightPlacementDropMessage?.text||'',
                            messageState:sdeNightPlacementDropMessage?.targetAvailabilityState||'',
                            exact:Boolean(exact),
                            cardCount:cards.length,
                            source:exact?.sourceSlot||'',
                            target:exact?.targetSlot||'',
                            intentId:exact?.canonicalIdentity?.intentId||'',
                            overrideIntent:override?.intentIdentity||'',
                            actualRevision:override?.actualStateRevision||'',
                            plannerInvoked:override?.canonicalPlannerInvoked===true,
                            integrity:reader.integrityReport.status,
                            ghosts:document.querySelectorAll('.dragging,.drop-rejected').length,
                            actualLocation:getSdeCanonicalActualLocationForVehicle('70-11')?.slot||''
                          };
                        }"""
                    )
                    self.assertEqual(result["messageType"], "info", result)
                    self.assertEqual(result["messageState"], "DIRECTLY_AVAILABLE", result)
                    self.assertNotIn("står allerede", result["messageText"].lower())
                    self.assertTrue(result["exact"], result)
                    self.assertEqual(result["cardCount"], 1, result)
                    self.assertEqual([result["source"], result["target"]], ["12N", "11N"])
                    self.assertTrue(result["intentId"])
                    self.assertEqual(result["intentId"], result["overrideIntent"])
                    self.assertTrue(result["actualRevision"])
                    self.assertTrue(result["plannerInvoked"])
                    self.assertEqual(result["integrity"], "PASS")
                    self.assertEqual(result["ghosts"], 0)
                    self.assertEqual(result["actualLocation"], "12N")
                    self.assertEqual(page.evaluate("JSON.stringify(state.grunnoppstilling)"), actual_before)

                    page.reload(wait_until="domcontentloaded")
                    reloaded = page.evaluate(
                        """() => {
                          state.sharedSporplanDraftAppliedRevision=1;
                          getSdeShiftShowcaseData=()=>({score:100,baseScore:100,needs:[],moves:[],scoreMoves:[],unresolved:[],flexibleUnknownParking:[],filteredPastDepartureNeeds:[],totalArrivals:0,solvedArrivals:0,totalDepartures:0,securedDepartures:0,unresolvedCount:0,flexibleUnknownCount:0,baseMoveCount:0,adaptiveMoveCount:0});
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          return {cards:cards.map(card=>[card.vehicleId,card.sourceSlot,card.targetSlot]),integrity:reader.integrityReport.status};
                        }"""
                    )
                    self.assertEqual(reloaded["cards"], [["70-11", "12N", "11N"]])
                    self.assertEqual(reloaded["integrity"], "PASS")
                    self.assertEqual(page_errors, [])
                    context.close()
            browser.close()

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

    def test_completed_release_preserves_main_and_recovery_on_desktop_and_390(self) -> None:
        placements = [["6S", "SUFFIX-MAIN"], ["6N", "SUFFIX-BLOCKER"], ["1N", "OCCUPIED-ORDINARY"]]
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((1280, 900), (390, 844)):
                with self.subTest(width=width):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page_errors: list[str] = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.goto(base_url, wait_until="domcontentloaded")
                    reset_graphic_fixture(page, placements)
                    actual_pointer_drag(page, "6S", "11S")

                    transition = page.evaluate(
                        """async () => {
                          getSdeMoveLearningReason=async()=>getSdeNoMoveLearningReason('');
                          saveSharedSporplanDraftFromSdeCompletedMove=async()=>{};
                          persist=()=>{};
                          window.__suffixAlerts=[];
                          alert=message=>window.__suffixAlerts.push(String(message));
                          const beforeRows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId);
                          const release=beforeRows.find(row=>row.sdePhysicalDependencyRole==='prerequisite');
                          const main=beforeRows.find(row=>row.sdePhysicalDependencyRole==='dependent');
                          const recovery=beforeRows.find(row=>row.sdePhysicalDependencyRole==='return');
                          const beforeReader=buildSdeCanonicalProductionReader();
                          const releaseKey=getSdeMoveActionKey(release);
                          const initialChainId=release?.sdePhysicalChainId||'';
                          const initialIntentId=main?.sdeNightPlacementDragIdentity||'';
                          await handleSdeShiftMoveAction(encodeURIComponent(releaseKey),'completed');
                          localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
                          const afterRows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId);
                          const afterReader=buildSdeCanonicalProductionReader();
                          const cards=[...(afterReader.cardProjection.actionableCards||[]),
                            ...(afterReader.cardProjection.blockedChainCards||[]),
                            ...(afterReader.cardProjection.handlerBlockedCards||[])];
                          const chain=afterReader.cardProjection.chains?.find(item=>item.chainId===initialChainId)||null;
                          return {
                            initial:{
                              chainId:initialChainId,
                              intentId:initialIntentId,
                              releaseKey,
                              roles:beforeRows.map(row=>row.sdePhysicalDependencyRole),
                              statuses:[...(beforeReader.cardProjection.actionableCards||[]),
                                ...(beforeReader.cardProjection.blockedChainCards||[])].map(card=>card.status),
                              path:[[release?.fromSlot,release?.toSlot],[main?.fromSlot,main?.toSlot],[recovery?.fromSlot,recovery?.toSlot]]
                            },
                            after:{
                              chainIds:[...new Set(afterRows.map(row=>row.sdePhysicalChainId))],
                              roles:afterRows.map(row=>row.sdePhysicalDependencyRole),
                              statuses:cards.map(card=>card.status),
                              targets:cards.map(card=>card.targetSlot),
                              mainIntentIds:afterRows.filter(row=>row.sdePhysicalDependencyRole==='dependent')
                                .map(row=>row.sdeNightPlacementDragIdentity||''),
                              action:state.sdeMoveActions?.[releaseKey]?.action||'',
                              releaseActual:getSdeVehicleInSlot('VN'),
                              mainActual:getSdeVehicleInSlot('6S'),
                              actionCount:Object.keys(state.sdeMoveActions||{}).length,
                              chainStepCount:chain?.stepCount||0,
                              completedSteps:(chain?.steps||[]).filter(step=>step.status==='completed').length,
                              integrity:afterReader.integrityReport.status,
                              integrityConflicts:(afterReader.integrityReport.conflicts||[]).map(item=>({
                                code:item.code||item.diagnosticType||'',message:item.message||'',
                                chainId:item.chainId||'',candidateOutcomeId:item.candidateOutcomeId||''
                              })),
                              failedInvariants:(afterReader.integrityReport.invariantResults||[])
                                .filter(item=>item.status!=='PASS'),
                              runtimeRoles:(afterReader.runtimeSnapshot?.legacy?.finalCards||[]).map(row=>row.sdePhysicalDependencyRole||''),
                              outcomes:(afterReader.canonicalPlan?.candidateOutcomes||[]).map(outcome=>({
                                role:outcome.raw?.sdePhysicalDependencyRole||'',status:outcome.status,
                                activeEligible:outcome.activeEligible,sourceValid:outcome.sourceValidation?.valid,
                                physicalValid:outcome.physicalValidation?.valid,unmet:outcome.unmetDependencies,
                                chainId:outcome.chainId,target:outcome.targetSlot,
                                vnRecoveryRequired:outcome.raw?.sdeVnRecoveryRequired,
                                physicalVnRecovery:outcome.raw?.isSdePhysicalVnRecoveryMove,
                                obligationKind:outcome.obligationKind,
                                actualSource:outcome.actualSourceSlot
                              })),
                              recoveryResults:afterReader.integrityReport.recoveryResults,
                              planConflicts:(afterReader.canonicalPlan?.conflicts||[]).map(item=>item.code),
                              planDiagnostics:(afterReader.canonicalPlan?.diagnostics||[]).map(item=>item.code||item.diagnosticType),
                              cardDiagnostics:(afterReader.cardProjection?.diagnostics||[]).map(item=>item.diagnosticType),
                              alerts:window.__suffixAlerts,
                              selection:sdeNightPlacementSelectedSlot,
                              ghosts:document.querySelectorAll('.dragging,.drop-rejected').length
                            }
                          };
                        }"""
                    )
                    self.assertEqual(transition["initial"]["roles"], ["prerequisite", "dependent", "return"])
                    self.assertEqual(transition["initial"]["statuses"], ["actionable", "blocked_chain_step", "blocked_chain_step"])
                    self.assertEqual(transition["initial"]["path"], [["6N", "VN"], ["6S", "11S"], ["VN", "6S"]])
                    self.assertEqual(transition["after"]["roles"], ["dependent", "return"])
                    self.assertEqual(transition["after"]["statuses"], ["actionable", "blocked_chain_step"], transition)
                    self.assertEqual(transition["after"]["targets"], ["11S", "6S"])
                    self.assertEqual(transition["after"]["chainIds"], [transition["initial"]["chainId"]])
                    self.assertEqual(transition["after"]["mainIntentIds"], [transition["initial"]["intentId"]])
                    self.assertEqual(transition["after"]["action"], "completed")
                    self.assertEqual(transition["after"]["releaseActual"], "SUFFIX-BLOCKER")
                    self.assertEqual(transition["after"]["mainActual"], "SUFFIX-MAIN")
                    self.assertEqual(transition["after"]["actionCount"], 1)
                    self.assertEqual(transition["after"]["chainStepCount"], 3)
                    self.assertEqual(transition["after"]["completedSteps"], 1)
                    self.assertEqual(transition["after"]["integrity"], "PASS", transition)
                    self.assertEqual(transition["after"]["alerts"], [])
                    self.assertEqual(transition["after"]["selection"], "")
                    self.assertEqual(transition["after"]["ghosts"], 0)

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
                          activateTab('sdeSkiftebevegelser');
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),
                            ...(reader.cardProjection.blockedChainCards||[]),
                            ...(reader.cardProjection.handlerBlockedCards||[])];
                          return {statuses:cards.map(card=>card.status),targets:cards.map(card=>card.targetSlot),
                            cards:cards.map(card=>({status:card.status,target:card.targetSlot,chainId:card.chainId,
                              vehicle:card.vehicleId,step:card.sequenceStep,producer:card.producerProvenance?.producer||''})),
                            roles:(reader.runtimeSnapshot?.legacy?.finalCards||[]).map(row=>({
                              role:row.sdePhysicalDependencyRole||'',target:row.toSlot||row.recommendedSlot||'',
                              chainId:row.sdePhysicalChainId||'',vnRecoveryRequired:row.sdeVnRecoveryRequired||false,
                              trapped:row.sdeTrappedEgressChainStep||false
                            })),
                            integrity:reader.integrityReport.status};
                        }"""
                    )
                    self.assertEqual(hydrated["statuses"], ["actionable", "blocked_chain_step"], hydrated)
                    self.assertEqual(hydrated["targets"], ["11S", "6S"])
                    self.assertEqual(hydrated["integrity"], "PASS")

                    unexpected = page.evaluate(
                        """async () => {
                          getSdeMoveLearningReason=async()=>getSdeNoMoveLearningReason('');
                          saveSharedSporplanDraftFromSdeCompletedMove=async()=>{};
                          persist=()=>{};
                          window.__suffixAlerts=[];
                          alert=message=>window.__suffixAlerts.push(String(message));
                          const beforeReader=buildSdeCanonicalProductionReader();
                          const beforeCards=[...(beforeReader.cardProjection.actionableCards||[]),
                            ...(beforeReader.cardProjection.blockedChainCards||[])];
                          const originalChainId=beforeCards.find(card=>card.vehicleId==='SUFFIX-MAIN')?.chainId||'';
                          const beforeRows=(beforeReader.runtimeSnapshot?.legacy?.finalCards||[])
                            .filter(row=>row?.sdePhysicalChainId===originalChainId);
                          const beforeRevision=beforeRows.find(row=>row.sdePhysicalDependencyRole==='dependent')
                            ?.sdePhysicalPlanRevision||'';

                          state.grunnoppstilling={...state.grunnoppstilling,VN:'UNEXPECTED-THIRD-PARTY','4M':'SUFFIX-BLOCKER'};
                          const actualBeforePlanning=JSON.stringify(state.grunnoppstilling);
                          const generated=buildSdeNightPlacementGeneratedMoves([]);
                          const replannedRows=buildSdePhysicalBlockerGuardMoves(generated,{reconcileActive:false});
                          const debugSnapshot=captureSdeCanonicalShadowRuntimeSnapshot();
                          const debugChainRows=(debugSnapshot.legacy?.finalCards||[])
                            .filter(row=>row?.sdePhysicalChainId===originalChainId);
                          const debugStructure=inspectSdePassiveBlockedSlotStructure(debugChainRows,debugSnapshot);
                          const sourceReader=buildSdeCanonicalProductionReaderSource(debugSnapshot);
                          const sourceCards=[...(sourceReader.cardProjection.actionableCards||[]),
                            ...(sourceReader.cardProjection.blockedChainCards||[]),
                            ...(sourceReader.cardProjection.handlerBlockedCards||[])]
                            .filter(card=>card.chainId===originalChainId);
                          const sourceAdapters=Object.fromEntries(sourceCards.map(card=>[
                            card.canonicalCardId,buildSdeCanonicalHandlerAdapter(card,sourceReader)
                          ]));
                          const replannedReader=buildSdeCanonicalProductionReader();
                          const replannedCards=[...(replannedReader.cardProjection.actionableCards||[]),
                            ...(replannedReader.cardProjection.blockedChainCards||[])]
                            .filter(card=>card.chainId===originalChainId);
                          const chainRows=replannedRows.filter(row=>row?.sdePhysicalChainId===originalChainId);
                          const main=chainRows.find(row=>row.sdePhysicalDependencyRole==='dependent');
                          const recovery=chainRows.find(row=>row.sdePhysicalDependencyRole==='return');
                          const replanSnapshot={
                            chainId:originalChainId,
                            roles:chainRows.map(row=>row.sdePhysicalDependencyRole),
                            statuses:replannedCards.map(card=>card.status),
                            path:chainRows.map(row=>[row.fromSlot,row.toSlot]),
                            mainIntent:main?.sdeNightPlacementDragIdentity||'',
                            planRevision:main?.sdePhysicalPlanRevision||'',
                            beforeRevision,
                            completedPrefix:(replannedReader.canonicalPlan.candidateOutcomes||[])
                              .filter(outcome=>outcome.chainId===originalChainId&&outcome.status==='completed').length,
                            integrity:replannedReader.integrityReport.status,
                            actualUnchanged:actualBeforePlanning===JSON.stringify(state.grunnoppstilling),
                            actionTypes:Object.values(state.sdeMoveActions||{}).map(record=>record?.action),
                            diagnostics:(replannedReader.canonicalPlan.diagnostics||[]).map(item=>item.code||item.diagnosticType)
                            ,structure:{complete:debugStructure.complete,missing:debugStructure.missingPlanParts,
                              completedProofs:debugStructure.completedReleaseProofs,
                              actual:getSdePassiveBlockedSlotActualPlacements(debugSnapshot),
                              roles:debugChainRows.map(row=>[row.sdePhysicalDependencyRole,row.fromSlot,row.toSlot,row.sdePhysicalChainId]),
                              sourceOutcomes:(sourceReader.canonicalPlan.candidateOutcomes||[])
                                .filter(outcome=>outcome.chainId===originalChainId)
                                .map(outcome=>[outcome.raw?.sdePhysicalDependencyRole,outcome.status,outcome.targetSlot]),
                              sourceCards:sourceCards.map(card=>[card.status,card.targetSlot]),
                              sourceReservations:(sourceReader.reservationProjection.reservations||[])
                                .filter(item=>item.chainId===originalChainId).map(item=>item.targetSlot),
                              sourceOverlays:[...(sourceReader.graphicProjection.activeOverlays||[]),
                                ...(sourceReader.graphicProjection.deferredOverlays||[])]
                                .filter(item=>item.chainId===originalChainId).map(item=>item.targetSlot),
                              sourceAdapters:Object.values(sourceAdapters).map(adapter=>({ready:adapter.ready,reasons:adapter.reasons}))}
                          };

                          await handleSdeShiftMoveAction(encodeURIComponent(getSdeMoveActionKey(main)),'completed');
                          localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
                          const postMainReader=buildSdeCanonicalProductionReader();
                          const postSnapshot=captureSdeCanonicalShadowRuntimeSnapshot();
                          const postChainRows=(postSnapshot.legacy?.finalCards||[])
                            .filter(row=>row?.sdePhysicalChainId===originalChainId);
                          const postStructure=inspectSdePassiveBlockedSlotStructure(postChainRows,postSnapshot);
                          const postMainCards=[...(postMainReader.cardProjection.actionableCards||[]),
                            ...(postMainReader.cardProjection.blockedChainCards||[])]
                            .filter(card=>card.chainId===originalChainId);
                          const postMainChain=postMainReader.cardProjection.chains?.find(item=>item.chainId===originalChainId)||null;
                          return {
                            replan:replanSnapshot,
                            postMain:{
                              statuses:postMainCards.map(card=>card.status),
                              targets:postMainCards.map(card=>card.targetSlot),
                              completedSteps:(postMainChain?.steps||[]).filter(step=>step.status==='completed').length,
                              integrity:postMainReader.integrityReport.status,
                              mainActual:sanitizeVehicleValue(state.grunnoppstilling?.['11S']),
                              blockerActual:sanitizeVehicleValue(state.grunnoppstilling?.['4M']),
                              rawPlacement:{...state.grunnoppstilling},
                              roles:(postMainReader.runtimeSnapshot?.legacy?.finalCards||[]).map(row=>[
                                row.sdePhysicalDependencyRole||'',row.fromSlot||'',row.toSlot||row.recommendedSlot||'',
                                row.sdePhysicalChainId||'',row.sdeTrappedEgressDiagnosticOnly||false
                              ]),
                              diagnostics:(postMainReader.canonicalPlan.diagnostics||[]).map(item=>item.code||item.diagnosticType),
                              actionTypes:Object.values(state.sdeMoveActions||{}).map(record=>[record.action,record.vehicle,record.fromSlot,record.toSlot])
                              ,structure:{complete:postStructure.complete,missing:postStructure.missingPlanParts,
                                releases:postStructure.completedReleaseProofs,mains:postStructure.completedMainProofs,
                                roles:postChainRows.map(row=>[row.sdePhysicalDependencyRole,row.fromSlot,row.toSlot,row.sdePhysicalDependsOn])}
                            },
                            alerts:window.__suffixAlerts,
                            selection:sdeNightPlacementSelectedSlot,
                            ghosts:document.querySelectorAll('.dragging,.drop-rejected').length
                          };
                        }"""
                    )
                    self.assertEqual(unexpected["replan"]["roles"], ["dependent", "return"], unexpected)
                    self.assertEqual(unexpected["replan"]["statuses"], ["actionable", "blocked_chain_step"], unexpected)
                    self.assertEqual(unexpected["replan"]["path"], [["6S", "11S"], ["4M", "6S"]], unexpected)
                    self.assertEqual(unexpected["replan"]["mainIntent"], transition["initial"]["intentId"])
                    self.assertNotEqual(unexpected["replan"]["planRevision"], unexpected["replan"]["beforeRevision"])
                    self.assertEqual(unexpected["replan"]["completedPrefix"], 1)
                    self.assertEqual(unexpected["replan"]["integrity"], "PASS")
                    self.assertTrue(unexpected["replan"]["actualUnchanged"])
                    self.assertNotIn("cancelled", unexpected["replan"]["actionTypes"])
                    self.assertEqual(unexpected["postMain"]["statuses"], ["actionable"], unexpected)
                    self.assertEqual(unexpected["postMain"]["targets"], ["6S"])
                    self.assertEqual(unexpected["postMain"]["completedSteps"], 2)
                    self.assertEqual(unexpected["postMain"]["integrity"], "PASS")
                    self.assertEqual(unexpected["postMain"]["mainActual"], "SUFFIX-MAIN")
                    self.assertEqual(unexpected["postMain"]["blockerActual"], "SUFFIX-BLOCKER")
                    self.assertEqual(unexpected["alerts"], [])
                    self.assertEqual(unexpected["selection"], "")
                    self.assertEqual(unexpected["ghosts"], 0)

                    page.reload(wait_until="domcontentloaded")
                    post_main_hydrated = page.evaluate(
                        """() => {
                          getSdeShiftShowcaseData=()=>({
                            score:100,baseScore:100,needs:[],moves:[],scoreMoves:[],unresolved:[],
                            flexibleUnknownParking:[],filteredPastDepartureNeeds:[],totalArrivals:0,
                            solvedArrivals:0,totalDepartures:0,securedDepartures:0,unresolvedCount:0,
                            flexibleUnknownCount:0,baseMoveCount:0,adaptiveMoveCount:0
                          });
                          getSdeTomorrowJsonReadinessForScore=()=>({ready:true,reason:'TEST_FIXTURE_READY'});
                          state.sharedSporplanDraftAppliedRevision=1;
                          activateTab('sdeSkiftebevegelser');
                          const reader=buildSdeCanonicalProductionReader();
                          const mainChain=(reader.cardProjection.chains||[]).find(chain=>(chain.steps||[])
                            .some(step=>step.vehicleId==='SUFFIX-MAIN'))||null;
                          const cards=[...(reader.cardProjection.actionableCards||[]),
                            ...(reader.cardProjection.blockedChainCards||[])]
                            .filter(card=>card.chainId===mainChain?.chainId);
                          return {statuses:cards.map(card=>card.status),targets:cards.map(card=>card.targetSlot),
                            completedSteps:(mainChain?.steps||[]).filter(step=>step.status==='completed').length,
                            integrity:reader.integrityReport.status};
                        }"""
                    )
                    self.assertEqual(post_main_hydrated["statuses"], ["actionable"], post_main_hydrated)
                    self.assertEqual(post_main_hydrated["targets"], ["6S"])
                    self.assertEqual(post_main_hydrated["completedSteps"], 2)
                    self.assertEqual(post_main_hydrated["integrity"], "PASS")
                    self.assertEqual(page_errors, [])
                    context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
