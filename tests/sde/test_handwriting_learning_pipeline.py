from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "sde_handwriting_learning.py"


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", str(SCRIPT), *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class PrivateHandwritingLearningPipelineTests(unittest.TestCase):
    def test_quality_gate_rejects_holdout_leakage_and_bad_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary)
            candidate = base / "candidate.json"
            metrics = base / "metrics.json"
            report = base / "report.json"
            candidate.write_text(json.dumps({
                "modelSha256": "a" * 64,
                "trainingDocumentIds": ["same-document"],
                "holdoutDocumentIds": ["same-document"],
            }), encoding="utf-8")
            metrics.write_text(json.dumps({
                "structuredPrecision": 0.98,
                "clearCellCoverage": 0.84,
                "manualCorrectionRate": 0.11,
                "blankAcceptedFalsePositiveCount": 1,
                "gibberishFormValueCount": 1,
                "crossRowAcceptedErrorCount": 1,
                "crossColumnAcceptedErrorCount": 1,
            }), encoding="utf-8")
            result = run_cli("qualify", "--candidate-manifest", str(candidate), "--metrics", str(metrics), "--output", str(report))
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["gate"], "RED")
            self.assertIn("HOLDOUT_LEAKAGE", payload["reasons"])

    def test_green_gate_still_requires_exact_human_sha_and_supports_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary)
            candidate_hash = "b" * 64
            previous_hash = "a" * 64
            candidate = base / "candidate.json"
            metrics = base / "metrics.json"
            qualification = base / "qualification.json"
            registry = base / "registry.json"
            candidate.write_text(json.dumps({
                "modelSha256": candidate_hash,
                "trainingDocumentIds": ["train-document"],
                "holdoutDocumentIds": ["blind-document"],
            }), encoding="utf-8")
            metrics.write_text(json.dumps({
                "structuredPrecision": 1.0,
                "clearCellCoverage": 0.88,
                "manualCorrectionRate": 0.09,
                "blankAcceptedFalsePositiveCount": 0,
                "gibberishFormValueCount": 0,
                "crossRowAcceptedErrorCount": 0,
                "crossColumnAcceptedErrorCount": 0,
            }), encoding="utf-8")
            registry.write_text(json.dumps({"activeModelSha256": previous_hash, "rollbackModelSha256": "c" * 64}), encoding="utf-8")

            qualified = run_cli("qualify", "--candidate-manifest", str(candidate), "--metrics", str(metrics), "--output", str(qualification))
            self.assertEqual(qualified.returncode, 0, qualified.stdout + qualified.stderr)
            self.assertEqual(json.loads(qualification.read_text(encoding="utf-8"))["gate"], "GREEN")

            refused = run_cli("promote", "--qualification", str(qualification), "--registry", str(registry), "--approved-sha", "d" * 64)
            self.assertEqual(refused.returncode, 2)
            self.assertEqual(json.loads(registry.read_text(encoding="utf-8"))["activeModelSha256"], previous_hash)

            promoted = run_cli("promote", "--qualification", str(qualification), "--registry", str(registry), "--approved-sha", candidate_hash)
            self.assertEqual(promoted.returncode, 0, promoted.stdout + promoted.stderr)
            promoted_registry = json.loads(registry.read_text(encoding="utf-8"))
            self.assertEqual(promoted_registry["activeModelSha256"], candidate_hash)
            self.assertEqual(promoted_registry["rollbackModelSha256"], previous_hash)

            rolled_back = run_cli("rollback", "--registry", str(registry))
            self.assertEqual(rolled_back.returncode, 0, rolled_back.stdout + rolled_back.stderr)
            self.assertEqual(json.loads(registry.read_text(encoding="utf-8"))["activeModelSha256"], previous_hash)


if __name__ == "__main__":
    unittest.main()
