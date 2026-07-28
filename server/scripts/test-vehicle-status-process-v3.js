#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  LIFECYCLE_COMMANDS,
  normalizeLifecycleCommand
} = require("../src/vehicleStatusLifecycle");
const {
  PROCESS_EVENT_TABLE,
  createVehicleStatusRepository
} = require("../src/vehicleStatusTestRepository");

const VEHICLE_ID = "74-04";
const OTHER_VEHICLE_ID = "74-10";
const passed = [];
let counter = 0;
let clock = Date.parse("2026-07-25T08:00:00.000Z");

const dropsAuthority = Object.freeze({
  subject: "cf-access|drops-process-test",
  roles: Object.freeze([ROLE_KEYS.DROPS]),
  effectiveRole: ROLE_KEYS.DROPS,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.DROPS]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});
const workshopAuthority = Object.freeze({
  subject: "cf-access|workshop-process-test",
  roles: Object.freeze([ROLE_KEYS.VERKSTED]),
  effectiveRole: ROLE_KEYS.VERKSTED,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.VERKSTED]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});

function uuid(){
  counter += 1;
  return `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function now(){
  return new Date(clock).toISOString();
}

function advance(minutes){
  clock += minutes * 60_000;
}

function normalized(name, payload){
  const result = normalizeLifecycleCommand(name, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function execute(repository, name, payload, authority = dropsAuthority){
  return repository.executeCommand(name, normalized(name, payload), authority);
}

function createFixture(){
  const databasePath = path.join(
    os.tmpdir(),
    `sde-vehicle-process-v3-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`
  );
  const db = new DatabaseSync(databasePath);
  const repository = createVehicleStatusRepository({
    db,
    mode: "test",
    writeEnabled: true,
    now,
    randomUUID: uuid
  });
  return {
    db,
    repository,
    close(){
      db.close();
      for(const suffix of ["", "-wal", "-shm"]){
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }
    }
  };
}

function registerFault(repository, vehicleId = VEHICLE_ID, expectedCaseRevision = 0, category = "A1"){
  return execute(repository, LIFECYCLE_COMMANDS.REGISTER_FAULT, {
    actionId: uuid(),
    expectedCaseRevision,
    vehicleId,
    slot: 1,
    category,
    description: category === "A1" ? "Mangler stigtrinn." : "AC-defekt"
  }).result;
}

function requestRepair(repository, fault, expectedCaseRevision = 1){
  return execute(repository, LIFECYCLE_COMMANDS.REQUEST_REPAIR, {
    actionId: uuid(),
    expectedCaseRevision,
    vehicleId: fault.vehicleId || VEHICLE_ID,
    faultId: fault.faultId
  });
}

function processEvents(repository, vehicleId = VEHICLE_ID){
  return repository.getReadModel({ roles: [ROLE_KEYS.DROPS] }).processEvents
    .filter((event) => event.vehicleId === vehicleId);
}

function check(name, callback){
  callback();
  passed.push(name);
}

function main(){
  const fixture = createFixture();
  try{
    const { repository, db } = fixture;
    check("01 schema migrates through v5 without resetting lifecycle tables", () => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
      assert.ok(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(PROCESS_EVENT_TABLE));
    });

    const neutralFault = registerFault(repository);
    const neutralBefore = repository.getStorageSnapshot();
    advance(5);
    const neutralRepair = requestRepair(repository, neutralFault);

    check("02 ACTIVE fault without status record can request repair", () => {
      assert.equal(neutralRepair.status, 201);
      assert.equal(repository.getStorageSnapshot().counts.records, 0);
    });
    check("03 request repair creates exactly one request and notification", () => {
      const after = repository.getStorageSnapshot();
      assert.equal(after.counts.repairRequests - neutralBefore.counts.repairRequests, 1);
      assert.equal(after.counts.notifications - neutralBefore.counts.notifications, 1);
      assert.equal(after.counts.idempotency - neutralBefore.counts.idempotency, 1);
    });
    check("04 request repair emits request and notification-created milestones", () => {
      const types = processEvents(repository).map((event) => event.eventType);
      assert.deepEqual(types.slice(-2), [
        "REPAIR_REQUESTED",
        "WORKSHOP_NOTIFICATION_CREATED"
      ]);
    });
    check("05 request repair returns preserved neutral status facts", () => {
      assert.equal(neutralRepair.result.currentStatus, null);
      assert.equal(neutralRepair.result.disposition, null);
      assert.equal(neutralRepair.result.statusRevision, 0);
    });

    const notificationId = neutralRepair.result.notificationId;
    advance(2);
    const presentedPayload = {
      actionId: uuid(),
      notificationId
    };
    const presented = execute(
      repository,
      LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
      presentedPayload,
      workshopAuthority
    );
    const presentedReplay = repository.executeCommand(
      LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
      normalized(LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED, presentedPayload),
      workshopAuthority
    );
    check("06 notification-presented is server-authorized and idempotent", () => {
      assert.equal(presented.status, 201);
      assert.equal(presentedReplay.result.idempotentReplay, true);
      assert.equal(processEvents(repository)
        .filter((event) => event.eventType === "WORKSHOP_NOTIFICATION_PRESENTED").length, 1);
    });
    check("07 presentation does not claim read or understood", () => {
      assert.doesNotMatch(JSON.stringify(presented.result), /\b(read|understood|lest|forstått)\b/i);
    });

    advance(3);
    const opened = execute(repository, LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED, {
      actionId: uuid(),
      vehicleId: VEHICLE_ID
    }, workshopAuthority);
    const openedAgain = execute(repository, LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED, {
      actionId: uuid(),
      vehicleId: VEHICLE_ID
    }, workshopAuthority);
    check("08 workshop first-open is emitted once per active case", () => {
      assert.equal(opened.status, 201);
      assert.equal(openedAgain.status, 200);
      assert.equal(openedAgain.result.alreadyRecorded, true);
      assert.equal(openedAgain.result.timelineEventCreated, false);
      assert.equal(processEvents(repository)
        .filter((event) => event.eventType === "WORKSHOP_SHEET_FIRST_OPENED").length, 1);
    });

    check("09 first placement observation establishes only a baseline", () => {
      const result = repository.observeCanonicalPlacements({
        placementRevision: 10,
        placements: [{ vehicleId: VEHICLE_ID, slot: "6N" }]
      });
      assert.equal(result.eventsCreated, 0);
    });
    advance(10);
    check("10 outside-to-workshop creates one entry with source facts", () => {
      const result = repository.observeCanonicalPlacements({
        placementRevision: 11,
        placements: [{ vehicleId: VEHICLE_ID, slot: "7N" }]
      });
      assert.equal(result.eventsCreated, 1);
      const event = processEvents(repository).at(-1);
      assert.equal(event.eventType, "WORKSHOP_AREA_ENTERED");
      assert.equal(event.payload.fromSlot, "6N");
      assert.equal(event.payload.toSlot, "7N");
      assert.equal(event.sourceRevision, "11");
    });
    check("11 workshop-to-workshop creates no transition", () => {
      assert.equal(repository.observeCanonicalPlacements({
        placementRevision: 12,
        placements: [{ vehicleId: VEHICLE_ID, slot: "8S" }]
      }).eventsCreated, 0);
    });

    advance(5);
    const wait = execute(repository, LIFECYCLE_COMMANDS.SET_WAIT_REASON, {
      actionId: uuid(),
      expectedCaseRevision: 2,
      vehicleId: VEHICLE_ID,
      reason: "WAITING_FOR_PART"
    }, workshopAuthority);
    advance(5);
    const started = execute(repository, LIFECYCLE_COMMANDS.WORK_STARTED, {
      actionId: uuid(),
      expectedCaseRevision: 3,
      vehicleId: VEHICLE_ID
    }, workshopAuthority);
    check("12 wait reason and work-start are explicit immutable events", () => {
      assert.equal(wait.status, 201);
      assert.equal(started.status, 201);
      assert.equal(started.result.workStartedAt, now());
      assert.deepEqual(processEvents(repository).slice(-2).map((event) => event.eventType), [
        "WAIT_REASON_SET", "WORK_STARTED"
      ]);
    });
    check("13 work-start and wait reason preserve absence of status record", () => {
      assert.equal(repository.getStorageSnapshot().counts.records, 0);
    });

    check("14 workshop-to-outside creates exactly one exit", () => {
      assert.equal(repository.observeCanonicalPlacements({
        placementRevision: 13,
        placements: [{ vehicleId: VEHICLE_ID, slot: "6S" }]
      }).eventsCreated, 1);
      assert.equal(processEvents(repository).at(-1).eventType, "WORKSHOP_AREA_EXITED");
    });
    check("15 observer replay and restart-style duplicate revision create no events", () => {
      assert.equal(repository.observeCanonicalPlacements({
        placementRevision: 13,
        placements: [{ vehicleId: VEHICLE_ID, slot: "6S" }]
      }).eventsCreated, 0);
    });

    const readModel = repository.getReadModel({ roles: [ROLE_KEYS.DROPS] });
    const processCase = readModel.processCases.find((candidate) => candidate.vehicleId === VEHICLE_ID);
    check("16 projection is rebuildable and missing milestones remain null", () => {
      assert.equal(processCase.currentWaitReason, "WAITING_FOR_PART");
      assert.equal(processCase.milestones.firstFaultRegisteredAt, "2026-07-25T08:00:00.000Z");
      assert.equal(processCase.milestones.firstNotOperationalAt, null);
      assert.equal(processCase.metrics.downtimeMs, null);
    });
    check("17 deterministic metrics use absolute server timestamps", () => {
      assert.equal(processCase.metrics.timeBeforeRepairRequestedMs, 5 * 60_000);
      assert.equal(processCase.metrics.notificationPresentationDelayMs, 2 * 60_000);
      assert.equal(processCase.metrics.timeToFirstWorkshopSheetOpenMs, 5 * 60_000);
    });

    const analytics = repository.getAnalytics({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z"
    });
    check("18 analytics contains process, reliability and capacity contracts", () => {
      assert.equal(analytics.schemaVersion, "vehicle-status-analytics-v1");
      assert.ok(analytics.operationalSnapshot);
      assert.ok(analytics.processPerformance);
      assert.ok(analytics.reliability);
      assert.ok(analytics.capacity);
      assert.ok(analytics.sampleCounts);
      assert.ok(Array.isArray(analytics.missingDataDiagnostics));
      assert.ok(analytics.metricDefinitions);
    });
    check("19 analytics response has no person identity or surveillance data", () => {
      const json = JSON.stringify(analytics);
      assert.doesNotMatch(json, /cf-access|actor|subject|email|keyboard|keystroke|mouse|idle|employee|mechanicRanking/i);
      assert.doesNotMatch(json, /drops-process-test|workshop-process-test/);
    });
    check("20 analytics reports median, average and sample count together", () => {
      const measure = analytics.processPerformance.timeBeforeRepairRequested;
      assert.equal(measure.sampleCount, 1);
      assert.equal(measure.averageMs, 5 * 60_000);
      assert.equal(measure.medianMs, 5 * 60_000);
    });

    check("21 first production observation creates no historical event", () => {
      assert.equal(repository.observeProductionOccurrences({
        sourceRevision: "data-1",
        occurrences: [{
          occurrenceId: "occ-1",
          operationalDate: "2026-07-25",
          vehicleId: VEHICLE_ID,
          trainNumber: "810",
          departureAt: "2026-07-25T12:00:00.000Z",
          evidenceType: "TURSATT_SCHEDULED"
        }]
      }).eventsCreated, 0);
    });

    check("22 process-event table is immutable", () => {
      assert.throws(() => db.prepare(
        `UPDATE ${PROCESS_EVENT_TABLE} SET event_type='ALTERED' WHERE event_type='FAULT_REGISTERED'`
      ).run(), /immutable/i);
      assert.throws(() => db.prepare(
        `DELETE FROM ${PROCESS_EVENT_TABLE} WHERE event_type='FAULT_REGISTERED'`
      ).run(), /immutable/i);
    });

    check("23 active repair request cannot be duplicated with a fresh action", () => {
      const duplicate = requestRepair(repository, neutralFault, 4);
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.error, "repair_already_requested");
    });

    check("24 process readback never exposes actor audit identity", () => {
      assert.doesNotMatch(JSON.stringify(readModel.processEvents), /cf-access|actorSubject|actorRoles/i);
    });

    const otherFault = registerFault(repository, OTHER_VEHICLE_ID, 0, "A2");
    const otherBefore = repository.getStorageSnapshot();
    const otherRepair = requestRepair(repository, { ...otherFault, vehicleId: OTHER_VEHICLE_ID }, 1);
    check("25 another statusless vehicle remains statusless after repair request", () => {
      assert.equal(otherRepair.status, 201);
      assert.equal(repository.getStorageSnapshot().counts.records, otherBefore.counts.records);
    });

    check("26 an active statusless case can re-enter the workshop before completion", () => {
      assert.equal(repository.observeCanonicalPlacements({
        placementRevision: 14,
        placements: [{ vehicleId: VEHICLE_ID, slot: "7S" }]
      }).eventsCreated, 1);
      assert.equal(processEvents(repository).at(-1).eventType, "WORKSHOP_AREA_ENTERED");
    });

    advance(5);
    const operational = execute(repository, LIFECYCLE_COMMANDS.REPORT_OPERATIONAL, {
      actionId: uuid(),
      expectedStatusRevision: 0,
      expectedCaseRevision: 4,
      vehicleId: VEHICLE_ID
    }, workshopAuthority);
    check("27 explicit operational completion closes active work without prior status", () => {
      assert.equal(operational.status, 201);
      assert.equal(operational.result.status, "DRIFTSKLAR");
      assert.equal(operational.result.resolvedFaults, 1);
      assert.equal(operational.result.completedRepairRequests, 1);
      const item = repository.getReadModel({ roles: [ROLE_KEYS.DROPS] }).items
        .find((candidate) => candidate.vehicleId === VEHICLE_ID);
      assert.equal(item.currentStatus, "DRIFTSKLAR");
      assert.equal(item.activeFaults.length, 0);
    });

    advance(5);
    check("28 workshop exit is observed after the process case has closed", () => {
      assert.equal(repository.observeCanonicalPlacements({
        placementRevision: 15,
        placements: [{ vehicleId: VEHICLE_ID, slot: "6S" }]
      }).eventsCreated, 1);
      assert.equal(processEvents(repository).at(-1).eventType, "WORKSHOP_AREA_EXITED");
    });

    check("29 return-to-service metric uses occurrence departure, not detection time", () => {
      assert.equal(repository.observeProductionOccurrences({
        sourceRevision: "data-2",
        occurrences: [{
          occurrenceId: "occ-2",
          operationalDate: "2026-07-25",
          vehicleId: VEHICLE_ID,
          trainNumber: "812",
          departureAt: "2026-07-25T12:00:00.000Z",
          evidenceType: "TURSATT_SCHEDULED"
        }]
      }).eventsCreated, 1);
      const processCaseAfter = repository.getReadModel({ roles: [ROLE_KEYS.DROPS] })
        .processCases.find((candidate) => candidate.vehicleId === VEHICLE_ID);
      assert.equal(
        processCaseAfter.milestones.returnToServiceDetectedAt,
        "2026-07-25T12:00:00.000Z"
      );
      assert.equal(processCaseAfter.metrics.returnToServiceTimeMs, 205 * 60_000);
      const returnEvent = processEvents(repository).at(-1);
      assert.equal(returnEvent.payload.detectedAt, "2026-07-25T08:40:00.000Z");
    });

    const recurringFault = registerFault(repository, VEHICLE_ID, 5, "A1");
    check("30 a new fault cycle drives recurrence, visit and next-fault analytics", () => {
      assert.equal(recurringFault.category, "A1");
      const recurringAnalytics = repository.getAnalytics({
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z"
      });
      assert.deepEqual(recurringAnalytics.reliability.recurrence["7Days"], {
        repeated: 1,
        sampleCount: 3
      });
      assert.deepEqual(recurringAnalytics.reliability.descriptionRecurrence["7Days"], {
        repeated: 1,
        sampleCount: 3
      });
      assert.equal(recurringAnalytics.reliability.faultsPerMonth["2026-07"], 3);
      assert.equal(recurringAnalytics.reliability.workshopVisitsPerVehicle[VEHICLE_ID], 2);
      assert.equal(recurringAnalytics.reliability.timeFromRepairToNextFault.medianMs, 5 * 60_000);
      assert.equal(recurringAnalytics.capacity.distributions.category.A1, 1);
      assert.equal(recurringAnalytics.capacity.distributions.series["74"], 2);
    });

    process.stdout.write(JSON.stringify({
      schemaVersion: "sde-vehicle-status-process-v3-test-v1",
      counts: { passed: passed.length, total: 30 },
      passed
    }) + "\n");
  }finally{
    fixture.close();
  }
}

main();
