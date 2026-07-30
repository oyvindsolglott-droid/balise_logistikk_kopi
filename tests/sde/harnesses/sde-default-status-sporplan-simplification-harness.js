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

const centralPresentation = extractFunction("getAuthoritativeVehicleStatusPresentation");
const centralRecord = extractFunction("getDropsVehicleStatusRecord");
const context = {};
vm.createContext(context);
vm.runInContext(`
  ${centralRecord}
  ${centralPresentation}
  this.present = getAuthoritativeVehicleStatusPresentation;
`, context);

const readback = {
  items:[
    {
      vehicleId:"74-38",
      currentStatus:null,
      workshopDisposition:"TIL_REP",
      activeFaults:[{faultId:"fault-1",status:"ACTIVE",slot:1,category:"A1"}],
    },
    {
      vehicleId:"74-09",
      currentStatus:"IKKE_DRIFTSKLAR",
      workshopDisposition:"NONE",
      registeredAt:"2026-07-30T08:00:00.000Z",
    },
    {
      vehicleId:"74-06",
      currentStatus:"DRIFTSKLAR",
      workshopDisposition:"TIL_DREI",
      operationalAt:"2026-07-30T08:01:00.000Z",
    },
  ],
  faults:[],
  repairRequests:[],
};

const repairOnly = context.present(readback,"74-38");
assert.equal(repairOnly.effectiveStatus,"DRIFTSKLAR");
assert.equal(repairOnly.defaultOperational,true);
assert.equal(repairOnly.disposition,"TIL_REP");
assert.equal(repairOnly.activeFaults.length,1);

const explicitRed = context.present(readback,"74-09");
assert.equal(explicitRed.effectiveStatus,"IKKE_DRIFTSKLAR");
assert.equal(explicitRed.explicitStatus,true);

const turnOnly = context.present(readback,"74-06");
assert.equal(turnOnly.effectiveStatus,"DRIFTSKLAR");
assert.equal(turnOnly.disposition,"TIL_DREI");

const dropsStatus = extractFunction("getDropsSkienStationVehicleStatus");
assert.match(dropsStatus,/getAuthoritativeVehicleStatusPresentation/);
assert.doesNotMatch(dropsStatus,/isRepMarker|isDreiMarker/);
assert.doesNotMatch(dropsStatus,/Ikke driftsklart\./);

const badgeBuilder = extractFunction("buildSporplanVehicleStatusBadgesHtml");
assert.doesNotMatch(badgeBuilder,/presentation\.label/);
assert.doesNotMatch(badgeBuilder,/TIL REP|DRIFTSKLAR|IKKE DRIFTSKLAR/);
assert.match(badgeBuilder,/Dreies/);

const buildSporplan = extractFunction("buildSporplan");
assert.match(buildSporplan,/getSporplanVehicleAccessibilityLabel/);
assert.doesNotMatch(buildSporplan,/>Rep<\/span>/);
assert.doesNotMatch(buildSporplan,/>Drei<\/span>/);

const overlayCss = source.slice(
  source.indexOf(".sporplan-slot-overlay .slot.sporplan-status-operational"),
  source.indexOf("#sporplan .yard-wrap")
);
assert.doesNotMatch(
  overlayCss,
  /sporplan-status-not-operational,\s*\n?\.sporplan-slot-overlay \.slot\.rep-slot/
);
assert.doesNotMatch(
  overlayCss,
  /sporplan-status-turn,\s*\n?\.sporplan-slot-overlay \.slot\.drei-slot/
);

assert.match(source,/Siste revisjon: 30\. juli 2026/);
assert.doesNotMatch(source,/Siste revisjon: 29\. juli 2026/);

console.log(JSON.stringify({
  schemaVersion:"sde-default-status-sporplan-simplification-harness-v1",
  defaultOperational:true,
  explicitRedOnly:true,
  visualBadges:["Dreies"],
  revision:"30. juli 2026",
}));
