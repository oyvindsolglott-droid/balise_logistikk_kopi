"use strict";

const {
  BASELINE_REPLAY_TIMEOUT_MS,
  CHILD_MAX_BUFFER_BYTES,
  DETERMINISM_RUNS,
  STRICT_REPLAY_TIMEOUT_MS,
  STRICT_INVARIANT_IDS,
  STRICT_TOTAL,
  assessRuns,
  buildChildDiagnostic,
  normalizedBaselineReport,
  normalizedStrictReport,
  validateReplaySchedule,
  validateBaselineReport,
  validateStrictReport,
} = require("./qualification-contract.cjs");

function strictReport({failId = "", indexSha256 = "a".repeat(64)} = {}) {
  const ids = [...STRICT_INVARIANT_IDS];
  if (failId) ids[0] = failId;
  const results = ids.map((id, index) => ({id, status: failId && index === 0 ? "FAIL" : "PASS", detail: `meta result ${index + 1}`}));
  return {
    schemaVersion: "sde-strict-report-v1",
    mode: "strict",
    indexPath: "/synthetic/index.html",
    indexSha256,
    counts: {total: STRICT_TOTAL, pass: failId ? STRICT_TOTAL - 1 : STRICT_TOTAL, fail: failId ? 1 : 0},
    failIds: failId ? [failId] : [],
    results,
  };
}

function baselineReport() {
  return {
    schemaVersion: "sde-baseline-audit-report-v2",
    mode: "baseline-audit",
    strictRunCount: DETERMINISM_RUNS,
    strictExitCode: 0,
    strictExitCodes: [0, 0, 0],
    indexSha256: "a".repeat(64),
    counts: {total: STRICT_TOTAL, pass: STRICT_TOTAL, fail: 0},
    failIds: [],
    strictSemanticSha256: ["b".repeat(64), "b".repeat(64), "b".repeat(64)],
    validationErrors: [],
    status: "PASS",
  };
}

function run(report, status = 0, options = {}) {
  return {
    status,
    signal: options.signal || null,
    stdout: options.missingOutput ? "" : options.malformedOutput ? "not-json\n" : `${JSON.stringify(report)}\n`,
    stderr: "",
    error: options.error || null,
    replayTiming: options.replayTiming || null,
  };
}

function scheduled(report, count = DETERMINISM_RUNS) {
  return Array.from({length: count}, (_, index) => run(report, 0, {
    replayTiming: {startNs: index * 20, endNs: index * 20 + 10, elapsedMs: 0.01, completed: true},
  }));
}

function assessStrict(runs) {
  return assessRuns(runs, {expectedExitCode: 0, validateReport: validateStrictReport, normalizeReport: normalizedStrictReport});
}

function assessBaseline(runs) {
  return assessRuns(runs, {expectedExitCode: 0, validateReport: validateBaselineReport, normalizeReport: normalizedBaselineReport});
}

function schedule(runs) {
  return validateReplaySchedule(runs.map(item => item.replayTiming));
}

function scenario(id, checks) {
  return {id, checks, passed: checks.every(item => item.passed)};
}

