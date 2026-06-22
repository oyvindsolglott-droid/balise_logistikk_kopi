const { findEventByPayloadActionId, insertEvent } = require("./events");

const ACTION_CONTRACT_TEST_EVENT_TYPE = "action_contract.test";

function getMainState(db){
  const row = db.prepare(`
    SELECT revision, state_json AS stateJson, updated_at AS updatedAt
    FROM app_state
    WHERE id = ?
  `).get("main");

  if(!row){
    throw new Error("Missing app_state row with id main");
  }

  return {
    revision: row.revision,
    updatedAt: row.updatedAt,
    state: safeParseJson(row.stateJson, {})
  };
}

function getCurrentRevision(db){
  return Number(getMainState(db).revision) || 0;
}

function writeTestNote(db, { expectedRevision, note }){
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
    if(currentRevision !== expectedRevision){
      db.exec("ROLLBACK;");
      return {
        ok: false,
        error: "revision_conflict",
        expectedRevision,
        currentRevision
      };
    }

    const previousRevision = currentRevision;
    const revision = previousRevision + 1;
    const createdAt = new Date().toISOString();
    const currentState = safeParseJson(row.stateJson, {});
    const nextState = {
      ...currentState,
      serverTest: {
        lastNote: note,
        updatedAt: createdAt,
        revision
      }
    };

    db.prepare(`
      UPDATE app_state
      SET revision = ?, state_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?
    `).run(
      revision,
      JSON.stringify(nextState),
      createdAt,
      "test-note",
      "main"
    );

    const event = insertEvent(db, {
      revision,
      type: "test.note",
      payload: {
        note,
        previousRevision,
        revision,
        createdAt
      },
      createdAt,
      previousRevision
    });

    db.exec("COMMIT;");

    return {
      ok: true,
      action: "test-note",
      previousRevision,
      revision,
      event
    };
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }
}

function writeActionContractTest(db, action){
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
    const existingEvent = findEventByPayloadActionId(db, {
      type: ACTION_CONTRACT_TEST_EVENT_TYPE,
      actionId: action.actionId
    });

    if(existingEvent){
      const existingRequest = existingEvent.payload.request || null;
      if(stableStringify(existingRequest) !== stableStringify(action)){
        db.exec("ROLLBACK;");
        return {
          ok: false,
          error: "action_id_conflict",
          actionId: action.actionId,
          currentRevision
        };
      }

      db.exec("ROLLBACK;");
      return {
        ok: true,
        action: "action-contract-test",
        idempotent: true,
        actionId: action.actionId,
        revision: existingEvent.revision,
        currentRevision,
        event: existingEvent
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
    const revision = previousRevision + 1;
    const createdAt = new Date().toISOString();
    const currentState = safeParseJson(row.stateJson, {});
    const nextState = {
      ...currentState,
      actionContractTest: {
        lastActionId: action.actionId,
        lastActionType: action.actionType,
        lastTestNote: action.payload.testNote,
        actor: action.actor,
        deviceId: action.deviceId,
        updatedAt: createdAt,
        revision
      }
    };

    db.prepare(`
      UPDATE app_state
      SET revision = ?, state_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?
    `).run(
      revision,
      JSON.stringify(nextState),
      createdAt,
      "action-contract-test",
      "main"
    );

    const event = insertEvent(db, {
      revision,
      type: ACTION_CONTRACT_TEST_EVENT_TYPE,
      actor: action.actor.id,
      deviceId: action.deviceId,
      payload: {
        actionId: action.actionId,
        actionType: action.actionType,
        actor: action.actor,
        deviceId: action.deviceId,
        expectedRevision: action.expectedRevision,
        resultingRevision: revision,
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

    db.exec("COMMIT;");

    return {
      ok: true,
      action: "action-contract-test",
      idempotent: false,
      actionId: action.actionId,
      previousRevision,
      revision,
      event
    };
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }
}

function rollbackQuietly(db){
  try{
    db.exec("ROLLBACK;");
  }catch(_error){
    // Ignore rollback failures so the original write error is preserved.
  }
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

module.exports = {
  getCurrentRevision,
  getMainState,
  writeActionContractTest,
  writeTestNote
};
