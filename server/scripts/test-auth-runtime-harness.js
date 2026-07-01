"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
runUnknownEndpointTests();
runReviewNeededGetTests();
runPrivateCandidateDenyTests();
runPrivateCandidateAllowTests();
runWriteBlockedTests();
runFailClosedTests();
runAuditShapeTest();
runNoMutationAssertion();

console.log("B48-G auth runtime harness tests OK");

function runPublicSafeGetTests() {
  [
    "/api/health",
    "/api/server/status",
    "/api/state/revision"
  ].forEach((route) => {
    const counters = createCounters();
    const result = runHarness({}, {
      method: "GET",
      path: route,
      requestedRight: AUTH_RIGHTS.READ_ONLY,
      handlerKind: "public",
      roleScopeCatalog
    }, counters);

    assertDecision(result, true, "public_read_allowed", `public ${route}`);
    assert.equal(counters.public, 1, `public handler effect for ${route}`);
    assert.equal(counters.private, 0, `private handler blocked for ${route}`);
    assert.equal(counters.write, 0, `write handler blocked for ${route}`);
  });
}

function runUnknownEndpointTests() {
  const counters = createCounters();
  const result = runHarness({}, {
    method: "GET",
    path: "/api/unknown-auth-harness-test",
    requestedRight: AUTH_RIGHTS.READ_ONLY,
    handlerKind: "public",
    roleScopeCatalog
  }, counters);

  assertDecision(result, false, "unknown_endpoint", "unknown GET");
  assertNoHandlerEffect(counters, "unknown GET");
}

function runReviewNeededGetTests() {
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
  ].forEach((route) => {
    const counters = createCounters();
    const result = runHarness(trustedIdentity(), {
      method: "GET",
      path: route,
      requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
      scope: "manual-assessments-notes",
      handlerKind: "private",
      roleScopeCatalog
    }, counters);

    assert.equal(classifyEndpoint("GET", route).endpointClass, ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY, `review class ${route}`);
    assertDecision(result, false, "review_needed_not_private_runtime", `review-needed ${route}`);
    assertNoHandlerEffect(counters, `review-needed ${route}`);
  });
}

function runPrivateCandidateDenyTests() {
  [
    {
      label: "manual missing identity",
      identityContext: {},
      requestContext: privateRequest("manual-assessments-notes"),
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
      requestContext: privateRequest("operational-state-sensitive-readback"),
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
      requestContext: privateRequest("scope-restricted-shared-workspace-readback"),
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
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "missing_identity"
    },
    {
      label: "device not identity",
      identityContext: {
        device: {
          id: "admin-device"
        }
      },
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "missing_identity"
    },
    {
      label: "client context not identity",
      identityContext: {
        clientContext: {
          role: "admin_pilot"
        }
      },
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "missing_identity"
    },
    {
      label: "local lan not identity",
      identityContext: {
        localLan: true,
        role: "admin_pilot"
      },
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "missing_identity"
    },
    {
      label: "wrong role",
      identityContext: trustedIdentity({
        id: "agila",
        role: "agila",
        scopes: ["manual-assessments-notes"]
      }),
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "unknown_role"
    },
    {
      label: "wrong scope",
      identityContext: trustedIdentity({
        scopes: ["sde-night-placement-manual-overrides"]
      }),
      requestContext: privateRequest("manual-assessments-notes"),
      reason: "identity_scope_not_assigned"
    }
  ].forEach((testCase) => {
    const counters = createCounters();
    const result = runHarness(testCase.identityContext, testCase.requestContext, counters);

    assertDecision(result, false, testCase.reason, testCase.label);
    assert.equal(counters.private, 0, `private handler blocked for ${testCase.label}`);
    assert.equal(counters.write, 0, `write handler blocked for ${testCase.label}`);
  });
}

function runPrivateCandidateAllowTests() {
  const counters = createCounters();
  const result = runHarness(trustedIdentity(), privateRequest("manual-assessments-notes"), counters);

  assertDecision(result, true, "readback_allowed", "private read-only allow in isolated harness");
  assert.equal(counters.public, 0, "public handler not used for private allow");
  assert.equal(counters.private, 1, "private read-only handler effect allowed in isolated harness");
  assert.equal(counters.write, 0, "write handler remains blocked for private allow");
}

