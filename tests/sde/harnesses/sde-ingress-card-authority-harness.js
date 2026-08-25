#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const frontendSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const repositorySource = fs.readFileSync(
  path.join(root, "server/src/vehicleStatusTestRepository.js"),
  "utf8"
);
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));
const {
  LIFECYCLE_COMMANDS,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));

assert.match(repositorySource, /PRAGMA user_version = 12/);
assert.match(
  repositorySource,
  /CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_ingress_card_per_target[\s\S]*ON[\s\S]*\(target_slot\)[\s\S]*ACTIVATING[\s\S]*CARD_CREATED/
);
for(const token of [
  "TARGET_RESERVED_BY_EXISTING_CARD",
  "activeWorkshopIngressCardOwner",
  "reconcileWorkshopIngressCardOwnership",
]){
  assert.ok(repositorySource.includes(token), `repository misses ${token}`);
}

for(const token of [
  "Bestill innkjøring",
  "Legg i kø, innkjøring",
  "waitForWorkshopIngressQueueReceipt",
  "commandAccepted",
  "readbackConfirmed",
  "TARGET_RESERVED_BY_EXISTING_CARD",
]){
  assert.ok(frontendSource.includes(token), `frontend misses ${token}`);
}
assert.equal(frontendSource.includes("Forhåndsbestill innkjøring"), false);
assert.equal(frontendSource.includes("Forhåndsbestilling av innkjøring"), false);

let tick = 0;
let uuid = 1;
const db = new DatabaseSync(":memory:");
const repository = createVehicleStatusTestRepository({
  db,
  now: () => `2026-07-29T08:00:${String(tick++).padStart(2, "0")}.000Z`,
  randomUUID: () =>
    `00000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`,
});
const authority = {
  subject: "workshop-authority-test",
  effectiveRole: "verksted",
  roles: ["verksted"],
  capabilitySourceRoles: ["verksted"],
};

repository.observeCanonicalPlacements({
  placementRevision: "shared-sporplan:246",
  placements: [
    {vehicleId: "74-23", slot: "5N"},
    {vehicleId: "74-38", slot: "3S"},
  ],
});

const first = repository.executeCommand(
  LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
  {
    actionId: "10000000-0000-4000-8000-000000000001",
    payloadHash: "prebooked-74-23-8n",
    operation: "ADD",
    targetSlot: "8N",
    vehicleId: "74-23",
    requestType: "PREBOOKED",
    priority: "NORMAL",
    queueEntryId: null,
    expectedQueueRevision: 0,
    expectedPlacementRevision: "shared-sporplan:246",
  },
  authority
);
assert.equal(first.ok, true);
assert.equal(first.result.status, "CARD_CREATED");

const second = repository.executeCommand(
  LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
  {
    actionId: "10000000-0000-4000-8000-000000000002",
    payloadHash: "asap-74-38-8n",
    operation: "ADD",
    targetSlot: "8N",
    vehicleId: "74-38",
    requestType: "ASAP",
    priority: "HIGH",
    queueEntryId: null,
    expectedQueueRevision: first.result.queueRevision,
    expectedPlacementRevision: "shared-sporplan:246",
  },
  authority
);
assert.equal(second.ok, true);
assert.equal(second.result.status, "HIGH_PRIORITY_WAITING_FOR_SLOT");
assert.equal(second.result.linkedCardId, null);

const readback = repository.getReadModel({roles: ["verksted"]});
const activeOwners = readback.workshopIngressQueue.filter(entry =>
  entry.targetSlot === "8N" &&
  ["ACTIVATING", "CARD_CREATED"].includes(entry.status)
);
assert.equal(activeOwners.length, 1);
assert.equal(activeOwners[0].vehicleId, "74-23");
assert.equal(
  readback.workshopIngressQueue.find(entry => entry.vehicleId === "74-38").status,
  "HIGH_PRIORITY_WAITING_FOR_SLOT"
);
assert.equal(
  readback.workshopIngressQueue
    .find(entry => entry.vehicleId === "74-38")
    .reasonCodes.includes("TARGET_RESERVED_BY_EXISTING_CARD"),
  true
);

console.log(JSON.stringify({
  schemaVersion: "sde-ingress-card-authority-harness-v1",
  targetSlot: "8N",
  activeCardOwners: activeOwners.length,
  ownerVehicleId: activeOwners[0].vehicleId,
  waitingVehicleId: "74-38",
}));
