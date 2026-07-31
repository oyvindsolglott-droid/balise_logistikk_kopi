"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { readJson, repoRoot } = require("./core.cjs");

const FINDING_TYPES = Object.freeze([
  "CONFIRMED_DEFECT",
  "PROBABLE_DEFECT",
  "POSSIBLE_FALSE_POSITIVE",
  "EXPECTED_DIFFERENCE",
  "AUTHORIZED_OVERRIDE",
  "CONTRACT_AMBIGUITY",
  "TEST_ORACLE_DEFECT",
  "BLOCKED",
  "UNKNOWN"
]);

const THREE_WAY_CATEGORIES = Object.freeze([
  "balise_only_candidate",
  "candidate_only",
  "balise_only_published",
  "published_only",
  "vehicle_mismatch_candidate",
  "vehicle_mismatch_published",
  "consist_mismatch_candidate",
  "consist_mismatch_published",
  "track_mismatch_candidate",
  "track_mismatch_published",
  "date_mismatch_candidate",
  "date_mismatch_published",
  "authorized_override",
  "expected_difference",
  "unauthorized_difference",
  "possible_false_positive",
  "contract_ambiguity"
]);

const PARITY_CATEGORIES = Object.freeze([
  "balise_only",
  "sde_only",
  "identity_mismatch",
  "vehicle_mismatch",
  "consist_mismatch",
  "track_mismatch",
  "date_mismatch",
  "occurrence_mismatch",
  "stale_source",
  "stale_sde_dataset",
  "provenance_missing",
  "authorized_override",
  "unauthorized_difference"
]);

const COMPARABLE_FIELDS = Object.freeze([
  "operationalDate", "trainNumber", "direction", "time", "track", "vehicleIds", "consist"
]);

function parseUpdatedAt(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})[ ,T]+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match;
  const desiredLocal = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  let candidate = desiredLocal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const observedLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    candidate += desiredLocal - observedLocal;
  }
  return Number.isFinite(candidate) ? candidate : null;
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean).map(String))].sort();
}

function timeFromTimestamp(value) {
  return String(value || "").match(/\s(\d{2}:\d{2})(?::\d{2})?$/)?.[1] || null;
}

function eventTimestamp(record) {
  return record.stop_planned_arrival || record.stop_planned_departure || null;
}

function directionForStationRow(row) {
  return row.stop_planned_arrival ? "arrival" : "departure";
}

function occurrenceIdFor(row) {
  const direction = directionForStationRow(row);
  const timestamp = direction === "arrival" ? row.stop_planned_arrival : row.stop_planned_departure;
  return `${row.route_date}|${direction}|${row.route_number}|${timeFromTimestamp(timestamp)}`;
}

function normalizeBaliseRows(rows, vehiclesByRoute = {}) {
  return (rows || []).map((row) => {
    const vehicleIds = uniqueSorted(vehiclesByRoute[row.stop_route]);
    return {
      routeId: String(row.stop_route || ""),
      occurrenceId: occurrenceIdFor(row),
      operationalDate: String(row.route_date || ""),
      direction: directionForStationRow(row),
      trainNumber: String(row.route_number || ""),
      time: timeFromTimestamp(eventTimestamp(row)),
      stopId: String(row.stop_id || ""),
      track: String(row.stop_track || "").trim() || null,
      vehicleIds,
      consist: vehicleIds.length > 1 ? "double_set" : vehicleIds.length === 1 ? "single_set" : "unknown",
      sourceTimestamp: row.stop_actual_arrival || row.stop_actual_departure || row.stop_estimated_arrival || row.stop_estimated_departure || eventTimestamp(row),
      provenance: row.stop_route && row.stop_id
        ? "balise.no/api/station/SKN + balise.no/api/train/vehicles"
        : null
    };
  });
}

