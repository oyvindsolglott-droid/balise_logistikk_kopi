"use strict";

const fs = require("node:fs");
const path = require("node:path");
const recognitionPath = path.resolve(process.argv[2]);
const runtimePath = path.resolve(process.argv[3]);
const workerPath = path.resolve(process.argv[4]);
const uiPath = path.resolve(process.argv[5]);

const htr = require(recognitionPath);
const recognition = fs.readFileSync(recognitionPath, "utf8");
const runtime = fs.readFileSync(runtimePath, "utf8");
const worker = fs.readFileSync(workerPath, "utf8");
const ui = fs.readFileSync(uiPath, "utf8");
const results = [];

function invariant(id, description, test){
  try{
    if(!test()) throw new Error(description);
    results.push({id, status: "PASS", description});
  }catch(error){
    results.push({id, status: "FAIL", description, error: String(error?.message || error)});
  }
}

function registration(){
  return htr.registerTemplate({
    imageWidth: 1200,
    imageHeight: 1500,
    quadrilateral: [{x: 30, y: 20}, {x: 1170, y: 35}, {x: 1190, y: 1480}, {x: 15, y: 1460}],
  });
}

invariant("INV-HTR-001", "all handwritten cells use the explicit HTR layer", () => {
  const requests = htr.createRecognitionRequests(registration());
  return requests.length === 177 && requests.every(request => request.recognizerKind === "HANDWRITING")
    && worker.includes('import * as ort from "./assets/vendor/onnxruntime-web/ort.wasm.min.mjs"');
});

invariant("INV-HTR-002", "the UI maps the actual HTR result instead of bypassing the HTR runtime", () =>
  ui.includes("htrRuntime.mapResultToNightPlan(result, {")
  && runtime.includes("createLocalHandwritingAnalyzer")
  && !ui.includes("logic.mapOcrResultToNightPlan(result, {")
);

invariant("INV-HTR-003", "perspective correction is applied before fixed-form segmentation", () => {
  const value = registration();
  return value.perspectiveCorrectionApplied === true
    && value.perspective.applied === true
    && worker.indexOf("registerTemplate(") < worker.indexOf("createRecognitionRequests(");
});

invariant("INV-HTR-004", "cell crops and boxes stay in original-image coordinates", () => {
  const value = registration();
  return value.cells.every(cell => cell.boundingBox.coordinateSpace === "ORIGINAL_IMAGE")
    && worker.includes("registration.perspective.inverse, request")
    && worker.includes("cellInputTensor(pixels, width, height");
});

invariant("INV-HTR-005", "the 29 row indexes are stable and zero-based", () => {
  const rows = [...new Set(registration().cells.map(cell => cell.rowIndex))];
  return JSON.stringify(rows) === JSON.stringify(Array.from({length: 29}, (_unused, index) => index));
});

invariant("INV-HTR-006", "the six columns retain canonical order", () => {
  const columns = [...new Set(registration().cells.map(cell => cell.columnId))];
  return JSON.stringify(columns) === JSON.stringify(htr.COLUMN_IDS);
});

invariant("INV-HTR-007", "recognition processes and reports the complete 29 x 6 table", () =>
  worker.includes("for(let index = 0; index < requests.length; index += 1)")
  && worker.includes("const tableCells = cells.filter(cell => cell.rowIndex != null);")
  && !worker.includes("cells.filter(cell => cell.rowIndex != null).slice(0, 1)")
);

invariant("INV-HTR-008", "uncertain free handwriting is review-marked rather than auto-accepted", () => {
  const value = htr.normalizeRecognition({columnId: "notes", candidates: [{text: "mulig tekst", confidence: 0.5}]});
  return value.selectedValue === "mulig tekst" && value.needsReview === true;
});

invariant("INV-HTR-009", "recognition has no previous-plan or historical-value fallback", () =>
  !/(previousPlanValue|historicalValue|previous_plan_value|historical_value)/.test(recognition)
);

invariant("INV-HTR-010", "recognition contains no hardcoded concrete vehicle number", () =>
  !/\b\d{2}-\d{2}\b/.test(recognition)
);

invariant("INV-HTR-011", "slot normalization remains bound to the injected canonical register", () => {
  const value = htr.normalizeRecognition({columnId: "toTrack", candidates: [{text: "13N", confidence: 0.99}]}, {canonicalSlots: ["12N", "12S"]});
  return value.selectedValue === "" && value.needsReview === true;
});

invariant("INV-HTR-012", "human correction is the only learning ground truth", () => {
  const value = htr.applyHumanCorrection({recognizedText: "73-2G", selectedValue: "", needsReview: true}, "73-26");
  return value.selectedValue === "73-26" && value.groundTruthSource === "HUMAN_CORRECTED_FORM"
    && value.rawRecognizerIsGroundTruth === false && ui.includes("correctedMappingReport(form)");
});

invariant("INV-HTR-013", "unsaved HTR data is not written to browser persistence", () =>
  !/localStorage\.setItem\(["']sde_htr|sessionStorage\.setItem\(["']sde_htr|indexedDB\.open\(["']sde_htr/.test(ui)
  && !/localStorage|sessionStorage|indexedDB|caches\.open/.test(recognition)
  && !/localStorage|sessionStorage|indexedDB|caches\.open/.test(runtime)
  && !/localStorage|sessionStorage|indexedDB|caches\.open/.test(worker)
);

invariant("INV-HTR-014", "import success is impossible before HTR completion", () => {
  const report = htr.buildMappingReport({
    htrCompleted: false,
    registrationStatus: "CELLS_SEGMENTED",
    cells: [{selectedValue: "991"}, {selectedValue: "73-26"}],
  });
  return report.mappingStatus === "RECOGNITION_FAILED"
    && ui.includes('setImportState("IMAGE_PREPROCESSING", null);');
});

invariant("INV-HTR-015", "model and dictionary bytes are SHA-256 verified before inference", () =>
  recognition.includes('throw new Error("model_hash_mismatch")')
  && worker.includes("await htr.verifyModelBytes(modelBytes")
  && worker.includes("await htr.verifyModelBytes(dictionaryBytes")
  && worker.indexOf("verifyModelBytes(modelBytes") < worker.indexOf("InferenceSession.create(modelBytes")
);

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-handwriting-recognition-invariants-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
