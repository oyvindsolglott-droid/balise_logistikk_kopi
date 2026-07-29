"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));
const {
  LIFECYCLE_COMMANDS,
} = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));

const authority = {
  subject:"workshop-owner-subject",
  effectiveRole:"verksted",
  roles:["verksted"],
  capabilitySourceRoles:["verksted"],
};

let repositorySequence = 0;
function createRepository(placements){
  const db = new DatabaseSync(":memory:");
  let tick = 0;
  let uuid = 1;
  const repository = createVehicleStatusTestRepository({
    db,
    now:() => `2026-07-29T10:${String(repositorySequence).padStart(2, "0")}:${String(tick++).padStart(2, "0")}.000Z`,
    randomUUID:() => `90000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`,
  });
  repositorySequence += 1;
  repository.observeCanonicalPlacements({
    placementRevision:"shared-sporplan:status-independent",
    placements,
  });
  return repository;
}

let actionSequence = 1;
function addIngress(repository,{
  vehicleId,
  targetSlot,
  requestType="ASAP",
  priority=requestType === "ASAP" ? "HIGH" : "NORMAL",
  expectedQueueRevision=0,
}){
  const actionId = `91000000-0000-4000-8000-${String(actionSequence++).padStart(12, "0")}`;
  return repository.executeCommand(
    LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
    {
      actionId,
      payloadHash:`${vehicleId}|${targetSlot}|${requestType}|${actionId}`,
      operation:"ADD",
      targetSlot,
      vehicleId,
      requestType,
      priority,
      queueEntryId:null,
      expectedQueueRevision,
      expectedPlacementRevision:"shared-sporplan:status-independent",
    },
    authority
  );
}

const safeRepository = createRepository([
  {vehicleId:"69-01",slot:"12N"},
]);
const safe = addIngress(safeRepository,{
  vehicleId:"69-01",
  targetSlot:"8N",
});
assert.equal(safe.ok, true);
assert.equal(safe.result.status, "CARD_CREATED");
assert.ok(safe.result.linkedCardId);

const occupiedRepository = createRepository([
  {vehicleId:"70-01",slot:"11N"},
  {vehicleId:"74-54",slot:"7N"},
]);
const occupied = addIngress(occupiedRepository,{
  vehicleId:"70-01",
  targetSlot:"7N",
});
assert.equal(occupied.ok, true);
assert.equal(occupied.result.status, "HIGH_PRIORITY_WAITING_FOR_SLOT");
assert.equal(occupied.result.linkedCardId, null);

const reservedRepository = createRepository([
  {vehicleId:"74-21",slot:"10N"},
  {vehicleId:"75-01",slot:"9"},
]);
const cardOwner = addIngress(reservedRepository,{
  vehicleId:"74-21",
  targetSlot:"8S",
});
assert.equal(cardOwner.ok, true);
assert.equal(cardOwner.result.status, "CARD_CREATED");
const reserved = addIngress(reservedRepository,{
  vehicleId:"75-01",
  targetSlot:"8S",
  expectedQueueRevision:1,
});
assert.equal(reserved.ok, true);
assert.equal(reserved.result.status, "HIGH_PRIORITY_WAITING_FOR_SLOT");
assert.equal(reserved.result.linkedCardId, null);
const reservedQueue = reservedRepository.getReadModel({roles:["verksted"]})
  .workshopIngressQueue.filter(entry=>entry.targetSlot === "8S");
assert.equal(reservedQueue.length, 2);
assert.equal(
  reservedQueue.filter(entry=>entry.status === "CARD_CREATED").length,
  1
);
assert.equal(
  reservedQueue.find(entry=>entry.vehicleId === "75-01")
    .reasonCodes.includes("TARGET_RESERVED_BY_EXISTING_CARD"),
  true
);

const unresolvedRepository = createRepository([]);
const unresolved = addIngress(unresolvedRepository,{
  vehicleId:"74-38",
  targetSlot:"7S",
});
assert.equal(unresolved.ok, true);
assert.equal(unresolved.result.status, "REPLAN_REQUIRED");
assert.equal(unresolved.result.linkedCardId, null);
assert.equal(
  unresolvedRepository.getReadModel({roles:["verksted"]})
    .workshopIngressQueue[0].reasonCodes.includes("SOURCE_SLOT_UNRESOLVED"),
  true
);

const sameSourceRepository = createRepository([
  {vehicleId:"74-38",slot:"8N"},
]);
const sameSource = addIngress(sameSourceRepository,{
  vehicleId:"74-38",
  targetSlot:"8N",
});
assert.equal(sameSource.ok, true);
assert.equal(sameSource.result.status, "REPLAN_REQUIRED");
assert.equal(sameSource.result.linkedCardId, null);

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = open; index < source.length; index += 1){
    const char = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(char === "\\") escaped = true;
      else if(char === quote) quote = "";
      continue;
    }
    if(char === "'" || char === '"' || char === "`"){
      quote = char;
      continue;
    }
    if(char === "{") depth += 1;
    if(char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const actionCenter = extractFunction("buildWorkshopActionCenterHtml");
assert.doesNotMatch(
  actionCenter,
  /if\s*\(activeTargetCardOwner\)\s*validationErrors\.push/,
  "a valid reserved target must be accepted as a waiting ingress request"
);
assert.match(actionCenter, /TARGET_RESERVED|reservert/i);
assert.doesNotMatch(
  actionCenter,
  /currentStatus\s*===|workshopDisposition\s*===|activeFaults\.length/,
  "ingress request readiness must not depend on vehicle lifecycle status"
);
for(const type of ["69","70","74","75"]){
  assert.ok(actionCenter.includes(`"${type}"`));
}

console.log(JSON.stringify({
  schemaVersion:"sde-status-independent-ingress-harness-v1",
  tests:33,
  outcomes:{
    safe:"CARD_CREATED",
    occupied:"HIGH_PRIORITY_WAITING_FOR_SLOT",
    reserved:"HIGH_PRIORITY_WAITING_FOR_SLOT",
    unresolved:"REPLAN_REQUIRED",
    sameSource:"REPLAN_REQUIRED",
  },
}));