function normalizeSdePayloads(payloads) {
  const byRoute = new Map();
  for (const payload of payloads || []) {
    for (const entry of Object.values(payload.arrivals || {})) {
      const context = entry?.movementContext;
      if (!context?.routeId || byRoute.has(String(context.routeId))) continue;
      byRoute.set(String(context.routeId), {
        routeId: String(context.routeId),
        occurrenceId: String(context.occurrenceId || ""),
        operationalDate: String(context.operationalDate || payload.date || ""),
        direction: "arrival",
        trainNumber: String(context.trainNumber || ""),
        time: timeFromTimestamp(context.plannedArrival) || String(entry.time || ""),
        stopId: String(context.stopId || ""),
        track: String(context.platformTrack || "").trim() || null,
        vehicleIds: uniqueSorted(context.vehicleIds),
        consist: String(context.consistContext || "unknown"),
        sourceTimestamp: context.sourceUpdatedAt || context.sourceObservedAt || payload.updatedAt || null,
        provenance: context.trackProvenance || null,
        datasetUpdatedAt: payload.updatedAt || null,
        datasetMode: payload.mode || null
      });
    }
    for (const occurrence of Object.values(payload.departureOccurrences || {})) {
      const routeId = String(occurrence?.routeId || "");
      if (!routeId || byRoute.has(routeId)) continue;
      const vehicleIds = uniqueSorted(occurrence.vehicleIds || occurrence.departureVehicles);
      const trainNumber = String(occurrence.displayTrainNumber || "");
      const time = String(occurrence.departureTime || "");
      byRoute.set(routeId, {
        routeId,
        occurrenceId: `${occurrence.operationalDate}|departure|${trainNumber}|${time}`,
        operationalDate: String(occurrence.operationalDate || payload.date || ""),
        direction: "departure",
        trainNumber,
        time,
        stopId: null,
        track: null,
        vehicleIds,
        consist: vehicleIds.length > 1 ? "double_set" : vehicleIds.length === 1 ? "single_set" : "unknown",
        sourceTimestamp: payload.updatedAt || null,
        provenance: occurrence.vehicleResolutionSource || null,
        datasetUpdatedAt: payload.updatedAt || null,
        datasetMode: payload.mode || null
      });
    }
  }
  return [...byRoute.values()];
}

function validateOverride(override) {
  const required = [
    "trainNumber", "occurrenceId", "vehicleId", "part", "timestamp", "rawValue",
    "originalValue", "overrideValue", "source", "provenance", "scope"
  ];
  const missing = required.filter((field) => override?.[field] == null || String(override[field]).trim() === "");
  const expectedScope = override
    ? `${override.occurrenceId}|${override.part}`
    : "";
  if (override && override.scope !== expectedScope) missing.push("scope_exact_match");
  return { valid: missing.length === 0, missing, expectedScope };
}

function valueEquals(field, left, right) {
  if (field === "vehicleIds") {
    return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right));
  }
  return String(left ?? "") === String(right ?? "");
}

function mismatchCategory(field) {
  if (["trainNumber", "direction", "time"].includes(field)) return "identity_mismatch";
  if (field === "vehicleIds") return "vehicle_mismatch";
  if (field === "consist") return "consist_mismatch";
  if (field === "track") return "track_mismatch";
  if (field === "operationalDate") return "date_mismatch";
  return "unauthorized_difference";
}

function matchingOverride(overrides, balise, sde, field) {
  return (overrides || []).find((override) => {
    const check = validateOverride(override);
    return check.valid &&
      override.trainNumber === sde.trainNumber &&
      override.occurrenceId === sde.occurrenceId &&
      override.part === field &&
      String(override.rawValue) === String(balise[field] ?? "") &&
      String(override.overrideValue) === String(sde[field] ?? "");
  }) || null;
}

function compareRecords(baliseRecords, sdeRecords, options = {}) {
  const differences = [];
  const baliseByRoute = new Map((baliseRecords || []).map((item) => [item.routeId, item]));
  const sdeByRoute = new Map((sdeRecords || []).map((item) => [item.routeId, item]));
  const add = (category, detail) => differences.push({ category, ...detail });

  for (const [routeId, balise] of baliseByRoute) {
    const sde = sdeByRoute.get(routeId);
    if (!sde) {
      add("balise_only", { routeId, balise });
      continue;
    }
    if (!balise.provenance || !sde.provenance) {
      add("provenance_missing", { routeId, baliseProvenance: balise.provenance, sdeProvenance: sde.provenance });
    }
    if (balise.occurrenceId !== sde.occurrenceId) {
      add("occurrence_mismatch", { routeId, balise: balise.occurrenceId, sde: sde.occurrenceId });
      add("unauthorized_difference", { routeId, field: "occurrenceId", sourceCategory: "occurrence_mismatch" });
    }
    for (const field of COMPARABLE_FIELDS) {
      if (valueEquals(field, balise[field], sde[field])) continue;
      const override = matchingOverride(options.overrides, balise, sde, field);
      const category = mismatchCategory(field);
      if (override) {
        add("authorized_override", { routeId, field, raw: balise[field], override: sde[field], authority: override });
      } else {
        add(category, { routeId, field, balise: balise[field], sde: sde[field] });
        add("unauthorized_difference", { routeId, field, sourceCategory: category });
      }
    }
  }
  for (const [routeId, sde] of sdeByRoute) {
    if (!baliseByRoute.has(routeId)) add("sde_only", { routeId, sde });
  }
  if (options.sourceStale) add("stale_source", options.sourceStale);
  if (options.sdeStale) add("stale_sde_dataset", options.sdeStale);

  const counts = Object.fromEntries(PARITY_CATEGORIES.map((category) => [category, 0]));
  for (const item of differences) counts[item.category] += 1;
  return { categories: [...PARITY_CATEGORIES], counts, differences };
}