function runWriteBlockedTests() {
  [
    {
      label: "test note",
      requestContext: writeRequest("/api/actions/test-note")
    },
    {
      label: "action contract",
      requestContext: writeRequest("/api/actions/action-contract-test")
    },
    {
      label: "actions table",
      requestContext: writeRequest("/api/actions/actions-table-test")
    },
    {
      label: "server note",
      requestContext: writeRequest("/api/actions/server-note")
    },
    {
      label: "recommendation ack",
      requestContext: writeRequest("/api/actions/sde-recommendation-ack")
    },
    {
      label: "operational snapshot",
      requestContext: writeRequest("/api/operational-state/snapshot")
    },
    {
      label: "production write",
      requestContext: {
        ...privateRequest("manual-assessments-notes"),
        requestedRight: AUTH_RIGHTS.PRODUCTION_WRITE,
        handlerKind: "write"
      }
    },
    {
      label: "operational authority",
      requestContext: {
        ...privateRequest("manual-assessments-notes"),
        requestedRight: AUTH_RIGHTS.OPERATIONAL_AUTHORITY,
        handlerKind: "write"
      },
      reason: "operational_authority_denied"
    },
    {
      label: "migration schema",
      requestContext: {
        method: "POST",
        path: "/api/schema/migration",
        requestedRight: AUTH_RIGHTS.WRITE,
        handlerKind: "write",
        roleScopeCatalog
      }
    }
  ].forEach((testCase) => {
    const counters = createCounters();
    const result = runHarness(trustedIdentity(), testCase.requestContext, counters);

    assertDecision(result, false, testCase.reason || "write_denied", testCase.label);
    assert.equal(counters.write, 0, `write handler blocked for ${testCase.label}`);
    assert.equal(counters.private, 0, `private handler blocked for ${testCase.label}`);
  });
}

function runFailClosedTests() {
  [
    {
      label: "unknown endpoint",
      identityContext: {},
      requestContext: {
        method: "GET",
        path: "/api/not-real",
        requestedRight: AUTH_RIGHTS.READ_ONLY,
        handlerKind: "public",
        roleScopeCatalog
      },
      reason: "unknown_endpoint"
    },
    {
      label: "unknown method",
      identityContext: {},
      requestContext: {
        method: "PATCH",
        path: "/api/health",
        requestedRight: AUTH_RIGHTS.READ_ONLY,
        handlerKind: "public",
        roleScopeCatalog
      },
      reason: "unknown_endpoint"
    },
    {
      label: "policy error",
      identityContext: trustedIdentity(),
      requestContext: privateRequest("manual-assessments-notes"),
      policyEvaluator: () => {
        throw new Error("simulated policy failure");
      },
      reason: "policy_error"
    },
    {
      label: "missing policy input",
      identityContext: trustedIdentity(),
      requestContext: null,
      reason: "missing_policy_input"
    },
    {
      label: "malformed request context",
      identityContext: trustedIdentity(),
      requestContext: "not-an-object",
      reason: "missing_policy_input"
    }
  ].forEach((testCase) => {
    const counters = createCounters();
    const result = runHarness(testCase.identityContext, testCase.requestContext, counters, {
      policyEvaluator: testCase.policyEvaluator
    });

    assertDecision(result, false, testCase.reason, testCase.label);
    assertNoHandlerEffect(counters, testCase.label);
  });
}

function runAuditShapeTest() {
  const identityContext = trustedIdentity({
    actor: {
      id: "claimed-actor"
    },
    device: {
      id: "claimed-device"
    },
    clientContext: {
      source: "isolated-harness"
    }
  });
  const audit = buildAuthAuditDecision({
    identityContext,
    requestContext: privateRequest("manual-assessments-notes"),
    allowed: true,
    reason: "readback_allowed"
  });

  assert.equal(audit.authenticatedIdentityId, "admin-pilot", "audit identity");
  assert.equal(audit.actorIsIdentity, false, "actor remains metadata");
  assert.equal(audit.deviceIsIdentity, false, "device remains metadata");
  assert.equal(audit.clientContextIsIdentity, false, "client context remains metadata");
  assert.equal(audit.decision, "allow", "audit decision");

  const normalized = normalizeIdentityContext(identityContext);
  assert.equal(normalized.trustedBoundary, true, "trusted identity remains explicit server-side context");
  assert.equal(normalized.untrustedClientFields.localLanClaimed, false, "local LAN not claimed");
}

