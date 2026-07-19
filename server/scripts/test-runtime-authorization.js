#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const express = require("express");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  CAPABILITY_CATALOG,
  CAPABILITY_IDS,
  VEHICLE_STATUS_ROLES,
  createRuntimeCapabilitiesHandler,
  evaluateRuntimeAuthorization,
  validateCapabilityCatalog
} = require("../src/runtimeAuthorization");

const SERVER_DIR = path.resolve(__dirname, "..");
const INDEX_FILE = path.join(SERVER_DIR, "src", "index.js");
const AUTH_IDENTITY_FILE = path.join(SERVER_DIR, "src", "accessIdentity.js");
const VEHICLE_READ_MODEL_FILE = path.join(SERVER_DIR, "src", "vehicleStatusReadModel.js");
const TEST_HOST = "127.0.0.1";
const TEST_DB = path.join(os.tmpdir(), `sde-authority-1c-${process.pid}.sqlite3`);
const TEST_LOG = path.join(os.tmpdir(), `sde-authority-1c-${process.pid}.log`);
const EXPECTED_ROLES = Object.freeze([
  ROLE_KEYS.ADMIN_PILOT,
  ROLE_KEYS.AGILA,
  ROLE_KEYS.DROPS,
  ROLE_KEYS.SDE_SKIFTERE,
  ROLE_KEYS.TXP,
  ROLE_KEYS.VERKSTED
]);

let serverProcess = null;
const passed = [];

async function check(name, callback){
  await callback();
  passed.push(name);
}

