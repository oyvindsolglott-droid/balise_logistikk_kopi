from __future__ import annotations

import contextlib
import functools
import http.server
import json
import pathlib
import threading
import unittest

from playwright.sync_api import BrowserType, Page, sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "sde" / "fixtures" / "night-plan"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def static_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def expected_fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def run_fixture(page: Page, image_file: str) -> dict[str, object]:
    return page.evaluate(
        "url => window.runHtrFixture(url)",
        f"/tests/sde/fixtures/night-plan/{image_file}",
    )


def normalized_output(result: dict[str, object]) -> tuple[dict[tuple[int, str], str], dict[str, str]]:
    cells = {
        (int(cell["rowIndex"]), str(cell["columnId"])): str(cell["selectedValue"])
        for cell in result["cells"]
    }
    metadata = {
        str(cell["columnId"]): str(cell["selectedValue"])
        for cell in result["metadataCells"]
    }
    return cells, metadata


def quality_metrics(output: dict[str, object], fixture: dict[str, object]) -> dict[str, float | int]:
    cells, metadata = normalized_output(output["result"])
    expected: dict[tuple[int, str], str] = {}
    structured_fields = ["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"]
    for row in fixture["rows"]:
        row_index = int(row["rowIndex"])
        for field in structured_fields:
            value = str(row[field])
            if value:
                expected[(row_index, field)] = value
    expected_metadata_date = str(fixture["metadata"]["date"])
    correct = sum(cells.get(key, "") == value for key, value in expected.items())
    correct += metadata.get("date", "") == expected_metadata_date
    expected_count = len(expected) + 1
    accepted_cells = {
        (int(cell["rowIndex"]), str(cell["columnId"])): str(cell["selectedValue"])
        for cell in output["result"]["cells"]
        if cell["selectedValue"] and not cell["needsReview"] and str(cell["columnId"]) in structured_fields
    }
    predicted = accepted_cells
    true_positive = sum(expected.get(key) == value for key, value in predicted.items())
    false_positive = sum(key not in expected for key in predicted)
    notes_expected = {
        int(row["rowIndex"]): str(row["notes"])
        for row in fixture["rows"]
        if str(row["notes"])
    }
    notes_correct = sum(cells.get((row, "notes"), "").casefold() == value.casefold() for row, value in notes_expected.items())
    return {
        "structured_accuracy": correct / expected_count,
        "non_empty_precision": true_positive / max(1, len(predicted)),
        "unsupported_guesses": false_positive,
        "free_text_note_exact_accuracy": notes_correct / max(1, len(notes_expected)),
    }


