"use strict";
const fs = require("node:fs");
const path = require("node:path");
const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));
eval(prefix + String.raw`
(async()=>{
  function direct(vehicle,from,to,id){
    const actionKey = "night-placement-drag|"+vehicle.replace(/[^0-9A-Za-z-]/g,"")+"|"+from+"|"+to+"|"+id;
    return {vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to,stableActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:id,
      manualPlanId:"manual-graphic-order|"+id,sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true};
  }
  const report = {handler:{},multiple:{},access:{},progression:{},persistence:{},history:{}};

  // Problem 1: rendered snapshot and canonical authority use the same identity.
  const p1Placements = [["5M","75-01"]];
  const p1Row = direct("75-01","5M","4M","p1");
  const p1Reader = ctx.buildSdeCanonicalProductionReader(snapshot([p1Row],p1Placements));
  const p1Card = p1Reader.cardProjection.actionableCards[0];
  const p1Adapter = p1Reader.handlerAdapters[p1Card.canonicalCardId];
  const p1Authority = {activeOutcomeId:p1Card.activeOutcomeId,canonicalActiveOutcomeId:p1Card.activeOutcomeId,legacyActionKey:p1Adapter.actionKey,
    obligationId:p1Card.obligationId,stepId:p1Card.stepId};
  const p1Context = {canonicalCardId:p1Card.canonicalCardId,activeOutcomeId:p1Card.activeOutcomeId,obligationId:p1Card.obligationId,
    stepId:p1Card.stepId,actionKey:p1Adapter.actionKey};
  assert.equal(ctx.doesSdeCanonicalActionAuthorityMatch(p1Adapter.row,p1Authority,p1Context),true);
  assert.equal(ctx.doesSdeCanonicalActionAuthorityMatch(p1Adapter.row,{...p1Authority,activeOutcomeId:"replacement"},p1Context),false);
  assert.ok(p1Reader.planRevision);
  const p1Html = ctx.buildSdeCanonicalProductionCardHtml(p1Card,p1Reader,0);
  assert.ok(p1Html.includes('data-sde-plan-revision="'+p1Reader.planRevision+'"'));
  let handlerCalls = 0;
  let rerenders = 0;
  let alerts = [];
  const originalReaderBuilder = ctx.buildSdeCanonicalProductionReader;
  const originalHandler = ctx.handleSdeShiftMoveAction;
  ctx.buildSdeCanonicalProductionReader = ()=>p1Reader;
  ctx.handleSdeShiftMoveAction = async (_key,_action,context)=>{handlerCalls+=1; assert.equal(context.activeOutcomeId,p1Card.activeOutcomeId);};
  ctx.renderSdeSkiftebevegelser = ()=>{rerenders+=1;};
  ctx.alert = message=>{alerts.push(String(message));};
  await ctx.handleSdeCanonicalCardAction(encodeURIComponent(p1Card.canonicalCardId),"completed",encodeURIComponent(p1Reader.planRevision));
  assert.equal(handlerCalls,1);
  await ctx.handleSdeCanonicalCardAction(encodeURIComponent(p1Card.canonicalCardId),"completed",encodeURIComponent("stale-revision"));
  assert.equal(handlerCalls,1);
  assert.equal(rerenders,1);
  assert.ok(alerts.some(message=>message.includes("oppdatert siden")));
  ctx.buildSdeCanonicalProductionReader = originalReaderBuilder;
  ctx.handleSdeShiftMoveAction = originalHandler;
  report.handler={ready:p1Adapter.ready,currentCalledOnce:handlerCalls===1,staleWrite:false,rerendered:rerenders===1,planRevision:p1Reader.planRevision};

  // Problem 2: independent obligations coexist, while same-vehicle stale source authority is retired.
  const multiPlacements = [["5M","75-01"],["11S","74-11"],["10S","74-12"]];
  const planA = direct("75-01","5M","1N","plan-a");
  const planB = direct("74-11","11S","1S","plan-b");
  const planC = direct("74-12","10S","4S","plan-c");
  const multiReader = ctx.buildSdeCanonicalProductionReader(snapshot([planA,planB,planC],multiPlacements));
  assert.equal(multiReader.canonicalPlan.activeOutcomes.length,3);
  assert.equal(multiReader.cardProjection.actionableCards.length,3);
  assert.equal(multiReader.reservationProjection.reservations.length,3);
  assert.equal(multiReader.graphicProjection.activeOverlays.length,3);
  assert.equal(new Set(multiReader.canonicalPlan.activeOutcomes.map(item=>item.obligationId)).size,3);
  assert.equal(multiReader.reservationProjection.conflicts.length,0);
  resetState(multiPlacements);
  appState.sdeNightPlacementManualOverrides = {old:{vehicle:"74-12",fromSlot:"11S",originalFromSlot:"11S",toSlot:"12N",sdeCanonicalGraphicDragOrder:true}};
  appState.sdeActiveMoveOutcomes = {old:{vehicle:"74-12",physicalFromSlot:"11S",producer:"graphic_drag_generated_move",activeOutcomeId:"old"}};
  assert.equal(ctx.removeSdeStaleCanonicalGraphicOverridesForVehicle("74-12","10S"),true);
  assert.equal(ctx.removeSdeStaleCanonicalGraphicAuthoritiesForVehicle("74-12","10S"),true);
  assert.equal(Object.keys(appState.sdeNightPlacementManualOverrides).length,0);
  assert.equal(Object.keys(appState.sdeActiveMoveOutcomes).length,0);
  vm.runInContext('sdeShiftLastRenderedData={moves:[],score:0}',ctx);
  ctx.renderSdeSkiftebevegelser = ()=>{};
  const exactDragAccepted = ctx.applySdeNightPlacementDragOverride({vehicle:"74-12",slot:"10S",fromSlot:"10S",sourceKind:"actual"},"4S");
  assert.equal(exactDragAccepted,true,String(vm.runInContext('sdeNightPlacementDropMessage?.text||""',ctx)));
  assert.equal(Object.values(appState.sdeNightPlacementManualOverrides).filter(item=>item.vehicle==="74-12" && item.fromSlot==="10S" && item.toSlot==="4S").length,1);
  assert.equal(Object.values(appState.sdeNightPlacementManualOverrides).some(item=>item.vehicle==="74-12" && item.fromSlot==="11S"),false);

  // Automatic stale-source pruning removes impossible canonical drag orders before they can render as unsolvable cards.
  resetState([["11S","74-10"],["5M","69-55"],["5N","74-12"]]);
  appState.sdeNightPlacementManualOverrides = {
    stale:{
      id:"stale",
      vehicle:"74-10",
      fromSlot:"5M",
      originalFromSlot:"5M",
      toSlot:"6N",
      stableActionKey:"night-placement-drag|7410|5M|6N|stale",
      moveKey:"night-placement-drag|7410|5M|6N|stale",
      needKey:"night-placement-drag-need|night-placement-drag|7410|5M|6N|stale",
      sdeCanonicalGraphicDragOrder:true,
      dragRequestId:"stale",
      createdAt:"2026-07-16T08:00:00.000Z",
      updatedAt:"2026-07-16T08:00:00.000Z"
    }
  };
  appState.sdeActiveMoveOutcomes = {
    stale:{vehicle:"74-10",physicalFromSlot:"5M",producer:"graphic_drag_generated_move",activeOutcomeId:"stale"}
  };
  const prunedOverrides = ctx.getSdeNightPlacementActiveManualOverrides();
  assert.equal(prunedOverrides.length,0);
  assert.equal(Object.keys(appState.sdeNightPlacementManualOverrides).length,0);
  assert.equal(Object.keys(appState.sdeActiveMoveOutcomes).length,0);

  resetState([["11S","74-10"]]);
  appState.sdeNightPlacementManualOverrides = {
    parent:{
      id:"parent",
      vehicle:"74-10",
      fromSlot:"11S",
      originalFromSlot:"11S",
      toSlot:"5M",
      stableActionKey:"night-placement-drag|7410|11S|5M|parent",
      moveKey:"night-placement-drag|7410|11S|5M|parent",
      needKey:"night-placement-drag-need|night-placement-drag|7410|11S|5M|parent",
      sdeCanonicalGraphicDragOrder:true,
      dragRequestId:"parent",
      createdAt:"2026-07-16T08:01:00.000Z",
      updatedAt:"2026-07-16T08:01:00.000Z"
    },
    child:{
      id:"child",
      vehicle:"74-10",
      fromSlot:"5M",
      originalFromSlot:"5M",
      toSlot:"6N",
      stableActionKey:"night-placement-drag|7410|5M|6N|child",
      moveKey:"night-placement-drag|7410|5M|6N|child",
      needKey:"night-placement-drag-need|night-placement-drag|7410|5M|6N|child",
      sdeCanonicalGraphicDragOrder:true,
      dragRequestId:"child",
      createdAt:"2026-07-16T08:02:00.000Z",
      updatedAt:"2026-07-16T08:02:00.000Z"
    }
  };
  const keptOverrides = ctx.getSdeNightPlacementActiveManualOverrides();
  assert.equal(keptOverrides.length,2);
  assert.equal(Object.keys(appState.sdeNightPlacementManualOverrides).length,2);

  resetState(multiPlacements);
  vm.runInContext('sdeShiftLastRenderedData={moves:[],score:0}',ctx);
  ctx.renderSdeSkiftebevegelser = ()=>{};
  const repeatedExactDrag = ctx.applySdeNightPlacementDragOverride({vehicle:"74-12",slot:"10S",fromSlot:"10S",sourceKind:"actual"},"4S");
  assert.equal(repeatedExactDrag,true);
  assert.equal(Object.values(appState.sdeNightPlacementManualOverrides).filter(item=>item.vehicle==="74-12" && item.fromSlot==="10S" && item.toSlot==="4S").length,1);
  const duplicateReader = ctx.buildSdeCanonicalProductionReader(snapshot([planA,planB,planC,JSON.parse(JSON.stringify(planC))],multiPlacements));
  assert.equal(duplicateReader.cardProjection.actionableCards.filter(card=>card.vehicleId==="74-12").length,0);
  assert.ok(duplicateReader.cardProjection.handlerBlockedCards.some(card=>card.vehicleId==="74-12") || duplicateReader.cardProjection.diagnostics.some(item=>item.vehicleId==="74-12"));
  report.multiple={obligations:3,activeOutcomes:3,cards:3,reservations:3,overlays:3,staleSourceRetired:true,exactDragAccepted,identicalDragNoOp:true,duplicateFailClosed:true};

  // Problem 3: generic three-step access relief with deterministic blocker/holding/return.
  const accessPlacements = [["5M","75-01"],["4N","75-10"],["4S","75-09"]];
  resetState(accessPlacements);
  vm.runInContext('sdeShiftLastRenderedData={moves:[],score:0}',ctx);
  const exactAccessDragAccepted = ctx.applySdeNightPlacementDragOverride({vehicle:"75-01",slot:"5M",fromSlot:"5M",sourceKind:"actual"},"4M");
  assert.equal(exactAccessDragAccepted,true,String(vm.runInContext('sdeNightPlacementDropMessage?.text||""',ctx)));
  const liveAccessOverride = Object.values(appState.sdeNightPlacementManualOverrides).find(item=>item.vehicle==="75-01" && item.fromSlot==="5M" && item.toSlot==="4M");
  assert.equal(liveAccessOverride?.hardPhysicalBlocked,true);
  assert.equal(liveAccessOverride?.sdeCanonicalManualAuthority?.authorityMode,"requested_target_with_physical_guard");
  resetState(accessPlacements);
  const accessMain = direct("75-01","5M","4M","access-main");
  const blockState = ctx.getSdeHardPhysicalBlockStateForMove(accessMain);
  assert.equal(blockState.accessAssessment.targetAccessBlocked,true);
  const accessRows = ctx.buildSdePhysicalBlockerGuardMoves([accessMain]);
  assert.equal(accessRows.length,3);
  const release = getRole(accessRows,"prerequisite");
  const main = getRole(accessRows,"dependent");
  const recovery = getRole(accessRows,"return");
  assert.ok(release && main && recovery);
  assert.equal(main.toSlot,"4M");
  assert.equal(recovery.toSlot,release.fromSlot);
  assert.equal(recovery.fromSlot,release.toSlot);
  assert.equal(recovery.isSdePhysicalBlockerReturnMove,true);
  assert.equal(recovery.sdePhysicalAccessReliefChain.context,"target_access_temporary_relief");
  const accessReader = ctx.buildSdeCanonicalProductionReader(snapshot(accessRows,accessPlacements));
  const inspected = ctx.inspectSdeCanonicalGraphicDragAccessReliefChain(accessReader,{vehicle:"75-01",sourceSlot:"5M",targetSlot:"4M",actionKey:ctx.getSdeMoveActionKey(main)});
  assert.equal(inspected.ok,true,inspected.reason);
  assert.equal(accessReader.cardProjection.activeProposalCount,1);
  assert.equal(accessReader.cardProjection.actionableCards.length,1);
  assert.equal(accessReader.cardProjection.blockedChainCards.length,2);
  assert.equal(accessReader.reservationProjection.reservations.length,3);
  assert.equal(accessReader.graphicProjection.activeOverlays.length,1);
  assert.equal(accessReader.graphicProjection.deferredOverlays.length,2);
  assert.equal(inspected.cards.return.canCancel,false);
  assert.equal(inspected.cards.return.canDelete,false);
  assert.equal(accessReader.reservationProjection.conflicts.length,0);
  report.access={exactDragAccepted:exactAccessDragAccepted,blocker:release.vehicle,from:release.fromSlot,holding:release.toSlot,mainTarget:main.toSlot,returnTarget:recovery.toSlot,resource:inspected.plan.accessResource,chainOutcomes:3};

  // Both-end deterministic and a reservation of 4S forces the north-side blocker.
  resetState(accessPlacements);
  const repeatedRows = ctx.buildSdePhysicalBlockerGuardMoves([accessMain]);
  assert.equal(getRole(repeatedRows,"prerequisite").fromSlot,release.fromSlot);
  resetState(accessPlacements);
  const reservedSouth = direct("74-12","10S","4S","reserved-4s");
  const directReservedChoice = ctx.buildSdePhysicalBlockerFreeingMove(accessMain,ctx.getSdeHardPhysicalBlockStateForMove(accessMain),[reservedSouth,accessMain],{avoidSlots:["4S","4M"],sequenceReservedSlots:["4S","4M"]});
  assert.equal(directReservedChoice.fromSlot,"4N");
  const northRows = ctx.buildSdePhysicalBlockerGuardMoves([reservedSouth,accessMain]);
  const northRelease = northRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite" && row.sdePhysicalBlockerForVehicle==="75-01");
  assert.equal(northRelease.fromSlot,"4N");
  assert.equal(getRole(northRows.filter(row=>row.sdePhysicalChainId===northRelease.sdePhysicalChainId),"return").toSlot,"4N");

  // Explicit single-side topology contexts use the same generic builder.
  for(const side of ["north","south"]){
    resetState(accessPlacements);
    const selectedBlocker = blockState.blockers.find(item=>item.accessEnd===side);
    const synthetic = {...blockState,blockers:[selectedBlocker],accessAssessment:{...blockState.accessAssessment,targetAccessBlocked:true,targetAccessOptions:blockState.accessAssessment.targetAccessOptions.filter(option=>option.end===side)}};
    const freeing = ctx.buildSdePhysicalBlockerFreeingMove(accessMain,synthetic,[accessMain],{avoidSlots:["4M"],sequenceReservedSlots:["4M"]});
    if(!freeing) console.error(JSON.stringify({side,candidates:ctx.getSdePhysicalBlockerReleaseCandidateOrder(selectedBlocker.vehicle,selectedBlocker.slot,"5M",{avoidSlots:["4M"]})},null,2));
    const plan = ctx.buildSdeTemporaryAccessReliefChainPlan(accessMain,synthetic,freeing,ctx.getSdePhysicalDependencyChainId(accessMain,synthetic,freeing),{reservedSlots:["4M"]});
    assert.equal(plan.accessEnd,side);
    assert.equal(plan.returnTargetSlot,selectedBlocker.slot);
  }

  // Stepwise progression and hydration.
  const releaseKey = ctx.getSdeMoveActionKey(release);
  const mainKey = ctx.getSdeMoveActionKey(main);
  const returnKey = ctx.getSdeMoveActionKey(recovery);
  const holdingPlacements = [[release.toSlot,release.vehicle],["5M","75-01"],[release.fromSlot==="4S"?"4N":"4S",release.fromSlot==="4S"?"75-10":"75-09"]];
  const actions1 = {[releaseKey]:{action:"completed",snapshot:ctx.getSdeMoveActionSnapshot(release)}};
  const after1 = ctx.buildSdeCanonicalProductionReader(snapshot([main,recovery],holdingPlacements,actions1));
  assert.equal(after1.cardProjection.actionableCards.map(card=>card.targetSlot).join(","),"4M");
  assert.equal(after1.cardProjection.blockedChainCards.map(card=>card.targetSlot).join(","),release.fromSlot);
  const actions2 = {...actions1,[mainKey]:{action:"completed",snapshot:ctx.getSdeMoveActionSnapshot(main)}};
  const after2Placements = [[release.toSlot,release.vehicle],["4M","75-01"],[release.fromSlot==="4S"?"4N":"4S",release.fromSlot==="4S"?"75-10":"75-09"]];
  const after2 = ctx.buildSdeCanonicalProductionReader(snapshot([recovery],after2Placements,actions2));
  assert.equal(after2.cardProjection.actionableCards.map(card=>card.targetSlot).join(","),release.fromSlot);
  assert.equal(after2.cardProjection.actionableCards[0].canCancel,false);
  const actions3 = {...actions2,[returnKey]:{action:"completed",snapshot:ctx.getSdeMoveActionSnapshot(recovery)}};
  const after3 = ctx.buildSdeCanonicalProductionReader(snapshot([],[[release.fromSlot,release.vehicle],["4M","75-01"]],actions3));
  assert.equal(after3.cardProjection.actionableCards.length,0);
  report.progression={before:"1 ready + 2 blocked",afterStep1:"main ready",afterStep2:"return ready",afterStep3:"closed"};

  resetState(holdingPlacements,{sdeMoveActions:actions1});
  const hydratedWithMain = ctx.buildSdePhysicalBlockerGuardMoves([accessMain]);
  assert.equal(hydratedWithMain.filter(row=>row.sdePhysicalDependencyRole==="return").length,1);
  assert.equal(hydratedWithMain.filter(row=>row.sdePhysicalDependencyRole==="dependent").length,1);
  const hydratedWithoutMain = ctx.buildSdePhysicalBlockerGuardMoves([]);
  assert.equal(hydratedWithoutMain.filter(row=>row.sdePhysicalDependencyRole==="return").length,1);
  appState.sdeMoveActions[mainKey] = {action:"cancelled",snapshot:ctx.getSdeMoveActionSnapshot(main)};
  const recoveryAfterCancel = ctx.buildSdePersistentTemporaryAccessReliefRows()[0];
  assert.equal(recoveryAfterCancel.sdePhysicalDependsOn.join(","),releaseKey);
  assert.equal(recoveryAfterCancel.isSdePhysicalBlockerReturnMove,true);
  report.persistence={reloadBeforeMain:true,reloadWithoutMain:true,recoveryAfterCancel:true};

  // No safe temporary target and occupied main target fail closed without an operative main plan.
  const candidateSlots = ctx.getSdeResolutionCandidateSlots("4S","5M").filter(slot=>!["4S","4M","5M"].includes(slot));
  const fullPlacements = [["5M","75-01"],["4N","75-10"],["4S","75-09"],["VN","X-VN"],["VS","X-VS"],...candidateSlots.map((slot,index)=>[slot,"X-"+index])];
  resetState(fullPlacements);
  const noSafeRows = ctx.buildSdePhysicalBlockerGuardMoves([accessMain]);
  assert.equal(noSafeRows.some(row=>row.sdePhysicalResolutionContext==="target_access_temporary_relief"),false);
  const noSafeReader = ctx.buildSdeCanonicalProductionReader(snapshot(noSafeRows,fullPlacements));
  assert.equal(noSafeReader.cardProjection.actionableCards.some(card=>card.vehicleId==="75-01"),false);
  vm.runInContext('sdeShiftLastRenderedData={moves:[],score:0}',ctx);
  const noSafeDrag = ctx.applySdeNightPlacementDragOverride({vehicle:"75-01",slot:"5M",fromSlot:"5M",sourceKind:"actual"},"4M");
  assert.equal(noSafeDrag,false);
  assert.equal(Object.keys(appState.sdeNightPlacementManualOverrides).length,0);
  resetState([...accessPlacements,["4M","X-TARGET"]]);
  const occupiedBlock = ctx.getSdeHardPhysicalBlockStateForMove(accessMain);
  const occupiedFree = ctx.buildSdePhysicalBlockerFreeingMove(accessMain,occupiedBlock,[accessMain]);
  assert.equal(ctx.buildSdeTemporaryAccessReliefChainPlan(accessMain,occupiedBlock,occupiedFree,"occupied",{}),null);
  vm.runInContext('sdeShiftLastRenderedData={moves:[],score:0}',ctx);
  const occupiedDrag = ctx.applySdeNightPlacementDragOverride({vehicle:"75-01",slot:"5M",fromSlot:"5M",sourceKind:"actual"},"4M");
  assert.equal(occupiedDrag,false);
  assert.equal(Object.keys(appState.sdeNightPlacementManualOverrides).length,0);

  // History/exiting does not reserve, overlay, or become authority.
  const historical = {...planC,status:"dismissing",sdeCancellationDismissalCard:true,stableActionKey:"old-history"};
  const historyReader = ctx.buildSdeCanonicalProductionReader(snapshot([planA,planB,planC,historical],multiPlacements));
  assert.equal(historyReader.canonicalPlan.activeOutcomes.length,3);
  assert.equal(historyReader.reservationProjection.reservations.length,3);
  assert.equal(historyReader.graphicProjection.activeOverlays.length,3);
  assert.equal(historyReader.cardProjection.exitingCards.length,1);
  report.history={active:3,exiting:1,historyReservations:0,historyOverlays:0};

  console.log(JSON.stringify({ok:true,...report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
