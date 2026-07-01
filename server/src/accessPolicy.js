"use strict";

const ENDPOINT_CATEGORIES = Object.freeze({
  PUBLIC_STATUS: "public_status",
  SERVER_STATUS_READ: "server_status_read",
  SHARED_READBACK: "shared_readback",
  SCOPE_RESTRICTED_READBACK: "scope_restricted_readback",
  TEST_WRITE: "test_write",
  PRODUCTION_PILOT_WRITE: "production_pilot_write",
  OPERATIONAL_AUTHORITY: "operational_authority"
});

const ACCESS_RIGHTS = Object.freeze({
  NO_ACCESS: "no_access",
  READ_ONLY: "read_only",
  READBACK_AUDIT: "readback_audit",
  WRITE_DRAFT: "write_draft",
  TEST_WRITE: "test_write",
  PRODUCTION_PILOT_WRITE: "production_pilot_write",
  ADMIN_PILOT: "admin_pilot",
  OPERATIONAL_AUTHORITY: "operational_authority"
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
  SDE_NIGHT_PLACEMENT_MANUAL_OVERRIDES: "sde-night-placement-manual-overrides",
  SDE_SHIFT_MOVEMENT_ASSESSMENTS: "sde-shift-movement-assessments",
  SDE_VAKTPLAN_COVERAGE: "sde-vaktplan-coverage",
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

const ENDPOINT_CATEGORY_VALUES = new Set(Object.values(ENDPOINT_CATEGORIES));
const ACCESS_RIGHT_VALUES = new Set(Object.values(ACCESS_RIGHTS));
const SHARED_WORKSPACE_SCOPE_VALUES = new Set(Object.values(SHARED_WORKSPACE_SCOPES));
const HIGH_RISK_SCOPE_VALUES = new Set(Object.values(HIGH_RISK_SCOPES));
const KNOWN_SCOPE_VALUES = new Set([
  ...SHARED_WORKSPACE_SCOPE_VALUES,
  ...HIGH_RISK_SCOPE_VALUES
]);

const DEFAULT_RIGHT_BY_ENDPOINT_CATEGORY = Object.freeze({
  [ENDPOINT_CATEGORIES.PUBLIC_STATUS]: ACCESS_RIGHTS.READ_ONLY,
  [ENDPOINT_CATEGORIES.SERVER_STATUS_READ]: ACCESS_RIGHTS.READ_ONLY,
  [ENDPOINT_CATEGORIES.SHARED_READBACK]: ACCESS_RIGHTS.READBACK_AUDIT,
  [ENDPOINT_CATEGORIES.SCOPE_RESTRICTED_READBACK]: ACCESS_RIGHTS.READBACK_AUDIT,
  [ENDPOINT_CATEGORIES.TEST_WRITE]: ACCESS_RIGHTS.TEST_WRITE,
  [ENDPOINT_CATEGORIES.PRODUCTION_PILOT_WRITE]: ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE,
  [ENDPOINT_CATEGORIES.OPERATIONAL_AUTHORITY]: ACCESS_RIGHTS.OPERATIONAL_AUTHORITY
});

const RIGHT_GRANTS = Object.freeze({
  [ACCESS_RIGHTS.NO_ACCESS]: Object.freeze([]),
  [ACCESS_RIGHTS.READ_ONLY]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY
  ]),
  [ACCESS_RIGHTS.READBACK_AUDIT]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY,
    ACCESS_RIGHTS.READBACK_AUDIT
  ]),
  [ACCESS_RIGHTS.WRITE_DRAFT]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY,
    ACCESS_RIGHTS.READBACK_AUDIT,
    ACCESS_RIGHTS.WRITE_DRAFT
  ]),
  [ACCESS_RIGHTS.TEST_WRITE]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY,
    ACCESS_RIGHTS.READBACK_AUDIT,
    ACCESS_RIGHTS.WRITE_DRAFT,
    ACCESS_RIGHTS.TEST_WRITE
  ]),
  [ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY,
    ACCESS_RIGHTS.READBACK_AUDIT,
    ACCESS_RIGHTS.WRITE_DRAFT,
    ACCESS_RIGHTS.TEST_WRITE,
    ACCESS_RIGHTS.PRODUCTION_PILOT_WRITE
  ]),
  [ACCESS_RIGHTS.ADMIN_PILOT]: Object.freeze([
    ACCESS_RIGHTS.READ_ONLY,
    ACCESS_RIGHTS.READBACK_AUDIT,
    ACCESS_RIGHTS.ADMIN_PILOT
  ]),
  [ACCESS_RIGHTS.OPERATIONAL_AUTHORITY]: Object.freeze([])
});

