const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createShiftEngine } = require('../../sde_canonical_shift_engine.js');
const {
  PRODUCER_CONTRACTS,
  buildCanonicalSlotCatalog,
  classifyLegacyShiftNeed,
  buildCanonicalProducerRequest,
  buildCanonicalProducerRequests,
  adaptShiftNeed,
  planCanonicalShiftNeeds,
  buildCanonicalShadowProjection,
  buildCanonicalProductProjection,
  revalidateCanonicalProductAction,
  createCanonicalShiftRuntime,
  toLegacyCandidateRows,
} = require('../../sde_canonical_shift_adapter.js');

const slotIds = ['1N', '1S', '2N', '2S', '3N', '3M', '3S', '4N', '4M', '4S', '5N', '5M', '5S', '6N', '6S', '6SS', '7N', '7S', '7SS', '8N', '8S', '8SS', '9', '10N', '10S', '11N', '11S', '12N', '12S', 'VN', 'VS'];

function catalog() {
  return buildCanonicalSlotCatalog({
    slotIds,
    getTrack: slot => slot.startsWith('V') ? 'V' : (slot.match(/^\d+/)?.[0] || slot),
    getTrackOrder: track => ({
      V: ['VS', 'VN'], 3: ['3S', '3M', '3N'], 4: ['4S', '4M', '4N'], 5: ['5S', '5M', '5N'],
      6: ['6SS', '6S', '6N'], 7: ['7SS', '7S', '7N'], 8: ['8SS', '8S', '8N'], 10: ['10S', '10N'],
      11: ['11S', '11N'], 12: ['12S', '12N'],
    }[track] || [track]),
    getOpenEnds: track => track === 'V' || ['10', '11', '12'].includes(track) ? ['north'] : ['south', 'north'],
    getRole: slot => slot === 'VS' ? 'route_resource' : slot === 'VN' ? 'temporary_relief' : ['7N', '7S', '8N', '8S'].includes(slot) ? 'workshop' : 'ordinary',
  });
}

test('one canonical catalog contains the complete established 31-slot set', () => {
  const result = catalog();
  assert.equal(result.length, 31);
  assert.deepEqual(result.map(item => item.id).sort(), [...slotIds].sort());
  assert.equal(result.find(item => item.id === 'VN').role, 'temporary_relief');
  assert.equal(result.find(item => item.id === 'VS').role, 'route_resource');
});

test('legacy compatibility adapter classifies every required producer family', () => {
  const cases = [
    [{ sdeCanonicalGraphicDragOrder: true }, 'MANUAL_DRAG'],
    [{ manualPlanOverrideActive: true }, 'MANUAL_ORDER'],
    [{ isTursattSplitNeed: true }, 'TURSATT_SPLIT'],
    [{ isTursattPostArrivalShiftNeed: true }, 'TURSATT_PARKING'],
    [{ outOfTraffic: true }, 'OUT_OF_TRAFFIC'],
    [{ isWorkshopExitRequestNeed: true }, 'WORKSHOP_EXIT'],
    [{ isWorkshopIngressQueueNeed: true }, 'WORKSHOP_INGRESS'],
    [{ isStatusDispositionNeed: true }, 'STATUS_DISPOSITION'],
    [{ isNightPlanNeed: true }, 'NIGHT_PLAN'],
    [{ humanConfirmedWrittenPlan: true }, 'CONFIRMED_WRITTEN_PLAN'],
    [{ isDelayReplan: true }, 'DELAY_REPLAN'],
    [{ isSdeCancellationReplacementMove: true }, 'CANCEL_RECOVERY'],
    [{ sdeBlockedSource: true }, 'BLOCKED_SOURCE'],
    [{ sdeBlockedTarget: true }, 'BLOCKED_TARGET'],
    [{ source: 'already canonical' }, 'CANONICAL_EXISTING'],
  ];
  for (const [row, expected] of cases) assert.equal(classifyLegacyShiftNeed(row), expected);
});

test('derived producer recommendations do not become binding targets in the migration adapter', () => {
  const derived = buildCanonicalProducerRequest({
    vehicle: '74-20', fromSlot: '10S', recommendedSlot: '1N', isTursattPostArrivalShiftNeed: true,
  });
  const manual = buildCanonicalProducerRequest({
    vehicle: '70-11', fromSlot: '10S', recommendedSlot: '8S', sdeCanonicalGraphicDragOrder: true,
  });
  assert.equal(derived.producerId, 'TURSATT_PARKING');
  assert.equal(derived.payload.targetSlot, '');
  assert.equal(manual.producerId, 'MANUAL_DRAG');
  assert.equal(manual.payload.targetSlot, '8S');
});

