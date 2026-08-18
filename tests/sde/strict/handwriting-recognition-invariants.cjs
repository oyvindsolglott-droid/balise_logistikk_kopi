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

function photographedFormWithEdgeShadow(){
  const width = 360;
  const height = 480;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const shade = (x, y, value = 30) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  };
  const rules = [18, 58, 104, 148, 191, 229, 342];
  const slopes = [0.055, 0.045, 0.034, 0.022, 0.01, -0.002, -0.025];
  for(let rule = 0; rule < rules.length; rule += 1){
    const startY = rule === 0 || rule === rules.length - 1 ? 10 : 88;
    for(let y = startY; y <= 466; y += 1){
      const x = rules[rule] + slopes[rule] * (y - 96);
      shade(x - 1, y);
      shade(x, y);
      shade(x + 1, y);
    }
  }
  for(let x = 13; x <= 344; x += 1) shade(x, 10 + ((344 - x) * 0.018));
  for(let row = 0; row < 30; row += 1){
    const y = 88 + ((row / 29) * 378);
    const left = rules[0] + slopes[0] * (y - 96);
    const right = rules.at(-1) + slopes.at(-1) * (y - 96);
    for(let x = Math.round(left); x <= Math.round(right); x += 1) shade(x, y);
  }
  for(let y = 180; y < height; y += 1){
    for(let x = 0; x < Math.min(12, Math.floor((y - 180) / 20)); x += 1) shade(x, y, 0);
  }
  return {width, height, pixels};
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
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
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

invariant("INV-HTR-016", "the complete seven-rule and thirty-row form grid wins over a camera-edge shadow", () => {
  const detected = htr.detectFormRegistration(photographedFormWithEdgeShadow());
  return detected.source === "FORM_GRID_RULE_SEQUENCE"
    && detected.verticalLineCount === 7
    && detected.horizontalLineCount === 30
    && detected.canonicalRowBoundaries.length === 30
    && detected.canonicalRowBoundaries.every((value, index, values) => index === 0 || value > values[index - 1]);
});

invariant("INV-HTR-017", "the worker refuses fallback registration and uses the image-derived row boundaries", () =>
  worker.includes('detected.source !== "FORM_GRID_RULE_SEQUENCE"')
  && worker.includes("detected.verticalLineCount !== 7")
  && worker.includes("rowBoundaries: detected.canonicalRowBoundaries,")
);

invariant("INV-HTR-018", "cell crops preserve edge handwriting and run three structured-field preprocessing passes", () =>
  worker.includes("boxWidth * (cell.columnId === \"notes\" ? 0.012 : 0.02)")
  && worker.includes("boxHeight * 0.055")
  && worker.includes("const tensors = Object.freeze([")
  && worker.includes("binaryDark")
  && worker.includes("binaryFaint")
  && worker.includes("crop.tensors")
  && worker.includes("suppressGridLinePixels(grayscale, resizedWidth, 48)")
  && worker.includes("x1: box.x1 - xPadding")
);

invariant("INV-HTR-019", "a candidate seen in only one preprocessing pass cannot become high confidence", () =>
  worker.includes("candidate.votes >= 2 ? candidate.confidence : Math.min(candidate.confidence, 0.84)")
);

invariant("INV-HTR-020", "plausible but imperfect identifiers stay review-marked", () => {
  const train = htr.normalizeRecognition({columnId: "toTrain", candidates: [{text: "765", confidence: 0.994}]});
  const vehicle = htr.normalizeRecognition({columnId: "vehicleId", candidates: [{text: "73-26", confidence: 0.979}]});
  return train.selectedValue === "765" && train.needsReview === true
    && vehicle.selectedValue === "73-26" && vehicle.needsReview === true;
});

invariant("INV-HTR-021", "progress states distinguish preprocessing, registration, segmentation, and recognition", () =>
  worker.includes('status: "IMAGE_PREPROCESSING"')
  && worker.includes('status: "FORM_REGISTRATION_COMPLETE"')
  && worker.includes('status: "CELL_SEGMENTATION_COMPLETE"')
  && worker.includes('status: "HANDWRITING_RECOGNITION_RUNNING"')
);

invariant("INV-HTR-022", "vehicle separators and canonical track suffixes survive normalization", () => {
  const vehicle = htr.normalizeRecognition({columnId: "vehicleId", candidates: [{text: "7326", confidence: 1}]});
  const track = htr.normalizeRecognition({columnId: "toTrack", candidates: [{text: "11N", confidence: 1}]}, {canonicalSlots: ["11N"]});
  return vehicle.selectedValue === "73-26" && track.selectedValue === "11N";
});

invariant("INV-HTR-023", "each mapped cell carries auditable candidates, source coordinates, confidence, and normalization reason", () =>
  worker.includes("rawCandidates:")
  && worker.includes("sourceBoundingBox: request.boundingBox")
  && worker.includes("normalizationReason:")
  && recognition.includes("COMPETING_IMAGE_CANDIDATES")
);

invariant("INV-HTR-024", "decoding preserves complete text lines instead of one glyph or one token", () =>
  worker.includes("Math.ceil(48 * ratio)")
  && worker.includes('text += characters[bestIndex] || ""')
);

invariant("INV-HTR-025", "the recognized plan remains in form state through mapping", () =>
  ui.includes("draft = plan;")
  && ui.includes("setImportState(draft.ocrMapping.mappingStatus, draft.ocrMapping);")
);

invariant("INV-HTR-026", "a replacement image starts empty and cannot retain the previous import", () => {
  const first = htr.recordRecognition(htr.createRecognitionSession("first"), {selectedValue: "991"});
  const second = htr.replaceRecognitionImage(first, "second");
  return second.sourceImageFingerprint === "second" && second.cells.length === 0 && second.status === "IMAGE_PREPROCESSING";
});

invariant("INV-HTR-027", "catalogs and slot registers validate but never invent absent image candidates", () => {
  const vehicle = htr.normalizeRecognition({columnId: "vehicleId", candidates: []}, {vehicleCatalog: ["73-26"]});
  const track = htr.normalizeRecognition({columnId: "toTrack", candidates: []}, {canonicalSlots: ["11N"]});
  return vehicle.selectedValue === "" && vehicle.needsReview === true
    && track.selectedValue === "" && track.needsReview === true;
});

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-handwriting-recognition-invariants-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
