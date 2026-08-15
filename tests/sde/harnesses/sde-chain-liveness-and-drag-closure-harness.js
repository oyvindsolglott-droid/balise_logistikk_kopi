"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseHarness = fs.readFileSync(
  path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"),
  "utf8",
);
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../fixtures/chain-liveness-and-drag-closure-20260815.json"),
  "utf8",
));

eval(prefix + String.raw`
(()=>{
  const historical=${JSON.stringify(fixture.orphanDependency)};
  const drag=${JSON.stringify(fixture.drag)};
  resetState(historical.placements,{sdeMoveActions:historical.actions});
  const actualBefore=JSON.stringify(appState.grunnoppstilling||{});
  const directReconciliation=ctx.reconcileSdeCanonicalDependencyRows(
    [historical.row],snapshot([historical.row],historical.placements,historical.actions)
  );
  const directReconciliationKeys=directReconciliation.rows.map(row=>ctx.getSdeMoveActionKey(row)).filter(Boolean);
  const reader=ctx.buildSdeCanonicalProductionReader(snapshot(
    [historical.row],historical.placements,historical.actions
  ));
  const historicalActualAfter=JSON.stringify(appState.grunnoppstilling||{});
  const liveCards=[
    ...(reader.cardProjection?.actionableCards||[]),
    ...(reader.cardProjection?.blockedChainCards||[]),
    ...(reader.cardProjection?.handlerBlockedCards||[])
  ];
  const dependencyCards=reader.cardProjection?.blockedChainCards||[];
  const candidateActionKeys=new Set((reader.canonicalPlan?.candidateOutcomes||[]).map(item=>String(item?.actionKey||"").trim()).filter(Boolean));
  const completedKeys=new Set(Object.entries(historical.actions||{}).filter(([,record])=>record?.action==="completed").map(([key])=>key));
  const orphanCards=dependencyCards.filter(card=>(card.blockedBy||card.dependencyIds||[]).some(key=>!candidateActionKeys.has(key)&&!completedKeys.has(key)));
  const rebuilt=(reader.canonicalPlan?.candidateOutcomes||[]).find(outcome=>
    String(outcome?.actionKey||"").trim()===historical.missingDependency
    && ctx.sanitizeVehicleValue(outcome?.vehicleId)===historical.expectedRebuiltPredecessor.vehicle
    && ctx.normalizeSlot(outcome?.canonicalSourceSlot)===historical.expectedRebuiltPredecessor.source
    && ctx.normalizeSlot(outcome?.targetSlot)===historical.expectedRebuiltPredecessor.target
  )||null;
  const actionable=reader.cardProjection?.actionableCards||[];
  const recovery=dependencyCards.find(card=>card.vehicleId===historical.row.vehicle)||null;
  const mainAdapter=actionable[0] ? reader.handlerAdapters?.[actionable[0].canonicalCardId] : null;
  const recoveryAdapter=recovery ? reader.handlerAdapters?.[recovery.canonicalCardId] : null;
  const projectionCounts={
    cards:liveCards.length,
    reservations:reader.reservationProjection?.reservations?.length||0,
    overlays:(reader.graphicProjection?.activeOverlays?.length||0)+(reader.graphicProjection?.deferredOverlays?.length||0),
    adapters:Object.keys(reader.handlerAdapters||{}).length
  };

  const completedMainActions={
    ...historical.actions,
    [historical.missingDependency]:{
      action:"completed",
      time:"2026-08-14T20:05:00.000Z",
      actualStateRevision:"fixture-actual-r2",
      snapshot:{
        vehicle:"74-53",fromSlot:"11S",arrivalSlot:"11S",recommendedSlot:"10S",toSlot:"10S",
        stableActionKey:historical.missingDependency,
        sdePhysicalChainId:"fixture-chain-75-76",sdePhysicalIntentId:"fixture-intent-75-76",
        sdePhysicalObligationId:"fixture-obligation-75-76",sdePhysicalPlanRevision:"fixture-plan-r1",
        sdePhysicalStepId:"fixture-chain-75-76|main",sdePhysicalChainStep:2,sdePhysicalChainStepCount:3,
        sdePhysicalDependsOn:["night-placement-release|75-76|10N|6N"],sdePhysicalDependencyRole:"dependent",
        sdeTrappedEgressRouteResources:["track-access|10|north","fixture-chain|75-76"]
      }
    }
  };
  const completedPlacements=[["6N","75-76"],["10S","74-53"]];
  resetState(completedPlacements,{sdeMoveActions:completedMainActions});
  const completedActualBefore=JSON.stringify(appState.grunnoppstilling||{});
  const completedReader=ctx.buildSdeCanonicalProductionReader(snapshot(
    [historical.row],completedPlacements,completedMainActions
  ));
  const completedActualAfter=JSON.stringify(appState.grunnoppstilling||{});
  const promotedRecovery=(completedReader.cardProjection?.actionableCards||[]).find(card=>card.vehicleId==="75-76")||null;
  const promotedAdapter=promotedRecovery ? completedReader.handlerAdapters?.[promotedRecovery.canonicalCardId] : null;

  const irreparableRow={...historical.row};
  delete irreparableRow.sdePhysicalAccessReliefChain;
  irreparableRow.sdePhysicalDependsOn=["fixture-missing-without-rebuild-metadata"];
  irreparableRow.stableActionKey="fixture-irreparable-recovery";
  resetState(historical.placements,{sdeMoveActions:{}});
  const irreparableReader=ctx.buildSdeCanonicalProductionReader(snapshot([irreparableRow],historical.placements,{}));
  const irreparableLiveCards=[
    ...(irreparableReader.cardProjection?.actionableCards||[]),
    ...(irreparableReader.cardProjection?.blockedChainCards||[]),
    ...(irreparableReader.cardProjection?.handlerBlockedCards||[])
  ];
  const irreparableDiagnostics=[
    ...(irreparableReader.canonicalPlan?.diagnostics||[]),
    ...(irreparableReader.cardProjection?.diagnostics||[])
  ];
  const directOrphanPlan=ctx.buildSdeCanonicalPlan({
    actualSources:snapshot([irreparableRow],historical.placements,{}).actualSources,
    candidateRows:[irreparableRow],
    completedActionKeys:[]
  });
  const directOrphanProjection=ctx.buildSdeCanonicalCardProjection(directOrphanPlan,{actionRecords:{}});

  resetState(historical.placements,{sdeMoveActions:historical.actions});
  const readerAgain=ctx.buildSdeCanonicalProductionReader(snapshot([historical.row],historical.placements,historical.actions));
  const stableReadback=value=>JSON.stringify({
    outcomes:(value.canonicalPlan?.candidateOutcomes||[]).map(item=>[item.actionKey,item.status,item.chainId,item.targetSlot]),
    cards:[...(value.cardProjection?.actionableCards||[]),...(value.cardProjection?.blockedChainCards||[])].map(item=>[item.activeOutcomeId,item.status,item.blockedBy||[]]),
    reservations:(value.reservationProjection?.reservations||[]).map(item=>item.reservationId),
    overlays:[...(value.graphicProjection?.activeOverlays||[]),...(value.graphicProjection?.deferredOverlays||[])].map(item=>item.overlayId),
    integrity:value.integrityReport?.status
  });
  const operativeOutcomes=(reader.canonicalPlan?.candidateOutcomes||[]).filter(item=>item.status!=="completed");
  const outcomeChainIds=new Set((reader.canonicalPlan?.candidateOutcomes||[]).map(item=>item.chainId).filter(Boolean));
  const operativePlanRevisions=new Set(operativeOutcomes.map(item=>String(item.raw?.sdePhysicalPlanRevision||"").trim()).filter(Boolean));
  const uniqueProjectionIds=items=>new Set(items.map(item=>item.activeOutcomeId||item.canonicalCardId||item.reservationId||item.overlayId)).size===items.length;
  resetState(drag.placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);
  const originalAccessPlan=ctx.buildSdeTemporaryAccessReliefChainPlan;
  const dragReliefAttempts=[];
  ctx.buildSdeTemporaryAccessReliefChainPlan=(blockedRow,blockState,freeingMove,chainId,context={})=>{
    const target=ctx.normalizeSlot(freeingMove?.recommendedSlot||freeingMove?.toSlot);
    dragReliefAttempts.push(target);
    if(target===drag.firstRejectedRelief) return null;
    return originalAccessPlan(blockedRow,blockState,freeingMove,chainId,context);
  };
  const dragActualBefore=JSON.stringify(appState.grunnoppstilling||{});
  const dragAccepted=ctx.applySdeNightPlacementDragOverride(
    {vehicle:"DRAG-SAFE-MAIN",slot:drag.source,fromSlot:drag.source,sourceKind:"standing"},
    drag.requestedTarget
  );
  const dragReader=ctx.buildSdeCanonicalProductionReader();
  const dragRows=ctx.buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false}).filter(row=>row?.sdePhysicalChainId);
  const dragCards=[...(dragReader.cardProjection?.actionableCards||[]),...(dragReader.cardProjection?.blockedChainCards||[])];
  const dragAttempts=[...dragReliefAttempts];
  const dragMessage=vm.runInContext("sdeNightPlacementDropMessage",ctx);
  const invariant=(id,contract,pass,detail)=>({id,contract,status:pass?"PASS":"FAIL",detail:JSON.stringify(detail)});
  const results=[
    invariant("INV-CHAIN-LIVENESS-001","DEPENDENCY_BLOCKED_CARD_MUST_HAVE_RESOLVABLE_PREDECESSOR",orphanCards.length===0,{orphanCards:orphanCards.map(card=>card.activeOutcomeId),dependencies:dependencyCards.map(card=>card.blockedBy)}),
    invariant("INV-CHAIN-LIVENESS-002","MISSING_PREDECESSOR_MUST_TRIGGER_AUTOMATIC_RECONCILIATION",Boolean(rebuilt),{rebuilt:rebuilt&&{vehicle:rebuilt.vehicleId,source:rebuilt.canonicalSourceSlot,target:rebuilt.targetSlot}}),
    invariant("INV-CHAIN-LIVENESS-003","ORPHAN_DEPENDENCY_CARD_MUST_NOT_RENDER_AS_LIVE_OPERATIONAL_CARD",!liveCards.some(card=>orphanCards.includes(card)),{liveCards:liveCards.map(card=>[card.vehicleId,card.status,card.activeOutcomeId])}),
    invariant("INV-CHAIN-LIVENESS-004","RECONCILED_PREDECESSOR_IS_ACTIONABLE_AND_RECOVERY_REMAINS_BLOCKED",Boolean(rebuilt&&actionable.some(card=>card.activeOutcomeId===rebuilt.candidateOutcomeId)&&recovery),{actionable:actionable.map(card=>[card.vehicleId,card.sourceSlot,card.targetSlot]),recovery:recovery&&[recovery.vehicleId,recovery.sourceSlot,recovery.targetSlot]}),
    invariant("INV-CHAIN-LIVENESS-005","TECHNICAL_INTEGRITY_FAIL_CANNOT_COEXIST_WITH_LIVE_OPERATIONAL_CARD",reader.integrityReport?.status!=="FAIL"||liveCards.length===0,{integrity:reader.integrityReport?.status,liveCards:liveCards.length}),
    invariant("INV-CHAIN-LIVENESS-006","RECONCILIATION_DOES_NOT_MUTATE_ACTUAL_PLACEMENT",actualBefore===JSON.stringify(Object.fromEntries(historical.placements.map(([slot,vehicle])=>[slot,vehicle]))),{actualBefore}),
    invariant("INV-CHAIN-LIVENESS-007","COMPLETED_PREDECESSOR_PROMOTES_NEXT_CARD",Boolean(promotedRecovery&&promotedAdapter?.ready===true&&promotedAdapter?.canComplete===true),{promoted:promotedRecovery&&[promotedRecovery.sourceSlot,promotedRecovery.targetSlot],ready:promotedAdapter?.ready}),
    invariant("INV-CHAIN-LIVENESS-008","COMPLETED_PREFIX_REMAINS_TERMINAL_AND_NON_OPERATIVE",(completedReader.canonicalPlan?.candidateOutcomes||[]).filter(item=>item.status==="completed").length===2&&completedReader.cardProjection.blockedChainCards.length===0,{statuses:(completedReader.canonicalPlan?.candidateOutcomes||[]).map(item=>item.status)}),
    invariant("INV-CHAIN-LIVENESS-009","CARD_2_AND_CARD_3_SURVIVE_COMPLETION_OF_CARD_1",liveCards.length===2&&actionable.length===1&&dependencyCards.length===1,projectionCounts),
    invariant("INV-CHAIN-LIVENESS-010","MANDATORY_RECOVERY_SURVIVES_UNTIL_CHAIN_COMPLETION",Boolean(recovery&&recovery.recoveryRequired===true&&recovery.canDelete===false&&recovery.canCancel===false),recovery),
    invariant("INV-CHAIN-LIVENESS-011","ACTIONABLE_CARD_EXPOSES_UTFORT_AND_ANNULLERT",Boolean(mainAdapter?.ready===true&&mainAdapter?.canComplete===true&&mainAdapter?.canCancel===true),{ready:mainAdapter?.ready,complete:mainAdapter?.canComplete,cancel:mainAdapter?.canCancel}),
    invariant("INV-CHAIN-LIVENESS-012","DEPENDENCY_CARD_HAS_DISABLED_EXECUTION_WITH_VALID_BLOCK_REASON",Boolean(recoveryAdapter&&recoveryAdapter.ready===false&&recoveryAdapter.canComplete===false&&(recovery.blockedBy||[]).length===1),{ready:recoveryAdapter?.ready,canComplete:recoveryAdapter?.canComplete,blockedBy:recovery?.blockedBy}),
    invariant("INV-CHAIN-LIVENESS-013","CHAIN_IDENTITY_IS_SINGLE_AND_STABLE",outcomeChainIds.size===1&&outcomeChainIds.has("fixture-chain-75-76"),[...outcomeChainIds]),
    invariant("INV-CHAIN-LIVENESS-014","PLAN_REVISION_IS_PRESERVED_ACROSS_REBUILT_SUFFIX",operativePlanRevisions.size===1&&operativePlanRevisions.has("fixture-plan-r1"),[...operativePlanRevisions]),
    invariant("INV-CHAIN-LIVENESS-015","OPERATIVE_OUTCOMES_HAVE_ROUTE_RESOURCES",operativeOutcomes.every(item=>Array.isArray(item.routeResources)&&item.routeResources.length>0),operativeOutcomes.map(item=>[item.actionKey,item.routeResources])),
    invariant("INV-CHAIN-LIVENESS-016","NO_DUPLICATE_CARDS_RESERVATIONS_OVERLAYS_OR_ADAPTERS",uniqueProjectionIds(liveCards)&&uniqueProjectionIds(reader.reservationProjection.reservations||[])&&uniqueProjectionIds([...(reader.graphicProjection.activeOverlays||[]),...(reader.graphicProjection.deferredOverlays||[])])&&projectionCounts.adapters===liveCards.length,projectionCounts),
    invariant("INV-CHAIN-LIVENESS-017","EXACTLY_ONE_CHAIN_STEP_IS_ACTIONABLE",actionable.length===1&&reader.canonicalPlan.activeOutcomes.length===1,{actionable:actionable.length,activeOutcomes:reader.canonicalPlan.activeOutcomes.length}),
    invariant("INV-CHAIN-LIVENESS-018","RECONCILIATION_METADATA_RECORDS_REBUILT_PREDECESSOR",reader.canonicalPlan.metadata?.chainLivenessReconstructedCount===1,reader.canonicalPlan.metadata),
    invariant("INV-CHAIN-LIVENESS-019","COMPLETION_PROOF_IS_BOUND_TO_FRESH_ACTUAL_STATE",reader.canonicalPlan.metadata?.chainLivenessCompletionProofCount===1,{proofs:reader.canonicalPlan.metadata?.chainLivenessCompletionProofCount}),
    invariant("INV-CHAIN-LIVENESS-020","RELOAD_AND_RECOMPUTE_PRESERVE_CANONICAL_IDENTITY",stableReadback(reader)===stableReadback(readerAgain),{first:stableReadback(reader),second:stableReadback(readerAgain)}),
    invariant("INV-CHAIN-LIVENESS-021","IRREPARABLE_ORPHAN_IS_FAIL_CLOSED",irreparableLiveCards.length===0,{liveCards:irreparableLiveCards.length}),
    invariant("INV-CHAIN-LIVENESS-022","IRREPARABLE_ORPHAN_EMITS_UNDERSTANDABLE_DIAGNOSTIC",irreparableDiagnostics.some(item=>item.code==="orphan_dependency_reconciliation_exhausted"),irreparableDiagnostics.map(item=>item.code||item.diagnosticType)),
    invariant("INV-CHAIN-LIVENESS-023","CARD_PROJECTION_INDEPENDENTLY_REJECTS_ORPHAN_DEPENDENCY",directOrphanProjection.blockedChainCards.length===0&&directOrphanProjection.diagnostics.some(item=>item.diagnosticType==="orphan_dependency"),{blocked:directOrphanProjection.blockedChainCards.length,diagnostics:directOrphanProjection.diagnostics.map(item=>item.diagnosticType)}),
    invariant("INV-CHAIN-LIVENESS-024","ACTUAL_PLACEMENT_CHANGES_ONLY_AFTER_AUTHORIZED_COMPLETION",completedActualBefore===completedActualAfter&&actualBefore!==completedActualBefore,{before:actualBefore,afterCompleted:completedActualBefore}),
    invariant("INV-CHAIN-LIVENESS-025","ONE_FAILED_PRESTAGE_CANDIDATE_DOES_NOT_END_DRAG_SEARCH",dragAccepted===true&&dragMessage?.type==="info"&&dragAttempts.length>=2&&dragAttempts[0]===drag.firstRejectedRelief&&dragAttempts[1]!==drag.firstRejectedRelief&&dragRows.length===3&&dragCards.length===3&&dragReader.integrityReport?.status==="PASS"&&dragActualBefore===JSON.stringify(appState.grunnoppstilling||{}),{accepted:dragAccepted,message:dragMessage?.text,attempts:dragAttempts,rows:dragRows.length,cards:dragCards.length,integrity:dragReader.integrityReport?.status}),
    invariant("INV-CHAIN-LIVENESS-026","RECONCILIATION_CANNOT_MATERIALIZE_DUPLICATE_CHAIN_STEPS",directReconciliationKeys.length===new Set(directReconciliationKeys).size,{actionKeys:directReconciliationKeys})
  ];
  const output={
    schemaVersion:"sde-chain-liveness-and-drag-closure-harness-v1",
    fixture:historical.name,
    results,
    evidence:{
      cards:liveCards.map(card=>({vehicle:card.vehicleId,status:card.status,source:card.sourceSlot,target:card.targetSlot,blockedBy:card.blockedBy||[]})),
      candidates:(reader.canonicalPlan?.candidateOutcomes||[]).map(outcome=>({vehicle:outcome.vehicleId,source:outcome.canonicalSourceSlot,target:outcome.targetSlot,actionKey:outcome.actionKey,status:outcome.status})),
      integrity:reader.integrityReport?.status,
      conflicts:(reader.integrityReport?.conflicts||[]).map(item=>item.classification),
      actualUnchanged:actualBefore===historicalActualAfter
    },
    pass:results.every(item=>item.status==="PASS")
  };
  process.stdout.write(JSON.stringify(output)+"\n");
  process.exitCode=output.pass?0:1;
})()
`);
