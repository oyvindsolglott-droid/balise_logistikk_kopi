const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SEARCH_BOUNDARY_CONTRACT,
  createShiftIntent,
  createShiftEngine,
  createShiftReplanner,
  buildMissingCardLedger,
  projectCanonicalPlan,
  revalidateActionStep,
  stableHash,
} = require('../../sde_canonical_shift_engine.js');

const slots = [
  { id: '1N', track: '1', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '1S', track: '1', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '7S', track: '7', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '8S', track: '8', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '8N', track: '8', order: 1, role: 'workshop', accessEnds: ['south'] },
  { id: '9', track: '9', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '10S', track: '10', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '10N', track: '10', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '11S', track: '11', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '11N', track: '11', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '12S', track: '12', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: 'VN', track: 'V', order: 0, role: 'temporary_relief', accessEnds: ['south'] },
  { id: 'VS', track: 'V', order: 1, role: 'route_resource', accessEnds: ['south'] },
];

function engine(overrides = {}) {
  return createShiftEngine({
    slotCatalog: slots,
    boundary: {
      maxStates: 250000,
      maxWallTimeMs: 1800,
      maxConnectedVehicles: 16,
      maxConnectedSlots: 31,
      maxPlanSteps: null,
      maxBranchingFactor: 31,
      ...overrides,
    },
  });
}

function state(occupancy, extra = {}) {
  return {
    actualStateRevision: extra.actualStateRevision || 'actual-r1',
    occupancy,
    unavailableSlots: extra.unavailableSlots || [],
    routeReservations: extra.routeReservations || [],
    ...extra,
  };
}

function manual(vehicle, fromSlot, targetSlot, extra = {}) {
  return createShiftIntent({
    intentId: extra.intentId || `manual|${vehicle}|${fromSlot}|${targetSlot}`,
    sourceType: 'MANUAL',
    authority: 'HUMAN_MANUAL',
    priorityClass: 'P1_MANUAL',
    vehicle,
    fromSlot,
    targetSlot,
    requestedAt: extra.requestedAt || '2026-08-22T10:00:00.000Z',
    ...extra,
  });
}

test('boundary is versioned and does not impose a three-step limit', () => {
  assert.equal(SEARCH_BOUNDARY_CONTRACT.id, 'SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1');
  assert.equal(SEARCH_BOUNDARY_CONTRACT.maxPlanSteps, null);
});

test('intent preserves immutable human target and idempotency identity', () => {
  const intent = manual('70-11', '10S', '8S');
  assert.equal(intent.originalTargetSlot, '8S');
  assert.equal(intent.targetSlot, '8S');
  assert.match(intent.idempotencyKey, /^shift-intent-v1\|/);
  assert.ok(Object.isFrozen(intent));
});

test('stable input hashing is independent of object insertion order', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
});

test('direct 70-11 10S to empty 8S creates one MAIN step', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => [step.role, step.vehicleId, step.sourceSlot, step.targetSlot]), [
    ['MAIN', '70-11', '10S', '8S'],
  ]);
});

test('a source blocker produces RELEASE MAIN RECOVERY', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => step.role), ['RELEASE', 'MAIN', 'RECOVERY']);
  assert.equal(result.plan.steps[0].vehicleId, '74-99');
  assert.equal(result.plan.steps[1].vehicleId, '70-11');
  assert.equal(result.plan.steps[2].vehicleId, '74-99');
});

test('recursive blockers produce a general chain longer than three steps', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99', '8S': '74-20', '8N': '74-21' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  assert.equal(result.status, 'PLANNED');
  assert.ok(result.plan.steps.length > 3, JSON.stringify(result, null, 2));
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN').length, 1);
});

test('the complete eligible slot set is diagnosed', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  const evaluated = result.diagnostics.candidateEvaluations.map(item => item.slot).sort();
  assert.deepEqual(evaluated, slots.map(item => item.id).sort());
});

test('1N is not a global or short-circuiting fallback', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.ok(result.diagnostics.candidateEvaluations.some(item => item.slot === '1N'));
  assert.notEqual(result.plan.steps[0].targetSlot, '1N');
  assert.equal(result.diagnostics.searchStoppedAfterFirstCandidate, false);
});

test('VN is evaluated contextually and compared with ordinary relief candidates', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  const vn = result.diagnostics.candidateEvaluations.find(item => item.slot === 'VN');
  const ordinary = result.diagnostics.candidateEvaluations.filter(item => item.role === 'ordinary');
  assert.equal(vn.considered, true);
  assert.ok(ordinary.length > 1);
  assert.equal(result.diagnostics.vnComparedWithOrdinaryRelief, true);
});

test('a rejected candidate never stops the later safe candidate search', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }, { unavailableSlots: ['1N'] }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.status, 'PLANNED');
  assert.equal(result.diagnostics.firstRejectedCandidate, '10S');
  assert.equal(result.diagnostics.firstRejectionReason, 'TARGET_OCCUPIED');
  assert.ok(result.diagnostics.safeCandidateCount > 0);
  assert.equal(result.diagnostics.searchStoppedAfterFirstCandidate, false);
  assert.notEqual(result.plan.steps[0].targetSlot, '1N');
  const rejectedIndex = result.diagnostics.candidateEvaluations.findIndex(item => item.slot === '10S');
  const laterSafeIndex = result.diagnostics.candidateEvaluations.findIndex(item => item.slot === '11N' && item.eligible);
  assert.ok(laterSafeIndex > rejectedIndex);
});

