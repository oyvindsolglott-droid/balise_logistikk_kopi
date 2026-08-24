"use strict";

const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(process.argv[2],"utf8");
if(source.includes('migrationMode:"CANONICAL_ONLY"')){
  require("./sde-phase-a-canonical-contract-helper.cjs").runScenario("stable-execution",process.argv[2]);
  process.exit(0);
}
const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(async()=>{
  function direct(vehicle,from,to,id){
    const actionKey = "night-placement-drag|"+vehicle.replace(/[^0-9A-Za-z-]/g,"")+"|"+from+"|"+to+"|"+id;
    return {
      vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to,
      stableActionKey:actionKey,sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
      source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:id,manualPlanId:"manual-graphic-order|"+id,
      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true
    };
  }

  function readerSnapshot(rows,placements,cycle=0,actions={}){
    const value = snapshot(rows,placements,actions);
    value.legacy.activeButtonCount = cycle % 7;
    value.legacy.historyOpen = cycle % 2 === 0;
    value.legacy.graphicPlanVisible = cycle % 3 === 0;
    value.runtimeState.actionHistory = Array.from({length:cycle % 4},(_,index)=>({id:"unrelated-history-"+index}));
    value.runtimeState.timerTick = 1700000000000 + cycle;
    value.infrastructure = {
      viewMode:cycle % 2 ? "cards" : "graphic",
      diagnosticRevision:"diagnostic-"+cycle,
      animationTick:cycle
    };
    return value;
  }

  function getPrimary(rows){
    const release = getRole(rows,"prerequisite");
    const main = getRole(rows,"dependent");
    const recovery = getRole(rows,"return");
    assert.ok(release && main && recovery);
    return {release,main,recovery};
  }

  const report = {execution:{},preferred:{},fallback:{},conflict:{},supersession:{}};
  const placements = [["5M","75-01"],["4N","75-10"],["4S","75-09"]];
  const mainMove = direct("75-01","5M","4M","w-main");

  // Preferred 4M access chain uses the highest-ranked safe local holding slot.
  resetState(placements);
  appState.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};
  const preferredRows = ctx.buildSdePhysicalBlockerGuardMoves([mainMove]);
  assert.equal(preferredRows.length,3);
  const preferred = getPrimary(preferredRows);
  assert.equal(preferred.release.vehicle,"75-10");
  assert.equal(preferred.release.fromSlot,"4N");
  assert.equal(preferred.release.toSlot,"5N");
  assert.equal(preferred.main.vehicle,"75-01");
  assert.equal(preferred.main.fromSlot,"5M");
  assert.equal(preferred.main.toSlot,"4M");
  assert.equal(preferred.recovery.vehicle,"75-10");
  assert.equal(preferred.recovery.fromSlot,"5N");
  assert.equal(preferred.recovery.toSlot,"4N");
  assert.equal(preferred.release.sdePhysicalAccessReliefChain.holdingSlot,"5N");
  assert.equal(preferred.release.sdePhysicalAccessReliefChain.transitResource,"");
  assert.deepEqual(Array.from(preferred.release.sdePhysicalAccessReliefChain.routeResources),["track-access|4|north"]);

  const preferredReader = ctx.buildSdeCanonicalProductionReader(readerSnapshot(preferredRows,placements,0));
  assert.equal(preferredReader.integrityReport.status,"PASS");
  assert.equal(preferredReader.cardProjection.actionableCards.length,1);
  assert.equal(preferredReader.cardProjection.blockedChainCards.length,2);
  assert.equal(preferredReader.reservationProjection.reservations.length,3);
  assert.equal(preferredReader.graphicProjection.activeOverlays.length,1);
  assert.equal(preferredReader.graphicProjection.deferredOverlays.length,2);
  assert.equal(preferredReader.reservationProjection.conflicts.length,0);
  assert.equal(preferredReader.reservationProjection.reservations.some(item=>item.targetSlot==="5N"),true);
  assert.equal(preferredReader.graphicProjection.activeOverlays.concat(preferredReader.graphicProjection.deferredOverlays).some(item=>item.targetSlot==="5N"),true);
  assert.equal(preferredReader.reservationProjection.reservations.every(item=>!item.routeResources.includes("VN") && !item.routeResources.includes("VS")),true);
  assert.equal(preferredReader.graphicProjection.actualSlots.some(item=>item.vehicleId==="75-10" && item.slot==="4N"),true);
  assert.equal(preferredReader.graphicProjection.actualSlots.some(item=>item.vehicleId==="75-01" && item.slot==="5M"),true);
  const preferredCards = [
    ...preferredReader.cardProjection.actionableCards,
    ...preferredReader.cardProjection.blockedChainCards
  ];
  const preferredAdapters = preferredCards.map(card=>preferredReader.handlerAdapters[card.canonicalCardId]);
  assert.equal(preferredAdapters.filter(adapter=>adapter.executionResolution.status==="ready").length,1);
  assert.equal(preferredAdapters.filter(adapter=>adapter.executionResolution.status==="dependency_blocked").length,2);
  assert.equal(preferredAdapters.every(adapter=>adapter.executionKey && adapter.relevantRevision),true);
  report.preferred={chain:"4N→5N;5M→4M;5N→4N",cards:"1+2",reservations:3,overlays:"1+2",integrity:"PASS",routeResources:["track-access|4|north"]};

  // Stable execution contract across 50 presentation/global-snapshot perturbations.
  const renderedCard = preferredReader.cardProjection.actionableCards[0];
  const renderedAdapter = preferredReader.handlerAdapters[renderedCard.canonicalCardId];
  assert.equal(renderedAdapter.ready,true);
  assert.equal(renderedAdapter.canComplete,true);
  assert.equal(renderedAdapter.canCancel,true);
  const executionKeys = new Set([renderedAdapter.executionKey]);
  const relevantRevisions = new Set([renderedAdapter.relevantRevision]);
  const globalRevisions = new Set([preferredReader.planRevision]);
  const currentReaders = [];
  const unrelatedMove = direct("U-01","11S","12N","w-unrelated");
  for(let cycle=1;cycle<=50;cycle++){
    const withUnrelatedObligation = cycle % 4 === 0;
    const cyclePlacements = withUnrelatedObligation ? [...placements,["11S","U-01"]] : placements;
    resetState(cyclePlacements);
    const samePlanRows = cycle % 2 ? [...preferredRows].reverse() : JSON.parse(JSON.stringify(preferredRows));
    const rows = withUnrelatedObligation ? [unrelatedMove,...samePlanRows] : samePlanRows;
    const currentReader = ctx.buildSdeCanonicalProductionReader(readerSnapshot(rows,cyclePlacements,cycle));
    const currentCard = currentReader.cardProjection.actionableCards.find(card=>card.obligationId===renderedCard.obligationId && card.stepId===renderedCard.stepId);
    assert.ok(currentCard,"same operative step must survive cycle "+cycle);
    const currentAdapter = currentReader.handlerAdapters[currentCard.canonicalCardId];
    const resolution = ctx.resolveSdeCanonicalExecutableAction({
      renderedDescriptor:renderedAdapter.executionDescriptor,
      currentDescriptor:currentAdapter.executionDescriptor,
      currentCard,
      currentHandlerDescriptor:currentAdapter,
      currentCanonicalPlan:currentReader.canonicalPlan,
      currentCardProjection:currentReader.cardProjection,
      currentReservationProjection:currentReader.reservationProjection,
      currentGraphicProjection:currentReader.graphicProjection,
      actionType:"completed"
    });
    assert.equal(resolution.status,"ready","cycle "+cycle+": "+resolution.reason);
    assert.equal(resolution.executable,true);
    assert.equal(currentAdapter.executionKey,renderedAdapter.executionKey);
    assert.equal(currentAdapter.relevantRevision,renderedAdapter.relevantRevision);
    assert.equal(currentAdapter.actionKey,renderedAdapter.actionKey);
    executionKeys.add(currentAdapter.executionKey);
    relevantRevisions.add(currentAdapter.relevantRevision);
    globalRevisions.add(currentReader.planRevision);
    currentReaders.push(currentReader);
  }
  assert.equal(executionKeys.size,1);
  assert.equal(relevantRevisions.size,1);
  assert.ok(globalRevisions.size>1,"global planRevision must remain presentation/snapshot scoped");

  // The visible ready card reaches the existing write handler exactly once after unrelated rerenders.
  const originalReaderBuilder = ctx.buildSdeCanonicalProductionReader;
  const originalHandler = ctx.handleSdeShiftMoveAction;
  let handlerCalls = 0;
  let rerenders = 0;
  const alerts = [];
  const clickReader = currentReaders[49];
  ctx.buildSdeCanonicalProductionReader = ()=>clickReader;
  ctx.handleSdeShiftMoveAction = async (_key,action,context)=>{
    handlerCalls += 1;
    assert.equal(action,"completed");
    assert.equal(context.activeOutcomeId,clickReader.cardProjection.actionableCards[0].activeOutcomeId);
    assert.equal(context.executionKey,renderedAdapter.executionKey);
    assert.equal(context.relevantRevision,renderedAdapter.relevantRevision);
    assert.equal(context.vehicleId,"75-10");
    assert.equal(context.sourceSlot,"4N");
    assert.equal(context.targetSlot,"5N");
  };
  ctx.renderSdeSkiftebevegelser = ()=>{rerenders+=1;};
  ctx.alert = message=>{alerts.push(String(message));};
  await ctx.handleSdeCanonicalCardAction(
    encodeURIComponent(renderedCard.canonicalCardId),
    "completed",
    encodeURIComponent(JSON.stringify(renderedAdapter.executionDescriptor))
  );
  assert.equal(handlerCalls,1);
  assert.equal(rerenders,0);
  assert.equal(alerts.length,0);

  // A real target replacement is rejected by the same resolver and never reaches the handler.
  const replacedDescriptor = {
    ...renderedAdapter.executionDescriptor,
    targetSlot:"VN",
    executionIdentity:{...renderedAdapter.executionDescriptor.executionIdentity,targetSlot:"VN"}
  };
  await ctx.handleSdeCanonicalCardAction(
    encodeURIComponent(renderedCard.canonicalCardId),
    "completed",
    encodeURIComponent(JSON.stringify(replacedDescriptor))
  );
  assert.equal(handlerCalls,1);
  assert.equal(rerenders,1);
  assert.equal(alerts.length,1);
  assert.ok(alerts[0].includes("semantisk erstattet"));
  assert.ok(alerts[0].includes("Målet er endret"));
  ctx.buildSdeCanonicalProductionReader = originalReaderBuilder;
  ctx.handleSdeShiftMoveAction = originalHandler;
  report.execution={cycles:50,executionKeys:executionKeys.size,relevantRevisions:relevantRevisions.size,globalRevisions:globalRevisions.size,handlerCalls,staleAlertsForUnchanged:0};
  report.supersession={handlerCallsAfterReplacement:handlerCalls,rerendered:rerenders,message:alerts[0]};

  // VN occupied: deterministic ordinary-slot fallback remains a complete recovery chain.
  const fallbackPlacements = [...placements];
  resetState(fallbackPlacements);
  appState.txpUnavailableInfrastructure = {slots:["VN"],tracks:[],washRouteUnavailable:false};
  const fallbackRows = ctx.buildSdePhysicalBlockerGuardMoves([mainMove]);
  assert.equal(fallbackRows.length,3);
  const fallback = getPrimary(fallbackRows);
  assert.notEqual(fallback.release.toSlot,"VN");
  assert.equal(fallback.release.toSlot,"5N");
  assert.equal(fallback.main.toSlot,"4M");
  assert.equal(fallback.recovery.fromSlot,"5N");
  assert.equal(fallback.recovery.toSlot,"4N");
  const fallbackReader = ctx.buildSdeCanonicalProductionReader(readerSnapshot(fallbackRows,fallbackPlacements,1));
  assert.equal(fallbackReader.integrityReport.status,"PASS");
  assert.equal(fallbackReader.cardProjection.actionableCards.length,1);
  assert.equal(fallbackReader.cardProjection.blockedChainCards.length,2);
  const fallbackAdapter = fallbackReader.handlerAdapters[fallbackReader.cardProjection.actionableCards[0].canonicalCardId];
  const fallbackHydrated = ctx.buildSdeCanonicalProductionReader(readerSnapshot(JSON.parse(JSON.stringify(fallbackRows)).reverse(),fallbackPlacements,2));
  const fallbackHydratedAdapter = fallbackHydrated.handlerAdapters[fallbackHydrated.cardProjection.actionableCards[0].canonicalCardId];
  assert.equal(fallbackHydratedAdapter.executionKey,fallbackAdapter.executionKey);
  report.fallback={chain:"4N→5N;5M→4M;5N→4N",integrity:"PASS",executionStable:true};

  // No VN/VS and no ordinary fallback: diagnostic-only, no partial chain.
  const ordinaryCandidates = ctx.getSdeResolutionCandidateSlots("4N","5M").filter(slot=>!["4N","4M","5M","VN","VS"].includes(slot));
  const closedPlacements = [...placements,...ordinaryCandidates.map((slot,index)=>[slot,"CLOSED-"+index])];
  resetState(closedPlacements);
  appState.txpUnavailableInfrastructure = {slots:["VN","VS"],tracks:[],washRouteUnavailable:false};
  const closedRows = ctx.buildSdePhysicalBlockerGuardMoves([mainMove]);
  assert.equal(closedRows.some(row=>row.sdePhysicalResolutionContext==="target_access_temporary_relief"),false);
  const closedReader = ctx.buildSdeCanonicalProductionReader(readerSnapshot(closedRows,closedPlacements,3));
  assert.equal(closedReader.cardProjection.actionableCards.some(card=>card.vehicleId==="75-01"),false);
  assert.equal(closedReader.reservationProjection.reservations.some(item=>item.vehicleId==="75-01"),false);
  assert.equal(closedReader.graphicProjection.activeOverlays.some(item=>item.vehicleId==="75-01"),false);

  // One butt-track VN consumer and one 4M access consumer: exactly one deterministic VN winner.
  function simultaneous(reverse=false){
    const simultaneousPlacements = [...placements,["10N","B-N"],["10S","B-S"]];
    resetState(simultaneousPlacements);
    appState.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};
    const butt = makeMain("10","B-S","8N","w-butt");
    const input = reverse ? [butt,mainMove] : [mainMove,butt];
    const rows = ctx.buildSdePhysicalBlockerGuardMoves(input);
    const vnReleases = rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite" && row.toSlot==="VN");
    assert.equal(vnReleases.length,1);
    const reader = ctx.buildSdeCanonicalProductionReader(readerSnapshot(rows,simultaneousPlacements,reverse?5:4));
    assert.equal(reader.reservationProjection.reservations.filter(item=>item.targetSlot==="VN").length,1);
    assert.equal(reader.reservationProjection.conflicts.some(item=>["VN_RESOURCE_OVERLAP","VS_RESOURCE_OVERLAP","OVERLAPPING_CHAIN_TARGET"].includes(item.classification)),false);
    const chains = rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite");
    assert.ok(chains.length===1 || chains.length===2);
    assert.equal(rows.filter(row=>row.sdePhysicalDependencyRole==="return").length,chains.length);
    const loserMode = chains.length===2 ? "ordinary fallback" : "fail-closed";
    if(loserMode==="fail-closed"){
      const losingMainVehicle = vnReleases[0].vehicle==="B-N" ? "75-01" : "B-S";
      assert.equal(reader.canonicalPlan.activeOutcomes.some(item=>item.vehicleId===losingMainVehicle),false);
    }
    return {winner:vnReleases[0].vehicle+"|"+vnReleases[0].fromSlot,loserMode,rows,reader};
  }
  const simultaneousForward = simultaneous(false);
  const simultaneousReverse = simultaneous(true);
  assert.equal(simultaneousForward.winner,simultaneousReverse.winner);
  assert.equal(simultaneousForward.loserMode,simultaneousReverse.loserMode);
  report.conflict={vnReservations:1,deterministicWinner:simultaneousForward.winner,otherConsumer:simultaneousForward.loserMode,reversedStable:true};

  console.log(JSON.stringify({ok:true,...report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
