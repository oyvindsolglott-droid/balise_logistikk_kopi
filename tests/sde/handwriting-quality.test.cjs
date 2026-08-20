"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const htr = require("../../sde_handwriting_recognition.js");

function image(width, height, points = []){
  const pixels = new Uint8Array(width * height).fill(255);
  for(const [x, y] of points) pixels[(y * width) + x] = 0;
  return pixels;
}

test("blank classifier rejects empty, grid-only, and isolated-noise cells before recognition", () => {
  const width = 64;
  const height = 32;
  const grid = [];
  for(let x = 0; x < width; x += 1) grid.push([x, 1], [x, height - 2]);
  for(let y = 0; y < height; y += 1) grid.push([1, y], [width - 2, y]);
  assert.equal(htr.classifyBlankCell({image: image(width, height), width, height}).blank, true);
  assert.equal(htr.classifyBlankCell({image: image(width, height, grid), width, height}).blank, true);
  assert.equal(htr.classifyBlankCell({image: image(width, height, [[12, 12], [45, 19]]), width, height}).blank, true);

  const stroke = [];
  for(let x = 13; x <= 38; x += 1){ stroke.push([x, 14], [x, 15]); }
  assert.equal(htr.classifyBlankCell({image: image(width, height, stroke), width, height}).blank, false);
});

test("WC/vann symbol classification requires compact circled-star geometry", () => {
  const width = 48;
  const height = 48;
  const points = [];
  for(let degree = 0; degree < 360; degree += 5){
    const radians = degree * Math.PI / 180;
    points.push([24 + Math.round(Math.cos(radians) * 13), 24 + Math.round(Math.sin(radians) * 13)]);
  }
  for(let offset = -9; offset <= 9; offset += 1){
    points.push([24 + offset, 24], [24, 24 + offset], [24 + offset, 24 + offset], [24 + offset, 24 - offset]);
  }
  assert.equal(htr.classifyWcWaterSymbol({image: image(width, height, points), width, height}).symbol, "*");
  const line = Array.from({length: 24}, (_unused, index) => [10 + index, 24]);
  assert.equal(htr.classifyWcWaterSymbol({image: image(width, height, line), width, height}).symbol, "");
});

test("single-stroke slot classifier accepts a vertical one and rejects a wide glyph", () => {
  const width = 48;
  const height = 48;
  const one = [];
  for(let y = 12; y <= 38; y += 1) one.push([24, y], [25, y]);
  assert.equal(htr.classifySingleStrokeGlyph({image: image(width, height, one), width, height}).value, "1");
  const wide = [];
  for(let x = 12; x <= 36; x += 1) wide.push([x, 24], [x, 25]);
  assert.equal(htr.classifySingleStrokeGlyph({image: image(width, height, wide), width, height}).value, "");
});

test("review proposals never become canonical form values", () => {
  const value = htr.normalizeRecognition({
    columnId: "vehicleId",
    candidates: [{text: "74-51", confidence: 0.90, votes: 1}],
  }, {vehicleCatalog: ["74-51"]});
  assert.equal(value.disposition, "REVIEW_SUGGESTION");
  assert.equal(value.selectedValue, "");
  assert.equal(value.suggestedValue, "74-51");
  assert.equal(value.normalizedValue, "74-51");
  assert.equal(value.needsReview, true);
});

test("gibberish and field-invalid output is rejected rather than displayed as a value", () => {
  const nonsense = htr.normalizeRecognition({
    columnId: "notes",
    candidates: [{text: "cYanmGntalowb", confidence: 0.999, votes: 3}],
  });
  assert.equal(nonsense.disposition, "REJECTED");
  assert.equal(nonsense.selectedValue, "");
  assert.equal(nonsense.suggestedValue, "");

  const fragment = htr.normalizeRecognition({
    columnId: "vehicleId",
    candidates: [{text: "KA", confidence: 0.999, votes: 3}],
  });
  assert.equal(fragment.disposition, "REJECTED");
  assert.equal(fragment.selectedValue, "");
});

test("high-confidence consensus can auto-accept a field-valid structured value", () => {
  const value = htr.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "11N", confidence: 0.9997, votes: 3}],
  }, {canonicalSlots: ["11N"]});
  assert.equal(value.disposition, "AUTO_ACCEPTED");
  assert.equal(value.selectedValue, "11N");
  assert.equal(value.suggestedValue, "");
  assert.equal(value.needsReview, false);
});

