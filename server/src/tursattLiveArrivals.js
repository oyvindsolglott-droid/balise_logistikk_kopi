"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BALISE_STOPS_ORIGIN = "https://balise.no";
const BALISE_STOPS_PATH = "/api/train/stops";
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_STALE_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const MAX_OCCURRENCES = 64;
const SAFE_ROUTE_ID = /^[A-Za-z0-9_-]{1,96}$/;

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(clean(value));
}

function sourceRevision(context) {
  return clean(context.sourceRevision || context.sourceUpdatedAt || context.sourceObservedAt);
}

function canonicalClock(value) {
  const match = clean(value).match(/(?:^|[ T])(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function parseServiceTimestamp(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5] || 0);
}

function formatServiceTimestamp(value) {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function normalizeOccurrence(trainKey, value, operationalDate) {
  const context = value && typeof value === "object" ? value.movementContext : null;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const trainNumber = clean(context.trainNumber || trainKey).replace(/\s+/g, "");
  const plannedArrival = clean(context.plannedArrival);
  const occurrence = {
    operationalDate: clean(context.operationalDate),
    trainNumber,
    stationRef: clean(context.stationRef).toUpperCase(),
    direction: clean(context.direction || "arrival").toLowerCase(),
    plannedArrival,
    routeId: clean(context.routeId),
    stopId: clean(context.stopId),
    occurrenceId: clean(context.occurrenceId),
    sourceRevision: sourceRevision(context)
  };
  const expectedOccurrenceId = `${operationalDate}|arrival|${trainNumber}|${canonicalClock(plannedArrival)}`;
  const required = Object.values(occurrence).every(Boolean);
  const exact = required
    && occurrence.operationalDate === operationalDate
    && occurrence.stationRef === "SKN"
    && occurrence.direction === "arrival"
    && occurrence.occurrenceId === expectedOccurrenceId;
  return exact ? occurrence : null;
}

function readOccurrences(repositoryRoot, operationalDate) {
  const files = ["api_idag.json", "api_imorgen.json"];
  for (const filename of files) {
    const filePath = path.join(repositoryRoot, "data", filename);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_error) {
      continue;
    }
    if (clean(payload.date) !== operationalDate || !payload.arrivals || typeof payload.arrivals !== "object") continue;
    return Object.entries(payload.arrivals)
      .map(([train, value]) => normalizeOccurrence(train, value, operationalDate))
      .filter(Boolean)
      .slice(0, MAX_OCCURRENCES);
  }
  throw new Error("operational_date_not_available");
}

function buildStopsUrl(routeId) {
  if (!SAFE_ROUTE_ID.test(clean(routeId))) return "";
  const url = new URL(BALISE_STOPS_PATH, BALISE_STOPS_ORIGIN);
  url.searchParams.set("route", clean(routeId));
  return url.toString();
}

async function fetchRouteStops(routeId, {fetchImpl, timeoutMs}) {
  const url = buildStopsUrl(routeId);
  if (!url) throw new Error("invalid_route_id");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {method: "GET", signal: controller.signal, redirect: "error"});
    if (!response || !response.ok) throw new Error(`balise_http_${response && response.status || 0}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data)) throw new Error("balise_invalid_payload");
    return {
      rows: payload.data.filter(row => row && typeof row === "object" && !Array.isArray(row)),
      updatedAt: clean(response.headers && response.headers.get && response.headers.get("date"))
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(Math.max(1, concurrency), Math.max(1, values.length))}, worker));
  return result;
}

function isSkienStop(row) {
  return clean(row.station_ref).toUpperCase() === "SKN" || clean(row.station_name).toLowerCase() === "skien";
}

function propagatedArrival(rows, targetIndex, plannedArrival) {
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const planned = parseServiceTimestamp(row.stop_planned_arrival);
    const live = parseServiceTimestamp(row.stop_actual_arrival) ?? parseServiceTimestamp(row.stop_estimated_arrival);
    const target = parseServiceTimestamp(plannedArrival);
    if (planned == null || live == null || target == null) continue;
    const delayMs = live - planned;
    if (!Number.isFinite(delayMs)) continue;
    return formatServiceTimestamp(target + delayMs);
  }
  return "";
}

function unavailableRecord(occurrence, reason, observedAt) {
  return {
    ...occurrence,
    estimatedArrival: "",
    actualArrival: "",
    delayMinutes: null,
    delaySource: "",
    observedAt,
    upstreamUpdatedAt: "",
    freshness: "unavailable",
    status: reason
  };
}

function bindOccurrenceToStops(occurrence, routeResult, observedAt) {
  if (!routeResult || routeResult.error) return unavailableRecord(occurrence, routeResult && routeResult.error || "route_unavailable", observedAt);
  const candidates = routeResult.rows
    .map((row, index) => ({row, index}))
    .filter(({row}) => clean(row.stop_id) === occurrence.stopId)
    .filter(({row}) => isSkienStop(row))
    .filter(({row}) => clean(row.stop_planned_arrival) === occurrence.plannedArrival);
  if (candidates.length !== 1) return unavailableRecord(occurrence, candidates.length ? "ambiguous_exact_stop" : "exact_stop_not_found", observedAt);

  const {row, index} = candidates[0];
  const actualArrival = clean(row.stop_actual_arrival);
  const explicitEstimate = clean(row.stop_estimated_arrival);
  const propagatedEstimate = actualArrival || explicitEstimate ? "" : propagatedArrival(routeResult.rows, index, occurrence.plannedArrival);
  const estimatedArrival = explicitEstimate || propagatedEstimate;
  const delaySource = actualArrival
    ? "actual_arrival_at_skien"
    : explicitEstimate
      ? "estimated_arrival_at_skien"
      : propagatedEstimate
        ? "propagated_route_delay"
        : "";
  const plannedMs = parseServiceTimestamp(occurrence.plannedArrival);
  const liveMs = parseServiceTimestamp(actualArrival) ?? parseServiceTimestamp(estimatedArrival);
  const delayMinutes = plannedMs == null || liveMs == null ? null : Math.round((liveMs - plannedMs) / 60_000);
  return {
    ...occurrence,
    estimatedArrival,
    actualArrival,
    delayMinutes,
    delaySource,
    observedAt,
    upstreamUpdatedAt: routeResult.updatedAt,
    freshness: delaySource ? "fresh" : "unavailable",
    status: delaySource ? "live" : "live_time_not_available"
  };
}

function staleResponse(response, nowMs) {
  return {
    ...response,
    ok: true,
    upstreamHealthy: false,
    cache: "stale-fallback",
    generatedAt: new Date(nowMs).toISOString(),
    records: response.records.map(record => record.freshness === "fresh"
      ? {...record, freshness: "stale", status: "stale_fallback"}
      : record)
  };
}

function createTursattLiveArrivalService(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.resolve(__dirname, "..", ".."));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const cacheTtlMs = Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  const maxStaleMs = Number(options.maxStaleMs || DEFAULT_MAX_STALE_MS);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const concurrency = Number(options.concurrency || DEFAULT_CONCURRENCY);
  const failureThreshold = Number(options.breakerFailureThreshold || DEFAULT_BREAKER_FAILURE_THRESHOLD);
  const breakerCooldownMs = Number(options.breakerCooldownMs || DEFAULT_BREAKER_COOLDOWN_MS);
  const cache = new Map();
  const inFlight = new Map();
  let consecutiveFailures = 0;
  let breakerOpenUntil = 0;

  if (options.seedCache && isIsoDate(options.seedCache.operationalDate)) {
    cache.set(options.seedCache.operationalDate, options.seedCache);
  }

  async function refresh(operationalDate) {
    const nowMs = Number(now());
    const observedAt = new Date(nowMs).toISOString();
    const occurrences = readOccurrences(repositoryRoot, operationalDate);
    const routeIds = [...new Set(occurrences.map(item => item.routeId).filter(routeId => SAFE_ROUTE_ID.test(routeId)))];
    const routePairs = await mapWithConcurrency(routeIds, concurrency, async routeId => {
      try {
        return [routeId, await fetchRouteStops(routeId, {fetchImpl, timeoutMs})];
      } catch (error) {
        return [routeId, {error: clean(error && error.message) || "route_unavailable", rows: []}];
      }
    });
    const routeResults = new Map(routePairs);
    const records = occurrences.map(occurrence => SAFE_ROUTE_ID.test(occurrence.routeId)
      ? bindOccurrenceToStops(occurrence, routeResults.get(occurrence.routeId), observedAt)
      : unavailableRecord(occurrence, "invalid_route_id", observedAt));
    const routeFailures = routePairs.filter(([, value]) => value.error).length;
    const upstreamHealthy = routeIds.length === 0 || routeFailures < routeIds.length;
    if (upstreamHealthy) {
      consecutiveFailures = 0;
      breakerOpenUntil = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) breakerOpenUntil = nowMs + breakerCooldownMs;
    }
    return {
      ok: true,
      contract: "sde-tursatt-live-arrivals-v1",
      operationalDate,
      generatedAt: observedAt,
      expiresAt: new Date(nowMs + cacheTtlMs).toISOString(),
      cache: "miss",
      upstreamHealthy,
      writePerformed: false,
      records
    };
  }

  async function getByOperationalDate(rawDate) {
    const operationalDate = clean(rawDate);
    if (!isIsoDate(operationalDate)) throw new Error("invalid_operational_date");
    const nowMs = Number(now());
    const previous = cache.get(operationalDate) || null;
    const previousGeneratedMs = previous ? Date.parse(previous.generatedAt) : Number.NaN;
    if (previous && Number.isFinite(previousGeneratedMs) && nowMs - previousGeneratedMs <= cacheTtlMs) {
      return {...previous, cache: "fresh-hit"};
    }
    if (breakerOpenUntil > nowMs) {
      if (previous && Number.isFinite(previousGeneratedMs) && nowMs - previousGeneratedMs <= maxStaleMs) return staleResponse(previous, nowMs);
      const occurrences = readOccurrences(repositoryRoot, operationalDate);
      return {
        ok: true,
        contract: "sde-tursatt-live-arrivals-v1",
        operationalDate,
        generatedAt: new Date(nowMs).toISOString(),
        cache: "breaker-open",
        upstreamHealthy: false,
        writePerformed: false,
        records: occurrences.map(item => unavailableRecord(item, "circuit_breaker_open", new Date(nowMs).toISOString()))
      };
    }
    if (inFlight.has(operationalDate)) return inFlight.get(operationalDate);
    const promise = refresh(operationalDate).then(result => {
      if (!result.upstreamHealthy && previous && Number.isFinite(previousGeneratedMs) && nowMs - previousGeneratedMs <= maxStaleMs) {
        return staleResponse(previous, nowMs);
      }
      cache.set(operationalDate, result);
      return result;
    }).finally(() => inFlight.delete(operationalDate));
    inFlight.set(operationalDate, promise);
    return promise;
  }

  return Object.freeze({getByOperationalDate});
}

function createTursattLiveArrivalHandler(service) {
  return async function tursattLiveArrivalHandler(req, res) {
    try {
      const payload = await service.getByOperationalDate(req.query && req.query.date);
      res.set("Cache-Control", "no-store");
      return res.status(200).json(payload);
    } catch (error) {
      const code = clean(error && error.message);
      const status = code === "invalid_operational_date" ? 400 : code === "operational_date_not_available" ? 404 : 503;
      return res.status(status).json({ok: false, error: code || "live_arrivals_unavailable", writePerformed: false});
    }
  };
}

module.exports = {
  BALISE_STOPS_ORIGIN,
  BALISE_STOPS_PATH,
  buildStopsUrl,
  createTursattLiveArrivalHandler,
  createTursattLiveArrivalService,
  normalizeOccurrence
};
