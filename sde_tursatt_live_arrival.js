(function initSdeTursattLiveArrival(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SdeTursattLiveArrival = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSdeTursattLiveArrivalApi() {
  "use strict";

  const EXACT_IDENTITY_FIELDS = Object.freeze([
    "operationalDate",
    "trainNumber",
    "stationRef",
    "direction",
    "plannedArrival",
    "routeId",
    "stopId",
    "occurrenceId",
    "sourceRevision"
  ]);
  const DEFAULT_MAX_AGE_MS = 120_000;
  const CLOCK_SKEW_ALLOWANCE_MS = 30_000;

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeIdentity(identity = {}) {
    return {
      operationalDate: clean(identity.operationalDate),
      trainNumber: clean(identity.trainNumber || identity.train).replace(/\s+/g, ""),
      stationRef: clean(identity.stationRef).toUpperCase(),
      direction: clean(identity.direction).toLowerCase(),
      plannedArrival: clean(identity.plannedArrival),
      routeId: clean(identity.routeId),
      stopId: clean(identity.stopId),
      occurrenceId: clean(identity.occurrenceId || identity.sourceOccurrenceId),
      sourceRevision: clean(identity.sourceRevision)
    };
  }

  function buildLiveArrivalKey(identity = {}) {
    const normalized = normalizeIdentity(identity);
    if (EXACT_IDENTITY_FIELDS.some(field => !normalized[field])) return "";
    return `tursatt-live-arrival:${JSON.stringify(EXACT_IDENTITY_FIELDS.map(field => normalized[field]))}`;
  }

  function parseServiceTimestamp(value) {
    const text = clean(value);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "0"] = match;
    const values = [year, month, day, hour, minute, second].map(Number);
    if (values[1] < 1 || values[1] > 12 || values[2] < 1 || values[2] > 31 || values[3] > 23 || values[4] > 59 || values[5] > 59) return null;
    return Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5]);
  }

  function clockText(value) {
    const text = clean(value);
    const match = text.match(/(?:^|[ T])(\d{2}):(\d{2})(?::\d{2})?(?:$|[+-])/);
    if (match) return `${match[1]}:${match[2]}`;
    const clock = text.match(/^(\d{1,2}):(\d{2})/);
    return clock ? `${clock[1].padStart(2, "0")}:${clock[2]}` : text;
  }

  function plannedOnly(identity, status, detail = "") {
    const normalized = normalizeIdentity(identity);
    const plannedText = clockText(normalized.plannedArrival);
    return {
      plannedText,
      suffixText: "",
      delayMinutes: null,
      delaySource: "",
      tone: "planned-only",
      status,
      detail,
      ariaLabel: plannedText ? `Planlagt ankomst ${plannedText}` : "Planlagt ankomst ukjent"
    };
  }

  function exactIdentityMatches(expected, actual) {
    const left = normalizeIdentity(expected);
    const right = normalizeIdentity(actual);
    return EXACT_IDENTITY_FIELDS.every(field => left[field] && left[field] === right[field]);
  }

  function resolveLiveArrivalPresentation(identity = {}, record = null, options = {}) {
    const expected = normalizeIdentity(identity);
    const base = plannedOnly(expected, "PLANNED_ONLY");
    if (!buildLiveArrivalKey(expected)) return plannedOnly(expected, "INVALID_IDENTITY");
    if (!record || typeof record !== "object") return plannedOnly(expected, "UNAVAILABLE");
    if (!exactIdentityMatches(expected, record)) return plannedOnly(expected, "IDENTITY_MISMATCH");

    const freshness = clean(record.freshness).toLowerCase();
    if (freshness !== "fresh") return plannedOnly(expected, freshness === "stale" ? "STALE" : "UNAVAILABLE");

    const nowMs = options.now == null ? Date.now() : new Date(options.now).getTime();
    const observedAtMs = new Date(record.observedAt).getTime();
    const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
    if (!Number.isFinite(nowMs) || !Number.isFinite(observedAtMs)) return plannedOnly(expected, "INVALID_OBSERVATION_TIME");
    if (observedAtMs - nowMs > CLOCK_SKEW_ALLOWANCE_MS) return plannedOnly(expected, "FUTURE_OBSERVATION");
    if (nowMs - observedAtMs > maxAgeMs) return plannedOnly(expected, "STALE");

    const plannedMs = parseServiceTimestamp(expected.plannedArrival);
    const actualMs = parseServiceTimestamp(record.actualArrival);
    const estimatedMs = parseServiceTimestamp(record.estimatedArrival);
    const effectiveMs = actualMs == null ? estimatedMs : actualMs;
    if (plannedMs == null || effectiveMs == null) return plannedOnly(expected, "INVALID_LIVE_TIME");

    const delayMinutes = Math.round((effectiveMs - plannedMs) / 60_000);
    if (!Number.isFinite(delayMinutes)) return base;
    const suffixText = delayMinutes > 0 ? `+${delayMinutes}` : "";
    const tone = delayMinutes >= 4 ? "long-delay" : delayMinutes > 0 ? "short-delay" : "on-time";
    const delaySource = clean(record.delaySource) || (actualMs == null ? "estimated_arrival_at_skien" : "actual_arrival_at_skien");
    const liveDescription = delayMinutes > 0 ? `${delayMinutes} minutter forsinket` : delayMinutes < 0 ? `${Math.abs(delayMinutes)} minutter før plan` : "i rute";

    return {
      plannedText: base.plannedText,
      suffixText,
      delayMinutes,
      delaySource,
      tone,
      status: "LIVE",
      detail: liveDescription,
      ariaLabel: `Planlagt ankomst ${base.plannedText}, ${liveDescription}`
    };
  }

  return Object.freeze({
    CLOCK_SKEW_ALLOWANCE_MS,
    DEFAULT_MAX_AGE_MS,
    EXACT_IDENTITY_FIELDS,
    buildLiveArrivalKey,
    exactIdentityMatches,
    normalizeIdentity,
    parseServiceTimestamp,
    resolveLiveArrivalPresentation
  });
});
