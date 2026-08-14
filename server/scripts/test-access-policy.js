"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ACCESS_RIGHTS,
  ENDPOINT_CATEGORIES,
  ENDPOINT_POLICY_CATALOG,
  HIGH_RISK_SCOPES,
  READBACK_CLASSES,
  ROLE_KEYS,
  SHARED_WORKSPACE_SCOPES,
  STATIC_RESOURCE_KINDS,
  decideAccess,
  decideEndpointAccess,
  getEndpointPolicy,
  getReadbackClassification
} = require("../src/accessPolicy");

const INDEX_FILE = path.resolve(__dirname, "..", "src", "index.js");

const identity = Object.freeze({
  id: "b46-policy-test-user",
  role: ROLE_KEYS.ADMIN_PILOT
});

function expectAllowed(label, decision, expected = {}) {
  assert.equal(decision.allowed, true, `${label}: expected allow, got ${decision.reason}`);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(decision[key], value, `${label}: expected ${key}=${value}`);
  }
}

function expectDenied(label, decision, reason) {
  assert.equal(decision.allowed, false, `${label}: expected deny`);
  assert.equal(decision.reason, reason, `${label}: unexpected deny reason`);
}

function expectPolicy(label, method, path, expected = {}) {
  const policy = getEndpointPolicy({ method, path });
  assert.ok(policy, `${label}: expected endpoint policy`);
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      assert.deepEqual(policy[key], value, `${label}: expected ${key}=${value}`);
      continue;
    }
    assert.equal(policy[key], value, `${label}: expected ${key}=${value}`);
  }
}

function expectNoPolicy(label, method, path) {
  const policy = getEndpointPolicy({ method, path });
  assert.equal(policy, null, `${label}: expected no endpoint policy`);
}

assert.ok(
  ENDPOINT_POLICY_CATALOG.length >= 18,
  "endpoint policy catalog should cover current read/write and preflight categories"
);

expectPolicy("health endpoint is public status", "get", "/api/health", {
  endpointCategory: ENDPOINT_CATEGORIES.PUBLIC_STATUS,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  readbackClass: READBACK_CLASSES.PUBLIC_STATUS
});

expectPolicy("state revision endpoint is public status", "GET", "/api/state/revision", {
  endpointCategory: ENDPOINT_CATEGORIES.PUBLIC_STATUS,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  readbackClass: READBACK_CLASSES.PUBLIC_STATUS
});

expectPolicy("server status endpoint is read-only status", "GET", "/api/server/status", {
  endpointCategory: ENDPOINT_CATEGORIES.SERVER_STATUS_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  readbackClass: READBACK_CLASSES.SHARED_NON_SENSITIVE_READBACK
});

expectPolicy("state endpoint is scope-risk readback", "GET", "/api/state", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT,
  readbackClass: READBACK_CLASSES.SCOPE_RESTRICTED_READBACK,
  requiresScopeBeforePrivateData: true
});

expectPolicy("events endpoint is private audit readback", "GET", "/api/events", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT,
  readbackClass: READBACK_CLASSES.PRIVATE_AUDIT_READBACK,
  requiresScopeBeforePrivateData: true
});

expectPolicy("operational-state endpoint is shared readback", "GET", "/api/operational-state", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT,
  readbackClass: READBACK_CLASSES.SHARED_NON_SENSITIVE_READBACK,
  requiresScopeBeforePrivateData: true
});

expectPolicy(
  "operational-state events endpoint is audit readback",
  "GET",
  "/api/operational-state/events?limit=20",
  {
    endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
    defaultRight: ACCESS_RIGHTS.READBACK_AUDIT,
    readbackClass: READBACK_CLASSES.PRIVATE_AUDIT_READBACK,
    requiresScopeBeforePrivateData: true
  }
);

expectPolicy("stream endpoint is read stream/readback", "GET", "/api/stream", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT,
  readbackClass: READBACK_CLASSES.SHARED_NON_SENSITIVE_READBACK,
  readStream: true,
  writeEndpoint: false
});

