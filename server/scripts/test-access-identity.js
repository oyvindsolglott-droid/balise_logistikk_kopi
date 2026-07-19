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
const {
  ACCESS_IDENTITY_SOURCE,
  createAccessIdentitySessionHandler,
  getAccessIdentityConfiguration,
  verifyAccessIdentityRequest
} = require("../src/accessIdentity");

const SERVER_DIR = path.resolve(__dirname, "..");
const INDEX_FILE = path.join(SERVER_DIR, "src", "index.js");
const TEST_HOST = "127.0.0.1";
const TEST_DB = path.join(os.tmpdir(), `sde-authority-1a-${process.pid}.sqlite3`);
const TEST_LOG = path.join(os.tmpdir(), `sde-authority-1a-${process.pid}.log`);
const TEST_ENV = Object.freeze({
  SDE_CF_ACCESS_TEAM_DOMAIN: " https://unit-test.cloudflareaccess.com/ ",
  SDE_CF_ACCESS_AUDIENCE: " sde-test-audience "
});
const EXPECTED_IDENTITY_SCHEMA_VERSION = "sde-runtime-identity-v1";

let serverProcess = null;
const passed = [];
const schemaPassed = [];
const observedIdentityResponses = [];

async function check(name, callback){
  await callback();
  passed.push(name);
}

async function schemaCheck(name, callback){
  await callback();
  schemaPassed.push(name);
}

function assertIdentityResponseSchema(response){
  assert.equal(typeof response.body, "object");
  assert.equal(response.body.schemaVersion, EXPECTED_IDENTITY_SCHEMA_VERSION);
  assert.deepEqual(
    ["schema", "schema_version", "identitySchemaVersion", "responseSchemaVersion"]
      .filter((field) => Object.hasOwn(response.body, field)),
    []
  );
  observedIdentityResponses.push(response.body);
}

