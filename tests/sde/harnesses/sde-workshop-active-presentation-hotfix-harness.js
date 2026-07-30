#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sourcePath = process.argv[2];
assert.ok(sourcePath, "usage: node sde-workshop-active-presentation-hotfix-harness.js <index.html>");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing production function ${name}`);
  const nextTopLevelFunction = source.indexOf("\nfunction ", start + marker.length);
  assert.ok(nextTopLevelFunction > start, `missing production boundary for ${name}`);
  return source.slice(start, nextTopLevelFunction);
}

const context = {
  console,
  getDropsVehicleCatalog(){
    return {"74":["74-04","74-09"]};
  },
  getVehicleProcessCase(readback, vehicleId){
    return (readback.processCases || []).find(item=>item.vehicleId === vehicleId) || null;
  },
  isDropsPilotVehicleAllowed(){
    return true;
  },
  buildVehicleStatusFaultTimingHtml(fault){
    return `<time data-fault-time="${fault.faultId}">${fault.registeredAt || fault.resolvedAt || ""}</time>`;
  },
  formatDropsVehicleStatusTimestamp(value){
    return String(value || "");
  },
  buildVehicleProcessTimelineHtml(readback, vehicleId){
    return `<div data-process-timeline="${vehicleId}">${(readback.processEvents || []).length}</div>`;
  },
  buildVehicleStatusAudioControlHtml(){
    return "";
  },
  getWorkshopExitRequestAvailability(){
    return {
      available:false,
      activeRequest:null,
      sourceSlot:"",
      ariaDisabled:"true"
    };
  }
};
vm.createContext(context);
vm.runInContext([
  extractFunction("getDropsVehicleStatusRecord"),
  extractFunction("getAuthoritativeVehicleStatusPresentation"),
  extractFunction("buildWorkshopVehicleRegistryHtml"),
  "this.api={getAuthoritativeVehicleStatusPresentation,buildWorkshopVehicleRegistryHtml};"
].join("\n"), context);
const api = context.api;

const capabilities = {
  ok:true,
  roleResolved:true,
  roles:["verksted"],
  capabilities:{
    "vehicle_status.report_operational":{allowed:true,decision:"ALLOW"},
    "vehicle_status.work_started":{allowed:true,decision:"ALLOW"},
    "vehicle_status.set_wait_reason":{allowed:true,decision:"ALLOW"}
  }
};

function baseReadback(fields = {}){
  return {
    ok:true,
    writeEnabled:true,
    reportOperationalCommandAvailable:true,
    workStartedCommandAvailable:true,
    setWaitReasonCommandAvailable:true,
    pilotAllowedVehicleIds:["74-04","74-09"],
    items:[],
    faults:[],
    repairRequests:[],
    placements:[{vehicleId:"74-04",slot:"2N",inWorkshop:false}],
    processCases:[{
      vehicleId:"74-04",
      active:true,
      milestones:{},
      currentWaitReason:"NONE"
    }],
    processEvents:[],
    ...fields
  };
}

const activeFault = {
  vehicleId:"74-04",
  faultId:"fault-active",
  slot:2,
  category:"A2",
  description:"Aktiv dørfeil",
  status:"ACTIVE",
  registeredAt:"2026-07-26T05:00:00.000Z"
};
const resolvedFault = {
  vehicleId:"74-04",
  faultId:"fault-resolved",
  slot:1,
  category:"A1",
  description:"Historisk stigtrinn",
  status:"RESOLVED",
  registeredAt:"2026-07-25T05:00:00.000Z",
  resolvedAt:"2026-07-25T06:00:00.000Z"
};
const requestedRepair = {
  vehicleId:"74-04",
  repairRequestId:"repair-open",
  faultId:"fault-active",
  status:"REQUESTED",
  requestedAt:"2026-07-26T05:05:00.000Z"
};
const completedRepair = {
  vehicleId:"74-04",
  repairRequestId:"repair-completed",
  faultId:"fault-resolved",
  status:"COMPLETED",
  requestedAt:"2026-07-25T05:05:00.000Z",
  completedAt:"2026-07-25T06:00:00.000Z"
};
const operationalRecord = {
  vehicleId:"74-04",
  currentStatus:"DRIFTSKLAR",
  workshopDisposition:"NONE",
  statusRevision:3,
  operationalAt:"2026-07-25T06:00:00.000Z"
};

const mixedReadback = baseReadback({
  items:[operationalRecord],
  faults:[resolvedFault,activeFault,{...activeFault,vehicleId:"74-09",faultId:"other-vehicle"}],
  repairRequests:[completedRepair,requestedRepair,{...requestedRepair,vehicleId:"74-09",repairRequestId:"other-request"}]
});
const presentation = api.getAuthoritativeVehicleStatusPresentation(mixedReadback,"74-04");
assert.equal(presentation.kind,"operational");
assert.equal(presentation.className,"is-operational");
assert.equal(presentation.label,"DRIFTSKLAR");
assert.deepEqual(Array.from(presentation.activeFaults,fault=>fault.faultId),["fault-active"]);
assert.deepEqual(Array.from(presentation.resolvedFaults,fault=>fault.faultId),["fault-resolved"]);
assert.deepEqual(Array.from(presentation.requestedRepairRequests,request=>request.repairRequestId),["repair-open"]);
assert.deepEqual(Array.from(presentation.completedRepairRequests,request=>request.repairRequestId),["repair-completed"]);
assert.deepEqual(Array.from(presentation.faults,fault=>fault.faultId),["fault-active","fault-resolved"]);
assert.deepEqual(
  Array.from(presentation.repairRequests,request=>request.repairRequestId),
  ["repair-open","repair-completed"]
);

const workshopHtml = api.buildWorkshopVehicleRegistryHtml("74","74-04",mixedReadback,capabilities,false);
assert.match(workshopHtml,/workshop-vehicle-status is-operational/);
assert.match(workshopHtml,/data-authoritative-status-kind="operational"/);
assert.match(workshopHtml,/data-sde-workshop-active-faults/);
assert.match(workshopHtml,/Aktiv dørfeil/);
assert.match(workshopHtml,/2026-07-26T05:00:00\.000Z/);
assert.doesNotMatch(workshopHtml,/Ingen aktive feil/);
assert.match(workshopHtml,/<strong>Bestilt utbedring<\/strong> · fault-active/);
assert.match(workshopHtml,/2026-07-26T05:05:00\.000Z/);
assert.match(workshopHtml,/data-sde-workshop-fault-history/);
assert.match(workshopHtml,/Historisk stigtrinn/);
assert.match(workshopHtml,/<strong>COMPLETED<\/strong> · fault-resolved/);
assert.doesNotMatch(workshopHtml,/other-vehicle|other-request/);
assert.doesNotMatch(workshopHtml,/data-sde-workshop-work-started|Arbeid påbegynt|Arbeid startet/);
assert.match(workshopHtml,/data-sde-workshop-wait-reason>/);
assert.match(
  workshopHtml,
  /data-sde-workshop-report-operational aria-disabled="false">Registrer Driftsklar<\/button>/
);

const collapsedHtml = api.buildWorkshopVehicleRegistryHtml("74","74-04",mixedReadback,capabilities,true);
assert.match(collapsedHtml,/data-sde-workshop-standard-sheet hidden/);
assert.match(collapsedHtml,/Aktiv dørfeil/);
assert.match(collapsedHtml,/<strong>Bestilt utbedring<\/strong> · fault-active/);
assert.equal(
  api.buildWorkshopVehicleRegistryHtml("74","74-04",mixedReadback,capabilities,false),
  workshopHtml,
  "refresh with identical readback must be deterministic"
);

const historyOnlyReadback = baseReadback({
  items:[operationalRecord],
  faults:[resolvedFault],
  repairRequests:[completedRepair]
});
const historyOnlyHtml = api.buildWorkshopVehicleRegistryHtml("74","74-04",historyOnlyReadback,capabilities,false);
assert.match(historyOnlyHtml,/Ingen aktive feil/);
assert.doesNotMatch(historyOnlyHtml,/data-sde-workshop-active-faults/);
assert.match(historyOnlyHtml,/Historisk stigtrinn/);
assert.doesNotMatch(historyOnlyHtml,/Bestilt utbedring/);

const notOperationalReadback = baseReadback({
  items:[{...operationalRecord,currentStatus:"IKKE_DRIFTSKLAR",registeredAt:"2026-07-26T04:59:00.000Z"}],
  faults:[activeFault],
  repairRequests:[requestedRepair]
});
const notOperationalHtml = api.buildWorkshopVehicleRegistryHtml("74","74-04",notOperationalReadback,capabilities,false);
assert.match(notOperationalHtml,/workshop-vehicle-status is-not-operational/);
assert.match(notOperationalHtml,/Aktiv dørfeil/);
assert.match(notOperationalHtml,/Bestilt utbedring/);
assert.match(notOperationalHtml,/data-sde-workshop-report-operational aria-disabled="false">Registrer Driftsklar/);

const unknownReadback = baseReadback({
  items:[],
  faults:[activeFault],
  repairRequests:[requestedRepair]
});
const unknownHtml = api.buildWorkshopVehicleRegistryHtml("74","74-04",unknownReadback,capabilities,false);
assert.match(unknownHtml,/workshop-vehicle-status is-operational/);
assert.match(unknownHtml,/Aktiv dørfeil/);
assert.match(unknownHtml,/Bestilt utbedring/);
assert.doesNotMatch(unknownHtml,/workshop-vehicle-status is-unknown|workshop-vehicle-status is-not-operational/);

assert.doesNotMatch(extractFunction("getAuthoritativeVehicleStatusPresentation"),/fetch\(|localStorage|sessionStorage/);

process.stdout.write(JSON.stringify({
  schemaVersion:"sde-workshop-active-presentation-hotfix-v1",
  counts:{passed:41,total:41}
}) + "\n");
