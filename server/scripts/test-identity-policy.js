"use strict";

const assert = require("node:assert/strict");
const {
  ACCESS_RIGHTS,
  ENDPOINT_CLASSES,
  HIGH_RISK_SCOPES,
  IDENTITY_SOURCES,
  LOCAL_LAN_TRUST_MODEL,
  ROLE_KEYS,
  SHARED_WORKSPACE_SCOPES,
  decideIdentityAccess,
  resolveLocalLanIdentity
} = require("../src/identityPolicy");

const adminIdentity = Object.freeze({
  id: "admin-pilot-user",
  role: ROLE_KEYS.ADMIN_PILOT,
  scopes: [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]
});

function expectAllowed(label, decision, expected = {}) {
  assert.equal(decision.allowed, true, `${label}: expected allow, got ${decision.reason}`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(decision[key], value, `${label}: expected ${key}`);
  }
}

function expectDenied(label, decision, reason) {
  assert.equal(decision.allowed, false, `${label}: expected deny`);
  assert.equal(decision.reason, reason, `${label}: unexpected deny reason`);
}

assert.equal(LOCAL_LAN_TRUST_MODEL.designOnly, true, "Local/LAN model must be design-only");
assert.equal(LOCAL_LAN_TRUST_MODEL.externalSecurity, false, "Local/LAN model is not external security");
assert.equal(LOCAL_LAN_TRUST_MODEL.runtimeEnforcement, false, "Local/LAN model is not runtime enforcement");
assert.equal(LOCAL_LAN_TRUST_MODEL.middleware, false, "Local/LAN model is not middleware");
assert.equal(LOCAL_LAN_TRUST_MODEL.actorDeviceIsIdentity, false, "actor/device must not be identity");
assert.equal(LOCAL_LAN_TRUST_MODEL.frontendLevelsAreSecurity, false, "frontend levels must not be security");
assert.equal(LOCAL_LAN_TRUST_MODEL.operationalAuthority, false, "Local/LAN model must not open authority");

