#!/usr/bin/env python3
"""Build a deterministic SDE night-planning challenger from authoritative outcomes.

This is an explicit offline job. It never reads browser state, never writes operational
state, and never promotes its own output to CHAMPION.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import pathlib
import sys
from collections import Counter
from typing import Any


SCHEMA_VERSION = "sde-night-model-artifact-v1"
FEATURE_VERSION = "sde-night-features-v1"
TARGET_VERSION = "sde-night-targets-v1"
DATASET_SCHEMA_VERSION = "sde-night-training-dataset-v1"

NUMERIC_FEATURES = (
    "departureMinutes",
    "arrivalMinutes",
    "faultCount",
    "reservationCount",
    "blockingVehicleCount",
    "requiredMoveCount",
    "departureOrder",
    "serviceNeed",
    "workshopNeed",
    "cleaningNeed",
    "tursattBound",
)
CATEGORICAL_FEATURES = (
    "startSlot",
    "candidateSlot",
    "vehicleType",
    "dispositionCode",
)
FEATURE_ALLOWLIST = frozenset(NUMERIC_FEATURES + CATEGORICAL_FEATURES)
LABELS = (
    "replanOccurred",
    "morningConflict",
    "moveCount",
    "departureBlocked",
    "planCompleted",
)
BINARY_TARGETS = {
    "replanProbability": "replanOccurred",
    "morningConflictProbability": "morningConflict",
    "departureBlockingProbability": "departureBlocked",
    "planCompletionProbability": "planCompleted",
}
LINEAR_TARGETS = {"expectedMoveCount": "moveCount"}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    text = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        return None


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def exclude(counter: Counter[str], reason: str) -> None:
    counter[reason] += 1


def build_dataset(records: Any) -> dict[str, Any]:
    exclusions: Counter[str] = Counter()
    rows: list[dict[str, Any]] = []
    revisions: set[str] = set()

    if not isinstance(records, list):
        raise ValueError("Input must be a JSON array of records")

    for record in records:
        if not isinstance(record, dict):
            exclude(exclusions, "CORRUPT_RECORD")
            continue
        source_type = str(record.get("sourceType", ""))
        if source_type != "AUTHORITATIVE_EXECUTED_RESULT":
            if source_type == "SDE_RECOMMENDATION":
                exclude(exclusions, "SDE_RECOMMENDATION_NOT_GROUND_TRUTH")
            elif source_type in {"HUMAN_IMPORTED_PLAN", "HUMAN_MANUAL_PLAN", "LOCAL_BROWSER_OCR"}:
                exclude(exclusions, "UNVERIFIED_PLAN_NOT_GROUND_TRUTH")
            else:
                exclude(exclusions, "NON_AUTHORITATIVE_SOURCE")
            continue
        if record.get("currentSafetyValid") is not True:
            exclude(exclusions, "INVALID_UNDER_CURRENT_SAFETY_RULES")
            continue

        decision_at = parse_time(record.get("decisionAt"))
        outcome_known_at = parse_time(record.get("outcomeKnownAt"))
        operational_date = str(record.get("operationalDate", ""))
        try:
            dt.date.fromisoformat(operational_date)
        except ValueError:
            operational_date = ""
        if decision_at is None or not operational_date or not record.get("recordId"):
            exclude(exclusions, "MISSING_CRITICAL_STATE")
            continue
        if outcome_known_at is None or outcome_known_at <= decision_at:
            exclude(exclusions, "INVALID_OUTCOME_PROVENANCE")
            continue

        descriptors = record.get("features")
        if not isinstance(descriptors, dict) or not descriptors:
            exclude(exclusions, "MISSING_CRITICAL_STATE")
            continue
        if any(name not in FEATURE_ALLOWLIST for name in descriptors):
            exclude(exclusions, "NON_ALLOWLISTED_FEATURE")
            continue

        clean_features: dict[str, Any] = {}
        leakage = False
        invalid_feature = False
        for name, descriptor in descriptors.items():
            if not isinstance(descriptor, dict) or "value" not in descriptor:
                invalid_feature = True
                break
            known_at = parse_time(descriptor.get("knownAt"))
            if known_at is None or known_at > decision_at:
                leakage = True
                break
            if name in NUMERIC_FEATURES:
                value = finite_number(descriptor.get("value"))
                if value is None:
                    invalid_feature = True
                    break
                clean_features[name] = value
            else:
                value = str(descriptor.get("value", "")).strip().upper()
                if not value:
                    invalid_feature = True
                    break
                clean_features[name] = value
        if leakage:
            exclude(exclusions, "FUTURE_FEATURE_LEAKAGE")
            continue
        if invalid_feature:
            exclude(exclusions, "INVALID_FEATURE_VALUE")
            continue

        raw_labels = record.get("labels")
        if not isinstance(raw_labels, dict) or any(name not in raw_labels for name in LABELS):
            exclude(exclusions, "MISSING_TARGET_LABEL")
            continue
        clean_labels: dict[str, float | bool] = {}
        labels_valid = True
        for name in LABELS:
            value = raw_labels[name]
            if name == "moveCount":
                number = finite_number(value)
                if number is None or number < 0:
                    labels_valid = False
                    break
                clean_labels[name] = number
            elif isinstance(value, bool):
                clean_labels[name] = value
            else:
                labels_valid = False
                break
        if not labels_valid:
            exclude(exclusions, "INVALID_TARGET_LABEL")
            continue

        revision = str(record.get("operationalRevision", "")).strip()
        if revision:
            revisions.add(revision)
        rows.append(
            {
                "recordId": str(record["recordId"]),
                "operationalDate": operational_date,
                "decisionAt": str(record["decisionAt"]),
                "outcomeKnownAt": str(record["outcomeKnownAt"]),
                "operationalRevision": revision,
                "features": clean_features,
                "labels": clean_labels,
            }
        )

    rows.sort(key=lambda row: (row["operationalDate"], row["recordId"]))
    dates = sorted({row["operationalDate"] for row in rows})
    return {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "featureVersion": FEATURE_VERSION,
        "targetVersion": TARGET_VERSION,
        "rows": rows,
        "exclusions": dict(sorted(exclusions.items())),
        "provenance": {
            "sourcePolicy": "AUTHORITATIVE_EXECUTED_RESULT_ONLY",
            "periodStart": dates[0] if dates else None,
            "periodEnd": dates[-1] if dates else None,
            "recordCount": len(rows),
            "operationalDateCount": len(dates),
            "operationalDates": dates,
            "operationalRevisions": sorted(revisions),
            "features": list(NUMERIC_FEATURES + CATEGORICAL_FEATURES),
            "labels": list(LABELS),
            "excludedRecords": sum(exclusions.values()),
            "exclusionReasons": dict(sorted(exclusions.items())),
        },
    }


def minimum_data_failures(dataset: dict[str, Any], contract: dict[str, Any]) -> list[str]:
    rows = dataset["rows"]
    failures: list[str] = []
    if len(rows) < int(contract["minimumAuthoritativeOutcomes"]):
        failures.append("MINIMUM_AUTHORITATIVE_OUTCOMES")
    dates = {row["operationalDate"] for row in rows}
    if len(dates) < int(contract["minimumOperationalDates"]):
        failures.append("MINIMUM_OPERATIONAL_DATES")
    class_minimum = int(contract["minimumPerBinaryClass"])
    for label in BINARY_TARGETS.values():
        counts = Counter(bool(row["labels"][label]) for row in rows)
        if counts[False] < class_minimum or counts[True] < class_minimum:
            failures.append(f"MINIMUM_BINARY_CLASS:{label}")
    return failures


def split_by_time(dataset: dict[str, Any], fractions: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    dates = sorted({row["operationalDate"] for row in dataset["rows"]})
    training_end = max(1, int(len(dates) * float(fractions["training"])))
    validation_count = max(1, int(len(dates) * float(fractions["validation"])))
    validation_end = min(len(dates) - 1, training_end + validation_count)
    training_dates = set(dates[:training_end])
    validation_dates = set(dates[training_end:validation_end])
    test_dates = set(dates[validation_end:])
    return {
        "training": [row for row in dataset["rows"] if row["operationalDate"] in training_dates],
        "validation": [row for row in dataset["rows"] if row["operationalDate"] in validation_dates],
        "test": [row for row in dataset["rows"] if row["operationalDate"] in test_dates],
    }


def build_feature_schema(training_rows: list[dict[str, Any]]) -> dict[str, Any]:
    numeric: dict[str, dict[str, float]] = {}
    for name in NUMERIC_FEATURES:
        values = [
            value
            for row in training_rows
            if (value := finite_number(row["features"].get(name))) is not None
        ]
        mean = sum(values) / len(values) if values else 0.0
        variance = sum((value - mean) ** 2 for value in values) / len(values) if values else 0.0
        scale = math.sqrt(variance)
        numeric[name] = {"mean": mean, "scale": scale if scale > 1e-12 else 1.0}
    categorical = {
        name: sorted({str(row["features"].get(name, "")).upper() for row in training_rows if row["features"].get(name)})
        for name in CATEGORICAL_FEATURES
    }
    encoded = list(NUMERIC_FEATURES)
    for name in CATEGORICAL_FEATURES:
        encoded.extend(f"{name}={value}" for value in categorical[name])
    return {
        "version": FEATURE_VERSION,
        "numeric": numeric,
        "categorical": categorical,
        "encodedFeatures": encoded,
        "missingNumericPolicy": "TRAINING_MEAN_AS_STANDARDIZED_ZERO",
        "unknownCategoryPolicy": "ALL_ZERO",
    }


def encode_features(features: dict[str, Any], schema: dict[str, Any]) -> list[float]:
    encoded: list[float] = []
    for name in NUMERIC_FEATURES:
        descriptor = schema["numeric"][name]
        value = finite_number(features.get(name))
        encoded.append(
            0.0
            if value is None
            else (value - float(descriptor["mean"])) / float(descriptor["scale"])
        )
    for name in CATEGORICAL_FEATURES:
        actual = str(features.get(name, "")).upper()
        encoded.extend(1.0 if actual == category else 0.0 for category in schema["categorical"][name])
    return encoded


def sigmoid(value: float) -> float:
    clipped = max(-30.0, min(30.0, value))
    return 1.0 / (1.0 + math.exp(-clipped))


def train_model(
    rows: list[dict[str, Any]],
    schema: dict[str, Any],
    label: str,
    model_type: str,
    iterations: int,
    learning_rate: float,
    regularization: float,
) -> dict[str, Any]:
    feature_names = schema["encodedFeatures"]
    matrix = [encode_features(row["features"], schema) for row in rows]
    targets = [float(row["labels"][label]) for row in rows]
    weights = [0.0] * len(feature_names)
    if model_type == "logistic":
        prevalence = min(1 - 1e-6, max(1e-6, sum(targets) / len(targets)))
        intercept = math.log(prevalence / (1 - prevalence))
    else:
        intercept = sum(targets) / len(targets)

    for _ in range(iterations):
        intercept_gradient = 0.0
        weight_gradients = [0.0] * len(weights)
        for vector, target in zip(matrix, targets):
            raw = intercept + sum(weight * value for weight, value in zip(weights, vector))
            prediction = sigmoid(raw) if model_type == "logistic" else raw
            error = prediction - target
            intercept_gradient += error
            for index, value in enumerate(vector):
                weight_gradients[index] += error * value
        count = float(len(rows))
        intercept -= learning_rate * intercept_gradient / count
        for index in range(len(weights)):
            gradient = weight_gradients[index] / count + regularization * weights[index]
            weights[index] -= learning_rate * gradient

    return {
        "type": model_type,
        "intercept": round(intercept, 12),
        "weights": {name: round(weight, 12) for name, weight in zip(feature_names, weights)},
        "regularization": regularization,
        "iterations": iterations,
    }


def predict(model: dict[str, Any], features: dict[str, Any], schema: dict[str, Any]) -> float:
    vector = encode_features(features, schema)
    raw = float(model["intercept"]) + sum(
        float(model["weights"][name]) * value for name, value in zip(schema["encodedFeatures"], vector)
    )
    return sigmoid(raw) if model["type"] == "logistic" else raw


def binary_metrics(rows: list[dict[str, Any]], model: dict[str, Any], schema: dict[str, Any], label: str) -> dict[str, Any]:
    if not rows:
        return {"sampleCount": 0, "brier": None, "precision": None, "recall": None, "calibration": []}
    pairs = [(predict(model, row["features"], schema), bool(row["labels"][label])) for row in rows]
    brier = sum((probability - int(actual)) ** 2 for probability, actual in pairs) / len(pairs)
    true_positive = sum(probability >= 0.5 and actual for probability, actual in pairs)
    false_positive = sum(probability >= 0.5 and not actual for probability, actual in pairs)
    false_negative = sum(probability < 0.5 and actual for probability, actual in pairs)
    calibration = []
    for lower in (0.0, 0.2, 0.4, 0.6, 0.8):
        bucket = [(probability, actual) for probability, actual in pairs if lower <= probability < lower + 0.2 or (lower == 0.8 and probability == 1.0)]
        if bucket:
            calibration.append(
                {
                    "range": [lower, round(lower + 0.2, 1)],
                    "count": len(bucket),
                    "meanPrediction": round(sum(item[0] for item in bucket) / len(bucket), 6),
                    "observedRate": round(sum(int(item[1]) for item in bucket) / len(bucket), 6),
                }
            )
    return {
        "sampleCount": len(rows),
        "brier": round(brier, 6),
        "precision": round(true_positive / (true_positive + false_positive), 6) if true_positive + false_positive else None,
        "recall": round(true_positive / (true_positive + false_negative), 6) if true_positive + false_negative else None,
        "calibration": calibration,
    }


def linear_metrics(rows: list[dict[str, Any]], model: dict[str, Any], schema: dict[str, Any], label: str) -> dict[str, Any]:
    if not rows:
        return {"sampleCount": 0, "mae": None}
    errors = [abs(predict(model, row["features"], schema) - float(row["labels"][label])) for row in rows]
    return {"sampleCount": len(rows), "mae": round(sum(errors) / len(errors), 6)}


def split_manifest(splits: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, rows in splits.items():
        dates = sorted({row["operationalDate"] for row in rows})
        result[name] = {
            "recordCount": len(rows),
            "operationalDateCount": len(dates),
            "periodStart": dates[0] if dates else None,
            "periodEnd": dates[-1] if dates else None,
            "recordIdsHash": sha256([row["recordId"] for row in rows]),
        }
    return result


def make_artifact(records: Any, config: dict[str, Any], trained_at: str, requested_version: str | None) -> dict[str, Any]:
    dataset = build_dataset(records)
    dataset_payload = {
        "schemaVersion": dataset["schemaVersion"],
        "featureVersion": dataset["featureVersion"],
        "targetVersion": dataset["targetVersion"],
        "rows": dataset["rows"],
        "provenance": dataset["provenance"],
    }
    dataset_version = f"sha256:{sha256(dataset_payload)}"
    contract = config["minimumDataContract"]
    failures = minimum_data_failures(dataset, contract)
    model_version = requested_version or f"1.0.0-challenger.{dataset_version[-8:]}"
    artifact: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "modelId": "sde-night-tabular",
        "modelVersion": model_version,
        "status": "INSUFFICIENT_DATA" if failures else "CHALLENGER",
        "trainedAt": None if failures else trained_at,
        "trainingDatasetVersion": dataset_version,
        "datasetVersion": dataset_version,
        "featureVersion": FEATURE_VERSION,
        "targetVersion": TARGET_VERSION,
        "minimumDataContractVersion": contract["version"],
        "minimumDataAssessment": {
            "passed": not failures,
            "failures": failures,
            "recordCount": dataset["provenance"]["recordCount"],
            "operationalDateCount": dataset["provenance"]["operationalDateCount"],
            "contract": contract,
        },
        "algorithm": config["training"]["algorithm"],
        "provenance": dataset["provenance"],
        "split": None,
        "featureSchema": None,
        "models": None,
        "metrics": None,
        "deploymentPolicy": {
            "maySelfPromote": False,
            "requiresExplicitChampionApproval": True,
            "runtimeTrainingAllowed": False,
        },
    }

    if not failures:
        splits = split_by_time(dataset, contract["splitFractions"])
        schema = build_feature_schema(splits["training"])
        settings = config["training"]
        models: dict[str, Any] = {}
        for output, label in BINARY_TARGETS.items():
            models[output] = train_model(
                splits["training"], schema, label, "logistic",
                int(settings["iterations"]), float(settings["learningRate"]), float(settings["l2Regularization"]),
            )
        for output, label in LINEAR_TARGETS.items():
            models[output] = train_model(
                splits["training"], schema, label, "linear",
                int(settings["iterations"]), float(settings["learningRate"]), float(settings["l2Regularization"]),
            )
        metrics: dict[str, Any] = {"validation": {}, "test": {}}
        for split_name in ("validation", "test"):
            for output, label in BINARY_TARGETS.items():
                metrics[split_name][output] = binary_metrics(splits[split_name], models[output], schema, label)
            for output, label in LINEAR_TARGETS.items():
                metrics[split_name][output] = linear_metrics(splits[split_name], models[output], schema, label)
        artifact["split"] = split_manifest(splits)
        artifact["featureSchema"] = schema
        artifact["models"] = models
        artifact["metrics"] = metrics

    artifact["artifactHash"] = sha256(artifact)
    return artifact


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=pathlib.Path, help="Authoritative outcome records as JSON array")
    parser.add_argument("--output", required=True, type=pathlib.Path, help="Artifact JSON path")
    parser.add_argument("--config", default=pathlib.Path("config/sde-night-intelligence.json"), type=pathlib.Path)
    parser.add_argument("--trained-at", help="Controlled ISO-8601 training timestamp; defaults to current UTC")
    parser.add_argument("--model-version")
    args = parser.parse_args(argv)

    records = json.loads(args.input.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    trained_at = args.trained_at or dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    if parse_time(trained_at) is None:
        raise ValueError("--trained-at must be a valid ISO-8601 timestamp")
    artifact = make_artifact(records, config, trained_at, args.model_version)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": artifact["status"], "modelVersion": artifact["modelVersion"], "artifactHash": artifact["artifactHash"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
