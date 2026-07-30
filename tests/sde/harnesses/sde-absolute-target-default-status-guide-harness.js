#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const signature = source.slice(start).match(/\)\s*\{/);
  assert.ok(signature, `missing body for ${name}`);
  const open = start + signature.index + signature[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = open; index < source.length; index += 1){
    const character = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(character === "\\") escaped = true;
      else if(character === quote) quote = "";
      continue;
    }
    if(character === "'" || character === '"' || character === "`"){
      quote = character;
      continue;
    }
    if(character === "{") depth += 1;
    if(character === "}" && --depth === 0) return source.slice(start,index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

// A — every selectable target must pass one absolute, revision-aware safety gate.
for(const name of [
  "evaluateSdeAbsoluteTargetSlotSafety",
  "isSdeAbsoluteTargetSlotEligible",
  "revalidateSdeAbsoluteTargetBeforeAction",
]){
  assert.ok(source.includes(`function ${name}(`),`missing central target invariant ${name}`);
}
const absoluteSafety = extractFunction("evaluateSdeAbsoluteTargetSlotSafety");
for(const token of [
  "placementRevision",
  "TARGET_OCCUPIED",
  "TARGET_RESERVED_BY_EXISTING_CARD",
  "targetVehicle",
  "reservationOwnerCardId",
]){
  assert.ok(absoluteSafety.includes(token),`absolute safety misses ${token}`);
}
for(const name of [
  "getSdeBestResolutionTarget",
  "buildSdeManualOverrideCandidateSlots",
  "buildSdeShiftCardMoveCandidates",
]){
  const body = extractFunction(name);
  assert.ok(
    body.includes("isSdeAbsoluteTargetSlotEligible"),
    `${name} must filter through the absolute target invariant`,
  );
  const filterAt = body.indexOf("isSdeAbsoluteTargetSlotEligible");
  const scoreAt = Math.min(
    ...["scoreSdeResolutionTarget","scoreSdeArrivalParkingCandidate"]
      .map(token=>body.indexOf(token))
      .filter(index=>index >= 0),
  );
  if(Number.isFinite(scoreAt)){
    assert.ok(filterAt < scoreAt,`${name} must filter before scoring`);
  }
}
const actionRevalidation = extractFunction("revalidateSdeAbsoluteTargetBeforeAction");
assert.match(actionRevalidation,/REPLAN_REQUIRED/);
assert.match(actionRevalidation,/release|reservasjon/i);
assert.match(actionRevalidation,/placementRevision/);

// B — a missing record is effective DRIFTSKLAR without creating a status record.
const presentationSource = extractFunction("getAuthoritativeVehicleStatusPresentation");
const statusContext = {
  getDropsVehicleStatusRecord:(readback,vehicleId)=>
    (readback?.items || []).find(item=>item.vehicleId === vehicleId) || null,
};
vm.createContext(statusContext);
vm.runInContext(`${presentationSource}; this.present=getAuthoritativeVehicleStatusPresentation;`,statusContext);
const missing = statusContext.present({items:[],faults:[],repairRequests:[]},"74-10");
assert.equal(missing.kind,"operational");
assert.equal(missing.effectiveStatus,"DRIFTSKLAR");
assert.equal(missing.explicitStatus,false);
assert.equal(missing.defaultOperational,true);
assert.match(missing.className,/is-operational/);
assert.equal(missing.label,"DRIFTSKLAR");
assert.equal(missing.record,null,"default semantics must not synthesize an authoritative record");
const explicitRed = statusContext.present({
  items:[{vehicleId:"74-10",currentStatus:"IKKE_DRIFTSKLAR"}],
  faults:[],
  repairRequests:[],
},"74-10");
assert.equal(explicitRed.kind,"not-operational");
assert.equal(explicitRed.explicitStatus,true);
const turning = statusContext.present({
  items:[{vehicleId:"74-10",currentStatus:null,workshopDisposition:"TIL_DREI"}],
  faults:[],
  repairRequests:[],
},"74-10");
assert.equal(turning.kind,"operational");
assert.equal(turning.dispositionLabel,"Drei");
assert.equal(turning.dispositionClassName,"is-turning");
assert.match(turning.className,/is-operational/);
const repair = statusContext.present({
  items:[{vehicleId:"74-10",currentStatus:null,workshopDisposition:"TIL_REP"}],
  faults:[],
  repairRequests:[],
},"74-10");
assert.equal(repair.dispositionClassName,"is-repair");
assert.equal(repair.kind,"operational");

const frameSource = extractFunction("getSporplanVehicleStatusFrameClass");
const framePresentationsSource = extractFunction("getSporplanVehicleStatusPresentations");
const frameContext = {
  getDropsVehicleStatusRecord:(readback,vehicleId)=>
    (readback?.items || []).find(item=>item.vehicleId === vehicleId) || null,
  splitVehicleList:value=>String(value || "").split(/\s*,\s*/),
  normalizeVehicleToken:value=>String(value || "").trim(),
};
vm.createContext(frameContext);
vm.runInContext(`
  ${presentationSource}
  ${framePresentationsSource}
  ${frameSource}
  this.frame=getSporplanVehicleStatusFrameClass;
`,frameContext);
assert.equal(frameContext.frame({items:[]},"74-10"),"sporplan-status-operational");
assert.equal(frameContext.frame({
  items:[{vehicleId:"74-10",currentStatus:"IKKE_DRIFTSKLAR"}],
},"74-10"),"sporplan-status-not-operational");

// D — one pure capability model must remove unauthorized guide detail from the DOM model.
for(const name of [
  "getSdeGuideCapabilityModel",
  "buildSdeRoleGuideEntries",
  "renderSdeRoleGuide",
]){
  assert.ok(source.includes(`function ${name}(`),`missing guide function ${name}`);
}
const guideContext = {};
vm.createContext(guideContext);
vm.runInContext(`
  ${extractFunction("getSdeGuideCapabilityModel")}
  ${extractFunction("buildSdeRoleGuideEntries")}
  this.model=getSdeGuideCapabilityModel;
  this.entries=buildSdeRoleGuideEntries;
`,guideContext);
const expected = {
  "0":["overview","txp","sde","drops","verksted","agila","collaboration"],
  "1":["drops","collaboration"],
  "2":["txp","collaboration"],
  "3":["sde","collaboration"],
  "4":["verksted","collaboration"],
  "5":["agila","collaboration"],
};
for(const [level,allowed] of Object.entries(expected)){
  const capabilityModel = guideContext.model(level);
  const entries = guideContext.entries(capabilityModel);
  assert.deepEqual(
    Array.from(entries,key=>String(key.id)),
    allowed,
    `level ${level} must receive only authorized guide entries`,
  );
}
const guideRenderer = extractFunction("renderSdeRoleGuide");
assert.match(guideRenderer,/replaceChildren/);
assert.match(guideRenderer,/data-sde-guide-search/);
assert.match(guideRenderer,/details/);
assert.match(guideRenderer,/GUIDE_ALLOWED_TABS/);
assert.doesNotMatch(guideRenderer,/202[0-9]-[0-9]{2}-[0-9]{2}/);
assert.doesNotMatch(guideRenderer,/fetch\(|localStorage\.setItem|sessionStorage\.setItem/);

console.log(JSON.stringify({
  schemaVersion:"sde-absolute-target-default-status-guide-harness-v1",
  targetConsumers:3,
  guideLevels:6,
  defaultStatus:"DRIFTSKLAR",
}));
