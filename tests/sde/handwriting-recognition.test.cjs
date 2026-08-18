"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");

const root = path.resolve(__dirname, "../..");
const modulePath = path.join(root, "sde_handwriting_recognition.js");

function loadSubject(){
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("HTR-pipelinen er eksplisitt, lokal og kjører før formmapping", () => {
  const subject = loadSubject();
  assert.deepEqual(subject.PIPELINE_STAGES, [
    "IMAGE",
    "ORIENTATION",
    "PERSPECTIVE_CORRECTION",
    "TEMPLATE_REGISTRATION",
    "CELL_SEGMENTATION",
    "HANDWRITING_RECOGNITION",
    "FIELD_NORMALIZATION",
    "FORM_MAPPING",
  ]);
  assert.equal(subject.MODEL_SPEC.id, "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx");
  assert.equal(subject.MODEL_SPEC.revision, "89d3a50e2c27e2e7cceeab0e944c25c807d5db4f");
  assert.equal(subject.MODEL_SPEC.modelSha256, "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498");
  assert.equal(subject.MODEL_SPEC.runtime, "onnxruntime-web@1.27.0");
  assert.equal(subject.MODEL_SPEC.remoteModelsAllowed, false);
  assert.equal(subject.MODEL_SPEC.handwritingCapable, true);
});

test("perspektivtransformen registrerer fire hjørner og bevarer originalkoordinater", () => {
  const subject = loadSubject();
  const original = [
    {x: 42, y: 31},
    {x: 1110, y: 12},
    {x: 1072, y: 1340},
    {x: 74, y: 1328},
  ];
  const canonical = [
    {x: 0, y: 0},
    {x: 1200, y: 0},
    {x: 1200, y: 1500},
    {x: 0, y: 1500},
  ];
  const transform = subject.createPerspectiveTransform(original, canonical);
  for(let index = 0; index < 4; index += 1){
    const mapped = subject.projectPoint(transform.forward, original[index]);
    const restored = subject.projectPoint(transform.inverse, mapped);
    assert.ok(Math.abs(mapped.x - canonical[index].x) < 1e-6);
    assert.ok(Math.abs(mapped.y - canonical[index].y) < 1e-6);
    assert.ok(Math.abs(restored.x - original[index].x) < 1e-6);
    assert.ok(Math.abs(restored.y - original[index].y) < 1e-6);
  }
  assert.equal(transform.applied, true);
});

test("malregistrering gir nøyaktig 29 x 6 stabile håndskriftceller", () => {
  const subject = loadSubject();
  const quadrilateral = [
    {x: 18, y: 21}, {x: 1182, y: 8}, {x: 1161, y: 1488}, {x: 31, y: 1494},
  ];
  const registration = subject.registerTemplate({
    imageWidth: 1200,
    imageHeight: 1500,
    quadrilateral,
  });
  assert.equal(registration.status, "FORM_DETECTED");
  assert.equal(registration.perspectiveCorrectionApplied, true);
  assert.equal(registration.cells.length, 29 * 6);
  assert.equal(registration.metadataCells.length, 3);
  assert.deepEqual([...new Set(registration.cells.map(cell => cell.rowIndex))], Array.from({length: 29}, (_, i) => i));
  assert.deepEqual([...new Set(registration.cells.map(cell => cell.columnId))], subject.COLUMN_IDS);
  for(const cell of registration.cells){
    assert.equal(cell.boundingBox.coordinateSpace, "ORIGINAL_IMAGE");
    assert.ok(cell.boundingBox.x1 > cell.boundingBox.x0);
    assert.ok(cell.boundingBox.y1 > cell.boundingBox.y0);
  }
  const rowSeven = registration.cells.filter(cell => cell.rowIndex === 6);
  const rowEight = registration.cells.filter(cell => cell.rowIndex === 7);
  assert.equal(Math.max(...rowSeven.map(cell => cell.canonicalBox.y1)) <= Math.min(...rowEight.map(cell => cell.canonicalBox.y0)), true);
});

test("alle utfyllbare felt bruker HTR mens trykte labels ikke sendes til recognizer", () => {
  const subject = loadSubject();
  const registration = subject.registerTemplate({imageWidth: 1200, imageHeight: 1500});
  const requests = subject.createRecognitionRequests(registration);
  assert.equal(requests.length, (29 * 6) + 3);
  assert.equal(requests.every(request => request.recognizerKind === "HANDWRITING"), true);
  assert.equal(requests.some(request => request.columnId === "notes" && request.normalizer === "FREE_TEXT"), true);
  assert.equal(requests.some(request => request.columnId === "wcWater" && request.normalizer === "WC_WATER_SYMBOL"), true);
  assert.equal(requests.some(request => /header|label/i.test(request.columnId)), false);
});

test("feltspesifikk normalisering rangerer bare bildebaserte kandidater", () => {
  const subject = loadSubject();
  const slots = ["3M", "4S", "4N", "6S", "6N", "11N"];
  const vehicle = subject.normalizeRecognition({
    columnId: "vehicleId",
    candidates: [{text: "74-5l", confidence: 0.91}, {text: "74-51", confidence: 0.86}],
  }, {canonicalSlots: slots, vehicleCatalog: ["74-51", "74-57"]});
  assert.equal(vehicle.selectedValue, "74-51");
  assert.equal(vehicle.alternatives.includes("74-57"), false, "catalog entries without image candidates cannot be invented");

  const slot = subject.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "11n", confidence: 0.93}, {text: "1ln", confidence: 0.72}],
  }, {canonicalSlots: slots});
  assert.equal(slot.selectedValue, "11N");
  assert.equal(slot.validationState, "VALID");

  const unsupported = subject.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "13N", confidence: 0.99}],
  }, {canonicalSlots: slots});
  assert.equal(unsupported.selectedValue, "");
  assert.equal(unsupported.needsReview, true);
  assert.equal(unsupported.validationState, "UNSUPPORTED");
});

