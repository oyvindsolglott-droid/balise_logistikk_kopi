const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('../../config/sde-regression-70-11-10s-to-8s-silent-candidate-drop-20260821-v1.json');
const {
  createShiftEngine,
  createShiftIntent,
  projectCanonicalPlan,
  buildMissingCardLedger,
} = require('../../sde_canonical_shift_engine.js');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function historicalActualRevision(value) {
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function makeIntent(vehicleId = fixture.interaction.vehicleId) {
  return createShiftIntent({
    intentId: `${fixture.interaction.intentId}|${vehicleId}`,
    sourceType: 'MANUAL',
    authority: fixture.interaction.authority,
    priorityClass: 'P1_MANUAL',
    vehicle: vehicleId,
    fromSlot: fixture.interaction.sourceSlot,
    targetSlot: fixture.interaction.targetSlot,
    createdAt: fixture.incidentWindow.from,
    reason: fixture.interaction.reason,
  });
}

function runExactFixture(vehicleId = fixture.interaction.vehicleId) {
  const occupancy = { ...fixture.actualState.occupancy, '10S': vehicleId };
  const state = {
    ...fixture.actualState,
    actualStateRevision: vehicleId === fixture.interaction.vehicleId
      ? fixture.actualState.actualStateRevision
      : `synthetic-revision-${vehicleId}`,
    occupancy,
  };
  return createShiftEngine({ slotCatalog: fixture.slotCatalog }).plan({
    state,
    intents: [makeIntent(vehicleId)],
  });
}

const exactResult = runExactFixture();
const exactProjection = projectCanonicalPlan(exactResult.plan);
const exactLedger = buildMissingCardLedger(exactResult.plan, exactProjection);

test('exact historical fixture preserves revision 372, physical state, eligibility and forensic evidence', () => {
  assert.equal(fixture.contractId, 'SDE-REGRESSION-70-11-10S-TO-8S-SILENT-CANDIDATE-DROP-20260821-V1');
  assert.equal(fixture.sourceReadback.revision, 372);
  assert.equal(fixture.sourceReadback.updatedAt, '2026-08-21T09:23:16.865Z');
  assert.equal(fixture.sourceReadback.nextWriteAt, '2026-08-21T13:52:21.189Z');
  assert.ok(Date.parse(fixture.incidentWindow.from) >= Date.parse(fixture.sourceReadback.updatedAt));
  assert.ok(Date.parse(fixture.incidentWindow.through) < Date.parse(fixture.sourceReadback.nextWriteAt));
  assert.deepEqual(fixture.actualState.occupancy, fixture.sourceReadback.draft.grunnoppstilling);
  assert.deepEqual(fixture.sourceReadback.draft.grunnoppstillingRep, {});
  assert.deepEqual(fixture.actualState.unavailableSlots, []);
  assert.deepEqual(fixture.actualState.unavailableTracks, []);
  assert.deepEqual(fixture.actualState.infrastructureState, { slots: [], tracks: [], washRouteUnavailable: false });
  assert.deepEqual(fixture.actualState.routeReservations, []);
  assert.deepEqual(fixture.actualState.plannedResourceClaims, []);
  assert.deepEqual(fixture.actualState.activeMoveOutcomes, {});
  assert.deepEqual(fixture.actualState.overlays, []);
  assert.deepEqual(fixture.actualState.renderedHolding, {
    ordinarySlotCount: 29,
    placedCount: 6,
    emptyCount: 23,
    separateRouteResourceSlots: ['VN', 'VS'],
  });
  assert.deepEqual(fixture.actualState.targetEligibility, {
    slot: '8S',
    occupied: false,
    unavailable: false,
    eligible: true,
    visualState: 'GREEN',
    warning: '8S er verksted-/reparasjonsposisjon. Bruk normalt bare ved eksplisitt rep/verkstedflyt.',
  });
  assert.equal(fixture.slotCatalog.length, 31);
  assert.equal(new Set(fixture.slotCatalog.map(slot => slot.id)).size, 31);
  assert.equal(fixture.observedHistoricalFailure.candidateOutcomeCount, 0);
  assert.equal(fixture.observedHistoricalFailure.actionableCardCount, 0);
  assert.equal(fixture.observedHistoricalFailure.reservationCount, 0);
  assert.equal(fixture.observedHistoricalFailure.overlayCount, 0);
  assert.deepEqual(fixture.evidence.screenshots.map(item => item.sha256), [
    '68da9a514eeb7035ad3d6f12ae02ab5b90a038f70816e5148f7e297077b86503',
    'a84e9120dec8323a0f30639ac8b4f71747c85cc366ff072c32a41b749027e282',
    'dcab128c40a39b55eacf9b3d0d450a44a56037e947da9dba35ed2fabd73e3171',
    '87e959fe30dc0483e5d740b6ed8c7b91487039618edc716c0198b1663ed298a2',
    '38707fad7101b002a125d116786557c4d716b5dacf96ee3e2e8f36d938b072e0',
  ]);
  const reconstructed = historicalActualRevision(stableStringify(fixture.historicalActualRevisionProof.stablePayload));
  assert.equal(reconstructed, fixture.historicalActualRevisionProof.expectedHash);
  assert.equal(reconstructed, fixture.actualState.actualStateRevision);
});

test('scenario 33 exact regression creates immutable MANUAL_INTENT', () => {
  const intent = exactResult.retainedIntents[0];
  assert.equal(intent.sourceType, 'MANUAL');
  assert.equal(intent.authority, 'HUMAN_MANUAL');
  assert.equal(intent.vehicle, '70-11');
  assert.equal(intent.originalTargetSlot, '8S');
  assert.ok(Object.isFrozen(intent));
});

test('scenario 34 exact regression binds source 10S to fresh actual occupancy', () => {
  assert.equal(fixture.actualState.occupancy['10S'], '70-11');
  assert.equal(exactResult.retainedIntents[0].fromSlot, '10S');
  assert.equal(exactResult.plan.actualStateRevision, 'h7a15d93e');
});

test('scenario 35 exact regression binds eligible empty target 8S', () => {
  assert.equal(fixture.actualState.occupancy['8S'], undefined);
  assert.equal(fixture.actualState.targetEligibility.eligible, true);
  assert.equal(exactResult.retainedIntents[0].targetSlot, '8S');
});

test('scenario 36 exact regression reaches canonical candidate generation', () => {
  assert.equal(exactResult.diagnostics.evaluatedSlotCount, fixture.slotCatalog.length);
  assert.equal(exactResult.diagnostics.candidateEvaluations.length, fixture.slotCatalog.length);
  assert.ok(exactResult.diagnostics.candidateEvaluations.some(candidate => candidate.slot === '8S' && candidate.eligible));
});

test('scenario 37 exact regression candidate generation is never silent', () => {
  assert.equal(exactResult.status, 'PLANNED');
  assert.ok(exactResult.diagnostics);
  assert.ok(Array.isArray(exactResult.diagnostics.candidateEvaluations));
  assert.ok(exactResult.diagnostics.candidateEvaluations.length > 0);
});

test('scenario 38 exact regression reports all 31 candidate outcomes', () => {
  assert.equal(exactResult.diagnostics.candidateCount, fixture.expectedCanonicalOutcome.candidateCount);
  assert.equal(exactResult.diagnostics.candidateCount, 31);
  assert.equal(exactResult.diagnostics.fullEligibleSlotSearch, true);
});

test('scenario 39 exact regression reports all 23 physically safe candidates', () => {
  assert.equal(exactResult.diagnostics.safeCandidateCount, fixture.expectedCanonicalOutcome.safeCandidateCount);
  assert.equal(exactResult.diagnostics.safeCandidateCount, 23);
  assert.equal(exactResult.diagnostics.oneNGlobalDefault, false);
});

test('scenario 40 exact safe state creates the complete proven one-move minimum plan', () => {
  assert.equal(exactResult.status, 'PLANNED');
  assert.equal(exactResult.plan.moveCount, 1);
  assert.equal(exactResult.plan.searchEvidence.optimalityStatus, 'PROVEN');
  assert.deepEqual(exactResult.plan.steps.map(step => ({
    role: step.role,
    vehicleId: step.vehicleId,
    sourceSlot: step.sourceSlot,
    targetSlot: step.targetSlot,
  })), fixture.expectedCanonicalOutcome.steps);
});

test('scenario 41 exact intent has no null empty exception or silent no-op terminal path', () => {
  assert.ok(exactResult);
  assert.ok(exactResult.plan);
  assert.equal(exactResult.retainedIntents.length, 1);
  assert.equal(exactResult.plan.steps.length, 1);
  assert.notEqual(exactResult.status, 'DIAGNOSTIC_ONLY');
  assert.notEqual(exactResult.diagnosticCode, 'SILENT_NO_OP');
});

test('scenario 42 exact regression ledger reaches one READY visible card atomically', () => {
  assert.equal(exactProjection.status, 'PROJECTED');
  assert.equal(exactProjection.cards.filter(card => card.status === 'READY').length, 1);
  assert.equal(exactProjection.reservations.filter(item => item.status === 'OPERATIVE_RESERVATION').length, 1);
  assert.equal(exactProjection.overlays.length, 1);
  assert.deepEqual(exactProjection.routeResources[0].resources, fixture.expectedCanonicalOutcome.projection.routeResources);
  assert.equal(exactLedger.status, 'CONSISTENT');
  assert.equal(exactLedger.aggregates.missingCardWithSafePlan, 0);
  assert.equal(exactLedger.entries[0].visibleCardCreated, true);
});

test('scenario 43 exact topology preserves plan structure for three synthetic vehicle identities', () => {
  const structures = fixture.vehiclePolicyPermutation.syntheticVehicleIds.map(vehicleId => {
    const result = runExactFixture(vehicleId);
    assert.equal(result.status, 'PLANNED');
    assert.equal(result.diagnostics.candidateCount, 31);
    assert.equal(result.diagnostics.safeCandidateCount, 23);
    return result.plan.steps.map(step => `${step.role}:${step.sourceSlot}:${step.targetSlot}`);
  });
  assert.equal(fixture.vehiclePolicyPermutation.syntheticVehicleIds.length, 3);
  assert.deepEqual(structures, [
    fixture.vehiclePolicyPermutation.expectedStructure,
    fixture.vehiclePolicyPermutation.expectedStructure,
    fixture.vehiclePolicyPermutation.expectedStructure,
  ]);
});