test('VN wins over safe 1N when the complete multi-intent plan needs fewer movements', () => {
  const result = engine().plan({
    state: state(
      { '10S': 'UNIT-MAIN', '8S': 'UNIT-BLOCKER', '11S': 'UNIT-LATER' },
      { unavailableSlots: ['1S', '7S', '8N', '9', '10N', '11N', '12S'] },
    ),
    intents: [
      manual('UNIT-MAIN', '10S', '8S', { intentId: 'manual-main', createdAt: '2026-08-22T10:00:00Z' }),
      manual('UNIT-LATER', '11S', '1N', { intentId: 'manual-later', createdAt: '2026-08-22T10:01:00Z' }),
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => [step.role, step.vehicleId, step.sourceSlot, step.targetSlot]), [
    ['RELEASE', 'UNIT-BLOCKER', '8S', 'VN'],
    ['MAIN', 'UNIT-MAIN', '10S', '8S'],
    ['MAIN', 'UNIT-LATER', '11S', '1N'],
  ]);
  assert.equal(result.plan.moveCount, 3);
  assert.equal(result.diagnostics.candidateEvaluations.find(item => item.slot === '1N').eligible, true);
  assert.equal(result.diagnostics.candidateEvaluations.find(item => item.slot === 'VN').eligible, true);
});

test('VS is never accepted as an ordinary holding target', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.diagnostics.candidateEvaluations.find(item => item.slot === 'VS').hardSafe, false);
  assert.ok(result.plan.steps.every(step => step.targetSlot !== 'VS'));
});

test('a safe low-experience candidate remains eligible', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
    humanExperienceEvidence: [{ vehicleId: '74-20', targetSlot: '1N', outcome: 'REJECTED', occurredAt: '2026-08-22T09:00:00.000Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' }],
  });
  const item = result.diagnostics.candidateEvaluations.find(candidate => candidate.slot === '1N');
  assert.equal(item.hardSafe, true);
  assert.equal(item.eligible, true);
  assert.ok(item.humanExperienceScore < 0);
});

test('recommendation provenance is excluded from HumanExperienceScore', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
    humanExperienceEvidence: [{ vehicleId: '74-20', targetSlot: '1N', outcome: 'SUCCESS', occurredAt: '2026-08-22T09:00:00.000Z', provenance: 'SDE_RECOMMENDATION' }],
  });
  assert.equal(result.diagnostics.candidateEvaluations.find(item => item.slot === '1N').humanExperienceScore, 0);
});

test('identical relevant input produces NO_OP against prior plan', () => {
  const first = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const second = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')], previousPlan: first.plan });
  assert.equal(second.status, 'NO_OP');
  assert.equal(second.plan.planRevision, first.plan.planRevision);
});

test('actual revision alone does not change relevant input hash', () => {
  const first = engine().plan({ state: state({ '10S': '70-11' }, { actualStateRevision: 'r1' }), intents: [manual('70-11', '10S', '8S')] });
  const second = engine().plan({ state: state({ '10S': '70-11' }, { actualStateRevision: 'r2' }), intents: [manual('70-11', '10S', '8S')], previousPlan: first.plan });
  assert.equal(second.status, 'NO_OP');
});

test('changed occupancy causes a new atomic suffix revision', () => {
  const first = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const second = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
    previousPlan: first.plan,
    events: [{ type: 'TARGET_OCCUPIED', slot: '8S', vehicleId: '74-20' }],
  });
  assert.equal(second.status, 'REPLANNED');
  assert.notEqual(second.plan.planRevision, first.plan.planRevision);
  assert.equal(second.plan.originalIntents[0].originalTargetSlot, '8S');
});

test('completed prefix is preserved across suffix replan', () => {
  const first = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const release = first.plan.steps[0];
  const afterRelease = { ...state({ '10S': '70-11', [release.targetSlot]: '74-99' }), completedStepIds: [release.stepId] };
  const second = engine().plan({ state: afterRelease, intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })], previousPlan: first.plan, events: [{ type: 'STEP_COMPLETED', stepId: release.stepId }] });
  assert.equal(second.plan.steps[0].stepId, release.stepId);
  assert.equal(second.plan.steps[0].status, 'COMPLETED');
});

test('unchanged conflict-free plan fragments retain stable identity across an affected replan', () => {
  const firstIntent = manual('UNIT-A', '10S', '8S', { createdAt: '2026-08-22T10:00:00.000Z' });
  const first = engine().plan({
    state: state({ '10S': 'UNIT-A', '11S': 'UNIT-B' }),
    intents: [firstIntent],
  });
  const preserved = first.plan.steps[0];
  const second = engine().plan({
    state: state({ '10S': 'UNIT-A', '11S': 'UNIT-B' }),
    intents: [
      firstIntent,
      manual('UNIT-B', '11S', '12S', { createdAt: '2026-08-22T10:01:00.000Z' }),
    ],
    previousPlan: first.plan,
    events: [{ type: 'MANUAL_INTENT_CREATED', vehicleId: 'UNIT-B' }],
  });
  assert.equal(second.status, 'REPLANNED');
  assert.equal(second.plan.steps[0].stepId, preserved.stepId);
  assert.equal(second.plan.steps[0].sourceSlot, preserved.sourceSlot);
  assert.equal(second.plan.steps[0].targetSlot, preserved.targetSlot);
  assert.equal(second.plan.searchEvidence.reusedPendingPlanFragments, 1);
  assert.equal(second.plan.searchEvidence.reusedPlanFragments, 1);
});

