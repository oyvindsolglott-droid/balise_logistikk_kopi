"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname,"../../..");
const source = fs.readFileSync(path.join(root,"index.html"),"utf8");
const driver = path.join(__dirname,"vehicle-id-policy-invariants.cjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),"sde-vehicle-id-policy-mutations-"));

function replaceOnce(input,before,after,label){
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before,index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0,index) + after + input.slice(index + before.length);
}

function mutateFunction(input,name,before,after,label){
  const start = input.indexOf(`function ${name}(`);
  if(start < 0) throw new Error(`${label}: function ${name} not found`);
  const next = input.indexOf("\nfunction ",start + 10);
  const end = next < 0 ? input.length : next;
  const body = input.slice(start,end);
  return input.slice(0,start) + replaceOnce(body,before,after,label) + input.slice(end);
}

function run(input,label){
  const file = path.join(temporary,`${label}.html`);
  fs.writeFileSync(file,input);
  const execution = childProcess.spawnSync(process.execPath,[driver,file],{
    cwd:root,encoding:"utf8",timeout:120_000,maxBuffer:64 * 1024 * 1024,
  });
  if(execution.error || execution.signal || ![0,1].includes(execution.status)){
    throw new Error(`${label}: policy infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-vehicle-id-policy-invariants-v1") throw new Error(`${label}: unexpected policy schema`);
  return {execution,report};
}

const mutations = [
  {
    id:"EXACT_MOVING_VEHICLE_SELECTS_ROUTE",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"getSdeDirectWashTransitRouteAssessment",
      "  const {vehicle,fromSlot,toSlot} = getSdePhysicalMoveParts(row);",
      "  const {vehicle,fromSlot,toSlot} = getSdePhysicalMoveParts(row);\n  if(vehicle === \"69-63\") return {eligible:false,vehicle,fromSlot,toSlot,routeResources:[],reason:\"mutant exact route\"};",
      "exact moving vehicle route"),
  },
  {
    id:"EXACT_BLOCKER_VEHICLE_SELECTS_RELIEF",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"getSdePhysicalBlockerAccessReliefCandidateOrder",
      "  const from = normalizeSlot(fromSlot);",
      "  if(vehicle === \"75-76\") options = {...options,preferDedicatedVn:false};\n  const from = normalizeSlot(fromSlot);",
      "exact blocker relief"),
  },
  {
    id:"EXACT_VEHICLE_SELECTS_1N",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"buildSdeNightPlacementGeneratedMove",
      "  const toSlot = normalizeSlot(override?.toSlot);",
      "  const toSlot = vehicle === \"70-11\" ? \"1N\" : normalizeSlot(override?.toSlot);",
      "exact 1N fallback"),
  },
  {
    id:"EXACT_VEHICLE_SELECTS_VN",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"buildSdeNightPlacementGeneratedMove",
      "  const toSlot = normalizeSlot(override?.toSlot);",
      "  const toSlot = vehicle === \"74-51\" ? \"VN\" : normalizeSlot(override?.toSlot);",
      "exact VN selection"),
  },
  {
    id:"EXACT_VEHICLE_SELECTS_RECOVERY",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"buildSdeTemporaryAccessReturnRow",
      "  const targetSlot = normalizeSlot(plan.returnTargetSlot);",
      "  const targetSlot = plan.blockerVehicle === \"75-76\" ? \"1N\" : normalizeSlot(plan.returnTargetSlot);",
      "exact recovery selection"),
  },
  {
    id:"EXACT_VEHICLE_PAIR_CREATES_THREE_CARD_CHAIN",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"getSdeCompleteTrappedEgressBlockState",
      "  const occupancy = getSdeTrappedEgressActualOccupancy();",
      "  const occupancy = getSdeTrappedEgressActualOccupancy();\n  if(vehicle === \"70-11\" && occupancy.get(\"6N\") === \"75-76\") return {...original,hardBlocked:true,kind:\"mutant_exact_pair\"};",
      "exact pair chain"),
  },
  {
    id:"FIXTURE_IMPORTED_INTO_PRODUCTION_PLANNER",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-004"],
    apply:input=>replaceOnce(input,
      "const inputSlots=[",
      "const historicalVehicleFixture = require(\"./sde_scenarios\"); // mutation: production fixture import\nconst inputSlots=[",
      "fixture import"),
  },
  {
    id:"VEHICLE_ID_PERMUTATION_CHANGES_PLAN",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves",
      "  const rawRows = applySdeCanonicalRetargetIntentsToRows(Array.isArray(rows) ? rows : []);",
      "  if(rows.some(row=>row?.vehicle === \"69-63\")) return rows.map(row=>({...row,recommendedSlot:\"1N\",toSlot:\"1N\"}));\n  const rawRows = applySdeCanonicalRetargetIntentsToRows(Array.isArray(rows) ? rows : []);",
      "ID permutation changes plan"),
  },
  {
    id:"EXACT_TRAIN_VEHICLE_BINDING_REINTRODUCED",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"getSdeServiceTrackNightRole",
      "  const arrivalTrain = String(need?.arrivalTrain || \"\").trim();",
      "  const arrivalTrain = String(need?.arrivalTrain || \"\").trim();\n  if(arrivalTrain === \"835\" && need?.vehicle === \"74-20\") return \"6S\";",
      "exact train vehicle binding"),
  },
  {
    id:"SAME_SEMANTIC_STATE_DIFFERENT_ID_REJECTED",expected:["INV-VEHICLE-ID-POLICY-001","INV-VEHICLE-ID-POLICY-002"],
    apply:input=>mutateFunction(input,"getSdeDirectWashTransitRouteAssessment",
      "  const {vehicle,fromSlot,toSlot} = getSdePhysicalMoveParts(row);",
      "  const {vehicle,fromSlot,toSlot} = getSdePhysicalMoveParts(row);\n  if(vehicle === \"74-51\") return {eligible:false,vehicle,fromSlot,toSlot,routeResources:[],reason:\"mutant semantic-state rejection\"};",
      "same semantic state rejected by ID"),
  },
];

const results = [];
try{
  const baseline = run(source,"baseline");
  if(baseline.execution.status !== 0 || baseline.report.results?.some(item=>item.status !== "PASS")){
    throw new Error("vehicle ID policy mutation baseline is not green");
  }
  for(const mutation of mutations){
    const mutant = run(mutation.apply(source),mutation.id);
    const failedIds = (mutant.report.results || []).filter(item=>item.status === "FAIL").map(item=>item.id);
    const killed = mutant.execution.status === 1 && mutation.expected.every(id=>failedIds.includes(id));
    results.push({id:mutation.id,status:killed?"PASS":"FAIL",mutantExitCode:mutant.execution.status,expectedInvariants:mutation.expected,failedIds});
  }
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}

const failed = results.filter(item=>item.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-vehicle-id-policy-mutation-audit-v1",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results,
})}\n`);
process.exitCode=failed.length?1:0;
