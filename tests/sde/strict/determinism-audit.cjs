"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const {
  BASELINE_REPLAY_TIMEOUT_MS,
  CHILD_MAX_BUFFER_BYTES,
  DETERMINISM_RUNS,
  STRICT_REPLAY_TIMEOUT_MS,
  assessRuns,
  buildChildDiagnostic,
  normalizedBaselineReport,
  normalizedStrictReport,
  validateReplaySchedule,
  validateBaselineReport,
  validateStrictReport,
} = require("./qualification-contract.cjs");

const root = path.resolve(__dirname, "../../..");
const commands = [
  {name: "strict", file: "strict-runner.cjs", timeoutMs: STRICT_REPLAY_TIMEOUT_MS, expectedExitCode: 0, validateReport: validateStrictReport, normalizeReport: normalizedStrictReport},
  {name: "baseline-audit", file: "baseline-audit.cjs", timeoutMs: BASELINE_REPLAY_TIMEOUT_MS, expectedExitCode: 0, validateReport: validateBaselineReport, normalizeReport: normalizedBaselineReport},
];
const reports = [];

const metaRun = childProcess.spawnSync(process.execPath, [path.join(__dirname, "qualification-contract-meta.cjs")], {
  cwd: root,
  encoding: "utf8",
  timeout: STRICT_REPLAY_TIMEOUT_MS,
  maxBuffer: CHILD_MAX_BUFFER_BYTES,
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

function runReplaySeries(command) {
  const runs = [];
  const intervals = [];
  const diagnostics = [];
  const epoch = process.hrtime.bigint();
  let activeChildren = 0;
  let maximumObservedConcurrency = 0;
  for (let index = 0; index < DETERMINISM_RUNS; index += 1) {
    const startNs = Number(process.hrtime.bigint() - epoch);
    activeChildren += 1;
    maximumObservedConcurrency = Math.max(maximumObservedConcurrency, activeChildren);
    let run;
    try {
      run = childProcess.spawnSync(process.execPath, [path.join(__dirname, command.file)], {
        cwd: root,
        encoding: "utf8",
        timeout: command.timeoutMs,
        maxBuffer: CHILD_MAX_BUFFER_BYTES,
      });
    } catch (error) {
      run = {status: null, signal: null, stdout: "", stderr: "", error};
    } finally {
      activeChildren -= 1;
    }
    const endNs = Number(process.hrtime.bigint() - epoch);
    run.replayTiming = {
      startNs,
      endNs,
      elapsedMs: (endNs - startNs) / 1_000_000,
      completed: !run.error && (Number.isInteger(run.status) || Boolean(run.signal)),
    };
    runs.push(run);
    intervals.push(run.replayTiming);
    const diagnostic = buildChildDiagnostic(run, {
      childType: command.name,
      runIndex: index + 1,
      command: [process.execPath, path.join(__dirname, command.file)],
      cwd: root,
      timeoutMs: command.timeoutMs,
      expectedExitCode: command.expectedExitCode,
    });
    if (diagnostic) diagnostics.push(diagnostic);
  }
  const schedule = validateReplaySchedule(intervals);
  if (maximumObservedConcurrency !== schedule.summary.maximumConcurrency) {
    schedule.errors.push(`observed concurrency ${maximumObservedConcurrency} disagrees with interval concurrency ${schedule.summary.maximumConcurrency}`);
    schedule.ok = false;
  }
  return {runs, schedule, diagnostics};
}

for (const command of commands) {
  const execution = runReplaySeries(command);
  const runs = execution.runs;
  const assessment = assessRuns(runs, command);
  reports.push({
    name: command.name,
    status: assessment.ok && execution.schedule.ok ? "PASS" : "FAIL",
    expectedExitCode: command.expectedExitCode,
    exitCodes: assessment.exitCodes,
    normalizedOutputSha256: assessment.normalizedOutputSha256,
    replayContract: execution.schedule.summary,
    childDiagnostics: execution.diagnostics,
    validationErrors: [...assessment.errors, ...execution.schedule.errors],
  });
}

const failed = reports.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-determinism-audit-v2",
  metaContract: {status: metaOk ? "PASS" : "FAIL", exitCode: metaRun.status, counts: metaReport?.counts || null},
  reports,
})}\n`);
process.exit(metaOk && failed.length === 0 ? 0 : 1);
