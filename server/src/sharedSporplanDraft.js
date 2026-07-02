"use strict";

const DEFAULT_DRAFT_ID = "default";
const MODE = "shared_sporplan_draft";

const AUTHORITY_FIELD_KEYS = new Set([
  "mode",
  "revision",
  "updatedat",
  "serverstateauthority",
  "operationalauthority",
  "writesrepresentoperationalauthority"
]);

const HIGH_RISK_FIELD_KEYS = new Set([
  "utfort",
  "utfoert",
  "annullert",
  "planskifterows",
  "sdemooveactions",
  "sdemoveactions",
  "sdemovelearninglog",
  "sdemanualmoveoverrides",
  "sdenightplacementmanualoverrides",
  "drops",
  "dropsorder",
  "dropsorders",
  "verksted",
  "workshop",
  "actions",
  "actionlog",
  "events",
  "score",
  "sdescore",
  "recommendationscore",
  "sortering",
  "sorting",
  "txpoperationalblock",
  "txpoperationalblocks",
  "operationalstate",
  "operationalauthority",
  "switchingorder",
  "skifteordre"
]);

function ensureSharedSporplanDraftSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_sporplan_draft (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      audit_json TEXT
    );
  `);
}

function getSharedSporplanDraft(db){
  ensureSharedSporplanDraftSchema(db);

  const row = db.prepare(`
    SELECT revision, updated_at AS updatedAt, draft_json AS draftJson, audit_json AS auditJson
    FROM shared_sporplan_draft
    WHERE id = ?
  `).get(DEFAULT_DRAFT_ID);

  if(!row){
    return buildReadback({
      revision: 0,
      updatedAt: null,
      draft: defaultDraft(),
      audit: defaultAudit()
    });
  }

  const draft = normalizeStoredDraft(safeParseJson(row.draftJson, defaultDraft()));
  const audit = normalizeStoredAudit(safeParseJson(row.auditJson, defaultAudit()));

  return buildReadback({
    revision: Number(row.revision) || 0,
    updatedAt: row.updatedAt || null,
    draft,
    audit
  });
}

function saveSharedSporplanDraft(db, payload, now = new Date()){
  const validation = validateSharedSporplanDraftPayload(payload);
  if(!validation.ok){
    return validation;
  }

  ensureSharedSporplanDraftSchema(db);
  const updatedAt = toIsoTimestamp(now);

  db.exec("BEGIN IMMEDIATE TRANSACTION;");

  try{
    const row = db.prepare(`
      SELECT revision
      FROM shared_sporplan_draft
      WHERE id = ?
    `).get(DEFAULT_DRAFT_ID);

    const currentRevision = row ? Number(row.revision) || 0 : 0;
    if(currentRevision !== validation.value.expectedRevision){
      db.exec("ROLLBACK;");
      return {
        ok: false,
        status: 409,
        code: "revision_conflict",
        message: "Shared sporplan draft revision conflict.",
        expectedRevision: validation.value.expectedRevision,
        currentRevision
      };
    }

    const revision = currentRevision + 1;
    const audit = buildStoredAudit(validation.value.audit, {
      expectedRevision: validation.value.expectedRevision,
      previousServerRevision: currentRevision,
      newServerRevision: revision,
      serverReceivedAt: updatedAt,
      serverUpdatedAt: updatedAt
    });

    if(row){
      db.prepare(`
        UPDATE shared_sporplan_draft
        SET revision = ?, updated_at = ?, draft_json = ?, audit_json = ?
        WHERE id = ?
      `).run(
        revision,
        updatedAt,
        JSON.stringify(validation.value.draft),
        JSON.stringify(audit),
        DEFAULT_DRAFT_ID
      );
    }else{
      db.prepare(`
        INSERT INTO shared_sporplan_draft (id, revision, updated_at, draft_json, audit_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        DEFAULT_DRAFT_ID,
        revision,
        updatedAt,
        JSON.stringify(validation.value.draft),
        JSON.stringify(audit)
      );
    }

    db.exec("COMMIT;");

    return {
      ok: true,
      previousRevision: currentRevision,
      readback: buildReadback({
        revision,
        updatedAt,
        draft: validation.value.draft,
        audit
      })
    };
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }
}

