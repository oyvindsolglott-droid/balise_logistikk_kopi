"use strict";

const ANALYTICS_SCHEMA_VERSION = "vehicle-status-analytics-v1";

const PROCESS_EVENT_TYPES = Object.freeze([
  "FAULT_REGISTERED",
  "NOT_OPERATIONAL_REPORTED",
  "REPAIR_REQUESTED",
  "WORKSHOP_NOTIFICATION_CREATED",
  "WORKSHOP_NOTIFICATION_PRESENTED",
  "WORKSHOP_SHEET_FIRST_OPENED",
  "WORKSHOP_AREA_ENTERED",
  "WORK_STARTED",
  "WAIT_REASON_SET",
  "OPERATIONAL_REPORTED",
  "WORKSHOP_AREA_EXITED",
  "RETURN_TO_SERVICE_DETECTED",
  "FAULT_RESOLVED",
  "REPAIR_REQUEST_COMPLETED"
]);

const MILESTONE_FIELDS = Object.freeze({
  FAULT_REGISTERED: "firstFaultRegisteredAt",
  NOT_OPERATIONAL_REPORTED: "firstNotOperationalAt",
  REPAIR_REQUESTED: "firstRepairRequestedAt",
  WORKSHOP_NOTIFICATION_CREATED: "workshopNotificationCreatedAt",
  WORKSHOP_NOTIFICATION_PRESENTED: "workshopNotificationPresentedAt",
  WORKSHOP_SHEET_FIRST_OPENED: "workshopSheetFirstOpenedAt",
  WORKSHOP_AREA_ENTERED: "firstWorkshopAreaEnteredAt",
  WORK_STARTED: "workStartedAt",
  OPERATIONAL_REPORTED: "operationalAt",
  RETURN_TO_SERVICE_DETECTED: "returnToServiceDetectedAt",
  FAULT_RESOLVED: "faultResolvedAt",
  REPAIR_REQUEST_COMPLETED: "repairRequestCompletedAt"
});

const METRIC_DEFINITIONS = Object.freeze({
  totalTreatmentTimeMs: "FAULT_REGISTERED → OPERATIONAL_REPORTED",
  timeBeforeRepairRequestedMs: "FAULT_REGISTERED → REPAIR_REQUESTED",
  notificationPresentationDelayMs:
    "WORKSHOP_NOTIFICATION_CREATED → WORKSHOP_NOTIFICATION_PRESENTED",
  timeToFirstWorkshopSheetOpenMs:
    "REPAIR_REQUESTED → WORKSHOP_SHEET_FIRST_OPENED",
  waitForWorkshopEntryMs: "REPAIR_REQUESTED → WORKSHOP_AREA_ENTERED",
  workshopStayMs: "Sum av komplette WORKSHOP_AREA_ENTERED → WORKSHOP_AREA_EXITED",
  workshopQueueTimeMs: "WORKSHOP_AREA_ENTERED → WORK_STARTED",
  activeRepairTimeMs: "WORK_STARTED → OPERATIONAL_REPORTED",
  completedToReleasedMs:
    "OPERATIONAL_REPORTED → første senere WORKSHOP_AREA_EXITED",
  returnToServiceTimeMs:
    "OPERATIONAL_REPORTED → RETURN_TO_SERVICE_DETECTED",
  downtimeMs: "NOT_OPERATIONAL_REPORTED → OPERATIONAL_REPORTED"
});

