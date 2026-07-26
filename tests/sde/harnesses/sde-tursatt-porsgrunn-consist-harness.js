"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/balise_tursatt_porsgrunn_split_2026-07-26.json"),
    "utf8",
  ),
);
const generatorPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "update_static_data.py");
const generator = fs.readFileSync(generatorPath, "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.equal(fixture.operationalDate, "2026-07-26");
assert.equal(fixture.lookupTrainNumber, "80824");
assert.equal(fixture.skienDepartureTime, "15:00");
assert.equal(fixture.routeInfo.routeId, "fixture-route-80824-split");

const rowsAt = station => fixture.vehicleRows
  .filter(row => row.sv_route === fixture.routeInfo.routeId && row.station_name === station)
  .sort((left, right) => left.position - right.position)
  .map(row => row.vehicle)
  .filter((vehicle, index, rows) => rows.indexOf(vehicle) === index);

assert.deepEqual(rowsAt("Skien"), ["74-03", "74-46"]);
assert.deepEqual(rowsAt("Porsgrunn"), ["74-03"]);

for (const token of [
  "vehiclesObservedAtSkien",
  "vehiclesContinuingAtPorsgrunn",
  "departureVehicles",
  "detachedAtSkien",
  "vehicleResolutionSource",
  "vehicleError",
  "porsgrunn_occurrence_subset",
]) {
  assert.ok(generator.includes(token), `generator contract misses ${token}`);
}
assert.match(generator, /extract_route_vehicle_hits\([\s\S]*?"Porsgrunn"/);
assert.match(html, /payload\.departureVehicles \|\| \{\}/);
assert.doesNotMatch(generator, /80824[\s\S]{0,200}74-46/);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-tursatt-porsgrunn-consist-harness-v1",
  operationalDate: fixture.operationalDate,
  trainNumber: fixture.lookupTrainNumber,
  routeId: fixture.routeInfo.routeId,
  skienVehicles: rowsAt("Skien"),
  porsgrunnVehicles: rowsAt("Porsgrunn"),
  expectedDepartureVehicles: ["74-03"],
  expectedDetachedAtSkien: ["74-46"],
  status: "PASS",
})}\n`);
