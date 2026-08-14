from __future__ import annotations

import contextlib
import functools
import http.server
import json
import pathlib
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]


class SdeMenuHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "SdeMenuTest/1"

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
    handler = functools.partial(SdeMenuHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class SdeMenuAccessLayoutBrowserTests(unittest.TestCase):
    def test_stadler_dimensions_and_server_authorized_nightplan_mounting(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.goto(base_url, wait_until="domcontentloaded")
            page.locator('[data-tab="sdeNattplanErfaring"]').wait_for(timeout=30_000)

            night_button = page.locator('[data-tab="sdeNattplanErfaring"]')
            self.assertEqual(night_button.count(), 1)
            self.assertEqual(night_button.inner_text(), "Registrer Plan i SDE")
            self.assertEqual(night_button.get_attribute("data-levels"), "0 2")
            self.assertEqual(night_button.get_attribute("aria-label"), "Åpne Registrer Plan i SDE")
            self.assertEqual(
                night_button.locator("img").get_attribute("src"),
                "assets/registrer-plan-i-sde-button.png",
            )

            stadler = page.locator('[data-tab="verkstedBestillinger"]')
            reference = page.locator('[data-tab="sdeVaktplan"]')
            stadler_box = stadler.bounding_box()
            reference_box = reference.bounding_box()
            self.assertIsNotNone(stadler_box)
            self.assertIsNotNone(reference_box)
            self.assertLessEqual(abs(stadler_box["width"] - reference_box["width"]), 1.0)
            self.assertLessEqual(abs(stadler_box["height"] - reference_box["height"]), 1.0)
            self.assertTrue(
                page.evaluate(
                    """() => {
                      const menu=document.querySelector('.segmented[aria-label="Hovedmeny"]');
                      const buttons=[...menu.querySelectorAll('.seg:not(.level-hidden)')];
                      const rects=buttons.map(button=>button.getBoundingClientRect());
                      const overlap=(a,b)=>a.left < b.right-0.5 && a.right > b.left+0.5
                        && a.top < b.bottom-0.5 && a.bottom > b.top+0.5;
                      return menu.scrollWidth <= menu.clientWidth + 1
                        && document.documentElement.scrollWidth <= innerWidth + 1
                        && rects.every((rect,index)=>rects.every((other,otherIndex)=>index===otherIndex||!overlap(rect,other)));
                    }"""
                )
            )
            stadler.focus()
            self.assertTrue(page.evaluate("document.activeElement?.dataset?.tab === 'verkstedBestillinger'"))
            focused_box = stadler.bounding_box()
            self.assertEqual(stadler_box, focused_box)

            selector = page.locator("#accessLevelSelect")
            for level, expected_count in (("0", 1), ("1", 0), ("2", 1), ("3", 0), ("4", 0), ("5", 0)):
                selector.select_option(level)
                page.wait_for_timeout(30)
                self.assertEqual(page.locator('[data-tab="sdeNattplanErfaring"]').count(), expected_count)
                if expected_count:
                    self.assertEqual(page.locator('[data-tab="sdeNattplanErfaring"]').inner_text(), "Registrer Plan i SDE")

            selector.select_option("3")
            direct_result = page.evaluate(
                """() => {
                  activateTab('sdeNattplanErfaring');
                  return {
                    allowed:isTabAllowedAtCurrentLevel('sdeNattplanErfaring'),
                    buttonCount:document.querySelectorAll('[data-tab="sdeNattplanErfaring"]').length,
                    panelActive:document.getElementById('sdeNattplanErfaring').classList.contains('active'),
                    panelHidden:document.getElementById('sdeNattplanErfaring').hidden
                  };
                }"""
            )
            self.assertEqual(
                direct_result,
                {"allowed": False, "buttonCount": 0, "panelActive": False, "panelHidden": True},
            )

            chain_result = page.evaluate(
                """() => {
                  const saved={
                    grunnoppstilling:JSON.parse(JSON.stringify(state.grunnoppstilling||{})),
                    actions:JSON.parse(JSON.stringify(state.sdeMoveActions||{})),
                    outcomes:JSON.parse(JSON.stringify(state.sdeActiveMoveOutcomes||{})),
                    overrides:JSON.parse(JSON.stringify(state.sdeNightPlacementManualOverrides||{})),
                    replans:JSON.parse(JSON.stringify(state.sdePhysicalReleaseReplans||{})),
                    obligations:JSON.parse(JSON.stringify(state.sdeVnRecoveryObligations||{})),
                    rows:JSON.parse(JSON.stringify(state.planSkifteRows||[])),
                    unavailable:JSON.parse(JSON.stringify(state.txpUnavailableSlots||[]))
                  };
                  const reset=placements=>{
                    state.grunnoppstilling=Object.fromEntries(placements);
                    state.sdeMoveActions={}; state.sdeActiveMoveOutcomes={};
                    state.sdeNightPlacementManualOverrides={}; state.sdePhysicalReleaseReplans={};
                    state.sdeVnRecoveryObligations={}; state.planSkifteRows=[]; state.txpUnavailableSlots=[];
                  };
                  const move=(vehicle,from,to,id)=>{
                    const key=['night-placement-drag',vehicle,from,to,id].join('|');
                    return {vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,
                      recommendedSlot:to,toSlot:to,stableActionKey:key,sdeNightPlacementGeneratedActionKey:key,
                      needKey:'need|'+key,sdeNightPlacementGeneratedNeedKey:'need|'+key,
                      source:'night-placement-drag',canonicalProducer:'graphic_drag_generated_move',
                      canonicalPurpose:'vehicle-relocation',sdeCanonicalGraphicDragOrder:true,
                      sdeNightPlacementDragIdentity:id,manualPlanId:'manual-graphic-order|'+id,
                      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true};
                  };
                  const snapshot=(rows,placements,actions={})=>{
                    const actual=placements.map(([slot,vehicleId])=>({vehicleId,slot}));
                    return {schemaVersion:'sde-canonical-shadow-runtime-v1',
                      actualSources:[{source:'canonical-actual',provenance:'menu-browser',selected:true,rows:actual}],
                      actualStateReconciliation:{diagnostics:[]},
                      legacy:{finalCards:rows,activeCards:rows,visibleCards:rows,activeButtonCount:0,activeCount:1,
                        reservations:[],overlays:[],actualSlots:actual,unresolvedMarkers:[]},
                      runtimeState:{actions,activeAuthorities:{}},infrastructure:{}};
                  };
                  const inspect=(placements,main)=>{
                    reset(placements);
                    const actualBefore=JSON.stringify(state.grunnoppstilling);
                    const rows=buildSdePhysicalBlockerGuardMoves([main]);
                    const reader=buildSdeCanonicalProductionReader(snapshot(rows,placements));
                    const roles=rows.map(row=>row.sdePhysicalDependencyRole);
                    const release=rows.find(row=>row.sdePhysicalDependencyRole==='prerequisite');
                    const dependent=rows.find(row=>row.sdePhysicalDependencyRole==='dependent');
                    const recovery=rows.find(row=>row.sdePhysicalDependencyRole==='return');
                    return {rows,reader,release,dependent,recovery,roles,actualUnchanged:actualBefore===JSON.stringify(state.grunnoppstilling)};
                  };
                  try{
                    const sourcePlacements=[['12S','SOURCE-MAIN'],['12N','SOURCE-BLOCKER']];
                    const source=inspect(sourcePlacements,move('SOURCE-MAIN','12S','9','browser-source'));
                    const sourceReload=buildSdeCanonicalProductionReader(snapshot(source.rows,sourcePlacements));
                    const sourcePlan=source.release?.sdePhysicalVnReliefChain;
                    const cancelledRecovery=buildSdeTemporaryVnReturnRow(sourcePlan,{recovery:true});
                    const targetPlacements=[['9','TARGET-MAIN'],['12N','TARGET-BLOCKER']];
                    const target=inspect(targetPlacements,move('TARGET-MAIN','9','12S','browser-target'));
                    const allCards=reader=>[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                    return {
                      sourceRoles:source.roles.join(','),sourceRecovery:source.recovery?.toSlot||'',
                      sourceCards:allCards(source.reader).map(card=>card.status).join(','),
                      sourceDependencies:source.dependent?.sdePhysicalDependsOn?.[0]===getSdeMoveActionKey(source.release)
                        && source.recovery?.sdePhysicalDependsOn?.[0]===getSdeMoveActionKey(source.dependent),
                      sourceReloadStable:JSON.stringify(source.reader.canonicalPlan.candidateOutcomes.map(item=>item.candidateOutcomeId))
                        ===JSON.stringify(sourceReload.canonicalPlan.candidateOutcomes.map(item=>item.candidateOutcomeId)),
                      cancelledRecovery:cancelledRecovery?.toSlot||'',sourceActualUnchanged:source.actualUnchanged,
                      targetRoles:target.roles.join(','),targetRecovery:target.recovery?.toSlot||'',
                      targetCards:allCards(target.reader).map(card=>card.status).join(','),
                      targetActualUnchanged:target.actualUnchanged,
                      noPartial:[source,target].every(item=>item.rows.length===3&&allCards(item.reader).length===3
                        && item.reader.reservationProjection.reservations.length===3
                        && item.reader.integrityReport.status==='PASS'),
                      selectionClear:!sdeNightPlacementSelectedSlot
                    };
                  } finally {
                    state.grunnoppstilling=saved.grunnoppstilling; state.sdeMoveActions=saved.actions;
                    state.sdeActiveMoveOutcomes=saved.outcomes; state.sdeNightPlacementManualOverrides=saved.overrides;
                    state.sdePhysicalReleaseReplans=saved.replans; state.sdeVnRecoveryObligations=saved.obligations;
                    state.planSkifteRows=saved.rows; state.txpUnavailableSlots=saved.unavailable;
                  }
                }"""
            )
            self.assertEqual(chain_result["sourceRoles"], "prerequisite,dependent,return")
            self.assertEqual(chain_result["sourceRecovery"], "12S")
            self.assertEqual(chain_result["sourceCards"], "actionable,blocked_chain_step,blocked_chain_step")
            self.assertTrue(chain_result["sourceDependencies"])
            self.assertTrue(chain_result["sourceReloadStable"])
            self.assertEqual(chain_result["cancelledRecovery"], "12N")
            self.assertTrue(chain_result["sourceActualUnchanged"])
            self.assertEqual(chain_result["targetRoles"], "prerequisite,dependent,return")
            self.assertEqual(chain_result["targetRecovery"], "12N")
            self.assertEqual(chain_result["targetCards"], "actionable,blocked_chain_step,blocked_chain_step")
            self.assertTrue(chain_result["targetActualUnchanged"])
            self.assertTrue(chain_result["noPartial"])
            self.assertTrue(chain_result["selectionClear"])

            selector.select_option("0")
            page.set_viewport_size({"width": 390, "height": 844})
            stadler.scroll_into_view_if_needed()
            reference.scroll_into_view_if_needed()
            mobile_stadler_box = stadler.bounding_box()
            mobile_reference_box = reference.bounding_box()
            self.assertEqual(round(mobile_stadler_box["width"]), 160)
            self.assertEqual(round(mobile_stadler_box["height"]), 76)
            self.assertEqual(round(mobile_reference_box["width"]), 160)
            self.assertEqual(round(mobile_reference_box["height"]), 76)
            self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
            self.assertEqual(page_errors, [])

            context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