function buildProcessCases(input = {}){
  const caseRows = Array.isArray(input.caseRows) ? input.caseRows : [];
  const events = Array.isArray(input.events) ? input.events : [];
  return caseRows.map((row) => {
    const caseEvents = events
      .filter((event) => event.caseId === row.caseId)
      .sort(compareEvent);
    const milestones = Object.fromEntries(
      Object.values(MILESTONE_FIELDS).map((field) => [field, null])
    );
    let currentWaitReason = row.currentWaitReason || "NONE";
    for(const event of caseEvents){
      const field = MILESTONE_FIELDS[event.eventType];
      const milestoneTimestamp = event.eventType === "RETURN_TO_SERVICE_DETECTED"
        ? (validIso(event.payload?.departureAt) || event.timestamp)
        : event.timestamp;
      if(field && !milestones[field]) milestones[field] = milestoneTimestamp;
      if(event.eventType === "WAIT_REASON_SET"){
        currentWaitReason = event.payload?.reason || "NONE";
      }
    }
    const exits = caseEvents.filter((event) => event.eventType === "WORKSHOP_AREA_EXITED");
    milestones.finalWorkshopAreaExitedAt =
      [...exits].reverse()[0]?.timestamp || null;
    const firstExitAfterOperational = milestones.operationalAt
      ? exits.find((event) => toMillis(event.timestamp) >= toMillis(milestones.operationalAt))
      : null;
    const workshopSegments = buildWorkshopSegments(caseEvents);
    const completeWorkshopStayValues = workshopSegments
      .filter((segment) => segment.exitedAt)
      .map((segment) => durationMs(segment.enteredAt, segment.exitedAt))
      .filter(Number.isFinite);
    const openWorkshopSegment = [...workshopSegments]
      .reverse()
      .find((segment) => !segment.exitedAt) || null;
    const metrics = {
      totalTreatmentTimeMs: durationMs(
        milestones.firstFaultRegisteredAt,
        milestones.operationalAt
      ),
      timeBeforeRepairRequestedMs: durationMs(
        milestones.firstFaultRegisteredAt,
        milestones.firstRepairRequestedAt
      ),
      notificationPresentationDelayMs: durationMs(
        milestones.workshopNotificationCreatedAt,
        milestones.workshopNotificationPresentedAt
      ),
      timeToFirstWorkshopSheetOpenMs: durationMs(
        milestones.firstRepairRequestedAt,
        milestones.workshopSheetFirstOpenedAt
      ),
      waitForWorkshopEntryMs: durationMs(
        milestones.firstRepairRequestedAt,
        milestones.firstWorkshopAreaEnteredAt
      ),
      workshopStayMs: completeWorkshopStayValues.length
        ? completeWorkshopStayValues.reduce((sum, value) => sum + value, 0)
        : null,
      ongoingWorkshopStaySince: openWorkshopSegment?.enteredAt || null,
      workshopQueueTimeMs: durationMs(
        milestones.firstWorkshopAreaEnteredAt,
        milestones.workStartedAt
      ),
      activeRepairTimeMs: durationMs(
        milestones.workStartedAt,
        milestones.operationalAt
      ),
      completedToReleasedMs: durationMs(
        milestones.operationalAt,
        firstExitAfterOperational?.timestamp
      ),
      returnToServiceTimeMs: durationMs(
        milestones.operationalAt,
        milestones.returnToServiceDetectedAt
      ),
      downtimeMs: durationMs(
        milestones.firstNotOperationalAt,
        milestones.operationalAt
      )
    };
    return {
      caseId: row.caseId,
      vehicleId: row.vehicleId,
      sequence: row.sequence,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      currentWaitReason,
      active: !row.closedAt,
      milestones,
      metrics,
      workshopSegments,
      events: caseEvents
    };
  });
}

