"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2], "utf8");
const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
  .filter(match=>!/\bsrc\s*=/.test(match[1]) && !/type=["'](?:application\/json|application\/ld\+json|text\/plain)["']/i.test(match[1]))
  .map(match=>match[2]);

const storage = () => ({getItem(){return null;},setItem(){},removeItem(){},clear(){}});
const fakeElement = () => ({
  style:{setProperty(){},removeProperty(){}},
  children:[],childNodes:[],classList:{add(){},remove(){},toggle(){},contains(){return false;}},dataset:{},
  addEventListener(){},removeEventListener(){},appendChild(){},replaceChildren(...items){this.children=items;},
  querySelector(){return null;},querySelectorAll(){return [];},closest(){return null;},contains(){return false;},
  setAttribute(){},removeAttribute(){},getAttribute(){return null;},
  getBoundingClientRect(){return {left:0,top:0,width:0,height:0};},
  innerHTML:"",textContent:"",value:"",checked:false
});
const document = {
  addEventListener(){},removeEventListener(){},createElement(){return fakeElement();},getElementById(){return fakeElement();},
  querySelector(){return null;},querySelectorAll(){return [];},body:fakeElement(),documentElement:fakeElement()
};
const ctx = {
  console,
  setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},
  requestAnimationFrame(){return 1;},cancelAnimationFrame(){},
  location:{origin:"http://localhost",href:"http://localhost/",pathname:"/",search:"",hostname:"localhost"},
  addEventListener(){},removeEventListener(){},dispatchEvent(){},matchMedia(){return {matches:false,addEventListener(){},removeEventListener(){}};},
  innerWidth:1200,scrollTo(){},localStorage:storage(),sessionStorage:storage(),document,
  navigator:{userAgent:"node"},URL,URLSearchParams,Blob:function(){},FileReader:function(){},
  fetch:async()=>({ok:false,json:async()=>({}),text:async()=>""}),
  alert(message){throw new Error(`unexpected alert: ${message}`);}
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(scripts.join("\n;\n"),ctx,{filename:"index-inline.js"});
const appState = vm.runInContext("state",ctx);

function resetState(placements, extra={}){
  const grunnoppstilling = Object.fromEntries(placements.map(([slot,vehicle])=>[slot,vehicle]));
  vm.runInContext(`
    state.grunnoppstilling = ${JSON.stringify(grunnoppstilling)};
    state.grunnoppstillingRep = {};
    state.sdeMoveActions = {};
    state.sdeActiveMoveOutcomes = {};
    state.sdeNightPlacementManualOverrides = {};
    state.sdePhysicalReleaseReplans = {};
    state.sdeVnRecoveryObligations = {};
    state.planSkifteRows = [];
    state.txpUnavailableSlots = [];
    computeInndataCachedRows = null;
    computeInndataCacheDepth = 0;
  `,ctx);
  Object.assign(appState,extra);
}

function makeMain(track,vehicle,target,request){
  const fromSlot = `${track}S`;
  const actionKey = `night-placement-drag|${vehicle}|${fromSlot}|${target}|${request}`;
  return {
    vehicle,
    fromSlot,
    arrivalSlot:fromSlot,
    originalFromSlot:fromSlot,
    recommendedSlot:target,
    toSlot:target,
    stableActionKey:actionKey,
    sdeNightPlacementGeneratedActionKey:actionKey,
    needKey:`night-placement-drag-need|${actionKey}`,
    sdeNightPlacementGeneratedNeedKey:`night-placement-drag-need|${actionKey}`,
    source:"night-placement-drag",
    canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,
    sdeNightPlacementDragIdentity:request,
    manualPlanId:`manual-graphic-order|${request}`,
    sdeNightPlacementDragOverrideActive:true,
    isNightPlacementGenerated:true,
    isManualOnly:true
  };
}

function actualRows(placements){
  return placements.map(([slot,vehicle])=>({vehicleId:vehicle,slot}));
}

function snapshot(rows,placements,actions={}){
  const actual = actualRows(placements);
  return {
    schemaVersion:"sde-canonical-shadow-runtime-v1",
    actualSources:[{source:"canonical-actual",provenance:"phase-t-harness",selected:true,rows:actual}],
    actualStateReconciliation:{diagnostics:[]},
    legacy:{finalCards:rows,activeCards:rows,visibleCards:rows,activeButtonCount:0,activeCount:1,reservations:[],overlays:[],actualSlots:actual,unresolvedMarkers:[]},
    runtimeState:{actions,activeAuthorities:{}},
    infrastructure:{}
  };
}

function getRole(rows,role){
  return rows.find(row=>row.sdePhysicalDependencyRole === role);
}

function assertInitialChain(track,target){
  const blocker = `A-${track}`;
  const mainVehicle = `B-${track}`;
  const source = `${track}S`;
  const north = `${track}N`;
  const placements = [[north,blocker],[source,mainVehicle]];
  resetState(placements);
  const main = makeMain(track,mainVehicle,target,`request-${track}`);
  const blockState = ctx.getSdeHardPhysicalBlockStateForMove(main);
  assert.equal(blockState.hardBlocked,true);
  assert.equal(blockState.blockers.map(item=>item.slot).join(","),north);
  const rows = ctx.buildSdePhysicalBlockerGuardMoves([main]);
  assert.equal(rows.length,3);
  const release = getRole(rows,"prerequisite");
  const dependent = getRole(rows,"dependent");
  const recovery = getRole(rows,"return");
  assert.ok(release && dependent && recovery);
  assert.equal(release.vehicle,blocker);
  assert.equal(release.fromSlot,north);
  assert.equal(release.toSlot,"VN");
  assert.equal(dependent.vehicle,mainVehicle);
  assert.equal(dependent.fromSlot,source);
  assert.equal(dependent.toSlot,target);
  assert.equal(recovery.vehicle,blocker);
  assert.equal(recovery.fromSlot,"VN");
  assert.equal(recovery.toSlot,source);
  assert.equal(recovery.sdeRecoveryUsesPostMainTopology,true);
  assert.equal(new Set(rows.map(row=>row.sdePhysicalChainId)).size,1);
  assert.equal(dependent.sdePhysicalDependsOn.join(","),ctx.getSdeMoveActionKey(release));
  assert.equal(recovery.sdePhysicalDependsOn.join(","),ctx.getSdeMoveActionKey(dependent));
  assert.equal(release.canonicalChainStepActive,true);
  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements));
  const inspected = ctx.inspectSdeCanonicalGraphicDragVnReliefChain(reader,{
    vehicle:mainVehicle,sourceSlot:source,targetSlot:target,actionKey:ctx.getSdeMoveActionKey(dependent)
  });
  assert.equal(inspected.ok,true,inspected.reason);
  assert.equal(reader.cardProjection.activeProposalCount,1);
  assert.equal(reader.cardProjection.actionableCards.length,1);
  assert.equal(reader.cardProjection.blockedChainCards.length,2);
  assert.equal(reader.reservationProjection.reservations.length,3);
  assert.equal(reader.graphicProjection.activeOverlays.length,1);
  assert.equal(reader.graphicProjection.deferredOverlays.length,2);
  assert.equal(reader.graphicProjection.actualSlots.some(item=>item.vehicleId===blocker && item.slot===north),true);
  assert.equal(reader.graphicProjection.actualSlots.some(item=>item.vehicleId===mainVehicle && item.slot===source),true);
  assert.equal(inspected.cards.return.canDelete,false);
  assert.equal(inspected.cards.main.canComplete,false);
  assert.equal(inspected.adapters.release.ready,true);
  assert.equal(inspected.adapters.main.ready,false);
  assert.equal(inspected.adapters.return.ready,false);
  assert.equal(reader.reservationProjection.conflicts.length,0);
  return {track,target,blocker,mainVehicle,source,north,placements,main,rows,release,dependent,recovery,reader,inspected};
}

