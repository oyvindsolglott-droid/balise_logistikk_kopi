const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { getDatabasePath, openDatabase } = require("./db");
const { getEventsSinceRevision, parseSinceRevision, writeSseEvent } = require("./events");
const { prepareRuntimeMigrationMode, runRuntimeMigrationIfEnabled } = require("./runtimeMigrationMode");
const { getSchemaStatus } = require("./schemaStatus");
const { getCurrentRevision, getMainState, writeActionContractTest, writeTestNote } = require("./state");
const { ACTIONS_TABLE_TEST_EVENT_TYPE, writeActionsTableTestAction } = require("./actionsTableTestAction");
const { SERVER_NOTE_ACTION_TYPE, SERVER_NOTE_EVENT_TYPE, writeServerNoteAction } = require("./serverNoteAction");
const {
  getServerNoteEnvironmentGuardFailure,
  getServerNoteGuardFailure,
  getServerNoteStatus
} = require("./serverNoteGuards");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HEARTBEAT_MS = 15000;
const TEST_NOTE_MAX_LENGTH = 500;
const ACTION_CONTRACT_TEST_NOTE_MAX_LENGTH = 500;
const ACTIONS_TABLE_TEST_NOTE_MAX_LENGTH = 500;
const SERVER_NOTE_MAX_LENGTH = 500;
const ACTION_CONTRACT_FIELD_MAX_LENGTH = 200;
const ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH = 4000;
const SERVER_NOTE_CATEGORIES = new Set(["ops", "test", "maintenance"]);
const SERVER_NOTE_SEVERITIES = new Set(["info", "warning"]);
const TEST_WRITES_ENABLED = process.env.SDE_ENABLE_TEST_WRITES === "1";
const ACTION_CONTRACT_TESTS_ENABLED = process.env.SDE_ENABLE_ACTION_CONTRACT_TESTS === "1";
const ACTIONS_TABLE_TESTS_ENABLED = process.env.SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES === "1";
const SERVER_NOTE_ACTIONS_ENABLED = process.env.SDE_ENABLE_SERVER_NOTE_ACTIONS === "1";
const SERVER_NOTE_STATUS = getServerNoteStatus(process.env);
const STARTED_AT = new Date();
const SERVER_MODE = process.env.SDE_SERVER_MODE || "server-groundwork";
const ACTION_CONTRACT_TEST_EVENT_TYPE = "action_contract.test";
const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";

const configuredDatabasePath = getDatabasePath();
let runtimeMigrationMode;
try{
  runtimeMigrationMode = prepareRuntimeMigrationMode({
    port: PORT,
    rawPort: process.env.PORT,
    databasePath: configuredDatabasePath
  });
}catch(error){
  console.error(`schema migration startup blocked: ${error.message}`);
  process.exit(1);
}

if(ACTION_CONTRACT_TESTS_ENABLED){
  const guardFailure = getActionContractTestEnvironmentGuardFailure(configuredDatabasePath);
  if(guardFailure){
    console.error(`action contract test startup blocked: ${guardFailure.message}`);
    process.exit(1);
  }
}

if(ACTIONS_TABLE_TESTS_ENABLED){
  const guardFailure = getActionsTableTestEnvironmentGuardFailure(configuredDatabasePath);
  if(guardFailure){
    console.error(`actions table test startup blocked: ${guardFailure.message}`);
    process.exit(1);
  }
}

if(SERVER_NOTE_ACTIONS_ENABLED){
  const guardFailure = getServerNoteEnvironmentGuardFailure({
    env: process.env,
    port: PORT,
    databasePath: configuredDatabasePath
  });
  if(guardFailure){
    console.error(`server note action startup blocked: ${guardFailure.message}`);
    process.exit(1);
  }
}

const { db, databasePath } = openDatabase();
let runtimeMigrationStatus = runtimeMigrationMode;
try{
  runtimeMigrationStatus = runRuntimeMigrationIfEnabled(db, {
    mode: runtimeMigrationMode,
    databasePath
  });
}catch(error){
  console.error("schema migration failed", error);
  process.exit(1);
}

const app = express();
const sseClients = new Set();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  const revision = getCurrentRevision(db);
  res.json({
    ok: true,
    service: "sde-server",
    time: new Date().toISOString(),
    revision
  });
});

