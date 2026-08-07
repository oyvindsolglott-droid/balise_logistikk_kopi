"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");

const root = path.resolve(__dirname, "../..");
const modulePath = path.join(root, "sde_intelligent_night_planning.js");

function loadSubject() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function artifactHash(artifact) {
  const unsigned = {...artifact};
  delete unsigned.artifactHash;
  return crypto.createHash("sha256").update(canonical(unsigned)).digest("hex");
}

test("canonical nattplan bruker samme modell for OCR og manuell registrering", () => {
  const subject = loadSubject();
  const parsed = subject.parseOcrText([
    "22:53 Fra 833 Til 802 74-38 12S WC vann",
    "00:50 Fra 837 Til 808 74-47 6N verksted",
  ].join("\n"), {
    planId: "plan-ocr-1",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00.000Z",
    sourceFingerprint: "sha256:test",
  });
  const manual = subject.createNightPlan({
    planId: "plan-manual-1",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00.000Z",
    sourceType: "HUMAN_MANUAL_PLAN",
    entries: [{vehicleId: "74-38", desiredSlot: "12S", trainNumber: "802", time: "22:53"}],
  });

  assert.equal(parsed.schemaVersion, "sde-night-plan-v1");
  assert.equal(manual.schemaVersion, parsed.schemaVersion);
  assert.equal(parsed.planStatus, "DRAFT");
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].vehicleId.normalizedValue, "74-38");
  assert.equal(parsed.entries[0].desiredSlot.normalizedValue, "12S");
  assert.equal(parsed.entries[0].confirmationState, "UNCONFIRMED");
  assert.equal(parsed.entries[0].vehicleId.sourceRegion.line, 1);
  assert.equal(typeof parsed.entries[0].vehicleId.confidence, "number");
  assert.equal(manual.entries[0].confirmationState, "UNCONFIRMED");
});

test("validering oppretter aldri ukjent vehicleId og gjør aldri ugyldig slot gyldig", () => {
  const subject = loadSubject();
  const plan = subject.createNightPlan({
    planId: "plan-validation",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00.000Z",
    sourceType: "HUMAN_MANUAL_PLAN",
    entries: [
      {vehicleId: "99-99", desiredSlot: "12S"},
      {vehicleId: "74-38", desiredSlot: "13N"},
    ],
  });
  const result = subject.validateNightPlan(plan, {knownVehicleIds: ["74-38"]});

  assert.equal(result.valid, false);
  assert.deepEqual(result.entries[0].validationWarnings, ["UNKNOWN_VEHICLE"]);
  assert.deepEqual(result.entries[1].validationWarnings, ["INVALID_SLOT"]);
  assert.equal(result.entries[1].desiredSlot.validationState, "INVALID");
  assert.equal(result.createdVehicleIds.length, 0);
});

test("plananalyse er read-only og canonical actual vinner over importert plan", () => {
  const subject = loadSubject();
  const plan = subject.createNightPlan({
    planId: "plan-analysis",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00.000Z",
    sourceType: "HUMAN_IMPORTED_PLAN",
    entries: [{vehicleId: "74-38", desiredSlot: "12S"}],
  });
  const state = Object.freeze({revision: "41", placements: Object.freeze({"74-38": "5N", "74-44": "12S"})});
  const before = JSON.stringify(state);
  const result = subject.analyzeNightPlan(plan, {
    revision: state.revision,
    actualSlotForVehicle: vehicleId => state.placements[vehicleId] || "",
    absoluteTargetGate: (_vehicleId, targetSlot) => targetSlot === "12S"
      ? {ok: false, reasonCode: "TARGET_OCCUPIED", occupiedBy: "74-44"}
      : {ok: true},
  });

  assert.equal(result.entries[0].classification, "KONFLIKT");
  assert.equal(result.entries[0].canonicalActual, "5N");
  assert.equal(result.entries[0].reasonCodes.includes("TARGET_OCCUPIED"), true);
  assert.equal(JSON.stringify(state), before);
  assert.equal(result.sideEffectPolicy, "READ_ONLY");
});

