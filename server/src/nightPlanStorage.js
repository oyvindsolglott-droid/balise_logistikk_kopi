"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORAGE_SCHEMA_VERSION = "sde-night-plan-storage-v1";
const PLAN_SCHEMA_VERSION = "sde-togplassering-skien-v1";
const LEARNING_SCHEMA_VERSION = "sde-night-plan-learning-record-v1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_DIMENSION = 20_000;
const ROW_COUNT = 29;
const ALLOWED_MIME_TYPES = Object.freeze(["image/jpeg", "image/png"]);
const ALLOWED_SOURCE_TYPES = new Set(["CAMERA", "DEVICE_FILE", "MANUAL", "LEGACY_LOCAL"]);
const ALLOWED_PLAN_STATUSES = new Set(["SAVED"]);
const ALLOWED_MAPPING_STATUSES = new Set([
  "FORM_MAPPING_COMPLETE",
  "FORM_MAPPING_REQUIRES_REVIEW",
  "MAPPING_FAILED",
  "RECOGNITION_FAILED",
  "OCR_FAILED",
  "NOT_RUN_HUMAN_ENTERED"
]);
const ROW_FIELDS = Object.freeze([
  "arrivalTime",
  "fromTrain",
  "toTrain",
  "vehicleId",
  "toTrack",
  "wcWater",
  "info",
  "notes"
]);
const TEMPLATE_COLUMNS = Object.freeze({
  TEMPLATE_A: Object.freeze(["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "notes"]),
  TEMPLATE_B: ROW_FIELDS,
});

class NightPlanStorageError extends Error {
  constructor(code, message, status = 400, details = {}){
    super(message);
    this.name = "NightPlanStorageError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function ensureNightPlanSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS night_plans (
      plan_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      plan_date TEXT NOT NULL,
      clock TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL,
      ds TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      image_id TEXT,
      final_form_sha256 TEXT NOT NULL,
      operational_authority INTEGER NOT NULL DEFAULT 0 CHECK (operational_authority = 0)
    );

    CREATE TABLE IF NOT EXISTS night_plan_images (
      image_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_provenance (
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      ocr_engine TEXT,
      ocr_version TEXT,
      source_image_sha256 TEXT,
      imported_at TEXT,
      human_corrected INTEGER NOT NULL,
      mapping_status TEXT,
      mapping_report_json TEXT,
      saved_at TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      final_form_sha256 TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      PRIMARY KEY(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_learning_records (
      learning_record_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      final_form_sha256 TEXT NOT NULL,
      source_image_sha256 TEXT,
      learning_status TEXT NOT NULL,
      learning_source TEXT NOT NULL,
      canonical_form_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model_version TEXT,
      pipeline_version TEXT,
      recognizer_result_json TEXT,
      human_ground_truth_json TEXT,
      schema_version TEXT NOT NULL,
      UNIQUE(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS night_plan_images_plan_idx
      ON night_plan_images(plan_id, plan_revision);
    CREATE INDEX IF NOT EXISTS night_plan_learning_plan_idx
      ON night_plan_learning_records(plan_id, plan_revision);
  `);
  ensureColumn(db, "night_plan_provenance", "mapping_status", "TEXT");
  ensureColumn(db, "night_plans", "clock", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "night_plan_provenance", "mapping_report_json", "TEXT");
  ensureColumn(db, "night_plan_learning_records", "recognizer_result_json", "TEXT");
  ensureColumn(db, "night_plan_learning_records", "human_ground_truth_json", "TEXT");
}

function ensureColumn(db, table, column, definition){
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if(!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function saveNightPlan(db, payload, options = {}){
  ensureNightPlanSchema(db);
  const validated = validateNightPlanSavePayload(payload);
  const existingIdempotency = getIdempotency(db, validated.idempotencyKey);
  if(existingIdempotency) return replayIdempotency(existingIdempotency, validated.requestSha256);

  const storage = preparePrivateStorage(options);
  const now = toIsoTimestamp(options.now || new Date());
  const existingPlan = validated.planId
    ? db.prepare("SELECT * FROM night_plans WHERE plan_id = ?").get(validated.planId)
    : null;
  if(existingPlan && Number(existingPlan.revision) !== validated.expectedRevision){
    throw conflict("revision_conflict", "Night plan revision conflict.", {
      expectedRevision: validated.expectedRevision,
      currentRevision: Number(existingPlan.revision)
    });
  }
  if(!existingPlan && validated.expectedRevision !== 0){
    throw conflict("revision_conflict", "Night plan does not exist at the expected revision.", {
      expectedRevision: validated.expectedRevision,
      currentRevision: 0
    });
  }

  const planId = existingPlan?.plan_id || crypto.randomUUID();
  const revision = (existingPlan ? Number(existingPlan.revision) : 0) + 1;
  const imageId = validated.image ? crypto.randomUUID() : null;
  const learningRecordId = crypto.randomUUID();
  const storageKey = imageId ? `${imageId}.${validated.image.extension}` : null;
  const stagingPath = storageKey ? safeStoragePath(storage.stagingPath, `${storageKey}.tmp`) : null;
  const finalPath = storageKey ? safeStoragePath(storage.imagesPath, storageKey) : null;
  let staged = false;
  let published = false;
  let transactionStarted = false;

  try{
    if(validated.image){
      injectFailure(options, "image_write");
      fs.writeFileSync(stagingPath, validated.image.bytes, {flag: "wx", mode: 0o600});
      staged = true;
      fsyncPath(stagingPath);
      fsyncPath(storage.stagingPath);
    }

    db.exec("BEGIN IMMEDIATE TRANSACTION;");
    transactionStarted = true;

    const concurrentIdempotency = getIdempotency(db, validated.idempotencyKey);
    if(concurrentIdempotency){
      db.exec("ROLLBACK;");
      transactionStarted = false;
      removeFileQuietly(stagingPath);
      return replayIdempotency(concurrentIdempotency, validated.requestSha256);
    }

    const concurrentPlan = validated.planId
      ? db.prepare("SELECT revision FROM night_plans WHERE plan_id = ?").get(validated.planId)
      : null;
    const concurrentRevision = concurrentPlan ? Number(concurrentPlan.revision) : 0;
    if(concurrentRevision !== validated.expectedRevision){
      throw conflict("revision_conflict", "Night plan revision changed during save.", {
        expectedRevision: validated.expectedRevision,
        currentRevision: concurrentRevision
      });
    }

    if(validated.image){
      fs.linkSync(stagingPath, finalPath);
      published = true;
      fsyncPath(storage.imagesPath);
      fs.unlinkSync(stagingPath);
      staged = false;
      fsyncPath(storage.stagingPath);
      injectFailure(options, "after_image_publish");
    }

    injectFailure(options, "plan_write");
    writePlanRow(db, {
      planId,
      revision,
      validated,
      imageId,
      now,
      savedBy: options.savedBy
    });

    if(validated.image){
      db.prepare(`
        INSERT INTO night_plan_images (
          image_id, plan_id, plan_revision, mime_type, byte_count, sha256,
          original_file_name, storage_key, width, height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        imageId,
        planId,
        revision,
        validated.image.mimeType,
        validated.image.bytes.length,
        validated.image.sha256,
        validated.image.originalFileName,
        storageKey,
        validated.image.width,
        validated.image.height,
        now
      );
    }

    injectFailure(options, "provenance_write");
    db.prepare(`
      INSERT INTO night_plan_provenance (
        plan_id, plan_revision, source_type, ocr_engine, ocr_version,
        source_image_sha256, imported_at, human_corrected, mapping_status,
        mapping_report_json, saved_at, saved_by, final_form_sha256, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      revision,
      validated.source.sourceType,
      validated.source.ocrEngine,
      validated.source.ocrVersion,
      validated.image?.sha256 || null,
      validated.source.importedAt,
      validated.source.humanCorrected ? 1 : 0,
      validated.source.mappingStatus,
      validated.source.mappingReport ? JSON.stringify(validated.source.mappingReport) : null,
      now,
      normalizeSavedBy(options.savedBy),
      validated.finalFormSha256,
      STORAGE_SCHEMA_VERSION
    );

    injectFailure(options, "learning_write");
    db.prepare(`
      INSERT INTO night_plan_learning_records (
        learning_record_id, plan_id, plan_revision, final_form_sha256,
        source_image_sha256, learning_status, learning_source,
        canonical_form_json, created_at, model_version, pipeline_version,
        recognizer_result_json, human_ground_truth_json, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      learningRecordId,
      planId,
      revision,
      validated.finalFormSha256,
      validated.image?.sha256 || null,
      "READY",
      "HUMAN_CORRECTED_FORM",
      JSON.stringify(validated.form),
      now,
      validated.pipeline.modelVersion,
      validated.pipeline.pipelineVersion,
      validated.source.mappingReport ? JSON.stringify({
        tableCells: validated.source.mappingReport.cells || [],
        metadataCells: validated.source.mappingReport.metadataCells || []
      }) : null,
      JSON.stringify(validated.form),
      LEARNING_SCHEMA_VERSION
    );

    const response = buildSaveReadback({
      planId,
      revision,
      imageId,
      learningRecordId,
      validated,
      now,
      savedBy: options.savedBy
    });

    injectFailure(options, "before_commit");
    db.prepare(`
      INSERT INTO night_plan_idempotency (
        idempotency_key, request_sha256, plan_id, plan_revision,
        response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      validated.idempotencyKey,
      validated.requestSha256,
      planId,
      revision,
      JSON.stringify(response),
      now
    );
    db.exec("COMMIT;");
    transactionStarted = false;
    return response;
  }catch(error){
    if(transactionStarted) rollbackQuietly(db);
    if(staged) removeFileQuietly(stagingPath);
    if(published) removeFileQuietly(finalPath);
    throw error;
  }
}

function writePlanRow(db, input){
  const args = [
    input.revision,
    input.validated.form.planDate,
    input.validated.form.clock,
    input.validated.form.signature,
    input.validated.form.ds,
    JSON.stringify(input.validated.form.rows),
    input.validated.source.sourceType,
    input.validated.status,
    input.validated.createdAt,
    input.now,
    normalizeSavedBy(input.savedBy),
    PLAN_SCHEMA_VERSION,
    input.imageId,
    input.validated.finalFormSha256,
    input.planId
  ];
  const updated = db.prepare(`
    UPDATE night_plans SET
      revision = ?, plan_date = ?, clock = ?, signature = ?, ds = ?, rows_json = ?,
      source_type = ?, status = ?, created_at = ?, saved_at = ?, saved_by = ?,
      schema_version = ?, image_id = ?, final_form_sha256 = ?, operational_authority = 0
    WHERE plan_id = ?
  `).run(...args);
  if(Number(updated.changes) > 0) return;
  db.prepare(`
    INSERT INTO night_plans (
      revision, plan_date, clock, signature, ds, rows_json, source_type, status,
      created_at, saved_at, saved_by, schema_version, image_id,
      final_form_sha256, plan_id, operational_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(...args);
}

function getNightPlan(db, planId){
  ensureNightPlanSchema(db);
  const cleanPlanId = requireUuid(planId, "invalid_plan_id");
  const plan = db.prepare("SELECT * FROM night_plans WHERE plan_id = ?").get(cleanPlanId);
  if(!plan) return null;
  const image = plan.image_id
    ? db.prepare("SELECT * FROM night_plan_images WHERE image_id = ?").get(plan.image_id)
    : null;
  const provenance = db.prepare(`
    SELECT * FROM night_plan_provenance
    WHERE plan_id = ? AND plan_revision = ?
  `).get(cleanPlanId, plan.revision);
  const learning = db.prepare(`
    SELECT * FROM night_plan_learning_records
    WHERE plan_id = ? AND plan_revision = ?
  `).get(cleanPlanId, plan.revision);
  return projectStoredPlan(plan, image, provenance, learning);
}

function listNightPlans(db, limit = 50){
  ensureNightPlanSchema(db);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return db.prepare(`
    SELECT plan_id AS planId, revision, plan_date AS planDate, clock, signature, ds,
      source_type AS sourceType, status, saved_at AS savedAt,
      saved_by AS savedBy, image_id AS storedImageId,
      final_form_sha256 AS finalFormSha256
    FROM night_plans
    ORDER BY saved_at DESC, plan_id ASC
    LIMIT ?
  `).all(safeLimit).map(row => ({...row, operationalAuthority: false}));
}

function getNightPlanImage(db, planId, imageId, options = {}){
  ensureNightPlanSchema(db);
  const cleanPlanId = requireUuid(planId, "invalid_plan_id");
  const cleanImageId = requireUuid(imageId, "invalid_image_id");
  const row = db.prepare(`
    SELECT * FROM night_plan_images WHERE image_id = ? AND plan_id = ?
  `).get(cleanImageId, cleanPlanId);
  if(!row) return null;
  const storage = preparePrivateStorage(options);
  const filePath = safeStoragePath(storage.imagesPath, row.storage_key);
  const stat = fs.lstatSync(filePath);
  if(!stat.isFile() || stat.isSymbolicLink()){
    throw new NightPlanStorageError("stored_image_invalid", "Stored image is not a regular private file.", 500);
  }
  const bytes = fs.readFileSync(filePath);
  const digest = sha256(bytes);
  if(bytes.length !== Number(row.byte_count) || digest !== row.sha256){
    throw new NightPlanStorageError("stored_image_integrity_failure", "Stored image integrity check failed.", 500);
  }
  return {
    bytes,
    imageId: row.image_id,
    planId: row.plan_id,
    mimeType: row.mime_type,
    byteCount: Number(row.byte_count),
    sha256: row.sha256,
    width: Number(row.width),
    height: Number(row.height),
    originalFileName: row.original_file_name
  };
}

function cleanupNightPlanImageOrphans(db, options = {}){
  ensureNightPlanSchema(db);
  const storage = preparePrivateStorage(options);
  const referenced = new Set(db.prepare("SELECT storage_key FROM night_plan_images").all().map(row => row.storage_key));
  const removed = [];
  for(const entry of fs.readdirSync(storage.imagesPath, {withFileTypes: true})){
    if(referenced.has(entry.name)) continue;
    const candidate = safeStoragePath(storage.imagesPath, entry.name);
    if(entry.isFile() || entry.isSymbolicLink()){
      fs.unlinkSync(candidate);
      removed.push(entry.name);
    }
  }
  for(const entry of fs.readdirSync(storage.stagingPath, {withFileTypes: true})){
    const candidate = safeStoragePath(storage.stagingPath, entry.name);
    if(entry.isFile() || entry.isSymbolicLink()){
      fs.unlinkSync(candidate);
      removed.push(`staging/${entry.name}`);
    }
  }
  if(removed.some(name => name.startsWith("staging/"))) fsyncPath(storage.stagingPath);
  if(removed.some(name => !name.startsWith("staging/"))) fsyncPath(storage.imagesPath);
  return Object.freeze({removedCount: removed.length, removed: Object.freeze(removed.sort())});
}

function validateNightPlanSavePayload(payload){
  requirePlainObject(payload, "invalid_payload");
  rejectUnexpectedFields(payload, [
    "idempotencyKey", "expectedRevision", "planId", "createdAt", "status",
    "form", "source", "image", "pipeline"
  ], "unexpected_payload_field");
  const idempotencyKey = normalizeExactString(payload.idempotencyKey, 200);
  if(!idempotencyKey || !/^[A-Za-z0-9:_-]{16,200}$/.test(idempotencyKey)){
    throw invalid("invalid_idempotency_key", "A stable idempotency key is required.");
  }
  if(!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0){
    throw invalid("invalid_expected_revision", "expectedRevision must be an integer >= 0.");
  }
  const planId = payload.planId == null || payload.planId === ""
    ? null
    : requireUuid(payload.planId, "invalid_plan_id");
  const createdAt = toIsoTimestamp(payload.createdAt);
  const status = normalizeExactString(payload.status, 40);
  if(!ALLOWED_PLAN_STATUSES.has(status)){
    throw invalid("invalid_plan_status", "Only explicitly saved plans are accepted.");
  }

  const form = validateForm(payload.form);
  const source = validateSource(payload.source);
  const image = payload.image == null ? null : validateImage(payload.image);
  if(["CAMERA", "DEVICE_FILE"].includes(source.sourceType) && !image){
    throw invalid("source_image_required", "Camera and device-file plans require their original source image.");
  }
  if(["MANUAL", "LEGACY_LOCAL"].includes(source.sourceType) && image){
    throw invalid("non_image_plan_image_not_allowed", "Manual and legacy plans must not claim an image source.");
  }
  const pipeline = validatePipeline(payload.pipeline);
  const finalFormSha256 = sha256(Buffer.from(canonicalJson(form), "utf8"));
  const requestDescriptor = {
    expectedRevision: payload.expectedRevision,
    planId,
    createdAt,
    status,
    form,
    source,
    image: image ? {
      mimeType: image.mimeType,
      originalFileName: image.originalFileName,
      sha256: image.sha256,
      byteCount: image.bytes.length,
      width: image.width,
      height: image.height
    } : null,
    pipeline
  };
  return Object.freeze({
    idempotencyKey,
    expectedRevision: payload.expectedRevision,
    planId,
    createdAt,
    status,
    form,
    source,
    image,
    pipeline,
    finalFormSha256,
    requestSha256: sha256(Buffer.from(canonicalJson(requestDescriptor), "utf8"))
  });
}

function validateForm(value){
  requirePlainObject(value, "invalid_form");
  rejectUnexpectedFields(value, ["planDate", "clock", "signature", "ds", "rows"], "unexpected_form_field");
  const planDate = normalizeExactString(value.planDate, 10);
  if(!planDate || !/^\d{4}-\d{2}-\d{2}$/.test(planDate) || Number.isNaN(Date.parse(`${planDate}T00:00:00Z`))){
    throw invalid("invalid_plan_date", "planDate must be a valid ISO date.");
  }
  const signature = normalizeFormString(value.signature, 120, "signature");
  if(!signature) throw invalid("signature_required", "signature is required.");
  const ds = normalizeFormString(value.ds, 120, "ds");
  const clock = normalizeFormString(value.clock, 20, "clock");
  if(!Array.isArray(value.rows) || value.rows.length !== ROW_COUNT){
    throw invalid("invalid_row_count", `Exactly ${ROW_COUNT} plan rows are required.`);
  }
  const rows = value.rows.map((row, index) => validateRow(row, index));
  return Object.freeze({planDate, clock, signature, ds, rows: Object.freeze(rows)});
}

function validateRow(value, index){
  requirePlainObject(value, "invalid_plan_row");
  rejectUnexpectedFields(value, ROW_FIELDS, "unexpected_row_field");
  const normalized = {};
  for(const field of ROW_FIELDS){
    const maximum = ["info", "notes"].includes(field) ? 500 : 120;
    normalized[field] = normalizeFormString(value[field], maximum, `rows[${index}].${field}`);
  }
  return Object.freeze(normalized);
}

function validateSource(value){
  requirePlainObject(value, "invalid_source");
  rejectUnexpectedFields(value, [
    "sourceType", "ocrEngine", "ocrVersion", "importedAt", "humanCorrected",
    "mappingStatus", "mappingReport"
  ], "unexpected_source_field");
  const sourceType = normalizeExactString(value.sourceType, 40);
  if(!ALLOWED_SOURCE_TYPES.has(sourceType)){
    throw invalid("invalid_source_type", "sourceType must be CAMERA, DEVICE_FILE, MANUAL or LEGACY_LOCAL.");
  }
  const humanCorrected = value.humanCorrected === true;
  if(!humanCorrected){
    throw invalid("human_correction_required", "The final saved form must be human controlled.");
  }
  const imageSource = ["CAMERA", "DEVICE_FILE"].includes(sourceType);
  const importedAt = imageSource ? toIsoTimestamp(value.importedAt) : null;
  const ocrEngine = imageSource ? normalizeNullableString(value.ocrEngine, 120, "ocrEngine") : null;
  const ocrVersion = imageSource ? normalizeNullableString(value.ocrVersion, 120, "ocrVersion") : null;
  const mappingStatus = imageSource ? normalizeNullableString(value.mappingStatus, 80, "mappingStatus") : null;
  if(imageSource && !ALLOWED_MAPPING_STATUSES.has(mappingStatus)){
    throw invalid("invalid_mapping_status", "Image plans require an explicit truthful mappingStatus.");
  }
  const mappingReport = imageSource && value.mappingReport != null ? validateMappingReport(value.mappingReport) : null;
  if(mappingReport && mappingReport.mappingStatus !== mappingStatus){
    throw invalid("mapping_status_mismatch", "mappingStatus must match the structured mapping report.");
  }
  if(imageSource && ocrEngine && mappingStatus !== "NOT_RUN_HUMAN_ENTERED" && !mappingReport){
    throw invalid("mapping_report_required", "OCR-backed plans require their structured mapping report.");
  }
  if(!imageSource && (value.mappingStatus != null || value.mappingReport != null)){
    throw invalid("non_image_mapping_not_allowed", "Manual and legacy plans cannot claim OCR mapping provenance.");
  }
  return Object.freeze({sourceType, ocrEngine, ocrVersion, importedAt, humanCorrected, mappingStatus, mappingReport});
}

function validateMappingReport(value){
  requirePlainObject(value, "invalid_mapping_report");
  if(["sde-night-form-mapping-report-v2", "sde-night-form-mapping-report-v3", "sde-night-form-mapping-report-v4"].includes(value.schemaVersion)) return validateHtrMappingReport(value);
  rejectUnexpectedFields(value, [
    "schemaVersion", "ocrTokenCount", "recognizedLineCount", "detectedHeaderCount",
    "detectedRowCount", "mappedCellCount", "unmappedTokenCount", "mappingConfidence",
    "mappingStatus", "discardedReasonCounts", "geometrySource", "requiresHumanReview"
  ], "unexpected_mapping_report_field");
  if(normalizeExactString(value.schemaVersion, 100) !== "sde-night-form-mapping-report-v1"){
    throw invalid("invalid_mapping_report_schema", "Unsupported mapping report schema.");
  }
  const integerFields = [
    "ocrTokenCount", "recognizedLineCount", "detectedHeaderCount", "detectedRowCount",
    "mappedCellCount", "unmappedTokenCount"
  ];
  const report = {schemaVersion: "sde-night-form-mapping-report-v1"};
  for(const field of integerFields){
    const count = Number(value[field]);
    if(!Number.isInteger(count) || count < 0 || count > 100000){
      throw invalid("invalid_mapping_report_count", `${field} must be a bounded non-negative integer.`);
    }
    report[field] = count;
  }
  const mappingConfidence = Number(value.mappingConfidence);
  if(!Number.isFinite(mappingConfidence) || mappingConfidence < 0 || mappingConfidence > 1){
    throw invalid("invalid_mapping_confidence", "mappingConfidence must be between zero and one.");
  }
  report.mappingConfidence = mappingConfidence;
  report.mappingStatus = normalizeExactString(value.mappingStatus, 80);
  if(!ALLOWED_MAPPING_STATUSES.has(report.mappingStatus) || report.mappingStatus === "NOT_RUN_HUMAN_ENTERED"){
    throw invalid("invalid_mapping_status", "The mapping report has an invalid mappingStatus.");
  }
  requirePlainObject(value.discardedReasonCounts, "invalid_discarded_reason_counts");
  const allowedReasons = new Set(["MISSING_GEOMETRY", "OUTSIDE_FORM", "LOW_CONFIDENCE"]);
  const reasonCounts = {};
  for(const [reason, rawCount] of Object.entries(value.discardedReasonCounts)){
    if(!allowedReasons.has(reason) || !Number.isInteger(rawCount) || rawCount < 0 || rawCount > 100000){
      throw invalid("invalid_discarded_reason_count", "Discard reasons must be allowlisted bounded counts.");
    }
    reasonCounts[reason] = rawCount;
  }
  report.discardedReasonCounts = Object.freeze(reasonCounts);
  report.geometrySource = normalizeNullableString(value.geometrySource, 120, "geometrySource");
  report.requiresHumanReview = value.requiresHumanReview === true;
  return Object.freeze(report);
}

function validateHtrMappingReport(value){
  rejectUnexpectedFields(value, [
    "schemaVersion", "mappingStatus", "htrCompleted", "registrationStatus",
    "templateId", "templateVersion", "columnCount", "recognitionMode",
    "recognizerVersion", "modelSha256", "cellCount",
    "mappedCellCount", "suggestedCellCount", "recognizedCellCount", "reviewedCellCount", "requiresHumanReview",
    "mappingConfidence", "cells", "metadataCells", "humanGroundTruthSource",
    "rawRecognizerIsGroundTruth", "humanReviewCompleted", "correctionBurden"
  ], "unexpected_mapping_report_field");
  const schemaVersion = normalizeExactString(value.schemaVersion, 100);
  const report = {schemaVersion};
  report.mappingStatus = normalizeExactString(value.mappingStatus, 80);
  if(!ALLOWED_MAPPING_STATUSES.has(report.mappingStatus) || ["NOT_RUN_HUMAN_ENTERED", "OCR_FAILED"].includes(report.mappingStatus)){
    throw invalid("invalid_mapping_status", "The HTR mapping report has an invalid mappingStatus.");
  }
  if(value.htrCompleted !== true) throw invalid("htr_not_completed", "An HTR mapping report requires completed handwriting recognition.");
  report.htrCompleted = true;
  report.registrationStatus = normalizeExactString(value.registrationStatus, 80);
  if(!["CELLS_SEGMENTED", "CELL_SEGMENTATION_COMPLETE"].includes(report.registrationStatus)) throw invalid("invalid_registration_status", "The 29-row cell segmentation must be complete.");
  report.templateId = ["sde-night-form-mapping-report-v3", "sde-night-form-mapping-report-v4"].includes(schemaVersion)
    ? normalizeExactString(value.templateId, 40)
    : "TEMPLATE_A";
  const templateColumns = TEMPLATE_COLUMNS[report.templateId];
  if(!templateColumns) throw invalid("invalid_htr_template", "The HTR form template is unsupported.");
  report.columnCount = ["sde-night-form-mapping-report-v3", "sde-night-form-mapping-report-v4"].includes(schemaVersion) ? Number(value.columnCount) : templateColumns.length;
  if(report.columnCount !== templateColumns.length) throw invalid("invalid_htr_column_count", "The HTR column count does not match the template.");
  report.recognitionMode = ["sde-night-form-mapping-report-v3", "sde-night-form-mapping-report-v4"].includes(schemaVersion)
    ? normalizeExactString(value.recognitionMode, 80)
    : "HANDWRITING_HTR";
  if(schemaVersion === "sde-night-form-mapping-report-v3" && report.recognitionMode !== "HYBRID_PRINT_OCR_HTR"){
    throw invalid("invalid_htr_recognition_mode", "Template v3 requires hybrid print OCR and HTR provenance.");
  }
  if(schemaVersion === "sde-night-form-mapping-report-v4" && report.recognitionMode !== "LOCAL_REAL_HTR_ENSEMBLE"){
    throw invalid("invalid_htr_recognition_mode", "Template v4 requires real local HTR ensemble provenance.");
  }
  report.templateVersion = normalizeExactString(value.templateVersion, 120);
  report.recognizerVersion = normalizeExactString(value.recognizerVersion, 120);
  report.modelSha256 = normalizeExactString(value.modelSha256, 64);
  if(!report.templateVersion || !report.recognizerVersion || !/^[a-f0-9]{64}$/.test(report.modelSha256 || "")){
    throw invalid("invalid_htr_provenance", "HTR template, recognizer and model hash provenance are required.");
  }
  for(const field of ["cellCount", "mappedCellCount", "reviewedCellCount"]){
    const count = Number(value[field]);
    if(!Number.isInteger(count) || count < 0 || count > 235) throw invalid("invalid_mapping_report_count", `${field} is invalid.`);
    report[field] = count;
  }
  if(!Array.isArray(value.cells) || value.cells.length !== ROW_COUNT * templateColumns.length || report.cellCount !== value.cells.length){
    throw invalid("invalid_htr_cell_count", `Exactly 29 x ${templateColumns.length} HTR table cells are required.`);
  }
  report.cells = Object.freeze(value.cells.map((cell, index) => validateHtrCell(cell, index, false, templateColumns)));
  if(!Array.isArray(value.metadataCells) || value.metadataCells.length !== 3){
    throw invalid("invalid_htr_metadata_cell_count", "Exactly the date, signature and ds HTR metadata cells are required.");
  }
  const expectedMetadata = report.templateId === "TEMPLATE_B" ? ["clock", "date", "signature"] : ["date", "signature", "ds"];
  report.metadataCells = Object.freeze(value.metadataCells.map((cell, index) => validateHtrCell(cell, index, true, expectedMetadata)));
  const metadataColumns = new Set(report.metadataCells.map(cell => cell.columnId));
  if(metadataColumns.size !== 3 || !expectedMetadata.every(column => metadataColumns.has(column))){
    throw invalid("invalid_htr_metadata_cells", "HTR metadata cells do not match the detected template.");
  }
  const actualMapped = report.cells.filter(cell => cell.selectedValue).length;
  if(actualMapped !== report.mappedCellCount) throw invalid("mapped_cell_count_mismatch", "mappedCellCount does not match the HTR cells.");
  if(schemaVersion === "sde-night-form-mapping-report-v4"){
    report.suggestedCellCount = Number(value.suggestedCellCount);
    report.recognizedCellCount = Number(value.recognizedCellCount);
    const actualSuggested = report.cells.filter(cell => cell.suggestedValue).length;
    const actualRecognized = report.cells.filter(cell => cell.selectedValue || cell.suggestedValue).length;
    if(!Number.isInteger(report.suggestedCellCount) || report.suggestedCellCount !== actualSuggested){
      throw invalid("suggested_cell_count_mismatch", "suggestedCellCount does not match the HTR cells.");
    }
    if(!Number.isInteger(report.recognizedCellCount) || report.recognizedCellCount !== actualRecognized){
      throw invalid("recognized_cell_count_mismatch", "recognizedCellCount does not match the HTR cells.");
    }
    report.correctionBurden = value.correctionBurden == null ? null : validateCorrectionBurden(value.correctionBurden);
  }
  const confidence = Number(value.mappingConfidence);
  if(!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw invalid("invalid_mapping_confidence", "mappingConfidence must be between zero and one.");
  report.mappingConfidence = confidence;
  report.requiresHumanReview = value.requiresHumanReview === true;
  report.humanGroundTruthSource = value.humanGroundTruthSource == null
    ? null
    : normalizeExactString(value.humanGroundTruthSource, 80);
  if(report.humanGroundTruthSource && report.humanGroundTruthSource !== "HUMAN_CORRECTED_FORM"){
    throw invalid("invalid_learning_ground_truth", "Only the human-corrected form can be learning ground truth.");
  }
  report.rawRecognizerIsGroundTruth = value.rawRecognizerIsGroundTruth === true;
  if(report.rawRecognizerIsGroundTruth) throw invalid("raw_recognizer_ground_truth_forbidden", "Raw recognizer output cannot be learning ground truth.");
  report.humanReviewCompleted = value.humanReviewCompleted === true;
  return Object.freeze(report);
}

function validateHtrCell(value, index, metadata = false, allowedColumns = []){
  requirePlainObject(value, "invalid_htr_cell");
  rejectUnexpectedFields(value, [
    "rowIndex", "columnId", "boundingBox", "recognizedText", "normalizedValue",
    "selectedValue", "suggestedValue", "disposition", "humanDisposition", "confidence", "alternatives", "needsReview",
    "validationState", "recognizerVersion", "groundTruthSource",
    "rawRecognizerIsGroundTruth", "imageEvidence", "humanFinalValue",
    "recognizerDisposition", "recognizerSelectedValue", "recognizerSuggestedValue", "learningOutcome",
    "rawCandidates", "printedCandidate", "handwrittenCandidate", "finalCandidate",
    "recognitionMode", "sourceBoundingBox", "normalizationReason"
  ], "unexpected_htr_cell_field");
  const rowIndex = metadata ? null : Number(value.rowIndex);
  if(metadata && value.rowIndex !== null) throw invalid("invalid_htr_row", `HTR metadata cell ${index} must not claim a table row.`);
  if(!metadata && (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= ROW_COUNT)) throw invalid("invalid_htr_row", `HTR cell ${index} has an invalid row.`);
  const columnId = normalizeExactString(value.columnId, 40);
  if(!allowedColumns.includes(columnId)) throw invalid("invalid_htr_column", `HTR cell ${index} has an invalid column.`);
  const boundingBox = validateHtrBoundingBox(value.boundingBox);
  const maximum = ["info", "notes"].includes(columnId) ? 500 : 120;
  const recognizedText = normalizeFormString(value.recognizedText, maximum, `cells[${index}].recognizedText`);
  const normalizedValue = normalizeFormString(value.normalizedValue, maximum, `cells[${index}].normalizedValue`);
  const selectedValue = normalizeFormString(value.selectedValue, maximum, `cells[${index}].selectedValue`);
  const suggestedValue = normalizeFormString(value.suggestedValue, maximum, `cells[${index}].suggestedValue`);
  const legacyDisposition = selectedValue
    ? "AUTO_ACCEPTED"
    : value.needsReview && suggestedValue
      ? "REVIEW_SUGGESTION"
      : value.needsReview
        ? "REJECTED"
        : "EMPTY";
  const disposition = normalizeExactString(value.disposition || legacyDisposition, 80);
  if(!["AUTO_ACCEPTED", "REVIEW_SUGGESTION", "REJECTED", "EMPTY", "HUMAN_CONFIRMED"].includes(disposition)){
    throw invalid("invalid_htr_disposition", `HTR cell ${index} has an invalid disposition.`);
  }
  if(disposition === "AUTO_ACCEPTED" && (!selectedValue || suggestedValue)) throw invalid("invalid_htr_disposition", "AUTO_ACCEPTED requires only a canonical selected value.");
  if(disposition === "REVIEW_SUGGESTION" && (selectedValue || !suggestedValue)) throw invalid("review_suggestion_as_form_value", "Review suggestions must remain separate from canonical form values.");
  if(["REJECTED", "EMPTY"].includes(disposition) && (selectedValue || suggestedValue)) throw invalid("invalid_htr_disposition", "Rejected and empty cells cannot contain accepted or suggested values.");
  const humanDisposition = value.humanDisposition == null ? null : normalizeExactString(value.humanDisposition, 80);
  if(humanDisposition && !["ACCEPT_SUGGESTION", "EDIT_VALUE", "LEAVE_BLANK"].includes(humanDisposition)){
    throw invalid("invalid_human_recognition_disposition", `HTR cell ${index} has an invalid human disposition.`);
  }
  const confidence = Number(value.confidence);
  if(!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw invalid("invalid_htr_confidence", `HTR cell ${index} has invalid confidence.`);
  if(!Array.isArray(value.alternatives) || value.alternatives.length > 8) throw invalid("invalid_htr_alternatives", `HTR cell ${index} has invalid alternatives.`);
  const alternatives = value.alternatives.map((alternative, candidateIndex) => normalizeFormString(alternative, maximum, `cells[${index}].alternatives[${candidateIndex}]`));
  const recognizerVersion = normalizeExactString(value.recognizerVersion, 120);
  if(!recognizerVersion) throw invalid("invalid_htr_recognizer_version", `HTR cell ${index} lacks recognizer provenance.`);
  const groundTruthSource = normalizeExactString(value.groundTruthSource, 80);
  if(!["UNCONFIRMED_RECOGNIZER_OUTPUT", "HUMAN_CORRECTED_FORM"].includes(groundTruthSource)){
    throw invalid("invalid_htr_ground_truth_source", `HTR cell ${index} has invalid ground-truth provenance.`);
  }
  if(value.rawRecognizerIsGroundTruth === true) throw invalid("raw_recognizer_ground_truth_forbidden", "Raw recognizer output cannot be learning ground truth.");
  const humanFinalValue = value.humanFinalValue == null
    ? null
    : normalizeFormString(value.humanFinalValue, maximum, `cells[${index}].humanFinalValue`);
  const recognizerDisposition = value.recognizerDisposition == null ? null : normalizeExactString(value.recognizerDisposition, 80);
  if(recognizerDisposition && !["AUTO_ACCEPTED", "REVIEW_SUGGESTION", "REJECTED", "EMPTY"].includes(recognizerDisposition)){
    throw invalid("invalid_recognizer_disposition", `HTR cell ${index} has invalid original recognizer disposition.`);
  }
  const recognizerSelectedValue = value.recognizerSelectedValue == null
    ? null : normalizeFormString(value.recognizerSelectedValue, maximum, `cells[${index}].recognizerSelectedValue`);
  const recognizerSuggestedValue = value.recognizerSuggestedValue == null
    ? null : normalizeFormString(value.recognizerSuggestedValue, maximum, `cells[${index}].recognizerSuggestedValue`);
  const learningOutcome = value.learningOutcome == null ? null : normalizeExactString(value.learningOutcome, 80);
  if(learningOutcome && !["AUTO_ACCEPTED_UNCHANGED", "CORRECTED", "ENTERED_FROM_EMPTY", "REJECTED"].includes(learningOutcome)){
    throw invalid("invalid_learning_outcome", `HTR cell ${index} has invalid learning outcome.`);
  }
  requirePlainObject(value.imageEvidence, "invalid_htr_image_evidence");
  rejectUnexpectedFields(value.imageEvidence, [
    "inkRatio", "printInkRatio", "handwritingInkRatio", "strikeThroughDetected", "gridLineMask", "blank", "blankClassification", "symbolClassification", "structuredGlyphClassification"
  ], "unexpected_htr_image_evidence_field");
  const inkRatio = Number(value.imageEvidence.inkRatio);
  if(!Number.isFinite(inkRatio) || inkRatio < 0 || inkRatio > 1 || typeof value.imageEvidence.blank !== "boolean"){
    throw invalid("invalid_htr_image_evidence", `HTR cell ${index} has invalid image evidence.`);
  }
  const evidenceRatio = field => {
    if(value.imageEvidence[field] == null) return 0;
    const ratio = Number(value.imageEvidence[field]);
    if(!Number.isFinite(ratio) || ratio < 0 || ratio > 1){
      throw invalid("invalid_htr_image_evidence", `HTR cell ${index} has invalid ${field}.`);
    }
    return ratio;
  };
  if(value.imageEvidence.strikeThroughDetected != null && typeof value.imageEvidence.strikeThroughDetected !== "boolean"){
    throw invalid("invalid_htr_image_evidence", `HTR cell ${index} has invalid strike-through evidence.`);
  }
  let gridLineMask = null;
  if(value.imageEvidence.gridLineMask != null){
    requirePlainObject(value.imageEvidence.gridLineMask, "invalid_htr_grid_line_mask");
    rejectUnexpectedFields(value.imageEvidence.gridLineMask, [
      "horizontalLineCount", "verticalLineCount", "gridPixelCount", "adaptiveInkNormalizationApplied"
    ], "unexpected_htr_grid_line_mask_field");
    gridLineMask = {};
    for(const field of ["horizontalLineCount", "verticalLineCount", "gridPixelCount"]){
      const count = Number(value.imageEvidence.gridLineMask[field]);
      if(!Number.isInteger(count) || count < 0 || count > 1000000){
        throw invalid("invalid_htr_grid_line_mask", `HTR cell ${index} has invalid grid-mask evidence.`);
      }
      gridLineMask[field] = count;
    }
    gridLineMask = Object.freeze(gridLineMask);
  }
  let blankClassification = null;
  if(value.imageEvidence.blankClassification != null){
    requirePlainObject(value.imageEvidence.blankClassification, "invalid_htr_blank_classification");
    rejectUnexpectedFields(value.imageEvidence.blankClassification, [
      "blank", "inkPixelCount", "meaningfulPixels", "meaningfulInkRatio", "meaningfulComponentCount", "largestComponentPixels", "reason"
    ], "unexpected_htr_blank_classification_field");
    const ratio = Number(value.imageEvidence.blankClassification.meaningfulInkRatio);
    if(typeof value.imageEvidence.blankClassification.blank !== "boolean" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1){
      throw invalid("invalid_htr_blank_classification", `HTR cell ${index} has invalid blank-classifier evidence.`);
    }
    blankClassification = Object.freeze({
      blank: value.imageEvidence.blankClassification.blank,
      inkPixelCount: boundedCount(value.imageEvidence.blankClassification.inkPixelCount, "invalid_htr_blank_classification"),
      meaningfulPixels: boundedCount(value.imageEvidence.blankClassification.meaningfulPixels, "invalid_htr_blank_classification"),
      meaningfulInkRatio: ratio,
      meaningfulComponentCount: boundedCount(value.imageEvidence.blankClassification.meaningfulComponentCount, "invalid_htr_blank_classification"),
      largestComponentPixels: boundedCount(value.imageEvidence.blankClassification.largestComponentPixels, "invalid_htr_blank_classification"),
      reason: normalizeExactString(value.imageEvidence.blankClassification.reason, 120),
    });
  }
  const symbolClassification = value.imageEvidence.symbolClassification == null
    ? null : validateClassifierEvidence(value.imageEvidence.symbolClassification, ["symbol", "confidence", "reason", "aspect", "occupancy", "centerDensity", "quadrants"]);
  const structuredGlyphClassification = value.imageEvidence.structuredGlyphClassification == null
    ? null : validateClassifierEvidence(value.imageEvidence.structuredGlyphClassification, ["value", "confidence", "reason", "aspect", "heightRatio", "occupiedRows", "occupancy"]);
  const printedCandidate = validateLayerCandidate(value.printedCandidate, `cells[${index}].printedCandidate`);
  const handwrittenCandidate = validateLayerCandidate(value.handwrittenCandidate, `cells[${index}].handwrittenCandidate`);
  const finalCandidate = validateLayerCandidate(value.finalCandidate, `cells[${index}].finalCandidate`, true);
  const rawCandidateValues = value.rawCandidates == null ? [] : value.rawCandidates;
  if(!Array.isArray(rawCandidateValues) || rawCandidateValues.length > 32) throw invalid("invalid_htr_raw_candidates", `HTR cell ${index} has invalid raw candidates.`);
  const rawCandidates = Object.freeze(rawCandidateValues.map((candidate, candidateIndex) => validateLayerCandidate(candidate, `cells[${index}].rawCandidates[${candidateIndex}]`, false, true)));
  const recognitionMode = normalizeExactString(value.recognitionMode || "HANDWRITING_HTR", 80);
  const normalizationReason = normalizeNullableString(value.normalizationReason, 120, "normalizationReason");
  const sourceBoundingBox = value.sourceBoundingBox == null ? boundingBox : validateHtrBoundingBox(value.sourceBoundingBox);
  return Object.freeze({
    rowIndex, columnId, boundingBox, recognizedText, normalizedValue,
    selectedValue, suggestedValue, disposition, humanDisposition, confidence, alternatives: Object.freeze(alternatives),
    needsReview: value.needsReview === true,
    validationState: normalizeExactString(value.validationState, 80),
    recognizerVersion, groundTruthSource, rawRecognizerIsGroundTruth: false,
    imageEvidence: Object.freeze({
      inkRatio,
      printInkRatio: evidenceRatio("printInkRatio"),
      handwritingInkRatio: evidenceRatio("handwritingInkRatio"),
      strikeThroughDetected: value.imageEvidence.strikeThroughDetected === true,
      gridLineMask,
      blank: value.imageEvidence.blank,
      blankClassification,
      symbolClassification,
      structuredGlyphClassification,
    }),
    rawCandidates, printedCandidate, handwrittenCandidate, finalCandidate, recognitionMode,
    sourceBoundingBox, normalizationReason, humanFinalValue,
    recognizerDisposition, recognizerSelectedValue, recognizerSuggestedValue, learningOutcome
  });
}

function validateCorrectionBurden(value){
  requirePlainObject(value, "invalid_htr_correction_burden");
  const countFields = [
    "reviewedCellCount", "acceptedSuggestionCount", "editedCellCount", "leftBlankCount",
    "nonEmptyGroundTruthCells", "autoAcceptedCorrect", "autoAcceptedIncorrect",
    "reviewSuggestions", "emptyRejected", "manuallyChangedCells",
    "characterEditsRequired", "fieldsEnteredFromScratch"
  ];
  const ratioFields = [
    "manualCorrectionRate", "manualCellEditsRequiredRate", "characterEditDistancePerNonEmptyCell"
  ];
  rejectUnexpectedFields(value, [...countFields, ...ratioFields], "unexpected_htr_correction_burden_field");
  const result = {};
  for(const field of countFields) result[field] = boundedCount(value[field], "invalid_htr_correction_burden");
  for(const field of ratioFields){
    const ratio = Number(value[field]);
    const maximum = field === "characterEditDistancePerNonEmptyCell" ? 500 : 1;
    if(!Number.isFinite(ratio) || ratio < 0 || ratio > maximum){
      throw invalid("invalid_htr_correction_burden", `${field} is invalid.`);
    }
    result[field] = ratio;
  }
  if(result.manualCorrectionRate !== result.manualCellEditsRequiredRate){
    throw invalid("invalid_htr_correction_burden", "Correction-rate aliases disagree.");
  }
  return Object.freeze(result);
}

function validateLayerCandidate(value, label, allowBlank = false, allowSource = false){
  if(value == null) return null;
  requirePlainObject(value, "invalid_htr_layer_candidate");
  rejectUnexpectedFields(value, allowSource ? ["text", "confidence", "votes", "sourceLayer"] : ["text", "confidence", "votes"], "unexpected_htr_layer_candidate_field");
  const text = normalizeFormString(value.text, 500, `${label}.text`);
  const confidence = Number(value.confidence);
  if((!text && !allowBlank) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1){
    throw invalid("invalid_htr_layer_candidate", `${label} is invalid.`);
  }
  const candidate = {text, confidence};
  if(value.votes != null) candidate.votes = boundedCount(value.votes, "invalid_htr_layer_candidate");
  if(allowSource) candidate.sourceLayer = normalizeExactString(value.sourceLayer, 40);
  return Object.freeze(candidate);
}

function boundedCount(value, code){
  const count = Number(value);
  if(!Number.isInteger(count) || count < 0 || count > 1000000) throw invalid(code, "A bounded non-negative integer is required.");
  return count;
}

function validateClassifierEvidence(value, allowedFields){
  requirePlainObject(value, "invalid_htr_classifier_evidence");
  rejectUnexpectedFields(value, allowedFields, "unexpected_htr_classifier_evidence_field");
  const result = {};
  for(const [key, raw] of Object.entries(value)){
    if(["symbol", "value", "reason"].includes(key)) result[key] = normalizeExactString(raw, 120);
    else if(key === "quadrants") result[key] = boundedCount(raw, "invalid_htr_classifier_evidence");
    else {
      const number = Number(raw);
      if(!Number.isFinite(number) || number < 0 || number > 4) throw invalid("invalid_htr_classifier_evidence", "Classifier evidence is invalid.");
      result[key] = number;
    }
  }
  return Object.freeze(result);
}

function validateHtrBoundingBox(value){
  requirePlainObject(value, "invalid_htr_bounding_box");
  rejectUnexpectedFields(value, ["x0", "y0", "x1", "y1", "coordinateSpace", "polygon"], "unexpected_htr_bounding_box_field");
  const box = {};
  for(const field of ["x0", "y0", "x1", "y1"]){
    const coordinate = Number(value[field]);
    if(!Number.isFinite(coordinate) || coordinate < 0 || coordinate > MAX_IMAGE_DIMENSION) throw invalid("invalid_htr_bounding_box", "HTR image coordinates are invalid.");
    box[field] = coordinate;
  }
  if(!(box.x1 > box.x0) || !(box.y1 > box.y0) || value.coordinateSpace !== "ORIGINAL_IMAGE"){
    throw invalid("invalid_htr_bounding_box", "HTR bounding boxes must use original-image coordinates.");
  }
  if(!Array.isArray(value.polygon) || value.polygon.length !== 4) throw invalid("invalid_htr_polygon", "HTR bounding polygons require four points.");
  box.coordinateSpace = "ORIGINAL_IMAGE";
  box.polygon = Object.freeze(value.polygon.map(point => {
    requirePlainObject(point, "invalid_htr_polygon_point");
    rejectUnexpectedFields(point, ["x", "y"], "unexpected_htr_polygon_point_field");
    const x = Number(point.x);
    const y = Number(point.y);
    if(!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > MAX_IMAGE_DIMENSION || y > MAX_IMAGE_DIMENSION){
      throw invalid("invalid_htr_polygon_point", "HTR polygon coordinates are invalid.");
    }
    return Object.freeze({x, y});
  }));
  return Object.freeze(box);
}

function validatePipeline(value){
  if(value == null) return Object.freeze({modelVersion: null, pipelineVersion: null});
  requirePlainObject(value, "invalid_pipeline");
  rejectUnexpectedFields(value, ["modelVersion", "pipelineVersion"], "unexpected_pipeline_field");
  return Object.freeze({
    modelVersion: normalizeNullableString(value.modelVersion, 120, "modelVersion"),
    pipelineVersion: normalizeNullableString(value.pipelineVersion, 120, "pipelineVersion")
  });
}

function validateImage(value){
  requirePlainObject(value, "invalid_image");
  rejectUnexpectedFields(value, ["mimeType", "originalFileName", "bytesBase64"], "unexpected_image_field");
  const declaredMimeType = normalizeExactString(value.mimeType, 80);
  if(!ALLOWED_MIME_TYPES.includes(declaredMimeType)){
    throw invalid("unsupported_image_type", "Only JPEG and PNG source images are supported.");
  }
  const originalFileName = normalizeOriginalFileName(value.originalFileName);
  const bytes = decodeBase64(value.bytesBase64);
  if(bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES){
    throw invalid("image_size_invalid", `Image must contain 1-${MAX_IMAGE_BYTES} bytes.`);
  }
  const detected = detectImage(bytes);
  if(!detected || detected.mimeType !== declaredMimeType){
    throw invalid("image_mime_mismatch", "Declared image MIME type does not match the received bytes.");
  }
  if(
    detected.width < 1 || detected.height < 1 ||
    detected.width > MAX_IMAGE_DIMENSION || detected.height > MAX_IMAGE_DIMENSION ||
    detected.width * detected.height > MAX_IMAGE_PIXELS
  ){
    throw invalid("image_dimensions_invalid", "Image dimensions exceed the safe processing limits.");
  }
  return Object.freeze({
    bytes,
    mimeType: detected.mimeType,
    extension: detected.extension,
    originalFileName,
    width: detected.width,
    height: detected.height,
    sha256: sha256(bytes)
  });
}

function detectImage(bytes){
  if(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    if(bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    if(!bytes.subarray(bytes.length - 12, bytes.length - 8).equals(Buffer.from([0,0,0,0])) ||
       bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii") !== "IEND") return null;
    return {mimeType: "image/png", extension: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  }
  if(
    bytes.length >= 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ){
    let offset = 2;
    while(offset + 9 < bytes.length){
      if(bytes[offset] !== 0xff){ offset += 1; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if(marker === 0xd8 || marker === 0xd9) continue;
      if(offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if(length < 2 || offset + length > bytes.length) break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length < 7) return null;
        return {
          mimeType: "image/jpeg",
          extension: "jpg",
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5)
        };
      }
      offset += length;
    }
  }
  return null;
}

function preparePrivateStorage(options = {}){
  const rawRoot = options.imageStorageRoot;
  if(typeof rawRoot !== "string" || !rawRoot.trim()){
    throw new NightPlanStorageError("image_storage_not_configured", "Private night-plan image storage is not configured.", 503);
  }
  const requestedRootPath = path.resolve(rawRoot.trim());
  const requestedRepositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : null;
  const prospectiveRootPath = resolveProspectiveRealPath(requestedRootPath);
  const repositoryRoot = requestedRepositoryRoot
    ? resolveProspectiveRealPath(requestedRepositoryRoot)
    : null;
  if(repositoryRoot && (prospectiveRootPath === repositoryRoot || isInside(prospectiveRootPath, repositoryRoot))){
    throw new NightPlanStorageError("image_storage_inside_repository", "Private image storage must be outside the repository.", 503);
  }
  fs.mkdirSync(requestedRootPath, {recursive: true, mode: 0o700});
  const rootStat = fs.lstatSync(requestedRootPath);
  if(!rootStat.isDirectory() || rootStat.isSymbolicLink()){
    throw new NightPlanStorageError("image_storage_unsafe", "Private image storage root is unsafe.", 503);
  }
  const rootPath = fs.realpathSync(requestedRootPath);
  if(repositoryRoot && (rootPath === repositoryRoot || isInside(rootPath, repositoryRoot))){
    throw new NightPlanStorageError("image_storage_inside_repository", "Private image storage must be outside the repository.", 503);
  }
  fs.chmodSync(rootPath, 0o700);
  const imagesPath = path.join(rootPath, "images");
  const stagingPath = path.join(rootPath, "staging");
  for(const directory of [imagesPath, stagingPath]){
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(directory);
    if(!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory){
      throw new NightPlanStorageError("image_storage_unsafe", "Private image storage subdirectory is unsafe.", 503);
    }
    fs.chmodSync(directory, 0o700);
  }
  return Object.freeze({rootPath, imagesPath, stagingPath});
}

function resolveProspectiveRealPath(candidatePath){
  let existingAncestor = path.resolve(candidatePath);
  const missingSegments = [];
  while(!fs.existsSync(existingAncestor)){
    const parent = path.dirname(existingAncestor);
    if(parent === existingAncestor){
      throw new NightPlanStorageError("image_storage_unsafe", "Private image storage path cannot be resolved safely.", 503);
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const ancestorStat = fs.lstatSync(existingAncestor);
  if(!ancestorStat.isDirectory() && !ancestorStat.isSymbolicLink()){
    throw new NightPlanStorageError("image_storage_unsafe", "Private image storage path has an unsafe ancestor.", 503);
  }
  return path.resolve(fs.realpathSync(existingAncestor), ...missingSegments);
}

function safeStoragePath(directory, storageKey){
  if(typeof storageKey !== "string" || !/^[0-9a-f-]{36}\.(?:png|jpg)(?:\.tmp)?$/.test(storageKey)){
    throw new NightPlanStorageError("invalid_storage_key", "Internal image storage key is invalid.", 500);
  }
  const candidate = path.resolve(directory, storageKey);
  if(!isInside(candidate, directory)){
    throw new NightPlanStorageError("image_storage_escape", "Image storage path escaped its private root.", 500);
  }
  return candidate;
}

function buildSaveReadback(input){
  return Object.freeze({
    ok: true,
    mode: "night_plan_documentation",
    schemaVersion: STORAGE_SCHEMA_VERSION,
    planId: input.planId,
    revision: input.revision,
    storedImageId: input.imageId,
    storedImageSha256: input.validated.image?.sha256 || null,
    storedImageByteCount: input.validated.image?.bytes.length || 0,
    storedImageMimeType: input.validated.image?.mimeType || null,
    storedImageWidth: input.validated.image?.width || null,
    storedImageHeight: input.validated.image?.height || null,
    finalFormSha256: input.validated.finalFormSha256,
    form: input.validated.form,
    sourceType: input.validated.source.sourceType,
    mappingStatus: input.validated.source.mappingStatus,
    mappingReport: input.validated.source.mappingReport,
    status: input.validated.status,
    learningRecordId: input.learningRecordId,
    learningStatus: "READY",
    learningSource: "HUMAN_CORRECTED_FORM",
    savedAt: input.now,
    savedBy: normalizeSavedBy(input.savedBy),
    operationalAuthority: false,
    operationalStateMutation: false
  });
}

function projectStoredPlan(plan, image, provenance, learning){
  return Object.freeze({
    ok: true,
    mode: "night_plan_documentation",
    schemaVersion: STORAGE_SCHEMA_VERSION,
    planId: plan.plan_id,
    revision: Number(plan.revision),
    form: Object.freeze({
      planDate: plan.plan_date,
      clock: plan.clock,
      signature: plan.signature,
      ds: plan.ds,
      rows: Object.freeze(JSON.parse(plan.rows_json))
    }),
    sourceType: plan.source_type,
    status: plan.status,
    createdAt: plan.created_at,
    savedAt: plan.saved_at,
    savedBy: plan.saved_by,
    storedImageId: image?.image_id || null,
    storedImageSha256: image?.sha256 || null,
    storedImageByteCount: image ? Number(image.byte_count) : 0,
    storedImageMimeType: image?.mime_type || null,
    storedImageWidth: image ? Number(image.width) : null,
    storedImageHeight: image ? Number(image.height) : null,
    finalFormSha256: plan.final_form_sha256,
    provenance: provenance ? {
      sourceType: provenance.source_type,
      ocrEngine: provenance.ocr_engine,
      ocrVersion: provenance.ocr_version,
      sourceImageSha256: provenance.source_image_sha256,
      importedAt: provenance.imported_at,
      humanCorrected: Boolean(provenance.human_corrected),
      mappingStatus: provenance.mapping_status,
      mappingReport: provenance.mapping_report_json ? JSON.parse(provenance.mapping_report_json) : null,
      savedAt: provenance.saved_at,
      savedBy: provenance.saved_by,
      finalFormSha256: provenance.final_form_sha256
    } : null,
    learningRecordId: learning?.learning_record_id || null,
    learningStatus: learning?.learning_status || null,
    learningSource: learning?.learning_source || null,
    operationalAuthority: false,
    operationalStateMutation: false
  });
}

function getIdempotency(db, key){
  return db.prepare("SELECT * FROM night_plan_idempotency WHERE idempotency_key = ?").get(key);
}

function replayIdempotency(row, requestSha256){
  if(row.request_sha256 !== requestSha256){
    throw conflict("idempotency_key_reused", "Idempotency key was already used with a different payload.");
  }
  return Object.freeze({...JSON.parse(row.response_json), idempotentReplay: true});
}

function decodeBase64(value){
  if(typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4){
    throw invalid("invalid_image_base64", "Image bytes must be valid bounded base64.");
  }
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0){
    throw invalid("invalid_image_base64", "Image bytes must be valid base64.");
  }
  const bytes = Buffer.from(value, "base64");
  if(bytes.toString("base64") !== value){
    throw invalid("invalid_image_base64", "Image base64 must use canonical encoding.");
  }
  return bytes;
}

function normalizeOriginalFileName(value){
  const clean = normalizeExactString(value, 255);
  if(!clean || clean === "." || clean === ".." || /[\\/]/.test(clean)){
    throw invalid("invalid_original_file_name", "Original file name must be metadata only, not a path.");
  }
  return clean;
}

function normalizeSavedBy(value){
  const clean = normalizeExactString(value, 320);
  if(!clean) throw new NightPlanStorageError("verified_identity_required", "Verified savedBy identity is required.", 403);
  return clean;
}

function normalizeFormString(value, maximumLength, field){
  if(value == null) return "";
  if(typeof value !== "string" || value.length > maximumLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)){
    throw invalid("invalid_form_value", `${field} is invalid.`);
  }
  return value.trim();
}

function normalizeNullableString(value, maximumLength, field){
  if(value == null || value === "") return null;
  const clean = normalizeExactString(value, maximumLength);
  if(!clean) throw invalid("invalid_metadata_value", `${field} is invalid.`);
  return clean;
}

function normalizeExactString(value, maximumLength){
  if(typeof value !== "string" || value.length === 0 || value.length > maximumLength) return null;
  if(value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function requireUuid(value, code){
  const clean = normalizeExactString(value, 36);
  if(!clean || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)){
    throw invalid(code, "Identifier must be an opaque UUIDv4.");
  }
  return clean;
}

function toIsoTimestamp(value){
  const date = value instanceof Date ? value : new Date(value);
  if(Number.isNaN(date.getTime())) throw invalid("invalid_timestamp", "Timestamp must be valid ISO-8601.");
  return date.toISOString();
}

function canonicalJson(value){
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if(value && typeof value === "object"){
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes){
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function rejectUnexpectedFields(value, allowed, code){
  const allowlist = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowlist.has(key));
  if(unexpected) throw invalid(code, `Unexpected field: ${unexpected}.`, {field: unexpected});
}

function requirePlainObject(value, code){
  if(!value || typeof value !== "object" || Array.isArray(value)){
    throw invalid(code, "Expected a plain object.");
  }
}

function isInside(candidate, directory){
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function injectFailure(options, point){
  if(options.failAt === point){
    throw new NightPlanStorageError("injected_storage_failure", `Injected failure at ${point}.`, 500);
  }
}

function removeFileQuietly(filePath){
  if(!filePath) return;
  try{ fs.unlinkSync(filePath); }catch(error){ if(error?.code !== "ENOENT") throw error; }
}

function fsyncPath(targetPath){
  const descriptor = fs.openSync(targetPath, "r");
  try{
    fs.fsyncSync(descriptor);
  }finally{
    fs.closeSync(descriptor);
  }
}

function rollbackQuietly(db){
  try{ db.exec("ROLLBACK;"); }catch(_error){}
}

function invalid(code, message, details = {}){
  return new NightPlanStorageError(code, message, 400, details);
}

function conflict(code, message, details = {}){
  return new NightPlanStorageError(code, message, 409, details);
}

module.exports = {
  ALLOWED_MIME_TYPES,
  LEARNING_SCHEMA_VERSION,
  MAX_IMAGE_BYTES,
  NightPlanStorageError,
  PLAN_SCHEMA_VERSION,
  ROW_COUNT,
  STORAGE_SCHEMA_VERSION,
  canonicalJson,
  cleanupNightPlanImageOrphans,
  detectImage,
  ensureNightPlanSchema,
  getNightPlan,
  getNightPlanImage,
  listNightPlans,
  preparePrivateStorage,
  saveNightPlan,
  sha256,
  validateNightPlanSavePayload
};
