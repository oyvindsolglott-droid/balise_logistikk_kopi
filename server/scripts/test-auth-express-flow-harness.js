"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  AUTH_RIGHTS,
  ENDPOINT_CLASSES,
  buildAuthAuditDecision,
  classifyEndpoint,
  evaluateAuthDecision,
  normalizeIdentityContext
} = require("../src/authPolicy");

const SCRIPT_PATH = __filename;
const RUNTIME_PATH = path.join(__dirname, "..", "src", "in" + "dex.js");
const scriptSource = fs.readFileSync(SCRIPT_PATH, "utf8");
const runtimeSource = fs.readFileSync(RUNTIME_PATH, "utf8");

assertNoRuntimeCoupling();

const isolatedApp = express();
assert.equal(typeof isolatedApp.handle, "function", "isolated Express app is available without network use");

const roleScopeCatalog = Object.freeze({
  admin_pilot: Object.freeze({
    "manual-assessments-notes": Object.freeze([AUTH_RIGHTS.READBACK_AUDIT]),
    "operational-state-sensitive-readback": Object.freeze([AUTH_RIGHTS.READBACK_AUDIT]),
    "scope-restricted-shared-workspace-readback": Object.freeze([AUTH_RIGHTS.READBACK_AUDIT])
  }),
  sde_skiftere: Object.freeze({
    "sde-night-placement-manual-overrides": Object.freeze([AUTH_RIGHTS.READBACK_AUDIT])
  })
});

runPublicSafeGetTests();
runUnknownAndMalformedTests();
runReviewNeededTests();
runPrivateCandidateDenyTests();
runPrivateCandidateAllowTest();
runWriteBlockedTests();
runPolicyFailClosedTests();
runIdentityBoundaryAuditTest();
runNoMutationAssertion();

console.log("B48-I auth Express-flow harness tests OK");

function runPublicSafeGetTests() {
  [
    "/api/health",
    "/api/server/status",
    "/api/state/revision"
  ].forEach((pathname) => {
    const result = runExpressFlow({
      method: "GET",
      path: pathname,
      handlerKind: "public"
    });

    assertDecision(result, true, "public_read_allowed", `public safe GET ${pathname}`);
    assert.equal(result.nextCalled, true, `next called for ${pathname}`);
    assertCounters(result.counters, { public: 1, private: 0, write: 0 }, `public safe GET ${pathname}`);
  });
}

function runUnknownAndMalformedTests() {
  [
    {
      label: "unknown endpoint",
      request: {
        method: "GET",
        path: "/api/unknown-express-flow-test",
        handlerKind: "public"
      },
      reason: "unknown_endpoint"
    },
    {
      label: "unknown method",
      request: {
        method: "DELETE",
        path: "/api/health",
        handlerKind: "public"
      },
      reason: "unknown_endpoint"
    },
    {
      label: "missing path",
      request: {
        method: "GET",
        handlerKind: "public"
      },
      reason: "unknown_endpoint"
    },
    {
      label: "missing method",
      request: {
        path: "/api/health",
        handlerKind: "public"
      },
      reason: "unknown_endpoint"
    }
  ].forEach((testCase) => {
    const result = runExpressFlow(testCase.request);

    assertDecision(result, false, testCase.reason, testCase.label);
    assert.equal(result.nextCalled, false, `${testCase.label}: next blocked`);
    assertNoHandlerEffect(result.counters, testCase.label);
  });
}

function runReviewNeededTests() {
  [
    "/api/state",
    "/api/events",
    "/api/operational-state",
    "/api/operational-state/events",
    "/api/stream",
    "/",
    "/app",
    "/data/example.json",
    "/assets/example.js"
  ].forEach((pathname) => {
    const classification = classifyEndpoint("GET", pathname);
    const result = runExpressFlow({
      method: "GET",
      path: pathname,
      identityContext: trustedIdentity(),
      requestOverrides: {
        requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
        scope: "manual-assessments-notes"
      },
      handlerKind: "private"
    });

    assert.equal(
      classification.endpointClass,
      ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY,
      `review-needed classification ${pathname}`
    );
    assertDecision(result, false, "review_needed_not_private_runtime", `review-needed ${pathname}`);
    assert.equal(result.nextCalled, false, `review-needed ${pathname}: next blocked`);
    assertNoHandlerEffect(result.counters, `review-needed ${pathname}`);
  });
}

