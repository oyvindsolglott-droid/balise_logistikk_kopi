(function installSdeUserRerouteBrowserHarness(global){
  "use strict";

  const FIXTURE_URL = "/tests/sde/fixtures/user-reroute-vn.json";
  let fixturesPromise = null;
  let currentFixture = "";

  function fixtures(){
    if(!fixturesPromise){
      fixturesPromise = fetch(FIXTURE_URL, {method:"GET"}).then(response=>{
        if(!response.ok) throw new Error(`Fixture GET feilet: ${response.status}`);
        return response.json();
      }).then(payload=>payload.fixtures);
    }
    return fixturesPromise;
  }

  function makeMain(config){
    const fromSlot = String(config.sourceSlot || "").trim();
    const targetSlot = String(config.requestedTarget || "").trim();
    const vehicle = String(config.vehicle || "").trim();
    const requestId = String(config.requestId || "").trim();
    const actionKey = `night-placement-drag|${vehicle}|${fromSlot}|${targetSlot}|${requestId}`;
    return {
      vehicle,
      fromSlot,
      arrivalSlot:fromSlot,
      originalFromSlot:fromSlot,
      recommendedSlot:targetSlot,
      toSlot:targetSlot,
      stableActionKey:actionKey,
      sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:`night-placement-drag-need|${actionKey}`,
      sdeNightPlacementGeneratedNeedKey:`night-placement-drag-need|${actionKey}`,
      source:"night-placement-drag",
      canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,
      sdeNightPlacementDragIdentity:requestId,
      manualPlanId:`manual-graphic-order|${requestId}`,
      sdeNightPlacementDragOverrideActive:true,
      isNightPlacementGenerated:true,
      isManualOnly:true
    };
  }

  function makeRecovery(config){
    const chainId = "browser-fixture-b-vn-recovery";
    return {
      vehicle:config.vehicle,
      fromSlot:config.sourceSlot,
      arrivalSlot:config.sourceSlot,
      originalFromSlot:config.sourceSlot,
      recommendedSlot:config.currentTarget,
      toSlot:config.currentTarget,
      stableActionKey:`browser-fixture-b-recovery|${config.vehicle}|${config.sourceSlot}|${config.currentTarget}`,
      source:"browser-fixture-mandatory-recovery",
      canonicalProducer:"vn_recovery",
      canonicalPurpose:"vn-recovery",
      isManualOnly:true,
      isSdePhysicalBlockerReturnMove:true,
      isSdePhysicalVnRecoveryMove:true,
      sdeVnRecoveryRequired:true,
      sdeVnRecoveryObligationId:chainId,
      sdeVnEntryToken:"browser-fixture-b-entry",
      sdeVnRecoveryAuthoritative:true,
      sdeVnRecoveryStatus:"recovery_required",
      sdePhysicalChainId:chainId,
      sdePhysicalChainStep:3,
      sdePhysicalChainStepCount:3,
      sdePhysicalDependsOn:[],
      sdePhysicalDependencyRole:"return",
      sdePhysicalResolutionContext:"butt_track_temporary_vn_relief",
      sdePhysicalVnReliefChain:{
        context:"butt_track_temporary_vn_relief",
        chainId,
        blockerVehicle:config.vehicle,
        blockerFromSlot:config.currentTarget,
        holdingSlot:"VN",
        returnTargetSlot:config.currentTarget,
        recoveryTargetSlot:config.currentTarget,
        returnActionKey:`browser-fixture-b-return|${config.vehicle}|${config.currentTarget}`,
        recoveryActionKey:`browser-fixture-b-recovery|${config.vehicle}|${config.currentTarget}`,
        sequenceStepCount:3
      }
    };
  }

  function resetLocalState(placements){
    state.grunnoppstilling = Object.fromEntries(placements);
    state.grunnoppstillingRep = {};
    state.sdeMoveActions = {};
    state.sdeActiveMoveOutcomes = {};
    state.sdeNightPlacementManualOverrides = {};
    state.sdePhysicalReleaseReplans = {};
    state.sdeCanonicalRetargetIntents = {};
    state.sdeVnRecoveryObligations = {};
    state.planSkifteRows = [];
    state.txpUnavailableSlots = [];
    state.txpUnavailableInfrastructure = {slots:[],tracks:[],washRouteUnavailable:false};
    sdeNightPlacementBlockedMoveRequest = null;
    sdeCanonicalRetargetSelection = null;
    sdeProductionReaderFallbackError = null;
    sdeShiftViewMode = SDE_SHIFT_VIEW_MODE_CARDS;
  }

  async function install(name){
    const all = await fixtures();
    const fixture = all[String(name || "A").toUpperCase()];
    if(!fixture) throw new Error(`Ukjent reroute-fixture: ${name}`);
    let placements = fixture.placements.map(item=>[...item]);
    let moves = [];
    resetLocalState(placements);

    if(fixture.main) moves = [makeMain(fixture.main)];
    if(name === "B") moves = [makeRecovery(fixture.recovery)];
    if(name === "C"){
      const occupied = new Set(placements.map(item=>item[0]));
      getSdeResolutionCandidateSlots(fixture.main.sourceSlot.replace("S","N"), fixture.main.sourceSlot)
        .filter(slot=>slot !== "VN" && slot !== "VS" && slot !== fixture.main.requestedTarget)
        .forEach((slot,index)=>{
          if(!occupied.has(slot)) placements.push([slot,`BROWSER-CLOSED-${index}`]);
        });
      resetLocalState(placements);
      moves = [makeMain(fixture.main)];
    }
    if(name === "E") moves = [makeMain(fixture.affected), makeMain(fixture.independent)];

    global.__sdeUserRerouteHarnessData = {
      score:"100%",
      moves,
      baseMoveCount:moves.length,
      unresolved:[],
      unresolvedCount:0,
      filteredPastDepartureNeeds:[],
      flexibleUnknownParking:[],
      solvedArrivals:moves.length,
      totalArrivals:moves.length,
      securedDepartures:moves.length,
      totalDepartures:moves.length
    };
    global.getSdeTomorrowJsonReadinessForScore = ()=>({ready:true,reason:"READY"});
    global.getSdeShiftShowcaseData = ()=>global.__sdeUserRerouteHarnessData;
    currentFixture = String(name || "A").toUpperCase();
    renderSdeSkiftebevegelser();
    return summary();
  }

  function summary(){
    const reader = buildSdeCanonicalProductionReader();
    const cards = getSdeCanonicalProductionProjectedCards(reader);
    return {
      fixture:currentFixture,
      planRevision:reader.planRevision,
      cards:cards.map(card=>({
        id:card.canonicalCardId,
        status:card.status,
        vehicle:card.vehicleId,
        source:card.sourceSlot,
        target:card.targetSlot,
        canRetarget:card.canRetarget,
        canCancel:card.canCancel,
        canDelete:card.canDelete,
        recoveryRequired:card.recoveryRequired
      })),
      reservations:reader.reservationProjection.reservations.map(item=>({id:item.reservationId,target:item.targetSlot,vehicle:item.vehicleId,status:item.status})),
      overlays:[...reader.graphicProjection.activeOverlays,...reader.graphicProjection.deferredOverlays].map(item=>({id:item.overlayId,target:item.targetSlot,vehicle:item.vehicleId,status:item.status})),
      adapters:Object.values(reader.handlerAdapters || {}).map(item=>({executionKey:item.executionKey,target:item.outcome?.targetSlot,canRetarget:item.canRetarget,ready:item.ready})),
      diagnostics:buildSdeCanonicalProductionDiagnostics(reader).map(item=>item.diagnosticType),
      integrity:reader.integrityReport.status,
      retargetIntents:JSON.parse(JSON.stringify(state.sdeCanonicalRetargetIntents || {}))
    };
  }

  global.__sdeUserRerouteBrowserHarness = {install,summary};
})(window);
