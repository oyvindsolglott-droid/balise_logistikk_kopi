#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const authorizationSource = fs.readFileSync(
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
const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
const frontendSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

const roles = ["drops", "txp", "sde_skiftere", "verksted", "agila"];
const allowedRoleConstants = authorizationSource.match(
  /const OPERATIONAL_MESSAGE_ROLES = Object\.freeze\(\[([\s\S]*?)\]\);/
)?.[1] || "";
for(const role of roles){
  assert.match(
    allowedRoleConstants,
    new RegExp(`ROLE_KEYS\\.${role === "sde_skiftere" ? "SDE_SKIFTERE" : role.toUpperCase()}`),
    `${role} must be an explicit message capability source`
  );
}
assert.doesNotMatch(
  authorizationSource.match(/SEND_OPERATIONAL_MESSAGE[\s\S]*?allowedRoles:\s*\[([\s\S]*?)\]/)?.[1] || "",
  /ADMIN_PILOT/,
  "admin_pilot alone must never grant send capability"
);
for(const token of [
  "requiredEffectiveRole",
  "sourceRole",
  "send-operational-message",
  "OPERATIONAL_MESSAGE",
  "vehicle_status_operational_messages",
  "vehicle_status_operational_message_events",
  "PRAGMA user_version = 6",
]){
  assert.ok(
    `${lifecycleSource}\n${repositorySource}\n${serverSource}`.includes(token),
    `server implementation misses ${token}`
  );
}
for(const token of [
  "data-sde-operational-message-host",
  "data-sde-operational-message-target",
  "data-sde-operational-message-text",
  "getActiveOperationalMessageRole",
  "submitOperationalMessageFromUi",
  "OPERATIONAL_MESSAGE",
]){
  assert.ok(frontendSource.includes(token), `frontend implementation misses ${token}`);
}

const {
  LIFECYCLE_COMMANDS,
  normalizeLifecycleCommand,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));

const validAction = value =>
  `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const normalize = (sourceRole, targetRole, message = "  Sikker <b>tekst</b>  ") =>
  normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {
      actionId: validAction(900000 + roles.indexOf(sourceRole) * 10 + roles.indexOf(targetRole)),
      targetRole,
      message,
      context: {surface: sourceRole, vehicleId: "74-10", slotId: "7N"},
    },
    {sourceRole}
  );

for(const sourceRole of roles){
  for(const targetRole of roles){
    const result = normalize(sourceRole, targetRole);
    if(sourceRole === targetRole){
      assert.equal(result.ok, false, `${sourceRole} must not send to itself`);
      assert.equal(result.error, "message_self_target_forbidden");
    }else{
      assert.equal(result.ok, true, `${sourceRole} -> ${targetRole} must normalize`);
      assert.equal(result.value.sourceRole, sourceRole);
      assert.equal(result.value.targetRole, targetRole);
      assert.equal(result.value.message, "Sikker <b>tekst</b>");
      assert.deepEqual(
        {...result.value.context},
        {surface: sourceRole, vehicleId: "74-10", slotId: "7N"}
      );
    }
  }
}

const controlsRemoved = normalize("drops", "txp", " A\u0000B\u0007C\nD ");
assert.equal(controlsRemoved.ok, true);
assert.equal(controlsRemoved.value.message, "ABCD");
assert.equal(normalize("drops", "txp", " \u0000 ").ok, false);
assert.equal(normalize("drops", "txp", "x".repeat(251)).ok, false);
assert.equal(
  normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {
      actionId: validAction(999998),
      sourceRole: "verksted",
      targetRole: "drops",
      message: "spoof",
      context: {},
    },
    {sourceRole: "txp"}
  ).error,
  "forbidden_request_field"
);

let tick = 0;
let uuid = 1;
const repository = createVehicleStatusTestRepository({
  db: new DatabaseSync(":memory:"),
  now: () => `2026-07-29T08:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}.000Z`,
  randomUUID: () => `00000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`,
});

let action = 1;
for(const sourceRole of roles){
  for(const targetRole of roles.filter(role => role !== sourceRole)){
    const normalized = normalizeLifecycleCommand(
      LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      {
        actionId: validAction(action++),
        targetRole,
        message: `${sourceRole} til ${targetRole}`,
        context: {surface: sourceRole},
      },
      {sourceRole}
    );
    assert.equal(normalized.ok, true);
    const authority = {
      subject: `${sourceRole}-subject`,
      roles: [sourceRole],
      effectiveRole: sourceRole,
      capabilitySourceRoles: [sourceRole],
    };
    const result = repository.executeCommand(
      LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      normalized.value,
      authority
    );
    assert.equal(result.ok, true, `${sourceRole} -> ${targetRole} must persist`);
    assert.equal(result.result.sourceRole, sourceRole);
    const targetReadback = repository.getReadModel({roles: [targetRole]});
    const saved = targetReadback.operationalMessages.at(-1);
    assert.equal(saved.sourceRole, sourceRole);
    assert.equal(saved.targetRole, targetRole);
    assert.equal(saved.message, `${sourceRole} til ${targetRole}`);
    assert.ok(targetReadback.notifications.some(notification =>
      notification.notificationId === result.result.notificationId &&
      notification.targetRole === targetRole &&
      notification.kind === "OPERATIONAL_MESSAGE"
    ));
    for(const otherRole of roles.filter(role => role !== targetRole)){
      assert.equal(
        repository.getReadModel({roles: [otherRole]}).operationalMessages
          .some(message => message.messageId === result.result.messageId),
        false,
        `${otherRole} must not read a message for ${targetRole}`
      );
    }
    const replay = repository.executeCommand(
      LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      normalized.value,
      authority
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.result.idempotentReplay, true);
  }
}

const full = repository.getReadModel({roles});
assert.equal(full.operationalMessages.length, 20);
assert.equal(full.notifications.filter(item => item.kind === "OPERATIONAL_MESSAGE").length, 20);

console.log(JSON.stringify({
  schemaVersion: "sde-global-operational-messaging-harness-v1",
  directions: 20,
  roles: roles.length,
  persisted: full.operationalMessages.length,
}));
