"use strict";

const {
  OPEN_POLICY_DECISIONS,
  normalizeVehicleStatusEvent,
  normalizeVehicleStatusNotification,
  normalizeVehicleStatusRecord
} = require("./vehicleStatusContract");

const SCHEMA_VERSION = "vehicle-status-read-model-v1";
const AUTHORITY_METADATA = Object.freeze({
  domain: "vehicle-status",
  contractActive: true,
  persistenceActive: false,
  statusAuthorityActive: false,
  writeEnabled: false,
  runtimeRoleEnforcement: false,
  operationalAuthority: false,
  sourceMode: "contract_only"
});
const READBACK_MESSAGE = Object.freeze({
  code: "vehicle_status_contract_readback_only",
  text: "Vehicle-status is contract/readback-only; no authoritative persistence source is active."
});

function buildProductionVehicleStatusReadModel(){
  return buildVehicleStatusReadModel({
    revision: 0,
    records: [],
    events: [],
    notifications: []
  });
}

function buildVehicleStatusReadModel(input = {}){
  const source = isPlainObject(input) ? input : {};
  const diagnostics = [];
  const revision = normalizeReadModelRevision(source.revision, diagnostics);
  const records = normalizeCollection(
    source.records,
    "record",
    "invalid_vehicle_status_record",
    normalizeVehicleStatusRecord,
    diagnostics
  );
  const events = normalizeCollection(
    source.events,
    "event",
    "invalid_vehicle_status_event",
    normalizeVehicleStatusEvent,
    diagnostics
  );
  const notifications = normalizeCollection(
    source.notifications,
    "notification",
    "invalid_vehicle_status_notification",
    normalizeVehicleStatusNotification,
    diagnostics
  );

  records.sort(compareRecords);
  events.sort(compareEvents);
  notifications.sort(compareNotifications);
  diagnostics.sort(compareDiagnostics);

  const items = [];
  const history = [];
  let previousVehicleId = null;
  for(const record of records){
    if(record.vehicleId !== previousVehicleId){
      items.push(record);
      previousVehicleId = record.vehicleId;
    }else{
      history.push(record);
    }
  }

  return deepFreeze({
    ...AUTHORITY_METADATA,
    schemaVersion: SCHEMA_VERSION,
    revision,
    items,
    history,
    events,
    notifications,
    diagnostics,
    message: { ...READBACK_MESSAGE },
    openPolicyDecisions: [...OPEN_POLICY_DECISIONS]
  });
}

function normalizeReadModelRevision(value, diagnostics){
  if(value === undefined) return 0;
  if(Number.isInteger(value) && value >= 0) return value;
  diagnostics.push({
    code: "invalid_vehicle_status_revision",
    kind: "read_model",
    recordKey: "revision",
    message: "revision must be a non-negative integer; fail-closed value 0 was used."
  });
  return 0;
}

function normalizeCollection(value, kind, code, normalizer, diagnostics){
  if(value === undefined) return [];
  if(!Array.isArray(value)){
    diagnostics.push({
      code,
      kind,
      recordKey: "collection",
      message: `${kind} collection must be an array.`
    });
    return [];
  }

  const output = [];
  for(const candidate of value){
    try{
      output.push(normalizer(candidate));
    }catch(error){
      diagnostics.push({
        code,
        kind,
        recordKey: diagnosticKey(candidate, kind),
        message: error?.message || `Invalid ${kind}.`
      });
    }
  }
  return output;
}

function diagnosticKey(candidate, kind){
  if(!isPlainObject(candidate)) return "unknown";
  const keysByKind = {
    record: ["vehicleId"],
    event: ["eventId", "vehicleId"],
    notification: ["notificationId", "vehicleId"]
  };
  for(const key of keysByKind[kind] || []){
    if(typeof candidate[key] === "string" && candidate[key].trim()){
      return candidate[key].trim().toUpperCase();
    }
  }
  return "unknown";
}

function compareRecords(left, right){
  return compareStrings(left.vehicleId, right.vehicleId) ||
    right.statusRevision - left.statusRevision ||
    compareStrings(right.updatedAt, left.updatedAt) ||
    compareStrings(stableStringify(left), stableStringify(right));
}

function compareEvents(left, right){
  return compareStrings(left.timestamp, right.timestamp) ||
    compareStrings(left.eventId, right.eventId) ||
    compareStrings(stableStringify(left), stableStringify(right));
}

function compareNotifications(left, right){
  return compareStrings(left.createdAt, right.createdAt) ||
    compareStrings(left.notificationId, right.notificationId) ||
    compareStrings(stableStringify(left), stableStringify(right));
}

function compareDiagnostics(left, right){
  return compareStrings(left.kind, right.kind) ||
    compareStrings(left.recordKey, right.recordKey) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message);
}

function stableStringify(value){
  if(value === null || typeof value !== "object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort(compareStrings).map((key) => {
    return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
  }).join(",")}}`;
}

function deepFreeze(value){
  if(!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for(const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value){
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left, right){
  if(left < right) return -1;
  if(left > right) return 1;
  return 0;
}

module.exports = {
  AUTHORITY_METADATA,
  SCHEMA_VERSION,
  buildProductionVehicleStatusReadModel,
  buildVehicleStatusReadModel
};
