"use strict";

const CURRENT_STATUSES = Object.freeze([
  "DRIFTSKLAR",
  "IKKE_DRIFTSKLAR"
]);

const WORKSHOP_DISPOSITIONS = Object.freeze([
  "NONE",
  "TIL_REP",
  "TIL_DREI"
]);

const FAULT_CATEGORIES = Object.freeze([
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6"
]);

const OPEN_POLICY_DECISIONS = Object.freeze([
  "fault_required_before_ikke_driftsklar",
  "resolution_required_before_driftsklar",
  "til_drei_authority",
  "status_editing_authority_expiry",
  "partial_acknowledgement",
  "popup_acknowledgement_required",
  "disposition_without_confirmed_skien_presence"
]);

const CURRENT_STATUS_SET = new Set(CURRENT_STATUSES);
const WORKSHOP_DISPOSITION_SET = new Set(WORKSHOP_DISPOSITIONS);
const FAULT_CATEGORY_SET = new Set(FAULT_CATEGORIES);
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class VehicleStatusContractError extends Error {
  constructor(message, field){
    super(message);
    this.name = "VehicleStatusContractError";
    this.code = "invalid_vehicle_status_contract";
    this.field = field;
  }
}

function normalizeVehicleStatusRecord(input){
  const record = requireObject(input, "record");
  const activeFaults = requireArray(record.activeFaults, "activeFaults")
    .map((fault, index) => normalizeFault(fault, `activeFaults[${index}]`));

  if(activeFaults.length > 5){
    invalid("activeFaults may contain at most five faults.", "activeFaults");
  }

  assertUniqueFaultFields(activeFaults);
  activeFaults.sort(compareFaults);

  return {
    vehicleId: normalizeVehicleId(record.vehicleId, "vehicleId"),
    currentStatus: normalizeCurrentStatus(record.currentStatus, "currentStatus"),
    previousStatus: normalizeNullableCurrentStatus(record.previousStatus, "previousStatus"),
    workshopDisposition: normalizeWorkshopDisposition(
      record.workshopDisposition,
      "workshopDisposition"
    ),
    statusReason: normalizeNullableString(record.statusReason, "statusReason"),
    statusAuthority: normalizeRequiredString(record.statusAuthority, "statusAuthority"),
    registeredAt: normalizeTimestamp(record.registeredAt, "registeredAt"),
    registeredBy: normalizeRequiredString(record.registeredBy, "registeredBy"),
    sourceLevel: normalizeRequiredString(record.sourceLevel, "sourceLevel"),
    stationPresenceAtRegistration: normalizeNullableBoolean(
      record.stationPresenceAtRegistration,
      "stationPresenceAtRegistration"
    ),
    stationSlotAtRegistration: normalizeNullableString(
      record.stationSlotAtRegistration,
      "stationSlotAtRegistration"
    ),
    activeCaseId: normalizeNullableString(record.activeCaseId, "activeCaseId"),
    statusRevision: normalizeRevision(record.statusRevision, "statusRevision"),
    activeFaults,
    latestResolution: normalizeNullableJsonObject(record.latestResolution, "latestResolution"),
    updatedAt: normalizeTimestamp(record.updatedAt, "updatedAt")
  };
}

function normalizeFault(input, fieldPrefix = "fault"){
  const fault = requireObject(input, fieldPrefix);
  return {
    stableFaultId: normalizeRequiredString(
      fault.stableFaultId,
      `${fieldPrefix}.stableFaultId`
    ),
    priority: normalizePriority(fault.priority, `${fieldPrefix}.priority`),
    category: normalizeFaultCategory(fault.category, `${fieldPrefix}.category`),
    description: normalizeRequiredString(fault.description, `${fieldPrefix}.description`),
    createdAt: normalizeTimestamp(fault.createdAt, `${fieldPrefix}.createdAt`),
    createdBy: normalizeRequiredString(fault.createdBy, `${fieldPrefix}.createdBy`),
    resolvedAt: normalizeNullableTimestamp(fault.resolvedAt, `${fieldPrefix}.resolvedAt`),
    resolvedBy: normalizeNullableString(fault.resolvedBy, `${fieldPrefix}.resolvedBy`),
    resolutionDescription: normalizeNullableString(
      fault.resolutionDescription,
      `${fieldPrefix}.resolutionDescription`
    )
  };
}

