"use strict";

const { insertEvent, findEventByPayloadActionId, getEventsSinceRevision } = require("./events");
const { getMainState } = require("./state");
const {
  PRODUCTION_PORT,
  isProductionDatabasePath,
  isTmpDatabasePath
} = require("./serverNoteGuards");

const OPERATIONAL_STATE_EVENT_TYPE = "operational_state.snapshot.test";
const MAX_SCOPE_ITEMS = 40;
const MAX_STRING_LENGTH = 500;
const RECENT_SNAPSHOT_LIMIT = 20;
const MANUAL_ASSESSMENTS_NOTES_SCOPE = "manual-assessments-notes";
const SHARED_WORKSPACE_AUDIT_LOG_SCOPE = "shared-workspace-audit-log";
const MANUAL_ASSESSMENTS_SCHEMA_VERSION = 1;
const MANUAL_ASSESSMENTS_SCOPE_VERSION = 1;
const MANUAL_ASSESSMENTS_SOURCE_MODULE = "shared-workspace-manual-note";
const MANUAL_ASSESSMENTS_WRITE_INTENT = "test_manual_assessment_note";
const MANUAL_ASSESSMENTS_IDEMPOTENCY_PREFIX = "manual-assessments-notes-test-";
const MANUAL_ASSESSMENTS_ALLOWED_CATEGORIES = new Set([
  "observation",
  "question",
  "risk",
  "followup",
  "coordination",
  "data_quality",
]);
const MANUAL_ASSESSMENTS_ALLOWED_STATUSES = new Set([
  "observation",
  "question",
  "risk_note",
  "manual_followup",
]);
const MANUAL_ASSESSMENTS_ALLOWED_RELATED_SCOPES = new Set([
  "sporplan-readback",
  "input-sporplan-draft",
  "txp-infrastructure-status",
  "sde-night-placement-manual-overrides",
  "sde-shift-movement-assessments",
  "sde-vaktplan-coverage",
  "drops-material-control",
  "workshop-material-status",
  MANUAL_ASSESSMENTS_NOTES_SCOPE,
  SHARED_WORKSPACE_AUDIT_LOG_SCOPE,
]);
const MANUAL_ASSESSMENTS_TOP_LEVEL_KEYS = new Set([
  "scope",
  "stateScope",
  "schemaVersion",
  "scopeVersion",
  "sourceModule",
  "writeIntent",
  "readbackOnly",
  "serviceDate",
  "idempotencyKey",
  "expectedRevision",
  "expectedServerRevision",
  "actor",
  "device",
  "clientContext",
  "payload",
  "clientRevision",
  "createdAt",
]);
const MANUAL_ASSESSMENTS_PAYLOAD_KEYS = new Set([
  "category",
  "assessmentStatus",
  "relatedScope",
  "validForServiceDate",
  "text",
  "relatedVehicle",
  "relatedSlot",
  "relatedTrain",
]);
const MANUAL_ASSESSMENTS_FORBIDDEN_TERMS = [
  "skifteordre",
  "ordre",
  "utf\u00f8r",
  "utfoer",
  "utf\u00f8rt",
  "utfoert",
  "annullert",
  "txp block",
  "txp operational block",
  "operational block",
  "drops dispatch",
  "dispatch",
  "verksted binding",
  "verksted frigj\u00f8ring",
  "verksted frigjoering",
  "binding",
  "frigitt",
  "frigj\u00f8r",
  "frigjoer",
  "tursatt",
  "operativ beslutning",
  "sde-motor-source",
  "sde motor source",
  "operational authority",
];
const MANUAL_ASSESSMENTS_FORBIDDEN_PAYLOAD_KEYS = new Set([
  "drag",
  "dragmetadata",
  "dragstate",
  "selectedslot",
  "selected",
  "hover",
  "hoverstate",
  "focus",
  "focusstate",
  "modal",
  "modalstate",
  "scroll",
  "scrollstate",
  "filter",
  "filterstate",
  "sort",
  "sortstate",
  "score",
  "diagnose",
  "diagnostic",
  "rawdiagnose",
  "rawdiagnostic",
  "transient",
  "transientstate",
  "uistate",
]);

