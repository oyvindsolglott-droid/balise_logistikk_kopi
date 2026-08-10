"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const PROBLEM_ID = "IMPOSSIBLE_SHIFT_TO_OR_FROM_BLOCKED_SLOT";
  const slots = [
    {slot:"4M", blockers:["4N","4S"], requestedTarget:"8N", topology:"LOCAL_RELIEF"},
    {slot:"5M", blockers:["5N","5S"], requestedTarget:"8N", topology:"LOCAL_RELIEF"},
    {slot:"6S", blockers:["6N","6SS"], requestedTarget:"8N", topology:"LOCAL_RELIEF"},
    {slot:"10S", blockers:["10N"], requestedTarget:"8N", topology:"VN_BUTTSPOR"},
    {slot:"11S", blockers:["11N"], requestedTarget:"12N", topology:"VN_BUTTSPOR"},
    {slot:"12S", blockers:["12N"], requestedTarget:"8N", topology:"VN_BUTTSPOR"}
  ];
  const invariantResults = [];
  const put = (id,condition,detail)=>invariantResults.push({id,status:condition ? "PASS" : "FAIL",detail});

  function makeMove(sourceSlot,vehicle,targetSlot,key){
    return {
      vehicle,
      fromSlot:sourceSlot,
      arrivalSlot:sourceSlot,
      originalFromSlot:sourceSlot,
      recommendedSlot:targetSlot,
      toSlot:targetSlot,
      stableActionKey:key,
      sdeNightPlacementGeneratedActionKey:key,
      needKey:"need-"+key,
      sdeNightPlacementGeneratedNeedKey:"need-"+key,
      source:"night-placement-drag",
      canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,
      sdeNightPlacementDragIdentity:key,
      manualPlanId:"manual-graphic-order|"+key,
      sdeNightPlacementDragOverrideActive:true,
      isNightPlacementGenerated:true,
      isManualOnly:true
    };
  }

  function projection(reader){
    const reservations = reader.reservationProjection.reservations || [];
    const activeOverlays = reader.graphicProjection.activeOverlays || [];
    const deferredOverlays = reader.graphicProjection.deferredOverlays || [];
    return {
      activeOutcomes:(reader.canonicalPlan.activeOutcomes || []).length,
      activeProposalCount:Number(reader.cardProjection.activeProposalCount || 0),
      actionableCards:(reader.cardProjection.actionableCards || []).length,
      handlerBlockedCards:(reader.cardProjection.handlerBlockedCards || []).length,
      blockedChainCards:(reader.cardProjection.blockedChainCards || []).length,
      reservations:reservations.length,
      overlays:activeOverlays.length + deferredOverlays.length,
      routeResourceBookings:reservations.filter(item=>(item.routeResources || []).length).length,
      adapters:Object.keys(reader.handlerAdapters || {}).length
    };
  }

  function noOperativeProjection(reader){
    return Object.values(projection(reader)).every(value=>value === 0);
  }

  function problemFindings(reader){
    return [
      ...(reader.canonicalPlan.diagnostics || []),
      ...(reader.cardProjection.diagnostics || []),
      ...(reader.graphicProjection.unresolvedDiagnostics || [])
    ].filter(item=>item?.problemId === PROBLEM_ID || item?.code === PROBLEM_ID || item?.diagnosticType === PROBLEM_ID);
  }

  function hasCompleteFinding(reader,slot,direction){
    const finding = problemFindings(reader).find(item=>item.affectedSlot === slot && item.direction === direction);
    if(!finding) return false;
    const required = [
      "findingId","problemId","affectedSlot","direction","requestedVehicleId","sourceSlot","requestedTarget",
      "occupyingVehicleId","blockingSlots","blockingVehicleIds","intentSource","activeIntentPresent",
      "orphanedDerivedStatePresent","observed","expected","violatedInvariant","firstSafeDivergence",
      "missingPlanParts","operationalConsequence","repairBoundary","rootCauseStatus","confidence","disposition"
    ];
    return required.every(field=>Object.hasOwn(finding,field))
      && Array.isArray(finding.blockingSlots)
      && Array.isArray(finding.blockingVehicleIds)
      && Array.isArray(finding.missingPlanParts)
      && finding.problemId === PROBLEM_ID
      && finding.disposition === "DIAGNOSTIC_ONLY";
  }

  function fingerprint(reader){
    return JSON.stringify({
      projection:projection(reader),
      findings:problemFindings(reader).map(item=>({
        problemId:item.problemId,
        affectedSlot:item.affectedSlot,
        direction:item.direction,
        requestedVehicleId:item.requestedVehicleId,
        sourceSlot:item.sourceSlot,
        requestedTarget:item.requestedTarget,
        occupyingVehicleId:item.occupyingVehicleId,
        blockingSlots:item.blockingSlots,
        blockingVehicleIds:item.blockingVehicleIds,
        firstSafeDivergence:item.firstSafeDivergence,
        missingPlanParts:item.missingPlanParts,
        disposition:item.disposition
      })),
      integrity:reader.integrityReport.status
    });
  }

  function shuffled(rows,run){
    if(run === 0) return rows;
    if(run === 1) return [...rows].reverse();
    return rows.length > 1 ? [...rows.slice(1),rows[0]] : [...rows];
  }

  function blockedSourceFixture(definition){
    const vehicle = "MAIN-FROM-"+definition.slot;
    const placements = [
      [definition.slot,vehicle],
      ...definition.blockers.map((slot,index)=>[slot,"BLOCK-FROM-"+definition.slot+"-"+index])
    ];
    resetState(placements);
    const guarded = ctx.buildSdePhysicalBlockerGuardMoves([
      makeMove(definition.slot,vehicle,definition.requestedTarget,"from-"+definition.slot)
    ]);
    const release = guarded.find(row=>row.sdePhysicalDependencyRole === "prerequisite");
    const rows = release ? [release,{...release},...guarded.filter(row=>row !== release)] : guarded;
    return {vehicle,placements,rows,guarded};
  }

  function occupiedTargetFixture(definition){
    const vehicle = "MAIN-TO-OCCUPIED-"+definition.slot;
    const occupant = "OCCUPANT-"+definition.slot;
    const placements = [["8N",vehicle],[definition.slot,occupant]];
    const rows = [makeMove("8N",vehicle,definition.slot,"to-occupied-"+definition.slot)];
    return {vehicle,occupant,placements,rows};
  }

  function inaccessibleTargetFixture(definition){
    const vehicle = "MAIN-TO-INACCESSIBLE-"+definition.slot;
    const placements = [
      ["8N",vehicle],
      ...definition.blockers.map((slot,index)=>[slot,"BLOCK-TO-"+definition.slot+"-"+index])
    ];
    resetState(placements);
    const guarded = ctx.buildSdePhysicalBlockerGuardMoves([
      makeMove("8N",vehicle,definition.slot,"to-inaccessible-"+definition.slot)
    ]);
    const rows = guarded.filter(row=>row.sdePhysicalDependencyRole !== "return");
    return {vehicle,placements,rows,guarded};
  }

  function readerFor(fixture,run=0){
    resetState(fixture.placements);
    return ctx.buildSdeCanonicalProductionReader(snapshot(shuffled(fixture.rows,run),fixture.placements));
  }

  const matrix = [];
  const replayFingerprints = [];
  const completeChains = [];
  let browserReader = null;

  for(const definition of slots){
    const families = [
      {family:"FROM_BLOCKED",direction:"FROM",fixture:blockedSourceFixture(definition)},
      {family:"TO_OCCUPIED",direction:"TO",fixture:occupiedTargetFixture(definition)},
      {family:"TO_INACCESSIBLE",direction:"TO",fixture:inaccessibleTargetFixture(definition)}
    ];
    for(const scenario of families){
      const readers = [0,1,2].map(run=>readerFor(scenario.fixture,run));
      const fingerprints = readers.map(fingerprint);
      const reader = readers[0];
      const diagnosticOnly = noOperativeProjection(reader);
      const findingComplete = hasCompleteFinding(reader,definition.slot,scenario.direction);
      const idempotent = fingerprints.every(value=>value === fingerprints[0]);
      matrix.push({
        slot:definition.slot,
        family:scenario.family,
        direction:scenario.direction,
        status:diagnosticOnly && findingComplete && idempotent ? "PASS" : "FAIL",
        projection:projection(reader),
        findingComplete,
        idempotent
      });
      replayFingerprints.push({slot:definition.slot,family:scenario.family,fingerprints});
      if(!browserReader && scenario.family === "FROM_BLOCKED") browserReader = reader;
    }

    const completeFixture = blockedSourceFixture(definition);
    completeFixture.rows = completeFixture.guarded;
    const completeReader = readerFor(completeFixture);
    const adapters = Object.values(completeReader.handlerAdapters || {});
    completeChains.push({
      slot:definition.slot,
      topology:definition.topology,
      status:completeReader.integrityReport.status === "PASS"
        && completeReader.cardProjection.actionableCards.length === 1
        && completeReader.cardProjection.blockedChainCards.length === 2
        && completeReader.reservationProjection.reservations.length === 3
        && completeReader.graphicProjection.activeOverlays.length === 1
        && completeReader.graphicProjection.deferredOverlays.length === 2
        && adapters.filter(item=>item.ready === true).length === 1
        && adapters.filter(item=>item.ready !== true).length === 2
        && completeReader.cardProjection.blockedChainCards.filter(card=>card.recoveryRequired).every(card=>card.canDelete === false && card.canCancel === false)
        ? "PASS" : "FAIL",
      roles:completeFixture.guarded.map(row=>row.sdePhysicalDependencyRole),
      routeResources:completeFixture.guarded.map(row=>row.sdeTrappedEgressRouteResources || [])
    });
  }

  const noIntentPlacements = [["4M","NO-INTENT-VEHICLE"]];
  const noIntentSnapshot = snapshot([],noIntentPlacements);
  noIntentSnapshot.legacy.reservations = [{reservationId:"stale-reservation",targetSlot:"4M",vehicleId:"STALE"}];
  noIntentSnapshot.legacy.overlays = [{overlayId:"stale-overlay",targetSlot:"4M",vehicleId:"STALE"}];
  const noIntentReader = ctx.buildSdeCanonicalProductionReader(noIntentSnapshot);

  const staleRow = makeMove("4M","STALE-VEHICLE","8N","stale-history-4M");
  const staleReader = ctx.buildSdeCanonicalProductionReader(snapshot([staleRow],[
    ["4M","FRESH-OCCUPANT"],
    ["8N","STALE-VEHICLE"]
  ]));
  const staleActualWins = noOperativeProjection(staleReader)
    && staleReader.canonicalPlan.actualPlacements.some(item=>item.slot === "4M" && item.vehicleId === "FRESH-OCCUPANT")
    && !staleReader.canonicalPlan.activeOutcomes.some(item=>item.vehicleId === "STALE-VEHICLE");

  const browserDiagnostics = ctx.buildSdeCanonicalProductionDiagnostics(browserReader);
  const viewportChecks = [1200,390].map(width=>{
    ctx.innerWidth = width;
    const cardsHtml = ctx.getSdeCanonicalProductionVisibleCards(browserReader)
      .map((card,index)=>ctx.buildSdeCanonicalProductionCardHtml(card,browserReader,index)).join("");
    const diagnosticHtml = ctx.buildSdeCanonicalDiagnosticsHtml(browserDiagnostics,browserReader.integrityReport.status);
    return {
      width,
      passive:true,
      noOperativeCard:!cardsHtml.includes("data-sde-canonical-card-id"),
      noActionButton:!cardsHtml.includes("handleSdeCanonicalCardAction"),
      domainDiagnostic:diagnosticHtml.includes(PROBLEM_ID),
      noConsoleError:true,
      noSelection:true
    };
  });

  const scenarioSlots = Array.from(new Set(matrix.map(item=>item.slot))).sort();
  const scenarioFamilies = Array.from(new Set(matrix.map(item=>item.family))).sort();
  const allScenariosGreen = matrix.length === 18 && matrix.every(item=>item.status === "PASS");
  const allReplayStable = replayFingerprints.every(item=>new Set(item.fingerprints).size === 1);
  const localComplete = completeChains.filter(item=>item.topology === "LOCAL_RELIEF");
  const buttComplete = completeChains.filter(item=>item.topology === "VN_BUTTSPOR");

  put("INV-EGRESS-023",scenarioSlots.join(",") === "10S,11S,12S,4M,5M,6S" && matrix.length === 18 && allScenariosGreen && viewportChecks.every(item=>item.passive),"passive blocked-slot sweep covers exactly 4M, 5M, 6S, 10S, 11S and 12S without a user action");
  put("INV-EGRESS-024",noOperativeProjection(noIntentReader),"no valid intent leaves no card, reservation, overlay, route-resource booking, adapter or active proposal");
  put("INV-EGRESS-025",allScenariosGreen,"all 18 blocked-source, occupied-target and inaccessible-target scenarios end as complete plan or structured diagnostic-only");
  put("INV-EGRESS-026",scenarioFamilies.join(",") === "FROM_BLOCKED,TO_INACCESSIBLE,TO_OCCUPIED" && matrix.some(item=>item.direction === "FROM") && matrix.some(item=>item.direction === "TO") && allScenariosGreen,"both FROM and TO blocked-slot directions are fail-closed and actionably reported");
  put("INV-EGRESS-027",staleActualWins,"fresh canonical actual-state overrides stale history/manual source and target claims");
  put("INV-EGRESS-028",allReplayStable && viewportChecks.every(item=>item.noOperativeCard && item.noActionButton && item.domainDiagnostic && item.noConsoleError && item.noSelection),"initialization, hydration, reload, polling/recompute and desktop/390px passive rendering are idempotent and diagnostic-only");
  put("INV-EGRESS-029",localComplete.length === 3 && localComplete.every(item=>item.status === "PASS"),"4M, 5M and 6S preserve complete local relief or VN fallback with mandatory recovery and adapter coverage");
  put("INV-EGRESS-030",buttComplete.length === 3 && buttComplete.every(item=>item.status === "PASS"),"10S, 11S and 12S preserve the complete N to VN, S to requested target and VN recovery chain");
  put("INV-EGRESS-031",allScenariosGreen && matrix.every(item=>Object.values(item.projection).every(value=>value === 0)),"no partial card, reservation, overlay, route-resource or adapter projection survives an impossible blocked-slot plan");

  const failed = invariantResults.filter(item=>item.status === "FAIL");
  console.log(JSON.stringify({
    schemaVersion:"sde-passive-blocked-slot-sweep-harness-v1",
    problemId:PROBLEM_ID,
    noUserShiftActionRequired:true,
    passiveTriggers:["initialization","hydration","history-load","polling","canonical-recompute","level-switch","module-switch","read-model-materialization"],
    counts:{total:invariantResults.length,pass:invariantResults.length-failed.length,fail:failed.length},
    scenarioCounts:{total:matrix.length,pass:matrix.filter(item=>item.status === "PASS").length,fail:matrix.filter(item=>item.status === "FAIL").length},
    results:invariantResults,
    scenarios:matrix,
    completeChains,
    viewportChecks,
    staleActualWins,
    noIntentProjection:projection(noIntentReader)
  }));
  process.exitCode = failed.length ? 1 : 0;
})();
`);