expectDenied(
  "no identity => restricted denied",
  decideIdentityAccess({
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectDenied(
  "null identity => restricted denied",
  decideIdentityAccess({
    identity: null,
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectDenied(
  "empty identity => restricted denied",
  decideIdentityAccess({
    identity: {},
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectDenied(
  "invalid identity => restricted denied",
  decideIdentityAccess({
    identity: "admin-pilot-user",
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "invalid_identity"
);

expectDenied(
  "unknown role => denied",
  decideIdentityAccess({
    identity: {
      id: "unknown-role-user",
      role: "ghost_role",
      scopes: [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]
    },
    requestedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "unknown_role"
);

expectDenied(
  "known role without assigned scope => denied",
  decideIdentityAccess({
    identity: {
      id: "agila-user",
      role: ROLE_KEYS.AGILA,
      scopes: []
    },
    requestedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  "identity_scope_not_assigned"
);

expectAllowed(
  "known role with scope => allow readback only",
  decideIdentityAccess({
    identity: {
      id: "agila-user",
      role: ROLE_KEYS.AGILA,
      scopes: [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]
    },
    requestedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }),
  {
    reason: "readback_allowed",
    role: ROLE_KEYS.AGILA,
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    matchedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }
);

expectDenied(
  "actor/device alone does not create identity",
  decideIdentityAccess({
    actor: { id: "actor-only", role: ROLE_KEYS.ADMIN_PILOT },
    device: { id: "device-only" },
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "actor_device_not_identity"
);

expectDenied(
  "spoofed actor/device => denied",
  resolveLocalLanIdentity({
    actor: { id: "claimed-admin", role: ROLE_KEYS.ADMIN_PILOT },
    device: { id: "claimed-device" }
  }),
  "actor_device_not_identity"
);

expectDenied(
  "spoofed frontend data-level => denied",
  decideIdentityAccess({
    dataLevel: "admin",
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "client_level_not_identity"
);

expectDenied(
  "spoofed client-level => denied",
  decideIdentityAccess({
    clientLevel: "admin",
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "client_level_not_identity"
);

expectDenied(
  "spoofed client header => denied without trusted boundary",
  decideIdentityAccess({
    clientHeader: "admin-pilot-user",
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "untrusted_client_header"
);

expectDenied(
  "client header only does not create authenticated identity",
  resolveLocalLanIdentity({
    clientHeader: "admin-pilot-user"
  }),
  "untrusted_client_header"
);

expectAllowed(
  "actor/device mismatch does not override authenticated identity",
  decideIdentityAccess({
    identity: adminIdentity,
    actor: { id: "claimed-agila", role: ROLE_KEYS.AGILA },
    device: { id: "claimed-device" },
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  {
    reason: "readback_allowed",
    role: ROLE_KEYS.ADMIN_PILOT,
    matchedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }
);

expectAllowed(
  "agila gets sporplan-readback",
  decideIdentityAccess({
    identity: {
      id: "agila-user",
      role: ROLE_KEYS.AGILA,
      scopes: [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]
    },
    requestedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }),
  {
    role: ROLE_KEYS.AGILA,
    matchedScope: SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK
  }
);

expectDenied(
  "agila denied manual-assessments-notes",
  decideIdentityAccess({
    identity: {
      id: "agila-user",
      role: ROLE_KEYS.AGILA,
      scopes: [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]
    },
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "role_scope_not_allowed"
);

expectAllowed(
  "admin_pilot allowed readback/audit for manual-assessments-notes",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }),
  {
    role: ROLE_KEYS.ADMIN_PILOT,
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }
);

expectDenied(
  "role with scope gets readback only, not write",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES,
    requestedRight: ACCESS_RIGHTS.WRITE_DRAFT
  }),
  "write_not_allowed"
);

expectDenied(
  "unknown scope denied",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: "unknown-scope"
  }),
  "unknown_scope"
);

expectDenied(
  "write denied",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES,
    requestedRight: ACCESS_RIGHTS.TEST_WRITE
  }),
  "write_not_allowed"
);

expectDenied(
  "production-pilot-write denied",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES,
    requestedRight: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
  }),
  "write_not_allowed"
);

expectDenied(
  "operational authority denied",
  decideIdentityAccess({
    identity: adminIdentity,
    requestedScope: HIGH_RISK_SCOPES.OPERATIONAL_AUTHORITY_STATE,
    requestedRight: ACCESS_RIGHTS.OPERATIONAL_AUTHORITY
  }),
  "operational_authority_not_opened"
);

for (const scope of Object.values(HIGH_RISK_SCOPES)) {
  expectDenied(
    `high-risk scope ${scope} denied`,
    decideIdentityAccess({
      identity: {
        id: "admin-pilot-user",
        role: ROLE_KEYS.ADMIN_PILOT,
        scopes: [scope]
      },
      requestedScope: scope
    }),
    "high_risk_scope_denied"
  );
}

expectAllowed(
  "public health/status can remain public when explicitly modeled",
  decideIdentityAccess({
    endpointClass: ENDPOINT_CLASSES.PUBLIC_STATUS,
    requestedRight: ACCESS_RIGHTS.READ_ONLY
  }),
  {
    reason: "public_status_allowed",
    endpointClass: ENDPOINT_CLASSES.PUBLIC_STATUS
  }
);

expectAllowed(
  "static/data/assets are read-only but not security",
  decideIdentityAccess({
    endpointClass: ENDPOINT_CLASSES.STATIC_READ,
    requestedRight: ACCESS_RIGHTS.READ_ONLY
  }),
  {
    reason: "static_read_allowed",
    securityBoundary: false
  }
);

expectDenied(
  "static/data/assets do not grant restricted readback",
  decideIdentityAccess({
    endpointClass: ENDPOINT_CLASSES.STATIC_READ,
    requestedRight: ACCESS_RIGHTS.READBACK_AUDIT
  }),
  "static_read_only_only"
);

expectDenied(
  "direct API model without UI denied for restricted readback",
  decideIdentityAccess({
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  "missing_identity"
);

expectAllowed(
  "frontend UI/data-level has no effect on authenticated allow",
  decideIdentityAccess({
    identity: adminIdentity,
    clientLevel: "agila",
    dataLevel: "agila",
    requestedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }),
  {
    role: ROLE_KEYS.ADMIN_PILOT,
    matchedScope: SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES
  }
);

expectDenied(
  "untrusted client source denied",
  resolveLocalLanIdentity({
    identity: {
      id: "client-claimed-user",
      role: ROLE_KEYS.ADMIN_PILOT,
      scopes: [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]
    },
    source: IDENTITY_SOURCES.UNTRUSTED_CLIENT
  }),
  "untrusted_identity_source"
);

expectDenied(
  "trusted boundary required source denied without trusted boundary",
  resolveLocalLanIdentity({
    identity: {
      id: "boundary-user",
      role: ROLE_KEYS.ADMIN_PILOT,
      scopes: [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]
    },
    source: IDENTITY_SOURCES.TRUSTED_BOUNDARY_REQUIRED
  }),
  "trusted_boundary_required"
);

console.log("B47-F identity-policy tests OK");
