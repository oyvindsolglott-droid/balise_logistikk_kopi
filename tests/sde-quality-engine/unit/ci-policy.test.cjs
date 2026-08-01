"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { result, summarize } = require("../lib/core.cjs");
const { evaluateCiPolicy, renderCiSummary } = require("../lib/ci-policy.cjs");

const COMMIT = "cc4ec68ad691012aa468b5782981bf874ac2d6bb";

function countsFor(results) {
  return results.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { GREEN: 0, AMBER: 0, RED: 0, BLOCKED: 0, UNKNOWN: 0 });
}

function internal(status = "GREEN") {
  return result({
    id: "QE-UNIT-001",
    area: "quality-engine",
    name: "Internal qualification",
    status,
    critical: true,
    summary: `Internal ${status}`
  });
}

function external({ id = "BALISE-010-LIVE", status = "GREEN", critical = true, findingType = null } = {}) {
  return result({
    id,
    area: "tursatt-balise",
    name: "External validation",
    status,
    critical,
    summary: `External ${status}`,
    details: findingType ? { findingType } : {}
  });
}

function provenance(status = "BLOCKED") {
  return result({
    id: "PROV-005",
    area: "data-provenance",
    name: "Git and deployment attestation",
    status,
    critical: true,
    summary: `Provenance ${status}`
  });
}

function report(results) {
  const summary = summarize(results);
  const ids = results.map((item) => item.id);
  return {
    schemaVersion: "1.0.0",
    runId: "ci-policy-unit",
    generatedAt: "2026-08-01T00:00:00Z",
    suite: "ci",
    git: { commit: COMMIT, branch: "detached", baseline: COMMIT, originMain: COMMIT, clean: true, changedFiles: [] },
    results,
    summary,
    accounting: {
      testCases: { total: ids.length, unique: new Set(ids).size, ids },
      assertions: { total: ids.length, unique: new Set(ids).size, statusCounts: countsFor(results) }
    },
    productionSafety: { allowedMethods: ["GET", "HEAD"], guardVerified: true, ledger: [] }
  };
}

function evaluate(results, runnerExitCode = 0, extra = {}) {
  return evaluateCiPolicy({ report: report(results), expectedCommit: COMMIT, runnerExitCode, ...extra });
}

test("critical external BLOCKED is external HOLD without confirmed product defect", () => {
  const observed = evaluate([internal(), external({ status: "BLOCKED" })], 1);
  const markdown = renderCiSummary(observed, report([internal(), external({ status: "BLOCKED" })]));
  assert.equal(observed.qualityEngineQualification, "GREEN");
  assert.equal(observed.externalValidation, "HOLD");
  assert.equal(observed.confirmedProductDefect, false);
  assert.equal(observed.workflowDecision, "QUALITY_ENGINE_SUCCESS_EXTERNAL_HOLD");
  assert.equal(observed.workflowConclusion, "SUCCESS");
  assert.match(markdown, /QUALITY ENGINE: GREEN/);
  assert.match(markdown, /SDE VALIDATION: HOLD/);
  assert.match(markdown, /HOLD DOES NOT MEAN CONFIRMED PRODUCT DEFECT/);
});

test("missing deployment provenance is external HOLD and not an internal QE regression", () => {
  const observed = evaluate([internal(), provenance("BLOCKED")], 1);
  assert.equal(observed.qualityEngineQualification, "GREEN");
  assert.equal(observed.externalValidation, "HOLD");
  assert.equal(observed.infrastructureIntegrity, "GREEN");
  assert.equal(observed.confirmedProductDefect, false);
  assert.equal(observed.workflowConclusion, "SUCCESS");
});

test("internal RED is a workflow failure", () => {
  const observed = evaluate([internal("RED"), external()], 1);
  assert.equal(observed.qualityEngineQualification, "FAILURE");
  assert.equal(observed.workflowDecision, "FAILURE");
  assert.equal(observed.primaryFailureReason, "INTERNAL_QUALITY_ENGINE_FAILURE");
});

test("external critical confirmed defect is NO-GO and workflow failure", () => {
  const observed = evaluate([internal(), external({ status: "RED", findingType: "CONFIRMED_DEFECT" })], 1);
  assert.equal(observed.externalValidation, "NO-GO");
  assert.equal(observed.confirmedDefects, 1);
  assert.equal(observed.workflowDecision, "FAILURE");
  assert.equal(observed.primaryFailureReason, "EXTERNAL_CONFIRMED_CRITICAL_RED");
});

