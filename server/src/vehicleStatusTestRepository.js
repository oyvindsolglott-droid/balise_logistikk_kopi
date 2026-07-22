"use strict";

const crypto = require("node:crypto");
const { buildVehicleStatusReadModel } = require("./vehicleStatusReadModel");

const RECORD_TABLE = "vehicle_status_command_records";
const EVENT_TABLE = "vehicle_status_command_events";
const IDEMPOTENCY_TABLE = "vehicle_status_command_idempotency";
const META_TABLE = "vehicle_status_command_meta";

class VehicleStatusRepositoryConflict extends Error {
  constructor(code, message, fields = {}){
    super(message);
    this.name = "VehicleStatusRepositoryConflict";
    this.status = 409;
    this.code = code;
    this.fields = fields;
  }
}

function createVehicleStatusTestRepository(options = {}){
  const db = options.db;
  if(!db || typeof db.exec !== "function" || typeof db.prepare !== "function"){
    throw new TypeError("A synchronous SQLite database is required.");
  }
  const now = options.now || (() => new Date().toISOString());
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const failureInjector = options.failureInjector || (() => {});

  initializeSchema(db);

  function executeReportNotOperational(command, authority){
    db.exec("BEGIN IMMEDIATE;");
    try{
      const replay = findIdempotency(command.actionId);
      if(replay){
        if(replay.payload_hash !== command.payloadHash){
          throw new VehicleStatusRepositoryConflict(
            "action_id_payload_conflict",
            "actionId is already bound to a different normalized payload."
          );
        }
        const original = JSON.parse(replay.result_json);
        db.exec("COMMIT;");
        return {
          ok: true,
          status: 200,
          result: { ...original, idempotentReplay: true }
        };
      }

      const current = findRecord(command.vehicleId);
      const currentRevision = current?.revision || 0;
      if(command.expectedRevision !== currentRevision){
        throw new VehicleStatusRepositoryConflict(
          "revision_mismatch",
          "expectedRevision does not match the current vehicle status revision.",
          { currentRevision }
        );
      }
      if(current?.status === "IKKE_DRIFTSKLAR"){
        throw new VehicleStatusRepositoryConflict(
          "status_already_not_operational",
          "The vehicle is already registered as IKKE_DRIFTSKLAR.",
          { currentRevision }
        );
      }

      const timestamp = now();
      const eventId = randomUUID();
      const resultingRevision = currentRevision + 1;
      const previousStatus = current?.status || null;
      const previousDisposition = current?.disposition || null;
      const faults = command.faults.map((fault) => ({
        stableFaultId: `${eventId}:fault:${fault.priority}`,
        priority: fault.priority,
        category: fault.category,
        description: fault.description,
        createdAt: timestamp,
        createdBy: authority.subject,
        resolvedAt: null,
        resolvedBy: null,
        resolutionDescription: null
      }));
      const faultsJson = JSON.stringify(faults);

      db.prepare(`
        INSERT INTO ${RECORD_TABLE} (
          vehicle_id, status, previous_status, disposition, revision,
          registered_at, updated_at, actor_subject, last_event_id, faults_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vehicle_id) DO UPDATE SET
          status = excluded.status,
          previous_status = excluded.previous_status,
          disposition = excluded.disposition,
          revision = excluded.revision,
          registered_at = excluded.registered_at,
          updated_at = excluded.updated_at,
          actor_subject = excluded.actor_subject,
          last_event_id = excluded.last_event_id,
          faults_json = excluded.faults_json
      `).run(
        command.vehicleId,
        "IKKE_DRIFTSKLAR",
        previousStatus,
        "NONE",
        resultingRevision,
        timestamp,
        timestamp,
        authority.subject,
        eventId,
        faultsJson
      );
      failureInjector("after_record_upsert");

      db.prepare(`
        INSERT INTO ${EVENT_TABLE} (
          event_id, action_id, command_type, vehicle_id,
          previous_status, resulting_status,
          previous_revision, resulting_revision,
          previous_disposition, resulting_disposition,
          fault_snapshot_json, server_timestamp,
          actor_subject, identity_source, role_binding_source,
          payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        command.actionId,
        "report_not_operational",
        command.vehicleId,
        previousStatus,
        "IKKE_DRIFTSKLAR",
        currentRevision,
        resultingRevision,
        previousDisposition,
        "NONE",
        faultsJson,
        timestamp,
        authority.subject,
        authority.identitySource,
        authority.roleBindingSource,
        command.payloadHash
      );
      failureInjector("after_event_insert");

      db.prepare(`UPDATE ${META_TABLE} SET revision = revision + 1 WHERE id = 'main'`).run();

      const result = {
        schemaVersion: "vehicle-status-command-v1",
        command: "report_not_operational",
        actionId: command.actionId,
        vehicleId: command.vehicleId,
        status: "IKKE_DRIFTSKLAR",
        disposition: "NONE",
        revision: resultingRevision,
        registeredAt: timestamp,
        faults,
        eventId,
        idempotentReplay: false
      };

      db.prepare(`
        INSERT INTO ${IDEMPOTENCY_TABLE} (
          action_id, payload_hash, result_json, event_id, resulting_revision
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        command.actionId,
        command.payloadHash,
        JSON.stringify(result),
        eventId,
        resultingRevision
      );
      failureInjector("before_commit");
      db.exec("COMMIT;");
      return { ok: true, status: 201, result };
    }catch(error){
      rollbackQuietly(db);
      if(error instanceof VehicleStatusRepositoryConflict){
        return {
          ok: false,
          status: error.status,
          error: error.code,
          message: error.message,
          ...error.fields
        };
      }
      throw error;
    }
  }

  function getReadModel(){
    const revision = db.prepare(`SELECT revision FROM ${META_TABLE} WHERE id = 'main'`).get()?.revision || 0;
    const records = db.prepare(`SELECT * FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all()
      .map(mapRecordToContract);
    const events = db.prepare(`SELECT * FROM ${EVENT_TABLE} ORDER BY server_timestamp, event_id`).all()
      .map(mapEventToContract);
    const model = buildVehicleStatusReadModel({ revision, records, events, notifications: [] });
    return {
      ...model,
      persistenceActive: true,
      statusAuthorityActive: true,
      writeEnabled: true,
      runtimeRoleEnforcement: true,
      operationalAuthority: false,
      sourceMode: "isolated_vehicle_status_test_repository",
      message: {
        code: "vehicle_status_test_repository_active",
        text: "Authoritative vehicle-status test persistence is active on an isolated server."
      }
    };
  }

  function getStorageSnapshot(){
    return {
      counts: {
        records: countRows(RECORD_TABLE),
        events: countRows(EVENT_TABLE),
        idempotency: countRows(IDEMPOTENCY_TABLE)
      },
      records: db.prepare(`SELECT
        vehicle_id AS vehicleId,
        status,
        disposition,
        revision,
        registered_at AS registeredAt,
        updated_at AS updatedAt,
        actor_subject AS actorSubject,
        last_event_id AS lastEventId,
        faults_json AS faultsJson
        FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all(),
      events: db.prepare(`SELECT
        event_id AS eventId,
        action_id AS actionId,
        command_type AS commandType,
        vehicle_id AS vehicleId,
        previous_status AS previousStatus,
        resulting_status AS resultingStatus,
        previous_revision AS previousRevision,
        resulting_revision AS resultingRevision,
        previous_disposition AS previousDisposition,
        resulting_disposition AS resultingDisposition,
        fault_snapshot_json AS faultSnapshotJson,
        server_timestamp AS serverTimestamp,
        actor_subject AS actorSubject,
        identity_source AS identitySource,
        role_binding_source AS roleBindingSource,
        payload_hash AS payloadHash
        FROM ${EVENT_TABLE} ORDER BY server_timestamp, event_id`).all()
    };
  }

  function findIdempotency(actionId){
    return db.prepare(`SELECT * FROM ${IDEMPOTENCY_TABLE} WHERE action_id = ?`).get(actionId);
  }

  function findRecord(vehicleId){
    return db.prepare(`SELECT * FROM ${RECORD_TABLE} WHERE vehicle_id = ?`).get(vehicleId);
  }

  function countRows(tableName){
    return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
  }

  return {
    executeReportNotOperational,
    getReadModel,
    getStorageSnapshot
  };
}

function initializeSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      id TEXT PRIMARY KEY CHECK(id = 'main'),
      revision INTEGER NOT NULL CHECK(revision >= 0)
    );

    INSERT OR IGNORE INTO ${META_TABLE} (id, revision) VALUES ('main', 0);

    CREATE TABLE IF NOT EXISTS ${RECORD_TABLE} (
      vehicle_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('DRIFTSKLAR', 'IKKE_DRIFTSKLAR')),
      previous_status TEXT,
      disposition TEXT NOT NULL CHECK(disposition IN ('NONE', 'TIL_REP', 'TIL_DREI')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      last_event_id TEXT NOT NULL,
      faults_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
      event_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL UNIQUE,
      command_type TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      previous_status TEXT,
      resulting_status TEXT NOT NULL,
      previous_revision INTEGER NOT NULL,
      resulting_revision INTEGER NOT NULL,
      previous_disposition TEXT,
      resulting_disposition TEXT NOT NULL,
      fault_snapshot_json TEXT NOT NULL,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      identity_source TEXT NOT NULL,
      role_binding_source TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY_TABLE} (
      action_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      resulting_revision INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES ${EVENT_TABLE}(event_id)
    );

    CREATE TRIGGER IF NOT EXISTS vehicle_status_command_events_immutable_update
    BEFORE UPDATE ON ${EVENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'vehicle status events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS vehicle_status_command_events_immutable_delete
    BEFORE DELETE ON ${EVENT_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'vehicle status events are immutable');
    END;
  `);
}

function mapRecordToContract(row){
  const activeFaults = JSON.parse(row.faults_json);
  return {
    vehicleId: row.vehicle_id,
    currentStatus: row.status,
    previousStatus: row.previous_status,
    workshopDisposition: row.disposition,
    statusReason: activeFaults[0]?.description || "Reported not operational without fault details.",
    statusAuthority: "vehicle_status.report_not_operational",
    registeredAt: row.registered_at,
    registeredBy: row.actor_subject,
    sourceLevel: "server_test_only",
    stationPresenceAtRegistration: null,
    stationSlotAtRegistration: null,
    activeCaseId: row.last_event_id,
    statusRevision: row.revision,
    activeFaults,
    latestResolution: null,
    updatedAt: row.updated_at
  };
}

function mapEventToContract(row){
  return {
    eventId: row.event_id,
    actionId: row.action_id,
    vehicleId: row.vehicle_id,
    caseId: null,
    eventType: "vehicle_status.report_not_operational",
    previousStatus: row.previous_status,
    currentStatus: row.resulting_status,
    previousDisposition: row.previous_disposition,
    currentDisposition: row.resulting_disposition,
    timestamp: row.server_timestamp,
    actor: row.actor_subject,
    sourceLevel: "server_test_only",
    statusRevision: row.resulting_revision,
    payloadDigest: row.payload_hash
  };
}

function rollbackQuietly(db){
  try{ db.exec("ROLLBACK;"); }catch(_error){ /* no active transaction */ }
}

module.exports = {
  EVENT_TABLE,
  IDEMPOTENCY_TABLE,
  META_TABLE,
  RECORD_TABLE,
  VehicleStatusRepositoryConflict,
  createVehicleStatusTestRepository
};