function rawValue(record, field) {
  if (!record) return null;
  if (field === "track") return record.rawTrackValue ?? record.track ?? null;
  return record[field] ?? null;
}

function discrepancyCategory(field, target) {
  const suffix = target === "candidate" ? "candidate" : "published";
  if (field === "vehicleIds") return `vehicle_mismatch_${suffix}`;
  if (field === "consist") return `consist_mismatch_${suffix}`;
  if (field === "track") return `track_mismatch_${suffix}`;
  if (field === "operationalDate") return `date_mismatch_${suffix}`;
  return "unauthorized_difference";
}

function fieldClassification({ field, balise, candidate, published, target, override }) {
  if (override) {
    return {
      findingType: "AUTHORIZED_OVERRIDE",
      confidence: "HIGH",
      aggregateCategory: "authorized_override",
      contract: "En forskjell er tillatt bare med full, forekomst- og feltbundet override-proveniens.",
      alternatives: ["Ingen; override-authority er eksplisitt og validert."],
      additionalEvidence: []
    };
  }
  const compared = target === "candidate" ? candidate : published;
  const peer = target === "candidate" ? published : candidate;
  if (field === "track" && balise?.direction === "departure" && compared?.track == null) {
    return {
      findingType: "TEST_ORACLE_DEFECT",
      confidence: "HIGH",
      aggregateCategory: "expected_difference",
      contract: "QE skal bare sammenligne actual-spor når begge kildekontraktene representerer samme felt.",
      alternatives: ["Departure-occurrence i SDE-payloaden har ingen actual platformTrack-kontrakt."],
      additionalEvidence: ["Dokumenter eksplisitt om departure-spor senere blir del av payloadkontrakten."]
    };
  }
  if (field === "track" && compared?.track == null) {
    return {
      findingType: "CONTRACT_AMBIGUITY",
      confidence: "MEDIUM",
      aggregateCategory: "contract_ambiguity",
      contract: "Actual-spor krever tidsriktig, occurrence-bundet proveniens.",
      alternatives: ["Balise kan ha actual-spor etter at payloaden ble generert.", "SDE kan mangle et representerbart spor uten at selve forekomsten er feil."],
      additionalEvidence: ["Sammenlign generatorens sourceObservedAt med Balise-feltets endringstid."]
    };
  }
  if (peer && valueEquals(field, compared?.[field], peer?.[field])) {
    return {
      findingType: "PROBABLE_DEFECT",
      confidence: "MEDIUM",
      aggregateCategory: "unauthorized_difference",
      contract: "Kandidat og publisert payload skal samsvare med autoritativ occurrence-verdi.",
      alternatives: ["Balise kan ha endret seg etter siste legitime generering.", "Kildesnapshot og payloadsnapshot kan dekke ulike tidspunkter."],
      additionalEvidence: ["Sammenlign eksakt generator-run og kildehash fra samme snapshotvindu."]
    };
  }
  return {
    findingType: "POSSIBLE_FALSE_POSITIVE",
    confidence: "LOW",
    aggregateCategory: "possible_false_positive",
    contract: "Tre kilder må måles med sammenlignbar occurrence- og tidssemantikk.",
    alternatives: ["Publiseringsforsinkelse.", "Snapshot-skew.", "Ulik occurrence-definisjon eller normalisering."],
    additionalEvidence: ["Etabler samme kildehash og genereringstid for kandidat og publisert payload."]
  };
}

