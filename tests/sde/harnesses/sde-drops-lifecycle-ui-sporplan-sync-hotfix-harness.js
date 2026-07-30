"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

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

const functionNames = [
  "getDropsVehicleCatalog",
  "getDropsNotOperationalFaultCategories",
  "createDropsNotOperationalEditorDraft",
  "updateDropsNotOperationalFault",
  "buildDropsNotOperationalPreview",
  "getDropsVehicleStatusRecord",
  "getDropsRegisterFaultAvailability",
  "getAuthoritativeVehicleStatusPresentation",
  "computeCanonicalActualPlacementRows",
  "computeCanonicalActualPlacementViewRows",
  "buildCanonicalActualPlacementSlotMap",
  "captureSdeCanonicalActualPlacementSnapshot",
];
const functions = functionNames.map((name) => extractFunction(source, name));
const state = {
  sharedSporplanDraftAppliedRevision: 227,
  grunnoppstilling: {
    "1N": "70-06",
    "5N": "74-12",
    "6S": "69-55",
  },
};
const inputSlots = ["1N", "5N", "6S", "4M"];
const computedRows = [
  { slot: "1N", mat: "74-12" },
  { slot: "5N", mat: "70-06" },
  { slot: "4M", mat: "69-63" },
];

const context = {
  console,
  Date,
  state,
  inputSlots,
  washMachineSlots: [],
  DROPS_VEHICLE_REGISTRY_TOTAL: 176,
  REGISTERED_VEHICLES_SCOPE: "REGISTERED_VEHICLES",
  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },
  normalizeSlot(value) {
    return String(value || "").trim().toUpperCase();
  },
  sanitizeVehicleValue(value) {
    return String(value || "").trim();
  },
  normalizeVehicleToken(value) {
    return String(value || "").trim().toUpperCase();
  },
  normalizeSdeCanonicalToken(value) {
    return String(value || "").trim().toUpperCase();
  },
  splitVehicleList(value) {
    return String(value || "").split(/[,+;\s]+/).filter(Boolean);
  },
  sortSdeCanonicalObjects(value) {
    return [...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  },
  stableStringifySdeCanonicalValue(value) {
    return JSON.stringify(value);
  },
  computeInndata() {
    return computedRows.map((row) => ({ ...row }));
  },
  isSharedSporplanDraftActiveForCommonView() {
    return Number(state.sharedSporplanDraftAppliedRevision) > 0;
  },
  computeSharedSporplanDraftRowsForCommonView() {
    return inputSlots.map((slot) => ({
      slot,
      tog: "",
      mat: state.grunnoppstilling[slot] || "",
      wash: false,
      sharedDraft: true,
    }));
  },
  captureSdeCanonicalPendulumOccurrences() {
    return [];
  },
  getSdeCanonicalRuntimeSnapshotSequenceMinutes() {
    return 720;
  },
  buildSdeCanonicalActualStateReconciliation(input) {
    return {
      actualPlacements: (input.computedActualRows || []).map((row) => ({
        slot: row.slot,
        vehicleId: row.mat,
        supplemented: true,
      })),
      diagnostics: [],
      conflicts: [],
      metadata: { sideEffectPolicy: "pure-shadow-readmodel" },
    };
  },
  cloneSdeCanonicalValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  },
  getSdeNightPlacementLayoutRows() {
    return [["1N", "5N", "6S", "4M"]];
  },
  isSdeNightPlacementOrdinarySlot(value) {
    return Boolean(value);
  },
  haveSameSdeVehicleTokens(left, right) {
    return String(left) === String(right);
  },
};
vm.createContext(context);
vm.runInContext(functions.join("\n") + `\nthis.api={${functionNames.join(",")}};`, context);
const api = context.api;

function capabilities(allowed = true, fields = {}) {
  return {
    ok: true,
    roleResolved: true,
    roles: ["drops"],
    capabilities: {
      "vehicle_status.register_fault": {
        allowed,
        decision: allowed ? "ALLOW" : "DENY",
      },
      "vehicle_status.request_repair": { allowed: false, decision: "DENY" },
      "vehicle_status.mark_for_turning": { allowed: false, decision: "DENY" },
      "vehicle_status.report_operational": { allowed: false, decision: "DENY" },
    },
    ...fields,
  };
}

function readback(items = [], fields = {}) {
  return {
    ok: true,
    writeEnabled: true,
    vehicleStatusLifecycleCommandsAvailable: true,
    productionPilotWriteEnabled: true,
    vehicleStatusPersistenceReady: true,
    vehicleWriteScope: "REGISTERED_VEHICLES",
    commandReadiness: {
      registerFault: {
        available: true,
        capabilityAllowed: true,
        persistenceReady: true,
        registeredVehicleScopeReady: true,
      },
    },
    items,
    faults: [],
    repairRequests: [],
    ...fields,
  };
}

