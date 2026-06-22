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
  getEventsSinceRevision,
  parseSinceRevision,
  writeSseEvent
};