test("HumanExperienceScore skiller planlagt fra bevist gjennomført og ignorerer egne uutførte forslag", () => {
  const subject = loadSubject();
  const records = [
    {sourceType: "HUMAN_IMPORTED_PLAN", planStatus: "CONFIRMED", operationalDate: "2026-07-10", desiredSlot: "12S", vehicleType: "74"},
    {sourceType: "AUTHORITATIVE_EXECUTED_RESULT", operationalDate: "2026-07-11", desiredSlot: "12S", actualFinalSlot: "12S", actualOutcome: "COMPLETED", replanOccurred: false, vehicleType: "74"},
    {sourceType: "AUTHORITATIVE_EXECUTED_RESULT", operationalDate: "2026-07-12", desiredSlot: "12S", actualFinalSlot: "11S", actualOutcome: "REPLAN_REQUIRED", replanOccurred: true, vehicleType: "74"},
    {sourceType: "SDE_RECOMMENDATION", operationalDate: "2026-07-13", desiredSlot: "12S", actualFinalSlot: "12S", actualOutcome: "COMPLETED", vehicleType: "74"},
  ];
  const score = subject.scoreHumanExperience({slot: "12S", vehicleType: "74"}, records, {now: "2026-08-07T00:00:00.000Z"});

  assert.equal(score.status, "AVAILABLE");
  assert.equal(score.plannedCount, 1);
  assert.equal(score.authoritativelyExecutedCount, 2);
  assert.equal(score.excludedRecommendationCount, 1);
  assert.equal(score.score >= 0 && score.score <= 100, true);
  assert.match(score.explanation, /gjennomført/i);
  assert.match(score.explanation, /replan/i);
});

test("dataset builder er allowlistet, autoritativ og avviser future leakage og identitetsfeatures", () => {
  const subject = loadSubject();
  const base = {
    sourceType: "AUTHORITATIVE_EXECUTED_RESULT",
    recordId: "outcome-1",
    operationalDate: "2026-07-01",
    decisionAt: "2026-07-01T20:00:00.000Z",
    outcomeKnownAt: "2026-07-02T05:00:00.000Z",
    operationalRevision: "rev-19",
    currentSafetyValid: true,
    features: {
      startSlot: {value: "5N", knownAt: "2026-07-01T19:50:00.000Z"},
      candidateSlot: {value: "12S", knownAt: "2026-07-01T19:50:00.000Z"},
      departureMinutes: {value: 250, knownAt: "2026-07-01T19:50:00.000Z"},
      vehicleType: {value: "74", knownAt: "2026-07-01T19:50:00.000Z"},
    },
    labels: {replanOccurred: false, morningConflict: false, moveCount: 1, departureBlocked: false, planCompleted: true},
  };
  const result = subject.buildTrainingDataset([
    base,
    {...base, recordId: "own-suggestion", sourceType: "SDE_RECOMMENDATION"},
    {...base, recordId: "future", features: {...base.features, startSlot: {value: "5N", knownAt: "2026-07-02T01:00:00.000Z"}}},
    {...base, recordId: "identity", features: {...base.features, email: {value: "person@example.com", knownAt: "2026-07-01T19:00:00.000Z"}}},
    {...base, recordId: "unsafe-history", currentSafetyValid: false},
  ]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].recordId, "outcome-1");
  assert.equal(result.exclusions.SDE_RECOMMENDATION_NOT_GROUND_TRUTH, 1);
  assert.equal(result.exclusions.FUTURE_FEATURE_LEAKAGE, 1);
  assert.equal(result.exclusions.NON_ALLOWLISTED_FEATURE, 1);
  assert.equal(result.exclusions.INVALID_UNDER_CURRENT_SAFETY_RULES, 1);
  assert.equal(result.provenance.operationalRevisions.includes("rev-19"), true);
  assert.equal("email" in result.rows[0].features, false);
});

test("cold start fabrikerer ikke MachineLearningScore", async () => {
  const subject = loadSubject();
  const artifact = {
    schemaVersion: "sde-night-model-artifact-v1",
    modelId: "sde-night-tabular",
    modelVersion: "0.0.0-cold-start",
    status: "INSUFFICIENT_DATA",
    trainedAt: null,
    trainingDatasetVersion: "none",
    featureVersion: "sde-night-features-v1",
    targetVersion: "sde-night-targets-v1",
    minimumDataContractVersion: "sde-night-minimum-data-v1",
    models: null,
  };
  artifact.artifactHash = artifactHash(artifact);
  const result = await subject.inferMachineLearning({candidateSlot: "12S"}, artifact);

  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.score, null);
  assert.equal(result.influencesCombinedScore, false);
  assert.match(result.explanation, /utilstrekkelig/i);
});