function validDraft(vehicle = "74-04") {
  const draft = api.createDropsNotOperationalEditorDraft(vehicle);
  return api.updateDropsNotOperationalFault(
    api.updateDropsNotOperationalFault(draft, 0, "category", "A2"),
    0,
    "description",
    "Dørfeil",
  );
}

// A — all row actions share one fail-closed availability contract.
const gateOffView = {
  readback: readback([], {
    writeEnabled: false,
    vehicleStatusLifecycleCommandsAvailable: false,
    productionPilotWriteEnabled: false,
  }),
  capabilities: capabilities(),
  commandInFlight: false,
};
const openView = {
  readback: readback([], {
    registerFaultCommandAvailable: true,
  }),
  capabilities: capabilities(),
  commandInFlight: false,
};
assert.equal(api.getDropsRegisterFaultAvailability(validDraft(), 0, openView).available, true);
for (const [label, view] of [
  ["identity", { readback: readback(), capabilities: { ...capabilities(), ok: false }, commandInFlight: false }],
  ["role", { readback: readback(), capabilities: { ...capabilities(), roles: ["verksted"] }, commandInFlight: false }],
  ["capability", { readback: readback(), capabilities: capabilities(false), commandInFlight: false }],
  ["readiness", { readback: readback([], {
    vehicleStatusLifecycleCommandsAvailable: false,
    commandReadiness: {
      registerFault: {
        available: false,
        capabilityAllowed: true,
        persistenceReady: true,
        registeredVehicleScopeReady: true,
      },
    },
  }), capabilities: capabilities(), commandInFlight: false }],
  ["write gate", { readback: readback([], { writeEnabled: false }), capabilities: capabilities(), commandInFlight: false }],
  ["request in flight", { readback: readback(), capabilities: capabilities(), commandInFlight: true }],
]) {
  assert.equal(api.getDropsRegisterFaultAvailability(validDraft(), 0, view).available, false, label);
}
assert.equal(api.getDropsRegisterFaultAvailability(validDraft(), 1, openView).available, false, "empty row");
assert.equal(
  api.getDropsRegisterFaultAvailability(validDraft(), 0, {
    ...openView,
    readback: readback([{ vehicleId: "74-04", currentStatus: "IKKE_DRIFTSKLAR", activeFaults: [
      { faultId: "fault-1", slot: 1, status: "ACTIVE" },
    ] }]),
  }).available,
  false,
  "already registered row",
);
assert.equal(
  api.getDropsRegisterFaultAvailability(validDraft("74-10"), 0, {
    ...openView,
    readback: readback(),
  }).available,
  true,
  "every registered vehicle must use the shared server-authoritative scope",
);
const registerAvailabilitySource = extractFunction(source, "getDropsRegisterFaultAvailability");
assert.doesNotMatch(
  registerAvailabilitySource,
  /pilotAllowedVehicleIds/,
  "register-fault availability must not retain the historical pilot allowlist",
);
assert.match(
  registerAvailabilitySource,
  /registeredVehicleScopeReady/,
  "frontend availability must consume server-computed registered scope readiness",
);

// B — color and truth labels come only from authoritative GET records.
const operationalRecord = {
  vehicleId: "74-04",
  currentStatus: "DRIFTSKLAR",
  operationalAt: "2026-07-24T08:09:10.000Z",
  activeFaults: [],
};
const notOperationalRecord = {
  vehicleId: "74-04",
  currentStatus: "IKKE_DRIFTSKLAR",
  registeredAt: "2026-07-24T07:08:09.000Z",
  workshopDisposition: "TIL_DREI",
  activeFaults: [{ faultId: "fault-1", slot: 1, category: "A2", description: "Dørfeil", status: "ACTIVE" }],
};
const operationalReadback = readback([operationalRecord], {
  faults: [{ vehicleId: "74-04", faultId: "old-1", slot: 1, category: "A1", description: "Løst", status: "RESOLVED" }],
  repairRequests: [{ vehicleId: "74-04", faultId: "old-1", status: "COMPLETED" }],
});
const notOperationalReadback = readback([notOperationalRecord], {
  faults: notOperationalRecord.activeFaults,
});
assert.equal(api.getAuthoritativeVehicleStatusPresentation(readback(), "74-04").kind, "operational");
assert.equal(api.getAuthoritativeVehicleStatusPresentation(operationalReadback, "74-04").kind, "operational");
assert.equal(api.getAuthoritativeVehicleStatusPresentation(notOperationalReadback, "74-04").kind, "not-operational");

