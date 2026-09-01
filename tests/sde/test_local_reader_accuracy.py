"""Accuracy and fail-closed contract for the local form reader.

Cell boundaries here come from the fixture generator's own constants, not from a
detector, so a failure is the recognizer and not the geometry. The thresholds
guard against regression; they are not a claim that the reader is exact.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[2]
ENGINE_DIR = ROOT / "server" / "togplassering_scanner_v03"
FIXTURES = ROOT / "tests" / "sde" / "fixtures" / "night-plan"

sys.path.insert(0, str(ENGINE_DIR))
_spec = importlib.util.spec_from_file_location("sde_local_reader", ENGINE_DIR / "local_reader.py")
READER = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(READER)

# Template A geometry, from generate_synthetic_htr_fixtures.py.
COLUMNS = [26, 168, 329, 484, 636, 770, 1174]
DATA_TOP, DATA_BOTTOM = 285, 1465
ROW_HEIGHT = (DATA_BOTTOM - DATA_TOP) / 29

# Fixture field name -> reader column name.
STRUCTURED = [
    ("fromTrain", "fra_tog"),
    ("toTrain", "til_tog"),
    ("vehicleId", "setter"),
    ("toTrack", "til_spor"),
]


def read_fixture(name: str):
    truth = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    image = cv2.imread(str(FIXTURES / f"{name}.png"), cv2.IMREAD_GRAYSCALE)
    hits = total = 0
    misses = []
    for row in truth["rows"]:
        index = row["rowIndex"]
        top = int(round(DATA_TOP + index * ROW_HEIGHT)) + 3
        bottom = int(round(DATA_TOP + (index + 1) * ROW_HEIGHT)) - 3
        for column, (fixture_field, reader_field) in enumerate(STRUCTURED):
            expected = str(row.get(fixture_field, "") or "").strip()
            if not expected:
                continue
            cell = image[top:bottom, COLUMNS[column] + 4:COLUMNS[column + 1] - 4]
            text, _certainty = READER.read_cell(cell, reader_field)
            total += 1
            if text.upper() == expected.upper():
                hits += 1
            else:
                misses.append((reader_field, expected, text))
    return hits, total, misses


class LocalReaderAccuracyTests(unittest.TestCase):
    def test_structured_columns_are_read_correctly_on_known_geometry(self) -> None:
        for name in ("synthetic-htr-neat", "synthetic-htr-varied"):
            with self.subTest(fixture=name):
                hits, total, misses = read_fixture(name)
                self.assertGreater(total, 0)
                ratio = hits / total
                self.assertGreaterEqual(
                    ratio,
                    0.90,
                    f"{name}: {hits}/{total} = {ratio:.0%}, avvik: {misses}",
                )

    def test_free_text_is_never_reported_as_certain(self) -> None:
        for text in ("Kontroll sør", "vann", "Etter vask"):
            for field in ("info", "merknad"):
                self.assertEqual(READER.confidence_label(field, text, 0.99), "low")

    def test_an_empty_cell_is_certain_and_a_weak_read_is_not(self) -> None:
        self.assertEqual(READER.confidence_label("fra_tog", "", 0.0), "high")
        self.assertEqual(READER.confidence_label("fra_tog", "851", 0.99), "high")
        self.assertEqual(READER.confidence_label("fra_tog", "851", 0.75), "medium")
        self.assertEqual(READER.confidence_label("fra_tog", "851", 0.40), "low")

    def test_the_reader_never_reaches_the_network(self) -> None:
        source = (ENGINE_DIR / "local_reader.py").read_text(encoding="utf-8")
        for forbidden in ("requests", "urllib", "http", "openai", "OPENAI_API_KEY", "api_key"):
            self.assertNotIn(forbidden, source)

    def test_numeric_columns_cannot_emit_letters(self) -> None:
        # The confusions this form suffers from are O for 0 and S for 5.
        for field in ("klokken", "fra_tog", "til_tog", "setter"):
            alphabet = READER.COLUMN_ALPHABETS[field]
            self.assertNotIn("O", alphabet)
            self.assertNotIn("S", alphabet)
            self.assertNotIn("I", alphabet)


if __name__ == "__main__":
    unittest.main()
