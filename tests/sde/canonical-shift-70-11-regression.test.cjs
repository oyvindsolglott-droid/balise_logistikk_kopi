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

function fixtureStateHash(value) {
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

function runSyntheticFixture(vehicleId = fixture.interaction.vehicleId, statePatch = {}) {
  const baseState = fixture.syntheticScenarioCompletion.engineState;
  const occupancy = {
    ...baseState.occupancy,
    ...(statePatch.occupancyAdd || {}),
    '10S': vehicleId,
  };
  const patch = { ...statePatch };
  delete patch.occupancyAdd;
  const state = {
    ...baseState,
    ...patch,
    actualStateRevision: vehicleId === fixture.interaction.vehicleId
      ? baseState.actualStateRevision
      : `synthetic-revision-${vehicleId}`,
    occupancy,
  };
  return createShiftEngine({ slotCatalog: fixture.slotCatalog }).plan({
    state,
    intents: [makeIntent(vehicleId)],
  });
}

const baselineResult = runSyntheticFixture();
const baselineProjection = projectCanonicalPlan(baselineResult.plan);
const baselineLedger = buildMissingCardLedger(baselineResult.plan, baselineProjection);

test('fixture separates direct historical evidence from explicit synthetic completion', () => {
  assert.equal(fixture.contractId, 'SDE-REGRESSION-70-11-10S-TO-8S-SILENT-CANDIDATE-DROP-20260821-V1');
  assert.equal(fixture.fixtureAuthority, 'PARTIAL_HISTORICAL_CORE_WITH_EXPLICIT_SYNTHETIC_SCENARIO_COMPLETION');
  assert.deepEqual(fixture.evidenceModel, {
    historicalCoreAuthority: 'HISTORICAL_CORE_DIRECT_EVIDENCE',
    scenarioCompletionAuthority: 'EXPLICIT_SYNTHETIC_SCENARIO_COMPLETION',
    exactHistoricalFullStateClaim: false,
    directReadOnlyCopyUsed: false,
    directReadOnlyInspectionUsed: true,
    historicalActualStateRevisionAvailable: false,
  });
  const historical = fixture.historicalCoreDirectEvidence;
  const synthetic = fixture.syntheticScenarioCompletion;
  assert.equal(historical.sourceReadback.revision, 372);
  assert.equal(historical.sourceReadback.updatedAt, '2026-08-21T09:23:16.865Z');
  assert.equal(historical.sourceReadback.nextRevision, 373);
  assert.equal(historical.sourceReadback.nextWriteAt, '2026-08-21T13:52:21.189Z');
  assert.ok(Date.parse(fixture.incidentWindow.from) >= Date.parse(historical.sourceReadback.updatedAt));
  assert.ok(Date.parse(fixture.incidentWindow.through) < Date.parse(historical.sourceReadback.nextWriteAt));
  assert.deepEqual(historical.sourceReadback.draft.grunnoppstilling, synthetic.engineState.occupancy);
  assert.deepEqual(historical.sourceReadback.draft.grunnoppstillingRep, {});
  assert.equal(Object.hasOwn(historical, 'actualStateRevision'), false);
  assert.ok(historical.notDirectlyProven.includes('historicalActualStateRevision'));
  assert.ok(historical.notDirectlyProven.includes('routeResourceState'));
  assert.equal(synthetic.authority, 'EXPLICIT_SYNTHETIC_SCENARIO_COMPLETION');
  assert.equal(synthetic.engineState.actualStateRevision, `synthetic:${synthetic.fixtureStateHash}`);
  assert.deepEqual(synthetic.engineState.unavailableSlots, []);
  assert.deepEqual(synthetic.engineState.unavailableTracks, []);
  assert.deepEqual(synthetic.engineState.infrastructureState, { slots: [], tracks: [], washRouteUnavailable: false });
  assert.deepEqual(synthetic.engineState.routeReservations, []);
  assert.deepEqual(synthetic.engineState.plannedResourceClaims, []);
  assert.deepEqual(synthetic.engineState.activeMoveOutcomes, {});
  assert.deepEqual(synthetic.engineState.overlays, []);
  assert.deepEqual(synthetic.renderedHolding, {
    ordinarySlotCount: 29,
    placedCount: 6,
    emptyCount: 23,
    separateRouteResourceSlots: ['VN', 'VS'],
  });
  assert.deepEqual(synthetic.targetEligibility, {
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
  const reconstructed = fixtureStateHash(stableStringify(fixture.syntheticFixtureStateHash.stablePayload));
  assert.equal(reconstructed, fixture.syntheticFixtureStateHash.expectedHash);
  assert.equal(reconstructed, synthetic.fixtureStateHash);
  assert.equal(fixture.syntheticFixtureStateHash.meaning, 'CONSTRUCTED_TEST_STATE_HASH_NOT_HISTORICAL_SERVER_REVISION');
});

test('scenario 33 synthetic completion creates immutable MANUAL_INTENT', () => {
  const intent = baselineResult.retainedIntents[0];
  assert.equal(intent.sourceType, 'MANUAL');
  assert.equal(intent.authority, 'HUMAN_MANUAL');
  assert.equal(intent.vehicle, '70-11');
  assert.equal(intent.originalTargetSlot, '8S');
  assert.ok(Object.isFrozen(intent));
});

test('scenario 34 synthetic completion binds source 10S to supplied occupancy', () => {
  assert.equal(fixture.syntheticScenarioCompletion.engineState.occupancy['10S'], '70-11');
  assert.equal(baselineResult.retainedIntents[0].fromSlot, '10S');
  assert.equal(baselineResult.plan.actualStateRevision, 'synthetic:h7a15d93e');
});

test('scenario 35 synthetic completion binds eligible empty target 8S', () => {
  assert.equal(fixture.syntheticScenarioCompletion.engineState.occupancy['8S'], undefined);
  assert.equal(fixture.syntheticScenarioCompletion.targetEligibility.eligible, true);
  assert.equal(baselineResult.retainedIntents[0].targetSlot, '8S');
});

test('scenario 36 synthetic baseline reaches canonical candidate generation', () => {
  assert.equal(baselineResult.diagnostics.evaluatedSlotCount, fixture.slotCatalog.length);
  assert.equal(baselineResult.diagnostics.candidateEvaluations.length, fixture.slotCatalog.length);
  assert.ok(baselineResult.diagnostics.candidateEvaluations.some(candidate => candidate.slot === '8S' && candidate.eligible));
});

test('scenario 37 synthetic baseline candidate generation is never silent', () => {
  assert.equal(baselineResult.status, 'PLANNED');
  assert.ok(baselineResult.diagnostics);
  assert.ok(Array.isArray(baselineResult.diagnostics.candidateEvaluations));
  assert.ok(baselineResult.diagnostics.candidateEvaluations.length > 0);
});

test('scenario 38 synthetic baseline reports all 31 candidate outcomes', () => {
  assert.equal(baselineResult.diagnostics.candidateCount, fixture.expectedCanonicalOutcome.candidateCount);
  assert.equal(baselineResult.diagnostics.candidateCount, 31);
  assert.equal(baselineResult.diagnostics.fullEligibleSlotSearch, true);
});

test('scenario 39 synthetic baseline reports all 23 physically safe candidates', () => {
  assert.equal(baselineResult.diagnostics.safeCandidateCount, fixture.expectedCanonicalOutcome.safeCandidateCount);
  assert.equal(baselineResult.diagnostics.safeCandidateCount, 23);
  assert.equal(baselineResult.diagnostics.oneNGlobalDefault, false);
});

test('scenario 40 synthetic safe state creates the complete proven one-move minimum plan', () => {
  assert.equal(baselineResult.status, 'PLANNED');
  assert.equal(baselineResult.plan.moveCount, 1);
  assert.equal(baselineResult.plan.searchEvidence.optimalityStatus, 'PROVEN');
  assert.deepEqual(baselineResult.plan.steps.map(step => ({
    role: step.role,
    vehicleId: step.vehicleId,
    sourceSlot: step.sourceSlot,
    targetSlot: step.targetSlot,
  })), fixture.expectedCanonicalOutcome.steps);
});

test('scenario 41 synthetic intent has no null empty exception or silent no-op terminal path', () => {
  assert.ok(baselineResult);
  assert.ok(baselineResult.plan);
  assert.equal(baselineResult.retainedIntents.length, 1);
  assert.equal(baselineResult.plan.steps.length, 1);
  assert.notEqual(baselineResult.status, 'DIAGNOSTIC_ONLY');
  assert.notEqual(baselineResult.diagnosticCode, 'SILENT_NO_OP');
});

test('scenario 42 synthetic baseline ledger reaches one READY visible card atomically', () => {
  assert.equal(baselineProjection.status, 'PROJECTED');
  assert.equal(baselineProjection.cards.filter(card => card.status === 'READY').length, 1);
  assert.equal(baselineProjection.reservations.filter(item => item.status === 'OPERATIVE_RESERVATION').length, 1);
  assert.equal(baselineProjection.overlays.length, 1);
  assert.deepEqual(baselineProjection.routeResources[0].resources, fixture.expectedCanonicalOutcome.projection.routeResources);
  assert.equal(baselineLedger.status, 'CONSISTENT');
  assert.equal(baselineLedger.aggregates.missingCardWithSafePlan, 0);
  assert.equal(baselineLedger.entries[0].visibleCardCreated, true);
});

test('scenario 43 synthetic topology preserves plan structure for three vehicle identities', () => {
  const structures = fixture.vehiclePolicyPermutation.syntheticVehicleIds.map(vehicleId => {
    const result = runSyntheticFixture(vehicleId);
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

test('scenario 44 sensitivity matrix never silently drops the manual intent', () => {
  assert.ok(Array.isArray(fixture.sensitivityMatrix));
  assert.ok(fixture.sensitivityMatrix.length >= 6);
  for (const variant of fixture.sensitivityMatrix) {
    const result = runSyntheticFixture(fixture.interaction.vehicleId, variant.statePatch || {});
    const projection = result.plan ? projectCanonicalPlan(result.plan) : null;
    const terminal = result.plan ? 'PLAN' : 'DIAGNOSTIC';
    assert.equal(terminal, variant.expected.terminal, variant.id);
    assert.equal(result.status, variant.expected.status, variant.id);
    assert.equal(result.diagnosticCode || '', variant.expected.diagnosticCode || '', variant.id);
    assert.equal(result.retainedIntents.length, 1, variant.id);
    assert.equal(result.retainedIntents[0].vehicle, '70-11', variant.id);
    assert.equal(result.retainedIntents[0].originalTargetSlot, '8S', variant.id);
    if (terminal === 'PLAN') {
      assert.equal(projection.cards.filter(card => card.status === 'READY').length, variant.expected.visibleCardCount, variant.id);
    } else {
      assert.ok(result.diagnostics, variant.id);
      assert.ok(result.reason || result.diagnosticCode, variant.id);
    }
  }
});