const operationalPresentation = api.getAuthoritativeVehicleStatusPresentation(operationalReadback, "74-04");
assert.equal(operationalPresentation.className, "is-operational");
assert.equal(operationalPresentation.label, "DRIFTSKLAR");
assert.equal(operationalPresentation.registrationLabel, "Registrert Driftsklar");
assert.equal(operationalPresentation.timestamp, "2026-07-24T08:09:10.000Z");
assert.equal(operationalPresentation.faults.length, 1);
assert.equal(operationalPresentation.repairRequests.length, 1);
const notOperationalPresentation = api.getAuthoritativeVehicleStatusPresentation(notOperationalReadback, "74-04");
assert.equal(notOperationalPresentation.className, "is-not-operational");
assert.equal(notOperationalPresentation.label, "IKKE DRIFTSKLAR");
assert.equal(notOperationalPresentation.timestamp, "2026-07-24T07:08:09.000Z");
assert.equal(notOperationalPresentation.record.workshopDisposition, "TIL_DREI");
const unknownPresentation = api.getAuthoritativeVehicleStatusPresentation(readback(), "74-04");
assert.match(unknownPresentation.className, /is-operational/);
assert.equal(unknownPresentation.label, "DRIFTSKLAR");
assert.equal(unknownPresentation.effectiveStatus, "DRIFTSKLAR");
assert.equal(unknownPresentation.defaultOperational, true);
assert.equal(unknownPresentation.explicitStatus, false);

// C — Sporplan and SDE must consume the same immutable actual-placement snapshot.
const beforeState = JSON.stringify(state);
const actualSnapshot = api.captureSdeCanonicalActualPlacementSnapshot();
assert.equal(JSON.stringify(state), beforeState, "actual snapshot must not mutate canonical state");
const canonicalMap = JSON.parse(JSON.stringify(api.buildCanonicalActualPlacementSlotMap(actualSnapshot.actualRows)));
assert.equal(canonicalMap["1N"], "70-06");
assert.equal(canonicalMap["5N"], "74-12");
assert.equal(Object.values(canonicalMap).filter((vehicle) => vehicle === "70-06").length, 1);
assert.equal(actualSnapshot.actualSources.find((candidate) => candidate.selected)?.source, "canonical-sporplan-actual");
assert.equal(
  actualSnapshot.actualSources.find((candidate) => candidate.selected)?.rows.find((row) => row.slot === "1N")?.mat,
  "70-06",
);

const graphicalMap = JSON.parse(JSON.stringify(api.buildCanonicalActualPlacementSlotMap(
  actualSnapshot.actualSources.find((candidate) => candidate.selected).rows,
)));
assert.deepEqual(graphicalMap, canonicalMap);
assert.equal(graphicalMap["1N"], "70-06");
assert.notEqual(graphicalMap["1N"], "74-12");
assert.equal(JSON.stringify(state), beforeState, "graphic render read-model must not mutate placement");

for (const forbidden of [
  "localStorage.",
  "sessionStorage.",
  "fetch(",
  "XMLHttpRequest",
  "persist(",
  "scheduleSdeRebuild(",
]) {
  assert.equal(
    [
      extractFunction(source, "computeCanonicalActualPlacementRows"),
      extractFunction(source, "computeCanonicalActualPlacementViewRows"),
      extractFunction(source, "buildCanonicalActualPlacementSlotMap"),
      extractFunction(source, "captureSdeCanonicalActualPlacementSnapshot"),
    ].join("\n").includes(forbidden),
    false,
    `canonical actual placement path contains side effect ${forbidden}`,
  );
}
assert.match(
  extractFunction(source, "captureSdeCanonicalShadowRuntimeSnapshot"),
  /const actualPlacementSnapshot = captureSdeCanonicalActualPlacementSnapshot\(\);[\s\S]*?const data = getSdeShiftShowcaseData\(\);/,
  "actual placement must be captured before SDE plan generation",
);
assert.match(
  extractFunction(source, "buildSporplan"),
  /const dataRows = computeCanonicalActualPlacementViewRows\(\);/,
  "Sporplan must use the shared canonical actual placement view",
);
assert.match(
  extractFunction(source, "buildSdeCanonicalGraphicOverviewData"),
  /reader\.graphicProjection\.actualSlots/,
  "SDE graphical actual layer must consume canonical actual slots",
);

console.log(JSON.stringify({
  schemaVersion: "sde-drops-lifecycle-ui-sporplan-sync-hotfix-v1",
  status: "PASS",
  failClosedRegisterButtons: 5,
  statusKinds: ["operational", "not-operational", "unknown"],
  actualSlotParity: true,
  documentedSlot: canonicalMap["1N"],
  nonMutation: true,
}));