test('future steps validate against predecessor simulation, not initial actual', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const main = result.plan.steps.find(step => step.role === 'MAIN');
  assert.equal(main.validation.predecessorStateHash, result.plan.steps[0].postStateHash);
  assert.notEqual(main.validation.predecessorStateHash, result.plan.initialStateHash);
});

test('fresh action revalidation rejects changed source occupancy', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const check = revalidateActionStep(result.plan, result.plan.steps[0].stepId, state({ '10S': '74-00' }));
  assert.equal(check.ok, false);
  assert.equal(check.code, 'SOURCE_CHANGED');
});

test('fresh action revalidation accepts unchanged actionable step', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const check = revalidateActionStep(result.plan, result.plan.steps[0].stepId, state({ '10S': '70-11' }));
  assert.equal(check.ok, true);
});

test('canonical projections are complete and share one plan revision', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.status, 'PROJECTED');
  assert.equal(projection.cards.length, result.plan.steps.length);
  assert.equal(projection.reservations.length, 1);
  assert.equal(projection.plannedResourceClaims.length, result.plan.steps.length - 1);
  assert.equal(projection.overlays.length, result.plan.steps.length);
  assert.equal(projection.ledger.length, result.plan.obligations.length);
  assert.deepEqual(new Set([...projection.cards, ...projection.reservations, ...projection.overlays].map(item => item.planRevision)), new Set([result.plan.planRevision]));
});

test('a corrupt graph fails closed without partial operational projection', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const corrupt = structuredClone(result.plan);
  corrupt.steps[0].dependencyIds = ['missing-step'];
  const projection = projectCanonicalPlan(corrupt);
  assert.equal(projection.status, 'REJECTED');
  assert.deepEqual(projection.cards, []);
  assert.deepEqual(projection.reservations, []);
  assert.deepEqual(projection.overlays, []);
});

test('unavailable requested target is fail-closed', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }, { unavailableSlots: ['8S'] }), intents: [manual('70-11', '10S', '8S')] });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.equal(result.plan, null);
});

test('wrong actual source is fail-closed and does not infer a hardcoded vehicle slot', () => {
  const result = engine().plan({ state: state({ VN: '75-76', '10S': '74-00' }), intents: [manual('70-11', '10S', '8S')] });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.match(result.reason, /source/i);
});

test('an absent vehicle is never materialized into any slot', () => {
  const result = engine().plan({ state: state({}), intents: [manual('75-76', 'VN', '8S')] });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.equal(JSON.stringify(result).includes('"targetSlot":"VN"'), false);
});

test('two intents reserve globally conflict-free targets', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [manual('70-11', '10S', '8S'), manual('74-11', '11S', '12S')],
  });
  assert.equal(result.status, 'PLANNED');
  const mains = result.plan.steps.filter(step => step.role === 'MAIN');
  assert.deepEqual(mains.map(step => step.targetSlot).sort(), ['12S', '8S']);
});

test('conflicting manual targets fail closed instead of overwriting intent', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [manual('70-11', '10S', '8S'), manual('74-11', '11S', '8S')],
  });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.match(result.reason, /conflict/i);
});

test('search boundary stops deterministically with explicit diagnostics', () => {
  const result = engine({ maxStates: 1 }).plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  assert.equal(result.status, 'SEARCH_BOUNDARY_EXHAUSTED');
  assert.equal(result.diagnostics.boundaryId, 'SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1');
});

test('plan identity is deterministic across repeated runs', () => {
  const input = { state: state({ '10S': '70-11', '8S': '74-20' }), intents: [manual('70-11', '10S', '8S')] };
  const first = engine().plan(input);
  const second = engine().plan(input);
  assert.equal(first.plan.planRevision, second.plan.planRevision);
  assert.deepEqual(first.plan.steps, second.plan.steps);
});

test('ShiftIntent exposes the complete canonical authority contract', () => {
  const intent = createShiftIntent({
    intentId: 'manual-complete',
    sourceType: 'MANUAL',
    priorityClass: 'P1_MANUAL',
    createdAt: '2026-08-22T10:00:00.000Z',
    createdBy: 'operator-1',
    vehicleId: '70-11',
    sourceOccurrence: 'occ-1',
    requestedSource: '10S',
    requestedTarget: '8S',
    earliestStart: 100,
    latestFinish: 140,
    explicitSequenceIndex: 2,
    mandatory: true,
    reason: 'manual drag',
    sourceRevision: 'actual-r1',
    status: 'ACTIVE',
  });
  assert.deepEqual({
    sourceOccurrence: intent.sourceOccurrence,
    requestedSource: intent.requestedSource,
    requestedTarget: intent.requestedTarget,
    createdBy: intent.createdBy,
    earliestStart: intent.earliestStart,
    latestFinish: intent.latestFinish,
    explicitSequenceIndex: intent.explicitSequenceIndex,
    mandatory: intent.mandatory,
    reason: intent.reason,
    sourceRevision: intent.sourceRevision,
    status: intent.status,
  }, {
    sourceOccurrence: 'occ-1', requestedSource: '10S', requestedTarget: '8S', createdBy: 'operator-1',
    earliestStart: 100, latestFinish: 140, explicitSequenceIndex: 2, mandatory: true,
    reason: 'manual drag', sourceRevision: 'actual-r1', status: 'ACTIVE',
  });
});

test('manual intent is ordered before SDE-derived intent', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      createShiftIntent({ intentId: 'derived', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', vehicle: '74-11', fromSlot: '11S', targetSlot: '12S', createdAt: '2026-08-22T09:00:00Z' }),
      manual('70-11', '10S', '8S', { createdAt: '2026-08-22T10:00:00Z' }),
    ],
  });
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId, 'manual|70-11|10S|8S');
});

