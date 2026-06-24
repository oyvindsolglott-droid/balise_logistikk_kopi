#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const EXPECTED_REPO_CWD = "/Users/solglottsr/balise_logistikk_kopi";
const EXPECTED_SERVER_CWD = "/Users/solglottsr/balise_logistikk_kopi/server";
const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const TEST_PORT = 8798;
const GUARD_TEST_PORT = 8799;
const TEST_HOST = "127.0.0.1";
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const TEST_DB = `/tmp/sde-b26b-recommendation-ack-${STAMP}.sqlite3`;
const BOOTSTRAP_LOG = `/tmp/sde-b26b-recommendation-ack-bootstrap-${STAMP}.log`;
const DISABLED_LOG = `/tmp/sde-b26b-recommendation-ack-disabled-${STAMP}.log`;
const WRITE_LOG = `/tmp/sde-b26b-recommendation-ack-write-${STAMP}.log`;
const PORT_GUARD_LOG = `/tmp/sde-b26b-recommendation-ack-port-guard-${STAMP}.log`;
const DB_GUARD_LOG = `/tmp/sde-b26b-recommendation-ack-db-guard-${STAMP}.log`;
const DB_PATH_GUARD_LOG = `/tmp/sde-b26b-recommendation-ack-db-path-guard-${STAMP}.log`;
const OPERATIONAL_GUARD_LOG = `/tmp/sde-b26b-recommendation-ack-operational-guard-${STAMP}.log`;

let bootstrapServer = null;
let disabledServer = null;
let writeServer = null;