test('canonical actual occupant repairs imperfect workshop source metadata without inventing placement', () => {
  const requests = buildCanonicalProducerRequests([{
    vehicle: '74-76', fromSlot: 'stale-slot', isWorkshopExitRequestNeed: true, workshopExitRequestId: 'exit-1',
  }], { occupancy: { '8S': '74-76' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].producerId, 'WORKSHOP_EXIT');
  assert.equal(requests[0].payload.sourceSlot, '8S');
  assert.equal(requests[0].payload.targetSlot, '');
});

test('all required producer families have one declared intent contract', () => {
  const required = ['MANUAL_DRAG', 'MANUAL_ORDER', 'TURSATT_SPLIT', 'TURSATT_PARKING', 'OUT_OF_TRAFFIC', 'WORKSHOP_EXIT', 'WORKSHOP_INGRESS', 'STATUS_DISPOSITION', 'NIGHT_PLAN', 'CONFIRMED_WRITTEN_PLAN', 'DELAY_REPLAN', 'CANCEL_RECOVERY', 'BLOCKED_SOURCE', 'BLOCKED_TARGET', 'CANONICAL_EXISTING'];
  assert.deepEqual(Object.keys(PRODUCER_CONTRACTS).sort(), required.sort());
});

test('manual drag is normalized to P1 MANUAL without deriving actual placement', () => {
  const input = { vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S', actorId: 'operator-1', sourceRevision: 'r1', createdAt: '2026-08-22T10:00:00Z' };
  const before = structuredClone(input);
  const result = adaptShiftNeed('MANUAL_DRAG', input);
  assert.equal(result.status, 'INTENT_CREATED');
  assert.equal(result.intent.sourceType, 'MANUAL');
  assert.equal(result.intent.priorityClass, 'P1_MANUAL');
  assert.equal(result.intent.originalTargetSlot, '8S');
  assert.deepEqual(input, before);
});

for (const producerId of ['TURSATT_SPLIT', 'TURSATT_PARKING', 'OUT_OF_TRAFFIC', 'WORKSHOP_EXIT', 'WORKSHOP_INGRESS', 'STATUS_DISPOSITION', 'NIGHT_PLAN', 'DELAY_REPLAN', 'CANCEL_RECOVERY', 'BLOCKED_SOURCE', 'BLOCKED_TARGET']) {
  test(`${producerId} is normalized to P2 SDE-derived`, () => {
    const result = adaptShiftNeed(producerId, { needId: `${producerId}-1`, vehicleId: '74-31', sourceSlot: '10S', targetSlot: '8S', sourceRevision: 'r1' });
    assert.equal(result.intent.sourceType, 'SDE_DERIVED');
    assert.equal(result.intent.priorityClass, 'P2_SDE_DERIVED');
    assert.equal(result.intent.metadata.producerId, producerId);
  });
}

test('confirmed written plan is P3 only with explicit human confirmation', () => {
  const rejected = adaptShiftNeed('CONFIRMED_WRITTEN_PLAN', { vehicleId: '74-31', sourceSlot: '10S', targetSlot: '8S', humanConfirmed: false });
  assert.equal(rejected.status, 'DIAGNOSTIC_ONLY');
  assert.equal(rejected.intent, null);
  const accepted = adaptShiftNeed('CONFIRMED_WRITTEN_PLAN', { planRowId: 'row-1', vehicleId: '74-31', sourceSlot: '10S', targetSlot: '8S', humanConfirmed: true, confirmedBy: 'operator-1' });
  assert.equal(accepted.intent.priorityClass, 'P3_CONFIRMED_WRITTEN_PLAN');
  assert.equal(accepted.intent.sourceType, 'CONFIRMED_WRITTEN_PLAN');
});

test('identical producer input is idempotent', () => {
  const input = { needId: 'stable-1', vehicleId: '74-31', sourceSlot: '10S', targetSlot: '8S', sourceRevision: 'r1' };
  assert.equal(adaptShiftNeed('TURSATT_PARKING', input).intent.idempotencyKey, adaptShiftNeed('TURSATT_PARKING', input).intent.idempotencyKey);
});

test('unauthorized manual intent is rejected before planning', async () => {
  const runtime = createCanonicalShiftRuntime({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    readActualState: () => ({ actualStateRevision: 'r1', occupancy: { '10S': '70-11' } }),
    authorizeManualIntent: () => false,
    authorizeUtført: () => false,
  });
  const result = await runtime.submitNeed('MANUAL_DRAG', { vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S', actorId: 'unauthorized' });
  assert.equal(result.status, 'AUTHORITY_REJECTED');
  assert.equal(runtime.intents.length, 0);
});

test('runtime materializes intent through one engine and leaves actual state unchanged', async () => {
  const actual = { actualStateRevision: 'r1', occupancy: { '10S': '70-11' } };
  const runtime = createCanonicalShiftRuntime({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    readActualState: () => actual,
    authorizeManualIntent: () => true,
    authorizeUtført: () => false,
  });
  const before = structuredClone(actual);
  const result = await runtime.submitNeed('MANUAL_DRAG', { vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S', actorId: 'operator-1' });
  assert.equal(result.status, 'PLANNED');
  assert.equal(result.projection.status, 'PROJECTED');
  assert.equal(result.ledger.aggregates.missingCardWithSafePlan, 0);
  assert.deepEqual(actual, before);
  assert.equal(runtime.operationalWriteOwner, 'SDE_CANONICAL_SHIFT_ENGINE');
});

test('batch planner migrates Tursatt and workshop producers through one atomic plan', () => {
  const actual = { actualStateRevision: 'r1', actualStateFresh: true, occupancy: { '10S': '74-20', '11S': '74-47', '7S': '74-31' } };
  const before = structuredClone(actual);
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: actual,
    needs: [
      { producerId: 'TURSATT_SPLIT', payload: { needId: '835-1', vehicleId: '74-20', sourceSlot: '10S', targetSlot: '8S', train: '835' } },
      { producerId: 'OUT_OF_TRAFFIC', payload: { needId: '837-1', vehicleId: '74-47', sourceSlot: '11S', targetSlot: '12S', train: '837' } },
      { producerId: 'WORKSHOP_EXIT', payload: { needId: 'exit-1', vehicleId: '74-31', sourceSlot: '7S', targetSlot: '9' } },
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.plan.originalIntents.map(item => item.metadata.producerId).sort(), ['OUT_OF_TRAFFIC', 'TURSATT_SPLIT', 'WORKSHOP_EXIT']);
  assert.equal(result.projection.status, 'PROJECTED');
  assert.equal(result.ledger.aggregates.missingCardWithSafePlan, 0);
  assert.equal(result.rows.length, result.plan.steps.length);
  assert.ok(result.rows.every(row => row.sdeCanonicalUnifiedEngine === true && row.sdeCanonicalProjectionOnly === true));
  assert.deepEqual(actual, before);
});

test('workshop ingress is materialized as a canonical physical plan', () => {
  const actual = { actualStateRevision: 'r-workshop-ingress', actualStateFresh: true, occupancy: { '10S': '74-31' } };
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: actual,
    needs: [{
      producerId: 'WORKSHOP_INGRESS',
      payload: { needId: 'ingress-1', vehicleId: '74-31', sourceSlot: '10S', targetSlot: '8S', isWorkshopIngressQueueNeed: true },
    }],
  });
  assert.equal(result.status, 'PLANNED');
  assert.equal(result.plan.originalIntents[0].metadata.producerId, 'WORKSHOP_INGRESS');
  assert.deepEqual(result.plan.steps.map(step => [step.role, step.vehicleId, step.sourceSlot, step.targetSlot]), [
    ['MAIN', '74-31', '10S', '8S'],
  ]);
  assert.equal(result.projection.cards.length, 1);
  assert.equal(result.projection.cards[0].status, 'READY');
  assert.deepEqual(actual.occupancy, { '10S': '74-31' });
});

test('batch planner retains every actual vehicle from trains 835, 837 and 839 as a distinct intent', () => {
  const vehicles = [
    ['835', '74-20', '10S', '8S'],
    ['835', '74-21', '10N', '9'],
    ['837', '74-47', '11S', '12S'],
    ['837', '74-48', '11N', '3N'],
    ['839', '74-06', '12N', '6S'],
  ];
  const occupancy = Object.fromEntries(vehicles.map(([, vehicle, source]) => [source, vehicle]));
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: { actualStateRevision: 'r-trains', actualStateFresh: true, occupancy },
    needs: vehicles.map(([train, vehicleId, sourceSlot, targetSlot], index) => ({
      producerId: 'TURSATT_PARKING',
      payload: { needId: `${train}-${index}`, train, vehicleId, sourceSlot, targetSlot },
    })),
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.intents.map(item => item.vehicle).sort(), vehicles.map(([, vehicle]) => vehicle).sort());
  assert.equal(result.intents.length, vehicles.length);
  assert.equal(result.plan.steps.filter(step => step.role === 'MAIN').length, vehicles.length);
});

test('batch planner rejects unauthorized manual input without suppressing independent SDE needs', () => {
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: { actualStateRevision: 'r1', actualStateFresh: true, occupancy: { '10S': '70-11', '11S': '74-11' } },
    authorizeManualIntent: () => false,
    needs: [
      { producerId: 'MANUAL_DRAG', payload: { intentId: 'manual-denied', actorId: 'denied', vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S' } },
      { producerId: 'TURSATT_PARKING', payload: { needId: 'derived-ok', vehicleId: '74-11', sourceSlot: '11S', targetSlot: '12S' } },
    ],
  });
  assert.equal(result.status, 'PLANNED');
  assert.deepEqual(result.intents.map(item => item.vehicle), ['74-11']);
  assert.equal(result.adapterDiagnostics[0].diagnosticCode, 'MANUAL_INTENT_AUTHORITY_MISSING');
});

test('compatibility rows are projections and cannot become actual authority', async () => {
  const engine = createShiftEngine({ slotCatalog: catalog() });
  const result = engine.plan({ state: { actualStateRevision: 'r1', occupancy: { '10S': '70-11' } }, intents: [{ sourceType: 'MANUAL', priorityClass: 'P1_MANUAL', vehicleId: '70-11', requestedSource: '10S', requestedTarget: '8S' }] });
  const rows = toLegacyCandidateRows(result.plan);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sdeCanonicalProjectionOnly, true);
  assert.equal(rows[0].canMutateActualPlacement, false);
  assert.equal(rows[0].sdePhysicalPlanRevision, result.plan.planRevision);
});

test('product shadow projection exposes lifecycle evidence without any operative surface', () => {
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: { actualStateRevision: 'r-shadow', actualStateFresh: true, occupancy: { '10S': '70-11' } },
    authorizeManualIntent: () => true,
    needs: [{
      producerId: 'MANUAL_DRAG',
      payload: { intentId: 'shadow-manual', actorId: 'operator-1', vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S' },
    }],
  });
  assert.equal(result.projection.cards[0].status, 'READY');
  assert.equal(result.projection.cards[0].canComplete, true);
  assert.equal(result.projection.reservations.length, 1);

  const shadow = buildCanonicalShadowProjection(result);
  assert.equal(shadow.status, 'SHADOW_PROJECTED');
  assert.equal(shadow.planRevision, result.plan.planRevision);
  assert.equal(shadow.operationalWriteOwner, 'LEGACY_UNCHANGED_PENDING_ROLLBACK_GATE');
  assert.equal(shadow.cards[0].canonicalLifecycleStatus, 'READY');
  assert.equal(shadow.cards[0].status, 'SHADOW_ONLY');
  assert.equal(shadow.cards[0].ready, false);
  assert.equal(shadow.cards[0].canComplete, false);
  assert.equal(shadow.cards[0].canCancel, false);
  assert.equal(shadow.cards[0].canMutateActualPlacement, false);
  assert.equal(shadow.cards[0].reservationId, '');
  assert.deepEqual(shadow.reservations, []);
  assert.deepEqual(shadow.plannedResourceClaims, []);
  assert.deepEqual(shadow.overlays, []);
  assert.deepEqual(shadow.routeResources, []);
  assert.deepEqual(shadow.diagnosticCounts, { cards: 1, reservations: 1, plannedResourceClaims: 0, overlays: 1, routeResources: 1 });
});

test('post-rollback migration projection has one operational owner and preserves atomic engine resources', () => {
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: { actualStateRevision: 'r-product', actualStateFresh: true, occupancy: { '10S': '70-11' } },
    authorizeManualIntent: () => true,
    needs: [{
      producerId: 'MANUAL_DRAG',
      payload: { intentId: 'product-manual', actorId: 'operator-1', vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S' },
    }],
  });
  const product = buildCanonicalProductProjection(result, {
    capability: { canCreateManualIntent: true, canComplete: true, canCancel: true },
  });
  assert.equal(product.status, 'ACTIVE');
  assert.equal(product.migrationMode, 'CANONICAL_ONLY');
  assert.equal(product.operationalWriteOwner, 'SDE_CANONICAL_SHIFT_ENGINE');
  assert.equal(product.legacyOperationalWritesEnabled, false);
  assert.equal(product.machineLearningScoreActive, false);
  assert.equal(product.integrity.status, 'PASS');
  assert.equal(product.cards.length, result.plan.steps.length);
  assert.equal(product.reservations.length, 1);
  assert.equal(product.plannedResourceClaims.length, 0);
  assert.equal(product.overlays.length, result.plan.steps.length);
  assert.equal(product.cards[0].status, 'READY');
  assert.equal(product.cards[0].canComplete, true);
  assert.equal(product.cards[0].canCancel, true);
  assert.equal(product.cards[0].executionDescriptor.actualStateRevision, 'r-product');
  assert.equal(product.cards[0].producerId, 'MANUAL_DRAG');
  assert.equal(product.cards[0].producerPayload.intentId, 'product-manual');
});