test('SDE-derived intent is ordered before confirmed written plan', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      createShiftIntent({ intentId: 'written', sourceType: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN', vehicle: '70-11', fromSlot: '10S', targetSlot: '8S' }),
      createShiftIntent({ intentId: 'derived', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', vehicle: '74-11', fromSlot: '11S', targetSlot: '12S' }),
    ],
  });
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId, 'derived');
});

test('confirmed written plan is followed when no higher-priority conflict exists', () => {
  const written = createShiftIntent({
    intentId: 'written-only', sourceType: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN',
    vehicle: '70-11', fromSlot: '10S', targetSlot: '8S',
  });
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [written] });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => [step.intentId, step.targetSlot]), [['written-only', '8S']]);
  assert.equal(result.plan.writtenPlanEvidence.followedWhenFeasible, true);
});

test('manual override makes the minimum deviation and rejoins the confirmed written plan', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }),
    intents: [
      createShiftIntent({ intentId: 'written-rejoin', sourceType: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN', vehicle: '70-11', fromSlot: '10S', targetSlot: '8S' }),
      manual('70-11', '10S', '9', { intentId: 'manual-temporary' }),
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => [step.intentId, step.sourceSlot, step.targetSlot]), [
    ['manual-temporary', '10S', '9'],
    ['written-rejoin', '9', '8S'],
  ]);
  assert.equal(result.plan.moveCount, 2);
  assert.equal(result.plan.writtenPlanEvidence.minimumNecessaryDeviation, true);
  assert.equal(result.plan.writtenPlanEvidence.rejoinedAfterHigherPriorityOverride, true);
  assert.match(result.plan.explanation.summary, /skriftlig plan gjenopptas/i);
});

test('vehicle-id permutations preserve the same physical plan structure', () => {
  const structures = ['UNIT-A', 'UNIT-B', 'UNIT-C', 'UNIT-D'].map(vehicle => {
    const result = engine().plan({
      state: state({ '10S': vehicle, '10N': `${vehicle}-BLOCKER` }),
      intents: [manual(vehicle, '10S', '8S', { intentId: `manual-${vehicle}`, preferredSourceEnd: 'north' })],
    });
    assert.equal(result.status, 'PLANNED');
    return result.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]);
  });
  structures.slice(1).forEach(structure => assert.deepEqual(structure, structures[0]));
});

test('blocked workshop egress receives a complete N-step plan and retry retains intent', () => {
  const workshopIntent = createShiftIntent({
    intentId: 'workshop-exit-1', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED',
    vehicle: '74-76', fromSlot: '7S', targetSlot: '10S', preferredTargetEnd: 'north',
  });
  const blocked = engine().plan({
    state: state({ '7S': '74-76', '10N': '74-99' }, { unavailableSlots: ['10S'] }),
    intents: [workshopIntent],
  });
  assert.equal(blocked.status, 'BLOCKED_UNRESOLVED');
  assert.equal(blocked.retainedIntents[0].intentId, 'workshop-exit-1');
  const retried = engine().plan({
    state: state({ '7S': '74-76', '10N': '74-99' }),
    intents: blocked.retainedIntents,
  });
  assert.equal(retried.status, 'PLANNED');
  assert.ok(retried.plan.steps.length >= 3);
  assert.deepEqual(retried.plan.steps.map(step => step.role), ['RELEASE', 'MAIN', 'RECOVERY']);
  assert.equal(retried.plan.originalIntents[0].intentId, 'workshop-exit-1');
});

test('explicit human sequence orders two manual intents before creation time', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      manual('70-11', '10S', '8S', { intentId: 'manual-2', explicitSequenceIndex: 2, createdAt: '2026-08-22T09:00:00Z' }),
      manual('74-11', '11S', '12S', { intentId: 'manual-1', explicitSequenceIndex: 1, createdAt: '2026-08-22T10:00:00Z' }),
    ],
  });
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId, 'manual-1');
});

test('creation time orders manual intents without explicit sequence', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      manual('70-11', '10S', '8S', { intentId: 'late', createdAt: '2026-08-22T10:00:00Z' }),
      manual('74-11', '11S', '12S', { intentId: 'early', createdAt: '2026-08-22T09:00:00Z' }),
    ],
  });
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId, 'early');
});

test('hard constraint retains conflicting manual intent as explicit conflict', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }, { unavailableSlots: ['8S'] }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.equal(result.diagnosticCode, 'MANUAL_INTENT_CONFLICTS_WITH_HARD_CONSTRAINT');
  assert.equal(result.retainedIntents[0].originalTargetSlot, '8S');
});

test('unconfirmed OCR remains below P3 and is not promoted to a shift intent', () => {
  assert.throws(() => createShiftIntent({ sourceType: 'OCR_RAW', vehicle: '70-11', fromSlot: '10S', targetSlot: '8S' }), /confirmed/i);
});

test('plan graph exposes typed revision, dependencies, alternatives, evidence and explanation', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  assert.match(result.plan.planId, /^shift-plan-v1\|/);
  assert.equal(result.plan.inputRevision, 'actual-r1');
  assert.ok(Array.isArray(result.plan.dependencies));
  assert.ok(Array.isArray(result.plan.candidateAlternatives));
  assert.equal(result.plan.moveCount, 1);
  assert.equal(result.plan.safetyEvidence.hardGatesPassed, true);
  assert.equal(result.plan.rankingEvidence.machineLearningScoreActive, false);
  assert.match(result.plan.explanation.summary, /1 fysisk/i);
  assert.equal(result.plan.steps[0].planId, result.plan.planId);
  assert.equal(result.plan.planRevisionRecord.planRevisionId, result.plan.planRevision);
  assert.equal(result.plan.planRevisionRecord.createdAt, '2026-08-22T10:00:00.000Z');
});

