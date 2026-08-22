"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AUTH_RIGHTS,
  ENDPOINT_CLASSES,
  HIGH_RISK_SCOPES,
  buildAuthAuditDecision,
  classifyEndpoint,
  evaluateAuthDecision,
  isTrustedIdentityContext,
  normalizeIdentityContext
} = require("../src/authPolicy");
const identityPolicy = require("../src/identityPolicy");

const AUTH_POLICY_PATH = path.resolve(__dirname, "../src/authPolicy.js");
const RUNTIME_PATH = path.resolve(__dirname, "../src/index.js");
const authPolicySource = fs.readFileSync(AUTH_POLICY_PATH, "utf8");

assert.equal(require.cache[RUNTIME_PATH], undefined, "authPolicy test must not load server runtime");
assertNoRuntimeStrings();

const catalog = identityPolicy.ROLE_SCOPE_MATRIX;

assertEndpoint("public health", "GET", "/api/health", ENDPOINT_CLASSES.PUBLIC_READ_ONLY);
assertEndpoint("public revision", "GET", "/api/state/revision", ENDPOINT_CLASSES.PUBLIC_READ_ONLY);
assertEndpoint("server status", "GET", "/api/server/status", ENDPOINT_CLASSES.PUBLIC_READ_ONLY);
assertEndpoint("Tursatt live arrivals", "GET", "/api/tursatt/live-arrivals?date=2026-08-22", ENDPOINT_CLASSES.PUBLIC_READ_ONLY);
assertEndpoint("state review-needed", "GET", "/api/state", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("events review-needed", "GET", "/api/events?sinceRevision=1", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("operational readback review-needed", "GET", "/api/operational-state", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("operational events review-needed", "GET", "/api/operational-state/events", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("stream review-needed", "GET", "/api/stream", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("root static review-needed", "GET", "/", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("app static review-needed", "GET", "/app", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("data static review-needed", "GET", "/data/api_idag.json", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("asset static review-needed", "GET", "/assets/slot_track_empty.png", ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY);
assertEndpoint("post snapshot blocked", "POST", "/api/operational-state/snapshot", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("post test note blocked", "POST", "/api/actions/test-note", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("post action contract blocked", "POST", "/api/actions/action-contract-test", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("post actions table blocked", "POST", "/api/actions/actions-table-test", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("post server note blocked", "POST", "/api/actions/server-note", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("post ack blocked", "POST", "/api/actions/sde-recommendation-ack", ENDPOINT_CLASSES.WRITE_BLOCKED);
assertEndpoint("unknown endpoint default deny", "GET", "/api/not-real", ENDPOINT_CLASSES.UNKNOWN);
assertEndpoint("unknown method default deny", "PATCH", "/api/health", ENDPOINT_CLASSES.UNKNOWN);

assertDecision(
  "public endpoint allowed without private identity",
  evaluateAuthDecision({}, {
    method: "GET",
    path: "/api/health",
    requestedRight: AUTH_RIGHTS.READ_ONLY
  }),
  true,
  "public_read_allowed"
);

assertDecision(
  "review-needed endpoint does not become private allow",
  evaluateAuthDecision(trustedAdmin(), {
    method: "GET",
    path: "/api/operational-state",
    requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
    scope: "manual-assessments-notes",
    roleScopeCatalog: catalog
  }),
  false,
  "review_needed_not_private_runtime"
);

assertDecision(
  "missing identity denied for private readback",
  evaluateAuthDecision({}, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "trusted boundary absent denies private readback",
  evaluateAuthDecision({
    identity: {
      id: "admin-pilot",
      role: "admin_pilot",
      scopes: ["manual-assessments-notes"]
    }
  }, privateReadbackRequest()),
  false,
  "trusted_boundary_required"
);

assertDecision(
  "unknown role deny",
  evaluateAuthDecision({
    trustedBoundary: true,
    identity: {
      id: "ghost",
      role: "ghost_role",
      scopes: ["manual-assessments-notes"]
    }
  }, privateReadbackRequest()),
  false,
  "unknown_role"
);

assertDecision(
  "unknown scope deny",
  evaluateAuthDecision(trustedAdmin(["unknown-scope"]), {
    ...privateReadbackRequest(),
    scope: "unknown-scope"
  }),
  false,
  "unknown_scope"
);

assertDecision(
  "wrong role denied",
  evaluateAuthDecision({
    trustedBoundary: true,
    identity: {
      id: "agila",
      role: "agila",
      scopes: ["manual-assessments-notes"]
    }
  }, privateReadbackRequest()),
  false,
  "role_scope_not_allowed"
);

assertDecision(
  "identity without assigned scope denied",
  evaluateAuthDecision(trustedAdmin(["sporplan-readback"]), privateReadbackRequest()),
  false,
  "identity_scope_not_assigned"
);

assertDecision(
  "allowed role allowed readback only",
  evaluateAuthDecision(trustedAdmin(), privateReadbackRequest()),
  true,
  "readback_allowed"
);

assertDecision(
  "write denied even with allowed readback role",
  evaluateAuthDecision(trustedAdmin(), {
    ...privateReadbackRequest(),
    requestedRight: AUTH_RIGHTS.WRITE
  }),
  false,
  "write_denied"
);

assertDecision(
  "production-write denied",
  evaluateAuthDecision(trustedAdmin(), {
    ...privateReadbackRequest(),
    requestedRight: AUTH_RIGHTS.PRODUCTION_WRITE
  }),
  false,
  "write_denied"
);

assertDecision(
  "operational authority denied",
  evaluateAuthDecision(trustedAdmin(), {
    ...privateReadbackRequest(),
    requestedRight: AUTH_RIGHTS.OPERATIONAL_AUTHORITY
  }),
  false,
  "operational_authority_denied"
);

assertDecision(
  "spoofed headers denied as identity",
  evaluateAuthDecision({
    clientHeaders: {
      "x-sde-role": "admin_pilot",
      "x-sde-user": "spoofed"
    }
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "actor not identity",
  evaluateAuthDecision({
    actor: {
      id: "claimed-admin",
      role: "admin_pilot"
    }
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "device not identity",
  evaluateAuthDecision({
    device: {
      id: "claimed-device"
    }
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "clientContext not identity",
  evaluateAuthDecision({
    clientContext: {
      role: "admin_pilot"
    }
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "local LAN not identity",
  evaluateAuthDecision({
    localLan: true,
    role: "admin_pilot"
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

assertDecision(
  "trusted boundary marker without identity still denied",
  evaluateAuthDecision({
    trustedBoundary: true,
    role: "admin_pilot"
  }, privateReadbackRequest()),
  false,
  "missing_identity"
);

HIGH_RISK_SCOPES.forEach((scope) => {
  const highRiskCatalog = {
    admin_pilot: {
      [scope]: [AUTH_RIGHTS.READBACK_AUDIT]
    }
  };
  assertDecision(
    `high-risk scope ${scope} denied even if catalog allows`,
    evaluateAuthDecision(trustedAdmin([scope]), {
      ...privateReadbackRequest(),
      scope,
      roleScopeCatalog: highRiskCatalog
    }),
    false,
    "high_risk_scope_denied"
  );
});

const normalized = normalizeIdentityContext({
  trustedBoundary: true,
  identity: {
    id: "admin-pilot",
    role: "admin_pilot",
    scopes: ["manual-assessments-notes"]
  },
  actor: {
    id: "operator-claim",
    role: "agila"
  },
  device: {
    id: "browser-claim"
  },
  clientContext: {
    source: "ui"
  },
  sourceIp: "127.0.0.1",
  localNetworkMetadata: {
    network: "local"
  },
  clientHeaders: {
    "x-sde-role": "agila"
  },
  frontendDataLevel: "admin"
});

assert.equal(isTrustedIdentityContext(normalized), true, "trusted context should require explicit identity and boundary");
assert.equal(normalized.authenticatedIdentityId, "admin-pilot");
assert.equal(normalized.role, "admin_pilot");
assert.equal(normalized.actor.role, "agila");
assert.equal(normalized.untrustedClientFields.frontendDataLevel, "admin");

const audit = buildAuthAuditDecision({
  identityContext: normalized,
  requestContext: privateReadbackRequest(),
  allowed: true,
  reason: "readback_allowed"
});
assert.equal(audit.authenticatedIdentityId, "admin-pilot");
assert.equal(audit.actor.id, "operator-claim");
assert.equal(audit.device.id, "browser-claim");
assert.equal(audit.actorIsIdentity, false);
assert.equal(audit.deviceIsIdentity, false);
assert.equal(audit.clientContextIsIdentity, false);
assert.equal(audit.decision, "allow");

assert.equal(require.cache[RUNTIME_PATH], undefined, "test must still not load server runtime");

console.log("B48-B auth-policy tests OK");

function privateReadbackRequest() {
  return {
    method: "GET",
    path: "/api/operational-state/events",
    endpointClass: ENDPOINT_CLASSES.PRIVATE_READBACK_CANDIDATE,
    requestedRight: AUTH_RIGHTS.READBACK_AUDIT,
    scope: "manual-assessments-notes",
    roleScopeCatalog: catalog
  };
}

function trustedAdmin(scopes = ["manual-assessments-notes"]) {
  return {
    trustedBoundary: true,
    identity: {
      id: "admin-pilot",
      role: "admin_pilot",
      scopes
    }
  };
}

function assertEndpoint(label, method, rawPath, expectedClass) {
  const result = classifyEndpoint(method, rawPath);
  assert.equal(result.endpointClass, expectedClass, `${label}: endpointClass`);
}

function assertDecision(label, decision, expectedAllowed, expectedReason) {
  assert.equal(decision.allowed, expectedAllowed, `${label}: allowed`);
  assert.equal(decision.reason, expectedReason, `${label}: reason`);
  assert.equal(Boolean(decision.audit), true, `${label}: audit present`);
}

function assertNoRuntimeStrings() {
  const forbidden = /express|http|https|sqlite|Database|fetch\(|listen\(|app\.|router\.|process\.env|cookie|jwt|token|session/;
  assert.equal(forbidden.test(authPolicySource), false, "authPolicy must stay free of runtime/session dependencies");
}
