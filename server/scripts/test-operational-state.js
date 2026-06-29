#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const EXPECTED_REPO_CWD = "/Users/solglottsr/balise_logistikk_kopi";
const EXPECTED_SERVER_CWD = "/Users/solglottsr/balise_logistikk_kopi/server";
const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const TEST_HOST = "127.0.0.1";
const TEST_PORT = 8794;
const GUARD_TEST_PORT = 8795;
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const TEST_DB = `/tmp/sde-b37b-operational-state-${STAMP}.sqlite3`;
const DISABLED_LOG = `/tmp/sde-b37b-operational-state-disabled-${STAMP}.log`;
const WRITE_LOG = `/tmp/sde-b37b-operational-state-write-${STAMP}.log`;
const PORT_GUARD_LOG = `/tmp/sde-b37b-operational-state-port-guard-${STAMP}.log`;
const DB_GUARD_LOG = `/tmp/sde-b37b-operational-state-db-guard-${STAMP}.log`;
const DB_PATH_GUARD_LOG = `/tmp/sde-b37b-operational-state-db-path-guard-${STAMP}.log`;

let disabledServer = null;
let writeServer = null;

async function main(){
  normalizeServerCwd();
  assertSafeTestTarget(TEST_PORT, TEST_DB);
  await assertPortFree(TEST_PORT);
  await assertPortFree(GUARD_TEST_PORT);

  await assertProductionStatus("before");

  await assertOperationalStateStartupBlocked("production port guard", {
    PORT: "8787",
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_OPERATIONAL_STATE_WRITES: "1"
  }, "production port 8787", PORT_GUARD_LOG);

  await assertOperationalStateStartupBlocked("production database guard", {
    PORT: String(GUARD_TEST_PORT),
    SDE_SERVER_DB_PATH: PRODUCTION_DB_PATH,
    SDE_ENABLE_OPERATIONAL_STATE_WRITES: "1"
  }, "production database", DB_GUARD_LOG);

  await assertOperationalStateStartupBlocked("missing db path guard", {
    PORT: String(GUARD_TEST_PORT),
    SDE_ENABLE_OPERATIONAL_STATE_WRITES: "1"
  }, "temporary database", DB_PATH_GUARD_LOG);

  removeTestDatabaseFiles(TEST_DB);
  disabledServer = startServer("disabled", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB
  }, DISABLED_LOG);
  await waitForHealth(DISABLED_LOG);

  const disabledStatus = await getJson("/api/server/status");
  assertEqual(disabledStatus.operationalStateWritesEnabled, false, "disabled writes enabled");
  assertEqual(disabledStatus.operationalStateWritesAllowed, false, "disabled writes allowed");
  assertEqual(disabledStatus.operationalStateOperationalWritesAllowed, false, "disabled operational writes allowed");

  const disabledReadback = await getJson("/api/operational-state");
  assertEqual(disabledReadback.ok, true, "disabled readback ok");
  assertEqual(disabledReadback.readOnly, true, "disabled readback readOnly");
  assertEqual(disabledReadback.writesAllowed, false, "disabled readback writesAllowed");
  assertEqual(disabledReadback.operationalWritesAllowed, false, "disabled readback operationalWritesAllowed");

  const disabledPost = await postJson("/api/operational-state/snapshot", createSnapshot("b37b-disabled", 1));
  assertStatus(disabledPost, 403, "disabled post");
  assertEqual(disabledPost.body.error, "operational_state_writes_disabled", "disabled post error");

  await stopServer(disabledServer, "disabled");
  disabledServer = null;
  await assertPortFree(TEST_PORT);

  removeTestDatabaseFiles(TEST_DB);
  writeServer = startServer("write", {
    PORT: String(TEST_PORT),
    SDE_SERVER_DB_PATH: TEST_DB,
    SDE_ENABLE_OPERATIONAL_STATE_WRITES: "1"
  }, WRITE_LOG);
  await waitForHealth(WRITE_LOG);

  const writeStatus = await getJson("/api/server/status");
  assertEqual(writeStatus.operationalStateWritesEnabled, true, "write status writes enabled");
  assertEqual(writeStatus.operationalStateProductionWritesEnabled, false, "write status production writes enabled");
  assertEqual(writeStatus.operationalStateWritesAllowed, true, "write status writes allowed");
  assertEqual(writeStatus.operationalStateOperationalWritesAllowed, false, "write status operational writes allowed");
  assertEqual(writeStatus.operationalWritesEnabled, false, "write status production operational writes");
  assertEqual(writeStatus.pwaConnected, false, "write status pwa connected");

  const invalid = await postJson("/api/operational-state/snapshot", {
    serviceDate: "2026-06-29",
    idempotencyKey: "b37b-invalid"
  });
  assertStatus(invalid, 400, "invalid payload");

  const initialRevision = await getRevision();
  const snapshot = createSnapshot("b37b-snapshot-001", initialRevision);
  const created = await postJson("/api/operational-state/snapshot", snapshot);
  assertStatus(created, 201, "created snapshot");
  assertEqual(created.body.ok, true, "created ok");
  assertEqual(created.body.mode, "created", "created mode");
  assertEqual(created.body.idempotent, false, "created idempotent");
  assertEqual(created.body.previousRevision, initialRevision, "created previousRevision");
  assertEqual(created.body.resultingRevision, initialRevision + 1, "created resultingRevision");
  assertEqual(created.body.event.type, "operational_state.snapshot.test", "created event type");

  const readback = await getJson("/api/operational-state");
  assertEqual(readback.ok, true, "readback ok");
  assertEqual(readback.writesAllowed, true, "readback writesAllowed");
  assertEqual(readback.operationalWritesAllowed, false, "readback operationalWritesAllowed");
  assertEqual(readback.serverStateAuthority, false, "readback server authority");
  assertEqual(readback.operationalAuthority, false, "readback operational authority");
  assertEqual(
    readback.state.operationalStateReadback.lastSnapshot.idempotencyKey,
    snapshot.idempotencyKey,
    "readback idempotency key"
  );

  const replayed = await postJson("/api/operational-state/snapshot", snapshot);
  assertStatus(replayed, 200, "replayed snapshot");
  assertEqual(replayed.body.mode, "replayed", "replayed mode");
  assertEqual(replayed.body.idempotent, true, "replayed idempotent");
  assertEqual(replayed.body.resultingRevision, created.body.resultingRevision, "replayed revision");

  const conflict = await postJson("/api/operational-state/snapshot", {
    ...snapshot,
    stateSnapshot: {
      ...snapshot.stateSnapshot,
      changed: true
    }
  });
  assertStatus(conflict, 409, "idempotency conflict");
  assertEqual(conflict.body.error, "idempotency_key_conflict", "idempotency conflict error");

  const events = await getJson("/api/operational-state/events");
  if(!Array.isArray(events.events) || events.events.length !== 1){
    throw new Error(`Expected exactly one operational-state event, got ${JSON.stringify(events)}`);
  }
  assertEqual(events.events[0].type, "operational_state.snapshot.test", "operational-state event type");
  assertEqual(events.events[0].revision, created.body.resultingRevision, "operational-state event revision");

  await stopServer(writeServer, "write");
  writeServer = null;
  await assertPortFree(TEST_PORT);

  await assertProductionStatus("after");

  console.log(`testDb: ${TEST_DB}`);
  console.log(`disabledLog: ${DISABLED_LOG}`);
  console.log(`writeLog: ${WRITE_LOG}`);
  console.log(`portGuardLog: ${PORT_GUARD_LOG}`);
  console.log(`dbGuardLog: ${DB_GUARD_LOG}`);
  console.log(`dbPathGuardLog: ${DB_PATH_GUARD_LOG}`);
  console.log("startupGuards: ok");
  console.log("disabledPost: 403 ok");
  console.log("invalidPayload: 400 ok");
  console.log(`created: 201 ok revision ${initialRevision} -> ${created.body.resultingRevision}`);
  console.log("replayed: 200 idempotent ok");
  console.log("idempotencyConflict: 409 ok");
  console.log("readback: ok");
  console.log("productionGetOnlyStatus: ok");
  console.log("result: PASS_B37B_OPERATIONAL_STATE_TEST_ONLY");
}