app.get("/api/server/status", (_req, res) => {
  const revision = getCurrentRevision(db);
  const schemaStatus = getSchemaStatus(db, {
    migrationsEnabled: runtimeMigrationStatus.migrationsEnabled
  });
  res.json({
    ok: true,
    service: "sde-server",
    mode: SERVER_MODE,
    port: PORT,
    revision,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
    startedAt: STARTED_AT.toISOString(),
    serverTime: new Date().toISOString(),
    databaseExists: fs.existsSync(databasePath),
    databasePathConfigured: Boolean(process.env.SDE_SERVER_DB_PATH),
    databaseFile: path.basename(databasePath),
    testWritesEnabled: TEST_WRITES_ENABLED,
    actionsTableTestWritesEnabled: ACTIONS_TABLE_TESTS_ENABLED,
    serverNoteActionsEnabled: SERVER_NOTE_STATUS.serverNoteActionsEnabled,
    serverNoteProductionActionsEnabled: SERVER_NOTE_STATUS.serverNoteProductionActionsEnabled,
    ...schemaStatus,
    pwaConnected: false,
    operationalWritesEnabled: false
  });
});

app.get("/api/state", (_req, res) => {
  const state = getMainState(db);
  res.json({
    revision: state.revision,
    updatedAt: state.updatedAt,
    state: state.state
  });
});

app.get("/api/state/revision", (_req, res) => {
  const state = getMainState(db);
  res.json({
    revision: state.revision,
    updatedAt: state.updatedAt
  });
});

app.get("/api/events", (req, res) => {
  const sinceRevision = parseSinceRevision(req.query.sinceRevision);
  const currentRevision = getCurrentRevision(db);
  res.json({
    revision: currentRevision,
    sinceRevision,
    events: getEventsSinceRevision(db, sinceRevision)
  });
});

app.post("/api/actions/test-note", (req, res) => {
  if(!TEST_WRITES_ENABLED){
    return res.status(403).json({
      ok: false,
      error: "test_writes_disabled",
      message: "Test writes are disabled. Set SDE_ENABLE_TEST_WRITES=1 to enable this endpoint."
    });
  }

  const validation = validateTestNotePayload(req.body);
  if(!validation.ok){
    return res.status(400).json({
      ok: false,
      error: "invalid_payload",
      message: validation.message
    });
  }

  const result = writeTestNote(db, validation.value);
  if(!result.ok && result.error === "revision_conflict"){
    return res.status(409).json({
      ok: false,
      error: "revision_conflict",
      expectedRevision: result.expectedRevision,
      currentRevision: result.currentRevision
    });
  }

  const event = {
    revision: result.event.revision,
    type: result.event.type
  };

  broadcastSseEvent("state_changed", {
    revision: result.revision,
    previousRevision: result.previousRevision,
    event
  });

  res.json({
    ok: true,
    action: "test-note",
    previousRevision: result.previousRevision,
    revision: result.revision,
    event
  });
});

app.post("/api/actions/action-contract-test", (req, res) => {
  const guardFailure = getActionContractTestGuardFailure(databasePath);
  if(guardFailure){
    return res.status(403).json({
      ok: false,
      error: guardFailure.error,
      message: guardFailure.message
    });
  }

  const validation = validateActionContractTestPayload(req.body);
  if(!validation.ok){
    return res.status(400).json({
      ok: false,
      error: "invalid_payload",
      message: validation.message
    });
  }

  let result;
  try{
    result = writeActionContractTest(db, validation.value);
  }catch(error){
    console.error("action contract test failed", error);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error."
    });
  }

  if(!result.ok && result.error === "action_id_conflict"){
    return res.status(409).json({
      ok: false,
      error: "action_id_conflict",
      actionId: result.actionId,
      currentRevision: result.currentRevision,
      message: "actionId already exists with a different payload."
    });
  }

  if(!result.ok && result.error === "revision_conflict"){
    return res.status(409).json({
      ok: false,
      error: "revision_conflict",
      expectedRevision: result.expectedRevision,
      currentRevision: result.currentRevision
    });
  }

  const event = formatActionContractTestEvent(result.event);

  if(result.idempotent){
    return res.status(200).json({
      ok: true,
      action: "action-contract-test",
      idempotent: true,
      actionId: result.actionId,
      revision: result.revision,
      currentRevision: result.currentRevision,
      event
    });
  }

  broadcastSseEvent("state_changed", {
    revision: result.revision,
    previousRevision: result.previousRevision,
    event
  });

  return res.status(201).json({
    ok: true,
    action: "action-contract-test",
    idempotent: false,
    actionId: result.actionId,
    previousRevision: result.previousRevision,
    revision: result.revision,
    event
  });
});

