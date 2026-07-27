"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");
const vehicleRegistryTotalMatch = source.match(/const DROPS_VEHICLE_REGISTRY_TOTAL\s*=\s*(\d+)\s*;/);
assert.ok(vehicleRegistryTotalMatch, "missing production vehicle registry total");

const expectedCatalog = Object.freeze({
  "69": Object.freeze([
    "69-38", "69-39", "69-40", "69-42", "69-45", "69-46", "69-47", "69-49",
    "69-55", "69-58", "69-61", "69-63", "69-64", "69-67", "69-69", "69-72",
    "69-73", "69-74", "69-75", "69-76", "69-77", "69-78", "69-79", "69-80",
    "69-81", "69-82", "69-83", "69-84", "69-85", "69-86", "69-87", "69-88",
  ]),
  "70": Object.freeze(["70-02", "70-04", "70-05", "70-06", "70-10", "70-11", "70-12", "70-14"]),
  "74": Object.freeze([
    "74-01", "74-02", "74-03", "74-04", "74-06", "74-07", "74-08", "74-09",
    "74-10", "74-11", "74-12", "74-13", "74-14", "74-15", "74-16", "74-17",
    "74-18", "74-19", "74-20", "74-21", "74-22", "74-23", "74-24", "74-25",
    "74-26", "74-27", "74-28", "74-29", "74-30", "74-31", "74-32", "74-33",
    "74-34", "74-35", "74-36", "74-37", "74-38", "74-39", "74-40", "74-41",
    "74-42", "74-43", "74-44", "74-45", "74-46", "74-47", "74-48", "74-49",
    "74-50", "74-51", "74-52", "74-53", "74-54",
  ]),
  "75": Object.freeze(Array.from({ length: 83 }, (_unused, index) => `75-${String(index + 1).padStart(2, "0")}`)),
});

function extractFunction(text, name) {
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `missing production function ${name}`);
  const nextTopLevelFunction = text.indexOf("\nfunction ", start + marker.length);
  assert.ok(nextTopLevelFunction > start, `missing production boundary for ${name}`);
  return text.slice(start, nextTopLevelFunction);
}

const functionNames = [
  "getDropsVehicleCatalog",
  "getDropsNotOperationalFaultCategories",
  "createDropsNotOperationalEditorDraft",
  "updateDropsNotOperationalFault",
  "validateDropsNotOperationalDraft",
  "registerDropsNotOperationalFault",
  "buildDropsNotOperationalPreview",
  "buildDropsReportNotOperationalPayload",
  "isDropsPilotVehicleAllowed",
  "getDropsVehicleStatusRecord",
  "getDropsRegisterFaultAvailability",
  "getAuthoritativeVehicleStatusPresentation",
  "formatDropsVehicleStatusTimestamp",
  "formatDropsVehicleStatusDuration",
  "buildVehicleStatusFaultTimingHtml",
  "hasDropsUnsavedDraft",
  "shouldConfirmDropsVehicleSelectionChange",
  "buildDropsNotOperationalEditorHtml",
  "isDropsVehicleRegistryVisibleForAccessLevel",
  "buildVehicleStatusAudioControlHtml",
  "buildDropsVehicleRegistryHtml",
  "buildWorkshopVehicleRegistryHtml",
];
const productionFunctions = functionNames.map((name) => extractFunction(source, name));
const productionSurface = productionFunctions.join("\n");

for (const forbidden of [
  "localStorage.",
  "sessionStorage.",
  "XMLHttpRequest",
  "saveDropsVerkstedOrders(",
  "scheduleSdeRebuild(",
  "/api/stadler",
  "stadler.example",
]) assert.equal(productionSurface.includes(forbidden), false, `standard sheet contains forbidden authority or fake integration: ${forbidden}`);

const context = {
  console,
  Date,
  DROPS_VEHICLE_REGISTRY_TOTAL: Number(vehicleRegistryTotalMatch[1]),
  vehicleStatusNotificationAudioEnabled: false,
  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },
  getWorkshopExitRequestAvailability() {
    return {
      available: false,
      activeRequest: null,
      sourceSlot: "",
      ariaDisabled: "true",
    };
  },
};
vm.createContext(context);
vm.runInContext(`${productionFunctions.join("\n")}\nthis.api={${functionNames.join(",")}};`, context);
const api = context.api;