function isFlagEnabled(env, name) {
  return env[name] === "1";
}

function getOperationalStateStatus({ env = process.env, port, databasePath }) {
  const numericPort = Number(port);
  const operationalStateWritesEnabled = isFlagEnabled(env, "SDE_ENABLE_OPERATIONAL_STATE_WRITES");
  const operationalStateProductionWritesEnabled = isFlagEnabled(
    env,
    "SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES"
  );
  const productionTarget =
    numericPort === PRODUCTION_PORT || isProductionDatabasePath(databasePath);

  return {
    operationalStateWritesEnabled,
    operationalStateProductionWritesEnabled,
    productionTarget,
    writesAllowed:
      operationalStateWritesEnabled &&
      (!productionTarget || operationalStateProductionWritesEnabled),
    operationalWritesAllowed: false,
    serverStateAuthority: false,
    operationalAuthority: false,
    contract:
      "Operational-state readback is test-only state synchronization, not a switching order, not SDE motor source, and not operational authority."
  };
}

function getOperationalStateEnvironmentGuardFailure({ env = process.env, port, databasePath }) {
  const operationalStateWritesEnabled = isFlagEnabled(env, "SDE_ENABLE_OPERATIONAL_STATE_WRITES");
  const operationalStateProductionWritesEnabled = isFlagEnabled(
    env,
    "SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES"
  );
  const numericPort = Number(port);

  if (!operationalStateWritesEnabled) {
    return null;
  }

  if (operationalStateProductionWritesEnabled) {
    if (numericPort !== PRODUCTION_PORT) {
      return {
        status: 403,
        code: "operational_state_production_flag_requires_production_port",
        message:
          "SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1 is only valid on production port 8787."
      };
    }

    if (!isProductionDatabasePath(databasePath)) {
      return {
        status: 403,
        code: "operational_state_production_flag_requires_production_database",
        message:
          "SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1 requires the production database path."
      };
    }

    return null;
  }

  if (numericPort === PRODUCTION_PORT) {
    return {
      status: 403,
      code: "operational_state_production_writes_disabled",
      message:
        "Operational-state snapshot writes on production port 8787 require SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES=1."
    };
  }

  if (!env.SDE_SERVER_DB_PATH) {
    return {
      status: 403,
      code: "operational_state_db_path_required",
      message:
        "Test-only operational-state snapshot writes require SDE_SERVER_DB_PATH to point at a temporary database."
    };
  }

  if (isProductionDatabasePath(databasePath)) {
    return {
      status: 403,
      code: "operational_state_production_database_blocked",
      message:
        "Test-only operational-state snapshot writes cannot use the production database."
    };
  }

  if (!isTmpDatabasePath(databasePath)) {
    return {
      status: 403,
      code: "operational_state_tmp_database_required",
      message:
        "Test-only operational-state snapshot writes require a database under /tmp."
    };
  }

  return null;
}

function getOperationalStateRequestGuardFailure({ env = process.env, port, databasePath }) {
  if (!isFlagEnabled(env, "SDE_ENABLE_OPERATIONAL_STATE_WRITES")) {
    return {
      status: 403,
      code: "operational_state_writes_disabled",
      message:
        "Operational-state snapshot writes are disabled unless SDE_ENABLE_OPERATIONAL_STATE_WRITES=1 is set."
    };
  }

  return getOperationalStateEnvironmentGuardFailure({ env, port, databasePath });
}

function buildOperationalStateReadback(db, status) {
  const state = getMainState(db);
  const operationalStateReadback = state?.state?.operationalStateReadback || null;

  return {
    ok: true,
    mode: "operational_state_readback",
    readOnly: true,
    writesAllowed: Boolean(status.writesAllowed),
    operationalWritesAllowed: false,
    serverStateAuthority: false,
    operationalAuthority: false,
    revision: state?.revision ?? null,
    updatedAt: state?.updatedAt ?? null,
    contract: status.contract,
    state: {
      operationalStateReadback
    }
  };
}