async function main(){
  const humanIdentity = Object.freeze({
    authenticated: true,
    identityVerified: true,
    identityKind: "human",
    subject: "authority-1c-human",
    email: "must-not-be-projected@example.com"
  });

  await check("01 exact six ROLE_KEYS are reused", () => {
    assert.deepEqual(VEHICLE_STATUS_ROLES, EXPECTED_ROLES);
    assert.equal(VEHICLE_STATUS_ROLES.includes(ROLE_KEYS.VAKTPLAN_LEDELSE), false);
  });

  await check("02 read is allowed for all six roles", () => {
    for(const role of EXPECTED_ROLES){
      assertAllowed(decide(humanIdentity, role, CAPABILITY_IDS.READ));
    }
  });

  await check("03 report not operational is drops only", () => {
    assertOnlyRoleAllowed(humanIdentity, CAPABILITY_IDS.REPORT_NOT_OPERATIONAL, ROLE_KEYS.DROPS);
  });

  await check("04 report operational is verksted only", () => {
    assertOnlyRoleAllowed(humanIdentity, CAPABILITY_IDS.REPORT_OPERATIONAL, ROLE_KEYS.VERKSTED);
  });

  await check("05 register resolutions is verksted only", () => {
    assertOnlyRoleAllowed(humanIdentity, CAPABILITY_IDS.REGISTER_RESOLUTIONS, ROLE_KEYS.VERKSTED);
  });

  await check("06 clear workshop disposition is verksted only", () => {
    assertOnlyRoleAllowed(
      humanIdentity,
      CAPABILITY_IDS.CLEAR_WORKSHOP_DISPOSITION_WITH_OPERATIONAL,
      ROLE_KEYS.VERKSTED
    );
  });

  await check("07 acknowledge DROPS notification is drops only", () => {
    assertOnlyRoleAllowed(
      humanIdentity,
      CAPABILITY_IDS.ACKNOWLEDGE_DROPS_NOTIFICATION,
      ROLE_KEYS.DROPS
    );
  });

  await check("08 override is denied to every role", () => {
    for(const role of EXPECTED_ROLES){
      assertDenied(decide(humanIdentity, role, CAPABILITY_IDS.OVERRIDE), "role_not_allowed");
    }
  });

  await check("09 admin_pilot does not inherit DROPS write", () => {
    assertDenied(
      decide(humanIdentity, ROLE_KEYS.ADMIN_PILOT, CAPABILITY_IDS.REPORT_NOT_OPERATIONAL),
      "role_not_allowed"
    );
  });

  await check("10 admin_pilot does not inherit workshop writes", () => {
    for(const capability of [
      CAPABILITY_IDS.REPORT_OPERATIONAL,
      CAPABILITY_IDS.REGISTER_RESOLUTIONS,
      CAPABILITY_IDS.CLEAR_WORKSHOP_DISPOSITION_WITH_OPERATIONAL
    ]){
      assertDenied(decide(humanIdentity, ROLE_KEYS.ADMIN_PILOT, capability), "role_not_allowed");
    }
  });

  await check("11 unverified identity is denied", () => {
    assertDenied(decide({ ...humanIdentity, identityVerified: false }, ROLE_KEYS.DROPS), "identity_unverified");
  });

  await check("12 unbound identity is denied", () => {
    const result = evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: { roleResolved: false, roles: [] },
      capability: CAPABILITY_IDS.READ
    });
    assertDenied(result, "role_unresolved");
  });

  await check("13 service identity is denied human capabilities", () => {
    assertDenied(
      decide({ ...humanIdentity, identityKind: "service" }, ROLE_KEYS.DROPS),
      "human_identity_required"
    );
  });

  await check("14 multiple roles are denied", () => {
    const result = evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: { roleResolved: true, roles: [ROLE_KEYS.DROPS, ROLE_KEYS.VERKSTED] },
      capability: CAPABILITY_IDS.READ
    });
    assertDenied(result, "exactly_one_role_required");
  });

  await check("15 unknown role is denied", () => {
    assertDenied(decide(humanIdentity, "root"), "unknown_role");
    assertDenied(decide(humanIdentity, ROLE_KEYS.VAKTPLAN_LEDELSE), "unknown_role");
  });

  await check("16 unknown capability is denied", () => {
    assertDenied(decide(humanIdentity, ROLE_KEYS.DROPS, "vehicle_status.unknown"), "unknown_capability");
  });

  await check("17 unresolved capability is denied", () => {
    const catalog = validateCapabilityCatalog([
      ...CAPABILITY_CATALOG.entries,
      {
        capability: "vehicle_status.unresolved_test",
        description: "Permanent unresolved-policy fixture.",
        status: "unresolved",
        allowedRoles: []
      }
    ]);
    const result = evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: resolvedRole(ROLE_KEYS.ADMIN_PILOT),
      capability: "vehicle_status.unresolved_test"
    }, { catalog });
    assertDenied(result, "capability_unresolved");
  });

  await check("18 invalid catalog fails closed", () => {
    const catalog = validateCapabilityCatalog([{ capability: "invalid" }]);
    assert.equal(catalog.valid, false);
    assertDenied(evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: resolvedRole(ROLE_KEYS.DROPS),
      capability: CAPABILITY_IDS.READ
    }, { catalog }), "capability_catalog_invalid");
  });

  await check("19 catalog conflicts fail closed", () => {
    const duplicate = CAPABILITY_CATALOG.entries[0];
    const catalog = validateCapabilityCatalog([...CAPABILITY_CATALOG.entries, duplicate]);
    assert.equal(catalog.valid, false);
    assert.equal(catalog.diagnostics.includes("capability_catalog_duplicate_id"), true);
    assertDenied(evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: resolvedRole(ROLE_KEYS.DROPS),
      capability: CAPABILITY_IDS.READ
    }, { catalog }), "capability_catalog_invalid");
  });

  const baselineDecision = decide(humanIdentity, ROLE_KEYS.DROPS);
  for(const [number, label, spoof] of [
    [20, "query role is ignored", { query: { role: "verksted" } }],
    [21, "X-Role is ignored", { headers: { "x-role": "verksted" } }],
    [22, "X-Level is ignored", { headers: { "x-level": "master" } }],
    [23, "X-Email is ignored", { headers: { "x-email": "attacker@example.com" } }],
    [24, "frontend data-level is ignored", { dataLevel: 4, frontendLevel: "master" }]
  ]){
    await check(`${number} ${label}`, () => {
      const result = evaluateRuntimeAuthorization({
        identity: humanIdentity,
        roleResult: resolvedRole(ROLE_KEYS.DROPS),
        capability: CAPABILITY_IDS.READ,
        ...spoof
      });
      assert.deepEqual(result, baselineDecision);
    });
  }

  await check("25 identity input is not mutated", () => {
    const input = structuredClone(humanIdentity);
    const before = structuredClone(input);
    decide(input, ROLE_KEYS.DROPS);
    assert.deepEqual(input, before);
  });

  await check("26 role input is not mutated", () => {
    const roleResult = { roleResolved: true, roles: [ROLE_KEYS.DROPS] };
    const before = structuredClone(roleResult);
    evaluateRuntimeAuthorization({ identity: humanIdentity, roleResult, capability: CAPABILITY_IDS.READ });
    assert.deepEqual(roleResult, before);
  });

  await check("27 capability catalog is immutable and not mutated", () => {
    const before = JSON.stringify(CAPABILITY_CATALOG);
    decide(humanIdentity, ROLE_KEYS.DROPS);
    assert.equal(JSON.stringify(CAPABILITY_CATALOG), before);
    assert.equal(Object.isFrozen(CAPABILITY_CATALOG), true);
    assert.equal(Object.isFrozen(CAPABILITY_CATALOG.entries), true);
    assert.equal(Object.isFrozen(CAPABILITY_CATALOG.entries[0].allowedRoles), true);
  });

  await check("28 input order is deterministic", () => {
    const reversed = validateCapabilityCatalog([...CAPABILITY_CATALOG.entries].reverse());
    const first = evaluateRuntimeAuthorization({
      identity: humanIdentity,
      roleResult: resolvedRole(ROLE_KEYS.DROPS),
      capability: CAPABILITY_IDS.READ
    });
    const second = evaluateRuntimeAuthorization({
      capability: CAPABILITY_IDS.READ,
      roleResult: { roles: [ROLE_KEYS.DROPS], roleResolved: true },
      identity: { identityKind: "human", identityVerified: true, ...humanIdentity }
    }, { catalog: reversed });
    assert.deepEqual(second, first);
  });

  const adminHandler = createRuntimeCapabilitiesHandler({
    verifyIdentityRequest: async () => ({ ok: true, status: 200, identity: humanIdentity }),
    roleBindingsCatalog: {
      bindings: [{
        bindingId: "authority-1c-admin",
        subject: humanIdentity.subject,
        role: ROLE_KEYS.ADMIN_PILOT,
        enabled: true
      }]
    }
  });
  const handlerServer = await startHandlerServer(adminHandler);
  try{
    await check("29 capability endpoint is GET-only", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/capabilities?role=drops", undefined, {
        "X-Role": "drops",
        "X-Level": "master",
        "X-Email": "attacker@example.com"
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body.role, ROLE_KEYS.ADMIN_PILOT);
      assert.equal(response.body.capabilities[CAPABILITY_IDS.READ].allowed, true);
      for(const capability of Object.values(CAPABILITY_IDS).filter((id) => id !== CAPABILITY_IDS.READ)){
        assert.equal(response.body.capabilities[capability].allowed, false, capability);
      }
    });

    await check("30 no capability write method exists", async () => {
      const indexSource = fs.readFileSync(INDEX_FILE, "utf8");
      assert.match(indexSource, /app\.get\("\/api\/auth\/capabilities"/);
      assert.doesNotMatch(indexSource, /app\.(?:post|put|patch|delete)\("\/api\/auth\/capabilities"/i);
      for(const method of ["POST", "PUT", "PATCH", "DELETE"]){
        const response = await requestJson(handlerServer.port, method, "/api/auth/capabilities", {});
        assert.equal(response.status, 404, method);
      }
    });

    await check("31 response exposes neither bindings catalog nor other identities", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/capabilities");
      const serialized = JSON.stringify(response.body);
      for(const forbidden of ["bindings", "bindingId", "authority-1c-admin"]){
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    });

    await check("32 response omits subject email and JWT", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/capabilities", undefined, {
        "Cf-Access-Jwt-Assertion": "secret-jwt-must-not-appear"
      });
      const serialized = JSON.stringify(response.body);
      for(const forbidden of [humanIdentity.subject, humanIdentity.email, "secret-jwt-must-not-appear"]){
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    });
  }finally{
    await handlerServer.stop();
  }

  await check("33 unverified and unbound identities receive structured 401 and 403", async () => {
    const unverified = await invokeHandler(createRuntimeCapabilitiesHandler({
      verifyIdentityRequest: async () => ({
        ok: false,
        status: 401,
        publicError: "authentication_required"
      }),
      roleBindingsCatalog: { bindings: [] }
    }));
    assert.equal(unverified.status, 401);
    assert.equal(unverified.body.roleResolved, false);

    const unbound = await invokeHandler(createRuntimeCapabilitiesHandler({
      verifyIdentityRequest: async () => ({ ok: true, status: 200, identity: humanIdentity }),
      roleBindingsCatalog: { bindings: [] }
    }));
    assert.equal(unbound.status, 403);
    assert.equal(unbound.body.error, "role_binding_required");
  });

  await check("34 auth-session enforcement and write authority remain false", () => {
    const source = fs.readFileSync(AUTH_IDENTITY_FILE, "utf8");
    assert.match(source, /runtimeRoleEnforcement: false/);
    assert.match(source, /writeAuthority: false/);
    assert.doesNotMatch(source, /runtimeRoleEnforcement: true/);
    assert.doesNotMatch(source, /writeAuthority: true/);
  });

  await check("35 vehicle-status remains read-only", () => {
    const indexSource = fs.readFileSync(INDEX_FILE, "utf8");
    const readModelSource = fs.readFileSync(VEHICLE_READ_MODEL_FILE, "utf8");
    assert.match(indexSource, /app\.get\("\/api\/vehicle-status"/);
    assert.doesNotMatch(indexSource, /app\.(?:post|put|patch|delete)\("\/api\/vehicle-status"/i);
    for(const lockedFalse of ["persistenceActive", "statusAuthorityActive", "writeEnabled", "operationalAuthority"]){
      assert.match(readModelSource, new RegExp(`${lockedFalse}: false`));
    }
  });

  await check("36 capability handler reuses Access verification and role binding", () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, "src", "runtimeAuthorization.js"), "utf8");
    assert.match(source, /verifyAccessIdentityRequest/);
    assert.match(source, /resolveIdentityRoleBinding/);
    assert.match(source, /loadIdentityRoleBindingsCatalog/);
  });

  await check("37 GET does not change operational revision or shared draft", async () => {
    const port = await getFreePort();
    removeTestFiles();
    serverProcess = startServer(port);
    try{
      await waitForHealth(port);
      const beforeRevision = await requestJson(port, "GET", "/api/state/revision");
      const beforeOperational = await requestJson(port, "GET", "/api/operational-state");
      const beforeDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");
      const capabilityResponse = await requestJson(port, "GET", "/api/auth/capabilities");
      assert.equal([401, 503].includes(capabilityResponse.status), true);
      const afterRevision = await requestJson(port, "GET", "/api/state/revision");
      const afterOperational = await requestJson(port, "GET", "/api/operational-state");
      const afterDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");
      assert.deepEqual(afterRevision.body, beforeRevision.body);
      assert.deepEqual(afterOperational.body, beforeOperational.body);
      assert.deepEqual(afterDraft.body, beforeDraft.body);
    }finally{
      await stopServer();
      removeTestFiles();
    }
  });

  await check("38 global enforcement and write execution stay disabled", async () => {
    const response = await invokeHandler(adminHandler);
    assert.equal(response.body.globalRuntimeRoleEnforcement, false);
    assert.equal(response.body.writeExecutionEnabled, false);
    assert.equal(response.body.sourceMode, "authorization_policy_readback_only");
  });

  console.log(`runtimeAuthorizationTests: ${passed.length}/${passed.length}`);
  console.log("AUTHORITY-1C runtime authorization policy OK");
}

