"use strict";

const IDENTITY_SOURCES = Object.freeze({
  LOCAL_LAN_PILOT: "local_lan_pilot",
  UNTRUSTED_CLIENT: "untrusted_client",
  TRUSTED_BOUNDARY_REQUIRED: "trusted_boundary_required"
});

const ACCESS_RIGHTS = Object.freeze({
  READ_ONLY: "read_only",
  READBACK_AUDIT: "readback_audit",
  WRITE_DRAFT: "write_draft",
  TEST_WRITE: "test_write",
  PRODUCTION_PILOT_WRITE: "production_pilot_write",
  OPERATIONAL_AUTHORITY: "operational_authority"
});

const ENDPOINT_CLASSES = Object.freeze({
  PUBLIC_STATUS: "public_status",
  STATIC_READ: "static_read",
  SCOPE_RESTRICTED_READBACK: "scope_restricted_readback"
});

const ROLE_KEYS = Object.freeze({
  AGILA: "agila",
  TXP: "txp",
  DROPS: "drops",
  VERKSTED: "verksted",
  SDE_SKIFTERE: "sde_skiftere",
  VAKTPLAN_LEDELSE: "vaktplan_ledelse",
  ADMIN_PILOT: "admin_pilot"
});

const SHARED_WORKSPACE_SCOPES = Object.freeze({
  SPORPLAN_READBACK: "sporplan-readback",
  INPUT_SPORPLAN_DRAFT: "input-sporplan-draft",
  TXP_INFRASTRUCTURE_STATUS: "txp-infrastructure-status",
  SDE_SHIFT_MOVEMENT_ASSESSMENTS: "sde-shift-movement-assessments",
  DROPS_MATERIAL_CONTROL: "drops-material-control",
  WORKSHOP_MATERIAL_STATUS: "workshop-material-status",
  MANUAL_ASSESSMENTS_NOTES: "manual-assessments-notes",
  SHARED_WORKSPACE_AUDIT_LOG: "shared-workspace-audit-log"
});

const HIGH_RISK_SCOPES = Object.freeze({
  SDE_SHIFT_ORDERS: "sde-shift-orders",
  SDE_SHIFT_COMPLETION_STATUS: "sde-shift-completion-status",
  TXP_OPERATIONAL_BLOCKS: "txp-operational-blocks",
  DROPS_DISPATCH_DECISIONS: "drops-dispatch-decisions",
  OPERATIONAL_AUTHORITY_STATE: "operational-authority-state"
});

const LOCAL_LAN_TRUST_MODEL = Object.freeze({
  source: IDENTITY_SOURCES.LOCAL_LAN_PILOT,
  designOnly: true,
  externalSecurity: false,
  runtimeEnforcement: false,
  middleware: false,
  actorDeviceIsIdentity: false,
  frontendLevelsAreSecurity: false,
  operationalAuthority: false,
  notes: "Local/LAN identity is a pilot design model only; it is not external security."
});

const SHARED_SCOPE_VALUES = new Set(Object.values(SHARED_WORKSPACE_SCOPES));
const HIGH_RISK_SCOPE_VALUES = new Set(Object.values(HIGH_RISK_SCOPES));
const ROLE_VALUES = new Set(Object.values(ROLE_KEYS));
const READBACK_RIGHTS = new Set([
  ACCESS_RIGHTS.READ_ONLY,
  ACCESS_RIGHTS.READBACK_AUDIT
]);
const WRITE_RIGHTS = new Set([
  ACCESS_RIGHTS.WRITE_DRAFT,
  ACCESS_RIGHTS.TEST_WRITE,
  ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
]);

const ROLE_SCOPE_MATRIX = Object.freeze({
  [ROLE_KEYS.AGILA]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.TXP]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.DROPS]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.VERKSTED]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.SDE_SKIFTERE]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.SDE_SHIFT_MOVEMENT_ASSESSMENTS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.VAKTPLAN_LEDELSE]: freezeScopes({}),
  [ROLE_KEYS.ADMIN_PILOT]: freezeScopes({
    [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SHARED_WORKSPACE_AUDIT_LOG]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.INPUT_SPORPLAN_DRAFT]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  })
});

function resolveLocalLanIdentity(input = {}) {
  const normalizedInput = isPlainObject(input) ? input : {};
  const trustedBoundary = normalizedInput.trustedBoundary === true;
  const clientHeader = normalizeString(normalizedInput.clientHeader);

  if (clientHeader && !trustedBoundary) {
    return denyIdentity("untrusted_client_header", {
      source: IDENTITY_SOURCES.TRUSTED_BOUNDARY_REQUIRED
    });
  }

  const identity = normalizedInput.identity;

  if (!identity) {
    if (normalizedInput.actor || normalizedInput.device) {
      return denyIdentity("actor_device_not_identity");
    }
    if (hasClientLevelSignal(normalizedInput)) {
      return denyIdentity("client_level_not_identity");
    }
    return denyIdentity("missing_identity");
  }

  if (!isPlainObject(identity)) {
    return denyIdentity("invalid_identity");
  }

  const id = normalizeString(identity.id);
  if (!id) {
    return denyIdentity("missing_identity");
  }

  const source = normalizeString(normalizedInput.source) ||
    normalizeString(identity.source) ||
    IDENTITY_SOURCES.LOCAL_LAN_PILOT;

  if (source === IDENTITY_SOURCES.UNTRUSTED_CLIENT) {
    return denyIdentity("untrusted_identity_source", { source });
  }

  if (source === IDENTITY_SOURCES.TRUSTED_BOUNDARY_REQUIRED && !trustedBoundary) {
    return denyIdentity("trusted_boundary_required", { source });
  }

  const role = normalizeString(normalizedInput.role) || normalizeString(identity.role);
  if (!role) {
    return denyIdentity("missing_role", { identity: { id }, source });
  }

  if (!ROLE_VALUES.has(role)) {
    return denyIdentity("unknown_role", {
      identity: { id },
      role,
      source
    });
  }

  const scopes = normalizeScopes(
    normalizedInput.scopes !== undefined ? normalizedInput.scopes : identity.scopes
  );

  return {
    allowed: true,
    reason: "identity_resolved",
    identity: { id },
    role,
    scopes,
    source,
    trustedBoundary
  };
}

