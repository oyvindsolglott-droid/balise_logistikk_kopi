"use strict";

const assert = require("node:assert/strict");
const accessPolicy = require("../src/accessPolicy");
const identityPolicy = require("../src/identityPolicy");

const EXPECTED_ACCESS_ONLY_SCOPES = Object.freeze([]);

const EXPECTED_NIGHT_PLACEMENT_ROLES = Object.freeze([
  "admin_pilot",
  "drops",
  "sde_skiftere"
]);

const EXPECTED_VAKTPLAN_COVERAGE_ROLES = Object.freeze([
  "admin_pilot",
  "vaktplan_ledelse"
]);

const EXPECTED_MANUAL_ASSESSMENTS_ROLES = Object.freeze([
  "admin_pilot",
]);

const CENTRAL_RIGHTS = Object.freeze([
  "read_only",
  "readback_audit",
  "write_draft",
  "test_write",
  "production_pilot_write",
  "operational_authority"
]);

const accessRoleScopes = accessPolicy.ROLE_SCOPE_RIGHTS;
const identityRoleScopes = identityPolicy.ROLE_SCOPE_MATRIX;

function sorted(values) {
  return [...values].sort();
}

function valuesOf(catalog) {
  return sorted(Object.values(catalog));
}

function scopeNamesByRole(roleScopes, role) {
  return sorted(Object.keys(roleScopes[role] || {}));
}

function rolesForScope(roleScopes, scope) {
  return sorted(
    Object.entries(roleScopes)
      .filter(([, scopes]) => Boolean(scopes[scope]))
      .map(([role]) => role)
  );
}

function rightsForScope(roleScopes, role, scope) {
  return sorted(roleScopes[role] && roleScopes[role][scope] ? roleScopes[role][scope] : []);
}

function difference(left, right) {
  const rightSet = new Set(right);
  return sorted(left.filter((value) => !rightSet.has(value)));
}

function expectDenied(label, decision) {
  assert.equal(decision.allowed, false, `${label}: expected deny`);
}

function expectScopeRolesAndRights(roleScopes, scope, expectedRoles, policyName) {
  assert.deepEqual(
    rolesForScope(roleScopes, scope),
    sorted(expectedRoles),
    `${policyName} ${scope} roles must match expected readback owners`
  );

  for (const role of expectedRoles) {
    assert.deepEqual(
      rightsForScope(roleScopes, role, scope),
      ["readback_audit"],
      `${policyName} ${role}/${scope} must be readback/audit-only`
    );
  }
}

function expectNoOperationalAuthority(roleScopes, policyName) {
  for (const [role, scopes] of Object.entries(roleScopes)) {
    for (const [scope, rights] of Object.entries(scopes)) {
      assert.equal(
        rights.includes("operational_authority"),
        false,
        `${policyName}: ${role}/${scope} must not grant operational authority`
      );
    }
  }
}

function expectNoHighRiskScopeAllow(roleScopes, highRiskScopes, policyName) {
  const highRisk = new Set(highRiskScopes);
  for (const [role, scopes] of Object.entries(roleScopes)) {
    for (const scope of Object.keys(scopes)) {
      assert.equal(
        highRisk.has(scope),
        false,
        `${policyName}: ${role} must not allow high-risk scope ${scope}`
      );
    }
  }
}

const accessRoles = valuesOf(accessPolicy.ROLE_KEYS);
const identityRoles = valuesOf(identityPolicy.ROLE_KEYS);
assert.deepEqual(accessRoles, identityRoles, "role catalogs must match");

const accessHighRiskScopes = valuesOf(accessPolicy.HIGH_RISK_SCOPES);
const identityHighRiskScopes = valuesOf(identityPolicy.HIGH_RISK_SCOPES);
assert.deepEqual(accessHighRiskScopes, identityHighRiskScopes, "high-risk scopes must match");

const accessScopes = valuesOf(accessPolicy.SHARED_WORKSPACE_SCOPES);
const identityScopes = valuesOf(identityPolicy.SHARED_WORKSPACE_SCOPES);
const accessOnlyScopes = difference(accessScopes, identityScopes);
const identityOnlyScopes = difference(identityScopes, accessScopes);