function validateSharedSporplanDraftPayload(payload){
  if(!isPlainObject(payload)){
    return validationError("invalid_payload", "Payload must be an object.");
  }

  const blocked = findBlockedField(payload);
  if(blocked){
    return validationError(blocked.code, blocked.message, blocked.field);
  }

  const allowedTopLevel = new Set(["expectedRevision", "draft", "audit"]);
  const unexpectedTopLevel = Object.keys(payload).find(key => !allowedTopLevel.has(key));
  if(unexpectedTopLevel){
    return validationError("unexpected_field", `Unexpected field: ${unexpectedTopLevel}.`, unexpectedTopLevel);
  }

  if(!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0){
    return validationError("expected_revision_required", "expectedRevision must be an integer >= 0.");
  }

  if(!isPlainObject(payload.draft)){
    return validationError("invalid_draft", "draft must be an object.");
  }

  const allowedDraftFields = new Set(["grunnoppstilling", "grunnoppstillingRep"]);
  const unexpectedDraftField = Object.keys(payload.draft).find(key => !allowedDraftFields.has(key));
  if(unexpectedDraftField){
    return validationError("unexpected_draft_field", `Unexpected draft field: ${unexpectedDraftField}.`, unexpectedDraftField);
  }

  const grunnoppstilling = validateStringMap(payload.draft.grunnoppstilling, "draft.grunnoppstilling");
  if(!grunnoppstilling.ok) return grunnoppstilling;

  const grunnoppstillingRep = validateStringMap(payload.draft.grunnoppstillingRep, "draft.grunnoppstillingRep");
  if(!grunnoppstillingRep.ok) return grunnoppstillingRep;

  if(isEmptyDraft(grunnoppstilling.value, grunnoppstillingRep.value)){
    return validationError("empty_shared_draft", "Shared sporplan draft cannot be empty.");
  }

  if(!isPlainObject(payload.audit)){
    return validationError("invalid_audit", "audit must be an object.");
  }

  const allowedAuditFields = new Set(["actor", "device", "clientContext"]);
  const unexpectedAuditField = Object.keys(payload.audit).find(key => !allowedAuditFields.has(key));
  if(unexpectedAuditField){
    return validationError("unexpected_audit_field", `Unexpected audit field: ${unexpectedAuditField}.`, unexpectedAuditField);
  }

  const actor = validateNullableString(payload.audit.actor, "audit.actor", 128);
  if(!actor.ok) return actor;

  const device = validateNullableString(payload.audit.device, "audit.device", 128);
  if(!device.ok) return device;

  const clientContext = payload.audit.clientContext === undefined ? {} : payload.audit.clientContext;
  if(!isPlainObject(clientContext)){
    return validationError("invalid_client_context", "audit.clientContext must be an object when set.");
  }

  const contextJson = JSON.stringify(clientContext);
  if(contextJson.length > 5000){
    return validationError("client_context_too_large", "audit.clientContext is too large.");
  }

  return {
    ok: true,
    value: {
      expectedRevision: payload.expectedRevision,
      draft: {
        grunnoppstilling: grunnoppstilling.value,
        grunnoppstillingRep: grunnoppstillingRep.value
      },
      audit: {
        updatedByActor: actor.value,
        updatedByDevice: device.value,
        clientContext: deepClone(clientContext)
      }
    }
  };
}

function isEmptyDraft(grunnoppstilling, grunnoppstillingRep){
  return !hasStringMapContent(grunnoppstilling) && !hasStringMapContent(grunnoppstillingRep);
}

function hasStringMapContent(value){
  if(!isPlainObject(value)) return false;
  return Object.values(value).some(item => String(item || "").trim());
}

function buildStoredAudit(audit, metadata){
  return {
    mode: MODE,
    authority: "draft_readback_only",
    operationalAuthority: false,
    serverStateAuthority: false,
    writesRepresentOperationalAuthority: false,
    expectedRevision: metadata.expectedRevision,
    previousServerRevision: metadata.previousServerRevision,
    newServerRevision: metadata.newServerRevision,
    serverReceivedAt: metadata.serverReceivedAt,
    serverUpdatedAt: metadata.serverUpdatedAt,
    actor: audit.updatedByActor,
    device: audit.updatedByDevice,
    updatedByActor: audit.updatedByActor,
    updatedByDevice: audit.updatedByDevice,
    clientContext: audit.clientContext
  };
}

function validateStringMap(value, path){
  if(!isPlainObject(value)){
    return validationError("invalid_draft_map", `${path} must be an object.`, path);
  }

  const normalized = {};
  for(const [key, rawValue] of Object.entries(value)){
    const keyResult = validateNonEmptyString(key, `${path} key`, 64);
    if(!keyResult.ok) return keyResult;

    const valueResult = validateNullableString(rawValue, `${path}.${key}`, 200);
    if(!valueResult.ok) return valueResult;

    normalized[key] = valueResult.value || "";
  }

  return {
    ok: true,
    value: normalized
  };
}

function validateNonEmptyString(value, path, maxLength){
  if(typeof value !== "string" || !value.trim()){
    return validationError("invalid_string", `${path} must be a non-empty string.`, path);
  }

  if(value.length > maxLength){
    return validationError("string_too_long", `${path} is too long.`, path);
  }

  return {
    ok: true,
    value
  };
}

