"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const {test} = require("node:test");

const root = path.resolve(__dirname, "../..");
const attestationPath = path.join(root, "config/sde-handwriting-model-quality-attestation.json");
const registryPath = path.join(root, "config/sde-handwriting-model-registry.json");
const modelRoot = path.join(root, "assets/models/gigapdf-ocr-handwriting");

function readJson(file){ return JSON.parse(fs.readFileSync(file, "utf8")); }
function sha256(value){ return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value){
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

test("SDE-HANDWRITING-MODEL-QUALITY binds the active model to exact verified bytes", () => {
  const attestation = readJson(attestationPath);
  const registry = readJson(registryPath);
  const manifestBytes = fs.readFileSync(path.join(modelRoot, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const modelBytes = fs.readFileSync(path.join(modelRoot, "model.onnx"));
  const dictionaryBytes = fs.readFileSync(path.join(modelRoot, "dict.txt"));

  assert.equal(attestation.gateId, "SDE-HANDWRITING-MODEL-QUALITY");
  assert.equal(attestation.model.version, registry.activeModelVersion);
  assert.equal(attestation.model.sha256, registry.activeModelSha256);
  assert.equal(sha256(modelBytes), attestation.model.sha256);
  assert.equal(modelBytes.length, attestation.model.sizeBytes);
  assert.equal(sha256(manifestBytes), attestation.model.manifestSha256);
  assert.equal(sha256(dictionaryBytes), attestation.model.dictionarySha256);
  assert.equal(manifest.files["model.onnx"], attestation.model.sha256);
  assert.equal(manifest.files["dict.txt"], attestation.model.dictionarySha256);
  assert.equal(manifest.handwritingCapable, true);
  assert.equal(manifest.runtime.executionProvider, "wasm");
  assert.equal(attestation.model.sameOriginAssetsOnly, true);
});

test("private blind aggregate clears every binding acceptance threshold", () => {
  const attestation = readJson(attestationPath);
  const quality = attestation.quality;
  assert.ok(quality.clearStructuredCells >= 1);
  assert.equal(quality.autoAccepted, quality.autoAcceptedCorrect + quality.autoAcceptedIncorrect);
  assert.equal(quality.autoAcceptedIncorrect, 0);
  assert.ok(quality.autoAcceptedStructuredPrecision >= 0.99);
  assert.ok(quality.autoAcceptedClearCellCoverage >= 0.85);
  assert.ok(quality.manualCorrectionRate <= 0.10);
  assert.equal(quality.blankCellFalsePositiveAccepted, 0);
  assert.equal(quality.gibberishFormValues, 0);
  assert.equal(quality.crossRowAcceptedErrors, 0);
  assert.equal(quality.crossColumnAcceptedErrors, 0);
  assert.equal(quality.unsupportedAutoAcceptedValues, 0);
  assert.ok(quality.characterEditsRequired >= 0);
  assert.ok(quality.characterEditDistancePerNonEmptyCell >= 0);
  assert.ok(Object.keys(quality.fieldMetrics).length >= 5);
  for(const metric of Object.values(quality.fieldMetrics)){
    assert.equal(metric.autoAcceptedCorrect, metric.autoAccepted);
    assert.ok(metric.autoAcceptedPrecision >= 0.99);
  }
});

test("dataset split is document-disjoint and blind holdout cannot feed training or tuning", () => {
  const attestation = readJson(attestationPath);
  assert.equal(sha256(JSON.stringify(stable(attestation.aggregateDatasetManifest))), attestation.datasetManifestHash);
  assert.deepEqual(Object.keys(attestation.aggregateDatasetManifest.classes).sort(), [
    "PRIVATE_BLIND_HOLDOUT", "PRIVATE_TRAIN", "PRIVATE_VALIDATION",
  ]);
  assert.equal(attestation.splits.documentDisjoint, true);
  assert.equal(attestation.splits.holdoutUsedForTraining, false);
  assert.equal(attestation.splits.holdoutUsedForThresholdSelection, false);
  assert.equal(attestation.splits.holdoutUsedForManualModelAdaptation, false);
  assert.equal(attestation.aggregateDatasetManifest.publishedContent, "AGGREGATE_COUNTS_ONLY");
});

test("runtime and promotion remain fail-closed", () => {
  const attestation = readJson(attestationPath);
  const registry = readJson(registryPath);
  assert.equal(attestation.runtimeQualification.desktopChromium, "GREEN");
  assert.equal(attestation.runtimeQualification.mobile390Chromium, "GREEN");
  assert.equal(attestation.runtimeQualification.mobile390WebKitSafariEngine, "GREEN");
  assert.ok(attestation.runtimeQualification.observedMaximumMillisecondsPerSyntheticPlan < attestation.runtimeQualification.maximumAllowedMillisecondsPerSyntheticPlan);
  assert.equal(attestation.runtimeQualification.networkRequestsWithUserContentBeforeSave, 0);
  assert.equal(attestation.promotion.qualityGatePassed, true);
  assert.equal(attestation.promotion.humanApprovalRequired, true);
  assert.equal(attestation.promotion.automaticPromotion, false);
  assert.equal(attestation.promotion.rollbackAvailable, true);
  assert.equal(registry.humanPromotionRequired, true);
  assert.equal(registry.autoPromotion, false);
  assert.match(registry.rollbackModelSha256, /^[a-f0-9]{64}$/);
});

test("public Git inventory contains no private HTR images, crops, labels, or learning examples", () => {
  const attestation = readJson(attestationPath);
  const tracked = childProcess.execFileSync("git", ["ls-files"], {cwd: root, encoding: "utf8"}).trim().split("\n").filter(Boolean);
  const forbidden = tracked.filter(file => /(?:^|\/)(?:\.sde-private-handwriting|private\/sde-handwriting|handwriting-private)(?:\/|$)|private-acceptance-image|handwriting-learning-example/i.test(file));
  assert.deepEqual(forbidden, []);
  assert.equal(attestation.privacy.privateImagesCommitted, false);
  assert.equal(attestation.privacy.privateCropsCommitted, false);
  assert.equal(attestation.privacy.rawPrivateLabelsCommitted, false);
  assert.equal(attestation.privacy.privateDataInCiArtifacts, false);
  assert.equal(attestation.privacy.persistenceBeforeExplicitSave, false);
});