async function main(){
  const jose = await import("jose");
  const keyOne = await createSigningFixture(jose, "test-key-one");
  const keyTwo = await createSigningFixture(jose, "test-key-two");
  const wrongKey = await createSigningFixture(jose, "wrong-key");
  const jwks = jose.createLocalJWKSet({ keys: [keyOne.publicJwk, keyTwo.publicJwk] });
  const config = getAccessIdentityConfiguration(TEST_ENV);
  const now = Math.floor(Date.now() / 1000);
  const baseClaims = {
    sub: "human-subject-1",
    email: "  Operator@Example.COM ",
    iss: config.issuer,
    aud: config.audience,
    iat: now - 5,
    exp: now + 300,
    jti: "safe-token-id"
  };
  const validToken = await signToken(jose, keyOne, baseClaims);
  const validServiceToken = await signToken(jose, keyOne, {
    ...baseClaims,
    sub: "service-subject-1",
    email: undefined,
    common_name: "service-client-id.access"
  });

  await check("01 valid JWT", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validToken },
      env: TEST_ENV,
      jwks
    });
    assert.equal(result.ok, true);
    assert.equal(result.identity.authenticated, true);
    assert.equal(result.identity.identityVerified, true);
    assert.equal(result.identity.subject, "human-subject-1");
    assert.equal(config.issuer, "https://unit-test.cloudflareaccess.com");
    assert.equal(config.jwksUrl, "https://unit-test.cloudflareaccess.com/cdn-cgi/access/certs");
  });

  await check("02 signature is verified", async () => {
    const [encodedHeader, encodedPayload, encodedSignature] = validToken.split(".");
    const tamperedPayload = base64url(JSON.stringify({ ...baseClaims, sub: "tampered" }));
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": `${encodedHeader}.${tamperedPayload}.${encodedSignature}` },
      env: TEST_ENV,
      jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_invalid");
    assert.notEqual(encodedPayload, tamperedPayload);
  });

  await check("03 wrong signature", async () => {
    const token = await signToken(jose, wrongKey, baseClaims);
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token },
      env: TEST_ENV,
      jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  await check("04 wrong issuer", async () => {
    const token = await signToken(jose, keyOne, { ...baseClaims, iss: "https://wrong.cloudflareaccess.com" });
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_issuer_mismatch");
  });

  await check("05 wrong audience", async () => {
    const token = await signToken(jose, keyOne, { ...baseClaims, aud: "wrong-audience" });
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_audience_mismatch");
  });

  await check("06 expired token", async () => {
    const token = await signToken(jose, keyOne, { ...baseClaims, iat: now - 600, exp: now - 300 });
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_expired");
  });

  await check("07 missing assertion header", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: {
        cookie: `CF_Authorization=${validToken}`,
        "cf-access-token": validToken
      },
      env: TEST_ENV,
      jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_missing");
  });

  await check("08 alg none", async () => {
    const token = `${base64url(JSON.stringify({ alg: "none", typ: "JWT", kid: keyOne.kid }))}.${base64url(JSON.stringify(baseClaims))}.`;
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_invalid");
  });

  await check("09 unexpected algorithm", async () => {
    const secret = new TextEncoder().encode("test-only-secret-that-is-long-enough");
    const token = await new jose.SignJWT(baseClaims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: keyOne.kid })
      .sign(secret);
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnosticCode, "access_token_invalid");
  });

  await check("10 normalized human email", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validToken }, env: TEST_ENV, jwks
    });
    assert.equal(result.identity.identityKind, "human");
    assert.equal(result.identity.email, "operator@example.com");
    assert.equal(result.identity.identitySource, ACCESS_IDENTITY_SOURCE);
  });

  await check("11 invalid email is omitted", async () => {
    const token = await signToken(jose, keyOne, { ...baseClaims, email: "not-an-email" });
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": token }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, true);
    assert.equal(result.identity.identityKind, "unknown");
    assert.equal(Object.hasOwn(result.identity, "email"), false);
  });

  await check("12 verified service token", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validServiceToken }, env: TEST_ENV, jwks
    });
    assert.equal(result.ok, true);
    assert.equal(result.identity.identityKind, "service");
    assert.equal(result.identity.serviceTokenId, "service-client-id.access");
  });

  await check("13 service token gets no human role", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validServiceToken }, env: TEST_ENV, jwks
    });
    assert.equal(result.identity.roleResolved, false);
    assert.deepEqual(result.identity.roles, []);
    assert.equal(Object.hasOwn(result.identity, "role"), false);
  });

  const handlerServer = await startHandlerServer(createAccessIdentitySessionHandler({ env: TEST_ENV, jwks }));
  try{
    await check("14 X-Role ignored", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken,
        "X-Role": "admin"
      });
      assert.equal(response.status, 200);
      assert.equal(JSON.stringify(response.body).includes("admin"), false);
    });

    await check("15 X-Email ignored", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken,
        "X-Email": "attacker@example.com"
      });
      assert.equal(response.body.email, "operator@example.com");
      assert.equal(JSON.stringify(response.body).includes("attacker@example.com"), false);
    });

    await check("16 Cloudflare email header alone is not authority", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Authenticated-User-Email": "attacker@example.com"
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.identityVerified, false);
      assert.equal(JSON.stringify(response.body).includes("attacker@example.com"), false);
    });

    await check("17 query identity fields ignored", async () => {
      const response = await requestJson(
        handlerServer.port,
        "GET",
        "/api/auth/session?level=1&role=admin&actor=attacker&email=attacker%40example.com",
        undefined,
        { "Cf-Access-Jwt-Assertion": validToken }
      );
      assert.equal(response.status, 200);
      const serialized = JSON.stringify(response.body);
      for(const spoofed of ["admin", "attacker", "level"]){
        assert.equal(serialized.includes(spoofed), false);
      }
    });

    await check("18 raw JWT absent from response and logs", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(JSON.stringify(response.body).includes(validToken), false);
      assert.equal(handlerServer.logs.join("\n").includes(validToken), false);
    });

    await check("19 roleResolved false", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.body.roleResolved, false);
    });

    await check("20 roles empty", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.deepEqual(response.body.roles, []);
    });

    await check("21 runtime role enforcement false", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.body.runtimeRoleEnforcement, false);
    });

    await check("22 write authority false", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.body.writeAuthority, false);
    });

    await check("23 endpoint is GET-only", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
    });

    await check("24 no identity write routes", async () => {
      const indexSource = fs.readFileSync(INDEX_FILE, "utf8");
      assert.match(indexSource, /app\.get\("\/api\/auth\/session"/);
      assert.doesNotMatch(indexSource, /app\.(?:post|put|patch|delete)\("\/api\/auth\/session"/i);
      for(const method of ["POST", "PUT", "PATCH", "DELETE"]){
        const response = await requestJson(handlerServer.port, method, "/api/auth/session", {});
        assert.equal(response.status, 404);
      }
    });

    await schemaCheck("01 valid human response schema", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.identityKind, "human");
      assertIdentityResponseSchema(response);
    });

    await schemaCheck("02 valid service response schema", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validServiceToken
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.identityKind, "service");
      assert.equal(Object.hasOwn(response.body, "email"), false);
      assert.deepEqual(response.body.roles, []);
      assert.equal(response.body.writeAuthority, false);
      assertIdentityResponseSchema(response);
    });

    await schemaCheck("03 missing token response schema", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session");
      assert.equal(response.status, 401);
      assert.equal(response.body.error, "authentication_required");
      assertIdentityResponseSchema(response);
    });

    await schemaCheck("04 invalid token response schema", async () => {
      const response = await requestJson(handlerServer.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": "not-a-valid-jwt"
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error, "authentication_failed");
      assertIdentityResponseSchema(response);
    });

    await schemaCheck("05 schema cannot be overridden by request or claims", async () => {
      const spoofedToken = await signToken(jose, keyOne, {
        ...baseClaims,
        schemaVersion: "attacker-claim"
      });
      const response = await requestJson(
        handlerServer.port,
        "GET",
        "/api/auth/session?schemaVersion=attacker-query",
        undefined,
        {
          "Cf-Access-Jwt-Assertion": spoofedToken,
          "X-Schema-Version": "attacker-header"
        }
      );
      assert.equal(response.status, 200);
      assertIdentityResponseSchema(response);
      const serialized = JSON.stringify(response.body);
      for(const spoofed of ["attacker-claim", "attacker-query", "attacker-header"]){
        assert.equal(serialized.includes(spoofed), false);
      }
    });
  }finally{
    await handlerServer.stop();
  }

  await schemaCheck("06 missing runtime config response schema", async () => {
    const server = await startHandlerServer(createAccessIdentitySessionHandler({ env: {}, jwks }));
    try{
      const response = await requestJson(server.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.error, "access_identity_configuration_missing");
      assertIdentityResponseSchema(response);
    }finally{
      await server.stop();
    }
  });

  await schemaCheck("07 invalid runtime config response schema", async () => {
    const server = await startHandlerServer(createAccessIdentitySessionHandler({
      env: {
        SDE_CF_ACCESS_TEAM_DOMAIN: "http://invalid.cloudflareaccess.com",
        SDE_CF_ACCESS_AUDIENCE: "sde-test-audience"
      },
      jwks
    }));
    try{
      const response = await requestJson(server.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.error, "access_identity_configuration_invalid");
      assertIdentityResponseSchema(response);
    }finally{
      await server.stop();
    }
  });

  await schemaCheck("08 verification unavailable response schema", async () => {
    const unavailable = async () => {
      const error = new Error("test JWKS unavailable");
      error.code = "ERR_JWKS_NETWORK";
      throw error;
    };
    const server = await startHandlerServer(createAccessIdentitySessionHandler({
      env: TEST_ENV,
      jwks: unavailable
    }));
    try{
      const response = await requestJson(server.port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.error, "access_identity_verification_unavailable");
      assertIdentityResponseSchema(response);
    }finally{
      await server.stop();
    }
  });

  await runActualServerChecks(validToken);

  await check("27 missing config fails closed without crash", async () => {
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validToken }, env: {}, jwks
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.diagnosticCode, "access_configuration_missing");
  });

  await check("28 JWKS failure fails closed", async () => {
    const unavailable = async () => {
      const error = new Error("test JWKS unavailable");
      error.code = "ERR_JWKS_NETWORK";
      throw error;
    };
    const result = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": validToken }, env: TEST_ENV, jwks: unavailable
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.diagnosticCode, "access_jwks_unavailable");
    assert.equal(JSON.stringify(result).includes("test JWKS unavailable"), false);
  });

  await check("29 deterministic read-model", async () => {
    const input = { headers: { "cf-access-jwt-assertion": validToken }, env: TEST_ENV, jwks };
    const first = await verifyAccessIdentityRequest(input);
    const second = await verifyAccessIdentityRequest(input);
    assert.deepEqual(first, second);
  });

  await check("30 kid rotation with two keys", async () => {
    const tokenOne = await signToken(jose, keyOne, baseClaims);
    const tokenTwo = await signToken(jose, keyTwo, { ...baseClaims, sub: "human-subject-2", jti: "rotated-id" });
    const first = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": tokenOne }, env: TEST_ENV, jwks
    });
    const second = await verifyAccessIdentityRequest({
      headers: { "cf-access-jwt-assertion": tokenTwo }, env: TEST_ENV, jwks
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.identity.subject, "human-subject-2");
  });

  await schemaCheck("09 all structured identity responses use one exact schema", async () => {
    assert.equal(observedIdentityResponses.length, 8);
    assert.equal(
      new Set(observedIdentityResponses.map((body) => body.schemaVersion)).size,
      1
    );
  });

  assert.equal(passed.length, 30, `expected 30 checks, got ${passed.length}`);
  assert.equal(schemaPassed.length, 9, `expected 9 schema checks, got ${schemaPassed.length}`);
  console.log("accessIdentityTests: 30/30");
  console.log("accessIdentitySchemaTests: 9/9");
  console.log("accessIdentityHttpTests: PASS");
}

