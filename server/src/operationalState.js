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