function decide(identity, role, capability = CAPABILITY_IDS.READ){
  return evaluateRuntimeAuthorization({
    identity,
    roleResult: resolvedRole(role),
    capability
  });
}

function resolvedRole(role){
  return { roleResolved: true, roles: [role] };
}

function assertOnlyRoleAllowed(identity, capability, expectedRole){
  for(const role of EXPECTED_ROLES){
    const result = decide(identity, role, capability);
    if(role === expectedRole) assertAllowed(result);
    else assertDenied(result, "role_not_allowed");
  }
}

function assertAllowed(result){
  assert.equal(result.allowed, true);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.reasonCode, "role_explicitly_allowed");
  assert.equal(result.runtimeEnforcementScope, "policy_readback_only");
}

function assertDenied(result, reasonCode){
  assert.equal(result.allowed, false);
  assert.equal(result.decision, "DENY");
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(result.runtimeEnforcementScope, "policy_readback_only");
}

async function startHandlerServer(handler){
  const app = express();
  app.use(express.json());
  app.get("/api/auth/capabilities", handler);
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  const server = http.createServer(app);
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, TEST_HOST, resolve);
  });
  return {
    port,
    stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function invokeHandler(handler){
  const response = { headers: {}, status: 200, body: null };
  const res = {
    set(name, value){ response.headers[String(name).toLowerCase()] = value; return this; },
    status(status){ response.status = status; return this; },
    json(body){ response.body = body; return body; }
  };
  await handler({ headers: {}, query: {} }, res);
  return response;
}

function requestJson(port, method, pathname, body, headers = {}){
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: TEST_HOST,
      port,
      method,
      path: pathname,
      headers: {
        accept: "application/json",
        ...(encodedBody ? { "content-type": "application/json", "content-length": encodedBody.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try{ parsed = raw ? JSON.parse(raw) : null; }catch(_error){ parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if(encodedBody) req.write(encodedBody);
    req.end();
  });
}

function getFreePort(){
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, TEST_HOST, () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startServer(port){
  const output = fs.openSync(TEST_LOG, "w");
  const env = { ...process.env, PORT: String(port), SDE_SERVER_DB_PATH: TEST_DB };
  for(const key of Object.keys(env)){
    if(key.startsWith("SDE_ENABLE_")) delete env[key];
  }
  delete env.SDE_CF_ACCESS_TEAM_DOMAIN;
  delete env.SDE_CF_ACCESS_AUDIENCE;
  delete env.SDE_IDENTITY_ROLE_BINDINGS_PATH;
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", output, output]
  });
  fs.closeSync(output);
  return child;
}

async function waitForHealth(port){
  const deadline = Date.now() + 6000;
  while(Date.now() < deadline){
    if(serverProcess.exitCode !== null) throw new Error(`Test server exited early.\n${readLog()}`);
    try{
      const health = await requestJson(port, "GET", "/api/health");
      if(health.status === 200 && health.body.ok === true) return;
    }catch(_error){
      // Retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated server.\n${readLog()}`);
}

async function stopServer(){
  if(!serverProcess) return;
  if(serverProcess.exitCode === null) serverProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    if(serverProcess.exitCode !== null) return resolve();
    serverProcess.once("exit", resolve);
    setTimeout(() => {
      if(serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
      resolve();
    }, 3000).unref();
  });
  serverProcess = null;
}

function removeTestFiles(){
  for(const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, TEST_LOG]){
    try{ fs.unlinkSync(file); }catch(error){ if(error.code !== "ENOENT") throw error; }
  }
}

function readLog(){
  try{ return fs.readFileSync(TEST_LOG, "utf8"); }catch(_error){ return ""; }
}

main().catch(async (error) => {
  await stopServer();
  removeTestFiles();
  console.error(error);
  process.exitCode = 1;
});
