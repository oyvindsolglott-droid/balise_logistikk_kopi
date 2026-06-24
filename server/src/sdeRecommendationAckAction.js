const crypto = require("node:crypto");
const { insertEvent } = require("./events");
const { inspectDatabase, validateActionsSchema } = require("./actionsMigration");

const SDE_RECOMMENDATION_ACK_ACTION_TYPE = "sde_recommendation_ack.create";
const SDE_RECOMMENDATION_ACK_EVENT_TYPE = "sde_recommendation_ack.created";
const SDE_RECOMMENDATION_ACK_RECENT_LIMIT = 20;

function writeSdeRecommendationAckAction(db, action){
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
        action: "sde-recommendation-ack",
        idempotent: true,
        actionId: action.actionId,
        ackId: action.actionId,
        payloadHash,
        resultingRevision: Number(existingAction.resultingRevision),
        currentRevision,
        event: {
          id: Number(existingAction.eventId) || null,
          revision: Number(existingAction.resultingRevision),
          type: SDE_RECOMMENDATION_ACK_EVENT_TYPE
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
    const previousAcks = isPlainObject(currentState.sdeRecommendationAcks) ? currentState.sdeRecommendationAcks : {};
    const previousCount = Number.isInteger(previousAcks.count) ? previousAcks.count : 0;
    const previousRecent = Array.isArray(previousAcks.recent) ? previousAcks.recent : [];
    const ack = {
      id: action.actionId,
      actionId: action.actionId,
      createdAt,
      serviceDate: action.payload.serviceDate,
      recommendationKey: action.payload.recommendationKey,
      ackStatus: action.payload.ackStatus,
      actorRole: action.actor.role,
      actorId: action.actor.id,
      deviceId: action.deviceId,
      note: action.payload.note,
      revision: resultingRevision,
      payloadHash
    };
    const nextRecent = [ack, ...previousRecent].slice(0, SDE_RECOMMENDATION_ACK_RECENT_LIMIT);
    const nextState = {
      ...currentState,
      sdeRecommendationAcks: {
        count: previousCount + 1,
        lastAck: ack,
        recent: nextRecent
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
      "sde-recommendation-ack",
      "main"
    );

    const event = insertEvent(db, {
      revision: resultingRevision,
      type: SDE_RECOMMENDATION_ACK_EVENT_TYPE,
      actor: action.actor.id,
      deviceId: action.deviceId,
      payload: {
        actionId: action.actionId,
        actionType: action.actionType,
        ackId: action.actionId,
        actor: action.actor,
        deviceId: action.deviceId,
        expectedRevision: action.expectedRevision,
        resultingRevision,
        payloadHash,
        serverTimestamp: createdAt,
        payloadSummary: {
          serviceDate: action.payload.serviceDate,
          recommendationKey: action.payload.recommendationKey,
          ackStatus: action.payload.ackStatus,
          note: action.payload.note
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
      action: "sde-recommendation-ack",
      idempotent: false,
      actionId: action.actionId,
      ackId: action.actionId,
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

function isPlainObject(value){
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rollbackQuietly(db){
  try{
    db.exec("ROLLBACK;");
  }catch(_error){
    // Preserve the original write error.
  }
}

module.exports = {
  SDE_RECOMMENDATION_ACK_ACTION_TYPE,
  SDE_RECOMMENDATION_ACK_EVENT_TYPE,
  SDE_RECOMMENDATION_ACK_RECENT_LIMIT,
  stableStringify,
  writeSdeRecommendationAckAction
};
