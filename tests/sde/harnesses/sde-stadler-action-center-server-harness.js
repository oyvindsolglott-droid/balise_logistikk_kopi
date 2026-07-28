"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const runtimeAuthorization = fs.readFileSync(
  path.join(root, "server/src/runtimeAuthorization.js"),
  "utf8"
);
const lifecycleSource = fs.readFileSync(
  path.join(root, "server/src/vehicleStatusLifecycle.js"),
  "utf8"
);
const repositorySource = fs.readFileSync(
  path.join(root, "server/src/vehicleStatusTestRepository.js"),
  "utf8"
);

for(const token of [
  "vehicle_status.manage_workshop_ingress_queue",
  "vehicle_status.send_workshop_message",
]){
  assert.ok(runtimeAuthorization.includes(token), `missing capability ${token}`);
}
assert.match(
  runtimeAuthorization,
  /MANAGE_WORKSHOP_INGRESS_QUEUE[\s\S]*allowedRoles:\s*\[ROLE_KEYS\.VERKSTED\]/
);
assert.match(
  runtimeAuthorization,
  /SEND_WORKSHOP_MESSAGE[\s\S]*allowedRoles:\s*\[ROLE_KEYS\.VERKSTED\]/
);

for(const token of [
  "manage_workshop_ingress_queue",
  "send_workshop_message",
  "/api/vehicle-status/commands/manage-workshop-ingress-queue",
  "/api/vehicle-status/commands/send-workshop-message",
  "expectedQueueRevision",
  "expectedPlacementRevision",
  "targetRole",
  "message",
]){
  assert.ok(lifecycleSource.includes(token), `lifecycle misses ${token}`);
}

for(const token of [
  "vehicle_status_workshop_ingress_queue",
  "vehicle_status_workshop_ingress_queue_events",
  "vehicle_status_workshop_messages",
  "vehicle_status_workshop_message_events",
  "READY_FOR_ACTIVATION",
  "ACTIVATING",
  "CARD_CREATED",
  "REPLAN_REQUIRED",
  "activateWorkshopIngressQueueForEmptySlots",
]){
  assert.ok(repositorySource.includes(token), `repository misses ${token}`);
}
assert.match(repositorySource, /PRAGMA user_version = 5/);

const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));
const {
  LIFECYCLE_COMMANDS,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));

let tick = 0;
const db = new DatabaseSync(":memory:");
const repository = createVehicleStatusTestRepository({
  db,
  now: () => `2026-07-28T08:00:${String(tick++).padStart(2, "0")}.000Z`,
  randomUUID: (() => {
    let value = 1;
    return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
  })(),
});
const authority = {
  subject: "workshop-test-subject",
  effectiveRole: "verksted",
  roles: ["verksted"],
  capabilitySourceRoles: ["verksted"],
};

repository.observeCanonicalPlacements({
  placementRevision: "shared-sporplan:1",
  placements: [
    {vehicleId: "74-54", slot: "7N"},
    {vehicleId: "74-07", slot: "7S"},
    {vehicleId: "74-21", slot: "10N"},
  ],
});

const add = repository.executeCommand(
  LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
  {
    actionId: "10000000-0000-4000-8000-000000000001",
    payloadHash: "add-74-21-7n",
    operation: "ADD",
    targetSlot: "7N",
    vehicleId: "74-21",
    queueEntryId: null,
    expectedQueueRevision: 0,
    expectedPlacementRevision: "shared-sporplan:1",
  },
  authority
);
assert.equal(add.ok, true);
assert.equal(add.result.status, "QUEUED");
assert.equal(add.result.position, 1);

const duplicateAcrossSlots = repository.executeCommand(
  LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
  {
    actionId: "10000000-0000-4000-8000-000000000010",
    payloadHash: "duplicate-74-21-other-slot",
    operation: "ADD",
    targetSlot: "8N",
    vehicleId: "74-21",
    queueEntryId: null,
    expectedQueueRevision: 0,
    expectedPlacementRevision: "shared-sporplan:1",
  },
  authority
);
assert.equal(duplicateAcrossSlots.ok, false);
assert.equal(duplicateAcrossSlots.error, "workshop_queue_duplicate");

