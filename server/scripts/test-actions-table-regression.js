#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const EXPECTED_CWD = "/Users/solglottsr/balise_logistikk_kopi/server";
const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const TEST_PORT = 8788;
const TEST_HOST = "127.0.0.1";
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const TEST_DB = `/tmp/sde-b15d-actions-table-regression-${STAMP}.sqlite3`;
const BOOTSTRAP_LOG = `/tmp/sde-b15d-actions-table-regression-bootstrap-${STAMP}.log`;
const WRITE_LOG = `/tmp/sde-b15d-actions-table-regression-write-${STAMP}.log`;

let bootstrapServer = null;
let writeServer = null;

async function main(){
  assertServerCwd();
  assertSafeTestTarget(TEST_PORT, TEST_DB);
  await assertPortFree(TEST_PORT);
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

  writeServer = startServer("write", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES: "1"
  }, WRITE_LOG);

  await waitForHealth();
  const writeStatus = await getJson("/api/server/status");
  assertWriteStatus(writeStatus);

  const initialRevision = await getRevision();
  const action = {
    actionId: "b15d-action-001",
    actionType: "actions_table.test",
    actor: {
      id: "b15d-regression",
      role: "test"
    },
    deviceId: "b15d-test-device",
    expectedRevision: initialRevision,
    payload: {
      testNote: "B15D regression created test"
    }
  };

  const created = await postJson("/api/actions/actions-table-test", action);
  assertStatus(created, 201, "created");
  assertCreatedResponse(created.body, initialRevision);
  const resultingRevision = created.body.resultingRevision;

  const revisionAfterCreated = await getRevision();
  assertEqual(revisionAfterCreated, resultingRevision, "revision after created");

  const replayed = await postJson("/api/actions/actions-table-test", action);
  assertStatus(replayed, 200, "replayed");
  assertReplayedResponse(replayed.body, resultingRevision);
  const revisionAfterReplay = await getRevision();
  assertEqual(revisionAfterReplay, resultingRevision, "revision after replay");

  const actionConflict = await postJson("/api/actions/actions-table-test", {
    ...action,
    expectedRevision: resultingRevision,
    payload: {
      testNote: "B15D regression conflicting payload"
    }
  });
  assertStatus(actionConflict, 409, "action_id_conflict");
  assertEqual(actionConflict.body.error, "action_id_conflict", "action_id_conflict error");
  const revisionAfterActionConflict = await getRevision();
  assertEqual(revisionAfterActionConflict, resultingRevision, "revision after action_id_conflict");

  const revisionConflict = await postJson("/api/actions/actions-table-test", {
    ...action,
    actionId: "b15d-action-002",
    expectedRevision: initialRevision,
    payload: {
      testNote: "B15D regression stale revision"
    }
  });
  assertStatus(revisionConflict, 409, "revision_conflict");
  assertEqual(revisionConflict.body.error, "revision_conflict", "revision_conflict error");
  const revisionAfterRevisionConflict = await getRevision();
  assertEqual(revisionAfterRevisionConflict, resultingRevision, "revision after revision_conflict");

  const events = await getJson("/api/events");
  if(!Array.isArray(events.events) || events.events.length !== 1){
    throw new Error(`Expected exactly one event, got ${JSON.stringify(events)}`);
  }
  assertEqual(events.events[0].type, "actions_table.test", "event type");
  assertEqual(events.events[0].revision, resultingRevision, "event revision");

  assertSqliteScalar("PRAGMA integrity_check;", "ok", "final integrity_check");
  assertSqliteScalar("PRAGMA user_version;", "1", "final user_version");
  assertSqliteScalar("SELECT COUNT(*) FROM actions;", "1", "final action count");
  assertSqliteScalar("SELECT COUNT(*) FROM events;", "1", "final event count");
  assertSqliteScalar("SELECT status FROM actions WHERE action_id = 'b15d-action-001';", "completed", "action status");
  assertSqliteScalar("SELECT type FROM events ORDER BY revision;", "actions_table.test", "event type in sqlite");

  await stopServer(writeServer, "write");
  writeServer = null;
  await assertPortFree(TEST_PORT);

  console.log(`testDb: ${TEST_DB}`);
  console.log(`bootstrapLog: ${BOOTSTRAP_LOG}`);
  console.log(`writeLog: ${WRITE_LOG}`);
  console.log(`created: ok revision ${initialRevision} -> ${resultingRevision}`);
  console.log("replayed: ok");
  console.log("action_id_conflict: ok");
  console.log("revision_conflict: ok");
  console.log("sqlite: ok");
  console.log("result: PASS_B15D_ACTIONS_TABLE_REGRESSION");
}

function assertServerCwd(){
  if(path.resolve(process.cwd()) !== EXPECTED_CWD){
    throw new Error(`Must run from ${EXPECTED_CWD}; cwd=${process.cwd()}`);
  }
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
    cwd: EXPECTED_CWD,
    env,
    detached: false,
    stdio: ["ignore", output, output]
  });

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
  delete env.SDE_ENABLE_SCHEMA_MIGRATIONS;
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
  const response = await requestJson("GET", pathname);
  if(response.status < 200 || response.status >= 300){
    throw new Error(`GET ${pathname} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function postJson(pathname, body){
  return requestJson("POST", pathname, body);
}

function requestJson(method, pathname, body){
  if(TEST_PORT === 8787){
    throw new Error("Refusing HTTP request to production port 8787.");
  }

  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: TEST_HOST,
      port: TEST_PORT,
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

function assertBootstrapStatus(status){
  assertEqual(status.port, TEST_PORT, "bootstrap port");
  assertEqual(status.databaseFile, path.basename(TEST_DB), "bootstrap databaseFile");
  assertEqual(status.migrationsEnabled, true, "bootstrap migrationsEnabled");
  assertEqual(status.schemaUserVersion, 1, "bootstrap schemaUserVersion");
  assertEqual(status.actionsTablePresent, true, "bootstrap actionsTablePresent");
  assertEqual(status.actionsSchemaReady, true, "bootstrap actionsSchemaReady");
  assertEqual(status.migrationRequired, false, "bootstrap migrationRequired");
  assertEqual(status.actionsTableTestWritesEnabled, false, "bootstrap actionsTableTestWritesEnabled");
}

function assertWriteStatus(status){
  assertEqual(status.port, TEST_PORT, "write port");
  assertEqual(status.databaseFile, path.basename(TEST_DB), "write databaseFile");
  assertEqual(status.actionsTableTestWritesEnabled, true, "write actionsTableTestWritesEnabled");
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
  assertEqual(body.event?.type, "actions_table.test", "created event type");
}

function assertReplayedResponse(body, resultingRevision){
  assertEqual(body.ok, true, "replayed ok");
  assertEqual(body.mode, "replayed", "replayed mode");
  assertEqual(body.idempotent, true, "replayed idempotent");
  assertEqual(body.resultingRevision, resultingRevision, "replayed resultingRevision");
  assertEqual(body.event?.type, "actions_table.test", "replayed event type");
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
    console.error("FAIL_B15D_ACTIONS_TABLE_REGRESSION");
    console.error(error);
    if(bootstrapServer){
      await stopServer(bootstrapServer, "bootstrap").catch(stopError => console.error(stopError));
    }
    if(writeServer){
      await stopServer(writeServer, "write").catch(stopError => console.error(stopError));
    }
    console.error(`testDb: ${TEST_DB}`);
    console.error(`bootstrapLog: ${BOOTSTRAP_LOG}`);
    console.error(`writeLog: ${WRITE_LOG}`);
    process.exitCode = 1;
  });
