#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const frontendSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const authorizationSource = fs.readFileSync(
  path.join(root, "server/src/runtimeAuthorization.js"),
  "utf8"
);
const repositorySource = fs.readFileSync(
  path.join(root, "server/src/vehicleStatusTestRepository.js"),
  "utf8"
);
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));
const {
  LIFECYCLE_COMMANDS,
  normalizeLifecycleCommand,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));

assert.match(
  authorizationSource,
  /REQUEST_CLEANING_TRACK_SPACE[\s\S]*allowedRoles:\s*\[ROLE_KEYS\.AGILA\]/
);
assert.doesNotMatch(
  authorizationSource.match(
    /REQUEST_CLEANING_TRACK_SPACE[\s\S]*?allowedRoles:\s*\[([\s\S]*?)\]/
  )?.[1] || "",
  /ADMIN_PILOT/
);
for(const token of [
  "vehicle_status_cleaning_track_space_requests",
  "CLEANING_TRACK_SPACE_REQUESTED",
  "Europe/Oslo",
  "5S",
  "5M",
  "10S",
  "10N",
]){
  assert.ok(repositorySource.includes(token), `repository misses ${token}`);
}
for(const token of [
  "Direktemeldinger fra Agilia",
  "Bestilling av sporplass til hovedrenhold",
  "Bestill sporplass",
  "data-sde-agilia-cleaning-slot",
  "data-sde-agilia-cleaning-date",
  "data-sde-agilia-cleaning-time",
  "data-sde-agilia-cleaning-short-notice",
]){
  assert.ok(frontendSource.includes(token), `Agilia UI misses ${token}`);
}

let tick = 0;
let uuid = 1;
const db = new DatabaseSync(":memory:");
const repository = createVehicleStatusTestRepository({
  db,
  now: () => `2026-07-29T08:00:${String(tick++).padStart(2, "0")}.000Z`,
  randomUUID: () =>
    `00000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`,
});
assert.equal(db.prepare("PRAGMA user_version").get().user_version, 10);

const agiliaAuthority = {
  subject: "agilia-authority-test",
  effectiveRole: "agila",
  roles: ["agila"],
  capabilitySourceRoles: ["agila"],
};
const normalizeRequest = ({
  actionId,
  requestedSlots,
  requestedDate,
  startTime,
  shortNoticeAcknowledged,
}) => normalizeLifecycleCommand(
  LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
  {
    actionId,
    requestedSlots,
    requestedDate,
    startTime,
    shortNoticeAcknowledged,
  }
);

const normalized = normalizeRequest({
  actionId: "20000000-0000-4000-8000-000000000001",
  requestedSlots: ["5S", "10N"],
  requestedDate: "2026-07-30",
  startTime: "12:30",
  shortNoticeAcknowledged: false,
});
assert.equal(normalized.ok, true);
const created = repository.executeCommand(
  LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
  normalized.value,
  agiliaAuthority
);
assert.equal(created.ok, true);
assert.equal(created.status, 201);
assert.equal(created.result.status, "REQUESTED");
assert.deepEqual(created.result.requestedSlots, ["5S", "10N"]);
assert.equal(created.result.timeZone, "Europe/Oslo");
assert.equal(created.result.shortNotice, false);
assert.ok(created.result.cleaningRequestId);

const replay = repository.executeCommand(
  LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
  normalized.value,
  agiliaAuthority
);
assert.equal(replay.ok, true);
assert.equal(replay.status, 200);
assert.equal(replay.result.idempotentReplay, true);
assert.equal(replay.result.cleaningRequestId, created.result.cleaningRequestId);

const shortNotice = normalizeRequest({
  actionId: "20000000-0000-4000-8000-000000000002",
  requestedSlots: ["5M"],
  requestedDate: "2026-07-29",
  startTime: "11:00",
  shortNoticeAcknowledged: false,
});
assert.equal(shortNotice.ok, true);
const shortRejected = repository.executeCommand(
  LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
  shortNotice.value,
  agiliaAuthority
);
assert.equal(shortRejected.ok, false);
assert.equal(
  shortRejected.error,
  "cleaning_short_notice_acknowledgement_required"
);

const shortAcknowledged = normalizeRequest({
  actionId: "20000000-0000-4000-8000-000000000003",
  requestedSlots: ["5M"],
  requestedDate: "2026-07-29",
  startTime: "11:00",
  shortNoticeAcknowledged: true,
});
const shortCreated = repository.executeCommand(
  LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
  shortAcknowledged.value,
  agiliaAuthority
);
assert.equal(shortCreated.ok, true);
assert.equal(shortCreated.result.shortNotice, true);
assert.equal(shortCreated.result.shortNoticeAcknowledged, true);

assert.equal(normalizeRequest({
  actionId: "20000000-0000-4000-8000-000000000004",
  requestedSlots: ["8N"],
  requestedDate: "2026-07-30",
  startTime: "12:30",
  shortNoticeAcknowledged: false,
}).error, "invalid_cleaning_target_slot");
assert.equal(normalizeRequest({
  actionId: "20000000-0000-4000-8000-000000000005",
  requestedSlots: ["5S", "5S"],
  requestedDate: "2026-07-30",
  startTime: "12:30",
  shortNoticeAcknowledged: false,
}).error, "duplicate_cleaning_target_slot");

const agiliaReadback = repository.getReadModel({roles: ["agila"]});
assert.equal(agiliaReadback.cleaningTrackSpaceRequests.length, 2);
assert.deepEqual(
  agiliaReadback.cleaningTrackSpaceRequests.map(item => item.requestedSlots),
  [["5S", "10N"], ["5M"]]
);
const txpReadback = repository.getReadModel({roles: ["txp"]});
assert.equal(txpReadback.cleaningTrackSpaceRequests.length, 0);
assert.equal(
  txpReadback.notifications.filter(item =>
    item.kind === "CLEANING_TRACK_SPACE_REQUESTED"
  ).length,
  2
);
const dropsReadback = repository.getReadModel({roles: ["drops"]});
assert.equal(
  dropsReadback.notifications.filter(item =>
    item.kind === "CLEANING_TRACK_SPACE_REQUESTED"
  ).length,
  2
);

console.log(JSON.stringify({
  schemaVersion: "sde-agilia-cleaning-request-harness-v1",
  schemaUserVersion: 10,
  requests: agiliaReadback.cleaningTrackSpaceRequests.length,
  requestedSlots: agiliaReadback.cleaningTrackSpaceRequests.map(item => item.requestedSlots),
  txpNotifications: 2,
  dropsNotifications: 2,
}));
