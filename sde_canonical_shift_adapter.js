(function bootstrapSdeCanonicalShiftAdapter(root, factory) {
  const engineApi = typeof module === 'object' && module.exports
    ? require('./sde_canonical_shift_engine.js')
    : root.SdeCanonicalShiftEngine;
  const api = factory(engineApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SdeCanonicalShiftAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSdeCanonicalShiftAdapterModule(engineApi) {
  'use strict';

  if (!engineApi) throw new Error('SdeCanonicalShiftEngine must load before its adapter.');

  const {
    createShiftIntent,
    createShiftReplanner,
    projectCanonicalPlan,
    buildMissingCardLedger,
    revalidateActionStep,
    stableHash,
  } = engineApi;

  const PRODUCER_CONTRACTS = Object.freeze({
    MANUAL_DRAG: Object.freeze({ sourceType: 'MANUAL', priorityClass: 'P1_MANUAL', authority: 'SERVER_AUTHORIZED_HUMAN' }),
    MANUAL_ORDER: Object.freeze({ sourceType: 'MANUAL', priorityClass: 'P1_MANUAL', authority: 'SERVER_AUTHORIZED_HUMAN' }),
    TURSATT_SPLIT: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    TURSATT_PARKING: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    OUT_OF_TRAFFIC: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    WORKSHOP_EXIT: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    WORKSHOP_INGRESS: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    STATUS_DISPOSITION: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    NIGHT_PLAN: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    CONFIRMED_WRITTEN_PLAN: Object.freeze({ sourceType: 'CONFIRMED_WRITTEN_PLAN', priorityClass: 'P3_CONFIRMED_WRITTEN_PLAN', authority: 'HUMAN_CONFIRMED_WRITTEN_PLAN' }),
    DELAY_REPLAN: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    CANCEL_RECOVERY: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
    BLOCKED_SOURCE: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY', reliefContext: true }),
    BLOCKED_TARGET: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY', reliefContext: true }),
    CANONICAL_EXISTING: Object.freeze({ sourceType: 'SDE_DERIVED', priorityClass: 'P2_SDE_DERIVED', authority: 'SDE_ADVISORY' }),
  });

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function buildCanonicalSlotCatalog(input) {
    const slotIds = Array.from(new Set((input.slotIds || []).map(clean).filter(Boolean)));
    return slotIds.map((id, fallbackOrder) => {
      const track = clean(input.getTrack ? input.getTrack(id) : id.match(/^\d+|V/)?.[0] || id);
      const trackOrder = input.getTrackOrder ? input.getTrackOrder(track) : [];
      const orderIndex = Array.isArray(trackOrder) ? trackOrder.indexOf(id) : -1;
      const role = clean(input.getRole ? input.getRole(id) : 'ordinary').toLowerCase() || 'ordinary';
      const accessEnds = role === 'workshop'
        ? ['workshop']
        : Array.from(new Set((input.getOpenEnds ? input.getOpenEnds(track) : ['south', 'north']).map(item => clean(item).toLowerCase()).filter(Boolean)));
      return Object.freeze({
        id,
        track,
        order: orderIndex >= 0 ? orderIndex : fallbackOrder,
        role,
        accessEnds: accessEnds.length ? accessEnds : ['south', 'north'],
      });
    });
  }

  function normalizeProducerId(value) {
    return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function classifyLegacyShiftNeed(row) {
    const source = row && typeof row === 'object' ? row : {};
    const declared = [source.canonicalProducerId, source.shiftProducerId, source.producerId, source.canonicalProducer, source.sourceType]
      .map(normalizeProducerId)
      .find(value => Object.prototype.hasOwnProperty.call(PRODUCER_CONTRACTS, value));
    if (declared) return declared;
    if (source.sdeCanonicalGraphicDragOrder === true || source.sdeNightPlacementDragOverrideActive === true) return 'MANUAL_DRAG';
    if (source.humanConfirmedWrittenPlan === true || source.confirmedWrittenPlan === true) return 'CONFIRMED_WRITTEN_PLAN';
    if (source.manualPlanOverrideActive === true || source.manualOverrideActive === true || source.isManualOnly === true) return 'MANUAL_ORDER';
    if (source.sdeDelayReplan === true || source.isDelayReplan === true) return 'DELAY_REPLAN';
    if (source.isSdeCancellationReplacementMove === true || source.isCancelRecovery === true) return 'CANCEL_RECOVERY';
    if (source.isSdeNightPlacementBlockedMoveRequest === true || source.blockedSource === true || source.sdeBlockedSource === true) return 'BLOCKED_SOURCE';
    if (source.blockedTarget === true || source.sdeBlockedTarget === true || source.sdePhysicalHardBlocked === true) return 'BLOCKED_TARGET';
    if (source.isWorkshopIngressQueueNeed === true) return 'WORKSHOP_INGRESS';
    if (source.isWorkshopExitRequestNeed === true) return 'WORKSHOP_EXIT';
    if (source.isWorkshopMoveNeed === true) return clean(source.workshopExitRequestId) ? 'WORKSHOP_EXIT' : 'WORKSHOP_INGRESS';
    const semanticText = [source.source, source.parkingStrategy, source.status, source.disposition, source.reason]
      .map(clean).join(' ').toUpperCase();
    if (source.isOutOfTrafficNeed === true || source.outOfTraffic === true || /OUT_OF_TRAFFIC|UT AV TRAFIKK|UTE AV TRAFIKK/.test(semanticText)) return 'OUT_OF_TRAFFIC';
    if (source.isStatusDispositionNeed === true || /STATUS.?DISPOSITION|STATUS.?DISPOSISJON/.test(semanticText)) return 'STATUS_DISPOSITION';
    if (source.isNightPlanNeed === true || /NATTPLAN|NIGHT.?PLAN/.test(semanticText)) return 'NIGHT_PLAN';
    if (source.isTursattSplitNeed === true || source.tursattSplit === true || /TURSATT.?SPLIT|TURSATT.?DELING/.test(semanticText)) return 'TURSATT_SPLIT';
    if (source.isTursattPostArrivalShiftNeed === true || source.isSpor3ProductionNeed === true || /TURSATT|ANKOMSTBASERT PARKERINGSBEHOV|SPOR 3-PRODUKSJONSBEHOV/.test(semanticText)) return 'TURSATT_PARKING';
    return 'CANONICAL_EXISTING';
  }

  function getLegacyRequestedTarget(row, producerId) {
    const source = row && typeof row === 'object' ? row : {};
    const explicit = clean(source.requestedTarget || source.originalRequestedTarget || source.authoritativeTargetSlot);
    if (explicit) return explicit;
    const targetIsBinding = [
      'MANUAL_DRAG', 'MANUAL_ORDER', 'CONFIRMED_WRITTEN_PLAN', 'WORKSHOP_INGRESS',
      'DELAY_REPLAN', 'CANCEL_RECOVERY', 'BLOCKED_SOURCE', 'BLOCKED_TARGET', 'CANONICAL_EXISTING',
    ].includes(producerId);
    return targetIsBinding ? clean(source.targetSlot || source.toSlot || source.recommendedSlot) : '';
  }

  function buildCanonicalProducerRequest(row, requestIndex = 0) {
    const source = row && typeof row === 'object' ? row : {};
    const producerId = classifyLegacyShiftNeed(source);
    const vehicleId = clean(source.vehicleId || source.vehicle || source.mat);
    const sourceSlot = clean(source.sourceSlot || source.fromSlot || source.arrivalSlot || source.requestedSource || source.slot);
    const targetSlot = getLegacyRequestedTarget(source, producerId);
    const needId = clean(
      source.intentId || source.needId || source.needKey || source.stableActionKey || source.planRowId ||
      source.occurrenceId || source.arrivalOccurrenceId || source.tursattPostArrivalObligationId ||
      source.workshopExitRequestId || source.workshopIngressQueueEntryId
    ) || stableHash({ producerId, requestIndex, vehicleId, sourceSlot, targetSlot, sourceRevision: clean(source.sourceRevision) });
    return Object.freeze({
      producerId,
      payload: Object.freeze({
        ...source,
        vehicleId,
        sourceSlot,
        targetSlot,
        needId,
        sourceOccurrence: clean(source.sourceOccurrence || source.occurrenceId || source.arrivalOccurrenceId),
        earliestStart: source.earliestStart ?? source.arrivalSequenceMinutes,
        latestFinish: source.latestFinish ?? source.nextUseReadyBy,
        explicitSequenceIndex: source.explicitSequenceIndex ?? source.tursattPostArrivalSequenceIndex,
        reason: clean(source.reason || source.recommendationReason || source.parkingInstruction || source.parkingStrategy || producerId),
        actorId: clean(source.actorId || source.createdBy || source.confirmedBy),
        humanConfirmed: producerId === 'CONFIRMED_WRITTEN_PLAN' && (source.humanConfirmedWrittenPlan === true || source.confirmedWrittenPlan === true || source.humanConfirmed === true),
      }),
    });
  }

  function buildCanonicalProducerRequests(rows, actualState = {}) {
    const occupancy = actualState && typeof actualState.occupancy === 'object' ? actualState.occupancy : {};
    const actualSourceByVehicle = new Map(Object.entries(occupancy).map(([slot, vehicle]) => [
      clean(vehicle).replace(/[–—]/g, '-').toUpperCase(),
      clean(slot).toUpperCase(),
    ]));
    return Object.freeze((Array.isArray(rows) ? rows : []).filter(Boolean).map((row, index) => {
      const request = buildCanonicalProducerRequest(row, index);
      const actualSource = actualSourceByVehicle.get(clean(request.payload.vehicleId).replace(/[–—]/g, '-').toUpperCase()) || '';
      return Object.freeze({
        ...request,
        payload: Object.freeze({ ...request.payload, sourceSlot: actualSource || request.payload.sourceSlot }),
      });
    }));
  }

  function adaptShiftNeed(producerId, payload) {
    const id = clean(producerId).toUpperCase();
    const contract = PRODUCER_CONTRACTS[id];
    if (!contract) throw new TypeError(`Unknown canonical shift producer ${id || '(empty)'}.`);
    const source = payload && typeof payload === 'object' ? payload : {};
    if (id === 'CONFIRMED_WRITTEN_PLAN' && source.humanConfirmed !== true) {
      return Object.freeze({
        status: 'DIAGNOSTIC_ONLY',
        diagnosticCode: 'WRITTEN_PLAN_NOT_HUMAN_CONFIRMED',
        reason: 'OCR, HTR, draft or unconfirmed written plan cannot receive P3 authority.',
        intent: null,
      });
    }
    const vehicleId = clean(source.vehicleId || source.vehicle);
    const sourceSlot = clean(source.sourceSlot || source.fromSlot || source.requestedSource);
    const targetSlot = clean(source.targetSlot || source.toSlot || source.requestedTarget);
    const producerIdentity = clean(source.intentId || source.needId || source.planRowId || source.occurrenceId)
      || stableHash({ producerId: id, vehicleId, sourceSlot, targetSlot, sourceRevision: clean(source.sourceRevision) });
    const intent = createShiftIntent({
      intentId: `shift-producer-v1|${id}|${producerIdentity}`,
      sourceType: contract.sourceType,
      priorityClass: contract.priorityClass,
      authority: contract.authority,
      vehicleId,
      requestedSource: sourceSlot,
      requestedTarget: targetSlot,
      sourceOccurrence: clean(source.sourceOccurrence || source.occurrenceId),
      createdAt: clean(source.createdAt || source.detectedAt),
      createdBy: clean(source.actorId || source.createdBy || source.confirmedBy),
      earliestStart: source.earliestStart,
      latestFinish: source.latestFinish,
      explicitSequenceIndex: source.explicitSequenceIndex,
      mandatory: source.mandatory !== false,
      reason: clean(source.reason || id.replaceAll('_', ' ').toLowerCase()),
      sourceRevision: clean(source.sourceRevision),
      status: 'ACTIVE',
      preferredSourceEnd: clean(source.preferredSourceEnd),
      preferredTargetEnd: clean(source.preferredTargetEnd),
      reliefContext: contract.reliefContext === true || source.reliefContext === true,
      metadata: {
        producerId: id,
        producerIdentity,
        sourceStatus: clean(source.status),
        forcedTrainRule: source.forcedTrainRule === true,
        confirmedWrittenPlan: id === 'CONFIRMED_WRITTEN_PLAN',
      },
    });
    return Object.freeze({ status: 'INTENT_CREATED', diagnosticCode: '', reason: '', intent });
  }

  function toLegacyCandidateRows(plan) {
    if (!plan || !Array.isArray(plan.steps)) return [];
    return plan.steps.map(step => ({
      vehicle: step.vehicleId,
      fromSlot: step.sourceSlot,
      arrivalSlot: step.sourceSlot,
      recommendedSlot: step.targetSlot,
      toSlot: step.targetSlot,
      sdePhysicalDependencyRole: step.role === 'RELEASE' ? 'prerequisite' : step.role === 'RECOVERY' ? 'return' : 'dependent',
      sdePhysicalChainId: plan.planId,
      sdePhysicalPlanRevision: plan.planRevision,
      sdePhysicalStepId: step.stepId,
      sdePhysicalChainStep: step.sequenceIndex + 1,
      sdePhysicalChainStepCount: plan.steps.length,
      sdeCanonicalProjectionOnly: true,
      canMutateActualPlacement: false,
      sdeCanonicalUnifiedEngine: true,
      sdeCanonicalIntentId: step.intentId,
      sdeCanonicalInputHash: plan.inputHash,
      plannedWindowStart: step.plannedWindowStart,
      plannedWindowEnd: step.plannedWindowEnd,
      plannedResourceClaims: [...step.plannedResourceClaims],
    }));
  }

  function buildCanonicalShadowProjection(batchResult) {
    const source = batchResult && typeof batchResult === 'object' ? batchResult : {};
    const projection = source.projection && typeof source.projection === 'object' ? source.projection : null;
    const planRevision = clean(source.plan && source.plan.planRevision || projection && projection.planRevision);
    if (!projection || projection.status !== 'PROJECTED') {
      return Object.freeze({
        schemaVersion: 'sde-canonical-shift-product-shadow-v1',
        status: 'DIAGNOSTIC_ONLY',
        reason: clean(projection && projection.reason || source.reason || 'Canonical projection is unavailable.'),
        planRevision,
        migrationMode: 'SHADOW_READ_ONLY',
        shadowOnly: true,
        canMutateActualPlacement: false,
        operationalWriteOwner: 'LEGACY_UNCHANGED_PENDING_ROLLBACK_GATE',
        cards: Object.freeze([]),
        reservations: Object.freeze([]),
        plannedResourceClaims: Object.freeze([]),
        overlays: Object.freeze([]),
        routeResources: Object.freeze([]),
        diagnosticCounts: Object.freeze({ cards: 0, reservations: 0, plannedResourceClaims: 0, overlays: 0, routeResources: 0 }),
      });
    }
    const cards = Object.freeze((projection.cards || []).map(card => Object.freeze({
      ...card,
      canonicalLifecycleStatus: clean(card.status),
      status: 'SHADOW_ONLY',
      ready: false,
      canComplete: false,
      canCancel: false,
      canDelete: false,
      canRetarget: false,
      canMutateActualPlacement: false,
      reservationId: '',
      shadowOnly: true,
    })));
    return Object.freeze({
      schemaVersion: 'sde-canonical-shift-product-shadow-v1',
      status: 'SHADOW_PROJECTED',
      reason: '',
      planRevision,
      migrationMode: 'SHADOW_READ_ONLY',
      shadowOnly: true,
      canMutateActualPlacement: false,
      operationalWriteOwner: 'LEGACY_UNCHANGED_PENDING_ROLLBACK_GATE',
      cards,
      reservations: Object.freeze([]),
      plannedResourceClaims: Object.freeze([]),
      overlays: Object.freeze([]),
      routeResources: Object.freeze([]),
      diagnosticCounts: Object.freeze({
        cards: Number(projection.cards && projection.cards.length || 0),
        reservations: Number(projection.reservations && projection.reservations.length || 0),
        plannedResourceClaims: Number(projection.plannedResourceClaims && projection.plannedResourceClaims.length || 0),
        overlays: Number(projection.overlays && projection.overlays.length || 0),
        routeResources: Number(projection.routeResources && projection.routeResources.length || 0),
      }),
    });
  }

  function buildCanonicalProductProjection(batchResult, options = {}) {
    const source = batchResult && typeof batchResult === 'object' ? batchResult : {};
    const plan = source.plan && typeof source.plan === 'object' ? source.plan : null;
    const projection = source.projection && typeof source.projection === 'object' ? source.projection : null;
    const ledger = source.ledger && typeof source.ledger === 'object' ? source.ledger : null;
    const expectedPlanRevision = clean(plan && plan.planRevision);
    const projectionRevision = clean(projection && projection.planRevision);
    const actualStateRevision = clean(plan && plan.actualStateRevision);
    const actionRecords = options.actionRecords && typeof options.actionRecords === 'object'
      ? options.actionRecords
      : {};
    const capability = options.capability && typeof options.capability === 'object'
      ? options.capability
      : {};
    const diagnostics = [...(source.adapterDiagnostics || [])];
    if (source.status === 'NO_ACTIVE_INTENTS' && diagnostics.length === 0) {
      return Object.freeze({
        schemaVersion: 'sde-canonical-shift-product-v1',
        status: 'IDLE',
        reason: '',
        planRevision: '',
        actualStateRevision: '',
        migrationMode: 'CANONICAL_ONLY',
        operationalWriteOwner: 'SDE_CANONICAL_SHIFT_ENGINE',
        legacyOperationalWritesEnabled: false,
        machineLearningScoreActive: false,
        cards: Object.freeze([]),
        reservations: Object.freeze([]),
        plannedResourceClaims: Object.freeze([]),
        overlays: Object.freeze([]),
        routeResources: Object.freeze([]),
        diagnostics: Object.freeze([]),
        integrity: Object.freeze({ status: 'PASS', orphanCount: 0, duplicateCount: 0, missingAtomicStepIds: Object.freeze([]) }),
      });
    }
    const rejected = !plan
      || !projection
      || projection.status !== 'PROJECTED'
      || !ledger
      || ledger.status !== 'CONSISTENT'
      || !expectedPlanRevision
      || projectionRevision !== expectedPlanRevision;
    if (rejected) {
      diagnostics.push(Object.freeze({
        status: 'DIAGNOSTIC_ONLY',
        diagnosticCode: clean(source.diagnosticCode || projection && projection.reason || 'CANONICAL_PRODUCT_PROJECTION_UNAVAILABLE'),
        reason: clean(source.reason || projection && projection.reason || 'A complete canonical plan projection is unavailable.'),
      }));
      return Object.freeze({
        schemaVersion: 'sde-canonical-shift-product-v1',
        status: 'DIAGNOSTIC_ONLY',
        reason: diagnostics[diagnostics.length - 1].reason,
        planRevision: expectedPlanRevision || projectionRevision,
        actualStateRevision,
        migrationMode: 'CANONICAL_ONLY',
        operationalWriteOwner: 'SDE_CANONICAL_SHIFT_ENGINE',
        legacyOperationalWritesEnabled: false,
        machineLearningScoreActive: false,
        cards: Object.freeze([]),
        reservations: Object.freeze([]),
        plannedResourceClaims: Object.freeze([]),
        overlays: Object.freeze([]),
        routeResources: Object.freeze([]),
        diagnostics: Object.freeze(diagnostics),
        integrity: Object.freeze({ status: 'FAIL_CLOSED', orphanCount: 0, duplicateCount: 0 }),
      });
    }

    const stepById = new Map((plan.steps || []).map(step => [step.stepId, step]));
    const obligationByStepId = new Map((plan.obligations || []).map(obligation => [obligation.stepId, obligation]));
    const intentById = new Map((plan.originalIntents || []).map(intent => [intent.intentId, intent]));
    const sourceByIntentId = new Map((source.sources || []).map(item => [item.intentId, item]));
    const reservationByStepId = new Map((projection.reservations || []).map(item => [item.stepId, item]));
    const claimByStepId = new Map((projection.plannedResourceClaims || []).map(item => [item.stepId, item]));
    const overlayByStepId = new Map((projection.overlays || []).map(item => [item.stepId, item]));
    const cards = (projection.cards || []).map(card => {
      const step = stepById.get(card.stepId) || null;
      const obligation = obligationByStepId.get(card.stepId) || null;
      const intent = step ? intentById.get(step.intentId) || null : null;
      const producerSource = intent ? sourceByIntentId.get(intent.intentId) || null : null;
      const actionKey = `sde-canonical-action-v1|${stableHash({ planRevision: expectedPlanRevision, stepId: card.stepId })}`;
      const priorAction = actionRecords[actionKey] || null;
      const alreadyActioned = ['completed', 'cancelled'].includes(clean(priorAction && priorAction.action).toLowerCase());
      const ready = card.status === 'READY' && card.ready === true && !alreadyActioned;
      const lifecycleStatus = alreadyActioned
        ? clean(priorAction.action).toUpperCase()
        : clean(card.status || 'DIAGNOSTIC_ONLY');
      const executionDescriptor = Object.freeze({
        schemaVersion: 'sde-canonical-product-execution-v1',
        planRevision: expectedPlanRevision,
        actualStateRevision,
        stepId: clean(card.stepId),
        obligationId: clean(obligation && obligation.obligationId),
        intentId: clean(intent && intent.intentId),
        actionKey,
        vehicleId: clean(card.vehicleId),
        sourceSlot: clean(card.sourceSlot),
        targetSlot: clean(card.targetSlot),
        executionKey: `sde-canonical-execution-v1|${stableHash({
          planRevision: expectedPlanRevision,
          actualStateRevision,
          stepId: card.stepId,
          vehicleId: card.vehicleId,
          sourceSlot: card.sourceSlot,
          targetSlot: card.targetSlot,
        })}`,
      });
      return Object.freeze({
        ...card,
        canonicalCardId: clean(card.canonicalCardId || card.cardId),
        obligationId: clean(obligation && obligation.obligationId),
        intentId: clean(intent && intent.intentId),
        sourceType: clean(intent && intent.sourceType || card.sourceType),
        priority: clean(intent && intent.priorityClass || card.priority),
        intentReason: clean(intent && intent.reason || card.intentReason),
        producerId: clean(producerSource && producerSource.producerId || intent && intent.metadata && intent.metadata.producerId || 'CANONICAL_PREREQUISITE'),
        producerPayload: producerSource && producerSource.payload ? producerSource.payload : null,
        lifecycleStatus,
        status: lifecycleStatus,
        ready,
        canComplete: ready && capability.canComplete === true,
        canCancel: !alreadyActioned && card.canCancel === true && capability.canCancel === true,
        canDelete: false,
        canRetarget: !alreadyActioned && capability.canCreateManualIntent === true,
        actionKey,
        reservation: reservationByStepId.get(card.stepId) || null,
        plannedResourceClaim: claimByStepId.get(card.stepId) || null,
        overlay: overlayByStepId.get(card.stepId) || null,
        executionDescriptor,
      });
    });
    const stepIds = new Set((plan.steps || []).filter(step => step.status !== 'COMPLETED').map(step => step.stepId));
    const cardStepIds = new Set(cards.map(card => card.stepId));
    const reservationOrClaimStepIds = new Set([
      ...(projection.reservations || []).map(item => item.stepId),
      ...(projection.plannedResourceClaims || []).map(item => item.stepId),
    ]);
    const overlayStepIds = new Set((projection.overlays || []).map(item => item.stepId));
    const orphanCount = [
      ...(projection.reservations || []),
      ...(projection.plannedResourceClaims || []),
      ...(projection.overlays || []),
    ].filter(item => !stepIds.has(item.stepId)).length;
    const duplicateCount = cards.length - cardStepIds.size;
    const missingAtomicStepIds = [...stepIds].filter(stepId =>
      !cardStepIds.has(stepId) || !reservationOrClaimStepIds.has(stepId) || !overlayStepIds.has(stepId)
    );
    const integrityStatus = !orphanCount && !duplicateCount && !missingAtomicStepIds.length ? 'PASS' : 'FAIL_CLOSED';
    if (integrityStatus !== 'PASS') {
      diagnostics.push(Object.freeze({
        status: 'DIAGNOSTIC_ONLY',
        diagnosticCode: 'CANONICAL_PRODUCT_ATOMICITY_FAILED',
        reason: `Canonical product projection has ${orphanCount} orphan resources, ${duplicateCount} duplicate cards and ${missingAtomicStepIds.length} incomplete steps.`,
        missingAtomicStepIds: Object.freeze(missingAtomicStepIds),
      }));
    }
    const productCards = integrityStatus === 'PASS'
      ? cards
      : cards.map(card => Object.freeze({ ...card, ready: false, canComplete: false, canCancel: false, canRetarget: false, status: 'DIAGNOSTIC_ONLY', lifecycleStatus: 'DIAGNOSTIC_ONLY' }));
    return Object.freeze({
      schemaVersion: 'sde-canonical-shift-product-v1',
      status: integrityStatus === 'PASS' ? 'ACTIVE' : 'DIAGNOSTIC_ONLY',
      reason: integrityStatus === 'PASS' ? '' : diagnostics[diagnostics.length - 1].reason,
      planRevision: expectedPlanRevision,
      actualStateRevision,
      migrationMode: 'CANONICAL_ONLY',
      operationalWriteOwner: 'SDE_CANONICAL_SHIFT_ENGINE',
      legacyOperationalWritesEnabled: false,
      machineLearningScoreActive: false,
      cards: Object.freeze(productCards),
      reservations: Object.freeze([...(projection.reservations || [])]),
      plannedResourceClaims: Object.freeze([...(projection.plannedResourceClaims || [])]),
      overlays: Object.freeze([...(projection.overlays || [])]),
      routeResources: Object.freeze([...(projection.routeResources || [])]),
      diagnostics: Object.freeze(diagnostics),
      integrity: Object.freeze({
        status: integrityStatus,
        orphanCount,
        duplicateCount,
        missingAtomicStepIds: Object.freeze(missingAtomicStepIds),
      }),
    });
  }

  function revalidateCanonicalProductAction(input = {}) {
    const batchResult = input.batchResult && typeof input.batchResult === 'object' ? input.batchResult : {};
    const plan = batchResult.plan && typeof batchResult.plan === 'object' ? batchResult.plan : null;
    const descriptor = input.descriptor && typeof input.descriptor === 'object' ? input.descriptor : {};
    const freshActualState = input.freshActualState && typeof input.freshActualState === 'object' ? input.freshActualState : {};
    const actionType = clean(input.actionType).toUpperCase();
    const rejected = (code, reason) => Object.freeze({ ok: false, code, reason });
    if (!plan) return rejected('PLAN_MISSING', 'Canonical plan no longer exists.');
    if (actionType !== 'UTFORT' && actionType !== 'ANNULLERT') return rejected('ACTION_INVALID', 'Unknown canonical card action.');
    if (clean(descriptor.schemaVersion) !== 'sde-canonical-product-execution-v1') return rejected('DESCRIPTOR_INVALID', 'Execution descriptor is not canonical product v1.');
    if (clean(descriptor.planRevision) !== clean(plan.planRevision)) return rejected('PLAN_SUPERSEDED', 'Rendered plan revision is no longer active.');
    if (clean(descriptor.actualStateRevision) !== clean(freshActualState.actualStateRevision)) return rejected('STALE_ACTUAL_STATE', 'Fresh actual revision differs from the rendered card.');
    const step = (plan.steps || []).find(item => item.stepId === clean(descriptor.stepId));
    if (!step) return rejected('STEP_MISSING', 'Canonical step no longer exists.');
    const semanticMatch = clean(step.vehicleId) === clean(descriptor.vehicleId)
      && clean(step.sourceSlot) === clean(descriptor.sourceSlot)
      && clean(step.targetSlot) === clean(descriptor.targetSlot);
    if (!semanticMatch) return rejected('STEP_SEMANTICS_CHANGED', 'Canonical step semantics changed after render.');
    if (actionType === 'ANNULLERT') {
      return Object.freeze({ ok: true, code: 'CANCELLATION_EVENT_ALLOWED', reason: '', step, event: Object.freeze({
        type: 'ANNULLERT',
        planRevision: plan.planRevision,
        stepId: step.stepId,
        intentId: step.intentId,
        vehicleId: step.vehicleId,
        sourceSlot: step.sourceSlot,
        targetSlot: step.targetSlot,
      }) });
    }
    const validation = revalidateActionStep(plan, step.stepId, freshActualState);
    return validation.ok
      ? Object.freeze({ ok: true, code: 'ACTIONABLE', reason: '', step, validation })
      : rejected(validation.code || 'REPLAN_REQUIRED', validation.reason || 'Fresh revalidation failed.');
  }

  function planCanonicalShiftNeeds(options) {
    if (!options || !options.engine || typeof options.engine.plan !== 'function') throw new TypeError('Canonical batch planner requires engine.');
    const requests = Array.isArray(options.needs) ? options.needs : [];
    const intentsByKey = new Map();
    const sourceByIntentId = new Map();
    const adapterDiagnostics = [];
    requests.forEach((request, index) => {
      const producerId = clean(request && request.producerId).toUpperCase();
      const payload = request && request.payload && typeof request.payload === 'object' ? request.payload : {};
      let adapted;
      try {
        adapted = adaptShiftNeed(producerId, payload);
      } catch (error) {
        adapterDiagnostics.push(Object.freeze({
          status: 'DIAGNOSTIC_ONLY',
          diagnosticCode: 'SHIFT_NEED_ADAPTER_ERROR',
          producerId,
          requestIndex: index,
          reason: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      if (!adapted.intent) {
        adapterDiagnostics.push(Object.freeze({ ...adapted, producerId, requestIndex: index }));
        return;
      }
      if (adapted.intent.sourceType === 'MANUAL' && (!options.authorizeManualIntent || options.authorizeManualIntent(payload.actorId, payload, adapted.intent) !== true)) {
        adapterDiagnostics.push(Object.freeze({
          status: 'AUTHORITY_REJECTED',
          diagnosticCode: 'MANUAL_INTENT_AUTHORITY_MISSING',
          producerId,
          requestIndex: index,
          reason: 'Manual intent lacks server-authorized capability.',
        }));
        return;
      }
      intentsByKey.set(adapted.intent.idempotencyKey, adapted.intent);
      sourceByIntentId.set(adapted.intent.intentId, Object.freeze({ intentId: adapted.intent.intentId, producerId, payload: Object.freeze({ ...payload }) }));
    });
    const intents = Array.from(intentsByKey.values());
    if (!intents.length) {
      return Object.freeze({
        schemaVersion: 'sde-canonical-shift-batch-v1',
        status: adapterDiagnostics.length ? 'DIAGNOSTIC_ONLY' : 'NO_ACTIVE_INTENTS',
        intents: [],
        plan: null,
        projection: null,
        ledger: null,
        rows: [],
        sources: [],
        adapterDiagnostics,
      });
    }
    const actualState = options.actualState || {};
    const before = stableHash(actualState);
    const result = options.engine.plan({
      state: actualState,
      intents,
      previousPlan: options.previousPlan || null,
      humanExperienceEvidence: options.humanExperienceEvidence || [],
      events: options.events || [],
    });
    if (stableHash(actualState) !== before) throw new Error('Canonical batch planner mutated supplied actual state.');
    const projection = result.plan ? projectCanonicalPlan(result.plan, { activePlanRevision: result.plan.planRevision }) : null;
    const ledger = result.plan && projection ? buildMissingCardLedger(result.plan, projection) : null;
    const rows = result.plan ? toLegacyCandidateRows(result.plan).map((row, index) => {
      const step = result.plan.steps[index];
      const source = sourceByIntentId.get(step.intentId) || sourceByIntentId.get(result.plan.originalIntents[0]?.intentId) || null;
      return Object.freeze({
        ...(source?.payload || {}),
        ...row,
        canonicalProducer: source?.producerId || 'CANONICAL_PREREQUISITE',
        sourceType: source?.producerId || 'CANONICAL_PREREQUISITE',
        canonicalCard: projection?.cards?.find(card => card.stepId === step.stepId) || null,
      });
    }) : [];
    return Object.freeze({
      schemaVersion: 'sde-canonical-shift-batch-v1',
      ...result,
      intents,
      projection,
      ledger,
      rows,
      sources: Array.from(sourceByIntentId.values()).sort((left, right) => left.intentId.localeCompare(right.intentId)),
      adapterDiagnostics,
    });
  }

  function createCanonicalShiftRuntime(options) {
    if (!options || !options.engine || typeof options.engine.plan !== 'function') throw new TypeError('Canonical runtime requires engine.');
    if (typeof options.readActualState !== 'function') throw new TypeError('Canonical runtime requires readActualState.');
    const replanner = createShiftReplanner(options.engine);
    const intentsByKey = new Map();
    let current = null;

    async function submitNeed(producerId, payload) {
      const adapted = adaptShiftNeed(producerId, payload);
      if (!adapted.intent) return adapted;
      if (adapted.intent.sourceType === 'MANUAL' && (!options.authorizeManualIntent || options.authorizeManualIntent(payload?.actorId, payload, adapted.intent) !== true)) {
        return Object.freeze({ status: 'AUTHORITY_REJECTED', diagnosticCode: 'MANUAL_INTENT_AUTHORITY_MISSING', reason: 'Manual intent lacks server-authorized capability.', intent: null });
      }
      intentsByKey.set(adapted.intent.idempotencyKey, adapted.intent);
      const actualState = options.readActualState();
      const result = await replanner.submit({
        state: actualState,
        intents: Array.from(intentsByKey.values()),
        previousPlan: current?.plan || null,
        humanExperienceEvidence: options.readHumanExperienceEvidence ? options.readHumanExperienceEvidence() : [],
        events: [{ type: 'SHIFT_INTENT_UPSERTED', intentId: adapted.intent.intentId, producerId }],
      });
      const projection = result.plan ? projectCanonicalPlan(result.plan) : null;
      const ledger = result.plan && projection ? buildMissingCardLedger(result.plan, projection) : null;
      current = Object.freeze({ ...result, projection, ledger });
      return current;
    }

    async function completeStep(stepId, request) {
      if (!current?.plan) return Object.freeze({ status: 'REPLAN_REQUIRED', reason: 'No current canonical plan.' });
      if (!options.authorizeUtført || options.authorizeUtført(request?.actorId, request, current.plan) !== true) {
        return Object.freeze({ status: 'AUTHORITY_REJECTED', reason: 'Utført capability is missing.' });
      }
      const fresh = options.readActualState();
      if (clean(fresh.actualStateRevision) !== clean(request?.expectedActualRevision)) {
        return Object.freeze({ status: 'REPLAN_REQUIRED', reason: 'Fresh actual revision differs from expected readback.', freshActualRevision: clean(fresh.actualStateRevision) });
      }
      const revalidation = revalidateActionStep(current.plan, stepId, fresh);
      if (!revalidation.ok) return Object.freeze({ status: 'REPLAN_REQUIRED', reason: revalidation.reason, diagnosticCode: revalidation.code });
      if (typeof options.writeAuthorizedUtført !== 'function') return Object.freeze({ status: 'AUTHORITY_REJECTED', reason: 'Authorized Utført write adapter is unavailable.' });
      const step = current.plan.steps.find(item => item.stepId === stepId);
      const command = Object.freeze({
        schemaVersion: 'sde-authorized-utfort-command-v1',
        action: 'UTFORT',
        actorId: clean(request.actorId),
        expectedActualRevision: clean(request.expectedActualRevision),
        planRevision: current.plan.planRevision,
        stepId,
        vehicleId: step.vehicleId,
        sourceSlot: step.sourceSlot,
        targetSlot: step.targetSlot,
        idempotencyKey: `sde-utfort-v1|${stableHash({ planRevision: current.plan.planRevision, stepId, expectedActualRevision: clean(request.expectedActualRevision) })}`,
      });
      const receipt = await options.writeAuthorizedUtført(command);
      return Object.freeze({ status: receipt?.accepted === true ? 'UTFORT_COMMAND_ACCEPTED' : 'AUTHORITY_REJECTED', command, receipt: receipt || null });
    }

    return {
      schemaVersion: 'sde-canonical-shift-runtime-v1',
      operationalWriteOwner: 'SDE_CANONICAL_SHIFT_ENGINE',
      legacyOperationalWritesEnabled: false,
      get intents() { return Array.from(intentsByKey.values()); },
      get current() { return current; },
      get metrics() { return replanner.metrics; },
      submitNeed,
      completeStep,
    };
  }

  return Object.freeze({
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
  });
});
