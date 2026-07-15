"use strict";

const crypto = require("node:crypto");

const STRICT_TOTAL = 45;
const DETERMINISM_RUNS = 3;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseLastReport(stdout) {
  const line = String(stdout || "").trim().split(/\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("missing JSON report");
  return JSON.parse(line);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function normalizedStrictReport(report) {
  return {
    schemaVersion: report?.schemaVersion,
    mode: report?.mode,
    indexSha256: report?.indexSha256,
    counts: {
      total: report?.counts?.total,
      pass: report?.counts?.pass,
      fail: report?.counts?.fail,
    },
    failIds: Array.isArray(report?.failIds) ? [...report.failIds].sort() : report?.failIds,
    results: Array.isArray(report?.results)
      ? report.results.map(item => ({id: item?.id, status: item?.status, detail: item?.detail})).sort((left, right) => String(left.id).localeCompare(String(right.id)))
      : report?.results,
  };
}

function validateStrictReport(report) {
  const errors = [];
  if (report?.schemaVersion !== "sde-strict-report-v1") errors.push("unexpected strict schemaVersion");
  if (report?.mode !== "strict") errors.push("unexpected strict mode");
  if (typeof report?.indexSha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.indexSha256)) errors.push("invalid indexSha256");
  if (report?.counts?.total !== STRICT_TOTAL) errors.push(`strict total must be ${STRICT_TOTAL}`);
  if (report?.counts?.pass !== STRICT_TOTAL) errors.push(`strict pass must be ${STRICT_TOTAL}`);
  if (report?.counts?.fail !== 0) errors.push("strict fail must be 0");
  if (!Array.isArray(report?.failIds)) {
    errors.push("strict failIds must be an array");
  } else {
    if (report.failIds.length !== 0) errors.push("strict failIds must be empty");
    if (!unique(report.failIds)) errors.push("strict failIds must be unique");
  }
  if (!Array.isArray(report?.results)) {
    errors.push("strict results must be an array");
  } else {
    const ids = report.results.map(item => item?.id);
    const failures = report.results.filter(item => item?.status === "FAIL").map(item => item.id).sort();
    if (report.results.length !== STRICT_TOTAL) errors.push(`strict results must contain ${STRICT_TOTAL} entries`);
    if (ids.some(id => typeof id !== "string" || !id)) errors.push("strict result IDs must be non-empty strings");
    if (!unique(ids)) errors.push("strict result IDs must be unique");
    if (report.results.some(item => item?.status !== "PASS")) errors.push("every strict result must be PASS");
    if (failures.length !== report?.counts?.fail) errors.push("strict fail count does not match result statuses");
    if (Array.isArray(report?.failIds) && canonical(failures) !== canonical([...report.failIds].sort())) errors.push("strict failIds do not match result statuses");
  }
  if ((report?.counts?.pass || 0) + (report?.counts?.fail || 0) !== report?.counts?.total) errors.push("strict counts are inconsistent");
  return {ok: errors.length === 0, errors, normalized: normalizedStrictReport(report)};
}

function normalizedBaselineReport(report) {
  return {
    schemaVersion: report?.schemaVersion,
    mode: report?.mode,
    strictRunCount: report?.strictRunCount,
    strictExitCode: report?.strictExitCode,
    strictExitCodes: report?.strictExitCodes,
    indexSha256: report?.indexSha256,
    counts: report?.counts,
    failIds: report?.failIds,
    strictSemanticSha256: report?.strictSemanticSha256,
    validationErrors: report?.validationErrors,
    status: report?.status,
  };
}

function validateBaselineReport(report) {
  const errors = [];
  if (report?.schemaVersion !== "sde-baseline-audit-report-v2") errors.push("unexpected baseline-audit schemaVersion");
  if (report?.mode !== "baseline-audit") errors.push("unexpected baseline-audit mode");
  if (report?.status !== "PASS") errors.push("baseline-audit status must be PASS");
  if (report?.strictRunCount !== DETERMINISM_RUNS) errors.push(`baseline-audit must run strict ${DETERMINISM_RUNS} times`);
  if (report?.strictExitCode !== 0) errors.push("baseline-audit strictExitCode must be 0");
  if (!Array.isArray(report?.strictExitCodes) || report.strictExitCodes.length !== DETERMINISM_RUNS || report.strictExitCodes.some(code => code !== 0)) errors.push("baseline-audit strictExitCodes must all be 0");
  if (report?.counts?.total !== STRICT_TOTAL || report?.counts?.pass !== STRICT_TOTAL || report?.counts?.fail !== 0) errors.push(`baseline-audit counts must be ${STRICT_TOTAL}/${STRICT_TOTAL}/0`);
  if (!Array.isArray(report?.failIds) || report.failIds.length !== 0) errors.push("baseline-audit failIds must be empty");
  if (!Array.isArray(report?.strictSemanticSha256) || report.strictSemanticSha256.length !== DETERMINISM_RUNS || new Set(report.strictSemanticSha256).size !== 1) errors.push("baseline-audit strict semantics must be deterministic");
  if (!Array.isArray(report?.validationErrors) || report.validationErrors.length !== 0) errors.push("baseline-audit validationErrors must be empty");
  return {ok: errors.length === 0, errors, normalized: normalizedBaselineReport(report)};
}

function assessRuns(runs, {expectedExitCode = 0, validateReport, normalizeReport}) {
  const parsed = [];
  const normalized = [];
  const errors = [];

  runs.forEach((run, index) => {
    if (run?.error) errors.push(`run ${index + 1}: ${run.error.message || run.error}`);
    if (run?.status !== expectedExitCode) errors.push(`run ${index + 1}: expected exit ${expectedExitCode}, got ${run?.status}`);
    if (String(run?.stderr || "").trim()) errors.push(`run ${index + 1}: unexpected stderr`);
    try {
      const report = parseLastReport(run?.stdout);
      const validation = validateReport(report);
      parsed.push(report);
      normalized.push(normalizeReport(report));
      for (const error of validation.errors) errors.push(`run ${index + 1}: ${error}`);
    } catch (error) {
      parsed.push(null);
      normalized.push(null);
      errors.push(`run ${index + 1}: ${error.message}`);
    }
  });

  const hashes = normalized.map(value => value === null ? null : sha256(canonical(value)));
  if (runs.length !== DETERMINISM_RUNS) errors.push(`expected ${DETERMINISM_RUNS} runs, got ${runs.length}`);
  if (hashes.some(hash => hash === null) || new Set(hashes).size !== 1) errors.push("semantic outputs are not identical");
  return {
    ok: errors.length === 0,
    exitCodes: runs.map(run => run?.status ?? null),
    normalizedOutputSha256: hashes,
    errors,
    parsed,
  };
}

module.exports = {
  DETERMINISM_RUNS,
  STRICT_TOTAL,
  assessRuns,
  canonical,
  normalizedBaselineReport,
  normalizedStrictReport,
  sha256,
  validateBaselineReport,
  validateStrictReport,
};