app.post("/api/actions/actions-table-test", (req, res) => {
  const guardFailure = getActionsTableTestGuardFailure(databasePath);
  if(guardFailure){
    return res.status(403).json({
      ok: false,
      error: guardFailure.error,
      message: guardFailure.message
    });
  }

  const validation = validateActionsTableTestPayload(req.body);
  if(!validation.ok){
    return res.status(400).json({
      ok: false,
      error: "invalid_payload",
      message: validation.message
    });
  }

  let result;
  try{
    result = writeActionsTableTestAction(db, validation.value);
  }catch(error){
    console.error("actions table test failed", error);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error."
    });
  }

  if(!result.ok && result.error === "actions_schema_not_ready"){
    return res.status(500).json({
      ok: false,
      error: "actions_schema_not_ready",
      problems: result.problems
    });
  }

  if(!result.ok && result.error === "action_id_conflict"){
    return res.status(409).json({
      ok: false,
      error: "action_id_conflict",
      actionId: result.actionId,
      currentRevision: result.currentRevision,
      message: "actionId already exists with a different request."
    });
  }

  if(!result.ok && result.error === "revision_conflict"){
    return res.status(409).json({
      ok: false,
      error: "revision_conflict",
      expectedRevision: result.expectedRevision,
      currentRevision: result.currentRevision
    });
  }

  const event = formatActionsTableTestEvent(result.event);

  if(result.idempotent){
    return res.status(200).json({
      ok: true,
      action: "actions-table-test",
      mode: "replayed",
      idempotent: true,
      actionId: result.actionId,
      payloadHash: result.payloadHash,
      resultingRevision: result.resultingRevision,
      currentRevision: result.currentRevision,
      event
    });
  }

  broadcastSseEvent("state_changed", {
    revision: result.resultingRevision,
    previousRevision: result.previousRevision,
    event
  });

  return res.status(201).json({
    ok: true,
    action: "actions-table-test",
    mode: "created",
    idempotent: false,
    actionId: result.actionId,
    payloadHash: result.payloadHash,
    previousRevision: result.previousRevision,
    resultingRevision: result.resultingRevision,
    event
  });
});

app.post("/api/actions/server-note", (req, res) => {
  const guardFailure = getServerNoteGuardFailure({
    env: process.env,
    port: PORT,
    databasePath
  });
  if(guardFailure){
    return res.status(403).json({
      ok: false,
      error: guardFailure.error,
      message: guardFailure.message
    });
  }

  const validation = validateServerNotePayload(req.body);
  if(!validation.ok){
    return res.status(400).json({
      ok: false,
      error: "invalid_payload",
      message: validation.message
    });
  }

  let result;
  try{
    result = writeServerNoteAction(db, validation.value);
  }catch(error){
    console.error("server note action failed", error);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error."
    });
  }

  if(!result.ok && result.error === "actions_schema_not_ready"){
    return res.status(500).json({
      ok: false,
      error: "actions_schema_not_ready",
      problems: result.problems
    });
  }

  if(!result.ok && result.error === "action_id_conflict"){
    return res.status(409).json({
      ok: false,
      error: "action_id_conflict",
      actionId: result.actionId,
      currentRevision: result.currentRevision,
      message: "actionId already exists with a different request."
    });
  }

  if(!result.ok && result.error === "revision_conflict"){
    return res.status(409).json({
      ok: false,
      error: "revision_conflict",
      expectedRevision: result.expectedRevision,
      currentRevision: result.currentRevision
    });
  }

  const event = formatServerNoteEvent(result.event);

  if(result.idempotent){
    return res.status(200).json({
      ok: true,
      action: "server-note",
      mode: "replayed",
      idempotent: true,
      actionId: result.actionId,
      noteId: result.noteId,
      payloadHash: result.payloadHash,
      resultingRevision: result.resultingRevision,
      currentRevision: result.currentRevision,
      event
    });
  }

  broadcastSseEvent("state_changed", {
    revision: result.resultingRevision,
    previousRevision: result.previousRevision,
    event
  });

  return res.status(201).json({
    ok: true,
    action: "server-note",
    mode: "created",
    idempotent: false,
    actionId: result.actionId,
    noteId: result.noteId,
    payloadHash: result.payloadHash,
    previousRevision: result.previousRevision,
    resultingRevision: result.resultingRevision,
    event
  });
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  sseClients.add(res);

  writeSseEvent(res, "connected", {
    ok: true,
    service: "sde-server",
    time: new Date().toISOString(),
    revision: getCurrentRevision(db)
  });

  const heartbeat = setInterval(() => {
    writeSseEvent(res, "heartbeat", {
      time: new Date().toISOString(),
      revision: getCurrentRevision(db)
    });
  }, HEARTBEAT_MS);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    res.end();
  });
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found"
  });
});

