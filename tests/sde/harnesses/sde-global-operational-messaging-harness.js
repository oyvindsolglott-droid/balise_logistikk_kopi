#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const serverNodeModules = process.env.SDE_SERVER_NODE_MODULES
  ? path.resolve(process.env.SDE_SERVER_NODE_MODULES)
  : path.join(root,"server/node_modules");
let express;
try{
  express = require(path.join(serverNodeModules,"express"));
}catch(error){
  if(error?.code !== "MODULE_NOT_FOUND") throw error;
  express = require("express");
}
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
  COMMAND_DEFINITIONS,
  LIFECYCLE_COMMANDS,
  createVehicleStatusLifecycleHandler,
  createVehicleStatusReadHandler,
  normalizeLifecycleCommand,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));
const {ROLE_KEYS} = require(path.join(root,"server/src/identityPolicy.js"));
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
) => {
  const messageId = validAction(normalizedAction++);
  return normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {
      actionId:messageId,
      messageId,
      targetRole,
      message,
      context: {surface: sourceRole, vehicleId: "74-10", slotId: "7N"},
      ...threading,
    },
    {sourceRole}
  );
};

for(const sourceRole of roles){
  for(const targetRole of roles){
    const result = normalize(sourceRole, targetRole);
    if(sourceRole === targetRole){
      assert.equal(result.ok, false, `${sourceRole} must not send to itself`);
      assert.equal(result.error, "message_self_target_forbidden");
    }else{
      assert.equal(result.ok, true, `${sourceRole} -> ${targetRole} must normalize`);
      assert.equal(result.value.sourceRole, sourceRole);
      assert.equal(result.value.messageId,result.value.actionId);
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
      actionId:validAction(999996),
      messageId:validAction(999997),
      targetRole:"txp",
      message:"mismatch",
      context:{surface:"drops"},
    },
    {sourceRole:"drops"}
  ).error,
  "message_id_action_id_mismatch"
);
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
const repositoryVerifiedPairs = [];
for(const sourceRole of roles){
  for(const targetRole of roles.filter(role => role !== sourceRole)){
    const messageId = validAction(action++);
    const normalized = normalizeLifecycleCommand(
      LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      {
        actionId:messageId,
        messageId,
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
    assert.equal(result.result.messageId,messageId);
    assert.equal(result.result.sourceActorSubject,`${sourceRole}-subject`);
    assert.ok(result.result.notificationId);
    assert.ok(result.result.messageRevision);
    const targetReadback = repository.getReadModel({roles: [targetRole]});
    const saved = targetReadback.operationalMessages.at(-1);
    assert.equal(saved.sourceRole, sourceRole);
    assert.equal(saved.sourceActorSubject,`${sourceRole}-subject`);
    assert.equal(saved.targetRole, targetRole);
    assert.equal(saved.message, `${sourceRole} til ${targetRole}`);
    assert.ok(targetReadback.notifications.some(notification =>
      notification.notificationId === result.result.notificationId &&
      notification.targetRole === targetRole &&
      notification.kind === "OPERATIONAL_MESSAGE" &&
      notification.payload?.sourceActorSubject === `${sourceRole}-subject`
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
      sourceActorSubject:`${sourceRole}-subject`,
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
    const persistedBeforeRetry = repository.getReadModel({roles}).operationalMessages.length;
    const replay = repository.executeCommand(
      LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      normalized.value,
      authority
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.result.idempotentReplay, true);
    assert.equal(replay.result.messageId,messageId);
    assert.equal(
      repository.getReadModel({roles}).operationalMessages.length,
      persistedBeforeRetry,
      `${sourceRole} -> ${targetRole} retry must not duplicate`
    );
    repositoryVerifiedPairs.push(`${sourceRole}->${targetRole}`);
  }
}
assert.equal(repositoryVerifiedPairs.length,20);

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

async function verifyServerAuthoritativeHttpDirections(){
  let httpTick = 0;
  let httpUuid = 500000;
  const httpRepository = createVehicleStatusTestRepository({
    db:new DatabaseSync(":memory:"),
    now:()=>`2026-08-24T10:${String(Math.floor(httpTick / 60)).padStart(2,"0")}:${String(httpTick++ % 60).padStart(2,"0")}.000Z`,
    randomUUID:()=>`00000000-0000-4000-8000-${String(httpUuid++).padStart(12,"0")}`,
  });
  const roleKeyByRole = {
    drops:ROLE_KEYS.DROPS,
    txp:ROLE_KEYS.TXP,
    sde_skiftere:ROLE_KEYS.SDE_SKIFTERE,
    verksted:ROLE_KEYS.VERKSTED,
    agila:ROLE_KEYS.AGILA,
  };
  const roleBindingsCatalog = {
    bindings:roles.map(role=>({
      bindingId:`${role}-http-test`,
      subject:`cf-access|${role}`,
      role:roleKeyByRole[role],
      enabled:true,
    })),
  };
  const verifyIdentityRequest = async ({headers})=>{
    const role = String(headers.authorization || "").replace(/^Bearer\s+/i,"");
    if(!roles.includes(role)){
      return {ok:false,status:401,publicError:"authentication_required"};
    }
    return {
      ok:true,
      identity:{
        authenticated:true,
        identityVerified:true,
        identityKind:"human",
        subject:`cf-access|${role}`,
        identitySource:"cloudflare_access_jwt",
      },
    };
  };
  const app = express();
  app.use(express.json({limit:"64kb"}));
  app.post(
    COMMAND_DEFINITIONS[LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE].route,
    createVehicleStatusLifecycleHandler({
      repository:httpRepository,
      commandName:LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      roleBindingsCatalog,
      verifyIdentityRequest,
      isCommandAvailable:()=>true,
      allowedVehicleIds:new Set(["74-10"]),
    })
  );
  app.get("/api/vehicle-status",createVehicleStatusReadHandler({
    repository:httpRepository,
    roleBindingsCatalog,
    verifyIdentityRequest,
  }));
  const server = http.createServer(app);
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const verifiedPairs = [];
  let actionId = 700000;
  try{
    for(const sourceRole of roles){
      for(const targetRole of roles.filter(role=>role !== sourceRole)){
        const messageId = validAction(actionId++);
        const message = `HTTP ${sourceRole} til ${targetRole}`;
        const request = {
          method:"POST",
          headers:{
            Authorization:`Bearer ${sourceRole}`,
            "Content-Type":"application/json",
            Accept:"application/json",
          },
          body:JSON.stringify({
            actionId:messageId,
            messageId,
            targetRole,
            message,
            context:{surface:sourceRole},
          }),
        };
        const response = await fetch(
          `${origin}/api/vehicle-status/commands/send-operational-message/${sourceRole}`,
          request
        );
        const body = await response.json();
        assert.equal(response.status,201,`${sourceRole} -> ${targetRole} HTTP send`);
        assert.equal(body.messageId,messageId);
        assert.equal(body.sourceRole,sourceRole);
        assert.equal(body.targetRole,targetRole);
        assert.equal(body.sourceActorSubject,`cf-access|${sourceRole}`);
        assert.equal(body.threadId,messageId);
        assert.equal(body.rootMessageId,messageId);
        assert.equal(body.parentMessageId,null);

        const retryResponse = await fetch(
          `${origin}/api/vehicle-status/commands/send-operational-message/${sourceRole}`,
          request
        );
        const retryBody = await retryResponse.json();
        assert.equal(retryResponse.status,200);
        assert.equal(retryBody.messageId,messageId);
        assert.equal(retryBody.idempotentReplay,true);

        const receiverResponse = await fetch(`${origin}/api/vehicle-status`,{
          headers:{Authorization:`Bearer ${targetRole}`,Accept:"application/json"},
        });
        const receiver = await receiverResponse.json();
        assert.equal(receiverResponse.status,200);
        const delivered = receiver.operationalMessages.filter(candidate=>
          candidate.messageId === messageId
        );
        assert.equal(delivered.length,1,`${sourceRole} -> ${targetRole} single delivery`);
        assert.deepEqual(
          {
            sourceRole:delivered[0].sourceRole,
            sourceActorSubject:delivered[0].sourceActorSubject,
            targetRole:delivered[0].targetRole,
            message:delivered[0].message,
            threadId:delivered[0].threadId,
            rootMessageId:delivered[0].rootMessageId,
            parentMessageId:delivered[0].parentMessageId,
          },
          {
            sourceRole,
            sourceActorSubject:`cf-access|${sourceRole}`,
            targetRole,
            message,
            threadId:messageId,
            rootMessageId:messageId,
            parentMessageId:null,
          }
        );
        assert.ok(receiver.notifications.some(notification=>
          notification.kind === "OPERATIONAL_MESSAGE" &&
          notification.targetRole === targetRole &&
          notification.payload?.messageId === messageId &&
          notification.payload?.sourceActorSubject === `cf-access|${sourceRole}`
        ));

        const senderResponse = await fetch(`${origin}/api/vehicle-status`,{
          headers:{Authorization:`Bearer ${sourceRole}`,Accept:"application/json"},
        });
        const sender = await senderResponse.json();
        assert.equal(senderResponse.status,200);
        const receipts = sender.operationalMessageReceipts.filter(receipt=>
          receipt.messageId === messageId
        );
        assert.equal(receipts.length,1);
        assert.equal(receipts[0].sourceRole,sourceRole);
        assert.equal(receipts[0].sourceActorSubject,`cf-access|${sourceRole}`);
        assert.equal(receipts[0].targetRole,targetRole);
        verifiedPairs.push(`${sourceRole}->${targetRole}`);
      }
    }
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
  assert.equal(verifiedPairs.length,20);
  assert.equal(new Set(verifiedPairs).size,20);
  return verifiedPairs;
}

verifyServerAuthoritativeHttpDirections().then(verifiedPairs=>{
  console.log(JSON.stringify({
    schemaVersion:"sde-global-operational-messaging-harness-v2",
    directions:20,
    repositoryDirections:repositoryVerifiedPairs.length,
    httpDirections:verifiedPairs.length,
    verifiedPairs,
    capability:"vehicle_status.send_operational_message",
    messageIdDeduplication:true,
    sourceActorSubject:true,
    threadDepth:20,
    roles:roles.length,
    persisted:full.operationalMessages.length,
  }));
}).catch(error=>{
  console.error(error.stack || error);
  process.exitCode=1;
});
