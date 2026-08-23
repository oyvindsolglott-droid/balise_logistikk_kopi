"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(process.argv[2],"utf8");
if(source.includes('migrationMode:"CANONICAL_ONLY"')){
  require("./sde-phase-a-canonical-contract-helper.cjs").runScenario("manual-return",process.argv[2]);
  process.exit(0);
}

const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(async()=>{
  const initialPlacements=[["5N","74-12"],["5M","74-10"],["5S","74-11"]];
  resetState(initialPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const mainRequestId="completed-main-before-manual-return";
  const mainActionKey=["night-placement-drag","74-10","5M","6S",mainRequestId].join("|");
  const mainOrder={
    vehicle:"74-10",fromSlot:"5M",arrivalSlot:"5M",originalFromSlot:"5M",
    recommendedSlot:"6S",toSlot:"6S",stableActionKey:mainActionKey,
    sdeNightPlacementGeneratedActionKey:mainActionKey,
    needKey:"night-placement-drag-need|"+mainActionKey,
    sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+mainActionKey,
    source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",sdeCanonicalGraphicDragOrder:true,
    sdeNightPlacementDragIdentity:mainRequestId,manualPlanId:"manual-graphic-order|"+mainRequestId,
    sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true
  };
  const mainOverride={
    id:mainRequestId,vehicle:"74-10",originalFromSlot:"5M",fromSlot:"5M",currentFromSlot:"5M",toSlot:"6S",
    createdAt:"2026-07-17T18:29:00.000Z",updatedAt:"2026-07-17T18:29:00.000Z",
    source:"night-placement-drag",stableActionKey:mainActionKey,moveKey:mainActionKey,
    needKey:"night-placement-drag-need|"+mainActionKey,hasMatchedSdeMove:false,isManualOnly:true,
    hardPhysicalBlocked:true,canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,dragRequestId:mainRequestId,sdeNightPlacementDragIdentity:mainRequestId,
    manualPlanId:"manual-graphic-order|"+mainRequestId
  };
  appState.sdeNightPlacementManualOverrides={[mainOverride.id]:mainOverride};
  const stagedMainOrder=ctx.stageSdeCanonicalGraphicDragOrder(mainOverride);
  assert.ok(stagedMainOrder?.chain?.ok,"the original chain must stage completely");
  const chainRows=ctx.buildSdePhysicalBlockerGuardMoves([ctx.buildSdeNightPlacementGeneratedMove(mainOverride)],{reconcileActive:false});
  const release=chainRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const main=chainRows.find(row=>row.sdePhysicalDependencyRole==="dependent");
  const recovery=chainRows.find(row=>row.sdePhysicalDependencyRole==="return");
  assert.ok(release&&main&&recovery,"the original order must contain release, main and return");
  assert.equal(release.vehicle,"74-12");
  assert.equal(release.fromSlot,"5N");
  assert.equal(release.toSlot,"4M");
  assert.equal(main.fromSlot,"5M");
  assert.equal(main.toSlot,"6S");
  assert.equal(recovery.fromSlot,"4M");
  assert.equal(recovery.toSlot,"5M");

  const completedActions={
    [ctx.getSdeMoveActionKey(release)]:{
      action:"completed",vehicle:release.vehicle,fromSlot:release.fromSlot,toSlot:release.toSlot,
      time:"2026-07-17T18:30:00.000Z",snapshot:ctx.getSdeMoveActionSnapshot(release)
    },
    [ctx.getSdeMoveActionKey(main)]:{
      action:"completed",vehicle:main.vehicle,fromSlot:main.fromSlot,toSlot:main.toSlot,
      time:"2026-07-17T18:31:00.000Z",snapshot:ctx.getSdeMoveActionSnapshot(main)
    }
  };
  const progressedPlacements=[["4M","74-12"],["6S","74-10"],["5S","74-11"]];
  const progressedOverrides=JSON.parse(JSON.stringify(appState.sdeNightPlacementManualOverrides));
  const progressedAuthorities=JSON.parse(JSON.stringify(appState.sdeActiveMoveOutcomes));
  resetState(progressedPlacements,{
    sdeMoveActions:completedActions,
    sdeNightPlacementManualOverrides:progressedOverrides,
    sdeActiveMoveOutcomes:progressedAuthorities
  });
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const requestId="manual-return-after-completed-main";
  const actionKey=["night-placement-drag","74-12","4M","5M",requestId].join("|");
  const override={
    id:requestId,vehicle:"74-12",originalFromSlot:"4M",fromSlot:"4M",currentFromSlot:"4M",toSlot:"5M",
    createdAt:"2026-07-17T18:32:00.000Z",updatedAt:"2026-07-17T18:32:00.000Z",
    source:"night-placement-drag",stableActionKey:actionKey,moveKey:actionKey,
    needKey:"night-placement-drag-need|"+actionKey,hasMatchedSdeMove:false,isManualOnly:true,
    hardPhysicalBlocked:false,canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,dragRequestId:requestId,sdeNightPlacementDragIdentity:requestId,
    manualPlanId:"manual-graphic-order|"+requestId
  };
  appState.sdeNightPlacementManualOverrides={[override.id]:override};
  const staged=ctx.stageSdeCanonicalGraphicDragOrder(override);
  assert.ok(staged?.outcome,"the manual return must stage one canonical outcome");

  const manualReturn=ctx.buildSdeNightPlacementGeneratedMove(override);
  const outcomeKey=ctx.getSdeMoveObligationStepKey(manualReturn);
  const authority=ctx.getSdeActiveOutcomeAuthority(outcomeKey);
  assert.equal(authority?.legacyActionKey,actionKey,"the local card action must remain an explicit authority alias");
  assert.notEqual(authority?.activeOutcomeId,actionKey,"the browser regression requires canonical outcome identity to differ from the local action key");

  ctx.__manualReturnRow=manualReturn;
  vm.runInContext("sdeShiftLastRenderedData={moves:[__manualReturnRow],score:0}",ctx);
  const alerts=[];
  ctx.alert=message=>alerts.push(String(message||""));
  ctx.getSdeMoveLearningReason=async()=>({
    reasonCode:"proposal_fit",reasonLabel:"Forslaget passet",reasonText:"",
    reasonCodes:["proposal_fit"],reasonLabels:["Forslaget passet"],commentText:""
  });
  ctx.persist=()=>{};
  ctx.refreshSdeAfterMoveAction=()=>{};
  ctx.saveSharedSporplanDraftFromSdeCompletedMove=async()=>{};

  await ctx.handleSdeShiftMoveAction(encodeURIComponent(actionKey),"completed",{});

  assert.deepEqual(alerts,[],"a valid local return card must not be rejected as replaced");
  assert.equal(ctx.getSdeMoveActionRecord(actionKey)?.action,"completed","the return card must be quittable");
  assert.equal(appState.grunnoppstilling["5M"],"74-12","74-12 must physically recover to the source slot vacated by the main move");
  assert.equal(appState.grunnoppstilling["4M"],undefined,"the temporary 4M placement must be released");

  const historicalReplanKey="sde-physical-release-replan|74-10|10S|5M|74-12|5N";
  const historicalOutcomeKey="move|physical-release|"+historicalReplanKey+"|74-12|5N|physical-1";
  appState.sdeMoveActions["historical-cancelled-release"]={
    action:"cancelled",vehicle:"74-12",fromSlot:"5N",toSlot:"4M",physicalFromSlot:"5N",
    sequenceStep:"physical-1",outcomeKey:historicalOutcomeKey,replanKey:historicalReplanKey,
    replacementTargetSlot:"VN",time:"2026-07-17T17:00:00.000Z",
    snapshot:{
      vehicle:"74-12",fromSlot:"5N",originalFromSlot:"5N",toSlot:"4M",needKey:"historical-release-need",
      sdePhysicalChainStep:1,sdePhysicalDependencyRole:"prerequisite",sdePhysicalReleaseReplanKey:historicalReplanKey
    }
  };

  const unrelatedRuntimeRow={
    vehicle:"69-63",fromSlot:"2N",arrivalSlot:"2N",recommendedSlot:"4S",toSlot:"4S",
    arrivalTrain:"92489",arrivalPart:"1",arrivalTime:"20:51",nextDepartureTrain:"92482",nextDeparturePart:"1",
    source:"Ankomstbasert parkeringsbehov",canonicalProducer:"ordinary_base_need"
  };
  ctx.__unrelatedRuntimeRow=unrelatedRuntimeRow;
  vm.runInContext(
    "computeInndataCachedRows=null;computeInndataCacheDepth=0;"+
    "sdeShiftLastRenderedData={moves:[],score:0,limitedPlanningMode:true};"+
    "getSdeShiftShowcaseData=()=>({moves:[__unrelatedRuntimeRow],score:0});"+
    "sdeNightPlacementDropMessage=null;sdeNightPlacementBlockedMoveRequest=null;sdeProductionReaderFallbackError=null",
    ctx
  );
  ctx.renderSdeSkiftebevegelser=()=>{};
  assert.equal(ctx.getSdeCurrentSlotForVehicle("74-12"),"5M","actual state must show the manually completed post-main recovery");
  assert.equal(ctx.getSdeMoveActionRecord(mainActionKey)?.action,"completed");
  const nextPayload={vehicle:"74-10",slot:"6S",fromSlot:"6S",sourceKind:"actual"};
  const nextAssessment=ctx.buildSdeNightPlacementDropAssessment(nextPayload,"5N",{moves:[]});
  assert.equal(nextAssessment.ok,true,nextAssessment.message||"the next order must be assessable");
  assert.notEqual(nextAssessment.hardPhysicalBlocked,true,"the next free-slot order must remain directly executable");
  const nextApplied=ctx.applySdeNightPlacementDragOverride(nextPayload,"5N");
  const nextDropMessage=vm.runInContext("sdeNightPlacementDropMessage",ctx);
  assert.equal(nextApplied,true,nextDropMessage?.text||"the next order was rejected");
  assert.notEqual(nextDropMessage?.type,"error","a completed chain must not poison the next physical order");
  const nextOverview=ctx.buildSdeNightPlacementOverviewData({moves:[]});
  assert.equal(nextOverview.rejectedSlot,"","the free 5N target must not retain a red rejection frame");
  const nextReader=ctx.buildSdeCanonicalProductionReader();
  assert.equal(nextReader.integrityReport.status,"PASS","the next order must remain canonically complete");
  assert.equal(nextReader.cardProjection.actionableCards.length,1,"the next direct order must expose exactly one actionable card");
  assert.equal(nextReader.graphicProjection.activeOverlays.length,1,"the next order must expose exactly one active overlay");
  assert.equal(
    Object.keys(appState.sdePhysicalReleaseReplans).some(key=>key.includes("|74-10|6S|5N|")),
    false,
    "a direct free-slot order must not create a release replan merely because unrelated runtime rows exist"
  );

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-completed-chain-manual-return-harness-v2",ok:true,
    completedBefore:[ctx.getSdeMoveActionKey(release),ctx.getSdeMoveActionKey(main)],
    returnActionKey:actionKey,authorityOutcomeId:authority.activeOutcomeId,finalSlot:"5M",alerts,
    nextOrder:{vehicle:"74-10",fromSlot:"6S",toSlot:"5N",actionableCards:nextReader.cardProjection.actionableCards.length}
  })+"\n");
})().catch(error=>{
  process.stderr.write(String(error?.stack||error)+"\n");
  process.exitCode=1;
})
`);
