from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


def load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


TRAINER = load_module("sde_night_trainer", "scripts/train_sde_night_model.py")
PROMOTER = load_module("sde_night_promoter", "scripts/promote_sde_night_model.py")
CONFIG = json.loads((ROOT / "config/sde-night-intelligence.json").read_text(encoding="utf-8"))


def outcome(index: int, date_number: int) -> dict:
    operational_date = f"2026-06-{date_number:02d}"
    decision_at = f"{operational_date}T20:00:00.000Z"
    next_date = f"2026-06-{date_number + 1:02d}" if date_number < 30 else "2026-07-01"
    boolean = index % 2 == 0
    return {
        "sourceType": "AUTHORITATIVE_EXECUTED_RESULT",
        "recordId": f"outcome-{index:03d}",
        "operationalDate": operational_date,
        "decisionAt": decision_at,
        "outcomeKnownAt": f"{next_date}T05:00:00.000Z",
        "operationalRevision": f"rev-{date_number:02d}",
        "currentSafetyValid": True,
        "features": {
            "startSlot": {"value": "5N" if boolean else "6N", "knownAt": decision_at},
            "candidateSlot": {"value": "12S" if index % 3 else "11S", "knownAt": decision_at},
            "departureMinutes": {"value": 240 + index, "knownAt": decision_at},
            "arrivalMinutes": {"value": 80 + index, "knownAt": decision_at},
            "vehicleType": {"value": "74" if boolean else "75", "knownAt": decision_at},
            "workshopNeed": {"value": index % 5 == 0, "knownAt": decision_at},
            "cleaningNeed": {"value": index % 3 == 0, "knownAt": decision_at},
            "dispositionCode": {"value": "ORDINARY", "knownAt": decision_at},
            "faultCount": {"value": index % 3, "knownAt": decision_at},
            "reservationCount": {"value": index % 2, "knownAt": decision_at},
            "blockingVehicleCount": {"value": index % 4, "knownAt": decision_at},
            "requiredMoveCount": {"value": 1 + index % 4, "knownAt": decision_at},
            "tursattBound": {"value": True, "knownAt": decision_at},
            "departureOrder": {"value": 1 + index % 8, "knownAt": decision_at},
            "serviceNeed": {"value": index % 3 == 0, "knownAt": decision_at},
        },
        "labels": {
            "replanOccurred": boolean,
            "morningConflict": index % 3 == 0,
            "moveCount": 1 + index % 4,
            "departureBlocked": index % 4 == 0,
            "planCompleted": not boolean,
        },
    }


def enough_records() -> list[dict]:
    records = []
    for date_number in range(1, 21):
        for per_date in range(4):
            records.append(outcome((date_number - 1) * 4 + per_date, date_number))
    return records


def unsigned_hash(value: dict) -> str:
    unsigned = copy.deepcopy(value)
    unsigned.pop("artifactHash", None)
    return hashlib.sha256(TRAINER.canonical_json(unsigned).encode("utf-8")).hexdigest()


class DatasetContractTests(unittest.TestCase):
    def test_only_authoritative_current_safe_predecision_allowlisted_data_survives(self):
        valid = outcome(1, 1)
        recommendation = copy.deepcopy(valid)
        recommendation.update(recordId="recommendation", sourceType="SDE_RECOMMENDATION")
        ocr = copy.deepcopy(valid)
        ocr.update(recordId="ocr", sourceType="HUMAN_IMPORTED_PLAN")
        unsafe = copy.deepcopy(valid)
        unsafe.update(recordId="unsafe", currentSafetyValid=False)
        identity = copy.deepcopy(valid)
        identity["recordId"] = "identity"
        identity["features"]["email"] = {"value": "operator@example.com", "knownAt": identity["decisionAt"]}
        future = copy.deepcopy(valid)
        future["recordId"] = "future"
        future["features"]["startSlot"]["knownAt"] = future["outcomeKnownAt"]

        dataset = TRAINER.build_dataset([valid, recommendation, ocr, unsafe, identity, future])

        self.assertEqual([row["recordId"] for row in dataset["rows"]], [valid["recordId"]])
        self.assertEqual(dataset["exclusions"]["SDE_RECOMMENDATION_NOT_GROUND_TRUTH"], 1)
        self.assertEqual(dataset["exclusions"]["UNVERIFIED_PLAN_NOT_GROUND_TRUTH"], 1)
        self.assertEqual(dataset["exclusions"]["INVALID_UNDER_CURRENT_SAFETY_RULES"], 1)
        self.assertEqual(dataset["exclusions"]["NON_ALLOWLISTED_FEATURE"], 1)
        self.assertEqual(dataset["exclusions"]["FUTURE_FEATURE_LEAKAGE"], 1)
        self.assertNotIn("email", json.dumps(dataset))

    def test_missing_data_produces_honest_cold_start_artifact(self):
        artifact = TRAINER.make_artifact([], CONFIG, "2026-08-07T10:00:00Z", None)

        self.assertEqual(artifact["status"], "INSUFFICIENT_DATA")
        self.assertIsNone(artifact["models"])
        self.assertIsNone(artifact["metrics"])
        self.assertFalse(artifact["minimumDataAssessment"]["passed"])
        self.assertIn("MINIMUM_AUTHORITATIVE_OUTCOMES", artifact["minimumDataAssessment"]["failures"])
        self.assertEqual(artifact["artifactHash"], unsigned_hash(artifact))


