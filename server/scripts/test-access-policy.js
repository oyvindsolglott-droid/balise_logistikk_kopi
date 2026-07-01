"use strict";

const assert = require("node:assert/strict");
const {
  ACCESS_RIGHTS,
  ENDPOINT_CATEGORIES,
  HIGH_RISK_SCOPES,
  ROLE_KEYS,
  SHARED_WORKSPACE_SCOPES,
  decideAccess
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

expectDenied(
  "high-risk operational-authority-state denied",
  decideAccess({
    identity,
    endpointCategory: ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    scope: HIGH_RISK_SCOPES.OPERATIONAL_AUTHORITY_STATE
  }),
  "high_risk_scope_default_denied"
);

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

console.log("B46-A access-policy tests OK");