const catalog = JSON.parse(JSON.stringify(api.getDropsVehicleCatalog()));
assert.deepEqual(catalog, JSON.parse(JSON.stringify(expectedCatalog)));
assert.deepEqual(Object.keys(catalog), ["69", "70", "74", "75"]);
const allVehicles = Object.values(catalog).flat();
assert.deepEqual(
  Object.fromEntries(Object.entries(catalog).map(([series, vehicles]) => [series, vehicles.length])),
  { "69": 32, "70": 8, "74": 53, "75": 83 },
);
assert.equal(allVehicles.length, 176);
assert.equal(new Set(allVehicles).size, 176);
assert.equal(allVehicles.includes("74-05"), false);

for (const [series, vehicles] of Object.entries(catalog)) {
  const numbers = vehicles.map((vehicle) => Number(vehicle.split("-")[1]));
  assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), `${series} must be numerically ascending`);
}

assert.equal(api.isDropsVehicleRegistryVisibleForAccessLevel("1"), true);
for (const level of ["0", "2", "3", "4", "5", ""]) {
  assert.equal(api.isDropsVehicleRegistryVisibleForAccessLevel(level), false);
}

const emptyHtml = api.buildDropsVehicleRegistryHtml("", "", null, {});
assert.match(emptyHtml, /data-sde-drops-series-select/);
assert.match(emptyHtml, /data-sde-drops-vehicle-select/);
assert.equal((emptyHtml.match(/<option value="(?:69|70|74|75)"/g) || []).length, 4);
assert.match(emptyHtml, /176 kjøretøy/);
assert.doesNotMatch(emptyHtml, /data-sde-drops-vehicle-toggle|data-sde-drops-vehicle-list|data-sde-drops-vehicle-status-action/);
assert.doesNotMatch(emptyHtml, /data-sde-drops-not-operational-editor=/);

const seriesHtml = api.buildDropsVehicleRegistryHtml("74", "", null, {});
assert.match(seriesHtml, /data-sde-drops-series-select[^>]*>[\s\S]*?<option value="74" selected/);
assert.equal((seriesHtml.match(/<option value="74-\d+"/g) || []).length, 53);
assert.doesNotMatch(seriesHtml, /data-sde-drops-not-operational-editor=/);

let vehicleADraft = api.createDropsNotOperationalEditorDraft("74-10");
assert.equal(vehicleADraft.vehicle, "74-10");
assert.equal(vehicleADraft.faults.length, 5, "the standard sheet must always start with five fixed rows");
assert.deepEqual(
  JSON.parse(JSON.stringify(vehicleADraft.faults.map((fault) => ({
    category: fault.category,
    description: fault.description,
    registered: fault.registered,
  })))),
  Array.from({ length: 5 }, () => ({ category: "", description: "", registered: false })),
);

vehicleADraft = api.updateDropsNotOperationalFault(vehicleADraft, 0, "category", "A2");
vehicleADraft = api.updateDropsNotOperationalFault(vehicleADraft, 0, "description", "  Dørfeil behold mellomrom  ");
const attemptedEmptyRegistration = JSON.parse(JSON.stringify(api.registerDropsNotOperationalFault(vehicleADraft, 1, () => new Date("2026-07-23T10:11:12.000Z"))));
assert.equal(attemptedEmptyRegistration.faults[1].registered, false);
assert.match(attemptedEmptyRegistration.errors[0].message, /både feiltype og beskrivelse/i);