const valid = strictReport();
const scenarios = [
  scenario("valid-closed-baseline-passes", [
    {id: "three-strict-runs-pass", passed: assessStrict(scheduled(valid)).ok},
    {id: "three-baseline-runs-pass", passed: assessBaseline(scheduled(baselineReport())).ok},
    {id: "normal-three-run-schedule-passes", passed: schedule(scheduled(valid)).ok},
    {id: "timeouts-are-separate-and-finite", passed: STRICT_REPLAY_TIMEOUT_MS === 120_000 && BASELINE_REPLAY_TIMEOUT_MS === 180_000 && CHILD_MAX_BUFFER_BYTES === 64 * 1024 * 1024},
  ]),
  scenario("nonzero-strict-is-rejected", [
    {id: "nonzero-is-rejected", passed: !assessStrict(Array.from({length: 3}, () => run(valid, 1))).ok},
    {id: "signal-is-rejected", passed: !assessStrict([run(valid), run(valid, null, {signal: "SIGTERM"}), run(valid)]).ok},
  ]),
  scenario("fail-id-is-rejected", [
    {id: "fail-id-is-rejected", passed: !assessStrict(Array.from({length: 3}, () => run(strictReport({failId: "INV-CANCEL-010"}), 1))).ok},
    {id: "two-baseline-runs-are-rejected", passed: !assessBaseline(scheduled(baselineReport(), 2)).ok && !schedule(scheduled(baselineReport(), 2)).ok},
  ]),
  scenario("malformed-strict-output-is-rejected", [
    {id: "malformed-output-is-rejected", passed: !assessStrict([run(valid), run(valid, 0, {malformedOutput: true}), run(valid)]).ok},
    {id: "missing-output-is-rejected", passed: !assessStrict([run(valid), run(valid, 0, {missingOutput: true}), run(valid)]).ok},
  ]),
  scenario("count-mismatch-is-rejected", [
    {id: "count-mismatch-is-rejected", passed: !assessStrict(Array.from({length: 3}, () => run({...valid, counts: {total: 36, pass: 36, fail: 0}}))).ok},
    {id: "four-baseline-runs-are-rejected", passed: !assessBaseline(scheduled(baselineReport(), 4)).ok && !schedule(scheduled(baselineReport(), 4)).ok},
  ]),
  scenario("duplicate-invariant-id-is-rejected", [
    {id: "duplicate-id-is-rejected", passed: !assessStrict(Array.from({length: 3}, () => run({...valid, results: valid.results.map((item, index) => index === 1 ? {...item, id: valid.results[0].id} : item)}))).ok},
    {id: "overlap-is-rejected", passed: !validateReplaySchedule([
      {startNs: 0, endNs: 20, completed: true},
      {startNs: 10, endNs: 30, completed: true},
      {startNs: 30, endNs: 40, completed: true},
    ]).ok},
    {id: "incomplete-child-is-rejected", passed: !validateReplaySchedule([
      {startNs: 0, endNs: 10, completed: true},
      {startNs: 10, endNs: 20, completed: false},
      {startNs: 20, endNs: 30, completed: true},
    ]).ok},
  ]),
  scenario("one-of-three-semantic-differences-is-rejected", [
    {id: "strict-semantic-mismatch-is-rejected", passed: !assessStrict([run(valid), run(valid), run(strictReport({indexSha256: "c".repeat(64)}))]).ok},
    {id: "baseline-semantic-mismatch-is-rejected", passed: !assessBaseline([run(baselineReport()), run(baselineReport()), run({...baselineReport(), indexSha256: "c".repeat(64)})]).ok},
  ]),
  scenario("baseline-exit-one-makes-determinism-red", (() => {
    const timeoutRun = run(baselineReport(), 0, {
      signal: "SIGTERM",
      missingOutput: true,
      error: Object.assign(new Error("synthetic timeout"), {code: "ETIMEDOUT"}),
      replayTiming: {startNs: 10, endNs: 20, elapsedMs: 5, completed: true},
    });
    const diagnostic = buildChildDiagnostic(timeoutRun, {
      childType: "baseline-audit",
      runIndex: 2,
      command: ["node", "baseline-audit.cjs"],
      cwd: "/synthetic/root",
      timeoutMs: 5,
      expectedExitCode: 0,
    });
    return [
      {id: "baseline-nonzero-is-rejected", passed: !assessBaseline(Array.from({length: 3}, () => run(baselineReport(), 1))).ok},
      {id: "timeout-is-rejected", passed: !assessBaseline([run(baselineReport()), timeoutRun, run(baselineReport())]).ok},
      {id: "timeout-diagnostic-is-complete", passed: diagnostic?.childType === "baseline-audit"
        && diagnostic.runIndex === 2
        && diagnostic.command.join(" ") === "node baseline-audit.cjs"
        && diagnostic.elapsedMs === 5
        && diagnostic.timeoutMs === 5
        && diagnostic.cwd === "/synthetic/root"
        && diagnostic.errorCode === "ETIMEDOUT"},
    ];
  })()),
];

const failed = scenarios.filter(item => !item.passed);
const report = {
  schemaVersion: "sde-qualification-contract-meta-v1",
  counts: {total: scenarios.length, pass: scenarios.length - failed.length, fail: failed.length},
  scenarios: scenarios.map(item => ({
    id: item.id,
    status: item.passed ? "PASS" : "FAIL",
    checks: item.checks.map(check => ({id: check.id, status: check.passed ? "PASS" : "FAIL"})),
  })),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(failed.length ? 1 : 0);
