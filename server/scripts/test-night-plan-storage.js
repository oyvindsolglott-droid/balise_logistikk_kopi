"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");
const express = require("express");
const {createSchemaSql} = require("../src/schema");
const {createNightPlanApi} = require("../src/nightPlanRoutes");
const {
  NightPlanStorageError,
  MAX_IMAGE_BYTES,
  cleanupNightPlanImageOrphans,
  detectImage,
  getNightPlan,
  getNightPlanImage,
  preparePrivateStorage,
  saveNightPlan,
  sha256,
  validateNightPlanSavePayload
} = require("../src/nightPlanStorage");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const passed = [];
let tempRoot;

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main(){
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sde-night-plan-storage-"));
  try{
    runStorageContract();
    runTemplateBStorageContract();
    runValidationAndSecurityContract();
    runFailureAtomicityContract();
    runRestartReadbackContract();
    await runHttpAuthorizationContract();
    assert.ok(passed.length >= 45, `expected at least 45 independent assertions, got ${passed.length}`);
    console.log(`nightPlanStorageTests: ${passed.length}/${passed.length}`);
  }finally{
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}

function check(name, fn){
  fn();
  passed.push(name);
}

async function checkAsync(name, fn){
  await fn();
  passed.push(name);
}

function freshContext(name){
  const root = path.join(tempRoot, name);
  const repo = path.join(root, "repository");
  const imageRoot = path.join(root, "private-images");
  fs.mkdirSync(repo, {recursive: true});
  const db = new DatabaseSync(":memory:");
  db.exec(createSchemaSql());
  return {db, repo, imageRoot};
}

function rows(){
  return Array.from({length: 29}, (_unused, index) => ({
    arrivalTime: "",
    fromTrain: index === 0 ? "851" : "",
    toTrain: index === 0 ? "REP" : "",
    vehicleId: index === 0 ? "74-08" : "",
    toTrack: index === 0 ? "8S" : "",
    wcWater: index === 0 ? "*" : "",
    info: "",
    notes: index === 0 ? "ut syd." : ""
  }));
}

function mappingReport(){
  const columns = ["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "notes"];
  const row = rows()[0];
  const box = (rowIndex, columnIndex) => ({
    x0: 30 + columnIndex * 180,
    y0: rowIndex == null ? 80 : 170 + rowIndex * 37,
    x1: 190 + columnIndex * 180,
    y1: rowIndex == null ? 110 : 200 + rowIndex * 37,
    coordinateSpace: "ORIGINAL_IMAGE",
    polygon: [
      {x: 30 + columnIndex * 180, y: rowIndex == null ? 80 : 170 + rowIndex * 37},
      {x: 190 + columnIndex * 180, y: rowIndex == null ? 80 : 170 + rowIndex * 37},
      {x: 190 + columnIndex * 180, y: rowIndex == null ? 110 : 200 + rowIndex * 37},
      {x: 30 + columnIndex * 180, y: rowIndex == null ? 110 : 200 + rowIndex * 37}
    ]
  });
  const cell = (rowIndex, columnId, columnIndex, value) => ({
    rowIndex,
    columnId,
    boundingBox: box(rowIndex, columnIndex),
    recognizedText: value,
    normalizedValue: value,
    selectedValue: value,
    confidence: value ? 0.98 : 1,
    alternatives: value ? [value] : [],
    needsReview: false,
    validationState: value ? "VALID" : "BLANK_IMAGE_CELL",
    recognizerVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    groundTruthSource: "HUMAN_CORRECTED_FORM",
    rawRecognizerIsGroundTruth: false,
    imageEvidence: {inkRatio: value ? 0.1 : 0, blank: !value},
    humanFinalValue: value
  });
  const cells = Array.from({length: 29}, (_unused, rowIndex) => columns.map((column, columnIndex) => (
    cell(rowIndex, column, columnIndex, rowIndex === 0 ? row[column] : "")
  ))).flat();
  const metadataCells = [
    cell(null, "date", 0, "2026-08-18"),
    cell(null, "signature", 1, "TXP TEST"),
    cell(null, "ds", 2, "ds-1")
  ];
  return {
    schemaVersion: "sde-night-form-mapping-report-v2",
    mappingStatus: "FORM_MAPPING_COMPLETE",
    htrCompleted: true,
    registrationStatus: "CELLS_SEGMENTED",
    templateVersion: "togplassering-skien-29x6-v1",
    recognizerVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    modelSha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
    cellCount: cells.length,
    mappedCellCount: cells.filter(item => item.selectedValue).length,
    reviewedCellCount: 0,
    requiresHumanReview: false,
    mappingConfidence: 0.98,
    cells,
    metadataCells,
    humanGroundTruthSource: "HUMAN_CORRECTED_FORM",
    rawRecognizerIsGroundTruth: false,
    humanReviewCompleted: true
  };
}

function templateBRows(){
  return Array.from({length: 29}, (_unused, index) => ({
    arrivalTime: index === 0 ? "06:11" : "",
    fromTrain: index === 0 ? "9901/1" : "",
    toTrain: index === 0 ? "9902/1" : "",
    vehicleId: index === 0 ? "91-01" : "",
    toTrack: index === 0 ? "3N" : "",
    wcWater: index === 0 ? "CROSS" : "",
    info: index === 0 ? "TEST INFO" : "",
    notes: index === 0 ? "syntetisk rad" : ""
  }));
}

function templateBMappingReport(){
  const columns = ["arrivalTime", "fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "info", "notes"];
  const sourceRows = templateBRows();
  const box = (rowIndex, columnIndex) => ({
    x0: 20 + columnIndex * 120,
    y0: rowIndex == null ? 140 : 270 + rowIndex * 38,
    x1: 130 + columnIndex * 120,
    y1: rowIndex == null ? 170 : 300 + rowIndex * 38,
    coordinateSpace: "ORIGINAL_IMAGE",
    polygon: [
      {x: 20 + columnIndex * 120, y: rowIndex == null ? 140 : 270 + rowIndex * 38},
      {x: 130 + columnIndex * 120, y: rowIndex == null ? 140 : 270 + rowIndex * 38},
      {x: 130 + columnIndex * 120, y: rowIndex == null ? 170 : 300 + rowIndex * 38},
      {x: 20 + columnIndex * 120, y: rowIndex == null ? 170 : 300 + rowIndex * 38}
    ]
  });
  const cell = (rowIndex, columnId, columnIndex, value, sourceLayer = "PRINT_OCR") => ({
    rowIndex,
    columnId,
    boundingBox: box(rowIndex, columnIndex),
    sourceBoundingBox: box(rowIndex, columnIndex),
    recognizedText: value,
    normalizedValue: value,
    selectedValue: value,
    confidence: value ? 0.999 : 1,
    alternatives: value ? [value] : [],
    needsReview: false,
    validationState: value ? "VALID" : "BLANK_IMAGE_CELL",
    recognizerVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    groundTruthSource: "HUMAN_CORRECTED_FORM",
    rawRecognizerIsGroundTruth: false,
    imageEvidence: {
      inkRatio: value ? 0.1 : 0,
      printInkRatio: value && sourceLayer === "PRINT_OCR" ? 0.1 : 0,
      handwritingInkRatio: value && sourceLayer === "HANDWRITING_HTR" ? 0.1 : 0,
      strikeThroughDetected: false,
      gridLineMask: {horizontalLineCount: 0, verticalLineCount: 0, gridPixelCount: 0},
      blank: !value
    },
    printedCandidate: value && sourceLayer === "PRINT_OCR" ? {text: value, confidence: 0.999} : null,
    handwrittenCandidate: value && sourceLayer === "HANDWRITING_HTR" ? {text: value, confidence: 0.999} : null,
    finalCandidate: {text: value, confidence: value ? 0.999 : 1},
    recognitionMode: "HYBRID_PRINT_OCR_HTR",
    normalizationReason: value ? "IMAGE_CANDIDATE_PASSED_FIELD_VALIDATION" : "BLANK_IMAGE_CELL",
    humanFinalValue: value
  });
  const cells = Array.from({length: 29}, (_unused, rowIndex) => columns.map((column, columnIndex) => (
    cell(rowIndex, column, columnIndex, sourceRows[rowIndex][column], column === "notes" ? "HANDWRITING_HTR" : "PRINT_OCR")
  ))).flat();
  const metadataCells = [
    cell(null, "clock", 0, ""),
    cell(null, "date", 1, "31.12.2099"),
    cell(null, "signature", 2, "QA", "HANDWRITING_HTR")
  ];
  return {
    schemaVersion: "sde-night-form-mapping-report-v3",
    mappingStatus: "FORM_MAPPING_COMPLETE",
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    templateId: "TEMPLATE_B",
    templateVersion: "togplassering-skien-template-b-29x8-v1",
    columnCount: 8,
    recognitionMode: "HYBRID_PRINT_OCR_HTR",
    recognizerVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    modelSha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
    cellCount: cells.length,
    mappedCellCount: cells.filter(item => item.selectedValue).length,
    reviewedCellCount: 0,
    requiresHumanReview: false,
    mappingConfidence: 0.999,
    cells,
    metadataCells,
    humanGroundTruthSource: "HUMAN_CORRECTED_FORM",
    rawRecognizerIsGroundTruth: false,
    humanReviewCompleted: true
  };
}

function payload(overrides = {}){
  const base = {
    idempotencyKey: `night-plan-test:${cryptoId()}`,
    expectedRevision: 0,
    planId: null,
    createdAt: "2026-08-17T08:00:00.000Z",
    status: "SAVED",
    form: {planDate: "2026-08-18", clock: "", signature: "TXP TEST", ds: "ds-1", rows: rows()},
    source: {
      sourceType: "DEVICE_FILE",
      ocrEngine: "paddleocr-local-htr-onnx-wasm",
      ocrVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
      importedAt: "2026-08-17T08:01:00.000Z",
      humanCorrected: true,
      mappingStatus: "FORM_MAPPING_COMPLETE",
      mappingReport: mappingReport()
    },
    image: {mimeType: "image/png", originalFileName: "plan.png", bytesBase64: PNG.toString("base64")},
    pipeline: {modelVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e", pipelineVersion: "sde-night-local-htr-v1"}
  };
  return {...base, ...overrides};
}

function templateBPayload(){
  const base = payload();
  return {
    ...base,
    idempotencyKey: `night-plan-template-b-test:${cryptoId()}`,
    form: {planDate: "2099-12-31", clock: "", signature: "QA", ds: "", rows: templateBRows()},
    source: {
      ...base.source,
      ocrEngine: "paddleocr-local-hybrid-print-htr-onnx-wasm",
      mappingReport: templateBMappingReport()
    },
    pipeline: {...base.pipeline, pipelineVersion: "sde-night-local-hybrid-ocr-htr-v2"}
  };
}

function manualPayload(overrides = {}){
  const base = payload({
    source: {sourceType: "MANUAL", ocrEngine: null, ocrVersion: null, importedAt: null, humanCorrected: true},
    image: null
  });
  return {...base, ...overrides};
}

function cryptoId(){
  return require("node:crypto").randomUUID();
}

function runStorageContract(){
  const context = freshContext("core");
  const operationalBefore = snapshotOperational(context.db);
  const input = payload();
  const saved = saveNightPlan(context.db, input, {
    imageStorageRoot: context.imageRoot,
    repositoryRoot: context.repo,
    savedBy: "cf-subject-txp",
    now: "2026-08-17T08:02:00.000Z"
  });
  check("01 save succeeds", () => assert.equal(saved.ok, true));
  check("02 save is documentation only", () => assert.equal(saved.operationalAuthority, false));
  check("03 save reports no operational mutation", () => assert.equal(saved.operationalStateMutation, false));
  check("04 first revision is one", () => assert.equal(saved.revision, 1));
  check("05 opaque plan identifier", () => assert.match(saved.planId, /^[0-9a-f-]{36}$/));
  check("06 opaque image identifier", () => assert.match(saved.storedImageId, /^[0-9a-f-]{36}$/));
  check("07 exact source-image hash", () => assert.equal(saved.storedImageSha256, sha256(PNG)));
  check("08 exact source-image byte count", () => assert.equal(saved.storedImageByteCount, PNG.length));
  check("09 learning source is corrected form", () => assert.equal(saved.learningSource, "HUMAN_CORRECTED_FORM"));
  check("10 learning record is ready", () => assert.equal(saved.learningStatus, "READY"));

  const readback = getNightPlan(context.db, saved.planId);
  check("11 form readback has 29 rows", () => assert.equal(readback.form.rows.length, 29));
  check("12 form readback is exact", () => assert.deepEqual(readback.form, input.form));
  check("13 form digest agrees", () => assert.equal(readback.finalFormSha256, saved.finalFormSha256));
  check("14 provenance stores camera/file source", () => assert.equal(readback.provenance.sourceType, "DEVICE_FILE"));
  check("15 provenance stores human correction", () => assert.equal(readback.provenance.humanCorrected, true));
  check("16 provenance binds source hash", () => assert.equal(readback.provenance.sourceImageSha256, sha256(PNG)));
  check("17 identity comes from server option", () => assert.equal(readback.savedBy, "cf-subject-txp"));
  check("17a provenance stores truthful mapping status", () => assert.equal(readback.provenance.mappingStatus, "FORM_MAPPING_COMPLETE"));
  check("17b provenance stores all HTR cells and model provenance without treating raw output as truth", () => {
    assert.equal(readback.provenance.mappingReport.mappedCellCount, 6);
    assert.equal(readback.provenance.mappingReport.cells.length, 174);
    assert.equal(readback.provenance.mappingReport.metadataCells.length, 3);
    assert.equal(readback.provenance.mappingReport.modelSha256, "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498");
    assert.equal(readback.provenance.mappingReport.rawRecognizerIsGroundTruth, false);
    assert.equal(JSON.stringify(readback.provenance.mappingReport).includes("rawText"), false);
  });

  const image = getNightPlanImage(context.db, saved.planId, saved.storedImageId, {
    imageStorageRoot: context.imageRoot,
    repositoryRoot: context.repo
  });
  check("18 authenticated read primitive returns exact bytes", () => assert.deepEqual(image.bytes, PNG));
  check("19 actual MIME is retained", () => assert.equal(image.mimeType, "image/png"));
  check("20 dimensions are derived from bytes", () => assert.deepEqual([image.width, image.height], [1, 1]));
  check("21 image lives outside repository", () => assert.equal(path.relative(context.repo, context.imageRoot).startsWith(".."), true));
  check("22 image has private file mode", () => {
    const key = context.db.prepare("SELECT storage_key AS key FROM night_plan_images").get().key;
    assert.equal(fs.statSync(path.join(context.imageRoot, "images", key)).mode & 0o077, 0);
  });
  check("23 operational state and events unchanged", () => assert.deepEqual(snapshotOperational(context.db), operationalBefore));
  check("24 exactly one atomic row in each component", () => {
    for(const table of ["night_plans", "night_plan_images", "night_plan_provenance", "night_plan_learning_records", "night_plan_idempotency"]){
      assert.equal(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1, table);
    }
  });
  check("25 learning payload is final corrected form", () => {
    const learning = context.db.prepare("SELECT * FROM night_plan_learning_records").get();
    assert.deepEqual(JSON.parse(learning.canonical_form_json), input.form);
    assert.deepEqual(JSON.parse(learning.human_ground_truth_json), input.form);
    assert.equal(JSON.parse(learning.recognizer_result_json).tableCells.length, 174);
    assert.equal(JSON.parse(learning.recognizer_result_json).metadataCells.length, 3);
    assert.equal(learning.final_form_sha256, saved.finalFormSha256);
  });
  check("25a source image and plan share the same plan identifier", () => {
    const storedImage = context.db.prepare("SELECT plan_id AS planId FROM night_plan_images WHERE image_id = ?").get(saved.storedImageId);
    assert.equal(storedImage.planId, saved.planId);
  });

  const replay = saveNightPlan(context.db, input, {
    imageStorageRoot: context.imageRoot, repositoryRoot: context.repo, savedBy: "cf-subject-txp"
  });
  check("26 exact idempotent replay returns same plan", () => assert.equal(replay.planId, saved.planId));
  check("27 replay is identified", () => assert.equal(replay.idempotentReplay, true));
  check("28 replay creates no duplicate", () => assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM night_plans").get().count, 1));
  check("29 idempotency key rejects changed payload", () => expectCode(() => saveNightPlan(context.db, {...input, form: {...input.form, ds: "changed"}}, {
    imageStorageRoot: context.imageRoot, repositoryRoot: context.repo, savedBy: "cf-subject-txp"
  }), "idempotency_key_reused"));
  check("30 stale revision rejects update", () => expectCode(() => saveNightPlan(context.db, manualPayload({
    planId: saved.planId, expectedRevision: 0
  }), {imageStorageRoot: context.imageRoot, repositoryRoot: context.repo, savedBy: "cf-subject-txp"}), "revision_conflict"));
  context.db.close();
}

function runTemplateBStorageContract(){
  const context = freshContext("template-b");
  const input = templateBPayload();
  const saved = saveNightPlan(context.db, input, {
    imageStorageRoot: context.imageRoot,
    repositoryRoot: context.repo,
    savedBy: "cf-subject-qa",
    now: "2099-12-30T08:02:00.000Z"
  });
  const readback = getNightPlan(context.db, saved.planId);
  check("30a Template B persists all eight canonical columns", () => assert.deepEqual(readback.form.rows, input.form.rows));
  check("30b Template B persists the source clock field", () => assert.equal(readback.form.clock, ""));
  check("30c Template B persists source date and initials", () => assert.deepEqual(
    [readback.form.planDate, readback.form.signature], ["2099-12-31", "QA"]
  ));
  check("30d Template B provenance retains the detected template", () => assert.equal(
    readback.provenance.mappingReport.templateId, "TEMPLATE_B"
  ));
  check("30e Template B provenance retains all 232 cells", () => assert.equal(
    readback.provenance.mappingReport.cells.length, 232
  ));
  check("30f hybrid print/HTR provenance survives readback", () => {
    assert.equal(readback.provenance.mappingReport.recognitionMode, "HYBRID_PRINT_OCR_HTR");
    assert.equal(readback.provenance.mappingReport.cells[0].printedCandidate.text, "06:11");
    assert.equal(readback.provenance.mappingReport.cells[7].handwrittenCandidate.text, "syntetisk rad");
  });
  check("30g raw hybrid recognizer output is not learning ground truth", () => assert.equal(
    readback.provenance.mappingReport.rawRecognizerIsGroundTruth, false
  ));
  check("30h atomic learning record uses the reviewed eight-column form", () => {
    const learning = context.db.prepare("SELECT canonical_form_json AS form FROM night_plan_learning_records").get();
    assert.deepEqual(JSON.parse(learning.form), input.form);
  });
  context.db.close();
}

function runValidationAndSecurityContract(){
  check("31 valid PNG is detected from bytes", () => assert.equal(detectImage(PNG).mimeType, "image/png"));
  check("32 declared MIME mismatch rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {mimeType: "image/jpeg", originalFileName: "plan.jpg", bytesBase64: PNG.toString("base64")}
  })), "image_mime_mismatch"));
  check("33 unsupported MIME rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {mimeType: "image/gif", originalFileName: "plan.gif", bytesBase64: PNG.toString("base64")}
  })), "unsupported_image_type"));
  check("34 traversal filename rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {mimeType: "image/png", originalFileName: "../plan.png", bytesBase64: PNG.toString("base64")}
  })), "invalid_original_file_name"));
  check("35 noncanonical base64 rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {mimeType: "image/png", originalFileName: "plan.png", bytesBase64: PNG.toString("base64") + "="}
  })), "invalid_image_base64"));
  check("36 28 rows rejected", () => expectCode(() => validateNightPlanSavePayload(manualPayload({
    form: {planDate: "2026-08-18", signature: "TXP", ds: "", rows: rows().slice(0, 28)}
  })), "invalid_row_count"));
  check("37 30 rows rejected", () => expectCode(() => validateNightPlanSavePayload(manualPayload({
    form: {planDate: "2026-08-18", signature: "TXP", ds: "", rows: [...rows(), rows()[0]]}
  })), "invalid_row_count"));
  check("38 missing signature rejected", () => expectCode(() => validateNightPlanSavePayload(manualPayload({
    form: {planDate: "2026-08-18", signature: "", ds: "", rows: rows()}
  })), "signature_required"));
  check("39 image source without image rejected", () => expectCode(() => validateNightPlanSavePayload(payload({image: null})), "source_image_required"));
  check("40 manual source with image rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    source: {sourceType: "MANUAL", humanCorrected: true, ocrEngine: null, ocrVersion: null, importedAt: null}
  })), "non_image_plan_image_not_allowed"));
  check("41 non-human-corrected form rejected", () => expectCode(() => validateNightPlanSavePayload(manualPayload({
    source: {sourceType: "MANUAL", humanCorrected: false, ocrEngine: null, ocrVersion: null, importedAt: null}
  })), "human_correction_required"));
  check("42 unexpected field rejected", () => expectCode(() => validateNightPlanSavePayload({...manualPayload(), operationalState: {}}), "unexpected_payload_field"));
  check("43 invalid expected revision rejected", () => expectCode(() => validateNightPlanSavePayload(manualPayload({expectedRevision: -1})), "invalid_expected_revision"));
  check("44 private root inside repo rejected", () => {
    const context = freshContext("inside-repo");
    expectCode(() => preparePrivateStorage({imageStorageRoot: path.join(context.repo, "assets", "private"), repositoryRoot: context.repo}), "image_storage_inside_repository");
    context.db.close();
  });
  check("44a hybrid layer ratios are bounded", () => {
    const invalidPayload = templateBPayload();
    invalidPayload.source.mappingReport.cells[0].imageEvidence.printInkRatio = 2;
    expectCode(() => validateNightPlanSavePayload(invalidPayload), "invalid_htr_image_evidence");
  });
  check("44b hybrid grid-mask provenance is closed-schema", () => {
    const invalidPayload = templateBPayload();
    invalidPayload.source.mappingReport.cells[0].imageEvidence.gridLineMask.unexpected = 1;
    expectCode(() => validateNightPlanSavePayload(invalidPayload), "unexpected_htr_grid_line_mask_field");
  });
  check("45 symlink storage root rejected", () => {
    const context = freshContext("symlink-root");
    const actual = path.join(tempRoot, "symlink-actual");
    const link = path.join(tempRoot, "symlink-link");
    fs.mkdirSync(actual, {recursive: true});
    if(!fs.existsSync(link)) fs.symlinkSync(actual, link);
    expectCode(() => preparePrivateStorage({imageStorageRoot: link, repositoryRoot: context.repo}), "image_storage_unsafe");
    context.db.close();
  });
  check("46 legacy is read-only-transfer-compatible", () => {
    const validated = validateNightPlanSavePayload(payload({
      source: {sourceType: "LEGACY_LOCAL", humanCorrected: true, ocrEngine: null, ocrVersion: null, importedAt: null}, image: null
    }));
    assert.equal(validated.source.sourceType, "LEGACY_LOCAL");
  });
  check("46a client-controlled server path is rejected", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {...payload().image, serverPath: "/tmp/client-controlled.png"}
  })), "unexpected_image_field"));
  check("46b oversized source image is rejected before decoding or persistence", () => expectCode(() => validateNightPlanSavePayload(payload({
    image: {mimeType: "image/png", originalFileName: "too-large.png", bytesBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")}
  })), "image_size_invalid"));
  check("46c storage implementation has no payload or image logger", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/nightPlanStorage.js"), "utf8") +
      fs.readFileSync(path.join(__dirname, "../src/nightPlanRoutes.js"), "utf8");
    assert.equal(/console\.(?:log|info|debug)\s*\(/.test(source), false);
  });
  check("46d OCR-backed image source requires mapping provenance", () => expectCode(() => validateNightPlanSavePayload(payload({
    source: {sourceType: "DEVICE_FILE", ocrEngine: "paddleocr-local-htr-onnx-wasm", ocrVersion: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e", importedAt: "2026-08-17T08:01:00.000Z", humanCorrected: true, mappingStatus: "FORM_MAPPING_COMPLETE", mappingReport: null}
  })), "mapping_report_required"));
  check("46e mapping status and report cannot contradict each other", () => expectCode(() => validateNightPlanSavePayload(payload({
    source: {...payload().source, mappingStatus: "MAPPING_FAILED"}
  })), "mapping_status_mismatch"));
  check("46f HTR report requires the complete 29 x 6 cell set", () => {
    const report = mappingReport();
    report.cells = report.cells.slice(0, -1);
    report.cellCount = report.cells.length;
    expectCode(() => validateNightPlanSavePayload(payload({
      source: {...payload().source, mappingReport: report}
    })), "invalid_htr_cell_count");
  });
  check("46g HTR report requires all three metadata cells", () => {
    const report = mappingReport();
    report.metadataCells = report.metadataCells.slice(0, 2);
    expectCode(() => validateNightPlanSavePayload(payload({
      source: {...payload().source, mappingReport: report}
    })), "invalid_htr_metadata_cell_count");
  });
  check("46h raw recognizer output can never be learning ground truth", () => {
    const report = mappingReport();
    report.cells[0] = {...report.cells[0], rawRecognizerIsGroundTruth: true};
    expectCode(() => validateNightPlanSavePayload(payload({
      source: {...payload().source, mappingReport: report}
    })), "raw_recognizer_ground_truth_forbidden");
  });
  check("47 symlinked ancestor cannot redirect storage into repository", () => {
    const context = freshContext("symlink-ancestor-into-repo");
    const link = path.join(tempRoot, "repo-alias");
    if(!fs.existsSync(link)) fs.symlinkSync(context.repo, link);
    const redirectedRoot = path.join(link, "must-not-be-created");
    expectCode(() => preparePrivateStorage({imageStorageRoot: redirectedRoot, repositoryRoot: context.repo}), "image_storage_inside_repository");
    assert.equal(fs.existsSync(path.join(context.repo, "must-not-be-created")), false);
    context.db.close();
  });
}

function runFailureAtomicityContract(){
  for(const [index, point] of ["image_write", "after_image_publish", "plan_write", "provenance_write", "learning_write", "before_commit"].entries()){
      check(`${48 + index} ${point} failure leaves no partial aggregate`, () => {
      const context = freshContext(`failure-${point}`);
      expectCode(() => saveNightPlan(context.db, payload(), {
        imageStorageRoot: context.imageRoot,
        repositoryRoot: context.repo,
        savedBy: "cf-subject-txp",
        failAt: point
      }), "injected_storage_failure");
      for(const table of ["night_plans", "night_plan_images", "night_plan_provenance", "night_plan_learning_records", "night_plan_idempotency"]){
        assert.equal(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
      }
      const storage = preparePrivateStorage({imageStorageRoot: context.imageRoot, repositoryRoot: context.repo});
      assert.deepEqual(fs.readdirSync(storage.imagesPath), []);
      assert.deepEqual(fs.readdirSync(storage.stagingPath), []);
      context.db.close();
    });
  }
  check("54 crash orphan is removed at startup cleanup", () => {
    const context = freshContext("orphan-cleanup");
    const storage = preparePrivateStorage({imageStorageRoot: context.imageRoot, repositoryRoot: context.repo});
    const orphan = `${cryptoId()}.png`;
    fs.writeFileSync(path.join(storage.imagesPath, orphan), PNG, {mode: 0o600});
    const result = cleanupNightPlanImageOrphans(context.db, {imageStorageRoot: context.imageRoot, repositoryRoot: context.repo});
    assert.equal(result.removedCount, 1);
    assert.equal(fs.existsSync(path.join(storage.imagesPath, orphan)), false);
    context.db.close();
  });
}

function runRestartReadbackContract(){
  const root = path.join(tempRoot, "restart-readback");
  const repo = path.join(root, "repository");
  const imageRoot = path.join(root, "private-images");
  const databasePath = path.join(root, "sde.sqlite3");
  fs.mkdirSync(repo, {recursive: true});
  let db = new DatabaseSync(databasePath);
  db.exec(createSchemaSql());
  const input = payload();
  const saved = saveNightPlan(db, input, {imageStorageRoot: imageRoot, repositoryRoot: repo, savedBy: "restart-subject"});
  db.close();
  db = new DatabaseSync(databasePath);
  db.exec(createSchemaSql());
  createNightPlanApi({
    db,
    repositoryRoot: repo,
    imageStorageRoot: imageRoot,
    env: {SDE_ENABLE_NIGHT_PLAN_STORAGE: "1"},
    verifyIdentityRequest: async () => ({ok: false, status: 401, publicError: "authentication_required"}),
    roleBindingsCatalog: {bindings: []}
  });
  check("55 persisted aggregate survives server reinitialization", () => {
    const readback = getNightPlan(db, saved.planId);
    const image = getNightPlanImage(db, saved.planId, saved.storedImageId, {imageStorageRoot: imageRoot, repositoryRoot: repo});
    assert.deepEqual(readback.form, input.form);
    assert.deepEqual(image.bytes, PNG);
    assert.equal(readback.learningSource, "HUMAN_CORRECTED_FORM");
  });
  db.close();
}

async function runHttpAuthorizationContract(){
  const context = freshContext("http");
  const identities = {
    admin: identity("admin-subject"),
    txp: identity("txp-subject"),
    drops: identity("drops-subject")
  };
  const api = createNightPlanApi({
    db: context.db,
    repositoryRoot: context.repo,
    imageStorageRoot: context.imageRoot,
    env: {SDE_ENABLE_NIGHT_PLAN_STORAGE: "1"},
    verifyIdentityRequest: async ({headers}) => {
      const key = headers["x-test-identity"];
      return identities[key]
        ? {ok: true, status: 200, identity: identities[key]}
        : {ok: false, status: 401, publicError: "authentication_required"};
    },
    roleBindingsCatalog: {bindings: [
      {bindingId: "admin-binding", subject: "admin-subject", role: "admin_pilot", enabled: true},
      {bindingId: "txp-binding", subject: "txp-subject", role: "txp", enabled: true},
      {bindingId: "drops-binding", subject: "drops-subject", role: "drops", enabled: true}
    ]}
  });
  const app = express();
  app.use("/api/night-plans", api.router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/night-plans`;
  try{
    await checkAsync("56 unauthenticated write is rejected before persistence", async () => {
      const response = await fetch(base, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(manualPayload())});
      assert.equal(response.status, 401);
      assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM night_plans").get().count, 0);
    });
    await checkAsync("57 unauthorized operational role cannot save", async () => {
      const response = await fetch(base, {method: "POST", headers: {"Content-Type": "application/json", "X-Test-Identity": "drops", "X-Level": "0"}, body: JSON.stringify(manualPayload())});
      assert.equal(response.status, 403);
    });
    let created;
    await checkAsync("58 TXP can explicitly save", async () => {
      const response = await fetch(base, {method: "POST", headers: {"Content-Type": "application/json", "X-Test-Identity": "txp", "X-Level": "5"}, body: JSON.stringify(manualPayload())});
      created = await response.json();
      assert.equal(response.status, 201);
      assert.equal(created.savedBy, "txp-subject");
    });
    await checkAsync("59 untrusted frontend role does not override verified identity", async () => {
      const response = await fetch(base, {headers: {"X-Test-Identity": "drops", "X-Role": "admin_pilot", "X-Level": "0"}});
      assert.equal(response.status, 403);
    });
    await checkAsync("60 Admin can list saved plans without private path leakage", async () => {
      const response = await fetch(base, {headers: {"X-Test-Identity": "admin"}});
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.plans.length, 1);
      assert.equal(JSON.stringify(body).includes(context.imageRoot), false);
    });
    await checkAsync("61 authenticated exact plan readback succeeds", async () => {
      const response = await fetch(`${base}/${created.planId}`, {headers: {"X-Test-Identity": "txp"}});
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.form.rows.length, 29);
      assert.equal(body.operationalStateMutation, false);
    });
    await checkAsync("62 malformed opaque identifier is rejected", async () => {
      const response = await fetch(`${base}/not-a-uuid`, {headers: {"X-Test-Identity": "txp"}});
      assert.equal(response.status, 400);
    });
    let imageCreated;
    await checkAsync("63 TXP can save an image-backed plan", async () => {
      const response = await fetch(base, {method: "POST", headers: {"Content-Type": "application/json", "X-Test-Identity": "txp"}, body: JSON.stringify(payload())});
      imageCreated = await response.json();
      assert.equal(response.status, 201);
      assert.match(imageCreated.storedImageId, /^[0-9a-f-]{36}$/);
    });
    await checkAsync("64 unauthenticated user cannot read a private image", async () => {
      const response = await fetch(`${base}/${imageCreated.planId}/images/${imageCreated.storedImageId}`);
      assert.equal(response.status, 401);
    });
    await checkAsync("65 unauthorized role cannot read a private image", async () => {
      const response = await fetch(`${base}/${imageCreated.planId}/images/${imageCreated.storedImageId}`, {headers: {"X-Test-Identity": "drops"}});
      assert.equal(response.status, 403);
    });
    await checkAsync("66 authorized image readback returns exact bytes without directory listing", async () => {
      const response = await fetch(`${base}/${imageCreated.planId}/images/${imageCreated.storedImageId}`, {headers: {"X-Test-Identity": "txp"}});
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
      assert.equal(response.headers.get("x-sde-image-sha256"), sha256(PNG));
      assert.equal(response.url.includes(context.imageRoot), false);
    });
  }finally{
    await new Promise(resolve => server.close(resolve));
    context.db.close();
  }
}

function identity(subject){
  return {authenticated: true, identityVerified: true, identityKind: "human", subject};
}

function expectCode(fn, code){
  assert.throws(fn, error => error instanceof NightPlanStorageError && error.code === code);
}

function snapshotOperational(db){
  return {
    appState: db.prepare("SELECT * FROM app_state ORDER BY id").all(),
    events: db.prepare("SELECT * FROM events ORDER BY id").all(),
    sharedDraft: db.prepare("SELECT * FROM shared_sporplan_draft ORDER BY id").all()
  };
}