test("deployet cold-start artifact har gyldig integritet og er eksplisitt registrert", async () => {
  const subject = loadSubject();
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "models/sde/production-model.json"), "utf8"));
  const registry = JSON.parse(fs.readFileSync(path.join(root, "models/sde/model-registry.json"), "utf8"));
  const integrity = await subject.validateModelArtifact(artifact, registry);
  const inference = await subject.inferMachineLearning({candidateSlot: "12S"}, artifact, {registry});

  assert.equal(integrity.ok, true);
  assert.equal(registry.activeChampion, null);
  assert.equal(registry.models[0].artifactHash, artifact.artifactHash);
  assert.equal(inference.status, "INSUFFICIENT_DATA");
  assert.equal(inference.score, null);
  assert.equal(inference.influencesCombinedScore, false);
});

test("korrupt eller uregistrert modellartifact gir ML_DISABLED og trygg fallback", async () => {
  const subject = loadSubject();
  const corrupt = {
    schemaVersion: "sde-night-model-artifact-v1",
    modelId: "sde-night-tabular",
    modelVersion: "1.2.3",
    status: "CHAMPION",
    trainedAt: "2026-08-01T00:00:00.000Z",
    trainingDatasetVersion: "dataset-12",
    featureVersion: "sde-night-features-v1",
    targetVersion: "sde-night-targets-v1",
    artifactHash: "0".repeat(64),
    models: {},
  };
  const result = await subject.inferMachineLearning({candidateSlot: "12S"}, corrupt);

  assert.equal(result.status, "ML_DISABLED");
  assert.equal(result.score, null);
  assert.equal(result.influencesCombinedScore, false);
  assert.match(result.explanation, /integritet/i);
});

test("champion krever eksplisitt registry-binding og gir stabil forklarbar inference", async () => {
  const subject = loadSubject();
  const model = (type, intercept, weights) => ({type, intercept, weights});
  const artifact = {
    schemaVersion: "sde-night-model-artifact-v1",
    modelId: "sde-night-tabular",
    modelVersion: "1.2.3",
    status: "CHAMPION",
    trainedAt: "2026-08-01T00:00:00.000Z",
    trainingDatasetVersion: "sha256:dataset-12",
    featureVersion: "sde-night-features-v1",
    targetVersion: "sde-night-targets-v1",
    minimumDataContractVersion: "sde-night-minimum-data-v1",
    promotion: {sourceArtifactHash: "a".repeat(64), approvedAt: "2026-08-02T00:00:00.000Z", approvedBy: "model-owner"},
    featureSchema: {
      numeric: {departureMinutes: {mean: 300, scale: 60}},
      categorical: {candidateSlot: ["11S", "12S"]},
    },
    models: {
      replanProbability: model("logistic", -1, {departureMinutes: 0.4, "candidateSlot=12S": -0.8}),
      morningConflictProbability: model("logistic", -0.5, {departureMinutes: -0.2, "candidateSlot=12S": -0.4}),
      departureBlockingProbability: model("logistic", -0.8, {"candidateSlot=12S": -0.3}),
      planCompletionProbability: model("logistic", 1, {"candidateSlot=12S": 0.6}),
      expectedMoveCount: model("linear", 2, {departureMinutes: 0.2, "candidateSlot=12S": -0.5}),
    },
  };
  artifact.artifactHash = artifactHash(artifact);
  const candidate = {features: {departureMinutes: 240, candidateSlot: "12S"}};

  const unregistered = await subject.inferMachineLearning(candidate, artifact);
  assert.equal(unregistered.status, "ML_DISABLED");
  assert.equal(unregistered.reasonCode, "MODEL_ARTIFACT_UNREGISTERED");

  const registry = {models: [{
    modelId: artifact.modelId,
    modelVersion: artifact.modelVersion,
    artifactHash: artifact.artifactHash,
    status: "CHAMPION",
  }]};
  const withoutGateEvidence = await subject.inferMachineLearning(candidate, artifact, {registry});
  assert.equal(withoutGateEvidence.status, "ML_DISABLED");
  assert.equal(withoutGateEvidence.reasonCode, "ABSOLUTE_GATE_EVIDENCE_REQUIRED");

  const first = await subject.inferMachineLearning(candidate, artifact, {registry, absoluteGatePassed: true});
  const second = await subject.inferMachineLearning(candidate, artifact, {registry, absoluteGatePassed: true});
  assert.deepEqual(first, second);
  assert.equal(first.status, "AVAILABLE");
  assert.equal(first.modelVersion, "1.2.3");
  assert.equal(first.influencesCombinedScore, true);
  assert.equal(first.factors.some(factor => factor.displayFeature === "kandidatspor"), true);
  assert.match(first.explanation, /kandidatspor|avgangstid/i);
});

