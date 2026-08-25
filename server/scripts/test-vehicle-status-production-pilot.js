#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  COMMAND_ROUTE,
  DEFAULT_PRODUCTION_VEHICLE_STATUS_DB,
  PRODUCTION_PILOT_SERVER_MODE,
  PRODUCTION_PILOT_WRITE_GATE_ENV,
  VEHICLE_STATUS_DATABASE_ENV,
  createReportNotOperationalHandler,
  getVehicleStatusProductionPilotWriteStatus,
  getVehicleStatusTestWriteStatus,
  normalizeReportNotOperationalPayload
} = require("../src/vehicleStatusReportNotOperational");
const {
  createVehicleStatusRepository
} = require("../src/vehicleStatusTestRepository");

const MAIN_PRODUCTION_DB =
  "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const FIXED_TIME = "2026-07-23T12:00:00.000Z";
const DROP_SUBJECT = "cf-access|drops-production-pilot";
const TEST_BINDINGS = Object.freeze({
  bindings: Object.freeze([
    Object.freeze({
      bindingId: "production-pilot-drops",
      subject: DROP_SUBJECT,
      role: ROLE_KEYS.DROPS,
      enabled: true
    }),
    Object.freeze({
      bindingId: "production-pilot-admin",
      subject: "cf-access|admin-production-pilot",
      role: ROLE_KEYS.ADMIN_PILOT,
      enabled: true
    })
  ])
});

const passed = [];
const temporaryPaths = new Set();

async function check(name, callback){
  await callback();
  passed.push(name);
}

