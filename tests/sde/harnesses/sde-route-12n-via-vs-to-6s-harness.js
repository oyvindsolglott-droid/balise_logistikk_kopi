"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseHarness = fs.readFileSync(
  path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"),
  "utf8",
);
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../fixtures/route-12n-via-vs-to-6s-v1.json"),
  "utf8",
));

eval(prefix + String.raw`
(()=>{
  const fixture=${JSON.stringify(fixture)};
  const NativeDate=vm.runInContext("Date",ctx);
  ctx.Date=class SdeFixedRouteFixtureDate extends NativeDate{
    constructor(...args){ super(...(args.length ? args : ["2026-08-15T18:56:00.000Z"])); }
    static now(){ return NativeDate.parse("2026-08-15T18:56:00.000Z"); }
  };
  const placements=fixture.initialActualPlacement;
  const expected=fixture.expected;
  const intent={
    vehicle:fixture.userIntent.vehicle,
    fromSlot:fixture.userIntent.source,
    arrivalSlot:fixture.userIntent.source,
    originalFromSlot:fixture.userIntent.source,
    recommendedSlot:fixture.userIntent.requestedTarget,
    toSlot:fixture.userIntent.requestedTarget,
    stableActionKey:"night-placement-drag|70-11|12N|6S|SDE-ROUTE-12N-VIA-VS-TO-6S-V1",
    sdeNightPlacementGeneratedActionKey:"night-placement-drag|70-11|12N|6S|SDE-ROUTE-12N-VIA-VS-TO-6S-V1",
    needKey:"night-placement-drag-need|SDE-ROUTE-12N-VIA-VS-TO-6S-V1",
    sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|SDE-ROUTE-12N-VIA-VS-TO-6S-V1",
    source:"night-placement-drag",
    canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,
    sdeNightPlacementDragIdentity:fixture.userIntent.intentId,
    manualPlanId:"manual-graphic-order|SDE-ROUTE-12N-VIA-VS-TO-6S-V1",
    sdeNightPlacementDragOverrideActive:true,
    isNightPlacementGenerated:true,
    isManualOnly:true
  };
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const byRole=(rows,role)=>(rows||[]).find(row=>row?.sdePhysicalDependencyRole===role)||null;
  const routeOf=row=>row?.sdeCanonicalRoute||{
    routeSegments:row?.routeSegments||[],
    viaSlots:row?.viaSlots||[],
    reversalPoint:row?.reversalPoint||"",
    approachSide:row?.approachSide||"",
    routeResourceClaims:row?.sdeCanonicalRouteResourceClaims||[]
  };
  const completedRecord=(row,time,revision)=>({
    action:"completed",time,actualStateRevision:revision,
    vehicle:row?.vehicle,fromSlot:row?.fromSlot,toSlot:row?.toSlot,
    snapshot:{...row}
  });
  const stableReader=value=>JSON.stringify({
    cards:allCards(value).map(card=>[card.vehicleId,card.sourceSlot,card.targetSlot,card.status,card.route?.viaSlots||card.viaSlots||[]]),
    outcomes:(value?.canonicalPlan?.candidateOutcomes||[]).map(outcome=>[outcome.actionKey,outcome.status,outcome.targetSlot]),
    reservations:(value?.reservationProjection?.reservations||[]).map(item=>[item.activeOutcomeId,item.status,item.routeResourceClaims||[]]),
    overlays:[...(value?.graphicProjection?.activeOverlays||[]),...(value?.graphicProjection?.deferredOverlays||[])].map(item=>[item.activeOutcomeId,item.status])
  });
  const invariant=(id,contract,pass,detail)=>({id,contract,status:pass?"PASS":"FAIL",detail:JSON.stringify(detail)});

  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);
  const initialActual=JSON.stringify(appState.grunnoppstilling||{});
  const directState=ctx.getSdeCompleteTrappedEgressBlockState(
    intent,ctx.getSdeHardPhysicalBlockStateForMove(intent)
  );
  const sourceEnds=ctx.getSdeTrappedEgressMainSourceEnds("12N","6S");
  const directPlan=ctx.buildSdeCompleteTrappedEgressRows(intent,directState,[intent]);
  const directRows=directPlan?.rows||[];
  const dragAccepted=ctx.applySdeNightPlacementDragOverride(
    {vehicle:fixture.userIntent.vehicle,slot:fixture.userIntent.source,fromSlot:fixture.userIntent.source,sourceKind:"standing"},
    fixture.userIntent.requestedTarget
  );
  const message=vm.runInContext("sdeNightPlacementDropMessage",ctx);
  const rows=ctx.buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false})
    .filter(row=>row?.sdePhysicalChainId||row?.sdeTrappedEgressDiagnosticOnly);
  const chainRows=rows.filter(row=>row?.sdePhysicalChainId&&!row?.sdeTrappedEgressDiagnosticOnly);
  const release=byRole(chainRows,"prerequisite");
  const main=byRole(chainRows,"dependent");
  const recovery=byRole(chainRows,"return");
  const reader=ctx.buildSdeCanonicalProductionReader();
  const cards=allCards(reader);
  const initialActualAfter=JSON.stringify(appState.grunnoppstilling||{});
  const releaseRoute=routeOf(release);
  const mainRoute=routeOf(main);
  const recoveryRoute=routeOf(recovery);
  const routeClaims=chainRows.map(row=>routeOf(row).routeResourceClaims||[]);
  const visibleVehicles=new Set(chainRows.map(row=>ctx.sanitizeVehicleValue(row?.vehicle)).filter(Boolean));
  const diagnostics=[
    ...(reader?.canonicalPlan?.diagnostics||[]),
    ...(reader?.cardProjection?.diagnostics||[])
  ];
  const projectionCounts={
    cards:cards.length,
    reservations:reader?.reservationProjection?.reservations?.length||0,
    overlays:(reader?.graphicProjection?.activeOverlays?.length||0)+(reader?.graphicProjection?.deferredOverlays?.length||0),
    adapters:Object.keys(reader?.handlerAdapters||{}).length
  };

  const releaseKey=release ? ctx.getSdeMoveActionKey(release) : "";
  const mainKey=main ? ctx.getSdeMoveActionKey(main) : "";
  const recoveryKey=recovery ? ctx.getSdeMoveActionKey(recovery) : "";
  const releaseActions=releaseKey?{[releaseKey]:completedRecord(release,"2026-08-15T18:00:00.000Z","route-fixture-r2")} : {};
  const afterReleasePlacements=[["12N","70-11"],["VN","75-76"],["6SS","74-36"]];
  resetState(afterReleasePlacements,{sdeMoveActions:releaseActions});
  const afterReleaseReader=ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,afterReleasePlacements,releaseActions));
  const afterReleaseCards=allCards(afterReleaseReader);
  const afterReleaseAgain=ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,afterReleasePlacements,releaseActions));

  const mainActions=mainKey?{...releaseActions,[mainKey]:completedRecord(main,"2026-08-15T18:05:00.000Z","route-fixture-r3")} : releaseActions;
  const afterMainPlacements=[["6S","70-11"],["VN","75-76"],["6SS","74-36"]];
  resetState(afterMainPlacements,{sdeMoveActions:mainActions});
  const afterMainReader=ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,afterMainPlacements,mainActions));
  const afterMainCards=allCards(afterMainReader);
  const afterMainAgain=ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,afterMainPlacements,mainActions));

  const recoveryActions=recoveryKey?{...mainActions,[recoveryKey]:completedRecord(recovery,"2026-08-15T18:10:00.000Z","route-fixture-r4")} : mainActions;
  const afterRecoveryPlacements=[["6S","70-11"],["6N","75-76"],["6SS","74-36"]];
  resetState(afterRecoveryPlacements,{sdeMoveActions:recoveryActions});
  const afterRecoveryReader=ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,afterRecoveryPlacements,recoveryActions));
  const afterRecoveryCards=allCards(afterRecoveryReader);

  const results=[
    invariant("INV-MULTILEG-001","EXACT_12N_TO_6S_FIXTURE_IS_BINDING",fixture.fixtureId==="SDE-ROUTE-12N-VIA-VS-TO-6S-V1"&&placements.some(([s,v])=>s==="12N"&&v==="70-11")&&placements.some(([s,v])=>s==="6N"&&v==="75-76"),fixture),
    invariant("INV-MULTILEG-002","TARGET_6S_ACCEPTED_BY_POINTER_INTENT",dragAccepted===true&&message?.type==="info",{dragAccepted,message}),
    invariant("INV-MULTILEG-003","EXACT_FIXTURE_PRODUCES_THREE_CARDS",chainRows.length===3&&cards.length===3,{chainRows:chainRows.map(row=>[row.vehicle,row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]),cards:cards.map(card=>card.status)}),
    invariant("INV-MULTILEG-004","THREE_CARD_SEQUENCE_RELEASE_MAIN_RECOVERY",chainRows.map(row=>row.sdePhysicalDependencyRole).join(",")==="prerequisite,dependent,return",chainRows.map(row=>row.sdePhysicalDependencyRole)),
    invariant("INV-MULTILEG-005","CARD_1_75_76_6N_TO_VN_VIA_VS",Boolean(release&&release.vehicle==="75-76"&&release.fromSlot==="6N"&&release.toSlot==="VN"&&releaseRoute.viaSlots?.includes("VS")),{release,route:releaseRoute}),
    invariant("INV-MULTILEG-006","CARD_2_70_11_12N_TO_6S_VIA_VS_WITH_REVERSAL",Boolean(main&&main.vehicle==="70-11"&&main.fromSlot==="12N"&&main.toSlot==="6S"&&mainRoute.viaSlots?.includes("VS")&&mainRoute.reversalPoint==="VS"),{main,route:mainRoute}),
    invariant("INV-MULTILEG-007","CARD_3_75_76_VN_TO_6N_VIA_VS",Boolean(recovery&&recovery.vehicle==="75-76"&&recovery.fromSlot==="VN"&&recovery.toSlot==="6N"&&recoveryRoute.viaSlots?.includes("VS")),{recovery,route:recoveryRoute}),
    invariant("INV-MULTILEG-008","MULTILEG_MAIN_ROUTE_SUPPORTED",Array.isArray(mainRoute.routeSegments)&&mainRoute.routeSegments.length===2,{route:mainRoute}),
    invariant("INV-MULTILEG-009","VS_CAN_BE_ROUTE_WAYPOINT_AND_REVERSAL_POINT",mainRoute.viaSlots?.includes("VS")&&mainRoute.reversalPoint==="VS",mainRoute),
    invariant("INV-MULTILEG-010","VN_AND_VS_HAVE_DISTINCT_TOPOLOGY_ROLES",release?.toSlot==="VN"&&releaseRoute.targetSlot==="VN"&&releaseRoute.viaSlots?.includes("VS")&&!releaseRoute.viaSlots?.includes("VN")&&main?.toSlot!=="VS"&&recovery?.fromSlot==="VN"&&recoveryRoute.sourceSlot==="VN"&&recoveryRoute.viaSlots?.includes("VS"),{release:release&&[release.fromSlot,release.toSlot],main:main&&[main.fromSlot,main.toSlot],recovery:recovery&&[recovery.fromSlot,recovery.toSlot],routes:[releaseRoute,recoveryRoute]}),
    invariant("INV-MULTILEG-011","ONE_SAFE_APPROACH_IS_SUFFICIENT",mainRoute.approachSide==="NORTH"&&directState?.accessAssessment?.targetAccessBlocked===true,{approachSide:mainRoute.approachSide,targetOptions:directState?.accessAssessment?.targetAccessOptions}),
    invariant("INV-MULTILEG-012","OCCUPIED_6SS_DOES_NOT_BLOCK_NORTH_APPROACH_TO_6S",chainRows.length===3&&initialActualAfter.includes('"6SS":"74-36"'),{actual:initialActualAfter,rows:chainRows.length}),
    invariant("INV-MULTILEG-013","MAIN_SOURCE_USES_PHYSICAL_NORTH_EGRESS",Array.isArray(sourceEnds)&&sourceEnds.length===1&&sourceEnds[0]==="north",{sourceEnds}),
    invariant("INV-MULTILEG-014","NO_EXTRA_BLOCKER_MOVE",visibleVehicles.size===2&&visibleVehicles.has("70-11")&&visibleVehicles.has("75-76")&&!visibleVehicles.has("74-36"),[...visibleVehicles]),
    invariant("INV-MULTILEG-015","DEPENDENCY_SEQUENCED_STEPS_MAY_REUSE_ROUTE_RESOURCE",chainRows.every(row=>routeOf(row).viaSlots?.includes("VS"))&&!reader?.reservationProjection?.conflicts?.some(item=>String(item.classification||"").includes("VS_RESOURCE_OVERLAP")),{claims:routeClaims,conflicts:reader?.reservationProjection?.conflicts}),
    invariant("INV-MULTILEG-016","DEFERRED_ROUTE_RESOURCE_IS_NOT_ACTIVE_CONFLICT",routeClaims[0]?.some(item=>item.resource==="VS"&&item.state==="ACTIVE_ROUTE_RESOURCE")&&routeClaims.slice(1).every(claims=>claims.some(item=>item.resource==="VS"&&item.state==="DEFERRED_ROUTE_RESOURCE")),routeClaims),
    invariant("INV-MULTILEG-017","NO_PRESTAGE_INCOMPLETE_OR_DIAGNOSTIC_ONLY",message?.type==="info"&&!/forhåndsstages komplett|diagnostic-only/i.test(message?.text||"")&&!chainRows.some(row=>row.sdeTrappedEgressDiagnosticOnly)&&!diagnostics.some(item=>/prestage|diagnostic.only/i.test(String(item.code||item.diagnosticType||""))),{message,diagnostics:diagnostics.map(item=>item.code||item.diagnosticType)}),
    invariant("INV-MULTILEG-018","NO_PARTIAL_OPERATIVE_PROJECTION",projectionCounts.cards===3&&projectionCounts.reservations===3&&projectionCounts.overlays===3&&projectionCounts.adapters===3,projectionCounts),
    invariant("INV-MULTILEG-019","ACTUAL_PLACEMENT_ONLY_CHANGES_AFTER_AUTHORIZED_COMPLETION",initialActual===initialActualAfter,{before:initialActual,after:initialActualAfter}),
    invariant("INV-MULTILEG-020","CARD_2_AND_CARD_3_SURVIVE_CARD_1",afterReleaseCards.length===2&&afterReleaseCards.some(card=>card.vehicleId==="70-11"&&card.status==="actionable")&&afterReleaseCards.some(card=>card.vehicleId==="75-76"&&card.status==="blocked_chain_step"),afterReleaseCards.map(card=>[card.vehicleId,card.status,card.sourceSlot,card.targetSlot])),
    invariant("INV-MULTILEG-021","COMPLETED_PREDECESSOR_PROMOTES_MAIN_AND_ROUTE_RESOURCE",afterReleaseCards.some(card=>card.vehicleId==="70-11"&&card.status==="actionable"&&(card.routeResourceClaims||[]).some(item=>item.resource==="VS"&&item.state==="ACTIVE_ROUTE_RESOURCE")),afterReleaseCards),
    invariant("INV-MULTILEG-022","MAIN_COMPLETION_PROMOTES_RECOVERY",afterMainCards.length===1&&afterMainCards[0]?.vehicleId==="75-76"&&afterMainCards[0]?.status==="actionable",afterMainCards),
    invariant("INV-MULTILEG-023","RECOVERY_COMPLETION_CLOSES_CHAIN",afterRecoveryCards.length===0&&afterRecoveryReader?.canonicalPlan?.activeOutcomes?.length===0,{cards:afterRecoveryCards.map(card=>({vehicle:card.vehicleId,status:card.status,source:card.sourceSlot,target:card.targetSlot,explanation:card.explanation})),activeOutcomes:afterRecoveryReader?.canonicalPlan?.activeOutcomes?.length,diagnostics:afterRecoveryReader?.cardProjection?.diagnostics}),
    invariant("INV-MULTILEG-024","RELOAD_AND_POLLING_PRESERVE_ROUTE_AND_DEPENDENCIES",stableReader(afterReleaseReader)===stableReader(afterReleaseAgain)&&stableReader(afterMainReader)===stableReader(afterMainAgain),{afterRelease:stableReader(afterReleaseReader),afterMain:stableReader(afterMainReader)}),
    invariant("INV-MULTILEG-025","MAIN_INTENT_PRESERVED_WITHOUT_1N_FALLBACK",main?.fromSlot==="12N"&&main?.toSlot==="6S"&&!chainRows.some(row=>row.toSlot==="1N"||row.recommendedSlot==="1N"),chainRows.map(row=>[row.fromSlot,row.toSlot])),
    invariant("INV-MULTILEG-026","NO_UAVKLART_BLOCKED_UNRESOLVED_OR_PARTIAL_CHAIN",chainRows.length===3&&!rows.some(row=>/UAVKLART|BLOCKED_UNRESOLVED/.test(String(row.status||row.vehicle||row.toSlot||"")))&&reader?.integrityReport?.status==="PASS",{rows:rows.map(row=>[row.vehicle,row.status,row.sdeTrappedEgressDiagnosticOnly]),integrity:reader?.integrityReport?.status,directRows:directRows.map(row=>[row.vehicle,row.sdePhysicalDependencyRole,row.sdeTrappedEgressDiagnosticOnly])})
  ];
  const output={
    schemaVersion:"sde-route-12n-via-vs-to-6s-harness-v1",
    fixtureId:fixture.fixtureId,
    firstDivergence:{
      sourceEnds,
      directPlanAvailable:Boolean(directPlan&&directRows.length===3),
      blockState:{hardBlocked:directState?.hardBlocked,blockers:(directState?.blockers||[]).map(item=>[item.slot,item.vehicle,item.accessEnd])}
    },
    evidence:{
      message,
      rows:chainRows.map(row=>({vehicle:row.vehicle,source:row.fromSlot,target:row.toSlot,role:row.sdePhysicalDependencyRole,route:routeOf(row)})),
      cards:cards.map(card=>({vehicle:card.vehicleId,source:card.sourceSlot,target:card.targetSlot,status:card.status,route:card.route,claims:card.routeResourceClaims})),
      projectionCounts,
      conflicts:(reader?.reservationProjection?.conflicts||[]).map(item=>item.classification),
      integrity:reader?.integrityReport?.status,
      actualUnchanged:initialActual===initialActualAfter
    },
    results,
    pass:results.every(item=>item.status==="PASS")
  };
  process.stdout.write(JSON.stringify(output)+"\n");
  process.exitCode=output.pass?0:1;
})()
`);