const chain10 = assertInitialChain("10","8N");
const chain11 = assertInitialChain("11","12N");
const chain12 = assertInitialChain("12","8N");

for(const track of ["10","11","12"]){
  const vehicle = `DIRECT-${track}`;
  const source = `${track}S`;
  const target = track === "11" ? "12N" : "8N";
  resetState([[source,vehicle]]);
  const main = makeMain(track,vehicle,target,`direct-${track}`);
  const rows = ctx.buildSdePhysicalBlockerGuardMoves([main]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].sdePhysicalChainId,undefined);
  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(rows,[[source,vehicle]]));
  const inspected = ctx.inspectSdeCanonicalGraphicDragOrder(reader,{vehicle,sourceSlot:source,targetSlot:target,actionKey:ctx.getSdeMoveActionKey(main)});
  assert.equal(inspected.ok,true,inspected.reason);
}

function assertWashConflict(slot){
  const placements = [["10N","W-A"],["10S","W-B"],[slot,"W-C"]];
  resetState(placements);
  const main = makeMain("10","W-B","8N",`wash-${slot}`);
  const rows = ctx.buildSdePhysicalBlockerGuardMoves([main]);
  assert.equal(rows.some(row=>row.sdePhysicalDependencyRole === "prerequisite" && row.toSlot === "VN"),false);
  assert.equal(rows.some(row=>row.sdePhysicalDependencyRole === "return" && row.toSlot),false);
  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements));
  assert.equal(reader.canonicalPlan.activeOutcomes.some(item=>item.vehicleId === "W-B" && item.targetSlot === "8N"),false);
  assert.equal(reader.reservationProjection.reservations.some(item=>item.vehicleId === "W-B"),false);
  assert.equal(reader.graphicProjection.activeOverlays.some(item=>item.vehicleId === "W-B"),false);
  assert.equal(reader.graphicProjection.deferredOverlays.some(item=>item.vehicleId === "W-B"),false);
  assert.ok(reader.cardProjection.diagnostics.length || reader.graphicProjection.unresolvedDiagnostics.length);
}
assertWashConflict("VN");
assertWashConflict("VS");

