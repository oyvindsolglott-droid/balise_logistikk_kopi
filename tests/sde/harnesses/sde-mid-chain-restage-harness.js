"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(process.argv[2],"utf8");
if(source.includes('migrationMode:"CANONICAL_ONLY"')){
  require("./sde-phase-a-canonical-contract-helper.cjs").runScenario("mid-chain",process.argv[2]);
  process.exit(0);
}

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const initialPlacements=[["5N","74-12"],["5M","74-41"],["5S","70-06"]];
  resetState(initialPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const requestId="mid-chain-restage-74-41";
  const actionKey=["night-placement-drag","74-41","5M","4M",requestId].join("|");
  const override={
    id:requestId,vehicle:"74-41",originalFromSlot:"5M",fromSlot:"5M",currentFromSlot:"5M",toSlot:"4M",
    createdAt:"2026-07-18T10:30:00.000Z",updatedAt:"2026-07-18T10:30:00.000Z",
    source:"night-placement-drag",stableActionKey:actionKey,moveKey:actionKey,
    needKey:"night-placement-drag-need|"+actionKey,hasMatchedSdeMove:false,isManualOnly:true,
    hardPhysicalBlocked:true,canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,dragRequestId:requestId,sdeNightPlacementDragIdentity:requestId,
    manualPlanId:"manual-graphic-order|"+requestId
  };
  appState.sdeNightPlacementManualOverrides={[override.id]:override};
  const staged=ctx.stageSdeCanonicalGraphicDragOrder(override);
  assert.equal(staged.chain.ok,true);
  const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([ctx.buildSdeNightPlacementGeneratedMove(override)],{reconcileActive:false});
  const release=initialRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  assert.ok(release);

  const progressedPlacements=initialPlacements
    .filter(([slot])=>slot!==release.fromSlot)
    .concat([[release.toSlot,release.vehicle]]);
  const completedActions={
    [ctx.getSdeMoveActionKey(release)]:{
      action:"completed",vehicle:release.vehicle,fromSlot:release.fromSlot,toSlot:release.toSlot,
      time:"2026-07-18T10:31:00.000Z",snapshot:ctx.getSdeMoveActionSnapshot(release)
    }
  };
  const storedOverride=JSON.parse(JSON.stringify(override));
  const storedAuthorities=JSON.parse(JSON.stringify(appState.sdeActiveMoveOutcomes));
  resetState(progressedPlacements,{
    sdeMoveActions:completedActions,
    sdeNightPlacementManualOverrides:{[storedOverride.id]:storedOverride},
    sdeActiveMoveOutcomes:storedAuthorities
  });
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const suffixRows=ctx.buildSdePhysicalBlockerGuardMoves([ctx.buildSdeNightPlacementGeneratedMove(storedOverride)],{reconcileActive:false});
  const suffixReader=ctx.buildSdeCanonicalProductionReader(snapshot(suffixRows,progressedPlacements,completedActions));
  const suffixInspection=ctx.inspectSdeCanonicalGraphicDragPhysicalReliefChain(suffixReader,{
    vehicle:"74-41",sourceSlot:"5M",targetSlot:"4M",actionKey
  });
  assert.equal(suffixInspection.ok,true,suffixInspection.reason||"the valid mid-chain suffix was rejected");
  const restaged=ctx.stageSdeCanonicalGraphicDragOrder(storedOverride);
  assert.equal(restaged?.chain?.ok,true,"the valid main/return suffix must restage without a new prerequisite");
  assert.equal(restaged.chain.outcomes.all.length,3);
  assert.equal(restaged.chain.outcomes.releases[0]?.status,"completed");
  assert.equal(restaged.chain.outcomes.main?.vehicleId,"74-41");
  assert.equal(restaged.chain.outcomes.return?.vehicleId,"74-12");
  assert.equal(restaged.chain.cards.release?.status,"actionable");
  assert.equal(restaged.chain.cards.main?.status,"actionable");
  assert.equal(restaged.chain.cards.return?.status,"blocked_chain_step");
  assert.equal(restaged.reader.integrityReport.status,"PASS");

  const savedActions=appState.sdeMoveActions;
  appState.sdeMoveActions={};
  const unprovenInspection=ctx.inspectSdeCanonicalGraphicDragPhysicalReliefChain(suffixReader,{
    vehicle:"74-41",sourceSlot:"5M",targetSlot:"4M",actionKey
  });
  appState.sdeMoveActions=savedActions;
  assert.equal(unprovenInspection.ok,false,"a suffix without completed-release proof must remain fail-closed");

  console.log(JSON.stringify({
    schemaVersion:"sde-mid-chain-restage-harness-v1",
    status:"PASS",
    release:{vehicle:release.vehicle,fromSlot:release.fromSlot,toSlot:release.toSlot,actionKey:ctx.getSdeMoveActionKey(release)},
    suffixRoles:suffixRows.map(row=>({vehicle:row.vehicle,fromSlot:row.fromSlot,toSlot:row.toSlot,role:row.sdePhysicalDependencyRole,step:row.sdePhysicalChainStep,steps:row.sdePhysicalChainStepCount})),
    suffixOutcomes:(suffixReader.canonicalPlan.candidateOutcomes||[]).filter(outcome=>outcome.chainId===suffixRows[0]?.sdePhysicalChainId).map(outcome=>({vehicle:outcome.vehicleId,role:outcome.raw?.sdePhysicalDependencyRole,step:outcome.raw?.sdePhysicalChainStep,steps:outcome.raw?.sdePhysicalChainStepCount,actionKey:outcome.actionKey,dependencies:outcome.dependencies})),
    suffixInspection:{ok:suffixInspection.ok,reason:suffixInspection.reason},
    restaged:true,
    unprovenSuffixRejected:true
  }));
})();
`);
