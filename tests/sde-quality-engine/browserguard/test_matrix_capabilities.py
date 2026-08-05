"""Synthetic end-to-end tests for policy-bound read-only matrix controls."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from client import BrowserguardClient, BrowserguardClientError  # noqa: E402
from interaction_plan import (  # noqa: E402
    InteractionPlanError,
    ReadOnlyInteractionPlan,
    validate_element_policy,
)


class BrowserguardMatrixCapabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = BrowserguardClient().start()
        cls.initial = cls.client.status()
        cls.navigation = cls.client.navigate("open-matrix")
        cls.initial_page_id = cls.navigation["activePageId"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.shutdown = cls.client.close()

    def test_01_navigation_reads_count_visibility_and_load_state(self) -> None:
        self.assertEqual(self.navigation["path"], "/matrix.html")
        self.assertTrue(self.navigation["ok"])
        self.assertEqual(self.client.read_text("page-title")["text"], "Read-only matrix")
        self.assertEqual(self.client.count_elements("page-title")["count"], 1)
        self.assertTrue(self.client.is_visible("page-title")["visible"])
        self.assertEqual(self.client.read_attribute("page-title", "role")["value"], "heading")
        self.assertEqual(self.client.wait_load_state("domcontentloaded")["state"], "domcontentloaded")

    def test_02_exact_desktop_and_mobile_viewports(self) -> None:
        self.assertEqual(
            self.client.set_viewport("desktop"),
            {"viewportId": "desktop", "width": 1440, "height": 900},
        )
        self.assertEqual(
            self.client.set_viewport("mobile"),
            {"viewportId": "mobile", "width": 390, "height": 844},
        )

    def test_03_menu_opening_is_bound_to_declared_action(self) -> None:
        self.assertEqual(self.client.read_attribute("menu-button", "aria-expanded")["value"], "false")
        result = self.client.execute_action("toggle-main-menu")
        self.assertEqual(result["actionType"], "MENU_TOGGLE")
        self.assertEqual(self.client.read_attribute("menu-button", "aria-expanded")["value"], "true")
        self.assertTrue(self.client.is_visible("menu")["visible"])

    def test_04_tab_switching_uses_declared_tab_semantics(self) -> None:
        result = self.client.execute_action("show-details-tab")
        self.assertEqual(result["actionType"], "TAB_SWITCH")
        self.assertEqual(self.client.read_attribute("tab-details", "aria-selected")["value"], "true")
        self.assertTrue(self.client.is_visible("panel-details")["visible"])
        self.client.execute_action("show-summary-tab")
        self.assertEqual(self.client.read_attribute("tab-summary", "aria-selected")["value"], "true")

    def test_05_readonly_detail_and_overlay_close(self) -> None:
        self.assertFalse(self.client.is_visible("detail-dialog")["visible"])
        opened = self.client.execute_action("open-detail-dialog")
        self.assertEqual(opened["actionType"], "READONLY_DETAIL")
        self.assertTrue(self.client.is_visible("detail-dialog")["visible"])
        self.assertIn("Read-only detail content", self.client.read_text("detail-dialog")["text"])
        closed = self.client.execute_action("close-detail-dialog")
        self.assertEqual(closed["actionType"], "CLOSE_OVERLAY")
        self.assertFalse(self.client.is_visible("detail-dialog")["visible"])

    def test_06_focus_and_safe_keyboard_actions(self) -> None:
        focused = self.client.execute_action("focus-anchor-control")
        self.assertEqual(focused["actionType"], "FOCUS")
        self.assertEqual(self.client.read_attribute("focus-anchor", "aria-current")["value"], "true")
        moved = self.client.execute_action("move-focus-forward")
        self.assertEqual(moved["actionType"], "SAFE_KEY")
        self.assertEqual(self.client.read_attribute("focus-anchor", "aria-current")["value"], "false")
        arrow = self.client.execute_action("move-tab-right")
        self.assertEqual(arrow["actionType"], "SAFE_KEY")

    def test_07_scroll_is_bounded_and_target_bound(self) -> None:
        self.assertEqual(
            self.client.scroll("scroll-target", "DOWN"),
            {"targetId": "scroll-target", "direction": "DOWN"},
        )
        self.assertEqual(
            self.client.scroll("scroll-target", "UP"),
            {"targetId": "scroll-target", "direction": "UP"},
        )

    def test_08_popup_multiple_pages_listing_and_selection(self) -> None:
        popup = self.client.execute_action("open-detail-popup")
        self.assertEqual(popup["actionType"], "READONLY_DETAIL")
        self.assertGreaterEqual(popup["pageCount"], 2)
        pages = self.client.list_pages()
        self.assertEqual(len(pages["pages"]), 2)
        active = next(item for item in pages["pages"] if item["active"])
        self.assertEqual(active["path"], "/popup.html")
        selected = self.client.select_page(self.initial_page_id)
        self.assertEqual(selected["activePageId"], self.initial_page_id)

    def test_09_controlled_screenshot(self) -> None:
        result = self.client.capture_screenshot("matrix-mobile")
        self.assertEqual(result["filename"], "matrix-mobile.png")
        self.assertGreater(result["byteCount"], 0)
        root = Path(self.client.status()["evidenceDirectory"])
        self.assertTrue((root / result["filename"]).is_file())

    def test_10_human_gate_preserves_process_context_and_page(self) -> None:
        before = self.client.status()
        pending = self.client.begin_human_gate()
        self.assertEqual(pending["state"], "HUMAN_GATE_PENDING")
        with self.assertRaises(BrowserguardClientError):
            self.client.read_text("page-title")
        status = self.client.status()
        self.assertEqual(status["state"], "HUMAN_GATE_PENDING")
        active = self.client.complete_human_gate()
        self.assertEqual(active["state"], "ACTIVE")
        self.assertEqual(active["brokerPid"], before["brokerPid"])
        self.assertEqual(active["contextEpoch"], before["contextEpoch"])
        self.assertEqual(active["activePageId"], self.initial_page_id)
        self.assertEqual(self.client.read_text("page-title")["text"], "Read-only matrix")

    def test_11_unplanned_targets_actions_attributes_and_viewports_are_rejected(self) -> None:
        probes = (
            lambda: self.client.execute_action("unknown-action"),
            lambda: self.client.read_text("unknown-target"),
            lambda: self.client.read_attribute("page-title", "href"),
            lambda: self.client.set_viewport("unknown-viewport"),
        )
        for probe in probes:
            with self.assertRaises(BrowserguardClientError):
                probe()

    def test_12_submit_upload_drag_and_editable_controls_are_observable_but_not_actionable(self) -> None:
        for target in ("submit-control", "upload-control", "drag-control", "editable-control"):
            self.assertEqual(self.client.count_elements(target)["count"], 1)
            with self.assertRaises(BrowserguardClientError):
                self.client.execute_action(target)

    def test_13_plan_rejects_mutating_action_categories(self) -> None:
        path = HERE / "fixtures" / "synthetic-readonly-plan.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        for action_type in ("SUBMIT", "UPLOAD", "DRAG_AND_DROP", "SAVE"):
            mutated = deepcopy(original)
            mutated["actions"].append({"id": f"mutant-{action_type.lower().replace('_', '-')}", "type": action_type})
            with self.subTest(action_type=action_type), self.assertRaises(InteractionPlanError):
                ReadOnlyInteractionPlan(mutated, target_origin="http://127.0.0.1:9")

    def test_14_runtime_semantics_reject_mutating_elements(self) -> None:
        action = {
            "id": "safe-probe",
            "type": "FOCUS",
            "targetId": "focus-anchor",
            "expectedTag": "button",
            "expectedRole": "button",
        }
        base: Dict[str, Any] = {
            "tag": "button",
            "role": "button",
            "type": "button",
            "contenteditable": False,
            "draggable": False,
            "formAncestor": False,
            "accessibleName": "Read only detail",
        }
        validate_element_policy(action, base)
        mutants = [
            {**base, "tag": "input", "type": "file"},
            {**base, "type": "submit"},
            {**base, "contenteditable": True},
            {**base, "draggable": True},
            {**base, "formAncestor": True},
            {**base, "accessibleName": "Lagre"},
            {**base, "accessibleName": "Utført"},
            {**base, "accessibleName": "Annuller"},
            {**base, "accessibleName": "Oppdater"},
            {**base, "accessibleName": "Overprøv"},
        ]
        for descriptor in mutants:
            with self.subTest(descriptor=descriptor), self.assertRaises(InteractionPlanError):
                validate_element_policy(action, descriptor)

    def test_15_frozen_orchestrator_imports_no_browser_runtime(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(HERE)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        probe = subprocess.run(
            [sys.executable, "-B", "-c", "import sys,orchestrate; print('playwright' in sys.modules)"],
            cwd=HERE,
            env=environment,
            text=True,
            capture_output=True,
            timeout=10,
            check=True,
        )
        self.assertEqual(probe.stdout.strip(), "False")

    def test_16_every_plan_schema_object_rejects_additional_properties(self) -> None:
        schema_path = HERE.parent / "contracts" / "sde-browserguard-readonly-interaction-plan-v1.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        objects = []

        def collect(value: Any) -> None:
            if isinstance(value, dict):
                if value.get("type") == "object":
                    objects.append(value)
                for item in value.values():
                    collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)

        collect(schema)
        self.assertTrue(objects)
        self.assertTrue(all(item.get("additionalProperties") is False for item in objects))


if __name__ == "__main__":
    unittest.main(verbosity=2)