app.listen(PORT, () => {
  const revision = getCurrentRevision(db);
  console.log("server started");
  console.log(`port: ${PORT}`);
  console.log(`database path: ${databasePath}`);
  console.log(`current revision: ${revision}`);
});

function validateTestNotePayload(body){
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return invalidPayload("JSON body must be an object.");
  }

  if(!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1){
    return invalidPayload("expectedRevision must be an integer >= 1.");
  }

  if(typeof body.note !== "string"){
    return invalidPayload("note must be a string.");
  }

  const note = body.note.trim();
  if(!note){
    return invalidPayload("note must not be empty.");
  }

  if(note.length > TEST_NOTE_MAX_LENGTH){
    return invalidPayload(`note must be ${TEST_NOTE_MAX_LENGTH} characters or fewer.`);
  }

  return {
    ok: true,
    value: {
      expectedRevision: body.expectedRevision,
      note
    }
  };
}

function invalidPayload(message){
  return {
    ok: false,
    message
  };
}

function validateActionContractTestPayload(body){
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return invalidPayload("JSON body must be an object.");
  }

  const actionId = normalizeRequiredString(body.actionId, "actionId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actionId.ok) return actionId;

  if(body.actionType !== ACTION_CONTRACT_TEST_EVENT_TYPE){
    return invalidPayload("actionType must be action_contract.test.");
  }

  if(!body.actor || typeof body.actor !== "object" || Array.isArray(body.actor)){
    return invalidPayload("actor must be an object.");
  }

  const actorId = normalizeRequiredString(body.actor.id, "actor.id", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorId.ok) return actorId;

  const actorRole = normalizeRequiredString(body.actor.role, "actor.role", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorRole.ok) return actorRole;

  const deviceId = normalizeRequiredString(body.deviceId, "deviceId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!deviceId.ok) return deviceId;

  if(!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1){
    return invalidPayload("expectedRevision must be an integer >= 1.");
  }

  if(!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)){
    return invalidPayload("payload must be an object.");
  }

  const testNote = normalizeRequiredString(body.payload.testNote, "payload.testNote", ACTION_CONTRACT_TEST_NOTE_MAX_LENGTH);
  if(!testNote.ok) return testNote;

  let clientContext = null;
  if(body.clientContext !== undefined){
    if(!body.clientContext || typeof body.clientContext !== "object" || Array.isArray(body.clientContext)){
      return invalidPayload("clientContext must be an object when provided.");
    }

    if(JSON.stringify(body.clientContext).length > ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH){
      return invalidPayload(`clientContext must be ${ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH} characters or fewer when serialized.`);
    }

    clientContext = body.clientContext;
  }

  return {
    ok: true,
    value: {
      actionId: actionId.value,
      actionType: ACTION_CONTRACT_TEST_EVENT_TYPE,
      actor: {
        id: actorId.value,
        role: actorRole.value
      },
      deviceId: deviceId.value,
      expectedRevision: body.expectedRevision,
      payload: {
        testNote: testNote.value
      },
      clientContext
    }
  };
}

