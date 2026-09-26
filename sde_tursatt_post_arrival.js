(function initSdeTursattPostArrival(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SdeTursattPostArrival = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSdeTursattPostArrivalApi() {
  "use strict";

  const TURSATT_FORCE_POST_ARRIVAL_SHUNT_TRAINS = Object.freeze([
    "835", "837", "839", "851", "853", "855", "861", "863",
  ]);
  const FORCE_TRAIN_SET = new Set(TURSATT_FORCE_POST_ARRIVAL_SHUNT_TRAINS);
  const TURSATT_SHIFT_WINDOW_CONTRACT = Object.freeze({
    readinessMinutes: 2,
    mainDurationMinutes: 12,
    interCardGapMinutes: 1,
    nextUsePreparationMinutes: 10,
    immediateContinuationMaxMinutes: 90,
    analysisHorizonMinutes: 16 * 60,
    resourceId: "SDE-SHUNT-RESOURCE",
  });
  const ROLE_ORDER = Object.freeze({RELEASE: 0, MAIN: 1, RECOVERY: 2});

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeTrain(value) {
    return clean(value).replace(/\s+/g, "");
  }

  function normalizeVehicle(value) {
    return clean(value).toUpperCase().replace(/\s+/g, "");
  }

  function normalizePart(value, fallbackIndex) {
    const part = clean(value).replace(/^\//, "");
    return part || String(fallbackIndex + 1);
  }

  function parseClockMinutes(value) {
    const text = clean(value);
    const match = text.match(/^(\d{1,2}):(\d{2})(?:\s*\+(\d+))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const dayOffset = Number(match[3] || 0);
    if (hours > 23 || minutes > 59) return null;
    return dayOffset * 1440 + hours * 60 + minutes;
  }

  function formatClockMinutes(value) {
    if (!Number.isFinite(value)) return "";
    const rounded = Math.max(0, Math.round(value));
    const dayOffset = Math.floor(rounded / 1440);
    const clock = rounded % 1440;
    const hours = String(Math.floor(clock / 60)).padStart(2, "0");
    const minutes = String(clock % 60).padStart(2, "0");
    return `${hours}:${minutes}${dayOffset ? ` +${dayOffset}` : ""}`;
  }

  function dateOrdinal(value) {
    const text = clean(value);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return 0;
    return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
  }

  function eventSequenceMinutes(event, actual) {
    const planned = Number.isFinite(Number(event && event.sortMinutes))
      ? Number(event.sortMinutes)
      : parseClockMinutes(event && (event.displayTime || event.time));
    if (!actual) return planned;
    const actualMinutes = parseClockMinutes(event && event.actualArrival);
    if (actualMinutes === null) return planned;
    if (actualMinutes < 720 && planned >= 1440 && actualMinutes < 1440) return actualMinutes + 1440;
    return actualMinutes;
  }

  function stableKey(prefix, values) {
    return `${prefix}|${values.map(value => encodeURIComponent(clean(value))).join("|")}`;
  }

  function eventVehicleRows(event) {
    const source = Array.isArray(event && event.vehicles)
      ? event.vehicles
      : event && event.vehicle
        ? [{vehicle: event.vehicle, part: event.part}]
        : [];
    return source.map((item, index) => ({
      vehicle: normalizeVehicle(typeof item === "string" ? item : item && (item.vehicle || item.vehicleId)),
      part: normalizePart(typeof item === "string" ? "" : item && (item.part || item.position), index),
      slot: clean(typeof item === "string" ? event && (event.slot || event.arrivalSlot) : item && (item.slot || item.arrivalSlot) || event && (event.slot || event.arrivalSlot)),
      raw: typeof item === "string" ? event : item,
    })).filter(item => item.vehicle);
  }

  function normalizeEvent(event, role) {
    const plannedTime = clean(event && (event.displayTime || event.time));
    const train = normalizeTrain(event && (event.train || event.trainNumber || event.displayTrain));
    const station = clean(event && (event.stationRef || event.station)) || "SKN";
    const occurrenceId = clean(event && (event.occurrenceId || event.sourceOccurrenceId))
      || stableKey("tursatt-occurrence", [event && event.operationalDate, station, role, train, plannedTime]);
    return {
      role,
      operationalDate: clean(event && event.operationalDate),
      station,
      stationRef: clean(event && event.stationRef) || station,
      train,
      displayTrain: normalizeTrain(event && (event.displayTrain || event.train || event.trainNumber)),
      plannedTime,
      actualArrival: role === "arrival" ? clean(event && event.actualArrival) : "",
      sequenceMinutes: eventSequenceMinutes(event, role === "arrival"),
      plannedSequenceMinutes: eventSequenceMinutes(event, false),
      occurrenceId,
      sourceRevision: clean(event && event.sourceRevision),
      movement: clean(event && event.movement) || role,
      direction: clean(event && event.direction) || role,
      slot: clean(event && (event.slot || event.arrivalSlot)),
      explicitPostArrivalShunt: Boolean(event && (event.requiresPostArrivalShunt || event.removed || event.parked || event.leftBehind)),
      vehicles: eventVehicleRows(event),
      raw: event,
    };
  }

  function groupFlatEvents(events, role) {
    const groups = new Map();
    for (const raw of Array.isArray(events) ? events : []) {
      const event = normalizeEvent(raw, role);
      const groupKey = stableKey("tursatt-event-group", [
        event.operationalDate, event.station, event.train, event.plannedTime,
        event.actualArrival, event.occurrenceId, event.sourceRevision,
      ]);
      const existing = groups.get(groupKey);
      if (!existing) {
        groups.set(groupKey, event);
        continue;
      }
      const known = new Set(existing.vehicles.map(item => `${item.part}|${item.vehicle}`));
      for (const vehicle of event.vehicles) {
        const key = `${vehicle.part}|${vehicle.vehicle}`;
        if (!known.has(key)) existing.vehicles.push(vehicle);
      }
      existing.explicitPostArrivalShunt = existing.explicitPostArrivalShunt || event.explicitPostArrivalShunt;
    }
    return [...groups.values()];
  }

  function compareEvents(left, right) {
    const dateDiff = dateOrdinal(left.operationalDate) - dateOrdinal(right.operationalDate);
    if (dateDiff) return dateDiff;
    const timeDiff = (left.sequenceMinutes == null ? Number.MAX_SAFE_INTEGER : left.sequenceMinutes)
      - (right.sequenceMinutes == null ? Number.MAX_SAFE_INTEGER : right.sequenceMinutes);
    if (timeDiff) return timeDiff;
    return left.occurrenceId.localeCompare(right.occurrenceId, "nb");
  }

  function vehiclesIn(event) {
    return new Set((event && event.vehicles || []).map(item => item.vehicle));
  }

  function departuresAfter(arrival, departures, vehicle, config) {
    const start = arrival.sequenceMinutes;
    if (!Number.isFinite(start)) return [];
    return departures.filter(departure => {
      if (!vehiclesIn(departure).has(vehicle) || !Number.isFinite(departure.sequenceMinutes)) return false;
      const gap = departure.sequenceMinutes - start;
      return gap > 0 && gap <= config.analysisHorizonMinutes;
    }).sort(compareEvents);
  }

  function immediateContinuationFor(arrival, departures, config) {
    if (!Number.isFinite(arrival.sequenceMinutes)) return null;
    const arrivalVehicles = vehiclesIn(arrival);
    return departures.filter(departure => {
      if (!Number.isFinite(departure.sequenceMinutes)) return false;
      const gap = departure.sequenceMinutes - arrival.sequenceMinutes;
      if (gap <= 0 || gap > config.immediateContinuationMaxMinutes) return false;
      return [...vehiclesIn(departure)].some(vehicle => arrivalVehicles.has(vehicle));
    }).sort(compareEvents)[0] || null;
  }

  function occurrenceIdentity(arrival, vehicleRow) {
    return {
      operationalDate: arrival.operationalDate,
      station: arrival.station,
      arrivalTrainNumber: arrival.train,
      plannedArrival: arrival.plannedTime,
      actualArrival: arrival.actualArrival,
      movement: arrival.movement,
      part: vehicleRow.part,
      vehicleId: vehicleRow.vehicle,
      sourceOccurrenceId: arrival.occurrenceId,
      sourceRevision: arrival.sourceRevision,
    };
  }

  function obligationKeys(identity) {
    const lifecycleValues = [
      identity.operationalDate, identity.station, identity.arrivalTrainNumber,
      identity.plannedArrival, identity.movement, identity.part,
      identity.vehicleId, identity.sourceOccurrenceId,
    ];
    return {
      lifecycleKey: stableKey("tursatt-main-lifecycle", lifecycleValues),
      occurrenceVersionKey: stableKey("tursatt-occurrence-version", [
        ...lifecycleValues, identity.actualArrival, identity.sourceRevision,
      ]),
    };
  }

  function reasonForNeed({forced, immediate, immediateContainsVehicle, explicit, laterUse, train}) {
    if (forced) return `Fast post-arrival-shunt-regel for tog ${train}.`;
    if (explicit) return "Tursatt markerer at kjøretøyet tas ut, parkeres eller settes igjen etter ankomst.";
    if (immediate && !immediateContainsVehicle) return "Tursatt viser at kjøretøyet tas ut av ankomsttogets umiddelbare fortsettelse.";
    if (!immediate && laterUse) return "Kjøretøyet må skiftes bort etter ankomst før en senere dokumentert bruk.";
    return "Ingen umiddelbar fortsettelsesavgang finnes; kjøretøyet må få et synlig post-arrival shift need.";
  }

  function generatePostArrivalShiftNeeds(input = {}) {
    const config = {...TURSATT_SHIFT_WINDOW_CONTRACT, ...(input.config || {})};
    const arrivals = groupFlatEvents(input.arrivals, "arrival").sort(compareEvents);
    const departures = groupFlatEvents(input.departures, "departure").sort(compareEvents);
    const needs = [];
    const ambiguous = [];

    for (const arrival of arrivals) {
      const immediate = immediateContinuationFor(arrival, departures, config);
      const immediateVehicles = vehiclesIn(immediate);
      const forced = FORCE_TRAIN_SET.has(arrival.train);
      for (const vehicleRow of arrival.vehicles) {
        const laterUses = departuresAfter(arrival, departures, vehicleRow.vehicle, config);
        const laterUse = laterUses[0] || null;
        const immediateContainsVehicle = immediateVehicles.has(vehicleRow.vehicle);
        const explicit = arrival.explicitPostArrivalShunt || Boolean(vehicleRow.raw && vehicleRow.raw.requiresPostArrivalShunt);
        const requiresPostArrivalShunt = forced || explicit || !immediate || !immediateContainsVehicle;
        if (!requiresPostArrivalShunt) continue;

        const identity = occurrenceIdentity(arrival, vehicleRow);
        const missingIdentity = Object.entries(identity)
          .filter(([key, value]) => key !== "actualArrival" && key !== "sourceRevision" && !clean(value))
          .map(([key]) => key);
        const keys = obligationKeys(identity);
        const need = {
          ...keys,
          obligationId: stableKey("tursatt-main", [keys.occurrenceVersionKey]),
          occurrenceIdentity: identity,
          operationalDate: identity.operationalDate,
          station: identity.station,
          arrivalTrainNumber: identity.arrivalTrainNumber,
          arrivalTime: identity.plannedArrival,
          actualArrival: identity.actualArrival,
          arrivalSequenceMinutes: arrival.sequenceMinutes,
          plannedArrivalSequenceMinutes: arrival.plannedSequenceMinutes,
          movement: identity.movement,
          part: identity.part,
          vehicleId: identity.vehicleId,
          sourceOccurrenceId: identity.sourceOccurrenceId,
          sourceRevision: identity.sourceRevision,
          sourceSlot: vehicleRow.slot || arrival.slot,
          requiresPostArrivalShunt: true,
          forcedTrainRule: forced,
          immediateContinuation: immediate,
          nextUseOccurrence: laterUse,
          reason: reasonForNeed({forced, immediate, immediateContainsVehicle, explicit, laterUse, train: arrival.train}),
          status: missingIdentity.length ? "DATA_AMBIGUOUS" : "REQUIRED",
          missingIdentity,
        };
        needs.push(need);
        if (missingIdentity.length) ambiguous.push(need);
      }
    }

    const unique = new Map();
    for (const need of needs) unique.set(need.occurrenceVersionKey, need);
    return {
      arrivals,
      departures,
      needs: [...unique.values()].sort(compareNeeds),
      ambiguous,
    };
  }

  function compareNeeds(left, right) {
    const dateDiff = dateOrdinal(left.operationalDate) - dateOrdinal(right.operationalDate);
    if (dateDiff) return dateDiff;
    const timeDiff = (left.arrivalSequenceMinutes == null ? Number.MAX_SAFE_INTEGER : left.arrivalSequenceMinutes)
      - (right.arrivalSequenceMinutes == null ? Number.MAX_SAFE_INTEGER : right.arrivalSequenceMinutes);
    if (timeDiff) return timeDiff;
    const partDiff = Number(left.part || 0) - Number(right.part || 0);
    if (partDiff) return partDiff;
    return left.occurrenceVersionKey.localeCompare(right.occurrenceVersionKey, "nb");
  }

  function scheduleShiftWindows(needs, options = {}) {
    const config = {...TURSATT_SHIFT_WINDOW_CONTRACT, ...(options.config || {})};
    let resourceCursor = Number.isFinite(options.resourceAvailableAtMinutes)
      ? Number(options.resourceAvailableAtMinutes)
      : Number.NEGATIVE_INFINITY;
    return [...(Array.isArray(needs) ? needs : [])].sort(compareNeeds).map((need, index) => {
      const arrivalMinutes = Number.isFinite(need.arrivalSequenceMinutes)
        ? need.arrivalSequenceMinutes
        : parseClockMinutes(need.actualArrival || need.arrivalTime);
      const arrivalReadyMinutes = Number.isFinite(arrivalMinutes)
        ? arrivalMinutes + config.readinessMinutes
        : resourceCursor;
      const plannedWindowStartMinutes = Math.max(arrivalReadyMinutes, resourceCursor);
      const plannedWindowEndMinutes = plannedWindowStartMinutes + config.mainDurationMinutes;
      const nextUseMinutes = need.nextUseOccurrence && Number.isFinite(need.nextUseOccurrence.sequenceMinutes)
        ? need.nextUseOccurrence.sequenceMinutes
        : null;
      const nextUseReadyByMinutes = nextUseMinutes === null ? null : nextUseMinutes - config.nextUsePreparationMinutes;
      const windowStatus = nextUseReadyByMinutes !== null && plannedWindowEndMinutes > nextUseReadyByMinutes
        ? "CONFLICT_NEXT_USE"
        : "ASSIGNED";
      resourceCursor = plannedWindowEndMinutes + config.interCardGapMinutes;
      return {
        ...need,
        sequenceIndex: index + 1,
        constrainedResourceId: config.resourceId,
        arrivalReadyAtMinutes: arrivalReadyMinutes,
        arrivalReadyAt: formatClockMinutes(arrivalReadyMinutes),
        plannedWindowStartMinutes,
        plannedWindowEndMinutes,
        plannedWindowStart: formatClockMinutes(plannedWindowStartMinutes),
        plannedWindowEnd: formatClockMinutes(plannedWindowEndMinutes),
        nextUseReadyByMinutes,
        nextUseReadyBy: formatClockMinutes(nextUseReadyByMinutes),
        windowStatus,
        windowReason: windowStatus === "ASSIGNED"
          ? "Serialisert etter fersk ankomst/readiness og tidligere Tursatt-kort i samme skifteressurs."
          : "Tidsvinduet kolliderer med dokumentert neste bruk og må beholdes synlig for avklaring.",
      };
    });
  }

  function baseCard(need, role, values = {}) {
    const lifecycleKey = role === "MAIN" ? need.lifecycleKey : `${need.lifecycleKey}|${role.toLowerCase()}`;
    return {
      cardId: stableKey("tursatt-card", [lifecycleKey, role]),
      obligationId: need.obligationId,
      lifecycleKey,
      mainLifecycleKey: need.lifecycleKey,
      occurrenceVersionKey: need.occurrenceVersionKey,
      sourceRevision: need.sourceRevision,
      sourceOccurrenceId: need.sourceOccurrenceId,
      operationalDate: need.operationalDate,
      station: need.station,
      arrivalTrainNumber: need.arrivalTrainNumber,
      arrivalTime: need.arrivalTime,
      actualArrival: need.actualArrival,
      part: need.part,
      vehicleId: role === "MAIN" ? need.vehicleId : normalizeVehicle(values.vehicleId),
      cardRole: role,
      planKind: values.planKind || "DIRECT",
      sourceSlot: clean(values.sourceSlot == null ? need.sourceSlot : values.sourceSlot),
      targetSlot: clean(values.targetSlot),
      routeResources: Array.isArray(values.routeResources) ? [...values.routeResources] : [],
      dependencyIds: Array.isArray(values.dependencyIds) ? [...values.dependencyIds] : [],
      sequenceIndex: need.sequenceIndex,
      plannedWindowStart: need.plannedWindowStart,
      plannedWindowEnd: need.plannedWindowEnd,
      plannedWindowStartMinutes: need.plannedWindowStartMinutes,
      plannedWindowEndMinutes: need.plannedWindowEndMinutes,
      windowStatus: need.windowStatus,
      windowReason: need.windowReason,
      arrivalReadyAt: need.arrivalReadyAt,
      nextUseReadyBy: need.nextUseReadyBy,
      dependency: role === "MAIN" ? "ARRIVAL_CONFIRMED" : clean(values.dependency),
      status: "PLANNED_FUTURE",
      reason: need.reason,
    };
  }

  function compileShiftCards(needs, options = {}) {
    const selectTarget = typeof options.selectTarget === "function" ? options.selectTarget : () => ({safe: false, slot: ""});
    const resolveRoute = typeof options.resolveRoute === "function" ? options.resolveRoute : () => ({planKind: "DIRECT"});
    const completedLifecycleKeys = new Set((options.completedLifecycleKeys || []).map(clean));
    const cards = [];
    const diagnostics = [];
    let completedObligationCount = 0;

    for (const need of Array.isArray(needs) ? needs : []) {
      if (completedLifecycleKeys.has(need.lifecycleKey)) {
        completedObligationCount += 1;
        continue;
      }
      if (need.status === "DATA_AMBIGUOUS") {
        diagnostics.push({need, code: "DATA_AMBIGUOUS", missingPlanObjects: ["canonical-target", "MAIN-card"]});
        continue;
      }
      const target = selectTarget(need) || {};
      if (target.safe !== true || !clean(target.slot)) {
        diagnostics.push({need, code: "NO_SAFE_TARGET", searchedSlots: target.searchedSlots || [], missingPlanObjects: ["target", "MAIN-card"]});
        continue;
      }
      const route = resolveRoute(need, target) || {planKind: "DIRECT"};
      const planKind = route.planKind === "RELEASE_MAIN_RECOVERY" ? "RELEASE_MAIN_RECOVERY" : "DIRECT";
      if (planKind === "DIRECT") {
        cards.push(baseCard(need, "MAIN", {
          planKind,
          targetSlot: target.slot,
          routeResources: route.routeResources,
        }));
        continue;
      }
      const release = baseCard(need, "RELEASE", {
        planKind,
        vehicleId: route.release && route.release.vehicleId,
        sourceSlot: route.release && route.release.sourceSlot,
        targetSlot: route.release && route.release.targetSlot,
        routeResources: route.routeResources,
        dependency: "ARRIVAL_CONFIRMED",
      });
      const main = baseCard(need, "MAIN", {
        planKind,
        targetSlot: target.slot,
        routeResources: route.routeResources,
        dependencyIds: [release.cardId],
      });
      const recovery = baseCard(need, "RECOVERY", {
        planKind,
        vehicleId: route.recovery && route.recovery.vehicleId,
        sourceSlot: route.recovery && route.recovery.sourceSlot,
        targetSlot: route.recovery && route.recovery.targetSlot,
        routeResources: route.routeResources,
        dependencyIds: [main.cardId],
        dependency: "MAIN_COMPLETED",
      });
      cards.push(release, main, recovery);
    }
    cards.sort((left, right) => left.sequenceIndex - right.sequenceIndex || ROLE_ORDER[left.cardRole] - ROLE_ORDER[right.cardRole]);
    return {cards, diagnostics, completedObligationCount};
  }

  function reconcileShiftCards(generatedCards, existingCards, options = {}) {
    const completedCardIds = new Set((options.completedCardIds || []).map(clean));
    const byId = new Map();
    for (const card of Array.isArray(existingCards) ? existingCards : []) {
      if (!card || completedCardIds.has(clean(card.cardId))) continue;
      byId.set(clean(card.cardId), card);
    }
    for (const card of Array.isArray(generatedCards) ? generatedCards : []) {
      if (!card || completedCardIds.has(clean(card.cardId))) continue;
      byId.set(clean(card.cardId), card);
    }
    const cards = [...byId.values()].sort((left, right) =>
      Number(left.sequenceIndex || 0) - Number(right.sequenceIndex || 0)
      || ROLE_ORDER[left.cardRole] - ROLE_ORDER[right.cardRole]
      || clean(left.cardId).localeCompare(clean(right.cardId), "nb")
    );
    return {cards, duplicateCount: cards.length - new Set(cards.map(card => card.cardId)).size};
  }

  function createTursattPostArrivalPlan(input = {}) {
    const generated = generatePostArrivalShiftNeeds(input);
    const scheduled = scheduleShiftWindows(generated.needs, input);
    const compiled = compileShiftCards(scheduled, input);
    const reconciled = reconcileShiftCards(compiled.cards, input.existingCards || [], input);
    const generatedMainObligationCount = reconciled.cards.filter(card => card.cardRole === "MAIN").length;
    return {
      schemaVersion: "sde-tursatt-post-arrival-plan-v1",
      sideEffectPolicy: "READ_ONLY_UNTIL_AUTHORIZED_COMPLETION",
      arrivals: generated.arrivals,
      departures: generated.departures,
      needs: scheduled,
      cards: reconciled.cards,
      diagnostics: [...generated.ambiguous.map(need => ({need, code: "DATA_AMBIGUOUS"})), ...compiled.diagnostics],
      requiredMainObligationCount: scheduled.length,
      generatedMainObligationCount,
      completedObligationCount: compiled.completedObligationCount,
      duplicateCount: reconciled.duplicateCount,
    };
  }

  function planStructureSignature(plan) {
    return JSON.stringify((plan && plan.cards || []).map(card => ({
      cardRole: card.cardRole,
      planKind: card.planKind,
      sourceSlot: card.sourceSlot,
      targetSlot: card.targetSlot,
      dependencyCount: card.dependencyIds.length,
      sequenceIndex: card.sequenceIndex,
      plannedWindowStart: card.plannedWindowStart,
      plannedWindowEnd: card.plannedWindowEnd,
      windowStatus: card.windowStatus,
      arrivalTrainNumber: card.arrivalTrainNumber,
      part: card.part,
    })));
  }

  return Object.freeze({
    TURSATT_FORCE_POST_ARRIVAL_SHUNT_TRAINS,
    TURSATT_SHIFT_WINDOW_CONTRACT,
    generatePostArrivalShiftNeeds,
    scheduleShiftWindows,
    compileShiftCards,
    reconcileShiftCards,
    createTursattPostArrivalPlan,
    planStructureSignature,
    parseClockMinutes,
    formatClockMinutes,
  });
});
