const { insertEvent } = require("./events");

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

module.exports = {
  getCurrentRevision,
  getMainState,
  writeTestNote
};