async function main(){
  normalizeServerCwd();
  const productionBefore = await getProductionSnapshot("before");
  assertProductionBaseline(productionBefore, "before");
  assertSafeTestTarget(TEST_PORT, TEST_DB);
  await assertPortFree(TEST_PORT);
  await assertPortFree(GUARD_TEST_PORT);
  await assertSdeRecommendationAckStartupBlocked("production port guard", {
    PORT: "8787",
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS: "1"
  }, "SDE recommendation ack actions cannot run on production port 8787 in test mode.", PORT_GUARD_LOG);
  await assertSdeRecommendationAckStartupBlocked("production database guard", {
    PORT: String(GUARD_TEST_PORT),
    SDE_SERVER_DB_PATH: PRODUCTION_DB_PATH,
    SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS: "1"
  }, "SDE recommendation ack actions cannot use the production database in test mode.", DB_GUARD_LOG);
  await assertSdeRecommendationAckStartupBlocked("missing db path guard", {
    PORT: String(GUARD_TEST_PORT),
    SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS: "1"
  }, "SDE recommendation ack actions require an explicit non-production SDE_SERVER_DB_PATH.", DB_PATH_GUARD_LOG);
  await assertSdeRecommendationAckStartupBlocked("operational writes guard", {
    PORT: String(GUARD_TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS: "1",
    SDE_ENABLE_OPERATIONAL_WRITES: "1"
  }, "SDE recommendation ack actions must not be enabled with SDE_ENABLE_OPERATIONAL_WRITES=1", OPERATIONAL_GUARD_LOG);

  removeTestDatabaseFiles(TEST_DB);

  bootstrapServer = startServer("bootstrap", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_SCHEMA_MIGRATIONS: "1"
  }, BOOTSTRAP_LOG);

  await waitForHealth();
  const bootstrapStatus = await getJson("/api/server/status");
  assertBootstrapStatus(bootstrapStatus);

  await stopServer(bootstrapServer, "bootstrap");
  bootstrapServer = null;
  await assertPortFree(TEST_PORT);

  assertSqliteScalar("PRAGMA integrity_check;", "ok", "bootstrap integrity_check");
  assertSqliteScalar("PRAGMA user_version;", "1", "bootstrap user_version");
  assertSqliteScalar(
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions';",
    "1",
    "bootstrap actions table count"
  );

  disabledServer = startServer("disabled", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB
  }, DISABLED_LOG);

  await waitForHealth();
  const disabledStatus = await getJson("/api/server/status");
  assertDisabledStatus(disabledStatus);

  const disabledAction = createRecommendationAckAction("b26b-sde-ack-disabled", 1);
  const disabled = await postJson("/api/actions/sde-recommendation-ack", disabledAction);
  assertStatus(disabled, 403, "disabled");
  assertEqual(disabled.body.error, "sde_recommendation_ack_actions_disabled", "disabled error");
  assertEqual(await getRevision(), 1, "revision after disabled");
  assertSqliteScalar("SELECT COUNT(*) FROM actions;", "0", "disabled action count");
  assertSqliteScalar("SELECT COUNT(*) FROM events;", "0", "disabled event count");

  await stopServer(disabledServer, "disabled");
  disabledServer = null;
  await assertPortFree(TEST_PORT);

  writeServer = startServer("write", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS: "1"
  }, WRITE_LOG);

  await waitForHealth();
  const writeStatus = await getJson("/api/server/status");
  assertWriteStatus(writeStatus);

  const initialRevision = await getRevision();
  const action = createRecommendationAckAction("b26b-sde-ack-001", initialRevision);

  await assertInvalidPayloadCases(action, initialRevision);

  const created = await postJson("/api/actions/sde-recommendation-ack", action);
  assertStatus(created, 201, "created");
  assertCreatedResponse(created.body, initialRevision);
  const resultingRevision = created.body.resultingRevision;

  const revisionAfterCreated = await getRevision();
  assertEqual(revisionAfterCreated, resultingRevision, "revision after created");
  await assertRecommendationAckState(resultingRevision, 1, action);

  const replayed = await postJson("/api/actions/sde-recommendation-ack", action);
  assertStatus(replayed, 200, "replayed");
  assertReplayedResponse(replayed.body, resultingRevision);
  const revisionAfterReplay = await getRevision();
  assertEqual(revisionAfterReplay, resultingRevision, "revision after replay");

  const actionConflict = await postJson("/api/actions/sde-recommendation-ack", {
    ...action,
    expectedRevision: resultingRevision,
    payload: {
      ...action.payload,
      ackStatus: "needs_manual_review"
    }
  });
  assertStatus(actionConflict, 409, "action_id_conflict");
  assertEqual(actionConflict.body.error, "action_id_conflict", "action_id_conflict error");
  assertEqual(await getRevision(), resultingRevision, "revision after action_id_conflict");

  const revisionConflict = await postJson("/api/actions/sde-recommendation-ack", {
    ...createRecommendationAckAction("b26b-sde-ack-002", initialRevision),
    payload: {
      serviceDate: "2026-06-24",
      recommendationKey: "b26b-stale-recommendation",
      ackStatus: "seen",
      note: "B26B stale revision recommendation ack"
    }
  });
  assertStatus(revisionConflict, 409, "revision_conflict");
  assertEqual(revisionConflict.body.error, "revision_conflict", "revision_conflict error");
  assertEqual(await getRevision(), resultingRevision, "revision after revision_conflict");

  let currentRevision = resultingRevision;
  for(let i = 0; i < 25; i += 1){
    const boundedAction = createRecommendationAckAction(`b26b-sde-ack-bounded-${String(i).padStart(2, "0")}`, currentRevision, {
      recommendationKey: `b26b-rec-bounded-${String(i).padStart(2, "0")}`,
      ackStatus: i % 2 === 0 ? "seen" : "assessed",
      note: `B26B bounded recommendation ack ${i}`
    });
    const response = await postJson("/api/actions/sde-recommendation-ack", boundedAction);
    assertStatus(response, 201, `bounded created ${i}`);
    currentRevision = response.body.resultingRevision;
  }

  await assertRecommendationAckState(currentRevision, 26, createRecommendationAckAction("b26b-sde-ack-bounded-24", currentRevision - 1, {
    recommendationKey: "b26b-rec-bounded-24",
    ackStatus: "seen",
    note: "B26B bounded recommendation ack 24"
  }));

  const events = await getJson("/api/events");
  if(!Array.isArray(events.events) || events.events.length !== 26){
    throw new Error(`Expected exactly 26 events, got ${JSON.stringify(events)}`);
  }
  assertEqual(events.events[0].type, "sde_recommendation_ack.created", "first event type");
  assertEqual(events.events[events.events.length - 1].type, "sde_recommendation_ack.created", "last event type");

  assertSqliteScalar("PRAGMA integrity_check;", "ok", "final integrity_check");
  assertSqliteScalar("PRAGMA user_version;", "1", "final user_version");
  assertSqliteScalar("SELECT COUNT(*) FROM actions;", "26", "final action count");
  assertSqliteScalar("SELECT COUNT(*) FROM events;", "26", "final event count");
  assertSqliteScalar("SELECT status FROM actions WHERE action_id = 'b26b-sde-ack-001';", "completed", "action status");
  assertSqliteScalar("SELECT action_type FROM actions WHERE action_id = 'b26b-sde-ack-001';", "sde_recommendation_ack.create", "action type");
  assertSqliteScalar("SELECT COUNT(*) FROM events WHERE type = 'sde_recommendation_ack.created';", "26", "event type count in sqlite");

  await stopServer(writeServer, "write");
  writeServer = null;
  await assertPortFree(TEST_PORT);

  const productionAfter = await getProductionSnapshot("after");
  assertProductionUnchanged(productionBefore, productionAfter);

  console.log(`testDb: ${TEST_DB}`);
  console.log(`bootstrapLog: ${BOOTSTRAP_LOG}`);
  console.log(`disabledLog: ${DISABLED_LOG}`);
  console.log(`writeLog: ${WRITE_LOG}`);
  console.log(`portGuardLog: ${PORT_GUARD_LOG}`);
  console.log(`dbGuardLog: ${DB_GUARD_LOG}`);
  console.log(`dbPathGuardLog: ${DB_PATH_GUARD_LOG}`);
  console.log(`operationalGuardLog: ${OPERATIONAL_GUARD_LOG}`);
  console.log("startupGuards: ok");
  console.log("disabled: ok");
  console.log("invalidPayloadCases: ok");
  console.log(`created: ok revision ${initialRevision} -> ${resultingRevision}`);
  console.log("replayed: ok");
  console.log("action_id_conflict: ok");
  console.log("revision_conflict: ok");
  console.log("boundedState: ok count=26 recent=20");
  console.log("statusFields: ok");
  console.log("sqlite: ok");
  console.log("productionGetOnly: ok");
  console.log("result: PASS_B26B_SDE_RECOMMENDATION_ACK_ACTION");
}