class HandwritingRecognitionBrowserTests(unittest.TestCase):
    def test_real_local_model_accuracy_privacy_desktop_mobile_and_webkit(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            aggregate_expected = 0
            aggregate_correct = 0.0
            aggregate_predictions = 0
            aggregate_true_positive = 0.0
            note_results: list[float] = []
            desktop_elapsed: list[float] = []

            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page_errors: list[str] = []
            external_requests: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("request", lambda request: external_requests.append(request.url) if not request.url.startswith(base_url) else None)
            page.goto(f"{base_url}/tests/sde/htr-browser-harness.html")
            for name in ["synthetic-htr-neat", "synthetic-htr-varied"]:
                fixture = expected_fixture(name)
                for image_spec in fixture["images"]:
                    output = run_fixture(page, str(image_spec["file"]))
                    metrics = quality_metrics(output, fixture)
                    desktop_elapsed.append(float(output["elapsedMs"]))
                    print(
                        f"HTR_FIXTURE {image_spec['file']}"
                        f" structured={float(metrics['structured_accuracy']):.4f}"
                        f" precision={float(metrics['non_empty_precision']):.4f}"
                        f" unsupported={metrics['unsupported_guesses']}"
                        f" notes={float(metrics['free_text_note_exact_accuracy']):.4f}"
                    )
                    expected_count = 1 + sum(
                        bool(str(row[field]))
                        for row in fixture["rows"]
                        for field in ["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"]
                    )
                    cells, _metadata = normalized_output(output["result"])
                    prediction_count = sum(
                        bool(cell["selectedValue"])
                        for cell in output["result"]["cells"]
                        if not cell["needsReview"] and cell["columnId"] in ["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"]
                    )
                    aggregate_expected += expected_count
                    aggregate_correct += float(metrics["structured_accuracy"]) * expected_count
                    aggregate_predictions += prediction_count
                    aggregate_true_positive += float(metrics["non_empty_precision"]) * prediction_count
                    note_results.append(float(metrics["free_text_note_exact_accuracy"]))
                    self.assertEqual(output["result"]["model"]["hashVerified"], True)
                    self.assertEqual(output["result"]["model"]["modelType"], "REAL_LOCAL_HTR")
                    self.assertEqual(output["result"]["registration"]["perspectiveCorrectionApplied"], True)
                    self.assertEqual(len(output["result"]["cells"]), 29 * 6)
                    self.assertEqual(len(output["result"]["mappingReport"]["metadataCells"]), 3)
                    self.assertLess(float(output["elapsedMs"]), 30_000)
                    self.assertIn("LOCAL_REAL_HTR_ENSEMBLE_RUNNING", [step["status"] for step in output["progress"]])
                    unsupported = {
                        f"{row_index}:{field}": value
                        for (row_index, field), value in {
                            (int(cell["rowIndex"]), str(cell["columnId"])): str(cell["selectedValue"])
                            for cell in output["result"]["cells"]
                            if cell["selectedValue"] and not cell["needsReview"]
                        }.items()
                        if value and field in ["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"]
                        and not any(int(row["rowIndex"]) == row_index and str(row[field]) for row in fixture["rows"])
                    }
                    unsupported_details = [
                        cell for cell in output["result"]["cells"]
                        if f"{cell['rowIndex']}:{cell['columnId']}" in unsupported
                    ]
                    self.assertEqual(metrics["unsupported_guesses"], 0, f"{image_spec['file']}: {unsupported_details}")
                    for cell in output["result"]["cells"]:
                        if cell["disposition"] == "REVIEW_SUGGESTION":
                            self.assertEqual(str(cell["selectedValue"]), "", f"review leaked into canonical form: {cell}")
                    expected_notes = {int(row["rowIndex"]): str(row["notes"]) for row in fixture["rows"] if str(row["notes"])}
                    for cell in output["result"]["cells"]:
                        if cell["columnId"] != "notes" or int(cell["rowIndex"]) not in expected_notes:
                            continue
                        if str(cell["selectedValue"]).casefold() != expected_notes[int(cell["rowIndex"])].casefold():
                            self.assertEqual(str(cell["selectedValue"]), "", f"{image_spec['file']}: {cell}")
                            self.assertIn(cell["disposition"], {"EMPTY", "REJECTED", "REVIEW_SUGGESTION"})
            browser.close()

            structured_accuracy = aggregate_correct / aggregate_expected
            non_empty_precision = aggregate_true_positive / aggregate_predictions
            free_text_accuracy = sum(note_results) / len(note_results)
            print(
                "HTR_QUALITY"
                f" structured_exact={structured_accuracy:.4f}"
                f" non_empty_precision={non_empty_precision:.4f}"
                " unsupported_guesses=0"
                f" free_text_note_exact={free_text_accuracy:.4f}"
            )
            self.assertGreaterEqual(non_empty_precision, 0.99)
            self.assertEqual(page_errors, [])
            self.assertEqual(external_requests, [])
            self.assertTrue(note_results, "free-text note accuracy must be measured separately")

            mobile_elapsed = self._assert_profile(playwright.chromium, base_url, {"width": 390, "height": 844}, "synthetic-htr-neat.png")
            webkit_elapsed = self._assert_profile(playwright.webkit, base_url, {"width": 390, "height": 844}, "synthetic-htr-varied.png")
            print(
                f"HTR_PERFORMANCE desktop_max_ms={max(desktop_elapsed):.1f}"
                f" mobile_390_ms={mobile_elapsed:.1f}"
                f" webkit_390_ms={webkit_elapsed:.1f}"
            )

    def test_template_b_hybrid_fixtures_meet_fail_closed_quality_contract(self) -> None:
        with static_server() as base_url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page_errors: list[str] = []
            external_requests: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("request", lambda request: external_requests.append(request.url) if not request.url.startswith(base_url) else None)
            page.goto(f"{base_url}/tests/sde/htr-browser-harness.html")

            printed_total = 0
            printed_exact = 0
            printed_mismatches: list[dict[str, object]] = []
            accepted_total = 0
            accepted_correct = 0
            proposed_exact = 0
            review_required = 0
            expected_total = 0
            unsupported_accepted: list[dict[str, object]] = []
            for name in ["synthetic-template-b-hybrid-a", "synthetic-template-b-hybrid-b"]:
                fixture = expected_fixture(name)
                base_image = str(fixture["images"][0]["file"])
                output = run_fixture(page, base_image)
                result = output["result"]
                self.assertEqual(result["registration"]["templateId"], "TEMPLATE_B")
                self.assertEqual(result["registration"]["columnCount"], 8)
                self.assertEqual(len(result["cells"]), 29 * 8)
                self.assertEqual(result["registration"]["rowGeometryStable"], True)
                progress_states = [step["status"] for step in output["progress"]]
                for required_state in [
                    "IMAGE_PREPROCESSING", "TEMPLATE_DETECTION", "TEMPLATE_REGISTERED",
                    "PRINT_OCR_RUNNING", "HANDWRITING_RECOGNITION_RUNNING",
                    "LOCAL_REAL_HTR_ENSEMBLE_RUNNING", "CELL_MAPPING_REQUIRES_REVIEW",
                ]:
                    self.assertIn(required_state, progress_states)
                actual = {
                    (int(cell["rowIndex"]), str(cell["columnId"])): cell
                    for cell in result["cells"]
                }
                expected: dict[tuple[int, str], str] = {}
                for row in fixture["rows"]:
                    row_index = int(row["rowIndex"])
                    for field in ["arrivalTime", "fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"]:
                        value = str(row[field])
                        if value:
                            expected[(row_index, field)] = value
                correction_fields: set[tuple[int, str]] = set()
                for key, expected_value in expected.items():
                    cell = actual[key]
                    selected = str(cell["selectedValue"])
                    expected_total += 1
                    proposed = selected or str(cell.get("suggestedValue", ""))
                    if proposed == expected_value:
                        proposed_exact += 1
                    if bool(cell["needsReview"]):
                        review_required += 1
                    if key not in correction_fields:
                        printed_total += 1
                        if proposed == expected_value:
                            printed_exact += 1
                        else:
                            printed_mismatches.append({"fixture": name, "key": key, "expected": expected_value, "cell": cell})
                    if selected and not bool(cell["needsReview"]):
                        accepted_total += 1
                        if selected == expected_value:
                            accepted_correct += 1
                        else:
                            unsupported_accepted.append(cell)
                for key, cell in actual.items():
                    if key[1] not in {"arrivalTime", "fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater"}:
                        continue
                    if str(cell["selectedValue"]) and not bool(cell["needsReview"]) and key not in expected:
                        unsupported_accepted.append(cell)
                metadata = {str(cell["columnId"]): cell for cell in result["metadataCells"]}
                self.assertTrue(
                    str(metadata["date"]["selectedValue"]) == str(fixture["metadata"]["date"])
                    or bool(metadata["date"]["needsReview"])
                )
                self.assertTrue(any(
                    str(cell["selectedValue"]) or str(cell.get("suggestedValue", ""))
                    for cell in result["cells"] if cell["columnId"] == "info"
                ))
                self.assertTrue(all(
                    not str(cell["selectedValue"])
                    for cell in result["cells"] if cell["disposition"] == "REVIEW_SUGGESTION"
                ))

                if name.endswith("-a"):
                    correction_output = run_fixture(page, f"{name}-correction.png")
                    correction_actual = {
                        (int(cell["rowIndex"]), str(cell["columnId"])): cell
                        for cell in correction_output["result"]["cells"]
                    }
                    for correction_key in [(1, "toTrain"), (1, "toTrack")]:
                        correction_cell = correction_actual[correction_key]
                        self.assertTrue(correction_cell["needsReview"], str(correction_cell))
                        self.assertNotEqual(correction_cell["validationState"], "VALID")
                        self.assertIsNotNone(correction_cell["printedCandidate"])
                        self.assertIsNotNone(correction_cell["handwrittenCandidate"])
                        self.assertNotEqual(
                            correction_cell["printedCandidate"]["text"],
                            correction_cell["handwrittenCandidate"]["text"],
                        )

                for image_spec in fixture["images"]:
                    registration = page.evaluate(
                        "url => window.runHtrRegistrationFixture(url)",
                        f"/tests/sde/fixtures/night-plan/{image_spec['file']}",
                    )
                    self.assertEqual(registration["templateId"], "TEMPLATE_B", str(image_spec))
                    self.assertEqual(registration["verticalLineCount"], 9, str(image_spec))

            browser.close()
            printed_accuracy = printed_exact / printed_total
            accepted_precision = accepted_correct / accepted_total if accepted_total else 1.0
            proposed_exact_rate = proposed_exact / expected_total
            auto_accepted_coverage = accepted_total / expected_total
            review_required_coverage = review_required / expected_total
            print(
                "HYBRID_OCR_QUALITY"
                f" printed_exact={printed_accuracy:.4f}"
                f" accepted_precision={accepted_precision:.4f}"
                f" proposed_exact={proposed_exact_rate:.4f}"
                f" auto_accepted_coverage={auto_accepted_coverage:.4f}"
                f" review_required_coverage={review_required_coverage:.4f}"
                f" unsupported_accepted={len(unsupported_accepted)}"
                f" printed_mismatches={len(printed_mismatches)}"
            )
            self.assertGreaterEqual(accepted_precision, 0.99)
            self.assertGreaterEqual(proposed_exact_rate, 0.40, str(printed_mismatches))
            self.assertEqual(unsupported_accepted, [])
            self.assertLess(review_required_coverage, 1)
            self.assertEqual(page_errors, [])
            self.assertEqual(external_requests, [])

    def _assert_profile(
        self,
        browser_type: BrowserType,
        base_url: str,
        viewport: dict[str, int],
        image_file: str,
    ) -> float:
        browser = browser_type.launch(headless=True)
        page = browser.new_page(viewport=viewport)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"{base_url}/tests/sde/htr-browser-harness.html")
        output = run_fixture(page, image_file)
        browser.close()
        self.assertEqual(output["viewport"]["width"], 390)
        self.assertEqual(output["result"]["model"]["executionProvider"], "wasm")
        self.assertEqual(output["result"]["model"]["hashVerified"], True)
        self.assertLess(float(output["elapsedMs"]), 30_000)
        self.assertEqual(errors, [])
        return float(output["elapsedMs"])


if __name__ == "__main__":
    unittest.main()
