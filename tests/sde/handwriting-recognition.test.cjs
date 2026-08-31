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

function syntheticPhotographedForm(){
  const width = 360;
  const height = 480;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for(let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  const shade = (x, y, value = 30) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
  };
  const outer = [18, 58, 104, 148, 191, 229, 342];
  const slopes = [0.055, 0.045, 0.034, 0.022, 0.01, -0.002, -0.025];
  for(let line = 0; line < outer.length; line += 1){
    const startY = line === 0 || line === outer.length - 1 ? 10 : 88;
    for(let y = startY; y <= 466; y += 1){
      const x = outer[line] + slopes[line] * (y - 96);
      shade(x - 1, y);
      shade(x, y);
      shade(x + 1, y);
    }
  }
  for(let x = 13; x <= 344; x += 1) shade(x, 10 + ((344 - x) * 0.018));
  for(let row = 0; row < 30; row += 1){
    const ratio = row / 29;
    const y = 88 + (ratio * 378);
    const left = outer[0] + slopes[0] * (y - 96);
    const right = outer.at(-1) + slopes.at(-1) * (y - 96);
    for(let x = Math.round(left); x <= Math.round(right); x += 1) shade(x, y);
  }
  // A camera-edge/shadow distractor must not replace the seven-rule form grid.
  for(let y = 180; y < height; y += 1){
    for(let x = 0; x < Math.min(12, Math.floor((y - 180) / 20)); x += 1) shade(x, y, 0);
  }
  return {width, height, pixels};
}

function syntheticPhotographedTemplateB({omittedRules = [], horizontalBoundaryCount = 30} = {}){
  const width = 420;
  const height = 560;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for(let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  const shade = (x, y, value = 30) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
  };
  const rules = [17, 44, 73, 110, 144, 180, 220, 316, 407];
  const slopes = [0.045, 0.038, 0.03, 0.022, 0.014, 0.006, -0.002, -0.011, -0.022];
  for(let rule = 0; rule < rules.length; rule += 1){
    if(omittedRules.includes(rule)) continue;
    const startY = rule === 0 || rule === rules.length - 1 ? 12 : 104;
    for(let y = startY; y <= 546; y += 1){
      const x = rules[rule] + slopes[rule] * (y - 110);
      shade(x - 1, y);
      shade(x, y);
      shade(x + 1, y);
    }
  }
  for(let x = 13; x <= 409; x += 1) shade(x, 12 + ((409 - x) * 0.014));
  for(let row = 0; row < horizontalBoundaryCount; row += 1){
    const y = 104 + ((row / Math.max(1, horizontalBoundaryCount - 1)) * 442);
    const left = rules[0] + slopes[0] * (y - 110);
    const right = rules.at(-1) + slopes.at(-1) * (y - 110);
    for(let x = Math.round(left); x <= Math.round(right); x += 1) shade(x, y);
  }
  return {width, height, pixels};
}

function syntheticTemplateAWithInteriorRuleDistractors(){
  const width = 1125;
  const height = 1358;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const shade = (x, y, value = 26) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
  };
  const templateARules = [18, 153, 306, 454, 598, 726, 1110];
  const narrowTemplateBLikeDistractors = [18, 66, 117, 182, 242, 305, 377, 545, 708];
  for(const x of templateARules){
    for(let y = 40; y <= 1320; y += 1){
      shade(x - 1, y);
      shade(x, y);
      shade(x + 1, y);
    }
  }
  for(const x of narrowTemplateBLikeDistractors){
    if(templateARules.some(rule => Math.abs(rule - x) <= 2)) continue;
    for(let y = 255; y <= 1320; y += 1) shade(x, y, 62);
  }
  for(let x = 18; x <= 1110; x += 1){
    shade(x, 40);
    shade(x, 1320);
  }
  for(let row = 0; row < 30; row += 1){
    const y = 255 + ((row / 29) * (1320 - 255));
    for(let x = 18; x <= 1110; x += 1) shade(x, y);
  }
  return {width, height, pixels};
}

