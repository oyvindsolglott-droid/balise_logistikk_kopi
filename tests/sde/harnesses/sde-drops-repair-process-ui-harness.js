#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sourcePath = process.argv[2];
assert.ok(sourcePath, "usage: node sde-drops-repair-process-ui-harness.js <index.html>");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = bodyStart; index < source.length; index += 1){
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

const context = {
  console,
  Number,
  String,
  Boolean,
  Array,
  Object
};
vm.createContext(context);
vm.runInContext(extractFunction("getDropsRequestRepairAvailability"), context);

const baseViewModel = {
  readback: {
    ok: true,
    writeEnabled: true,
    productionPilotWriteEnabled: true,
    requestRepairCommandAvailable: true,
    pilotAllowedVehicleIds: ["74-04"]
  },
  capabilities: {
    ok: true,
    roleResolved: true,
    roles: ["drops"],
    capabilities: {
      "vehicle_status.request_repair": {
        allowed: true,
        decision: "ALLOW"
      }
    }
  },
  commandInFlight: false
};
const activeFault = { faultId: "fault-1", status: "ACTIVE" };

for(const statusRecord of [
  { currentStatus: "DRIFTSKLAR", workshopDisposition: "NONE" },
  null,
  { currentStatus: "IKKE_DRIFTSKLAR", workshopDisposition: "NONE" },
  { currentStatus: "IKKE_DRIFTSKLAR", workshopDisposition: "TIL_DREI" }
]){
  const result = context.getDropsRequestRepairAvailability({
    vehicleId: "74-04",
    fault: activeFault,
    repairRequest: null,
    statusRecord,
    viewModel: baseViewModel
  });
  assert.equal(result.available, true, JSON.stringify(statusRecord));
}

assert.equal(context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: { ...activeFault, status: "RESOLVED" },
  repairRequest: null,
  statusRecord: { currentStatus: "DRIFTSKLAR" },
  viewModel: baseViewModel
}).available, false);

assert.equal(context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: activeFault,
  repairRequest: { status: "REQUESTED" },
  statusRecord: { currentStatus: "DRIFTSKLAR" },
  viewModel: baseViewModel
}).available, false);

assert.doesNotMatch(source, /Aktiveres etter autoritativ Ikke Driftsklar-status/);
assert.match(source, /Aktiveres etter at feilen er registrert/);
assert.match(source, /Sakstidslinje/);
assert.match(source, /Ikke registrert/);
assert.match(source, /Arbeid påbegynt/);
assert.match(source, /Årsak til venting/);
assert.match(source, /Analyse og prosessdata/);
assert.match(source, /Operativt øyeblikksbilde/);
assert.match(source, /Prosessytelse/);
assert.match(source, /Pålitelighet/);
assert.match(source, /Kapasitetsplanlegging/);
assert.match(source, /SDE registrerer automatiske prosesstidspunkter for kjøretøy- og saksflyt\./);
assert.match(source, /ikke til rangering av enkeltpersoner/);
assert.doesNotMatch(source, /raskeste mekaniker|tregeste mekaniker|medarbeiderrangering|tastetrykk|inaktivitetstid/i);

process.stdout.write(JSON.stringify({
  schemaVersion: "sde-drops-repair-process-ui-harness-v1",
  counts: { passed: 18, total: 18 }
}) + "\n");