function buildAnalytics(input = {}){
  const now = typeof input.now === "function" ? input.now() : new Date().toISOString();
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const faults = Array.isArray(input.faults) ? input.faults : [];
  const repairs = Array.isArray(input.repairs) ? input.repairs : [];
  const records = Array.isArray(input.records) ? input.records : [];
  const placements = Array.isArray(input.placements) ? input.placements : [];
  const filter = normalizeFilter(input.filter, now);
  const scopedCases = cases.filter((processCase) =>
    matchesVehicleFilter(processCase.vehicleId, filter)
  );
  const selectedCases = cases.filter((processCase) =>
    insideRange(processCase.openedAt, filter.from, filter.to) &&
    matchesVehicleFilter(processCase.vehicleId, filter)
  );
  const selectedFaults = faults.filter((fault) =>
    insideRange(fault.registeredAt, filter.from, filter.to) &&
    matchesVehicleFilter(fault.vehicleId, filter) &&
    (!filter.category || fault.category === filter.category)
  );
  const selectedVehicleIds = new Set([
    ...selectedCases.map((processCase) => processCase.vehicleId),
    ...selectedFaults.map((fault) => fault.vehicleId)
  ]);
  const openCases = scopedCases.filter((processCase) => processCase.active);
  const scopedPlacements = placements.filter((placement) =>
    matchesVehicleFilter(placement.vehicleId, filter)
  );
  const workshopVehicles = new Set(
    scopedPlacements.filter((placement) => placement.inWorkshop === true)
      .map((placement) => placement.vehicleId)
  );
  const scopedRepairs = repairs.filter((repair) =>
    matchesVehicleFilter(repair.vehicleId, filter)
  );
  const pendingRepairs = scopedRepairs.filter((repair) => repair.status === "REQUESTED");
  const waitingForWorkshop = openCases.filter((processCase) =>
    pendingRepairs.some((repair) => repair.vehicleId === processCase.vehicleId) &&
    !workshopVehicles.has(processCase.vehicleId)
  );
  const scopedRecords = records.filter((record) =>
    matchesVehicleFilter(record.vehicleId, filter)
  );
  const completedOnWorkshop = scopedRecords.filter((record) =>
    record.currentStatus === "DRIFTSKLAR" &&
    workshopVehicles.has(record.vehicleId)
  );

  const performance = {};
  for(const metricName of Object.keys(METRIC_DEFINITIONS)){
    performance[metricName.replace(/Ms$/, "")] = summarize(
      selectedCases.map((processCase) => processCase.metrics[metricName])
    );
  }

  const recurrenceWindows = [7, 30, 90];
  const recurrence = Object.fromEntries(recurrenceWindows.map((days) => [
    `${days}Days`,
    buildRecurrence(selectedFaults, days)
  ]));
  const descriptionRecurrence = Object.fromEntries(recurrenceWindows.map((days) => [
    `${days}Days`,
    buildDescriptionRecurrence(selectedFaults, days)
  ]));
  const firstTimeFix = Object.fromEntries(recurrenceWindows.map((days) => [
    `${days}Days`,
    buildFirstTimeFix(selectedFaults, days, now)
  ]));
  const byVehicle = countBy(selectedFaults, (fault) => fault.vehicleId);
  const bySeries = countBy(selectedFaults, (fault) => String(fault.vehicleId || "").split("-")[0]);
  const byCategory = countBy(selectedFaults, (fault) => fault.category);
  const byMonth = countBy(selectedFaults, (fault) =>
    validIso(fault.registeredAt)?.slice(0, 7) || "UNKNOWN"
  );
  const workshopVisitsByVehicle = {};
  for(const processCase of selectedCases){
    workshopVisitsByVehicle[processCase.vehicleId] =
      (workshopVisitsByVehicle[processCase.vehicleId] || 0) +
      processCase.workshopSegments.length;
  }
  const timeFromRepairToNextFault = summarize(
    buildRepairToNextFaultDurations(selectedCases, scopedCases)
  );
  const downtimeByVehicle = {};
  const downtimeBySeries = {};
  const downtimeByCategory = {};
  for(const processCase of selectedCases){
    const downtime = processCase.metrics?.downtimeMs;
    if(!Number.isFinite(downtime)) continue;
    addDuration(downtimeByVehicle, processCase.vehicleId, downtime);
    addDuration(
      downtimeBySeries,
      String(processCase.vehicleId || "").split("-")[0],
      downtime
    );
    const categories = new Set(
      processCase.events
        .filter((event) => event.eventType === "FAULT_REGISTERED")
        .map((event) => clean(event.payload?.category))
        .filter(Boolean)
    );
    for(const category of categories) addDuration(downtimeByCategory, category, downtime);
  }
  const activeFaults = faults.filter((fault) =>
    fault.status === "ACTIVE" &&
    matchesVehicleFilter(fault.vehicleId, filter) &&
    (!filter.category || fault.category === filter.category)
  );
  const currentLoadVehicles = new Set([
    ...pendingRepairs.map((repair) => repair.vehicleId),
    ...workshopVehicles
  ]);
  const missingDataDiagnostics = [];
  for(const metricName of Object.keys(METRIC_DEFINITIONS)){
    const missing = selectedCases.filter((processCase) =>
      !Number.isFinite(processCase.metrics[metricName])).length;
    if(missing){
      missingDataDiagnostics.push({
        metric: metricName,
        missing,
        meaning: "Ikke målbart fra tilgjengelige immutable milepæler."
      });
    }
  }

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generatedAt: now,
    filter,
    sampleCounts: {
      cases: selectedCases.length,
      faults: selectedFaults.length,
      repairRequests: scopedRepairs.filter((repair) =>
        selectedVehicleIds.has(repair.vehicleId)).length,
      vehicles: selectedVehicleIds.size
    },
    operationalSnapshot: {
      openCases: openCases.length,
      pendingRepairRequests: pendingRepairs.length,
      oldestOpenCaseAgeMs: oldestAge(openCases, now),
      waitingForWorkshopTrack: waitingForWorkshop.length,
      vehiclesInWorkshop: workshopVehicles.size,
      operationalButStillInWorkshop: completedOnWorkshop.length
    },
    processPerformance: performance,
    reliability: {
      recurrence,
      descriptionRecurrence,
      firstTimeFix,
      faultsPerVehicle: byVehicle,
      faultsPerSeries: bySeries,
      faultsPerCategory: byCategory,
      faultsPerMonth: byMonth,
      faultFrequencySummaries: {
        vehicle: summarize(Object.values(byVehicle)),
        series: summarize(Object.values(bySeries)),
        category: summarize(Object.values(byCategory)),
        month: summarize(Object.values(byMonth))
      },
      workshopVisitsPerVehicle: workshopVisitsByVehicle,
      workshopVisitSummary: summarize(Object.values(workshopVisitsByVehicle)),
      timeFromRepairToNextFault,
      downtime: {
        perVehicle: downtimeByVehicle,
        perSeries: downtimeBySeries,
        perCategory: downtimeByCategory,
        summaries: {
          vehicle: summarize(Object.values(downtimeByVehicle)),
          series: summarize(Object.values(downtimeBySeries)),
          category: summarize(Object.values(downtimeByCategory))
        }
      }
    },
    capacity: {
      knownCurrentLoad: currentLoadVehicles.size,
      knownUpcomingLoad: null,
      knownUpcomingLoadMessage: "Ikke beregnbar fra tilgjengelige data",
      distributions: {
        category: countBy(activeFaults, (fault) => fault.category),
        series: countBy(openCases, (processCase) =>
          String(processCase.vehicleId || "").split("-")[0]
        ),
        status: countBy(scopedRecords, (record) => record.currentStatus || "NO_STATUS"),
        waitReason: countBy(
          openCases,
          (processCase) => processCase.currentWaitReason || "NONE"
        ),
        hourOfDay: countBy(selectedFaults, (fault) => osloTimePart(fault.registeredAt, "hour")),
        weekday: countBy(selectedFaults, (fault) => osloTimePart(fault.registeredAt, "weekday"))
      }
    },
    missingDataDiagnostics,
    metricDefinitions: METRIC_DEFINITIONS,
    privacy: {
      aggregationKeys: ["vehicleId", "series", "category", "case", "processPhase"],
      personalPerformanceAnalysis: false,
      interactionTelemetry: false
    }
  };
}

