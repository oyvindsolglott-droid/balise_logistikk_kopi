#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

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
    if(character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

assert.match(
  source,
  /movedFromRepSlots\.forEach\(slot => \{\s*if\(!isCurrentListRep\(slot\)\) slots\.delete\(slot\);/,
  "completed outbound skifte must not strip a current list Rep marker"
);
assert.match(
  source,
  /collectListRepVehicleTokens/,
  "graphic Rep must follow the marked vehicle, not only the list slot"
);
assert.match(
  source,
  /repSlots\.has\(normalizedSlot\) \|\|[\s\S]{0,120}repVehicles\.has\(vehicleToken\)/,
  "overlay isRepair must accept either the painted slot or the marked vehicle"
);

const inputSlots = ["4S","5S","6SS","8S","10S","12N"];
const planRows = [
  {vehicle:"74-21", fromSpor:"4S", toSpor:"6N", utfort:"ja", tilRep:""},
  {vehicle:"70-11", fromSpor:"10S", toSpor:"11S", utfort:"ja", tilRep:""},
  {vehicle:"74-45", fromSpor:"8S", toSpor:"7S", utfort:"ja", tilRep:""}
];
const context = {
  state:{
    grunnoppstilling:{
      "4S":"74-21",
      "5S":"74-19",
      "8S":"74-45",
      "10S":"70-11",
      "12N":"74-06"
    },
    grunnoppstillingRep:{
      "4S":"r",
      "5S":"r",
      "8S":"r",
      "10S":"r"
    },
    turneringKveld:[]
  },
  getEffectivePlanSkifteRows(){
    return planRows;
  }
};
vm.createContext(context);
vm.runInContext(`
const inputSlots=${JSON.stringify(inputSlots)};
const SPORPLAN_SLOT_ANCHORS=Object.freeze(Object.fromEntries(inputSlots.map(slot=>[slot,[0,0,10,10]])));
${extractFunction("normalizeVehicleToken")}
${extractFunction("normalizeSlot")}
${extractFunction("isUnknownMaterialIndividual")}
${extractFunction("isInvalidVehicleValue")}
${extractFunction("sanitizeVehicleValue")}
${extractFunction("splitVehicleList")}
${extractFunction("isDreiMarker")}
${extractFunction("isRepMarker")}
${extractFunction("isPlanSkifteFerdig")}
${extractFunction("getKveldRepSlots")}
${extractFunction("collectListRepVehicleTokens")}
${extractFunction("buildSporplanSlotOverlayModel")}
const graphicRows=[
  {slot:"4S", mat:"74-21"},
  {slot:"6SS", mat:"74-19"},
  {slot:"8S", mat:"74-45"},
  {slot:"10S", mat:"70-11"},
  {slot:"12N", mat:"74-06"}
];
const repSlots=getKveldRepSlots(graphicRows);
const repVehicles=collectListRepVehicleTokens();
const overlay=buildSporplanSlotOverlayModel(graphicRows,{
  repSlots,
  dreiSlots:new Set(),
  repVehicles
});
function overlaySlot(slot){
  return overlay.find(item=>item.slot===slot);
}
this.repSlotList=Array.from(repSlots).sort().join(",");
this.repVehicleList=Array.from(repVehicles).sort().join(",");
this.repair4S=overlaySlot("4S").isRepair;
this.repair5S=overlaySlot("5S").isRepair;
this.repair6SS=overlaySlot("6SS").isRepair;
this.repair8S=overlaySlot("8S").isRepair;
this.repair10S=overlaySlot("10S").isRepair;
this.repair12N=overlaySlot("12N").isRepair;
`, context);

assert.equal(context.repair4S, true, "non-workshop 4S with list R must get a Rep frame");
assert.equal(context.repair10S, true, "non-workshop 10S with list R must get a Rep frame");
assert.equal(context.repair8S, true, "workshop 8S with list R must get a Rep frame");
assert.equal(context.repair6SS, true, "74-19 marked R on list 5S must keep the frame where the graphic paints the vehicle");
assert.equal(context.repair5S, true, "the list slot that still has R also keeps a Rep frame");
assert.equal(context.repair12N, false, "unmarked 12N must stay without a Rep frame");
assert.equal(context.repVehicleList, "70-11,74-19,74-21,74-45");

planRows.length = 0;
context.state.grunnoppstillingRep = {};
vm.runInContext(`
this.emptyRepSlots=Array.from(getKveldRepSlots([{slot:"4S", mat:"74-21"}])).join(",");
this.emptyVehicles=Array.from(collectListRepVehicleTokens()).join(",");
`, context);
assert.equal(context.emptyRepSlots, "", "unmarked vehicles must not get a Rep frame");
assert.equal(context.emptyVehicles, "", "unmarked vehicles must not enter the Rep vehicle set");

console.log(JSON.stringify({
  schemaVersion:"sde-rep-frame-follows-list-harness-v2",
  status:"PASS",
  followsVehicleNotOnlySlot:true,
  nonWorkshopSlots:["4S","10S"],
  mismatchedGraphicSlot:"6SS",
  controlUnmarked:"12N"
}));