function validateNullableString(value, path, maxLength){
  if(value === undefined || value === null){
    return {
      ok: true,
      value: null
    };
  }

  if(typeof value !== "string"){
    return validationError("invalid_string", `${path} must be a string or null.`, path);
  }

  if(value.length > maxLength){
    return validationError("string_too_long", `${path} is too long.`, path);
  }

  return {
    ok: true,
    value
  };
}

function findBlockedField(value, path = ""){
  if(!value || typeof value !== "object") return null;

  if(Array.isArray(value)){
    for(let i = 0; i < value.length; i += 1){
      const nested = findBlockedField(value[i], `${path}[${i}]`);
      if(nested) return nested;
    }
    return null;
  }

  for(const [key, nestedValue] of Object.entries(value)){
    const normalizedKey = normalizeFieldKey(key);
    const fieldPath = path ? `${path}.${key}` : key;

    if(AUTHORITY_FIELD_KEYS.has(normalizedKey)){
      return {
        code: "authority_field_not_allowed",
        message: `Authority field is not allowed: ${fieldPath}.`,
        field: fieldPath
      };
    }

    if(HIGH_RISK_FIELD_KEYS.has(normalizedKey)){
      return {
        code: "high_risk_field_not_allowed",
        message: `High-risk field is not allowed: ${fieldPath}.`,
        field: fieldPath
      };
    }

    const nested = findBlockedField(nestedValue, fieldPath);
    if(nested) return nested;
  }

  return null;
}

function normalizeFieldKey(value){
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o")
    .replace(/Ø/g, "O")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "AE")
    .replace(/å/g, "a")
    .replace(/Å/g, "A")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function buildReadback({ revision, updatedAt, draft, audit }){
  return {
    mode: MODE,
    serverStateAuthority: false,
    operationalAuthority: false,
    writesRepresentOperationalAuthority: false,
    revision,
    updatedAt,
    draft: normalizeStoredDraft(draft),
    audit: normalizeStoredAudit(audit)
  };
}

function defaultDraft(){
  return {
    grunnoppstilling: {},
    grunnoppstillingRep: {}
  };
}

function defaultAudit(){
  return {
    updatedByActor: null,
    updatedByDevice: null,
    clientContext: {}
  };
}

function normalizeStoredDraft(value){
  if(!isPlainObject(value)){
    return defaultDraft();
  }

  return {
    grunnoppstilling: isPlainObject(value.grunnoppstilling) ? deepClone(value.grunnoppstilling) : {},
    grunnoppstillingRep: isPlainObject(value.grunnoppstillingRep) ? deepClone(value.grunnoppstillingRep) : {}
  };
}

function normalizeStoredAudit(value){
  if(!isPlainObject(value)){
    return defaultAudit();
  }

  const normalized = {
    updatedByActor: typeof value.updatedByActor === "string" ? value.updatedByActor : null,
    updatedByDevice: typeof value.updatedByDevice === "string" ? value.updatedByDevice : null,
    clientContext: isPlainObject(value.clientContext) ? deepClone(value.clientContext) : {}
  };

  if(value.mode === MODE) normalized.mode = MODE;
  if(value.authority === "draft_readback_only") normalized.authority = "draft_readback_only";
  if(value.operationalAuthority === false) normalized.operationalAuthority = false;
  if(value.serverStateAuthority === false) normalized.serverStateAuthority = false;
  if(value.writesRepresentOperationalAuthority === false) normalized.writesRepresentOperationalAuthority = false;
  if(Number.isInteger(value.expectedRevision) && value.expectedRevision >= 0) normalized.expectedRevision = value.expectedRevision;
  if(Number.isInteger(value.previousServerRevision) && value.previousServerRevision >= 0) normalized.previousServerRevision = value.previousServerRevision;
  if(Number.isInteger(value.newServerRevision) && value.newServerRevision >= 1) normalized.newServerRevision = value.newServerRevision;
  if(typeof value.serverReceivedAt === "string") normalized.serverReceivedAt = value.serverReceivedAt;
  if(typeof value.serverUpdatedAt === "string") normalized.serverUpdatedAt = value.serverUpdatedAt;
  if(typeof value.actor === "string") normalized.actor = value.actor;
  if(typeof value.device === "string") normalized.device = value.device;

  return normalized;
}

function validationError(code, message, field){
  return {
    ok: false,
    status: 400,
    code,
    message,
    field
  };
}

function isPlainObject(value){
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value){
  return JSON.parse(JSON.stringify(value));
}

function safeParseJson(value, fallback){
  try{
    return JSON.parse(value);
  }catch(_error){
    return fallback;
  }
}

function toIsoTimestamp(value){
  if(value instanceof Date){
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function rollbackQuietly(db){
  try{
    db.exec("ROLLBACK;");
  }catch(_error){
    // Ignore rollback failures caused by already-closed transactions.
  }
}

module.exports = {
  ensureSharedSporplanDraftSchema,
  getSharedSporplanDraft,
  saveSharedSporplanDraft,
  validateSharedSporplanDraftPayload
};