test('card projection exposes the complete operator explanation contract', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north', reason: 'Grafisk drag' })],
  });
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.status, 'PROJECTED');
  projection.cards.forEach((card, index) => {
    assert.equal(card.schemaVersion, 'sde-actionable-shift-card-v1');
    assert.equal(card.cardId, card.canonicalCardId);
    assert.equal(card.planId, result.plan.planId);
    assert.equal(card.planRevision, result.plan.planRevision);
    assert.equal(card.sequenceIndex, index);
    assert.equal(card.totalStepCount, result.plan.steps.length);
    assert.equal(card.source, card.sourceSlot);
    assert.equal(card.target, card.targetSlot);
    assert.ok(card.sourceType);
    assert.ok(card.priority);
    assert.ok(card.intentReason);
    assert.equal(card.planMoveCount, result.plan.moveCount);
    assert.match(card.rankingExplanation, /minimum moveCount/i);
    if (card.status === 'READY') assert.ok(card.reservationId);
    else assert.equal(card.reservationId, '');
  });
});

test('every step receives one serialized planned time window and resource claim', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }, { currentOperationalTime: 100 }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north', earliestStart: 110, latestFinish: 140 })],
  });
  result.plan.steps.forEach((step, index) => {
    assert.equal(step.plannedWindowStart, 110 + index * 5);
    assert.equal(step.plannedWindowEnd, 115 + index * 5);
    assert.equal(step.resourceId, 'sde-shift-resource-1');
    assert.ok(step.plannedResourceClaims.includes('sde-shift-resource-1'));
  });
});

test('an impossible hard deadline reports a concrete time conflict', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }, { currentOperationalTime: 100 }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north', earliestStart: 110, latestFinish: 120 })],
  });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.equal(result.diagnosticCode, 'MANUAL_INTENT_CONFLICTS_WITH_HARD_CONSTRAINT');
  assert.match(result.reason, /deadline|time window/i);
});

test('only READY card has operative reservation and completion authority', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.cards.filter(card => card.status === 'READY').length, 1);
  assert.equal(projection.cards.filter(card => card.canComplete).length, 1);
  assert.equal(projection.reservations.length, 1);
  assert.equal(projection.plannedResourceClaims.length, result.plan.steps.length - 1);
});

test('future cards have precise dependency lifecycle and no Utført authority', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const projection = projectCanonicalPlan(result.plan);
  const future = projection.cards.slice(1);
  assert.ok(future.every(card => card.status === 'WAITING_FOR_DEPENDENCY'));
  assert.ok(future.every(card => card.canComplete === false));
  assert.ok(future.every(card => card.futurePlanStep === true));
});