function compareThreeWay({
  baliseRecords = [],
  candidateRecords = [],
  publishedRecords = [],
  overrides = [],
  observedAt = new Date().toISOString(),
  sourceAvailability = { balise: true, candidate: true, published: true }
}) {
  const byRoute = (records) => new Map(records.map((record) => [record.routeId, record]));
  const baliseByRoute = byRoute(baliseRecords);
  const candidateByRoute = byRoute(candidateRecords);
  const publishedByRoute = byRoute(publishedRecords);
  const findings = [];
  const occurrenceCounts = Object.fromEntries([
    "balise_only_candidate", "candidate_only", "balise_only_published", "published_only"
  ].map((category) => [category, 0]));
  const fieldCounts = Object.fromEntries(THREE_WAY_CATEGORIES
    .filter((category) => !(category in occurrenceCounts))
    .map((category) => [category, 0]));

  function addFinding({ routeId, category, field = "occurrence", balise = null, candidate = null, published = null, target = null, classification = null }) {
    const reference = balise || candidate || published || {};
    const resolved = classification || {
      findingType: "POSSIBLE_FALSE_POSITIVE",
      confidence: "LOW",
      aggregateCategory: "possible_false_positive",
      contract: "Forekomstsett må være tidsmessig og semantisk sammenlignbare.",
      alternatives: ["Snapshot-skew.", "Ulikt genererings- eller publiseringsvindu."],
      additionalEvidence: ["Etabler kilde- og payloadhash fra samme observasjonsvindu."]
    };
    if (field === "occurrence") occurrenceCounts[category] += 1;
    else fieldCounts[category] = (fieldCounts[category] || 0) + 1;
    if (resolved.aggregateCategory && resolved.aggregateCategory !== category) {
      fieldCounts[resolved.aggregateCategory] = (fieldCounts[resolved.aggregateCategory] || 0) + 1;
    }
    const actualRecord = target === "published" ? published : target === "candidate" ? candidate : null;
    findings.push({
      testId: "BALISE-010-LIVE",
      status: resolved.findingType === "PROBABLE_DEFECT" ? "RED" : resolved.findingType === "AUTHORIZED_OVERRIDE" || resolved.findingType === "EXPECTED_DIFFERENCE" ? "GREEN" : "AMBER",
      findingType: resolved.findingType,
      confidence: resolved.confidence,
      category,
      routeId,
      occurrenceId: reference.occurrenceId || null,
      trainNumber: reference.trainNumber || null,
      operationalDate: reference.operationalDate || null,
      field,
      rawBalise: field === "occurrence" ? balise : rawValue(balise, field),
      normalizedBalise: field === "occurrence" ? balise?.occurrenceId ?? null : balise?.[field] ?? null,
      candidate: field === "occurrence" ? candidate?.occurrenceId ?? null : candidate?.[field] ?? null,
      published: field === "occurrence" ? published?.occurrenceId ?? null : published?.[field] ?? null,
      provenance: {
        balise: balise?.provenance || null,
        candidate: candidate?.provenance || null,
        published: published?.provenance || null
      },
      observedAt,
      expected: field === "occurrence" ? balise?.occurrenceId ?? null : balise?.[field] ?? null,
      actual: field === "occurrence" ? actualRecord?.occurrenceId ?? null : actualRecord?.[field] ?? null,
      brokenContract: resolved.contract,
      alternativeExplanations: resolved.alternatives,
      additionalEvidenceRequired: resolved.additionalEvidence
    });
  }

  for (const [routeId, balise] of baliseByRoute) {
    const candidate = candidateByRoute.get(routeId) || null;
    const published = publishedByRoute.get(routeId) || null;
    if (!candidate) addFinding({ routeId, category: "balise_only_candidate", balise, published, target: "candidate" });
    if (sourceAvailability.published !== false && !published) {
      addFinding({ routeId, category: "balise_only_published", balise, candidate, target: "published" });
    }
    for (const [target, compared] of [["candidate", candidate], ["published", published]]) {
      if (target === "published" && sourceAvailability.published === false) continue;
      if (!compared) continue;
      for (const field of COMPARABLE_FIELDS) {
        if (valueEquals(field, balise[field], compared[field])) continue;
        const override = matchingOverride(overrides, balise, compared, field);
        const classification = fieldClassification({ field, balise, candidate, published, target, override });
        addFinding({
          routeId,
          category: override ? "authorized_override" : discrepancyCategory(field, target),
          field,
          balise,
          candidate,
          published,
          target,
          classification
        });
      }
    }
  }
  for (const [routeId, candidate] of candidateByRoute) {
    if (!baliseByRoute.has(routeId)) addFinding({ routeId, category: "candidate_only", candidate, published: publishedByRoute.get(routeId) || null, target: "candidate" });
  }
  if (sourceAvailability.published !== false) {
    for (const [routeId, published] of publishedByRoute) {
      if (!baliseByRoute.has(routeId)) addFinding({ routeId, category: "published_only", candidate: candidateByRoute.get(routeId) || null, published, target: "published" });
    }
  } else {
    addFinding({
      routeId: "published-source",
      category: "contract_ambiguity",
      field: "source",
      classification: {
        findingType: "BLOCKED",
        confidence: "HIGH",
        aggregateCategory: "contract_ambiguity",
        contract: "Faktisk publisert payload må kunne leses med GET før treveis paritet kan konkluderes.",
        alternatives: ["Cloudflare Access eller klientpolicy kan blokkere QE uten at publisert payload er feil."],
        additionalEvidence: ["Les begge publiserte payloadene i en autentisert, read-only kontroll og registrer råhashene."]
      }
    });
  }

  const findingTypeCounts = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  for (const finding of findings) findingTypeCounts[finding.findingType] += 1;
  const contractViolations = findingTypeCounts.CONFIRMED_DEFECT + findingTypeCounts.PROBABLE_DEFECT;
  return {
    categories: [...THREE_WAY_CATEGORIES],
    occurrenceLevelDiscrepancies: occurrenceCounts,
    fieldLevelDiscrepancies: fieldCounts,
    findingTypeCounts,
    findingCount: findings.length,
    releaseStatus: findingTypeCounts.BLOCKED ? "BLOCKED" : contractViolations ? "SDE_NO_GO" : findings.length ? "HOLD" : "SDE_GREEN",
    findings
  };
}

function osloLocalParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
}

function osloBoundary(parts, hour) {
  const text = `${parts.day}.${parts.month}.${parts.year} ${String(hour).padStart(2, "0")}:00:00`;
  return new Date(parseUpdatedAt(text));
}

function requiredRefreshBoundary(now, contract) {
  const parts = osloLocalParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const thresholdOffset = Math.min(...contract.attemptMinutes) + contract.publicationGraceMinutes;
  const eligible = contract.cycleHours.filter((hour) => currentMinutes >= hour * 60 + thresholdOffset);
  if (eligible.length) return osloBoundary(parts, eligible.at(-1));
  const yesterday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const previous = osloLocalParts(yesterday);
  return osloBoundary(previous, contract.cycleHours.at(-1));
}

function nextScheduledAttempt(now, contract) {
  const parts = osloLocalParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  for (const hour of contract.cycleHours) {
    for (const minute of contract.attemptMinutes) {
      if (hour * 60 + minute > currentMinutes) {
        const text = `${parts.day}.${parts.month}.${parts.year} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
        return new Date(parseUpdatedAt(text));
      }
    }
  }
  const tomorrow = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = osloLocalParts(tomorrow);
  const text = `${next.day}.${next.month}.${next.year} ${String(contract.cycleHours[0]).padStart(2, "0")}:${String(contract.attemptMinutes[0]).padStart(2, "0")}:00`;
  return new Date(parseUpdatedAt(text));
}

function evaluateFreshness({ now, sourceReadAt, sourceResponseDate, sourceOwnTimestamp = null, sdeGeneratedAt, serverLastUpdate = null, contract }) {
  const testTime = new Date(now);
  const boundary = requiredRefreshBoundary(testTime, contract);
  const generatedMs = parseUpdatedAt(sdeGeneratedAt);
  const sourceResponse = sourceResponseDate ? new Date(sourceResponseDate) : null;
  const sourceAgeSeconds = sourceResponse && Number.isFinite(sourceResponse.getTime())
    ? Math.max(0, (testTime - sourceResponse) / 1000)
    : null;
  const sdeAgeSeconds = generatedMs == null ? null : Math.max(0, (testTime.getTime() - generatedMs) / 1000);
  const allowedSdeAgeSeconds = Math.max(0, (testTime - boundary) / 1000);
  const sourceFresh = sourceAgeSeconds != null && sourceAgeSeconds <= contract.sourceResponseMaxAgeSeconds;
  const sdeFresh = generatedMs != null && generatedMs >= boundary.getTime() && generatedMs <= testTime.getTime();
  return {
    sourceReadAt: new Date(sourceReadAt).toISOString(),
    sourceOwnTimestamp,
    sourceResponseDate: sourceResponse?.toISOString() || null,
    sdeGeneratedAt,
    sdeGeneratedAtIso: generatedMs == null ? null : new Date(generatedMs).toISOString(),
    serverLastUpdate,
    testTime: testTime.toISOString(),
    sourceAgeSeconds,
    sdeAgeSeconds,
    allowedSourceAgeSeconds: contract.sourceResponseMaxAgeSeconds,
    allowedSdeAgeSeconds,
    requiredRefreshBoundary: boundary.toISOString(),
    nextScheduledAttempt: nextScheduledAttempt(testTime, contract).toISOString(),
    sourceStatus: sourceFresh ? "FRESH" : "STALE_OR_UNKNOWN",
    sdeStatus: sdeFresh ? "FRESH" : "STALE_OR_UNKNOWN",
    status: sourceFresh && sdeFresh ? "GREEN" : "RED"
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "SDE-QE-read-only/1.0" },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${url}`);
      error.code = options.errorCode || "AUTHORITATIVE_SOURCE_UNAVAILABLE";
      throw error;
    }
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (_error) {
      const error = new Error(`Ugyldig JSON-respons ${url}`);
      error.code = options.errorCode || "AUTHORITATIVE_SOURCE_UNAVAILABLE";
      throw error;
    }
    if (options.balise !== false && (!body?.success || !Array.isArray(body.data))) {
      const error = new Error(`Ugyldig Balise-respons ${url}`);
      error.code = options.errorCode || "AUTHORITATIVE_SOURCE_UNAVAILABLE";
      throw error;
    }
    return {
      body,
      data: options.balise === false ? body : body.data,
      responseDate: response.headers.get("date"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      rawSha256: crypto.createHash("sha256").update(raw).digest("hex"),
      rawBytes: Buffer.byteLength(raw)
    };
  } catch (error) {
    if (!error.code) error.code = options.errorCode || "AUTHORITATIVE_SOURCE_UNAVAILABLE";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return output;
}

function responseEvidence(url, response) {
  return {
    url,
    httpDate: response.responseDate,
    etag: response.etag,
    lastModified: response.lastModified,
    rawSha256: response.rawSha256,
    rawBytes: response.rawBytes
  };
}

async function captureAuthoritativeSnapshot(stationUrl) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date();
    const stationBefore = await fetchJson(stationUrl);
    const routes = uniqueSorted(stationBefore.data.map((row) => row.stop_route));
    const routeResponses = await mapLimit(routes, 8, async (routeId) => {
      const url = `https://balise.no/api/train/vehicles?route=${encodeURIComponent(routeId)}`;
      const response = await fetchJson(url);
      const atSkien = response.data.filter((row) => String(row.station_name || "").toLowerCase() === "skien");
      return {
        routeId,
        vehicles: uniqueSorted(atSkien.map((row) => row.vehicle)),
        evidence: responseEvidence(url, response)
      };
    });
    const stationAfter = await fetchJson(stationUrl);
    const changedDuringObservation = stationBefore.rawSha256 !== stationAfter.rawSha256;
    const endedAt = new Date();
    const snapshot = {
      attempt,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      station: responseEvidence(stationUrl, stationBefore),
      stationVerification: responseEvidence(stationUrl, stationAfter),
      routeResponses: routeResponses.map((item) => item.evidence),
      routeCount: routes.length,
      occurrenceCount: stationBefore.data.length,
      changedDuringObservation,
      controlledRetryUsed: attempt === 2
    };
    if (!changedDuringObservation) {
      return {
        rows: stationBefore.data,
        vehiclesByRoute: Object.fromEntries(routeResponses.map((item) => [item.routeId, item.vehicles])),
        snapshot
      };
    }
    if (attempt === 2) {
      const error = new Error("Authoritative source changed during both snapshot attempts");
      error.code = "AUTHORITATIVE_SOURCE_CHANGED";
      error.snapshot = snapshot;
      throw error;
    }
  }
  throw new Error("Snapshot loop ended unexpectedly");
}