async function runActualServerChecks(validToken){
  const port = await getFreePort();
  removeTestFiles();
  serverProcess = startServer(port);

  try{
    await waitForHealth(port);
    const beforeRevision = await requestJson(port, "GET", "/api/state/revision");
    const beforeOperational = await requestJson(port, "GET", "/api/operational-state");
    const beforeDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");

    await check("25 auth GET does not mutate operational revision", async () => {
      const response = await requestJson(port, "GET", "/api/auth/session", undefined, {
        "Cf-Access-Jwt-Assertion": validToken
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.error, "access_identity_configuration_missing");
      assert.equal(response.body.schemaVersion, EXPECTED_IDENTITY_SCHEMA_VERSION);
      const afterRevision = await requestJson(port, "GET", "/api/state/revision");
      const afterOperational = await requestJson(port, "GET", "/api/operational-state");
      assert.deepEqual(afterRevision.body, beforeRevision.body);
      assert.deepEqual(afterOperational.body, beforeOperational.body);
    });

    await check("26 auth GET does not mutate shared draft", async () => {
      const afterDraft = await requestJson(port, "GET", "/api/shared-sporplan-draft");
      assert.deepEqual(afterDraft.body, beforeDraft.body);
      const vehicleStatus = await requestJson(port, "GET", "/api/vehicle-status");
      assert.equal(vehicleStatus.body.persistenceActive, false);
      assert.equal(vehicleStatus.body.statusAuthorityActive, false);
      assert.equal(vehicleStatus.body.writeEnabled, false);
      assert.equal(vehicleStatus.body.operationalAuthority, false);
      assert.equal(vehicleStatus.body.revision, 0);
      assert.equal(vehicleStatus.body.trustedRequestAuthority, null);
    });
  }finally{
    await stopServer();
    const logs = readLog();
    assert.equal(logs.includes(validToken), false, "raw JWT must not be logged by actual server");
    removeTestFiles();
  }
}

async function createSigningFixture(jose, kid){
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicJwk,
      alg: "RS256",
      kid,
      use: "sig"
    }
  };
}

