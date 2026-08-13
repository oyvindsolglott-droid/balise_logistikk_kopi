"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__vnReliefResults = results;
globalThis.__vnReliefRecord = record;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__vnReliefRecord;
  const roles=rows=>rows.map(row=>String(row?.sdePhysicalDependencyRole||""));
  const role=(rows,name)=>rows.find(row=>row?.sdePhysicalDependencyRole===name)||null;
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const direct=(vehicle,from,to,id)=>{
    const actionKey=["night-placement-drag",vehicle,from,to,id].join("|");
    return {
      vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to,
      stableActionKey:actionKey,sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
      source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:id,manualPlanId:"manual-graphic-order|"+id,
      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true,
      sdePreferDedicatedVnRelief:ctx.shouldSdePreferDedicatedVnForGlobalRelief(from,to)
    };
  };
  const complete=(rows,reader)=>Boolean(
    rows.length===3
    && roles(rows).join(",")==="prerequisite,dependent,return"
    && (reader?.canonicalPlan?.candidateOutcomes||[]).length===3
    && allCards(reader).length===3
    && (reader?.reservationProjection?.reservations||[]).length===3
    && allOverlays(reader).length===3
    && Object.keys(reader?.handlerAdapters||{}).length===3
    && reader?.integrityReport?.status==="PASS"
  );

  const placements=[["6S","VN-MAIN"],["6N","VN-BLOCKER"],["1N","ORDINARY-OCCUPIED"]];
  const main=direct("VN-MAIN","6S","11S","vn-historical-6s-11s");
  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const actualBefore=JSON.stringify(appState.grunnoppstilling||{});
  const blockState=ctx.getSdeCompleteTrappedEgressBlockState(main,ctx.getSdeHardPhysicalBlockStateForMove(main));
  const blocker=(blockState.blockers||[]).find(item=>item.slot==="6N")||blockState.blockers?.[0];
  const order=ctx.getSdeTrappedEgressTemporaryCandidateOrder("6N",["6S","11S"],{preferDedicatedVn:true});
  const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const initialReader=ctx.buildSdeCanonicalProductionReader(snapshot(initialRows,placements,{}));
  const initialRelease=role(initialRows,"prerequisite");
  const initialMain=role(initialRows,"dependent");
  const initialRecovery=role(initialRows,"return");
  const initialStatuses=allCards(initialReader).map(card=>card.status);

  put("VN-PREFERRED-OVER-ORDINARY-TRACK-FOR-GLOBAL-RELIEF",initialRelease?.toSlot==="VN"&&order[0]==="VN",JSON.stringify({order,release:initialRelease?.toSlot}));
  put("AVAILABLE-VN-IS-NOT-IGNORED",initialRows.some(row=>row.toSlot==="VN")&&initialRelease?.sdePhysicalReleaseCandidateOrder?.includes("VN"),JSON.stringify({order,release:initialRelease?.toSlot}));
  const occupiedOrdinaryAssessment=ctx.assessSdeTrappedEgressVirtualMove(
    ctx.getSdeTrappedEgressActualOccupancy(),"VN-BLOCKER","6N","1N"
  );
  put("OCCUPIED-ORDINARY-TEMP-TARGET-IS-REJECTED",occupiedOrdinaryAssessment.valid===false&&initialRelease?.toSlot!=="1N",JSON.stringify({order,release:initialRelease?.toSlot,occupiedValid:occupiedOrdinaryAssessment.valid}));
  put("VN-ACCESS-THROUGH-VS-IS-VALIDATED",initialRelease?.sdeTrappedEgressRouteResources?.includes("VN")&&initialRelease?.sdeTrappedEgressRouteResources?.includes("VS"),JSON.stringify(initialRelease?.sdeTrappedEgressRouteResources||[]));
  put("VN-RECOVERY-USES-POST-MAIN-TOPOLOGY",initialRecovery?.fromSlot==="VN"&&initialRecovery?.toSlot==="6S"&&initialRecovery?.sdeRecoveryUsesPostMainTopology===true,JSON.stringify(initialRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole])));
  put("RECOVERY-DOES-NOT-CREATE-TRAPPED-EMPTY-SLOT",initialRecovery?.toSlot==="6S"&&initialRecovery?.toSlot!=="6N",JSON.stringify({recovery:initialRecovery?.toSlot}));

  const replanPlacements=[...placements,["VS","INITIAL-VS-BLOCKER"]];
  resetState(replanPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const preChangeRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const preChangeRelease=role(preChangeRows,"prerequisite");
  const changedPlacements=placements
    .filter(([slot])=>slot!==preChangeRelease?.toSlot)
    .concat([[preChangeRelease?.toSlot||"4M","LATE-TEMP-OCCUPANT"]]);
  appState.grunnoppstilling=Object.fromEntries(changedPlacements);
  const changedBefore=JSON.stringify(appState.grunnoppstilling||{});
  const replannedRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const replannedReader=ctx.buildSdeCanonicalProductionReader(snapshot(replannedRows,changedPlacements,{}));
  const replannedRelease=role(replannedRows,"prerequisite");
  const replannedMain=role(replannedRows,"dependent");
  const replannedRecovery=role(replannedRows,"return");

  resetState(replanPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const automaticOverride={
    id:"automatic-replan-order",vehicle:"VN-MAIN",originalFromSlot:"6S",fromSlot:"6S",currentFromSlot:"6S",toSlot:"11S",
    createdAt:"2026-08-13T18:00:00.000Z",updatedAt:"2026-08-13T18:00:00.000Z",source:"night-placement-drag",
    stableActionKey:"night-placement-drag|VN-MAIN|6S|11S|automatic-replan-order",
    needKey:"night-placement-drag-need|automatic-replan-order",moveKey:"night-placement-drag|VN-MAIN|6S|11S|automatic-replan-order",
    hardPhysicalBlocked:true,canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,dragRequestId:"automatic-replan-order",sdeNightPlacementDragIdentity:"automatic-replan-order",
    manualPlanId:"manual-graphic-order|automatic-replan-order",actualStateRevision:ctx.getSdeNightPlacementActualStateRevision(),
    sdePreferDedicatedVnRelief:true
  };
  appState.sdeNightPlacementManualOverrides={automatic:automaticOverride};
  const automaticGenerated=ctx.buildSdeNightPlacementGeneratedMove(automaticOverride);
  const automaticBeforeRows=ctx.buildSdePhysicalBlockerGuardMoves([automaticGenerated],{reconcileActive:false});
  const automaticBeforeRelease=role(automaticBeforeRows,"prerequisite");
  ctx.setSdeActiveOutcomeAuthority(ctx.getSdeMoveObligationStepKey(automaticBeforeRelease),automaticBeforeRelease,{
    activeOutcomeId:ctx.getSdeMoveActionKey(automaticBeforeRelease),legacyActionKey:ctx.getSdeMoveActionKey(automaticBeforeRelease),
    dragRequestId:automaticOverride.dragRequestId,source:"vn-relief-invariant-initial-authority"
  });
  const automaticChangedPlacements=placements
    .filter(([slot])=>slot!==automaticBeforeRelease?.toSlot)
    .concat([[automaticBeforeRelease?.toSlot||"4M","AUTOMATIC-LATE-OCCUPANT"]]);
  appState.grunnoppstilling=Object.fromEntries(automaticChangedPlacements);
  const automaticChangedBefore=JSON.stringify(appState.grunnoppstilling||{});
  const regeneratedMoves=ctx.buildSdeNightPlacementGeneratedMoves([]);
  const automaticRows=ctx.buildSdePhysicalBlockerGuardMoves(regeneratedMoves,{reconcileActive:false});
  const automaticSnapshot=snapshot(automaticRows,automaticChangedPlacements,{});
  automaticSnapshot.runtimeState.activeAuthorities=JSON.parse(JSON.stringify(appState.sdeActiveMoveOutcomes||{}));
  const automaticReader=ctx.buildSdeCanonicalProductionReader(automaticSnapshot);
  const automaticRelease=role(automaticRows,"prerequisite");
  const automaticMain=role(automaticRows,"dependent");
  const automaticReplanComplete=Boolean(
    regeneratedMoves.length===1&&automaticRelease?.toSlot==="VN"&&automaticMain?.toSlot==="11S"
    && complete(automaticRows,automaticReader)
    && automaticOverride.actualStateRevision===ctx.getSdeNightPlacementActualStateRevision()
    && automaticChangedBefore===JSON.stringify(appState.grunnoppstilling||{})
  );
  put("ACTUAL-STATE-CHANGE-TRIGGERS-AUTOMATIC-REPLAN",preChangeRelease&&preChangeRelease.toSlot!=="VN"&&replannedRelease?.toSlot==="VN"&&automaticReplanComplete,JSON.stringify({before:preChangeRelease?.toSlot,after:replannedRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),automatic:{rows:automaticRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),complete:automaticReplanComplete,revision:automaticOverride.actualStateRevision}}));
  put("REPLAN-PRESERVES-ORIGINAL-MAIN-INTENT",replannedMain?.vehicle==="VN-MAIN"&&replannedMain?.fromSlot==="6S"&&replannedMain?.toSlot==="11S"&&replannedMain?.sdeNightPlacementDragIdentity===main.sdeNightPlacementDragIdentity,JSON.stringify({from:replannedMain?.fromSlot,to:replannedMain?.toSlot,identity:replannedMain?.sdeNightPlacementDragIdentity}));
  put("REPLAN-REBUILDS-ALL-THREE-CARDS-ATOMICALLY",complete(replannedRows,replannedReader)&&allCards(replannedReader).map(card=>card.status).join(",")==="actionable,blocked_chain_step,blocked_chain_step",JSON.stringify({roles:roles(replannedRows),statuses:allCards(replannedReader).map(card=>card.status),integrity:replannedReader.integrityReport?.status}));
  put("NO-ERROR-ONLY-WHEN-SAFE-RELIEF-EXISTS",Boolean(replannedRelease&&replannedMain&&replannedRecovery)&&!replannedRows.some(row=>row?.sdeTrappedEgressDiagnosticOnly||row?.sdePhysicalNoSafeReleaseMove),JSON.stringify(replannedRows.map(row=>({to:row.toSlot,diagnostic:row.sdeTrappedEgressDiagnosticOnly,noSafe:row.sdePhysicalNoSafeReleaseMove}))));

  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const firstPass=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const rejectedRelease=role(firstPass,"prerequisite");
  const rejectedIntent=ctx.setSdeCanonicalRetargetIntent(rejectedRelease,{mode:"reject_target",rejectedTarget:rejectedRelease?.toSlot});
  appState.grunnoppstilling={...appState.grunnoppstilling,"4M":"FIRST-ALTERNATIVE-OCCUPIED"};
  const nextRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const nextRelease=role(nextRows,"prerequisite");
  put("ONE-FAILED-CANDIDATE-DOES-NOT-END-SEARCH",rejectedIntent.ok===true&&nextRelease&&nextRelease.toSlot!==rejectedRelease?.toSlot&&nextRelease.toSlot!=="4M"&&nextRelease.toSlot!=="1N",JSON.stringify({intent:rejectedIntent.ok,rejected:rejectedRelease?.toSlot,occupied:"4M",next:nextRelease?.toSlot}));

  const slotFixtures=[
    {source:"4M",blockers:["4N","4S"]},
    {source:"5M",blockers:["5N","5S"]},
    {source:"6S",blockers:["6N","6SS"]},
    {source:"10S",blockers:["10N"]},
    {source:"11S",blockers:["11N"]},
    {source:"12S",blockers:["12N"]}
  ];
  const slotCoverage=slotFixtures.map((fixture,index)=>{
    const slotMain=direct("SLOT-MAIN-"+fixture.source,fixture.source,"9","slot-coverage-"+fixture.source);
    const slotPlacements=[[fixture.source,slotMain.vehicle],...fixture.blockers.map((slot,blockerIndex)=>[slot,"SLOT-BLOCKER-"+index+"-"+blockerIndex])];
    resetState(slotPlacements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([slotMain]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,slotPlacements,{}));
    return {slot:fixture.source,pass:complete(rows,reader),roles:roles(rows),integrity:reader.integrityReport?.status};
  });
  const allSlotsCovered=slotCoverage.length===6&&slotCoverage.every(item=>item.pass);
  const noErrorIndex=results.findIndex(item=>item.id==="NO-ERROR-ONLY-WHEN-SAFE-RELIEF-EXISTS");
  if(noErrorIndex>=0&&allSlotsCovered!==true) results[noErrorIndex]={...results[noErrorIndex],status:"FAIL",detail:JSON.stringify({slotCoverage})};
  put("NO-PARTIAL-OPERATIVE-PROJECTION",complete(initialRows,initialReader)&&complete(replannedRows,replannedReader)&&allSlotsCovered&&actualBefore===JSON.stringify(Object.fromEntries(placements))&&changedBefore===JSON.stringify(Object.fromEntries(changedPlacements)),JSON.stringify({initialStatuses,initialComplete:complete(initialRows,initialReader),replannedComplete:complete(replannedRows,replannedReader),slotCoverage,actualUnchanged:changedBefore===JSON.stringify(Object.fromEntries(changedPlacements))}));

  const failed=globalThis.__vnReliefResults.filter(item=>item.status!=="PASS");
  process.stdout.write(JSON.stringify({schemaVersion:"sde-vn-relief-invariants-v1",category:"vn-relief",counts:{total:globalThis.__vnReliefResults.length,pass:globalThis.__vnReliefResults.length-failed.length,fail:failed.length},observed:{order,initial:initialRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),replanned:replannedRows.map(row=>[row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),slotCoverage},results:globalThis.__vnReliefResults})+"\n");
  process.exitCode=failed.length?1:0;
})()
`);