function payloadUrl(baseUrl, fileName) {
  return `${String(baseUrl).replace(/\/$/, "")}/data/${fileName}`;
}

async function readPublishedPayloads(baseUrl) {
  const files = ["api_idag.json", "api_imorgen.json"];
  const responses = await Promise.all(files.map(async (fileName) => {
    const url = payloadUrl(baseUrl, fileName);
    const response = await fetchJson(url, { balise: false, errorCode: "PUBLISHED_SOURCE_UNAVAILABLE" });
    if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
      const error = new Error(`Publisert payload har ugyldig kontrakt: ${url}`);
      error.code = "PUBLISHED_SOURCE_UNAVAILABLE";
      throw error;
    }
    return { fileName, payload: response.body, evidence: responseEvidence(url, response) };
  }));
  return {
    baseUrl,
    payloads: responses.map((item) => item.payload),
    responses: responses.map((item) => item.evidence)
  };
}

async function readLiveBalise() {
  const stationUrl = "https://balise.no/api/station/SKN?content=all&passthru=true";
  const publishedBaseUrl = process.env.SDE_QE_PUBLISHED_BASE_URL || "https://sde.oyvind-solglott.no";
  const sourceReadAt = new Date();
  const [authoritative, publishedResult] = await Promise.all([
    captureAuthoritativeSnapshot(stationUrl),
    readPublishedPayloads(publishedBaseUrl).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )
  ]);
  const published = publishedResult.ok
    ? publishedResult.value
    : { baseUrl: publishedBaseUrl, payloads: [], responses: [] };
  const root = repoRoot();
  const payloads = [
    readJson(path.join(root, "data/api_idag.json")),
    readJson(path.join(root, "data/api_imorgen.json"))
  ];
  const operationalDates = new Set(payloads.map((payload) => payload.date));
  const publishedDates = new Set(published.payloads.map((payload) => payload.date));
  const scopedRows = authoritative.rows.filter((row) => operationalDates.has(String(row.route_date)) || publishedDates.has(String(row.route_date)));
  if (!scopedRows.length) throw new Error("Balise ga ingen rader for SDE-payloadenes operative datoer");
  const baliseRecords = normalizeBaliseRows(scopedRows, authoritative.vehiclesByRoute);
  const allCandidate = normalizeSdePayloads(payloads);
  const allPublished = normalizeSdePayloads(published.payloads);
  const eventTimes = scopedRows.map(eventTimestamp).filter(Boolean).sort();
  const scopeStart = eventTimes[0];
  const scopeEnd = eventTimes.at(-1);
  const inScope = (item) => {
    const timestamp = `${item.operationalDate} ${item.time}:00`;
    return timestamp >= scopeStart && timestamp <= scopeEnd;
  };
  const candidateRecords = allCandidate.filter(inScope);
  const publishedRecords = allPublished.filter(inScope);
  const contract = readJson(path.join(root, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));
  const freshnessByPayload = payloads.map((payload) => evaluateFreshness({
    now: new Date(),
    sourceReadAt,
    sourceResponseDate: authoritative.snapshot.station.httpDate,
    sourceOwnTimestamp: null,
    sdeGeneratedAt: payload.updatedAt,
    serverLastUpdate: null,
    contract
  }));
  const sourceStale = freshnessByPayload.some((item) => item.sourceStatus !== "FRESH")
    ? { freshnessByPayload }
    : null;
  const sdeStale = freshnessByPayload.some((item) => item.sdeStatus !== "FRESH")
    ? { freshnessByPayload }
    : null;
  const parity = compareRecords(baliseRecords, candidateRecords, { sourceStale, sdeStale });
  const threeWay = compareThreeWay({
    baliseRecords,
    candidateRecords,
    publishedRecords,
    observedAt: authoritative.snapshot.endedAt,
    sourceAvailability: { balise: true, candidate: true, published: publishedResult.ok }
  });
  return {
    authoritativeSource: stationUrl,
    sourceReadAt: sourceReadAt.toISOString(),
    sourceResponseDate: authoritative.snapshot.station.httpDate,
    sourceOwnTimestamp: null,
    sourceOwnTimestampStatus: "NOT_EXPOSED_BY_ENDPOINT",
    publishedSource: publishedBaseUrl,
    snapshot: authoritative.snapshot,
    publishedSnapshot: {
      status: publishedResult.ok ? "AVAILABLE" : "BLOCKED",
      blockedReason: publishedResult.ok ? null : "BLOCKED – PUBLISHED SDE DATA UNAVAILABLE",
      error: publishedResult.ok ? null : String(publishedResult.error?.message || publishedResult.error),
      startedAt: sourceReadAt.toISOString(),
      endedAt: new Date().toISOString(),
      responses: published.responses,
      occurrenceCount: publishedRecords.length
    },
    coverage: {
      operationalDates: [...operationalDates].sort(),
      publishedOperationalDates: [...publishedDates].sort(),
      scopeStart,
      scopeEnd,
      baliseRecords: baliseRecords.length,
      candidateRecords: candidateRecords.length,
      publishedRecords: publishedRecords.length
    },
    freshnessByPayload,
    parity,
    threeWay,
    priorGateReassessment: [
      {
        id: "BALISE-002",
        beforeRestack: "RED",
        afterRestack: payloads[1].date === [...operationalDates].sort().at(-1) ? "GREEN_OR_CURRENT" : "REVIEW",
        changedData: "data/api_imorgen.json",
        contract: "Morgendagens payload følger Europe/Oslo-vinduet.",
        findingType: "EXPECTED_DIFFERENCE",
        confidence: "HIGH",
        alternativeExplanations: ["Ingen når expectedOperationalDates og payloaddato samsvarer."],
        nextInvestigation: "Ingen SDE-endring; behold porten og observer neste tidsgrense."
      },
      ...["IDAG", "IMORGEN"].map((mode, index) => ({
        id: `BALISE-003-${mode}`,
        beforeRestack: "RED",
        afterRestack: freshnessByPayload[index].sdeStatus === "FRESH" ? "GREEN" : "RED",
        changedData: `data/api_${mode.toLowerCase()}.json`,
        contract: "Payloaden skal være generert etter siste påkrevde refreshgrense.",
        findingType: freshnessByPayload[index].sdeStatus === "FRESH" ? "EXPECTED_DIFFERENCE" : "PROBABLE_DEFECT",
        confidence: "HIGH",
        alternativeExplanations: ["Refresh kan være forsinket innen publiseringsgrace."],
        nextInvestigation: "Kontroller workflow-run read-only dersom porten blir rød."
      })),
      {
        id: "BALISE-010-LIVE",
        beforeRestack: "RED",
        afterRestack: threeWay.releaseStatus,
        changedData: "Begge kandidatpayloadene og mulig publisert payload kan ha endret seg.",
        contract: "Tre kilder sammenlignes occurrence- og feltvis med eksplisitt usikkerhet.",
        findingType: threeWay.findingTypeCounts.PROBABLE_DEFECT ? "PROBABLE_DEFECT" : threeWay.findingCount ? "POSSIBLE_FALSE_POSITIVE" : "EXPECTED_DIFFERENCE",
        confidence: threeWay.findingTypeCounts.PROBABLE_DEFECT ? "MEDIUM" : "LOW",
        alternativeExplanations: ["Snapshot-skew.", "Publiseringsforsinkelse.", "Test-orakel eller occurrence-kontrakt."],
        nextInvestigation: "Undersøk funnene enkeltvis; ikke rett SDE automatisk."
      }
    ],
    oracleAssessment: {
      operationalDay: "EVALUATED",
      observationTime: "EVALUATED_WITH_SNAPSHOT_METADATA",
      occurrenceDefinition: "ROUTE_ID_PRIMARY_WITH_OCCURRENCE_EVIDENCE",
      consistOrdering: "ORDER_INSENSITIVE_UNIQUE_SET",
      trackNormalization: "DEPARTURE_NULL_IS_NOT_COMPARED_AS_ACTUAL_TRACK",
      overrides: "ONLY_FULL_PROVENANCE_ACCEPTED",
      generationTiming: "ALTERNATIVE_EXPLANATION_UNTIL_SAME_SNAPSHOT_IS_PROVEN"
    }
  };
}

