"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const harness = path.join(root, "tests/sde/harnesses/sde-false-already-at-target-12n-11n-harness.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-actual-drag-source-mutations-"));

function replaceOnce(input, before, after, label) {
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before,index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0,index) + after + input.slice(index + before.length);
}

function mutateFunction(input, name, before, after, label) {
  const start = input.indexOf(`function ${name}(`);
  if(start < 0) throw new Error(`${label}: function ${name} not found`);
  const next = input.indexOf("\nfunction ",start + 10);
  const end = next < 0 ? input.length : next;
  const body = input.slice(start,end);
  return input.slice(0,start) + replaceOnce(body,before,after,label) + input.slice(end);
}

function run(input,label) {
  const file = path.join(temporary,`${label}.html`);
  fs.writeFileSync(file,input);
  const execution = childProcess.spawnSync(process.execPath,[harness,file],{
    cwd:root,encoding:"utf8",timeout:120_000,maxBuffer:64 * 1024 * 1024,
  });
  if(execution.error || execution.signal || ![0,1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-false-already-at-target-12n-11n-harness-v1"){
    throw new Error(`${label}: unexpected harness schema`);
  }
  return {execution,report};
}

const locationAnchor = "const placement = snapshot.placementsByVehicle?.[token] || null;";
const sourceMismatchReturn = "return invalid(\n      `Tilstandsavvik: rendered source ${renderedSourceSlot} og canonical actual source ${canonicalLocation.slot} bruker ikke samme revision. Visningen må reconcileres før ny planlegging.`\n    );";
const mutations = [
  {
    id:"DRAG_SOURCE_REPLACED_WITH_TARGET",expected:["INV-ACTUAL-DRAG-001","INV-ACTUAL-DRAG-008"],
    apply:input=>mutateFunction(input,"buildSdeNightPlacementDragIntentPayload",
      "dataset.sdeNightPlacementRenderedSourceSlot || dataset.sdeNightPlacementFromSlot",
      "dataset.sdeNightPlacementCurrentSlot || dataset.sdeNightPlacementFromSlot",
      "replace rendered source with displayed target"),
  },
  {
    id:"STALE_LOCATION_INDEX_USED_WITHOUT_REVISION_CHECK",expected:["INV-ACTUAL-DRAG-005"],
    apply:input=>mutateFunction(input,"reconcileSdeNightPlacementDragIntent",
      "let revisionMismatch = !renderedActualRevision || renderedActualRevision !== snapshot.actualRevision;",
      "let revisionMismatch = false; // mutation: revision check removed",
      "remove revision check"),
  },
  {
    id:"RESERVATION_TREATED_AS_ACTUAL_LOCATION",expected:["INV-ACTUAL-DRAG-003"],
    apply:input=>mutateFunction(input,"getSdeCanonicalActualLocationForVehicle",locationAnchor,
      "const reserved = Object.values(state.sdeNightPlacementManualOverrides || {})[0];\n  if(reserved?.toSlot) return {slot:normalizeSlot(reserved.toSlot),vehicleId:vehicle,actualRevision:snapshot.actualRevision};\n  " + locationAnchor,
      "treat reservation as actual"),
  },
  {
    id:"PLANNED_TARGET_TREATED_AS_ACTUAL_LOCATION",expected:["INV-ACTUAL-DRAG-004"],
    apply:input=>mutateFunction(input,"getSdeCanonicalActualLocationForVehicle",locationAnchor,
      "const historical = Object.values(state.sdeMoveActions || {})[0];\n  if(historical?.toSlot) return {slot:normalizeSlot(historical.toSlot),vehicleId:vehicle,actualRevision:snapshot.actualRevision};\n  " + locationAnchor,
      "treat historical target as actual"),
  },
  {
    id:"ALREADY_AT_TARGET_CHECK_IGNORES_SOURCE_SLOT",expected:["INV-ACTUAL-DRAG-002"],
    apply:input=>mutateFunction(input,"reconcileSdeNightPlacementDragIntent",
      "&& renderedSourceSlot === requestedTarget",
      "&& true // mutation: rendered source ignored",
      "ignore source in no-op"),
  },
  {
    id:"SOURCE_MISMATCH_RETURNS_FALSE_NOOP",expected:["INV-ACTUAL-DRAG-002"],
    apply:input=>mutateFunction(input,"reconcileSdeNightPlacementDragIntent",sourceMismatchReturn,
      "return {...invalid(`Tilstandsavvik mutert til falsk no-op.`),ok:true,stateDesync:false,noOpAuthorized:true,effectiveSourceSlot:canonicalLocation.slot,plannerActualRevision:snapshot.actualRevision,uniqueIdentity:true};",
      "return false no-op on source mismatch"),
  },
  {
    id:"POLLING_UPDATES_DOM_BUT_NOT_PLANNER_INDEX",expected:["INV-ACTUAL-DRAG-001"],
    apply:input=>mutateFunction(input,"applySharedSporplanDraftToActiveState",
      "rebuildSdeNightPlacementCanonicalActualIndex();",
      "// mutation: planner actual index remains stale",
      "remove polling index rebuild"),
  },
  {
    id:"DUPLICATE_ACTUAL_PLACEMENT_ACCEPTED",expected:["INV-ACTUAL-DRAG-007"],
    apply:input=>mutateFunction(input,"buildSdeNightPlacementCanonicalActualStateSnapshot",
      "const valid = duplicateVehicleTokens.length === 0 && duplicateSlots.length === 0;",
      "const valid = true; // mutation: duplicate actual accepted",
      "accept duplicate actual"),
  },
  {
    id:"AUTOMATIC_RECONCILIATION_REMOVED",expected:["INV-ACTUAL-DRAG-005"],
    apply:input=>mutateFunction(input,"reconcileSdeNightPlacementDragIntent",
      "if(sourceMismatch || revisionMismatch){",
      "if(false && (sourceMismatch || revisionMismatch)){",
      "remove automatic reconciliation"),
  },
  {
    id:"ORIGINAL_DRAG_INTENT_DROPPED_AFTER_REFRESH",expected:["INV-ACTUAL-DRAG-006","INV-ACTUAL-DRAG-009"],
    apply:input=>mutateFunction(input,"applySdeNightPlacementDragOverride",
      "assessment.intentId || payload?.intentId || `night-drag-${Date.now()}`",
      "`night-drag-${Date.now()}`",
      "drop original intent identity"),
  },
];

const results = [];
try{
  const baseline = run(source,"baseline");
  if(baseline.execution.status !== 0 || baseline.report.pass !== true) throw new Error("actual drag mutation baseline is not green");
  for(const mutation of mutations){
    const mutant = run(mutation.apply(source),mutation.id);
    const failedIds = (mutant.report.results || []).filter(item=>item.status === "FAIL").map(item=>item.id);
    const killed = mutant.execution.status === 1 && mutation.expected.some(id=>failedIds.includes(id));
    results.push({id:mutation.id,status:killed?"PASS":"FAIL",mutantExitCode:mutant.execution.status,expectedInvariants:mutation.expected,failedIds});
  }
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}

const failed = results.filter(item=>item.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-actual-drag-source-mutation-audit-v1",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
