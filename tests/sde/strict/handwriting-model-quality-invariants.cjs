"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [recognitionFile, workerFile, uiFile, storageFile, learningFile, gitignoreFile] = process.argv.slice(2).map(file => path.resolve(file));
const recognition = fs.readFileSync(recognitionFile, "utf8");
const worker = fs.readFileSync(workerFile, "utf8");
const ui = fs.readFileSync(uiFile, "utf8");
const storage = fs.readFileSync(storageFile, "utf8");
const learning = fs.readFileSync(learningFile, "utf8");
const gitignore = fs.readFileSync(gitignoreFile, "utf8");
delete require.cache[recognitionFile];
const htr = require(recognitionFile);
const results = [];

function invariant(id, description, check){
  try{
    if(!check()) throw new Error(description);
    results.push({id, status: "PASS", description});
  }catch(error){
    results.push({id, status: "FAIL", description, error: String(error?.message || error)});
  }
}

function frame(width, height, points, maskPoints = []){
  const image = new Uint8Array(width * height).fill(255);
  const gridMask = new Uint8Array(width * height);
  for(const [x, y] of points) image[(y * width) + x] = 0;
  for(const [x, y] of maskPoints) gridMask[(y * width) + x] = 1;
  return {image, gridMask, width, height};
}

invariant("INV-MQ-001", "blank cells terminate before any recognizer invocation", () =>
  worker.includes("if(crop.blank){")
  && worker.indexOf("if(crop.blank){") < worker.indexOf("await recognizeLayer(runtime, crop.printTensors")
  && worker.includes("cells.push(emptyCellResult(request, crop.inkRatio));")
);

invariant("INV-MQ-002", "grid-only ink is excluded by the blank classifier", () => {
  const points = [];
  for(let x = 2; x < 62; x += 1) points.push([x, 3], [x, 28]);
  for(let y = 3; y <= 28; y += 1) points.push([3, y], [60, y]);
  const sample = frame(64, 32, points, points);
  return htr.classifyBlankCell(sample).blank === true
    && recognition.includes("if(gridMask?.[index] || Number(image[index]) >= darkThreshold) continue;");
});

invariant("INV-MQ-003", "a real handwriting model is active alongside, not replaced by, print OCR", () =>
  worker.includes('const HTR_MODEL_ROOT = "assets/models/gigapdf-ocr-handwriting/";')
  && worker.includes("htrSession") && worker.includes("printSession")
  && recognition.includes('recognizerKind: "LOCAL_REAL_HTR_ENSEMBLE"')
);

invariant("INV-MQ-004", "low-confidence recognizer output cannot write canonical form state", () => {
  const value = htr.normalizeRecognition({columnId: "vehicleId", candidates: [{text: "7351", confidence: 0.2, votes: 1}]});
  return value.selectedValue === "" && value.disposition !== "AUTO_ACCEPTED";
});

invariant("INV-MQ-005", "review suggestions remain separate from rendered canonical values", () =>
  ui.includes('Object.hasOwn(field, "selectedValue") ? field.selectedValue || "" : field.normalizedValue || ""')
  && ui.includes('placeholder=\\"Forslag: ')
  && ui.includes('if (action === "ACCEPT_SUGGESTION")')
);

invariant("INV-MQ-006", "gibberish is rejected instead of becoming form content", () => {
  const value = htr.normalizeRecognition({columnId: "notes", candidates: [{text: "cYanmGntalowb", confidence: 1, votes: 4}]});
  return value.disposition === "REJECTED" && value.selectedValue === "" && value.suggestedValue === "";
});

invariant("INV-MQ-007", "vehicle identifiers preserve the canonical hyphen", () =>
  htr.normalizeRecognition({columnId: "vehicleId", candidates: [{text: "7351", confidence: 1, votes: 3}]}).selectedValue === "73-51"
);

invariant("INV-MQ-008", "track suffixes remain present", () =>
  htr.normalizeRecognition({columnId: "toTrack", candidates: [{text: "11N", confidence: 1, votes: 3}]}, {canonicalSlots: ["11N"]}).selectedValue === "11N"
);

