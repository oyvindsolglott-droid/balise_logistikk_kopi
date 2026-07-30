"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = process.argv[2] || path.resolve(__dirname, "../../../index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const central = extractFunction("getAuthoritativeVehicleStatusPresentation");
assert.match(central, /effectiveStatus/, "central presentation must expose one effective status");
assert.match(central, /DRIFTSKLAR/, "missing status must retain default Driftsklar semantics");
assert.match(central, /IKKE_DRIFTSKLAR/, "explicit not-operational status must remain distinct");
assert.match(central, /workshopDisposition/, "disposition must remain independent of operational status");
assert.match(central, /activeFaults/, "active faults must remain independent of operational status");

const workshop = extractFunction("getWorkshopHallOverviewStatus");
assert.match(
  workshop,
  /getAuthoritativeVehicleStatusPresentation\(readback,cleanVehicleId\)/,
  "Workshop must consume the same authoritative status presentation as Sporplan and DROPS",
);
assert.doesNotMatch(
  workshop,
  /fallbackRecord|fallbackKind|currentStatus\s*===/,
  "Workshop must not maintain a parallel fallback status model",
);

const renderer = extractFunction("renderSporplanVehicleStatusPresentation");
for (const token of [
  "sporplan-status-operational",
  "sporplan-status-not-operational",
  "classList.remove",
  "classList.add",
  "aria-label",
  "title",
  "buildSporplanVehicleStatusBadgesHtml",
]) {
  assert.ok(renderer.includes(token), `Sporplan readback renderer is missing ${token}`);
}
assert.match(
  renderer,
  /getAuthoritativeVehicleStatusPresentation/,
  "Sporplan readback renderer must use the central status presentation",
);

const refresh = extractFunction("refreshVehicleStatusReadback");
assert.match(
  refresh,
  /renderSporplanVehicleStatusPresentation\(\)/,
  "every fresh vehicle-status readback must update the complete Sporplan status presentation",
);

const sporplanBuilder = extractFunction("buildSporplan");
assert.match(
  sporplanBuilder,
  /getSporplanVehicleStatusFrameClass/,
  "initial Sporplan render must use the same status-frame contract as polling",
);

assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot-bottom\.mat\s*\{[\s\S]{0,500}background:\s*rgba\(0,0,0,\.80\)/,
  "vehicle identity must remain neutral black with white text",
);
assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot\s*\{[\s\S]{0,500}color:\s*#fff/,
  "vehicle identity must remain white regardless of status",
);
assert.match(
  source,
  /\.workshop-hall-overview-slot\.is-selected\s*\{[\s\S]{0,160}outline:\s*3px solid #38bdf8/,
  "selection must remain a separate visual layer",
);

process.stdout.write(JSON.stringify({
  schemaVersion: "sde-status-parity-polling-harness-v1",
  contracts: {
    centralStatusModel: true,
    noWorkshopParallelFallback: true,
    pollingUpdatesCompleteSporplanPresentation: true,
    neutralVehicleIdentity: true,
    selectionIndependent: true,
  },
}) + "\n");
