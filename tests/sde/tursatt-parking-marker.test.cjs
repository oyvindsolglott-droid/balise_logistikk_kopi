"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(process.env.SDE_TURSATT_INDEX || path.join(root, "index.html"), "utf8");

test("Tursatt marker authority is projected from the canonical post-arrival needs", () => {
  assert.match(html, /function refreshTursattPostArrivalParkingMarkers\(/);
  assert.match(html, /const bindings = buildSdeTursattVehicleBindings\(\);/);
  assert.match(html, /const plan = buildSdeTursattPostArrivalShiftNeeds\(bindings\);/);
  assert.match(html, /bindings\.filter\(binding=>binding\?\.role === "arrival"\)/);
  assert.match(html, /need\?\.requiresPostArrivalShunt/);
  assert.match(html, /need\?\.forcedTrainRule/);
  assert.match(html, /if\(!need\?\.requiresPostArrivalShunt \|\| !need\?\.forcedTrainRule\) return;/);
  assert.match(html, /canonicalOccurrencePartKey/);
});

test("actual arrival vehicle cells reuse the established red split/parking style and say PARKERES", () => {
  assert.match(html, /function getTursattPostArrivalParkingMark\(/);
  assert.match(html, /opp-split-remove-cell/);
  assert.match(html, /opp-split-remove-hint/);
  assert.match(html, /hint\.textContent = "PARKERES"/);
  assert.match(html, /side === "arrival"/);
  assert.match(html, /tursattPostArrivalParkingMarkers\.get\(occurrencePartKey\)/);
});

test("parking marker projection contains no train or vehicle hardcoding", () => {
  const start = html.indexOf("function refreshTursattPostArrivalParkingMarkers(");
  const end = html.indexOf("function handleOppstillingVehicleChange(", start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.doesNotMatch(source, /["'](?:835|837|839)["']/);
  assert.doesNotMatch(source, /["'](?:69|70|72|74|75)-\d{2}["']/);
});

test("marker cache refreshes before the canonical Tursatt table is rendered", () => {
  const buildStart = html.indexOf("function buildOppstilling(){");
  const buildEnd = html.indexOf("function slotKind(", buildStart);
  const source = html.slice(buildStart, buildEnd);
  assert.ok(source.indexOf("refreshTursattPostArrivalParkingMarkers()") >= 0);
  assert.ok(source.indexOf("refreshTursattPostArrivalParkingMarkers()") < source.indexOf("createTursattTableFragment(viewModel)"));
});
