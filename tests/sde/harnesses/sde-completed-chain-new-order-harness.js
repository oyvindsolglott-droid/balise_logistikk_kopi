"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const placements = [["5N","74-12"],["5M","74-10"],["5S","74-11"]];

  function makeGraphicOrder(requestId){
    const source = "5M";
    const target = "6S";
    const actionKey = ["night-placement-drag","74-10",source,target,requestId].join("|");
    return {
      vehicle:"74-10",
      fromSlot:source,
      arrivalSlot:source,
      originalFromSlot:source,
      recommendedSlot:target,
      toSlot:target,
      stableActionKey:actionKey,
      sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,
      sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
      source:"night-placement-drag",
      canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,
      sdeNightPlacementDragIdentity:requestId,
      manualPlanId:"manual-graphic-order|"+requestId,
      sdeNightPlacementDragOverrideActive:true,
      isNightPlacementGenerated:true,
      isManualOnly:true
    };
  }

  resetState(placements);
  appState.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};
  const historicalOrder = makeGraphicOrder("completed-generation-1");
  const historicalRows = ctx.buildSdePhysicalBlockerGuardMoves([historicalOrder]);
  assert.equal(historicalRows.length,3,"historical 5M→6S order must have one release, main and recovery step");
  assert.equal(
    historicalRows.map(row=>row.sdePhysicalDependencyRole).join(","),
    "prerequisite,dependent,return"
  );
  const historicalChainId = historicalRows[0].sdePhysicalChainId;
  assert.ok(historicalChainId);
  assert.equal(new Set(historicalRows.map(row=>row.sdePhysicalChainId)).size,1);

  const historicalActions = Object.fromEntries(historicalRows.map((row,index)=>[
    ctx.getSdeMoveActionKey(row),
    {
      action:"completed",
      completedAt:"2026-07-17T08:0"+index+":00.000Z",
      vehicle:row.vehicle,
      fromSlot:row.fromSlot,
      toSlot:row.toSlot,
      snapshot:ctx.getSdeMoveActionSnapshot(row)
    }
  ]));

  // The operational actual-state is authoritative. A finished historical order may
  // coexist with a later snapshot that again places the consist at the same source.
  resetState(placements,{sdeMoveActions:historicalActions});
  appState.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};
  const nextOrder = makeGraphicOrder("fresh-generation-2");
  const nextRows = ctx.buildSdePhysicalBlockerGuardMoves([nextOrder]);
  const nextReader = ctx.buildSdeCanonicalProductionReader(snapshot(nextRows,placements,historicalActions));
  const nextRelease = nextRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const nextMain = nextRows.find(row=>row.sdePhysicalDependencyRole==="dependent");
  const nextRecovery = nextRows.find(row=>row.sdePhysicalDependencyRole==="return");
  const historicalKeys = new Set(Object.keys(historicalActions));
  const nextKeys = nextRows.map(row=>ctx.getSdeMoveActionKey(row));

  assert.ok(nextRelease && nextMain && nextRecovery,"fresh 5M→6S order must materialize a complete new chain");
  assert.notEqual(nextRelease.sdePhysicalChainId,historicalChainId,"fresh drag generation must receive a fresh chain identity");
  assert.equal(nextMain.vehicle,"74-10");
  assert.equal(nextMain.fromSlot,"5M");
  assert.equal(nextMain.toSlot,"6S");
  assert.equal(nextRecovery.vehicle,nextRelease.vehicle);
  assert.equal(nextRecovery.fromSlot,nextRelease.toSlot);
  assert.equal(nextRecovery.toSlot,nextMain.fromSlot,"recovery must use the source slot vacated by the completed main move");
  assert.equal(nextKeys.some(key=>historicalKeys.has(key)),false,"no completed historical action key may be reused");
  assert.equal(nextReader.integrityReport.status,"PASS");
  assert.equal(nextReader.cardProjection.actionableCards.length,1);
  assert.equal(nextReader.cardProjection.blockedChainCards.length,2);
  assert.equal(nextReader.reservationProjection.conflicts.length,0);
  assert.equal(nextReader.graphicProjection.activeOverlays.length,1);
  assert.equal(nextReader.graphicProjection.deferredOverlays.length,2);

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-completed-chain-new-order-harness-v1",
    ok:true,
    completedHistoricalKeys:[...historicalKeys],
    historicalChainId,
    freshChainId:nextRelease.sdePhysicalChainId,
    freshRows:nextRows.map(row=>({role:row.sdePhysicalDependencyRole,vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,key:ctx.getSdeMoveActionKey(row)})),
    integrity:nextReader.integrityReport.status
  })+"\n");
})()
`);