function createSnapshot(idempotencyKey, expectedServerRevision){
  return {
    serviceDate: "2026-06-29",
    idempotencyKey,
    actor: {
      id: "b37b-test-actor",
      role: "test"
    },
    device: {
      id: "b37b-test-device",
      label: "B37-B test device"
    },
    stateScope: [
      "sde.nattplassering",
      "sde.skiftebevegelser"
    ],
    stateSnapshot: {
      manualNightPlacements: [
        {
          vehicleId: "test-2470",
          slotId: "test-slot-1"
        }
      ],
      readbackOnly: true
    },
    expectedServerRevision,
    clientRevision: "b37b-test-client",
    clientContext: {
      source: "server/scripts/test-operational-state.js"
    }
  };
}

async function assertProductionStatus(label){
  const status = await getJson("http://127.0.0.1:8787/api/server/status");
  assertEqual(status.ok, true, `production status ${label} ok`);
  assertEqual(status.port, 8787, `production status ${label} port`);
  assertEqual(status.pwaConnected, false, `production status ${label} pwa connected`);
  assertEqual(status.operationalWritesEnabled, false, `production status ${label} operational writes enabled`);
  assertFalseOrAbsent(status.operationalStateWritesEnabled, `production status ${label} operational state writes enabled`);
  assertFalseOrAbsent(status.operationalStateWritesAllowed, `production status ${label} operational state writes allowed`);
  assertFalseOrAbsent(
    status.operationalStateOperationalWritesAllowed,
    `production status ${label} operational state operational writes allowed`
  );
  assertEqual(status.migrationsEnabled, false, `production status ${label} migrations enabled`);
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

  child.expectedExit = false;
  child.once("exit", (code, signal) => {
    if(child.expectedExit) return;
    console.error(`${label} server exited unexpectedly: code=${code} signal=${signal}`);
    console.error(readTail(logPath));
  });

  child.label = label;
  child.logPath = logPath;
  console.log(`${label}Pid: ${child.pid}`);
  return child;
}

