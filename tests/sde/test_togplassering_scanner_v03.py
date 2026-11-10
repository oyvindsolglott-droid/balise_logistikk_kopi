from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
ENGINE_DIR = ROOT / "server" / "togplassering_scanner_v03"


def load_engine():
    sys.path.insert(0, str(ENGINE_DIR))
    spec = importlib.util.spec_from_file_location("togplassering_scanner_v03_app", ENGINE_DIR / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENGINE = load_engine()

VERT_TEMPLATE = ENGINE.VERT_TEMPLATE
HORIZ_TEMPLATE = ENGINE.HORIZ_TEMPLATE


def empty_row(row_no: int, **fields: str) -> dict:
    base = {field: "" for field in ENGINE.FIELDS}
    base.update(fields)
    return {
        "row_no": row_no,
        **base,
        "confidence": {field: "high" for field in ENGINE.FIELDS},
        "review_reason": "",
    }


class TogplasseringScannerV03Tests(unittest.TestCase):
    def test_merge_exposes_disagreement_as_low_and_keeps_first_value(self) -> None:
        first = {
            "form_title": "TOGPLASSERING SKIEN",
            "date_raw": "21.08.2026",
            "train_rows": [empty_row(1, til_spor="12")] + [empty_row(i) for i in range(2, 17)],
            "note_rows": [empty_row(i) for i in range(1, 4)],
            "warnings": [],
        }
        second = {
            "form_title": "TOGPLASSERING SKIEN",
            "date_raw": "21.08.2026",
            "train_rows": [empty_row(1, til_spor="11s")] + [empty_row(i) for i in range(2, 17)],
            "note_rows": [empty_row(i) for i in range(1, 4)],
            "warnings": [],
        }
        merged = ENGINE._merge_reads(first, second)
        self.assertTrue(merged["ai_double_checked"])
        self.assertEqual(merged["rows"][0]["til_spor"], "12")
        self.assertEqual(merged["rows"][0]["confidence"]["til_spor"], "low")
        self.assertEqual(merged["conflicts"], [{
            "row_type": "train",
            "row": 1,
            "field": "til_spor",
            "first": "12",
            "second": "11s",
        }])
        self.assertTrue(merged["needs_review"])

    def test_scan_fail_closed_when_geometry_is_low(self) -> None:
        original = ENGINE._geometry_from_image

        def low_geometry(_im):
            return {
                "metrics": {"confidence": "low", "vertical_lines": 9, "horizontal_lines": 31},
                "rectified": np.zeros((40, 40, 3), dtype=np.uint8),
                "overlay": np.zeros((40, 40, 3), dtype=np.uint8),
                "rect_overlay": np.zeros((40, 40, 3), dtype=np.uint8),
                "vxs": np.linspace(0, 39, 9),
                "hys": np.linspace(0, 39, 31),
                "corners_orig": np.array([[0, 0], [39, 0], [39, 39], [0, 39]], dtype=float),
            }

        ENGINE._geometry_from_image = low_geometry
        sys.path.insert(0, str(ENGINE_DIR))
        import cli as scanner_cli
        scanner_cli._geometry_from_image = low_geometry
        image = Image.new("RGB", (400, 600), "white")
        stdout = io.StringIO()
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg") as handle:
                image.save(handle.name, "JPEG")
                with contextlib.redirect_stdout(stdout):
                    code = scanner_cli.main(["scan", handle.name, "--no-double-check"])
        finally:
            ENGINE._geometry_from_image = original
            scanner_cli._geometry_from_image = original
        self.assertEqual(code, 2)
        payload = json.loads(stdout.getvalue().strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertIn("LOW", payload["error"])
        self.assertIn("sperret", payload["error"])

    def test_template_matching_requires_exact_9_and_31_line_families(self) -> None:
        self.assertEqual(len(VERT_TEMPLATE), 9)
        self.assertEqual(len(HORIZ_TEMPLATE), 31)
        self.assertEqual(float(VERT_TEMPLATE[0]), 0.0)
        self.assertEqual(float(VERT_TEMPLATE[-1]), 1.0)
        self.assertEqual(float(HORIZ_TEMPLATE[0]), 0.0)
        self.assertEqual(float(HORIZ_TEMPLATE[-1]), 1.0)
        vertical = np.round(100 + 900 * VERT_TEMPLATE).astype(float)
        extra = np.array([140.0, 410.0, 700.0])
        peaks = np.sort(np.concatenate([vertical, extra]))
        selected, cost = ENGINE._select_by_template(peaks, VERT_TEMPLATE, min_span=700)
        self.assertIsNotNone(selected)
        self.assertEqual(len(selected), 9)
        self.assertLess(cost, 0.02)
        horizontal = np.round(50 + 1800 * HORIZ_TEMPLATE).astype(float)
        selected_h, cost_h = ENGINE._select_by_template(horizontal, HORIZ_TEMPLATE, min_span=1500)
        self.assertEqual(len(selected_h), 31)
        self.assertLess(cost_h, 0.02)
        too_few, bad_cost = ENGINE._select_by_template(vertical[:6], VERT_TEMPLATE, min_span=100)
        self.assertIsNone(too_few)
        self.assertEqual(bad_cost, 999.0)

    def test_cli_reads_secret_only_from_environment(self) -> None:
        source = (ENGINE_DIR / "cli.py").read_text(encoding="utf-8")
        self.assertNotIn("--api-key", source)
        self.assertNotIn("add_argument(\"--api", source)
        self.assertIn('os.environ.get("OPENAI_API_KEY"', source)

    def test_frontend_bundle_does_not_embed_openai_key_field(self) -> None:
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        ui = (ROOT / "sde_night_planning_ui.js").read_text(encoding="utf-8")
        routes = (ROOT / "server" / "src" / "togplasseringScannerRoutes.js").read_text(encoding="utf-8")
        self.assertNotIn('id="key"', html)
        self.assertNotIn("sk-", ui)
        self.assertNotIn("OPENAI_API_KEY", ui)
        self.assertNotIn("api_key", ui)
        self.assertIn("Kontroller geometri", html)
        self.assertIn("Les skjema", html)
        # The import surface reads on this machine; it must not offer a remote read.
        self.assertNotIn("Les skjema med AI", html)
        self.assertIn("/api/togplassering-scanner/read", ui)
        self.assertNotIn("/api/togplassering-scanner/scan", ui)
        self.assertIn("/api/togplassering-scanner/geometry", ui)
        self.assertIn("scannerStatusDiagnosis", ui)
        self.assertNotIn("api_key", routes)
        self.assertNotIn("args.push(\"--api", routes)

    def test_a_malformed_key_is_rejected_without_echoing_its_value(self) -> None:
        # requests reports a rejected header by quoting the whole value, and that
        # message reaches the browser. A key pasted with a newline must therefore
        # never get as far as the header.
        malformed = [
            "",
            "   ",
            "sk-abc def",
            "sk-abc\ndef",
            "sk-abc\tdef",
            "Bearer sk-abc",
        ]
        for value in malformed:
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError) as caught:
                    ENGINE._require_valid_api_key(value)
                message = str(caught.exception)
                stripped = value.strip()
                if stripped:
                    self.assertNotIn(stripped, message)
                    self.assertNotIn(value, message)

        accepted = "sk-proj-AbC123._-xyz"
        for padded in (f"  {accepted}  ", f"{accepted}\r\n", f"\n{accepted}\n"):
            self.assertEqual(ENGINE._require_valid_api_key(padded), accepted)
        self.assertEqual(ENGINE._authorization_header(accepted), f"Bearer {accepted}")

        # The header must be built through the guard, never interpolated directly.
        source = (ENGINE_DIR / "app.py").read_text(encoding="utf-8")
        self.assertNotIn('f"Bearer {api_key}"', source)
        self.assertIn("_authorization_header(api_key)", source)


if __name__ == "__main__":
    unittest.main()