function buildOperationalStateEvents(db, status, sinceRevision = 0) {
  const events = getEventsSinceRevision(db, sinceRevision)
    .filter((event) => event.type === OPERATIONAL_STATE_EVENT_TYPE)
    .map(formatOperationalStateEvent);

  return {
    ok: true,
    mode: "operational_state_events",
    readOnly: true,
    writesAllowed: Boolean(status.writesAllowed),
    operationalWritesAllowed: false,
    serverStateAuthority: false,
    operationalAuthority: false,
    contract: status.contract,
    events
  };
}

function validateOperationalStateSnapshotPayload(payload) {
  if (!isPlainObject(payload)) {
    return validationError("invalid_payload", "Payload must be a JSON object.");
  }

  const requestedScopes = getRequestedOperationalStateScopes(payload);
  if (requestedScopes.includes(SHARED_WORKSPACE_AUDIT_LOG_SCOPE)) {
    return validationError(
      "audit_log_client_write_forbidden",
      "shared-workspace-audit-log is server-generated and cannot be client-written."
    );
  }

  if (isManualAssessmentsNotesCandidate(payload, requestedScopes)) {
    return validateManualAssessmentsNotesSnapshotPayload(payload, requestedScopes);
  }

  const serviceDate = readRequiredString(payload, "serviceDate");
  if (serviceDate.error) return serviceDate.error;

  const idempotencyKey = readRequiredString(payload, "idempotencyKey");
  if (idempotencyKey.error) return idempotencyKey.error;

  if (!isPlainObject(payload.actor)) {
    return validationError("invalid_actor", "actor must be an object.");
  }

  const actorId = readRequiredString(payload.actor, "id");
  if (actorId.error) return actorId.error;

  const actorRole = readRequiredString(payload.actor, "role");
  if (actorRole.error) return actorRole.error;

  if (!isPlainObject(payload.device)) {
    return validationError("invalid_device", "device must be an object.");
  }

  const deviceId = readRequiredString(payload.device, "id");
  if (deviceId.error) return deviceId.error;

  if (!Array.isArray(payload.stateScope) || payload.stateScope.length === 0) {
    return validationError(
      "invalid_state_scope",
      "stateScope must be a non-empty array of strings."
    );
  }

  if (payload.stateScope.length > MAX_SCOPE_ITEMS) {
    return validationError(
      "invalid_state_scope",
      `stateScope cannot contain more than ${MAX_SCOPE_ITEMS} entries.`
    );
  }

  const stateScope = [];
  for (const item of payload.stateScope) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return validationError(
        "invalid_state_scope",
        "stateScope must contain only non-empty strings."
      );
    }
    stateScope.push(item.trim());
  }

  if (!isPlainObject(payload.stateSnapshot)) {
    return validationError("invalid_state_snapshot", "stateSnapshot must be an object.");
  }

  const expectedRevisionResult = readOptionalRevision(payload.expectedServerRevision);
  if (expectedRevisionResult.error) return expectedRevisionResult.error;

  const normalized = {
    serviceDate: serviceDate.value,
    idempotencyKey: idempotencyKey.value,
    actor: {
      id: actorId.value,
      role: actorRole.value
    },
    device: {
      id: deviceId.value
    },
    stateScope,
    stateSnapshot: payload.stateSnapshot,
    expectedServerRevision: expectedRevisionResult.value,
    clientRevision:
      typeof payload.clientRevision === "string" && payload.clientRevision.trim()
        ? payload.clientRevision.trim()
        : null,
    clientContext: isPlainObject(payload.clientContext) ? payload.clientContext : null,
    createdAt:
      typeof payload.createdAt === "string" && payload.createdAt.trim()
        ? payload.createdAt.trim()
        : null
  };

  if (typeof payload.actor.displayName === "string" && payload.actor.displayName.trim()) {
    normalized.actor.displayName = payload.actor.displayName.trim();
  }

  if (typeof payload.device.label === "string" && payload.device.label.trim()) {
    normalized.device.label = payload.device.label.trim();
  }

  return {
    ok: true,
    value: normalized
  };
}