function competingWinner(order){
  const placements = [["10N","C-A"],["10S","C-B"],["12N","C-C"],["12S","C-D"]];
  resetState(placements);
  const first = makeMain("10","C-B","8N","compete-b");
  const second = makeMain("12","C-D","9","compete-d");
  const input = order === "reverse" ? [second,first] : [first,second];
  const rows = ctx.buildSdePhysicalBlockerGuardMoves(input);
  const releases = rows.filter(row=>row.sdePhysicalDependencyRole === "prerequisite" && row.toSlot === "VN");
  assert.equal(releases.length,1);
  const returns = rows.filter(row=>row.sdePhysicalDependencyRole === "return");
  assert.equal(returns.length,1);
  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements));
  assert.equal(reader.reservationProjection.reservations.filter(item=>item.targetSlot === "VN").length,1);
  assert.equal(reader.graphicProjection.activeOverlays.filter(item=>item.targetSlot === "VN").length,1);
  assert.equal(reader.reservationProjection.conflicts.some(item=>["VN_RESOURCE_OVERLAP","VS_RESOURCE_OVERLAP","OVERLAPPING_CHAIN_TARGET"].includes(item.classification)),false);
  return `${releases[0].vehicle}|${releases[0].fromSlot}`;
}
assert.equal(competingWinner("forward"),competingWinner("reverse"));

resetState(chain10.placements);
const existingRelease = {
  vehicle:chain10.blocker,fromSlot:"10N",arrivalSlot:"10N",recommendedSlot:"4M",toSlot:"4M",
  stableActionKey:"existing-release-10N-4M",source:"existing validated plan"
};
const reused = ctx.buildSdePhysicalBlockerGuardMoves([existingRelease,chain10.main]);
const reusedRelease = getRole(reused,"prerequisite");
assert.equal(reused.filter(row=>row.vehicle === chain10.blocker && row.fromSlot === "10N" && row.toSlot === "4M").length,1);
assert.equal(reused.some(row=>row.sdePhysicalDependencyRole === "return"),false);
assert.equal(getRole(reused,"dependent").sdePhysicalDependsOn[0],ctx.getSdeMoveActionKey(reusedRelease));

resetState(chain10.placements);
appState.sdeMoveActions = {[ctx.getSdeMoveActionKey(chain10.release)]:{action:"completed"}};
const afterStep1Placements = [["VN",chain10.blocker],["10S",chain10.mainVehicle]];
resetState(afterStep1Placements,{sdeMoveActions:{[ctx.getSdeMoveActionKey(chain10.release)]:{action:"completed"}}});
const afterStep1 = ctx.buildSdeCanonicalProductionReader(snapshot(
  [chain10.dependent,chain10.recovery],afterStep1Placements,appState.sdeMoveActions
));
assert.equal(afterStep1.cardProjection.actionableCards.map(card=>card.targetSlot).join(","),"8N");
assert.equal(afterStep1.cardProjection.blockedChainCards.map(card=>card.targetSlot).join(","),"10S");
assert.equal(afterStep1.handlerAdapters[afterStep1.cardProjection.actionableCards[0].canonicalCardId].ready,true);

