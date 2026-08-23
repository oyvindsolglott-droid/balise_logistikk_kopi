const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  createShiftEngine,
  createShiftIntent,
  createShiftReplanner,
  projectCanonicalPlan,
} = require('../../sde_canonical_shift_engine.js');

function simpleCatalog(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `S${index + 1}`,
    track: `T${index + 1}`,
    order: 0,
    role: 'ordinary',
    accessEnds: ['south', 'north'],
  }));
}

function intent(vehicleId, sourceSlot, targetSlot, extra = {}) {
  return createShiftIntent({
    intentId: extra.intentId || `intent|${vehicleId}|${sourceSlot}|${targetSlot}`,
    sourceType: extra.sourceType || 'MANUAL',
    priorityClass: extra.priorityClass || 'P1_MANUAL',
    vehicleId,
    requestedSource: sourceSlot,
    requestedTarget: targetSlot,
    createdAt: extra.createdAt || '2026-08-22T10:00:00.000Z',
    preferredSourceEnd: extra.preferredSourceEnd,
    preferredTargetEnd: extra.preferredTargetEnd,
  });
}

function signature(occupancy) {
  return JSON.stringify(Object.entries(occupancy).sort());
}

function exhaustiveMinimumMoves({ occupancy, slots, goal, flexibleVehicles = [] }) {
  const flexible = new Set(flexibleVehicles);
  const queue = [{ occupancy: { ...occupancy }, moves: 0 }];
  const visited = new Set([signature(occupancy)]);
  while (queue.length) {
    const current = queue.shift();
    if (Object.entries(goal).every(([vehicleId, targetSlot]) => current.occupancy[targetSlot] === vehicleId)) return current.moves;
    const emptySlots = slots.filter(slot => !current.occupancy[slot]);
    for (const [sourceSlot, vehicleId] of Object.entries(current.occupancy)) {
      if (!flexible.has(vehicleId) && !Object.hasOwn(goal, vehicleId)) continue;
      for (const targetSlot of emptySlots) {
        const next = { ...current.occupancy };
        delete next[sourceSlot];
        next[targetSlot] = vehicleId;
        const key = signature(next);
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ occupancy: next, moves: current.moves + 1 });
      }
    }
  }
  return null;
}

test('defined direct fixture equals the independent exhaustive oracle minimum', () => {
  const catalog = simpleCatalog(4);
  const occupancy = { S1: 'UNIT-A' };
  const oracle = exhaustiveMinimumMoves({ occupancy, slots: catalog.map(slot => slot.id), goal: { 'UNIT-A': 'S2' } });
  const result = createShiftEngine({ slotCatalog: catalog }).plan({
    state: { actualStateRevision: 'oracle-direct-r1', actualStateFresh: true, occupancy },
    intents: [intent('UNIT-A', 'S1', 'S2')],
  });
  assert.equal(oracle, 1);
  assert.equal(result.plan.moveCount, oracle);
  assert.equal(result.plan.searchEvidence.optimalityStatus, 'PROVEN');
});

test('defined occupied-target fixture equals the independent exhaustive oracle minimum', () => {
  const catalog = simpleCatalog(5);
  const occupancy = { S1: 'UNIT-A', S2: 'UNIT-B' };
  const oracle = exhaustiveMinimumMoves({
    occupancy,
    slots: catalog.map(slot => slot.id),
    goal: { 'UNIT-A': 'S2' },
    flexibleVehicles: ['UNIT-B'],
  });
  const result = createShiftEngine({ slotCatalog: catalog }).plan({
    state: {
      actualStateRevision: 'oracle-blocker-r1',
      actualStateFresh: true,
      occupancy,
      flexiblePlacementVehicles: ['UNIT-B'],
    },
    intents: [intent('UNIT-A', 'S1', 'S2')],
  });
  assert.equal(oracle, 2);
  assert.equal(result.plan.moveCount, oracle);
  assert.deepEqual(result.plan.steps.map(step => step.role), ['RELEASE', 'MAIN']);
});

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measureFixture(name, buildInput, samples = 40) {
  const input = buildInput();
  const planner = createShiftEngine({ slotCatalog: input.catalog });
  for (let index = 0; index < 5; index += 1) planner.plan(input.request);
  const durations = [];
  let last = null;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    last = planner.plan(input.request);
    durations.push(performance.now() - started);
  }
  const metrics = {
    name,
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maximumMs: Math.max(...durations),
    searchedStates: last.plan?.searchEvidence.expandedStates || last.diagnostics?.expandedStates || 0,
    cacheHits: last.plan?.searchEvidence.cacheHits || last.diagnostics?.cacheHits || 0,
    reusedPlanFragments: last.plan?.searchEvidence.reusedPlanFragments || 0,
    cancelledStaleJobs: 0,
    terminalPlanRevisions: 1,
    vehicleCount: Object.keys(input.request.state.occupancy || {}).length,
    slotCount: input.catalog.length,
    intentCount: input.request.intents.length,
  };
  assert.equal(last.status, 'PLANNED', JSON.stringify({ name, last }, null, 2));
  assert.ok(metrics.p95Ms <= 2000, JSON.stringify(metrics));
  return metrics;
}