test("HTR-pipelinen er eksplisitt, lokal og kjører før formmapping", () => {
  const subject = loadSubject();
  assert.deepEqual(subject.PIPELINE_STAGES, [
    "IMAGE",
    "ORIENTATION",
    "PERSPECTIVE_CORRECTION",
    "TEMPLATE_DETECTION",
    "TEMPLATE_REGISTRATION",
    "CELL_SEGMENTATION",
    "COLOR_LAYER_SEPARATION",
    "PRINTED_TEXT_RECOGNITION",
    "HANDWRITING_RECOGNITION",
    "FIELD_NORMALIZATION",
    "FORM_MAPPING",
  ]);
  assert.equal(subject.MODEL_SPEC.id, "ronylicha/gigapdf-ocr-handwriting");
  assert.equal(subject.MODEL_SPEC.revision, "9885c6b4022786860968e6f7be5ba50441cb395d");
  assert.equal(subject.MODEL_SPEC.modelSha256, "969d1899ed80afd51a1a37c888f0c239292738af9a1a08f6f4191f083565f5b3");
  assert.equal(subject.MODEL_SPEC.runtime, "onnxruntime-web@1.27.0");
  assert.equal(subject.MODEL_SPEC.remoteModelsAllowed, false);
  assert.equal(subject.MODEL_SPEC.handwritingCapable, true);
  assert.equal(subject.PRINT_MODEL_SPEC.id, "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx");
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

test("fotografert skjema registreres fra hele syvlinjers rutenett uten at kantskygge forskyver cellene", () => {
  const subject = loadSubject();
  const frame = syntheticPhotographedForm();
  const detected = subject.detectFormRegistration(frame);
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.verticalLineCount, 7);
  assert.equal(detected.horizontalLineCount, 30);
  assert.equal(detected.canonicalRowBoundaries.length, 30);
  assert.equal(detected.canonicalRowBoundaries.every((value, index, values) => index === 0 || value > values[index - 1]), true);
  assert.ok(detected.confidence >= 0.8);
  assert.ok(Math.abs(detected.corners[0].x - 13) < 8, JSON.stringify(detected));
  assert.ok(Math.abs(detected.corners[3].x - 38) < 8, JSON.stringify(detected));
  assert.ok(Math.abs(detected.corners[1].x - 344) < 8, JSON.stringify(detected));
  assert.ok(Math.abs(detected.corners[2].x - 333) < 8, JSON.stringify(detected));
});

test("Template A med bred Merknad-kolonne kan ikke avkortes til en smal ni-reglers Template B", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticTemplateAWithInteriorRuleDistractors());
  assert.equal(detected.templateId, "TEMPLATE_A", JSON.stringify(detected));
  assert.equal(detected.verticalLineCount, 7);
  assert.ok(detected.corners[1].x > 1000, JSON.stringify(detected));
  assert.ok(detected.corners[2].x > 1000, JSON.stringify(detected));
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
  assert.equal(registration.status, "FORM_REGISTRATION_COMPLETE");
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

test("alle utfyllbare felt bruker separate print-OCR- og HTR-spor mens labels ikke segmenteres som verdier", () => {
  const subject = loadSubject();
  const registration = subject.registerTemplate({imageWidth: 1200, imageHeight: 1500});
  const requests = subject.createRecognitionRequests(registration);
  assert.equal(requests.length, (29 * 6) + 3);
  assert.equal(requests.every(request => request.recognizerKind === "LOCAL_REAL_HTR_ENSEMBLE"), true);
  assert.equal(requests.every(request => request.recognizerKinds.includes("PRINT_OCR") && request.recognizerKinds.includes("HANDWRITING_HTR")), true);
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
  assert.equal(vehicle.suggestedValue, "");
  assert.equal(vehicle.alternatives.includes("74-57"), false, "catalog entries without image candidates cannot be invented");

  const slot = subject.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "11n", confidence: 0.93}, {text: "1ln", confidence: 0.72}],
  }, {canonicalSlots: slots});
  assert.equal(slot.selectedValue, "11N");
  assert.equal(slot.suggestedValue, "");
  assert.equal(slot.validationState, "VALID");

  const imagedArrow = subject.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "7O3N", confidence: 0.99, votes: 2}],
  }, {canonicalSlots: ["3N", "4S"]});
  assert.equal(imagedArrow.selectedValue, "7→3N");
  assert.equal(imagedArrow.validationState, "VALID");

  const unsupported = subject.normalizeRecognition({
    columnId: "toTrack",
    candidates: [{text: "13N", confidence: 0.99}],
  }, {canonicalSlots: slots});
  assert.equal(unsupported.selectedValue, "");
  assert.equal(unsupported.needsReview, true);
  assert.equal(unsupported.validationState, "REVIEW_REQUIRED");
});