function getRequestedOperationalStateScopes(payload) {
  const scopes = [];

  if (typeof payload.scope === "string" && payload.scope.trim()) {
    scopes.push(payload.scope.trim());
  }

  if (Array.isArray(payload.stateScope)) {
    for (const item of payload.stateScope) {
      if (typeof item === "string" && item.trim()) {
        scopes.push(item.trim());
      }
    }
  }

  return [...new Set(scopes)];
}

function isManualAssessmentsNotesCandidate(payload, requestedScopes) {
  return (
    requestedScopes.includes(MANUAL_ASSESSMENTS_NOTES_SCOPE) ||
    payload.sourceModule === MANUAL_ASSESSMENTS_SOURCE_MODULE ||
    payload.writeIntent === MANUAL_ASSESSMENTS_WRITE_INTENT
  );
}

function validateManualAssessmentsNotesSnapshotPayload(payload, requestedScopes) {
  const scopeResult = validateManualAssessmentsScope(payload, requestedScopes);
  if (scopeResult.error) return scopeResult.error;

  for (const key of Object.keys(payload)) {
    const normalizedKey = normalizeGuardKey(key);
    if (
      !MANUAL_ASSESSMENTS_TOP_LEVEL_KEYS.has(key) ||
      MANUAL_ASSESSMENTS_FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)
    ) {
      return validationError(
        "forbidden_manual_assessment_field",
        `${key} is not allowed for manual-assessments-notes.`
      );
    }
  }

  if (payload.stateSnapshot !== undefined) {
    return validationError(
      "manual_assessments_state_snapshot_forbidden",
      "manual-assessments-notes must use the guarded payload contract, not raw stateSnapshot."
    );
  }

  const schemaVersion = readRequiredExactInteger(
    payload,
    "schemaVersion",
    MANUAL_ASSESSMENTS_SCHEMA_VERSION
  );
  if (schemaVersion.error) return schemaVersion.error;

  const scopeVersion = readRequiredExactInteger(
    payload,
    "scopeVersion",
    MANUAL_ASSESSMENTS_SCOPE_VERSION
  );
  if (scopeVersion.error) return scopeVersion.error;

  if (payload.sourceModule !== MANUAL_ASSESSMENTS_SOURCE_MODULE) {
    return validationError(
      "invalid_sourceModule",
      `sourceModule must be ${MANUAL_ASSESSMENTS_SOURCE_MODULE}.`
    );
  }

  if (payload.writeIntent !== MANUAL_ASSESSMENTS_WRITE_INTENT) {
    return validationError(
      "invalid_writeIntent",
      `writeIntent must be ${MANUAL_ASSESSMENTS_WRITE_INTENT}.`
    );
  }

  if (payload.readbackOnly !== true) {
    return validationError("invalid_readbackOnly", "readbackOnly must be true.");
  }

  const serviceDate = readRequiredString(payload, "serviceDate");
  if (serviceDate.error) return serviceDate.error;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate.value)) {
    return validationError("invalid_serviceDate", "serviceDate must use YYYY-MM-DD.");
  }

  const idempotencyKey = readRequiredString(payload, "idempotencyKey");
  if (idempotencyKey.error) return idempotencyKey.error;
  if (
    !new RegExp(
      `^${escapeRegExp(MANUAL_ASSESSMENTS_IDEMPOTENCY_PREFIX)}[A-Za-z0-9._:-]{8,160}$`
    ).test(idempotencyKey.value)
  ) {
    return validationError(
      "invalid_idempotencyKey",
      `idempotencyKey must start with ${MANUAL_ASSESSMENTS_IDEMPOTENCY_PREFIX}.`
    );
  }

  const expectedRevision = readRequiredRevision(payload.expectedRevision, "expectedRevision");
  if (expectedRevision.error) return expectedRevision.error;

  const expectedServerRevision = readOptionalRevision(payload.expectedServerRevision);
  if (expectedServerRevision.error) return expectedServerRevision.error;
  if (
    expectedServerRevision.value !== null &&
    expectedServerRevision.value !== expectedRevision.value
  ) {
    return validationError(
      "expected_revision_alias_mismatch",
      "expectedRevision and expectedServerRevision must match when both are supplied."
    );
  }

  const actor = validateManualAssessmentsActor(payload.actor);
  if (actor.error) return actor.error;

  const device = validateManualAssessmentsDevice(payload.device);
  if (device.error) return device.error;

  const clientContext = validateManualAssessmentsClientContext(payload.clientContext);
  if (clientContext.error) return clientContext.error;

  const note = validateManualAssessmentsPayload(payload.payload, serviceDate.value);
  if (note.error) return note.error;

  return {
    ok: true,
    value: {
      serviceDate: serviceDate.value,
      idempotencyKey: idempotencyKey.value,
      actor: actor.value,
      device: device.value,
      stateScope: [MANUAL_ASSESSMENTS_NOTES_SCOPE],
      stateSnapshot: {
        manualAssessmentNote: {
          schemaVersion: MANUAL_ASSESSMENTS_SCHEMA_VERSION,
          scopeVersion: MANUAL_ASSESSMENTS_SCOPE_VERSION,
          scope: MANUAL_ASSESSMENTS_NOTES_SCOPE,
          sourceModule: MANUAL_ASSESSMENTS_SOURCE_MODULE,
          writeIntent: MANUAL_ASSESSMENTS_WRITE_INTENT,
          readbackOnly: true,
          clientContext: clientContext.value,
          payload: note.value
        }
      },
      expectedServerRevision: expectedRevision.value,
      clientRevision:
        typeof payload.clientRevision === "string" && payload.clientRevision.trim()
          ? payload.clientRevision.trim()
          : null,
      clientContext: clientContext.value,
      createdAt:
        typeof payload.createdAt === "string" && payload.createdAt.trim()
          ? payload.createdAt.trim()
          : null
    }
  };
}