assert.equal(
  getReadbackClassification({ method: "GET", path: "/api/state" }),
  READBACK_CLASSES.SCOPE_RESTRICTED_READBACK,
  "readback classification helper should classify /api/state"
);

assert.equal(
  getReadbackClassification({ method: "GET", path: "/api/events" }),
  READBACK_CLASSES.PRIVATE_AUDIT_READBACK,
  "readback classification helper should classify /api/events"
);

expectPolicy("health preflight is CORS/preflight", "OPTIONS", "/api/health", {
  endpointCategory: ENDPOINT_CATEGORIES.CORS_PREFLIGHT,
  defaultRight: ACCESS_RIGHTS.NO_ACCESS,
  transportOnly: true,
  corsPreflight: true,
  corsIsAuth: false,
  writeEndpoint: false
});

expectPolicy("events preflight is CORS/preflight", "OPTIONS", "/api/events", {
  endpointCategory: ENDPOINT_CATEGORIES.CORS_PREFLIGHT,
  defaultRight: ACCESS_RIGHTS.NO_ACCESS,
  transportOnly: true,
  corsPreflight: true,
  corsIsAuth: false,
  readbackClass: READBACK_CLASSES.PRIVATE_AUDIT_READBACK
});

expectDenied(
  "known CORS preflight does not become auth",
  decideEndpointAccess({
    method: "OPTIONS",
    path: "/api/health"
  }),
  "cors_preflight_not_auth"
);

expectDenied(
  "CORS preflight does not grant readback",
  decideEndpointAccess({
    method: "OPTIONS",
    path: "/api/events",
    identity,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "cors_preflight_not_auth"
);

expectDenied(
  "CORS preflight does not grant private endpoint access",
  decideEndpointAccess({
    method: "OPTIONS",
    path: "/api/events",
    identity,
    requestedRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "cors_preflight_not_auth"
);

expectNoPolicy("unknown OPTIONS path is not classified", "OPTIONS", "/api/not-real");

expectDenied(
  "unknown OPTIONS path denied",
  decideEndpointAccess({
    method: "OPTIONS",
    path: "/api/not-real",
    identity,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "unknown_endpoint"
);

expectPolicy("root frontend is static frontend", "GET", "/", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_FRONTEND,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.FRONTEND
});

expectPolicy("app frontend is static frontend", "GET", "/app?role=sde", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_FRONTEND,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.FRONTEND
});

expectPolicy("allowlisted data file is static data", "GET", "/data/api_idag.json", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_DATA_ALLOWLISTED,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.DATA_ALLOWLISTED,
  requiresRuntimeAllowlist: true,
  privateDataAllowed: false
});

expectPolicy("allowlisted asset file is static asset", "GET", "/assets/slot_track_empty.png", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_ASSET,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.ASSET,
  requiresRuntimeAllowlist: true
});

expectPolicy("Tursatt button graphic is an allowlisted static asset", "GET", "/assets/tursatt-button.png", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_ASSET,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.ASSET,
  requiresRuntimeAllowlist: true
});

expectPolicy("Registrer Plan i SDE graphic is an allowlisted static asset", "GET", "/assets/registrer-plan-i-sde-button.png", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_ASSET,
  defaultRight: ACCESS_RIGHTS.READ_ONLY,
  staticKind: STATIC_RESOURCE_KINDS.ASSET,
  requiresRuntimeAllowlist: true
});

assert.match(
  fs.readFileSync(INDEX_FILE, "utf8"),
  /\["tursatt-button\.png", path\.join\(REPO_ROOT, "assets", "tursatt-button\.png"\)\]/,
  "production server must serve the Tursatt button graphic from the static asset allowlist"
);

assert.match(
  fs.readFileSync(INDEX_FILE, "utf8"),
  /\["registrer-plan-i-sde-button\.png", path\.join\(REPO_ROOT, "assets", "registrer-plan-i-sde-button\.png"\)\]/,
  "production server must serve the exact Registrer Plan i SDE graphic from the static asset allowlist"
);