function normalizeVehicleStatusEvent(input){
  const event = requireObject(input, "event");
  return {
    eventId: normalizeRequiredString(event.eventId, "eventId"),
    actionId: normalizeRequiredString(event.actionId, "actionId"),
    vehicleId: normalizeVehicleId(event.vehicleId, "vehicleId"),
    caseId: normalizeNullableString(event.caseId, "caseId"),
    eventType: normalizeRequiredString(event.eventType, "eventType"),
    previousStatus: normalizeNullableCurrentStatus(event.previousStatus, "previousStatus"),
    currentStatus: normalizeCurrentStatus(event.currentStatus, "currentStatus"),
    previousDisposition: normalizeNullableWorkshopDisposition(
      event.previousDisposition,
      "previousDisposition"
    ),
    currentDisposition: normalizeWorkshopDisposition(
      event.currentDisposition,
      "currentDisposition"
    ),
    timestamp: normalizeTimestamp(event.timestamp, "timestamp"),
    actor: normalizeRequiredString(event.actor, "actor"),
    sourceLevel: normalizeRequiredString(event.sourceLevel, "sourceLevel"),
    statusRevision: normalizeRevision(event.statusRevision, "statusRevision"),
    payloadDigest: normalizeRequiredString(event.payloadDigest, "payloadDigest")
  };
}

function normalizeVehicleStatusNotification(input){
  const notification = requireObject(input, "notification");
  return {
    notificationId: normalizeRequiredString(
      notification.notificationId,
      "notificationId"
    ),
    eventId: normalizeRequiredString(notification.eventId, "eventId"),
    vehicleId: normalizeVehicleId(notification.vehicleId, "vehicleId"),
    notificationType: normalizeRequiredString(
      notification.notificationType,
      "notificationType"
    ),
    createdAt: normalizeTimestamp(notification.createdAt, "createdAt"),
    readAt: normalizeNullableTimestamp(notification.readAt, "readAt"),
    acknowledgedAt: normalizeNullableTimestamp(
      notification.acknowledgedAt,
      "acknowledgedAt"
    ),
    acknowledgedBy: normalizeNullableString(
      notification.acknowledgedBy,
      "acknowledgedBy"
    ),
    notificationRevision: normalizeRevision(
      notification.notificationRevision,
      "notificationRevision"
    )
  };
}

function normalizeVehicleId(value, field){
  return normalizeRequiredString(value, field).toUpperCase();
}

function normalizeCurrentStatus(value, field){
  return normalizeEnum(value, field, CURRENT_STATUS_SET, CURRENT_STATUSES);
}

function normalizeNullableCurrentStatus(value, field){
  if(value === null || value === undefined) return null;
  return normalizeCurrentStatus(value, field);
}

function normalizeWorkshopDisposition(value, field){
  return normalizeEnum(
    value,
    field,
    WORKSHOP_DISPOSITION_SET,
    WORKSHOP_DISPOSITIONS
  );
}

function normalizeNullableWorkshopDisposition(value, field){
  if(value === null || value === undefined) return null;
  return normalizeWorkshopDisposition(value, field);
}

function normalizeFaultCategory(value, field){
  return normalizeEnum(value, field, FAULT_CATEGORY_SET, FAULT_CATEGORIES);
}

function normalizeEnum(value, field, allowedSet, allowedValues){
  const normalized = normalizeRequiredString(value, field);
  if(!allowedSet.has(normalized)){
    invalid(`${field} must be one of: ${allowedValues.join(", ")}.`, field);
  }
  return normalized;
}

