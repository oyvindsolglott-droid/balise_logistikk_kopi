const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const enginePath = path.resolve(__dirname, '../../sde_canonical_shift_engine.js');
const engineSource = fs.readFileSync(enginePath, 'utf8');

const slots = [
  { id: '1N', track: '1', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '1S', track: '1', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '3N', track: '3', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '4M', track: '4', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '5M', track: '5', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '6S', track: '6', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '7S', track: '7', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '8S', track: '8', order: 0, role: 'workshop', accessEnds: ['south'] },
  { id: '8N', track: '8', order: 1, role: 'workshop', accessEnds: ['south'] },
  { id: '9', track: '9', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '10S', track: '10', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '10N', track: '10', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '11S', track: '11', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '11N', track: '11', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '12S', track: '12', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: '12N', track: '12', order: 1, role: 'ordinary', accessEnds: ['south', 'north'] },
  { id: 'VN', track: 'V', order: 0, role: 'temporary_relief', accessEnds: ['south'] },
  { id: 'VS', track: 'V', order: 1, role: 'route_resource', accessEnds: ['south'] },
];

function replaceExactly(source, from, to) {
  const first = source.indexOf(from);
  assert.notEqual(first, -1, `mutation anchor missing: ${from}`);
  assert.equal(source.indexOf(from, first + from.length), -1, `mutation anchor is ambiguous: ${from}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function load(source) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, queueMicrotask, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'sde_canonical_shift_engine.mutant.js', timeout: 1000 });
  return module.exports;
}

const original = load(engineSource);

function makeEngine(api, boundary = {}) {
  return api.createShiftEngine({
    slotCatalog: slots,
    boundary: {
      maxStates: 250000,
      maxWallTimeMs: 1800,
      maxConnectedVehicles: 16,
      maxConnectedSlots: 31,
      maxPlanSteps: null,
      maxBranchingFactor: 31,
      ...boundary,
    },
  });
}

function state(occupancy, extra = {}) {
  return { actualStateRevision: extra.actualStateRevision || 'actual-r1', occupancy, unavailableSlots: [], routeReservations: [], ...extra };
}

function intent(api, vehicle, fromSlot, targetSlot, extra = {}) {
  return api.createShiftIntent({
    intentId: extra.intentId || `manual|${vehicle}|${fromSlot}|${targetSlot}`,
    sourceType: extra.sourceType || 'MANUAL',
    authority: extra.authority || 'HUMAN_MANUAL',
    priorityClass: extra.priorityClass || 'P1_MANUAL',
    vehicle,
    fromSlot,
    targetSlot,
    createdAt: extra.createdAt || '2026-08-22T10:00:00.000Z',
    ...extra,
  });
}

async function kill(id, mutate, probe) {
  test(id, async () => {
    assert.equal(await probe(original), true, `${id}: control probe must pass`);
    const mutant = load(mutate(engineSource));
    let survived = false;
    try {
      survived = await probe(mutant);
    } catch {
      survived = false;
    }
    assert.equal(survived, false, `${id}: mutant survived`);
  });
}

const priorityProbe = (left, right) => api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '11S': '74-11' }),
    intents: [
      intent(api, '70-11', '10S', '8S', left),
      intent(api, '74-11', '11S', '12S', right),
    ],
  });
  return result.plan.steps.filter(step => step.role === 'MAIN')[0].intentId === left.intentId;
};

kill('MANUAL_PRIORITY_BELOW_SDE', source => replaceExactly(source, 'P1_MANUAL: 1,', 'P1_MANUAL: 4,'), priorityProbe(
  { intentId: 'manual', priorityClass: 'P1_MANUAL' },
  { intentId: 'derived', sourceType: 'SDE_DERIVED', authority: 'SDE_ADVISORY', priorityClass: 'P2_SDE_DERIVED' },
));

kill('SDE_PRIORITY_BELOW_WRITTEN_INVERTED', source => replaceExactly(source, 'P2_SDE_DERIVED: 2,', 'P2_SDE_DERIVED: 4,'), priorityProbe(
  { intentId: 'derived', sourceType: 'SDE_DERIVED', authority: 'SDE_ADVISORY', priorityClass: 'P2_SDE_DERIVED' },
  { intentId: 'written', sourceType: 'CONFIRMED_WRITTEN_PLAN', authority: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN' },
));

kill('WRITTEN_PLAN_OVERRIDES_MANUAL', source => replaceExactly(source, 'P3_CONFIRMED_WRITTEN_PLAN: 3,', 'P3_CONFIRMED_WRITTEN_PLAN: 0,'), priorityProbe(
  { intentId: 'manual', priorityClass: 'P1_MANUAL' },
  { intentId: 'written', sourceType: 'CONFIRMED_WRITTEN_PLAN', authority: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN' },
));

kill('HARD_CODED_THREE_STEP_LIMIT', source => replaceExactly(source, 'maxPlanSteps: null,', 'maxPlanSteps: 3,'), api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '10N': '74-99', '8S': '74-20', '8N': '74-21' }),
    intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  return result.status === 'PLANNED' && result.plan.steps.length > 3 && api.SEARCH_BOUNDARY_CONTRACT.maxPlanSteps === null;
});

kill('SEARCH_RETURNS_AFTER_FIRST_CANDIDATE', source => replaceExactly(source, 'return evaluations;\n  }', 'return evaluations.slice(0, 1);\n  }'), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11', '8S': '74-20' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.diagnostics.candidateEvaluations.length === slots.length && result.diagnostics.searchStoppedAfterFirstCandidate === false;
});

kill('ONE_N_GLOBAL_FALLBACK_REINTRODUCED', source => replaceExactly(source,
  'Number(right.eligible) - Number(left.eligible)\n      || right.humanExperienceScore',
  "Number(right.slot === '1N') - Number(left.slot === '1N')\n      || Number(right.eligible) - Number(left.eligible)\n      || right.humanExperienceScore"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11', '8S': '74-20' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.status === 'PLANNED' && result.plan.steps[0].targetSlot !== '1N';
});

kill('VN_REMOVED_FROM_CANDIDATES', source => replaceExactly(source, 'return evaluations;\n  }', "return evaluations.filter(item => item.slot !== 'VN');\n  }"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11', '8S': '74-20' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.diagnostics.candidateEvaluations.some(item => item.slot === 'VN') && result.diagnostics.vnComparedWithOrdinaryRelief;
});

kill('SAFE_LOW_SCORE_CANDIDATE_REJECTED', source => replaceExactly(source,
  'eligible: move.hardSafe && roleAllowed,',
  'eligible: move.hardSafe && roleAllowed && score >= 0,'), api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '8S': '74-20' }),
    intents: [intent(api, '70-11', '10S', '8S')],
    humanExperienceEvidence: [{ vehicleId: '74-20', targetSlot: '1N', outcome: 'REJECTED', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' }],
  });
  const candidate = result.diagnostics.candidateEvaluations.find(item => item.slot === '1N');
  return candidate.hardSafe && candidate.eligible && candidate.humanExperienceScore < 0;
});

kill('SCORE_THRESHOLD_RETURNS_UAVKLART', source => replaceExactly(source,
  'eligible: move.hardSafe && roleAllowed,',
  'eligible: move.hardSafe && roleAllowed && score > 0,'), api => {
  const evidence = slots.map(slot => ({ vehicleId: '74-20', targetSlot: slot.id, outcome: 'REJECTED', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' }));
  return makeEngine(api).plan({ state: state({ '10S': '70-11', '8S': '74-20' }), intents: [intent(api, '70-11', '10S', '8S')], humanExperienceEvidence: evidence }).status === 'PLANNED';
});

kill('FUTURE_OCCUPIED_TARGET_MARKED_READY', source => replaceExactly(source,
  "if (!firstPending || firstPending.stepId !== step.stepId) return 'WAITING_FOR_DEPENDENCY';",
  "if (!firstPending) return 'WAITING_FOR_DEPENDENCY';"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11', '10N': '74-99' }), intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })] });
  const planAtFutureTime = JSON.parse(JSON.stringify(result.plan));
  planAtFutureTime.steps.forEach(step => { step.currentOperationalTime = 999; });
  const projection = api.projectCanonicalPlan(planAtFutureTime);
  return projection.cards.filter(card => card.status === 'READY').length === 1 && projection.reservations.length === 1;
});

kill('FUTURE_TARGET_NOT_REVALIDATED', source => replaceExactly(source,
  "if (occupancy[step.targetSlot]) return deepFreeze({ ok: false, code: 'TARGET_CHANGED', reason: 'Fresh actual target is occupied.' });",
  "if (false && occupancy[step.targetSlot]) return deepFreeze({ ok: false, code: 'TARGET_CHANGED', reason: 'Fresh actual target is occupied.' });"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  const check = api.revalidateActionStep(result.plan, result.plan.steps[0].stepId, state({ '10S': '70-11', '8S': '74-20' }));
  return check.ok === false && check.code === 'TARGET_CHANGED';
});

kill('ONLY_FIRST_BLOCKER_MOVED', source => replaceExactly(source,
  "const blockers = getRelevantBlockers(node, intent, context);\n      return removeCancelledSupportTransitions(generateReliefMoves(node, blockers, intents, context, 'RELEASE', intent.intentId), context);",
  "if (node.path.some(move => move.role === 'RELEASE')) return [];\n      const blockers = getRelevantBlockers(node, intent, context);\n      return removeCancelledSupportTransitions(generateReliefMoves(node, blockers, intents, context, 'RELEASE', intent.intentId), context);"), api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '10N': '74-99', '8S': '74-20', '8N': '74-21' }),
    intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  return result.status === 'PLANNED' && result.plan.steps.filter(step => step.role === 'RELEASE').length > 1;
});

kill('RECOVERY_ALWAYS_FORCED', source => replaceExactly(source,
  'if (flexiblePlacementVehicles.has(vehicle)) return true;',
  'if (false && flexiblePlacementVehicles.has(vehicle)) return true;'), api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '10N': '74-99' }, { flexiblePlacementVehicles: ['74-99'] }),
    intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })],
  });
  return result.status === 'PLANNED' && result.plan.steps.map(step => step.role).join(',') === 'RELEASE,MAIN';
});

kill('RECOVERY_ALWAYS_DROPPED', source => replaceExactly(source,
  'return node.occupancy[slot] === vehicle;\n    });',
  'return true;\n    });'), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11', '10N': '74-99' }), intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })] });
  return result.status === 'PLANNED' && result.plan.steps.map(step => step.role).join(',') === 'RELEASE,MAIN,RECOVERY';
});

kill('MANUAL_INTENT_LOST_ON_REPLAN', source => replaceExactly(source,
  'const retainedIntents = normalizeIntents(latest.intents).filter(intent => !cancelledIntentIds.has(intent.intentId));',
  'const retainedIntents = events.length ? [] : normalizeIntents(latest.intents).filter(intent => !cancelledIntentIds.has(intent.intentId));'), async api => {
  const replanner = api.createShiftReplanner(makeEngine(api));
  const first = await replanner.submit({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  const result = await replanner.submit({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')], previousPlan: first.plan, events: [{ type: 'CARD_CANCELLED', stepId: first.plan.steps[0].stepId }] });
  return result.retainedIntents.length === 1;
});

kill('CARD_CANCEL_DELETES_PARENT_INTENT', source => replaceExactly(source,
  "events.filter(event => event.type === 'MANUAL_INTENT_CANCELLED')",
  "events.filter(event => event.type === 'MANUAL_INTENT_CANCELLED' || event.type === 'CARD_CANCELLED')"), async api => {
  const replanner = api.createShiftReplanner(makeEngine(api));
  const shiftIntent = intent(api, '70-11', '10S', '8S');
  const first = await replanner.submit({ state: state({ '10S': '70-11' }), intents: [shiftIntent] });
  const result = await replanner.submit({ state: state({ '10S': '70-11' }), intents: [shiftIntent], previousPlan: first.plan, events: [{ type: 'CARD_CANCELLED', intentId: shiftIntent.intentId }] });
  return result.retainedIntents.length === 1;
});

kill('CANCELLED_SUPPORT_TRANSITION_REUSED', source => replaceExactly(source,
  'return (Array.isArray(moves) ? moves : []).filter(move => !rejected.has(supportTransitionKey(move)));',
  'return (Array.isArray(moves) ? moves : []);'), api => {
  const planner = makeEngine(api);
  const actual = state({ '10S': '70-11', '10N': '74-99' });
  const parentIntent = intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' });
  const first = planner.plan({ state: actual, intents: [parentIntent] });
  const cancelledSupport = first.plan.steps.find(step => step.role === 'RELEASE');
  if (!cancelledSupport) return false;
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
    }],
  });
  const replacementSupport = replanned.plan && replanned.plan.steps.find(step => step.role === 'RELEASE');
  return Boolean(replacementSupport && replacementSupport.targetSlot !== cancelledSupport.targetSlot);
});

kill('COMPLETED_PREFIX_REPLANNED', source => replaceExactly(source,
  "const completedPrefix = input.previousPlan ? input.previousPlan.steps.filter(step => completedIds.has(step.stepId) || step.status === 'COMPLETED') : [];",
  'const completedPrefix = [];'), api => {
  const shiftIntent = intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' });
  const first = makeEngine(api).plan({ state: state({ '10S': '70-11', '10N': '74-99' }), intents: [shiftIntent] });
  const released = first.plan.steps[0];
  const next = makeEngine(api).plan({ state: state({ '10S': '70-11', [released.targetSlot]: '74-99' }, { completedStepIds: [released.stepId] }), intents: [shiftIntent], previousPlan: first.plan, events: [{ type: 'STEP_COMPLETED', stepId: released.stepId }] });
  return next.plan.steps[0].stepId === released.stepId && next.plan.steps[0].status === 'COMPLETED';
});

kill('OLD_RESERVATION_SURVIVES_NEW_REVISION', source => replaceExactly(source,
  'const planRevision = `shift-plan-v1|${stableHash(planWithoutRevision)}`;',
  'const planRevision = input.previousPlan ? input.previousPlan.planRevision : `shift-plan-v1|${stableHash(planWithoutRevision)}`;'), api => {
  const shiftIntent = intent(api, '70-11', '10S', '8S');
  const first = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [shiftIntent] });
  const next = makeEngine(api).plan({ state: state({ '10S': '70-11', '8S': '74-20' }), intents: [shiftIntent], previousPlan: first.plan, events: [{ type: 'TARGET_OCCUPIED' }] });
  return next.plan.planRevision !== first.plan.planRevision;
});

kill('PARTIAL_PLAN_PUBLISHED', source => replaceExactly(source,
  'if (!validation.ok) return rejected(validation.reason);',
  'if (false && !validation.ok) return rejected(validation.reason);'), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  const corrupt = JSON.parse(JSON.stringify(result.plan));
  corrupt.steps[0].dependencyIds = ['missing-step'];
  const projection = api.projectCanonicalPlan(corrupt);
  return projection.status === 'REJECTED' && projection.cards.length === 0 && projection.reservations.length === 0;
});

kill('POLLING_DUPLICATES_OBLIGATIONS', source => replaceExactly(source,
  'return steps.map(step => deepFreeze({',
  'return [...steps, ...steps].map(step => deepFreeze({'), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.plan.obligations.length === result.plan.steps.length && new Set(result.plan.obligations.map(item => item.obligationId)).size === result.plan.obligations.length;
});

kill('FULL_COMPLETED_CARD_RECREATED', source => replaceExactly(source,
  "const cards = plan.steps.filter(step => step.status !== 'COMPLETED').map(step => {",
  'const cards = plan.steps.map(step => {'), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  const completed = JSON.parse(JSON.stringify(result.plan));
  completed.steps[0].status = 'COMPLETED';
  return api.projectCanonicalPlan(completed).cards.length === 0;
});

kill('INPUT_HASH_UNCHANGED_CREATES_REVISION', source => replaceExactly(source,
  'if (input.previousPlan && input.previousPlan.inputHash === inputHash) {',
  'if (false && input.previousPlan && input.previousPlan.inputHash === inputHash) {'), api => {
  const shiftIntent = intent(api, '70-11', '10S', '8S');
  const first = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [shiftIntent] });
  const next = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [shiftIntent], previousPlan: first.plan });
  return next.status === 'NO_OP' && next.plan.planRevision === first.plan.planRevision;
});

kill('STALE_REPLAN_OVERWRITES_NEWER_PLAN', source => replaceExactly(source,
  'const latest = batch[batch.length - 1].input;',
  'const latest = batch[0].input;'), async api => {
  const replanner = api.createShiftReplanner(makeEngine(api));
  const shiftIntent = intent(api, '70-11', '10S', '8S');
  const oldInput = { state: state({ '10S': '70-11' }, { actualStateRevision: 'old' }), intents: [shiftIntent] };
  const newInput = { state: state({ '10S': '70-11', '8S': '74-20' }, { actualStateRevision: 'new' }), intents: [shiftIntent] };
  const results = await Promise.all([replanner.submit(oldInput), replanner.submit(newInput)]);
  return results.every(result => result.plan.actualStateRevision === 'new' && result.plan.steps.length > 1);
});

kill('HUMAN_EXPERIENCE_OVERRIDES_HARD_GATE', source => replaceExactly(source,
  'eligible: move.hardSafe && roleAllowed,',
  'eligible: (move.hardSafe && roleAllowed) || score > 0,'), api => {
  const result = makeEngine(api).plan({
    state: state({ '10S': '70-11', '8S': '74-20' }, { unavailableSlots: ['1N'] }),
    intents: [intent(api, '70-11', '10S', '8S')],
    humanExperienceEvidence: [{ vehicleId: '74-20', targetSlot: '1N', outcome: 'SUCCESS', occurredAt: '2026-08-22T09:00:00Z', provenance: 'AUTHORITATIVE_EXECUTED_RESULT' }],
  });
  const candidate = result.diagnostics.candidateEvaluations.find(item => item.slot === '1N');
  return candidate.hardSafe === false && candidate.eligible === false;
});

kill('HUMAN_EXPERIENCE_OVERRIDES_MANUAL_PRIORITY', source => replaceExactly(source,
  'priorityValue(left) - priorityValue(right)',
  '(Number(right.metadata && right.metadata.HumanExperienceScore) || 0) - (Number(left.metadata && left.metadata.HumanExperienceScore) || 0)\n      || priorityValue(left) - priorityValue(right)'), priorityProbe(
  { intentId: 'manual', priorityClass: 'P1_MANUAL', metadata: { HumanExperienceScore: -1 } },
  { intentId: 'derived', sourceType: 'SDE_DERIVED', authority: 'SDE_ADVISORY', priorityClass: 'P2_SDE_DERIVED', metadata: { HumanExperienceScore: 999 } },
));

kill('VEHICLE_ID_CHANGES_POLICY', source => replaceExactly(source,
  "if (!source || !target) return { hardSafe: false, code: 'UNKNOWN_SLOT' };",
  "if (token === '70-11' && target.id === '8S') return { hardSafe: false, code: 'VEHICLE_SPECIFIC_POLICY' };\n    if (!source || !target) return { hardSafe: false, code: 'UNKNOWN_SLOT' };"), api => {
  const structure = vehicle => {
    const result = makeEngine(api).plan({ state: state({ '10S': vehicle }), intents: [intent(api, vehicle, '10S', '8S')] });
    return result.status === 'PLANNED' ? result.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]).join('|') : result.status;
  };
  return structure('70-11') === structure('70-12');
});

kill('SEARCH_LIMIT_REPORTED_AS_NO_SAFE_PLAN', source => replaceExactly(source,
  "return deepFreeze({ status: 'SEARCH_BOUNDARY_EXHAUSTED', diagnosticCode: 'SEARCH_LIMIT_REACHED'",
  "return deepFreeze({ status: 'BLOCKED_UNRESOLVED', diagnosticCode: 'NO_SAFE_PLAN'"), api => {
  const result = makeEngine(api, { maxStates: 1 }).plan({ state: state({ '10S': '70-11', '10N': '74-99' }), intents: [intent(api, '70-11', '10S', '8S', { preferredSourceEnd: 'north' })] });
  return result.status === 'SEARCH_BOUNDARY_EXHAUSTED' && result.diagnosticCode === 'SEARCH_LIMIT_REACHED';
});

kill('SEARCH_LIMIT_CHANGED_TO_PASS_TESTS', source => replaceExactly(source, 'maxStates: 250000,', 'maxStates: 250001,'), api => api.SEARCH_BOUNDARY_CONTRACT.maxStates === 250000);

kill('REGRESSION_70_11_INTENT_DROPPED', source => replaceExactly(source,
  'let intents = normalizeIntents(input && input.intents);',
  "let intents = normalizeIntents(input && input.intents).filter(intent => intent.vehicle !== '70-11');"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.status === 'PLANNED' && result.retainedIntents.length === 1 && result.plan.steps.length === 1;
});

kill('REGRESSION_70_11_CANDIDATE_ARRAY_EMPTY_SILENTLY', source => replaceExactly(source,
  'const candidateEvaluations = candidateSubject ? evaluateCandidateSet(candidateSubject, initialOccupancy, context) : derived.diagnostics;',
  "const candidateEvaluations = candidateSubjectIntent && candidateSubjectIntent.vehicle === '70-11' ? [] : (candidateSubject ? evaluateCandidateSet(candidateSubject, initialOccupancy, context) : derived.diagnostics);"), api => {
  const result = makeEngine(api).plan({ state: state({ '10S': '70-11' }), intents: [intent(api, '70-11', '10S', '8S')] });
  return result.diagnostics.evaluatedSlotCount === slots.length && result.diagnostics.candidateEvaluations.length === slots.length;
});

kill('REGRESSION_70_11_VEHICLE_SPECIFIC_BRANCH_ADDED', source => replaceExactly(source,
  'const currentSource = getVehicleSlot(node.occupancy, intent.vehicle);',
  "if (intent.vehicle === '70-11') return [];\n      const currentSource = getVehicleSlot(node.occupancy, intent.vehicle);"), api => {
  const structures = ['70-11', '70-12', '74-99', '75-76'].map(vehicle => {
    const result = makeEngine(api).plan({ state: state({ '10S': vehicle }), intents: [intent(api, vehicle, '10S', '8S')] });
    return result.status === 'PLANNED' ? result.plan.steps.map(step => `${step.role}:${step.sourceSlot}:${step.targetSlot}`).join('|') : result.status;
  });
  return new Set(structures).size === 1;
});

function rollbackContractAccepts(text) {
  return /git\(clone, 'revert', '--no-edit', commit\)/.test(text)
    && !/git\([^\n]*'(?:reset|rebase)'/.test(text)
    && !/git\([^\n]*'--force(?:-with-lease)?'/.test(text)
    && /temporaryParent/.test(text);
}

const rollbackScript = fs.readFileSync(path.resolve(__dirname, '../../scripts/test-sde-canonical-shift-rollback.cjs'), 'utf8');

test('ROLLBACK_REQUIRES_RESET', () => {
  assert.equal(rollbackContractAccepts(rollbackScript), true);
  const mutant = rollbackScript.replace("git(clone, 'revert', '--no-edit', commit)", "git(clone, 'reset', '--hard', commit)");
  assert.equal(rollbackContractAccepts(mutant), false);
});

test('ROLLBACK_REQUIRES_FORCE', () => {
  assert.equal(rollbackContractAccepts(rollbackScript), true);
  const mutant = `${rollbackScript}\ngit(clone, 'push', '--force');`;
  assert.equal(rollbackContractAccepts(mutant), false);
});