test('product action revalidation rejects stale readback and accepts only exact current step semantics', () => {
  const actual = { actualStateRevision: 'r-action', actualStateFresh: true, occupancy: { '10S': '70-11' } };
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: actual,
    authorizeManualIntent: () => true,
    needs: [{ producerId: 'MANUAL_DRAG', payload: { intentId: 'action-manual', actorId: 'operator-1', vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S' } }],
  });
  const product = buildCanonicalProductProjection(result, { capability: { canComplete: true, canCancel: true } });
  const descriptor = product.cards[0].executionDescriptor;
  const stale = revalidateCanonicalProductAction({ batchResult: result, descriptor, freshActualState: { ...actual, actualStateRevision: 'r-new' }, actionType: 'UTFORT' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_ACTUAL_STATE');
  const changed = revalidateCanonicalProductAction({ batchResult: result, descriptor: { ...descriptor, targetSlot: '9' }, freshActualState: actual, actionType: 'UTFORT' });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'STEP_SEMANTICS_CHANGED');
  const accepted = revalidateCanonicalProductAction({ batchResult: result, descriptor, freshActualState: actual, actionType: 'UTFORT' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.code, 'ACTIONABLE');
  const cancellation = revalidateCanonicalProductAction({ batchResult: result, descriptor, freshActualState: actual, actionType: 'ANNULLERT' });
  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.event.intentId, result.plan.steps[0].intentId);
});

test('product projection fails closed instead of exposing partial operative materialization', () => {
  const result = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    actualState: { actualStateRevision: 'r-partial', actualStateFresh: true, occupancy: { '10S': '70-11' } },
    authorizeManualIntent: () => true,
    needs: [{ producerId: 'MANUAL_DRAG', payload: { intentId: 'partial-manual', actorId: 'operator-1', vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S' } }],
  });
  const broken = {
    ...result,
    projection: { ...result.projection, reservations: [], plannedResourceClaims: [] },
  };
  const product = buildCanonicalProductProjection(broken, { capability: { canComplete: true, canCancel: true } });
  assert.equal(product.status, 'DIAGNOSTIC_ONLY');
  assert.equal(product.integrity.status, 'FAIL_CLOSED');
  assert.ok(product.cards.every(card => card.canComplete === false && card.canCancel === false));
});

test('canonical product is cleanly idle when no producer intent exists', () => {
  const batch = planCanonicalShiftNeeds({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    needs: [],
    actualState: { actualStateRevision: 'r-idle', actualStateFresh: true, occupancy: {} },
  });
  const product = buildCanonicalProductProjection(batch, { capability: {} });
  assert.equal(product.status, 'IDLE');
  assert.equal(product.integrity.status, 'PASS');
  assert.deepEqual(product.cards, []);
  assert.deepEqual(product.diagnostics, []);
});

test('Utført command requires authority and a fresh matching readback', async () => {
  let actual = { actualStateRevision: 'r1', occupancy: { '10S': '70-11' } };
  const commands = [];
  const runtime = createCanonicalShiftRuntime({
    engine: createShiftEngine({ slotCatalog: catalog() }),
    readActualState: () => structuredClone(actual),
    authorizeManualIntent: () => true,
    authorizeUtført: actor => actor === 'operator-1',
    writeAuthorizedUtført: command => { commands.push(command); return { accepted: true }; },
  });
  const planned = await runtime.submitNeed('MANUAL_DRAG', { vehicleId: '70-11', sourceSlot: '10S', targetSlot: '8S', actorId: 'operator-1' });
  const stepId = planned.plan.steps[0].stepId;
  const denied = await runtime.completeStep(stepId, { actorId: 'other', expectedActualRevision: 'r1' });
  assert.equal(denied.status, 'AUTHORITY_REJECTED');
  actual = { actualStateRevision: 'r2', occupancy: { '10S': '70-11' } };
  const stale = await runtime.completeStep(stepId, { actorId: 'operator-1', expectedActualRevision: 'r1' });
  assert.equal(stale.status, 'REPLAN_REQUIRED');
  const accepted = await runtime.completeStep(stepId, { actorId: 'operator-1', expectedActualRevision: 'r2' });
  assert.equal(accepted.status, 'UTFORT_COMMAND_ACCEPTED');
  assert.equal(commands.length, 1);
});

test('product page loads the engine before adapter and invokes the canonical-only product planner', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const engineIndex = html.indexOf('<script src="sde_canonical_shift_engine.js');
  const adapterIndex = html.indexOf('<script src="sde_canonical_shift_adapter.js');
  const legacyIndex = html.indexOf('<script src="sde_intelligent_night_planning.js');
  assert.ok(engineIndex >= 0 && engineIndex < adapterIndex && adapterIndex < legacyIndex);
  assert.match(html, /buildSdeCanonicalUnifiedGraphicDragShadowPreview\(assessment,payload,generatedId\)/);
  assert.match(html, /sdeCanonicalUnifiedShadowPreview:unifiedShiftShadowPreview/);
  assert.match(html, /buildSdeCanonicalUnifiedAllProducerProduct\(needs\)/);
  assert.match(html, /canonicalUnifiedAllProducerProduct/);
  assert.match(html, /buildCanonicalProducerRequests\(sourceRows,actualState\)/);
  assert.match(html, /buildCanonicalProductProjection\(batchResult/);
  assert.match(html, /legacyOperationalWritesEnabled:false/);
  assert.match(html, /operationalWriteOwner:"SDE_CANONICAL_SHIFT_ENGINE"/);
  assert.match(html, /actualStateFresh:snapshot\?\.valid === true/);
  assert.doesNotMatch(html, /\bactualFresh:snapshot\?\.valid === true/);
  for (const asset of ['sde_canonical_shift_engine.js', 'sde_canonical_shift_adapter.js']) {
    const expected = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, `../../${asset}`))).digest('hex');
    assert.match(html, new RegExp(`${asset.replace('.', '\\.')}\\?v=${expected}`));
  }
});

