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
  createVehicleStatusRepository
} = require("../src/vehicleStatusTestRepository");

const VEHICLE_ID = "69-63";
const passed = [];
let counter = 0;
let clock = Date.parse("2026-07-27T10:00:00.000Z");

const workshopAuthority = Object.freeze({
  subject: "cf-access|workshop-exit-test",
  roles: Object.freeze([ROLE_KEYS.VERKSTED]),
  effectiveRole: ROLE_KEYS.VERKSTED,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.VERKSTED]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});

function uuid(){
  counter += 1;
  return `90000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function now(){
  return new Date(clock).toISOString();
}

function advance(minutes){
  clock += minutes * 60_000;
}

function check(name, callback){
  callback();
  passed.push(name);
}

function normalize(payload){
  const result = normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT,
    payload
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function request(repository, payload){
  return repository.executeCommand(
    LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT,
    normalize(payload),
    workshopAuthority
  );
}

function main(){
  const databasePath = path.join(
    os.tmpdir(),
    `sde-workshop-exit-${process.pid}-${Date.now()}.sqlite3`
  );
  const db = new DatabaseSync(databasePath);
  const repository = createVehicleStatusRepository({
    db,
    mode: "test",
    writeEnabled: true,
    now,
    randomUUID: uuid
  });
  try{
    check("01 schema v6 persists workshop exit requests and immutable events", () => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'vehicle_status_workshop_exit_%'
        ORDER BY name
      `).all().map(row=>row.name);
      assert.deepEqual(tables, [
        "vehicle_status_workshop_exit_events",
        "vehicle_status_workshop_exit_requests"
      ]);
    });

    check("02 first workshop placement creates an authoritative visit", () => {
      repository.observeCanonicalPlacements({
        placementRevision: "shared-234",
        placements: [{ vehicleId: VEHICLE_ID, slot: "8N" }]
      });
      const placement = repository.getReadModel({roles:[ROLE_KEYS.VERKSTED]})
        .placements.find(item=>item.vehicleId === VEHICLE_ID);
      assert.equal(placement.slot, "8N");
      assert.equal(placement.inWorkshop, true);
      assert.match(placement.workshopVisitId, /^workshop-visit\|69-63\|shared-234$/);
    });

    const placement = repository.getReadModel({roles:[ROLE_KEYS.VERKSTED]})
      .placements.find(item=>item.vehicleId === VEHICLE_ID);
    const payload = {
      actionId: uuid(),
      vehicleId: VEHICLE_ID,
      expectedPlacementRevision: "shared-234",
      expectedVisitId: placement.workshopVisitId
    };
    const before = repository.getStorageSnapshot();
    const created = request(repository, payload);

    check("03 verified workshop command creates one active request", () => {
      assert.equal(created.status, 201);
      assert.equal(created.result.vehicleId, VEHICLE_ID);
      assert.equal(created.result.sourceSlot, "8N");
      assert.equal(created.result.status, "REQUESTED");
      assert.equal(created.result.requestedAt, now());
      assert.equal(created.result.requestedBy, workshopAuthority.subject);
      assert.equal(created.result.visitId, placement.workshopVisitId);
      assert.equal(created.result.classification, "UNKNOWN");
    });

    check("04 request creates one command event, two role notifications and one exit event", () => {
      const after = repository.getStorageSnapshot();
      assert.equal(after.counts.events - before.counts.events, 1);
      assert.equal(after.counts.idempotency - before.counts.idempotency, 1);
      assert.equal(after.counts.notifications - before.counts.notifications, 2);
      assert.equal(after.counts.workshopExitRequests - before.counts.workshopExitRequests, 1);
      assert.equal(after.counts.workshopExitEvents - before.counts.workshopExitEvents, 1);
    });

    check("05 TXP and DROPS receive separate prioritized notifications", () => {
      const txp = repository.getReadModel({roles:[ROLE_KEYS.TXP]}).notifications;
      const drops = repository.getReadModel({roles:[ROLE_KEYS.DROPS]}).notifications;
      assert.equal(txp.length, 1);
      assert.equal(drops.length, 1);
      for(const notification of [...txp, ...drops]){
        assert.equal(notification.kind, "WORKSHOP_EXIT_REQUESTED");
        assert.equal(notification.priority, "HIGH");
        assert.equal(notification.payload.exitRequestId, created.result.exitRequestId);
        assert.equal(notification.payload.sourceSlot, "8N");
        assert.equal(notification.payload.visitId, placement.workshopVisitId);
      }
      assert.equal(txp[0].targetRole, ROLE_KEYS.TXP);
      assert.equal(drops[0].targetRole, ROLE_KEYS.DROPS);
    });

    const replay = request(repository, payload);
    check("06 same actionId is an exact idempotent replay", () => {
      assert.equal(replay.status, 200);
      assert.equal(replay.result.idempotentReplay, true);
      assert.equal(replay.result.exitRequestId, created.result.exitRequestId);
    });

    const semanticBefore = repository.getStorageSnapshot();
    const semanticRepeat = request(repository, {...payload, actionId:uuid()});
    check("07 new actionId for same vehicle visit is a write-free semantic replay", () => {
      assert.equal(semanticRepeat.status, 200);
      assert.equal(semanticRepeat.result.alreadyRequested, true);
      assert.equal(semanticRepeat.result.exitRequestId, created.result.exitRequestId);
      assert.deepEqual(repository.getStorageSnapshot().counts, semanticBefore.counts);
    });

    advance(5);
    check("08 canonical exit completes the request without a client write", () => {
      repository.observeCanonicalPlacements({
        placementRevision: "shared-235",
        placements: [{ vehicleId: VEHICLE_ID, slot: "6N" }]
      });
      const exitRequest = repository.getReadModel({roles:[ROLE_KEYS.TXP]})
        .workshopExitRequests.find(item=>item.exitRequestId === created.result.exitRequestId);
      assert.equal(exitRequest.status, "COMPLETED");
      assert.equal(exitRequest.completedAt, now());
      assert.equal(exitRequest.completedPlacementRevision, "shared-235");
      assert.equal(exitRequest.completedSlot, "6N");
    });

    advance(5);
    repository.observeCanonicalPlacements({
      placementRevision: "shared-236",
      placements: [{ vehicleId: VEHICLE_ID, slot: "7S" }]
    });
    const secondPlacement = repository.getReadModel({roles:[ROLE_KEYS.VERKSTED]})
      .placements.find(item=>item.vehicleId === VEHICLE_ID);
    const second = request(repository, {
      actionId:uuid(),
      vehicleId:VEHICLE_ID,
      expectedPlacementRevision:"shared-236",
      expectedVisitId:secondPlacement.workshopVisitId
    });
    check("09 a later workshop visit can create a new request", () => {
      assert.equal(second.status, 201);
      assert.notEqual(second.result.exitRequestId, created.result.exitRequestId);
      assert.notEqual(second.result.visitId, created.result.visitId);
      assert.equal(second.result.sourceSlot, "7S");
    });

    check("10 stale placement and visit facts fail closed", () => {
      const stale = request(repository, {
        actionId:uuid(),
        vehicleId:VEHICLE_ID,
        expectedPlacementRevision:"shared-234",
        expectedVisitId:placement.workshopVisitId
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.error, "workshop_placement_revision_mismatch");
    });

    process.stdout.write(JSON.stringify({
      schemaVersion:"sde-workshop-exit-request-test-v1",
      counts:{passed:passed.length,total:10},
      passed
    }) + "\n");
  }finally{
    db.close();
    for(const suffix of ["", "-wal", "-shm"]){
      fs.rmSync(`${databasePath}${suffix}`, {force:true});
    }
  }
}

main();
