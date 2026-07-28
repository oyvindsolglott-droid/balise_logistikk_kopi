#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.argv[2];
assert.ok(sourcePath, "usage: node sde-drops-repair-process-ui-harness.js <index.html>");
const source = fs.readFileSync(sourcePath, "utf8");
const serverSource = fs.readFileSync(
  path.resolve(__dirname, "../../../server/src/index.js"),
  "utf8"
);

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
vm.runInContext([
  extractFunction("getDropsVehicleStatusRecord"),
  extractFunction("getAuthoritativeVehicleStatusPresentation"),
  extractFunction("getDropsRequestRepairAvailability"),
  extractFunction("getDropsRequestRepairAvailabilityMessage")
].join("\n"), context);

const baseViewModel = {
  readback: {
    ok: true,
    writeEnabled: true,
    productionPilotWriteEnabled: true,
    vehicleStatusPersistenceReady: true,
    requestRepairCommandAvailable: true,
    pilotAllowedVehicleIds: ["74-04"],
    commandReadiness: {
      requestRepair: {
        available: true,
        capabilityAllowed: true,
        persistenceReady: true,
        registeredVehicleScopeReady: true
      }
    }
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
const activeFault = { faultId: "fault-1", vehicleId: "74-04", status: "ACTIVE" };
const nestedFaultReadback = {
  ...baseViewModel.readback,
  items: [{
    vehicleId: "74-04",
    currentStatus: "DRIFTSKLAR",
    workshopDisposition: "NONE",
    activeFaults: [{
      faultId: "fault-nested-1",
      slot: 1,
      category: "A1",
      description: "Serverregistrert feil uten duplisert vehicleId",
      status: "ACTIVE",
      registeredAt: "2026-07-27T04:52:38.000Z"
    }]
  }],
  faults: [],
  repairRequests: []
};
const nestedFaultPresentation = context.getAuthoritativeVehicleStatusPresentation(
  nestedFaultReadback,
  "74-04"
);
assert.equal(nestedFaultPresentation.activeFaults.length, 1);
assert.equal(
  nestedFaultPresentation.activeFaults[0].vehicleId,
  "74-04",
  "a nested authoritative ACTIVE fault must retain ownership from its status record"
);
const nestedFaultAvailability = context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: nestedFaultPresentation.activeFaults[0],
  repairRequest: null,
  statusRecord: nestedFaultPresentation.record,
  viewModel: { ...baseViewModel, readback: nestedFaultReadback }
});
assert.equal(nestedFaultAvailability.available, true);
assert.equal(nestedFaultAvailability.reason, "available");
assert.equal(nestedFaultAvailability.checks.faultBelongsToVehicle, true);

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
  assert.equal(result.reason, "available");
  assert.equal(result.checks.faultBelongsToVehicle, true);
  assert.equal(result.checks.persistenceReady, true);
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

assert.equal(context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: { ...activeFault, vehicleId: "74-10" },
  repairRequest: null,
  statusRecord: null,
  viewModel: baseViewModel
}).reason, "faultBelongsToVehicle");

assert.equal(context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: activeFault,
  repairRequest: { status: "COMPLETED" },
  statusRecord: null,
  viewModel: baseViewModel
}).available, false);

const persistenceUnavailable = context.getDropsRequestRepairAvailability({
  vehicleId: "74-04",
  fault: activeFault,
  repairRequest: null,
  statusRecord: null,
  viewModel: {
    ...baseViewModel,
    readback: {
      ...baseViewModel.readback,
      vehicleStatusPersistenceReady: false,
      commandReadiness: {
        requestRepair: {
          available: false,
          capabilityAllowed: true,
          persistenceReady: false,
          registeredVehicleScopeReady: true
        }
      }
    }
  }
});
assert.equal(persistenceUnavailable.available, false);
assert.equal(persistenceUnavailable.reason, "persistenceReady");
assert.match(
  context.getDropsRequestRepairAvailabilityMessage(persistenceUnavailable),
  /Serverlagring er ikke tilgjengelig/
);

const vehicleUnavailable = context.getDropsRequestRepairAvailability({
  vehicleId: "74-23",
  fault: { ...activeFault, vehicleId: "74-23" },
  repairRequest: null,
  statusRecord: null,
  viewModel: baseViewModel
});
assert.equal(vehicleUnavailable.available, false);
assert.equal(vehicleUnavailable.reason, "vehicleWriteAllowed");
assert.match(
  context.getDropsRequestRepairAvailabilityMessage(vehicleUnavailable),
  /ikke tillatt i gjeldende write-scope/
);

assert.doesNotMatch(source, /Aktiveres etter autoritativ Ikke Driftsklar-status/);
assert.match(source, /Aktiveres etter at feilen er registrert/);
assert.match(source, /Intern bestilling til Nivå 4 – Verksted/);
assert.match(source, /getDropsRequestRepairAvailabilityMessage\(repairAvailability\)/);
assert.match(
  extractFunction("buildDropsNotOperationalEditorHtml"),
  /const activeFaults = statusPresentation\.activeFaults;/,
  "the editor must consume the normalized authoritative presentation"
);
assert.match(serverSource, /commandReadiness:\s*\{\s*requestRepair:/);
assert.match(serverSource, /registeredVehicleScopeReady:/);
assert.match(serverSource, /persistenceReady:/);
assert.match(source, /Sakstidslinje/);
assert.match(source, /Ikke registrert/);
assert.doesNotMatch(source, /Arbeid påbegynt|Arbeid startet/);
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
  schemaVersion: "sde-drops-repair-process-ui-harness-v3",
  counts: { passed: 38, total: 38 }
}) + "\n");