function buildWorkshopSegments(events){
  const segments = [];
  let active = null;
  for(const event of events){
    if(event.eventType === "WORKSHOP_AREA_ENTERED" && !active){
      active = {
        enteredAt: event.timestamp,
        exitedAt: null,
        fromSlot: event.payload?.fromSlot || null,
        toSlot: event.payload?.toSlot || null
      };
    }else if(event.eventType === "WORKSHOP_AREA_EXITED" && active){
      active.exitedAt = event.timestamp;
      active.exitFromSlot = event.payload?.fromSlot || null;
      active.exitToSlot = event.payload?.toSlot || null;
      segments.push(active);
      active = null;
    }
  }
  if(active) segments.push(active);
  return segments;
}

function normalizeFilter(input = {}, now){
  const to = validIso(input.to) || now;
  const defaultFrom = new Date(toMillis(to) - 30 * 86_400_000).toISOString();
  return {
    from: validIso(input.from) || defaultFrom,
    to,
    series: clean(input.series),
    category: clean(input.category),
    vehicleId: clean(input.vehicleId),
    recurrenceWindowDays: allowedNumber(input.recurrenceWindowDays, [7, 30, 90], 30),
    knownLoadHorizonHours: allowedNumber(input.knownLoadHorizonHours, [6, 12], 6)
  };
}

function buildRecurrence(faults, days){
  return buildRecurrenceBy(
    faults,
    days,
    (fault) => `${fault.vehicleId}|${fault.category}`
  );
}

function buildDescriptionRecurrence(faults, days){
  return buildRecurrenceBy(
    faults.filter((fault) => normalizeDescription(fault.description)),
    days,
    (fault) => `${fault.vehicleId}|${normalizeDescription(fault.description)}`
  );
}

function buildRecurrenceBy(faults, days, identityFor){
  const windowMs = days * 86_400_000;
  let repeated = 0;
  const ordered = [...faults].sort((left, right) =>
    toMillis(left.registeredAt) - toMillis(right.registeredAt));
  for(let index = 0; index < ordered.length; index += 1){
    const fault = ordered[index];
    const prior = ordered.slice(0, index).some((candidate) =>
      identityFor(candidate) === identityFor(fault) &&
      toMillis(fault.registeredAt) - toMillis(candidate.registeredAt) <= windowMs
    );
    if(prior) repeated += 1;
  }
  return { repeated, sampleCount: ordered.length };
}

