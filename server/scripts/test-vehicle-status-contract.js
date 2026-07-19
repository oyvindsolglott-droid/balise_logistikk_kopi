#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER_DIR = path.resolve(__dirname, "..");
const CONTRACT_FILE = path.join(SERVER_DIR, "src", "vehicleStatusContract.js");
const READ_MODEL_FILE = path.join(SERVER_DIR, "src", "vehicleStatusReadModel.js");
const INDEX_FILE = path.join(SERVER_DIR, "src", "index.js");
const TEST_HOST = "127.0.0.1";
const TEST_DB = path.join(os.tmpdir(), `sde-drops-1b-${process.pid}.sqlite3`);
const TEST_LOG = path.join(os.tmpdir(), `sde-drops-1b-${process.pid}.log`);

let serverProcess = null;

async function main(){
  const contract = require(CONTRACT_FILE);
  const readModel = require(READ_MODEL_FILE);

  runContractTests(contract);
  runReadModelTests(contract, readModel);
  runSourceBoundaryTests();
  await runHttpTests();

  console.log("vehicleStatusContractTests: 18/18");
  console.log("vehicleStatusHttpTests: PASS");
}

function runContractTests(contract){
  assert.deepEqual(
    contract.CURRENT_STATUSES,
    ["DRIFTSKLAR", "IKKE_DRIFTSKLAR"],
    "currentStatus enum must be exact"
  );
  assert.deepEqual(
    contract.WORKSHOP_DISPOSITIONS,
    ["NONE", "TIL_REP", "TIL_DREI"],
    "workshopDisposition enum must be exact"
  );
  assert.deepEqual(
    contract.FAULT_CATEGORIES,
    ["A1", "A2", "A3", "A4", "A5", "A6"],
    "fault category enum must be exact"
  );
  assert.ok(Object.isFrozen(contract.CURRENT_STATUSES), "current status enum must be frozen");
  assert.ok(Object.isFrozen(contract.OPEN_POLICY_DECISIONS), "open policy decisions must be explicit and frozen");

  const raw = validRecord({
    vehicleId: " 74-10 ",
    statusReason: "  Trykkluftfeil  ",
    activeFaults: [
      validFault({ stableFaultId: " fault-2 ", priority: 2, category: "A2" }),
      validFault({ stableFaultId: " fault-1 ", priority: 1, category: "A1" })
    ]
  });
  const normalized = contract.normalizeVehicleStatusRecord(raw);
  assert.equal(normalized.vehicleId, "74-10", "vehicleId must be normalized");
  assert.equal(normalized.statusReason, "Trykkluftfeil", "statusReason must be normalized");
  assert.deepEqual(
    normalized.activeFaults.map((fault) => fault.priority),
    [1, 2],
    "faults must be sorted by priority"
  );
  assert.notEqual(normalized, raw, "normalization must clone the record");
  assert.notEqual(normalized.activeFaults, raw.activeFaults, "normalization must clone nested arrays");

  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({ currentStatus: "UNKNOWN" })),
    "currentStatus"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({ workshopDisposition: "VERKSTED" })),
    "workshopDisposition"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      activeFaults: [validFault({ category: "A7" })]
    })),
    "category"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      activeFaults: [validFault({ priority: 0 })]
    })),
    "priority"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      activeFaults: Array.from({ length: 6 }, (_, index) => validFault({
        stableFaultId: `fault-${index + 1}`,
        priority: (index % 5) + 1
      }))
    })),
    "five"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      activeFaults: [
        validFault({ stableFaultId: "same", priority: 1 }),
        validFault({ stableFaultId: "same", priority: 2 })
      ]
    })),
    "stableFaultId"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      activeFaults: [
        validFault({ stableFaultId: "one", priority: 1 }),
        validFault({ stableFaultId: "two", priority: 1 })
      ]
    })),
    "priority"
  );
  expectContractError(
    () => contract.normalizeVehicleStatusRecord(validRecord({
      updatedAt: "2026-07-19T10:00:00+02:00"
    })),
    "updatedAt"
  );

  const event = contract.normalizeVehicleStatusEvent(validEvent());
  assert.equal(event.eventId, "event-1", "event contract must normalize eventId");
  assert.equal(event.currentDisposition, "TIL_REP", "event contract must preserve disposition");

  const notification = contract.normalizeVehicleStatusNotification(validNotification());
  assert.equal(notification.notificationId, "notification-1", "notification contract must normalize id");
  assert.equal(notification.notificationRevision, 1, "notification revision must be preserved");
}