async function main(){
  const productionBefore = snapshotFiles([
    MAIN_PRODUCTION_DB,
    `${MAIN_PRODUCTION_DB}-wal`,
    `${MAIN_PRODUCTION_DB}-shm`
  ]);

  await check("01 production-pilot constants are exact and separate", () => {
    assert.equal(PRODUCTION_PILOT_WRITE_GATE_ENV, "SDE_VEHICLE_STATUS_PRODUCTION_PILOT_WRITES_ENABLED");
    assert.equal(VEHICLE_STATUS_DATABASE_ENV, "SDE_VEHICLE_STATUS_DB_PATH");
    assert.equal(PRODUCTION_PILOT_SERVER_MODE, "vehicle-status-production-pilot");
    assert.equal(
      DEFAULT_PRODUCTION_VEHICLE_STATUS_DB,
      "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-vehicle-status.sqlite3"
    );
  });

  await check("02 production gate defaults off", () => {
    const status = productionStatus({});
    assert.equal(status.enabled, false);
    assert.equal(status.writesAllowed, false);
    assert.equal(status.commandAvailable, false);
  });

  await check("03 only literal true and 1 enable the production gate", () => {
    for(const value of ["true", "1"]){
      assert.equal(productionStatus(validEnvironment(value)).enabled, true);
    }
    for(const value of ["", "TRUE", " 1 ", "yes", "on", "enabled", "2", "false"]){
      assert.equal(productionStatus(validEnvironment(value)).enabled, false);
    }
  });

  await check("04 production gate cannot run without explicit pilot runtime", () => {
    const env = validEnvironment("true");
    env.SDE_SERVER_MODE = "server-groundwork";
    assertGuard(productionStatus(env), "vehicle_status_production_pilot_server_mode_required");
  });

  await check("05 production gate requires port 8787", () => {
    assertGuard(productionStatus(validEnvironment("true"), {
      port: 43111
    }), "vehicle_status_production_pilot_port_required");
  });

  await check("06 production gate requires an explicit vehicle-status database path", () => {
    const env = validEnvironment("true");
    delete env[VEHICLE_STATUS_DATABASE_ENV];
    assertGuard(productionStatus(env), "vehicle_status_production_pilot_database_required");
  });

  await check("07 arbitrary or temporary databases are rejected", () => {
    const env = validEnvironment("true");
    env[VEHICLE_STATUS_DATABASE_ENV] = tempDatabasePath("arbitrary");
    assertGuard(productionStatus(env), "vehicle_status_production_pilot_database_not_approved");
  });

  await check("08 operational main database is always rejected", () => {
    const env = validEnvironment("true");
    env[VEHICLE_STATUS_DATABASE_ENV] = MAIN_PRODUCTION_DB;
    assertGuard(productionStatus(env), "vehicle_status_production_pilot_main_database_forbidden");
  });

  await check("09 exact runtime, port and separate approved database open the command", () => {
    const status = productionStatus(validEnvironment("true"));
    assert.equal(status.persistenceReady, true);
    assert.equal(status.writesAllowed, true);
    assert.equal(status.commandAvailable, true);
    assert.equal(status.guardFailure, null);
  });

  await check("10 test gate alone cannot open production-pilot writes", () => {
    const status = productionStatus({
      SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED: "true",
      SDE_SERVER_MODE: "vehicle-status-test",
      SDE_SERVER_DB_PATH: tempDatabasePath("test-gate")
    });
    assert.equal(status.enabled, false);
    assert.equal(status.writesAllowed, false);
  });

  await check("11 production gate cannot open the isolated test-write path", () => {
    const databasePath = tempDatabasePath("production-gate");
    const status = getVehicleStatusTestWriteStatus({
      env: {
        [PRODUCTION_PILOT_WRITE_GATE_ENV]: "true",
        SDE_SERVER_MODE: PRODUCTION_PILOT_SERVER_MODE,
        SDE_SERVER_DB_PATH: databasePath
      },
      port: 43112,
      databasePath,
      productionDatabasePath: MAIN_PRODUCTION_DB
    });
    assert.equal(status.enabled, false);
    assert.equal(status.writesAllowed, false);
  });

  await check("12 production repository creates only isolated vehicle-status tables", async () => {
    await withFixture(async (fixture) => {
      assert.deepEqual(sqliteTables(fixture.databasePath), [
        "vehicle_status_cases",
        "vehicle_status_cleaning_track_space_requests",
        "vehicle_status_command_events",
        "vehicle_status_command_idempotency",
        "vehicle_status_command_meta",
        "vehicle_status_command_records",
        "vehicle_status_faults",
        "vehicle_status_operational_message_acknowledgements",
        "vehicle_status_operational_message_auto_dismissals",
        "vehicle_status_operational_message_events",
        "vehicle_status_operational_message_lifecycle_events",
        "vehicle_status_operational_messages",
        "vehicle_status_process_cases",
        "vehicle_status_process_events",
        "vehicle_status_process_observations",
        "vehicle_status_repair_requests",
        "vehicle_status_role_notifications",
        "vehicle_status_workshop_exit_events",
        "vehicle_status_workshop_exit_requests",
        "vehicle_status_workshop_ingress_queue",
        "vehicle_status_workshop_ingress_queue_events",
        "vehicle_status_workshop_ingress_queue_meta",
        "vehicle_status_workshop_message_events",
        "vehicle_status_workshop_messages"
      ]);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
      const readOnlyRepository = createVehicleStatusRepository({
        db: fixture.db,
        mode: "production-pilot",
        writeEnabled: false
      });
      const normalized = normalizeReportNotOperationalPayload(validPayload());
      assert.equal(normalized.ok, true);
      const outcome = readOnlyRepository.executeReportNotOperational(
        normalized.value,
        {
          subject: DROP_SUBJECT,
          identitySource: "cloudflare_access_jwt",
          roleBindingSource: "server_config"
        }
      );
      assert.equal(outcome.status, 404);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("13 unavailable command is stable 404 before identity evaluation", async () => {
    await withFixture(async (fixture) => {
      fixture.setAvailable(false);
      const response = await postCommand(fixture, validPayload(), "drops");
      assert.equal(response.status, 404);
      assert.equal(fixture.identityChecks(), 0);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("14 available command still requires verified identity", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), null);
      assertError(response, 401, "authentication_required");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("15 admin_pilot is denied and cannot mutate persistence", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), "admin");
      assertError(response, 403, "capability_forbidden");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("16 verified drops identity creates exactly one authoritative write", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), "drops");
      assert.equal(response.status, 201);
      assert.equal(response.json.vehicleId, "74-10");
      assert.equal(response.json.status, "IKKE_DRIFTSKLAR");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("17 GET readback survives a fresh repository instance", async () => {
    await withFixture(async (fixture) => {
      await postCommand(fixture, validPayload(), "drops");
      const reopened = createVehicleStatusRepository({
        db: fixture.db,
        mode: "production-pilot",
        writeEnabled: true
      });
      const readback = reopened.getReadModel();
      assert.equal(readback.revision, 1);
      assert.equal(readback.items.length, 1);
      assert.equal(readback.items[0].vehicleId, "74-10");
      assert.equal(readback.items[0].currentStatus, "IKKE_DRIFTSKLAR");
      assert.equal(readback.persistenceActive, true);
      assert.equal(readback.writeEnabled, true);
    });
  });

  await check("18 idempotent replay does not duplicate event or revision", async () => {
    await withFixture(async (fixture) => {
      const payload = validPayload();
      const first = await postCommand(fixture, payload, "drops");
      const replay = await postCommand(fixture, payload, "drops");
      assert.equal(first.status, 201);
      assert.equal(replay.status, 200);
      assert.equal(replay.json.idempotentReplay, true);
      assert.equal(replay.json.eventId, first.json.eventId);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("19 headers, query and body cannot spoof drops authority", async () => {
    await withFixture(async (fixture) => {
      const header = await request(
        fixture.port,
        "POST",
        `${COMMAND_ROUTE}?role=drops`,
        validPayload(),
        { Authorization: "Bearer admin", "X-Role": "drops", "X-Level": "1" }
      );
      assertError(header, 403, "capability_forbidden");
      const body = await postCommand(fixture, {
        ...validPayload(),
        role: "drops"
      }, "admin");
      assertError(body, 403, "capability_forbidden");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("20 disabling the gate again returns 404 without further write", async () => {
    await withFixture(async (fixture) => {
      await postCommand(fixture, validPayload(), "drops");
      fixture.setAvailable(false);
      const response = await postCommand(fixture, validPayload({
        actionId: crypto.randomUUID(),
        vehicleId: "74-11"
      }), "drops");
      assert.equal(response.status, 404);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("21 operational production database remains byte-identical", () => {
    assert.deepEqual(snapshotFiles([
      MAIN_PRODUCTION_DB,
      `${MAIN_PRODUCTION_DB}-wal`,
      `${MAIN_PRODUCTION_DB}-shm`
    ]), productionBefore);
  });

  console.log(`PASS ${passed.length}/${passed.length}`);
  for(const name of passed) console.log(`PASS ${name}`);
}

function validEnvironment(gate){
  return {
    [PRODUCTION_PILOT_WRITE_GATE_ENV]: gate,
    [VEHICLE_STATUS_DATABASE_ENV]: DEFAULT_PRODUCTION_VEHICLE_STATUS_DB,
    SDE_SERVER_MODE: PRODUCTION_PILOT_SERVER_MODE,
    SDE_SERVER_DB_PATH: MAIN_PRODUCTION_DB
  };
}

function productionStatus(env, overrides = {}){
  return getVehicleStatusProductionPilotWriteStatus({
    env,
    port: 8787,
    mainDatabasePath: MAIN_PRODUCTION_DB,
    vehicleStatusDatabasePath: env[VEHICLE_STATUS_DATABASE_ENV],
    approvedVehicleStatusDatabasePath: DEFAULT_PRODUCTION_VEHICLE_STATUS_DB,
    ...overrides
  });
}

function assertGuard(status, code){
  assert.equal(status.enabled, true);
  assert.equal(status.writesAllowed, false);
  assert.equal(status.commandAvailable, false);
  assert.equal(status.guardFailure?.error, code);
}

async function withFixture(callback){
  const databasePath = tempDatabasePath("repository");
  const db = new DatabaseSync(databasePath);
  const repository = createVehicleStatusRepository({
    db,
    mode: "production-pilot",
    writeEnabled: true,
    now: () => FIXED_TIME
  });
  let available = true;
  let identityChecks = 0;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(COMMAND_ROUTE, createReportNotOperationalHandler({
    repository,
    isCommandAvailable: () => available,
    roleBindingsCatalog: TEST_BINDINGS,
    verifyIdentityRequest: async ({ headers }) => {
      identityChecks += 1;
      const token = String(headers.authorization || "").replace(/^Bearer\s+/, "");
      if(!token) return { ok: false, status: 401, publicError: "authentication_required" };
      return {
        ok: true,
        identity: {
          authenticated: true,
          identityVerified: true,
          identityKind: "human",
          subject: token === "drops" ? DROP_SUBJECT : "cf-access|admin-production-pilot",
          identitySource: "cloudflare_access_jwt",
          email: `${token}@example.test`
        }
      };
    }
  }));
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const fixture = {
    databasePath,
    db,
    repository,
    port: server.address().port,
    setAvailable(value){ available = value; },
    identityChecks(){ return identityChecks; }
  };
  try{
    await callback(fixture);
  }finally{
    await new Promise((resolve) => server.close(resolve));
    db.close();
    cleanupSqlite(databasePath);
  }
}

function validPayload(overrides = {}){
  return {
    actionId: crypto.randomUUID(),
    expectedRevision: 0,
    vehicleId: "74-10",
    faults: [{ priority: 1, category: "A1", description: "Produksjonspilot-test" }],
    ...overrides
  };
}

function postCommand(fixture, body, token){
  return request(
    fixture.port,
    "POST",
    COMMAND_ROUTE,
    body,
    token ? { Authorization: `Bearer ${token}` } : {}
  );
}

function request(port, method, route, body, headers = {}){
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      headers: {
        ...(raw ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) } : {}),
        ...headers
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let json = null;
        try{ json = data ? JSON.parse(data) : null; }catch(_error){ /* asserted by callers */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on("error", reject);
    if(raw) req.write(raw);
    req.end();
  });
}

function assertError(response, status, error){
  assert.equal(response.status, status);
  assert.equal(response.json?.ok, false);
  assert.equal(response.json?.error, error);
}

function emptyCounts(){
  return {
    records: 0,
    events: 0,
    idempotency: 0,
    cases: 0,
    faults: 0,
    repairRequests: 0,
    notifications: 0,
    processCases: 0,
    processEvents: 0,
    processObservations: 0,
    workshopExitRequests: 0,
    workshopExitEvents: 0,
    operationalMessages: 0,
    operationalMessageEvents: 0,
    operationalMessageAcknowledgements: 0,
    operationalMessageAutoDismissals: 0,
    operationalMessageLifecycleEvents: 0,
    cleaningTrackSpaceRequests: 0
  };
}

function legacyCounts(faults){
  return {
    records: 1,
    events: 1,
    idempotency: 1,
    cases: 1,
    faults,
    repairRequests: 0,
    notifications: 0,
    processCases: 1,
    processEvents: 1,
    processObservations: 0,
    workshopExitRequests: 0,
    workshopExitEvents: 0,
    operationalMessages: 0,
    operationalMessageEvents: 0,
    operationalMessageAcknowledgements: 0,
    operationalMessageAutoDismissals: 0,
    operationalMessageLifecycleEvents: 0,
    cleaningTrackSpaceRequests: 0
  };
}

function tempDatabasePath(label){
  const value = path.join(
    os.tmpdir(),
    `sde-drops-1f-${label}-${process.pid}-${crypto.randomUUID()}.sqlite3`
  );
  temporaryPaths.add(value);
  return value;
}

function sqliteTables(databasePath){
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try{
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
  }finally{
    db.close();
  }
}

function snapshotFiles(paths){
  return paths.map((filePath) => {
    if(!fs.existsSync(filePath)) return { filePath, exists: false };
    const stat = fs.statSync(filePath);
    return {
      filePath,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
    };
  });
}

function cleanupSqlite(databasePath){
  for(const suffix of ["", "-wal", "-shm"]){
    try{ fs.unlinkSync(`${databasePath}${suffix}`); }catch(_error){ /* absent */ }
  }
}

process.on("exit", () => {
  for(const value of temporaryPaths) cleanupSqlite(value);
});

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
