"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildLiveArrivalKey,
  resolveLiveArrivalPresentation
} = require(process.env.SDE_TURSATT_LIVE_MODULE
  ? path.resolve(process.env.SDE_TURSATT_LIVE_MODULE)
  : "../../sde_tursatt_live_arrival.js");

const identity = Object.freeze({
  operationalDate: "2026-08-22",
  trainNumber: "835",
  stationRef: "SKN",
  direction: "arrival",
  plannedArrival: "2026-08-22 23:53:00",
  routeId: "ROUTE-835",
  stopId: "STOP-SKIEN-835",
  occurrenceId: "2026-08-22|arrival|835|23:53",
  sourceRevision: "source-revision-1"
});

function record(overrides = {}) {
  return {
    ...identity,
    plannedArrival: identity.plannedArrival,
    estimatedArrival: "2026-08-22 23:54:00",
    actualArrival: "",
    delaySource: "estimated_arrival_at_skien",
    observedAt: "2026-08-22T21:52:30.000Z",
    freshness: "fresh",
    ...overrides
  };
}

function resolve(overrides = {}, now = "2026-08-22T21:53:00.000Z") {
  return resolveLiveArrivalPresentation(identity, record(overrides), {now});
}

test("exact occurrence identity includes date, train, Skien, direction, route, stop and source revision", () => {
  const key = buildLiveArrivalKey(identity);
  assert.match(key, /2026-08-22/);
  assert.match(key, /835/);
  assert.match(key, /SKN/);
  assert.match(key, /arrival/);
  assert.match(key, /ROUTE-835/);
  assert.match(key, /STOP-SKIEN-835/);
  assert.match(key, /source-revision-1/);
});

test("planned arrival remains primary and +1 through +3 are green", () => {
  for (const minute of [1, 2, 3]) {
    const result = resolve({estimatedArrival: `2026-08-22 23:${String(53 + minute).padStart(2, "0")}:00`});
    assert.equal(result.plannedText, "23:53");
    assert.equal(result.suffixText, `+${minute}`);
    assert.equal(result.tone, "short-delay");
    assert.equal(result.status, "LIVE");
  }
});

test("+4 and greater are red while on-time and early have no suffix", () => {
  assert.deepEqual(
    {suffix: resolve({estimatedArrival: "2026-08-22 23:57:00"}).suffixText, tone: resolve({estimatedArrival: "2026-08-22 23:57:00"}).tone},
    {suffix: "+4", tone: "long-delay"}
  );
  assert.equal(resolve({estimatedArrival: identity.plannedArrival}).suffixText, "");
  assert.equal(resolve({estimatedArrival: "2026-08-22 23:50:00"}).suffixText, "");
});

test("actual Skien arrival wins over estimate", () => {
  const result = resolve({
    estimatedArrival: "2026-08-22 23:54:00",
    actualArrival: "2026-08-22 23:59:00",
    delaySource: "actual_arrival_at_skien"
  });
  assert.equal(result.suffixText, "+6");
  assert.equal(result.tone, "long-delay");
  assert.equal(result.delaySource, "actual_arrival_at_skien");
});

test("stale, unavailable and future observations fail closed to planned-only", () => {
  assert.equal(resolve({freshness: "stale"}).suffixText, "");
  assert.equal(resolve({freshness: "unavailable", estimatedArrival: ""}).suffixText, "");
  assert.equal(resolve({observedAt: "2026-08-22T21:54:00.000Z"}).suffixText, "");
});

test("every exact-occurrence mismatch fails closed to planned-only", () => {
  const mismatches = [
    {operationalDate: "2026-08-23"},
    {trainNumber: "837"},
    {stationRef: "POR"},
    {direction: "departure"},
    {plannedArrival: "2026-08-22 23:54:00"},
    {routeId: "OTHER-ROUTE"},
    {stopId: "OTHER-STOP"},
    {occurrenceId: "other-occurrence"},
    {sourceRevision: "other-revision"}
  ];
  for (const mismatch of mismatches) {
    const result = resolve(mismatch);
    assert.equal(result.suffixText, "", JSON.stringify(mismatch));
    assert.equal(result.status, "IDENTITY_MISMATCH", JSON.stringify(mismatch));
  }
});

test("invalid and ambiguous timestamps do not invent delay", () => {
  assert.equal(resolve({estimatedArrival: "not-a-time"}).suffixText, "");
  assert.equal(resolve({actualArrival: "not-a-time", estimatedArrival: ""}).suffixText, "");
  assert.equal(resolve({plannedArrival: ""}).suffixText, "");
});
