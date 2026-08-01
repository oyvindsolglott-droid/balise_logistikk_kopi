"use strict";

const crypto = require("node:crypto");

const PRIMARY_CLASSIFICATIONS = Object.freeze([
  "CONFIRMED_DEFECT",
  "PROBABLE_DEFECT",
  "POSSIBLE_FALSE_POSITIVE",
  "EXPECTED_DIFFERENCE",
  "AUTHORIZED_OVERRIDE",
  "CONTRACT_AMBIGUITY",
  "TEST_ORACLE_DEFECT",
  "BLOCKED",
  "UNKNOWN"
]);

const DIAGNOSTIC_LABELS = Object.freeze([
  "SNAPSHOT_TIME_MISMATCH",
  "INSUFFICIENT_SNAPSHOT_PROVENANCE",
  "UNAUTHORIZED_DIFFERENCE",
  "EXPECTED_SNAPSHOT_DRIFT",
  "SOURCE_CHANGED_AFTER_GENERATION",
  "CANDIDATE_AND_PUBLISHED_DUPLICATE",
  "EXPECTED_DIFFERENCE"
]);

const CONTRACT_AUTHORITY_TYPES = Object.freeze([
  "NORMATIVE_OPERATIONAL_RULE",
  "APPROVED_TECHNICAL_SLA",
  "TECHNICAL_SCHEDULE_DERIVED",
  "TEST_ASSUMPTION",
  "HEURISTIC",
  "UNKNOWN"
]);

const PIPELINE_FINDING_TYPES = Object.freeze([
  "SDE_PRODUCT_DEFECT",
  "DATA_GENERATION_DEFECT",
  "EXPECTED_RUN_MISSING",
  "RUN_FAILED",
  "PUBLICATION_DELAY",
  "SCHEDULE_EXECUTION_DELAY",
  "CONTRACT_AMBIGUITY",
  "OBSERVABILITY_GAP"
]);