test("champion-artifact kan ikke snike identity eller andre ikke-allowlistede features inn i inference", async () => {
  const subject = loadSubject();
  const logistic = {type: "logistic", intercept: 0, weights: {email: 1}};
  const artifact = {
    schemaVersion: "sde-night-model-artifact-v1",
    modelId: "sde-night-tabular",
    modelVersion: "1.2.4-forbidden-feature",
    status: "CHAMPION",
    trainedAt: "2026-08-01T00:00:00Z",
    trainingDatasetVersion: "sha256:test",
    featureVersion: "sde-night-features-v1",
    targetVersion: "sde-night-targets-v1",
    promotion: {sourceArtifactHash: "a".repeat(64)},
    featureSchema: {numeric: {email: {mean: 0, scale: 1}}, categorical: {}},
    models: {
      replanProbability: logistic,
      morningConflictProbability: logistic,
      departureBlockingProbability: logistic,
      planCompletionProbability: logistic,
      expectedMoveCount: {type: "linear", intercept: 1, weights: {email: 1}},
    },
  };
  artifact.artifactHash = artifactHash(artifact);
  const registry = {models: [{modelId: artifact.modelId, modelVersion: artifact.modelVersion, artifactHash: artifact.artifactHash, status: "CHAMPION"}]};
  const result = await subject.inferMachineLearning({features: {email: "person@example.com"}}, artifact, {registry, absoluteGatePassed: true});
  assert.equal(result.status, "ML_DISABLED");
  assert.equal(result.reasonCode, "MODEL_FEATURE_NOT_ALLOWLISTED");
  assert.equal(result.score, null);
});

test("absolute gates kjører før alle læringsscorer og 100/100 kan ikke redde opptatt target", async () => {
  const subject = loadSubject();
  const calls = [];
  const result = await subject.evaluateCandidate({
    candidate: {vehicleId: "74-38", slot: "12S"},
    absoluteGate: () => {
      calls.push("gate");
      return {ok: false, reasonCode: "TARGET_OCCUPIED"};
    },
    deterministicScorer: () => { throw new Error("deterministic scorer must not run"); },
    humanScorer: () => { throw new Error("HumanExperienceScore 100 must not run"); },
    machineScorer: () => { throw new Error("MachineLearningScore 100 must not run"); },
    weights: {deterministic: 0, humanExperience: 0.5, machineLearning: 0.5},
  });

  assert.deepEqual(calls, ["gate"]);
  assert.equal(result.status, "REJECTED_BY_ABSOLUTE_GATE");
  assert.equal(result.humanExperienceScore, null);
  assert.equal(result.machineLearningScore, null);
  assert.equal(result.combinedScore, null);
});

test("samlet scoring beholder separate signaler, eksplisitte vekter og synlig uenighet", async () => {
  const subject = loadSubject();
  const order = [];
  const result = await subject.evaluateCandidate({
    candidate: {vehicleId: "74-38", slot: "12S"},
    absoluteGate: () => { order.push("gate"); return {ok: true, passed: ["CANONICAL_OCCUPANCY", "ROUTE_SAFETY", "TURSATT"]}; },
    deterministicScorer: () => { order.push("deterministic"); return {score: 84, explanation: "Operativ motor"}; },
    humanScorer: () => { order.push("human"); return {status: "AVAILABLE", score: 91, explanation: "6 av 8 netter"}; },
    machineScorer: () => { order.push("ml"); return {status: "AVAILABLE", score: 54, explanation: "Økt morgenrisiko", modelVersion: "1.0.0"}; },
    weights: {version: "sde-night-weights-v1", deterministic: 0.6, humanExperience: 0.25, machineLearning: 0.15},
  });

  assert.deepEqual(order, ["gate", "deterministic", "human", "ml"]);
  assert.equal(result.status, "RANKED_DECISION_SUPPORT");
  assert.equal(result.deterministicScore, 84);
  assert.equal(result.humanExperienceScore, 91);
  assert.equal(result.machineLearningScore, 54);
  assert.equal(result.weights.version, "sde-night-weights-v1");
  assert.equal(result.disagreement.status, "SIGNIFICANT_DISAGREEMENT");
  assert.match(result.explanation, /uenig/i);
});

