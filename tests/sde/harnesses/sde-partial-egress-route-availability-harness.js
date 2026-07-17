"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const baseHarness = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  ctx.persist=()=>{};
  ctx.renderSdeSkiftebevegelser=()=>{};
  const partialPlacements = [["5S","74-11"],["5M","74-10"],["1N","74-12"]];
  resetState(partialPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const main = {
    ...makeMain("5","74-10","6N","partial-egress-offer"),
    fromSlot:"5M",
    arrivalSlot:"5M",
    originalFromSlot:"5M"
  };
  const routeText = ctx.getSdeRouteAssessmentForPlanSkifte("5M","6N");
  assert.match(routeText,/Nordenden\/vaskesporet ser internt fri/i);
  const access = ctx.getSdeMovePhysicalAccessAssessment(main);
  assert.equal(access.sourceClearOptions.some(option=>option.end==="north"),true);
  assert.equal(access.hardRouteBlocked,false,"one blocked end must not classify the whole route as hard-blocked");
  const hardState = ctx.getSdeHardPhysicalBlockStateForMove(main);
  assert.equal(hardState.hardBlocked,false,"74-11 in 5S must not block 74-10 from leaving 5M through free 5N");
  assert.equal(ctx.getSdeShiftMoveActionBlockReason(main),"","the offered 5M→6N move must remain executable");

  const directRows = ctx.buildSdePhysicalBlockerGuardMoves([main]);
  assert.equal(directRows.length,1);
  assert.equal(directRows[0].sdePhysicalChainId,undefined);
  const directReader = ctx.buildSdeCanonicalProductionReader(snapshot(directRows,partialPlacements));
  const direct = ctx.inspectSdeCanonicalGraphicDragOrder(directReader,{
    vehicle:"74-10",sourceSlot:"5M",targetSlot:"6N",actionKey:ctx.getSdeMoveActionKey(main)
  });
  assert.equal(direct.ok,true,direct.reason);
  assert.equal(direct.adapter.ready,true);
  assert.equal(direct.adapter.canComplete,true);

  const occupiedTargets=new Set(partialPlacements.map(item=>item[0]));
  const manualTargets=vm.runInContext("inputSlots.filter(slot=>isSdeNightPlacementOrdinarySlot(slot))",ctx)
    .filter(target=>target!=="5M"&&!occupiedTargets.has(target));
  for(const requiredTarget of ["6N","6S","4M","4N","9","10N","6SS","2S","3M"]){
    assert.equal(manualTargets.includes(requiredTarget),true,"missing representative free target "+requiredTarget);
  }
  for(const target of manualTargets){
    resetState(partialPlacements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    vm.runInContext("sdeShiftLastRenderedData={moves:[]};sdeNightPlacementDropMessage=null;sdeNightPlacementBlockedMoveRequest=null;sdeProductionReaderFallbackError=null;",ctx);
    const payload={vehicle:"74-10",slot:"5M",fromSlot:"5M",sourceKind:"actual"};
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,target,{moves:[]});
    assert.equal(assessment.ok,true,target+": "+(assessment.message||"assessment rejected"));
    assert.equal(Boolean(assessment.hardPhysicalBlocked),false,target+": partial egress was classified as hard-blocked");
    const applied=ctx.applySdeNightPlacementDragOverride(payload,target);
    assert.equal(applied,true,target+": manual override was rejected");
    const dropMessage=vm.runInContext("sdeNightPlacementDropMessage",ctx);
    assert.notEqual(dropMessage?.type,"error",target+": manual override created a red rejection state");
    const overview=ctx.buildSdeNightPlacementOverviewData({moves:[]});
    assert.equal(overview.rejectedSlot,"",target+": free target received drop-rejected styling");
  }

  const trappedPlacements = [["5S","74-11"],["5M","74-10"],["5N","74-12"]];
  resetState(trappedPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const trappedMain={...main,stableActionKey:"trapped-5m-6n",sdeNightPlacementGeneratedActionKey:"trapped-5m-6n"};
  const trappedState=ctx.getSdeHardPhysicalBlockStateForMove(trappedMain);
  assert.equal(trappedState.hardBlocked,true,"both blocked ends must remain fail-closed");
  assert.equal(trappedState.accessAssessment?.sourceAccessBlocked,true);
  const trappedRows=ctx.buildSdePhysicalBlockerGuardMoves([trappedMain]);
  assert.equal(trappedRows.some(row=>row.vehicle==="74-10"&&row.fromSlot==="5M"&&row.toSlot==="6N"&&row.sdePhysicalDependencyRole!=="dependent"),false,"fully trapped main move must not become directly executable");
})();
`);

console.log(JSON.stringify({
  schemaVersion:"sde-partial-egress-route-availability-v1",
  status:"PASS",
  scenario:"74-10 5M with occupied 5S and free 5N",
  manualTargetContract:"every free ordinary slot",
  fullTrapGuard:"PASS"
}));
