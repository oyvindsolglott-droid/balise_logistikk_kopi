function parseSinceRevision(value){
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getEventsSinceRevision(db, sinceRevision){
  const revision = parseSinceRevision(sinceRevision);
  return db.prepare(`
    SELECT
      id,
      revision,
      type,
      payload_json AS payloadJson,
      actor,
      device_id AS deviceId,
      created_at AS createdAt,
      previous_revision AS previousRevision
    FROM events
    WHERE revision > ?
    ORDER BY revision ASC, id ASC
  `).all(revision).map(row => ({
    id: row.id,
    revision: row.revision,
    type: row.type,
    payload: safeParseJson(row.payloadJson, {}),
    actor: row.actor || "",
    deviceId: row.deviceId || "",
    createdAt: row.createdAt,
    previousRevision: row.previousRevision
  }));
}

function findEventByPayloadActionId(db, { type, actionId }){
  const rows = db.prepare(`
    SELECT
      id,
      revision,
      type,
      payload_json AS payloadJson,
      actor,
      device_id AS deviceId,
      created_at AS createdAt,
      previous_revision AS previousRevision
    FROM events
    WHERE type = ?
    ORDER BY revision ASC, id ASC
  `).all(type);

  for(const row of rows){
    const payload = safeParseJson(row.payloadJson, {});
    if(payload.actionId !== actionId) continue;

    return {
      id: row.id,
      revision: row.revision,
      type: row.type,
      payload,
      actor: row.actor || "",
      deviceId: row.deviceId || "",
      createdAt: row.createdAt,
      previousRevision: row.previousRevision
    };
  }

  return null;
}

function insertEvent(db, { revision, type, payload, actor = "", deviceId = "", createdAt, previousRevision }){
  const result = db.prepare(`
    INSERT INTO events (
      revision,
      type,
      payload_json,
      actor,
      device_id,
      created_at,
      previous_revision
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision,
    type,
    JSON.stringify(payload),
    actor,
    deviceId,
    createdAt,
    previousRevision
  );

  return {
    id: Number(result.lastInsertRowid),
    revision,
    type,
    payload,
    actor,
    deviceId,
    createdAt,
    previousRevision
  };
}

function safeParseJson(value, fallback){
  try{
    return JSON.parse(value);
  }catch(_error){
    return fallback;
  }
}

function writeSseEvent(res, eventName, payload){
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = {
  findEventByPayloadActionId,
  getEventsSinceRevision,
  insertEvent,
  parseSinceRevision,
  writeSseEvent
};
