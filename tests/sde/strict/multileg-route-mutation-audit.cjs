"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const harness = path.join(root, "tests/sde/harnesses/sde-route-12n-via-vs-to-6s-harness.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-multileg-route-mutations-"));

function replaceOnce(input, before, after, label) {
  const index = input.indexOf(before);
  if (index < 0) throw new Error(`${label}: mutation anchor not found`);
  if (input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function mutateFunction(input, name, before, after, label) {
  const start = input.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${label}: function ${name} not found`);
  const next = input.indexOf("\nfunction ", start + 10);
  const end = next < 0 ? input.length : next;
  const body = input.slice(start, end);
  const mutated = replaceOnce(body, before, after, label);
  return input.slice(0, start) + mutated + input.slice(end);
}

function run(input, label) {
  const file = path.join(temporary, `${label}.html`);
  fs.writeFileSync(file, input);
  const execution = childProcess.spawnSync(process.execPath, [harness, file], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (execution.error || execution.signal || ![0, 1].includes(execution.status)) {
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const line = String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1);
  const report = JSON.parse(line || "{}");
  if (report.schemaVersion !== "sde-route-12n-via-vs-to-6s-harness-v1") {
    throw new Error(`${label}: unexpected harness schema`);
  }
  return {execution, report};
}

const mutations = [
  {
    id:"MAIN_ROUTE_FORCED_DIRECT_ONLY",
    expected:["INV-MULTILEG-006","INV-MULTILEG-008"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalAccessReliefRoute",
      '{sourceSlot:plan.blockedFromSlot,targetSlot:plan.mainTargetSlot,viaSlots:["VS"],reversalPoint:"VS",approachSide:"NORTH",routeResources:["VS"],active:false}',
      '{sourceSlot:plan.blockedFromSlot,targetSlot:plan.mainTargetSlot,viaSlots:[],reversalPoint:"",approachSide:"NORTH",routeResources:[],active:false}',
      "force main route direct"),
  },
  {
    id:"VS_REMOVED_AS_WAYPOINT",
    expected:["INV-MULTILEG-005","INV-MULTILEG-009"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalMultilegRoute",
      "const via = Array.from(new Set((Array.isArray(viaSlots) ? viaSlots : []).map(normalizeSlot).filter(Boolean)));",
      "const via = []; // mutation: VS removed as waypoint",
      "remove VS waypoint"),
  },
  {
    id:"VS_REMOVED_AS_REVERSAL_POINT",
    expected:["INV-MULTILEG-006","INV-MULTILEG-009"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalAccessReliefRoute",
      'reversalPoint:"VS",approachSide:"NORTH"',
      'reversalPoint:"",approachSide:"NORTH"',
      "remove VS reversal"),
  },
  {
    id:"TARGET_REQUIRES_BOTH_SIDES_CLEAR",
    expected:["INV-MULTILEG-003","INV-MULTILEG-011"],
    apply:input=>mutateFunction(input,"buildSdeTemporaryAccessReliefMainRouteAssessment",
      "&& blockingSlots.length === 0\n    && internalBlockingSlots.length === 0;",
      "&& blockingSlots.length === 0\n    && internalBlockingSlots.length === 0\n    && getSdeAccessOptionsForSlot(mainTargetSlot,\"target\").every(option=>option.clear === true);",
      "require both target sides"),
  },
  {
    id:"OCCUPIED_6SS_REJECTS_NORTH_APPROACH",
    expected:["INV-MULTILEG-011","INV-MULTILEG-014"],
    apply:input=>mutateFunction(input,"buildSdeTemporaryAccessReliefMainRouteAssessment",
      "const safe = !targetVehicle",
      "const safe = !virtualOccupancy.get(\"6SS\") && !targetVehicle // mutation: unrelated south occupancy rejects north approach",
      "reject occupied south neighbor"),
  },
  {
    id:"DEFERRED_VS_ROUTE_TREATED_AS_ACTIVE_CONFLICT",
    expected:["INV-MULTILEG-015","INV-MULTILEG-018"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalReservationProjection",
      "if(sharedResources.length && (!left.chainId || !right.chainId || left.chainId !== right.chainId || !resourceOrdered)){",
      "if(sharedResources.length){ // mutation: deferred resources conflict as active",
      "deferred route conflict"),
  },
  {
    id:"VN_AND_VS_COLLAPSED_TO_SAME_ROLE",
    expected:["INV-MULTILEG-005","INV-MULTILEG-010"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalAccessReliefRoute",
      '{sourceSlot:plan.blockerFromSlot,targetSlot:"VN",viaSlots:["VS"],routeResources:["VS"],active:true}',
      '{sourceSlot:plan.blockerFromSlot,targetSlot:"VS",viaSlots:["VN"],routeResources:["VN"],active:true}',
      "collapse VN and VS roles"),
  },
  {
    id:"RELEASE_CARD_OMITTED",
    expected:["INV-MULTILEG-003","INV-MULTILEG-005"],
    apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves",
      "if(freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){",
      "if(false && freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){",
      "omit release card"),
  },
  {
    id:"MAIN_CARD_OMITTED",
    expected:["INV-MULTILEG-003","INV-MULTILEG-006"],
    apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves",
      "guarded.push({\n        ...guardedMainRow,",
      "if(false) guarded.push({\n        ...guardedMainRow,",
      "omit main card"),
  },
  {
    id:"RECOVERY_CARD_OMITTED",
    expected:["INV-MULTILEG-003","INV-MULTILEG-007"],
    apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves",
      "const returnRow = buildSdeTemporaryAccessReturnRow(accessChainPlan);",
      "const returnRow = null; // mutation: recovery omitted",
      "omit recovery card"),
  },
  {
    id:"MAIN_TARGET_REPLACED_WITH_1N",
    expected:["INV-MULTILEG-006","INV-MULTILEG-025"],
    apply:input=>mutateFunction(input,"annotateSdeTemporaryAccessReliefMainRow",
      "const annotated = {\n    ...row,",
      'const annotated = {\n    ...row,\n    recommendedSlot:"1N",\n    toSlot:"1N",',
      "replace main target"),
  },
  {
    id:"PRESTAGE_FAILURE_RETURNS_DIAGNOSTIC_WITH_SAFE_PLAN",
    expected:["INV-MULTILEG-002","INV-MULTILEG-017"],
    apply:input=>mutateFunction(input,"buildSdeTemporaryAccessReliefChainPlan",
      "  return {\n    context:SDE_TARGET_ACCESS_TEMPORARY_RELIEF_CONTEXT,",
      "  return null; // mutation: safe complete plan downgraded\n  return {\n    context:SDE_TARGET_ACCESS_TEMPORARY_RELIEF_CONTEXT,",
      "downgrade safe plan"),
  },
  {
    id:"CARD_2_AND_CARD_3_DELETED_AFTER_CARD_1",
    expected:["INV-MULTILEG-020","INV-MULTILEG-021"],
    apply:input=>mutateFunction(input,"buildSdeCanonicalProductionReaderSource",
      "snapshot.legacy.finalCards = chainLiveness.operativeRows;",
      'snapshot.legacy.finalCards = Object.values(snapshot.runtimeState?.actions || {}).some(record=>record?.action === "completed")\n      ? chainLiveness.operativeRows.filter(row=>Number(row?.sdePhysicalChainStep || 0) <= 1)\n      : chainLiveness.operativeRows; // mutation: delete card 2 and 3 after card 1',
      "delete suffix after card 1"),
  },
  {
    id:"ACTUAL_PLACEMENT_CHANGED_DURING_PLANNING",
    expected:["INV-MULTILEG-019"],
    apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves",
      "const reconciledRows = reconcileSdeFinalVnRecoveryRows(guarded, sourceRows);",
      "const reconciledRows = reconcileSdeFinalVnRecoveryRows(guarded, sourceRows); state.grunnoppstilling[\"6S\"] = \"70-11\"; // mutation: planning writes actual",
      "planning mutates actual state"),
  },
];

const results = [];
try {
  const baseline = run(source, "baseline");
  if (baseline.execution.status !== 0 || baseline.report.pass !== true) throw new Error("multileg mutation baseline is not green");
  for (const mutation of mutations) {
    const mutant = run(mutation.apply(source), mutation.id);
    const failedIds = (mutant.report.results || []).filter(item=>item.status === "FAIL").map(item=>item.id);
    const killed = mutant.execution.status === 1 && mutation.expected.some(id=>failedIds.includes(id));
    results.push({id:mutation.id,status:killed ? "PASS" : "FAIL",mutantExitCode:mutant.execution.status,expectedInvariants:mutation.expected,failedIds});
  }
} finally {
  fs.rmSync(temporary, {recursive:true, force:true});
}

const failed = results.filter(item=>item.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-multileg-route-mutation-audit-v1",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
