const express = require("express");
const { openDatabase } = require("./db");
const { getEventsSinceRevision, parseSinceRevision, writeSseEvent } = require("./events");
const { getCurrentRevision, getMainState, writeTestNote } = require("./state");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HEARTBEAT_MS = 15000;
const TEST_NOTE_MAX_LENGTH = 500;
const TEST_WRITES_ENABLED = process.env.SDE_ENABLE_TEST_WRITES === "1";

const { db, databasePath } = openDatabase();
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