test("plausible identifierforslag forblir review-merket ved vanlig modellkonfidens", () => {
  const subject = loadSubject();
  const train = subject.normalizeRecognition({
    columnId: "toTrain",
    candidates: [{text: "765", confidence: 0.979}],
  });
  const vehicle = subject.normalizeRecognition({
    columnId: "vehicleId",
    candidates: [{text: "73-26", confidence: 0.909}],
  });
  assert.equal(train.selectedValue, "");
  assert.equal(train.suggestedValue, "765");
  assert.equal(train.needsReview, true);
  assert.equal(vehicle.selectedValue, "");
  assert.equal(vehicle.suggestedValue, "73-26");
  assert.equal(vehicle.needsReview, true);
});

test("fri merknad forblir fri, symbolfelt er symbolsk og uleselig innhold gjettes ikke", () => {
  const subject = loadSubject();
  const note = subject.normalizeRecognition({
    columnId: "notes",
    candidates: [{text: "Kontrolleres i morgen", confidence: 0.88}],
  });
  assert.equal(note.selectedValue, "");
  assert.equal(note.suggestedValue, "Kontrolleres i morgen");
  assert.equal(note.normalizer, "FREE_TEXT");

  const symbol = subject.normalizeRecognition({
    columnId: "wcWater",
    candidates: [{text: "(*)", confidence: 0.87}],
  });
  assert.equal(symbol.selectedValue, "");
  assert.equal(symbol.suggestedValue, "*");
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
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    cells: [{selectedValue: "8S", confidence: 0.99, needsReview: false}],
  });
  assert.notEqual(onlyOne.mappingStatus, "FORM_MAPPING_COMPLETE");
  const reviewed = subject.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    cells: completeCells,
    metadataCells,
  });
  assert.equal(reviewed.mappingStatus, "FORM_MAPPING_COMPLETE");
  const uncertain = subject.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
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

test("HTR-cachekjeden er SHA-bundet fra hovedside til UI, worker og gjenkjenningsmodul", () => {
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const uiPath = path.join(root, "sde_night_planning_ui.js");
  const runtimePath = path.join(root, "sde_handwriting_runtime.js");
  const workerPath = path.join(root, "sde_handwriting_worker.js");
  const recognitionHash = crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex");
  const runtimeHash = crypto.createHash("sha256").update(fs.readFileSync(runtimePath)).digest("hex");
  const workerHash = crypto.createHash("sha256").update(fs.readFileSync(workerPath)).digest("hex");
  const uiHash = crypto.createHash("sha256").update(fs.readFileSync(uiPath)).digest("hex");
  assert.doesNotMatch(index, /<script[^>]+sde_handwriting_(?:recognition|runtime)\.js/);
  assert.match(fs.readFileSync(uiPath, "utf8"), new RegExp(`sde_handwriting_recognition\\.js\\?v=${recognitionHash}`));
  assert.match(fs.readFileSync(uiPath, "utf8"), new RegExp(`sde_handwriting_runtime\\.js\\?v=${runtimeHash}`));
  assert.match(fs.readFileSync(workerPath, "utf8"), new RegExp(`sde_handwriting_recognition\\.js\\?v=${recognitionHash}`));
  assert.match(fs.readFileSync(uiPath, "utf8"), new RegExp(`sde_handwriting_worker\\.js\\?v=${workerHash}`));
  assert.match(index, new RegExp(`sde_night_planning_ui\\.js\\?v=${uiHash}`));
});

test("malvariant klassifiseres eksplisitt fra struktur og trykte skjemabevis", () => {
  const subject = loadSubject();
  assert.equal(subject.detectTemplateVariant({
    title: "TOGPLASSERING SKIEN",
    printedHeaders: ["Fra Tog", "Til Tog", "Settnr", "Til spor", "Wc/vann", "Merknad"],
    metadataLabels: ["Dato", "Signatur", "ds"],
    verticalLineCount: 7,
  }).templateId, "TEMPLATE_A");
  assert.equal(subject.detectTemplateVariant({
    title: "TOGPLASSERING SKIEN",
    printedHeaders: ["Inn kl", "Fra Tog", "Til Tog", "Settnr", "Til spor", "WC/vann", "INFO", "Merknad"],
    metadataLabels: ["Klokken", "Dato", "Signatur"],
    verticalLineCount: 9,
  }).templateId, "TEMPLATE_B");
  assert.equal(subject.detectTemplateVariant({title: "ukjent", verticalLineCount: 8}).templateId, "TEMPLATE_UNKNOWN");
});

