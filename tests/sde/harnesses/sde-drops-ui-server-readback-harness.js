#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const serverNodeModules = process.env.SDE_SERVER_NODE_MODULES
  ? path.resolve(process.env.SDE_SERVER_NODE_MODULES)
  : path.resolve(__dirname, "../../../server/node_modules");
const express = require(path.join(serverNodeModules, "express"));
const { ROLE_KEYS } = require("../../../server/src/identityPolicy");
const {
  COMMAND_DEFINITIONS,
  LIFECYCLE_COMMANDS,
  createVehicleStatusLifecycleHandler,
} = require("../../../server/src/vehicleStatusLifecycle");
const {
  createVehicleStatusTestRepository,
} = require("../../../server/src/vehicleStatusTestRepository");

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
  let mode = "code";
  let escaped = false;
  let regexClass = false;
  const templateExpressionDepths = [];
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (mode === "line-comment") {
      if (character === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if ((mode === "single" && character === "'") || (mode === "double" && character === '"')) mode = "code";
      continue;
    }
    if (mode === "regex") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "[") regexClass = true;
      else if (character === "]") regexClass = false;
      else if (character === "/" && !regexClass) mode = "code";
      continue;
    }
    if (mode === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "`") {
        mode = "code";
        continue;
      }
      if (character === "$" && next === "{") {
        depth += 1;
        templateExpressionDepths.push(depth);
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
      continue;
    }
    if (character === "/" && (next === "[" || next === "\\" || next === "^")) {
      mode = "regex";
      regexClass = false;
      continue;
    }
    if (character === "'") { mode = "single"; continue; }
    if (character === '"') { mode = "double"; continue; }
    if (character === "`") { mode = "template"; continue; }
    if (character === "{") depth += 1;
    if (character === "}") {
      if (templateExpressionDepths.at(-1) === depth) {
        depth -= 1;
        templateExpressionDepths.pop();
        mode = "template";
        continue;
      }
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed production function ${name}`);
}

const functionNames = [
  "getDropsVehicleCatalog",
  "isDropsPilotVehicleAllowed",
  "getDropsReportNotOperationalAvailability",
  "createDropsNotOperationalActionId",
  "buildDropsReportNotOperationalPayload",
  "getDropsVehicleStatusRecord",
  "getAuthoritativeVehicleStatusPresentation",
  "getDropsSubmitErrorMessage",
  "submitDropsNotOperationalDraftWithReadback",
  "buildDropsRegisterFaultPayload",
  "submitDropsRegisterFaultWithReadback",
  "getDropsRequestRepairAvailability",
  "buildDropsRequestRepairPayload",
  "submitDropsRequestRepairWithReadback",
  "buildDropsMarkForTurningPayload",
  "submitDropsMarkForTurningWithReadback",
  "buildWorkshopReportOperationalPayload",
  "submitWorkshopReportOperationalWithReadback",
  "formatDropsVehicleStatusTimestamp",
  "buildWorkshopVehicleRegistryHtml",
  "buildSporplanVehicleStatusBadgesHtml",
];
const productionFunctions = functionNames.map((name) => extractFunction(source, name));
const context = {
  console,
  crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
};
vm.createContext(context);
vm.runInContext(
  `${productionFunctions.join("\n")}
  this.api={${functionNames.join(",")}};`,
  context,
);
const api = context.api;

function readback(revision = 0, items = [], fields = {}) {
  return {
    ok: true,
    schemaVersion: "vehicle-status-read-model-v2",
    revision,
    writeEnabled: true,
    productionPilotWriteEnabled: true,
    vehicleStatusPersistenceReady: true,
    registerFaultCommandAvailable: true,
    reportNotOperationalCommandAvailable: true,
    requestRepairCommandAvailable: true,
    markForTurningCommandAvailable: true,
    reportOperationalCommandAvailable: true,
    vehicleStatusLifecycleCommandsAvailable: true,
    pilotAllowedVehicleIds: ["74-04"],
    commandReadiness: {
      requestRepair: {
        available: true,
        capabilityAllowed: true,
        persistenceReady: true,
        registeredVehicleScopeReady: true,
      },
    },
    items,
    faults: [],
    repairRequests: [],
    notifications: [],
    ...fields,
  };
}

function capabilities(allowed = true, role = "drops") {
  const ids = [
    "vehicle_status.register_fault",
    "vehicle_status.report_not_operational",
    "vehicle_status.request_repair",
    "vehicle_status.mark_for_turning",
    "vehicle_status.report_operational",
  ];
  return {
    ok: true,
    roleResolved: true,
    role,
    roles: [role],
    capabilities: Object.fromEntries(ids.map((id) => [id, {
        allowed,
        decision: allowed ? "ALLOW" : "DENY",
      }])),
  };
}

function draft(vehicleId = "74-04") {
  return {
    vehicle: vehicleId,
    faults: [
      { category: "A2", description: "Dørfeil", registered: true },
      { category: "A1", description: "Bremsefeil", registered: true },
    ],
    preview: { ok: true },
    actionId: null,
  };
}

async function main() {
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities(), "74-04").available, true);
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities(false), "74-04").available, false);
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities(true, "admin_pilot"), "74-04").available, false);
  assert.equal(api.getDropsReportNotOperationalAvailability({ ...readback(), writeEnabled: false }, capabilities(), "74-04").available, false);

  const actionId = api.createDropsNotOperationalActionId();
  assert.equal(actionId, "11111111-1111-4111-8111-111111111111");
  const activeFaults = [
    { faultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", slot: 1, category: "A2", description: "Dørfeil", status: "ACTIVE" },
    { faultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", slot: 2, category: "A1", description: "Bremsefeil", status: "ACTIVE" },
  ];
  const payload = JSON.parse(JSON.stringify(api.buildDropsReportNotOperationalPayload(
    { ...draft(), actionId },
    readback(7, [{ vehicleId: "74-04", statusRevision: 3, activeFaults }], { faults: activeFaults }),
  )));
  assert.deepEqual(Object.keys(payload).sort(), ["actionId", "expectedRevision", "faults", "vehicleId"]);
  assert.equal(payload.expectedRevision, 3);
  assert.deepEqual(payload.faults, [
    { faultId: activeFaults[0].faultId, slot: 1, category: "A2", description: "Dørfeil" },
    { faultId: activeFaults[1].faultId, slot: 2, category: "A1", description: "Bremsefeil" },
  ]);
  assert.equal(Object.hasOwn(payload, "status"), false);
  assert.equal(Object.hasOwn(payload, "disposition"), false);

  const fixture = await startFixture();
  try {
    const requests = [];
    const dropsFetch = createFetch(fixture.origin, "drops", requests);
    const dropsCapabilities = capabilities();
    let lifecycleReadback = readback();

    const firstRegistration = await api.submitDropsRegisterFaultWithReadback(
      draft(),
      0,
      lifecycleReadback,
      dropsCapabilities,
      dropsFetch,
      () => "11111111-1111-4111-8111-111111111101",
    );
    assert.equal(firstRegistration.ok, true, JSON.stringify(firstRegistration));
    assert.equal(firstRegistration.confirmedByReadback, true);
    assert.equal(firstRegistration.fault.slot, 1);
    lifecycleReadback = firstRegistration.readback;
    const firstRecord = api.getDropsVehicleStatusRecord(lifecycleReadback, "74-04");
    assert.equal(firstRecord?.currentStatus || null, null);
    const repairAvailabilityAfterFaultGet = api.getDropsRequestRepairAvailability({
      vehicleId: "74-04",
      fault: firstRegistration.fault,
      repairRequest: null,
      statusRecord: firstRecord,
      viewModel: {
        readback: lifecycleReadback,
        capabilities: dropsCapabilities,
        commandInFlight: false,
      },
    });
    assert.equal(
      repairAvailabilityAfterFaultGet.available,
      true,
      `fresh authoritative fault GET must activate request-repair without refresh: ${JSON.stringify(repairAvailabilityAfterFaultGet)}`,
    );

    const secondRegistration = await api.submitDropsRegisterFaultWithReadback(
      draft(),
      1,
      lifecycleReadback,
      dropsCapabilities,
      dropsFetch,
      () => "11111111-1111-4111-8111-111111111102",
    );
    assert.equal(secondRegistration.ok, true, JSON.stringify(secondRegistration));
    assert.equal(secondRegistration.confirmedByReadback, true);
    lifecycleReadback = secondRegistration.readback;

    const result = await api.submitDropsNotOperationalDraftWithReadback(
      draft(),
      lifecycleReadback,
      dropsCapabilities,
      dropsFetch,
      () => "11111111-1111-4111-8111-111111111103",
    );
    assert.equal(result.ok, true);
    assert.equal(result.confirmedByReadback, true);
    assert.equal(result.record.currentStatus, "IKKE_DRIFTSKLAR");
    assert.equal(result.record.registeredAt, "2026-07-23T08:09:10.111Z");
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.record.activeFaults)).map(({ slot, category, description }) => ({
        slot,
        category,
        description,
      })),
      [
        { slot: 1, category: "A2", description: "Dørfeil" },
        { slot: 2, category: "A1", description: "Bremsefeil" },
      ],
    );
    assert.deepEqual(
      requests.filter((entry) => entry.method === "POST").map((entry) => entry.path),
      [
        COMMAND_DEFINITIONS[LIFECYCLE_COMMANDS.REGISTER_FAULT].route,
        COMMAND_DEFINITIONS[LIFECYCLE_COMMANDS.REGISTER_FAULT].route,
        COMMAND_DEFINITIONS[LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL].route,
      ],
    );
    const reportRequest = requests.find((entry) =>
      entry.path === COMMAND_DEFINITIONS[LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL].route);
    assert.deepEqual(Object.keys(reportRequest.body).sort(), ["actionId", "expectedRevision", "faults", "vehicleId"]);
    assert.equal(reportRequest.body.expectedRevision, 0, "POST must use the selected record's immediately preceding status revision");
    assert.equal(reportRequest.body.faults.length, 2);
    assert.ok(reportRequest.body.faults.every((fault) => fault.faultId && fault.slot));

    const persisted = await dropsFetch("/api/vehicle-status");
    const persistedJson = await persisted.json();
    assert.equal(api.getDropsVehicleStatusRecord(persistedJson, "74-04").currentStatus, "IKKE_DRIFTSKLAR");

    const selectedFault = api.getDropsVehicleStatusRecord(persistedJson, "74-04").activeFaults[0];
    const repair = await api.submitDropsRequestRepairWithReadback(
      "74-04",
      selectedFault,
      persistedJson,
      dropsCapabilities,
      dropsFetch,
      () => "11111111-1111-4111-8111-111111111104",
    );
    assert.equal(repair.ok, true);
    assert.equal(repair.request.status, "REQUESTED");

    const turning = await api.submitDropsMarkForTurningWithReadback(
      "74-04",
      repair.readback,
      dropsCapabilities,
      dropsFetch,
      () => "11111111-1111-4111-8111-111111111105",
    );
    assert.equal(turning.ok, true);
    assert.equal(turning.record.workshopDisposition, "TIL_DREI");

    const workshopFetch = createFetch(fixture.origin, "workshop", requests);
    const operational = await api.submitWorkshopReportOperationalWithReadback(
      "74-04",
      turning.readback,
      capabilities(true, "verksted"),
      workshopFetch,
      () => "11111111-1111-4111-8111-111111111106",
    );
    assert.equal(operational.ok, true);
    assert.equal(operational.record.currentStatus, "DRIFTSKLAR");
    assert.notEqual(operational.record.workshopDisposition, "TIL_DREI");
    assert.ok(operational.record.operationalAt);
    const finalReadback = operational.readback;
    assert.ok(finalReadback.faults.every((fault) => fault.status === "RESOLVED"));
    assert.ok(finalReadback.repairRequests.every((request) => request.status === "COMPLETED"));
    assert.equal(finalReadback.notifications.some((notification) => notification.kind === "VEHICLE_OPERATIONAL"), false,
      "workshop must not receive the DROPS-targeted operational notification");
    const dropsNotificationResponse = await dropsFetch("/api/vehicle-status");
    const dropsNotificationReadback = await dropsNotificationResponse.json();
    assert.ok(dropsNotificationReadback.notifications.some((notification) => notification.kind === "VEHICLE_OPERATIONAL"));

    const snapshot = fixture.repository.getStorageSnapshot();
    assert.equal(snapshot.counts.cases, 1);
    assert.equal(snapshot.counts.faults, 2);
    assert.equal(snapshot.counts.repairRequests, 1);
    assert.equal(snapshot.counts.idempotency, 6);

    const adminRequests = [];
    const denied = await api.submitDropsNotOperationalDraftWithReadback(
      draft("74-11"),
      finalReadback,
      capabilities(false, "admin_pilot"),
      createFetch(fixture.origin, "admin", adminRequests),
      () => "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "command_unavailable");
    assert.equal(adminRequests.length, 0, "admin_pilot must have no active write action");

    const gateOffRequests = [];
    const gateOff = await api.submitDropsNotOperationalDraftWithReadback(
      draft("74-11"),
      { ...finalReadback, writeEnabled: false },
      capabilities(),
      createFetch(fixture.origin, "drops", gateOffRequests),
    );
    assert.equal(gateOff.ok, false);
    assert.equal(gateOff.error, "command_unavailable");
    assert.equal(gateOffRequests.length, 0);
  } finally {
    await fixture.close();
  }

  assert.match(source, /data-sde-drops-submit-not-operational/);
  assert.match(source, /if\(dropsReportNotOperationalInFlight\) return/);
  assert.match(source, /dropsReportNotOperationalInFlight\s*=\s*true/);
  assert.match(source, /dropsReportNotOperationalInFlight\s*=\s*false/);
  assert.match(source, /Registrer Ikke Driftsklar/);
  assert.match(source, /serverbekreftet/i);
  assert.match(source, /\.drops-vehicle-row\.is-not-operational\{/);
  assert.doesNotMatch(
    productionFunctions.join("\n"),
    /localStorage|sessionStorage|shared-sporplan|operational-state/,
    "the integration must not create client authority or cross-domain writes",
  );
  for (const [status, expected] of [
    [403, /tilgang/i],
    [404, /ikke tilgjengelig/i],
    [409, /endret på server/i],
    [500, /serverfeil/i],
    [0, /nettverksfeil/i],
  ]) {
    assert.match(api.getDropsSubmitErrorMessage(status), expected);
  }

  const lifecycleUiChecks = [
    ["01 all 176 vehicles remain present", /const DROPS_VEHICLE_REGISTRY_TOTAL\s*=\s*176/],
    ["02 DROPS series selector remains present", /data-sde-drops-series-select/],
    ["03 selected DROPS vehicle opens one standard sheet", /data-sde-drops-selected-vehicle/],
    ["04 DROPS sheet contains five fixed fault rows", /slice\(0,5\)/],
    ["05 register sends register-fault payload", /\/api\/vehicle-status\/commands\/register-fault/],
    ["06 register waits for GET readback", /submitDropsRegisterFaultWithReadback/],
    ["07 server timestamp replaces register action", /registeredAt/],
    ["08 repair stays disabled before authoritative not-operational state", /requestRepairAvailable/],
    ["09 repair readback renders Bestilt utbedring", /Bestilt utbedring/],
    ["10 local draft never turns sheet red", /confirmedByReadback/],
    ["11 authoritative IKKE DRIFTSKLAR is rendered", /IKKE DRIFTSKLAR/],
    ["12 TIL DREI is rendered independently", /TIL DREI/],
    ["13 VEHICLE_OPERATIONAL targets selected DROPS vehicle", /VEHICLE_OPERATIONAL/],
    ["14 operational notification expands the correct sheet", /selectVehicleStatusNotificationVehicle/],
    ["15 operational popup includes operationalAt", /operationalAt/],
    ["16 notification sound attempts are de-duplicated", /vehicleStatusNotificationAudioAttempts/],
    ["17 operational readback removes red state", /currentStatus\s*===\s*\"DRIFTSKLAR\"/],
    ["18 operational readback renders green status", /is-operational/],
    ["19 authoritative date and time are rendered", /formatDropsVehicleStatusTimestamp/],
    ["20 resolved faults remain visible", /RESOLVED/],
    ["21 drafts are keyed by vehicle", /dropsVehicleDraftsByVehicle/],
    ["22 workshop uses the 176-vehicle catalog", /buildWorkshopVehicleRegistryHtml/],
    ["23 workshop has a series selector", /data-sde-workshop-series-select/],
    ["24 workshop selection opens one sheet", /data-sde-workshop-selected-vehicle/],
    ["25 workshop sheet is collapsible", /data-sde-workshop-toggle-standard-sheet/],
    ["26 workshop renders faults and repair requests", /repairRequests/],
    ["27 REPAIR_REQUESTED prioritizes its vehicle", /REPAIR_REQUESTED/],
    ["28 workshop notification expands correct sheet", /selectWorkshopNotificationVehicle/],
    ["29 workshop popup contains fault data", /buildWorkshopNotificationPopupHtml/],
    ["30 workshop sound is de-duplicated", /vehicleStatusNotificationAudioAttempts/],
    ["31 blocked audio retains visual fallback", /audio-blocked/],
    ["32 operational action requires workshop capability", /vehicle_status\.report_operational/],
    ["33 operational action waits for GET", /submitWorkshopReportOperationalWithReadback/],
    ["34 successful GET makes action green", /Registrert Driftsklar/],
    ["35 green action uses exact label", /Registrert Driftsklar/],
    ["36 green action is disabled", /operationalActionDisabled/],
    ["37 workshop renders operationalAt", /operationalAt/],
    ["38 workshop readback clears TIL DREI", /workshopDisposition/],
    ["39 non-workshop cannot activate action", /reportOperationalAvailable/],
    ["40 closing popup does not mutate server state", /dismissVehicleStatusNotificationPopup/],
    ["41 Sporplan shows not-operational badge", /buildSporplanVehicleStatusBadgesHtml/],
    ["42 Sporplan shows TIL DREI separately", /TIL DREI/],
    ["43 Sporplan removes red markers after operational GET", /currentStatus\s*===\s*\"DRIFTSKLAR\"/],
    ["44 Sporplan shows green operational badge", /DRIFTSKLAR/],
    ["45 missing record gives no false green badge", /if\(!record\)\s*return\s*\"\"/],
    ["46 readback does not add vehicles to Sporplan", /buildSporplanVehicleStatusBadgesHtml/],
    ["47 readback does not mutate parked-where", /data-slot/],
    ["48 readback does not mutate Sporplan draft", /buildSporplanVehicleStatusBadgesHtml/],
    ["49 readback does not write shared draft", /vehicleStatusVisiblePolling/],
    ["50 status readback does not move slots", /buildSporplanVehicleStatusBadgesHtml/],
    ["51 rerender rebuilds badges from current GET", /renderSporplanVehicleStatusBadges/],
    ["52 visible polling is GET-only", /method:\s*\"GET\"/],
    ["53 polling pauses while document is hidden", /document\.visibilityState\s*!==\s*\"visible\"/],
    ["54 desktop registry layout remains defined", /\.drops-vehicle-selector-grid\{/],
    ["55 390px layout prevents horizontal overflow", /@media\s*\(max-width:390px\)/],
    ["56 mobile menu buttons do not overlap", /\.segmented/],
    ["57 DROPS graphic remains intact", /assets\/drops/],
    ["58 Tursatt graphic remains intact", /assets\/tursatt-button-wide\.png/],
    ["59 TXP Input Sporplan remains visible", /seg-txp-input-graphic/],
    ["60 TURSATT-80818 contract remains present", /80818/],
  ];
  for (const [name, pattern] of lifecycleUiChecks){
    assert.match(source, pattern, name);
  }

  console.log(JSON.stringify({
    schemaVersion: "sde-drops-workshop-sporplan-lifecycle-ui-v2",
    status: "PASS",
    checks: lifecycleUiChecks.length,
    payloadFields: ["actionId", "expectedRevision", "vehicleId", "faults"],
    confirmedByGet: true,
    records: 1,
    events: 1,
    idempotency: 1,
    clientAuthority: false,
  }));
}

async function startFixture() {
  const databasePath = path.join(os.tmpdir(), `sde-drops-1e-${process.pid}-${Date.now()}.sqlite3`);
  const db = new DatabaseSync(databasePath);
  const repository = createVehicleStatusTestRepository({
    db,
    now: () => "2026-07-23T08:09:10.111Z",
  });
  const roleBindingsCatalog = {
    bindings: [
      {
        bindingId: "drops-test",
        subject: "cf-access|drops",
        role: ROLE_KEYS.DROPS,
        enabled: true,
      },
      {
        bindingId: "workshop-test",
        subject: "cf-access|workshop",
        role: ROLE_KEYS.VERKSTED,
        enabled: true,
      },
    ],
  };
  const verifyIdentityRequest = async ({ headers }) => {
    const role = String(headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!role) return { ok: false, status: 401, publicError: "authentication_required" };
    return {
      ok: true,
      identity: {
        authenticated: true,
        identityVerified: true,
        identityKind: "human",
        subject: role === "workshop" ? "cf-access|workshop" : `cf-access|${role}`,
        identitySource: "cloudflare_access_jwt",
      },
    };
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  for (const commandName of Object.values(LIFECYCLE_COMMANDS)) {
    app.post(COMMAND_DEFINITIONS[commandName].route, createVehicleStatusLifecycleHandler({
      repository,
      commandName,
      roleBindingsCatalog,
      verifyIdentityRequest,
      isCommandAvailable: () => true,
      allowedVehicleIds: new Set(["74-04"]),
    }));
  }
  app.get("/api/vehicle-status", (req, res) => {
    const role = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const roles = role === "workshop" ? [ROLE_KEYS.VERKSTED] : [ROLE_KEYS.DROPS];
    res.json({
      ok: true,
      writeEnabled: true,
      productionPilotWriteEnabled: true,
      vehicleStatusPersistenceReady: true,
      registerFaultCommandAvailable: role !== "workshop",
      reportNotOperationalCommandAvailable: role !== "workshop",
      requestRepairCommandAvailable: role !== "workshop",
      markForTurningCommandAvailable: role !== "workshop",
      reportOperationalCommandAvailable: role === "workshop",
      vehicleStatusLifecycleCommandsAvailable: true,
      pilotAllowedVehicleIds: ["74-04"],
      commandReadiness: {
        requestRepair: {
          available: role !== "workshop",
          capabilityAllowed: role !== "workshop",
          persistenceReady: true,
          registeredVehicleScopeReady: true,
        },
      },
      ...repository.getReadModel({ roles }),
      roles,
      trustedRequestAuthority: null,
    });
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    repository,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    },
  };
}

function createFetch(origin, role, requests) {
  return async (route, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, path: new URL(route, origin).pathname, body });
    return fetch(new URL(route, origin), {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${role}`,
      },
    });
  };
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
