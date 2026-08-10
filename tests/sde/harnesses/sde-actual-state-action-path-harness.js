"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const fixturePath = path.join(__dirname,"../fixtures/actual-state-action-path-20260810.json");
  const fixtureText = fs.readFileSync(fixturePath,"utf8");
  const fixture = JSON.parse(fixtureText);
  const results = [];
  const put = (id,condition,detail)=>results.push({id,status:condition ? "PASS" : "FAIL",detail});
  const plain = value=>JSON.parse(JSON.stringify(value));
  const stable = value=>JSON.stringify(value,Object.keys(value || {}).sort());
  const placements = fixture.slotMapPlacements.map(item=>[item.slot,item.vehicleId]);
  const actualRows = fixture.slotMapPlacements.map(item=>({slot:item.slot,vehicleId:item.vehicleId}));
  const incidentA = fixture.incidents.ambiguousMovementWithExplicitPlacement;
  const incidentB = fixture.incidents.knownActualWithStaleCandidate;

  const reconcile = (sharedRows=fixture.slotMapPlacements,movements=incidentA.movementCandidates)=>plain(
    ctx.buildSdeCanonicalActualStateReconciliation({
      sharedDraftRows:sharedRows,
      computedActualRows:[],
      sharedDraftRevision:fixture.revisions.sharedDraftRevision,
      sharedDraftActive:true,
      pendulumOccurrences:movements,
      snapshotSequenceMinutes:fixture.revisions.snapshotSequenceMinutes
    })
  );

  const makeKnownActualRequest = ()=>({
    vehicle:incidentB.vehicleId,
    fromSlot:incidentB.candidateSource,
    arrivalSlot:incidentB.candidateSource,
    originalFromSlot:incidentB.candidateSource,
    canonicalSourceSlot:incidentB.staleCanonicalSourceField,
    recommendedSlot:incidentB.requestedTarget,
    toSlot:incidentB.requestedTarget,
    stableActionKey:"incident-action-B",
    needKey:"incident-need-B",
    source:"authorized-shift-order",
    canonicalProducer:"canonical-shift-order",
    canonicalPurpose:"vehicle-relocation",
    sdeRecursiveRootRequestId:incidentB.rootRequest.rootRequestId,
    sdeRecursiveRootRequest:plain(incidentB.rootRequest),
    requestRevision:incidentB.rootRequest.requestRevision,
    createdAt:incidentB.rootRequest.createdAt
  });

  const makeUnknownActualRequest = ()=>({
    vehicle:"UNIT-U",
    fromSlot:"10S",
    arrivalSlot:"10S",
    originalFromSlot:"10S",
    recommendedSlot:"8N",
    toSlot:"8N",
    stableActionKey:"incident-action-U",
    needKey:"incident-need-U",
    source:"authorized-shift-order",
    canonicalProducer:"canonical-shift-order",
    canonicalPurpose:"vehicle-relocation",
    sdeRecursiveRootRequestId:"ROOT-U",
    sdeRecursiveRootRequest:{rootRequestId:"ROOT-U",requestedVehicleId:"UNIT-U",requestedTarget:"8N",requestSource:"authorized_shift_order",requestRevision:"revision-U",createdAt:fixture.capturedAt,status:"ACTIVE"}
  });

  const runKnown = (orderedPlacements=placements)=>{
    resetState(orderedPlacements,{sharedSporplanDraftAppliedRevision:fixture.revisions.sharedDraftRevision});
    const guarded = plain(ctx.buildSdePhysicalBlockerGuardMoves([makeKnownActualRequest()]));
    const reader = plain(ctx.buildSdeCanonicalProductionReader(snapshot(guarded,orderedPlacements)));
    const rootRows = guarded.filter(row=>row.sdeRecursiveRootRequestId === incidentB.rootRequest.rootRequestId);
    const main = rootRows.find(row=>row.vehicle === incidentB.vehicleId) || null;
    return {guarded,reader,rootRows,main};
  };

  const reconciliation = reconcile();
  const placementA = reconciliation.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId) || null;
  const pendulumA = reconciliation.pendulumOccurrenceResults?.find(item=>item.vehicleId === incidentA.vehicleId) || null;
  put("INV-EGRESS-050",
    placementA?.slot === incidentA.visibleActualSource
      && placementA?.sourceRevision === fixture.revisions.sharedDraftRevision
      && placementA?.provenance === "shared_draft_explicit"
      && pendulumA?.status === "ambiguous",
    "an ambiguous movement inference must not discard the explicit shared-placement source or revision"
  );

  const known = runKnown();
  const mainOutcome = known.reader.canonicalPlan?.candidateOutcomes?.find(item=>item.vehicleId === incidentB.vehicleId && item.targetSlot === incidentB.requestedTarget) || null;
  const conflictCodes = (known.reader.canonicalPlan?.conflicts || []).filter(item=>item.vehicleId === incidentB.vehicleId).map(item=>item.code);
  put("INV-EGRESS-051",
    known.main?.fromSlot === incidentB.canonicalActualSource
      && known.main?.canonicalSourceSlot === incidentB.canonicalActualSource
      && mainOutcome?.canonicalSourceSlot === incidentB.canonicalActualSource
      && !conflictCodes.includes("candidate_source_conflict"),
    "slot map, guard and canonical planner must agree on the known actual source"
  );

  const reconciliationStatus = known.main?.sdeRecursiveSourceReconciliation?.status;
  const physicalRoles = known.rootRows.map(row=>row.sdeRecursiveCardRole || row.sdePhysicalDependencyRole);
  put("INV-EGRESS-052",
    reconciliationStatus === "CANONICAL_SOURCE_RECONCILED"
      && known.rootRows.every(row=>row.canonicalSourceSlot === row.fromSlot)
      && known.reader.cardProjection?.actionableCards?.length === 1
      && known.reader.cardProjection?.blockedChainCards?.length === known.rootRows.length - 1,
    "a stale candidate source is rebased before every physical chain step is projected"
  );

  resetState(placements,{sharedSporplanDraftAppliedRevision:fixture.revisions.sharedDraftRevision});
  const unknownRows = plain(ctx.buildSdePhysicalBlockerGuardMoves([makeUnknownActualRequest()]));
  const unknownReader = plain(ctx.buildSdeCanonicalProductionReader(snapshot(unknownRows,placements)));
  const workflowCard = unknownReader.cardProjection?.workflowActionCards?.find(card=>card.rootRequestId === "ROOT-U") || null;
  put("INV-EGRESS-053",
    workflowCard?.role === "STATE_RECONCILIATION_REQUIRED"
      && workflowCard?.nonMovement === true
      && workflowCard?.status === "workflow_action"
      && unknownRows.some(row=>row.sdeRecursiveRootRequest?.rootRequestId === "ROOT-U"),
    "genuinely unknown actual state preserves the root request and projects a non-movement reconciliation card"
  );

  put("INV-EGRESS-054",
    known.rootRows.length >= 3
      && physicalRoles.includes("prerequisite")
      && physicalRoles.includes("dependent")
      && physicalRoles.includes("return")
      && known.reader.cardProjection?.actionableCards?.length === 1,
    "a known but blocked source produces one complete prerequisite, main and recovery chain"
  );

  const knownRootResult = known.reader.integrityReport?.rootRequestResults?.find(item=>item.rootRequestId === incidentB.rootRequest.rootRequestId);
  const unknownRootResult = unknownReader.integrityReport?.rootRequestResults?.find(item=>item.rootRequestId === "ROOT-U");
  const invariantKnown = known.reader.integrityReport?.invariantResults?.find(item=>item.invariant === "ACTIVE_ROOT_REQUEST_ALWAYS_HAS_ACTION_PATH");
  const invariantUnknown = unknownReader.integrityReport?.invariantResults?.find(item=>item.invariant === "ACTIVE_ROOT_REQUEST_ALWAYS_HAS_ACTION_PATH");
  put("INV-EGRESS-055",
    knownRootResult?.status === "PASS"
      && unknownRootResult?.status === "PASS"
      && invariantKnown?.status === "PASS"
      && invariantUnknown?.status === "PASS",
    "every active root request is covered by a READY physical path or an explicit workflow action card"
  );

  const reconciliationPermutations = [
    reconcile(),
    reconcile([...fixture.slotMapPlacements].reverse(),[...incidentA.movementCandidates].reverse()),
    reconcile([...fixture.slotMapPlacements].sort((a,b)=>b.vehicleId.localeCompare(a.vehicleId)),[...incidentA.movementCandidates].sort((a,b)=>b.occurrenceId.localeCompare(a.occurrenceId)))
  ];
  const parityFingerprints = reconciliationPermutations.map(value=>JSON.stringify({
    actualPlacements:value.actualPlacements,
    diagnostics:value.diagnostics,
    sourceRevision:value.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId)?.sourceRevision
  }));
  put("INV-EGRESS-056",
    new Set(parityFingerprints).size === 1
      && reconciliationPermutations.every(value=>value.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId)?.sourceRevision === fixture.revisions.sharedDraftRevision),
    "polling, hydration and input-order permutations preserve actual placement and revision parity"
  );

  const duplicateReader = {
    cardProjection:{diagnostics:[
      {diagnosticType:"candidate_source_conflict",obligationId:"O-1",stepId:"S-1",vehicleId:"UNIT-D",sourceSlot:"6N",targetSlot:"12N",explanation:"layer one"},
      {diagnosticType:"candidate_source_conflict",obligationId:"O-2",stepId:"S-2",vehicleId:"UNIT-D",sourceSlot:"6N",targetSlot:"12N",explanation:"layer two"}
    ],actionableCards:[],handlerBlockedCards:[]},
    graphicProjection:{unresolvedDiagnostics:[
      {diagnosticType:"candidate_source_conflict",obligationId:"O-3",stepId:"S-3",vehicleId:"UNIT-D",sourceSlot:"6N",targetSlot:"12N",message:"layer three"}
    ]},
    integrityReport:{conflicts:[]},
    handlerAdapters:{}
  };
  const deduped = plain(ctx.buildSdeCanonicalProductionDiagnostics(duplicateReader));
  put("INV-EGRESS-057",
    deduped.filter(item=>item.diagnosticType === "candidate_source_conflict" && item.vehicleId === "UNIT-D" && item.sourceSlot === "6N" && item.targetSlots?.includes("12N")).length === 1,
    "the same vehicle/source/target diagnostic is emitted once across projection layers"
  );

  const fullReplay = order=>{
    const ordered = order === "reverse" ? [...placements].reverse() : order === "vehicle" ? [...placements].sort((a,b)=>b[1].localeCompare(a[1])) : placements;
    const a = reconcile(order === "reverse" ? [...fixture.slotMapPlacements].reverse() : fixture.slotMapPlacements, order === "vehicle" ? [...incidentA.movementCandidates].reverse() : incidentA.movementCandidates);
    const b = runKnown(ordered);
    return JSON.stringify({
      sourceA:a.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId)?.slot || "",
      revisionA:a.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId)?.sourceRevision || null,
      pendulumStatus:a.pendulumOccurrenceResults?.find(item=>item.vehicleId === incidentA.vehicleId)?.status || "",
      sourcesB:b.rootRows.map(row=>[row.sdeRecursiveCardRole,row.vehicle,row.fromSlot,row.toSlot]),
      cardsB:[...(b.reader.cardProjection?.actionableCards || []),...(b.reader.cardProjection?.blockedChainCards || [])].map(card=>[card.vehicleId,card.sourceSlot,card.targetSlot,card.status]),
      rootStatus:b.reader.integrityReport?.rootRequestResults?.find(item=>item.rootRequestId === incidentB.rootRequest.rootRequestId)?.status || ""
    });
  };
  const replayFingerprints = [fullReplay("original"),fullReplay("reverse"),fullReplay("vehicle")];
  put("INV-EGRESS-058",
    new Set(replayFingerprints).size === 1
      && reconciliation.actualPlacements?.find(item=>item.vehicleId === incidentA.vehicleId)?.slot === incidentA.visibleActualSource
      && known.reader.cardProjection?.actionableCards?.length === 1,
    "the full anonymized incident snapshot replays deterministically with both action paths intact"
  );

  const failed = results.filter(item=>item.status === "FAIL");
  console.log(JSON.stringify({
    schemaVersion:"sde-actual-state-action-path-harness-v1",
    fixture:{snapshotId:fixture.snapshotId,sha256:crypto.createHash("sha256").update(fixtureText).digest("hex")},
    counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
    failIds:failed.map(item=>item.id),
    results,
    incidentA:{slotMapSource:incidentA.visibleActualSource,plannerSource:placementA?.slot || "UNKNOWN",movementCandidateCount:incidentA.movementCandidates.length,pendulumStatus:pendulumA?.status || "UNKNOWN"},
    incidentB:{slotMapSource:incidentB.visibleActualSource,plannerSource:mainOutcome?.canonicalSourceSlot || "UNKNOWN",rootRequestId:incidentB.rootRequest.rootRequestId,guardedRowCount:known.rootRows.length,physicalRoles,actionableCardCount:known.reader.cardProjection?.actionableCards?.length || 0,blockedCardCount:known.reader.cardProjection?.blockedChainCards?.length || 0},
    unknownActual:{workflowRole:workflowCard?.role || "MISSING",rootStatus:unknownRootResult?.status || "MISSING"},
    deterministicReplay:{runs:replayFingerprints.length,stable:new Set(replayFingerprints).size === 1}
  }));
  process.exitCode = failed.length ? 1 : 0;
})();
`);
