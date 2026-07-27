#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.argv[2] || "index.html";
const root = path.dirname(sourcePath);
const source = fs.readFileSync(sourcePath,"utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0,`missing function ${name}`);
  const signature = source.slice(start).match(/\)\s*\{/);
  assert.ok(signature,`missing body for ${name}`);
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
  normalizeSlot:value=>String(value || "").trim().toUpperCase(),
  sanitizeVehicleValue:value=>String(value || "").trim(),
  normalizeVehicleToken:value=>String(value || "").trim().toLowerCase(),
  splitVehicleList:value=>String(value || "").split(/[,+;\s]+/).filter(Boolean),
  computeCanonicalActualPlacementRows:()=>[
    {slot:"7N",mat:"74-54"},
    {slot:"7S",mat:"74-45"},
    {slot:"8S",mat:"74-07"}
  ],
  buildCanonicalActualPlacementSlotMap:rows=>Object.fromEntries(rows.map(row=>[row.slot,row.mat])),
  getSporplanVehicleStatusFrameClass:(readback,vehicle)=>{
    const record = readback.items.find(item=>item.vehicleId === vehicle);
    if(record?.workshopDisposition === "TIL_DREI") return "sporplan-status-turn";
    if(record?.currentStatus === "IKKE_DRIFTSKLAR") return "sporplan-status-not-operational";
    return record ? "sporplan-status-operational" : "";
  },
  getDropsVehicleStatusRecord:(readback,vehicle)=>
    readback.items.find(item=>item.vehicleId === vehicle) || null,
  SPORPLAN_SLOT_ANCHORS:{
    "8N":[469,478,93,187],
    "7N":[574,478,93,187],
    "8S":[469,681,93,185],
    "7S":[574,681,93,185]
  }
};
vm.createContext(context);
vm.runInContext(extractFunction("getWorkshopHallOverviewStatus"),context);
vm.runInContext(extractFunction("buildWorkshopHallOverviewHtml"),context);

const readback = {
  ok:true,
  items:[
    {vehicleId:"74-54",currentStatus:"DRIFTSKLAR",workshopDisposition:"NONE"},
    {vehicleId:"74-45",currentStatus:"IKKE_DRIFTSKLAR",workshopDisposition:"TIL_REP"},
    {vehicleId:"74-07",currentStatus:"IKKE_DRIFTSKLAR",workshopDisposition:"TIL_DREI"}
  ]
};
const html = context.buildWorkshopHallOverviewHtml(readback);

assert.match(html,/data-sde-workshop-hall-overview/);
assert.match(html,/assets\/NY_SPORPLAN\.png\?v=9510e11f/);
assert.match(html,/data-sde-workshop-overview-slot="7N"/);
assert.match(html,/data-sde-workshop-overview-vehicle="74-54"/);
assert.match(html,/data-sde-workshop-overview-status="DRIFTSKLAR"/);
assert.match(html,/data-sde-workshop-overview-status="TIL REP"/);
assert.match(html,/data-sde-workshop-overview-status="TIL DREI"/);
assert.doesNotMatch(html,/data-sde-workshop-overview-slot="8N"/);
assert.doesNotMatch(html,/draggable=/);
assert.doesNotMatch(html,/<input|<select|<textarea/);

const builderSource = extractFunction("buildWorkshopVehicleRegistryHtml");
assert.ok(
  builderSource.indexOf("buildWorkshopHallOverviewHtml") <
    builderSource.indexOf("drops-vehicle-selector-grid"),
  "the hall overview must be rendered above the existing selectors"
);

const clickSource = extractFunction("handleDropsNotOperationalRegistryClick");
assert.match(clickSource,/data-sde-workshop-overview-vehicle/);
assert.match(clickSource,/selectWorkshopOverviewVehicle/);

const asset = fs.readFileSync(path.join(root,"assets","NY_SPORPLAN.png"));
assert.equal(
  crypto.createHash("sha256").update(asset).digest("hex"),
  "9510e11fea79600ef2354d68db5304bacb3a1551b09ccd2db3cb2ce3b7f8461c",
  "the exact approved Sporplan background asset must remain byte-identical"
);

console.log(JSON.stringify({
  ok:true,
  exactSlots:["8N","7N","8S","7S"],
  actualVehicles:["74-54","74-45","74-07"],
  emptySlotClickable:false,
  draggable:false,
  authoritativeStatuses:["DRIFTSKLAR","TIL REP","TIL DREI"],
  exactAsset:true
},null,2));