test("fri merknad forblir fri, symbolfelt er symbolsk og uleselig innhold gjettes ikke", () => {
  const subject = loadSubject();
  const note = subject.normalizeRecognition({
    columnId: "notes",
    candidates: [{text: "Kontrolleres i morgen", confidence: 0.88}],
  });
  assert.equal(note.selectedValue, "Kontrolleres i morgen");
  assert.equal(note.normalizer, "FREE_TEXT");

  const symbol = subject.normalizeRecognition({
    columnId: "wcWater",
    candidates: [{text: "(*)", confidence: 0.87}],
  });
  assert.equal(symbol.selectedValue, "*");
  assert.equal(symbol.normalizer, "WC_WATER_SYMBOL");

  const unreadable = subject.normalizeRecognition({
    columnId: "vehicleId",
    candidates: [{text: "", confidence: 0.19}],
  }, {vehicleCatalog: ["74-08", "74-38"]});
  assert.equal(unreadable.selectedValue, "");
  assert.equal(unreadable.needsReview, true);
  assert.deepEqual(unreadable.alternatives, []);
});

test("komplett import krever ferdig HTR, flere celler og sannferdig reviewstatus", () => {
  const subject = loadSubject();
  const metadataCells = ["date", "signature", "ds"].map(columnId => ({columnId, selectedValue: "test", confidence: 0.99, needsReview: false}));
  const completeCells = Array.from({length: 29 * 6}, (_unused, index) => ({
    selectedValue: index < 3 ? ["991", "73-26", "4N"][index] : "",
    confidence: 0.99,
    needsReview: false,
  }));
  const before = subject.buildMappingReport({htrCompleted: false, cells: []});
  assert.notEqual(before.mappingStatus, "FORM_MAPPING_COMPLETE");
  const onlyOne = subject.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELLS_SEGMENTED",
    cells: [{selectedValue: "8S", confidence: 0.99, needsReview: false}],
  });
  assert.notEqual(onlyOne.mappingStatus, "FORM_MAPPING_COMPLETE");
  const reviewed = subject.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELLS_SEGMENTED",
    cells: completeCells,
    metadataCells,
  });
  assert.equal(reviewed.mappingStatus, "FORM_MAPPING_COMPLETE");
  const uncertain = subject.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELLS_SEGMENTED",
    cells: completeCells.map((cell, index) => index === 1 ? {...cell, needsReview: true, confidence: 0.2} : cell),
    metadataCells,
  });
  assert.equal(uncertain.mappingStatus, "FORM_MAPPING_REQUIRES_REVIEW");
});

test("menneskelig kontroll er autoritativt learning-ground-truth", () => {
  const subject = loadSubject();
  const recognizerCell = {
    rowIndex: 4,
    columnId: "vehicleId",
    recognizedText: "73-2G",
    normalizedValue: "",
    selectedValue: "",
    confidence: 0.41,
    alternatives: ["73-26"],
    needsReview: true,
    recognizerVersion: subject.MODEL_SPEC.version,
  };
  const corrected = subject.applyHumanCorrection(recognizerCell, "73-26");
  assert.equal(corrected.recognizedText, "73-2G");
  assert.equal(corrected.humanFinalValue, "73-26");
  assert.equal(corrected.selectedValue, "73-26");
  assert.equal(corrected.needsReview, false);
  assert.equal(corrected.groundTruthSource, "HUMAN_CORRECTED_FORM");
  assert.equal(corrected.rawRecognizerIsGroundTruth, false);
});

test("to gjeldende bildekjøringer kan ikke lekke verdier mellom hverandre", () => {
  const subject = loadSubject();
  const first = subject.createRecognitionSession("sha256:image-a");
  const withResult = subject.recordRecognition(first, {rowIndex: 0, columnId: "vehicleId", selectedValue: "73-26"});
  const second = subject.replaceRecognitionImage(withResult, "sha256:image-b");
  assert.equal(second.sourceImageFingerprint, "sha256:image-b");
  assert.deepEqual(second.cells, []);
  assert.equal(JSON.stringify(second).includes("73-26"), false);
});

test("modellmanifest verifiseres med SHA-256 og krever Safari-kompatibel WASM", async () => {
  const subject = loadSubject();
  const bytes = Buffer.from("pinned-local-model");
  const manifest = {
    modelSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    runtimeVersion: "1.27.0",
    executionProvider: "wasm",
  };
  assert.equal(await subject.verifyModelBytes(bytes, manifest), true);
  await assert.rejects(() => subject.verifyModelBytes(Buffer.from("changed"), manifest), /model_hash_mismatch/);
  assert.equal(subject.supportsLocalRuntime({Worker: function(){}, WebAssembly: {}, crypto: {subtle: {digest(){}}}}), true);
  assert.equal(subject.supportsLocalRuntime({Worker: function(){}, WebAssembly: null, crypto: {subtle: {digest(){}}}}), false);
  assert.equal(subject.MODEL_SPEC.executionProvider, "wasm");
  assert.equal(subject.MODEL_SPEC.requiresWebGpu, false);
});

test("HTR-modulen har ingen persistens-, sky-OCR- eller designverdi-fallback", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  for(const forbidden of ["localStorage", "sessionStorage", "indexedDB", "caches.open", "cloud ocr", "74-08", "74-38"]){
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(/previous(?:Plan|Value)|historical(?:Plan|Value)/.test(source), false);
});