function syntheticPhotographedTemplateBWithClutter(){
  const width = 420;
  const height = 560;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for(let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  const shade = (x, y, value = 30) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
  };
  const rules = [17, 44, 73, 110, 144, 180, 220, 316, 407];
  const slopes = [0.045, 0.038, 0.03, 0.022, 0.014, 0.006, -0.002, -0.011, -0.022];
  for(let rule = 0; rule < rules.length; rule += 1){
    const startY = 18;
    for(let y = startY; y <= 520; y += 1){
      const x = rules[rule] + slopes[rule] * (y - 42);
      shade(x - 1, y);
      shade(x, y);
      shade(x + 1, y);
    }
  }
  const extraVerticals = [30, 95, 198, 258];
  for(const x of extraVerticals){
    for(let y = 210; y <= 280; y += 1) shade(x, y, 120);
  }
  for(let x = 16; x <= 406; x += 1) shade(x, 28);
  const topY = 42;
  const spacing = 16;
  for(let row = 0; row < 30; row += 1){
    const y = topY + (row * spacing);
    const left = rules[0] + slopes[0] * (y - 42);
    const right = rules.at(-1) + slopes.at(-1) * (y - 42);
    for(let x = Math.round(left); x <= Math.round(right); x += 1) shade(x, y, 30);
  }
  return {width, height, pixels};
}

function syntheticPhotographedTemplateBWithHeaderBands(){
  const frame = syntheticPhotographedTemplateB();
  const {width, height, pixels} = frame;
  const shade = (x, y, value = 30) => {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if(roundedX < 0 || roundedX >= width || roundedY < 0 || roundedY >= height) return;
    const offset = ((roundedY * width) + roundedX) * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
  };
  for(const y of [48, 72]){
    for(let x = 16; x <= 406; x += 1) shade(x, y, 30);
  }
  return frame;
}

test("tydelig fotografert skjema med ekstra vertikal støy og rader høyt i bildet registreres uten å gjette rader", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticPhotographedTemplateBWithClutter());
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.templateId, "TEMPLATE_B");
  assert.equal(detected.verticalLineCount, 9);
  assert.equal(detected.horizontalLineCount, 30);
  assert.equal(detected.rowGeometryStable, true);
  assert.ok(detected.confidence >= 0.55, JSON.stringify(detected));
  assert.equal(detected.canonicalRowBoundaries.length, 30);
});

test("trykt toppfelt over datanettet blir ikke rad 0 på fotografert Template B", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticPhotographedTemplateBWithHeaderBands());
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.templateId, "TEMPLATE_B");
  assert.equal(detected.horizontalLineCount, 30);
  assert.equal(detected.rowGeometryStable, true);
  const first = detected.canonicalRowBoundaries[0];
  const last = detected.canonicalRowBoundaries[29];
  const spacing = (last - first) / 29;
  assert.ok(first > 180, JSON.stringify({first, last, spacing}));
  const secondGap = detected.canonicalRowBoundaries[1] - first;
  assert.ok(Math.abs(secondGap - spacing) / spacing < 0.2, JSON.stringify({first, secondGap, spacing}));
});

test("fotografert Template B registreres som ni regler og 29 x 8 uten rad- eller kolonneforskyvning", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticPhotographedTemplateB());
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.templateId, "TEMPLATE_B");
  assert.equal(detected.verticalLineCount, 9);
  assert.equal(detected.horizontalLineCount, 30);
  const registration = subject.registerTemplate({
    imageWidth: 420,
    imageHeight: 560,
    templateId: detected.templateId,
    quadrilateral: detected.corners,
    rowBoundaries: detected.canonicalRowBoundaries,
  });
  assert.equal(registration.cells.length, 29 * 8);
  assert.deepEqual([...new Set(registration.cells.map(cell => cell.columnId))], subject.TEMPLATE_B_COLUMN_IDS);
  assert.deepEqual(registration.metadataCells.map(cell => cell.columnId), ["clock", "date", "signature"]);
});