test("missing report is an infrastructure failure", () => {
  const observed = evaluateCiPolicy({ report: null, expectedCommit: COMMIT, runnerExitCode: 2 });
  assert.equal(observed.infrastructureIntegrity, "FAILURE");
  assert.equal(observed.workflowDecision, "FAILURE");
});

test("invalid or contradictory report is an infrastructure failure", () => {
  const invalid = report([internal(), external()]);
  invalid.summary.total += 1;
  const observed = evaluateCiPolicy({ report: invalid, expectedCommit: COMMIT, runnerExitCode: 0 });
  assert.equal(observed.infrastructureIntegrity, "FAILURE");
  assert.ok(observed.errors.includes("SUMMARY_TOTAL_MISMATCH"));
});

test("only external AMBER gives internal GREEN and GO MED AVVIK", () => {
  const observed = evaluate([internal(), external({ status: "AMBER", critical: false })]);
  assert.equal(observed.qualityEngineQualification, "GREEN");
  assert.equal(observed.externalValidation, "GO MED AVVIK");
  assert.equal(observed.workflowConclusion, "SUCCESS");
});

test("non-critical external BLOCKED gives GO MED AVVIK", () => {
  const observed = evaluate([internal(), external({ status: "BLOCKED", critical: false })]);
  assert.equal(observed.qualityEngineQualification, "GREEN");
  assert.equal(observed.externalValidation, "GO MED AVVIK");
  assert.equal(observed.workflowConclusion, "SUCCESS");
});

test("internal RED has primary priority over simultaneous external HOLD", () => {
  const observed = evaluate([internal("RED"), external({ status: "BLOCKED" })], 1);
  assert.equal(observed.externalValidation, "HOLD");
  assert.equal(observed.primaryFailureReason, "INTERNAL_QUALITY_ENGINE_FAILURE");
});

test("runner exit 1 with a valid external HOLD report is EXPECTED_HOLD_EXIT", () => {
  const observed = evaluate([internal(), external({ status: "BLOCKED" })], 1);
  assert.equal(observed.runnerDisposition, "EXPECTED_HOLD_EXIT");
  assert.equal(observed.infrastructureIntegrity, "GREEN");
});

test("runner exit 0 with internal RED fails because exit code and report disagree", () => {
  const observed = evaluate([internal("RED"), external()], 0);
  assert.equal(observed.workflowDecision, "FAILURE");
  assert.equal(observed.infrastructureIntegrity, "FAILURE");
  assert.equal(observed.primaryFailureReason, "EXIT_CODE_AND_REPORT_DISAGREE");
});

test("wrong commit identity fails closed", () => {
  const observed = evaluateCiPolicy({
    report: report([internal(), external()]),
    expectedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runnerExitCode: 0
  });
  assert.equal(observed.infrastructureIntegrity, "FAILURE");
  assert.ok(observed.errors.includes("REPORT_COMMIT_MISMATCH"));
});

test("runner crash exit is infrastructure failure even with a valid report", () => {
  const observed = evaluate([internal(), external()], 2);
  assert.equal(observed.infrastructureIntegrity, "FAILURE");
  assert.equal(observed.runnerDisposition, "RUNNER_CRASH_OR_UNSUPPORTED_EXIT");
});

test("failed upstream permanent regression firewall is internal failure", () => {
  const observed = evaluate([internal(), external()], 1, { upstreamQualificationOutcome: "failure" });
  assert.equal(observed.qualityEngineQualification, "FAILURE");
  assert.equal(observed.primaryFailureReason, "INTERNAL_QUALITY_ENGINE_FAILURE");
});

test("workflow captures runner evidence, validates semantics, and always uploads bound artifacts", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../../.github/workflows/sde-regression-firewall.yml"),
    "utf8"
  );
  assert.match(workflow, /id: permanent_regression/);
  assert.match(workflow, /id: quality_engine\n\s+if: always\(\)/);
  assert.match(workflow, /npm run test:sde:qe:ci/);
  assert.match(workflow, /echo "exit_code=\$\{runner_exit\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /id: quality_engine_policy\n\s+if: always\(\)/);
  assert.match(workflow, /node tests\/sde-quality-engine\/ci-policy\.cjs/);
  assert.match(workflow, /--runner-exit "\$\{\{ steps\.quality_engine\.outputs\.exit_code \}\}"/);
  assert.match(workflow, /--expected-commit "\$\{\{ github\.sha \}\}"/);
  assert.match(workflow, /--upstream-qualification "\$\{\{ steps\.permanent_regression\.outcome \}\}"/);
  assert.match(workflow, /latest\.github-summary\.md/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /id: quality_engine_reports\n\s+if: always\(\)/);
  assert.match(workflow, /name: sde-quality-engine-reports-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /if-no-files-found: error/);
});