test('locked performance fixtures remain inside the two-second p95 budget', (context) => {
  const cases = [
    ['direct', () => ({
      catalog: simpleCatalog(4),
      request: { state: { actualStateRevision: 'perf-direct', actualStateFresh: true, occupancy: { S1: 'UNIT-A' } }, intents: [intent('UNIT-A', 'S1', 'S2')] },
    })],
    ['one-blocker', () => ({
      catalog: simpleCatalog(6),
      request: { state: { actualStateRevision: 'perf-one', actualStateFresh: true, occupancy: { S1: 'UNIT-A', S2: 'UNIT-B' }, flexiblePlacementVehicles: ['UNIT-B'] }, intents: [intent('UNIT-A', 'S1', 'S2')] },
    })],
    ['two-blockers', () => {
      const catalog = [
        { id: 'A1', track: 'A', order: 0, role: 'ordinary', accessEnds: ['north'] },
        { id: 'A2', track: 'A', order: 1, role: 'ordinary', accessEnds: ['north'] },
        { id: 'B1', track: 'B', order: 0, role: 'ordinary', accessEnds: ['north'] },
        { id: 'B2', track: 'B', order: 1, role: 'ordinary', accessEnds: ['north'] },
        { id: 'R1', track: 'R1', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
        { id: 'R2', track: 'R2', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
        { id: 'R3', track: 'R3', order: 0, role: 'ordinary', accessEnds: ['south', 'north'] },
      ];
      return {
        catalog,
        request: {
          state: { actualStateRevision: 'perf-two', actualStateFresh: true, occupancy: { A1: 'UNIT-A', A2: 'UNIT-B', B2: 'UNIT-C' } },
          intents: [intent('UNIT-A', 'A1', 'B1', { preferredSourceEnd: 'north', preferredTargetEnd: 'north' })],
        },
      };
    }],
    ['five-intents', () => {
      const catalog = simpleCatalog(12);
      const occupancy = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`S${index + 1}`, `UNIT-${index + 1}`]));
      const intents = Array.from({ length: 5 }, (_, index) => intent(`UNIT-${index + 1}`, `S${index + 1}`, `S${index + 7}`, { createdAt: `2026-08-22T10:00:0${index}.000Z` }));
      return { catalog, request: { state: { actualStateRevision: 'perf-five', actualStateFresh: true, occupancy }, intents } };
    }],
    ['ten-intents-stress', () => {
      const catalog = simpleCatalog(22);
      const occupancy = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`S${index + 1}`, `UNIT-${index + 1}`]));
      const intents = Array.from({ length: 10 }, (_, index) => intent(`UNIT-${index + 1}`, `S${index + 1}`, `S${index + 12}`, { createdAt: `2026-08-22T10:00:${String(index).padStart(2, '0')}.000Z` }));
      return { catalog, request: { state: { actualStateRevision: 'perf-ten', actualStateFresh: true, occupancy }, intents } };
    }],
    ['manual-derived-written', () => ({
      catalog: simpleCatalog(8),
      request: {
        state: { actualStateRevision: 'perf-mixed', actualStateFresh: true, occupancy: { S1: 'UNIT-A', S2: 'UNIT-B', S3: 'UNIT-C' } },
        intents: [
          intent('UNIT-A', 'S1', 'S4', { intentId: 'manual', sourceType: 'MANUAL', priorityClass: 'P1_MANUAL' }),
          intent('UNIT-B', 'S2', 'S5', { intentId: 'derived', sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED' }),
          intent('UNIT-C', 'S3', 'S6', { intentId: 'written', sourceType: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN' }),
        ],
      },
    })],
  ];
  const results = cases.map(([name, factory]) => measureFixture(name, factory));
  context.diagnostic(JSON.stringify({ contract: 'SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1', results }));
  assert.ok(results.every(item => item.samples === 40));
});

test('manual intent reaches a visible plan inside the two-second p95 budget', (context) => {
  const catalog = simpleCatalog(6);
  const durations = [];
  for (let sample = 0; sample < 40; sample += 1) {
    const planner = createShiftEngine({ slotCatalog: catalog });
    const started = performance.now();
    const result = planner.plan({
      state: { actualStateRevision: `manual-visible-${sample}`, actualStateFresh: true, occupancy: { S1: 'UNIT-A' } },
      intents: [intent('UNIT-A', 'S1', 'S2')],
    });
    const projection = projectCanonicalPlan(result.plan);
    assert.equal(projection.cards.length, 1);
    durations.push(performance.now() - started);
  }
  const metrics = {
    fixtureId: 'manual-intent-to-visible-plan',
    samples: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maximumMs: Math.max(...durations),
  };
  context.diagnostic(JSON.stringify(metrics));
  assert.ok(metrics.p95Ms <= 2000, JSON.stringify(metrics));
});

test('fifty rapid events, unchanged polling and a stale queued calculation produce one terminal revision', async (context) => {
  const planner = createShiftEngine({ slotCatalog: simpleCatalog(8) });
  const replanner = createShiftReplanner(planner);
  const base = {
    state: { actualStateRevision: 'rapid-r1', actualStateFresh: true, occupancy: { S1: 'UNIT-A' } },
    intents: [intent('UNIT-A', 'S1', 'S2')],
  };
  const rapidStarted = performance.now();
  const rapid = await Promise.all(Array.from({ length: 50 }, (_, index) => replanner.submit({
    ...base,
    state: { ...base.state, actualStateRevision: `rapid-r${index + 1}` },
    events: [{ type: 'STATE_EVENT', index }],
  })));
  const rapidDuration = performance.now() - rapidStarted;
  assert.equal(new Set(rapid.map(item => item.plan?.planRevision).filter(Boolean)).size, 1);
  assert.equal(replanner.metrics.cancelledStaleJobs, 49);
  assert.equal(replanner.metrics.terminalPlanRevisions, 1);
  assert.equal(replanner.metrics.maximumParallelJobs, 1);
  assert.equal(replanner.metrics.duplicateTerminalRevisions, 0);

  const pollingStarted = performance.now();
  const polls = [];
  for (let index = 0; index < 50; index += 1) {
    polls.push(await replanner.submit({
      ...base,
      state: { ...base.state, actualStateRevision: `poll-r${index + 1}` },
      events: [{ type: 'UNCHANGED_POLL', index }],
    }));
  }
  const pollingDuration = performance.now() - pollingStarted;
  assert.ok(polls.every(item => item.status === 'NO_OP'));
  assert.equal(replanner.metrics.terminalPlanRevisions, 1);
  assert.equal(replanner.metrics.duplicateTerminalRevisions, 0);

  const stale = replanner.submit({
    state: { actualStateRevision: 'stale-calc', actualStateFresh: true, occupancy: { S1: 'UNIT-A', S4: 'UNIT-B' } },
    intents: [intent('UNIT-A', 'S1', 'S2', { intentId: 'stale-manual' })],
    events: [{ type: 'MANUAL_INTENT_CHANGED', revision: 'stale' }],
  });
  const newest = replanner.submit({
    state: { actualStateRevision: 'current-calc', actualStateFresh: true, occupancy: { S1: 'UNIT-A', S4: 'UNIT-B' } },
    intents: [
      intent('UNIT-A', 'S1', 'S2'),
      intent('UNIT-B', 'S4', 'S5', { intentId: 'current-manual-b', createdAt: '2026-08-22T10:01:00.000Z' }),
    ],
    events: [{ type: 'MANUAL_INTENT_CHANGED', revision: 'current' }],
  });
  const [staleResult, currentResult] = await Promise.all([stale, newest]);
  assert.equal(staleResult.plan.steps.at(-1).targetSlot, 'S5');
  assert.equal(currentResult.plan.steps.at(-1).targetSlot, 'S5');
  assert.equal(currentResult.plan.searchEvidence.reusedPendingPlanFragments, 1);
  assert.equal(replanner.metrics.cancelledStaleJobs, 50);
  assert.equal(replanner.metrics.terminalPlanRevisions, 2);
  assert.equal(replanner.metrics.reusedPlanFragments, 1);
  assert.equal(replanner.metrics.duplicateTerminalRevisions, 0);
  const metrics = {
    fixtureId: 'incremental-replanner-load',
    rapidEventCount: 50,
    rapidDurationMs: rapidDuration,
    unchangedPollCount: 50,
    unchangedPollingDurationMs: pollingDuration,
    searchedStates: currentResult.plan.searchEvidence.expandedStates,
    cacheHits: currentResult.plan.searchEvidence.cacheHits,
    reusedPlanFragments: replanner.metrics.reusedPlanFragments,
    cancelledStaleJobs: replanner.metrics.cancelledStaleJobs,
    terminalPlanRevisions: replanner.metrics.terminalPlanRevisions,
    maximumParallelJobs: replanner.metrics.maximumParallelJobs,
    duplicateTerminalRevisions: replanner.metrics.duplicateTerminalRevisions,
  };
  context.diagnostic(JSON.stringify(metrics));
  assert.ok(rapidDuration <= 2000, JSON.stringify(metrics));
});
