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
    (ROOT / "tests/sde/fixtures/chain-liveness-and-drag-closure-20260815.json").read_text(
        encoding="utf-8"
    )
)


class SdeChainLivenessDragBrowserTests(unittest.TestCase):
    def test_actual_pointer_drag_continues_after_first_safe_relief_fails_prestage(self) -> None:
        drag = FIXTURE["drag"]
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((1280, 900), (390, 844)):
                with self.subTest(width=width):
                    context = browser.new_context(viewport={"width": width, "height": height})
                    page = context.new_page()
                    page_errors: list[str] = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.goto(base_url, wait_until="domcontentloaded")
                    reset_graphic_fixture(page, drag["placements"])
                    actual_before = page.evaluate("JSON.stringify(state.grunnoppstilling)")
                    page.evaluate(
                        """firstRejectedRelief => {
                          globalThis.__chainLivenessOriginalAccessPlan=buildSdeTemporaryAccessReliefChainPlan;
                          globalThis.__chainLivenessReliefAttempts=[];
                          buildSdeTemporaryAccessReliefChainPlan=(blockedRow,blockState,freeingMove,chainId,context={})=>{
                            const target=normalizeSlot(freeingMove?.recommendedSlot||freeingMove?.toSlot);
                            globalThis.__chainLivenessReliefAttempts.push(target);
                            if(target===firstRejectedRelief) return null;
                            return globalThis.__chainLivenessOriginalAccessPlan(blockedRow,blockState,freeingMove,chainId,context);
                          };
                        }""",
                        drag["firstRejectedRelief"],
                    )

                    hover = actual_pointer_drag(page, drag["source"], drag["requestedTarget"])
                    result = page.evaluate(
                        """() => {
                          const reader=buildSdeCanonicalProductionReader();
                          const cards=[...(reader.cardProjection.actionableCards||[]),...(reader.cardProjection.blockedChainCards||[])];
                          const rows=buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
                            .filter(row=>row?.sdePhysicalChainId);
                          return {
                            messageType:sdeNightPlacementDropMessage?.type||'',
                            messageText:sdeNightPlacementDropMessage?.text||'',
                            attempts:[...(globalThis.__chainLivenessReliefAttempts||[])],
                            roles:rows.map(row=>row.sdePhysicalDependencyRole),
                            cards:cards.map(card=>card.status),
                            outcomes:reader.canonicalPlan.candidateOutcomes.length,
                            reservations:reader.reservationProjection.reservations.length,
                            overlays:reader.graphicProjection.activeOverlays.length+reader.graphicProjection.deferredOverlays.length,
                            adapters:Object.keys(reader.handlerAdapters||{}).length,
                            integrity:reader.integrityReport.status,
                            overrides:Object.keys(state.sdeNightPlacementManualOverrides||{}).length,
                            targetOccupant:getSdeVehicleInSlot('12S')||''
                          };
                        }"""
                    )
                    self.assertEqual(hover["state"], "AVAILABLE_WITH_RELIEF_PLANNING", result)
                    self.assertFalse(hover["red"], result)
                    self.assertEqual(result["targetOccupant"], "", result)
                    self.assertEqual(result["messageType"], "info", result)
                    self.assertNotIn("kunne ikke forhåndsstages komplett", result["messageText"])
                    self.assertGreaterEqual(len(result["attempts"]), 2, result)
                    self.assertEqual(result["attempts"][0], drag["firstRejectedRelief"], result)
                    self.assertNotEqual(result["attempts"][1], drag["firstRejectedRelief"], result)
                    self.assertEqual(result["roles"], ["prerequisite", "dependent", "return"], result)
                    self.assertEqual(result["cards"], ["actionable", "blocked_chain_step", "blocked_chain_step"], result)
                    self.assertEqual(
                        [result["outcomes"], result["reservations"], result["overlays"], result["adapters"]],
                        [3, 3, 3, 3],
                        result,
                    )
                    self.assertEqual(result["integrity"], "PASS", result)
                    self.assertEqual(result["overrides"], 1, result)
                    self.assertEqual(page.evaluate("JSON.stringify(state.grunnoppstilling)"), actual_before)
                    self.assertEqual(page_errors, [])
                    context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