class ControlledTrainingTests(unittest.TestCase):
    def test_training_is_deterministic_time_split_and_challenger_only(self):
        records = enough_records()
        first = TRAINER.make_artifact(records, CONFIG, "2026-08-07T10:00:00Z", "1.2.3-test")
        second = TRAINER.make_artifact(records, CONFIG, "2026-08-07T10:00:00Z", "1.2.3-test")

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "CHALLENGER")
        self.assertTrue(first["minimumDataAssessment"]["passed"])
        self.assertFalse(first["deploymentPolicy"]["maySelfPromote"])
        self.assertEqual(first["artifactHash"], unsigned_hash(first))
        self.assertLess(first["split"]["training"]["periodEnd"], first["split"]["validation"]["periodStart"])
        self.assertLess(first["split"]["validation"]["periodEnd"], first["split"]["test"]["periodStart"])
        self.assertIn("brier", first["metrics"]["test"]["replanProbability"])
        self.assertIn("calibration", first["metrics"]["test"]["morningConflictProbability"])
        self.assertIn("mae", first["metrics"]["test"]["expectedMoveCount"])

    def test_cli_writes_versioned_artifact_not_operational_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            input_path = directory / "outcomes.json"
            output_path = directory / "challenger.json"
            input_path.write_text(json.dumps(enough_records()), encoding="utf-8")
            result = TRAINER.main([
                "--input", str(input_path),
                "--output", str(output_path),
                "--config", str(ROOT / "config/sde-night-intelligence.json"),
                "--trained-at", "2026-08-07T10:00:00Z",
                "--model-version", "1.2.3-cli",
            ])

            self.assertEqual(result, 0)
            artifact = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(artifact["modelVersion"], "1.2.3-cli")
            self.assertEqual(artifact["status"], "CHALLENGER")
            self.assertNotIn("actualPlacement", json.dumps(artifact))

    def test_time_split_has_disjoint_records_and_strictly_ordered_dates(self):
        dataset = TRAINER.build_dataset(enough_records())
        splits = TRAINER.split_by_time(dataset, CONFIG["minimumDataContract"]["splitFractions"])
        record_sets = {
            name: {row["recordId"] for row in rows}
            for name, rows in splits.items()
        }
        self.assertFalse(record_sets["training"] & record_sets["validation"])
        self.assertFalse(record_sets["training"] & record_sets["test"])
        self.assertFalse(record_sets["validation"] & record_sets["test"])
        self.assertEqual(set.union(*record_sets.values()), {row["recordId"] for row in dataset["rows"]})
        self.assertLess(
            max(row["operationalDate"] for row in splits["training"]),
            min(row["operationalDate"] for row in splits["validation"]),
        )
        self.assertLess(
            max(row["operationalDate"] for row in splits["validation"]),
            min(row["operationalDate"] for row in splits["test"]),
        )

    def test_missing_numeric_features_are_mean_imputed_as_standardized_zero(self):
        rows = TRAINER.build_dataset(enough_records())["rows"]
        rows[0]["features"].pop("departureMinutes")
        schema = TRAINER.build_feature_schema(rows)
        vector = TRAINER.encode_features(rows[0]["features"], schema)
        departure_index = schema["encodedFeatures"].index("departureMinutes")
        self.assertEqual(schema["missingNumericPolicy"], "TRAINING_MEAN_AS_STANDARDIZED_ZERO")
        self.assertEqual(vector[departure_index], 0.0)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.challenger = TRAINER.make_artifact(
            enough_records(), CONFIG, "2026-08-07T10:00:00Z", "1.2.3-promote"
        )

    def test_model_cannot_self_promote_or_use_unbound_approval(self):
        with self.assertRaises(ValueError):
            PROMOTER.promote(self.challenger, {})
        approval = {
            "approvedArtifactHash": "0" * 64,
            "approvedBy": "technical-model-owner",
            "approvedAt": "2026-08-07T11:00:00Z",
            "approvalReason": "Compared validation and test metrics",
            "comparedToChampion": "NONE_COLD_START",
        }
        with self.assertRaises(ValueError):
            PROMOTER.promote(self.challenger, approval)

    def test_explicit_bound_approval_creates_separately_hashed_champion(self):
        approval = {
            "approvedArtifactHash": self.challenger["artifactHash"],
            "approvedBy": "technical-model-owner",
            "approvedAt": "2026-08-07T11:00:00Z",
            "approvalReason": "Compared validation, test, calibration, stability and safety compatibility",
            "comparedToChampion": "NONE_COLD_START",
        }
        champion = PROMOTER.promote(self.challenger, approval)

        self.assertEqual(champion["status"], "CHAMPION")
        self.assertEqual(champion["promotion"]["sourceArtifactHash"], self.challenger["artifactHash"])
        self.assertNotEqual(champion["artifactHash"], self.challenger["artifactHash"])
        self.assertEqual(champion["artifactHash"], unsigned_hash(champion))


if __name__ == "__main__":
    unittest.main()
