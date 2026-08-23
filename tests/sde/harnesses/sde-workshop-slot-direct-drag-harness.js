#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sourcePath = process.argv[2] || "index.html";
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signature = source.slice(start).match(/\)\s*\{/);
  assert.ok(signature, `missing body for ${name}`);
  const open = start + signature.index + signature[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index=open; index<source.length; index+=1){
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
    if(char === "}" && --depth === 0) return source.slice(start,index+1);
  }
  throw new Error(`unclosed function ${name}`);
}

const occupancy = {
  "7N":"74-54",
  "7S":"74-45",
  "7SS":"74-07"
};
const context = {
  inputSlots:["7N","7S","7SS","8N","8S","8SS","6N","5N","4N"],
  normalizeSlot:value=>String(value || "").trim().toUpperCase(),
  sanitizeVehicleValue:value=>String(value || "").trim(),
  getSdeSlotTrack:slot=>String(slot || "").match(/^(7|8|6|5|4)/)?.[1] || "",
  getSdeVehicleInSlot:slot=>occupancy[String(slot || "").toUpperCase()] || "",
  getSdeSameTrackSlotOrder:track=>({
    "7":["7SS","7S","7N"],
    "8":["8SS","8S","8N"],
    "6":["6SS","6S","6N"],
    "5":["5S","5M","5N"],
    "4":["4S","4M","4N"]
  })[String(track || "")] || [],
  getSdeSameTrackOpenEnds:()=>["south","north"],
  getSdeSameTrackEndLabel:end=>String(end || ""),
  getSdeSlotPathToOpenEnd(slot,end){
    const order = this.getSdeSameTrackSlotOrder(this.getSdeSlotTrack(slot));
    const index = order.indexOf(String(slot || "").toUpperCase());
    return end === "north" ? order.slice(index + 1) : order.slice(0,index).reverse();
  },
  Map,
  Set,
  Array
};
vm.createContext(context);
for(const name of [
  "isSdeWorkshopSlot",
  "getSdeWorkshopBayAccessOption",
  "getSdePhysicalBlockerItems",
  "getSdeAccessOptionsForSlot",
  "getSdeInternalBlockersBetweenSlots",
  "getSdeTrappedEgressAccessOptions",
  "getSdeTrappedEgressInternalBlockers",
  "getSdeTrappedEgressMainSourceEnds"
]){
  vm.runInContext(extractFunction(name),context);
}

for(const slot of ["7N","7S","8N","8S"]){
  const option = context.getSdeWorkshopBayAccessOption(slot);
  assert.equal(option.clear,true, `${slot} must be an independently accessible workshop bay`);
  assert.equal(option.end,"workshop");
  assert.deepEqual(Array.from(option.pathSlots),[]);
}

const physicalOptions = context.getSdeAccessOptionsForSlot("7N","source");
assert.equal(physicalOptions.length,1);
assert.equal(physicalOptions[0].clear,true);
assert.deepEqual(Array.from(physicalOptions[0].blockers),[]);

const trappedOptions = context.getSdeTrappedEgressAccessOptions(
  new Map(Object.entries(occupancy)),
  "7N",
  ["workshop"]
);
assert.equal(trappedOptions.length,1);
assert.equal(trappedOptions[0].clear,true);
assert.deepEqual(Array.from(trappedOptions[0].blockers),[]);
assert.deepEqual(Array.from(context.getSdeTrappedEgressMainSourceEnds("7N","6N")),["workshop"]);

assert.deepEqual(
  Array.from(context.getSdeInternalBlockersBetweenSlots("7N","7SS")),
  [],
  "workshop bays must not inherit fictitious same-track blockers"
);
assert.deepEqual(
  Array.from(context.getSdeTrappedEgressInternalBlockers(
    new Map(Object.entries(occupancy)),
    "7N",
    "7SS"
  )),
  [],
  "canonical virtual routing must use the same independent-bay contract"
);

const applySource = extractFunction("applySdeNightPlacementDragOverride");
assert.ok(
  applySource.indexOf("supersedeSdeNightPlacementPlanningStateForVehicle(assessment.vehicle)") <
    applySource.indexOf("stageSdeCanonicalGraphicDragOrder(override)"),
  "stale completed, cancelled and superseded planning identities must be retired before staging"
);

console.log(JSON.stringify({
  ok:true,
  vehicle:"74-54",
  sourceSlot:"7N",
  acceptedTargets:["6N","5N","4N"],
  sourceAccess:"workshop",
  fictitiousNeighbourBlockers:false,
  stalePlanningRetiredBeforeStage:true
},null,2));