function validateManualAssessmentsScope(payload, requestedScopes) {
  const explicitScope =
    typeof payload.scope === "string" && payload.scope.trim() ? payload.scope.trim() : null;

  if (explicitScope && explicitScope !== MANUAL_ASSESSMENTS_NOTES_SCOPE) {
    return {
      error: validationError(
        "invalid_manual_assessments_scope",
        "manual-assessments-notes is the only allowed B41 test-write scope."
      )
    };
  }

  if (Array.isArray(payload.stateScope)) {
    if (
      payload.stateScope.length !== 1 ||
      typeof payload.stateScope[0] !== "string" ||
      payload.stateScope[0].trim() !== MANUAL_ASSESSMENTS_NOTES_SCOPE
    ) {
      return {
        error: validationError(
          "invalid_manual_assessments_scope",
          "manual-assessments-notes requires exactly one stateScope item."
        )
      };
    }
  }

  if (!explicitScope && !Array.isArray(payload.stateScope)) {
    return {
      error: validationError(
        "missing_manual_assessments_scope",
        "manual-assessments-notes requires scope or stateScope."
      )
    };
  }

  if (requestedScopes.length !== 1 || requestedScopes[0] !== MANUAL_ASSESSMENTS_NOTES_SCOPE) {
    return {
      error: validationError(
        "invalid_manual_assessments_scope",
        "manual-assessments-notes must be the only requested scope."
      )
    };
  }

  return { value: MANUAL_ASSESSMENTS_NOTES_SCOPE };
}

function validateManualAssessmentsActor(actor) {
  if (!isPlainObject(actor)) {
    return { error: validationError("invalid_actor", "actor must be an object.") };
  }

  const actorId = readRequiredString(actor, "id");
  if (actorId.error) return { error: actorId.error };

  const actorRole = readRequiredString(actor, "role");
  if (actorRole.error) return { error: actorRole.error };

  const normalized = {
    id: actorId.value,
    role: actorRole.value
  };

  if (typeof actor.displayName === "string" && actor.displayName.trim()) {
    normalized.displayName = actor.displayName.trim();
  }

  return { value: normalized };
}

