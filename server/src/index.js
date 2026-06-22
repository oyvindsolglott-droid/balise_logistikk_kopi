const express = require("express");
const { openDatabase } = require("./db");
const { getEventsSinceRevision, parseSinceRevision, writeSseEvent } = require("./events");
const { getCurrentRevision, getMainState } = require("./state");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HEARTBEAT_MS = 15000;

const { db, databasePath } = openDatabase();
const app = express();

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

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

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
