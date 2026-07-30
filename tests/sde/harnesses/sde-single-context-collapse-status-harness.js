#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0,`missing ${name}`);
  const end = source.indexOf("\nfunction ",start + marker.length);
  assert.ok(end > start,`missing boundary for ${name}`);
  return source.slice(start,end);
}

const registry = extractFunction("buildWorkshopVehicleRegistryHtml");
assert.match(registry,/data-sde-workshop-single-context/);
assert.doesNotMatch(registry,/buildWorkshopSlotStatusCardsHtml/);
assert.doesNotMatch(registry,/workshop-slot-status-grid/);

const actionCenter = extractFunction("buildWorkshopActionCenterHtml");
assert.match(actionCenter,/const vehicleId = slotVehicle/);
assert.match(actionCenter,/data-sde-workshop-action-center/);
const overviewClick = extractFunction("handleDropsNotOperationalRegistryClick");
assert.match(
  overviewClick,
  /workshopVehicleRegistrySelectedVehicle\s*=\s*""/,
  "occupied-to-empty must clear selected vehicle state"
);

const diagnostics = extractFunction("renderTursattFlowDiagnostics");
assert.match(diagnostics,/aria-expanded/);
assert.match(diagnostics,/data-sde-toggle-tursatt-flow-diagnostics/);
assert.match(diagnostics,/tursattFlowDiagnosticsExpanded/);
assert.match(source,/let tursattFlowDiagnosticsExpanded = false/);
assert.match(source,/▸/);
assert.match(source,/▾/);

assert.match(
  source,
  /\.vehicle-status-notification-host\s*\{[^}]*pointer-events:none;/s,
  "empty global popup host must not block the page"
);
assert.match(
  source,
  /\.vehicle-status-notification-popup\s*\{[^}]*pointer-events:auto;/s,
  "visible popup must remain interactive"
);

const presentation = extractFunction("getAuthoritativeVehicleStatusPresentation");
for(const token of [
  "disposition",
  "dispositionLabel",
  "dispositionClassName",
  "accessibleLabel",
  "defaultOperational",
  "effectiveStatus",
]){
  assert.ok(presentation.includes(token),`presentation misses ${token}`);
}
const hallStatus = extractFunction("getWorkshopHallOverviewStatus");
assert.doesNotMatch(hallStatus,/return \\{label:"TIL (REP|DREI)"/);
const hall = extractFunction("buildWorkshopHallOverviewHtml");
assert.match(hall,/workshop-hall-overview-disposition/);
const badges = extractFunction("buildSporplanVehicleStatusBadgesHtml");
assert.match(badges,/sporplan-vehicle-disposition/);
assert.doesNotMatch(badges,/DRI Rep LAR/);

console.log(JSON.stringify({
  schemaVersion:"sde-single-context-collapse-status-harness-v1",
  tests:26,
  workshopContextCount:1,
  diagnosticsDefault:"collapsed",
}));
