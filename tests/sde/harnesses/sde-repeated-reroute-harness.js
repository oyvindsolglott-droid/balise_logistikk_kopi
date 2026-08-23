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

const context = {
  state:{
    sdeMoveActions:{},
    sdeNightPlacementManualOverrides:{},
    sdeActiveMoveOutcomes:{}
  },
  normalizeSlot:value=>String(value || "").trim().toUpperCase(),
  sanitizeVehicleValue:value=>String(value || "").trim(),
  normalizeVehicleToken:value=>String(value || "").trim().toLowerCase(),
  getSdeCurrentSlotForVehicle:vehicle=>
    String(vehicle).toLowerCase() === "69-63" ? context.actualSlot : "4N",
  getSdeMoveActionRecord:key=>context.state.sdeMoveActions[String(key || "")] || null,
  getSdeNightPlacementOverrideActionKey:override=>String(override?.stableActionKey || ""),
  actualSlot:"8N"
};
vm.createContext(context);
for(const name of [
  "getSdeNightPlacementCompletedLockedSlots",
  "supersedeSdeNightPlacementPlanningStateForVehicle"
]){
  vm.runInContext(extractFunction(name), context);
}

const slots = ["7N","7S","8S","9","10S","10N","11S","11N","12S","12N","6S","8N"];
slots.forEach((slot,index)=>{
  context.state.sdeMoveActions[`completed-${index}`] = {
    action:"completed",
    vehicle:"69-63",
    toSlot:slot,
    time:`2026-07-27T10:${String(index).padStart(2,"0")}:00.000Z`
  };
});
context.state.sdeMoveActions["other-completed"] = {
  action:"completed",vehicle:"74-10",toSlot:"4N",time:"2026-07-27T09:00:00.000Z"
};

const locked = context.getSdeNightPlacementCompletedLockedSlots();
assert.deepEqual(
  JSON.parse(JSON.stringify(locked)),
  {
    "8N":{slot:"8N",vehicle:"69-63",source:"completedLocked",time:"2026-07-27T10:11:00.000Z"},
    "4N":{slot:"4N",vehicle:"74-10",source:"completedLocked",time:"2026-07-27T09:00:00.000Z"}
  },
  "only completed history confirmed by current canonical actual placement may remain occupied"
);

for(let index=0; index<5; index+=1){
  context.state.sdeNightPlacementManualOverrides[`old-${index}`] = {
    vehicle:"69-63",
    originalFromSlot:"8N",
    toSlot:["7N","7S","8S","9","10S"][index],
    stableActionKey:`old-action-${index}`
  };
  context.state.sdeActiveMoveOutcomes[`old-outcome-${index}`] = {
    vehicle:"69-63",
    physicalFromSlot:"8N",
    requestedTarget:["7N","7S","8S","9","10S"][index]
  };
}
context.state.sdeNightPlacementManualOverrides.other = {
  vehicle:"74-10",originalFromSlot:"4N",toSlot:"3N",stableActionKey:"other-action"
};
context.state.sdeActiveMoveOutcomes.other = {
  vehicle:"74-10",physicalFromSlot:"4N",requestedTarget:"3N"
};

const retired = context.supersedeSdeNightPlacementPlanningStateForVehicle("69-63");
assert.equal(retired.overrides,5);
assert.equal(retired.authorities,5);
assert.deepEqual(Object.keys(context.state.sdeNightPlacementManualOverrides),["other"]);
assert.deepEqual(Object.keys(context.state.sdeActiveMoveOutcomes),["other"]);

const applySource = extractFunction("applySdeNightPlacementDragOverride");
assert.match(
  applySource,
  /supersedeSdeNightPlacementPlanningStateForVehicle\s*\(\s*assessment\.vehicle/,
  "every accepted drag must supersede older unexecuted plans for the same vehicle"
);
assert.match(source,/const SPORPLAN_SLOT_ANCHORS\s*=\s*Object\.freeze/);
for(const slot of ["7N","7S","8N","8S","9","10S","10N","11S","11N","12S","12N"]){
  assert.match(source,new RegExp(`["']?${slot}["']?\\s*:`),`missing central anchor ${slot}`);
}

const classificationContext = {
  normalizeVehicleToken:value=>String(value || "").trim().toLowerCase(),
  getDropsVehicleStatusRecord:(_readback,vehicle)=>
    classificationContext.records[String(vehicle || "").trim()] || null,
  getSdeGrunnoppstillingRepDreiValueForVehicle:vehicle=>
    classificationContext.markers[String(vehicle || "").trim()] || "",
  buildSdeProductionNeeds:()=>classificationContext.productionNeeds,
  getSdeNextDepartureBindingForVehicle:vehicle=>
    classificationContext.departures[String(vehicle || "").trim()] || null,
  normalizeTognr:value=>String(value || "").replace(/\D/g,""),
  isDreiMarker:value=>String(value || "").trim().toLowerCase() === "d",
  isRepMarker:value=>String(value || "").trim().toLowerCase() === "r",
  records:{},
  markers:{},
  productionNeeds:[],
  departures:{}
};
vm.createContext(classificationContext);
vm.runInContext(
  extractFunction("getSdeFreshWorkshopExitClassification"),
  classificationContext
);

function classifyFixture(vehicle, fixture={}){
  classificationContext.records = fixture.record
    ? {[vehicle]:fixture.record}
    : {};
  classificationContext.markers = fixture.marker
    ? {[vehicle]:fixture.marker}
    : {};
  classificationContext.productionNeeds = fixture.productionNeed
    ? [{vehicle,...fixture.productionNeed}]
    : [];
  classificationContext.departures = fixture.departure
    ? {[vehicle]:fixture.departure}
    : {};
  return classificationContext.getSdeFreshWorkshopExitClassification(
    vehicle,
    {classification:"UNKNOWN",reasonCodes:["snapshot_unknown"]},
    {repairRequests:fixture.repairRequests || []}
  );
}

const classificationCases = [
  {
    name:"Drei precedence",
    expected:"TIL_DREI",
    fixture:{
      record:{currentStatus:"IKKE_DRIFTSKLAR",workshopDisposition:"TIL_DREI",activeFaults:[{status:"ACTIVE"}]},
      departure:{train:"80001"}
    }
  },
  {
    name:"Rep precedence",
    expected:"TIL_REP",
    fixture:{
      record:{currentStatus:"IKKE_DRIFTSKLAR",workshopDisposition:"TIL_REP",activeFaults:[]},
      departure:{train:"80002"}
    }
  },
  {
    name:"Tursatt departure",
    expected:"TURSATT",
    fixture:{
      record:{currentStatus:"DRIFTSKLAR",workshopDisposition:"NONE",activeFaults:[]},
      departure:{train:"80003"}
    }
  },
  {
    name:"Driftsklar reserve",
    expected:"RESERVE",
    fixture:{
      record:{currentStatus:"DRIFTSKLAR",workshopDisposition:"NONE",activeFaults:[]}
    }
  },
  {
    name:"Ambiguous fail-closed",
    expected:"UNKNOWN",
    fixture:{}
  }
];
for(const testCase of classificationCases){
  const result = classifyFixture("69-63",testCase.fixture);
  assert.equal(
    result.classification,
    testCase.expected,
    `${testCase.name} must reuse the authoritative classification precedence`
  );
}

process.stdout.write(JSON.stringify({
  schemaVersion:"sde-repeated-reroute-harness-v1",
  counts:{passed:10,total:10},
  actualSlot:"8N",
  historicalCompletions:12,
  preExecutionReplans:5,
  classificationCases:classificationCases.map(item=>item.expected)
}) + "\n");
