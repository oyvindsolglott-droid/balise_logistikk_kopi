#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const express = require(path.resolve(__dirname, "../../../server/node_modules/express"));
const { ROLE_KEYS } = require("../../../server/src/identityPolicy");
const {
  COMMAND_ROUTE,
  createReportNotOperationalHandler,
  createVehicleStatusJsonErrorHandler,
} = require("../../../server/src/vehicleStatusReportNotOperational");
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
  let quote = "";
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
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
  "getDropsReportNotOperationalAvailability",
  "createDropsNotOperationalActionId",
  "buildDropsReportNotOperationalPayload",
  "getDropsVehicleStatusRecord",
  "getDropsSubmitErrorMessage",
  "submitDropsNotOperationalDraftWithReadback",
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

function readback(revision = 0, items = []) {
  return {
    ok: true,
    schemaVersion: "vehicle-status-read-model-v1",
    revision,
    writeEnabled: true,
    items,
  };
}

function capabilities(allowed = true, role = "drops") {
  return {
    ok: true,
    roleResolved: true,
    role,
    capabilities: {
      "vehicle_status.report_not_operational": {
        allowed,
        decision: allowed ? "ALLOW" : "DENY",
      },
    },
  };
}

function draft(vehicleId = "74-10") {
  return {
    vehicle: vehicleId,
    faults: [
      { category: "A2", description: "Dørfeil" },
      { category: "A1", description: "Bremsefeil" },
    ],
    preview: { ok: true },
    actionId: null,
  };
}

async function main() {
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities()).available, true);
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities(false)).available, false);
  assert.equal(api.getDropsReportNotOperationalAvailability(readback(), capabilities(true, "admin_pilot")).available, false);
  assert.equal(api.getDropsReportNotOperationalAvailability({ ...readback(), writeEnabled: false }, capabilities()).available, false);

  const actionId = api.createDropsNotOperationalActionId();
  assert.equal(actionId, "11111111-1111-4111-8111-111111111111");
  const payload = JSON.parse(JSON.stringify(api.buildDropsReportNotOperationalPayload(
    { ...draft(), actionId },
    readback(7),
  )));
  assert.deepEqual(Object.keys(payload).sort(), ["actionId", "expectedRevision", "faults", "vehicleId"]);
  assert.equal(payload.expectedRevision, 7);
  assert.deepEqual(payload.faults, [
    { priority: 1, category: "A2", description: "Dørfeil" },
    { priority: 2, category: "A1", description: "Bremsefeil" },
  ]);
  assert.equal(Object.hasOwn(payload, "status"), false);
  assert.equal(Object.hasOwn(payload, "disposition"), false);

  const fixture = await startFixture();
  try {
    const requests = [];
    const dropsFetch = createFetch(fixture.origin, "drops", requests);
    const result = await api.submitDropsNotOperationalDraftWithReadback(
      draft(),
      readback(),
      capabilities(),
      dropsFetch,
      () => actionId,
    );
    assert.equal(result.ok, true);
    assert.equal(result.confirmedByReadback, true);
    assert.equal(result.record.currentStatus, "IKKE_DRIFTSKLAR");
    assert.equal(result.record.registeredAt, "2026-07-23T08:09:10.111Z");
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.record.activeFaults)).map(({ priority, category, description }) => ({
        priority,
        category,
        description,
      })),
      payload.faults,
    );
    assert.deepEqual(requests.map((entry) => `${entry.method} ${entry.path}`), [
      "GET /api/vehicle-status",
      `POST ${COMMAND_ROUTE}`,
      "GET /api/vehicle-status",
    ]);
    assert.deepEqual(Object.keys(requests[1].body).sort(), ["actionId", "expectedRevision", "faults", "vehicleId"]);
    assert.equal(requests[1].body.expectedRevision, 0, "POST must use the immediately preceding GET revision");

    const persisted = await dropsFetch("/api/vehicle-status");
    const persistedJson = await persisted.json();
    assert.equal(api.getDropsVehicleStatusRecord(persistedJson, "74-10").currentStatus, "IKKE_DRIFTSKLAR");
    assert.equal(fixture.repository.getStorageSnapshot().counts.records, 1);
    assert.equal(fixture.repository.getStorageSnapshot().counts.events, 1);
    assert.equal(fixture.repository.getStorageSnapshot().counts.idempotency, 1);

    const adminRequests = [];
    const denied = await api.submitDropsNotOperationalDraftWithReadback(
      draft("74-11"),
      persistedJson,
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
      { ...persistedJson, writeEnabled: false },
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
  assert.match(source, /Meld som Ikke Driftsklar/);
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

  console.log(JSON.stringify({
    schemaVersion: "sde-drops-ui-server-readback-harness-v1",
    status: "PASS",
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
    bindings: [{
      bindingId: "drops-test",
      subject: "cf-access|drops",
      role: ROLE_KEYS.DROPS,
      enabled: true,
    }],
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(COMMAND_ROUTE, createReportNotOperationalHandler({
    repository,
    roleBindingsCatalog,
    verifyIdentityRequest: async ({ headers }) => {
      const role = String(headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!role) return { ok: false, status: 401, publicError: "authentication_required" };
      return {
        ok: true,
        identity: {
          authenticated: true,
          identityVerified: true,
          identityKind: "human",
          subject: role === "drops" ? "cf-access|drops" : `cf-access|${role}`,
          identitySource: "cloudflare_access_jwt",
        },
      };
    },
  }));
  app.get("/api/vehicle-status", (_req, res) => {
    res.json({ ok: true, ...repository.getReadModel(), trustedRequestAuthority: null });
  });
  app.use(createVehicleStatusJsonErrorHandler());
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
