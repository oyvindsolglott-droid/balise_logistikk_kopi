#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  COMMAND_NAME,
  COMMAND_ROUTE,
  COMMAND_SCHEMA_VERSION,
  MAX_FAULT_DESCRIPTION_LENGTH,
  createReportNotOperationalHandler,
  createVehicleStatusJsonErrorHandler,
  getVehicleStatusTestWriteStatus,
  normalizeReportNotOperationalPayload
} = require("../src/vehicleStatusReportNotOperational");
const {
  VEHICLE_REGISTRY,
  VEHICLE_REGISTRY_SIZE,
  isRegisteredVehicle
} = require("../src/vehicleRegistry");
const {
  createVehicleStatusTestRepository
} = require("../src/vehicleStatusTestRepository");

const SERVER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const INDEX_FILE = path.join(SERVER_DIR, "src", "index.js");
const FRONTEND_FILE = path.join(REPO_ROOT, "index.html");
const PRODUCTION_DB = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const TEST_HOST = "127.0.0.1";
const FIXED_TIME = "2026-07-22T10:11:12.345Z";
const FIXED_SUBJECT = "cf-access|drops-operator";
const TEST_CATALOG = Object.freeze({
  bindings: Object.freeze(Object.entries({
    drops: ROLE_KEYS.DROPS,
    admin: ROLE_KEYS.ADMIN_PILOT,
    verksted: ROLE_KEYS.VERKSTED,
    txp: ROLE_KEYS.TXP,
    agila: ROLE_KEYS.AGILA,
    sde: ROLE_KEYS.SDE_SKIFTERE
  }).map(([key, role]) => Object.freeze({
    bindingId: `test-${key}`,
    subject: `cf-access|${key}-operator`,
    role,
    enabled: true
  })))
});

const passed = [];
const tempPaths = new Set();
const childProcesses = new Set();

async function check(name, callback){
  await callback();
  passed.push(name);
}