assert.deepEqual(
  accessOnlyScopes,
  sorted(EXPECTED_ACCESS_ONLY_SCOPES),
  "access-only scopes must stay explicit expected-YELLOW"
);
assert.deepEqual(identityOnlyScopes, [], "identity-only scopes must not appear unnoticed");

for (const right of CENTRAL_RIGHTS) {
  assert.ok(
    Object.values(accessPolicy.ACCESS_RIGHTS).includes(right),
    `accessPolicy must define central right ${right}`
  );
  assert.ok(
    Object.values(identityPolicy.ACCESS_RIGHTS).includes(right),
    `identityPolicy must define central right ${right}`
  );
}

assert.deepEqual(
  scopeNamesByRole(accessRoleScopes, "agila"),
  ["sporplan-readback"],
  "accessPolicy agila must only have sporplan-readback"
);
assert.deepEqual(
  scopeNamesByRole(identityRoleScopes, "agila"),
  ["sporplan-readback"],
  "identityPolicy agila must only have sporplan-readback"
);

assert.deepEqual(
  rolesForScope(accessRoleScopes, "manual-assessments-notes"),
  sorted(EXPECTED_MANUAL_ASSESSMENTS_ROLES),
  "manual-assessments access roles must stay admin_pilot-only"
);
assert.deepEqual(
  rolesForScope(identityRoleScopes, "manual-assessments-notes"),
  sorted(EXPECTED_MANUAL_ASSESSMENTS_ROLES),
  "manual-assessments identity roles must stay admin_pilot-only"
);
assert.equal(
  rolesForScope(identityRoleScopes, "manual-assessments-notes").includes("sde_skiftere"),
  false,
  "manual-assessments identity roles must deny sde_skiftere"
);
assert.equal(
  rolesForScope(identityRoleScopes, "manual-assessments-notes").includes("vaktplan_ledelse"),
  false,
  "manual-assessments identity roles must deny vaktplan_ledelse"
);

expectScopeRolesAndRights(
  accessRoleScopes,
  "sde-night-placement-manual-overrides",
  EXPECTED_NIGHT_PLACEMENT_ROLES,
  "accessPolicy"
);
expectScopeRolesAndRights(
  identityRoleScopes,
  "sde-night-placement-manual-overrides",
  EXPECTED_NIGHT_PLACEMENT_ROLES,
  "identityPolicy"
);
expectScopeRolesAndRights(
  accessRoleScopes,
  "sde-vaktplan-coverage",
  EXPECTED_VAKTPLAN_COVERAGE_ROLES,
  "accessPolicy"
);
expectScopeRolesAndRights(
  identityRoleScopes,
  "sde-vaktplan-coverage",
  EXPECTED_VAKTPLAN_COVERAGE_ROLES,
  "identityPolicy"
);

assert.deepEqual(
  rightsForScope(accessRoleScopes, "admin_pilot", "manual-assessments-notes"),
  ["readback_audit"],
  "accessPolicy manual-assessments readback must not grant write"
);
assert.deepEqual(
  rightsForScope(identityRoleScopes, "admin_pilot", "manual-assessments-notes"),
  ["readback_audit"],
  "identityPolicy manual-assessments readback must not grant write"
);

expectNoOperationalAuthority(accessRoleScopes, "accessPolicy");
expectNoOperationalAuthority(identityRoleScopes, "identityPolicy");
expectNoHighRiskScopeAllow(accessRoleScopes, accessHighRiskScopes, "accessPolicy");
expectNoHighRiskScopeAllow(identityRoleScopes, identityHighRiskScopes, "identityPolicy");

const accessAdminIdentity = Object.freeze({
  id: "catalog-parity-admin",
  role: "admin_pilot"
});
const identityAdmin = Object.freeze({
  id: "catalog-parity-admin",
  role: "admin_pilot",
  scopes: ["manual-assessments-notes"]
});

for (const requestedRight of [
  "write_draft",
  "test_write",
  "production_pilot_write"
]) {
  expectDenied(
    `accessPolicy ${requestedRight}`,
    accessPolicy.decideAccess({
      identity: accessAdminIdentity,
      endpointCategory: "scope_restricted_readback",
      requestedRight,
      scope: "manual-assessments-notes"
    })
  );
  expectDenied(
    `identityPolicy ${requestedRight}`,
    identityPolicy.decideIdentityAccess({
      identity: identityAdmin,
      requestedScope: "manual-assessments-notes",
      requestedRight
    })
  );
}