const step2Actions = {
  [ctx.getSdeMoveActionKey(chain10.release)]:{action:"completed"},
  [ctx.getSdeMoveActionKey(chain10.dependent)]:{action:"completed"}
};
const afterStep2Placements = [["VN",chain10.blocker],["8N",chain10.mainVehicle]];
resetState(afterStep2Placements,{sdeMoveActions:step2Actions});
const afterStep2 = ctx.buildSdeCanonicalProductionReader(snapshot([chain10.recovery],afterStep2Placements,step2Actions));
assert.equal(afterStep2.cardProjection.actionableCards.map(card=>card.targetSlot).join(","),"10S");
assert.equal(afterStep2.cardProjection.actionableCards[0].recoveryRequired,true);
assert.equal(afterStep2.cardProjection.actionableCards[0].canDelete,false);
assert.equal(afterStep2.cardProjection.actionableCards[0].canCancel,false);
assert.equal(afterStep2.graphicProjection.activeOverlays.length,1);

resetState(chain10.placements);
const persistedRows = ctx.buildSdePhysicalBlockerGuardMoves([chain10.main]);
const persistedRelease = getRole(persistedRows,"prerequisite");
const persistedMain = getRole(persistedRows,"dependent");
ctx.updateSdeVnRecoveryObligationForMove(persistedRelease,"completed","2026-07-14T14:00:00.000Z");
assert.equal(Object.keys(appState.sdeVnRecoveryObligations).length,1);
const hydratedObligations = JSON.parse(JSON.stringify(appState.sdeVnRecoveryObligations));
resetState([["VN",chain10.blocker],["10S",chain10.mainVehicle]],{sdeVnRecoveryObligations:hydratedObligations});
const hydratedRecoveryRows = ctx.buildSdePersistentVnRecoveryRows([persistedMain]);
assert.equal(hydratedRecoveryRows.length,1);
assert.equal(hydratedRecoveryRows[0].fromSlot,"VN");
assert.equal(hydratedRecoveryRows[0].toSlot,"10S");
assert.equal(hydratedRecoveryRows[0].sdeVnRecoveryRequired,true);
ctx.updateSdeVnRecoveryObligationForMove(persistedMain,"completed","2026-07-14T14:05:00.000Z");
assert.equal(Object.values(appState.sdeVnRecoveryObligations)[0].vnRecoveryStatus,"return_ready");

resetState(chain10.placements);
ctx.updateSdeVnRecoveryObligationForMove(chain10.release,"cancelled","2026-07-14T14:10:00.000Z");
assert.equal(Object.keys(appState.sdeVnRecoveryObligations).length,0);
assert.equal(chain10.inspected.cards.main.canCancel,false);
assert.equal(chain10.inspected.cards.return.canDelete,false);

assert.ok(html.includes('entry.aliasType !== "chainId"'));
assert.ok(html.includes('override?.hardPhysicalBlocked'));
assert.ok(html.includes('requested_target_with_physical_guard'));
assert.ok(html.includes('assessment.hardPhysicalBlocked && !canonicalReaderMode'));

console.log(JSON.stringify({
  ok:true,
  initial:{tracks:["10","11","12"],chains:3,stepsPerChain:3,actionablePerChain:1,blockedPerChain:2},
  direct:{tracks:["10","11","12"],cardsPerMove:1,chains:0},
  conflicts:{vn:"fail_closed",vs:"fail_closed",simultaneousVnReservations:1,deterministicWinner:true},
  sequence:{start:"N→VN",afterStep1:"S→requested target",afterStep2:"VN→vacated S"},
  recovery:{hydrated:true,required:true,canDelete:false,canCancel:false},
  adapters:{step1:"ready",step2:"dependency-blocked",step3:"dependency-blocked"},
  existingReleasePlan:{reused:true,duplicates:0}
},null,2));
