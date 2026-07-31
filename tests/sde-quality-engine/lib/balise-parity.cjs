"use strict";

const path = require("node:path");
const { readJson, repoRoot } = require("./core.cjs");

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

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "SDE-QE-read-only/1.0" },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${url}`);
      error.code = "AUTHORITATIVE_SOURCE_UNAVAILABLE";
      throw error;
    }
    const body = await response.json();
    if (!body?.success || !Array.isArray(body.data)) {
      const error = new Error(`Ugyldig Balise-respons ${url}`);
      error.code = "AUTHORITATIVE_SOURCE_UNAVAILABLE";
      throw error;
    }
    return { data: body.data, responseDate: response.headers.get("date") };
  } catch (error) {
    if (!error.code) error.code = "AUTHORITATIVE_SOURCE_UNAVAILABLE";
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

async function readLiveBalise() {
  const stationUrl = "https://balise.no/api/station/SKN?content=all&passthru=true";
  const sourceReadAt = new Date();
  const station = await fetchJson(stationUrl);
  const root = repoRoot();
  const payloads = [
    readJson(path.join(root, "data/api_idag.json")),
    readJson(path.join(root, "data/api_imorgen.json"))
  ];
  const operationalDates = new Set(payloads.map((payload) => payload.date));
  const scopedRows = station.data.filter((row) => operationalDates.has(String(row.route_date)));
  if (!scopedRows.length) throw new Error("Balise ga ingen rader for SDE-payloadenes operative datoer");
  const routes = uniqueSorted(scopedRows.map((row) => row.stop_route));
  const routeResponses = await mapLimit(routes, 8, async (routeId) => {
    const response = await fetchJson(`https://balise.no/api/train/vehicles?route=${encodeURIComponent(routeId)}`);
    const atSkien = response.data.filter((row) => String(row.station_name || "").toLowerCase() === "skien");
    return [routeId, uniqueSorted(atSkien.map((row) => row.vehicle))];
  });
  const vehiclesByRoute = Object.fromEntries(routeResponses);
  const baliseRecords = normalizeBaliseRows(scopedRows, vehiclesByRoute);
  const allSde = normalizeSdePayloads(payloads);
  const eventTimes = scopedRows.map(eventTimestamp).filter(Boolean).sort();
  const scopeStart = eventTimes[0];
  const scopeEnd = eventTimes.at(-1);
  const sdeRecords = allSde.filter((item) => {
    const timestamp = `${item.operationalDate} ${item.time}:00`;
    return timestamp >= scopeStart && timestamp <= scopeEnd;
  });
  const contract = readJson(path.join(root, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));
  const freshnessByPayload = payloads.map((payload) => evaluateFreshness({
    now: new Date(),
    sourceReadAt,
    sourceResponseDate: station.responseDate,
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
  const parity = compareRecords(baliseRecords, sdeRecords, { sourceStale, sdeStale });
  return {
    authoritativeSource: stationUrl,
    sourceReadAt: sourceReadAt.toISOString(),
    sourceResponseDate: station.responseDate,
    sourceOwnTimestamp: null,
    sourceOwnTimestampStatus: "NOT_EXPOSED_BY_ENDPOINT",
    coverage: { operationalDates: [...operationalDates].sort(), scopeStart, scopeEnd, baliseRecords: baliseRecords.length, sdeRecords: sdeRecords.length },
    freshnessByPayload,
    parity
  };
}

async function main() {
  try {
    const report = await readLiveBalise();
    process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
  } catch (error) {
    const sourceUnavailable = error?.code === "AUTHORITATIVE_SOURCE_UNAVAILABLE";
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: sourceUnavailable ? "BLOCKED" : "RED",
      blockedReason: sourceUnavailable ? "BLOCKED – AUTHORITATIVE BALISE SOURCE UNAVAILABLE" : null,
      error: String(error?.message || error)
    })}\n`);
    process.exitCode = sourceUnavailable ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  PARITY_CATEGORIES,
  compareRecords,
  evaluateFreshness,
  normalizeBaliseRows,
  normalizeSdePayloads,
  readLiveBalise,
  requiredRefreshBoundary,
  validateOverride
};
