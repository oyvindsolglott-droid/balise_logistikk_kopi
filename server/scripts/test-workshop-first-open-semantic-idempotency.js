#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  LIFECYCLE_COMMANDS,
  normalizeLifecycleCommand
} = require("../src/vehicleStatusLifecycle");
const {
  PROCESS_CASE_TABLE,
  createVehicleStatusRepository
} = require("../src/vehicleStatusTestRepository");

const VEHICLE_ID = "74-04";
const OTHER_VEHICLE_ID = "74-10";
const passed = [];
let counter = 0;
let clock = Date.parse("2026-07-26T07:00:00.000Z");

const dropsAuthority = Object.freeze({
  subject: "cf-access|first-open-drops-test",
  roles: Object.freeze([ROLE_KEYS.DROPS]),
  effectiveRole: ROLE_KEYS.DROPS,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.DROPS]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});
const workshopAuthority = Object.freeze({
  subject: "cf-access|first-open-workshop-test",
  roles: Object.freeze([ROLE_KEYS.VERKSTED]),
  effectiveRole: ROLE_KEYS.VERKSTED,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.VERKSTED]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});

function uuid(){
  counter += 1;
  return `20000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function now(){
  return new Date(clock).toISOString();
}

function advance(minutes = 1){
  clock += minutes * 60_000;
}

function normalized(name, payload){
  const result = normalizeLifecycleCommand(name, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function execute(repository, name, payload, authority = workshopAuthority){
  return repository.executeCommand(name, normalized(name, payload), authority);
}

function createFixture(label = "main"){
  const databasePath = path.join(
    os.tmpdir(),
    `sde-first-open-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`
  );
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 10000;");
  const repository = createVehicleStatusRepository({
    db,
    mode: "test",
    writeEnabled: true,
    now,
    randomUUID: uuid
  });
  return {
    databasePath,
    db,
    repository,
    close(){
      db.close();
      removeDatabase(databasePath);
    }
  };
}

function removeDatabase(databasePath){
  for(const suffix of ["", "-wal", "-shm"]){
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function registerFault(repository, vehicleId = VEHICLE_ID){
  return execute(repository, LIFECYCLE_COMMANDS.REGISTER_FAULT, {
    actionId: uuid(),
    expectedCaseRevision: 0,
    vehicleId,
    slot: 1,
    category: "A1",
    description: "Mangler stigtrinn."
  }, dropsAuthority);
}

function requestRepair(repository, faultResult){
  return execute(repository, LIFECYCLE_COMMANDS.REQUEST_REPAIR, {
    actionId: uuid(),
    expectedCaseRevision: 1,
    vehicleId: VEHICLE_ID,
    faultId: faultResult.result.faultId
  }, dropsAuthority);
}

function openSheet(repository, actionId, caseId = undefined){
  return execute(repository, LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED, {
    actionId,
    vehicleId: VEHICLE_ID,
    ...(caseId ? { caseId } : {})
  });
}

function presentNotification(repository, actionId, notificationId){
  return execute(repository, LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED, {
    actionId,
    notificationId
  });
}

function counts(repository){
  return repository.getStorageSnapshot().counts;
}

function check(name, callback){
  callback();
  passed.push(name);
}

function assertCountsEqual(actual, expected, message){
  assert.deepEqual(actual, expected, message);
}

async function runConcurrentFirstOpen(databasePath, caseId){
  const repositoryPath = path.join(__dirname, "..", "src", "vehicleStatusTestRepository.js");
  const lifecyclePath = path.join(__dirname, "..", "src", "vehicleStatusLifecycle.js");
  const identityPath = path.join(__dirname, "..", "src", "identityPolicy.js");
  const workerSource = `
    "use strict";
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const { createVehicleStatusRepository } = require(workerData.repositoryPath);
    const { LIFECYCLE_COMMANDS, normalizeLifecycleCommand } = require(workerData.lifecyclePath);
    const { ROLE_KEYS } = require(workerData.identityPath);
    const db = new DatabaseSync(workerData.databasePath);
    db.exec("PRAGMA busy_timeout = 10000;");
    const repository = createVehicleStatusRepository({
      db,
      mode: "test",
      writeEnabled: true
    });
    const authority = {
      subject: "cf-access|concurrent-first-open",
      roles: [ROLE_KEYS.VERKSTED],
      effectiveRole: ROLE_KEYS.VERKSTED,
      capabilitySourceRoles: [ROLE_KEYS.VERKSTED],
      identitySource: "cloudflare_access_jwt",
      roleBindingSource: "server_config"
    };
    parentPort.once("message", () => {
      try {
        const normalized = normalizeLifecycleCommand(
          LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED,
          {
            actionId: workerData.actionId,
            vehicleId: workerData.vehicleId,
            caseId: workerData.caseId
          }
        );
        const result = repository.executeCommand(
          LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED,
          normalized.value,
          authority
        );
        db.close();
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        try { db.close(); } catch (_closeError) {}
        parentPort.postMessage({
          ok: false,
          error: { name: error.name, message: error.message, stack: error.stack }
        });
      }
    });
    parentPort.postMessage({ ready: true });
  `;
  const workerData = {
    databasePath,
    repositoryPath,
    lifecyclePath,
    identityPath,
    vehicleId: VEHICLE_ID,
    caseId
  };
  const workers = [uuid(), uuid()].map((actionId) =>
    new Worker(workerSource, { eval: true, workerData: { ...workerData, actionId } })
  );
  const ready = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if(message?.ready){
        worker.off("error", reject);
        resolve();
      }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  })));
  assert.equal(ready.length, 2);
  const results = workers.map((worker) => new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if(!message?.ready){
        worker.off("message", onMessage);
        worker.off("error", reject);
        resolve(message);
      }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  }));
  workers.forEach((worker) => worker.postMessage({ go: true }));
  const messages = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  messages.forEach((message) => assert.equal(message.ok, true, JSON.stringify(message.error)));
  return messages.map((message) => message.result);
}

async function main(){
  const fixture = createFixture();
  try{
    const { repository, db } = fixture;
    const fault = registerFault(repository);
    const repair = requestRepair(repository, fault);
    const processCase = repository.getReadModel({ roles: [ROLE_KEYS.VERKSTED] })
      .processCases.find((candidate) => candidate.vehicleId === VEHICLE_ID && candidate.active);
    assert.ok(processCase?.caseId);

    const firstActionId = uuid();
    const beforeFirst = counts(repository);
    advance();
    const first = openSheet(repository, firstActionId, processCase.caseId);
    const afterFirst = counts(repository);
    check("01 first opening returns created", () => assert.equal(first.status, 201));
    check("02 first opening creates one command audit", () =>
      assert.equal(afterFirst.events - beforeFirst.events, 1));
    check("03 first opening creates one process milestone", () =>
      assert.equal(afterFirst.processEvents - beforeFirst.processEvents, 1));
    check("04 first opening creates one original idempotency binding", () =>
      assert.equal(afterFirst.idempotency - beforeFirst.idempotency, 1));
    check("05 first opening returns authoritative timestamp and event identity", () => {
      assert.match(first.result.firstOpenedAt, /^2026-07-26T/);
      assert.ok(first.result.eventId);
      assert.equal(first.result.timelineEventCreated, true);
      assert.notEqual(first.result.alreadyRecorded, true);
    });
    check("06 first opening preserves business status", () => {
      assert.equal(afterFirst.records, beforeFirst.records);
      assert.equal(afterFirst.cases, beforeFirst.cases);
      assert.equal(afterFirst.faults, beforeFirst.faults);
      assert.equal(afterFirst.repairRequests, beforeFirst.repairRequests);
      assert.equal(afterFirst.notifications, beforeFirst.notifications);
    });

    const replay = openSheet(repository, firstActionId, processCase.caseId);
    check("07 identical actionId replay returns 200", () => assert.equal(replay.status, 200));
    check("08 identical actionId replay is marked idempotent", () =>
      assert.equal(replay.result.idempotentReplay, true));
    check("09 identical actionId replay returns the original result", () => {
      assert.equal(replay.result.eventId, first.result.eventId);
      assert.equal(replay.result.firstOpenedAt, first.result.firstOpenedAt);
    });
    check("10 identical actionId replay creates no rows", () =>
      assertCountsEqual(counts(repository), afterFirst));

    advance();
    const newAction = openSheet(repository, uuid(), processCase.caseId);
    check("11 new actionId for an opened case returns semantic 200", () =>
      assert.equal(newAction.status, 200));
    check("12 new actionId for an opened case is already recorded", () => {
      assert.equal(newAction.result.alreadyRecorded, true);
      assert.equal(newAction.result.timelineEventCreated, false);
      assert.equal(newAction.result.firstOpenedAt, first.result.firstOpenedAt);
    });
    check("13 new actionId for an opened case creates no rows or revision", () =>
      assertCountsEqual(counts(repository), afterFirst));

    for(let index = 0; index < 10; index += 1){
      advance();
      const result = openSheet(repository, uuid(), processCase.caseId);
      assert.equal(result.status, 200);
      assert.equal(result.result.alreadyRecorded, true);
    }
    check("14 ten fresh actionIds create no count growth", () =>
      assertCountsEqual(counts(repository), afterFirst));

    const noCaseBefore = counts(repository);
    const noCase = execute(repository, LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED, {
      actionId: uuid(),
      vehicleId: OTHER_VEHICLE_ID
    });
    check("15 missing relevant case fails closed", () => {
      assert.equal(noCase.status, 404);
      assert.equal(noCase.error, "process_case_not_found");
    });
    check("16 missing relevant case creates no rows", () =>
      assertCountsEqual(counts(repository), noCaseBefore));

    db.prepare(`
      UPDATE ${PROCESS_CASE_TABLE}
      SET closed_at = ?, latest_event_at = ?
      WHERE case_id = ?
    `).run(now(), now(), processCase.caseId);
    const nextCaseId = "process-case-74-04-sequence-2";
    db.prepare(`
      INSERT INTO ${PROCESS_CASE_TABLE} (
        case_id, vehicle_id, sequence, opened_at, closed_at,
        current_wait_reason, source_event_id, latest_event_at
      ) VALUES (?, ?, 2, ?, NULL, 'NONE', NULL, ?)
    `).run(nextCaseId, VEHICLE_ID, now(), now());
    const beforeNextCase = counts(repository);
    advance();
    const nextCaseOpen = openSheet(repository, uuid(), nextCaseId);
    check("17 a new stable case can create its own first-open milestone", () => {
      assert.equal(nextCaseOpen.status, 201);
      assert.equal(nextCaseOpen.result.timelineEventCreated, true);
      assert.equal(nextCaseOpen.result.alreadyRecorded, false);
    });
    check("18 the previous case remains immutable", () => {
      const firstCaseEvents = repository.getStorageSnapshot().processEvents
        .filter((event) =>
          event.case_id === processCase.caseId &&
          event.event_type === "WORKSHOP_SHEET_FIRST_OPENED"
        );
      assert.equal(firstCaseEvents.length, 1);
    });
    check("19 a new case adds exactly one command, milestone and binding", () => {
      const after = counts(repository);
      assert.equal(after.events - beforeNextCase.events, 1);
      assert.equal(after.processEvents - beforeNextCase.processEvents, 1);
      assert.equal(after.idempotency - beforeNextCase.idempotency, 1);
    });

    const notificationBefore = counts(repository);
    const presentedActionId = uuid();
    advance();
    const presented = presentNotification(
      repository,
      presentedActionId,
      repair.result.notificationId
    );
    const notificationAfter = counts(repository);
    check("20 first notification presentation creates one semantic milestone", () => {
      assert.equal(presented.status, 201);
      assert.equal(notificationAfter.events - notificationBefore.events, 1);
      assert.equal(notificationAfter.processEvents - notificationBefore.processEvents, 1);
      assert.equal(notificationAfter.idempotency - notificationBefore.idempotency, 1);
    });
    const presentedReplay = presentNotification(
      repository,
      presentedActionId,
      repair.result.notificationId
    );
    check("21 identical notification actionId replays without rows", () => {
      assert.equal(presentedReplay.status, 200);
      assert.equal(presentedReplay.result.idempotentReplay, true);
      assertCountsEqual(counts(repository), notificationAfter);
    });
    const presentedFreshAction = presentNotification(
      repository,
      uuid(),
      repair.result.notificationId
    );
    check("22 fresh actionId for presented notification is a write-free semantic no-op", () => {
      assert.equal(presentedFreshAction.status, 200);
      assert.equal(presentedFreshAction.result.alreadyRecorded, true);
      assert.equal(presentedFreshAction.result.timelineEventCreated, false);
      assertCountsEqual(counts(repository), notificationAfter);
    });
  }finally{
    fixture.close();
  }

  const raceFixture = createFixture("race");
  try{
    registerFault(raceFixture.repository);
    const raceCase = raceFixture.repository
      .getReadModel({ roles: [ROLE_KEYS.VERKSTED] })
      .processCases.find((candidate) => candidate.vehicleId === VEHICLE_ID && candidate.active);
    assert.ok(raceCase?.caseId);
    const beforeRace = counts(raceFixture.repository);
    raceFixture.db.close();
    const raceResults = await runConcurrentFirstOpen(raceFixture.databasePath, raceCase.caseId);
    const verifyDb = new DatabaseSync(raceFixture.databasePath);
    const verifyRepository = createVehicleStatusRepository({
      db: verifyDb,
      mode: "test",
      writeEnabled: true
    });
    const afterRace = counts(verifyRepository);
    check("23 concurrent first opens return one create and one semantic no-op", () => {
      assert.deepEqual(raceResults.map((result) => result.status).sort(), [200, 201]);
    });
    check("24 concurrent first opens persist one milestone, command and binding", () => {
      assert.equal(afterRace.events - beforeRace.events, 1);
      assert.equal(afterRace.processEvents - beforeRace.processEvents, 1);
      assert.equal(afterRace.idempotency - beforeRace.idempotency, 1);
    });
    check("25 concurrent loser does not leak a transaction error", () =>
      assert.ok(raceResults.every((result) => result.ok === true)));
    verifyDb.close();
  }finally{
    removeDatabase(raceFixture.databasePath);
  }

  process.stdout.write(JSON.stringify({
    schemaVersion: "sde-workshop-first-open-semantic-idempotency-test-v1",
    counts: { passed: passed.length, total: 25 },
    passed
  }) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