const exitBefore = repository.getReadModel({roles: ["verksted"]});
const placementBefore = exitBefore.placements.find(item => item.vehicleId === "74-07");
assert.ok(placementBefore?.placementRevision);
assert.ok(placementBefore?.workshopVisitId);
const stateBeforeExit = JSON.stringify({
  item: exitBefore.items.find(item => item.vehicleId === "74-07") || null,
  faults: exitBefore.faults.filter(item => item.vehicleId === "74-07"),
  repairRequests: exitBefore.repairRequests.filter(item => item.vehicleId === "74-07"),
  placement: placementBefore,
});
const exitRequest = repository.executeCommand(
  LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT,
  {
    actionId: "10000000-0000-4000-8000-000000000011",
    payloadHash: "exit-74-07-7s",
    vehicleId: "74-07",
    expectedPlacementRevision: placementBefore.placementRevision,
    expectedVisitId: placementBefore.workshopVisitId,
  },
  authority
);
assert.equal(exitRequest.ok, true);
assert.equal(exitRequest.result.sourceSlot, "7S");
const exitAfter = repository.getReadModel({roles: ["verksted"]});
assert.equal(exitAfter.workshopExitRequests.filter(item => item.vehicleId === "74-07").length, 1);
assert.equal(JSON.stringify({
  item: exitAfter.items.find(item => item.vehicleId === "74-07") || null,
  faults: exitAfter.faults.filter(item => item.vehicleId === "74-07"),
  repairRequests: exitAfter.repairRequests.filter(item => item.vehicleId === "74-07"),
  placement: exitAfter.placements.find(item => item.vehicleId === "74-07"),
}), stateBeforeExit);

repository.observeCanonicalPlacements({
  placementRevision: "shared-sporplan:2",
  placements: [
    {vehicleId: "74-54", slot: "9"},
    {vehicleId: "74-07", slot: "7S"},
    {vehicleId: "74-21", slot: "10N"},
  ],
});
let readback = repository.getReadModel({roles: ["verksted"]});
let queueEntry = readback.workshopIngressQueue.find(entry => entry.vehicleId === "74-21");
assert.equal(queueEntry.status, "CARD_CREATED");
assert.equal(queueEntry.targetSlot, "7N");
assert.ok(queueEntry.linkedCardId);
assert.equal(readback.workshopIngressQueue.filter(entry => entry.status === "CARD_CREATED").length, 1);

repository.observeCanonicalPlacements({
  placementRevision: "shared-sporplan:3",
  placements: [
    {vehicleId: "74-12", slot: "7N"},
    {vehicleId: "74-07", slot: "7S"},
    {vehicleId: "74-21", slot: "10N"},
  ],
});
readback = repository.getReadModel({roles: ["verksted"]});
queueEntry = readback.workshopIngressQueue.find(entry => entry.vehicleId === "74-21");
assert.equal(queueEntry.status, "REPLAN_REQUIRED");
assert.equal(queueEntry.linkedCardId, null);

const message = repository.executeCommand(
  LIFECYCLE_COMMANDS.SEND_WORKSHOP_MESSAGE,
  {
    actionId: "10000000-0000-4000-8000-000000000002",
    payloadHash: "message-drops",
    targetRole: "drops",
    message: "<b>Kontroller 74-21</b>",
    selectedSlotId: "7N",
    selectedVehicleId: "74-12",
  },
  authority
);
assert.equal(message.ok, true);
assert.equal(message.result.targetRole, "drops");
readback = repository.getReadModel({roles: ["drops"]});
assert.equal(readback.workshopMessages.length, 1);
assert.equal(readback.workshopMessages[0].message, "<b>Kontroller 74-21</b>");
assert.equal(readback.workshopMessages[0].selectedSlotId, "7N");
assert.equal(readback.workshopMessages[0].selectedVehicleId, "74-12");
assert.equal(readback.notifications.filter(item => item.kind === "WORKSHOP_MESSAGE").length, 1);
assert.equal(readback.notifications.find(item => item.kind === "WORKSHOP_MESSAGE").payload.selectedSlotId, "7N");
assert.equal(readback.notifications.find(item => item.kind === "WORKSHOP_MESSAGE").payload.selectedVehicleId, "74-12");
assert.equal(repository.getReadModel({roles: ["txp"]}).workshopMessages.length, 0);

const replay = repository.executeCommand(
  LIFECYCLE_COMMANDS.SEND_WORKSHOP_MESSAGE,
  {
    actionId: "10000000-0000-4000-8000-000000000002",
    payloadHash: "message-drops",
    targetRole: "drops",
    message: "<b>Kontroller 74-21</b>",
    selectedSlotId: "7N",
    selectedVehicleId: "74-12",
  },
  authority
);
assert.equal(replay.ok, true);
assert.equal(replay.result.idempotentReplay, true);
assert.equal(repository.getReadModel({roles: ["drops"]}).workshopMessages.length, 1);

console.log(JSON.stringify({
  schemaVersion: "sde-global-update-stadler-action-center-server-harness-v2",
  tests: 55,
  queueStatus: queueEntry.status,
  messageCount: 1,
}));