test('missing-card ledger proves required parity equalities', () => {
  const result = engine().plan({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const projection = projectCanonicalPlan(result.plan);
  const ledger = buildMissingCardLedger(result.plan, projection);
  assert.equal(ledger.aggregates.mandatoryObligationGoalCount, ledger.aggregates.obligationCount);
  assert.equal(ledger.aggregates.feasibleIntentCount, ledger.aggregates.completePlanCount);
  assert.equal(ledger.aggregates.readyStepCount, ledger.aggregates.actionableCardCount);
  assert.equal(ledger.aggregates.actionableCardCount, ledger.aggregates.visibleActionableCardCount);
  assert.equal(ledger.aggregates.missingCardWithSafePlan, 0);
  assert.equal(ledger.entries[0].candidateCount, result.plan.candidateDiagnostics.length);
  assert.equal(typeof ledger.entries[0].safeCandidateCount, 'number');
  assert.equal(typeof ledger.entries[0].firstRejectionReason, 'string');
});

test('planner never mutates supplied actual placement', () => {
  const actual = state({ '10S': '70-11' });
  const before = structuredClone(actual);
  engine().plan({ state: actual, intents: [manual('70-11', '10S', '8S')] });
  assert.deepEqual(actual, before);
});

test('card cancellation retains parent manual intent and requests replan', async () => {
  const replanner = createShiftReplanner(engine());
  const first = await replanner.submit({ state: state({ '10S': '70-11' }), intents: [manual('70-11', '10S', '8S')] });
  const cancelled = await replanner.submit({
    state: state({ '10S': '70-11' }),
    intents: [manual('70-11', '10S', '8S')],
    previousPlan: first.plan,
    events: [{ type: 'CARD_CANCELLED', stepId: first.plan.steps[0].stepId, reason: 'operator-cancelled-card' }],
  });
  assert.equal(cancelled.auditEvents[0].type, 'CARD_CANCELLED');
  assert.equal(cancelled.retainedIntents[0].intentId, 'manual|70-11|10S|8S');
  assert.notEqual(cancelled.status, 'NO_OP');
});

test('Annullert support step preserves parent intent and selects a different safe support transition', () => {
  const planner = engine();
  const actual = state({ '10S': '70-11', '10N': '74-99' });
  const parentIntent = manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' });
  const first = planner.plan({ state: actual, intents: [parentIntent] });
  const cancelledSupport = first.plan.steps.find(step => step.role === 'RELEASE');
  assert.ok(cancelledSupport);
  const replanned = planner.plan({
    state: actual,
    intents: [parentIntent],
    previousPlan: first.plan,
    events: [{
      type: 'ANNULLERT',
      stepId: cancelledSupport.stepId,
      intentId: cancelledSupport.intentId,
      vehicleId: cancelledSupport.vehicleId,
      sourceSlot: cancelledSupport.sourceSlot,
      targetSlot: cancelledSupport.targetSlot,
      role: cancelledSupport.role,
      reason: 'operator-rejected-support-target',
    }],
  });
  assert.equal(replanned.status, 'REPLANNED');
  assert.equal(replanned.retainedIntents[0].intentId, parentIntent.intentId);
  const replacementSupport = replanned.plan.steps.find(step => step.role === 'RELEASE');
  assert.ok(replacementSupport);
  assert.notEqual(replacementSupport.targetSlot, cancelledSupport.targetSlot);
});

test('explicit manual-intent cancellation removes only that intent', async () => {
  const replanner = createShiftReplanner(engine());
  const result = await replanner.submit({
    state: state({ '10S': '70-11' }),
    intents: [manual('70-11', '10S', '8S')],
    events: [{ type: 'MANUAL_INTENT_CANCELLED', intentId: 'manual|70-11|10S|8S' }],
  });
  assert.equal(result.status, 'NO_ACTIVE_INTENTS');
  assert.deepEqual(result.retainedIntents, []);
});

test('burst events coalesce to one terminal revision with at most one active job', async () => {
  const replanner = createShiftReplanner(engine());
  const inputs = Array.from({ length: 50 }, (_, index) => ({
    state: state({ '10S': '70-11' }, { actualStateRevision: `r${index}` }),
    intents: [manual('70-11', '10S', '8S')],
    events: [{ type: 'IRRELEVANT_POLL', index }],
  }));
  const results = await Promise.all(inputs.map(input => replanner.submit(input)));
  assert.equal(replanner.metrics.maximumParallelJobs, 1);
  assert.equal(replanner.metrics.duplicateTerminalRevisions, 0);
  assert.equal(new Set(results.filter(Boolean).map(item => item.plan?.planRevision).filter(Boolean)).size, 1);
});

test('HumanExperienceScore changes equal-cost tie-break and explanation', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
    humanExperienceEvidence: [
      { vehicleId: '74-20', targetSlot: '7S', outcome: 'SUCCESS', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
      { vehicleId: '74-20', targetSlot: '9', outcome: 'REJECTED', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
    ],
  });
  assert.equal(result.plan.steps[0].targetSlot, '7S');
  assert.match(result.plan.explanation.summary, /HumanExperienceScore/i);
});

test('HumanExperienceScore uses comparable material context and never individual vehicle identity as policy', () => {
  const evidence = [
    { vehicleId: '74-99', vehicleType: '74', targetSlot: '7S', outcome: 'COMPLETED', actualFinalSlot: '7S', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
    { vehicleId: '74-98', vehicleType: '74', targetSlot: '9', outcome: 'REJECTED', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
  ];
  const first = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S')],
    humanExperienceEvidence: evidence,
  });
  const second = engine().plan({
    state: state({ '10S': '70-12', '8S': '74-21' }),
    intents: [manual('70-12', '10S', '8S')],
    humanExperienceEvidence: evidence,
  });
  assert.equal(first.plan.steps[0].targetSlot, '7S');
  assert.equal(second.plan.steps[0].targetSlot, '7S');
  assert.deepEqual(first.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]), second.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]));
});

test('HumanExperienceScore cannot make an unavailable candidate pass a hard gate', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '8S': '74-20' }, { unavailableSlots: ['7S'] }),
    intents: [manual('70-11', '10S', '8S')],
    humanExperienceEvidence: [
      { vehicleId: '74-99', vehicleType: '74', targetSlot: '7S', outcome: 'COMPLETED', actualFinalSlot: '7S', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.notEqual(result.plan.steps[0].targetSlot, '7S');
  const unavailable = result.diagnostics.candidateEvaluations.find(item => item.slot === '7S');
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.reasonCode, 'SLOT_UNAVAILABLE');
});

test('HumanExperienceScore cannot demote an explicit MANUAL intent below SDE-derived work', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      createShiftIntent({
        intentId: 'derived-experience-favored', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED',
        vehicle: '74-11', fromSlot: '11S', targetSlot: '12S', createdAt: '2026-08-22T09:00:00Z',
        metadata: { HumanExperienceScore: 999 },
      }),
      manual('70-11', '10S', '8S', {
        intentId: 'manual-experience-disfavored', createdAt: '2026-08-22T10:00:00Z',
        metadata: { HumanExperienceScore: -999 },
      }),
    ],
    humanExperienceEvidence: [
      { vehicleType: '74', targetSlot: '12S', outcome: 'COMPLETED', actualFinalSlot: '12S', occurredAt: '2026-08-22T08:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
      { vehicleType: '70', targetSlot: '8S', outcome: 'REJECTED', occurredAt: '2026-08-22T08:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' },
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId, 'manual-experience-disfavored');
});

test('stale actual state is never accepted as physical authority', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }, { actualStateFresh: false }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.status, 'REPLAN_REQUIRED');
  assert.equal(result.diagnosticCode, 'STALE_ACTUAL_STATE');
  assert.equal(result.plan, null);
  assert.equal(result.retainedIntents[0].originalTargetSlot, '8S');
});

test('fresh action readback fails closed when actual state is stale', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }),
    intents: [manual('70-11', '10S', '8S')],
  });
  const check = revalidateActionStep(
    result.plan,
    result.plan.steps[0].stepId,
    state({ '10S': '70-11' }, { actualStateFresh: false }),
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'STALE_ACTUAL_STATE');
});