function validateManualAssessmentsDevice(device) {
  if (!isPlainObject(device)) {
    return { error: validationError("invalid_device", "device must be an object.") };
  }

  const deviceId = readRequiredString(device, "id");
  if (deviceId.error) return { error: deviceId.error };

  const normalized = {
    id: deviceId.value
  };

  if (typeof device.label === "string" && device.label.trim()) {
    normalized.label = device.label.trim();
  }

  return { value: normalized };
}

function validateManualAssessmentsClientContext(clientContext) {
  if (!isPlainObject(clientContext)) {
    return {
      error: validationError("invalid_clientContext", "clientContext must be an object.")
    };
  }

  const requiredBooleans = {
    readbackOnly: true,
    notOperationalOrder: true,
    notCompletedCancelled: true,
    notSdeMotorSource: true,
    noAutomaticSubmit: true,
    oneManualSubmit: true,
    serverStateAuthority: false,
    operationalAuthority: false
  };

  for (const [key, expected] of Object.entries(requiredBooleans)) {
    if (clientContext[key] !== expected) {
      return {
        error: validationError(
          "invalid_clientContext",
          `clientContext.${key} must be ${expected}.`
        )
      };
    }
  }

  return {
    value: {
      ...clientContext,
      readbackOnly: true,
      notOperationalOrder: true,
      notCompletedCancelled: true,
      notSdeMotorSource: true,
      noAutomaticSubmit: true,
      oneManualSubmit: true,
      serverStateAuthority: false,
      operationalAuthority: false
    }
  };
}

function validateManualAssessmentsPayload(notePayload, serviceDate) {
  if (!isPlainObject(notePayload)) {
    return {
      error: validationError(
        "invalid_manual_assessment_payload",
        "payload must be a manual assessment note object."
      )
    };
  }

  for (const key of Object.keys(notePayload)) {
    const normalizedKey = normalizeGuardKey(key);
    if (
      !MANUAL_ASSESSMENTS_PAYLOAD_KEYS.has(key) ||
      MANUAL_ASSESSMENTS_FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)
    ) {
      return {
        error: validationError(
          "forbidden_manual_assessment_field",
          `payload.${key} is not allowed for manual-assessments-notes.`
        )
      };
    }
  }

  const category = readRequiredString(notePayload, "category");
  if (category.error) return { error: category.error };
  if (!MANUAL_ASSESSMENTS_ALLOWED_CATEGORIES.has(category.value)) {
    return {
      error: validationError(
        "invalid_manual_assessment_category",
        "payload.category is not allowed."
      )
    };
  }

  const assessmentStatus = readRequiredString(notePayload, "assessmentStatus");
  if (assessmentStatus.error) return { error: assessmentStatus.error };
  if (!MANUAL_ASSESSMENTS_ALLOWED_STATUSES.has(assessmentStatus.value)) {
    return {
      error: validationError(
        "invalid_manual_assessment_status",
        "payload.assessmentStatus is not allowed."
      )
    };
  }

  const relatedScope = readRequiredString(notePayload, "relatedScope");
  if (relatedScope.error) return { error: relatedScope.error };
  if (!MANUAL_ASSESSMENTS_ALLOWED_RELATED_SCOPES.has(relatedScope.value)) {
    return {
      error: validationError(
        "invalid_manual_assessment_related_scope",
        "payload.relatedScope is not allowed."
      )
    };
  }

  const validForServiceDate = readRequiredString(notePayload, "validForServiceDate");
  if (validForServiceDate.error) return { error: validForServiceDate.error };
  if (validForServiceDate.value !== serviceDate) {
    return {
      error: validationError(
        "invalid_manual_assessment_service_date",
        "payload.validForServiceDate must match serviceDate."
      )
    };
  }

  const text = readRequiredString(notePayload, "text");
  if (text.error) return { error: text.error };
  if (containsForbiddenManualAssessmentLanguage(text.value)) {
    return {
      error: validationError(
        "forbidden_manual_assessment_language",
        "payload.text contains operational or authority language."
      )
    };
  }

  const normalized = {
    category: category.value,
    assessmentStatus: assessmentStatus.value,
    relatedScope: relatedScope.value,
    validForServiceDate: validForServiceDate.value,
    text: text.value
  };

  for (const key of ["relatedVehicle", "relatedSlot", "relatedTrain"]) {
    const optional = readOptionalShortString(notePayload, key, 80);
    if (optional.error) return { error: optional.error };
    if (optional.value !== null) {
      if (containsForbiddenManualAssessmentLanguage(optional.value)) {
        return {
          error: validationError(
            "forbidden_manual_assessment_language",
            `payload.${key} contains operational or authority language.`
          )
        };
      }
      normalized[key] = optional.value;
    }
  }

  return { value: normalized };
}

