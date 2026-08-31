"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");
const serverSource = fs.readFileSync(path.resolve(__dirname, "../../../server/src/index.js"), "utf8");
const lifecycleSource = fs.readFileSync(
  path.resolve(__dirname, "../../../server/src/vehicleStatusLifecycle.js"),
  "utf8"
);
const authSource = fs.readFileSync(
  path.resolve(__dirname, "../../../server/src/runtimeAuthorization.js"),
  "utf8"
);

function extractFunction(text, name) {
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `missing production function ${name}`);
  const signatureEnd = text.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing production body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed production function ${name}`);
}

assert.doesNotMatch(
  source,
  /data-drops-action=["']ready["']/,
  "DROPS UI must not expose a ready/Driftsklar action"
);
assert.doesNotMatch(
  source,
  /Bekreft driftsklart/,
  "DROPS must not offer a button that grants Driftsklar"
);
assert.doesNotMatch(
  extractFunction(source, "getSdePhysicalAvailabilityForVehicle"),
  /dropsOrder\?\.driftsklarAt/,
  "local DROPS driftsklarAt must not unblock traffic assessment"
);
assert.match(
  extractFunction(source, "getSdePhysicalAvailabilityForVehicle"),
  /isWorkshopReportedDriftsklar/,
  "traffic unblocking of Ikke driftsklar must require workshop-reported Driftsklar"
);
assert.match(
  extractFunction(source, "getSdePhysicalAvailabilityForVehicle"),
  /DROPS kan ikke gi status Driftsklar/,
  "availability copy must state that DROPS cannot grant Driftsklar"
);
assert.match(
  extractFunction(source, "isWorkshopReportedDriftsklar"),
  /explicitStatus === true/,
  "workshop Driftsklar must be an explicit server registration, not default semantics"
);
assert.match(
  extractFunction(source, "getDropsOrderStatus"),
  /isAuthoritativeIkkeDriftsklar/,
  "DROPS order pills must keep Ikke driftsklar until workshop reports Driftsklar"
);
assert.doesNotMatch(
  extractFunction(source, "getDropsOrderStatus"),
  /order\?\.driftsklarAt/,
  "DROPS order status must not treat a local DROPS timestamp as Driftsklar"
);
assert.doesNotMatch(
  extractFunction(source, "initDropsPanels"),
  /action === "ready"/,
  "DROPS click handler must not write driftsklarAt"
);
assert.match(
  source,
  /Bare verksted kan sette Driftsklar/,
  "DROPS surface must state that only workshop can set Driftsklar"
);
assert.match(
  extractFunction(source, "getWorkshopReportOperationalReadiness"),
  /workshopAuthority/,
  "Meld Driftsklart remains a workshop-authority action"
);
assert.match(
  serverSource,
  /reportOperationalCommandAvailable/,
  "server still exposes report-operational only through capability gating"
);
assert.match(
  lifecycleSource,
  /REPORT_OPERATIONAL/,
  "canonical lifecycle still owns report-operational"
);
assert.match(
  authSource,
  /ROLE_KEYS\.VERKSTED/,
  "runtime authorization still names the workshop role"
);

const context = { console };
vm.createContext(context);
vm.runInContext(
  [
    extractFunction(source, "getDropsVehicleStatusRecord"),
    extractFunction(source, "getAuthoritativeVehicleStatusPresentation"),
    extractFunction(source, "isAuthoritativeIkkeDriftsklar"),
    extractFunction(source, "isWorkshopReportedDriftsklar"),
  ].join("\n") + `
    this.api = {
      isAuthoritativeIkkeDriftsklar,
      isWorkshopReportedDriftsklar,
      getAuthoritativeVehicleStatusPresentation
    };
  `,
  context
);

const ikkeDriftsklarReadback = {
  items: [{
    vehicleId: "74-21",
    currentStatus: "IKKE_DRIFTSKLAR",
    registeredAt: "2026-08-31T08:00:00.000Z",
    workshopDisposition: "TIL_REP",
    activeFaults: []
  }]
};
assert.equal(context.api.isAuthoritativeIkkeDriftsklar("74-21", ikkeDriftsklarReadback), true);
assert.equal(context.api.isWorkshopReportedDriftsklar("74-21", ikkeDriftsklarReadback), false);

const workshopDriftsklarReadback = {
  items: [{
    vehicleId: "74-21",
    currentStatus: "DRIFTSKLAR",
    operationalAt: "2026-08-31T10:00:00.000Z",
    workshopDisposition: "NONE",
    activeFaults: []
  }]
};
assert.equal(context.api.isAuthoritativeIkkeDriftsklar("74-21", workshopDriftsklarReadback), false);
assert.equal(context.api.isWorkshopReportedDriftsklar("74-21", workshopDriftsklarReadback), true);

assert.equal(context.api.isWorkshopReportedDriftsklar("74-19", {items: []}), false,
  "missing status must stay default Driftsklar without counting as a workshop grant");

console.log(JSON.stringify({
  schemaVersion: "sde-drops-cannot-grant-driftsklar-harness-v1",
  status: "PASS",
  workshopOnlyDriftsklar: true,
  dropsReadyActionRemoved: true
}));
