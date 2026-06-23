const crypto = require("node:crypto");
const { insertEvent } = require("./events");
const { inspectDatabase, validateActionsSchema } = require("./actionsMigration");

const ACTIONS_TABLE_TEST_EVENT_TYPE = "actions_table.test";

function writeActionsTableTestAction(db, action){
  const schemaInspection = inspectDatabase(db);
  const schemaCheck = validateActionsSchema(schemaInspection);
  if(!schemaCheck.ok){
    return {
      ok: false,
      error: "actions_schema_not_ready",
      problems: schemaCheck.problems
    };
  }

  const canonicalRequest = stableStringify(action);
  const payloadHash = sha256(canonicalRequest);

  db.exec("BEGIN IMMEDIATE TRANSACTION;");

  try{
    const row = db.prepare(`
      SELECT revision, state_json AS stateJson
      FROM app_state
      WHERE id = ?
    `).get("main");

    if(!row){
      throw new Error("Missing app_state row with id main");
    }

    const currentRevision = Number(row.revision) || 0;
    const existingAction = db.prepare(`
      SELECT
        action_id AS actionId,
        request_json AS requestJson,
        payload_hash AS payloadHash,
        status,
        resulting_revision AS resultingRevision,
        event_id AS eventId
      FROM actions
      WHERE action_id = ?
    `).get(action.actionId);

    if(existingAction){
      const sameRequest = existingAction.payloadHash === payloadHash &&
        existingAction.requestJson === canonicalRequest;
      if(!sameRequest){
        db.exec("ROLLBACK;");
        return {
          ok: false,
          error: "action_id_conflict",
          actionId: action.actionId,
          currentRevision
        };
      }

      if(existingAction.status !== "completed" || !existingAction.resultingRevision){
        throw new Error("Existing action record is incomplete.");
      }

      db.exec("ROLLBACK;");
      return {
        ok: true,
        action: "actions-table-test",
        idempotent: true,
        actionId: action.actionId,
        payloadHash,
        resultingRevision: Number(existingAction.resultingRevision),
        currentRevision,
        event: {
          id: Number(existingAction.eventId) || null,
          revision: Number(existingAction.resultingRevision),
          type: ACTIONS_TABLE_TEST_EVENT_TYPE
        }
      };
    }

    if(currentRevision !== action.expectedRevision){
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: "revision_conflict",
        expectedRevision: action.expectedRevision,
        currentRevision
      };
    }

    const previousRevision = currentRevision;
    const resultingRevision = previousRevision + 1;
    const createdAt = new Date().toISOString();
    const currentState = safeParseJson(row.stateJson, {});
    const nextState = {
      ...currentState,
      serverTestActionsTable: {
        lastActionId: action.actionId,
        lastActionType: action.actionType,
        lastTestNote: action.payload.testNote,
        actor: action.actor,
        deviceId: action.deviceId,
        payloadHash,
        updatedAt: createdAt,
        revision: resultingRevision
      }
    };

    db.prepare(`
      INSERT INTO actions (
        action_id,
        action_type,
        actor_id,
        actor_role,
        device_id,
        expected_revision,
        request_json,
        payload_hash,
        status,
        resulting_revision,
        event_id,
        server_created_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.actionId,
      action.actionType,
      action.actor.id,
      action.actor.role,
      action.deviceId,
      action.expectedRevision,
      canonicalRequest,
      payloadHash,
      "started",
      null,
      null,
      createdAt,
      null
    );

    db.prepare(`
      UPDATE app_state
      SET revision = ?, state_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?
    `).run(
      resultingRevision,
      JSON.stringify(nextState),
      createdAt,
      "actions-table-test",
      "main"
    );

    const event = insertEvent(db, {
      revision: resultingRevision,
      type: ACTIONS_TABLE_TEST_EVENT_TYPE,
      actor: action.actor.id,
      deviceId: action.deviceId,
      payload: {
        actionId: action.actionId,
        actionType: action.actionType,
        actor: action.actor,
        deviceId: action.deviceId,
        expectedRevision: action.expectedRevision,
        resultingRevision,
        payloadHash,
        serverTimestamp: createdAt,
        payloadSummary: {
          testNote: action.payload.testNote
        },
        clientContext: action.clientContext,
        request: action
      },
      createdAt,
      previousRevision
    });

    db.prepare(`
      UPDATE actions
      SET status = ?, resulting_revision = ?, event_id = ?, completed_at = ?
      WHERE action_id = ?
    `).run(
      "completed",
      resultingRevision,
      event.id,
      createdAt,
      action.actionId
    );

    db.exec("COMMIT;");

    return {
      ok: true,
      action: "actions-table-test",
      idempotent: false,
      actionId: action.actionId,
      payloadHash,
      previousRevision,
      resultingRevision,
      event
    };
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }
}

function sha256(value){
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeParseJson(value, fallback){
  try{
    return JSON.parse(value);
  }catch(_error){
    return fallback;
  }
}

function stableStringify(value){
  return JSON.stringify(sortJson(value));
}

function sortJson(value){
  if(Array.isArray(value)){
    return value.map(sortJson);
  }

  if(value && typeof value === "object"){
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortJson(value[key])])
    );
  }

  return value;
}

function rollbackQuietly(db){
  try{
    db.exec("ROLLBACK;");
  }catch(_error){
    // Preserve the original write error.
  }
}

module.exports = {
  ACTIONS_TABLE_TEST_EVENT_TYPE,
  stableStringify,
  writeActionsTableTestAction
};
