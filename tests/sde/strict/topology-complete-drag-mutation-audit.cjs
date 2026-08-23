"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname,"../../..");
const source = fs.readFileSync(path.join(root,"index.html"),"utf8");
const harness = path.join(root,"tests/sde/strict/topology-complete-drag-invariants.cjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),"sde-topology-complete-drag-mutations-"));

function replaceOnce(input,before,after,label){
  const index=input.indexOf(before);
  if(index<0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before,index+before.length)>=0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0,index)+after+input.slice(index+before.length);
}

function mutateFunction(input,name,before,after,label){
  const start=input.indexOf(`function ${name}(`);
  if(start<0) throw new Error(`${label}: function ${name} not found`);
  const next=input.indexOf("\nfunction ",start+10);
  const end=next<0?input.length:next;
  const body=input.slice(start,end);
  return input.slice(0,start)+replaceOnce(body,before,after,label)+input.slice(end);
}

function run(input,label){
  const file=path.join(temporary,`${label}.html`);
  fs.writeFileSync(file,input);
  const execution=childProcess.spawnSync(process.execPath,[harness,file],{
    cwd:root,encoding:"utf8",timeout:90_000,maxBuffer:64*1024*1024
  });
  if(execution.error||execution.signal||![0,1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message||execution.signal||execution.status})`);
  }
  const report=JSON.parse(String(execution.stdout||"").trim().split(/\n/).filter(Boolean).at(-1)||"{}");
  if(report.schemaVersion!=="sde-topology-complete-drag-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution,report};
}

const topologyGuard="if(!sourceDescriptor.canContainVehicle || !targetDescriptor.targetEligible || source === target) return null;";
const mutations=[
  {id:"VN_ONLY_SUPPORTS_2N",expected:["INV-TOPOLOGY-DIRECT-001","INV-TOPOLOGY-MATRIX-001"],apply:input=>mutateFunction(input,"getSdeCanonicalManualRouteTopology",topologyGuard,`if(source === "VN" && target !== "2N") return null; // mutation\n  ${topologyGuard}`,"VN only 2N")},
  {id:"VN_TO_3N_REMOVED",expected:["INV-TOPOLOGY-DIRECT-001"],apply:input=>mutateFunction(input,"getSdeCanonicalManualRouteTopology",topologyGuard,`if(source === "VN" && target === "3N") return null; // mutation\n  ${topologyGuard}`,"remove VN to 3N")},
  {id:"VN_TO_9_REMOVED",expected:["INV-TOPOLOGY-DIRECT-001"],apply:input=>mutateFunction(input,"getSdeCanonicalManualRouteTopology",topologyGuard,`if(source === "VN" && target === "9") return null; // mutation\n  ${topologyGuard}`,"remove VN to 9")},
  {id:"VN_TO_11N_REMOVED",expected:["INV-TOPOLOGY-DIRECT-001"],apply:input=>mutateFunction(input,"getSdeCanonicalManualRouteTopology",topologyGuard,`if(source === "VN" && target === "11N") return null; // mutation\n  ${topologyGuard}`,"remove VN to 11N")},
  {id:"MANUAL_TARGET_REJECTED_BY_SCORE_THRESHOLD",expected:["INV-TOPOLOGY-DIRECT-001","INV-TOPOLOGY-MATRIX-001"],apply:input=>mutateFunction(input,"getSdeCanonicalManualRouteAssessment","  if(!vehicle || !fromSlot || !toSlot || !topology){","  if(Number(row?.recommendationScore || 0) < 1000) return unavailable(\"score threshold rejected manual target\"); // mutation\n  if(!vehicle || !fromSlot || !toSlot || !topology){","manual score threshold")},
  {id:"FIRST_REJECTED_CANDIDATE_TERMINATES_SEARCH",expected:["INV-TOPOLOGY-CANDIDATE-001"],apply:input=>mutateFunction(input,"selectSdeCanonicalSafeRouteCandidate","const safeCandidates = evaluated.filter(candidate=>candidate.valid)","const safeCandidates = evaluated.slice(0,1).filter(candidate=>candidate.valid)", "terminate on first candidate")},
  {id:"DIRECT_SAFE_PLAN_HAS_ZERO_OUTCOME",expected:["INV-TOPOLOGY-DIRECT-002"],apply:input=>mutateFunction(input,"buildSdeCanonicalPlan","const candidateOutcomes = rawRows.map(row=>{","const candidateOutcomes = rawRows.filter(row=>normalizeSlot(row.fromSlot || row.arrivalSlot) !== \"VN\").map(row=>{ // mutation","remove direct outcome")},
  {id:"DIRECT_SAFE_PLAN_HAS_NO_CARD",expected:["INV-TOPOLOGY-DIRECT-002","INV-TOPOLOGY-DIRECT-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalCardProjection","const actionableCards = activeOutcomes.filter(outcome=>","const actionableCards = activeOutcomes.filter(outcome=>outcome.canonicalSourceSlot !== \"VN\").filter(outcome=> // mutation","remove direct card")},
  {id:"DIRECT_SAFE_PLAN_HAS_NO_RESERVATION",expected:["INV-TOPOLOGY-DIRECT-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalReservationProjection","const proposalEntries = projectionCards.flatMap(card=>{","const proposalEntries = projectionCards.filter(card=>card.sourceSlot !== \"VN\").flatMap(card=>{ // mutation","remove direct reservation")},
  {id:"DIRECT_SAFE_PLAN_HAS_NO_OVERLAY",expected:["INV-TOPOLOGY-DIRECT-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalGraphicProjection","const activeCandidates = (cards.actionableCards || []).map(card=>buildOverlay(card,\"active\")).filter(Boolean);","const activeCandidates = (cards.actionableCards || []).filter(card=>card.sourceSlot !== \"VN\").map(card=>buildOverlay(card,\"active\")).filter(Boolean); // mutation","remove direct overlay")},
  {id:"DIRECT_SAFE_PLAN_HAS_NO_ADAPTER",expected:["INV-TOPOLOGY-DIRECT-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalProductionReader","const needsHandlerAdapter = card=>{\n    if(card?.status !== \"exiting\") return true;","const needsHandlerAdapter = card=>{\n    if(card?.sourceSlot === \"VN\") return false; // mutation\n    if(card?.status !== \"exiting\") return true;","remove direct adapter")},
  {id:"OUTCOME_AND_CARD_IDENTITIES_DIVERGE",expected:["INV-TOPOLOGY-DIRECT-005","INV-TOPOLOGY-CHAIN-005"],apply:input=>mutateFunction(input,"buildSdeCanonicalCardProjection","canonicalCardId:identity.canonicalCardId,","canonicalCardId:`${identity.canonicalCardId}|diverged-card`, // mutation","diverge card identity")},
  {id:"RELEASE_STEP_OMITTED",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-003"],apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves","if(freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){","if(false && freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){ // mutation","omit release")},
  {id:"MAIN_STEP_OMITTED",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-003"],apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves","guarded.push({\n        ...guardedMainRow,","if(false) guarded.push({\n        ...guardedMainRow, // mutation","omit main")},
  {id:"RECOVERY_STEP_OMITTED",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-003"],apply:input=>{
    const withoutVn=mutateFunction(input,"buildSdePhysicalBlockerGuardMoves","const returnRow = buildSdeTemporaryVnReturnRow(vnChainPlan);","const returnRow = null; // mutation: omit VN recovery","omit VN recovery");
    return mutateFunction(withoutVn,"buildSdePhysicalBlockerGuardMoves","const returnRow = buildSdeTemporaryAccessReturnRow(accessChainPlan);","const returnRow = null; // mutation: omit access recovery","omit access recovery");
  }},
  {id:"THREE_STEP_ADAPTERS_MISSING",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalProductionReader","const needsHandlerAdapter = card=>{\n    if(card?.status !== \"exiting\") return true;","const needsHandlerAdapter = card=>{\n    if(card?.chainId) return false; // mutation\n    if(card?.status !== \"exiting\") return true;","remove chain adapters")},
  {id:"DEFERRED_RESOURCE_TREATED_AS_ACTIVE_CONFLICT",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-003"],apply:input=>mutateFunction(input,"buildSdeCanonicalReservationProjection","if(sharedResources.length && (!left.chainId || !right.chainId || left.chainId !== right.chainId || !resourceOrdered)){","if(sharedResources.length){ // mutation: deferred resources conflict","deferred resource conflict")},
  {id:"OCCUPIED_10N_DOES_NOT_TRIGGER_10S_RELIEF",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-CHAIN-002"],apply:input=>mutateFunction(input,"getSdeHardPhysicalBlockStateForMove","if(!inputSlots.includes(fromSlot) || !inputSlots.includes(toSlot)) return emptyState;","if(!inputSlots.includes(fromSlot) || !inputSlots.includes(toSlot)) return emptyState;\n  if(toSlot === \"10S\") return emptyState; // mutation","ignore 10N blocker")},
  {id:"BLOCKED_6S_RETURNS_PRESTAGE_INCOMPLETE",expected:["INV-TOPOLOGY-CHAIN-003","INV-TOPOLOGY-CHAIN-004"],apply:input=>mutateFunction(input,"buildSdeTemporaryAccessReliefChainPlan","  if(\n    !blockedRow","  if(normalizeSlot(blockedRow?.recommendedSlot || blockedRow?.toSlot) === \"6S\") return null; // mutation\n  if(\n    !blockedRow","downgrade 6S prestage")},
  {id:"VN_REMOVED_AS_RELIEF_CANDIDATE",expected:["INV-TOPOLOGY-CHAIN-004"],apply:input=>mutateFunction(input,"shouldSdePreferDedicatedVnForTargetAccess",`  return end === "north" && (
    /^(10|11|12)S$/.test(target)
    || getSdeCanonicalSlotRole(target) === "service"
  );`,`  return false; // mutation: VN removed from safe preference`,"remove VN relief")},
  {id:"CARD_2_AND_CARD_3_DELETED_AFTER_CARD_1",expected:["INV-TOPOLOGY-SEQUENCE-001","INV-TOPOLOGY-SEQUENCE-002"],apply:input=>mutateFunction(input,"buildSdeCanonicalProductionReaderSource","snapshot.legacy.finalCards = chainLiveness.operativeRows;",'snapshot.legacy.finalCards = Object.values(snapshot.runtimeState?.actions || {}).some(record=>record?.action === "completed")\n      ? chainLiveness.operativeRows.filter(row=>Number(row?.sdePhysicalChainStep || 0) <= 1)\n      : chainLiveness.operativeRows; // mutation',"delete suffix after card 1")},
  {id:"VEHICLE_ID_CHANGES_PLAN_TOPOLOGY",expected:["INV-TOPOLOGY-CHAIN-001","INV-TOPOLOGY-PERMUTATION-001"],apply:input=>mutateFunction(input,"buildSdePhysicalBlockerGuardMoves","  sourceRows.forEach(row=>{\n    const rowKey = getSdeMoveActionKey(row);\n    if(rowKey && insertedFreeingKeys.has(rowKey)) return;","  sourceRows.forEach(row=>{\n    const rowKey = getSdeMoveActionKey(row);\n    if(String(row?.vehicle || \"\") === \"69-67\"){ guarded.push(row); return; } // mutation\n    if(rowKey && insertedFreeingKeys.has(rowKey)) return;","vehicle-specific policy")}
  ,{id:"DIRECT_VN_MISCLASSIFIED_AS_RECOVERY",expected:["INV-TOPOLOGY-DIRECT-006"],apply:input=>mutateFunction(input,"getSdeCanonicalObligationKind","const semanticVnRecovery = fromVn && Boolean(","const semanticVnRecovery = fromVn || Boolean( // mutation: source alone becomes policy","VN source becomes recovery policy")}
];

const results=[];
try{
  const baseline=run(source,"baseline");
  if(baseline.execution.status!==0||baseline.report.counts?.fail!==0) throw new Error("topology mutation baseline is not green");
  for(const mutation of mutations){
    const mutant=run(mutation.apply(source),mutation.id);
    const failedIds=(mutant.report.results||[]).filter(item=>item.status==="FAIL").map(item=>item.id);
    const killed=mutant.execution.status===1&&mutation.expected.some(id=>failedIds.includes(id));
    results.push({id:mutation.id,status:killed?"PASS":"FAIL",mutantExitCode:mutant.execution.status,expectedInvariants:mutation.expected,failedIds,timeoutKill:false});
  }
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}

const failed=results.filter(item=>item.status!=="PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-topology-complete-drag-mutation-audit-v1",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results
})}\n`);
process.exitCode=failed.length?1:0;