function normalizeDescription(value){
  return String(value || "")
    .toLocaleLowerCase("nb-NO")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRepairToNextFaultDurations(selectedCases, allCases){
  const allFaultEvents = allCases.flatMap((processCase) =>
    processCase.events
      .filter((event) => event.eventType === "FAULT_REGISTERED")
      .map((event) => ({ vehicleId: processCase.vehicleId, timestamp: event.timestamp }))
  );
  return selectedCases.map((processCase) => {
    const operationalAt = processCase.milestones?.operationalAt;
    const nextFault = allFaultEvents
      .filter((event) =>
        event.vehicleId === processCase.vehicleId &&
        toMillis(event.timestamp) > toMillis(operationalAt)
      )
      .sort(compareEvent)[0];
    return durationMs(operationalAt, nextFault?.timestamp);
  }).filter(Number.isFinite);
}

function buildFirstTimeFix(faults, days, now){
  const windowMs = days * 86_400_000;
  const resolved = faults.filter((fault) =>
    fault.status === "RESOLVED" && validIso(fault.resolvedAt));
  const eligible = resolved.filter((fault) =>
    toMillis(now) - toMillis(fault.resolvedAt) >= windowMs);
  const successful = eligible.filter((fault) =>
    !faults.some((candidate) =>
      candidate.vehicleId === fault.vehicleId &&
      candidate.category === fault.category &&
      toMillis(candidate.registeredAt) > toMillis(fault.resolvedAt) &&
      toMillis(candidate.registeredAt) - toMillis(fault.resolvedAt) <= windowMs
    )).length;
  return {
    successful,
    sampleCount: eligible.length,
    rate: eligible.length ? successful / eligible.length : null
  };
}

function summarize(values){
  const available = values.filter(Number.isFinite).sort((left, right) => left - right);
  if(!available.length){
    return { averageMs: null, medianMs: null, sampleCount: 0 };
  }
  const midpoint = Math.floor(available.length / 2);
  const medianMs = available.length % 2
    ? available[midpoint]
    : (available[midpoint - 1] + available[midpoint]) / 2;
  return {
    averageMs: available.reduce((sum, value) => sum + value, 0) / available.length,
    medianMs,
    sampleCount: available.length
  };
}

function durationMs(start, end){
  const startMs = toMillis(start);
  const endMs = toMillis(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : null;
}

function oldestAge(cases, now){
  const ages = cases.map((processCase) => durationMs(processCase.openedAt, now))
    .filter(Number.isFinite);
  return ages.length ? Math.max(...ages) : null;
}

function countBy(items, keyFor){
  const counts = {};
  for(const item of items){
    const key = String(keyFor(item) || "UNKNOWN");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function addDuration(target, key, duration){
  const normalizedKey = String(key || "UNKNOWN");
  target[normalizedKey] = (target[normalizedKey] || 0) + duration;
}

function osloTimePart(timestamp, kind){
  if(!validIso(timestamp)) return "UNKNOWN";
  const options = kind === "hour"
    ? { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }
    : { timeZone: "Europe/Oslo", weekday: "long" };
  return new Intl.DateTimeFormat("nb-NO", options).format(new Date(timestamp));
}

function matchesVehicleFilter(vehicleId, filter){
  if(filter.vehicleId && vehicleId !== filter.vehicleId) return false;
  if(filter.series && !String(vehicleId).startsWith(`${filter.series}-`)) return false;
  return true;
}

function insideRange(timestamp, from, to){
  const value = toMillis(timestamp);
  return Number.isFinite(value) && value >= toMillis(from) && value <= toMillis(to);
}

function compareEvent(left, right){
  return String(left.timestamp).localeCompare(String(right.timestamp)) ||
    String(left.processEventId).localeCompare(String(right.processEventId));
}

function validIso(value){
  return Number.isFinite(toMillis(value)) ? new Date(toMillis(value)).toISOString() : null;
}

function toMillis(value){
  return Date.parse(String(value || ""));
}

function clean(value){
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function allowedNumber(value, allowed, fallback){
  const numeric = Number(value);
  return allowed.includes(numeric) ? numeric : fallback;
}

module.exports = {
  ANALYTICS_SCHEMA_VERSION,
  METRIC_DEFINITIONS,
  PROCESS_EVENT_TYPES,
  buildAnalytics,
  buildProcessCases,
  durationMs,
  summarize
};
