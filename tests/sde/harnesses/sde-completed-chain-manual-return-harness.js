"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
  const chainRows=ctx.buildSdePhysicalBlockerGuardMoves([mainOrder],{reconcileActive:false});
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
  assert.equal(recovery.toSlot,"5N");

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
  resetState(progressedPlacements,{sdeMoveActions:completedActions});
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const requestId="manual-return-after-completed-main";
  const actionKey=["night-placement-drag","74-12","4M","5N",requestId].join("|");
  const override={
    id:requestId,vehicle:"74-12",originalFromSlot:"4M",fromSlot:"4M",currentFromSlot:"4M",toSlot:"5N",
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
  assert.equal(appState.grunnoppstilling["5N"],"74-12","74-12 must physically return to 5N");
  assert.equal(appState.grunnoppstilling["4M"],undefined,"the temporary 4M placement must be released");

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-completed-chain-manual-return-harness-v1",ok:true,
    completedBefore:[ctx.getSdeMoveActionKey(release),ctx.getSdeMoveActionKey(main)],
    returnActionKey:actionKey,authorityOutcomeId:authority.activeOutcomeId,finalSlot:"5N",alerts
  })+"\n");
})().catch(error=>{
  process.stderr.write(String(error?.stack||error)+"\n");
  process.exitCode=1;
})
`);
