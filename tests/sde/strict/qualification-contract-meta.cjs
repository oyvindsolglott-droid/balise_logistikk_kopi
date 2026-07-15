"use strict";

const {
  DETERMINISM_RUNS,
  STRICT_TOTAL,
  assessRuns,
  normalizedBaselineReport,
  normalizedStrictReport,
  validateBaselineReport,
  validateStrictReport,
} = require("./qualification-contract.cjs");

function strictReport({failId = "", indexSha256 = "a".repeat(64)} = {}) {
  const ids = Array.from({length: STRICT_TOTAL}, (_, index) => `INV-META-${String(index + 1).padStart(3, "0")}`);
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

function run(report, status = 0) {
  return {status, stdout: `${JSON.stringify(report)}\n`, stderr: "", error: null};
}

const valid = strictReport();
const scenarios = [
  {
    id: "valid-closed-baseline-passes",
    passed: assessRuns(Array.from({length: 3}, () => run(valid)), {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "nonzero-strict-is-rejected",
    passed: !assessRuns(Array.from({length: 3}, () => run(valid, 1)), {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "fail-id-is-rejected",
    passed: !assessRuns(Array.from({length: 3}, () => run(strictReport({failId: "INV-CANCEL-010"}), 1)), {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "malformed-strict-output-is-rejected",
    passed: !assessRuns([run(valid), {status: 0, stdout: "not-json\n", stderr: "", error: null}, run(valid)], {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "count-mismatch-is-rejected",
    passed: !assessRuns(Array.from({length: 3}, () => run({...valid, counts: {total: 36, pass: 36, fail: 0}})), {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "duplicate-invariant-id-is-rejected",
    passed: !assessRuns(Array.from({length: 3}, () => run({...valid, results: valid.results.map((item, index) => index === 1 ? {...item, id: valid.results[0].id} : item)})), {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "one-of-three-semantic-differences-is-rejected",
    passed: !assessRuns([run(valid), run(valid), run(strictReport({indexSha256: "c".repeat(64)}))], {
      expectedExitCode: 0,
      validateReport: validateStrictReport,
      normalizeReport: normalizedStrictReport,
    }).ok,
  },
  {
    id: "baseline-exit-one-makes-determinism-red",
    passed: !assessRuns(Array.from({length: 3}, () => run(baselineReport(), 1)), {
      expectedExitCode: 0,
      validateReport: validateBaselineReport,
      normalizeReport: normalizedBaselineReport,
    }).ok,
  },
];

const failed = scenarios.filter(item => !item.passed);
const report = {
  schemaVersion: "sde-qualification-contract-meta-v1",
  counts: {total: scenarios.length, pass: scenarios.length - failed.length, fail: failed.length},
  scenarios: scenarios.map(item => ({id: item.id, status: item.passed ? "PASS" : "FAIL"})),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(failed.length ? 1 : 0);
