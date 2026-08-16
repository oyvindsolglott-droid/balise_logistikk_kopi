"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseHarness = fs.readFileSync(
  path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"),
  "utf8",
);
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../fixtures/false-already-at-target-12n-11n-v1.json"),
  "utf8",
));

eval(prefix + String.raw`
(()=>{
  const fixture=${JSON.stringify(fixture)};
  const invariant=(id,contract,pass,detail)=>({id,contract,status:pass?"PASS":"FAIL",detail:JSON.stringify(detail)});
  const hasSnapshotApi=typeof ctx.buildSdeNightPlacementCanonicalActualStateSnapshot==="function";
  const hasPayloadApi=typeof ctx.buildSdeNightPlacementDragIntentPayload==="function";
  const hasReconcileApi=typeof ctx.reconcileSdeNightPlacementDragIntent==="function";

  const staleCompletedPlanRow={
    time:"",vehicle:"70-11",fromSpor:"12N",toSpor:"11N",crew:"",tilRep:"",operationType:"",utfort:"Utført"
  };
  resetState(fixture.canonicalActualPlacement,{
    sharedSporplanDraftAppliedRevision:1601,
    planSkifteRows:[staleCompletedPlanRow]
  });
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);

  const renderedOverview=ctx.buildSdeNightPlacementOverviewData({moves:[],limitedPlanningMode:false});
  const renderedRevision=String(renderedOverview.actualStateRevision||ctx.getSdeNightPlacementActualStateRevision());
  const payloadInput={
    sdeNightPlacementVehicleId:fixture.userIntent.vehicleId,
    sdeNightPlacementVehicle:fixture.userIntent.vehicleId,
    sdeNightPlacementRenderedSourceSlot:fixture.userIntent.renderedSourceSlot,
    sdeNightPlacementCurrentSlot:fixture.userIntent.requestedTarget,
    sdeNightPlacementFromSlot:fixture.userIntent.renderedSourceSlot,
    sdeNightPlacementActualRevision:renderedRevision,
    sdeNightPlacementSourceKind:"standing"
  };
  const boundPayload=hasPayloadApi
    ? ctx.buildSdeNightPlacementDragIntentPayload({dataset:payloadInput},fixture.userIntent.intentId)
    : {
        vehicle:fixture.userIntent.vehicleId,
        slot:fixture.userIntent.requestedTarget,
        fromSlot:fixture.userIntent.renderedSourceSlot,
        vehicleId:fixture.userIntent.vehicleId,
        renderedSourceSlot:fixture.userIntent.renderedSourceSlot,
        actualRevision:renderedRevision,
        intentId:fixture.userIntent.intentId
      };
  const dropPayload={...boundPayload,requestedTarget:fixture.userIntent.requestedTarget};
  const initialAssessment=ctx.buildSdeNightPlacementDropAssessment(dropPayload,fixture.userIntent.requestedTarget,{moves:[],limitedPlanningMode:false});
  const initialDerivedPlannerSlot=ctx.getSdePhysicalSlotForVehicle("70-11");
  const accepted=ctx.applySdeNightPlacementDragOverride(dropPayload,fixture.userIntent.requestedTarget);
  const initialMessage=vm.runInContext("sdeNightPlacementDropMessage",ctx);
  const directReader=ctx.buildSdeCanonicalProductionReader();
  const directCards=[
    ...(directReader?.cardProjection?.actionableCards||[]),
    ...(directReader?.cardProjection?.blockedChainCards||[])
  ];
  const exactCard=directCards.find(card=>card.vehicleId==="70-11"&&card.sourceSlot==="12N"&&card.targetSlot==="11N")||null;

  resetState([["12N","70-11"]],{sharedSporplanDraftAppliedRevision:1602});
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null;",ctx);
  const currentRevision=String(ctx.getSdeNightPlacementActualStateRevision());
  const staleIntent={vehicleId:"70-11",vehicle:"70-11",renderedSourceSlot:"11N",slot:"11N",fromSlot:"11N",requestedTarget:"10N",actualRevision:"stale-revision",intentId:"ORIGINAL-STALE-INTENT",sourceKind:"standing"};
  const reconciled=hasReconcileApi ? ctx.reconcileSdeNightPlacementDragIntent(staleIntent,"10N") : null;
  const staleAssessment=ctx.buildSdeNightPlacementDropAssessment(staleIntent,"10N",{moves:[],limitedPlanningMode:false});
  const revisionOnlyReconciled=hasReconcileApi ? ctx.reconcileSdeNightPlacementDragIntent({...staleIntent,renderedSourceSlot:"12N",slot:"12N",fromSlot:"12N"},"10N") : null;

  resetState([["11N","70-11"]],{sharedSporplanDraftAppliedRevision:16021});
  const targetActualRevision=String(ctx.getSdeNightPlacementActualStateRevision());
  const exactNoOp=ctx.isSdeNightPlacementNoOpMove("70-11","11N","11N",targetActualRevision);
  const sourceMismatchNoOp=ctx.isSdeNightPlacementNoOpMove("70-11","12N","11N",targetActualRevision);
  const revisionMismatchNoOp=ctx.isSdeNightPlacementNoOpMove("70-11","11N","11N","stale-revision");
  const mismatchedTargetAssessment=ctx.buildSdeNightPlacementDropAssessment({vehicleId:"70-11",vehicle:"70-11",renderedSourceSlot:"12N",slot:"12N",fromSlot:"12N",requestedTarget:"11N",actualRevision:targetActualRevision,intentId:"MISMATCHED-TARGET-INTENT"},"11N",{moves:[],limitedPlanningMode:false});

  resetState([["12N","70-11"]],{sharedSporplanDraftAppliedRevision:16022});
  const reservationOnly={vehicle:"70-11",fromSlot:"12N",toSlot:"11N",targetSlot:"11N",sourceKind:"reservation"};
  appState.sdeNightPlacementManualOverrides={reservationOnly};
  const reservationSnapshot=hasSnapshotApi ? ctx.buildSdeNightPlacementCanonicalActualStateSnapshot() : null;
  const reservationLocation=(hasSnapshotApi ? ctx.getSdeCanonicalActualLocationForVehicle("70-11",reservationSnapshot)?.slot : ctx.getSdePhysicalSlotForVehicle("70-11"))||"";

  resetState([["12N","70-11"]],{sharedSporplanDraftAppliedRevision:16023});
  const historicalOnly={vehicle:"70-11",fromSlot:"12N",toSlot:"11N",targetSlot:"11N",action:"completed",sourceKind:"historical-card"};
  appState.sdeMoveActions={historical:{action:"completed",vehicle:"70-11",fromSlot:"12N",toSlot:"11N",snapshot:historicalOnly}};
  const canonicalSnapshot=hasSnapshotApi ? ctx.buildSdeNightPlacementCanonicalActualStateSnapshot() : null;
  const canonicalLocation=(hasSnapshotApi ? ctx.getSdeCanonicalActualLocationForVehicle("70-11",canonicalSnapshot)?.slot : ctx.getSdePhysicalSlotForVehicle("70-11"))||"";

  resetState([["11N","70-11"]],{sharedSporplanDraftAppliedRevision:1605});
  if(hasSnapshotApi) ctx.rebuildSdeNightPlacementCanonicalActualIndex();
  const pollApplied=ctx.applySharedSporplanDraftToActiveState({grunnoppstilling:{"12N":"70-11"},grunnoppstillingRep:{},revision:1606,updatedAt:"2026-08-16T00:00:00.000Z"});
  const pollingIndex=hasSnapshotApi ? vm.runInContext("sdeNightPlacementCanonicalActualIndex",ctx) : null;
  const pollingLocation=pollingIndex?.placementsByVehicle?.[ctx.normalizeVehicleToken("70-11")]?.slot||"";

  resetState([["12N","70-11"],["11S","70-11"]],{sharedSporplanDraftAppliedRevision:1603});
  const duplicateSnapshot=hasSnapshotApi ? ctx.buildSdeNightPlacementCanonicalActualStateSnapshot() : null;
  const duplicateAssessment=ctx.buildSdeNightPlacementDropAssessment({vehicleId:"70-11",vehicle:"70-11",renderedSourceSlot:"12N",slot:"12N",fromSlot:"12N",requestedTarget:"11N",actualRevision:String(duplicateSnapshot?.actualRevision||""),intentId:"DUPLICATE-INTENT"},"11N",{moves:[],limitedPlanningMode:false});

  resetState([["12N","70-11"]],{sharedSporplanDraftAppliedRevision:1604});
  const htmlOverview=ctx.buildSdeNightPlacementOverviewData({moves:[],limitedPlanningMode:false});
  const renderedHtml=ctx.renderSdeNightPlacementOverview({moves:[],limitedPlanningMode:false},{overview:htmlOverview,readerMode:"canonical"});

  resetState([["12N","70-11"],["6N","75-76"],["6SS","74-36"]]);
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null;",ctx);
  const oldRevision=String(ctx.getSdeNightPlacementActualStateRevision());
  const oldAccepted=ctx.applySdeNightPlacementDragOverride({vehicleId:"70-11",vehicle:"70-11",renderedSourceSlot:"12N",slot:"12N",fromSlot:"12N",requestedTarget:"6S",actualRevision:oldRevision,intentId:"SDE-ROUTE-12N-VIA-VS-TO-6S-V1-INTENT",sourceKind:"standing"},"6S");
  const oldRows=ctx.buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false}).filter(row=>row?.sdePhysicalChainId&&!row?.sdeTrappedEgressDiagnosticOnly);

  const results=[
    invariant("INV-ACTUAL-DRAG-001","RENDERED_SOURCE_AND_PLANNER_SOURCE_USE_SAME_REVISION",hasPayloadApi&&boundPayload.vehicleId==="70-11"&&boundPayload.renderedSourceSlot==="12N"&&boundPayload.actualRevision===renderedRevision&&initialAssessment.fromSlot==="12N"&&pollApplied===true&&pollingLocation==="12N",{boundPayload,renderedRevision,assessmentSource:initialAssessment.fromSlot,pollingLocation}),
    invariant("INV-ACTUAL-DRAG-002","ALREADY_AT_TARGET_REQUIRES_CANONICAL_SOURCE_EQUALS_TARGET",initialAssessment.noOp!==true&&initialAssessment.fromSlot==="12N"&&fixture.userIntent.requestedTarget==="11N"&&mismatchedTargetAssessment.noOp!==true&&mismatchedTargetAssessment.stateDesync===true&&exactNoOp===true&&sourceMismatchNoOp===false&&revisionMismatchNoOp===false,{initialAssessment,mismatchedTargetAssessment,exactNoOp,sourceMismatchNoOp,revisionMismatchNoOp}),
    invariant("INV-ACTUAL-DRAG-003","RESERVATION_IS_NOT_ACTUAL_PLACEMENT",reservationLocation==="12N"&&reservationOnly.targetSlot==="11N",{reservationLocation,reservationOnly}),
    invariant("INV-ACTUAL-DRAG-004","PLANNED_TARGET_IS_NOT_ACTUAL_PLACEMENT",canonicalLocation==="12N"&&historicalOnly.targetSlot==="11N",{canonicalLocation,historicalOnly}),
    invariant("INV-ACTUAL-DRAG-005","STALE_VEHICLE_LOCATION_TRIGGERS_AUTOMATIC_RECONCILIATION",Boolean(reconciled?.ok&&reconciled.sourceStateMismatch&&reconciled.reconciliationPasses===2&&reconciled.effectiveSourceSlot==="12N"&&revisionOnlyReconciled?.ok&&revisionOnlyReconciled.revisionMismatch&&revisionOnlyReconciled.reconciliationPasses===2&&staleAssessment.fromSlot==="12N"&&staleAssessment.plannerInvoked===true),{reconciled,revisionOnlyReconciled,staleAssessment,currentRevision}),
    invariant("INV-ACTUAL-DRAG-006","SOURCE_STATE_MISMATCH_DOES_NOT_DESTROY_ORIGINAL_INTENT",Boolean(reconciled?.intentId==="ORIGINAL-STALE-INTENT"&&staleAssessment.intentId==="ORIGINAL-STALE-INTENT"&&staleAssessment.toSlot==="10N"),{reconciled,staleAssessment}),
    invariant("INV-ACTUAL-DRAG-007","ONE_VEHICLE_HAS_AT_MOST_ONE_CANONICAL_ACTUAL_SLOT",Boolean(duplicateSnapshot&&duplicateSnapshot.valid===false&&duplicateSnapshot.duplicateVehicleTokens?.includes(ctx.normalizeVehicleToken("70-11"))&&duplicateAssessment.ok===false&&duplicateAssessment.stateDesync===true),{duplicateSnapshot,duplicateAssessment}),
    invariant("INV-ACTUAL-DRAG-008","FALSE_ALREADY_AT_TARGET_MUST_NOT_BLOCK_PLANNER",accepted===true&&initialAssessment.plannerInvoked===true&&!/står allerede/i.test(initialMessage?.text||""),{accepted,initialAssessment,initialMessage}),
    invariant("INV-ACTUAL-DRAG-009","EXACT_12N_TO_11N_FIXTURE_REACHES_PLANNER",fixture.fixtureId==="SDE-FALSE-ALREADY-AT-TARGET-12N-11N-V1"&&accepted===true&&Boolean(exactCard)&&exactCard?.canonicalIdentity?.intentId===fixture.userIntent.intentId&&/data-sde-night-placement-rendered-source-slot="12N"/.test(renderedHtml)&&renderedHtml.includes('data-sde-night-placement-actual-revision='),{fixtureId:fixture.fixtureId,accepted,exactCard,renderedHtmlHasBinding:/data-sde-night-placement-rendered-source-slot="12N"/.test(renderedHtml)&&renderedHtml.includes('data-sde-night-placement-actual-revision=')}),
    invariant("INV-ACTUAL-DRAG-010","EXACT_12N_TO_6S_FIXTURE_REMAINS_GREEN",oldAccepted===true&&oldRows.length===3&&oldRows.map(row=>row.sdePhysicalDependencyRole).join(",")==="prerequisite,dependent,return",oldRows.map(row=>[row.vehicle,row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole]))
  ];
  const output={
    schemaVersion:"sde-false-already-at-target-12n-11n-harness-v1",
    fixtureId:fixture.fixtureId,
    firstDivergence:{renderedCanonicalSlot:renderedOverview.slots?.["12N"]?.vehicle?"12N":"",derivedPlannerSlotBeforeFix:initialDerivedPlannerSlot,assessmentNoOp:initialAssessment.noOp===true,message:initialAssessment.message},
    evidence:{boundPayload,initialAssessment,accepted,initialMessage,exactCard,reconciled,duplicateAssessment,oldRows:oldRows.map(row=>[row.vehicle,row.fromSlot,row.toSlot,row.sdePhysicalDependencyRole])},
    results,
    pass:results.every(item=>item.status==="PASS")
  };
  process.stdout.write(JSON.stringify(output)+"\n");
  process.exitCode=output.pass?0:1;
})()
`);
