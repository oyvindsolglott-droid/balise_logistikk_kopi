"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BALISE_STOPS_ORIGIN,
  createTursattLiveArrivalService
} = require("../src/tursattLiveArrivals");

function movement(trainNumber, routeId, stopId, plannedArrival, sourceRevision = "rev-1") {
  const clock = plannedArrival.slice(11, 16);
  return {
    operationalDate: "2026-08-22",
    trainNumber,
    occurrenceId: `2026-08-22|arrival|${trainNumber}|${clock}`,
    routeId,
    stopId,
    stationName: "Skien",
    stationRef: "SKN",
    direction: "arrival",
    plannedArrival,
    sourceRevision
  };
}

function writeFixture(root, arrivals) {
  fs.mkdirSync(path.join(root, "data"), {recursive: true});
  fs.writeFileSync(path.join(root, "data", "api_idag.json"), JSON.stringify({
    ok: true,
    date: "2026-08-22",
    arrivals: Object.fromEntries(arrivals.map(item => [item.trainNumber, {
      time: item.plannedArrival.slice(11, 16),
      movementContext: item
    }]))
  }));
  fs.writeFileSync(path.join(root, "data", "api_imorgen.json"), JSON.stringify({ok: true, date: "2026-08-23", arrivals: {}}));
}

function response(data) {
  return {
    ok: true,
    status: 200,
    headers: {get: name => name.toLowerCase() === "date" ? "Sat, 22 Aug 2026 21:52:30 GMT" : ""},
    async json() { return {data}; }
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sde-live-arrivals-"));
  try {
    const a835 = movement("835", "ROUTE835", "STOP835", "2026-08-22 23:53:00");
    const a837 = movement("837", "ROUTE837", "STOP837", "2026-08-23 00:50:00");
    const invalid = movement("839", "https://evil.example/route", "STOP839", "2026-08-23 01:45:00");
    writeFixture(root, [a835, a837, invalid]);

    const calls = [];
    const fetchImpl = async rawUrl => {
      calls.push(rawUrl);
      const url = new URL(rawUrl);
      assert.equal(url.origin, BALISE_STOPS_ORIGIN);
      assert.equal(url.pathname, "/api/train/stops");
      const route = url.searchParams.get("route");
      if (route === "ROUTE835") return response([{
        stop_id: "STOP835", station_ref: "SKN", station_name: "Skien",
        stop_planned_arrival: "2026-08-22 23:53:00",
        stop_estimated_arrival: "2026-08-22 23:57:00", stop_actual_arrival: null
      }]);
      if (route === "ROUTE837") return response([{
        stop_id: "STOP837", station_ref: "SKN", station_name: "Skien",
        stop_planned_arrival: "2026-08-23 00:50:00",
        stop_estimated_arrival: "2026-08-23 00:52:00", stop_actual_arrival: null
      }]);
      throw new Error(`unexpected route ${route}`);
    };

    let nowMs = Date.parse("2026-08-22T21:53:00.000Z");
    const service = createTursattLiveArrivalService({
      repositoryRoot: root,
      fetchImpl,
      now: () => nowMs,
      cacheTtlMs: 30_000,
      maxStaleMs: 120_000,
      concurrency: 2
    });

    const first = await service.getByOperationalDate("2026-08-22");
    assert.equal(first.ok, true);
    assert.equal(first.writePerformed, false);
    assert.equal(first.records.length, 3);
    assert.equal(calls.length, 2, "invalid route id must not be fetched");
    assert.equal(first.records.find(item => item.trainNumber === "835").delayMinutes, 4);
    assert.equal(first.records.find(item => item.trainNumber === "837").delayMinutes, 2);
    assert.equal(first.records.find(item => item.trainNumber === "839").freshness, "unavailable");

    const second = await service.getByOperationalDate("2026-08-22");
    assert.equal(second.cache, "fresh-hit");
    assert.equal(calls.length, 2, "fresh cache must avoid duplicate Balise requests");

    nowMs += 31_000;
    const degradedService = createTursattLiveArrivalService({
      repositoryRoot: root,
      fetchImpl: async () => { throw new Error("upstream unavailable"); },
      now: () => nowMs,
      cacheTtlMs: 1,
      maxStaleMs: 120_000,
      seedCache: first
    });
    const degraded = await degradedService.getByOperationalDate("2026-08-22");
    assert.equal(degraded.records.filter(item => item.freshness === "stale").length, 2);
    assert.equal(degraded.writePerformed, false);

    await assert.rejects(() => service.getByOperationalDate("22.08.2026"), /invalid_operational_date/);
    process.stdout.write("tursatt live arrivals: PASS\n");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
