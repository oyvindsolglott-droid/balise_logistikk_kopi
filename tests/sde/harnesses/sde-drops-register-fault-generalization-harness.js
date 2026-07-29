#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
const registry = require(path.join(root, "server/src/vehicleRegistry.js"));

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

const availabilitySource = extractFunction("getDropsRegisterFaultAvailability");
for(const forbidden of [
  "pilotAllowedVehicleIds",
  "allowedVehicleIds",
  "vehicleStatusLifecycleAllowedVehicleIds",
  "stateAllowsRegistration",
]){
  assert.equal(
    availabilitySource.includes(forbidden),
    false,
    `availability must not use legacy ${forbidden} gating`
  );
}
for(const required of [
  "commandReadiness?.registerFault",
  "registeredVehicleScopeReady",
  "vehicleWriteScope",
  "REGISTERED_VEHICLES",
  "vehicleStatusPersistenceReady",
  "caseRevision",
  "rowUnregistered",
]){
  assert.ok(availabilitySource.includes(required), `availability misses ${required}`);
}
assert.match(serverSource, /registerFault:\s*\{[\s\S]*registeredVehicleScopeReady/);

const context = {};
vm.createContext(context);
vm.runInContext(`
  const REGISTERED_VEHICLES_SCOPE = "REGISTERED_VEHICLES";
  function getDropsNotOperationalFaultCategories(){ return ["A1","A2","A3","A4","A5","A6"]; }
  function getDropsVehicleStatusRecord(readback,vehicleId){
    return (Array.isArray(readback?.items) ? readback.items : [])
      .find(item=>item?.vehicleId === vehicleId) || null;
  }
  ${availabilitySource}
  this.check = getDropsRegisterFaultAvailability;
`, context);

const capabilities = {
  ok: true,
  roleResolved: true,
  roles: ["admin_pilot", "drops"],
  capabilities: {
    "vehicle_status.register_fault": {
      allowed: true,
      decision: "ALLOW",
      capabilitySourceRoles: ["drops"],
    },
  },
};
function viewModel(vehicleId, overrides = {}){
  return {
    readback: {
      ok: true,
      writeEnabled: true,
      productionPilotWriteEnabled: true,
      vehicleWriteScope: "REGISTERED_VEHICLES",
      vehicleStatusPersistenceReady: true,
      registerFaultCommandAvailable: true,
      commandReadiness: {
        registerFault: {
          available: true,
          capabilityAllowed: true,
          persistenceReady: true,
          registeredVehicleScopeReady: true,
        },
      },
      items: [{
        vehicleId,
        currentStatus: null,
        caseRevision: 0,
        activeFaults: [],
      }],
      ...overrides,
    },
    capabilities,
    commandInFlight: false,
  };
}
const draft = vehicleId => ({
  vehicle: vehicleId,
  faults: Array.from({length: 5}, (_unused, index) => ({
    category: `A${index + 1}`,
    description: `Feil ${index + 1}`,
  })),
});

const vehicles = Object.values(registry.VEHICLE_REGISTRY).flat();
assert.equal(vehicles.length, 176);
for(const vehicleId of vehicles){
  assert.equal(
    context.check(draft(vehicleId), 0, viewModel(vehicleId)).available,
    true,
    `${vehicleId} must be write-eligible from authoritative registered scope`
  );
}
for(const currentStatus of [
  null,
  "DRIFTSKLAR",
  "IKKE_DRIFTSKLAR",
  "TIL_REP",
  "TIL_DREI",
]){
  const vmForStatus = viewModel("74-23", {
    items: [{
      vehicleId: "74-23",
      currentStatus,
      workshopDisposition: currentStatus,
      caseRevision: 9,
      activeFaults: [],
      history: [{status: "COMPLETED"}],
    }],
  });
  assert.equal(
    context.check(draft("74-23"), 0, vmForStatus).available,
    true,
    `74-23 status ${currentStatus} must not block a free active fault slot`
  );
}
const fiveActive = viewModel("74-23", {
  items: [{
    vehicleId: "74-23",
    currentStatus: "DRIFTSKLAR",
    caseRevision: 5,
    activeFaults: Array.from({length: 5}, (_unused, index) => ({
      slot: index + 1,
      status: "ACTIVE",
    })),
  }],
});
assert.equal(context.check(draft("74-23"), 0, fiveActive).available, false);
assert.equal(context.check(draft("74-23"), 0, fiveActive).reason, "rowUnregistered");
assert.equal(
  context.check(draft("74-23"), 0, viewModel("74-23", {
    commandReadiness: {
      registerFault: {
        available: false,
        capabilityAllowed: true,
        persistenceReady: true,
        registeredVehicleScopeReady: true,
      },
    },
  })).available,
  false
);

console.log(JSON.stringify({
  schemaVersion: "sde-drops-register-fault-generalization-harness-v1",
  registeredVehicles: vehicles.length,
  statusVariants: 5,
  tests: 26,
}));