test("catalog-confirmed occurrence marks remain image-derived and ambiguous bases await document context", () => {
  const catalog = ["802¹", "802²"];
  const explicitOccurrence = htr.normalizeRecognition({
    columnId: "toTrain",
    candidates: [{text: "8021", confidence: 0.98, votes: 3, sourceLayer: "PRINT_OCR"}],
  }, {trainCatalog: catalog});
  assert.equal(explicitOccurrence.disposition, "AUTO_ACCEPTED");
  assert.equal(explicitOccurrence.selectedValue, "802¹");

  const ambiguousBase = htr.normalizeRecognition({
    columnId: "toTrain",
    candidates: [{text: "802", confidence: 0.98, votes: 3, sourceLayer: "PRINT_OCR"}],
  }, {trainCatalog: catalog});
  assert.equal(ambiguousBase.disposition, "REVIEW_SUGGESTION");
  assert.equal(ambiguousBase.selectedValue, "");
  assert.equal(ambiguousBase.suggestedValue, "802");
});

test("a clearly dominant field-specific segment may pass without weakening generic single-pass abstention", () => {
  const segment = htr.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "11N", confidence: 0.95, votes: 1, sourceLayer: "STRUCTURED_SEGMENT_OCR"}],
  }, {canonicalSlots: ["11N"]});
  assert.equal(segment.disposition, "AUTO_ACCEPTED");
  assert.equal(segment.selectedValue, "11N");

  const generic = htr.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "11N", confidence: 0.95, votes: 1, sourceLayer: "HANDWRITING_HTR"}],
  }, {canonicalSlots: ["11N"]});
  assert.equal(generic.disposition, "REVIEW_SUGGESTION");
  assert.equal(generic.selectedValue, "");
});

test("human dispositions produce explicit ground truth and correction metrics", () => {
  const proposed = {
    columnId: "vehicleId",
    selectedValue: "",
    suggestedValue: "74-51",
    normalizedValue: "74-51",
    needsReview: true,
    disposition: "REVIEW_SUGGESTION",
  };
  const accepted = htr.applyHumanCorrection(proposed, "74-51", "ACCEPT_SUGGESTION");
  assert.equal(accepted.selectedValue, "74-51");
  assert.equal(accepted.humanDisposition, "ACCEPT_SUGGESTION");
  assert.equal(accepted.groundTruthSource, "HUMAN_CORRECTED_FORM");
  assert.equal(accepted.rawRecognizerIsGroundTruth, false);

  const blanked = htr.applyHumanCorrection(proposed, "", "LEAVE_BLANK");
  assert.equal(blanked.selectedValue, "");
  assert.equal(blanked.humanDisposition, "LEAVE_BLANK");

  const metrics = htr.computeCorrectionBurden([
    accepted,
    htr.applyHumanCorrection({...proposed, suggestedValue: "74-52"}, "74-53", "EDIT_VALUE"),
    blanked,
  ]);
  assert.deepEqual(metrics, {
    reviewedCellCount: 3,
    acceptedSuggestionCount: 1,
    editedCellCount: 1,
    leftBlankCount: 1,
    nonEmptyGroundTruthCells: 2,
    autoAcceptedCorrect: 0,
    autoAcceptedIncorrect: 0,
    reviewSuggestions: 3,
    emptyRejected: 0,
    manuallyChangedCells: 1,
    characterEditsRequired: 6,
    fieldsEnteredFromScratch: 0,
    manualCorrectionRate: 1 / 2,
    manualCellEditsRequiredRate: 1 / 2,
    characterEditDistancePerNonEmptyCell: 6 / 2,
  });
});

test("model gate is fail closed, requires document-disjoint holdout, and supports rollback", () => {
  const rejected = htr.evaluateModelCandidate({
    candidateModelSha256: "a".repeat(64),
    trainingDocumentIds: ["doc-a"],
    holdoutDocumentIds: ["doc-a"],
    structuredPrecision: 1,
    clearCellCoverage: 1,
    manualCorrectionRate: 0,
  });
  assert.equal(rejected.promotable, false);
  assert.equal(rejected.reasons.includes("HOLDOUT_LEAKAGE"), true);

  const accepted = htr.evaluateModelCandidate({
    candidateModelSha256: "b".repeat(64),
    trainingDocumentIds: ["doc-a"],
    holdoutDocumentIds: ["doc-b"],
    structuredPrecision: 0.995,
    clearCellCoverage: 0.86,
    manualCorrectionRate: 0.09,
  });
  assert.equal(accepted.promotable, true);
  const registry = htr.promoteModelCandidate({activeModelSha256: "a".repeat(64), history: []}, accepted, {humanApproved: true});
  assert.equal(registry.activeModelSha256, "b".repeat(64));
  assert.equal(htr.rollbackModel(registry).activeModelSha256, "a".repeat(64));
});