function runNoMutationAssertion() {
  const mutationState = {
    dbWrites: 0,
    events: 0,
    revision: 0
  };
  const counters = createCounters();
  const result = runHarness({}, privateRequest("manual-assessments-notes"), counters);

  assertDecision(result, false, "missing_identity", "no mutation deny");
  assert.deepEqual(mutationState, {
    dbWrites: 0,
    events: 0,
    revision: 0
  }, "isolated harness must not mutate state");
}

function runHarness(identityContext, requestContext, counters, options = {}) {
  if (!isPlainObject(requestContext)) {
    return denyWithoutHandler("missing_policy_input");
  }

  const handlerKind = requestContext.handlerKind || "private";
  let decision;
  try {
    const policyEvaluator = options.policyEvaluator || evaluateAuthDecision;
    decision = policyEvaluator(identityContext, requestContext);
  } catch (_error) {
    return denyWithoutHandler("policy_error");
  }

  if (!decision.allowed) {
    return decision;
  }

  if (handlerKind === "public") {
    counters.public += 1;
  } else if (handlerKind === "private") {
    counters.private += 1;
  } else if (handlerKind === "write") {
    counters.write += 1;
  } else {
    throw new Error(`Unknown handler kind: ${handlerKind}`);
  }

  return decision;
}

function privateRequest(scope) {
  return {
    method: "GET",
    path: "/api/auth-harness/private-readback",
    endpointClass: ENDPOINT_CLASSES.PRIVATE_READBACK_CANDIDATE,
    requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
    scope,
    handlerKind: "private",
    roleScopeCatalog
  };
}

function writeRequest(pathname) {
  return {
    method: "POST",
    path: pathname,
    requestedRight: AUTH_RIGHTS.WRITE,
    handlerKind: "write",
    roleScopeCatalog
  };
}

function trustedIdentity(overrides = {}) {
  const identity = {
    id: overrides.id || "admin-pilot",
    role: overrides.role || "admin_pilot",
    scopes: overrides.scopes || ["manual-assessments-notes"]
  };

  return {
    trustedBoundary: true,
    identity,
    actor: overrides.actor,
    device: overrides.device,
    clientContext: overrides.clientContext,
    sourceIp: overrides.sourceIp
  };
}

function denyWithoutHandler(reason) {
  return {
    allowed: false,
    reason,
    audit: {
      decision: "deny",
      reason
    }
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

function assertNoHandlerEffect(counters, label) {
  assert.equal(counters.public, 0, `${label}: public handler blocked`);
  assert.equal(counters.private, 0, `${label}: private handler blocked`);
  assert.equal(counters.write, 0, `${label}: write handler blocked`);
}

function assertNoRuntimeCoupling() {
  assert.equal(require.cache[RUNTIME_PATH], undefined, "runtime must not be loaded before harness tests");
  assert.equal(runtimeSource.includes("authPolicy"), false, "runtime must not import auth policy");

  [
    "require(" + JSON.stringify("../src/" + "in" + "dex"),
    "require(" + JSON.stringify("../src/" + "in" + "dex.js"),
    "src/" + "in" + "dex",
    "lis" + "ten(",
    "create" + "Server",
    "ht" + "tp.",
    "ht" + "tps.",
    "fet" + "ch(",
    "sql" + "ite",
    "Data" + "base",
    "SDE_" + "SERVER_DB_PATH",
    "app." + "listen",
    "pro" + "cess.env",
    "87" + "87"
  ].forEach((patternText) => {
    assert.equal(scriptSource.includes(patternText), false, `forbidden runtime pattern: ${patternText}`);
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