async function main() {
  try {
    const report = await readLiveBalise();
    process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
  } catch (error) {
    const sourceUnavailable = error?.code === "AUTHORITATIVE_SOURCE_UNAVAILABLE";
    const publishedUnavailable = error?.code === "PUBLISHED_SOURCE_UNAVAILABLE";
    const sourceChanged = error?.code === "AUTHORITATIVE_SOURCE_CHANGED";
    const blocked = sourceUnavailable || publishedUnavailable || sourceChanged;
    const blockedReason = sourceChanged
      ? "BLOCKED – AUTHORITATIVE SOURCE CHANGED DURING SNAPSHOT"
      : publishedUnavailable
        ? "BLOCKED – PUBLISHED SDE DATA UNAVAILABLE"
        : sourceUnavailable
          ? "BLOCKED – AUTHORITATIVE BALISE SOURCE UNAVAILABLE"
          : null;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: blocked ? "BLOCKED" : "RED",
      findingType: blocked ? "BLOCKED" : "UNKNOWN",
      blockedReason,
      error: String(error?.message || error),
      snapshot: error?.snapshot || null
    })}\n`);
    process.exitCode = blocked ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  FINDING_TYPES,
  PARITY_CATEGORIES,
  THREE_WAY_CATEGORIES,
  compareRecords,
  compareThreeWay,
  evaluateFreshness,
  normalizeBaliseRows,
  normalizeSdePayloads,
  readLiveBalise,
  requiredRefreshBoundary,
  validateOverride
};
