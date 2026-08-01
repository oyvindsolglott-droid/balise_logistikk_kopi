"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readJson, repoRoot, result, summarize } = require("../lib/core.cjs");
const { compareThreeWay, evaluateFreshness } = require("../lib/balise-parity.cjs");
const {
  classifyPipelineExecution,
  evaluateComparisonEligibility
} = require("../lib/classification.cjs");
const {
  classificationModel,
  renderHtml,
  renderJUnit,
  renderMarkdown,
  writeReports
} = require("../lib/reporters.cjs");

const root = repoRoot();
const july31 = readJson(path.join(root, "tests/sde-quality-engine/fixtures/classification-guard-july31.json"));
const freshnessContract = readJson(path.join(root, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));
const normativeAuthority = { type: "NORMATIVE_OPERATIONAL_RULE", normative: true, source: "synthetic approved contract" };

function occurrence(index, direction = "arrival") {
  const routeId = `synthetic-route-${String(index).padStart(2, "0")}`;
  const time = `15:${String(index).padStart(2, "0")}`;
  const occurrenceId = `${july31.operationalDate}|${direction}|T${String(index).padStart(3, "0")}|${time}`;
  const balise = {
    routeId,
    occurrenceId,
    operationalDate: july31.operationalDate,
    direction,
    trainNumber: `T${String(index).padStart(3, "0")}`,
    time,
    track: direction === "departure" ? "2" : "1",
    vehicleIds: [`UNIT-${String(index).padStart(3, "0")}`],
    consist: "single_set",
    sourceTimestamp: july31.sourceObservation.observedAt,
    provenance: "synthetic upstream"
  };
  const sde = {
    ...balise,
    track: direction === "departure" ? null : "2",
    vehicleIds: direction === "departure" ? balise.vehicleIds : [`UNIT-X${String(index).padStart(3, "0")}`],
    consist: direction === "departure" ? "single_set" : "double_set",
    sourceTimestamp: july31.dataset.generatedAt,
    datasetUpdatedAt: july31.dataset.generatedAt,
    provenance: "synthetic dataset"
  };
  return { balise, sde };
}

function incomparable(records = [occurrence(1)]) {
  return compareThreeWay({
    baliseRecords: records.map((item) => item.balise),
    candidateRecords: records.map((item) => item.sde),
    publishedRecords: records.map((item) => item.sde),
    observedAt: july31.sourceObservation.observedAt,
    comparisonContext: {
      sourceObservedAt: july31.sourceObservation.observedAt,
      sourceHash: july31.sourceObservation.hash,
      datasetGeneratedAt: july31.dataset.generatedAt,
      datasetSourceObservedAt: july31.dataset.sourceObservedAt,
      datasetSourceHash: july31.dataset.sourceHash
    },
    contractAuthority: freshnessContract.authority
  });
}

function comparable(records = [occurrence(1)], authority = normativeAuthority) {
  return compareThreeWay({
    baliseRecords: records.map((item) => item.balise),
    candidateRecords: records.map((item) => item.sde),
    publishedRecords: records.map((item) => item.sde),
    comparisonContext: {
      sourceObservedAt: "2099-07-31T13:09:00.000Z",
      sourceHash: "same-snapshot-hash",
      datasetGeneratedAt: "2099-07-31T13:10:00.000Z",
      datasetSourceObservedAt: "2099-07-31T13:09:00.000Z",
      datasetSourceHash: "same-snapshot-hash"
    },
    contractAuthority: authority
  });
}

function sampleReport(threeWay) {
  const results = [result({
    id: "BALISE-010-LIVE",
    area: "tursatt-balise",
    name: "Synthetic classification",
    status: threeWay.releaseStatus === "BLOCKED" ? "BLOCKED" : "AMBER",
    critical: true,
    summary: "Synthetic evidence.",
    details: { threeWay }
  })];
  return {
    runId: "classification-unit",
    generatedAt: "2099-07-31T22:35:00.000Z",
    suite: "unit",
    git: { commit: "abc", branch: "detached", baseline: "abc", clean: false, changedFiles: [] },
    results,
    summary: summarize(results),
    functionMatrix: [],
    commands: [],
    productionSafety: { allowedMethods: ["GET", "HEAD"], ledger: [], guardVerified: true },
    recommendations: []
  };
}