expectNoPolicy("unknown data file is not classified", "GET", "/data/private.json");
expectNoPolicy("unknown asset file is not classified", "GET", "/assets/private.png");
expectNoPolicy("unknown static path is not classified", "GET", "/static/private.json");

expectAllowed(
  "static frontend can be read-only without becoming identity",
  decideEndpointAccess({
    method: "GET",
    path: "/"
  }),
  {
    reason: "static_read_allowed",
    matchedRight: ACCESS_RIGHTS.READ_ONLY
  }
);

expectDenied(
  "static data does not grant private readback access",
  decideEndpointAccess({
    method: "GET",
    path: "/data/api_idag.json",
    identity,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "static_read_only_only"
);

expectDenied(
  "static asset does not grant write",
  decideEndpointAccess({
    method: "GET",
    path: "/assets/slot_track_empty.png",
    identity,
    requestedRight: ACCESS_RIGHTS.TEST_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "static_read_only_only"
);

expectPolicy("operational-state snapshot is production-pilot write category", "POST", "/api/operational-state/snapshot", {
  endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
  defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
  writeEndpoint: true
});

expectPolicy("test note action is test-write category", "POST", "/api/actions/test-note", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE,
  writeEndpoint: true
});

expectPolicy("action contract test is test-write category", "POST", "/api/actions/action-contract-test", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE,
  writeEndpoint: true
});

expectPolicy("actions table test is test-write category", "POST", "/api/actions/actions-table-test", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE,
  writeEndpoint: true
});

expectPolicy("server-note action is production-pilot write category", "POST", "/api/actions/server-note", {
  endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
  defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
  writeEndpoint: true
});

expectPolicy(
  "sde recommendation ack action is production-pilot write category",
  "POST",
  "/api/actions/sde-recommendation-ack",
  {
    endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
    defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
    writeEndpoint: true
  }
);

expectNoPolicy("unknown endpoint is not classified", "GET", "/api/not-real");
expectNoPolicy("unknown method is not classified", "PATCH", "/api/health");

expectDenied(
  "unknown endpoint decision denied",
  decideEndpointAccess({
    method: "GET",
    path: "/api/not-real",
    identity,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "unknown_endpoint"
);

expectAllowed(
  "public status allowed without identity through endpoint helper",
  decideEndpointAccess({
    method: "GET",
    path: "/api/health"
  }),
  {
    reason: "public_status_allowed",
    matchedRight: ACCESS_RIGHTS.READ_ONLY
  }
);

expectDenied(
  "public status cannot be upgraded to readback",
  decideEndpointAccess({
    method: "GET",
    path: "/api/health",
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }),
  "public_status_read_only_only"
);

expectDenied(
  "scope-risk readback requires scope before private data",
  decideEndpointAccess({
    method: "GET",
    path: "/api/state",
    identity
  }),
  "missing_scope"
);

expectDenied(
  "shared readback helper requires identity when scope is present",
  decideEndpointAccess({
    method: "GET",
    path: "/api/operational-state",
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectAllowed(
  "manual-assessments-notes readback requires explicit scope and role",
  decideEndpointAccess({
    method: "GET",
    path: "/api/operational-state/events",
    identity,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  {
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    role: ROLE_KEYS.ADMIN_PILOT
  }
);

expectDenied(
  "readback endpoint helper does not grant write",
  decideEndpointAccess({
    method: "GET",
    path: "/api/operational-state/events",
    identity,
    requestedRight: ACCESS_RIGHTS.TEST_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "insufficient_right"
);

expectDenied(
  "write endpoint helper does not grant production-pilot write",
  decideEndpointAccess({
    method: "POST",
    path: "/api/operational-state/snapshot",
    identity,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "insufficient_right"
);

expectDenied(
  "default deny for restricted readback without identity",
  decideAccess({
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "missing_identity"
);

expectAllowed(
  "public status allowed without identity",
  decideAccess({
    endpointCategory: ENDPOINT_CATEGORIES.PUBLIC_STATUS
  }),
  {
    reason: "public_status_allowed",
    matchedRight: ACCESS_RIGHTS.READ_ONLY
  }
);

expectDenied(
  "restricted readback denied without identity",
  decideAccess({
    endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "missing_identity"
);

expectDenied(
  "empty identity denied",
  decideAccess({
    identity: { id: " " },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "missing_identity"
);

expectDenied(
  "identity without role denied",
  decideAccess({
    identity: { id: "no-role-user" },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "missing_role"
);

expectDenied(
  "unknown role denied",
  decideAccess({
    identity: { id: "unknown-role-user" },
    role: "ghost_role",
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "unknown_role"
);

expectDenied(
  "known role without scope denied",
  decideAccess({
    identity: { id: "agila-user", role: ROLE_KEYS.AGILA },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }),
  "missing_scope"
);

expectAllowed(
  "Agila has sporplan readback",
  decideAccess({
    identity: { id: "agila-user", role: ROLE_KEYS.AGILA },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  {
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    role: ROLE_KEYS.AGILA
  }
);

expectAllowed(
  "known role with scope allowed",
  decideAccess({
    identity: { id: "txp-user", role: ROLE_KEYS.TXP },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS
  }),
  {
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    role: ROLE_KEYS.TXP
  }
);

expectDenied(
  "Agila has no manual-assessments-notes readback",
  decideAccess({
    identity: { id: "agila-user", role: ROLE_KEYS.AGILA },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "role_scope_not_allowed"
);

expectDenied(
  "TXP has no manual-assessments-notes readback by default",
  decideAccess({
    identity: { id: "txp-user", role: ROLE_KEYS.TXP },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "role_scope_not_allowed"
);

expectAllowed(
  "Admin/pilot has explicit manual-assessments-notes readback",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  {
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }
);

expectDenied(
  "Admin/pilot readback does not grant admin-pilot right",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.ADMIN_PILOT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "insufficient_right"
);

expectDenied(
  "actor/device alone does not grant identity",
  decideAccess({
    actor: { id: "actor-only", role: ROLE_KEYS.ADMIN_PILOT },
    device: { id: "device-only" },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectAllowed(
  "actor/device mismatch does not override authenticated role",
  decideAccess({
    identity,
    actor: { id: "claimed-agila", role: ROLE_KEYS.AGILA },
    device: { id: "claimed-device" },
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  {
    role: ROLE_KEYS.ADMIN_PILOT,
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }
);

for (const scope of Object.values(HIGH_RISK_SCOPES)) {
  expectDenied(
    `high-risk scope ${scope} denied`,
    decideAccess({
      identity,
      endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
      requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
      scope
    }),
    "high_risk_scope_default_denied"
  );
}

expectDenied(
  "operational_authority requestedRight denied",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.OPERATIONAL_AUTHORITY,
    requestedRight: ACCESS_RIGHTS.OPERATIONAL_AUTHORITY,
    scope: HIGH_RISK_SCOPES.OPERATIONAL_AUTHORITY_STATE
  }),
  "operational_authority_not_opened"
);

expectDenied(
  "production-pilot-write denied by default",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
    requestedRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "insufficient_right"
);

expectDenied(
  "test-write not allowed for read-only role",
  decideAccess({
    identity: { id: "txp-user", role: ROLE_KEYS.TXP },
    endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
    requestedRight: ACCESS_RIGHTS.TEST_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS
  }),
  "insufficient_right"
);

expectDenied(
  "shared-workspace-audit-log is not writable",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
    requestedRight: ACCESS_RIGHTS.TEST_WRITE,
    scope: SHARED_WORKSPACE_SCOPES.SHARED_WORKSPACE_AUDIT_LOG
  }),
  "insufficient_right"
);

expectDenied(
  "unknown scope denied",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: "unknown-scope"
  }),
  "unknown_scope"
);

expectDenied(
  "unknown endpointCategory denied",
  decideAccess({
    identity,
    endpointCategory: "unknown_endpoint",
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "unknown_endpoint_category"
);

expectDenied(
  "unknown requestedRight denied",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: "superuser",
    scope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "unknown_requested_right"
);

console.log("B46-F access-policy tests OK");