test('future arrival readiness keeps the first card non-operative', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }, {
      currentOperationalTime: 100,
      arrivalReadiness: { '70-11': { ready: false, expectedAt: 130 } },
    }),
    intents: [manual('70-11', '10S', '8S')],
  });
  assert.equal(result.status, 'PLANNED');
  assert.equal(result.plan.steps[0].plannedWindowStart, 130);
  assert.equal(result.plan.steps[0].arrivalReady, false);
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.cards[0].status, 'WAITING_FOR_ARRIVAL');
  assert.equal(projection.cards[0].canComplete, false);
  assert.equal(projection.reservations.length, 0);
  assert.equal(projection.plannedResourceClaims.length, 1);
});

test('an anticipated Tursatt arrival can be planned without becoming actual placement', () => {
  const result = engine().plan({
    state: state({}, {
      currentOperationalTime: 100,
      arrivalReadiness: { '74-20': { ready: false, expectedAt: 130 } },
      anticipatedArrivals: { '74-20': { sourceSlot: '10S', expectedAt: 130, occurrenceId: '835-arrival-1' } },
    }),
    intents: [createShiftIntent({
      intentId: 'tursatt-future-835', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED',
      vehicle: '74-20', fromSlot: '10S', targetSlot: '8S', createdAt: '2026-08-22T10:00:00Z',
    })],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.initialActualOccupancy, {});
  assert.deepEqual(result.plan.initialPlanningOccupancy, { '10S': '74-20' });
  assert.equal(result.plan.safetyEvidence.anticipatedArrivalShadowCount, 1);
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.cards[0].status, 'WAITING_FOR_ARRIVAL');
  assert.equal(projection.cards[0].canComplete, false);
  assert.equal(projection.reservations.length, 0);
});

test('an anticipated arrival cannot overwrite a currently occupied source slot', () => {
  const result = engine().plan({
    state: state({ '10S': '74-99' }, {
      arrivalReadiness: { '74-20': { ready: false, expectedAt: 130 } },
      anticipatedArrivals: { '74-20': { sourceSlot: '10S', expectedAt: 130 } },
    }),
    intents: [createShiftIntent({
      intentId: 'tursatt-source-conflict', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED',
      vehicle: '74-20', fromSlot: '10S', targetSlot: '8S',
    })],
  });
  assert.equal(result.status, 'BLOCKED_UNRESOLVED');
  assert.match(result.reason, /Actual source mismatch/);
  assert.equal(result.plan, null);
});

test('future time window keeps the first card waiting until its earliest start', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11' }, { currentOperationalTime: 100 }),
    intents: [manual('70-11', '10S', '8S', { earliestStart: 130 })],
  });
  const projection = projectCanonicalPlan(result.plan);
  assert.equal(projection.cards[0].status, 'WAITING_FOR_TIME');
  assert.equal(projection.cards[0].canComplete, false);
  assert.equal(projection.reservations.length, 0);
});

test('a blocker explicitly free of recovery obligations may stay at a safe permanent target', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99' }, { flexiblePlacementVehicles: ['74-99'] }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => step.role), ['RELEASE', 'MAIN']);
  assert.equal(result.plan.moveCount, 2);
});

