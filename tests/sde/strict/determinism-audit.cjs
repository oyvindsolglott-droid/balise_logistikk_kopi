"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const {
  DETERMINISM_RUNS,
  assessRuns,
  normalizedBaselineReport,
  normalizedStrictReport,
  validateBaselineReport,
  validateStrictReport,
} = require("./qualification-contract.cjs");

const root = path.resolve(__dirname, "../../..");
const commands = [
  {name: "strict", file: "strict-runner.cjs", expectedExitCode: 0, validateReport: validateStrictReport, normalizeReport: normalizedStrictReport},
  {name: "baseline-audit", file: "baseline-audit.cjs", expectedExitCode: 0, validateReport: validateBaselineReport, normalizeReport: normalizedBaselineReport},
];
const reports = [];

const metaRun = childProcess.spawnSync(process.execPath, [path.join(__dirname, "qualification-contract-meta.cjs")], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});
let metaReport = null;
try {
  metaReport = JSON.parse(String(metaRun.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
} catch {}
const requiredMetaScenarios = [
  "valid-closed-baseline-passes",
  "nonzero-strict-is-rejected",
  "fail-id-is-rejected",
  "malformed-strict-output-is-rejected",
  "count-mismatch-is-rejected",
  "duplicate-invariant-id-is-rejected",
  "one-of-three-semantic-differences-is-rejected",
  "baseline-exit-one-makes-determinism-red",
];
const metaOk = !metaRun.error
  && metaRun.status === 0
  && !String(metaRun.stderr || "").trim()
  && metaReport?.schemaVersion === "sde-qualification-contract-meta-v1"
  && metaReport?.counts?.total === requiredMetaScenarios.length
  && metaReport?.counts?.pass === requiredMetaScenarios.length
  && metaReport?.counts?.fail === 0
  && requiredMetaScenarios.every(id => metaReport.scenarios?.some(item => item.id === id && item.status === "PASS"));

for (const command of commands) {
  const runs = Array.from({length: DETERMINISM_RUNS}, () => childProcess.spawnSync(process.execPath, [path.join(__dirname, command.file)], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  }));
  const assessment = assessRuns(runs, command);
  reports.push({
    name: command.name,
    status: assessment.ok ? "PASS" : "FAIL",
    expectedExitCode: command.expectedExitCode,
    exitCodes: assessment.exitCodes,
    normalizedOutputSha256: assessment.normalizedOutputSha256,
    validationErrors: assessment.errors,
  });
}

const failed = reports.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-determinism-audit-v2",
  metaContract: {status: metaOk ? "PASS" : "FAIL", exitCode: metaRun.status, counts: metaReport?.counts || null},
  reports,
})}\n`);
process.exit(metaOk && failed.length === 0 ? 0 : 1);