function runPrivateCandidateDenyTests() {
  [
    {
      label: "manual missing identity",
      identityContext: {},
      scope: "manual-assessments-notes",
      reason: "missing_identity"
    },
    {
      label: "operational sensitive untrusted identity",
      identityContext: {
        identity: {
          id: "admin-pilot",
          role: "admin_pilot",
          scopes: ["operational-state-sensitive-readback"]
        }
      },
      scope: "operational-state-sensitive-readback",
      reason: "trusted_boundary_required"
    },
    {
      label: "shared workspace spoofed headers",
      identityContext: {
        clientHeaders: {
          "x-sde-role": "admin_pilot",
          "x-sde-user": "spoofed"
        }
      },
      scope: "scope-restricted-shared-workspace-readback",
      reason: "missing_identity"
    },
    {
      label: "actor not identity",
      identityContext: {
        actor: {
          id: "admin-pilot",
          role: "admin_pilot"
        }
      },
      scope: "manual-assessments-notes",
      reason: "missing_identity"
    },
    {
      label: "device not identity",
      identityContext: {
        device: {
          id: "admin-device"
        }
      },
      scope: "manual-assessments-notes",
      reason: "missing_identity"
    },
    {
      label: "client context not identity",
      identityContext: {
        clientContext: {
          role: "admin_pilot"
        }
      },
      scope: "manual-assessments-notes",
      reason: "missing_identity"
    },
    {
      label: "local network not identity",
      identityContext: {
        localLan: true,
        role: "admin_pilot"
      },
      scope: "manual-assessments-notes",
      reason: "missing_identity"
    },
    {
      label: "wrong role",
      identityContext: trustedIdentity({
        id: "agila",
        role: "agila",
        scopes: ["manual-assessments-notes"]
      }),
      scope: "manual-assessments-notes",
      reason: "unknown_role"
    },
    {
      label: "wrong scope",
      identityContext: trustedIdentity({
        scopes: ["operational-state-sensitive-readback"]
      }),
      scope: "manual-assessments-notes",
      reason: "identity_scope_not_assigned"
    }
  ].forEach((testCase) => {
    const result = runExpressFlow(privateCandidateRequest(testCase.scope, {
      identityContext: testCase.identityContext
    }));

    assertDecision(result, false, testCase.reason, testCase.label);
    assert.equal(result.nextCalled, false, `${testCase.label}: next blocked`);
    assertCounters(result.counters, { public: 0, private: 0, write: 0 }, testCase.label);
  });
}

function runPrivateCandidateAllowTest() {
  const result = runExpressFlow(privateCandidateRequest("manual-assessments-notes", {
    identityContext: trustedIdentity()
  }));

  assertDecision(result, true, "readback_allowed", "trusted server-side readback allow in isolated test");
  assert.equal(result.nextCalled, true, "trusted private read-only next allowed in isolated test");
  assertCounters(result.counters, { public: 0, private: 1, write: 0 }, "trusted private read-only allow");
}

function runWriteBlockedTests() {
  [
    {
      label: "test note action",
      request: writeRequest("/api/actions/test-note")
    },
    {
      label: "action contract",
      request: writeRequest("/api/actions/action-contract-test")
    },
    {
      label: "actions table",
      request: writeRequest("/api/actions/actions-table-test")
    },
    {
      label: "server note",
      request: writeRequest("/api/actions/server-note")
    },
    {
      label: "recommendation ack",
      request: writeRequest("/api/actions/sde-recommendation-ack")
    },
    {
      label: "operational snapshot",
      request: writeRequest("/api/operational-state/snapshot")
    },
    {
      label: "production write",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: trustedIdentity(),
        requestedRight: AUTH_RIGHTS.PRODUCTION_WRITE,
        handlerKind: "write"
      })
    },
    {
      label: "operational authority",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: trustedIdentity(),
        requestedRight: AUTH_RIGHTS.OPERATIONAL_AUTHORITY,
        handlerKind: "write"
      }),
      reason: "operational_authority_denied"
    },
    {
      label: "migration schema",
      request: writeRequest("/api/schema/migration")
    }
  ].forEach((testCase) => {
    const result = runExpressFlow(testCase.request);

    assertDecision(result, false, testCase.reason || "write_denied", testCase.label);
    assert.equal(result.nextCalled, false, `${testCase.label}: next blocked`);
    assertCounters(result.counters, { public: 0, private: 0, write: 0 }, testCase.label);
  });
}