function createServerEnv(envOverrides){
  const env = { ...process.env };
  for(const key of [
    "SDE_ENABLE_TEST_WRITES",
    "SDE_ENABLE_ACTION_CONTRACT_TESTS",
    "SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES",
    "SDE_ENABLE_SCHEMA_MIGRATIONS",
    "SDE_ENABLE_SERVER_NOTE_ACTIONS",
    "SDE_ENABLE_SERVER_NOTE_PRODUCTION_ACTIONS",
    "SDE_ENABLE_SDE_RECOMMENDATION_ACK_ACTIONS",
    "SDE_ENABLE_SDE_RECOMMENDATION_ACK_PRODUCTION_ACTIONS",
    "SDE_ENABLE_OPERATIONAL_STATE_WRITES",
    "SDE_ENABLE_OPERATIONAL_STATE_PRODUCTION_WRITES"
  ]){
    delete env[key];
  }

  return {
    ...env,
    ...envOverrides
  };
}

async function assertOperationalStateStartupBlocked(label, envOverrides, expectedText, logPath){
  const child = startServer(label, envOverrides, logPath);
  child.expectedExit = true;
  const exit = await waitForProcessExit(child, 4000);
  if(exit === null){
    child.kill("SIGTERM");
    throw new Error(`${label} did not exit`);
  }

  const output = readTail(logPath);
  if(!output.includes("operational state startup blocked") || !output.includes(expectedText)){
    throw new Error(`${label} did not produce expected guard output. Output:\n${output}`);
  }
}

function waitForProcessExit(child, timeoutMs){
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if(done) return;
      done = true;
      resolve(null);
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      if(done) return;
      done = true;
      clearTimeout(timer);
      child.expectedExit = true;
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(logPath){
  const deadline = Date.now() + 5000;
  let lastError = null;
  while(Date.now() < deadline){
    try{
      const health = await getJson("/api/health");
      if(health.ok === true) return health;
    }catch(error){
      lastError = error;
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for health. Last error: ${lastError?.message || "unknown"}\n${readTail(logPath)}`);
}

async function getRevision(){
  const body = await getJson("/api/state/revision");
  return Number(body.revision);
}

function getJson(pathOrUrl){
  return requestJson("GET", pathOrUrl);
}

function postJson(pathOrUrl, body){
  return requestJson("POST", pathOrUrl, body);
}

function requestJson(method, pathOrUrl, body){
  const url = pathOrUrl.startsWith("http://")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, `http://${TEST_HOST}:${TEST_PORT}`);

  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      timeout: 5000,
      headers: payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        : {}
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try{
          parsed = raw ? JSON.parse(raw) : null;
        }catch(error){
          reject(new Error(`Invalid JSON from ${method} ${url.href}: ${error.message}; raw=${raw}`));
          return;
        }

        if(method === "GET" && res.statusCode >= 400){
          reject(new Error(`GET ${url.href} failed with ${res.statusCode}: ${raw}`));
          return;
        }

        if(method === "POST"){
          resolve({
            status: res.statusCode,
            body: parsed
          });
          return;
        }

        resolve(parsed);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timed out ${method} ${url.href}`));
    });
    req.on("error", reject);
    if(payload) req.write(payload);
    req.end();
  });
}

function stopServer(child, label){
  if(!child) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out stopping ${label}`));
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    child.expectedExit = true;
    child.kill("SIGTERM");
  });
}

function assertPortFree(port){
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`Port ${port} is not free: ${error.message}`));
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, TEST_HOST);
  });
}

function assertStatus(response, expected, label){
  if(response.status !== expected){
    throw new Error(`${label}: expected HTTP ${expected}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
}

function assertEqual(actual, expected, label){
  if(actual !== expected){
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertFalseOrAbsent(actual, label){
  if(actual !== undefined && actual !== false){
    throw new Error(`${label}: expected false or absent, got ${JSON.stringify(actual)}`);
  }
}

function readTail(filePath){
  try{
    const value = fs.readFileSync(filePath, "utf8");
    return value.split("\n").slice(-80).join("\n");
  }catch(error){
    return `<unable to read ${filePath}: ${error.message}>`;
  }
}

function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("exit", () => {
  if(disabledServer && !disabledServer.killed) disabledServer.kill("SIGTERM");
  if(writeServer && !writeServer.killed) writeServer.kill("SIGTERM");
});

main().catch(async (error) => {
  if(disabledServer) await stopServer(disabledServer, "disabled").catch(() => {});
  if(writeServer) await stopServer(writeServer, "write").catch(() => {});
  console.error(error);
  process.exit(1);
});
