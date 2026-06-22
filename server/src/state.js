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

function safeParseJson(value, fallback){
  try{
    return JSON.parse(value);
  }catch(_error){
    return fallback;
  }
}

module.exports = {
  getCurrentRevision,
  getMainState
};
