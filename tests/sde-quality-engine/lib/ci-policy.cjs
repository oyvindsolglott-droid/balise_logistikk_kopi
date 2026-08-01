"use strict";

const { STATUSES, summarize } = require("./core.cjs");

const INTERNAL_RESULT_PREFIXES = Object.freeze([
  "QE-CORE-",
  "QE-INVENTORY-",
  "QE-PYTHON-",
  "QE-REGRESSION-",
  "QE-REPORT-",
  "QE-SAFE-",
  "QE-SERVER-",
  "QE-STRICT-",
  "QE-UNIT-"
]);

const EXTERNAL_DECISIONS = Object.freeze({
  GREEN: "GREEN",
  DEVIATION: "GO MED AVVIK",
  HOLD: "HOLD",
  NO_GO: "NO-GO"
});

function countsFor(results) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of results) counts[item.status] += 1;
  return counts;
}

function sameCounts(left, right) {
  return STATUSES.every((status) => Number(left?.[status]) === Number(right?.[status]));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInternalQualificationResult(item) {
  const id = String(item?.id || "");
  if (id.startsWith("PROD-")) return false;
  return item?.area === "quality-engine"
    || item?.area === "regression"
    || INTERNAL_RESULT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function validateReport(report, expectedCommit) {
  const errors = [];
  if (!isObject(report)) return { valid: false, errors: ["REPORT_MISSING_OR_NOT_OBJECT"] };
  if (report.schemaVersion !== "1.0.0") errors.push("UNSUPPORTED_REPORT_SCHEMA");
  if (typeof report.runId !== "string" || !report.runId) errors.push("RUN_ID_MISSING");
  if (typeof report.suite !== "string" || !report.suite) errors.push("SUITE_MISSING");
  if (!isObject(report.git) || typeof report.git.commit !== "string") errors.push("GIT_IDENTITY_MISSING");
  if (expectedCommit && report.git?.commit !== expectedCommit) errors.push("REPORT_COMMIT_MISMATCH");
  if (!Array.isArray(report.results) || report.results.length === 0) {
    errors.push("RESULTS_MISSING");
    return { valid: false, errors };
  }

  const ids = [];
  for (const item of report.results) {
    if (!isObject(item)) {
      errors.push("RESULT_NOT_OBJECT");
      continue;
    }
    if (typeof item.id !== "string" || !item.id) errors.push("RESULT_ID_MISSING");
    else ids.push(item.id);
    if (typeof item.area !== "string" || !item.area) errors.push(`RESULT_AREA_MISSING:${item.id || "unknown"}`);
    if (!STATUSES.includes(item.status)) errors.push(`RESULT_STATUS_INVALID:${item.id || "unknown"}`);
    if (typeof item.critical !== "boolean") errors.push(`RESULT_CRITICAL_INVALID:${item.id || "unknown"}`);
    if (typeof item.summary !== "string" || !item.summary) errors.push(`RESULT_SUMMARY_MISSING:${item.id || "unknown"}`);
  }
  if (new Set(ids).size !== ids.length) errors.push("DUPLICATE_RESULT_IDS");

  const calculated = summarize(report.results);
  if (!isObject(report.summary)) errors.push("SUMMARY_MISSING");
  else {
    if (report.summary.total !== calculated.total) errors.push("SUMMARY_TOTAL_MISMATCH");
    if (!sameCounts(report.summary.counts, calculated.counts)) errors.push("SUMMARY_COUNTS_MISMATCH");
    if (report.summary.criticalRed !== calculated.criticalRed) errors.push("SUMMARY_CRITICAL_RED_MISMATCH");
    if (report.summary.criticalUnproven !== calculated.criticalUnproven) errors.push("SUMMARY_CRITICAL_UNPROVEN_MISMATCH");
    if (report.summary.classification !== calculated.classification) errors.push("SUMMARY_CLASSIFICATION_MISMATCH");
  }

  const accounting = report.accounting;
  if (!isObject(accounting)) errors.push("ACCOUNTING_MISSING");
  else {
    if (accounting.testCases?.total !== ids.length) errors.push("ACCOUNTING_TEST_TOTAL_MISMATCH");
    if (accounting.testCases?.unique !== new Set(ids).size) errors.push("ACCOUNTING_TEST_UNIQUE_MISMATCH");
    if (!Array.isArray(accounting.testCases?.ids)
      || accounting.testCases.ids.length !== ids.length
      || accounting.testCases.ids.some((id, index) => id !== ids[index])) {
      errors.push("ACCOUNTING_TEST_IDS_MISMATCH");
    }
    if (accounting.assertions?.total !== ids.length) errors.push("ACCOUNTING_ASSERTION_TOTAL_MISMATCH");
    if (accounting.assertions?.unique !== new Set(ids).size) errors.push("ACCOUNTING_ASSERTION_UNIQUE_MISMATCH");
    if (!sameCounts(accounting.assertions?.statusCounts, countsFor(report.results))) {
      errors.push("ACCOUNTING_ASSERTION_COUNTS_MISMATCH");
    }
  }

  if (!isObject(report.productionSafety)) errors.push("PRODUCTION_SAFETY_MISSING");
  else {
    const methods = Array.isArray(report.productionSafety.allowedMethods)
      ? [...report.productionSafety.allowedMethods].sort()
      : [];
    if (methods.join(",") !== "GET,HEAD") errors.push("PRODUCTION_METHOD_ALLOWLIST_INVALID");
    if (report.productionSafety.guardVerified !== true) errors.push("PRODUCTION_GUARD_NOT_VERIFIED");
    if (!Array.isArray(report.productionSafety.ledger)) errors.push("PRODUCTION_LEDGER_INVALID");
    else if (report.productionSafety.ledger.some((entry) => !["GET", "HEAD"].includes(String(entry?.method || "").toUpperCase()))) {
      errors.push("PRODUCTION_WRITE_OBSERVED");
    }
  }

  return { valid: errors.length === 0, errors };
}

function findingCounts(result) {
  const counts = { CONFIRMED_DEFECT: 0, PROBABLE_DEFECT: 0 };
  const details = isObject(result?.details) ? result.details : {};
  const candidates = [
    details.findingTypeCounts,
    details.threeWay?.findingTypeCounts,
    details.live?.threeWay?.findingTypeCounts
  ].filter(isObject);
  for (const candidate of candidates) {
    counts.CONFIRMED_DEFECT += Number(candidate.CONFIRMED_DEFECT || 0);
    counts.PROBABLE_DEFECT += Number(candidate.PROBABLE_DEFECT || 0);
  }
  if (details.findingType === "CONFIRMED_DEFECT") counts.CONFIRMED_DEFECT += 1;
  if (details.findingType === "PROBABLE_DEFECT") counts.PROBABLE_DEFECT += 1;
  return counts;
}

function scopedExternalStatus(results, predicate) {
  const scoped = results.filter(predicate);
  if (!scoped.length) return "NOT EVALUATED";
  if (scoped.some((item) => item.critical && item.status === "RED")) return "NO-GO";
  if (scoped.some((item) => item.critical && ["BLOCKED", "UNKNOWN"].includes(item.status))) return "HOLD";
  if (scoped.some((item) => item.status !== "GREEN")) return "GO MED AVVIK";
  return "GREEN";
}

function infrastructureFailure(errors, runnerExitCode = null) {
  return {
    policySchemaVersion: "1.0.0",
    qualityEngineQualification: "UNKNOWN",
    externalValidation: "UNKNOWN",
    infrastructureIntegrity: "FAILURE",
    workflowDecision: "FAILURE",
    workflowConclusion: "FAILURE",
    primaryFailureReason: errors.includes("EXIT_CODE_AND_REPORT_DISAGREE")
      ? "EXIT_CODE_AND_REPORT_DISAGREE"
      : "WORKFLOW_INFRASTRUCTURE_FAILURE",
    runnerExitCode,
    runnerDisposition: "INFRASTRUCTURE_FAILURE",
    confirmedDefects: 0,
    probableDefects: 0,
    criticalRed: 0,
    criticalBlocked: 0,
    confirmedProductDefect: false,
    baliseParity: "NOT EVALUATED",
    productionReadonly: "NOT EVALUATED",
    internalNonGreen: [],
    externalNonGreen: [],
    errors
  };
}

function evaluateCiPolicy({
  report,
  expectedCommit,
  runnerExitCode,
  upstreamQualificationOutcome = "success",
  reportLoadError = null
} = {}) {
  if (reportLoadError) return infrastructureFailure([`REPORT_LOAD_FAILED:${reportLoadError}`], runnerExitCode);
  const validation = validateReport(report, expectedCommit);
  if (!validation.valid) return infrastructureFailure(validation.errors, runnerExitCode);

  const internal = report.results.filter(isInternalQualificationResult);
  const external = report.results.filter((item) => !isInternalQualificationResult(item));
  const internalNonGreen = internal.filter((item) => item.status !== "GREEN");
  const externalNonGreen = external.filter((item) => item.status !== "GREEN");
  const upstreamKnown = ["success", "failure"].includes(upstreamQualificationOutcome);
  if (!upstreamKnown) {
    return infrastructureFailure([`UPSTREAM_QUALIFICATION_OUTCOME_INVALID:${upstreamQualificationOutcome}`], runnerExitCode);
  }

  const qualityEngineQualification = internalNonGreen.length === 0 && upstreamQualificationOutcome === "success"
    ? "GREEN"
    : "FAILURE";
  const criticalRed = external.filter((item) => item.critical && item.status === "RED").length;
  const criticalBlocked = external.filter((item) => item.critical && ["BLOCKED", "UNKNOWN"].includes(item.status)).length;
  const findings = external.reduce((totals, item) => {
    const counts = findingCounts(item);
    totals.CONFIRMED_DEFECT += counts.CONFIRMED_DEFECT;
    totals.PROBABLE_DEFECT += counts.PROBABLE_DEFECT;
    return totals;
  }, { CONFIRMED_DEFECT: 0, PROBABLE_DEFECT: 0 });

  let externalValidation = EXTERNAL_DECISIONS.GREEN;
  if (findings.CONFIRMED_DEFECT > 0 || criticalRed > 0) externalValidation = EXTERNAL_DECISIONS.NO_GO;
  else if (criticalBlocked > 0) externalValidation = EXTERNAL_DECISIONS.HOLD;
  else if (externalNonGreen.length > 0) externalValidation = EXTERNAL_DECISIONS.DEVIATION;

  const semanticFailure = qualityEngineQualification === "FAILURE"
    || externalValidation === EXTERNAL_DECISIONS.NO_GO;
  let infrastructureIntegrity = "GREEN";
  let runnerDisposition = "MATCHED_SUCCESS_EXIT";
  const policyErrors = [];
  if (!Number.isInteger(runnerExitCode) || runnerExitCode < 0) {
    infrastructureIntegrity = "FAILURE";
    runnerDisposition = "RUNNER_EXIT_INVALID";
    policyErrors.push("RUNNER_EXIT_INVALID");
  } else if (runnerExitCode === 0 && semanticFailure) {
    infrastructureIntegrity = "FAILURE";
    runnerDisposition = "EXIT_CODE_AND_REPORT_DISAGREE";
    policyErrors.push("EXIT_CODE_AND_REPORT_DISAGREE");
  } else if (runnerExitCode === 1 && !semanticFailure && externalValidation === EXTERNAL_DECISIONS.HOLD) {
    runnerDisposition = "EXPECTED_HOLD_EXIT";
  } else if (runnerExitCode === 1 && semanticFailure) {
    runnerDisposition = "EXPECTED_FAILURE_EXIT";
  } else if (runnerExitCode !== 0) {
    infrastructureIntegrity = "FAILURE";
    runnerDisposition = runnerExitCode > 1 ? "RUNNER_CRASH_OR_UNSUPPORTED_EXIT" : "EXIT_CODE_AND_REPORT_DISAGREE";
    policyErrors.push(runnerDisposition);
  }

  if (infrastructureIntegrity === "FAILURE") {
    const failed = infrastructureFailure(policyErrors, runnerExitCode);
    return {
      ...failed,
      qualityEngineQualification,
      externalValidation,
      runnerDisposition,
      confirmedDefects: findings.CONFIRMED_DEFECT,
      probableDefects: findings.PROBABLE_DEFECT,
      criticalRed,
      criticalBlocked,
      confirmedProductDefect: findings.CONFIRMED_DEFECT > 0,
      internalNonGreen: internalNonGreen.map((item) => item.id),
      externalNonGreen: externalNonGreen.map((item) => item.id),
      baliseParity: scopedExternalStatus(external, (item) => item.area === "tursatt-balise"),
      productionReadonly: scopedExternalStatus(external, (item) => item.area === "production-readonly" || item.id.startsWith("PROD-"))
    };
  }

  let workflowDecision = "QUALITY_ENGINE_SUCCESS";
  let workflowConclusion = "SUCCESS";
  let primaryFailureReason = null;
  if (qualityEngineQualification === "FAILURE") {
    workflowDecision = "FAILURE";
    workflowConclusion = "FAILURE";
    primaryFailureReason = "INTERNAL_QUALITY_ENGINE_FAILURE";
  } else if (externalValidation === EXTERNAL_DECISIONS.NO_GO) {
    workflowDecision = "FAILURE";
    workflowConclusion = "FAILURE";
    primaryFailureReason = "EXTERNAL_CONFIRMED_CRITICAL_RED";
  } else if (externalValidation === EXTERNAL_DECISIONS.HOLD) {
    workflowDecision = "QUALITY_ENGINE_SUCCESS_EXTERNAL_HOLD";
  } else if (externalValidation === EXTERNAL_DECISIONS.DEVIATION) {
    workflowDecision = "QUALITY_ENGINE_SUCCESS_WITH_DEVIATION";
  }

  return {
    policySchemaVersion: "1.0.0",
    qualityEngineQualification,
    externalValidation,
    infrastructureIntegrity,
    workflowDecision,
    workflowConclusion,
    primaryFailureReason,
    runnerExitCode,
    runnerDisposition,
    confirmedDefects: findings.CONFIRMED_DEFECT,
    probableDefects: findings.PROBABLE_DEFECT,
    criticalRed,
    criticalBlocked,
    confirmedProductDefect: findings.CONFIRMED_DEFECT > 0,
    baliseParity: scopedExternalStatus(external, (item) => item.area === "tursatt-balise"),
    productionReadonly: scopedExternalStatus(external, (item) => item.area === "production-readonly" || item.id.startsWith("PROD-")),
    internalNonGreen: internalNonGreen.map((item) => item.id),
    externalNonGreen: externalNonGreen.map((item) => item.id),
    errors: []
  };
}

function renderCiSummary(decision, report = null) {
  const lines = [
    "## SDE Quality Engine CI decision",
    "",
    `**QUALITY ENGINE: ${decision.qualityEngineQualification}**  `,
    `**SDE VALIDATION: ${decision.externalValidation}**  `,
    `**BALISE PARITY: ${decision.baliseParity}**  `,
    `**PRODUCTION-READONLY: ${decision.productionReadonly}**  `,
    `**INFRASTRUCTURE: ${decision.infrastructureIntegrity}**`,
    "",
    `- Workflow decision: \`${decision.workflowDecision}\``,
    `- Workflow conclusion: \`${decision.workflowConclusion}\``,
    `- Runner exit: \`${decision.runnerExitCode == null ? "missing" : decision.runnerExitCode}\` (\`${decision.runnerDisposition}\`)`,
    `- CONFIRMED DEFECTS: ${decision.confirmedDefects}`,
    `- PROBABLE DEFECTS: ${decision.probableDefects}`,
    `- CRITICAL RED: ${decision.criticalRed}`,
    `- CRITICAL BLOCKED: ${decision.criticalBlocked}`,
    `- Report commit: \`${report?.git?.commit || "unavailable"}\``,
    ""
  ];
  if (decision.externalValidation === "HOLD") {
    lines.push("**HOLD DOES NOT MEAN CONFIRMED PRODUCT DEFECT.**", "");
  }
  if (decision.errors.length) {
    lines.push("### Policy errors", "", ...decision.errors.map((error) => `- \`${error}\``), "");
  }
  lines.push("The original SDE Quality Engine report remains authoritative evidence and is not overwritten.");
  return `${lines.join("\n")}\n`;
}

module.exports = {
  EXTERNAL_DECISIONS,
  evaluateCiPolicy,
  isInternalQualificationResult,
  renderCiSummary,
  validateReport
};