invariant("INV-MQ-009", "track arrows survive field decoding", () =>
  htr.normalizeRecognition({columnId: "toTrack", candidates: [{text: "6N->3M", confidence: 1, votes: 3}]}, {canonicalSlots: ["3M"]}).selectedValue === "6N→3M"
);

invariant("INV-MQ-010", "a new import replaces all previous recognition state", () => {
  const first = htr.recordRecognition(htr.createRecognitionSession("first"), {selectedValue: "synthetic"});
  const second = htr.replaceRecognitionImage(first, "second");
  return second.sourceImageFingerprint === "second" && second.cells.length === 0
    && ui.includes("releaseSelectedImage();\n    draft = makeManualDraft();");
});

invariant("INV-MQ-011", "raw recognizer output is never ground truth", () => {
  const corrected = htr.applyHumanCorrection({selectedValue: "", suggestedValue: "synthetic", disposition: "REVIEW_SUGGESTION"}, "human");
  return corrected.rawRecognizerIsGroundTruth === false
    && corrected.groundTruthSource === "HUMAN_CORRECTED_FORM"
    && storage.includes("raw_recognizer_ground_truth_forbidden");
});

invariant("INV-MQ-012", "human correction and learning outcome are retained", () => {
  const corrected = htr.applyHumanCorrection({selectedValue: "", suggestedValue: "synthetic", disposition: "REVIEW_SUGGESTION"}, "human");
  return corrected.humanFinalValue === "human" && corrected.learningOutcome === "CORRECTED"
    && storage.includes('learningSource: "HUMAN_CORRECTED_FORM"');
});

invariant("INV-MQ-013", "training refuses a blind-holdout document overlap", () =>
  learning.includes("train_documents & holdout_documents")
  && learning.includes('reasons.append("HOLDOUT_LEAKAGE")')
  && htr.evaluateModelCandidate({candidateModelSha256: "a".repeat(64), trainingDocumentIds: ["d"], holdoutDocumentIds: ["d"], structuredPrecision: 1, clearCellCoverage: 1, manualCorrectionRate: 0}).promotable === false
);

invariant("INV-MQ-014", "model promotion requires both a green gate and matching human SHA approval", () => {
  let refused = false;
  try{ htr.promoteModelCandidate({activeModelSha256: "a".repeat(64)}, {promotable: false, candidateModelSha256: "b".repeat(64)}, {humanApproved: true}); }
  catch(_error){ refused = true; }
  return refused && learning.includes('qualification.get("gate") != "GREEN" or args.approved_sha != candidate_hash');
});

invariant("INV-MQ-015", "model and dictionary hashes are verified before inference", () =>
  worker.includes('await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["model.onnx"]});')
  && worker.includes('await htr.verifyModelBytes(dictionaryBytes, {modelSha256: manifest.files["dict.txt"]});')
  && worker.indexOf("verifyModelBytes(modelBytes") < worker.indexOf("InferenceSession.create(modelBytes")
);

invariant("INV-MQ-016", "private crops and learning examples are excluded from Git", () =>
  gitignore.includes(".sde-private-handwriting/")
  && gitignore.includes("private/sde-handwriting/")
  && gitignore.includes("tests/sde/fixtures/handwriting-private/")
  && gitignore.includes("*handwriting-learning-example*")
);

invariant("INV-MQ-017", "real correction burden is calculated and validated", () => {
  const base = {selectedValue: "", suggestedValue: "ab", disposition: "REVIEW_SUGGESTION"};
  const metric = htr.computeCorrectionBurden([htr.applyHumanCorrection(base, "ac", "EDIT_VALUE")]);
  return metric.manuallyChangedCells === 1 && metric.characterEditsRequired === 1
    && metric.manualCellEditsRequiredRate === 1
    && ui.includes("htrLogic.computeCorrectionBurden([...cells, ...metadataCells])")
    && storage.includes('"manualCorrectionRate", "manualCellEditsRequiredRate", "characterEditDistancePerNonEmptyCell"');
});

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-handwriting-model-quality-invariants-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
