#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const frontend = fs.readFileSync(path.join(root, "index.html"), "utf8");
const lifecycle = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));
const authorization = require(path.join(root, "server/src/runtimeAuthorization.js"));
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));

assert.equal(
  lifecycle.LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
  "acknowledge_operational_message"
);
assert.equal(
  authorization.CAPABILITY_IDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
  "vehicle_status.acknowledge_operational_message"
);

let tick = 0;
let uuid = 1;
const repository = createVehicleStatusTestRepository({
  db:new DatabaseSync(":memory:"),
  now:() => `2026-07-29T16:00:${String(tick++).padStart(2, "0")}.000Z`,
  randomUUID:() => `91000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`,
});
const sender = {
  subject:"sender",
  effectiveRole:"verksted",
  roles:["verksted"],
  capabilitySourceRoles:["verksted"],
};
const receiver = {
  subject:"receiver",
  effectiveRole:"drops",
  roles:["drops"],
  capabilitySourceRoles:["drops"],
};
const sent = repository.executeCommand(
  lifecycle.LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
  {
    actionId:"92000000-0000-4000-8000-000000000001",
    payloadHash:"send",
    vehicleId:"OPERATIONAL_MESSAGE",
    sourceRole:"verksted",
    targetRole:"drops",
    message:"Kontroller 74-38",
    context:{surface:"verksted",vehicleId:"74-38",slotId:"3S"},
  },
  sender
);
assert.equal(sent.ok,true);
const acknowledgementInput = {
  actionId:"92000000-0000-4000-8000-000000000002",
  payloadHash:"ack",
  vehicleId:"OPERATIONAL_MESSAGE",
  messageId:sent.result.messageId,
  notificationId:sent.result.notificationId,
};
const acknowledged = repository.executeCommand(
  lifecycle.LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
  acknowledgementInput,
  receiver
);
assert.equal(acknowledged.ok,true);
assert.ok(acknowledged.result.acknowledgedAt);
const replay = repository.executeCommand(
  lifecycle.LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
  acknowledgementInput,
  receiver
);
assert.equal(replay.ok,true);
assert.equal(replay.result.idempotentReplay,true);
const readback = repository.getReadModel({roles:["drops"]});
assert.equal(readback.operationalMessageAcknowledgements.length,1);
assert.equal(
  readback.notifications.find(item=>item.notificationId === sent.result.notificationId)
    .acknowledgedAt,
  acknowledged.result.acknowledgedAt
);

for(const token of [
  "data-sde-acknowledge-operational-message",
  "Kvitter mottatt",
  "Kvittert mottatt",
  "resolveOperationalMessageDeepLink",
  "acknowledgeOperationalMessageFromUi",
]){
  assert.ok(frontend.includes(token),`frontend misses ${token}`);
}
assert.doesNotMatch(
  frontend.match(/function resolveOperationalMessageDeepLink[\s\S]*?\n\}/)?.[0] || "",
  /https?:|javascript:|payload\?\.url/
);

console.log(JSON.stringify({
  schemaVersion:"sde-operational-message-acknowledgement-harness-v1",
  tests:18,
  acknowledgementCount:readback.operationalMessageAcknowledgements.length,
}));