const ROLE_SCOPE_RIGHTS = Object.freeze({
  [ROLE_KEYS.AGILA]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.TXP]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.INPUT_SPORPLAN_DRAFT]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.DROPS]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SDE_NIGHT_PLACEMENT_MANUAL_OVERRIDES]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.SDE_SHIFT_MOVEMENT_ASSESSMENTS]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.VERKSTED]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.SDE_SKIFTERE]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.INPUT_SPORPLAN_DRAFT]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SDE_NIGHT_PLACEMENT_MANUAL_OVERRIDES]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.SDE_SHIFT_MOVEMENT_ASSESSMENTS]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.VAKTPLAN_LEDELSE]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SDE_VAKTPLAN_COVERAGE]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SDE_SHIFT_MOVEMENT_ASSESSMENTS]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT]
  }),
  [ROLE_KEYS.ADMIN_PILOT]: scopeRights({
    [SHARED_WORKSPACE_SCOPES.SPORPLAN_READBACK]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.INPUT_SPORPLAN_DRAFT]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.TXP_INFRASTRUCTURE_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SDE_NIGHT_PLACEMENT_MANUAL_OVERRIDES]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.SDE_SHIFT_MOVEMENT_ASSESSMENTS]: [
      ACCESS_RIGHTS.READBACK_AUDIT
    ],
    [SHARED_WORKSPACE_SCOPES.SDE_VAKTPLAN_COVERAGE]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.DROPS_MATERIAL_CONTROL]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.WORKSHOP_MATERIAL_STATUS]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.MANUAL_ASSESSMENTS_NOTES]: [ACCESS_RIGHTS.READBACK_AUDIT],
    [SHARED_WORKSPACE_SCOPES.SHARED_WORKSPACE_AUDIT_LOG]: [ACCESS_RIGHTS.READBACK_AUDIT]
  })
});

function decideAccess({
  identity = null,
  role = null,
  scope = null,
  endpointCategory = null,
  requestedRight = null,
  actor: _actor = null,
  device: _device = null
} = {}) {
  const normalizedEndpointCategory = normalizeString(endpointCategory);
  const normalizedScope = normalizeString(scope);
  const normalizedRequestedRight =
    normalizeString(requestedRight) ||
    DEFAULT_RIGHT_BY_ENDPOINT_CATEGORY[normalizedEndpointCategory] ||
    null;
  const normalizedRole = normalizeRole(role, identity);

  const base = {
    endpointCategory: normalizedEndpointCategory,
    scope: normalizedScope,
    role: normalizedRole,
    requestedRight: normalizedRequestedRight,
    matchedRight: null
  };

  if (!ENDPOINT_CATEGORY_VALUES.has(normalizedEndpointCategory)) {
    return deny("unknown_endpoint_category", base);
  }

  if (!ACCESS_RIGHT_VALUES.has(normalizedRequestedRight)) {
    return deny("unknown_requested_right", base);
  }

  if (normalizedEndpointCategory === ENDPOINT_CATEGORIES.PUBLIC_STATUS) {
    if (normalizedRequestedRight !== ACCESS_RIGHTS.READ_ONLY) {
      return deny("public_status_read_only_only", base);
    }
    return allow("public_status_allowed", {
      ...base,
      matchedRight: ACCESS_RIGHTS.READ_ONLY
    });
  }

  if (
    normalizedEndpointCategory === ENDPOINT_CATEGORIES.OPERATIONAL_AUTHORITY ||
    normalizedRequestedRight === ACCESS_RIGHTS.OPERATIONAL_AUTHORITY
  ) {
    return deny("operational_authority_not_opened", base);
  }

  if (!normalizedScope) {
    return deny("missing_scope", base);
  }

  if (HIGH_RISK_SCOPE_VALUES.has(normalizedScope)) {
    return deny("high_risk_scope_default_denied", base);
  }

  if (!KNOWN_SCOPE_VALUES.has(normalizedScope)) {
    return deny("unknown_scope", base);
  }

  if (!hasIdentity(identity)) {
    return deny("missing_identity", base);
  }

  if (!normalizedRole) {
    return deny("missing_role", base);
  }

  const scopeRightsByRole = ROLE_SCOPE_RIGHTS[normalizedRole];
  if (!scopeRightsByRole) {
    return deny("unknown_role", base);
  }

  const roleRights = scopeRightsByRole[normalizedScope] || null;
  if (!roleRights) {
    return deny("role_scope_not_allowed", base);
  }

  const matchedRight = findMatchingRight(roleRights, normalizedRequestedRight);
  if (!matchedRight) {
    return deny("insufficient_right", base);
  }

  return allow("allowed", {
    ...base,
    matchedRight
  });
}

function scopeRights(entries) {
  return Object.freeze(
    Object.entries(entries).reduce((result, [scope, rights]) => {
      result[scope] = Object.freeze([...rights]);
      return result;
    }, {})
  );
}

function hasIdentity(identity) {
  return Boolean(
    identity &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      typeof identity.id === "string" &&
      identity.id.trim()
  );
}

function normalizeRole(role, identity) {
  const explicitRole = normalizeString(role);
  if (explicitRole) return explicitRole;

  if (identity && typeof identity === "object" && !Array.isArray(identity)) {
    return normalizeString(identity.role);
  }

  return null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findMatchingRight(roleRights, requestedRight) {
  return roleRights.find((roleRight) => {
    const grants = RIGHT_GRANTS[roleRight] || [];
    return grants.includes(requestedRight);
  }) || null;
}

function allow(reason, details) {
  return {
    allowed: true,
    reason,
    ...details
  };
}

function deny(reason, details) {
  return {
    allowed: false,
    reason,
    ...details
  };
}

module.exports = {
  ACCESS_RIGHTS,
  ENDPOINT_CATEGORIES,
  HIGH_RISK_SCOPES,
  ROLE_KEYS,
  ROLE_SCOPE_RIGHTS,
  SHARED_WORKSPACE_SCOPES,
  decideAccess
};