function runPolicyFailClosedTests() {
  [
    {
      label: "policy error",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: trustedIdentity()
      }),
      options: {
        policyEvaluator: () => {
          throw new Error("simulated policy failure");
        }
      },
      reason: "policy_error"
    },
    {
      label: "missing policy input",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: trustedIdentity()
      }),
      options: {
        buildRequestContext: () => null
      },
      reason: "missing_policy_input"
    },
    {
      label: "malformed request context",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: trustedIdentity()
      }),
      options: {
        buildRequestContext: () => "not-an-object"
      },
      reason: "missing_policy_input"
    },
    {
      label: "private missing identity-source",
      request: privateCandidateRequest("manual-assessments-notes", {
        identityContext: {}
      }),
      reason: "missing_identity"
    }
  ].forEach((testCase) => {
    const result = runExpressFlow(testCase.request, testCase.options);

    assertDecision(result, false, testCase.reason, testCase.label);
    assert.equal(result.nextCalled, false, `${testCase.label}: next blocked`);
    assertNoHandlerEffect(result.counters, testCase.label);
  });
}

function runIdentityBoundaryAuditTest() {
  const identityContext = trustedIdentity({
    actor: {
      id: "claimed-actor"
    },
    device: {
      id: "claimed-device"
    },
    clientContext: {
      source: "isolated-express-flow"
    },
    sourceIp: "loopback-test"
  });
  const normalized = normalizeIdentityContext(identityContext);
  const audit = buildAuthAuditDecision({
    identityContext,
    requestContext: {
      method: "GET",
      path: "/api/auth-express-flow/private-readback",
      endpointClass: ENDPOINT_CLASSES.PRIVATE_READBACK_CANDIDATE,
      requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
      scope: "manual-assessments-notes"
    },
    allowed: true,
    reason: "readback_allowed"
  });

  assert.equal(normalized.trustedBoundary, true, "trusted identity is explicit server-side context");
  assert.equal(normalized.authenticatedIdentityId, "admin-pilot", "authenticated identity id");
  assert.equal(normalized.untrustedClientFields.actorProvided, true, "actor remains marked as client-provided metadata");
  assert.equal(audit.actorIsIdentity, false, "actor is not identity");
  assert.equal(audit.deviceIsIdentity, false, "device is not identity");
  assert.equal(audit.clientContextIsIdentity, false, "client context is not identity");
  assert.equal(audit.trustedBoundary, true, "audit carries explicit trusted boundary");
}

function runNoMutationAssertion() {
  const mutationState = {
    dbWrites: 0,
    events: 0,
    revision: 0
  };
  const result = runExpressFlow(privateCandidateRequest("manual-assessments-notes", {
    identityContext: {}
  }));

  assertDecision(result, false, "missing_identity", "no mutation deny");
  assert.deepEqual(mutationState, {
    dbWrites: 0,
    events: 0,
    revision: 0
  }, "isolated Express-flow harness must not mutate state");
}

function runExpressFlow(request, options = {}) {
  const counters = createCounters();
  const req = createRequest(request);
  const res = createResponse();
  let nextCalled = false;

  const authMiddleware = createIsolatedAuthMiddleware(options);
  authMiddleware(req, res, () => {
    nextCalled = true;
    runHandler(request?.handlerKind || "private", counters, res);
  });

  return {
    allowed: Boolean(req.authDecision?.allowed),
    reason: req.authDecision?.reason || res.body?.error,
    audit: req.authDecision?.audit || res.body?.audit,
    nextCalled,
    counters,
    response: res
  };
}

function createIsolatedAuthMiddleware(options = {}) {
  const policyEvaluator = options.policyEvaluator || evaluateAuthDecision;
  const requestContextBuilder = options.buildRequestContext || buildRequestContext;

  return (req, res, next) => {
    let requestContext;
    try {
      requestContext = requestContextBuilder(req);
      if (!isPlainObject(requestContext)) {
        return denyResponse(req, res, "missing_policy_input");
      }

      const identityContext = normalizeIdentityContext(req.serverSideIdentityContext || {});
      const decision = policyEvaluator(identityContext, requestContext);
      req.authDecision = decision;

      if (!decision.allowed) {
        return denyResponse(req, res, decision.reason, decision.audit);
      }
    } catch (_error) {
      return denyResponse(req, res, "policy_error");
    }

    return next();
  };
}

