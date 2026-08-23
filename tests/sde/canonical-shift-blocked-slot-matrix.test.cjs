const test = require('node:test');
const assert = require('node:assert/strict');

const { createShiftEngine, createShiftIntent } = require('../../sde_canonical_shift_engine.js');
const { buildCanonicalSlotCatalog } = require('../../sde_canonical_shift_adapter.js');

const slotIds = ['1N', '1S', '2N', '2S', '3N', '3M', '3S', '4N', '4M', '4S', '5N', '5M', '5S', '6N', '6S', '6SS', '7N', '7S', '7SS', '8N', '8S', '8SS', '9', '10N', '10S', '11N', '11S', '12N', '12S', 'VN', 'VS'];
const trackOrders = {
  V: ['VS', 'VN'], 1: ['1S', '1N'], 2: ['2S', '2N'], 3: ['3S', '3M', '3N'],
  4: ['4S', '4M', '4N'], 5: ['5S', '5M', '5N'], 6: ['6SS', '6S', '6N'],
  7: ['7SS', '7S', '7N'], 8: ['8SS', '8S', '8N'], 9: ['9'],
  10: ['10S', '10N'], 11: ['11S', '11N'], 12: ['12S', '12N'],
};

const catalog = buildCanonicalSlotCatalog({
  slotIds,
  getTrack: slot => slot.startsWith('V') ? 'V' : slot.match(/^\d+/)[0],
  getTrackOrder: track => trackOrders[track] || [],
  getOpenEnds: track => track === 'V' || ['10', '11', '12'].includes(track) ? ['north'] : ['south', 'north'],
  getRole: slot => slot === 'VS' ? 'route_resource' : slot === 'VN' ? 'temporary_relief' : ['7N', '7S', '8N', '8S'].includes(slot) ? 'workshop' : 'ordinary',
});
const planner = createShiftEngine({ slotCatalog: catalog });

function manual(vehicleId, sourceSlot, targetSlot, extra = {}) {
  return createShiftIntent({
    intentId: `matrix|${vehicleId}|${sourceSlot}|${targetSlot}|${extra.caseId || 'case'}`,
    sourceType: 'MANUAL',
    priorityClass: 'P1_MANUAL',
    vehicleId,
    requestedSource: sourceSlot,
    requestedTarget: targetSlot,
    createdAt: '2026-08-22T10:00:00.000Z',
    ...extra,
  });
}

function plan(occupancy, shiftIntent, extraState = {}) {
  return planner.plan({
    state: { actualStateRevision: `matrix-${shiftIntent.intentId}`, actualStateFresh: true, occupancy, ...extraState },
    intents: [shiftIntent],
  });
}

function applyPlan(initial, steps) {
  const final = { ...initial };
  for (const step of steps) {
    assert.equal(final[step.sourceSlot], step.vehicleId, `predecessor state must contain ${step.vehicleId} at ${step.sourceSlot}`);
    assert.equal(final[step.targetSlot], undefined, `predecessor target ${step.targetSlot} must be empty`);
    delete final[step.sourceSlot];
    final[step.targetSlot] = step.vehicleId;
  }
  return final;
}

const blockedCases = [
  { slot: '4M', north: '4N', target: '5M', targetNorth: '5N' },
  { slot: '5M', north: '5N', target: '6S', targetNorth: '6N' },
  { slot: '6S', north: '6N', target: '4M', targetNorth: '4N' },
  { slot: '10S', north: '10N', target: '11S', targetNorth: '11N' },
  { slot: '11S', north: '11N', target: '12S', targetNorth: '12N' },
  { slot: '12S', north: '12N', target: '10S', targetNorth: '10N' },
];