function validateActionsTableTestPayload(body){
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return invalidPayload("JSON body must be an object.");
  }

  const actionId = normalizeRequiredString(body.actionId, "actionId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actionId.ok) return actionId;

  if(body.actionType !== ACTIONS_TABLE_TEST_EVENT_TYPE){
    return invalidPayload("actionType must be actions_table.test.");
  }

  if(!body.actor || typeof body.actor !== "object" || Array.isArray(body.actor)){
    return invalidPayload("actor must be an object.");
  }

  const actorId = normalizeRequiredString(body.actor.id, "actor.id", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorId.ok) return actorId;

  const actorRole = normalizeRequiredString(body.actor.role, "actor.role", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorRole.ok) return actorRole;

  const deviceId = normalizeRequiredString(body.deviceId, "deviceId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!deviceId.ok) return deviceId;

  if(!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1){
    return invalidPayload("expectedRevision must be an integer >= 1.");
  }

  if(!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)){
    return invalidPayload("payload must be an object.");
  }

  const testNote = normalizeRequiredString(body.payload.testNote, "payload.testNote", ACTIONS_TABLE_TEST_NOTE_MAX_LENGTH);
  if(!testNote.ok) return testNote;

  let clientContext = null;
  if(body.clientContext !== undefined){
    if(!body.clientContext || typeof body.clientContext !== "object" || Array.isArray(body.clientContext)){
      return invalidPayload("clientContext must be an object when provided.");
    }

    if(JSON.stringify(body.clientContext).length > ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH){
      return invalidPayload(`clientContext must be ${ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH} characters or fewer when serialized.`);
    }

    clientContext = body.clientContext;
  }

  return {
    ok: true,
    value: {
      actionId: actionId.value,
      actionType: ACTIONS_TABLE_TEST_EVENT_TYPE,
      actor: {
        id: actorId.value,
        role: actorRole.value
      },
      deviceId: deviceId.value,
      expectedRevision: body.expectedRevision,
      payload: {
        testNote: testNote.value
      },
      clientContext
    }
  };
}

function validateServerNotePayload(body){
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return invalidPayload("JSON body must be an object.");
  }

  const actionId = normalizeRequiredString(body.actionId, "actionId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actionId.ok) return actionId;

  if(body.actionType !== SERVER_NOTE_ACTION_TYPE){
    return invalidPayload("actionType must be server_note.create.");
  }

  if(!body.actor || typeof body.actor !== "object" || Array.isArray(body.actor)){
    return invalidPayload("actor must be an object.");
  }

  const actorId = normalizeRequiredString(body.actor.id, "actor.id", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorId.ok) return actorId;

  const actorRole = normalizeRequiredString(body.actor.role, "actor.role", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!actorRole.ok) return actorRole;

  const deviceId = normalizeRequiredString(body.deviceId, "deviceId", ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!deviceId.ok) return deviceId;

  if(!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1){
    return invalidPayload("expectedRevision must be an integer >= 1.");
  }

  if(!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)){
    return invalidPayload("payload must be an object.");
  }

  const note = normalizeRequiredString(body.payload.note, "payload.note", SERVER_NOTE_MAX_LENGTH);
  if(!note.ok) return note;

  const category = normalizeAllowedString(body.payload.category, "payload.category", SERVER_NOTE_CATEGORIES);
  if(!category.ok) return category;

  const severity = normalizeAllowedString(body.payload.severity, "payload.severity", SERVER_NOTE_SEVERITIES);
  if(!severity.ok) return severity;

  let clientContext = null;
  if(body.clientContext !== undefined){
    if(!body.clientContext || typeof body.clientContext !== "object" || Array.isArray(body.clientContext)){
      return invalidPayload("clientContext must be an object when provided.");
    }

    if(JSON.stringify(body.clientContext).length > ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH){
      return invalidPayload(`clientContext must be ${ACTION_CONTRACT_CLIENT_CONTEXT_MAX_LENGTH} characters or fewer when serialized.`);
    }

    clientContext = body.clientContext;
  }

  return {
    ok: true,
    value: {
      actionId: actionId.value,
      actionType: SERVER_NOTE_ACTION_TYPE,
      actor: {
        id: actorId.value,
        role: actorRole.value
      },
      deviceId: deviceId.value,
      expectedRevision: body.expectedRevision,
      payload: {
        note: note.value,
        category: category.value,
        severity: severity.value
      },
      clientContext
    }
  };
}