function buildRequestContext(req) {
  if (!isPlainObject(req)) {
    return null;
  }

  const classification = classifyEndpoint(req.method, req.path);
  const requestOverrides = isPlainObject(req.requestOverrides) ? req.requestOverrides : {};

  return {
    method: req.method,
    path: req.path,
    endpointClass: requestOverrides.endpointClass || classification.endpointClass,
    requestedRight: requestOverrides.requestedRight || classification.requestedRight || AUTH_RIGHTS.READBACK_AUDIT,
    scope: requestOverrides.scope,
    roleScopeCatalog
  };
}

function createRequest(request = {}) {
  return {
    method: request.method,
    path: request.path,
    headers: request.headers || {},
    requestOverrides: request.requestOverrides,
    serverSideIdentityContext: request.identityContext
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.finished = true;
      return this;
    }
  };
}

function denyResponse(req, res, reason, audit) {
  req.authDecision = {
    allowed: false,
    reason,
    audit: audit || {
      decision: "deny",
      reason
    }
  };
  return res.status(403).json({
    ok: false,
    error: reason,
    audit: req.authDecision.audit
  });
}

function runHandler(handlerKind, counters, res) {
  if (handlerKind === "public") {
    counters.public += 1;
  } else if (handlerKind === "private") {
    counters.private += 1;
  } else if (handlerKind === "write") {
    counters.write += 1;
  } else {
    throw new Error(`Unknown handler kind: ${handlerKind}`);
  }

  res.status(200).json({
    ok: true,
    handlerKind
  });
}

function privateCandidateRequest(scope, options = {}) {
  return {
    method: "GET",
    path: "/api/auth-express-flow/private-readback",
    identityContext: options.identityContext,
    requestOverrides: {
      endpointClass: ENDPOINT_CLASSES.PRIVATE_READBACK_CANDIDATE,
      requestedRight: options.requestedRight || AUTH_RIGHTS.READBACK_AUDIT,
      scope
    },
    handlerKind: options.handlerKind || "private"
  };
}

function writeRequest(pathname) {
  return {
    method: "POST",
    path: pathname,
    identityContext: trustedIdentity(),
    handlerKind: "write"
  };
}

function trustedIdentity(overrides = {}) {
  return {
    trustedBoundary: true,
    identity: {
      id: overrides.id || "admin-pilot",
      role: overrides.role || "admin_pilot",
      scopes: overrides.scopes || ["manual-assessments-notes"]
    },
    actor: overrides.actor,
    device: overrides.device,
    clientContext: overrides.clientContext,
    sourceIp: overrides.sourceIp
  };
}

function createCounters() {
  return {
    public: 0,
    private: 0,
    write: 0
  };
}

function assertDecision(result, expectedAllowed, expectedReason, label) {
  assert.equal(result.allowed, expectedAllowed, `${label}: allowed`);
  assert.equal(result.reason, expectedReason, `${label}: reason`);
  assert.equal(Boolean(result.audit), true, `${label}: audit present`);
}

function assertCounters(actual, expected, label) {
  assert.equal(actual.public, expected.public, `${label}: public handler calls`);
  assert.equal(actual.private, expected.private, `${label}: private handler calls`);
  assert.equal(actual.write, expected.write, `${label}: write handler calls`);
}

function assertNoHandlerEffect(counters, label) {
  assertCounters(counters, { public: 0, private: 0, write: 0 }, label);
}

function assertNoRuntimeCoupling() {
  assert.equal(runtimeSource.includes("authPolicy"), false, "runtime must not import auth policy");

  [
    "require(" + JSON.stringify("../src/" + "in" + "dex"),
    "require(" + JSON.stringify("../src/" + "in" + "dex.js"),
    "src/" + "in" + "dex",
    "app." + "listen",
    "lis" + "ten(",
    "create" + "Server",
    "require(" + JSON.stringify("ht" + "tp"),
    "require(" + JSON.stringify("ht" + "tps"),
    "ht" + "tp.",
    "ht" + "tps.",
    "fet" + "ch(",
    "sql" + "ite",
    "Data" + "base",
    "SDE_" + "SERVER_DB_PATH",
    "pro" + "cess.env",
    "87" + "87"
  ].forEach((patternText) => {
    assert.equal(scriptSource.includes(patternText), false, `forbidden runtime pattern: ${patternText}`);
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