test("Template B med én svak venstre ytterregel registreres bare fra komplett åttereglers indre sekvens", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticPhotographedTemplateB({omittedRules: [0]}));
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.templateId, "TEMPLATE_B");
  assert.equal(detected.verticalLineCount, 9);
  assert.equal(detected.observedVerticalLineCount, 8);
  assert.equal(detected.inferredVerticalBoundary, "LEFT");
  assert.equal(detected.horizontalLineCount, 30);
  assert.ok(detected.confidence >= 0.55, JSON.stringify(detected));

  const unsafe = subject.detectFormRegistration(syntheticPhotographedTemplateB({omittedRules: [0, 2]}));
  assert.equal(unsafe.source, "FORM_GRID_REGISTRATION_FAILED", JSON.stringify(unsafe));
  assert.equal(unsafe.templateId, "TEMPLATE_UNKNOWN");

  const inferredRight = subject.detectFormRegistration(syntheticPhotographedTemplateB({omittedRules: [8]}));
  assert.equal(inferredRight.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(inferredRight));
  assert.equal(inferredRight.templateId, "TEMPLATE_B");
  assert.equal(inferredRight.verticalLineCount, 9);
  assert.equal(inferredRight.observedVerticalLineCount, 8);
  assert.equal(inferredRight.inferredVerticalBoundary, "RIGHT");
  assert.equal(inferredRight.horizontalLineCount, 30);
});

test("Template B med ufullstendig radnett forblir fail-closed med konkret registreringsfeil", () => {
  const subject = loadSubject();
  const detected = subject.detectFormRegistration(syntheticPhotographedTemplateB({
    omittedRules: [0],
    horizontalBoundaryCount: 26,
  }));
  assert.equal(detected.source, "FORM_GRID_RULE_SEQUENCE", JSON.stringify(detected));
  assert.equal(detected.templateId, "TEMPLATE_B");
  assert.equal(detected.verticalLineCount, 9);
  assert.equal(detected.horizontalLineCount, 26);
  assert.equal(detected.rowGeometryStable, false);
  assert.equal(
    subject.formRegistrationFailureMessage(detected),
    "form_registration_failed · mal TEMPLATE_B · 9 vertikale linjer (8 observert; venstre yttergrense inferert) · fant 26 av 30 radlinjer · radgeometrien er ustabil · sikkerhet 0.836",
  );
});

test("canonical superset bevarer Inn kl og INFO, mens Template A lar dem være tomme", () => {
  const subject = loadSubject();
  assert.deepEqual(subject.CANONICAL_COLUMN_IDS, [
    "arrivalTime", "fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "info", "notes",
  ]);
  const templateA = subject.registerTemplate({imageWidth: 1200, imageHeight: 1500, templateId: "TEMPLATE_A"});
  const templateB = subject.registerTemplate({imageWidth: 1200, imageHeight: 1500, templateId: "TEMPLATE_B"});
  assert.deepEqual([...new Set(templateA.cells.map(cell => cell.columnId))], subject.TEMPLATE_A_COLUMN_IDS);
  assert.deepEqual([...new Set(templateB.cells.map(cell => cell.columnId))], subject.TEMPLATE_B_COLUMN_IDS);
  assert.equal(subject.toCanonicalRow("TEMPLATE_A", {fromTrain: "821", notes: "kontroll"}).arrivalTime, "");
  assert.equal(subject.toCanonicalRow("TEMPLATE_A", {fromTrain: "821", notes: "kontroll"}).info, "");
  assert.equal(subject.toCanonicalRow("TEMPLATE_B", {arrivalTime: "16:53", info: "RØD", notes: "svart"}).arrivalTime, "16:53");
  assert.equal(subject.toCanonicalRow("TEMPLATE_B", {arrivalTime: "16:53", info: "RØD", notes: "svart"}).info, "RØD");
});

test("rødt print og svart håndskrift skilles før gjenkjenning og rutenett holdes ute", () => {
  const subject = loadSubject();
  const separated = subject.separateInkLayers({
    width: 4,
    height: 1,
    pixels: new Uint8ClampedArray([
      210, 35, 35, 255,
      25, 25, 25, 255,
      155, 155, 155, 255,
      250, 250, 245, 255,
    ]),
    gridMask: new Uint8Array([0, 0, 1, 0]),
  });
  assert.deepEqual([...separated.printInk], [0, 255, 255, 255]);
  assert.deepEqual([...separated.handwritingInk], [255, 0, 255, 255]);
  assert.deepEqual([...separated.combinedInk], [0, 0, 255, 255]);
});