test("modell drift deaktiverer ML-vekt uten automatisk retraining", () => {
  const subject = loadSubject();
  const result = subject.assessModelDrift({
    baseline: {replanBrier: 0.12, morningConflictBrier: 0.10},
    current: {replanBrier: 0.27, morningConflictBrier: 0.24},
    sampleCount: 80,
    minimumSamples: 40,
    maximumBrierDegradation: 0.10,
  });

  assert.equal(result.status, "MODEL_DRIFT");
  assert.equal(result.machineLearningWeightAllowed, false);
  assert.equal(result.requiresControlledRetraining, true);
  assert.equal(result.runtimeRetrainingTriggered, false);
});

test("lokal OCR-adapter bruker injisert worker, returnerer tekst og terminerer alltid", async () => {
  const subject = loadSubject();
  const calls = [];
  const analyzer = subject.createLocalOcrAnalyzer({
    createWorker: async (languages, _oem, options) => {
      calls.push({type: "create", languages, options});
      return {
        recognize: async image => {
          calls.push({type: "recognize", image});
          return {data: {text: "22:53 833 802 74-38 12S", confidence: 88}};
        },
        terminate: async () => { calls.push({type: "terminate"}); },
      };
    },
    workerPath: "assets/vendor/tesseract/worker.min.js",
    corePath: "assets/vendor/tesseract-core",
    langPath: "assets/vendor/tessdata",
  });
  const result = await analyzer.analyze({name: "nattplan.png", type: "image/png"});

  assert.equal(result.rawText.includes("74-38"), true);
  assert.equal(result.confidence, 0.88);
  assert.deepEqual(calls.map(call => call.type), ["create", "recognize", "terminate"]);
  assert.equal(calls[0].languages, "nor+eng");
});