function createRecommendationAckAction(actionId, expectedRevision, payloadOverrides = {}){
  return {
    actionId,
    actionType: "sde_recommendation_ack.create",
    actor: {
      id: "b26b-regression",
      role: "test"
    },
    deviceId: "b26b-test-device",
    expectedRevision,
    payload: {
      serviceDate: "2026-06-24",
      recommendationKey: "b26b-recommendation-card-001",
      ackStatus: "assessed",
      note: "B26B recommendation acknowledgement test",
      ...payloadOverrides
    },
    clientContext: {
      source: "test-sde-recommendation-ack-action"
    }
  };
}

function normalizeServerCwd(){
  const cwd = path.resolve(process.cwd());
  if(cwd === EXPECTED_SERVER_CWD) return;
  if(cwd === EXPECTED_REPO_CWD){
    process.chdir(EXPECTED_SERVER_CWD);
    return;
  }

  throw new Error(`Must run from ${EXPECTED_SERVER_CWD} or ${EXPECTED_REPO_CWD}; cwd=${process.cwd()}`);
}

function assertSafeTestTarget(port, databasePath){
  if(Number(port) === 8787){
    throw new Error("Test port must never be production port 8787.");
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  if(resolvedDatabasePath === path.resolve(PRODUCTION_DB_PATH)){
    throw new Error("Test database must never be the production database.");
  }

  if(!resolvedDatabasePath.startsWith("/tmp/")){
    throw new Error(`Test database must be under /tmp: ${databasePath}`);
  }
}

function removeTestDatabaseFiles(databasePath){
  for(const file of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]){
    const resolved = path.resolve(file);
    if(!resolved.startsWith("/tmp/")){
      throw new Error(`Refusing to remove non-/tmp file: ${file}`);
    }
    fs.rmSync(resolved, { force: true });
  }
}

