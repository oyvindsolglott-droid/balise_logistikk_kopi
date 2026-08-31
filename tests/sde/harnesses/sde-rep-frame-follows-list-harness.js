#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  /const repSlots=getKveldRepSlots\(dataRows\)/,
  "graphic overlay must collect Rep slots from the same placement rows it paints"
);

const planRows = [
  {
    vehicle:"74-21",
    fromSpor:"8S",
    toSpor:"7S",
    utfort:"ja",
    tilRep:""
  }
];
const context = {
  state:{
    grunnoppstilling:{"8S":"74-45","7N":"74-37","12N":"74-06"},
    grunnoppstillingRep:{"8S":"r"},
    turneringKveld:[]
  },
  getEffectivePlanSkifteRows(){
    return planRows;
  }
};
vm.createContext(context);
vm.runInContext(`
${extractFunction("normalizeVehicleToken")}
${extractFunction("normalizeSlot")}
${extractFunction("isInvalidVehicleValue")}
${extractFunction("sanitizeVehicleValue")}
${extractFunction("isDreiMarker")}
${extractFunction("isRepMarker")}
${extractFunction("isPlanSkifteFerdig")}
${extractFunction("getKveldRepSlots")}
this.repSlots = Array.from(getKveldRepSlots([
  {slot:"8S", mat:"74-45"},
  {slot:"7N", mat:"74-37"},
  {slot:"12N", mat:"74-06"}
])).sort();
`, context);

assert.equal(context.repSlots.join(","), "8S",
  "8S must keep a graphic Rep frame when the list still has R, even if a finished skifte once left 8S"
);

planRows.length = 0;
context.state.grunnoppstillingRep = {};
vm.runInContext(`this.emptyRepSlots = Array.from(getKveldRepSlots([
  {slot:"8S", mat:"74-45"},
  {slot:"12N", mat:"74-06"}
])).sort();`, context);
assert.equal(context.emptyRepSlots.join(","), "", "unmarked vehicles must not get a Rep frame");

console.log(JSON.stringify({
  schemaVersion:"sde-rep-frame-follows-list-harness-v1",
  status:"PASS",
  workshopSlot:"8S",
  vehicle:"74-45",
  keepsCurrentListRep:true,
  controlUnmarked:true
}));