test('search evidence exposes deterministic transition-cache metrics', () => {
  const result = engine().plan({
    state: state({ '10S': '70-11', '10N': '74-99', '8S': '74-20' }),
    intents: [manual('70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  assert.equal(result.status, 'PLANNED');
  assert.ok(Number.isInteger(result.plan.searchEvidence.generatedTransitions));
  assert.ok(Number.isInteger(result.plan.searchEvidence.cacheHits));
  assert.ok(result.plan.searchEvidence.generatedTransitions >= result.plan.searchEvidence.expandedStates - 1);
});

test('relevant fresh arrival delay shifts the affected plan windows', () => {
  const first = engine().plan({
    state: state({ '10S': 'UNIT-A' }, { currentOperationalTime: 100, liveDataFresh: true }),
    intents: [manual('UNIT-A', '10S', '8S', { earliestStart: 110 })],
  });
  const second = engine().plan({
    state: state({ '10S': 'UNIT-A' }, {
      currentOperationalTime: 100,
      liveDataFresh: true,
      liveDelayMinutesByVehicle: { 'UNIT-A': 15 },
    }),
    intents: [manual('UNIT-A', '10S', '8S', { earliestStart: 110 })],
    previousPlan: first.plan,
    events: [{ type: 'LIVE_DELAY_CHANGED', vehicleId: 'UNIT-A' }],
  });
  assert.equal(second.status, 'REPLANNED');
  assert.equal(second.plan.steps[0].plannedWindowStart, 125);
});

test('irrelevant delay does not create a new plan revision', () => {
  const request = {
    state: state({ '10S': 'UNIT-A' }, { currentOperationalTime: 100, liveDataFresh: true }),
    intents: [manual('UNIT-A', '10S', '8S', { earliestStart: 110 })],
  };
  const first = engine().plan(request);
  const second = engine().plan({
    ...request,
    state: { ...request.state, liveDelayMinutesByVehicle: { 'UNIT-UNRELATED': 90 } },
    previousPlan: first.plan,
    events: [{ type: 'LIVE_DELAY_CHANGED', vehicleId: 'UNIT-UNRELATED' }],
  });
  assert.equal(second.status, 'NO_OP');
  assert.equal(second.plan.planRevision, first.plan.planRevision);
});

test('stale live delay cannot alter an existing canonical plan', () => {
  const request = {
    state: state({ '10S': 'UNIT-A' }, { currentOperationalTime: 100, liveDataFresh: true }),
    intents: [manual('UNIT-A', '10S', '8S', { earliestStart: 110 })],
  };
  const first = engine().plan(request);
  const second = engine().plan({
    ...request,
    state: {
      ...request.state,
      liveDataFresh: false,
      liveDelayMinutesByVehicle: { 'UNIT-A': 60 },
    },
    previousPlan: first.plan,
    events: [{ type: 'STALE_LIVE_DATA', vehicleId: 'UNIT-A' }],
  });
  assert.equal(second.status, 'NO_OP');
  assert.equal(second.plan.planRevision, first.plan.planRevision);
});

test('completed prefix remains historical evidence but is not recreated as an active card', () => {
  const first = engine().plan({
    state: state({ '10S': 'UNIT-A', '10N': 'UNIT-B' }),
    intents: [manual('UNIT-A', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const completedStep = first.plan.steps[0];
  const second = engine().plan({
    state: state({ '10S': 'UNIT-A', [completedStep.targetSlot]: 'UNIT-B' }, {
      actualStateRevision: 'actual-r2',
      completedStepIds: [completedStep.stepId],
      currentOperationalTime: completedStep.plannedWindowEnd,
    }),
    intents: [manual('UNIT-A', '10S', '8S', { preferredSourceEnd: 'north' })],
    previousPlan: first.plan,
    events: [{ type: 'STEP_COMPLETED', stepId: completedStep.stepId }],
  });
  const projection = projectCanonicalPlan(second.plan);
  assert.equal(second.plan.steps.find(step => step.stepId === completedStep.stepId).status, 'COMPLETED');
  assert.equal(projection.cards.some(card => card.stepId === completedStep.stepId), false);
  assert.equal(projection.overlays.some(overlay => overlay.stepId === completedStep.stepId), false);
  assert.equal(projection.cards.filter(card => card.status === 'READY').length, 1);
});

test('later suffix cards survive after the first Utført step is completed', () => {
  const first = engine().plan({
    state: state({ '10S': 'UNIT-A', '10N': 'UNIT-B' }),
    intents: [manual('UNIT-A', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const completed = first.plan.steps[0];
  const second = engine().plan({
    state: state({ '10S': 'UNIT-A', [completed.targetSlot]: 'UNIT-B' }, {
      actualStateRevision: 'actual-r2',
      completedStepIds: [completed.stepId],
      currentOperationalTime: completed.plannedWindowEnd,
    }),
    intents: first.plan.originalIntents,
    previousPlan: first.plan,
    events: [{ type: 'UTFORT', stepId: completed.stepId }],
  });
  const projection = projectCanonicalPlan(second.plan);
  const survivingSteps = second.plan.steps.filter(step => step.status !== 'COMPLETED');
  assert.ok(survivingSteps.length >= 2);
  assert.deepEqual(projection.cards.map(card => card.stepId), survivingSteps.map(step => step.stepId));
  assert.equal(projection.cards[0].status, 'READY');
  assert.ok(projection.cards.slice(1).every(card => card.status === 'WAITING_FOR_DEPENDENCY'));
});

test('superseded or non-active plan revisions cannot publish actionable projections', () => {
  const first = engine().plan({
    state: state({ '10S': 'UNIT-A' }),
    intents: [manual('UNIT-A', '10S', '8S')],
  });
  const second = engine().plan({
    state: state({ '10S': 'UNIT-A', '8S': 'UNIT-B' }),
    intents: [manual('UNIT-A', '10S', '8S')],
    previousPlan: first.plan,
    events: [{ type: 'TARGET_OCCUPIED' }],
  });
  const oldProjection = projectCanonicalPlan(first.plan, { activePlanRevision: second.plan.planRevision });
  const newProjection = projectCanonicalPlan(second.plan, { activePlanRevision: second.plan.planRevision });
  assert.equal(oldProjection.status, 'REJECTED');
  assert.equal(oldProjection.reason, 'PLAN_SUPERSEDED');
  assert.deepEqual(oldProjection.cards, []);
  assert.equal(newProjection.status, 'PROJECTED');
  assert.ok(newProjection.reservations.every(item => item.planRevision === second.plan.planRevision));
});

test('fresh action readback revalidates source and target approach occupancy', () => {
  const result = engine().plan({
    state: state({ '10S': 'UNIT-A' }),
    intents: [manual('UNIT-A', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  const check = revalidateActionStep(
    result.plan,
    result.plan.steps[0].stepId,
    state({ '10S': 'UNIT-A', '10N': 'UNIT-NEW-BLOCKER' }, { actualStateRevision: 'actual-r2' }),
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'SOURCE_ACCESS_CHANGED');
});

test('fresh action readback revalidates route-resource conflicts', () => {
  const result = engine().plan({
    state: state({ '10S': 'UNIT-A' }, { currentOperationalTime: 100 }),
    intents: [manual('UNIT-A', '10S', '8S')],
  });
  const step = result.plan.steps[0];
  const check = revalidateActionStep(
    result.plan,
    step.stepId,
    state({ '10S': 'UNIT-A' }, {
      actualStateRevision: 'actual-r2',
      routeReservations: [{
        resource: step.routeResources[0],
        timeWindow: { start: step.plannedWindowStart, end: step.plannedWindowEnd },
      }],
    }),
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'ROUTE_RESOURCE_CONFLICT');
});