function normalizeRequiredString(value, fieldName, maxLength){
  if(typeof value !== "string"){
    return invalidPayload(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if(!normalized){
    return invalidPayload(`${fieldName} must not be empty.`);
  }

  if(normalized.length > maxLength){
    return invalidPayload(`${fieldName} must be ${maxLength} characters or fewer.`);
  }

  return {
    ok: true,
    value: normalized
  };
}

function normalizeAllowedString(value, fieldName, allowedValues){
  const normalized = normalizeRequiredString(value, fieldName, ACTION_CONTRACT_FIELD_MAX_LENGTH);
  if(!normalized.ok) return normalized;

  if(!allowedValues.has(normalized.value)){
    return invalidPayload(`${fieldName} must be one of: ${Array.from(allowedValues).join(", ")}.`);
  }

  return normalized;
}

function getActionContractTestGuardFailure(activeDatabasePath){
  if(!ACTION_CONTRACT_TESTS_ENABLED){
    return {
      error: "action_contract_tests_disabled",
      message: "Action contract tests are disabled. Set SDE_ENABLE_ACTION_CONTRACT_TESTS=1 to enable this endpoint."
    };
  }

  return getActionContractTestEnvironmentGuardFailure(activeDatabasePath);
}

function getActionsTableTestGuardFailure(activeDatabasePath){
  if(!ACTIONS_TABLE_TESTS_ENABLED){
    return {
      error: "actions_table_test_writes_disabled",
      message: "Actions table test writes are disabled. Set SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES=1 to enable this endpoint."
    };
  }

  return getActionsTableTestEnvironmentGuardFailure(activeDatabasePath);
}

function getActionContractTestEnvironmentGuardFailure(activeDatabasePath){
  if(PORT === 8787){
    return {
      error: "action_contract_tests_production_port",
      message: "Action contract tests cannot run on production port 8787."
    };
  }

  if(!process.env.SDE_SERVER_DB_PATH){
    return {
      error: "action_contract_tests_db_path_required",
      message: "Action contract tests require an explicit non-production SDE_SERVER_DB_PATH."
    };
  }

  if(isProductionDatabasePath(activeDatabasePath)){
    return {
      error: "action_contract_tests_production_database",
      message: "Action contract tests cannot use the production database."
    };
  }

  return null;
}

function getActionsTableTestEnvironmentGuardFailure(activeDatabasePath){
  if(PORT === 8787){
    return {
      error: "actions_table_test_production_port",
      message: "Actions table test writes cannot run on production port 8787."
    };
  }

  if(!process.env.SDE_SERVER_DB_PATH){
    return {
      error: "actions_table_test_db_path_required",
      message: "Actions table test writes require an explicit non-production SDE_SERVER_DB_PATH."
    };
  }

  if(isProductionDatabasePath(activeDatabasePath)){
    return {
      error: "actions_table_test_production_database",
      message: "Actions table test writes cannot use the production database."
    };
  }

  return null;
}

function isProductionDatabasePath(databasePath){
  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedProductionPath = path.resolve(PRODUCTION_DB_PATH);
  if(resolvedDatabasePath === resolvedProductionPath){
    return true;
  }

  try{
    if(fs.existsSync(resolvedDatabasePath) && fs.existsSync(resolvedProductionPath)){
      return fs.realpathSync(resolvedDatabasePath) === fs.realpathSync(resolvedProductionPath);
    }
  }catch(_error){
    return false;
  }

  return false;
}

function isTmpDatabasePath(databasePath){
  const resolvedDatabasePath = path.resolve(databasePath);
  return resolvedDatabasePath.startsWith("/tmp/") ||
    resolvedDatabasePath.startsWith("/private/tmp/");
}

function formatActionContractTestEvent(event){
  return {
    id: event.id,
    revision: event.revision,
    type: event.type,
    actionId: event.payload?.actionId
  };
}

function formatActionsTableTestEvent(event){
  return {
    id: event?.id ?? null,
    revision: event?.revision ?? null,
    type: event?.type || ACTIONS_TABLE_TEST_EVENT_TYPE
  };
}

function formatServerNoteEvent(event){
  return {
    id: event?.id ?? null,
    revision: event?.revision ?? null,
    type: event?.type || SERVER_NOTE_EVENT_TYPE
  };
}

function broadcastSseEvent(eventName, payload){
  for(const res of sseClients){
    if(res.destroyed || res.writableEnded){
      sseClients.delete(res);
      continue;
    }

    try{
      writeSseEvent(res, eventName, payload);
    }catch(_error){
      sseClients.delete(res);
    }
  }
}
