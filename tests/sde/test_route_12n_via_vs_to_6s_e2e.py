from __future__ import annotations

import json
import pathlib
import unittest

from playwright.sync_api import sync_playwright

from tests.sde.test_empty_target_drag_e2e import (
    actual_pointer_drag,
    reset_graphic_fixture,
    static_server,
)


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = json.loads(
    (ROOT / "tests/sde/fixtures/route-12n-via-vs-to-6s-v1.json").read_text(
        encoding="utf-8"
    )
)


class SdeRoute12NViaVsTo6SBrowserTests(unittest.TestCase):
    def test_actual_pointer_drag_builds_exact_multileg_vn_relief_chain(self) -> None:
        intent = FIXTURE["userIntent"]
        placements = FIXTURE["initialActualPlacement"]
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
                    actual_before = page.evaluate("JSON.stringify(state.grunnoppstilling)")

                    hover = actual_pointer_drag(page, intent["source"], intent["requestedTarget"])
                    result = page.evaluate(
                        """() => {
                          const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId&&!row?.sdeTrappedEgressDiagnosticOnly);
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          toggleSdeNightPlacement(false);
                          const summarizeRoute=row=>{
                            const route=row?.sdeCanonicalRoute||{};
                            return {
                              segments:route.routeSegments||row?.routeSegments||[],
                              via:route.viaSlots||row?.viaSlots||[],
                              reversal:route.reversalPoint||row?.reversalPoint||'',
                              approach:route.approachSide||row?.approachSide||'',
                              claims:route.routeResourceClaims||row?.sdeCanonicalRouteResourceClaims||[]
                            };
                          };
                          return {
                            messageType:sdeNightPlacementDropMessage?.type||'',
                            messageText:sdeNightPlacementDropMessage?.text||'',
                            rows:rows.map(row=>({
                              vehicle:row.vehicle,source:row.fromSlot,target:row.toSlot,
                              role:row.sdePhysicalDependencyRole,route:summarizeRoute(row)
                            })),
                            cards:cards.map(card=>({
                              vehicle:card.vehicleId,source:card.sourceSlot,target:card.targetSlot,
                              status:card.status,route:card.route||{},claims:card.routeResourceClaims||[]
                            })),
                            reservations:reader.reservationProjection.reservations.length,
                            overlays:reader.graphicProjection.activeOverlays.length+reader.graphicProjection.deferredOverlays.length,
                            adapters:Object.keys(reader.handlerAdapters||{}).length,
                            conflicts:reader.reservationProjection.conflicts.map(item=>item.classification),
                            integrity:reader.integrityReport.status,
                            actual:JSON.stringify(state.grunnoppstilling),
                            cardText:document.getElementById('sdeSkiftebevegelserDashboard')?.innerText||''
                          };
                        }"""
                    )

                    self.assertEqual(hover["state"], "AVAILABLE_WITH_RELIEF_PLANNING", result)
                    self.assertFalse(hover["red"], result)
                    self.assertEqual(result["messageType"], "info", result)
                    self.assertNotRegex(result["messageText"], r"forhåndsstages komplett|diagnostic-only")
                    self.assertEqual(
                        [(row["vehicle"], row["source"], row["target"], row["role"]) for row in result["rows"]],
                        [
                            ("75-76", "6N", "VN", "prerequisite"),
                            ("70-11", "12N", "6S", "dependent"),
                            ("75-76", "VN", "6N", "return"),
                        ],
                        result,
                    )
                    self.assertEqual(
                        [card["status"] for card in result["cards"]],
                        ["actionable", "blocked_chain_step", "blocked_chain_step"],
                        result,
                    )
                    self.assertTrue(all("VS" in row["route"]["via"] for row in result["rows"]), result)
                    self.assertEqual(result["rows"][1]["route"]["reversal"], "VS", result)
                    self.assertEqual(result["rows"][1]["route"]["approach"], "NORTH", result)
                    self.assertEqual(len(result["rows"][1]["route"]["segments"]), 2, result)
                    self.assertTrue(
                        any(claim["resource"] == "VS" and claim["state"] == "ACTIVE_ROUTE_RESOURCE" for claim in result["rows"][0]["route"]["claims"]),
                        result,
                    )
                    self.assertTrue(
                        all(any(claim["resource"] == "VS" and claim["state"] == "DEFERRED_ROUTE_RESOURCE" for claim in row["route"]["claims"]) for row in result["rows"][1:]),
                        result,
                    )
                    self.assertEqual(
                        [len(result["cards"]), result["reservations"], result["overlays"], result["adapters"]],
                        [3, 3, 3, 3],
                        result,
                    )
                    self.assertFalse(any("VS_RESOURCE_OVERLAP" in conflict for conflict in result["conflicts"]), result)
                    self.assertEqual(result["integrity"], "PASS", result)
                    self.assertEqual(result["actual"], actual_before)
                    self.assertIn("via VS", result["cardText"], result)
                    self.assertIn("vending VS", result["cardText"], result)
                    self.assertEqual(page_errors, [])
                    context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