function decideIdentityAccess(input = {}) {
  const normalizedInput = isPlainObject(input) ? input : {};
  const endpointClass = normalizeString(normalizedInput.endpointClass) ||
    ENDPOINT_CLASSES.SCOPE_RESTRICTED_READBACK;
  const requestedRight = normalizeString(normalizedInput.requestedRight) ||
    ACCESS_RIGHTS.READBACK_AUDIT;
  const requestedScope = normalizeString(normalizedInput.requestedScope);

  if (endpointClass === ENDPOINT_CLASSES.PUBLIC_STATUS) {
    if (requestedRight !== ACCESS_RIGHTS.READ_ONLY) {
      return deny("public_status_read_only_only", {
        endpointClass,
        requestedRight
      });
    }
    return allow("public_status_allowed", {
      endpointClass,
      requestedRight,
      source: IDENTITY_SOURCES.LOCAL_LAN_PILOT
    });
  }

  if (endpointClass === ENDPOINT_CLASSES.STATIC_READ) {
    if (requestedRight !== ACCESS_RIGHTS.READ_ONLY) {
      return deny("static_read_only_only", {
        endpointClass,
        requestedRight
      });
    }
    return allow("static_read_allowed", {
      endpointClass,
      requestedRight,
      source: IDENTITY_SOURCES.LOCAL_LAN_PILOT,
      securityBoundary: false
    });
  }

  if (WRITE_RIGHTS.has(requestedRight)) {
    return deny("write_not_allowed", {
      requestedRight,
      requestedScope
    });
  }

  if (requestedRight === ACCESS_RIGHTS.OPERATIONAL_AUTHORITY) {
    return deny("operational_authority_not_opened", {
      requestedRight,
      requestedScope
    });
  }

  if (!READBACK_RIGHTS.has(requestedRight)) {
    return deny("unknown_requested_right", {
      requestedRight,
      requestedScope
    });
  }

  if (!requestedScope) {
    return deny("missing_scope", {
      requestedRight
    });
  }

  if (HIGH_RISK_SCOPE_VALUES.has(requestedScope)) {
    return deny("high_risk_scope_denied", {
      requestedRight,
      requestedScope
    });
  }

  if (!SHARED_SCOPE_VALUES.has(requestedScope)) {
    return deny("unknown_scope", {
      requestedRight,
      requestedScope
    });
  }

  const identityDecision = resolveLocalLanIdentity(normalizedInput);
  if (!identityDecision.allowed) {
    return deny(identityDecision.reason, {
      endpointClass,
      requestedRight,
      requestedScope,
      source: identityDecision.source || IDENTITY_SOURCES.LOCAL_LAN_PILOT
    });
  }

  if (!identityDecision.scopes.includes(requestedScope)) {
    return deny("identity_scope_not_assigned", {
      identity: identityDecision.identity,
      role: identityDecision.role,
      requestedRight,
      requestedScope,
      source: identityDecision.source
    });
  }

  const roleScopes = ROLE_SCOPE_MATRIX[identityDecision.role] || null;
  const roleRights = roleScopes ? roleScopes[requestedScope] : null;
  if (!roleRights || !roleRights.includes(ACCESS_RIGHTS.READBACK_AUDIT)) {
    return deny("role_scope_not_allowed", {
      identity: identityDecision.identity,
      role: identityDecision.role,
      requestedRight,
      requestedScope,
      source: identityDecision.source
    });
  }

  return allow("readback_allowed", {
    identity: identityDecision.identity,
    role: identityDecision.role,
    requestedRight,
    requestedScope,
    matchedScope: requestedScope,
    matchedRight: ACCESS_RIGHTS.READBACK_AUDIT,
    source: identityDecision.source,
    trustedBoundary: identityDecision.trustedBoundary
  });
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizeString).filter(Boolean));
  }
  const normalized = normalizeString(value);
  return normalized ? Object.freeze([normalized]) : Object.freeze([]);
}

function hasClientLevelSignal(input) {
  return Boolean(
    normalizeString(input.clientLevel) ||
      normalizeString(input.dataLevel)
  );
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function freezeScopes(entries) {
  return Object.freeze(
    Object.entries(entries).reduce((result, [scope, rights]) => {
      result[scope] = Object.freeze([...rights]);
      return result;
    }, {})
  );
}

function allow(reason, details = {}) {
  return {
    allowed: true,
    reason,
    ...details
  };
}

function deny(reason, details = {}) {
  return {
    allowed: false,
    reason,
    ...details
  };
}

function denyIdentity(reason, details = {}) {
  return deny(reason, {
    identity: null,
    ...details
  });
}

module.exports = {
  ACCESS_RIGHTS,
  ENDPOINT_CLASSES,
  HIGH_RISK_SCOPES,
  IDENTITY_SOURCES,
  LOCAL_LAN_TRUST_MODEL,
  ROLE_KEYS,
  ROLE_SCOPE_MATRIX,
  SHARED_WORKSPACE_SCOPES,
  decideIdentityAccess,
  resolveLocalLanIdentity
};
