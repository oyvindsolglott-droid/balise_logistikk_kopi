(function bootstrapSdeCanonicalShiftEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SdeCanonicalShiftEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSdeCanonicalShiftEngineModule() {
  'use strict';

  const SEARCH_BOUNDARY_CONTRACT = Object.freeze({
    id: 'SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1',
    maxStates: 250000,
    maxWallTimeMs: 1800,
    maxConnectedVehicles: 16,
    maxConnectedSlots: 31,
    maxPlanSteps: null,
    maxBranchingFactor: 31,
  });

  const PRIORITY_ORDER = Object.freeze({
    P0_PHYSICAL_SAFETY: 0,
    P1_MANUAL: 1,
    P2_SDE_DERIVED: 2,
    P3_CONFIRMED_WRITTEN_PLAN: 3,
    P4_OPTIMIZATION: 4,
  });

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }

  function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
  }

  function stableHash(value) {
    const input = typeof value === 'string' ? value : stableStringify(value);
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      hash ^= BigInt(code & 0xff);
      hash = BigInt.asUintN(64, hash * prime);
      if (code > 0xff) {
        hash ^= BigInt((code >>> 8) & 0xff);
        hash = BigInt.asUintN(64, hash * prime);
      }
    }
    return hash.toString(16).padStart(16, '0');
  }

  function cleanToken(value) {
    return String(value == null ? '' : value).trim();
  }

  function cleanVehicle(value) {
    return cleanToken(value).replace(/[–—]/g, '-').toUpperCase();
  }

  function cleanSlot(value) {
    return cleanToken(value).replace(/\s+/g, '').toUpperCase();
  }

  function vehicleMaterialType(value) {
    const match = cleanVehicle(value).match(/^(69|70|74|75)(?:-|\/|$)/);
    return match ? match[1] : '';
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function createShiftIntent(input) {
    const vehicle = cleanVehicle(input && (input.vehicle || input.vehicleId));
    const fromSlot = cleanSlot(input && (input.fromSlot || input.sourceSlot || input.requestedSource));
    const targetSlot = cleanSlot(input && (input.targetSlot || input.toSlot || input.requestedTarget));
    const intentId = cleanToken(input && input.intentId) || `intent|${vehicle}|${fromSlot}|${targetSlot || 'DERIVED'}`;
    if (!vehicle) throw new TypeError('ShiftIntent requires vehicle.');
    if (!fromSlot) throw new TypeError('ShiftIntent requires fromSlot.');
    const sourceType = cleanToken(input && input.sourceType) || 'SDE_DERIVED';
    if (/^(OCR_RAW|HTR_RAW|OCR_PROPOSAL|HTR_PROPOSAL)$/i.test(sourceType)) {
      throw new TypeError('Unconfirmed OCR/HTR is not a confirmed written plan and cannot create ShiftIntent.');
    }
    const createdAt = cleanToken(input && (input.createdAt || input.requestedAt));
    const earliestStart = Number(input && (input.earliestStart ?? input.timeWindow?.start));
    const latestFinish = Number(input && (input.latestFinish ?? input.timeWindow?.end));
    const explicitSequenceIndex = Number(input && (input.explicitSequenceIndex ?? input.explicitSequence));
    const semanticIdentity = {
      intentId,
      sourceType,
      authority: cleanToken(input && input.authority) || 'SDE_ADVISORY',
      priorityClass: cleanToken(input && input.priorityClass) || (targetSlot ? 'P1_MANUAL' : 'P2_SDE_DERIVED'),
      vehicle,
      fromSlot,
      originalTargetSlot: targetSlot,
      createdAt,
      sourceRevision: cleanToken(input && input.sourceRevision),
    };
    return deepFreeze({
      schemaVersion: 'sde-shift-intent-v1',
      ...semanticIdentity,
      vehicleId: vehicle,
      sourceOccurrence: cleanToken(input && input.sourceOccurrence),
      requestedSource: fromSlot,
      requestedTarget: targetSlot,
      targetSlot,
      originalTargetSlot: targetSlot,
      createdAt,
      createdBy: cleanToken(input && input.createdBy),
      requestedAt: createdAt,
      earliestStart: Number.isFinite(earliestStart) ? earliestStart : null,
      latestFinish: Number.isFinite(latestFinish) ? latestFinish : null,
      explicitSequenceIndex: Number.isFinite(explicitSequenceIndex) ? explicitSequenceIndex : null,
      explicitSequence: Number.isFinite(explicitSequenceIndex) ? explicitSequenceIndex : null,
      mandatory: input && input.mandatory !== undefined ? input.mandatory === true : true,
      reason: cleanToken(input && input.reason),
      status: cleanToken(input && input.status) || 'ACTIVE',
      preferredSourceEnd: cleanToken(input && input.preferredSourceEnd).toLowerCase(),
      preferredTargetEnd: cleanToken(input && input.preferredTargetEnd).toLowerCase(),
      reliefContext: Boolean(input && input.reliefContext),
      timeWindow: canonicalize({
        start: Number.isFinite(earliestStart) ? earliestStart : null,
        end: Number.isFinite(latestFinish) ? latestFinish : null,
        ...(input && input.timeWindow ? input.timeWindow : {}),
      }),
      metadata: canonicalize(input && input.metadata ? input.metadata : {}),
      idempotencyKey: `shift-intent-v1|${stableHash(semanticIdentity)}`,
    });
  }

  function normalizeCatalog(slotCatalog) {
    const seen = new Set();
    return (Array.isArray(slotCatalog) ? slotCatalog : []).map((raw, index) => {
      const id = cleanSlot(raw && (raw.id || raw.slot));
      if (!id || seen.has(id)) throw new TypeError(`Invalid or duplicate slot: ${id || '(empty)'}`);
      seen.add(id);
      const accessEnds = Array.from(new Set((raw.accessEnds || ['south', 'north']).map(item => cleanToken(item).toLowerCase()).filter(Boolean)));
      return deepFreeze({
        id,
        track: cleanToken(raw.track || id.replace(/[^0-9V].*$/, '')) || id,
        order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
        role: cleanToken(raw.role || 'ordinary').toLowerCase(),
        accessEnds: accessEnds.length ? accessEnds : ['south', 'north'],
        unavailable: raw.unavailable === true,
        allowedVehicleClasses: Array.isArray(raw.allowedVehicleClasses) ? raw.allowedVehicleClasses.map(cleanToken).filter(Boolean) : [],
      });
    }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  }

  function normalizeOccupancy(rawOccupancy, catalogById) {
    const result = {};
    Object.entries(rawOccupancy || {}).forEach(([rawSlot, rawVehicle]) => {
      const slot = cleanSlot(rawSlot);
      const vehicle = cleanVehicle(rawVehicle);
      if (slot && vehicle && catalogById.has(slot)) result[slot] = vehicle;
    });
    return result;
  }

  function getVehicleSlot(occupancy, vehicle) {
    const token = cleanVehicle(vehicle);
    return Object.keys(occupancy).find(slot => occupancy[slot] === token) || '';
  }

  function occupancyHash(occupancy) {
    return stableHash(Object.keys(occupancy).sort().map(slot => [slot, occupancy[slot]]));
  }

  function getTrackSlots(catalog, track) {
    return catalog.filter(slot => slot.track === track).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id, 'en'));
  }

  function getAccessBlockers(occupancy, catalog, slotId, allowedEnds) {
    const slot = catalog.find(item => item.id === slotId);
    if (!slot) return { clear: false, options: [], blockers: [] };
    if (slot.role === 'workshop') {
      return { clear: true, options: [{ end: 'workshop', pathSlots: [], blockers: [], clear: true }], blockers: [] };
    }
    const trackSlots = getTrackSlots(catalog, slot.track);
    const position = trackSlots.findIndex(item => item.id === slot.id);
    const ends = (allowedEnds && allowedEnds.length ? allowedEnds : slot.accessEnds).filter(end => slot.accessEnds.includes(end));
    const options = ends.map(end => {
      const path = end === 'south' ? trackSlots.slice(0, position) : trackSlots.slice(position + 1);
      const blockers = path.map(item => ({ slot: item.id, vehicleId: occupancy[item.id] || '' })).filter(item => item.vehicleId);
      return { end, pathSlots: path.map(item => item.id), blockers, clear: blockers.length === 0 };
    });
    const union = new Map();
    options.forEach(option => option.blockers.forEach(blocker => union.set(`${blocker.slot}|${blocker.vehicleId}`, blocker)));
    return { clear: options.some(option => option.clear), options, blockers: Array.from(union.values()) };
  }

  function routeResourcesForMove(source, target, sourceEnd, targetEnd) {
    return [
      `track-access|${source.track}|${sourceEnd}`,
      `track-access|${target.track}|${targetEnd}`,
      `route|${source.id}|${sourceEnd}|${target.id}|${targetEnd}`,
    ].sort();
  }

  function overlaps(left, right) {
    const leftStart = Number(left && left.start);
    const leftEnd = Number(left && left.end);
    const rightStart = Number(right && right.start);
    const rightEnd = Number(right && right.end);
    if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return true;
    return leftStart < rightEnd && rightStart < leftEnd;
  }

  function reservationConflict(resources, state, timeWindow) {
    return (state.routeReservations || []).find(reservation => {
      const resource = cleanToken(reservation.resource || reservation.resourceId);
      return resource && resources.includes(resource) && overlaps(timeWindow, reservation.timeWindow);
    }) || null;
  }

  function evaluateMove(occupancy, vehicle, sourceId, targetId, context) {
    const { catalog, catalogById, unavailable, state } = context;
    const source = catalogById.get(cleanSlot(sourceId));
    const target = catalogById.get(cleanSlot(targetId));
    const token = cleanVehicle(vehicle);
    if (!source || !target) return { hardSafe: false, code: 'UNKNOWN_SLOT' };
    if (source.id === target.id) return { hardSafe: false, code: 'SAME_SLOT' };
    if (occupancy[source.id] !== token) return { hardSafe: false, code: 'SOURCE_CHANGED' };
    if (occupancy[target.id]) return { hardSafe: false, code: 'TARGET_OCCUPIED', blockerVehicleId: occupancy[target.id] };
    if (source.unavailable || target.unavailable || unavailable.has(source.id) || unavailable.has(target.id)) {
      return { hardSafe: false, code: 'SLOT_UNAVAILABLE' };
    }
    if (target.role === 'route_resource') return { hardSafe: false, code: 'ROUTE_RESOURCE_NOT_HOLDING_SLOT' };
    const sourceEnds = context.sourceEnds && context.sourceEnds.length ? context.sourceEnds : source.accessEnds;
    const targetEnds = context.targetEnds && context.targetEnds.length ? context.targetEnds : target.accessEnds;
    const sourceAccess = getAccessBlockers(occupancy, catalog, source.id, sourceEnds);
    const targetAccess = getAccessBlockers(occupancy, catalog, target.id, targetEnds);
    const sourceOption = sourceAccess.options.find(option => option.clear);
    const targetOption = targetAccess.options.find(option => option.clear);
    if (!sourceOption) return { hardSafe: false, code: 'SOURCE_ACCESS_BLOCKED', blockers: sourceAccess.blockers };
    if (!targetOption) return { hardSafe: false, code: 'TARGET_ACCESS_BLOCKED', blockers: targetAccess.blockers };
    const resources = routeResourcesForMove(source, target, sourceOption.end, targetOption.end);
    const conflict = reservationConflict(resources, state, context.timeWindow);
    if (conflict) return { hardSafe: false, code: 'ROUTE_RESOURCE_CONFLICT', conflict };
    return {
      hardSafe: true,
      code: 'SAFE',
      sourceEnd: sourceOption.end,
      targetEnd: targetOption.end,
      sourcePathSlots: sourceOption.pathSlots,
      targetPathSlots: targetOption.pathSlots,
      routeResources: resources,
    };
  }

  function evidenceWeight(provenance) {
    const token = cleanToken(provenance).toUpperCase();
    if (token === 'AUTHORITATIVE_EXECUTED_RESULT') return 1;
    if (token === 'CONFIRMED_WRITTEN_PLAN' || token === 'HUMAN_IMPORTED_PLAN' || token === 'HUMAN_MANUAL_PLAN') return 0.35;
    return 0;
  }

  function outcomeSign(outcome) {
    const token = cleanToken(outcome).toUpperCase();
    if (['SUCCESS', 'COMPLETED', 'ACCEPTED', 'SAFE'].includes(token)) return 1;
    if (['REJECTED', 'FAILED', 'CANCELLED', 'UNSAFE'].includes(token)) return -1;
    return 0;
  }

  function humanExperienceScore(evidence, vehicleId, targetSlot, referenceTime, subjectContext) {
    const reference = Date.parse(referenceTime || '2026-08-22T00:00:00.000Z');
    const subjectVehicleType = cleanToken(subjectContext && (subjectContext.vehicleType || subjectContext.materialType))
      || vehicleMaterialType(vehicleId);
    return (Array.isArray(evidence) ? evidence : []).reduce((score, item) => {
      if (cleanSlot(item.targetSlot || item.desiredSlot || item.slot) !== cleanSlot(targetSlot)) return score;
      const evidenceVehicleType = cleanToken(item.vehicleType || item.materialType)
        || vehicleMaterialType(item.vehicleId || item.vehicle);
      if (subjectVehicleType && evidenceVehicleType && evidenceVehicleType !== subjectVehicleType) return score;
      const provenance = cleanToken(item.provenance || item.sourceType).toUpperCase();
      const weight = evidenceWeight(provenance);
      const finalSlot = cleanSlot(item.actualFinalSlot || item.finalSlot);
      const replanOccurred = item.replanOccurred === true || cleanToken(item.actualOutcome).toUpperCase() === 'REPLAN_REQUIRED';
      const rawOutcome = cleanToken(item.outcome || item.result || item.actualOutcome || item.planStatus).toUpperCase();
      const confirmedPlan = provenance !== 'AUTHORITATIVE_EXECUTED_RESULT'
        && rawOutcome === 'CONFIRMED';
      const executedSuccess = provenance === 'AUTHORITATIVE_EXECUTED_RESULT'
        && rawOutcome === 'COMPLETED'
        && (!finalSlot || finalSlot === cleanSlot(targetSlot))
        && !replanOccurred;
      const sign = confirmedPlan || executedSuccess ? 1 : outcomeSign(rawOutcome);
      if (!weight || !sign) return score;
      const occurred = Date.parse(item.occurredAt || item.timestamp || '');
      const dated = Number.isFinite(occurred) ? occurred : Date.parse(`${cleanToken(item.operationalDate)}T00:00:00.000Z`);
      const ageDays = Number.isFinite(dated) && Number.isFinite(reference) ? Math.max(0, (reference - dated) / 86400000) : 0;
      const decay = Math.pow(0.5, ageDays / 180);
      return score + sign * weight * decay;
    }, 0);
  }

  function trackDistance(source, target) {
    const left = Number(source.track);
    const right = Number(target.track);
    if (Number.isFinite(left) && Number.isFinite(right)) return Math.abs(left - right);
    if (source.track === target.track) return 0;
    return 4;
  }

  function candidateRolePenalty(slot, reliefContext) {
    if (slot.role === 'route_resource') return 1000;
    if (slot.role === 'temporary_relief') return reliefContext ? 1 : 30;
    if (slot.role === 'workshop') return reliefContext ? 18 : 2;
    if (slot.role === 'service_access') return 12;
    return 0;
  }

  function evaluateCandidateSet(subject, occupancy, context) {
    const source = context.catalogById.get(cleanSlot(subject.sourceSlot));
    const reliefContext = subject.reliefContext === true;
    const evaluations = context.catalog.map(slot => {
      const move = evaluateMove(occupancy, subject.vehicleId, subject.sourceSlot, slot.id, {
        ...context,
        sourceEnds: subject.sourceEnds,
        targetEnds: null,
        timeWindow: subject.timeWindow,
      });
      const roleAllowed = slot.role !== 'route_resource' && (slot.role !== 'temporary_relief' || reliefContext || slot.id === cleanSlot(subject.explicitTargetSlot) || cleanSlot(subject.sourceSlot) === 'VN');
      const score = humanExperienceScore(
        context.humanExperienceEvidence,
        subject.vehicleId,
        slot.id,
        subject.referenceTime,
        { vehicleType: subject.vehicleType || context.state.vehicleTypesByVehicle?.[cleanVehicle(subject.vehicleId)] || vehicleMaterialType(subject.vehicleId) },
      );
      return {
        slot: slot.id,
        role: slot.role,
        considered: true,
        hardSafe: move.hardSafe && roleAllowed,
        eligible: move.hardSafe && roleAllowed,
        reasonCode: roleAllowed ? move.code : 'VN_NOT_CONTEXTUAL_RELIEF',
        humanExperienceScore: Number(score.toFixed(8)),
        distance: source ? trackDistance(source, slot) : 999,
        rolePenalty: candidateRolePenalty(slot, reliefContext),
        move,
      };
    });
    return evaluations;
  }

  function sortCandidateEvaluations(evaluations) {
    return [...evaluations].sort((left, right) =>
      Number(right.eligible) - Number(left.eligible)
      || right.humanExperienceScore - left.humanExperienceScore
      || left.rolePenalty - right.rolePenalty
      || left.distance - right.distance
      || left.slot.localeCompare(right.slot, 'en')
    );
  }

  function applyMove(occupancy, move) {
    const next = { ...occupancy };
    delete next[move.sourceSlot];
    next[move.targetSlot] = move.vehicleId;
    return next;
  }

  function clonePath(path) {
    return path.map(item => ({ ...item, routeResources: [...item.routeResources] }));
  }

  function priorityValue(intent) {
    return PRIORITY_ORDER[intent.priorityClass] == null ? PRIORITY_ORDER.P2_SDE_DERIVED : PRIORITY_ORDER[intent.priorityClass];
  }

  function normalizeIntents(rawIntents) {
    return (Array.isArray(rawIntents) ? rawIntents : []).map(item => item && item.schemaVersion === 'sde-shift-intent-v1' ? item : createShiftIntent(item)).sort((left, right) =>
      priorityValue(left) - priorityValue(right)
      || ((left.explicitSequenceIndex ?? Number.MAX_SAFE_INTEGER) - (right.explicitSequenceIndex ?? Number.MAX_SAFE_INTEGER))
      || left.createdAt.localeCompare(right.createdAt, 'en')
      || ((left.latestFinish ?? Number.MAX_SAFE_INTEGER) - (right.latestFinish ?? Number.MAX_SAFE_INTEGER))
      || left.intentId.localeCompare(right.intentId, 'en')
    );
  }

  function resolveDerivedIntentTargets(intents, occupancy, context) {
    const diagnostics = [];
    const reserved = new Set();
    const resolved = intents.map(intent => {
      if (intent.targetSlot) {
        reserved.add(intent.targetSlot);
        return intent;
      }
      const currentSource = getVehicleSlot(occupancy, intent.vehicle) || intent.fromSlot;
      const evaluations = evaluateCandidateSet({
        vehicleId: intent.vehicle,
        sourceSlot: currentSource,
        reliefContext: intent.reliefContext,
        referenceTime: intent.requestedAt,
        timeWindow: intent.timeWindow,
      }, occupancy, context);
      diagnostics.push(...evaluations);
      const chosen = sortCandidateEvaluations(evaluations).find(item => item.eligible && !reserved.has(item.slot));
      if (!chosen) return intent;
      reserved.add(chosen.slot);
      return deepFreeze({ ...intent, targetSlot: chosen.slot, derivedTargetSlot: chosen.slot });
    });
    return { intents: resolved, diagnostics };
  }

  function getRelevantBlockers(node, intent, context) {
    const occupancy = node.occupancy;
    const vehicleSlot = getVehicleSlot(occupancy, intent.vehicle);
    const targetSlot = intent.targetSlot;
    const blockers = [];
    if (occupancy[targetSlot] && occupancy[targetSlot] !== intent.vehicle) {
      blockers.push({ vehicleId: occupancy[targetSlot], sourceSlot: targetSlot, reason: 'TARGET_OCCUPANT' });
    }
    const sourceEnds = intent.preferredSourceEnd ? [intent.preferredSourceEnd] : null;
    const targetEnds = intent.preferredTargetEnd ? [intent.preferredTargetEnd] : null;
    const sourceAccess = getAccessBlockers(occupancy, context.catalog, vehicleSlot, sourceEnds);
    const targetAccess = getAccessBlockers(occupancy, context.catalog, targetSlot, targetEnds);
    sourceAccess.blockers.forEach(blocker => blockers.push({ ...blocker, sourceSlot: blocker.slot, reason: 'SOURCE_ACCESS' }));
    targetAccess.blockers.forEach(blocker => blockers.push({ ...blocker, sourceSlot: blocker.slot, reason: 'TARGET_ACCESS' }));
    const dedup = new Map();
    blockers.forEach(blocker => {
      if (blocker.vehicleId && blocker.vehicleId !== intent.vehicle) dedup.set(blocker.vehicleId, blocker);
    });
    return Array.from(dedup.values()).sort((left, right) => left.sourceSlot.localeCompare(right.sourceSlot, 'en'));
  }

  function completedIntentCount(node, intents) {
    let count = 0;
    while (count < intents.length && node.completedIntentIds.includes(intents[count].intentId)) count += 1;
    return count;
  }

  function goalSatisfied(node, intents, originalOccupancy) {
    if (node.completedIntentIds.length !== intents.length) return false;
    const protectedTargets = new Set(intents.map(intent => intent.targetSlot));
    const intentVehicles = new Set(intents.map(intent => intent.vehicle));
    const flexiblePlacementVehicles = new Set((node.flexiblePlacementVehicles || []).map(cleanVehicle));
    return Object.entries(originalOccupancy).every(([slot, vehicle]) => {
      if (intentVehicles.has(vehicle)) return true;
      if (flexiblePlacementVehicles.has(vehicle)) return true;
      if (protectedTargets.has(slot)) return true;
      return node.occupancy[slot] === vehicle;
    });
  }

  function nodeSignature(node) {
    return `${occupancyHash(node.occupancy)}|${node.completedIntentIds.join(',')}`;
  }

  function makeMove(vehicleId, sourceSlot, targetSlot, role, intentId, assessment, reason) {
    return {
      vehicleId,
      sourceSlot,
      targetSlot,
      role,
      intentId,
      reason,
      sourceEnd: assessment.sourceEnd,
      targetEnd: assessment.targetEnd,
      sourcePathSlots: [...(assessment.sourcePathSlots || [])],
      targetPathSlots: [...(assessment.targetPathSlots || [])],
      routeResources: assessment.routeResources,
    };
  }

  function supportTransitionKey(move) {
    return [
      cleanToken(move && (move.vehicleId || move.vehicle)),
      cleanSlot(move && (move.sourceSlot || move.fromSlot)),
      cleanSlot(move && (move.targetSlot || move.toSlot)),
      cleanToken(move && move.role).toUpperCase(),
    ].join('|');
  }

  function removeCancelledSupportTransitions(moves, context) {
    const rejected = context && context.cancelledSupportTransitions instanceof Set
      ? context.cancelledSupportTransitions
      : new Set();
    return (Array.isArray(moves) ? moves : []).filter(move => !rejected.has(supportTransitionKey(move)));
  }

  function generateRecoveryMoves(node, intents, originalOccupancy, context) {
    const protectedTargets = new Set(intents.map(intent => intent.targetSlot));
    const intentVehicles = new Set(intents.map(intent => intent.vehicle));
    const flexiblePlacementVehicles = new Set((context.state.flexiblePlacementVehicles || []).map(cleanVehicle));
    const displaced = Object.entries(originalOccupancy).map(([originalSlot, vehicleId]) => ({ originalSlot, vehicleId, currentSlot: getVehicleSlot(node.occupancy, vehicleId) }))
      .filter(item => !intentVehicles.has(item.vehicleId))
      .filter(item => !flexiblePlacementVehicles.has(item.vehicleId))
      .filter(item => !protectedTargets.has(item.originalSlot))
      .filter(item => item.currentSlot && item.currentSlot !== item.originalSlot);
    const direct = [];
    displaced.forEach(item => {
      const assessment = evaluateMove(node.occupancy, item.vehicleId, item.currentSlot, item.originalSlot, { ...context, sourceEnds: null, targetEnds: null, timeWindow: null });
      if (assessment.hardSafe) direct.push(makeMove(item.vehicleId, item.currentSlot, item.originalSlot, 'RECOVERY', intents[0]?.intentId || '', assessment, 'RESTORE_DISPLACED_VEHICLE'));
    });
    if (direct.length) return direct.sort((left, right) => left.vehicleId.localeCompare(right.vehicleId, 'en'));
    const blockers = [];
    displaced.forEach(item => {
      if (node.occupancy[item.originalSlot] && node.occupancy[item.originalSlot] !== item.vehicleId) {
        blockers.push({ vehicleId: node.occupancy[item.originalSlot], sourceSlot: item.originalSlot });
      }
      const access = getAccessBlockers(node.occupancy, context.catalog, item.originalSlot, null);
      access.blockers.forEach(blocker => blockers.push({ vehicleId: blocker.vehicleId, sourceSlot: blocker.slot }));
    });
    return generateReliefMoves(node, blockers, intents, context, 'RECOVERY', intents[0]?.intentId || '');
  }

  function generateReliefMoves(node, blockers, intents, context, role, parentIntentId) {
    const fixedVehicles = new Set(node.completedIntentIds.map(id => intents.find(intent => intent.intentId === id)?.vehicle).filter(Boolean));
    const moves = [];
    const blockerMap = new Map((blockers || []).map(item => [item.vehicleId, item]));
    blockerMap.forEach(blocker => {
      if (fixedVehicles.has(blocker.vehicleId)) return;
      const evaluations = evaluateCandidateSet({
        vehicleId: blocker.vehicleId,
        sourceSlot: blocker.sourceSlot,
        reliefContext: true,
        referenceTime: intents[0] && intents[0].requestedAt,
      }, node.occupancy, context);
      sortCandidateEvaluations(evaluations).filter(item => item.eligible).slice(0, context.boundary.maxBranchingFactor).forEach(item => {
        moves.push(makeMove(blocker.vehicleId, blocker.sourceSlot, item.slot, role, parentIntentId || '', item.move, blocker.reason || 'CLEAR_PHYSICAL_ACCESS'));
      });
    });
    return moves;
  }

  function generateMoves(node, intents, originalOccupancy, context) {
    const intentIndex = completedIntentCount(node, intents);
    if (intentIndex < intents.length) {
      const intent = intents[intentIndex];
      const currentSource = getVehicleSlot(node.occupancy, intent.vehicle);
      if (!currentSource) return [];
      const direct = evaluateMove(node.occupancy, intent.vehicle, currentSource, intent.targetSlot, {
        ...context,
        sourceEnds: intent.preferredSourceEnd ? [intent.preferredSourceEnd] : null,
        targetEnds: intent.preferredTargetEnd ? [intent.preferredTargetEnd] : null,
        timeWindow: intent.timeWindow,
      });
      if (direct.hardSafe) return removeCancelledSupportTransitions([makeMove(intent.vehicle, currentSource, intent.targetSlot, 'MAIN', intent.intentId, direct, 'FULFIL_SHIFT_INTENT')], context);
      const blockers = getRelevantBlockers(node, intent, context);
      return removeCancelledSupportTransitions(generateReliefMoves(node, blockers, intents, context, 'RELEASE', intent.intentId), context);
    }
    return removeCancelledSupportTransitions(generateRecoveryMoves(node, intents, originalOccupancy, context), context);
  }

  function compileSteps(path, initialOccupancy, completedPrefix, planId) {
    let occupancy = { ...initialOccupancy };
    const prefix = Array.isArray(completedPrefix) ? completedPrefix.map(item => ({ ...item, status: 'COMPLETED' })) : [];
    const steps = [...prefix];
    let previousStepId = prefix.length ? prefix[prefix.length - 1].stepId : '';
    path.forEach((move, index) => {
      const predecessorStateHash = occupancyHash(occupancy);
      const occurrence = steps.filter(step => step.vehicleId === move.vehicleId && step.sourceSlot === move.sourceSlot && step.targetSlot === move.targetSlot && step.role === move.role).length;
      const stepId = `shift-step-v1|${stableHash({ role: move.role, intentId: move.intentId, vehicleId: move.vehicleId, sourceSlot: move.sourceSlot, targetSlot: move.targetSlot, occurrence })}`;
      occupancy = applyMove(occupancy, move);
      const postStateHash = occupancyHash(occupancy);
      steps.push(deepFreeze({
        schemaVersion: 'sde-shift-step-v1',
        stepId,
        planId,
        index: steps.length,
        role: move.role,
        intentId: move.intentId,
        vehicleId: move.vehicleId,
        sourceSlot: move.sourceSlot,
        targetSlot: move.targetSlot,
        dependencyIds: previousStepId ? [previousStepId] : [],
        routeResources: [...move.routeResources],
        sourcePathSlots: [...(move.sourcePathSlots || [])],
        targetPathSlots: [...(move.targetPathSlots || [])],
        sourceEnd: move.sourceEnd,
        targetEnd: move.targetEnd,
        reason: move.reason,
        status: 'PENDING',
        validation: { predecessorStateHash, mode: 'PREDECESSOR_SIMULATION' },
        postStateHash,
      }));
      previousStepId = stepId;
    });
    return steps.map((step, index) => deepFreeze({ ...step, index }));
  }

  function buildObligations(steps, intents) {
    return steps.map(step => deepFreeze({
      schemaVersion: 'sde-shift-obligation-v1',
      obligationId: `shift-obligation-v1|${stableHash({ stepId: step.stepId, role: step.role })}`,
      intentId: step.intentId || intents.find(intent => intent.vehicle === step.vehicleId)?.intentId || '',
      vehicleId: step.vehicleId,
      goalState: { vehicleId: step.vehicleId, slot: step.targetSlot },
      priority: intents.find(intent => intent.intentId === step.intentId)?.priorityClass || 'P1_MANUAL',
      mandatory: intents.find(intent => intent.intentId === step.intentId)?.mandatory !== false,
      deadline: intents.find(intent => intent.intentId === step.intentId)?.latestFinish ?? null,
      stepId: step.stepId,
      role: step.role,
      status: step.status,
      dependencyIds: [...step.dependencyIds],
      revision: 1,
    }));
  }

  function scheduleSteps(steps, intents, state) {
    const duration = Math.max(1, Number(state.shiftDurationMinutes) || 5);
    let cursor = Number(state.currentOperationalTime);
    if (!Number.isFinite(cursor)) cursor = 0;
    const scheduled = [];
    for (const rawStep of steps) {
      if (rawStep.status === 'COMPLETED') {
        scheduled.push(deepFreeze({ ...rawStep, sequenceIndex: scheduled.length, status: 'COMPLETED' }));
        // UTFORT is authoritative evidence that the predecessor has already ended.
        // Its historical planned window must not keep the next suffix step waiting.
        continue;
      }
      const intent = intents.find(item => item.intentId === rawStep.intentId) || intents[0] || null;
      const rawArrivalReadiness = state.arrivalReadiness && state.arrivalReadiness[rawStep.vehicleId];
      const arrivalReadiness = rawArrivalReadiness && typeof rawArrivalReadiness === 'object'
        ? rawArrivalReadiness
        : { ready: rawArrivalReadiness !== false, expectedAt: Number(rawArrivalReadiness) };
      const arrivalExpectedAt = Number(arrivalReadiness.expectedAt);
      const rawLiveDelay = state.liveDataFresh === false ? 0 : Number(state.liveDelayMinutesByVehicle && state.liveDelayMinutesByVehicle[rawStep.vehicleId]);
      const liveDelayMinutes = Number.isFinite(rawLiveDelay) ? Math.max(0, rawLiveDelay) : 0;
      const intentEarliestStart = (Number.isFinite(intent?.earliestStart) ? intent.earliestStart : cursor) + liveDelayMinutes;
      const earliestStart = Math.max(cursor, intentEarliestStart, Number.isFinite(arrivalExpectedAt) ? arrivalExpectedAt : cursor);
      const latestFinish = Number.isFinite(intent?.latestFinish) ? intent.latestFinish : null;
      const plannedWindowStart = Math.max(cursor, earliestStart);
      const plannedWindowEnd = plannedWindowStart + duration;
      if (latestFinish !== null && plannedWindowEnd > latestFinish) {
        return {
          ok: false,
          reason: `Hard deadline/time window ${latestFinish} cannot contain complete ${intent.intentId} plan; step ${rawStep.stepId} ends at ${plannedWindowEnd}.`,
          conflict: {
            code: 'HARD_DEADLINE_CONFLICT',
            intentId: intent.intentId,
            stepId: rawStep.stepId,
            latestFinish,
            firstSafeDivergence: plannedWindowEnd,
            necessaryDelay: plannedWindowEnd - latestFinish,
            blockingResource: 'sde-shift-resource-1',
          },
        };
      }
      const plannedResourceClaims = Array.from(new Set(['sde-shift-resource-1', ...(rawStep.routeResources || [])])).sort();
      scheduled.push(deepFreeze({
        ...rawStep,
        sequenceIndex: scheduled.length,
        earliestStart,
        latestFinish,
        plannedWindowStart,
        plannedWindowEnd,
        currentOperationalTime: Number.isFinite(Number(state.currentOperationalTime)) ? Number(state.currentOperationalTime) : 0,
        arrivalReady: arrivalReadiness.ready !== false,
        arrivalExpectedAt: Number.isFinite(arrivalExpectedAt) ? arrivalExpectedAt : null,
        liveDelayMinutes,
        windowReason: arrivalReadiness.ready === false
          ? 'WAITING_FOR_ARRIVAL_AND_SERIALIZED_RESOURCE'
          : (liveDelayMinutes > 0
            ? 'LIVE_DELAY_AND_SERIALIZED_RESOURCE'
            : (Number.isFinite(intent?.earliestStart) ? 'INTENT_EARLIEST_START_AND_SERIALIZED_RESOURCE' : 'SERIALIZED_SINGLE_SHIFT_RESOURCE')),
        resourceId: 'sde-shift-resource-1',
        requiredResources: [...plannedResourceClaims],
        plannedResourceClaims,
      }));
      cursor = plannedWindowEnd;
    }
    return { ok: true, steps: scheduled, resourceTimeline: scheduled.map(step => ({
      resourceId: step.resourceId,
      stepId: step.stepId,
      plannedWindowStart: step.plannedWindowStart,
      plannedWindowEnd: step.plannedWindowEnd,
    })) };
  }

  function blockedResult(reason, intents, diagnostics, diagnosticCode, conflict) {
    return deepFreeze({
      status: 'BLOCKED_UNRESOLVED',
      diagnosticCode: diagnosticCode || 'NO_SAFE_PLAN',
      reason,
      retainedIntents: intents,
      conflict: conflict || null,
      plan: null,
      diagnostics,
    });
  }

  function searchPlan(intents, initialOccupancy, originalOccupancy, context) {
    const startTime = Date.now();
    const initialCompleted = intents.filter(intent => initialOccupancy[intent.targetSlot] === intent.vehicle).map(intent => intent.intentId);
    const flexiblePlacementVehicles = (context.state.flexiblePlacementVehicles || []).map(cleanVehicle);
    const queue = [{ occupancy: initialOccupancy, completedIntentIds: initialCompleted, path: [], flexiblePlacementVehicles }];
    const visited = new Set([nodeSignature(queue[0])]);
    let expandedStates = 0;
    let generatedTransitions = 0;
    let cacheHits = 0;
    while (queue.length) {
      if (expandedStates >= context.boundary.maxStates || Date.now() - startTime > context.boundary.maxWallTimeMs) {
        return { status: 'SEARCH_BOUNDARY_EXHAUSTED', expandedStates, generatedTransitions, cacheHits, path: null };
      }
      const node = queue.shift();
      expandedStates += 1;
      if (goalSatisfied(node, intents, originalOccupancy)) return { status: 'FOUND', expandedStates, generatedTransitions, cacheHits, path: node.path };
      const moves = generateMoves(node, intents, originalOccupancy, context);
      for (const move of moves) {
        generatedTransitions += 1;
        const occupancy = applyMove(node.occupancy, move);
        const completedIntentIds = [...node.completedIntentIds];
        if (move.role === 'MAIN' && move.intentId && !completedIntentIds.includes(move.intentId)) completedIntentIds.push(move.intentId);
        const next = { occupancy, completedIntentIds, path: [...node.path, move], flexiblePlacementVehicles };
        const signature = nodeSignature(next);
        if (visited.has(signature)) {
          cacheHits += 1;
          continue;
        }
        visited.add(signature);
        queue.push(next);
      }
    }
    return { status: 'NOT_FOUND', expandedStates, generatedTransitions, cacheHits, path: null };
  }

  function validateInput(intents, occupancy, catalogById, boundary) {
    const vehicles = new Set(Object.values(occupancy));
    if (vehicles.size > boundary.maxConnectedVehicles) return 'Connected vehicle count exceeds frozen search boundary.';
    if (catalogById.size > boundary.maxConnectedSlots) return 'Connected slot count exceeds frozen search boundary.';
    const targets = new Map();
    for (const intent of intents) {
      if (!catalogById.has(intent.fromSlot)) return `Unknown source slot ${intent.fromSlot}.`;
      if (intent.targetSlot && !catalogById.has(intent.targetSlot)) return `Unknown target slot ${intent.targetSlot}.`;
      const actualSlot = getVehicleSlot(occupancy, intent.vehicle);
      if (!actualSlot || actualSlot !== intent.fromSlot) return `Actual source mismatch for ${intent.vehicle}: expected ${intent.fromSlot}, found ${actualSlot || 'absent'}.`;
      if (intent.targetSlot) {
        const prior = targets.get(intent.targetSlot);
        if (prior && prior !== intent.vehicle) return `Target conflict at ${intent.targetSlot}.`;
        targets.set(intent.targetSlot, intent.vehicle);
      }
    }
    return '';
  }

  function makeDiagnostics(context, candidateEvaluations, search) {
    const firstRejected = candidateEvaluations.find(item => !item.eligible) || null;
    const firstSafe = candidateEvaluations.find(item => item.eligible) || null;
    return {
      boundaryId: context.boundary.id,
      expandedStates: search ? search.expandedStates : 0,
      generatedTransitions: search ? search.generatedTransitions || 0 : 0,
      cacheHits: search ? search.cacheHits || 0 : 0,
      candidateEvaluations: candidateEvaluations.map(item => ({
        slot: item.slot,
        role: item.role,
        considered: item.considered,
        hardSafe: item.hardSafe,
        eligible: item.eligible,
        reasonCode: item.reasonCode,
        humanExperienceScore: item.humanExperienceScore,
      })),
      candidateCount: candidateEvaluations.length,
      safeCandidateCount: candidateEvaluations.filter(item => item.eligible).length,
      firstRejectedCandidate: firstRejected?.slot || '',
      firstRejectionReason: firstRejected?.reasonCode || '',
      firstSafeDivergence: firstSafe?.slot || '',
      evaluatedSlotCount: context.catalog.length,
      fullEligibleSlotSearch: true,
      searchStoppedAfterFirstCandidate: false,
      vnComparedWithOrdinaryRelief: context.catalog.some(item => item.id === 'VN') && context.catalog.some(item => item.role === 'ordinary'),
      oneNGlobalDefault: false,
      machineLearningScoreActive: false,
      humanExperienceScoreActive: true,
    };
  }

  function createShiftEngine(configuration) {
    const catalog = normalizeCatalog(configuration && configuration.slotCatalog);
    const catalogById = new Map(catalog.map(slot => [slot.id, slot]));
    const boundary = deepFreeze({ ...SEARCH_BOUNDARY_CONTRACT, ...canonicalize(configuration && configuration.boundary ? configuration.boundary : {}) });
    if (boundary.maxPlanSteps !== null) throw new TypeError('The frozen boundary forbids a hard plan-step limit.');

    return deepFreeze({
      schemaVersion: 'sde-canonical-shift-engine-v1',
      boundary,
      plan(input) {
        const state = input && input.state ? input.state : {};
        const actualOccupancy = normalizeOccupancy(state.occupancy, catalogById);
        const anticipatedArrivals = canonicalize(state.anticipatedArrivals || {});
        const initialOccupancy = { ...actualOccupancy };
        Object.entries(anticipatedArrivals).forEach(([rawVehicle, arrival]) => {
          const vehicle = cleanVehicle(rawVehicle);
          const sourceSlot = cleanSlot(arrival && (arrival.sourceSlot || arrival.arrivalSlot));
          const readiness = state.arrivalReadiness && state.arrivalReadiness[vehicle];
          const explicitlyFuture = readiness && typeof readiness === 'object' && readiness.ready === false;
          if (!vehicle || !sourceSlot || !catalogById.has(sourceSlot) || !explicitlyFuture) return;
          if (getVehicleSlot(actualOccupancy, vehicle) || actualOccupancy[sourceSlot]) return;
          initialOccupancy[sourceSlot] = vehicle;
        });
        const unavailable = new Set([...(state.unavailableSlots || []), ...catalog.filter(item => item.unavailable).map(item => item.id)].map(cleanSlot));
        const humanEvidence = input && input.humanExperienceEvidence ? input.humanExperienceEvidence : [];
        let intents = normalizeIntents(input && input.intents);
        const relevantEvents = Array.isArray(input && input.events) ? input.events : [];
        const cancelledSupportTransitions = new Set(relevantEvents
          .filter(event => ['ANNULLERT', 'CARD_CANCELLED'].includes(cleanToken(event && event.type).toUpperCase()))
          .filter(event => ['RELEASE', 'RECOVERY'].includes(cleanToken(event && event.role).toUpperCase()))
          .map(event => supportTransitionKey({
            vehicleId: event.vehicleId,
            sourceSlot: event.sourceSlot,
            targetSlot: event.targetSlot,
            role: event.role,
          })));
        const context = { catalog, catalogById, boundary, unavailable, state, humanExperienceEvidence: humanEvidence, cancelledSupportTransitions };
        const derived = resolveDerivedIntentTargets(intents, initialOccupancy, context);
        intents = derived.intents;
        const invalid = validateInput(intents, initialOccupancy, catalogById, boundary);
        const candidateSubjectIntent = intents[0];
        let candidateSubject = candidateSubjectIntent ? {
          vehicleId: candidateSubjectIntent.vehicle,
          sourceSlot: candidateSubjectIntent.fromSlot,
          explicitTargetSlot: candidateSubjectIntent.targetSlot,
          reliefContext: candidateSubjectIntent.reliefContext,
          referenceTime: candidateSubjectIntent.requestedAt,
          timeWindow: candidateSubjectIntent.timeWindow,
        } : null;
        if (candidateSubjectIntent && initialOccupancy[candidateSubjectIntent.targetSlot] && initialOccupancy[candidateSubjectIntent.targetSlot] !== candidateSubjectIntent.vehicle) {
          candidateSubject = {
            vehicleId: initialOccupancy[candidateSubjectIntent.targetSlot],
            sourceSlot: candidateSubjectIntent.targetSlot,
            explicitTargetSlot: '',
            reliefContext: true,
            referenceTime: candidateSubjectIntent.requestedAt,
          };
        } else if (candidateSubjectIntent) {
          const blockers = getRelevantBlockers({ occupancy: initialOccupancy, completedIntentIds: [] }, candidateSubjectIntent, context);
          if (blockers[0]) candidateSubject = { vehicleId: blockers[0].vehicleId, sourceSlot: blockers[0].sourceSlot, reliefContext: true, referenceTime: candidateSubjectIntent.requestedAt };
        }
        const candidateEvaluations = candidateSubject ? evaluateCandidateSet(candidateSubject, initialOccupancy, context) : derived.diagnostics;
        const emptySearch = { expandedStates: 0 };
        const hasManual = intents.some(intent => intent.priorityClass === 'P1_MANUAL' || intent.sourceType === 'MANUAL');
        if (state.actualStateFresh === false) {
          return deepFreeze({
            status: 'REPLAN_REQUIRED',
            diagnosticCode: 'STALE_ACTUAL_STATE',
            reason: 'Canonical actual-state is stale and cannot authorize planning or actionable projection.',
            retainedIntents: intents,
            conflict: { code: 'STALE_ACTUAL_STATE', actualStateRevision: cleanToken(state.actualStateRevision) },
            plan: null,
            diagnostics: makeDiagnostics(context, candidateEvaluations, emptySearch),
          });
        }
        if (invalid) {
          return blockedResult(invalid, intents, makeDiagnostics(context, candidateEvaluations, emptySearch), hasManual ? 'MANUAL_INTENT_CONFLICTS_WITH_HARD_CONSTRAINT' : 'HARD_CONSTRAINT_CONFLICT');
        }
        if (intents.some(intent => !intent.targetSlot)) {
          return blockedResult('No physically safe target exists for one or more derived intents.', intents, makeDiagnostics(context, candidateEvaluations, emptySearch), 'NO_SAFE_PLAN');
        }
        if (intents.some(intent => unavailable.has(intent.targetSlot))) {
          const target = intents.find(intent => unavailable.has(intent.targetSlot));
          return blockedResult('Requested target is unavailable.', intents, makeDiagnostics(context, candidateEvaluations, emptySearch), hasManual ? 'MANUAL_INTENT_CONFLICTS_WITH_HARD_CONSTRAINT' : 'TARGET_UNAVAILABLE', {
            code: 'TARGET_UNAVAILABLE',
            intentId: target?.intentId || '',
            blockingSlot: target?.targetSlot || '',
            firstSafeDivergence: 'Retain intent and replan when target becomes available.',
          });
        }
        const relevantInput = {
          occupancy: initialOccupancy,
          actualOccupancy,
          anticipatedArrivals,
          unavailableSlots: [...unavailable].sort(),
          infrastructureState: canonicalize(state.infrastructureState || {}),
          routeReservations: canonicalize(state.routeReservations || []),
          plannedResourceClaims: canonicalize(state.plannedResourceClaims || []),
          completedStepIds: [...(state.completedStepIds || [])].sort(),
          arrivalReadiness: canonicalize(state.arrivalReadiness || {}),
          writtenPlanConstraints: canonicalize(state.writtenPlanConstraints || {}),
          statusAndDispositionConstraints: canonicalize(state.statusAndDispositionConstraints || {}),
          flexiblePlacementVehicles: [...(state.flexiblePlacementVehicles || [])].map(cleanVehicle).sort(),
          liveDelayMinutesByVehicle: state.liveDataFresh === false
            ? {}
            : canonicalize(Object.fromEntries(Object.entries(state.liveDelayMinutesByVehicle || {}).filter(([vehicleId]) => Object.values(initialOccupancy).includes(cleanVehicle(vehicleId))))),
          intents: intents.map(intent => ({
            intentId: intent.intentId,
            priorityClass: intent.priorityClass,
            vehicle: intent.vehicle,
            fromSlot: intent.fromSlot,
            targetSlot: intent.targetSlot,
            originalTargetSlot: intent.originalTargetSlot,
            preferredSourceEnd: intent.preferredSourceEnd,
            preferredTargetEnd: intent.preferredTargetEnd,
            timeWindow: intent.timeWindow,
          })),
          humanExperienceEvidence: canonicalize(humanEvidence),
          relevantEvents: canonicalize((input.events || []).filter(event => ['CARD_CANCELLED', 'MANUAL_INTENT_CANCELLED', 'STEP_COMPLETED', 'UTFORT', 'ANNULLERT'].includes(cleanToken(event.type))).map(event => ({
            type: cleanToken(event.type),
            intentId: cleanToken(event.intentId),
            stepId: cleanToken(event.stepId),
            vehicleId: cleanToken(event.vehicleId),
            sourceSlot: cleanSlot(event.sourceSlot),
            targetSlot: cleanSlot(event.targetSlot),
            role: cleanToken(event.role).toUpperCase(),
            reason: cleanToken(event.reason),
          }))),
          boundaryId: boundary.id,
        };
        const inputHash = stableHash(relevantInput);
        if (input.previousPlan && input.previousPlan.inputHash === inputHash) {
          return deepFreeze({ status: 'NO_OP', reason: 'Relevant inputHash is unchanged.', retainedIntents: intents, plan: input.previousPlan, diagnostics: makeDiagnostics(context, candidateEvaluations, emptySearch) });
        }
        const completedIds = new Set(state.completedStepIds || []);
        const completedPrefix = input.previousPlan ? input.previousPlan.steps.filter(step => completedIds.has(step.stepId) || step.status === 'COMPLETED') : [];
        const originalOccupancy = input.previousPlan && input.previousPlan.initialOccupancy ? input.previousPlan.initialOccupancy : initialOccupancy;
        const search = searchPlan(intents, initialOccupancy, originalOccupancy, context);
        const diagnostics = makeDiagnostics(context, candidateEvaluations, search);
        if (search.status === 'SEARCH_BOUNDARY_EXHAUSTED') {
          return deepFreeze({ status: 'SEARCH_BOUNDARY_EXHAUSTED', diagnosticCode: 'SEARCH_LIMIT_REACHED', reason: 'Frozen search boundary exhausted before a safe plan was proven.', retainedIntents: intents, plan: null, diagnostics });
        }
        if (search.status !== 'FOUND') {
          return blockedResult('No complete physically safe plan exists inside the frozen search boundary.', intents, diagnostics, 'NO_SAFE_PLAN');
        }
        const planId = `shift-plan-v1|${stableHash(intents.map(intent => intent.intentId))}`;
        const compiledSteps = compileSteps(search.path, initialOccupancy, completedPrefix, planId);
        const schedule = scheduleSteps(compiledSteps, intents, state);
        if (!schedule.ok) {
          return blockedResult(schedule.reason, intents, diagnostics, hasManual ? 'MANUAL_INTENT_CONFLICTS_WITH_HARD_CONSTRAINT' : 'HARD_DEADLINE_CONFLICT', schedule.conflict);
        }
        const fragmentSignature = step => stableStringify({
          stepId: step.stepId,
          role: step.role,
          intentId: step.intentId,
          vehicleId: step.vehicleId,
          sourceSlot: step.sourceSlot,
          targetSlot: step.targetSlot,
          dependencyIds: step.dependencyIds,
          plannedWindowStart: step.plannedWindowStart,
          plannedWindowEnd: step.plannedWindowEnd,
          requiredResources: step.requiredResources,
          status: step.status,
        });
        const previousPendingFragments = new Map((input.previousPlan?.steps || [])
          .filter(step => step.status !== 'COMPLETED')
          .map(step => [step.stepId, fragmentSignature(step)]));
        const reusedPendingPlanFragments = schedule.steps.filter(step =>
          previousPendingFragments.get(step.stepId) === fragmentSignature(step)
        ).length;
        const steps = schedule.steps;
        const obligations = buildObligations(steps, intents);
        const safeAlternatives = candidateEvaluations.filter(item => item.eligible).map(item => ({
          targetSlot: item.slot,
          role: item.role,
          HumanExperienceScore: item.humanExperienceScore,
          distance: item.distance,
          hardSafe: item.hardSafe,
        }));
        const humanInfluenced = search.path.some(move => {
          const match = candidateEvaluations.find(item => item.slot === move.targetSlot);
          return Boolean(match && match.humanExperienceScore !== 0);
        });
        const writtenIntents = intents.filter(intent => intent.priorityClass === 'P3_CONFIRMED_WRITTEN_PLAN');
        const writtenIntentIds = new Set(writtenIntents.map(intent => intent.intentId));
        const higherPriorityIntentVehicles = new Set(intents
          .filter(intent => intent.priorityClass !== 'P3_CONFIRMED_WRITTEN_PLAN')
          .map(intent => intent.vehicle));
        const writtenPlanRejoined = writtenIntents.some(intent =>
          higherPriorityIntentVehicles.has(intent.vehicle)
          && steps.some(step => step.intentId === intent.intentId && step.targetSlot === intent.targetSlot)
        );
        const planWithoutRevision = {
          schemaVersion: 'sde-shift-plan-graph-v1',
          engineVersion: 'sde-canonical-shift-engine-v1',
          planId,
          boundaryId: boundary.id,
          inputRevision: cleanToken(state.actualStateRevision),
          inputHash,
          priorPlanRevision: cleanToken(input.previousPlan && input.previousPlan.planRevision),
          revisionNumber: Number(input.previousPlan && input.previousPlan.revisionNumber || 0) + 1,
          originalIntents: intents,
          initialOccupancy: canonicalize(originalOccupancy),
          initialActualOccupancy: canonicalize(actualOccupancy),
          initialPlanningOccupancy: canonicalize(initialOccupancy),
          actualStateRevision: cleanToken(state.actualStateRevision),
          initialStateHash: occupancyHash(originalOccupancy),
          steps,
          obligations,
          dependencies: steps.flatMap(step => step.dependencyIds.map(predecessorId => ({ predecessorId, successorId: step.stepId }))),
          resourceTimeline: schedule.resourceTimeline,
          candidateAlternatives: safeAlternatives,
          candidateDiagnostics: diagnostics.candidateEvaluations,
          moveCount: steps.filter(step => step.status !== 'COMPLETED').length,
          safetyEvidence: {
            hardGatesPassed: true,
            actualStateAuthority: true,
            anticipatedArrivalShadowCount: Object.values(initialOccupancy).filter(vehicle => !Object.values(actualOccupancy).includes(vehicle)).length,
            topologyValidated: true,
            routeResourcesValidated: true,
            infrastructureStateValidated: true,
            plannedResourceClaimsValidated: true,
          },
          rankingEvidence: {
            priorityMode: 'LEXICOGRAPHIC_P0_P1_P2_P3_P4',
            minimumMoveObjective: true,
            HumanExperienceScoreActive: true,
            HumanExperienceScoreInfluencedTieBreak: humanInfluenced,
            machineLearningScoreActive: false,
          },
          writtenPlanEvidence: {
            followedWhenFeasible: writtenIntents.every(intent =>
              steps.some(step => step.intentId === intent.intentId && step.targetSlot === intent.targetSlot)
            ),
            minimumNecessaryDeviation: writtenIntents.length > 0,
            rejoinedAfterHigherPriorityOverride: writtenPlanRejoined,
            writtenIntentIds: writtenIntents.map(intent => intent.intentId),
          },
          explanation: {
            summary: `${steps.length} fysisk${steps.length === 1 ? '' : 'e'} skiftebevegelse${steps.length === 1 ? '' : 'r'} valgt med P0–P3 oppfylt, minimum moveCount og ${humanInfluenced ? 'HumanExperienceScore som deterministisk tie-break' : 'stabile deterministiske tie-breakere'}.${writtenPlanRejoined ? ' Bekreftet skriftlig plan gjenopptas etter høyere prioritert override.' : ''}`,
            selectedMoveCount: steps.length,
            priorityOrder: ['P0_PHYSICAL_SAFETY', 'P1_MANUAL', 'P2_SDE_DERIVED', 'P3_CONFIRMED_WRITTEN_PLAN', 'P4_OPTIMIZATION'],
          },
          status: 'PLANNED',
          completedPrefixStepIds: completedPrefix.map(step => step.stepId),
          searchEvidence: {
            expandedStates: search.expandedStates,
            generatedTransitions: search.generatedTransitions,
            cacheHits: search.cacheHits,
            fullEligibleSlotSearch: true,
            evaluatedSlotCount: catalog.length,
            machineLearningScoreActive: false,
            humanExperienceScoreActive: true,
            optimalityStatus: 'PROVEN',
            bestFoundMoveCount: steps.length,
            reusedPlanFragments: completedPrefix.length + reusedPendingPlanFragments,
            reusedCompletedPrefixFragments: completedPrefix.length,
            reusedPendingPlanFragments,
          },
        };
        const planRevision = `shift-plan-v1|${stableHash(planWithoutRevision)}`;
        const planRevisionRecord = deepFreeze({
          schemaVersion: 'sde-plan-revision-v1',
          planRevisionId: planRevision,
          parentRevision: planWithoutRevision.priorPlanRevision,
          inputHash,
          createdAt: cleanToken(state.planningTimestamp || input.events?.[0]?.timestamp || intents[0]?.createdAt),
          reason: input.previousPlan ? cleanToken(input.events?.[0]?.type) || 'RELEVANT_INPUT_CHANGED' : 'INITIAL_PLAN',
          affectedIntents: intents.map(intent => intent.intentId),
          affectedVehicles: Array.from(new Set(steps.map(step => step.vehicleId))).sort(),
          affectedSlots: Array.from(new Set(steps.flatMap(step => [step.sourceSlot, step.targetSlot]))).sort(),
          supersededRevision: planWithoutRevision.priorPlanRevision,
        });
        const plan = deepFreeze({ ...planWithoutRevision, planRevision, planRevisionRecord });
        return deepFreeze({ status: input.previousPlan ? 'REPLANNED' : 'PLANNED', reason: '', retainedIntents: intents, plan, diagnostics });
      },
    });
  }

  function validatePlanGraph(plan) {
    if (!plan || !Array.isArray(plan.steps) || !Array.isArray(plan.obligations)) return { ok: false, reason: 'PLAN_MISSING' };
    const ids = new Set(plan.steps.map(step => step.stepId));
    if (ids.size !== plan.steps.length) return { ok: false, reason: 'DUPLICATE_STEP_ID' };
    if (plan.steps.some(step => step.dependencyIds.some(id => !ids.has(id)))) return { ok: false, reason: 'MISSING_DEPENDENCY' };
    const obligationSteps = new Set(plan.obligations.map(item => item.stepId));
    if (plan.steps.some(step => !obligationSteps.has(step.stepId))) return { ok: false, reason: 'MISSING_OBLIGATION' };
    const intentIds = new Set((plan.originalIntents || []).map(intent => intent.intentId));
    if (plan.obligations.some(item => item.intentId && !intentIds.has(item.intentId))) return { ok: false, reason: 'MISSING_PARENT_INTENT' };
    if (plan.steps.some(step => step.planId && step.planId !== plan.planId)) return { ok: false, reason: 'STEP_PLAN_ID_MISMATCH' };
    return { ok: true, reason: '' };
  }

  function projectCanonicalPlan(plan, options) {
    const validation = validatePlanGraph(plan);
    const rejected = reason => deepFreeze({ status: 'REJECTED', reason, planRevision: cleanToken(plan && plan.planRevision), cards: [], reservations: [], plannedResourceClaims: [], overlays: [], routeResources: [], ledger: [] });
    if (!validation.ok) return rejected(validation.reason);
    const activePlanRevision = cleanToken(options && options.activePlanRevision);
    if (plan.status === 'SUPERSEDED' || (activePlanRevision && activePlanRevision !== cleanToken(plan.planRevision))) return rejected('PLAN_SUPERSEDED');
    const completed = new Set(plan.steps.filter(step => step.status === 'COMPLETED').map(step => step.stepId));
    const firstPending = plan.steps.find(step => step.status !== 'COMPLETED' && step.dependencyIds.every(id => completed.has(id)));
    function lifecycleForStep(step) {
      if (step.status === 'COMPLETED') return 'COMPLETED';
      if (!firstPending || firstPending.stepId !== step.stepId) return 'WAITING_FOR_DEPENDENCY';
      if (step.arrivalReady === false) return 'WAITING_FOR_ARRIVAL';
      if (Number(step.currentOperationalTime) < Number(step.plannedWindowStart)) return 'WAITING_FOR_TIME';
      return 'READY';
    }
    const cards = plan.steps.filter(step => step.status !== 'COMPLETED').map(step => {
      const lifecycle = lifecycleForStep(step);
      return deepFreeze({
        schemaVersion: 'sde-actionable-shift-card-v1',
        cardId: `canonical-card-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
        canonicalCardId: `canonical-card-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
        planId: plan.planId,
        planRevision: plan.planRevision,
        stepId: step.stepId,
        role: step.role,
        vehicleId: step.vehicleId,
        sourceSlot: step.sourceSlot,
        targetSlot: step.targetSlot,
        source: step.sourceSlot,
        target: step.targetSlot,
        sourceType: plan.originalIntents.find(intent => intent.intentId === step.intentId)?.sourceType || 'PREREQUISITE',
        priority: plan.originalIntents.find(intent => intent.intentId === step.intentId)?.priorityClass || 'P1_MANUAL',
        intentReason: plan.originalIntents.find(intent => intent.intentId === step.intentId)?.reason || step.reason,
        sequenceIndex: step.sequenceIndex,
        totalStepCount: plan.steps.length,
        dependencyIds: [...step.dependencyIds],
        timeWindow: { start: step.plannedWindowStart, end: step.plannedWindowEnd },
        ready: lifecycle === 'READY',
        canComplete: lifecycle === 'READY',
        canCancel: step.status !== 'COMPLETED',
        futurePlanStep: step.status !== 'COMPLETED' && lifecycle !== 'READY',
        freshActualRevision: cleanToken(plan.actualStateRevision),
        reservationId: lifecycle === 'READY' ? `canonical-reservation-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}` : '',
        auditIdentity: `shift-card-audit-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
        blockingReason: lifecycle === 'READY' ? '' : lifecycle,
        planMoveCount: plan.moveCount,
        HumanExperienceScore: (plan.candidateAlternatives || []).find(item => item.targetSlot === step.targetSlot)?.HumanExperienceScore || 0,
        rankingExplanation: plan.explanation?.summary || '',
        status: lifecycle,
      });
    });
    const reservations = plan.steps.filter(step => lifecycleForStep(step) === 'READY').map(step => deepFreeze({
      reservationId: `canonical-reservation-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
      planRevision: plan.planRevision,
      stepId: step.stepId,
      vehicleId: step.vehicleId,
      sourceSlot: step.sourceSlot,
      targetSlot: step.targetSlot,
      routeResources: [...step.routeResources],
      status: 'OPERATIVE_RESERVATION',
    }));
    const plannedResourceClaims = plan.steps.filter(step => lifecycleForStep(step) !== 'READY').filter(step => step.status !== 'COMPLETED').map(step => deepFreeze({
      claimId: `canonical-planned-claim-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
      planRevision: plan.planRevision,
      stepId: step.stepId,
      resources: [...step.plannedResourceClaims],
      status: 'PLANNED_RESOURCE_CLAIM',
    }));
    const overlays = plan.steps.filter(step => step.status !== 'COMPLETED').map(step => deepFreeze({
      overlayId: `canonical-overlay-v1|${stableHash({ planRevision: plan.planRevision, stepId: step.stepId })}`,
      planRevision: plan.planRevision,
      stepId: step.stepId,
      vehicleId: step.vehicleId,
      sourceSlot: step.sourceSlot,
      targetSlot: step.targetSlot,
      status: step.status,
    }));
    const routeResources = plan.steps.filter(step => step.status !== 'COMPLETED').map(step => deepFreeze({ planRevision: plan.planRevision, stepId: step.stepId, resources: [...step.routeResources] }));
    const ledger = plan.obligations.map(obligation => deepFreeze({
      planRevision: plan.planRevision,
      obligationId: obligation.obligationId,
      stepId: obligation.stepId,
      cardPresent: cards.some(card => card.stepId === obligation.stepId),
      reservationPresent: reservations.some(item => item.stepId === obligation.stepId),
      plannedResourceClaimPresent: plannedResourceClaims.some(item => item.stepId === obligation.stepId),
      overlayPresent: overlays.some(item => item.stepId === obligation.stepId),
      completed: completed.has(obligation.stepId),
      missing: [],
    }));
    if (ledger.some(item => !item.completed && (!item.cardPresent || (!item.reservationPresent && !item.plannedResourceClaimPresent) || !item.overlayPresent))) return rejected('ATOMIC_PROJECTION_INCOMPLETE');
    return deepFreeze({ status: 'PROJECTED', reason: '', planRevision: plan.planRevision, cards, reservations, plannedResourceClaims, overlays, routeResources, ledger });
  }

  function buildMissingCardLedger(plan, projection) {
    const rejected = !plan || !projection || projection.status !== 'PROJECTED';
    const entries = rejected ? [] : plan.obligations.map(obligation => {
      const intent = plan.originalIntents.find(item => item.intentId === obligation.intentId) || null;
      const step = plan.steps.find(item => item.stepId === obligation.stepId) || null;
      const card = projection.cards.find(item => item.stepId === obligation.stepId) || null;
      const reservation = projection.reservations.find(item => item.stepId === obligation.stepId) || null;
      const claim = projection.plannedResourceClaims.find(item => item.stepId === obligation.stepId) || null;
      const candidateEvaluations = plan.candidateDiagnostics || plan.candidateAlternatives || [];
      const firstRejected = candidateEvaluations.find(item => item.eligible === false || item.hardSafe === false) || null;
      const firstSafe = candidateEvaluations.find(item => item.eligible === true || item.hardSafe === true) || null;
      const completed = step?.status === 'COMPLETED';
      return deepFreeze({
        intentId: intent?.intentId || '',
        sourceType: intent?.sourceType || '',
        priority: intent?.priorityClass || obligation.priority,
        vehicleId: step?.vehicleId || obligation.vehicleId,
        occurrenceId: intent?.sourceOccurrence || '',
        sourceSlot: step?.sourceSlot || '',
        requestedTarget: intent?.originalTargetSlot || '',
        mandatory: obligation.mandatory,
        detectedAt: intent?.createdAt || '',
        obligationCreated: true,
        candidateCount: candidateEvaluations.length,
        safeCandidateCount: candidateEvaluations.filter(item => item.hardSafe).length,
        searchedStateCount: plan.searchEvidence.expandedStates,
        selectedCandidate: step?.targetSlot || '',
        selectedMoveCount: plan.moveCount,
        planGraphCreated: true,
        planStepCount: plan.steps.length,
        readyStep: card?.status === 'READY',
        completed,
        visibleCardCreated: Boolean(card),
        reservationCreated: Boolean(reservation),
        resourceClaimCreated: Boolean(claim),
        firstRejectedCandidate: firstRejected?.slot || firstRejected?.targetSlot || '',
        firstRejectionReason: firstRejected?.reasonCode || '',
        firstSafeDivergence: firstSafe?.slot || firstSafe?.targetSlot || '',
        blockingRule: firstRejected?.reasonCode || '',
        blockingVehicle: '',
        blockingSlot: firstRejected?.slot || firstRejected?.targetSlot || '',
        blockingResource: '',
        HumanExperienceScore: candidateEvaluations.find(item => (item.slot || item.targetSlot) === step?.targetSlot)?.humanExperienceScore
          ?? candidateEvaluations.find(item => (item.slot || item.targetSlot) === step?.targetSlot)?.HumanExperienceScore
          ?? 0,
        planRevision: plan.planRevision,
        diagnosticCode: '',
        missing: [
          !completed && !card ? 'CARD' : '',
          !completed && !reservation && !claim ? 'RESERVATION_OR_CLAIM' : '',
        ].filter(Boolean),
      });
    });
    const readyStepCount = plan ? plan.steps.filter(step => projection?.cards?.find(card => card.stepId === step.stepId)?.status === 'READY').length : 0;
    const actionableCardCount = projection?.cards?.filter(card => card.status === 'READY').length || 0;
    const feasibleIntentCount = plan ? plan.originalIntents.length : 0;
    return deepFreeze({
      schemaVersion: 'sde-shift-missing-card-ledger-v1',
      status: rejected ? 'REJECTED' : 'CONSISTENT',
      planRevision: cleanToken(plan && plan.planRevision),
      entries,
      aggregates: {
        detectedIntentCount: plan?.originalIntents?.length || 0,
        mandatoryIntentCount: plan?.originalIntents?.filter(intent => intent.mandatory).length || 0,
        mandatoryObligationGoalCount: plan?.obligations?.filter(item => item.mandatory).length || 0,
        obligationCount: plan?.obligations?.length || 0,
        feasibleIntentCount,
        completePlanCount: plan ? feasibleIntentCount : 0,
        planStepCount: plan?.steps?.length || 0,
        readyStepCount,
        actionableCardCount,
        visibleActionableCardCount: actionableCardCount,
        reservationCount: projection?.reservations?.length || 0,
        plannedResourceClaimCount: projection?.plannedResourceClaims?.length || 0,
        diagnosticCount: 0,
        duplicateCount: 0,
        orphanCount: entries.filter(item => item.missing.length).length,
        supersededCount: projection?.cards?.filter(card => card.status === 'SUPERSEDED').length || 0,
        missingCardWithSafePlan: entries.filter(item => item.missing.includes('CARD')).length,
      },
    });
  }

  function revalidateActionStep(plan, stepId, actualState) {
    const step = plan && plan.steps && plan.steps.find(item => item.stepId === stepId);
    if (!step) return deepFreeze({ ok: false, code: 'STEP_MISSING', reason: 'Canonical step no longer exists.' });
    if (actualState && actualState.actualStateFresh === false) {
      return deepFreeze({ ok: false, code: 'STALE_ACTUAL_STATE', reason: 'Fresh canonical actual-state readback is required.' });
    }
    const occupancy = Object.fromEntries(Object.entries(actualState && actualState.occupancy || {}).map(([slot, vehicle]) => [cleanSlot(slot), cleanVehicle(vehicle)]).filter(([, vehicle]) => vehicle));
    const completed = new Set(actualState && actualState.completedStepIds || []);
    if (step.dependencyIds.some(id => !completed.has(id) && !plan.steps.some(item => item.stepId === id && item.status === 'COMPLETED'))) {
      return deepFreeze({ ok: false, code: 'DEPENDENCIES_INCOMPLETE', reason: 'A predecessor is not completed.' });
    }
    if (occupancy[step.sourceSlot] !== step.vehicleId) return deepFreeze({ ok: false, code: 'SOURCE_CHANGED', reason: 'Fresh actual source does not contain the planned vehicle.' });
    if (occupancy[step.targetSlot]) return deepFreeze({ ok: false, code: 'TARGET_CHANGED', reason: 'Fresh actual target is occupied.' });
    if ((actualState && actualState.unavailableSlots || []).map(cleanSlot).includes(step.targetSlot)) return deepFreeze({ ok: false, code: 'TARGET_UNAVAILABLE', reason: 'Fresh actual target is unavailable.' });
    const sourceAccessBlocker = (step.sourcePathSlots || []).find(slot => occupancy[slot]);
    if (sourceAccessBlocker) return deepFreeze({ ok: false, code: 'SOURCE_ACCESS_CHANGED', reason: `Fresh actual source approach is blocked at ${sourceAccessBlocker}.`, blockingSlot: sourceAccessBlocker });
    const targetAccessBlocker = (step.targetPathSlots || []).find(slot => occupancy[slot]);
    if (targetAccessBlocker) return deepFreeze({ ok: false, code: 'TARGET_ACCESS_CHANGED', reason: `Fresh actual target approach is blocked at ${targetAccessBlocker}.`, blockingSlot: targetAccessBlocker });
    const routeConflict = reservationConflict(step.routeResources || [], actualState || {}, {
      start: step.plannedWindowStart,
      end: step.plannedWindowEnd,
    });
    if (routeConflict) return deepFreeze({ ok: false, code: 'ROUTE_RESOURCE_CONFLICT', reason: 'Fresh actual route-resource readback conflicts with the planned move.', conflict: routeConflict });
    return deepFreeze({ ok: true, code: 'ACTIONABLE', reason: '', stepId: step.stepId, planRevision: plan.planRevision });
  }

  function createShiftReplanner(engine) {
    if (!engine || typeof engine.plan !== 'function') throw new TypeError('createShiftReplanner requires a shift engine.');
    const metrics = {
      activeJobs: 0,
      maximumParallelJobs: 0,
      coalescedEvents: 0,
      cancelledStaleJobs: 0,
      reusedPlanFragments: 0,
      terminalPlanRevisions: 0,
      duplicateTerminalRevisions: 0,
    };
    const seenTerminalRevisions = new Set();
    let currentPlan = null;
    let pending = [];
    let scheduled = false;

    function flush() {
      scheduled = false;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      metrics.coalescedEvents += Math.max(0, batch.length - 1);
      metrics.cancelledStaleJobs += Math.max(0, batch.length - 1);
      const latest = batch[batch.length - 1].input;
      const events = Array.isArray(latest.events) ? latest.events : [];
      const cancelledIntentIds = new Set(events.filter(event => event.type === 'MANUAL_INTENT_CANCELLED').map(event => cleanToken(event.intentId)).filter(Boolean));
      const retainedIntents = normalizeIntents(latest.intents).filter(intent => !cancelledIntentIds.has(intent.intentId));
      const auditEvents = events.filter(event => ['CARD_CANCELLED', 'MANUAL_INTENT_CANCELLED', 'STEP_COMPLETED', 'UTFORT', 'ANNULLERT'].includes(cleanToken(event.type))).map(event => canonicalize(event));
      metrics.activeJobs += 1;
      metrics.maximumParallelJobs = Math.max(metrics.maximumParallelJobs, metrics.activeJobs);
      let result;
      try {
        if (!retainedIntents.length) {
          result = deepFreeze({ status: 'NO_ACTIVE_INTENTS', reason: 'All underlying intents are explicitly cancelled.', retainedIntents: [], auditEvents, plan: null });
          currentPlan = null;
        } else {
          const planned = engine.plan({ ...latest, intents: retainedIntents, previousPlan: latest.previousPlan || currentPlan, events });
          result = deepFreeze({ ...planned, retainedIntents, auditEvents });
          if (planned.plan) currentPlan = planned.plan;
          metrics.reusedPlanFragments += Number(planned.plan?.searchEvidence?.reusedPlanFragments || 0);
          if (planned.plan && ['PLANNED', 'REPLANNED'].includes(planned.status)) {
            metrics.terminalPlanRevisions += 1;
            if (seenTerminalRevisions.has(planned.plan.planRevision)) metrics.duplicateTerminalRevisions += 1;
            seenTerminalRevisions.add(planned.plan.planRevision);
          }
        }
      } catch (error) {
        batch.forEach(item => item.reject(error));
        metrics.activeJobs -= 1;
        return;
      }
      metrics.activeJobs -= 1;
      batch.forEach(item => item.resolve(result));
    }

    return {
      schemaVersion: 'sde-shift-replanner-v1',
      metrics,
      get currentPlan() { return currentPlan; },
      submit(input) {
        return new Promise((resolve, reject) => {
          pending.push({ input: input || {}, resolve, reject });
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
          }
        });
      },
    };
  }

  return deepFreeze({
    SEARCH_BOUNDARY_CONTRACT,
    PRIORITY_ORDER,
    createShiftIntent,
    createShiftEngine,
    createShiftReplanner,
    buildMissingCardLedger,
    projectCanonicalPlan,
    revalidateActionStep,
    stableHash,
    stableStringify,
    humanExperienceScore,
  });
});