test("beslutningsmodulen inneholder ingen operativ writeflate", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  for (const forbidden of [
    "localStorage.setItem",
    "fetch(",
    "/api/actions/",
    "actual placement",
    "markUtført",
    "approveShiftCard",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden write token: ${forbidden}`);
  }
});

test("bildekontrakten godtar ekte JPG/PNG-deskriptorer og avviser manglende, ugyldige eller for store filer", () => {
  const subject = loadSubject();
  assert.deepEqual(subject.validateImageFileDescriptor({name: "plan.jpg", type: "image/jpeg", size: 12}), {
    ok: true,
    reasonCode: "IMAGE_ACCEPTED",
    mimeType: "image/jpeg",
  });
  assert.equal(subject.validateImageFileDescriptor({name: "plan.png", type: "image/png", size: 12}).ok, true);
  assert.equal(subject.validateImageFileDescriptor(null).reasonCode, "MISSING_IMAGE");
  assert.equal(subject.validateImageFileDescriptor({name: "plan.pdf", type: "application/pdf", size: 12}).reasonCode, "UNSUPPORTED_IMAGE_TYPE");
  assert.equal(subject.validateImageFileDescriptor({name: "plan.jpg", type: "text/plain", size: 12}).reasonCode, "UNSUPPORTED_IMAGE_TYPE");
  assert.equal(subject.validateImageFileDescriptor({name: "plan.png", type: "image/png", size: 0}).reasonCode, "EMPTY_IMAGE");
  assert.equal(subject.validateImageFileDescriptor({name: "plan.png", type: "image/png", size: subject.MAX_IMAGE_BYTES + 1}).reasonCode, "IMAGE_TOO_LARGE");
});

test("dårlig og delvis OCR blir usikker DRAFT, aldri autoritativ sannhet", () => {
  const subject = loadSubject();
  const base = {planId: "poor-ocr", operationalDate: "2026-08-08", createdAt: "2026-08-07T20:00:00Z", ocrConfidence: 0.22};
  const poor = subject.parseOcrText("støy uten planfelt", base);
  const partial = subject.parseOcrText("74-38 tekst som mangler spor", {...base, planId: "partial-ocr"});

  assert.equal(poor.entries.length, 0);
  assert.equal(poor.planStatus, "DRAFT");
  assert.equal(partial.entries.length, 1);
  assert.equal(partial.entries[0].vehicleId.confidence < 0.5, true);
  assert.equal(partial.entries[0].desiredSlot.normalizedValue, "");
  assert.equal(partial.entries[0].confirmationState, "UNCONFIRMED");
});

test("menneskelig korrigering, fjerning og tillegg skjer i canonical nattplan og krever ny kontroll", () => {
  const subject = loadSubject();
  const original = subject.parseOcrText("22:53 74-38 12S", {
    planId: "editable-plan",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00Z",
    ocrConfidence: 0.8,
  });
  const corrected = subject.updateNightPlanField(original, 0, "desiredSlot", "11s");
  const withAdded = subject.addNightPlanEntry(corrected, {vehicleId: "74-47", desiredSlot: "12N"});
  const removed = subject.removeNightPlanEntry(withAdded, 0);

  assert.equal(original.entries[0].desiredSlot.normalizedValue, "12S", "input plan must remain immutable");
  assert.equal(corrected.entries[0].desiredSlot.normalizedValue, "11S");
  assert.equal(corrected.entries[0].desiredSlot.rawValue, "12S");
  assert.equal(corrected.entries[0].desiredSlot.humanCorrected, true);
  assert.equal(corrected.entries[0].confirmationState, "UNCONFIRMED");
  assert.equal(withAdded.entries[1].vehicleId.humanAdded, true);
  const reordered = subject.moveNightPlanEntry(withAdded, 1, "UP");
  assert.equal(reordered.entries[0].vehicleId.normalizedValue, "74-47");
  assert.deepEqual(reordered.entries.map(entry => entry.order), [1, 2]);
  assert.equal(removed.entries.length, 1);
  assert.equal(removed.entries[0].vehicleId.normalizedValue, "74-47");
});

test("CONFIRMED krever gyldige og menneskelig bekreftede kritiske felt", () => {
  const subject = loadSubject();
  let plan = subject.createNightPlan({
    planId: "confirm-plan",
    operationalDate: "2026-08-08",
    createdAt: "2026-08-07T20:00:00Z",
    entries: [{vehicleId: "74-38", desiredSlot: "12S"}],
  });
  plan = subject.validateNightPlan(plan, {knownVehicleIds: ["74-38"]});
  assert.equal(subject.canConfirmNightPlan(plan), false);
  plan.entries[0].confirmationState = "CONFIRMED";
  assert.equal(subject.canConfirmNightPlan(plan), true);
  const invalid = subject.updateNightPlanField(plan, 0, "desiredSlot", "13N");
  const revalidated = subject.validateNightPlan(invalid, {knownVehicleIds: ["74-38"]});
  assert.equal(subject.canConfirmNightPlan(revalidated), false);

  let withRejectedLine = subject.addNightPlanEntry(plan, {vehicleId: "99-99", desiredSlot: "13N"});
  withRejectedLine = subject.setNightPlanEntryExcluded(withRejectedLine, 1, true);
  withRejectedLine = subject.validateNightPlan(withRejectedLine, {knownVehicleIds: ["74-38"]});
  assert.equal(withRejectedLine.entries[1].confirmationState, "EXCLUDED");
  assert.equal(subject.canConfirmNightPlan(withRejectedLine), true);
  const analysis = subject.analyzeNightPlan(withRejectedLine, {
    actualSlotForVehicle: () => "5N",
    absoluteTargetGate: () => ({ok: true}),
  });
  assert.equal(analysis.entries.length, 1);
});

test("HumanExperienceScore vekter planlagt svakere enn autoritativt gjennomført", () => {
  const subject = loadSubject();
  const candidate = {slot: "12S", vehicleType: "74"};
  const planned = {recordId: "planned", sourceType: "HUMAN_MANUAL_PLAN", planStatus: "CONFIRMED", operationalDate: "2026-08-01", desiredSlot: "12S", vehicleType: "74"};
  const executed = {recordId: "executed", sourceType: "AUTHORITATIVE_EXECUTED_RESULT", operationalDate: "2026-08-01", desiredSlot: "12S", actualFinalSlot: "12S", actualOutcome: "COMPLETED", replanOccurred: false, vehicleType: "74"};
  const result = subject.scoreHumanExperience(candidate, [planned, executed], {now: "2026-08-07T00:00:00Z"});

  assert.equal(result.plannedCount, 1);
  assert.equal(result.authoritativelyExecutedCount, 1);
  assert.equal(result.evidence.find(item => item.recordId === "planned").weight < result.evidence.find(item => item.recordId === "executed").weight, true);
  assert.match(result.explanation, /2026-08-01/);
});

test("replan, avbrudd og feil sluttplassering behandles ikke som vellykket gjennomføring", () => {
  const subject = loadSubject();
  const base = {sourceType: "AUTHORITATIVE_EXECUTED_RESULT", desiredSlot: "12S", vehicleType: "74", operationalDate: "2026-08-01"};
  const successful = {...base, recordId: "success", actualFinalSlot: "12S", actualOutcome: "COMPLETED", replanOccurred: false};
  const failures = [
    {...base, recordId: "replan", actualFinalSlot: "12S", actualOutcome: "REPLAN_REQUIRED", replanOccurred: true},
    {...base, recordId: "aborted", actualFinalSlot: "", actualOutcome: "ABORTED", replanOccurred: false},
    {...base, recordId: "wrong-slot", actualFinalSlot: "11S", actualOutcome: "COMPLETED", replanOccurred: false},
  ];
  const successScore = subject.scoreHumanExperience({slot: "12S", vehicleType: "74"}, [successful], {now: "2026-08-07T00:00:00Z"});
  const failureScore = subject.scoreHumanExperience({slot: "12S", vehicleType: "74"}, failures, {now: "2026-08-07T00:00:00Z"});
  assert.equal(successScore.score, 100);
  assert.equal(failureScore.score, 0);
  assert.equal(failureScore.replanCount, 1);
  assert.deepEqual(failureScore.evidence.map(item => item.success), [0, 0, 0]);
});

test("nyere relevant erfaring veier mer, irrelevant historikk filtreres og SDE-forslag lærer ingenting", () => {
  const subject = loadSubject();
  const base = {sourceType: "AUTHORITATIVE_EXECUTED_RESULT", desiredSlot: "12S", actualOutcome: "COMPLETED", vehicleType: "74", replanOccurred: false};
  const records = [
    {...base, recordId: "old-failure", operationalDate: "2024-01-01", actualFinalSlot: "11S"},
    {...base, recordId: "new-success", operationalDate: "2026-08-06", actualFinalSlot: "12S"},
    {...base, recordId: "irrelevant", operationalDate: "2026-08-06", desiredSlot: "11S", actualFinalSlot: "11S"},
    {...base, recordId: "own", operationalDate: "2026-08-06", sourceType: "SDE_RECOMMENDATION", actualFinalSlot: "12S"},
  ];
  const result = subject.scoreHumanExperience({slot: "12S", vehicleType: "74"}, records, {now: "2026-08-07T00:00:00Z"});
  assert.equal(result.score > 90, true);
  assert.equal(result.irrelevantRecordCount, 1);
  assert.equal(result.excludedRecommendationCount, 1);
  assert.equal(result.evidence.some(item => item.recordId === "own"), false);
});

test("dataset avviser uverifisert OCR, manglende knownAt og ugyldige outcome-tidspunkter", () => {
  const subject = loadSubject();
  const authoritative = {
    sourceType: "AUTHORITATIVE_EXECUTED_RESULT",
    recordId: "valid",
    operationalDate: "2026-07-01",
    decisionAt: "2026-07-01T20:00:00Z",
    outcomeKnownAt: "2026-07-02T05:00:00Z",
    currentSafetyValid: true,
    operationalRevision: "rev-1",
    features: {candidateSlot: {value: "12S", knownAt: "2026-07-01T19:00:00Z"}},
    labels: {replanOccurred: false, morningConflict: false, moveCount: 1, departureBlocked: false, planCompleted: true},
  };
  const ocr = {...authoritative, recordId: "ocr", sourceType: "HUMAN_IMPORTED_PLAN"};
  const missingKnownAt = {...authoritative, recordId: "missing-known-at", features: {candidateSlot: {value: "12S"}}};
  const earlyOutcome = {...authoritative, recordId: "early-outcome", outcomeKnownAt: authoritative.decisionAt};
  const result = subject.buildTrainingDataset([authoritative, ocr, missingKnownAt, earlyOutcome]);
  assert.deepEqual(result.rows.map(row => row.recordId), ["valid"]);
  assert.equal(result.exclusions.UNVERIFIED_PLAN_NOT_GROUND_TRUTH, 1);
  assert.equal(result.exclusions.FUTURE_FEATURE_LEAKAGE, 1);
  assert.equal(result.exclusions.INVALID_OUTCOME_PROVENANCE, 1);
});

test("kombinert scoring dekker separate tilgjengelighetskombinasjoner og renormaliserer eksplisitte vekter", async () => {
  const subject = loadSubject();
  const weights = {version: "weights-test-v1", deterministic: 0.6, humanExperience: 0.25, machineLearning: 0.15};
  const scenarios = [
    {name: "deterministisk alene", human: null, machine: null, expected: 80},
    {name: "deterministisk + human", human: 100, machine: null, expected: 85.9},
    {name: "deterministisk + ML", human: null, machine: 40, expected: 72},
    {name: "alle tre enige", human: 80, machine: 80, expected: 80},
    {name: "alle tre uenige", human: 100, machine: 40, expected: 79},
  ];
  for (const scenario of scenarios) {
    const result = await subject.evaluateCandidate({
      candidate: {slot: "12S"},
      absoluteGate: () => ({ok: true}),
      deterministicScorer: () => ({score: 80}),
      humanScorer: () => scenario.human == null ? {status: "INSUFFICIENT_DATA", score: null} : {status: "AVAILABLE", score: scenario.human},
      machineScorer: () => scenario.machine == null ? {status: "ML_DISABLED", score: null} : {status: "AVAILABLE", score: scenario.machine},
      weights,
    });
    assert.equal(result.combinedScore, scenario.expected, scenario.name);
    assert.equal(result.weights.version, "weights-test-v1");
  }
  assert.deepEqual(weights, {version: "weights-test-v1", deterministic: 0.6, humanExperience: 0.25, machineLearning: 0.15});
});

test("morgenklarhet forblir delegert til eksisterende deterministisk motor etter absolute gate", () => {
  const uiSource = fs.readFileSync(path.join(root, "sde_night_planning_ui.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const required of [
    "scoreSdeArrivalParkingCandidate(buildNeed(entry, actualSlot), targetSlot)",
    "evaluateSdeAbsoluteTargetSlotSafety(vehicle, targetSlot",
    "nextDeparturePart",
    "serviceRequired",
  ]) assert.equal(uiSource.includes(required), true, required);
  for (const existingRule of [
    "Tidlig avgang krever lett tilgjengelig nattplassering.",
    "buttspor fordi /2 normalt skal stå i N",
    "buttspor fordi /1 normalt skal stå i S",
    "Servicebehov er registrert",
    "operationalSingleSetSlot",
  ]) assert.equal(indexSource.includes(existingRule), true, existingRule);
});

test("read-only analyse endrer ingen operativ state utover at caller eventuelt velger teknisk inferenceaudit", async () => {
  const subject = loadSubject();
  const operational = {
    placements: {"74-38": "5N"},
    statusrecords: [{vehicleId: "74-38", status: "DRIFTSKLAR"}],
    dispositions: [], faults: [], repairs: [], messages: [], acknowledgements: [],
    queue: [], reservations: [], cards: [], revision: "88", sharedDraft: {revision: "5"},
  };
  const before = JSON.stringify(operational);
  const result = await subject.evaluateCandidate({
    candidate: {vehicleId: "74-38", slot: "12S"},
    absoluteGate: () => ({ok: true}),
    deterministicScorer: () => ({score: 82}),
    humanScorer: () => ({status: "INSUFFICIENT_DATA", score: null}),
    machineScorer: () => ({status: "ML_DISABLED", score: null}),
    weights: {version: "write-free-v1", deterministic: 1, humanExperience: 0, machineLearning: 0},
  });
  assert.equal(result.status, "RANKED_DECISION_SUPPORT");
  assert.equal(JSON.stringify(operational), before);
});