vehicleADraft = api.registerDropsNotOperationalFault(vehicleADraft, 0, () => new Date("2026-07-23T10:11:12.000Z"));
assert.equal(vehicleADraft.faults[0].registered, true);
assert.equal(vehicleADraft.faults[0].registeredAt, "2026-07-23T10:11:12.000Z");
assert.equal(vehicleADraft.faults[0].description, "  Dørfeil behold mellomrom  ");
assert.equal(api.hasDropsUnsavedDraft(vehicleADraft), true);
assert.equal(api.shouldConfirmDropsVehicleSelectionChange(vehicleADraft, "74-11"), true);
assert.equal(api.shouldConfirmDropsVehicleSelectionChange(vehicleADraft, "74-10"), false);

const preview = JSON.parse(JSON.stringify(api.buildDropsNotOperationalPreview(vehicleADraft)));
assert.equal(preview.ok, true);
assert.equal(preview.notSaved, true);
assert.equal(preview.vehicle, "74-10");
assert.equal(preview.faults.length, 1);
assert.deepEqual(preview.faults[0], { priority: 1, category: "A2", description: "  Dørfeil behold mellomrom  " });

const payload = JSON.parse(JSON.stringify(api.buildDropsReportNotOperationalPayload(
  { ...vehicleADraft, actionId: "11111111-1111-4111-8111-111111111111" },
  {
    items: [{
      vehicleId: "74-10",
      statusRevision: 7,
      activeFaults: [{
        faultId: "fault-74-10-1",
        slot: 1,
        category: "A2",
        description: "  Dørfeil behold mellomrom  ",
        status: "ACTIVE",
      }],
    }],
  },
)));
assert.deepEqual(Object.keys(payload).sort(), ["actionId", "expectedRevision", "faults", "vehicleId"]);
assert.equal(payload.expectedRevision, 7);
assert.deepEqual(payload.faults, [{
  faultId: "fault-74-10-1",
  slot: 1,
  category: "A2",
  description: "Dørfeil behold mellomrom",
}]);

const editedAfterRegistration = api.updateDropsNotOperationalFault(vehicleADraft, 0, "description", "Ny tekst");
assert.equal(editedAfterRegistration.faults[0].registered, false, "editing a registered draft row must invalidate its local registration");
assert.equal(editedAfterRegistration.faults[0].registeredAt, "");

const sheetHtml = api.buildDropsVehicleRegistryHtml("74", "74-10", vehicleADraft, {
  availability: { available: false },
  readback: { ok: true, items: [] },
});
assert.equal((sheetHtml.match(/data-sde-drops-not-operational-editor=/g) || []).length, 1);
assert.match(sheetHtml, />Kjøretøy 74-10</);
assert.equal((sheetHtml.match(/data-sde-drops-fault-row="\d+"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-fault-category="\d+"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-fault-description="\d+"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-register-fault="\d+"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-register-fault="\d+"[^>]*\bdisabled\b/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-register-fault="\d+"[^>]*aria-disabled="true"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-order-repair="\d+"/g) || []).length, 5);
assert.equal((sheetHtml.match(/data-sde-drops-order-repair="\d+"[^>]*disabled/g) || []).length, 5);
assert.match(sheetHtml, /Sendes bare for en aktiv, serverregistrert feil/);
assert.doesNotMatch(sheetHtml, /Stadler-integrasjon ikke aktivert/);
assert.match(sheetHtml, /Ikke lagret/);
assert.equal((sheetHtml.match(/data-sde-drops-submit-not-operational/g) || []).length, 1);
assert.match(sheetHtml, /Registrer Ikke Driftsklar/);
assert.match(sheetHtml, /data-sde-drops-submit-not-operational[^>]*disabled/);
assert.doesNotMatch(sheetHtml, /data-sde-drops-vehicle-toggle|data-sde-drops-vehicle-list|data-sde-drops-vehicle-status-action/);

const authoritativeHtml = api.buildDropsVehicleRegistryHtml("74", "74-10", vehicleADraft, {
  availability: { available: true },
  readback: {
    ok: true,
    items: [{
      vehicleId: "74-10",
      currentStatus: "IKKE_DRIFTSKLAR",
      registeredAt: "2026-07-23T10:11:12.000Z",
      activeFaults: [{ priority: 1, category: "A2", description: "Dørfeil" }],
    }],
  },
});
assert.match(authoritativeHtml, /data-sde-drops-authoritative-status="74-10"/);
assert.match(authoritativeHtml, /IKKE DRIFTSKLAR/);
assert.match(authoritativeHtml, /Dørfeil/);
assert.match(authoritativeHtml, /data-sde-drops-submit-not-operational/);
assert.match(authoritativeHtml, /data-sde-drops-not-operational-editor=/);

