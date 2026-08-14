"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];
const invariantIds = [
  "COMPLETING_RELEASE_MUST_NOT_DELETE_MAIN_OR_RECOVERY",
  "COMPLETED_PREFIX_PRESERVED_REMAINING_SUFFIX_ACTIVE",
  "EXPECTED_TEMP_OCCUPANT_IS_NOT_A_CONFLICT",
  "STATE_CHANGE_TRIGGERS_AUTOMATIC_SUFFIX_REPLAN",
  "REPLAN_PRESERVES_ORIGINAL_MAIN_INTENT",
  "REPLAN_ATOMICALLY_REPLACES_STALE_SUFFIX",
  "SYSTEM_ERROR_DOES_NOT_CANCEL_VALID_CHAIN",
  "AVAILABLE_VN_PREFERRED_OVER_ORDINARY_OPERATIONAL_TRACKS",
  "AVAILABLE_VN_MUST_BE_EVALUATED_BEFORE_UNRESOLVED",
  "ONE_REJECTED_RELIEF_CANDIDATE_DOES_NOT_END_SEARCH",
  "RECOVERY_USES_POST_MAIN_TOPOLOGY",
  "RECOVERY_DOES_NOT_CREATE_TRAPPED_EMPTY_SLOT",
  "NO_PARTIAL_OPERATIVE_PROJECTION",
  "ACTUAL_PLACEMENT_CHANGES_ONLY_AFTER_AUTHORIZED_COMPLETION",
];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__suffixPersistenceResults = results;
globalThis.__suffixPersistenceRecord = record;

