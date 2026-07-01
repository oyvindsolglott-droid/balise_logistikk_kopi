"use strict";

const assert = require("node:assert/strict");
const {
  ACCESS_RIGHTS,
  ENDPOINT_CATEGORIES,
  ENDPOINT_POLICY_CATALOG,
  HIGH_RISK_SCOPES,
  ROLE_KEYS,
  SHARED_WORKSPACE_SCOPES,
  decideAccess,
  decideEndpointAccess,
  getEndpointPolicy
} = require("../src/accessPolicy");

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
    assert.equal(policy[key], value, `${label}: expected ${key}=${value}`);
  }
}

function expectNoPolicy(label, method, path) {
  const policy = getEndpointPolicy({ method, path });
  assert.equal(policy, null, `${label}: expected no endpoint policy`);
}

assert.ok(
  ENDPOINT_POLICY_CATALOG.length >= 12,
  "endpoint policy catalog should cover current read/write categories"
);

expectPolicy("health endpoint is public status", "get", "/api/health", {
  endpointCategory: ENDPOINT_CATEGORIES.PUBLIC_STATUS,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("state revision endpoint is public status", "GET", "/api/state/revision", {
  endpointCategory: ENDPOINT_CATEGORIES.PUBLIC_STATUS,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("server status endpoint is read-only status", "GET", "/api/server/status", {
  endpointCategory: ENDPOINT_CATEGORIES.SERVER_STATUS_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("state endpoint is shared readback", "GET", "/api/state", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT
});

expectPolicy("events endpoint is shared readback", "GET", "/api/events", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT
});

expectPolicy("operational-state endpoint is shared readback", "GET", "/api/operational-state", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT
});

expectPolicy(
  "operational-state events endpoint is shared readback",
  "GET",
  "/api/operational-state/events?limit=20",
  {
    endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
    defaultRight: ACCESS_RIGHTS.READBACK_AUDIT
  }
);

expectPolicy("stream endpoint is shared readback", "GET", "/api/stream", {
  endpointCategory: ENDPOINT_CATEGORIES.SHARED_READBACK,
  defaultRight: ACCESS_RIGHTS.READBACK_AUDIT
});

expectPolicy("root frontend is static read", "GET", "/", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("app frontend is static read", "GET", "/app?role=sde", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("data file is static read", "GET", "/data/api_idag.json", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("asset file is static read", "GET", "/assets/logo.png", {
  endpointCategory: ENDPOINT_CATEGORIES.STATIC_READ,
  defaultRight: ACCESS_RIGHTS.READ_ONLY
});

expectPolicy("operational-state snapshot is production-pilot write category", "POST", "/api/operational-state/snapshot", {
  endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
  defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
});

expectPolicy("test note action is test-write category", "POST", "/api/actions/test-note", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE
});

expectPolicy("action contract test is test-write category", "POST", "/api/actions/action-contract-test", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE
});

expectPolicy("actions table test is test-write category", "POST", "/api/actions/actions-table-test", {
  endpointCategory: ENDPOINT_CATEGORIES.TEST_WRITE,
  defaultRight: ACCESS_RIGHTS.TEST_WRITE
});

expectPolicy("server-note action is production-pilot write category", "POST", "/api/actions/server-note", {
  endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
  defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
});

expectPolicy(
  "sde recommendation ack action is production-pilot write category",
  "POST",
  "/api/actions/sde-recommendation-ack",
  {
    endpointCategory: ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE,
    defaultRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
  }
);

expectNoPolicy("unknown endpoint is not classified", "GET", "/api/not-real");

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
  "shared readback helper requires identity",
  decideEndpointAccess({
    method: "GET",
    path: "/api/operational-state",
    scope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectAllowed(
  "shared readback helper allows explicit role and scope",
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

console.log("B46-C access-policy tests OK");