test("ulikt snapshot uten kildehash kan ikke gi PROBABLE_DEFECT", () => {
  const observed = incomparable();
  assert.equal(observed.findingTypeCounts.PROBABLE_DEFECT, 0);
  assert.equal(observed.findingTypeCounts.BLOCKED, 3);
});

test("flere timers snapshotforskjell gir BLOCKED", () => {
  const eligibility = evaluateComparisonEligibility({
    sourceObservedAt: "2099-07-31T20:35:00Z", sourceHash: "h",
    datasetGeneratedAt: "2099-07-31T13:10:00Z", datasetSourceObservedAt: "2099-07-31T13:10:00Z", datasetSourceHash: "h",
    sourceOperationalDate: july31.operationalDate, datasetOperationalDate: july31.operationalDate,
    sourceOccurrenceModel: "v1", datasetOccurrenceModel: "v1"
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, "SNAPSHOT_TIME_MISMATCH");
  assert.ok(eligibility.timeDeltaSeconds > 7 * 3600);
});

test("SNAPSHOT_TIME_MISMATCH er en sekundæretikett og ikke et nytt funn", () => {
  const observed = incomparable();
  assert.equal(observed.uniqueUnderlyingFindings, 3);
  assert.equal(observed.diagnosticLabelCounts.SNAPSHOT_TIME_MISMATCH, 3);
  assert.equal(observed.findings.every((finding) => finding.primaryClassification === "BLOCKED"), true);
});

test("manglende normativ kontrakt gir CONTRACT_AMBIGUITY når snapshotet ellers er kvalifisert", () => {
  const observed = comparable([occurrence(1)], freshnessContract.authority);
  assert.equal(observed.findingTypeCounts.CONTRACT_AMBIGUITY, 3);
  assert.equal(observed.findingTypeCounts.PROBABLE_DEFECT, 0);
});

test("teknisk avledet 21-grense kan ikke gi bekreftet SDE-feil", () => {
  const freshness = evaluateFreshness({
    now: new Date("2099-07-31T20:35:00Z"), sourceReadAt: new Date("2099-07-31T20:35:00Z"),
    sourceResponseDate: "Fri, 31 Jul 2099 20:35:00 GMT", sdeGeneratedAt: "31.07.2099 15:10:00", contract: freshnessContract
  });
  assert.equal(freshness.contractAuthority.type, "TECHNICAL_SCHEDULE_DERIVED");
  assert.equal(freshness.contractAuthority.normative, false);
});

test("forsinket workflow uten generering gir EXPECTED_RUN_MISSING", () => {
  const pipeline = classifyPipelineExecution({
    expectedRun: true, scheduledCycleHour: 21, workflowStarted: true,
    actualWorkflowStart: july31.workflow.actualStart, generatorExecuted: false,
    generatorSkipReason: july31.workflow.generatorSkipReason, workflowConclusion: "success",
    dataCommitCreated: false, deploymentCompleted: false, contractAuthority: freshnessContract.authority
  });
  assert.equal(pipeline.pipelineFindingType, "EXPECTED_RUN_MISSING");
  assert.equal(pipeline.primaryClassification, "CONTRACT_AMBIGUITY");
});

test("grønn workflow med skipped generator skjuler ikke pipelinefunnet", () => {
  const pipeline = classifyPipelineExecution({ expectedRun: true, workflowStarted: true, generatorExecuted: false, workflowConclusion: "success", dataCommitCreated: false });
  assert.equal(pipeline.pipelineFindingType, "EXPECTED_RUN_MISSING");
  assert.equal(pipeline.evidence.workflowConclusion, "success");
});

test("ingen ny datacommit kan ikke klassifiseres som PUBLICATION_DELAY", () => {
  const pipeline = classifyPipelineExecution({ expectedRun: true, workflowStarted: true, generatorExecuted: false, dataCommitCreated: false, deploymentCompleted: false });
  assert.equal(pipeline.publicationDelayEligible, false);
  assert.notEqual(pipeline.pipelineFindingType, "PUBLICATION_DELAY");
});

test("byteidentiske kandidat- og published-payloads dedupliseres", () => {
  const observed = incomparable();
  assert.equal(observed.uniqueUnderlyingFindings, 3);
  assert.equal(observed.layerObservationCount, 6);
  assert.equal(observed.findings.every((finding) => finding.layerObservationCount === 2), true);
  assert.equal(observed.findings.every((finding) => finding.diagnosticLabels.includes("CANDIDATE_AND_PUBLISHED_DUPLICATE")), true);
});

test("manglende actual avgangsspor gir TEST_ORACLE_DEFECT", () => {
  const observed = incomparable([occurrence(90, "departure")]);
  assert.equal(observed.findingTypeCounts.TEST_ORACLE_DEFECT, 1);
  assert.equal(observed.findingTypeCounts.PROBABLE_DEFECT, 0);
  assert.deepEqual(observed.findings[0].diagnosticLabels.sort(), ["CANDIDATE_AND_PUBLISHED_DUPLICATE", "EXPECTED_DIFFERENCE"]);
});

test("full proveniens og normativ kontrakt kan fortsatt tillate PROBABLE_DEFECT", () => {
  const observed = comparable();
  assert.equal(observed.findingTypeCounts.PROBABLE_DEFECT, 3);
  assert.equal(observed.findings.every((finding) => finding.evidenceRequirements.probableEligible), true);
});

test("manglende proveniens er fail-closed også for occurrence-avvik", () => {
  const { balise, sde } = occurrence(2);
  const observed = compareThreeWay({ baliseRecords: [balise], candidateRecords: [], publishedRecords: [] });
  assert.equal(observed.findingTypeCounts.BLOCKED, 1);
  assert.equal(observed.findings[0].comparisonEligibility.eligible, false);
});

test("31. juli-fixturen representerer 72 blokkerte lagobservasjoner uten produktdefekt", () => {
  const records = Array.from({ length: july31.comparison.neutralArrivalOccurrenceCount }, (_, index) => occurrence(index + 1));
  records.push(occurrence(90, "departure"));
  const observed = incomparable(records);
  assert.equal(observed.findingTypeCounts.CONFIRMED_DEFECT, july31.expected.confirmedDefect);
  assert.equal(observed.findingTypeCounts.PROBABLE_DEFECT, july31.expected.probableDefect);
  assert.equal(observed.findingTypeCounts.BLOCKED, july31.expected.uniqueBlocked);
  assert.equal(observed.layerPrimaryClassificationCounts.BLOCKED, july31.expected.blockedLayerObservations);
  assert.equal(observed.layerDiagnosticLabelCounts.SNAPSHOT_TIME_MISMATCH, july31.expected.snapshotTimeMismatchLayerObservations);
  assert.equal(observed.findingTypeCounts.TEST_ORACLE_DEFECT, july31.expected.testOracleDefect);
});

test("syntetisk live-observasjon kan ikke skrive tilbake til fixtures eller kontrakter", () => {
  const fixturePath = path.join(root, "tests/sde-quality-engine/fixtures/classification-guard-july31.json");
  const contractPath = path.join(root, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json");
  const before = [fs.readFileSync(fixturePath), fs.readFileSync(contractPath)];
  incomparable();
  const after = [fs.readFileSync(fixturePath), fs.readFileSync(contractPath)];
  assert.equal(before[0].equals(after[0]), true);
  assert.equal(before[1].equals(after[1]), true);
});

test("rapportenes summer stemmer med detaljpostene", () => {
  const observed = incomparable();
  assert.equal(observed.accounting.uniqueFindings, observed.findings.length);
  assert.equal(observed.accounting.layerObservations, observed.layerObservations.length);
  assert.equal(Object.values(observed.primaryClassificationCounts).reduce((sum, value) => sum + value, 0), observed.findings.length);
});

test("JSON, Markdown, HTML og JUnit bruker samme klassifiseringsmodell uten ekstra label-tester", () => {
  const observed = incomparable();
  const report = sampleReport(observed);
  const model = classificationModel(report);
  assert.equal(model.uniqueUnderlyingFindings, observed.uniqueUnderlyingFindings);
  assert.match(renderMarkdown(report), /Comparison eligible|Comparison eligible/i);
  assert.match(renderMarkdown(report), /HOLD does not mean confirmed product defect/);
  assert.match(renderHtml(report), /Fail-closed klassifisering/);
  const junit = renderJUnit(report);
  assert.match(junit, /primaryClassification/);
  assert.match(junit, /tests="1"/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-classification-"));
  try {
    const written = writeReports(report, directory);
    const json = JSON.parse(written.rendered.json);
    assert.equal(classificationModel(json).uniqueUnderlyingFindings, model.uniqueUnderlyingFindings);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