function startServer(label, envOverrides, logPath){
  const env = createServerEnv(envOverrides);
  const output = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: EXPECTED_SERVER_CWD,
    env,
    detached: false,
    stdio: ["ignore", output, output]
  });
  fs.closeSync(output);

  child.once("exit", (code, signal) => {
    if(child.expectedExit) return;
    console.error(`${label} server exited unexpectedly: code=${code} signal=${signal}`);
    console.error(readTail(logPath));
  });

  child.label = label;
  child.logPath = logPath;
  console.log(`${label}Pid: ${child.pid}`);
  console.log(`${label}Log: ${logPath}`);
  return child;
}

function createServerEnv(overrides){
  const env = { ...process.env };
  delete env.PORT;
  delete env.SDE_SERVER_DB_PATH;
  delete env.SDE_ENABLE_SCHEMA_MIGRATIONS;
  delete env.SDE_ENABLE_SERVER_NOTE_ACTIONS;
  delete env.SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS;
  delete env.SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS;
  delete env.SDE_ENABLE_PRODUCTION_SDE_RECOMMENDATION_ACK_ACTIONS;
  delete env.SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES;
  delete env.SDE_ENABLE_ACTION_CONTRACT_TESTS;
  delete env.SDE_ENABLE_TEST_WRITES;
  delete env.SDE_ENABLE_OPERATIONAL_WRITES;
  delete env.SDE_PWA_CONNECTED;
  return {
    ...env,
    ...overrides
  };
}

async function assertSdeRecommendationAckStartupBlocked(label, envOverrides, expectedLogText, logPath){
  const port = Number(envOverrides.PORT || 8787);
  if(port !== 8787){
    await assertPortFree(port);
  }

  const env = createServerEnv(envOverrides);
  const output = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: EXPECTED_SERVER_CWD,
    env,
    detached: false,
    stdio: ["ignore", output, output]
  });
  fs.closeSync(output);

  const result = await waitForChildExitDetails(child, 3000);
  if(!result.exited){
    child.kill("SIGTERM");
    const stopped = await waitForChildExit(child, 1500);
    if(!stopped){
      child.kill("SIGKILL");
    }
    throw new Error(`${label} did not block startup quickly. Log:\n${readTail(logPath)}`);
  }

  if(result.code === 0){
    throw new Error(`${label} exited successfully, expected startup block. Log:\n${readTail(logPath)}`);
  }

  const log = readTail(logPath);
  if(!log.includes(expectedLogText)){
    throw new Error(`${label} log did not include ${JSON.stringify(expectedLogText)}. Log:\n${log}`);
  }

  if(port !== 8787){
    await assertPortFree(port);
  }
}

async function stopServer(child, label){
  if(!child || child.exitCode !== null) return;
  child.expectedExit = true;
  child.kill("SIGTERM");
  const stopped = await waitForChildExit(child, 3000);
  if(!stopped){
    child.kill("SIGKILL");
    throw new Error(`${label} server did not stop after SIGTERM.`);
  }
}