test("hybrid forespørsel bruker separate print-OCR- og HTR-spor med original crop", () => {
  const subject = loadSubject();
  const registration = subject.registerTemplate({imageWidth: 1200, imageHeight: 1500, templateId: "TEMPLATE_B"});
  const requests = subject.createRecognitionRequests(registration);
  assert.equal(requests.length, (29 * 8) + 3);
  assert.equal(requests.every(request => JSON.stringify(request.recognizerKinds) === JSON.stringify(["PRINT_OCR", "HANDWRITING_HTR"])), true);
  assert.equal(requests.every(request => request.boundingBox.coordinateSpace === "ORIGINAL_IMAGE"), true);
});

test("lagkonflikt og overstrykning kan aldri autoaksepteres", () => {
  const subject = loadSubject();
  const conflict = subject.reconcileLayerCandidates({
    columnId: "vehicleId",
    printedCandidate: {text: "91-77", confidence: 0.999},
    handwrittenCandidate: {text: "74-38", confidence: 0.999},
    strikeThroughDetected: false,
  });
  assert.equal(conflict.finalCandidate.text, "74-38");
  assert.equal(conflict.needsReview, true);
  assert.equal(conflict.reason, "PRINT_HANDWRITING_CONFLICT");
  const corrected = subject.reconcileLayerCandidates({
    columnId: "notes",
    printedCandidate: {text: "opprinnelig", confidence: 0.999},
    handwrittenCandidate: {text: "rettet", confidence: 0.999},
    strikeThroughDetected: true,
  });
  assert.equal(corrected.needsReview, true);
  assert.equal(corrected.finalCandidate.text, "rettet");
  assert.equal(corrected.reason, "STRIKETHROUGH_OR_CORRECTION");
});

test("vanlige håndskriftstreker er ikke overstrykning, men en sammenhengende rettelinje er det", () => {
  const subject = loadSubject();
  const width = 40;
  const height = 20;
  const handwriting = new Uint8Array(width * height).fill(255);
  for(const x of [2, 3, 8, 9, 15, 16, 25, 26, 34, 35]) handwriting[(10 * width) + x] = 0;
  assert.equal(subject.detectStrikeThrough(handwriting, width, height), false);

  const corrected = handwriting.slice();
  for(let x = 3; x <= 36; x += 1){
    corrected[(9 * width) + x] = 0;
    corrected[(10 * width) + x] = 0;
  }
  assert.equal(subject.detectStrikeThrough(corrected, width, height), true);
});

test("Template B-kildedato og initialer bevares uten current-date-fallback", () => {
  const subject = loadSubject();
  const metadata = subject.resolveSourceMetadata({
    templateId: "TEMPLATE_B",
    candidates: {clock: "14:19", date: "31.12.2099", signature: "QA"},
    currentOperationalDate: "2026-08-18",
  });
  assert.equal(metadata.date, "31.12.2099");
  assert.equal(metadata.signature, "QA");
  assert.equal(metadata.clock, "14:19");
  const missing = subject.resolveSourceMetadata({
    templateId: "TEMPLATE_B",
    candidates: {date: "", signature: ""},
    currentOperationalDate: "2026-08-18",
  });
  assert.equal(missing.date, "");
  assert.equal(missing.needsReview, true);
});

test("Template B mapping godtar bare komplett 29 x 8 og rapporterer reell lokal ensembleproveniens", () => {
  const subject = loadSubject();
  const cells = Array.from({length: 29 * 8}, (_unused, index) => ({
    rowIndex: Math.floor(index / 8),
    columnId: subject.TEMPLATE_B_COLUMN_IDS[index % 8],
    selectedValue: index < 8 ? String(index + 1) : "",
    confidence: 0.999,
    needsReview: false,
    printedCandidate: null,
    handwrittenCandidate: null,
  }));
  const metadataCells = ["clock", "date", "signature"].map(columnId => ({columnId, selectedValue: "test", confidence: 0.999, needsReview: false}));
  const report = subject.buildMappingReport({
    templateId: "TEMPLATE_B",
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    cells,
    metadataCells,
  });
  assert.equal(report.mappingStatus, "FORM_MAPPING_COMPLETE");
  assert.equal(report.templateId, "TEMPLATE_B");
  assert.equal(report.columnCount, 8);
  assert.equal(report.cellCount, 232);
  assert.equal(report.recognitionMode, "LOCAL_REAL_HTR_ENSEMBLE");
});