for (const fixture of blockedCases) {
  test(`${fixture.slot} blocked-source and target-access matrix creates only complete canonical chains`, () => {
    const sourceBlockedOccupancy = { [fixture.slot]: 'UNIT-MAIN', [fixture.north]: 'UNIT-SOURCE-BLOCKER' };
    const sourceBlocked = plan(
      sourceBlockedOccupancy,
      manual('UNIT-MAIN', fixture.slot, '1N', { caseId: 'source', preferredSourceEnd: 'north' }),
    );
    assert.equal(sourceBlocked.status, 'PLANNED', JSON.stringify(sourceBlocked, null, 2));
    assert.deepEqual(sourceBlocked.plan.steps.map(step => step.role), ['RELEASE', 'MAIN', 'RECOVERY']);
    assert.equal(applyPlan(sourceBlockedOccupancy, sourceBlocked.plan.steps)['1N'], 'UNIT-MAIN');

    const targetBlockedOccupancy = { '1N': 'UNIT-MAIN', [fixture.north]: 'UNIT-TARGET-BLOCKER' };
    const targetBlocked = plan(
      targetBlockedOccupancy,
      manual('UNIT-MAIN', '1N', fixture.slot, { caseId: 'target', preferredTargetEnd: 'north' }),
    );
    assert.equal(targetBlocked.status, 'PLANNED', JSON.stringify(targetBlocked, null, 2));
    assert.deepEqual(targetBlocked.plan.steps.map(step => step.role), ['RELEASE', 'MAIN', 'RECOVERY']);
    const targetFinal = applyPlan(targetBlockedOccupancy, targetBlocked.plan.steps);
    assert.equal(targetFinal[fixture.slot], 'UNIT-MAIN');
    assert.equal(targetFinal[fixture.north], 'UNIT-TARGET-BLOCKER');

    const twoBlockerOccupancy = {
      [fixture.slot]: 'UNIT-MAIN',
      [fixture.north]: 'UNIT-SOURCE-BLOCKER',
      [fixture.targetNorth]: 'UNIT-TARGET-BLOCKER',
    };
    const twoBlockers = plan(
      twoBlockerOccupancy,
      manual('UNIT-MAIN', fixture.slot, fixture.target, {
        caseId: 'two-blockers',
        preferredSourceEnd: 'north',
        preferredTargetEnd: 'north',
      }),
    );
    assert.equal(twoBlockers.status, 'PLANNED', JSON.stringify(twoBlockers, null, 2));
    assert.ok(twoBlockers.plan.steps.filter(step => step.role === 'RELEASE').length >= 2);
    assert.ok(twoBlockers.plan.steps.length >= 5);
    const final = applyPlan(twoBlockerOccupancy, twoBlockers.plan.steps);
    assert.equal(final[fixture.target], 'UNIT-MAIN');
    assert.equal(final[fixture.north], 'UNIT-SOURCE-BLOCKER');
    assert.equal(final[fixture.targetNorth], 'UNIT-TARGET-BLOCKER');
    assert.equal(new Set(Object.values(final)).size, Object.values(final).length, 'no vehicle may be duplicated');

    const vn = twoBlockers.diagnostics.candidateEvaluations.find(item => item.slot === 'VN');
    const vs = twoBlockers.diagnostics.candidateEvaluations.find(item => item.slot === 'VS');
    assert.equal(vn.considered, true);
    assert.equal(vs.hardSafe, false);
  });
}

for (const target of ['11N', '9', '3N']) {
  test(`VN to ${target} is a direct canonical MAIN move`, () => {
    const result = plan({ VN: 'UNIT-V' }, manual('UNIT-V', 'VN', target, { caseId: `vn-${target}` }));
    assert.equal(result.status, 'PLANNED');
    assert.deepEqual(result.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]), [['MAIN', 'VN', target]]);
  });
}

test('12N to 6S with 6N and 6SS occupied selects one safe approach without dropping the intent', () => {
  const occupancy = { '12N': 'UNIT-MAIN', '6N': 'UNIT-NORTH', '6SS': 'UNIT-SOUTH' };
  const result = plan(occupancy, manual('UNIT-MAIN', '12N', '6S', { caseId: 'legacy-12n-6s' }));
  assert.equal(result.status, 'PLANNED', JSON.stringify(result, null, 2));
  assert.ok(result.plan.steps.length >= 3);
  assert.equal(result.plan.steps.filter(step => step.role === 'RELEASE').length, 1);
  assert.equal(applyPlan(occupancy, result.plan.steps)['6S'], 'UNIT-MAIN');
});

test('11S to 10S with occupied 10N releases the target approach first', () => {
  const occupancy = { '11S': 'UNIT-MAIN', '10N': 'UNIT-BLOCKER' };
  const result = plan(occupancy, manual('UNIT-MAIN', '11S', '10S', { caseId: 'legacy-11s-10s' }));
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.steps.map(step => step.role), ['RELEASE', 'MAIN', 'RECOVERY']);
});

test('5M to 6S with blocked source and target access is not truncated to three steps', () => {
  const occupancy = { '5M': 'UNIT-MAIN', '5N': 'UNIT-SOURCE', '6N': 'UNIT-TARGET' };
  const result = plan(occupancy, manual('UNIT-MAIN', '5M', '6S', {
    caseId: 'legacy-5m-6s',
    preferredSourceEnd: 'north',
    preferredTargetEnd: 'north',
  }));
  assert.equal(result.status, 'PLANNED', JSON.stringify(result, null, 2));
  assert.ok(result.plan.steps.length >= 5);
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN').length, 1);
});
