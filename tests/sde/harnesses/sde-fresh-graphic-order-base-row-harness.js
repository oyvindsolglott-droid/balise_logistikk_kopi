"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const placements = [["5N","74-12"],["5M","74-10"],["5S","74-11"]];
  const legacyActionKey = "legacy-night-placement|74-10|5M|10S";
  const legacyBaseRow = {
    vehicle:"74-10",
    fromSlot:"5M",
    arrivalSlot:"5M",
    recommendedSlot:"10S",
    toSlot:"10S",
    stableActionKey:legacyActionKey,
    needKey:"legacy-need|74-10|5M|10S",
    source:"historical base candidate"
  };
  const previousCompletedIdentity = "completed-previous-identity|74-10|5M|10S";
  const historicalActions = {
    [previousCompletedIdentity]:{
      action:"completed",
      completedAt:"2026-07-17T08:16:00.000Z",
      vehicle:"74-10",
      fromSlot:"5M",
      toSlot:"10S",
      snapshot:ctx.getSdeMoveActionSnapshot(legacyBaseRow)
    }
  };
  const requestId = "fresh-browser-drag-5m-6s";
  const freshActionKey = ["night-placement-drag","74-10","5M","6S",requestId].join("|");
  const override = {
    id:requestId,
    vehicle:"74-10",
    originalFromSlot:"5M",
    fromSlot:"5M",
    currentFromSlot:"5M",
    toSlot:"6S",
    createdAt:"2026-07-17T10:10:00.000Z",
    updatedAt:"2026-07-17T10:10:00.000Z",
    source:"night-placement-drag",
    stableActionKey:freshActionKey,
    needKey:"night-placement-drag-need|"+freshActionKey,
    moveKey:freshActionKey,
    hasMatchedSdeMove:false,
    isManualOnly:true,
    hardPhysicalBlocked:true,
    canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,
    dragRequestId:requestId,
    sdeNightPlacementDragIdentity:requestId,
    manualPlanId:"manual-graphic-order|"+requestId
  };

  resetState(placements,{sdeMoveActions:historicalActions});
  appState.sdeNightPlacementManualOverrides={[override.id]:override};
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  assert.equal(
    ctx.getSdeNightPlacementMatchedMoveForOverride(override,[legacyBaseRow]),
    null,
    "a fresh canonical graphic order must not bind to the only historical row merely by vehicle and source"
  );
  assert.equal(
    ctx.getSdeEffectiveMoveForCard(legacyBaseRow,[legacyBaseRow]).stableActionKey,
    legacyActionKey,
    "the historical base row must retain its own completed identity"
  );

  const generated = ctx.buildSdeNightPlacementGeneratedMoves([legacyBaseRow]);
  assert.equal(generated.length,1,"the fresh graphical order must materialize despite an older row from the same source");
  assert.equal(ctx.getSdeMoveActionKey(generated[0]),freshActionKey);
  assert.equal(generated[0].fromSlot,"5M");
  assert.equal(generated[0].toSlot,"6S");

  const productionCandidates = ctx.buildSdeShiftCardMoveCandidates({moves:[legacyBaseRow]});
  assert.equal(
    productionCandidates.length,
    3,
    "the superseded base proposal must not coexist with the fresh graphical order"
  );
  const freshProductionRows = productionCandidates.filter(row=>
    row.sdePhysicalChainId
    && (
      ctx.getSdeMoveActionKey(row) === freshActionKey
      || row.sdePhysicalParentActionKey === freshActionKey
      || row.sdePhysicalDependencyRole === "prerequisite"
      || row.sdePhysicalDependencyRole === "return"
    )
  );
  assert.equal(
    freshProductionRows.length,
    3,
    "the complete card-candidate pipeline must preserve the fresh release/main/return chain"
  );

  const chainRows = ctx.buildSdePhysicalBlockerGuardMoves(generated);
  assert.equal(chainRows.length,3,"74-10 5M→6S must receive release, main and return steps");
  assert.equal(chainRows.map(row=>row.sdePhysicalDependencyRole).join(","),"prerequisite,dependent,return");
  const reader = ctx.buildSdeCanonicalProductionReader(snapshot(chainRows,placements,historicalActions));
  assert.equal(reader.integrityReport.status,"PASS");
  assert.equal(reader.cardProjection.actionableCards.length,1);
  assert.equal(reader.cardProjection.blockedChainCards.length,2);
  assert.equal(reader.graphicProjection.activeOverlays.length,1);
  assert.equal(reader.graphicProjection.deferredOverlays.length,2);

  // Reproduce the visible browser history as well: an earlier 74-10 order into
  // 5M was completed through a temporary 74-11 release, while all temporary
  // 74-12 targets for a previous 5M→6S attempt were later rejected.
  const makeOrder = (vehicle,fromSlot,toSlot,id) => {
    const actionKey=["night-placement-drag",vehicle,fromSlot,toSlot,id].join("|");
    return {
      vehicle,fromSlot,arrivalSlot:fromSlot,originalFromSlot:fromSlot,
      recommendedSlot:toSlot,toSlot,stableActionKey:actionKey,
      sdeNightPlacementGeneratedActionKey:actionKey,
      needKey:"night-placement-drag-need|"+actionKey,
      sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
      source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",sdeCanonicalGraphicDragOrder:true,
      sdeNightPlacementDragIdentity:id,manualPlanId:"manual-graphic-order|"+id,
      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true
    };
  };
  const preCompletionPlacements=[["5N","74-12"],["10S","74-10"],["5S","74-11"]];
  resetState(preCompletionPlacements);
  const priorOrder=makeOrder("74-10","10S","5M","completed-browser-order");
  const priorRows=ctx.buildSdePhysicalBlockerGuardMoves([priorOrder]);
  assert.equal(priorRows.length,3,"the visible completed browser order must have three steps");
  const priorActions=Object.fromEntries(priorRows.map((row,index)=>[
    ctx.getSdeMoveActionKey(row),
    {
      action:"completed",completedAt:"2026-07-17T09:3"+index+":00.000Z",
      vehicle:row.vehicle,fromSlot:row.fromSlot,toSlot:row.toSlot,
      snapshot:ctx.getSdeMoveActionSnapshot(row)
    }
  ]));

  resetState(placements,{sdeMoveActions:priorActions});
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const rejectedAttempt=makeOrder("74-10","5M","6S","rejected-browser-order");
  const rejectedRows=ctx.buildSdePhysicalBlockerGuardMoves([rejectedAttempt]);
  const rejectedRelease=rejectedRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  assert.ok(rejectedRelease,"the earlier browser attempt must expose its temporary release");
  const rejectedContextKey=ctx.getSdeCanonicalRetargetContextKey(rejectedRelease);
  const rejectedContextSignature=ctx.getSdeCanonicalRetargetContextSignature(rejectedRelease);
  appState.sdeCanonicalRetargetIntents={
    [rejectedContextKey]:{
      schemaVersion:"sde-canonical-retarget-intent-v1",
      contextKey:rejectedContextKey,
      contextSignature:rejectedContextSignature,
      role:"release",
      vehicleId:rejectedRelease.vehicle,
      sourceSlot:rejectedRelease.fromSlot,
      originalTarget:rejectedRelease.toSlot,
      explicitTarget:"",
      rejectedTargets:[...rejectedRelease.sdePhysicalReleaseCandidateOrder],
      revision:"rejected-browser-order-all-temporary-targets"
    }
  };
  appState.sdeNightPlacementManualOverrides={[override.id]:override};
  const browserHistoryCandidates=ctx.buildSdeShiftCardMoveCandidates({moves:[legacyBaseRow]});
  const browserHistoryMain=browserHistoryCandidates.find(row=>ctx.getSdeMoveActionKey(row)===freshActionKey);
  assert.ok(browserHistoryMain,"the fresh 74-10 order must survive the completed/rejected browser history");
  const browserHistoryChain=browserHistoryCandidates.filter(row=>row.sdePhysicalChainId===browserHistoryMain.sdePhysicalChainId);
  assert.equal(browserHistoryChain.length,3,"the browser-history scenario must still produce a complete chain");

  resetState(placements);
  const firstScopedOrder=makeOrder("74-10","5M","6S","scoped-order-1");
  const secondScopedOrder=makeOrder("74-10","5M","6S","scoped-order-2");
  const firstScopedRelease=ctx.buildSdePhysicalBlockerGuardMoves([firstScopedOrder])
    .find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const secondScopedRelease=ctx.buildSdePhysicalBlockerGuardMoves([secondScopedOrder])
    .find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  assert.ok(firstScopedRelease&&secondScopedRelease);
  assert.notEqual(
    ctx.getSdeCanonicalRetargetContextKey(firstScopedRelease),
    ctx.getSdeCanonicalRetargetContextKey(secondScopedRelease),
    "temporary-target rejections must be scoped to one unique graphical order"
  );

  const staleOutcomeKey=ctx.getSdeMoveObligationStepKey(firstScopedRelease);
  const staleNeedKey=ctx.getSdeMoveNeedKey(firstScopedRelease);
  const staleFailClosed=ctx.buildSdeCancellationFailClosedRow(
    firstScopedRelease,staleNeedKey,1,staleOutcomeKey
  );
  const staleReleaseActionKey=ctx.getSdeMoveActionKey(firstScopedRelease);
  appState.sdeMoveActions={
    [staleReleaseActionKey]:{
      action:"cancelled",
      vehicle:firstScopedRelease.vehicle,
      fromSlot:firstScopedRelease.fromSlot,
      toSlot:firstScopedRelease.toSlot,
      outcomeKey:staleOutcomeKey,
      needKey:staleNeedKey,
      roundNumber:1,
      replacementWasFailClosed:true,
      activeOutcomeId:ctx.getSdeMoveActionKey(staleFailClosed),
      snapshot:ctx.getSdeMoveActionSnapshot(firstScopedRelease)
    }
  };
  ctx.setSdeActiveOutcomeAuthority(staleOutcomeKey,staleFailClosed,{
    activeOutcomeId:ctx.getSdeMoveActionKey(staleFailClosed),
    source:"stale-browser-failclosed"
  });
  const authorityOverride={...override,id:"authority-fresh-order",dragRequestId:"authority-fresh-order",
    sdeNightPlacementDragIdentity:"authority-fresh-order",manualPlanId:"manual-graphic-order|authority-fresh-order",
    stableActionKey:"night-placement-drag|74-10|5M|6S|authority-fresh-order",
    moveKey:"night-placement-drag|74-10|5M|6S|authority-fresh-order",
    needKey:"night-placement-drag-need|night-placement-drag|74-10|5M|6S|authority-fresh-order"};
  appState.sdeNightPlacementManualOverrides={[authorityOverride.id]:authorityOverride};
  const authorityStaged=ctx.stageSdeCanonicalGraphicDragOrder(authorityOverride);
  assert.equal(authorityStaged?.chain?.ok,true,authorityStaged?.chain?.reason||"fresh order must replace stale fail-closed authorities atomically");
  assert.equal(authorityStaged?.chain?.outcomes?.all?.length,3);

  resetState(placements);
  const sameOrderOverride={...authorityOverride,id:"same-order-stale-release",
    dragRequestId:"same-order-stale-release",sdeNightPlacementDragIdentity:"same-order-stale-release",
    manualPlanId:"manual-graphic-order|same-order-stale-release",
    stableActionKey:"night-placement-drag|74-10|5M|6S|same-order-stale-release",
    moveKey:"night-placement-drag|74-10|5M|6S|same-order-stale-release",
    needKey:"night-placement-drag-need|night-placement-drag|74-10|5M|6S|same-order-stale-release"};
  const sameGenerated=ctx.buildSdeNightPlacementGeneratedMove(sameOrderOverride);
  const samePreviewRows=ctx.buildSdePhysicalBlockerGuardMoves([sameGenerated],{reconcileActive:false});
  const samePreviewRelease=samePreviewRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  assert.ok(samePreviewRelease);
  const sameOutcomeKey=ctx.getSdeMoveObligationStepKey(samePreviewRelease);
  const sameNeedKey=ctx.getSdeMoveNeedKey(samePreviewRelease);
  const sameFailClosed=ctx.buildSdeCancellationFailClosedRow(samePreviewRelease,sameNeedKey,1,sameOutcomeKey);
  const sameStaleActionKey="same-order-stale-release-action";
  appState.sdeMoveActions={
    [sameStaleActionKey]:{
      action:"cancelled",vehicle:samePreviewRelease.vehicle,fromSlot:samePreviewRelease.fromSlot,
      toSlot:samePreviewRelease.toSlot,outcomeKey:sameOutcomeKey,needKey:sameNeedKey,roundNumber:1,
      replacementWasFailClosed:true,activeOutcomeId:ctx.getSdeMoveActionKey(sameFailClosed),
      snapshot:ctx.getSdeMoveActionSnapshot(samePreviewRelease)
    }
  };
  ctx.setSdeActiveOutcomeAuthority(sameOutcomeKey,sameFailClosed,{
    activeOutcomeId:ctx.getSdeMoveActionKey(sameFailClosed),source:"same-order-stale-release"
  });
  appState.sdeNightPlacementManualOverrides={[sameOrderOverride.id]:sameOrderOverride};
  const sameOrderStaged=ctx.stageSdeCanonicalGraphicDragOrder(sameOrderOverride);
  assert.equal(sameOrderStaged?.chain?.ok,true,sameOrderStaged?.chain?.reason||"fresh order must replace stale authority on its release step");
  assert.equal(sameOrderStaged?.chain?.outcomes?.all?.length,3);

  resetState(placements);
  appState.sdeActiveMoveOutcomes={
    "legacy-authority-schema":{
      vehicleId:"74-10",
      canonicalSourceSlot:"5M",
      activeOutcomeId:"legacy-targetless-authority",
      status:"active"
    }
  };
  assert.equal(
    ctx.removeSdeActiveOutcomeAuthoritiesForPhysicalStep("74-10","5M"),
    true,
    "fresh graphical orders must clear legacy-schema authorities for the same physical step"
  );
  assert.deepEqual(Object.keys(appState.sdeActiveMoveOutcomes),[]);
  appState.sdeActiveMoveOutcomes={
    "move|manual|74-10|5M|74-10|5M|direct-1":{
      activeOutcomeId:"sde-cancel-replacement|historical-targetless"
    }
  };
  assert.equal(
    ctx.removeSdeActiveOutcomeAuthoritiesForPhysicalStep("74-10","5M"),
    true,
    "fieldless legacy authorities must be cleared from their encoded physical-step key"
  );
  assert.deepEqual(Object.keys(appState.sdeActiveMoveOutcomes),[]);

  const fallbackOutcomeKey="move|manual|74-10|5M|74-10|5M|direct-1";
  appState.sdeMoveActions={
    "historical-cancelled-direct-authority":{
      action:"cancelled",
      outcomeKey:fallbackOutcomeKey,
      activeOutcomeId:"sde-cancel-replacement|historical-targetless",
      status:"active",
      snapshot:{vehicle:"74-10",fromSlot:"5M"}
    }
  };
  assert.ok(
    ctx.getSdeActiveOutcomeAuthority(fallbackOutcomeKey),
    "cancelled history alone must reproduce the browser fallback authority"
  );
  assert.equal(
    ctx.removeSdeActiveOutcomeAuthoritiesForPhysicalStep("74-10","5M"),
    true,
    "a fresh graphical order must supersede fallback authority reconstructed from cancelled history"
  );
  assert.equal(ctx.getSdeActiveOutcomeAuthority(fallbackOutcomeKey),null);
  assert.equal(
    appState.sdeMoveActions["historical-cancelled-direct-authority"].prerequisiteCancellationSupersededToDifferentChain,
    true
  );

  resetState(placements);
  appState.sdeMoveLearningLog=[];
  const cancelledDirectKey="cancelled-direct-74-10-5m-1s";
  appState.sdeMoveActions={
    [cancelledDirectKey]:{
      action:"cancelled",time:"2026-07-17T08:14:00.000Z",cancelledAt:"2026-07-17T08:14:00.000Z",
      vehicle:"74-10",fromSlot:"5M",physicalFromSlot:"5M",toSlot:"1S",
      needKey:legacyBaseRow.needKey,
      snapshot:{...legacyBaseRow,recommendedSlot:"1S",toSlot:"1S",needKey:legacyBaseRow.needKey}
    }
  };
  appState.sdeNightPlacementManualOverrides={[authorityOverride.id]:authorityOverride};
  const cancelledReplacements=ctx.buildSdeCancelledReplacementMoves([legacyBaseRow]);
  assert.equal(
    cancelledReplacements.some(row=>
      ctx.normalizeVehicleToken(row?.vehicle)==="74-10"
      && ctx.normalizeSlot(row?.fromSlot || row?.arrivalSlot)==="5M"
    ),
    false,
    "an explicit fresh graphical order must supersede older cancellation replacements for the same physical step"
  );

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-fresh-graphic-order-base-row-harness-v1",
    ok:true,
    legacyActionKey,
    freshActionKey,
    chainId:chainRows[0].sdePhysicalChainId,
    browserHistoryChainId:browserHistoryMain.sdePhysicalChainId,
    roles:chainRows.map(row=>row.sdePhysicalDependencyRole),
    integrity:reader.integrityReport.status
  })+"\n");
})()
`);
