"use strict";

const crypto = require("node:crypto");
const { verifyAccessIdentityRequest } = require("./accessIdentity");
const {
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");
const { CAPABILITY_IDS, evaluateRuntimeAuthorization } = require("./runtimeAuthorization");
const {
  VEHICLE_REGISTRY,
  isRegisteredVehicle,
  normalizeRegisteredVehicleId
} = require("./vehicleRegistry");

const LIFECYCLE_SCHEMA_VERSION = "vehicle-status-command-v3";
const CONFIRM_OPERATIONAL_TEXT =
  "Bekreft at registrerte feil er kontrollert og kjøretøyet kan settes Driftsklart";
const MAX_FAULT_DESCRIPTION_LENGTH = 500;
const PILOT_ALLOWED_VEHICLES_ENV =
  "SDE_VEHICLE_STATUS_PRODUCTION_PILOT_ALLOWED_VEHICLE_IDS";
const PRODUCTION_ALLOWED_SCOPE_ENV =
  "SDE_VEHICLE_STATUS_PRODUCTION_ALLOWED_SCOPE";
const REGISTERED_VEHICLES_SCOPE = "REGISTERED_VEHICLES";
const REGISTERED_VEHICLE_IDS = Object.freeze(Object.values(VEHICLE_REGISTRY).flat());
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FAULT_CATEGORIES = new Set(["A1", "A2", "A3", "A4", "A5", "A6"]);
const WAIT_REASONS = new Set([
  "WAITING_FOR_SHUNTING",
  "WAITING_FOR_WORKSHOP_TRACK",
  "WAITING_FOR_PERSONNEL",
  "WAITING_FOR_PART",
  "WAITING_FOR_TECHNICAL_CLARIFICATION",
  "WAITING_FOR_TEST_RUN",
  "OTHER",
  "NONE"
]);

const LIFECYCLE_COMMANDS = Object.freeze({
  REGISTER_FAULT: "register_fault",
  REPORT_NOT_OPERATIONAL: "report_not_operational",
  REQUEST_REPAIR: "request_repair",
  MARK_FOR_TURNING: "mark_for_turning",
  REPORT_OPERATIONAL: "report_operational",
  NOTIFICATION_PRESENTED: "notification_presented",
  WORKSHOP_SHEET_OPENED: "workshop_sheet_opened",
  WORK_STARTED: "work_started",
  SET_WAIT_REASON: "set_wait_reason"
});

const COMMAND_DEFINITIONS = Object.freeze({
  [LIFECYCLE_COMMANDS.REGISTER_FAULT]: Object.freeze({
    route: "/api/vehicle-status/commands/register-fault",
    capability: CAPABILITY_IDS.REGISTER_FAULT
  }),
  [LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL]: Object.freeze({
    route: "/api/vehicle-status/commands/report-not-operational",
    capability: CAPABILITY_IDS.REPORT_NOT_OPERATIONAL
  }),
  [LIFECYCLE_COMMANDS.REQUEST_REPAIR]: Object.freeze({
    route: "/api/vehicle-status/commands/request-repair",
    capability: CAPABILITY_IDS.REQUEST_REPAIR
  }),
  [LIFECYCLE_COMMANDS.MARK_FOR_TURNING]: Object.freeze({
    route: "/api/vehicle-status/commands/mark-for-turning",
    capability: CAPABILITY_IDS.MARK_FOR_TURNING
  }),
  [LIFECYCLE_COMMANDS.REPORT_OPERATIONAL]: Object.freeze({
    route: "/api/vehicle-status/commands/report-operational",
    capability: CAPABILITY_IDS.REPORT_OPERATIONAL
  }),
  [LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED]: Object.freeze({
    route: "/api/vehicle-status/commands/notification-presented",
    capability: CAPABILITY_IDS.PRESENT_NOTIFICATION
  }),
  [LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED]: Object.freeze({
    route: "/api/vehicle-status/commands/workshop-sheet-opened",
    capability: CAPABILITY_IDS.OPEN_WORKSHOP_SHEET
  }),
  [LIFECYCLE_COMMANDS.WORK_STARTED]: Object.freeze({
    route: "/api/vehicle-status/commands/work-started",
    capability: CAPABILITY_IDS.START_WORK
  }),
  [LIFECYCLE_COMMANDS.SET_WAIT_REASON]: Object.freeze({
    route: "/api/vehicle-status/commands/set-wait-reason",
    capability: CAPABILITY_IDS.SET_WAIT_REASON
  })
});

const FIELDS = Object.freeze({
  [LIFECYCLE_COMMANDS.REGISTER_FAULT]: new Set([
    "actionId", "expectedCaseRevision", "vehicleId", "slot", "category", "description"
  ]),
  [LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL]: new Set([
    "actionId", "expectedRevision", "vehicleId", "faults"
  ]),
  [LIFECYCLE_COMMANDS.REQUEST_REPAIR]: new Set([
    "actionId", "expectedCaseRevision", "vehicleId", "faultId"
  ]),
  [LIFECYCLE_COMMANDS.MARK_FOR_TURNING]: new Set([
    "actionId", "expectedStatusRevision", "vehicleId"
  ]),
  [LIFECYCLE_COMMANDS.REPORT_OPERATIONAL]: new Set([
    "actionId", "expectedStatusRevision", "expectedCaseRevision", "vehicleId"
  ]),
  [LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED]: new Set([
    "actionId", "notificationId"
  ]),
  [LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED]: new Set([
    "actionId", "vehicleId", "caseId"
  ]),
  [LIFECYCLE_COMMANDS.WORK_STARTED]: new Set([
    "actionId", "expectedCaseRevision", "vehicleId"
  ]),
  [LIFECYCLE_COMMANDS.SET_WAIT_REASON]: new Set([
    "actionId", "expectedCaseRevision", "vehicleId", "reason"
  ])
});

function normalizeLifecycleCommand(commandName, input, options = {}){
  if(!Object.hasOwn(COMMAND_DEFINITIONS, commandName)){
    return invalid(404, "unknown_command", "Unknown vehicle-status command.");
  }
  if(!isPlainObject(input)){
    return invalid(400, "invalid_request_body", "JSON body must be an object.");
  }
  for(const field of Object.keys(input)){
    if(!FIELDS[commandName].has(field)){
      return invalid(400, "forbidden_request_field", `${field} is not allowed.`, { field });
    }
  }
  const actionId = normalizeUuid(input.actionId);
  if(!actionId) return invalid(400, "invalid_action_id", "actionId must be a UUID.");
  const vehicleId = commandName === LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED
    ? null
    : normalizeRegisteredVehicleId(input.vehicleId);
  const allowedVehicleIds = options.allowedVehicleIds;
  if(
    commandName !== LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED &&
    (
      !vehicleId ||
      !isRegisteredVehicle(vehicleId) ||
      (allowedVehicleIds instanceof Set && !allowedVehicleIds.has(vehicleId))
    )
  ){
    return invalid(404, "vehicle_not_found", "vehicleId is not allowed by the authoritative registry.");
  }

  let normalized;
  if(commandName === LIFECYCLE_COMMANDS.REGISTER_FAULT){
    const expectedCaseRevision = revision(input.expectedCaseRevision);
    if(expectedCaseRevision === null) return invalidRevision("expectedCaseRevision");
    if(!Number.isInteger(input.slot) || input.slot < 1 || input.slot > 5){
      return invalid(400, "invalid_fault_slot", "slot must be an integer from 1 to 5.");
    }
    if(typeof input.category !== "string" || !FAULT_CATEGORIES.has(input.category)){
      return invalid(400, "invalid_fault_category", "category must be A1 through A6.");
    }
    const description = normalizedText(input.description, MAX_FAULT_DESCRIPTION_LENGTH);
    if(!description){
      return invalid(400, "invalid_fault_description",
        `description must be non-empty, contain no control characters and be at most ${MAX_FAULT_DESCRIPTION_LENGTH} characters.`);
    }
    normalized = {
      actionId, expectedCaseRevision, vehicleId,
      slot: input.slot, category: input.category, description
    };
  }else if(commandName === LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL){
    const expectedRevision = revision(input.expectedRevision);
    if(expectedRevision === null) return invalidRevision("expectedRevision");
    if(!Array.isArray(input.faults) || input.faults.length > 5){
      return invalid(400, "invalid_faults", "faults must contain at most five authoritative fault snapshots.");
    }
    const faults = [];
    for(let index = 0; index < input.faults.length; index += 1){
      const candidate = input.faults[index];
      if(!isPlainObject(candidate)) return invalid(400, "invalid_fault", `faults[${index}] must be an object.`);
      const allowed = new Set(["faultId", "slot", "category", "description"]);
      const extra = Object.keys(candidate).find((field) => !allowed.has(field));
      if(extra) return invalid(400, "forbidden_request_field", `faults[${index}].${extra} is not allowed.`);
      const faultId = normalizeUuid(candidate.faultId);
      const description = normalizedText(candidate.description, MAX_FAULT_DESCRIPTION_LENGTH);
      if(
        !faultId ||
        !Number.isInteger(candidate.slot) ||
        candidate.slot < 1 ||
        candidate.slot > 5 ||
        typeof candidate.category !== "string" ||
        !FAULT_CATEGORIES.has(candidate.category) ||
        !description
      ){
        return invalid(400, "invalid_fault_snapshot", `faults[${index}] is invalid.`);
      }
      faults.push({
        faultId,
        slot: candidate.slot,
        category: candidate.category,
        description
      });
    }
    faults.sort((left, right) => left.slot - right.slot || left.faultId.localeCompare(right.faultId));
    if(new Set(faults.map((fault) => fault.faultId)).size !== faults.length){
      return invalid(400, "duplicate_fault", "faults must not contain duplicates.");
    }
    normalized = { actionId, expectedRevision, vehicleId, faults };
  }else if(commandName === LIFECYCLE_COMMANDS.REQUEST_REPAIR){
    const expectedCaseRevision = revision(input.expectedCaseRevision);
    if(expectedCaseRevision === null) return invalidRevision("expectedCaseRevision");
    const faultId = normalizeUuid(input.faultId);
    if(!faultId) return invalid(400, "invalid_fault_id", "faultId must be a UUID.");
    normalized = { actionId, expectedCaseRevision, vehicleId, faultId };
  }else if(commandName === LIFECYCLE_COMMANDS.MARK_FOR_TURNING){
    const expectedStatusRevision = revision(input.expectedStatusRevision);
    if(expectedStatusRevision === null) return invalidRevision("expectedStatusRevision");
    normalized = { actionId, expectedStatusRevision, vehicleId };
  }else if(commandName === LIFECYCLE_COMMANDS.REPORT_OPERATIONAL){
    const expectedStatusRevision = revision(input.expectedStatusRevision);
    const expectedCaseRevision = revision(input.expectedCaseRevision);
    if(expectedStatusRevision === null) return invalidRevision("expectedStatusRevision");
    if(expectedCaseRevision === null) return invalidRevision("expectedCaseRevision");
    normalized = { actionId, expectedStatusRevision, expectedCaseRevision, vehicleId };
  }else if(commandName === LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED){
    const notificationId = normalizeUuid(input.notificationId);
    if(!notificationId){
      return invalid(400, "invalid_notification_id", "notificationId must be a UUID.");
    }
    normalized = { actionId, notificationId };
  }else if(commandName === LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED){
    const caseId = input.caseId === undefined ? null : normalizedText(input.caseId, 200);
    if(input.caseId !== undefined && !caseId){
      return invalid(400, "invalid_case_id", "caseId is invalid.");
    }
    normalized = { actionId, vehicleId, caseId };
  }else if(commandName === LIFECYCLE_COMMANDS.WORK_STARTED){
    const expectedCaseRevision = revision(input.expectedCaseRevision);
    if(expectedCaseRevision === null) return invalidRevision("expectedCaseRevision");
    normalized = { actionId, expectedCaseRevision, vehicleId };
  }else{
    const expectedCaseRevision = revision(input.expectedCaseRevision);
    if(expectedCaseRevision === null) return invalidRevision("expectedCaseRevision");
    if(typeof input.reason !== "string" || !WAIT_REASONS.has(input.reason)){
      return invalid(400, "invalid_wait_reason", "reason is not an allowed standardized wait reason.");
    }
    normalized = { actionId, expectedCaseRevision, vehicleId, reason: input.reason };
  }
  return {
    ok: true,
    value: {
      ...normalized,
      payloadHash: sha256(stableStringify({ command: commandName, ...normalized }))
    }
  };
}

function createVehicleStatusLifecycleHandler(options = {}){
  const repository = options.repository;
  const commandName = options.commandName;
  const definition = COMMAND_DEFINITIONS[commandName];
  if(!repository || typeof repository.executeCommand !== "function"){
    throw new TypeError("A lifecycle vehicle-status repository is required.");
  }
  if(!definition) throw new TypeError("A known lifecycle command is required.");
  const env = options.env || process.env;
  const verifyIdentityRequest = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const hasInjectedVerifier = Object.hasOwn(options, "verifyIdentityRequest");
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({ env, readFileSync: options.readRoleBindingsFile });
  const isCommandAvailable = options.isCommandAvailable || (() => false);
  const allowedVehicleIds = options.allowedVehicleIds;

  return async function lifecycleCommandHandler(req, res){
    noStore(res);
    try{
      if(isCommandAvailable() !== true){
        return sendError(res, 404, "not_found", "The requested resource was not found.");
      }
      if(!hasInjectedVerifier && !accessAssertionPresent(req.headers)){
        return sendError(res, 401, "authentication_required", "Verified identity is required.");
      }
      const identityResult = await verifyIdentityRequest({
        headers: req.headers,
        env,
        jwks: options.jwks,
        verifier: options.verifier
      });
      if(!identityResult?.ok){
        return sendError(
          res,
          identityResult?.status || 401,
          identityResult?.publicError || "authentication_required",
          "Verified identity is required."
        );
      }
      if(roleBindingsCatalog.valid !== true){
        return sendError(res, 503, "role_binding_unavailable", "Role binding is unavailable.");
      }
      const roleResult = resolveIdentityRoleBinding(identityResult.identity, roleBindingsCatalog);
      if(roleResult.roleResolved !== true || roleResult.roles.length === 0){
        return sendError(res, 403, "role_binding_required", "A resolved role binding is required.");
      }
      const authorization = evaluateRuntimeAuthorization({
        identity: identityResult.identity,
        roleResult,
        capability: definition.capability
      });
      if(authorization.allowed !== true){
        return sendError(res, 403, "capability_forbidden", "The verified identity lacks the capability.");
      }
      const normalized = normalizeLifecycleCommand(commandName, req.body, { allowedVehicleIds });
      if(!normalized.ok){
        return sendError(res, normalized.status, normalized.error, normalized.message, {
          field: normalized.field
        });
      }
      const authority = {
        subject: identityResult.identity.subject,
        roles: roleResult.roles,
        effectiveRole: authorization.capabilitySourceRoles[0],
        capabilitySourceRoles: authorization.capabilitySourceRoles,
        identitySource: identityResult.identity.identitySource || "cloudflare_access_jwt",
        roleBindingSource: roleResult.roleBindingSource || "server_config",
        roleBindingId: roleResult.roleBindingId || null
      };
      const outcome = repository.executeCommand(commandName, normalized.value, authority);
      if(!outcome.ok){
        return sendError(res, outcome.status, outcome.error, outcome.message, outcome);
      }
      return res.status(outcome.status).json(outcome.result);
    }catch(error){
      console.error("vehicle-status lifecycle command failed", {
        name: error?.name || "Error",
        message: error?.message || "Lifecycle command failed."
      });
      return sendError(res, 500, "vehicle_status_command_failed",
        "The vehicle-status command could not be completed.");
    }
  };
}

function createVehicleStatusReadHandler(options = {}){
  const repository = options.repository;
  if(!repository || typeof repository.getReadModel !== "function"){
    throw new TypeError("A lifecycle vehicle-status repository is required.");
  }
  const env = options.env || process.env;
  const verifyIdentityRequest = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({ env, readFileSync: options.readRoleBindingsFile });

  return async function vehicleStatusReadHandler(req, res){
    noStore(res);
    let roles = [];
    let identityResult = null;
    let roleResult = null;
    try{
      if(accessAssertionPresent(req.headers) || Object.hasOwn(options, "verifyIdentityRequest")){
        identityResult = await verifyIdentityRequest({
          headers: req.headers,
          env,
          jwks: options.jwks,
          verifier: options.verifier
        });
        if(identityResult?.ok && roleBindingsCatalog.valid === true){
          roleResult = resolveIdentityRoleBinding(identityResult.identity, roleBindingsCatalog);
          if(roleResult.roleResolved === true) roles = [...roleResult.roles];
        }
      }
      const responseMetadata = typeof options.responseMetadata === "function"
        ? options.responseMetadata({
            req,
            identityResult,
            roleResult,
            roles: [...roles]
          })
        : (options.responseMetadata || {});
      return res.json({
        ok: true,
        ...repository.getReadModel({ roles }),
        ...responseMetadata,
        roles,
        trustedRequestAuthority: null
      });
    }catch(error){
      console.error("vehicle-status readback failed", {
        name: error?.name || "Error",
        message: error?.message || "Vehicle-status readback failed."
      });
      return sendError(res, 500, "vehicle_status_readback_failed",
        "Vehicle-status readback is unavailable.");
    }
  };
}

function createVehicleStatusAnalyticsHandler(options = {}){
  const repository = options.repository;
  if(!repository || typeof repository.getAnalytics !== "function"){
    throw new TypeError("A vehicle-status analytics repository is required.");
  }
  const env = options.env || process.env;
  const verifyIdentityRequest = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({ env, readFileSync: options.readRoleBindingsFile });

  return async function vehicleStatusAnalyticsHandler(req, res){
    noStore(res);
    try{
      if(!accessAssertionPresent(req.headers) && !Object.hasOwn(options, "verifyIdentityRequest")){
        return sendError(res, 401, "authentication_required", "Verified identity is required.");
      }
      const identityResult = await verifyIdentityRequest({
        headers: req.headers,
        env,
        jwks: options.jwks,
        verifier: options.verifier
      });
      if(identityResult?.ok !== true){
        return sendError(res, identityResult?.status || 401,
          identityResult?.publicError || "authentication_required",
          "Verified identity is required.");
      }
      if(roleBindingsCatalog.valid !== true){
        return sendError(res, 503, "role_binding_unavailable", "Role binding is unavailable.");
      }
      const roleResult = resolveIdentityRoleBinding(identityResult.identity, roleBindingsCatalog);
      const authorization = evaluateRuntimeAuthorization({
        identity: identityResult.identity,
        roleResult,
        capability: CAPABILITY_IDS.ANALYTICS_READ
      });
      if(authorization.allowed !== true){
        return sendError(res, 403, "capability_forbidden",
          "The verified identity lacks the analytics capability.");
      }
      return res.status(200).json({
        ok: true,
        ...repository.getAnalytics(req.query || {})
      });
    }catch(error){
      console.error("vehicle-status analytics failed", {
        name: error?.name || "Error",
        message: error?.message || "Vehicle-status analytics failed."
      });
      return sendError(res, 500, "vehicle_status_analytics_failed",
        "Vehicle-status analytics are unavailable.");
    }
  };
}

function getPilotAllowedVehicleIds(env = process.env){
  const configuredScope = typeof env[PRODUCTION_ALLOWED_SCOPE_ENV] === "string"
    ? env[PRODUCTION_ALLOWED_SCOPE_ENV].trim().toUpperCase()
    : "";
  if(configuredScope === REGISTERED_VEHICLES_SCOPE){
    return new Set(REGISTERED_VEHICLE_IDS);
  }
  if(configuredScope){
    return new Set();
  }
  const raw = typeof env[PILOT_ALLOWED_VEHICLES_ENV] === "string"
    ? env[PILOT_ALLOWED_VEHICLES_ENV]
    : "";
  return new Set(raw
    .split(",")
    .map((value) => normalizeRegisteredVehicleId(value))
    .filter((value) => value && isRegisteredVehicle(value)));
}

function revision(value){
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeUuid(value){
  if(typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizedText(value, maxLength){
  if(typeof value !== "string") return null;
  const normalized = value.trim();
  if(!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) return null;
  return normalized;
}

function invalidRevision(field){
  return invalid(400, "invalid_expected_revision", `${field} must be a non-negative integer.`, { field });
}

function invalid(status, error, message, fields = {}){
  return { ok: false, status, error, message, ...fields };
}

function sendError(res, status, error, message, fields = {}){
  const safeFields = {};
  for(const field of ["field", "currentRevision", "currentStatusRevision", "currentCaseRevision"]){
    if(fields[field] !== undefined) safeFields[field] = fields[field];
  }
  return res.status(status).json({ ok: false, error, message, ...safeFields });
}

function noStore(res){
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function accessAssertionPresent(headers = {}){
  return Boolean(
    headers["cf-access-jwt-assertion"] ||
    headers["Cf-Access-Jwt-Assertion"] ||
    headers["CF-Access-Jwt-Assertion"]
  );
}

function stableStringify(value){
  if(value === null || typeof value !== "object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value){
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value){
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  COMMAND_DEFINITIONS,
  CONFIRM_OPERATIONAL_TEXT,
  LIFECYCLE_COMMANDS,
  LIFECYCLE_SCHEMA_VERSION,
  MAX_FAULT_DESCRIPTION_LENGTH,
  PILOT_ALLOWED_VEHICLES_ENV,
  PRODUCTION_ALLOWED_SCOPE_ENV,
  REGISTERED_VEHICLES_SCOPE,
  WAIT_REASONS,
  createVehicleStatusAnalyticsHandler,
  createVehicleStatusLifecycleHandler,
  createVehicleStatusReadHandler,
  getPilotAllowedVehicleIds,
  normalizeLifecycleCommand
};