function runReadModelTests(contract, readModel){
  const latest = validRecord({
    vehicleId: "74-10",
    statusRevision: 2,
    updatedAt: "2026-07-19T10:02:00.000Z",
    activeFaults: [
      validFault({ stableFaultId: "fault-2", priority: 2, category: "A2" }),
      validFault({ stableFaultId: "fault-1", priority: 1, category: "A1" })
    ]
  });
  const historical = validRecord({
    vehicleId: "74-10",
    currentStatus: "DRIFTSKLAR",
    previousStatus: null,
    workshopDisposition: "NONE",
    statusRevision: 1,
    activeFaults: [],
    updatedAt: "2026-07-19T09:00:00.000Z"
  });
  const other = validRecord({
    vehicleId: "69-01",
    statusRevision: 4,
    updatedAt: "2026-07-19T10:01:00.000Z"
  });
  const eventOne = validEvent({ eventId: "event-b", timestamp: "2026-07-19T10:02:00.000Z" });
  const eventTwo = validEvent({ eventId: "event-a", timestamp: "2026-07-19T10:01:00.000Z" });
  const notificationOne = validNotification({
    notificationId: "notification-b",
    createdAt: "2026-07-19T10:02:00.000Z"
  });
  const notificationTwo = validNotification({
    notificationId: "notification-a",
    createdAt: "2026-07-19T10:01:00.000Z"
  });

  const input = {
    revision: 9,
    records: [latest, other, historical],
    events: [eventOne, eventTwo],
    notifications: [notificationOne, notificationTwo]
  };
  const reversed = {
    revision: 9,
    records: [...input.records].reverse(),
    events: [...input.events].reverse(),
    notifications: [...input.notifications].reverse()
  };

  const first = readModel.buildVehicleStatusReadModel(input);
  const second = readModel.buildVehicleStatusReadModel(reversed);
  assert.deepEqual(first, second, "input order must not change read-model output");
  assert.deepEqual(first.items.map((item) => item.vehicleId), ["69-01", "74-10"]);
  assert.equal(first.history.length, 1, "older record must be separated into history");
  assert.equal(first.history[0].statusRevision, 1, "history must contain older revision");
  assert.deepEqual(first.items[1].activeFaults.map((fault) => fault.priority), [1, 2]);
  assert.deepEqual(first.events.map((event) => event.eventId), ["event-a", "event-b"]);
  assert.deepEqual(
    first.notifications.map((notification) => notification.notificationId),
    ["notification-a", "notification-b"]
  );
  assert.ok(Object.isFrozen(first), "read-model root must be immutable");
  assert.ok(Object.isFrozen(first.items), "read-model arrays must be immutable");
  assert.ok(Object.isFrozen(first.items[0]), "read-model records must be immutable");

  latest.vehicleId = "MUTATED";
  latest.activeFaults[0].description = "mutated";
  assert.equal(first.items[1].vehicleId, "74-10", "output must not share record references");
  assert.notEqual(first.items[1].activeFaults[1].description, "mutated", "fault output must be cloned");

  const invalid = readModel.buildVehicleStatusReadModel({
    records: [validRecord({ vehicleId: "74-11", currentStatus: "INVALID" })],
    events: [],
    notifications: []
  });
  assert.deepEqual(invalid.items, [], "invalid records must not become operative items");
  assert.equal(invalid.diagnostics.length, 1, "invalid records must produce diagnostics");
  assert.equal(invalid.diagnostics[0].code, "invalid_vehicle_status_record");

  const production = readModel.buildProductionVehicleStatusReadModel();
  assert.equal(production.schemaVersion, "vehicle-status-read-model-v1");
  assert.equal(production.domain, "vehicle-status");
  assert.equal(production.contractActive, true);
  assert.equal(production.persistenceActive, false);
  assert.equal(production.statusAuthorityActive, false);
  assert.equal(production.writeEnabled, false);
  assert.equal(production.runtimeRoleEnforcement, false);
  assert.equal(production.operationalAuthority, false);
  assert.equal(production.sourceMode, "contract_only");
  assert.equal(production.revision, 0);
  assert.deepEqual(production.items, []);
  assert.deepEqual(production.events, []);
  assert.deepEqual(production.notifications, []);
  assert.deepEqual(production.history, []);
  assert.deepEqual(production.diagnostics, []);
  assert.deepEqual(production.openPolicyDecisions, contract.OPEN_POLICY_DECISIONS);
}

