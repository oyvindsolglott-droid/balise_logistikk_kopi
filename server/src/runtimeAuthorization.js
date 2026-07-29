"use strict";

const { verifyAccessIdentityRequest } = require("./accessIdentity");
const { ROLE_KEYS } = require("./identityPolicy");
const {
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");

const RUNTIME_AUTHORIZATION_SCHEMA_VERSION = "sde-runtime-authorization-v1";
const DECISION_SOURCE = "server_runtime_authorization_policy";
const RUNTIME_ENFORCEMENT_SCOPE = "policy_readback_only";
const SOURCE_MODE = "authorization_policy_readback_only";
const CAPABILITY_STATUSES = Object.freeze({
  ACTIVE: "active",
  UNRESOLVED: "unresolved"
});

const VEHICLE_STATUS_ROLES = Object.freeze([
  ROLE_KEYS.ADMIN_PILOT,
  ROLE_KEYS.AGILA,
  ROLE_KEYS.DROPS,
  ROLE_KEYS.SDE_SKIFTERE,
  ROLE_KEYS.TXP,
  ROLE_KEYS.VERKSTED
]);
const VEHICLE_STATUS_ROLE_SET = new Set(VEHICLE_STATUS_ROLES);
const OPERATIONAL_MESSAGE_ROLES = Object.freeze([
  ROLE_KEYS.AGILA,
  ROLE_KEYS.DROPS,
  ROLE_KEYS.SDE_SKIFTERE,
  ROLE_KEYS.TXP,
  ROLE_KEYS.VERKSTED
]);

const CAPABILITY_IDS = Object.freeze({
  READ: "vehicle_status.read",
  REGISTER_FAULT: "vehicle_status.register_fault",
  REPORT_NOT_OPERATIONAL: "vehicle_status.report_not_operational",
  REQUEST_REPAIR: "vehicle_status.request_repair",
  REQUEST_WORKSHOP_EXIT: "vehicle_status.request_workshop_exit",
  MANAGE_WORKSHOP_INGRESS_QUEUE: "vehicle_status.manage_workshop_ingress_queue",
  REQUEST_CLEANING_TRACK_SPACE: "vehicle_status.request_cleaning_track_space",
  SEND_OPERATIONAL_MESSAGE: "vehicle_status.send_operational_message",
  SEND_WORKSHOP_MESSAGE: "vehicle_status.send_operational_message",
  MARK_FOR_TURNING: "vehicle_status.mark_for_turning",
  REPORT_OPERATIONAL: "vehicle_status.report_operational",
  PRESENT_NOTIFICATION: "vehicle_status.notification_presented",
  OPEN_WORKSHOP_SHEET: "vehicle_status.workshop_sheet_opened",
  START_WORK: "vehicle_status.work_started",
  SET_WAIT_REASON: "vehicle_status.set_wait_reason",
  ANALYTICS_READ: "vehicle_status.analytics_read",
  REGISTER_RESOLUTIONS: "vehicle_status.register_resolutions",
  CLEAR_WORKSHOP_DISPOSITION_WITH_OPERATIONAL:
    "vehicle_status.clear_workshop_disposition_with_operational",
  ACKNOWLEDGE_DROPS_NOTIFICATION: "vehicle_status.acknowledge_drops_notification",
  OVERRIDE: "vehicle_status.override"
});

const OPEN_POLICY_DECISIONS = Object.freeze([
  "select_or_change_til_drei",
  "drops_edit_active_faults_after_initial_save",
  "drops_fault_edit_lock_timing",
  "workshop_partial_fault_resolution",
  "fault_required_for_not_operational",
  "resolution_required_for_operational",
  "drops_popup_read_or_acknowledged",
  "disposition_without_verified_skien_presence"
].map((policyDecision) => Object.freeze({
  policyDecision,
  status: CAPABILITY_STATUSES.UNRESOLVED,
  allowedRoles: Object.freeze([])
})));

const RAW_CAPABILITY_CATALOG = Object.freeze([
  {
    capability: CAPABILITY_IDS.READ,
    description: "Read the vehicle-status read model.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: VEHICLE_STATUS_ROLES
  },
  {
    capability: CAPABILITY_IDS.REGISTER_FAULT,
    description: "Register one authoritative vehicle fault.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS]
  },
  {
    capability: CAPABILITY_IDS.REPORT_NOT_OPERATIONAL,
    description: "Report a vehicle as not operational.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS]
  },
  {
    capability: CAPABILITY_IDS.REQUEST_REPAIR,
    description: "Create one internal repair request for an active fault.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS]
  },
  {
    capability: CAPABILITY_IDS.REQUEST_WORKSHOP_EXIT,
    description: "Request an authoritative exit from the current workshop visit.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
    description: "Manage the authoritative ingress queue for workshop tracks.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.REQUEST_CLEANING_TRACK_SPACE,
    description: "Request one authoritative Agilia cleaning-track allocation.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.AGILA]
  },
  {
    capability: CAPABILITY_IDS.SEND_OPERATIONAL_MESSAGE,
    description: "Send an authoritative message to one other operational role.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: OPERATIONAL_MESSAGE_ROLES
  },
  {
    capability: CAPABILITY_IDS.MARK_FOR_TURNING,
    description: "Mark a not-operational vehicle for turning.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS]
  },
  {
    capability: CAPABILITY_IDS.REPORT_OPERATIONAL,
    description: "Report a vehicle as operational.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.PRESENT_NOTIFICATION,
    description: "Record that an operational notification was rendered in an authenticated client.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: OPERATIONAL_MESSAGE_ROLES
  },
  {
    capability: CAPABILITY_IDS.OPEN_WORKSHOP_SHEET,
    description: "Record the first authenticated opening of a workshop vehicle sheet.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.START_WORK,
    description: "Record explicit workshop work start for an active vehicle case.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.SET_WAIT_REASON,
    description: "Set the standardized wait reason for an active workshop case.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.ANALYTICS_READ,
    description: "Read aggregated vehicle and process analytics without personal identifiers.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS, ROLE_KEYS.ADMIN_PILOT]
  },
  {
    capability: CAPABILITY_IDS.REGISTER_RESOLUTIONS,
    description: "Register workshop resolutions for active faults.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.CLEAR_WORKSHOP_DISPOSITION_WITH_OPERATIONAL,
    description: "Clear workshop disposition atomically with an operational transition.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.VERKSTED]
  },
  {
    capability: CAPABILITY_IDS.ACKNOWLEDGE_DROPS_NOTIFICATION,
    description: "Acknowledge a DROPS vehicle-status notification.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: [ROLE_KEYS.DROPS]
  },
  {
    capability: CAPABILITY_IDS.OVERRIDE,
    description: "Override vehicle-status policy.",
    status: CAPABILITY_STATUSES.ACTIVE,
    allowedRoles: []
  }
]);

const CAPABILITY_CATALOG = validateCapabilityCatalog(RAW_CAPABILITY_CATALOG);
if(!CAPABILITY_CATALOG.valid){
  throw new Error("Built-in runtime authorization catalog is invalid.");
}

function validateCapabilityCatalog(input){
  const diagnostics = new Set();
  const normalizedEntries = [];

  if(!Array.isArray(input)){
    diagnostics.add("capability_catalog_invalid_shape");
    return invalidCatalog(diagnostics);
  }

  for(const entry of input){
    const normalized = normalizeCatalogEntry(entry, diagnostics);
    if(normalized) normalizedEntries.push(normalized);
  }

  const capabilityCounts = countBy(normalizedEntries, (entry) => entry.capability);
  if([...capabilityCounts.values()].some((count) => count > 1)){
    diagnostics.add("capability_catalog_duplicate_id");
  }

  if(diagnostics.size > 0) return invalidCatalog(diagnostics);

  const entries = Object.freeze(
    normalizedEntries
      .sort((left, right) => left.capability.localeCompare(right.capability))
      .map((entry) => Object.freeze(entry))
  );
  return Object.freeze({
    valid: true,
    diagnostics: Object.freeze([]),
    entries
  });
}

function evaluateRuntimeAuthorization(input = {}, options = {}){
  const catalog = options.catalog || CAPABILITY_CATALOG;
  const capability = normalizeExactString(input.capability, 200);
  const identity = isPlainObject(input.identity) ? input.identity : null;
  const roleResult = isPlainObject(input.roleResult) ? input.roleResult : null;
  const candidateRoles = Array.isArray(roleResult?.roles)
    ? [...new Set(roleResult.roles.map((role) => normalizeExactString(role, 100)))]
    : [];
  const candidateRole = candidateRoles.length === 1 ? candidateRoles[0] : null;

  if(!catalog || catalog.valid !== true || !Array.isArray(catalog.entries)){
    return denyDecision(capability, candidateRole, "capability_catalog_invalid");
  }
  if(!identity) return denyDecision(capability, candidateRole, "identity_missing");
  if(identity.identityVerified !== true){
    return denyDecision(capability, candidateRole, "identity_unverified");
  }
  if(identity.identityKind !== "human"){
    return denyDecision(capability, candidateRole, "human_identity_required");
  }
  if(roleResult?.roleResolved !== true){
    return denyDecision(capability, candidateRole, "role_unresolved");
  }
  if(candidateRoles.length === 0 || candidateRoles.some((role) => !role)){
    return denyDecision(capability, candidateRole, "explicit_roles_required");
  }
  if(candidateRoles.some((role) => !VEHICLE_STATUS_ROLE_SET.has(role))){
    return denyDecision(capability, candidateRole, "unknown_role");
  }
  if(!capability){
    return denyDecision(null, candidateRole, "unknown_capability");
  }

  const catalogEntry = catalog.entries.find((entry) => entry.capability === capability);
  if(!catalogEntry) return denyDecision(capability, candidateRole, "unknown_capability");
  if(catalogEntry.status !== CAPABILITY_STATUSES.ACTIVE){
    return denyDecision(capability, candidateRole, "capability_unresolved");
  }
  const capabilitySourceRoles = candidateRoles
    .filter((role) => catalogEntry.allowedRoles.includes(role));
  if(capabilitySourceRoles.length === 0){
    return denyDecision(capability, candidateRole, "role_not_allowed");
  }

  return decisionResult(
    true,
    capability,
    candidateRole,
    "role_explicitly_allowed",
    candidateRoles,
    capabilitySourceRoles
  );
}

function createRuntimeCapabilitiesHandler(options = {}){
  const env = options.env || process.env;
  const jwks = options.jwks;
  const verifier = options.verifier;
  const verifyIdentityRequest = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({
      env,
      readFileSync: options.readRoleBindingsFile
    });

  return async function runtimeCapabilitiesHandler(req, res){
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");

    const identityResult = await verifyIdentityRequest({
      headers: req.headers,
      env,
      jwks,
      verifier
    });

    if(!identityResult?.ok){
      return res.status(identityResult?.status || 401).json(capabilityResponse({
        ok: false,
        error: identityResult?.publicError || "authentication_required",
        roleResolved: false,
        role: null,
        capabilities: {}
      }));
    }

    if(roleBindingsCatalog.valid !== true){
      return res.status(503).json(capabilityResponse({
        ok: false,
        error: "role_binding_unavailable",
        roleResolved: false,
        role: null,
        capabilities: {}
      }));
    }

    const roleResult = resolveIdentityRoleBinding(identityResult.identity, roleBindingsCatalog);
    if(roleResult.roleResolved !== true || roleResult.roles.length === 0){
      return res.status(403).json(capabilityResponse({
        ok: false,
        error: "role_binding_required",
        roleResolved: false,
        role: null,
        capabilities: {}
      }));
    }

    const roles = [...roleResult.roles];
    const role = roles.length === 1 ? roles[0] : null;
    const capabilities = Object.fromEntries(CAPABILITY_CATALOG.entries.map((entry) => {
      const result = evaluateRuntimeAuthorization({
        identity: identityResult.identity,
        roleResult,
        capability: entry.capability
      });
      return [entry.capability, Object.freeze({
        allowed: result.allowed,
        decision: result.decision,
        reasonCode: result.reasonCode,
        capabilitySourceRoles: result.capabilitySourceRoles
      })];
    }));

    return res.status(200).json(capabilityResponse({
      ok: true,
      roleResolved: true,
      role,
      roles,
      capabilities
    }));
  };
}

function capabilityResponse(fields){
  return {
    ...fields,
    schemaVersion: RUNTIME_AUTHORIZATION_SCHEMA_VERSION,
    decisionSource: DECISION_SOURCE,
    globalRuntimeRoleEnforcement: false,
    writeExecutionEnabled: false,
    sourceMode: SOURCE_MODE
  };
}

function normalizeCatalogEntry(entry, diagnostics){
  if(!isPlainObject(entry)){
    diagnostics.add("capability_catalog_invalid_entry");
    return null;
  }

  const capability = normalizeExactString(entry.capability, 200);
  const description = normalizeExactString(entry.description, 500);
  const status = normalizeExactString(entry.status, 40);
  const allowedRoles = Array.isArray(entry.allowedRoles)
    ? entry.allowedRoles.map((role) => normalizeExactString(role, 100))
    : null;

  if(!capability || !capability.startsWith("vehicle_status.")){
    diagnostics.add("capability_catalog_invalid_id");
  }
  if(!description) diagnostics.add("capability_catalog_invalid_description");
  if(!Object.values(CAPABILITY_STATUSES).includes(status)){
    diagnostics.add("capability_catalog_invalid_status");
  }
  if(!allowedRoles || allowedRoles.some((role) => !role || !VEHICLE_STATUS_ROLE_SET.has(role))){
    diagnostics.add("capability_catalog_invalid_role");
  }
  if(allowedRoles && new Set(allowedRoles).size !== allowedRoles.length){
    diagnostics.add("capability_catalog_duplicate_role");
  }
  if(status === CAPABILITY_STATUSES.UNRESOLVED && allowedRoles?.length > 0){
    diagnostics.add("capability_catalog_unresolved_role_conflict");
  }

  if(
    !capability ||
    !capability.startsWith("vehicle_status.") ||
    !description ||
    !Object.values(CAPABILITY_STATUSES).includes(status) ||
    !allowedRoles ||
    allowedRoles.some((role) => !role || !VEHICLE_STATUS_ROLE_SET.has(role)) ||
    new Set(allowedRoles).size !== allowedRoles.length ||
    (status === CAPABILITY_STATUSES.UNRESOLVED && allowedRoles.length > 0)
  ){
    return null;
  }

  const roleOrder = new Map(VEHICLE_STATUS_ROLES.map((role, index) => [role, index]));
  return {
    capability,
    description,
    status,
    allowedRoles: Object.freeze([...allowedRoles].sort((left, right) => (
      roleOrder.get(left) - roleOrder.get(right)
    )))
  };
}

function decisionResult(
  allowed,
  capability,
  role,
  reasonCode,
  roles = role ? [role] : [],
  capabilitySourceRoles = []
){
  return Object.freeze({
    allowed,
    decision: allowed ? "ALLOW" : "DENY",
    capability,
    role,
    roles: Object.freeze([...roles]),
    capabilitySourceRoles: Object.freeze([...capabilitySourceRoles]),
    decisionSource: DECISION_SOURCE,
    reasonCode,
    runtimeEnforcementScope: RUNTIME_ENFORCEMENT_SCOPE
  });
}

function denyDecision(capability, role, reasonCode){
  return decisionResult(false, capability, role, reasonCode);
}

function invalidCatalog(diagnostics){
  return Object.freeze({
    valid: false,
    diagnostics: Object.freeze([...diagnostics].sort()),
    entries: Object.freeze([])
  });
}

function countBy(values, selector){
  const counts = new Map();
  for(const value of values){
    const key = selector(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function normalizeExactString(value, maximumLength){
  if(typeof value !== "string" || value.length === 0 || value.length > maximumLength) return null;
  if(value !== value.trim()) return null;
  if(/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function isPlainObject(value){
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  CAPABILITY_CATALOG,
  CAPABILITY_IDS,
  CAPABILITY_STATUSES,
  DECISION_SOURCE,
  OPEN_POLICY_DECISIONS,
  RUNTIME_AUTHORIZATION_SCHEMA_VERSION,
  RUNTIME_ENFORCEMENT_SCOPE,
  SOURCE_MODE,
  VEHICLE_STATUS_ROLES,
  createRuntimeCapabilitiesHandler,
  evaluateRuntimeAuthorization,
  validateCapabilityCatalog
};