function normalizePriority(value, field){
  if(!Number.isInteger(value) || value < 1 || value > 5){
    invalid(`${field} priority must be an integer from 1 to 5.`, field);
  }
  return value;
}

function normalizeRevision(value, field){
  if(!Number.isInteger(value) || value < 0){
    invalid(`${field} must be a non-negative integer.`, field);
  }
  return value;
}

function normalizeTimestamp(value, field){
  const normalized = normalizeRequiredString(value, field);
  if(!ISO_UTC_TIMESTAMP.test(normalized)){
    invalid(`${field} must use canonical UTC ISO-8601 milliseconds format.`, field);
  }

  const timestamp = new Date(normalized);
  if(Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== normalized){
    invalid(`${field} must be a valid canonical UTC timestamp.`, field);
  }
  return normalized;
}

function normalizeNullableTimestamp(value, field){
  if(value === null || value === undefined) return null;
  return normalizeTimestamp(value, field);
}

function normalizeRequiredString(value, field){
  if(typeof value !== "string"){
    invalid(`${field} must be a string.`, field);
  }
  const normalized = value.trim();
  if(!normalized){
    invalid(`${field} must not be empty.`, field);
  }
  return normalized;
}

function normalizeNullableString(value, field){
  if(value === null || value === undefined) return null;
  return normalizeRequiredString(value, field);
}

function normalizeNullableBoolean(value, field){
  if(value === null || value === undefined) return null;
  if(typeof value !== "boolean"){
    invalid(`${field} must be boolean or null.`, field);
  }
  return value;
}

function normalizeNullableJsonObject(value, field){
  if(value === null || value === undefined) return null;
  if(!isPlainObject(value)){
    invalid(`${field} must be an object or null.`, field);
  }

  try{
    return canonicalJsonClone(value);
  }catch(error){
    invalid(`${field} must contain only finite JSON-compatible values: ${error.message}`, field);
  }
}

function assertUniqueFaultFields(faults){
  const faultIds = new Set();
  const priorities = new Set();

  for(const fault of faults){
    if(faultIds.has(fault.stableFaultId)){
      invalid("activeFaults stableFaultId values must be unique.", "activeFaults");
    }
    faultIds.add(fault.stableFaultId);

    if(priorities.has(fault.priority)){
      invalid("activeFaults priority values must be unique.", "activeFaults");
    }
    priorities.add(fault.priority);
  }
}

function compareFaults(left, right){
  return left.priority - right.priority || compareStrings(left.stableFaultId, right.stableFaultId);
}

function requireObject(value, field){
  if(!isPlainObject(value)){
    invalid(`${field} must be an object.`, field);
  }
  return value;
}

function requireArray(value, field){
  if(!Array.isArray(value)){
    invalid(`${field} must be an array.`, field);
  }
  return value;
}

function isPlainObject(value){
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonClone(value){
  if(value === null || typeof value === "string" || typeof value === "boolean"){
    return value;
  }
  if(typeof value === "number"){
    if(!Number.isFinite(value)) throw new Error("numbers must be finite");
    return value;
  }
  if(Array.isArray(value)){
    return value.map(canonicalJsonClone);
  }
  if(isPlainObject(value)){
    const output = {};
    for(const key of Object.keys(value).sort(compareStrings)){
      if(value[key] === undefined) throw new Error("undefined is not supported");
      output[key] = canonicalJsonClone(value[key]);
    }
    return output;
  }
  throw new Error("unsupported value type");
}

function compareStrings(left, right){
  if(left < right) return -1;
  if(left > right) return 1;
  return 0;
}

function invalid(message, field){
  throw new VehicleStatusContractError(message, field);
}

module.exports = {
  CURRENT_STATUSES,
  FAULT_CATEGORIES,
  OPEN_POLICY_DECISIONS,
  VehicleStatusContractError,
  WORKSHOP_DISPOSITIONS,
  normalizeFault,
  normalizeVehicleStatusEvent,
  normalizeVehicleStatusNotification,
  normalizeVehicleStatusRecord
};