function readRequiredExactInteger(object, key, expected) {
  if (object[key] !== expected) {
    return {
      error: validationError(`invalid_${key}`, `${key} must be ${expected}.`)
    };
  }

  return { value: expected };
}

function readRequiredRevision(value, key) {
  if (!Number.isInteger(value) || value < 0) {
    return {
      error: validationError(`invalid_${key}`, `${key} must be a non-negative integer.`)
    };
  }

  return { value };
}

function readOptionalShortString(object, key, maxLength) {
  if (object[key] === undefined || object[key] === null || object[key] === "") {
    return { value: null };
  }

  if (typeof object[key] !== "string") {
    return {
      error: validationError(`invalid_${key}`, `${key} must be a string when supplied.`)
    };
  }

  const value = object[key].trim();
  if (!value) {
    return { value: null };
  }

  if (value.length > maxLength) {
    return {
      error: validationError(`invalid_${key}`, `${key} cannot exceed ${maxLength} chars.`)
    };
  }

  return { value };
}

function containsForbiddenManualAssessmentLanguage(value) {
  const normalized = value.toLowerCase();
  return MANUAL_ASSESSMENTS_FORBIDDEN_TERMS.some((term) => normalized.includes(term));
}

function normalizeGuardKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeOperationalStateSnapshot(db, snapshot) {
  db.exec("BEGIN IMMEDIATE TRANSACTION;");

  try{
  const existingEvent = findEventByPayloadActionId(db, {
    type: OPERATIONAL_STATE_EVENT_TYPE,
    actionId: snapshot.idempotencyKey
  });

  if (existingEvent) {
    const existingRequest = existingEvent.payload?.request || null;
    if (stableStringify(existingRequest) !== stableStringify(snapshot)) {
      db.exec("ROLLBACK;");
      return {
        ok: false,
        status: 409,
        code: "idempotency_key_conflict",
        message: "idempotencyKey has already been used for a different snapshot.",
        event: formatOperationalStateEvent(existingEvent)
      };
    }

    db.exec("ROLLBACK;");
    return {
      ok: true,
      idempotent: true,
      previousRevision: existingEvent.previousRevision,
      resultingRevision: existingEvent.revision,
      event: formatOperationalStateEvent(existingEvent)
    };
  }

  const current = getMainState(db);
  const previousRevision = current.revision;

  if (
    Number.isInteger(snapshot.expectedServerRevision) &&
    snapshot.expectedServerRevision !== previousRevision
  ) {
    db.exec("ROLLBACK;");
    return {
      ok: false,
      status: 409,
      code: "revision_conflict",
      message: "expectedServerRevision does not match current server revision.",
      expectedServerRevision: snapshot.expectedServerRevision,
      currentRevision: previousRevision
    };
  }

  const previousPayload = current.state || {};
  const previousReadback = isPlainObject(previousPayload.operationalStateReadback)
    ? previousPayload.operationalStateReadback
    : {};
  const previousRecent = Array.isArray(previousReadback.recentSnapshots)
    ? previousReadback.recentSnapshots
    : [];
  const nextRevision = previousRevision + 1;
  const serverTimestamp = new Date().toISOString();
  const readbackSnapshot = {
    serviceDate: snapshot.serviceDate,
    idempotencyKey: snapshot.idempotencyKey,
    actor: snapshot.actor,
    device: snapshot.device,
    stateScope: snapshot.stateScope,
    stateSnapshot: snapshot.stateSnapshot,
    clientRevision: snapshot.clientRevision,
    clientContext: snapshot.clientContext,
    createdAt: snapshot.createdAt,
    acceptedAt: serverTimestamp,
    revision: nextRevision
  };
  const nextPayload = {
    ...previousPayload,
    operationalStateReadback: {
      mode: "test_readback_only",
      serverStateAuthority: false,
      operationalAuthority: false,
      notSwitchingOrder: true,
      count: Number(previousReadback.count || 0) + 1,
      lastSnapshot: readbackSnapshot,
      recentSnapshots: [readbackSnapshot, ...previousRecent].slice(0, RECENT_SNAPSHOT_LIMIT)
    }
  };

  const eventPayload = {
    actionId: snapshot.idempotencyKey,
    idempotencyKey: snapshot.idempotencyKey,
    serviceDate: snapshot.serviceDate,
    request: snapshot,
    readbackOnly: true,
    serverStateAuthority: false,
    operationalAuthority: false,
    notSwitchingOrder: true,
    serverTimestamp
  };

  const event = insertEvent(db, {
    type: OPERATIONAL_STATE_EVENT_TYPE,
    previousRevision,
    revision: nextRevision,
    payload: eventPayload,
    createdAt: serverTimestamp
  });

  db.prepare(`
    UPDATE app_state
    SET revision = ?, state_json = ?, updated_at = ?, updated_by = ?
    WHERE id = ?
  `).run(
    nextRevision,
    JSON.stringify(nextPayload),
    serverTimestamp,
    "operational-state-test",
    "main"
  );

  db.exec("COMMIT;");

  return {
    ok: true,
    idempotent: false,
    previousRevision,
    resultingRevision: nextRevision,
    event: formatOperationalStateEvent(event)
  };
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }
}

function formatOperationalStateEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    type: event.type,
    previousRevision: event.previousRevision,
    revision: event.revision,
    createdAt: event.createdAt,
    idempotencyKey: event.payload?.idempotencyKey || event.payload?.actionId || null,
    serviceDate: event.payload?.serviceDate || null,
    readbackOnly: event.payload?.readbackOnly === true,
    serverStateAuthority: false,
    operationalAuthority: false,
    notSwitchingOrder: true
  };
}

function readRequiredString(payload, key) {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      error: validationError(`missing_${key}`, `${key} is required.`)
    };
  }

  if (value.length > MAX_STRING_LENGTH) {
    return {
      error: validationError(`invalid_${key}`, `${key} is too long.`)
    };
  }

  return {
    value: value.trim()
  };
}

function readOptionalRevision(value) {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }

  if (!Number.isInteger(value) || value < 0) {
    return {
      error: validationError(
        "invalid_expected_server_revision",
        "expectedServerRevision must be a non-negative integer when provided."
      )
    };
  }

  return { value };
}

function validationError(code, message) {
  return {
    ok: false,
    status: 400,
    code,
    message
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortJson(value[key]);
        return result;
      }, {});
  }

  return value;
}

function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK;");
  } catch (_error) {
    // Ignore rollback failures after SQLite has already closed the transaction.
  }
}

module.exports = {
  OPERATIONAL_STATE_EVENT_TYPE,
  buildOperationalStateReadback,
  buildOperationalStateEvents,
  getOperationalStateEnvironmentGuardFailure,
  getOperationalStateRequestGuardFailure,
  getOperationalStateStatus,
  validateOperationalStateSnapshotPayload,
  writeOperationalStateSnapshot
};
