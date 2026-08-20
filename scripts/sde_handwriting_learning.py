#!/usr/bin/env python3
"""Private, document-disjoint SDE handwriting learning lifecycle.

No command reads or writes public webroot data. ``prepare`` derives private
cell crops only from explicitly saved, human-confirmed night plans. Training,
qualification, promotion and rollback are separate operator commands.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from typing import Any

GATE = {
    "structuredPrecision": 0.99,
    "clearCellCoverage": 0.85,
    "manualCorrectionRate": 0.10,
    "blankAcceptedFalsePositiveCount": 0,
    "gibberishFormValueCount": 0,
    "crossRowAcceptedErrorCount": 0,
    "crossColumnAcceptedErrorCount": 0,
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_private_root(path: Path, repository_root: Path) -> Path:
    root = path.expanduser().resolve()
    repository = repository_root.expanduser().resolve()
    if root == repository or repository in root.parents:
        raise ValueError("private learning output must be outside the repository")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    return root


def load_split_manifest(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    assignments = payload.get("documents")
    if not isinstance(assignments, dict) or not assignments:
        raise ValueError("split manifest requires document assignments")
    normalized = {str(document): str(split).upper() for document, split in assignments.items()}
    if any(split not in {"PRIVATE_TRAIN", "PRIVATE_VALIDATION", "PRIVATE_BLIND_HOLDOUT"} for split in normalized.values()):
        raise ValueError("invalid private dataset split")
    return normalized


def prepare(args: argparse.Namespace) -> None:
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    repository_root = Path(args.repository_root).resolve()
    output_root = ensure_private_root(Path(args.output), repository_root)
    image_root = Path(args.image_root).expanduser().resolve()
    assignments = load_split_manifest(Path(args.split_manifest))
    database = sqlite3.connect(f"file:{Path(args.db).resolve()}?mode=ro", uri=True)
    database.row_factory = sqlite3.Row
    rows = database.execute(
        """
        SELECT learning.learning_record_id, learning.plan_id, learning.plan_revision,
               learning.model_version, learning.pipeline_version,
               learning.recognizer_result_json, learning.human_ground_truth_json,
               images.storage_key, images.sha256 AS image_sha256
          FROM night_plan_learning_records AS learning
          JOIN night_plan_images AS images
            ON images.plan_id = learning.plan_id
           AND images.plan_revision = learning.plan_revision
         WHERE learning.learning_status = 'READY'
           AND learning.learning_source = 'HUMAN_CORRECTED_FORM'
        ORDER BY learning.plan_id, learning.plan_revision
        """
    ).fetchall()
    examples = []
    for row in rows:
        document_id = f"{row['plan_id']}:{row['plan_revision']}"
        split = assignments.get(document_id)
        if not split:
            continue
        source_path = (image_root / "images" / row["storage_key"]).resolve()
        if image_root not in source_path.parents or not source_path.is_file():
            raise ValueError("private source image path is invalid")
        if sha256_file(source_path) != row["image_sha256"]:
            raise ValueError("private source image hash mismatch")
        recognition = json.loads(row["recognizer_result_json"] or "{}")
        cells = recognition.get("tableCells", []) + recognition.get("metadataCells", [])
        with Image.open(source_path) as opened:
            source = ImageOps.exif_transpose(opened).convert("RGB")
            for index, cell in enumerate(cells):
                if cell.get("groundTruthSource") != "HUMAN_CORRECTED_FORM" or cell.get("rawRecognizerIsGroundTruth") is True:
                    raise ValueError("learning cell lacks human ground-truth provenance")
                box = cell.get("sourceBoundingBox") or cell.get("boundingBox") or {}
                coordinates = tuple(int(round(float(box[name]))) for name in ("x0", "y0", "x1", "y1"))
                if coordinates[2] <= coordinates[0] or coordinates[3] <= coordinates[1]:
                    raise ValueError("invalid learning crop bounds")
                example_id = hashlib.sha256(f"{document_id}:{index}:{cell.get('columnId')}".encode()).hexdigest()[:24]
                example_root = output_root / split.lower() / example_id
                example_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                original = source.crop(coordinates)
                processed = ImageOps.autocontrast(ImageOps.grayscale(original))
                processed = processed.point(lambda value: 0 if value < 175 else 255, mode="1")
                original_path = example_root / "original.png"
                processed_path = example_root / "processed.png"
                original.save(original_path, format="PNG")
                processed.save(processed_path, format="PNG")
                augmentation_paths = []
                if split == "PRIVATE_TRAIN":
                    variants = [
                        ("rotate-left", original.rotate(-1.5, fillcolor="white")),
                        ("rotate-right", original.rotate(1.5, fillcolor="white")),
                        ("blur", original.filter(ImageFilter.GaussianBlur(0.65))),
                        ("contrast-low", ImageEnhance.Contrast(original).enhance(0.78)),
                        ("contrast-high", ImageEnhance.Contrast(original).enhance(1.25)),
                    ]
                    for name, variant in variants:
                        target = example_root / f"augment-{name}.png"
                        variant.save(target, format="PNG")
                        augmentation_paths.append(str(target.relative_to(output_root)))
                examples.append({
                    "exampleId": example_id,
                    "documentId": document_id,
                    "split": split,
                    "fieldType": cell.get("columnId"),
                    "blankLabel": not bool(cell.get("humanFinalValue")),
                    "groundTruth": str(cell.get("humanFinalValue") or ""),
                    "humanDisposition": cell.get("humanDisposition"),
                    "rawCandidates": cell.get("rawCandidates", []),
                    "modelConfidence": cell.get("confidence"),
                    "modelVersion": row["model_version"],
                    "preprocessingVersion": row["pipeline_version"],
                    "originalCrop": str(original_path.relative_to(output_root)),
                    "processedCrop": str(processed_path.relative_to(output_root)),
                    "augmentations": augmentation_paths,
                })
    manifest = {
        "schemaVersion": "sde-private-handwriting-dataset-v1",
        "privacy": "PRIVATE_LOCAL_ONLY",
        "splitUnit": "DOCUMENT",
        "examples": examples,
    }
    manifest["manifestSha256"] = hashlib.sha256(canonical_bytes(manifest)).hexdigest()
    target = output_root / "dataset-manifest.json"
    target.write_bytes(canonical_bytes(manifest))
    os.chmod(target, 0o600)
    print(json.dumps({"ok": True, "exampleCount": len(examples), "manifestSha256": manifest["manifestSha256"]}))


def train(args: argparse.Namespace) -> None:
    manifest_path = Path(args.dataset_manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    train_documents = {item["documentId"] for item in manifest["examples"] if item["split"] == "PRIVATE_TRAIN"}
    holdout_documents = {item["documentId"] for item in manifest["examples"] if item["split"] == "PRIVATE_BLIND_HOLDOUT"}
    if not train_documents or train_documents & holdout_documents:
        raise ValueError("training/holdout split is missing or leaked")
    command = json.loads(args.command_json)
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise ValueError("training command must be a non-empty JSON argv array")
    environment = {**os.environ, "SDE_PRIVATE_DATASET_MANIFEST": str(manifest_path), "SDE_CANDIDATE_MODEL_OUTPUT": str(Path(args.output_model).resolve())}
    subprocess.run(command, check=True, shell=False, env=environment)
    output_model = Path(args.output_model).resolve()
    if not output_model.is_file():
        raise ValueError("trainer did not produce a candidate model")
    candidate = {
        "schemaVersion": "sde-handwriting-model-candidate-v1",
        "modelSha256": sha256_file(output_model),
        "datasetManifestSha256": manifest["manifestSha256"],
        "trainingDocumentIds": sorted(train_documents),
        "holdoutDocumentIds": sorted(holdout_documents),
        "autoPromotion": False,
    }
    Path(args.output_manifest).write_bytes(canonical_bytes(candidate))
    print(json.dumps({"ok": True, "candidateModelSha256": candidate["modelSha256"], "autoPromoted": False}))


def qualify(args: argparse.Namespace) -> None:
    candidate = json.loads(Path(args.candidate_manifest).read_text(encoding="utf-8"))
    metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))
    reasons = []
    if set(candidate.get("trainingDocumentIds", [])) & set(candidate.get("holdoutDocumentIds", [])):
        reasons.append("HOLDOUT_LEAKAGE")
    for name, threshold in GATE.items():
        value = metrics.get(name)
        if value is None or (name.endswith("Count") and int(value) != int(threshold)):
            reasons.append(f"{name.upper()}_GATE")
        elif name in {"structuredPrecision", "clearCellCoverage"} and float(value) < threshold:
            reasons.append(f"{name.upper()}_BELOW_GATE")
        elif name == "manualCorrectionRate" and float(value) > threshold:
            reasons.append("MANUAL_CORRECTION_RATE_ABOVE_GATE")
    report = {**candidate, "metrics": metrics, "gate": "GREEN" if not reasons else "RED", "reasons": reasons, "humanPromotionRequired": True}
    Path(args.output).write_bytes(canonical_bytes(report))
    print(json.dumps({"ok": not reasons, "gate": report["gate"], "reasons": reasons}))
    if reasons:
        raise SystemExit(2)


def promote(args: argparse.Namespace) -> None:
    qualification = json.loads(Path(args.qualification).read_text(encoding="utf-8"))
    registry_path = Path(args.registry)
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    candidate_hash = qualification.get("modelSha256")
    if qualification.get("gate") != "GREEN" or args.approved_sha != candidate_hash:
        raise ValueError("candidate requires matching human SHA approval and a green gate")
    previous = registry.get("activeModelSha256")
    registry.update({"activeModelSha256": candidate_hash, "rollbackModelSha256": previous, "lastPromotion": {"candidateModelSha256": candidate_hash, "humanApproved": True, "gate": "GREEN"}})
    registry_path.write_bytes(canonical_bytes(registry))
    print(json.dumps({"ok": True, "activeModelSha256": candidate_hash, "rollbackModelSha256": previous}))


def rollback(args: argparse.Namespace) -> None:
    registry_path = Path(args.registry)
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    rollback_hash = registry.get("rollbackModelSha256")
    if not isinstance(rollback_hash, str) or len(rollback_hash) != 64:
        raise ValueError("rollback model is unavailable")
    registry["activeModelSha256"], registry["rollbackModelSha256"] = rollback_hash, registry.get("activeModelSha256")
    registry_path.write_bytes(canonical_bytes(registry))
    print(json.dumps({"ok": True, "activeModelSha256": rollback_hash}))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    for name in ("db", "image-root", "output", "split-manifest", "repository-root"):
        prepare_parser.add_argument(f"--{name}", required=True)
    prepare_parser.set_defaults(handler=prepare)
    train_parser = commands.add_parser("train")
    for name in ("dataset-manifest", "command-json", "output-model", "output-manifest"):
        train_parser.add_argument(f"--{name}", required=True)
    train_parser.set_defaults(handler=train)
    qualify_parser = commands.add_parser("qualify")
    for name in ("candidate-manifest", "metrics", "output"):
        qualify_parser.add_argument(f"--{name}", required=True)
    qualify_parser.set_defaults(handler=qualify)
    promote_parser = commands.add_parser("promote")
    for name in ("qualification", "registry", "approved-sha"):
        promote_parser.add_argument(f"--{name}", required=True)
    promote_parser.set_defaults(handler=promote)
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--registry", required=True)
    rollback_parser.set_defaults(handler=rollback)
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    try:
        arguments.handler(arguments)
    except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
