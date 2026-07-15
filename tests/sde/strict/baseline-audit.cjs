"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const {
  DETERMINISM_RUNS,
  assessRuns,
  normalizedStrictReport,
  validateStrictReport,
} = require("./qualification-contract.cjs");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const strictRuns = Array.from({length: DETERMINISM_RUNS}, () => childProcess.spawnSync(
  process.execPath,
  [path.join(__dirname, "strict-runner.cjs"), indexPath],
  {cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024},
));
const assessment = assessRuns(strictRuns, {
  expectedExitCode: 0,
  validateReport: validateStrictReport,
  normalizeReport: normalizedStrictReport,
});
const actual = assessment.parsed.find(Boolean) || {};
const report = {
  schemaVersion: "sde-baseline-audit-report-v2",
  mode: "baseline-audit",
  strictRunCount: DETERMINISM_RUNS,
  strictExitCode: strictRuns[0]?.status ?? null,
  strictExitCodes: assessment.exitCodes,
  indexSha256: actual.indexSha256,
  counts: actual.counts,
  failIds: actual.failIds,
  strictSemanticSha256: assessment.normalizedOutputSha256,
  validationErrors: assessment.errors,
  status: assessment.ok ? "PASS" : "FAIL",
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(assessment.ok ? 0 : 1);