test('canonical drag and card actions do not delegate operative work to legacy handlers', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  const functionBody = name => {
    const regularStart = html.indexOf(`function ${name}(`);
    const asyncStart = html.indexOf(`async function ${name}(`);
    const start = regularStart >= 0 ? regularStart : asyncStart;
    assert.ok(start >= 0, `${name} must exist`);
    const nextRegular = html.indexOf('\nfunction ', start + 10);
    const nextAsync = html.indexOf('\nasync function ', start + 10);
    const candidates = [nextRegular,nextAsync].filter(index=>index >= 0);
    const next = candidates.length ? Math.min(...candidates) : html.length;
    return html.slice(start, next);
  };
  const drag = functionBody('applySdeNightPlacementDragOverride');
  assert.match(drag, /getSdeCanonicalShiftCapabilityModel\(\)/);
  assert.match(drag, /buildSdeCanonicalUnifiedAllProducerProduct/);
  assert.doesNotMatch(drag, /stageSdeCanonicalGraphicDragOrder\(/);
  assert.doesNotMatch(drag, /getSdeActiveMoveOutcomes\(/);

  const action = functionBody('handleSdeCanonicalCardAction');
  assert.match(action, /await refreshGlobalAuthoritativeData\(\)/);
  assert.match(action, /revalidateCanonicalProductAction/);
  assert.match(action, /canonicalProduct:true/);
  assert.match(action, /addSdeCompletedMoveToPlanSkifte\(row\)/);
  assert.doesNotMatch(action, /handleSdeShiftMoveAction\(/);
  assert.doesNotMatch(action, /deleteSdeLocalMoveCard\(/);
});