function isoMillis(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAuthority(authority = null) {
  const type = CONTRACT_AUTHORITY_TYPES.includes(authority?.type) ? authority.type : "UNKNOWN";
  return {
    type,
    normative: authority?.normative === true,
    source: authority?.source || null,
    approvedBy: authority?.approvedBy || null,
    approvedAt: authority?.approvedAt || null
  };
}

function evaluateComparisonEligibility(input = {}) {
  const sourceObservedAt = input.sourceObservedAt || null;
  const sourceHash = input.sourceHash || null;
  const datasetGeneratedAt = input.datasetGeneratedAt || null;
  const datasetSourceObservedAt = input.datasetSourceObservedAt || null;
  const datasetSourceHash = input.datasetSourceHash || null;
  const sourceMs = isoMillis(sourceObservedAt);
  const datasetSourceMs = isoMillis(datasetSourceObservedAt);
  const timeDeltaSeconds = sourceMs == null || datasetSourceMs == null
    ? null
    : Math.abs(sourceMs - datasetSourceMs) / 1000;
  const sameOperationalDate = input.sourceOperationalDate == null || input.datasetOperationalDate == null
    ? null
    : String(input.sourceOperationalDate) === String(input.datasetOperationalDate);
  const sameOccurrenceModel = input.sourceOccurrenceModel == null || input.datasetOccurrenceModel == null
    ? null
    : String(input.sourceOccurrenceModel) === String(input.datasetOccurrenceModel);
  const maxDeltaSeconds = Number.isFinite(input.maxTimeDeltaSeconds) ? input.maxTimeDeltaSeconds : 300;
  const generationBound = [
    input.sourceGenerationId,
    input.datasetGenerationId,
    input.datasetHash,
    input.publishedDatasetHash
  ].some((value) => value != null);
  const missingProvenance = [];
  if (sourceMs == null) missingProvenance.push("sourceObservedAt");
  if (!sourceHash) missingProvenance.push("sourceHash");
  if (isoMillis(datasetGeneratedAt) == null) missingProvenance.push("datasetGeneratedAt");
  if (datasetSourceMs == null) missingProvenance.push("datasetSourceObservedAt");
  if (!datasetSourceHash) missingProvenance.push("datasetSourceHash");
  if (generationBound) {
    if (!input.sourceGenerationId) missingProvenance.push("sourceGenerationId");
    if (!input.datasetGenerationId) missingProvenance.push("datasetGenerationId");
    if (!input.datasetHash) missingProvenance.push("datasetHash");
    if (!input.publishedDatasetHash) missingProvenance.push("publishedDatasetHash");
  }

  let eligible = true;
  let reason = "COMPARABLE_SNAPSHOT";
  const diagnosticLabels = [];
  if (missingProvenance.length) {
    eligible = false;
    reason = "INSUFFICIENT_SNAPSHOT_PROVENANCE";
    diagnosticLabels.push("INSUFFICIENT_SNAPSHOT_PROVENANCE", "SNAPSHOT_TIME_MISMATCH");
  } else if (generationBound && input.sourceGenerationId !== input.datasetGenerationId) {
    eligible = false;
    reason = "CONFLICTING_GENERATION_IDS";
    diagnosticLabels.push("INSUFFICIENT_SNAPSHOT_PROVENANCE");
  } else if (generationBound && input.datasetHash !== input.publishedDatasetHash) {
    eligible = false;
    reason = "PUBLISHED_DATASET_HASH_MISMATCH";
    diagnosticLabels.push("UNAUTHORIZED_DIFFERENCE");
  } else if (sourceHash !== datasetSourceHash) {
    eligible = false;
    reason = "SOURCE_CHANGED_AFTER_GENERATION";
    diagnosticLabels.push("SOURCE_CHANGED_AFTER_GENERATION", "SNAPSHOT_TIME_MISMATCH");
  } else if (timeDeltaSeconds > maxDeltaSeconds) {
    eligible = false;
    reason = "SNAPSHOT_TIME_MISMATCH";
    diagnosticLabels.push("SNAPSHOT_TIME_MISMATCH", "EXPECTED_SNAPSHOT_DRIFT");
  } else if (sameOperationalDate !== true || sameOccurrenceModel !== true) {
    eligible = false;
    reason = "SNAPSHOT_IDENTITY_MISMATCH";
    diagnosticLabels.push("SNAPSHOT_TIME_MISMATCH");
  }

  return {
    eligible,
    reason,
    sourceObservedAt,
    sourceHash,
    datasetGeneratedAt,
    datasetSourceObservedAt,
    datasetSourceHash,
    sourceGenerationId: input.sourceGenerationId || null,
    datasetGenerationId: input.datasetGenerationId || null,
    datasetHash: input.datasetHash || null,
    publishedDatasetHash: input.publishedDatasetHash || null,
    timeDeltaSeconds,
    sameOperationalDate,
    sameOccurrenceModel,
    confidence: eligible ? "HIGH" : "HIGH",
    availableProvenance: [
      sourceObservedAt && "sourceObservedAt",
      sourceHash && "sourceHash",
      datasetGeneratedAt && "datasetGeneratedAt",
      datasetSourceObservedAt && "datasetSourceObservedAt",
      datasetSourceHash && "datasetSourceHash",
      input.sourceGenerationId && "sourceGenerationId",
      input.datasetGenerationId && "datasetGenerationId",
      input.datasetHash && "datasetHash",
      input.publishedDatasetHash && "publishedDatasetHash"
    ].filter(Boolean),
    missingProvenance,
    diagnosticLabels: [...new Set(diagnosticLabels)]
  };
}

function requirement(status, evidence) {
  return { status, evidence };
}

function evaluateDefectEvidence({ eligibility, authority, oracleAvailable = true, authorizedOverride = false, alternativesExcluded = false, reproducible = false, independentExpectation = false, evidencePointsToSut = false } = {}) {
  const normalizedAuthority = normalizeAuthority(authority);
  const probable = {
    normativeContract: requirement(normalizedAuthority.normative ? "PASS" : normalizedAuthority.type === "UNKNOWN" ? "UNKNOWN" : "FAIL", normalizedAuthority.type),
    temporalQualification: requirement(eligibility?.eligible ? "PASS" : "FAIL", eligibility?.reason || "UNKNOWN"),
    sourceDatasetIdentity: requirement(eligibility?.sourceHash && eligibility?.sourceHash === eligibility?.datasetSourceHash ? "PASS" : "UNKNOWN", eligibility?.sourceHash || "missing source hash"),
    snapshotDriftExcluded: requirement(eligibility?.eligible ? "PASS" : "UNKNOWN", eligibility?.reason || "UNKNOWN"),
    authorizedOverrideExcluded: requirement(authorizedOverride ? "FAIL" : "PASS", authorizedOverride ? "authorized override exists" : "no matching override"),
    oracleAvailable: requirement(oracleAvailable ? "PASS" : "FAIL", oracleAvailable ? "field is represented" : "field is absent from oracle contract"),
    noMorePreciseBlocker: requirement(eligibility?.eligible && normalizedAuthority.normative ? "PASS" : "FAIL", eligibility?.eligible ? normalizedAuthority.type : eligibility?.reason || "UNKNOWN"),
    evidencePointsToSut: requirement(evidencePointsToSut ? "PASS" : "UNKNOWN", evidencePointsToSut ? "candidate and published reproduce the deviation" : "causality not isolated")
  };
  const confirmed = {
    ...probable,
    exactIdentity: requirement(eligibility?.sameOperationalDate === true && eligibility?.sameOccurrenceModel === true ? "PASS" : "FAIL", "operational date and occurrence model"),
    reproducible: requirement(reproducible ? "PASS" : "UNKNOWN", reproducible ? "independently reproduced" : "not independently reproduced"),
    independentExpectation: requirement(independentExpectation ? "PASS" : "UNKNOWN", independentExpectation ? "independent expectation exists" : "no independent expectation"),
    realisticAlternativesExcluded: requirement(alternativesExcluded ? "PASS" : "UNKNOWN", alternativesExcluded ? "alternatives excluded" : "snapshot alternatives remain")
  };
  return {
    probable,
    confirmed,
    probableEligible: Object.values(probable).every((item) => item.status === "PASS"),
    confirmedEligible: Object.values(confirmed).every((item) => item.status === "PASS")
  };
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function classifyPipelineExecution(input = {}) {
  const authority = normalizeAuthority(input.contractAuthority);
  let pipelineFindingType = "OBSERVABILITY_GAP";
  if (input.expectedRun === true && input.workflowStarted === true && input.generatorExecuted === false && input.dataCommitCreated === false) {
    pipelineFindingType = "EXPECTED_RUN_MISSING";
  } else if (input.workflowConclusion === "failure") {
    pipelineFindingType = "RUN_FAILED";
  } else if (input.dataCommitCreated === true && input.deploymentCompleted === false) {
    pipelineFindingType = "PUBLICATION_DELAY";
  } else if (input.workflowStarted === false && input.expectedRun === true) {
    pipelineFindingType = "SCHEDULE_EXECUTION_DELAY";
  }
  return {
    pipelineFindingType,
    primaryClassification: authority.normative ? "BLOCKED" : "CONTRACT_AMBIGUITY",
    diagnosticLabels: pipelineFindingType === "EXPECTED_RUN_MISSING" ? ["EXPECTED_SNAPSHOT_DRIFT"] : [],
    contractAuthority: authority,
    publicationDelayEligible: input.dataCommitCreated === true,
    evidence: {
      expectedRun: input.expectedRun ?? null,
      scheduledCycleHour: input.scheduledCycleHour ?? null,
      actualWorkflowStart: input.actualWorkflowStart || null,
      generatorExecuted: input.generatorExecuted ?? null,
      generatorSkipReason: input.generatorSkipReason || null,
      workflowConclusion: input.workflowConclusion || null,
      dataCommitCreated: input.dataCommitCreated ?? null,
      deploymentCompleted: input.deploymentCompleted ?? null
    }
  };
}

module.exports = {
  CONTRACT_AUTHORITY_TYPES,
  DIAGNOSTIC_LABELS,
  PIPELINE_FINDING_TYPES,
  PRIMARY_CLASSIFICATIONS,
  classifyPipelineExecution,
  evaluateComparisonEligibility,
  evaluateDefectEvidence,
  normalizeAuthority,
  stableHash
};
