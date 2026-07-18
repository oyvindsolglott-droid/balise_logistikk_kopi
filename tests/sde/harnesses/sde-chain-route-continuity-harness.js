"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const placements = [["5N","74-12"],["10S","74-10"],["5S","74-11"]];
  resetState(placements);
  appState.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};

  const main = makeMain("10","74-10","5M","route-continuity-74-10");
  const blockState = ctx.getSdeHardPhysicalBlockStateForMove(main);
  assert.equal(blockState.hardBlocked,true);
  assert.equal(blockState.accessAssessment.targetAccessBlocked,true);

  const staleRelease = {
    vehicle:"74-11",
    fromSlot:"5S",
    arrivalSlot:"5S",
    recommendedSlot:"4M",
    toSlot:"4M",
    stableActionKey:"stale-release-74-11-5S-4M"
  };
  const staleAssessment = ctx.buildSdeTemporaryAccessReliefMainRouteAssessment(main,blockState,staleRelease);
  assert.equal(staleAssessment.safe,false);
  assert.ok(Array.from(staleAssessment.blockingSlots).includes("4M"));

  const rows = ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const release = getRole(rows,"prerequisite");
  const dependent = getRole(rows,"dependent");
  const recovery = getRole(rows,"return");
  assert.ok(release && dependent && recovery,"a complete non-self-blocking chain must be found");
  assert.notEqual(release.toSlot,"4M");
  assert.equal(dependent.vehicle,"74-10");
  assert.equal(dependent.fromSlot,"10S");
  assert.equal(dependent.toSlot,"5M");
  assert.equal(recovery.vehicle,release.vehicle);
  assert.equal(recovery.fromSlot,release.toSlot);
  assert.equal(recovery.toSlot,release.fromSlot);

  const selectedAssessment = ctx.buildSdeTemporaryAccessReliefMainRouteAssessment(main,blockState,release);
  assert.equal(selectedAssessment.safe,true,selectedAssessment.reason);
  if(release.fromSlot === "5S"){
    assert.ok(Array.from(selectedAssessment.targetPathSlots).includes("4M"));
    assert.ok(Array.from(release.sdePhysicalAccessReliefChain.routeResources).includes("4M"));
  }else{
    assert.equal(release.fromSlot,"5N","north access must be opened by the north blocker");
    assert.ok(!Array.from(selectedAssessment.targetPathSlots).includes("4M"));
    assert.ok(!Array.from(release.sdePhysicalAccessReliefChain.routeResources).includes("4M"));
  }

  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements));
  assert.equal(reader.integrityReport.status,"PASS");
  assert.equal(reader.cardProjection.actionableCards.length,1);
  assert.equal(reader.cardProjection.blockedChainCards.length,2);
  assert.equal(reader.reservationProjection.conflicts.length,0);
  assert.equal(reader.cardProjection.actionableCards[0].vehicleId,release.vehicle);

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-chain-route-continuity-harness-v1",
    ok:true,
    rejectedChain:"74-11 5S→4M; 74-10 10S→5M",
    selectedChain:rows.map(row=>row.vehicle+" "+row.fromSlot+"→"+row.toSlot),
    routeResources:Array.from(release.sdePhysicalAccessReliefChain.routeResources),
    integrity:reader.integrityReport.status
  })+"\n");
})()
`);