expectDenied(
  "accessPolicy operational authority",
  accessPolicy.decideAccess({
    identity: accessAdminIdentity,
    endpointCategory: "operational_authority",
    requestedRight: "operational_authority",
    scope: "operational-authority-state"
  })
);
expectDenied(
  "identityPolicy operational authority",
  identityPolicy.decideIdentityAccess({
    identity: identityAdmin,
    requestedScope: "operational-authority-state",
    requestedRight: "operational_authority"
  })
);

for (const scope of accessHighRiskScopes) {
  expectDenied(
    `accessPolicy high-risk ${scope}`,
    accessPolicy.decideAccess({
      identity: accessAdminIdentity,
      endpointCategory: "scope_restricted_readback",
      requestedRight: "readback_audit",
      scope
    })
  );
  expectDenied(
    `identityPolicy high-risk ${scope}`,
    identityPolicy.decideIdentityAccess({
      identity: {
        id: "catalog-parity-admin",
        role: "admin_pilot",
        scopes: [scope]
      },
      requestedScope: scope,
      requestedRight: "readback_audit"
    })
  );
}

expectDenied(
  "accessPolicy unknown role",
  accessPolicy.decideAccess({
    identity: { id: "unknown-role", role: "ghost_role" },
    endpointCategory: "scope_restricted_readback",
    requestedRight: "readback_audit",
    scope: "sporplan-readback"
  })
);
expectDenied(
  "identityPolicy unknown role",
  identityPolicy.decideIdentityAccess({
    identity: {
      id: "unknown-role",
      role: "ghost_role",
      scopes: ["sporplan-readback"]
    },
    requestedScope: "sporplan-readback",
    requestedRight: "readback_audit"
  })
);

expectDenied(
  "accessPolicy unknown scope",
  accessPolicy.decideAccess({
    identity: accessAdminIdentity,
    endpointCategory: "scope_restricted_readback",
    requestedRight: "readback_audit",
    scope: "unknown-scope"
  })
);
expectDenied(
  "identityPolicy unknown scope",
  identityPolicy.decideIdentityAccess({
    identity: identityAdmin,
    requestedScope: "unknown-scope",
    requestedRight: "readback_audit"
  })
);

expectDenied(
  "accessPolicy unknown right",
  accessPolicy.decideAccess({
    identity: accessAdminIdentity,
    endpointCategory: "scope_restricted_readback",
    requestedRight: "unknown_right",
    scope: "manual-assessments-notes"
  })
);
expectDenied(
  "identityPolicy unknown right",
  identityPolicy.decideIdentityAccess({
    identity: identityAdmin,
    requestedScope: "manual-assessments-notes",
    requestedRight: "unknown_right"
  })
);

expectDenied(
  "accessPolicy actor/device only",
  accessPolicy.decideAccess({
    actor: { id: "actor-only", role: "admin_pilot" },
    device: { id: "device-only" },
    endpointCategory: "scope_restricted_readback",
    requestedRight: "readback_audit",
    scope: "manual-assessments-notes"
  })
);
expectDenied(
  "identityPolicy actor/device only",
  identityPolicy.decideIdentityAccess({
    actor: { id: "actor-only", role: "admin_pilot" },
    device: { id: "device-only" },
    requestedScope: "manual-assessments-notes"
  })
);
expectDenied(
  "identityPolicy frontend data-level",
  identityPolicy.decideIdentityAccess({
    dataLevel: "admin",
    requestedScope: "manual-assessments-notes"
  })
);

const loadedModules = Object.keys(require.cache);
assert.equal(
  loadedModules.some((modulePath) => modulePath.endsWith("/server/src/index.js")),
  false,
  "catalog parity test must not load server runtime"
);

console.log("B47-K catalog parity tests OK");
console.log("GREEN checks passed");
console.log("- manual-assessments-notes is admin_pilot-only in accessPolicy and identityPolicy");
console.log("- sde-night-placement-manual-overrides matches B47-P role decision");
console.log("- sde-vaktplan-coverage matches B47-P role decision");
console.log("expected-YELLOW checks cleared");
console.log("RED checks absent");
console.log("catalog parity is still isolated and not runtime-ready");