async function main(){
  const frontendBefore = sha256File(FRONTEND_FILE);
  const productionBefore = snapshotFiles([
    PRODUCTION_DB,
    `${PRODUCTION_DB}-wal`,
    `${PRODUCTION_DB}-shm`
  ]);

  await check("01 command contract is locked", () => {
    assert.equal(COMMAND_ROUTE, "/api/vehicle-status/commands/report-not-operational");
    assert.equal(COMMAND_NAME, "report_not_operational");
    assert.equal(COMMAND_SCHEMA_VERSION, "vehicle-status-command-v1");
    assert.equal(MAX_FAULT_DESCRIPTION_LENGTH, 500);
  });

  await check("02 authoritative registry has exact 176 identities", () => {
    assert.equal(VEHICLE_REGISTRY_SIZE, 176);
    assert.deepEqual(Object.keys(VEHICLE_REGISTRY), ["69", "70", "74", "75"]);
    assert.deepEqual(Object.fromEntries(
      Object.entries(VEHICLE_REGISTRY).map(([series, values]) => [series, values.length])
    ), { "69": 32, "70": 8, "74": 53, "75": 83 });
    assert.equal(isRegisteredVehicle("74-10"), true);
    assert.equal(isRegisteredVehicle("74-05"), false);
  });

  await check("03 gate off is fail-closed and does not initialize command schema", async () => {
    const instance = await startIndexServer({ gate: false });
    try{
      const response = await request(instance.port, "POST", COMMAND_ROUTE, validPayload());
      assert.equal(response.status, 404);
      const tables = sqliteTables(instance.databasePath);
      assert.equal(tables.some((name) => name.startsWith("vehicle_status_command_")), false);
    }finally{
      await stopIndexServer(instance);
    }
  });

  await check("04 gate alone is rejected without explicit isolated database", async () => {
    const result = await runRejectedIndexServer({ gate: true, databasePath: null });
    assert.match(result.output, /vehicle status test write startup blocked/i);
    assert.match(result.output, /explicit.*database/i);
  });

  await check("05 production database path is rejected before open", async () => {
    const result = await runRejectedIndexServer({ gate: true, databasePath: PRODUCTION_DB });
    assert.match(result.output, /production database/i);
  });

  await check("06 production data directory is rejected", async () => {
    const forbidden = path.join(SERVER_DIR, "data", `forbidden-${process.pid}.sqlite3`);
    const result = await runRejectedIndexServer({ gate: true, databasePath: forbidden });
    assert.match(result.output, /production data directory/i);
    assert.equal(fs.existsSync(forbidden), false);
  });

  await check("07 production port 8787 is rejected", async () => {
    const databasePath = tempDatabasePath("port-guard");
    const result = await runRejectedIndexServer({
      gate: true,
      databasePath,
      port: 8787
    });
    assert.match(result.output, /port 8787/i);
    assert.equal(fs.existsSync(databasePath), false);
  });

  await check("08 gate status requires explicit flag, non-production port and temp DB", () => {
    const allowed = getVehicleStatusTestWriteStatus({
      env: {
        SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED: "true",
        SDE_SERVER_DB_PATH: "/private/tmp/sde-vehicle-status-allowed.sqlite3"
      },
      port: 43123,
      databasePath: "/private/tmp/sde-vehicle-status-allowed.sqlite3",
      productionDatabasePath: PRODUCTION_DB,
      productionDataDirectories: [path.join(SERVER_DIR, "data")]
    });
    assert.equal(allowed.enabled, true);
    assert.equal(allowed.writesAllowed, true);
    assert.equal(allowed.guardFailure, null);
  });

  await check("09 isolated actual server starts and unauthenticated command is 401", async () => {
    const instance = await startIndexServer({ gate: true });
    try{
      const status = await request(instance.port, "GET", "/api/server/status");
      assert.equal(status.status, 200);
      assert.equal(status.json.vehicleStatusTestWritesEnabled, true);
      assert.equal(status.json.vehicleStatusTestWritesAllowed, true);
      const command = await request(instance.port, "POST", COMMAND_ROUTE, validPayload());
      assert.equal(command.status, 401);
      assert.equal(command.json.error, "authentication_required");
      const readback = await request(instance.port, "GET", "/api/vehicle-status");
      assert.equal(readback.status, 200);
      assert.equal(readback.json.revision, 0);
      assert.deepEqual(readback.json.items, []);
    }finally{
      await stopIndexServer(instance);
    }
  });

  await check("10 no verified identity gives stable 401", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), null);
      assertError(response, 401, "authentication_required");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("11 drops role with capability is allowed", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), "drops");
      assert.equal(response.status, 201);
      assert.equal(response.json.vehicleId, "74-10");
    });
  });

  for(const [number, token, role] of [
    [12, "admin", "admin_pilot"],
    [13, "verksted", "verksted"],
    [14, "txp", "txp"],
    [15, "agila", "agila"],
    [16, "sde", "sde_skiftere"]
  ]){
    await check(`${number} ${role} is denied`, async () => {
      await withFixture(async (fixture) => {
        const response = await postCommand(fixture, validPayload(), token);
        assertError(response, 403, "capability_forbidden");
        assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
      });
    });
  }

  await check("17 unresolved role is denied", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload(), "unbound");
      assertError(response, 403, "role_binding_required");
    });
  });

  await check("18 spoofed role header, query and body cannot grant authority", async () => {
    await withFixture(async (fixture) => {
      const queryResponse = await request(
        fixture.port,
        "POST",
        `${COMMAND_ROUTE}?role=drops&frontendLevel=1`,
        validPayload(),
        { Authorization: "Bearer admin", "X-Role": "drops", "X-Level": "1" }
      );
      assertError(queryResponse, 403, "capability_forbidden");
      const forbidden = await postCommand(fixture, {
        ...validPayload(),
        actor: "spoof",
        subject: FIXED_SUBJECT,
        email: "spoof@example.com",
        role: "drops"
      }, "drops");
      assertError(forbidden, 400, "forbidden_request_field");
    });
  });

  await check("19 malformed JSON returns stable 400", async () => {
    await withFixture(async (fixture) => {
      const response = await rawRequest(
        fixture.port,
        "POST",
        COMMAND_ROUTE,
        "{not-json",
        { Authorization: "Bearer drops", "Content-Type": "application/json" }
      );
      assertError(response, 400, "malformed_json");
    });
  });

  for(const [number, label, mutate, code] of [
    [20, "invalid actionId", (body) => { body.actionId = "not-a-uuid"; }, "invalid_action_id"],
    [21, "invalid expectedRevision", (body) => { body.expectedRevision = -1; }, "invalid_expected_revision"],
    [22, "six faults", (body) => { body.faults = makeFaults(6); }, "too_many_faults"],
    [23, "invalid priority", (body) => { body.faults = [{ priority: 0, category: "A1", description: "Feil" }]; }, "invalid_fault_priority"],
    [24, "duplicate priority", (body) => { body.faults = [{ priority: 1, category: "A1", description: "Feil" }, { priority: 1, category: "A2", description: "Feil" }]; }, "duplicate_fault_priority"],
    [25, "priority gap", (body) => { body.faults = [{ priority: 1, category: "A1", description: "Feil" }, { priority: 3, category: "A2", description: "Feil" }]; }, "non_contiguous_fault_priority"],
    [26, "invalid category", (body) => { body.faults = [{ priority: 1, category: "A7", description: "Feil" }]; }, "invalid_fault_category"],
    [27, "empty description", (body) => { body.faults = [{ priority: 1, category: "A1", description: "   " }]; }, "invalid_fault_description"],
    [28, "overlong description", (body) => { body.faults = [{ priority: 1, category: "A1", description: "x".repeat(MAX_FAULT_DESCRIPTION_LENGTH + 1) }]; }, "fault_description_too_long"],
    [29, "control character", (body) => { body.faults = [{ priority: 1, category: "A1", description: "Feil\u0000tekst" }]; }, "invalid_fault_description"],
    [30, "half-filled fault", (body) => { body.faults = [{ priority: 1, category: "A1" }]; }, "invalid_fault_description"],
    [31, "unknown request field", (body) => { body.clientRole = "drops"; }, "forbidden_request_field"]
  ]){
    await check(`${number} ${label} is rejected without write`, async () => {
      await withFixture(async (fixture) => {
        const body = validPayload();
        mutate(body);
        const response = await postCommand(fixture, body, "drops");
        assertError(response, 400, code);
        assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
      });
    });
  }

  await check("32 unknown vehicle is rejected with 404", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload({ vehicleId: "74-05" }), "drops");
      assertError(response, 404, "vehicle_not_found");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("33 representative registered series normalize and validate", () => {
    for(const vehicleId of [" 69-38 ", "70-14", "74-10", "75-83"]){
      const result = normalizeReportNotOperationalPayload(validPayload({ vehicleId }));
      assert.equal(result.ok, true);
      assert.equal(isRegisteredVehicle(result.value.vehicleId), true);
    }
  });

  await check("34 first command creates authoritative revision-one result", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload({
        faults: [{ priority: 1, category: "A2", description: "  Kort feil  " }]
      }), "drops");
      assert.equal(response.status, 201);
      assert.deepEqual(response.json, {
        schemaVersion: COMMAND_SCHEMA_VERSION,
        command: COMMAND_NAME,
        actionId: response.json.actionId,
        vehicleId: "74-10",
        status: "IKKE_DRIFTSKLAR",
        disposition: "NONE",
        revision: 1,
        registeredAt: FIXED_TIME,
        faults: [{
          stableFaultId: response.json.faults[0].stableFaultId,
          priority: 1,
          category: "A2",
          description: "Kort feil",
          createdAt: FIXED_TIME,
          createdBy: FIXED_SUBJECT,
          resolvedAt: null,
          resolvedBy: null,
          resolutionDescription: null
        }],
        eventId: response.json.eventId,
        idempotentReplay: false
      });
      assert.match(response.json.eventId, /^[0-9a-f-]{36}$/);
      assert.notEqual(response.json.registeredAt, validPayload().registeredAt);
    });
  });

  await check("35 zero authoritative faults is rejected without write", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload({ vehicleId: "69-38", faults: [] }), "drops");
      assertError(response, 409, "active_fault_required");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("36 exactly five sorted A1-A6 faults are accepted", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload({
        vehicleId: "75-83",
        faults: makeFaults(5).reverse()
      }), "drops");
      assert.equal(response.status, 201);
      assert.deepEqual(response.json.faults.map((fault) => fault.priority), [1, 2, 3, 4, 5]);
      assert.deepEqual(response.json.faults.map((fault) => fault.category), ["A1", "A2", "A3", "A4", "A5"]);
    });
  });

  await check("37 server verified actor and authority provenance are persisted", async () => {
    await withFixture(async (fixture) => {
      const body = validPayload({ vehicleId: "70-14" });
      const response = await postCommand(fixture, body, "drops");
      const snapshot = fixture.repository.getStorageSnapshot();
      assert.equal(response.status, 201);
      assert.equal(snapshot.records[0].last_actor, FIXED_SUBJECT);
      assert.equal(snapshot.events[0].actor_subject, FIXED_SUBJECT);
      assert.equal(snapshot.events[0].identity_source, "cloudflare_access_jwt");
      assert.equal(snapshot.events[0].role_binding_source, "server_config");
      assert.equal(snapshot.events[0].command_type, COMMAND_NAME);
    });
  });

  await check("38 immutable event rejects update and delete", async () => {
    await withFixture(async (fixture) => {
      await postCommand(fixture, validPayload(), "drops");
      assert.throws(() => fixture.db.prepare(
        "UPDATE vehicle_status_command_events SET actor_subject = ?"
      ).run("tampered"), /immutable/i);
      assert.throws(() => fixture.db.prepare(
        "DELETE FROM vehicle_status_command_events"
      ).run(), /immutable/i);
    });
  });

  await check("39 idempotent replay returns same event and revision", async () => {
    await withFixture(async (fixture) => {
      const body = validPayload({
        faults: [
          { description: "Andre", category: "A2", priority: 2 },
          { category: "A1", priority: 1, description: "Første" }
        ]
      });
      const first = await postCommand(fixture, body, "drops");
      const replay = await postCommand(fixture, {
        vehicleId: "74-10",
        faults: [
          { priority: 1, description: "Første", category: "A1" },
          { category: "A2", description: "Andre", priority: 2 }
        ],
        expectedRevision: 0,
        actionId: body.actionId
      }, "drops");
      assert.equal(first.status, 201);
      assert.equal(replay.status, 200);
      assert.equal(replay.json.idempotentReplay, true);
      assert.equal(replay.json.eventId, first.json.eventId);
      assert.equal(replay.json.revision, 1);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(2));
    });
  });

  await check("40 actionId with changed payload is a no-write conflict", async () => {
    await withFixture(async (fixture) => {
      const body = validPayload();
      await postCommand(fixture, body, "drops");
      const conflict = await postCommand(fixture, { ...body, vehicleId: "74-11" }, "drops");
      assertError(conflict, 409, "action_id_payload_conflict");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("41 revision mismatch exposes currentRevision and writes nothing", async () => {
    await withFixture(async (fixture) => {
      const response = await postCommand(fixture, validPayload({ expectedRevision: 1 }), "drops");
      assertError(response, 409, "revision_mismatch");
      assert.equal(response.json.currentRevision, 0);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("42 new action against already not operational vehicle is rejected", async () => {
    await withFixture(async (fixture) => {
      await postCommand(fixture, validPayload(), "drops");
      const response = await postCommand(fixture, validPayload({
        actionId: crypto.randomUUID(),
        expectedRevision: 1
      }), "drops");
      assertError(response, 409, "status_already_not_operational");
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("43 injected transaction failure rolls back record event and idempotency", async () => {
    await withFixture(async (fixture) => {
      fixture.repository.setFailureInjector((stage) => {
        if(stage === "before_commit") throw new Error("controlled repository failure");
      });
      const response = await postCommand(fixture, validPayload(), "drops");
      assertError(response, 500, "vehicle_status_command_failed");
      assert.equal(Object.hasOwn(response.json, "stack"), false);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, emptyCounts());
    });
  });

  await check("44 competing commands cannot both win", async () => {
    await withFixture(async (fixture) => {
      const [first, second] = await Promise.all([
        postCommand(fixture, validPayload({ actionId: crypto.randomUUID() }), "drops"),
        postCommand(fixture, validPayload({ actionId: crypto.randomUUID() }), "drops")
      ]);
      assert.deepEqual([first.status, second.status].sort(), [201, 409]);
      assert.deepEqual(fixture.repository.getStorageSnapshot().counts, legacyCounts(1));
    });
  });

  await check("45 GET readback exposes one authoritative projection and event", async () => {
    await withFixture(async (fixture) => {
      const command = await postCommand(fixture, validPayload({
        faults: [{ priority: 1, category: "A6", description: "Diagnose" }]
      }), "drops");
      const readback = await request(fixture.port, "GET", "/api/vehicle-status");
      assert.equal(readback.status, 200);
      assert.equal(readback.json.revision, 1);
      assert.equal(readback.json.items.length, 1);
      assert.equal(readback.json.items[0].vehicleId, "74-10");
      assert.equal(readback.json.items[0].currentStatus, "IKKE_DRIFTSKLAR");
      assert.equal(readback.json.items[0].workshopDisposition, "NONE");
      assert.equal(readback.json.items[0].statusRevision, 1);
      assert.equal(readback.json.items[0].registeredAt, FIXED_TIME);
      assert.equal(readback.json.items[0].registeredBy, FIXED_SUBJECT);
      assert.equal(readback.json.items[0].activeFaults[0].category, "A6");
      assert.equal(readback.json.events.length, 1);
      assert.equal(readback.json.events[0].eventId, command.json.eventId);
      assert.equal(readback.json.persistenceActive, true);
      assert.equal(readback.json.statusAuthorityActive, true);
      assert.equal(readback.json.writeEnabled, true);
      assert.equal(readback.json.operationalAuthority, false);
      assert.equal(readback.json.trustedRequestAuthority, null);
    });
  });

  await check("46 normal production readback remains revision-zero and read-only", async () => {
    const instance = await startIndexServer({ gate: false });
    try{
      const readback = await request(instance.port, "GET", "/api/vehicle-status");
      assert.equal(readback.status, 200);
      assert.equal(readback.json.revision, 0);
      assert.deepEqual(readback.json.items, []);
      assert.deepEqual(readback.json.events, []);
      assert.equal(readback.json.persistenceActive, false);
      assert.equal(readback.json.statusAuthorityActive, false);
      assert.equal(readback.json.writeEnabled, false);
      assert.equal(readback.json.operationalAuthority, false);
    }finally{
      await stopIndexServer(instance);
    }
  });

  await check("47 isolated repository contains no operational or shared-draft state", async () => {
    await withFixture(async (fixture) => {
      await postCommand(fixture, validPayload(), "drops");
      const tables = sqliteTables(fixture.databasePath);
      assert.deepEqual(tables, [
        "vehicle_status_command_events",
        "vehicle_status_command_idempotency",
        "vehicle_status_command_meta",
        "vehicle_status_command_records"
      ]);
    });
  });

  await check("48 frontend file is untouched by command tests", () => {
    assert.equal(sha256File(FRONTEND_FILE), frontendBefore);
  });

  await check("49 production database files are untouched", () => {
    assert.deepEqual(snapshotFiles([
      PRODUCTION_DB,
      `${PRODUCTION_DB}-wal`,
      `${PRODUCTION_DB}-shm`
    ]), productionBefore);
  });

  await check("50 deterministic normalized payload hash ignores object and fault order", () => {
    const actionId = crypto.randomUUID();
    const left = normalizeReportNotOperationalPayload({
      actionId,
      expectedRevision: 0,
      vehicleId: " 74-10 ",
      faults: [
        { priority: 2, category: "A2", description: " To " },
        { priority: 1, category: "A1", description: " En " }
      ]
    });
    const right = normalizeReportNotOperationalPayload({
      faults: [
        { description: "En", category: "A1", priority: 1 },
        { category: "A2", priority: 2, description: "To" }
      ],
      vehicleId: "74-10",
      expectedRevision: 0,
      actionId
    });
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(left.value.payloadHash, right.value.payloadHash);
  });

  console.log(`PASS ${passed.length}/${passed.length}`);
  for(const name of passed) console.log(`PASS ${name}`);
}

function validPayload(overrides = {}){
  return {
    actionId: crypto.randomUUID(),
    expectedRevision: 0,
    vehicleId: "74-10",
    faults: [{ priority: 1, category: "A1", description: "Kort og konkret feil" }],
    ...overrides
  };
}

function makeFaults(count){
  return Array.from({ length: count }, (_unused, index) => ({
    priority: index + 1,
    category: `A${(index % 6) + 1}`,
    description: `Feil ${index + 1}`
  }));
}

async function withFixture(callback){
  const databasePath = tempDatabasePath("fixture");
  const db = new DatabaseSync(databasePath);
  let failureInjector = null;
  const repository = createVehicleStatusTestRepository({
    db,
    now: () => FIXED_TIME,
    randomUUID: () => crypto.randomUUID(),
    failureInjector: (stage) => failureInjector?.(stage)
  });
  repository.setFailureInjector = (next) => { failureInjector = next; };
  const app = createTestApp(repository);
  const server = http.createServer(app);
  const port = await listen(server);
  const fixture = { app, server, port, db, databasePath, repository };
  try{
    await callback(fixture);
  }finally{
    await closeHttpServer(server);
    db.close();
    cleanupSqlite(databasePath);
  }
}

function createTestApp(repository){
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(COMMAND_ROUTE, createReportNotOperationalHandler({
    repository,
    roleBindingsCatalog: TEST_CATALOG,
    verifyIdentityRequest: async ({ headers }) => {
      const raw = String(headers.authorization || "");
      const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
      if(!token){
        return { ok: false, status: 401, publicError: "authentication_required" };
      }
      const subjectToken = token === "unbound" ? "unbound" : token;
      return {
        ok: true,
        identity: {
          authenticated: true,
          identityVerified: true,
          identityKind: "human",
          subject: `cf-access|${subjectToken}-operator`,
          identitySource: "cloudflare_access_jwt",
          email: `${subjectToken}@example.test`
        }
      };
    }
  }));
  app.get("/api/vehicle-status", (_req, res) => {
    res.json({ ok: true, ...repository.getReadModel(), trustedRequestAuthority: null });
  });
  app.use(createVehicleStatusJsonErrorHandler());
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  return app;
}

async function postCommand(fixture, body, token){
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return request(fixture.port, "POST", COMMAND_ROUTE, body, headers);
}

function assertError(response, status, code){
  assert.equal(response.status, status);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, code);
  assert.equal(response.json.schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.equal(typeof response.json.message, "string");
  assert.equal(Object.hasOwn(response.json, "stack"), false);
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
    cleaningTrackSpaceRequests: 0
  };
}

async function startIndexServer(options = {}){
  const port = options.port || await getFreePort();
  const databasePath = Object.hasOwn(options, "databasePath")
    ? options.databasePath
    : tempDatabasePath(options.gate ? "index-gate-on" : "index-gate-off");
  if(databasePath) tempPaths.add(databasePath);
  const logPath = path.join(os.tmpdir(), `sde-drops-1d-${process.pid}-${crypto.randomUUID()}.log`);
  tempPaths.add(logPath);
  const log = fs.openSync(logPath, "w");
  const env = sanitizedServerEnv({
    PORT: String(port),
    SDE_SERVER_MODE: "vehicle-status-test",
    ...(databasePath ? { SDE_SERVER_DB_PATH: databasePath } : {}),
    ...(options.gate ? { SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED: "true" } : {})
  });
  const child = spawn(process.execPath, [INDEX_FILE], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", log, log]
  });
  fs.closeSync(log);
  childProcesses.add(child);
  try{
    await waitForHealth(port, child, logPath);
    return { child, port, databasePath, logPath };
  }catch(error){
    await terminateChild(child);
    throw error;
  }
}

async function runRejectedIndexServer(options){
  const port = options.port || await getFreePort();
  const logPath = path.join(os.tmpdir(), `sde-drops-1d-reject-${process.pid}-${crypto.randomUUID()}.log`);
  tempPaths.add(logPath);
  const log = fs.openSync(logPath, "w");
  const env = sanitizedServerEnv({
    PORT: String(port),
    SDE_SERVER_MODE: "vehicle-status-test",
    SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED: options.gate ? "true" : "",
    ...(options.databasePath ? { SDE_SERVER_DB_PATH: options.databasePath } : {})
  });
  const child = spawn(process.execPath, [INDEX_FILE], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", log, log]
  });
  childProcesses.add(child);
  fs.closeSync(log);
  const exit = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Rejected server did not exit.")), 5000))
  ]);
  childProcesses.delete(child);
  const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  assert.notEqual(exit.code, 0);
  return { ...exit, output };
}

function sanitizedServerEnv(overrides){
  const env = { ...process.env };
  for(const key of Object.keys(env)){
    if(key.startsWith("SDE_ENABLE_") || key === "SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED"){
      delete env[key];
    }
  }
  delete env.SDE_SERVER_DB_PATH;
  delete env.SDE_IDENTITY_ROLE_BINDINGS_PATH;
  return { ...env, ...overrides };
}

async function stopIndexServer(instance){
  await terminateChild(instance.child);
  cleanupSqlite(instance.databasePath);
  cleanupFile(instance.logPath);
}

async function terminateChild(child){
  if(!child || child.exitCode !== null){
    childProcesses.delete(child);
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if(child.exitCode === null) child.kill("SIGKILL");
  childProcesses.delete(child);
}

async function waitForHealth(port, child, logPath){
  const deadline = Date.now() + 8000;
  while(Date.now() < deadline){
    if(child.exitCode !== null){
      const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      throw new Error(`Server exited before health check: ${output}`);
    }
    try{
      const response = await request(port, "GET", "/api/health");
      if(response.status === 200 && response.json.ok === true) return;
    }catch(_error){
      // Retry until deadline.
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for isolated test server.");
}

async function listen(server){
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, TEST_HOST, resolve);
  });
  return port;
}

async function closeHttpServer(server){
  if(!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function getFreePort(){
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, TEST_HOST, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(port, method, requestPath, body, headers = {}){
  const payload = body === undefined ? null : JSON.stringify(body);
  return rawRequest(port, method, requestPath, payload, {
    ...(payload ? { "Content-Type": "application/json" } : {}),
    ...headers
  });
}

function rawRequest(port, method, requestPath, payload, headers = {}){
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: TEST_HOST,
      port,
      path: requestPath,
      method,
      headers: {
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = null;
        try{ json = raw ? JSON.parse(raw) : null; }catch(_error){ /* asserted by callers */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.once("error", reject);
    if(payload) req.write(payload);
    req.end();
  });
}

function sqliteTables(databasePath){
  if(!databasePath || !fs.existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try{
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'vehicle_status_command_%'
      ORDER BY name
    `).all().map((row) => row.name);
  }finally{
    db.close();
  }
}

function tempDatabasePath(label){
  const value = path.join(os.tmpdir(), `sde-drops-1d-${label}-${process.pid}-${crypto.randomUUID()}.sqlite3`);
  tempPaths.add(value);
  return value;
}

function cleanupSqlite(databasePath){
  if(!databasePath) return;
  for(const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]){
    cleanupFile(candidate);
  }
}

function cleanupFile(filePath){
  if(!filePath) return;
  try{ fs.rmSync(filePath, { force: true }); }catch(_error){ /* cleanup only */ }
  tempPaths.delete(filePath);
}

function sha256File(filePath){
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotFiles(filePaths){
  return Object.fromEntries(filePaths.map((filePath) => {
    if(!fs.existsSync(filePath)) return [filePath, null];
    const stat = fs.statSync(filePath);
    return [filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sha256File(filePath)
    }];
  }));
}

function delay(milliseconds){
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanup(){
  for(const child of [...childProcesses]) await terminateChild(child);
  for(const filePath of [...tempPaths]){
    if(filePath.endsWith(".sqlite3")) cleanupSqlite(filePath);
    else cleanupFile(filePath);
  }
}

main().catch(async (error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(cleanup);