function runSourceBoundaryTests(){
  const contractSource = fs.readFileSync(CONTRACT_FILE, "utf8");
  const readModelSource = fs.readFileSync(READ_MODEL_FILE, "utf8");
  const indexSource = fs.readFileSync(INDEX_FILE, "utf8");
  const domainSources = `${contractSource}\n${readModelSource}`;

  for(const forbidden of ["localStorage", "sharedSporplanDraft", "grunnoppstillingRep"]){
    assert.equal(domainSources.includes(forbidden), false, `domain modules must not use ${forbidden}`);
  }

  assert.match(indexSource, /app\.get\("\/api\/vehicle-status"/, "GET route must exist");
  assert.doesNotMatch(
    indexSource,
    /app\.(?:post|put|patch|delete)\("\/api\/vehicle-status"/i,
    "no vehicle-status write route may exist"
  );
  assert.doesNotMatch(
    indexSource,
    /SDE_ENABLE_VEHICLE_STATUS/i,
    "vehicle-status must not introduce a write flag"
  );
}

async function runHttpTests(){
  const port = await getFreePort();
  removeTestFiles();
  serverProcess = startServer(port);

  try{
    await waitForHealth(port);
    const beforeRevision = await requestJson(port, "GET", "/api/state/revision");
    const beforeOperational = await requestJson(port, "GET", "/api/operational-state");
    const beforeDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");

    const response = await requestJson(
      port,
      "GET",
      "/api/vehicle-status?actor=client-admin&level=1",
      undefined,
      {
        "X-Actor": "client-admin",
        "X-Role": "drops",
        "X-Source-Level": "1"
      }
    );
    assert.equal(response.status, 200, "GET vehicle-status must succeed");
    assert.equal(response.headers["cache-control"], "no-store", "GET must use no-store");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.schemaVersion, "vehicle-status-read-model-v1");
    assert.equal(response.body.statusAuthorityActive, false);
    assert.equal(response.body.runtimeRoleEnforcement, false);
    assert.equal(response.body.operationalAuthority, false);
    assert.equal(response.body.writeEnabled, false);
    assert.equal(response.body.trustedRequestAuthority, null);
    assert.deepEqual(response.body.items, []);
    assert.deepEqual(response.body.events, []);
    assert.deepEqual(response.body.notifications, []);
    assert.equal(JSON.stringify(response.body).includes("client-admin"), false, "client actor must not become authority");
    assert.equal(JSON.stringify(response.body).includes("drops"), false, "client role must not become authority");

    for(const method of ["POST", "PUT", "PATCH", "DELETE"]){
      const blocked = await requestJson(port, method, "/api/vehicle-status", {});
      assert.equal(blocked.status, 404, `${method} vehicle-status must not exist`);
      assert.equal(blocked.body.error, "not_found", `${method} must use default not-found response`);
    }

    const afterRevision = await requestJson(port, "GET", "/api/state/revision");
    const afterOperational = await requestJson(port, "GET", "/api/operational-state");
    const afterDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");
    assert.deepEqual(afterRevision.body, beforeRevision.body, "GET must not change server revision");
    assert.deepEqual(afterOperational.body, beforeOperational.body, "GET must not change operational state");
    assert.deepEqual(afterDraft.body, beforeDraft.body, "GET must not change shared draft state");
  }finally{
    await stopServer();
    removeTestFiles();
  }
}

function validRecord(overrides = {}){
  return {
    vehicleId: "74-10",
    currentStatus: "IKKE_DRIFTSKLAR",
    previousStatus: "DRIFTSKLAR",
    workshopDisposition: "TIL_REP",
    statusReason: "Trykkluftfeil",
    statusAuthority: "contract-fixture",
    registeredAt: "2026-07-19T10:00:00.000Z",
    registeredBy: "fixture-user",
    sourceLevel: "fixture-level",
    stationPresenceAtRegistration: true,
    stationSlotAtRegistration: "5M",
    activeCaseId: "case-1",
    statusRevision: 1,
    activeFaults: [],
    latestResolution: null,
    updatedAt: "2026-07-19T10:01:00.000Z",
    ...overrides
  };
}

function validFault(overrides = {}){
  return {
    stableFaultId: "fault-1",
    priority: 1,
    category: "A1",
    description: "Feilbeskrivelse",
    createdAt: "2026-07-19T10:00:00.000Z",
    createdBy: "fixture-user",
    resolvedAt: null,
    resolvedBy: null,
    resolutionDescription: null,
    ...overrides
  };
}

function validEvent(overrides = {}){
  return {
    eventId: "event-1",
    actionId: "action-1",
    vehicleId: "74-10",
    caseId: "case-1",
    eventType: "STATUS_CHANGED",
    previousStatus: "DRIFTSKLAR",
    currentStatus: "IKKE_DRIFTSKLAR",
    previousDisposition: "NONE",
    currentDisposition: "TIL_REP",
    timestamp: "2026-07-19T10:01:00.000Z",
    actor: "fixture-user",
    sourceLevel: "fixture-level",
    statusRevision: 1,
    payloadDigest: "sha256:fixture",
    ...overrides
  };
}

function validNotification(overrides = {}){
  return {
    notificationId: "notification-1",
    eventId: "event-1",
    vehicleId: "74-10",
    notificationType: "STATUS_CHANGED",
    createdAt: "2026-07-19T10:01:00.000Z",
    readAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    notificationRevision: 1,
    ...overrides
  };
}

function expectContractError(callback, expectedFragment){
  assert.throws(callback, (error) => {
    return error &&
      error.name === "VehicleStatusContractError" &&
      error.code === "invalid_vehicle_status_contract" &&
      error.message.includes(expectedFragment);
  });
}

function getFreePort(){
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, TEST_HOST, () => {
      const address = probe.address();
      probe.close((error) => {
        if(error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function startServer(port){
  const output = fs.openSync(TEST_LOG, "w");
  const env = { ...process.env };
  for(const key of Object.keys(env)){
    if(key.startsWith("SDE_ENABLE_")) delete env[key];
  }
  env.PORT = String(port);
  env.SDE_SERVER_DB_PATH = TEST_DB;

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", output, output]
  });
  fs.closeSync(output);
  return child;
}

async function waitForHealth(port){
  const deadline = Date.now() + 6000;
  let lastError = null;
  while(Date.now() < deadline){
    if(serverProcess.exitCode !== null){
      throw new Error(`Test server exited early.\n${readLog()}`);
    }
    try{
      const health = await requestJson(port, "GET", "/api/health");
      if(health.status === 200 && health.body.ok === true) return;
    }catch(error){
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test server: ${lastError?.message || "unknown"}\n${readLog()}`);
}

function requestJson(port, method, requestPath, body, extraHeaders = {}){
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: TEST_HOST,
      port,
      method,
      path: requestPath,
      timeout: 4000,
      headers: {
        ...extraHeaders,
        ...(payload === null
          ? {}
          : {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            })
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try{
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : null
          });
        }catch(error){
          reject(new Error(`Invalid JSON from ${method} ${requestPath}: ${error.message}; raw=${raw}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out ${method} ${requestPath}`)));
    request.on("error", reject);
    if(payload !== null) request.write(payload);
    request.end();
  });
}

function stopServer(){
  if(!serverProcess || serverProcess.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverProcess.kill("SIGKILL");
      reject(new Error("Timed out stopping isolated vehicle-status test server"));
    }, 5000);
    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    serverProcess.kill("SIGTERM");
  });
}

function removeTestFiles(){
  for(const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, TEST_LOG]){
    const resolved = path.resolve(file);
    if(!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)){
      throw new Error(`Refusing to remove non-temp test file: ${file}`);
    }
    fs.rmSync(resolved, { force: true });
  }
}

function readLog(){
  return fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, "utf8") : "";
}

main().catch(async (error) => {
  try{
    await stopServer();
  }catch(stopError){
    console.error(stopError);
  }
  removeTestFiles();
  console.error(error);
  process.exitCode = 1;
});