function waitForChildExit(child, timeoutMs){
  return new Promise(resolve => {
    if(child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    function onExit(){
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

function waitForChildExitDetails(child, timeoutMs){
  return new Promise(resolve => {
    if(child.exitCode !== null){
      return resolve({
        exited: true,
        code: child.exitCode,
        signal: child.signalCode
      });
    }

    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ exited: false });
    }, timeoutMs);

    function onExit(code, signal){
      clearTimeout(timer);
      resolve({
        exited: true,
        code,
        signal
      });
    }

    child.once("exit", onExit);
  });
}

async function waitForHealth(){
  for(let attempt = 0; attempt < 30; attempt += 1){
    try{
      const health = await getJson("/api/health");
      if(health.ok === true) return health;
    }catch(_error){
      // Retry while the child server is starting.
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for test server health.");
}

async function getRevision(){
  const body = await getJson("/api/state/revision");
  return Number(body.revision);
}

async function getJson(pathname){
  const response = await requestJson("GET", TEST_PORT, pathname);
  if(response.status < 200 || response.status >= 300){
    throw new Error(`GET ${pathname} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function postJson(pathname, body){
  return requestJson("POST", TEST_PORT, pathname, body);
}

function requestJson(method, port, pathname, body){
  if(port === 8787 && method !== "GET"){
    throw new Error("Refusing non-GET request to production port 8787.");
  }

  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: TEST_HOST,
      port,
      path: pathname,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      } : {}
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        data += chunk;
      });
      res.on("end", () => {
        try{
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        }catch(error){
          reject(new Error(`Invalid JSON response from ${method} ${pathname}: ${error.message}; body=${data}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Timeout calling ${method} ${pathname}`));
    });
    if(payload) req.write(payload);
    req.end();
  });
}

async function getProductionSnapshot(label){
  const health = await requestJson("GET", 8787, "/api/health");
  assertStatus(health, 200, `${label} production health`);
  const revision = await requestJson("GET", 8787, "/api/state/revision");
  assertStatus(revision, 200, `${label} production revision`);
  const status = await requestJson("GET", 8787, "/api/server/status");
  assertStatus(status, 200, `${label} production status`);
  const events = await requestJson("GET", 8787, "/api/events");
  assertStatus(events, 200, `${label} production events`);
  const state = await requestJson("GET", 8787, "/api/state");
  assertStatus(state, 200, `${label} production state`);
  return {
    health: health.body,
    revision: revision.body,
    status: status.body,
    events: events.body,
    state: state.body
  };
}

function assertProductionBaseline(snapshot, label){
  assertEqual(snapshot.health.ok, true, `${label} production health ok`);
  assertEqual(snapshot.revision.revision, 3, `${label} production revision`);
  assertEqual(snapshot.events.events.length, 2, `${label} production event count`);
  for(const event of snapshot.events.events){
    assertEqual(event.type, "server_note.created", `${label} production event type`);
  }
  assertEqual(snapshot.state.state?.serverNotes?.count, 2, `${label} production serverNotes.count`);
  assertEqual(snapshot.status.serverNoteActionsEnabled, false, `${label} production serverNoteActionsEnabled`);
  assertEqual(snapshot.status.serverNoteProductionActionsEnabled, false, `${label} production serverNoteProductionActionsEnabled`);
  assertEqual(snapshot.status.migrationsEnabled, false, `${label} production migrationsEnabled`);
  assertEqual(snapshot.status.pwaConnected, false, `${label} production pwaConnected`);
  assertEqual(snapshot.status.operationalWritesEnabled, false, `${label} production operationalWritesEnabled`);
}

function assertProductionUnchanged(before, after){
  assertProductionBaseline(after, "after");
  assertEqual(after.revision.revision, before.revision.revision, "production revision unchanged");
  assertEqual(after.events.events.length, before.events.events.length, "production event count unchanged");
  assertEqual(after.state.state?.serverNotes?.count, before.state.state?.serverNotes?.count, "production serverNotes.count unchanged");
  assertEqual(after.status.startedAt, before.status.startedAt, "production startedAt unchanged");
}

function assertBootstrapStatus(status){
  assertEqual(status.port, TEST_PORT, "bootstrap port");
  assertEqual(status.databaseFile, path.basename(TEST_DB), "bootstrap databaseFile");
  assertEqual(status.migrationsEnabled, true, "bootstrap migrationsEnabled");
  assertEqual(status.schemaUserVersion, 1, "bootstrap schemaUserVersion");
  assertEqual(status.actionsTablePresent, true, "bootstrap actionsTablePresent");
  assertEqual(status.actionsSchemaReady, true, "bootstrap actionsSchemaReady");
  assertEqual(status.migrationRequired, false, "bootstrap migrationRequired");
  assertEqual(status.sdeRecommendationAckActionsEnabled, false, "bootstrap sdeRecommendationAckActionsEnabled");
  assertEqual(status.sdeRecommendationAckProductionActionsEnabled, false, "bootstrap sdeRecommendationAckProductionActionsEnabled");
}

function assertDisabledStatus(status){
  assertEqual(status.port, TEST_PORT, "disabled port");
  assertEqual(status.databaseFile, path.basename(TEST_DB), "disabled databaseFile");
  assertEqual(status.sdeRecommendationAckActionsEnabled, false, "disabled sdeRecommendationAckActionsEnabled");
  assertEqual(status.sdeRecommendationAckProductionActionsEnabled, false, "disabled sdeRecommendationAckProductionActionsEnabled");
  assertEqual(status.migrationsEnabled, false, "disabled migrationsEnabled");
  assertEqual(status.schemaUserVersion, 1, "disabled schemaUserVersion");
  assertEqual(status.actionsTablePresent, true, "disabled actionsTablePresent");
  assertEqual(status.actionsSchemaReady, true, "disabled actionsSchemaReady");
  assertEqual(status.migrationRequired, false, "disabled migrationRequired");
}

function assertWriteStatus(status){
  assertEqual(status.port, TEST_PORT, "write port");
  assertEqual(status.databaseFile, path.basename(TEST_DB), "write databaseFile");
  assertEqual(status.sdeRecommendationAckActionsEnabled, true, "write sdeRecommendationAckActionsEnabled");
  assertEqual(status.sdeRecommendationAckProductionActionsEnabled, false, "write sdeRecommendationAckProductionActionsEnabled");
  assertEqual(status.operationalWritesEnabled, false, "write operationalWritesEnabled");
  assertEqual(status.migrationsEnabled, false, "write migrationsEnabled");
  assertEqual(status.schemaUserVersion, 1, "write schemaUserVersion");
  assertEqual(status.actionsTablePresent, true, "write actionsTablePresent");
  assertEqual(status.actionsSchemaReady, true, "write actionsSchemaReady");
  assertEqual(status.migrationRequired, false, "write migrationRequired");
}

function assertCreatedResponse(body, previousRevision){
  assertEqual(body.ok, true, "created ok");
  assertEqual(body.mode, "created", "created mode");
  assertEqual(body.idempotent, false, "created idempotent");
  assertEqual(body.previousRevision, previousRevision, "created previousRevision");
  if(!(Number(body.resultingRevision) > previousRevision)){
    throw new Error(`Expected resultingRevision > ${previousRevision}, got ${body.resultingRevision}`);
  }
  if(!body.payloadHash){
    throw new Error("Expected created payloadHash.");
  }
  assertEqual(body.event?.type, "sde_recommendation_ack.created", "created event type");
}

function assertReplayedResponse(body, resultingRevision){
  assertEqual(body.ok, true, "replayed ok");
  assertEqual(body.mode, "replayed", "replayed mode");
  assertEqual(body.idempotent, true, "replayed idempotent");
  assertEqual(body.resultingRevision, resultingRevision, "replayed resultingRevision");
  assertEqual(body.event?.type, "sde_recommendation_ack.created", "replayed event type");
}

async function assertRecommendationAckState(resultingRevision, expectedCount, action){
  const stateResponse = await getJson("/api/state");
  assertEqual(stateResponse.revision, resultingRevision, "state revision");
  const acks = stateResponse.state?.sdeRecommendationAcks;
  if(!acks || typeof acks !== "object" || Array.isArray(acks)){
    throw new Error(`Expected sdeRecommendationAcks object, got ${JSON.stringify(acks)}`);
  }
  assertEqual(acks.count, expectedCount, "sdeRecommendationAcks count");
  assertEqual(acks.lastAck?.id, action.actionId, "sdeRecommendationAcks lastAck id");
  assertEqual(acks.lastAck?.recommendationKey, action.payload.recommendationKey, "sdeRecommendationAcks lastAck recommendationKey");
  assertEqual(acks.lastAck?.ackStatus, action.payload.ackStatus, "sdeRecommendationAcks lastAck ackStatus");
  assertEqual(acks.lastAck?.revision, resultingRevision, "sdeRecommendationAcks lastAck revision");
  if(!Array.isArray(acks.recent)){
    throw new Error("Expected sdeRecommendationAcks.recent array.");
  }
  if(acks.recent.length > 20){
    throw new Error(`Expected recent length <= 20, got ${acks.recent.length}`);
  }
  if(expectedCount >= 20){
    assertEqual(acks.recent.length, 20, "bounded recent length");
  }
}

async function assertInvalidPayloadCases(validAction, expectedRevision){
  const cases = [
    {
      label: "missing actionId",
      body: withoutKey(validAction, "actionId")
    },
    {
      label: "wrong actionType",
      body: {
        ...validAction,
        actionType: "sde_recommendation_ack.update"
      }
    },
    {
      label: "missing actor.id",
      body: {
        ...validAction,
        actor: withoutKey(validAction.actor, "id")
      }
    },
    {
      label: "invalid actor.role",
      body: {
        ...validAction,
        actor: {
          ...validAction.actor,
          role: "dispatcher"
        }
      }
    },
    {
      label: "missing deviceId",
      body: withoutKey(validAction, "deviceId")
    },
    {
      label: "invalid expectedRevision type",
      body: {
        ...validAction,
        expectedRevision: "1"
      }
    },
    {
      label: "missing payload.serviceDate",
      body: {
        ...validAction,
        payload: withoutKey(validAction.payload, "serviceDate")
      }
    },
    {
      label: "invalid payload.serviceDate",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          serviceDate: "24.06.2026"
        }
      }
    },
    {
      label: "missing payload.recommendationKey",
      body: {
        ...validAction,
        payload: withoutKey(validAction.payload, "recommendationKey")
      }
    },
    {
      label: "ackStatus executed forbidden",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          ackStatus: "executed"
        }
      }
    },
    {
      label: "ackStatus annulled forbidden",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          ackStatus: "annulled"
        }
      }
    },
    {
      label: "ackStatus followed forbidden",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          ackStatus: "followed"
        }
      }
    },
    {
      label: "ackStatus completed forbidden",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          ackStatus: "completed"
        }
      }
    },
    {
      label: "ackStatus cancelled forbidden",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          ackStatus: "cancelled"
        }
      }
    },
    {
      label: "note too long",
      body: {
        ...validAction,
        payload: {
          ...validAction.payload,
          note: "x".repeat(501)
        }
      }
    },
    {
      label: "invalid clientContext type",
      body: {
        ...validAction,
        clientContext: "not-an-object"
      }
    }
  ];

  for(const testCase of cases){
    const response = await postJson("/api/actions/sde-recommendation-ack", testCase.body);
    assertStatus(response, 400, testCase.label);
    assertEqual(response.body.error, "invalid_payload", `${testCase.label} error`);
    assertEqual(await getRevision(), expectedRevision, `revision after ${testCase.label}`);
  }
}

function withoutKey(object, key){
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function assertStatus(response, expectedStatus, label){
  if(response.status !== expectedStatus){
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(response.body)}`);
  }
}

function assertSqliteScalar(sql, expected, label){
  const value = execFileSync("sqlite3", [TEST_DB, sql], {
    encoding: "utf8"
  }).trim();
  assertEqual(value, expected, label);
}

function assertEqual(actual, expected, label){
  if(actual !== expected){
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function assertPortFree(port){
  const listening = await isPortListening(port);
  if(listening){
    throw new Error(`Port ${port} is already listening.`);
  }
}

function isPortListening(port){
  return new Promise(resolve => {
    const socket = net.createConnection({ host: TEST_HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readTail(filePath){
  try{
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").slice(-40).join("\n");
  }catch(error){
    return `Could not read log ${filePath}: ${error.message}`;
  }
}

main()
  .catch(async error => {
    console.error("FAIL_B26B_SDE_RECOMMENDATION_ACK_ACTION");
    console.error(error);
    if(bootstrapServer){
      await stopServer(bootstrapServer, "bootstrap").catch(stopError => console.error(stopError));
    }
    if(disabledServer){
      await stopServer(disabledServer, "disabled").catch(stopError => console.error(stopError));
    }
    if(writeServer){
      await stopServer(writeServer, "write").catch(stopError => console.error(stopError));
    }
    console.error(`testDb: ${TEST_DB}`);
    console.error(`bootstrapLog: ${BOOTSTRAP_LOG}`);
    console.error(`disabledLog: ${DISABLED_LOG}`);
    console.error(`writeLog: ${WRITE_LOG}`);
    console.error(`portGuardLog: ${PORT_GUARD_LOG}`);
    console.error(`dbGuardLog: ${DB_GUARD_LOG}`);
    console.error(`dbPathGuardLog: ${DB_PATH_GUARD_LOG}`);
    console.error(`operationalGuardLog: ${OPERATIONAL_GUARD_LOG}`);
    process.exitCode = 1;
  });
