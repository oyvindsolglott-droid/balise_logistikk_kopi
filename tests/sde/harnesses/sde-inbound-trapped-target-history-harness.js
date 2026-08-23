"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(process.argv[2],"utf8");
if(source.includes('migrationMode:"CANONICAL_ONLY"')){
  require("./sde-phase-a-canonical-contract-helper.cjs").runScenario("inbound-history",process.argv[2]);
  process.exit(0);
}

const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const initialPlacements = [["5N","74-12"],["5M","74-41"],["5S","70-06"],["10S","74-10"]];
  resetState(initialPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const automatic = ctx.buildSdeAutomaticTrappedReadinessMoves([]);
  const completedRows = ctx.buildSdePhysicalBlockerGuardMoves(automatic);
  assert.equal(completedRows.length,3,"the prior automatic readiness chain must be complete");
  const completedActions = Object.fromEntries(completedRows.map((row,index)=>[
    ctx.getSdeMoveActionKey(row),
    {
      action:"completed",completedAt:"2026-07-18T20:0"+index+":00.000Z",
      vehicle:row.vehicle,fromSlot:row.fromSlot,toSlot:row.toSlot,
      snapshot:ctx.getSdeMoveActionSnapshot(row)
    }
  ]));

  const currentPlacements = [["5N","74-12"],["4M","74-41"],["5S","70-06"],["10S","74-10"]];
  resetState(currentPlacements,{sdeMoveActions:completedActions});
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const requestId="inbound-74-10-to-trapped-5m-after-history";
  const actionKey=["night-placement-drag","74-10","10S","5M",requestId].join("|");
  const override={
    id:requestId,vehicle:"74-10",originalFromSlot:"10S",fromSlot:"10S",currentFromSlot:"10S",toSlot:"5M",
    createdAt:"2026-07-18T20:27:05.000Z",updatedAt:"2026-07-18T20:27:05.000Z",
    source:"night-placement-drag",stableActionKey:actionKey,moveKey:actionKey,
    needKey:"night-placement-drag-need|"+actionKey,hasMatchedSdeMove:false,isManualOnly:true,
    hardPhysicalBlocked:true,canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,dragRequestId:requestId,sdeNightPlacementDragIdentity:requestId,
    manualPlanId:"manual-graphic-order|"+requestId
  };
  appState.sdeNightPlacementManualOverrides={[override.id]:override};

  const generated=ctx.buildSdeNightPlacementGeneratedMove(override);
  const rows=ctx.buildSdePhysicalBlockerGuardMoves([generated],{reconcileActive:false});
  const release=rows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const main=rows.find(row=>ctx.getSdeMoveActionKey(row)===actionKey);
  const recovery=rows.find(row=>row.sdePhysicalDependencyRole==="return");
  assert.ok(release&&main&&recovery,"historical completed chains must not prevent a new inbound release/main/return chain");
  assert.equal(release.vehicle,"74-12");
  assert.equal(release.fromSlot,"5N");
  assert.ok(["VN","4N","9"].includes(release.toSlot),"the north blocker must use a safe temporary holding slot");
  assert.equal(release.sdePhysicalBlockerReturnAssessment?.returnSlot,"5N");
  assert.match(release.sdePhysicalBlockerReturnAssessment?.reason || "",/Retur til 5N/);
  assert.doesNotMatch(release.sdePhysicalBlockerReturnAssessment?.reason || "",/Retur til 10S/);
  assert.equal(main.vehicle,"74-10");
  assert.equal(main.fromSlot,"10S");
  assert.equal(main.toSlot,"5M");
  assert.equal(recovery.vehicle,"74-12");
  assert.equal(recovery.fromSlot,release.toSlot);
  assert.equal(recovery.toSlot,"5N");

  const staged=ctx.stageSdeCanonicalGraphicDragOrder(override);
  assert.equal(staged.chain.ok,true,"the inbound physical chain must pre-stage completely");
  assert.equal(staged.reader.integrityReport.status,"PASS");
  assert.equal(staged.reader.cardProjection.actionableCards.length,1);
  assert.equal(staged.reader.cardProjection.blockedChainCards.length,2);
  assert.equal(staged.reader.graphicProjection.activeOverlays.length,1);
  assert.equal(staged.reader.graphicProjection.deferredOverlays.length,2);

  console.log(JSON.stringify({
    schemaVersion:"sde-inbound-trapped-target-history-harness-v1",
    status:"PASS",
    completedHistory:completedRows.map(row=>[row.vehicle,row.fromSlot,row.toSlot]),
    inboundChain:rows.map(row=>[row.sdePhysicalChainStep,row.vehicle,row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),
    integrity:staged.reader.integrityReport.status
  }));
})();
`);