const operationalReadback = {
  ok: true,
  writeEnabled: true,
  productionPilotWriteEnabled: true,
  registerFaultCommandAvailable: true,
  reportNotOperationalCommandAvailable: true,
  vehicleStatusLifecycleCommandsAvailable: true,
  pilotAllowedVehicleIds: ["74-10"],
  items: [{
    vehicleId: "74-10",
    currentStatus: "DRIFTSKLAR",
    operationalAt: "2026-07-24T08:09:10.000Z",
    caseRevision: 4,
    statusRevision: 3,
    activeFaults: [],
  }],
  faults: [{
    vehicleId: "74-10",
    faultId: "fault-resolved",
    slot: 1,
    category: "A2",
    description: "Løst dørproblem",
    status: "RESOLVED",
    registeredAt: "2026-07-23T23:57:10.000Z",
    resolvedAt: "2026-07-24T08:09:10.000Z",
  }],
  repairRequests: [{
    vehicleId: "74-10",
    faultId: "fault-resolved",
    status: "COMPLETED",
  }],
};
const operationalHtml = api.buildDropsVehicleRegistryHtml("74", "74-10", vehicleADraft, {
  availability: { available: true },
  readback: operationalReadback,
  capabilities: {
    ok: true,
    roleResolved: true,
    roles: ["drops"],
    capabilities: {
      "vehicle_status.register_fault": { allowed: true, decision: "ALLOW" },
      "vehicle_status.report_not_operational": { allowed: true, decision: "ALLOW" },
      "vehicle_status.request_repair": { allowed: true, decision: "ALLOW" },
      "vehicle_status.mark_for_turning": { allowed: true, decision: "ALLOW" },
    },
  },
});
assert.match(operationalHtml, /drops-vehicle-authoritative-sheet is-operational/);
assert.match(operationalHtml, />DRIFTSKLAR</);
assert.match(operationalHtml, /Registrert Driftsklar/);
assert.match(operationalHtml, /Løst dørproblem/);
assert.match(operationalHtml, /data-sde-drops-not-operational-editor="74-10"/);
assert.equal((operationalHtml.match(/data-sde-drops-fault-row="\d+"/g) || []).length, 5);
assert.equal((operationalHtml.match(/data-sde-drops-register-fault="\d+"/g) || []).length, 5);
assert.match(operationalHtml, /data-sde-drops-register-fault="1" aria-disabled="false"/);
assert.equal(
  (operationalHtml.match(/data-sde-drops-register-fault="[2-5]"[^>]*\bdisabled\b/g) || []).length,
  4,
  "resolved slot 1 must not occupy any active row, while empty draft rows remain disabled",
);
assert.match(operationalHtml, /data-sde-drops-fault-history/);
assert.match(operationalHtml, /Registrert:/);
assert.match(operationalHtml, /Utbedret:/);
assert.match(operationalHtml, /Tid fra innmelding til utbedring: 8 t 12 min/);
assert.doesNotMatch(operationalHtml, /data-sde-drops-mark-for-turning/);

const workshopOperationalHtml = api.buildWorkshopVehicleRegistryHtml("74", "74-10", operationalReadback, {});
assert.match(workshopOperationalHtml, /workshop-vehicle-status is-operational/);
assert.match(workshopOperationalHtml, /data-sde-workshop-report-operational[^>]*disabled[^>]*aria-disabled="true"/);
assert.match(workshopOperationalHtml, />Registrert Driftsklar</);
assert.match(workshopOperationalHtml, /data-sde-workshop-fault-history/);
assert.match(workshopOperationalHtml, /Registrert:/);
assert.match(workshopOperationalHtml, /Utbedret:/);
assert.match(workshopOperationalHtml, /Tid fra innmelding til utbedring: 8 t 12 min/);

