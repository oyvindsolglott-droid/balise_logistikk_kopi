"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const placements = [["5N","74-12"],["5M","74-41"],["5S","70-06"],["11S","74-10"]];
  const reset = (rows=placements,actions={})=>{
    resetState(rows,{sdeMoveActions:actions});
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  };

  reset();
  const automatic = ctx.buildSdeAutomaticTrappedReadinessMoves([]);
  assert.equal(automatic.length,1,"one trapped middle vehicle must produce one automatic main order");
  const mainOrder = automatic[0];
  assert.equal(mainOrder.vehicle,"74-41");
  assert.equal(mainOrder.fromSlot,"5M");
  assert.equal(mainOrder.toSlot,"4M");
  assert.equal(mainOrder.canonicalProducer,"automatic_trapped_readiness");
  assert.equal(mainOrder.sdePreferDedicatedVnRelief,true);

  const chainRows = ctx.buildSdePhysicalBlockerGuardMoves(automatic);
  const release = chainRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const main = chainRows.find(row=>row.sdePhysicalDependencyRole==="dependent");
  const recovery = chainRows.find(row=>row.sdePhysicalDependencyRole==="return");
  assert.ok(release && main && recovery,"automatic readiness must be a complete release/main/recovery chain");
  assert.deepEqual(
    JSON.parse(JSON.stringify(chainRows.map(row=>[row.sdePhysicalChainStep,row.vehicle,row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]))),
    [[1,"74-12","5N","VN","prerequisite"],[2,"74-41","5M","4M","dependent"],[3,"74-12","VN","5N","return"]]
  );
  assert.equal(chainRows.every(row=>ctx.isSdeAutomaticTrappedReadinessMove(row)),true,"all generated chain cards must remain visibly automatic");

  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,placements));
  assert.equal(reader.integrityReport.status,"PASS");
  assert.equal(reader.cardProjection.actionableCards.length,1);
  assert.equal(reader.cardProjection.actionableCards[0].vehicleId,"74-12");
  assert.equal(reader.cardProjection.actionableCards[0].sourceSlot,"5N");
  assert.equal(reader.cardProjection.actionableCards[0].targetSlot,"VN");
  assert.equal(reader.cardProjection.blockedChainCards.length,2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(reader.cardProjection.blockedChainCards.map(card=>[card.vehicleId,card.sourceSlot,card.targetSlot]))),
    [["74-41","5M","4M"],["74-12","VN","5N"]]
  );

  const limited = ctx.buildSdeLimitedPlanningData("FRESH_NO_TURSATT_ASSIGNMENTS","test");
  assert.equal(limited.automaticMoveCount,0,"fresh data without tursatt assignments must not create an automatic order");
  assert.equal(limited.moves.some(row=>row.canonicalProducer==="automatic_trapped_readiness"),false);
  const overview = ctx.buildSdeNightPlacementOverviewData(limited);
  assert.equal(overview.counts.activeMoves,0);
  assert.equal(overview.counts.overlays,0,"no release, main or recovery overlay may be projected without a tursatt context");
  assert.equal(overview.counts.unresolved,0,"a dependency-blocked recovery is deferred, never unresolved");

  const claimed = ctx.buildSdeAutomaticTrappedReadinessMoves([{
    vehicle:"74-41",fromSlot:"5M",arrivalSlot:"5M",recommendedSlot:"6N",toSlot:"6N",
    stableActionKey:"manual-claim-74-41",isManualOnly:true
  }]);
  assert.equal(claimed.length,0,"an explicit user plan must own the vehicle and suppress the automatic order");

  reset();
  const permanentRelease = ctx.buildSdeAutomaticTrappedReadinessMoves([{
    vehicle:"74-12",fromSlot:"5N",arrivalSlot:"5N",recommendedSlot:"10S",toSlot:"10S",
    stableActionKey:"permanent-release-74-12",canonicalProducer:"existing-plan"
  }]);
  assert.equal(permanentRelease.length,0,"an existing permanent blocker move must win over a duplicate temporary release chain");

  reset([...placements,["VN","WASH-BLOCKER"]]);
  const fallbackAutomatic = ctx.buildSdeAutomaticTrappedReadinessMoves([]);
  const fallbackRows = ctx.buildSdePhysicalBlockerGuardMoves(fallbackAutomatic);
  const fallbackRelease = fallbackRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const fallbackRecovery = fallbackRows.find(row=>row.sdePhysicalDependencyRole==="return");
  assert.ok(fallbackRelease && fallbackRecovery);
  assert.notEqual(fallbackRelease.toSlot,"VN","occupied VN must use a safe ordinary fallback");
  assert.equal(fallbackRecovery.toSlot,fallbackRelease.fromSlot);

  reset(placements.filter(([slot])=>slot!=="5N"));
  assert.equal(ctx.buildSdeAutomaticTrappedReadinessMoves([]).length,0,"a middle vehicle with one clear end is not trapped");

  reset();
  const rejected = ctx.buildSdeAutomaticTrappedReadinessMoves([])[0];
  const rejectedKey = ctx.getSdeMoveActionKey(rejected);
  appState.sdeMoveActions={
    [rejectedKey]:{
      action:"cancelled",vehicle:rejected.vehicle,fromSlot:rejected.fromSlot,toSlot:rejected.toSlot,
      snapshot:ctx.getSdeMoveActionSnapshot(rejected),time:"2026-07-18T18:55:00.000Z"
    }
  };
  const learned = ctx.buildSdeAutomaticTrappedReadinessMoves([]);
  assert.equal(learned.length,1);
  assert.notEqual(learned[0].toSlot,rejected.toSlot,"a cancelled automatic target must not be offered again in unchanged actual state");
  assert.equal(ctx.buildSdePhysicalBlockerGuardMoves(learned).some(row=>row.sdePhysicalDependencyRole==="dependent"),true);

  console.log(JSON.stringify({
    schemaVersion:"sde-automatic-trapped-readiness-harness-v1",
    status:"PASS",
    automatic:{vehicle:mainOrder.vehicle,fromSlot:mainOrder.fromSlot,toSlot:mainOrder.toSlot},
    chain:chainRows.map(row=>({step:row.sdePhysicalChainStep,vehicle:row.vehicle,fromSlot:row.fromSlot,toSlot:row.toSlot,role:row.sdePhysicalDependencyRole})),
    actionableCards:reader.cardProjection.actionableCards.length,
    blockedCards:reader.cardProjection.blockedChainCards.length,
    vnFallback:fallbackRelease.toSlot,
    learnedTarget:learned[0].toSlot
  }));
})();
`);
