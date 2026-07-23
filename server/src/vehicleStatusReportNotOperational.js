"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyAccessIdentityRequest } = require("./accessIdentity");
const {
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");
const {
  CAPABILITY_IDS,
  evaluateRuntimeAuthorization
} = require("./runtimeAuthorization");
const {
  isRegisteredVehicle,
  normalizeRegisteredVehicleId
} = require("./vehicleRegistry");

const COMMAND_NAME = "report_not_operational";
const COMMAND_ROUTE = "/api/vehicle-status/commands/report-not-operational";
const COMMAND_SCHEMA_VERSION = "vehicle-status-command-v1";
const TEST_WRITE_GATE_ENV = "SDE_VEHICLE_STATUS_TEST_WRITES_ENABLED";
const TEST_SERVER_MODE = "vehicle-status-test";
const PRODUCTION_PILOT_WRITE_GATE_ENV =
  "SDE_VEHICLE_STATUS_PRODUCTION_PILOT_WRITES_ENABLED";
const VEHICLE_STATUS_DATABASE_ENV = "SDE_VEHICLE_STATUS_DB_PATH";
const PRODUCTION_PILOT_SERVER_MODE = "vehicle-status-production-pilot";
const DEFAULT_PRODUCTION_VEHICLE_STATUS_DB =
  "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-vehicle-status.sqlite3";
const MAX_FAULT_DESCRIPTION_LENGTH = 500;
const ALLOWED_REQUEST_FIELDS = new Set([
  "actionId",
  "expectedRevision",
  "vehicleId",
  "faults"
]);
const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  "actor",
  "subject",
  "email",
  "role",
  "capability",
  "registeredAt",
  "eventId",
  "revision",
  "status",
  "disposition",
  "authority",
  "authoritySource",
  "clientRole",
  "frontendLevel",
  "level"
]);
const FAULT_FIELDS = new Set(["priority", "category", "description"]);
const FAULT_CATEGORIES = new Set(["A1", "A2", "A3", "A4", "A5", "A6"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PRODUCTION_DB = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";

function normalizeReportNotOperationalPayload(input){
  if(!isPlainObject(input)){
    return invalidPayload("invalid_request_body", "JSON body must be an object.");
  }

  for(const field of Object.keys(input)){
    if(ALLOWED_REQUEST_FIELDS.has(field)) continue;
    const authorityField = FORBIDDEN_AUTHORITY_FIELDS.has(field);
    return invalidPayload(
      "forbidden_request_field",
      authorityField
        ? `${field} is server authority and must not be supplied by the client.`
        : `${field} is not allowed by this command contract.`,
      { field }
    );
  }

  if(typeof input.actionId !== "string" || !UUID_PATTERN.test(input.actionId.trim())){
    return invalidPayload("invalid_action_id", "actionId must be a UUID.", { field: "actionId" });
  }
  const actionId = input.actionId.trim().toLowerCase();

  if(!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0){
    return invalidPayload(
      "invalid_expected_revision",
      "expectedRevision must be a non-negative integer.",
      { field: "expectedRevision" }
    );
  }

  const vehicleId = normalizeRegisteredVehicleId(input.vehicleId);
  if(!vehicleId || !isRegisteredVehicle(vehicleId)){
    return {
      ok: false,
      status: 404,
      error: "vehicle_not_found",
      message: "vehicleId is not present in the authoritative DROPS vehicle registry.",
      field: "vehicleId"
    };
  }

  if(!Array.isArray(input.faults)){
    return invalidPayload("invalid_faults", "faults must be an array.", { field: "faults" });
  }
  if(input.faults.length > 5){
    return invalidPayload("too_many_faults", "faults may contain at most five entries.", { field: "faults" });
  }

  const faults = [];
  const priorities = new Set();
  for(let index = 0; index < input.faults.length; index += 1){
    const candidate = input.faults[index];
    const prefix = `faults[${index}]`;
    if(!isPlainObject(candidate)){
      return invalidPayload("invalid_fault", `${prefix} must be an object.`, { field: prefix });
    }
    for(const field of Object.keys(candidate)){
      if(!FAULT_FIELDS.has(field)){
        return invalidPayload(
          "forbidden_request_field",
          `${prefix}.${field} is not allowed by this command contract.`,
          { field: `${prefix}.${field}` }
        );
      }
    }
    if(!Number.isInteger(candidate.priority) || candidate.priority < 1 || candidate.priority > 5){
      return invalidPayload(
        "invalid_fault_priority",
        `${prefix}.priority must be an integer from 1 to 5.`,
        { field: `${prefix}.priority` }
      );
    }
    if(priorities.has(candidate.priority)){
      return invalidPayload(
        "duplicate_fault_priority",
        "fault priorities must be unique.",
        { field: "faults" }
      );
    }
    priorities.add(candidate.priority);
    if(typeof candidate.category !== "string" || !FAULT_CATEGORIES.has(candidate.category)){
      return invalidPayload(
        "invalid_fault_category",
        `${prefix}.category must be one of A1, A2, A3, A4, A5 or A6.`,
        { field: `${prefix}.category` }
      );
    }
    if(typeof candidate.description !== "string"){
      return invalidPayload(
        "invalid_fault_description",
        `${prefix}.description must be a string.`,
        { field: `${prefix}.description` }
      );
    }
    const description = candidate.description.trim();
    if(!description || CONTROL_CHARACTERS.test(description)){
      return invalidPayload(
        "invalid_fault_description",
        `${prefix}.description must be non-empty and contain no control characters.`,
        { field: `${prefix}.description` }
      );
    }
    if(description.length > MAX_FAULT_DESCRIPTION_LENGTH){
      return invalidPayload(
        "fault_description_too_long",
        `${prefix}.description must be ${MAX_FAULT_DESCRIPTION_LENGTH} characters or fewer.`,
        { field: `${prefix}.description` }
      );
    }
    faults.push({ priority: candidate.priority, category: candidate.category, description });
  }

  faults.sort((left, right) => left.priority - right.priority);
  for(let index = 0; index < faults.length; index += 1){
    if(faults[index].priority !== index + 1){
      return invalidPayload(
        "non_contiguous_fault_priority",
        "fault priorities must form the contiguous sequence 1..N.",
        { field: "faults" }
      );
    }
  }

  const normalized = {
    actionId,
    expectedRevision: input.expectedRevision,
    vehicleId,
    faults
  };
  return {
    ok: true,
    value: {
      ...normalized,
      payloadHash: sha256(stableStringify(normalized))
    }
  };
}

function createReportNotOperationalHandler(options = {}){
  const repository = options.repository;
  if(!repository || typeof repository.executeReportNotOperational !== "function"){
    throw new TypeError("A vehicle-status repository is required.");
  }
  const env = options.env || process.env;
  const isCommandAvailable = options.isCommandAvailable || (() => true);
  const hasInjectedIdentityVerifier = Object.hasOwn(options, "verifyIdentityRequest");
  const verifyIdentityRequest = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({
      env,
      readFileSync: options.readRoleBindingsFile
    });

  return async function reportNotOperationalHandler(req, res){
    setNoStore(res);
    try{
      if(isCommandAvailable() !== true){
        return sendError(res, 404, "not_found", "The requested resource was not found.");
      }
      if(!hasInjectedIdentityVerifier && !accessAssertionPresent(req.headers)){
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
      if(roleResult.roleResolved !== true || roleResult.roles.length !== 1){
        return sendError(res, 403, "role_binding_required", "A resolved server role binding is required.");
      }

      const decision = evaluateRuntimeAuthorization({
        identity: identityResult.identity,
        roleResult,
        capability: CAPABILITY_IDS.REPORT_NOT_OPERATIONAL
      });
      if(decision.allowed !== true){
        return sendError(res, 403, "capability_forbidden", "The verified identity lacks the required capability.");
      }

      const normalized = normalizeReportNotOperationalPayload(req.body);
      if(!normalized.ok){
        return sendError(
          res,
          normalized.status || 400,
          normalized.error,
          normalized.message,
          omitInternalFields(normalized)
        );
      }

      const authority = {
        subject: identityResult.identity.subject,
        identitySource: identityResult.identity.identitySource || "cloudflare_access_jwt",
        role: roleResult.roles[0],
        roleBindingSource: roleResult.roleBindingSource || "server_config",
        roleBindingId: roleResult.roleBindingId || null
      };
      const outcome = repository.executeReportNotOperational(normalized.value, authority);
      if(!outcome.ok){
        return sendError(
          res,
          outcome.status,
          outcome.error,
          outcome.message,
          omitInternalFields(outcome)
        );
      }
      return res.status(outcome.status).json(outcome.result);
    }catch(error){
      console.error("vehicle-status report-not-operational failed", safeLogError(error));
      return sendError(
        res,
        500,
        "vehicle_status_command_failed",
        "The vehicle-status command could not be completed."
      );
    }
  };
}

function createVehicleStatusJsonErrorHandler(){
  return function vehicleStatusJsonErrorHandler(error, req, res, next){
    if(req.path !== COMMAND_ROUTE) return next(error);
    if(error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, "body")){
      setNoStore(res);
      return sendError(res, 400, "malformed_json", "Request body must be valid JSON.");
    }
    return next(error);
  };
}

function getVehicleStatusProductionPilotWriteStatus(options = {}){
  const env = options.env || process.env;
  const port = Number(options.port);
  const mainDatabasePath = options.mainDatabasePath;
  const vehicleStatusDatabasePath = options.vehicleStatusDatabasePath;
  const approvedVehicleStatusDatabasePath =
    options.approvedVehicleStatusDatabasePath || DEFAULT_PRODUCTION_VEHICLE_STATUS_DB;
  const enabled = isProductionPilotExplicitlyEnabled(
    env[PRODUCTION_PILOT_WRITE_GATE_ENV]
  );
  let configurationFailure = null;

  if(env.SDE_SERVER_MODE !== PRODUCTION_PILOT_SERVER_MODE){
    configurationFailure = guard(
      "vehicle_status_production_pilot_server_mode_required",
      `Production-pilot writes require SDE_SERVER_MODE=${PRODUCTION_PILOT_SERVER_MODE}.`
    );
  }else if(port !== 8787){
    configurationFailure = guard(
      "vehicle_status_production_pilot_port_required",
      "Production-pilot writes require the explicit production port 8787."
    );
  }else if(!env.SDE_SERVER_DB_PATH || !mainDatabasePath){
    configurationFailure = guard(
      "vehicle_status_production_pilot_main_database_required",
      "Production-pilot writes require an explicit operational main database path."
    );
  }else if(!env[VEHICLE_STATUS_DATABASE_ENV] || !vehicleStatusDatabasePath){
    configurationFailure = guard(
      "vehicle_status_production_pilot_database_required",
      `Production-pilot persistence requires ${VEHICLE_STATUS_DATABASE_ENV}.`
    );
  }else if(pathsReferToSameFile(vehicleStatusDatabasePath, mainDatabasePath)){
    configurationFailure = guard(
      "vehicle_status_production_pilot_main_database_forbidden",
      "Vehicle-status production-pilot persistence cannot use the operational main database."
    );
  }else if(!pathsReferToSameFile(
    vehicleStatusDatabasePath,
    approvedVehicleStatusDatabasePath
  )){
    configurationFailure = guard(
      "vehicle_status_production_pilot_database_not_approved",
      "Vehicle-status production-pilot persistence requires the exact approved separate database."
    );
  }

  const persistenceReady = configurationFailure === null;
  const writesAllowed = enabled && persistenceReady;
  return Object.freeze({
    enabled,
    writesAllowed,
    commandAvailable: writesAllowed,
    persistenceReady,
    guardFailure: enabled ? configurationFailure : null,
    configurationFailure,
    gateEnvironmentVariable: PRODUCTION_PILOT_WRITE_GATE_ENV,
    databaseEnvironmentVariable: VEHICLE_STATUS_DATABASE_ENV
  });
}

function getVehicleStatusTestWriteStatus(options = {}){
  const env = options.env || process.env;
  const port = Number(options.port);
  const databasePath = options.databasePath;
  const productionDatabasePath = options.productionDatabasePath || DEFAULT_PRODUCTION_DB;
  const productionDataDirectories = options.productionDataDirectories || [
    path.resolve(__dirname, "..", "data"),
    path.dirname(productionDatabasePath)
  ];
  const enabled = isExplicitlyEnabled(env[TEST_WRITE_GATE_ENV]);
  if(!enabled){
    return Object.freeze({
      enabled: false,
      writesAllowed: false,
      guardFailure: null,
      gateEnvironmentVariable: TEST_WRITE_GATE_ENV
    });
  }

  let guardFailure = null;
  if(env.SDE_SERVER_MODE && env.SDE_SERVER_MODE !== TEST_SERVER_MODE){
    guardFailure = guard(
      "vehicle_status_test_server_mode_required",
      `Vehicle-status test writes require SDE_SERVER_MODE=${TEST_SERVER_MODE}.`
    );
  }else if(port === 8787){
    guardFailure = guard(
      "vehicle_status_test_production_port",
      "Vehicle-status test writes cannot run on production port 8787."
    );
  }else if(!Number.isInteger(port) || port < 1 || port > 65535){
    guardFailure = guard(
      "vehicle_status_test_invalid_port",
      "Vehicle-status test writes require an explicit non-production port."
    );
  }else if(!env.SDE_SERVER_DB_PATH || !databasePath){
    guardFailure = guard(
      "vehicle_status_test_database_required",
      "Vehicle-status test writes require an explicit isolated database path."
    );
  }else if(pathsReferToSameFile(databasePath, productionDatabasePath)){
    guardFailure = guard(
      "vehicle_status_test_production_database",
      "Vehicle-status test writes cannot use the production database."
    );
  }else if(productionDataDirectories.some((directory) => pathIsInside(databasePath, directory))){
    guardFailure = guard(
      "vehicle_status_test_production_data_directory",
      "Vehicle-status test writes cannot use a path inside a production data directory."
    );
  }else if(!isTemporaryDatabasePath(databasePath)){
    guardFailure = guard(
      "vehicle_status_test_temporary_database_required",
      "Vehicle-status test writes require a database in an operating-system temporary directory."
    );
  }

  return Object.freeze({
    enabled: true,
    writesAllowed: guardFailure === null,
    guardFailure,
    gateEnvironmentVariable: TEST_WRITE_GATE_ENV
  });
}

function invalidPayload(error, message, fields = {}){
  return { ok: false, status: 400, error, message, ...fields };
}

function sendError(res, status, error, message, fields = {}){
  return res.status(status).json({
    ok: false,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    error,
    message,
    ...fields
  });
}

function setNoStore(res){
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function omitInternalFields(value){
  const output = {};
  for(const [key, candidate] of Object.entries(value || {})){
    if(["ok", "status", "error", "message"].includes(key)) continue;
    output[key] = candidate;
  }
  return output;
}

function accessAssertionPresent(headers = {}){
  const value = headers["cf-access-jwt-assertion"] || headers["Cf-Access-Jwt-Assertion"];
  return typeof value === "string" && value.trim().length > 0;
}

function isExplicitlyEnabled(value){
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "1" || normalized === "true";
}

function isProductionPilotExplicitlyEnabled(value){
  return value === "1" || value === "true";
}

function isTemporaryDatabasePath(databasePath){
  const resolved = path.resolve(databasePath);
  const candidates = new Set([
    path.resolve(os.tmpdir()),
    path.resolve("/tmp"),
    path.resolve("/private/tmp")
  ]);
  for(const directory of candidates){
    if(pathIsInside(resolved, directory)) return true;
  }
  return false;
}

function pathsReferToSameFile(left, right){
  const resolvedLeft = resolveExistingPath(left);
  const resolvedRight = resolveExistingPath(right);
  return resolvedLeft === resolvedRight;
}

function pathIsInside(candidate, directory){
  const resolvedCandidate = resolveExistingPath(candidate);
  const resolvedDirectory = resolveExistingPath(directory);
  const relative = path.relative(resolvedDirectory, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingPath(value){
  const resolved = path.resolve(String(value || ""));
  try{
    return fs.realpathSync(resolved);
  }catch(_error){
    const parent = path.dirname(resolved);
    try{
      return path.join(fs.realpathSync(parent), path.basename(resolved));
    }catch(_parentError){
      return resolved;
    }
  }
}

function guard(error, message){
  return Object.freeze({ error, message });
}

function stableStringify(value){
  if(value === null || typeof value !== "object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}

function sha256(value){
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeLogError(error){
  return {
    name: error?.name || "Error",
    message: error?.message || "Vehicle-status command failed."
  };
}

function isPlainObject(value){
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  COMMAND_NAME,
  COMMAND_ROUTE,
  COMMAND_SCHEMA_VERSION,
  DEFAULT_PRODUCTION_VEHICLE_STATUS_DB,
  MAX_FAULT_DESCRIPTION_LENGTH,
  PRODUCTION_PILOT_SERVER_MODE,
  PRODUCTION_PILOT_WRITE_GATE_ENV,
  TEST_SERVER_MODE,
  TEST_WRITE_GATE_ENV,
  VEHICLE_STATUS_DATABASE_ENV,
  createReportNotOperationalHandler,
  createVehicleStatusJsonErrorHandler,
  getVehicleStatusProductionPilotWriteStatus,
  getVehicleStatusTestWriteStatus,
  normalizeReportNotOperationalPayload
};