assert.equal(
  api.formatDropsVehicleStatusDuration(
    "2026-07-24T08:00:00.000Z",
    "2026-07-24T08:42:00.000Z",
  ),
  "42 min",
);
assert.equal(
  api.formatDropsVehicleStatusDuration(
    "2026-07-24T08:00:00.000Z",
    "2026-07-24T11:42:00.000Z",
  ),
  "3 t 42 min",
);
assert.equal(
  api.formatDropsVehicleStatusDuration(
    "2026-07-24T08:00:00.000Z",
    "2026-07-25T12:12:00.000Z",
  ),
  "1 d 4 t 12 min",
);
assert.equal(
  api.formatDropsVehicleStatusDuration(
    "2026-10-25T01:30:00+02:00",
    "2026-10-25T02:30:00+01:00",
  ),
  "2 t",
  "DST must not alter the absolute server duration",
);
assert.equal(api.formatDropsVehicleStatusDuration("invalid", "2026-07-24T08:00:00.000Z"), "");
assert.equal(api.formatDropsVehicleStatusDuration("2026-07-24T09:00:00.000Z", "2026-07-24T08:00:00.000Z"), "");
const activeTimingHtml = api.buildVehicleStatusFaultTimingHtml({
  status: "ACTIVE",
  registeredAt: "2026-07-24T08:00:00.000Z",
  resolvedAt: null,
});
assert.match(activeTimingHtml, /Registrert:/);
assert.match(activeTimingHtml, /Pågående/);
assert.doesNotMatch(activeTimingHtml, /Utbedret:|Tid fra innmelding til utbedring:/);

const unknownReadback = {
  ok: true,
  writeEnabled: false,
  vehicleStatusLifecycleCommandsAvailable: false,
  items: [],
  faults: [],
  repairRequests: [],
};
const unknownHtml = api.buildDropsVehicleRegistryHtml("74", "74-10", vehicleADraft, {
  availability: { available: false },
  readback: unknownReadback,
  capabilities: {},
});
assert.match(unknownHtml, /drops-not-operational-editor is-unknown/);
assert.match(unknownHtml, /Ingen autoritativ status registrert/);
assert.doesNotMatch(unknownHtml, /drops-not-operational-editor is-operational|drops-not-operational-editor is-not-operational/);
const workshopUnknownHtml = api.buildWorkshopVehicleRegistryHtml("74", "74-10", unknownReadback, {});
assert.match(workshopUnknownHtml, /workshop-vehicle-status is-unknown/);
assert.match(workshopUnknownHtml, /Ingen autoritativ status registrert/);

const vehicleBDraft = api.createDropsNotOperationalEditorDraft("75-10");
assert.equal(vehicleBDraft.faults.length, 5);
assert.equal(vehicleBDraft.faults.every((fault) => fault.category === "" && fault.description === "" && fault.registered === false), true);

assert.match(source, /@media\(max-width:600px\)\{[\s\S]*?\.drops-not-operational-fault-row\{ grid-template-columns:minmax\(0,1fr\);/);
assert.match(source, /\.drops-vehicle-selector-grid\{[\s\S]*?grid-template-columns:/);
assert.match(source, /\.drops-not-operational-editor\{[\s\S]*?min-width:0;/);
assert.match(source, /window\.confirm\(/, "discarding an unsent draft on vehicle change must require confirmation");
assert.match(source, /id="dropsVehicleRegistry"[^>]*data-sde-drops-vehicle-registry/);
assert.match(source, /renderDropsVehicleRegistry\(\)/);

console.log(JSON.stringify({
  schemaVersion: "sde-drops-standard-sheet-harness-v2",
  status: "PASS",
  groups: { "69": 32, "70": 8, "74": 53, "75": 83 },
  total: 176,
  compactSelectors: true,
  activeSheets: 1,
  fixedFaultRows: 5,
  repairLifecycle: "server-authoritative",
  localDraftAuthority: false,
  confirmedByGet: true,
}));