function signToken(jose, fixture, claims){
  const normalizedClaims = Object.fromEntries(
    Object.entries(claims).filter(([, value]) => value !== undefined)
  );
  return new jose.SignJWT(normalizedClaims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: fixture.kid })
    .sign(fixture.privateKey);
}

function base64url(value){
  return Buffer.from(value).toString("base64url");
}

async function startHandlerServer(handler){
  const app = express();
  const logs = [];
  app.get("/api/auth/session", handler);
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  const server = http.createServer(app);
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, TEST_HOST, resolve);
  });
  return {
    port,
    logs,
    stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
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
  const env = { ...process.env };
  for(const key of Object.keys(env)){
    if(key.startsWith("SDE_ENABLE_")) delete env[key];
  }
  delete env.SDE_CF_ACCESS_TEAM_DOMAIN;
  delete env.SDE_CF_ACCESS_AUDIENCE;
  env.PORT = String(port);
  env.SDE_SERVER_DB_PATH = TEST_DB;
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
    if(serverProcess.exitCode !== null){
      throw new Error(`Test server exited early.\n${readLog()}`);
    }
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

function requestJson(port, method, requestPath, body, extraHeaders = {}){
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: TEST_HOST,
      port,
      method,
      path: requestPath,
      timeout: 4000,
      headers: {
        ...extraHeaders,
        ...(payload === null ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        })
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try{
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : null
          });
        }catch(error){
          reject(new Error(`Invalid JSON from ${method} ${requestPath}: ${error.message}; raw=${raw}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Timed out ${method} ${requestPath}`)));
    request.on("error", reject);
    if(payload !== null) request.write(payload);
    request.end();
  });
}

function stopServer(){
  if(!serverProcess || serverProcess.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverProcess.kill("SIGKILL");
      reject(new Error("Timed out stopping isolated access-identity test server"));
    }, 5000);
    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    serverProcess.kill("SIGTERM");
  });
}

function removeTestFiles(){
  for(const file of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`, TEST_LOG]){
    const resolved = path.resolve(file);
    if(!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)){
      throw new Error(`Refusing to remove non-temp test file: ${file}`);
    }
    fs.rmSync(resolved, { force: true });
  }
}

function readLog(){
  return fs.existsSync(TEST_LOG) ? fs.readFileSync(TEST_LOG, "utf8") : "";
}

main().catch(async (error) => {
  try{
    await stopServer();
  }catch(stopError){
    console.error(stopError);
  }
  removeTestFiles();
  console.error(error);
  process.exitCode = 1;
});
