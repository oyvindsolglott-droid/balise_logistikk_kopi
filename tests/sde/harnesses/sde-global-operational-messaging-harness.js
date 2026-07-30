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
  "PRAGMA user_version = 10",
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
  "waitForOperationalMessageReceipt",
  "data-sde-operational-message-thread",
  "data-sde-operational-message-reply",
  "threadId",
  "rootMessageId",
  "parentMessageId",
  "Beskjeden er mottatt av serveren. Venter på autoritativ bekreftelse",
  "OPERATIONAL_MESSAGE",
  "isSuccessfulLifecycleCommandBody",
]){
  assert.ok(frontendSource.includes(token), `frontend implementation misses ${token}`);
}
const postCommand = frontendSource.match(
  /async function postWorkshopActionCenterCommand\([\s\S]*?\n\}/
)?.[0] || "";
const submitMessage = frontendSource.match(
  /async function submitOperationalMessageFromUi\([\s\S]*?\n\}/
)?.[0] || "";
assert.ok(postCommand, "postWorkshopActionCenterCommand must exist");
assert.ok(submitMessage, "submitOperationalMessageFromUi must exist");
assert.doesNotMatch(
  postCommand,
  /body\?\.ok\s*!==\s*true/,
  "a successful lifecycle response has no top-level ok field"
);
assert.doesNotMatch(
  submitMessage,
  /result\?\.body\?\.ok\s*!==\s*true/,
  "message acceptance must use HTTP success and messageId"
);

const {
  LIFECYCLE_COMMANDS,
  normalizeLifecycleCommand,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));

const validAction = value =>
  `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
let normalizedAction = 900000;
const normalize = (
  sourceRole,
  targetRole,
  message = "  Sikker <b>tekst</b>  ",
  threading = {},
) =>
  normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {
      actionId: validAction(normalizedAction++),
      targetRole,
      message,
      context: {surface: sourceRole, vehicleId: "74-10", slotId: "7N"},
      ...threading,
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
      assert.equal(result.value.threadId,null);
      assert.equal(result.value.rootMessageId,null);
      assert.equal(result.value.parentMessageId,null);
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
    assert.ok(result.result.messageId);
    assert.ok(result.result.notificationId);
    assert.ok(result.result.messageRevision);
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
    const senderReadback = repository.getReadModel({roles: [sourceRole]});
    const receipt = senderReadback.operationalMessageReceipts.find(candidate =>
      candidate.messageId === result.result.messageId
    );
    assert.deepEqual(receipt, {
      messageId: result.result.messageId,
      notificationId: result.result.notificationId,
      messageRevision: result.result.messageRevision,
      sourceRole,
      targetRole,
      sentAt: result.result.createdAt,
    });
    for(const otherRole of roles.filter(role =>
      role !== targetRole && role !== sourceRole
    )){
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

// One root plus twenty alternating replies prove that deep threads never flatten.
const rootNormalized = normalize("drops","txp","Rotmelding");
assert.equal(rootNormalized.ok,true);
const dropsAuthority = {
  subject:"drops-subject",
  roles:["drops"],
  effectiveRole:"drops",
  capabilitySourceRoles:["drops"],
};
const txpAuthority = {
  subject:"txp-subject",
  roles:["txp"],
  effectiveRole:"txp",
  capabilitySourceRoles:["txp"],
};
const rootResult = repository.executeCommand(
  LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
  rootNormalized.value,
  dropsAuthority,
);
assert.equal(rootResult.ok,true);
assert.equal(rootResult.result.messageId,rootResult.result.rootMessageId);
assert.equal(rootResult.result.messageId,rootResult.result.threadId);
assert.equal(rootResult.result.parentMessageId,null);
let parentMessageId = rootResult.result.messageId;
for(let depth = 1; depth <= 20; depth += 1){
  const sourceRole = depth % 2 ? "txp" : "drops";
  const targetRole = sourceRole === "txp" ? "drops" : "txp";
  const normalized = normalize(
    sourceRole,
    targetRole,
    `Svar ${depth}`,
    {
      threadId:rootResult.result.threadId,
      rootMessageId:rootResult.result.rootMessageId,
      parentMessageId,
    },
  );
  assert.equal(normalized.ok,true,`reply ${depth} must normalize`);
  const reply = repository.executeCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    normalized.value,
    sourceRole === "txp" ? txpAuthority : dropsAuthority,
  );
  assert.equal(reply.ok,true,`reply ${depth} must persist`);
  assert.equal(reply.result.threadId,rootResult.result.threadId);
  assert.equal(reply.result.rootMessageId,rootResult.result.rootMessageId);
  assert.equal(reply.result.parentMessageId,parentMessageId);
  parentMessageId = reply.result.messageId;
}
const threadedReadback = repository.getReadModel({roles:["drops"]});
const thread = threadedReadback.operationalMessages
  .filter(message=>message.threadId === rootResult.result.threadId);
assert.equal(thread.length,21);
assert.equal(thread[0].depth,0);
assert.equal(thread.at(-1).depth,20);
assert.equal(thread.at(-1).parentMessageId,thread.at(-2).messageId);
assert.ok(thread.every(message=>
  Object.hasOwn(message,"presentedAt") &&
  Object.hasOwn(message,"acknowledgedAt") &&
  ["sent","presented","acknowledged"].includes(message.deliveryState)
));

const full = repository.getReadModel({roles});
assert.equal(full.operationalMessages.length, 41);
assert.equal(full.notifications.filter(item => item.kind === "OPERATIONAL_MESSAGE").length, 41);
assert.match(
  frontendSource,
  /waitForOperationalMessageReceipt[\s\S]*method:"GET"[\s\S]*cache:"no-store"/
);
assert.match(
  frontendSource,
  /submitOperationalMessageFromUi[\s\S]*postWorkshopActionCenterCommand[\s\S]*waitForOperationalMessageReceipt/
);

console.log(JSON.stringify({
  schemaVersion: "sde-global-operational-messaging-harness-v1",
  directions: 20,
  threadDepth:20,
  roles: roles.length,
  persisted: full.operationalMessages.length,
}));