try {
eval(prefix + String.raw`
(()=>{
  const put=globalThis.__suffixPersistenceRecord;
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const role=(rows,name)=>rows.find(row=>row?.sdePhysicalDependencyRole===name)||null;
  const direct=(vehicle,from,to,id)=>{
    const actionKey=["night-placement-drag",vehicle,from,to,id].join("|");
    return {
      vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to,
      stableActionKey:actionKey,sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
      source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:id,manualPlanId:"manual-graphic-order|"+id,
      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true,
      sdePreferDedicatedVnRelief:true
    };
  };
  const placements=[["6S","SUFFIX-MAIN"],["6N","SUFFIX-BLOCKER"],["1N","ORDINARY-OCCUPIED"]];
  const main=direct("SUFFIX-MAIN","6S","11S","suffix-persistence-intent");
  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const actualBefore=JSON.stringify(appState.grunnoppstilling||{});
  const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([main],{reconcileActive:false});
  const actualAfterInitialPlanning=JSON.stringify(appState.grunnoppstilling||{});
  const initialReader=ctx.buildSdeCanonicalProductionReader(snapshot(initialRows,placements,{}));
  const release=role(initialRows,"prerequisite");
  const initialMain=role(initialRows,"dependent");
  const initialRecovery=role(initialRows,"return");
  const releaseKey=ctx.getSdeMoveActionKey(release);
  const chainId=release?.sdePhysicalChainId||"";
  const initialRevision=release?.sdePhysicalPlanRevision||"";
  const completedActions={
    [releaseKey]:{
      action:"completed",vehicle:release.vehicle,fromSlot:release.fromSlot,toSlot:release.toSlot,
      time:"2026-08-14T08:00:00.000Z",snapshot:ctx.getSdeMoveActionSnapshot(release)
    }
  };
  const progressedPlacements=placements.filter(([slot])=>slot!==release.fromSlot).concat([[release.toSlot,release.vehicle]]);
  resetState(progressedPlacements,{sdeMoveActions:completedActions});
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const suffixRows=ctx.buildSdePhysicalBlockerGuardMoves([main],{reconcileActive:false});
  const suffixSnapshot=snapshot(suffixRows,progressedPlacements,completedActions);
  const suffixReader=ctx.buildSdeCanonicalProductionReader(suffixSnapshot);
  const suffixCards=allCards(suffixReader);
  const suffixMain=role(suffixRows,"dependent");
  const suffixRecovery=role(suffixRows,"return");
  const chain=suffixReader.cardProjection.chains?.find(item=>item.chainId===chainId)||null;
  const completedPrefix=(suffixReader.canonicalPlan.candidateOutcomes||[]).filter(item=>item.chainId===chainId&&item.status==="completed");
  const operativeOutcomes=(suffixReader.canonicalPlan.candidateOutcomes||[]).filter(item=>item.chainId===chainId&&item.status!=="completed");
  const completeSuffix=Boolean(
    suffixRows.length===2
    && suffixRows.map(row=>row.sdePhysicalDependencyRole).join(",")==="dependent,return"
    && suffixCards.length===2
    && suffixCards.map(card=>card.status).join(",")==="actionable,blocked_chain_step"
    && (suffixReader.reservationProjection.reservations||[]).filter(item=>item.chainId===chainId).length===2
    && allOverlays(suffixReader).filter(item=>item.chainId===chainId).length===2
    && suffixReader.integrityReport.status==="PASS"
  );
  const expectedOccupancyConflicts=(suffixReader.canonicalPlan.conflicts||[]).filter(item=>
    ["TARGET_PHYSICALLY_OCCUPIED","target_occupied","overlapping_target_reservation"].includes(item.code)
    && (item.targetSlot==="VN"||(item.targetSlots||[]).includes("VN"))
  );
  const slotFixtures=[
    {source:"4M",blockers:["4N","4S"]},
    {source:"5M",blockers:["5N","5S"]},
    {source:"6S",blockers:["6N","6SS"]},
    {source:"10S",blockers:["10N"]},
    {source:"11S",blockers:["11N"]},
    {source:"12S",blockers:["12N"]}
  ];
  const slotCompletionCoverage=slotFixtures.map((fixture,index)=>{
    const slotMain=direct("SUFFIX-SLOT-MAIN-"+fixture.source,fixture.source,"9","suffix-slot-"+fixture.source);
    const slotPlacements=[[fixture.source,slotMain.vehicle],...fixture.blockers.map((slot,blockerIndex)=>[slot,"SUFFIX-SLOT-BLOCKER-"+index+"-"+blockerIndex])];
    resetState(slotPlacements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const beforeRows=ctx.buildSdePhysicalBlockerGuardMoves([slotMain],{reconcileActive:false});
    const first=role(beforeRows,"prerequisite");
    const firstKey=ctx.getSdeMoveActionKey(first);
    if(!first||!firstKey) return {slot:fixture.source,pass:false,reason:"missing release"};
    const progressed=slotPlacements.filter(([slot])=>slot!==first.fromSlot).concat([[first.toSlot,first.vehicle]]);
    const actions={[firstKey]:{action:"completed",vehicle:first.vehicle,fromSlot:first.fromSlot,toSlot:first.toSlot,time:"2026-08-14T08:10:00.000Z",snapshot:ctx.getSdeMoveActionSnapshot(first)}};
    resetState(progressed,{sdeMoveActions:actions});
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const afterRows=ctx.buildSdePhysicalBlockerGuardMoves([slotMain],{reconcileActive:false});
    const slotChainId=String(first.sdePhysicalChainId||"");
    const relevantRows=afterRows.filter(row=>row?.sdePhysicalChainId===slotChainId);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(afterRows,progressed,actions));
    const cards=allCards(reader).filter(card=>card.chainId===slotChainId);
    const conflicts=(reader.canonicalPlan.conflicts||[]).filter(item=>
      item.chainId===slotChainId||item.chainScope===slotChainId
    );
    const unexpectedProgressed=progressed
      .filter(([slot])=>slot!==first.toSlot&&slot!=="1S")
      .concat([["VN","SUFFIX-UNEXPECTED-"+index],["1S",first.vehicle]]);
    resetState(unexpectedProgressed,{sdeMoveActions:actions});
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const unexpectedBefore=JSON.stringify(appState.grunnoppstilling||{});
    const replannedRows=ctx.buildSdePhysicalBlockerGuardMoves([slotMain],{reconcileActive:false});
    const replannedRelevant=replannedRows.filter(row=>row?.sdePhysicalChainId===slotChainId);
    const replannedReader=ctx.buildSdeCanonicalProductionReader(snapshot(replannedRows,unexpectedProgressed,actions));
    const replannedCards=allCards(replannedReader).filter(card=>card.chainId===slotChainId);
    const replannedMain=role(replannedRelevant,"dependent");
    const replannedRecovery=role(replannedRelevant,"return");
    const replanPass=Boolean(
      replannedRelevant.map(row=>row.sdePhysicalDependencyRole).join(",")==="dependent,return"
      && replannedCards.map(card=>card.status).join(",")==="actionable,blocked_chain_step"
      && replannedMain?.fromSlot===fixture.source
      && replannedMain?.toSlot==="9"
      && replannedMain?.sdeNightPlacementDragIdentity===slotMain.sdeNightPlacementDragIdentity
      && replannedRecovery?.fromSlot==="1S"
      && replannedRecovery?.toSlot===fixture.source
      && replannedReader.integrityReport.status==="PASS"
      && unexpectedBefore===JSON.stringify(appState.grunnoppstilling||{})
    );
    const pass=Boolean(
      relevantRows.map(row=>row.sdePhysicalDependencyRole).join(",")==="dependent,return"
      && cards.map(card=>card.status).join(",")==="actionable,blocked_chain_step"
      && reader.integrityReport.status==="PASS"
      && conflicts.every(item=>item.code!=="target_physically_occupied")
      && replanPass
    );
    return {slot:fixture.source,pass,release:[first.fromSlot,first.toSlot],releaseKey:firstKey,accessPlan:first.sdePhysicalAccessReliefChain?.context||"",vnPlan:first.sdePhysicalVnReliefChain?.context||"",releaseResources:first.sdeTrappedEgressRouteResources,suffix:relevantRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),statuses:cards.map(card=>card.status),integrity:reader.integrityReport.status,integrityConflicts:(reader.integrityReport.conflicts||[]).map(item=>({classification:item.classification,reason:item.reason,stepId:item.stepId,obligationId:item.obligationId})),unexpectedReplan:{pass:replanPass,suffix:replannedRelevant.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),statuses:replannedCards.map(card=>card.status),integrity:replannedReader.integrityReport.status}};
  });
  const allSlotCompletionsPass=slotCompletionCoverage.length===6&&slotCompletionCoverage.every(item=>item.pass);

  put("COMPLETING_RELEASE_MUST_NOT_DELETE_MAIN_OR_RECOVERY",completeSuffix&&allSlotCompletionsPass,JSON.stringify({rows:suffixRows.map(row=>[row.sdePhysicalDependencyRole,row.fromSlot,row.toSlot]),cards:suffixCards.map(card=>card.status),slotCompletionCoverage}));
  put("COMPLETED_PREFIX_PRESERVED_REMAINING_SUFFIX_ACTIVE",completedPrefix.length===1&&operativeOutcomes.length===2&&(chain?.steps||[]).filter(step=>step.status==="completed").length===1&&chain?.stepCount===3,JSON.stringify({completed:completedPrefix.length,operative:operativeOutcomes.length,chain}));
  put("EXPECTED_TEMP_OCCUPANT_IS_NOT_A_CONFLICT",expectedOccupancyConflicts.length===0&&allSlotCompletionsPass,JSON.stringify({conflicts:expectedOccupancyConflicts.map(item=>item.code),slotCompletionCoverage}));

  const unexpectedPlacements=progressedPlacements.filter(([slot])=>slot!=="VN").concat([["VN","UNEXPECTED-THIRD-PARTY"],["4M","SUFFIX-BLOCKER"]]);
  resetState(unexpectedPlacements,{sdeMoveActions:completedActions});
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const replannedRows=ctx.buildSdePhysicalBlockerGuardMoves([main],{reconcileActive:false});
  const replannedReader=ctx.buildSdeCanonicalProductionReader(snapshot(replannedRows,unexpectedPlacements,completedActions));
  const replannedChainRows=replannedRows.filter(row=>row?.sdePhysicalChainId===chainId);
  const replannedMain=role(replannedChainRows,"dependent");
  const replannedRecovery=role(replannedChainRows,"return");
  const replanCards=allCards(replannedReader);
  const replanComplete=Boolean(
    replannedChainRows.length===2&&replannedMain&&replannedRecovery
    && replanCards.length===2&&replanCards.map(card=>card.status).join(",")==="actionable,blocked_chain_step"
    && replannedReader.integrityReport.status==="PASS"
  );
  const originalIntentPreserved=Boolean(
    replannedMain?.sdeNightPlacementDragIdentity===main.sdeNightPlacementDragIdentity
    && replannedMain?.fromSlot==="6S"&&replannedMain?.toSlot==="11S"
    && replannedMain?.sdePhysicalChainId===chainId
  );
  const oldAndNewSuffixTargets=new Set(replannedChainRows.filter(row=>row.sdePhysicalDependencyRole==="return").map(row=>row.fromSlot));
  put("STATE_CHANGE_TRIGGERS_AUTOMATIC_SUFFIX_REPLAN",replanComplete,JSON.stringify({rows:replannedChainRows.map(row=>[row.sdePhysicalDependencyRole,row.fromSlot,row.toSlot]),integrity:replannedReader.integrityReport.status}));
  put("REPLAN_PRESERVES_ORIGINAL_MAIN_INTENT",originalIntentPreserved,JSON.stringify({intent:replannedMain?.sdeNightPlacementDragIdentity,from:replannedMain?.fromSlot,to:replannedMain?.toSlot,chainId:replannedMain?.sdePhysicalChainId}));
  put("REPLAN_ATOMICALLY_REPLACES_STALE_SUFFIX",replanComplete&&oldAndNewSuffixTargets.size===1&&oldAndNewSuffixTargets.has("4M")&&!replanCards.some(card=>card.targetSlot==="VN"),JSON.stringify({recoverySources:[...oldAndNewSuffixTargets],cards:replanCards.map(card=>[card.sourceSlot,card.targetSlot])}));
  put("SYSTEM_ERROR_DOES_NOT_CANCEL_VALID_CHAIN",replanComplete&&!Object.values(appState.sdeMoveActions||{}).some(record=>record?.action==="cancelled")&&!replannedChainRows.some(row=>row?.sdeCancellationDismissalCard),JSON.stringify({actionTypes:Object.values(appState.sdeMoveActions||{}).map(record=>record?.action),rows:replannedChainRows.length}));

  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const order=ctx.getSdeTrappedEgressTemporaryCandidateOrder("6N",["6S","11S"],{preferDedicatedVn:true});
  const preferredRows=ctx.buildSdePhysicalBlockerGuardMoves([main],{reconcileActive:false});
  const preferredRelease=role(preferredRows,"prerequisite");
  put("AVAILABLE_VN_PREFERRED_OVER_ORDINARY_OPERATIONAL_TRACKS",order[0]==="VN"&&preferredRelease?.toSlot==="VN",JSON.stringify({order,target:preferredRelease?.toSlot}));
  put("AVAILABLE_VN_MUST_BE_EVALUATED_BEFORE_UNRESOLVED",preferredRelease?.toSlot==="VN"&&!preferredRows.some(row=>row.sdeTrappedEgressDiagnosticOnly||row.sdePhysicalNoSafeReleaseMove),JSON.stringify(preferredRows.map(row=>({target:row.toSlot,diagnostic:row.sdeTrappedEgressDiagnosticOnly}))));
  const rejection=ctx.setSdeCanonicalRetargetIntent(preferredRelease,{mode:"reject_target",rejectedTarget:"VN"});
  appState.grunnoppstilling={...appState.grunnoppstilling,"4M":"REJECTED-ALTERNATIVE-OCCUPIED"};
  const searchedRows=ctx.buildSdePhysicalBlockerGuardMoves([main],{reconcileActive:false});
  const searchedRelease=role(searchedRows,"prerequisite");
  put("ONE_REJECTED_RELIEF_CANDIDATE_DOES_NOT_END_SEARCH",rejection.ok===true&&searchedRelease&&searchedRelease.toSlot!=="VN"&&searchedRelease.toSlot!=="4M",JSON.stringify({rejected:rejection.ok,next:searchedRelease?.toSlot}));
  put("RECOVERY_USES_POST_MAIN_TOPOLOGY",initialRecovery?.sdeRecoveryUsesPostMainTopology===true&&initialRecovery?.toSlot==="6S",JSON.stringify({from:initialRecovery?.fromSlot,to:initialRecovery?.toSlot,postMain:initialRecovery?.sdeRecoveryUsesPostMainTopology}));
  put("RECOVERY_DOES_NOT_CREATE_TRAPPED_EMPTY_SLOT",initialRecovery?.toSlot==="6S"&&initialRecovery?.toSlot!==release?.fromSlot,JSON.stringify({releaseSource:release?.fromSlot,recoveryTarget:initialRecovery?.toSlot}));
  put("NO_PARTIAL_OPERATIVE_PROJECTION",completeSuffix&&replanComplete&&allSlotCompletionsPass&&suffixCards.length===operativeOutcomes.length,JSON.stringify({suffixCards:suffixCards.length,suffixOutcomes:operativeOutcomes.length,replanCards:replanCards.length,slotCompletionCoverage}));
  put("ACTUAL_PLACEMENT_CHANGES_ONLY_AFTER_AUTHORIZED_COMPLETION",actualBefore===actualAfterInitialPlanning&&initialReader.graphicProjection.actualSlots.some(item=>item.vehicleId==="SUFFIX-BLOCKER"&&item.slot==="6N"),JSON.stringify({before:actualBefore,afterPlanning:actualAfterInitialPlanning}));

  const failed=globalThis.__suffixPersistenceResults.filter(item=>item.status!=="PASS");
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-suffix-persistence-invariants-v1",category:"suffix-persistence",
    counts:{total:globalThis.__suffixPersistenceResults.length,pass:globalThis.__suffixPersistenceResults.length-failed.length,fail:failed.length},
    observed:{initialRevision,suffixRevision:suffixMain?.sdePhysicalPlanRevision||"",replanRevision:replannedMain?.sdePhysicalPlanRevision||"",chainId,slotCompletionCoverage},
    results:globalThis.__suffixPersistenceResults
  })+"\n");
  process.exitCode=failed.length?1:0;
})()
`);
} catch (error) {
  const detail = `structured product failure: ${String(error?.stack || error)}`;
  const observed = new Set(results.map(result=>result.id));
  invariantIds.filter(id=>!observed.has(id)).forEach(id=>record(id,false,detail));
  const failed = results.filter(item=>item.status !== "PASS");
  process.stdout.write(`${JSON.stringify({
    schemaVersion:"sde-suffix-persistence-invariants-v1",
    category:"suffix-persistence",
    counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
    structuredFailure:true,
    error:detail,
    results,
  })}\n`);
  process.exitCode = 1;
}
