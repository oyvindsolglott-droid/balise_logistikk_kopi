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
const ROW_FIELDS = Object.freeze([
  "fromTrain",
  "toTrain",
  "vehicleId",
  "toTrack",
  "wcWater",
  "notes"
]);

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
        source_image_sha256, imported_at, human_corrected, saved_at, saved_by,
        final_form_sha256, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      revision,
      validated.source.sourceType,
      validated.source.ocrEngine,
      validated.source.ocrVersion,
      validated.image?.sha256 || null,
      validated.source.importedAt,
      validated.source.humanCorrected ? 1 : 0,
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
        schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      revision = ?, plan_date = ?, signature = ?, ds = ?, rows_json = ?,
      source_type = ?, status = ?, created_at = ?, saved_at = ?, saved_by = ?,
      schema_version = ?, image_id = ?, final_form_sha256 = ?, operational_authority = 0
    WHERE plan_id = ?
  `).run(...args);
  if(Number(updated.changes) > 0) return;
  db.prepare(`
    INSERT INTO night_plans (
      revision, plan_date, signature, ds, rows_json, source_type, status,
      created_at, saved_at, saved_by, schema_version, image_id,
      final_form_sha256, plan_id, operational_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
    SELECT plan_id AS planId, revision, plan_date AS planDate, signature, ds,
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
  rejectUnexpectedFields(value, ["planDate", "signature", "ds", "rows"], "unexpected_form_field");
  const planDate = normalizeExactString(value.planDate, 10);
  if(!planDate || !/^\d{4}-\d{2}-\d{2}$/.test(planDate) || Number.isNaN(Date.parse(`${planDate}T00:00:00Z`))){
    throw invalid("invalid_plan_date", "planDate must be a valid ISO date.");
  }
  const signature = normalizeFormString(value.signature, 120, "signature");
  if(!signature) throw invalid("signature_required", "signature is required.");
  const ds = normalizeFormString(value.ds, 120, "ds");
  if(!Array.isArray(value.rows) || value.rows.length !== ROW_COUNT){
    throw invalid("invalid_row_count", `Exactly ${ROW_COUNT} plan rows are required.`);
  }
  const rows = value.rows.map((row, index) => validateRow(row, index));
  return Object.freeze({planDate, signature, ds, rows: Object.freeze(rows)});
}

function validateRow(value, index){
  requirePlainObject(value, "invalid_plan_row");
  rejectUnexpectedFields(value, ROW_FIELDS, "unexpected_row_field");
  const normalized = {};
  for(const field of ROW_FIELDS){
    const maximum = field === "notes" ? 500 : 120;
    normalized[field] = normalizeFormString(value[field], maximum, `rows[${index}].${field}`);
  }
  return Object.freeze(normalized);
}

function validateSource(value){
  requirePlainObject(value, "invalid_source");
  rejectUnexpectedFields(value, [
    "sourceType", "ocrEngine", "ocrVersion", "importedAt", "humanCorrected"
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
  return Object.freeze({sourceType, ocrEngine, ocrVersion, importedAt, humanCorrected});
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
