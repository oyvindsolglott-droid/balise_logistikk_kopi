"use strict";

const crypto = require("node:crypto");
const {
  LIFECYCLE_COMMANDS,
  LIFECYCLE_SCHEMA_VERSION
} = require("./vehicleStatusLifecycle");

const RECORD_TABLE = "vehicle_status_command_records";
const EVENT_TABLE = "vehicle_status_command_events";
const IDEMPOTENCY_TABLE = "vehicle_status_command_idempotency";
const META_TABLE = "vehicle_status_command_meta";
const CASE_TABLE = "vehicle_status_cases";
const FAULT_TABLE = "vehicle_status_faults";
const REPAIR_TABLE = "vehicle_status_repair_requests";
const NOTIFICATION_TABLE = "vehicle_status_role_notifications";

class VehicleStatusRepositoryConflict extends Error {
  constructor(code, message, fields = {}, status = 409){
    super(message);
    this.name = "VehicleStatusRepositoryConflict";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function createVehicleStatusRepository(options = {}){
  const db = options.db;
  if(!db || typeof db.exec !== "function" || typeof db.prepare !== "function"){
    throw new TypeError("A synchronous SQLite database is required.");
  }
  const now = options.now || (() => new Date().toISOString());
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const failureInjector = options.failureInjector || (() => {});
  const repositoryMode = options.mode === "production-pilot" ? "production-pilot" : "test";
  const writeEnabled = options.writeEnabled !== false;
  const sourceLevel = repositoryMode === "production-pilot"
    ? "server_production_pilot"
    : "server_test_only";

  initializeSchema(db);

  function executeCommand(commandName, command, authority){
    if(!writeEnabled) return unavailable();
    const implementations = {
      [LIFECYCLE_COMMANDS.REGISTER_FAULT]: executeRegisterFault,
      [LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL]: executeReportNotOperationalV2,
      [LIFECYCLE_COMMANDS.REQUEST_REPAIR]: executeRequestRepair,
      [LIFECYCLE_COMMANDS.MARK_FOR_TURNING]: executeMarkForTurning,
      [LIFECYCLE_COMMANDS.REPORT_OPERATIONAL]: executeReportOperational
    };
    const implementation = implementations[commandName];
    if(!implementation) return {
      ok: false, status: 404, error: "unknown_command", message: "Unknown command."
    };
    return inTransaction(commandName, command, authority, implementation);
  }

  function inTransaction(commandName, command, authority, implementation){
    db.exec("BEGIN IMMEDIATE;");
    try{
      const replay = findIdempotency(command.actionId);
      if(replay){
        if(replay.command_type !== commandName || replay.payload_hash !== command.payloadHash){
          throw conflict("action_id_payload_conflict",
            "actionId is already bound to a different command or payload.");
        }
        const result = JSON.parse(replay.result_json);
        db.exec("COMMIT;");
        return { ok: true, status: 200, result: { ...result, idempotentReplay: true } };
      }
      const result = implementation(command, authority);
      failureInjector("before_commit");
      insertIdempotency(commandName, command, result);
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

  function executeRegisterFault(command, authority){
    const currentCase = findCase(command.vehicleId);
    const currentCaseRevision = currentCase?.case_revision || 0;
    requireRevision(
      command.expectedCaseRevision,
      currentCaseRevision,
      "case_revision_mismatch",
      { currentCaseRevision }
    );
    if(db.prepare(`
      SELECT 1 FROM ${FAULT_TABLE}
      WHERE vehicle_id = ? AND slot = ? AND status = 'ACTIVE'
    `).get(command.vehicleId, command.slot)){
      throw conflict("active_fault_slot_conflict",
        "The selected slot already contains an active fault.", { currentCaseRevision });
    }
    const timestamp = now();
    const eventId = randomUUID();
    const faultId = randomUUID();
    const caseRevision = currentCaseRevision + 1;
    ensureCase(command.vehicleId, timestamp, eventId, caseRevision);
    db.prepare(`
      INSERT INTO ${FAULT_TABLE} (
        fault_id, vehicle_id, slot, category, description, status,
        registered_at, registered_by, resolved_at, resolved_by,
        resolution_event_id, event_id
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL, NULL, NULL, ?)
    `).run(
      faultId, command.vehicleId, command.slot, command.category,
      command.description, timestamp, authority.subject, eventId
    );
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.REGISTER_FAULT,
      authority, timestamp, caseBefore: currentCaseRevision, caseAfter: caseRevision,
      statusBefore: statusRevision(command.vehicleId), statusAfter: statusRevision(command.vehicleId),
      previousState: {}, resultingState: { faultId, slot: command.slot, status: "ACTIVE" }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      faultId,
      slot: command.slot,
      category: command.category,
      description: command.description,
      registeredAt: timestamp,
      caseRevision
    });
  }

  function executeReportNotOperationalV2(command, authority){
    const currentRecord = findRecord(command.vehicleId);
    const currentRevision = currentRecord?.status_revision || 0;
    requireRevision(
      command.expectedRevision,
      currentRevision,
      "revision_mismatch",
      { currentRevision, currentStatusRevision: currentRevision }
    );
    if(currentRecord?.status === "IKKE_DRIFTSKLAR"){
      throw conflict("status_already_not_operational",
        "The vehicle is already IKKE_DRIFTSKLAR.", { currentRevision });
    }

    const legacyFaults = command.faults.filter((fault) => !fault.faultId);
    if(legacyFaults.length){
      createLegacyFaultSnapshots(command.vehicleId, legacyFaults, authority);
    }
    const activeFaults = selectFaults(command.vehicleId, "ACTIVE");
    if(activeFaults.length === 0){
      throw conflict("active_fault_required",
        "At least one server-registered ACTIVE fault is required.");
    }
    if(legacyFaults.length === 0){
      const authoritative = activeFaults.map(toFaultSnapshot);
      const supplied = command.faults.map((fault) => ({
        faultId: fault.faultId,
        slot: fault.slot,
        category: fault.category,
        description: fault.description
      })).sort(compareFaultSnapshot);
      if(stableStringify(authoritative) !== stableStringify(supplied)){
        throw conflict("fault_snapshot_mismatch",
          "Client fault snapshot does not match authoritative ACTIVE faults.");
      }
    }

    const timestamp = now();
    const eventId = randomUUID();
    const resultingRevision = currentRevision + 1;
    const previousStatus = currentRecord?.status || null;
    const previousDisposition = currentRecord?.disposition || null;
    db.prepare(`
      INSERT INTO ${RECORD_TABLE} (
        vehicle_id, status, previous_status, disposition, status_revision,
        registered_at, operational_at, updated_at, last_actor, latest_event_id
      ) VALUES (?, 'IKKE_DRIFTSKLAR', ?, 'NONE', ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(vehicle_id) DO UPDATE SET
        status='IKKE_DRIFTSKLAR',
        previous_status=excluded.previous_status,
        disposition='NONE',
        status_revision=excluded.status_revision,
        registered_at=excluded.registered_at,
        operational_at=NULL,
        updated_at=excluded.updated_at,
        last_actor=excluded.last_actor,
        latest_event_id=excluded.latest_event_id
    `).run(
      command.vehicleId, previousStatus, resultingRevision,
      timestamp, timestamp, authority.subject, eventId
    );
    const currentCase = findCase(command.vehicleId);
    if(!currentCase) ensureCase(command.vehicleId, timestamp, eventId, 0);
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
      authority, timestamp,
      caseBefore: currentCase?.case_revision || 0,
      caseAfter: currentCase?.case_revision || 0,
      statusBefore: currentRevision, statusAfter: resultingRevision,
      previousState: { status: previousStatus, disposition: previousDisposition },
      resultingState: {
        status: "IKKE_DRIFTSKLAR",
        disposition: "NONE",
        faults: activeFaults.map(toFaultContract)
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      status: "IKKE_DRIFTSKLAR",
      disposition: "NONE",
      revision: resultingRevision,
      statusRevision: resultingRevision,
      registeredAt: timestamp,
      faults: activeFaults.map(toFaultContract)
    });
  }

  function executeRequestRepair(command, authority){
    const currentCase = findCase(command.vehicleId);
    const currentCaseRevision = currentCase?.case_revision || 0;
    const fault = db.prepare(`SELECT * FROM ${FAULT_TABLE} WHERE fault_id = ?`).get(command.faultId);
    if(!fault || fault.vehicle_id !== command.vehicleId){
      throw conflict("fault_not_found", "The fault was not found for this vehicle.", {}, 404);
    }
    requireRevision(command.expectedCaseRevision, currentCaseRevision,
      "case_revision_mismatch", { currentCaseRevision });
    if(fault.status !== "ACTIVE"){
      throw conflict("fault_not_active", "Only ACTIVE faults can be requested for repair.");
    }
    const record = findRecord(command.vehicleId);
    if(record?.status !== "IKKE_DRIFTSKLAR"){
      throw conflict("vehicle_not_not_operational",
        "Repair requires authoritative IKKE_DRIFTSKLAR status.");
    }
    if(db.prepare(`
      SELECT 1 FROM ${REPAIR_TABLE} WHERE fault_id = ? AND status = 'REQUESTED'
    `).get(command.faultId)){
      throw conflict("repair_already_requested", "An active repair request already exists.");
    }
    const timestamp = now();
    const eventId = randomUUID();
    const repairRequestId = randomUUID();
    const notificationId = randomUUID();
    const caseRevision = currentCaseRevision + 1;
    db.prepare(`
      INSERT INTO ${REPAIR_TABLE} (
        repair_request_id, vehicle_id, fault_id, status,
        requested_at, requested_by, completed_at, completed_by, event_id
      ) VALUES (?, ?, ?, 'REQUESTED', ?, ?, NULL, NULL, ?)
    `).run(repairRequestId, command.vehicleId, command.faultId, timestamp, authority.subject, eventId);
    insertNotification({
      notificationId, eventId, targetRole: "verksted", kind: "REPAIR_REQUESTED",
      priority: "HIGH", vehicleId: command.vehicleId, faultId: command.faultId,
      repairRequestId, timestamp,
      payload: {
        category: fault.category,
        description: fault.description,
        slot: fault.slot,
        requestedAt: timestamp
      }
    });
    updateCase(command.vehicleId, timestamp, eventId, caseRevision);
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.REQUEST_REPAIR,
      authority, timestamp, caseBefore: currentCaseRevision, caseAfter: caseRevision,
      statusBefore: record.status_revision, statusAfter: record.status_revision,
      previousState: { faultStatus: fault.status },
      resultingState: { repairRequestId, repairStatus: "REQUESTED", notificationId }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      faultId: command.faultId,
      repairRequestId,
      status: "REQUESTED",
      requestedAt: timestamp,
      caseRevision,
      notificationId,
      externalRequestSent: false
    });
  }

  function executeMarkForTurning(command, authority){
    const record = findRecord(command.vehicleId);
    const currentRevision = record?.status_revision || 0;
    requireRevision(command.expectedStatusRevision, currentRevision,
      "status_revision_mismatch", { currentStatusRevision: currentRevision });
    if(record?.status !== "IKKE_DRIFTSKLAR"){
      throw conflict("vehicle_not_not_operational",
        "Only IKKE_DRIFTSKLAR vehicles can be marked TIL_DREI.");
    }
    if(record.disposition === "TIL_DREI"){
      throw conflict("already_marked_for_turning", "Vehicle is already TIL_DREI.");
    }
    const timestamp = now();
    const eventId = randomUUID();
    const resultingRevision = currentRevision + 1;
    db.prepare(`
      UPDATE ${RECORD_TABLE}
      SET disposition='TIL_DREI', status_revision=?, updated_at=?,
          last_actor=?, latest_event_id=?
      WHERE vehicle_id=?
    `).run(resultingRevision, timestamp, authority.subject, eventId, command.vehicleId);
    const currentCaseRevision = findCase(command.vehicleId)?.case_revision || 0;
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.MARK_FOR_TURNING,
      authority, timestamp, caseBefore: currentCaseRevision, caseAfter: currentCaseRevision,
      statusBefore: currentRevision, statusAfter: resultingRevision,
      previousState: { status: record.status, disposition: record.disposition },
      resultingState: { status: "IKKE_DRIFTSKLAR", disposition: "TIL_DREI" }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      status: "IKKE_DRIFTSKLAR",
      disposition: "TIL_DREI",
      previousDisposition: record.disposition,
      statusRevision: resultingRevision,
      registeredAt: timestamp
    });
  }

  function executeReportOperational(command, authority){
    const record = findRecord(command.vehicleId);
    const currentStatusRevision = record?.status_revision || 0;
    const currentCase = findCase(command.vehicleId);
    const currentCaseRevision = currentCase?.case_revision || 0;
    requireRevision(command.expectedStatusRevision, currentStatusRevision,
      "status_revision_mismatch", { currentStatusRevision });
    requireRevision(command.expectedCaseRevision, currentCaseRevision,
      "case_revision_mismatch", { currentCaseRevision });
    if(record?.status !== "IKKE_DRIFTSKLAR"){
      throw conflict("vehicle_not_not_operational",
        "Only IKKE_DRIFTSKLAR vehicles can be reported operational.");
    }
    const timestamp = now();
    const eventId = randomUUID();
    const notificationId = randomUUID();
    const activeFaultCount = countWhere(FAULT_TABLE, "vehicle_id = ? AND status = 'ACTIVE'", command.vehicleId);
    const requestedRepairCount =
      countWhere(REPAIR_TABLE, "vehicle_id = ? AND status = 'REQUESTED'", command.vehicleId);
    const caseChanged = activeFaultCount > 0 || requestedRepairCount > 0;
    const resultingCaseRevision = currentCaseRevision + (caseChanged ? 1 : 0);
    const resultingStatusRevision = currentStatusRevision + 1;

    db.prepare(`
      UPDATE ${FAULT_TABLE}
      SET status='RESOLVED', resolved_at=?, resolved_by=?, resolution_event_id=?
      WHERE vehicle_id=? AND status='ACTIVE'
    `).run(timestamp, authority.subject, eventId, command.vehicleId);
    failureInjector("report_operational_after_fault_resolution");
    db.prepare(`
      UPDATE ${REPAIR_TABLE}
      SET status='COMPLETED', completed_at=?, completed_by=?
      WHERE vehicle_id=? AND status='REQUESTED'
    `).run(timestamp, authority.subject, command.vehicleId);
    db.prepare(`
      UPDATE ${RECORD_TABLE}
      SET previous_status=status, status='DRIFTSKLAR', disposition='NONE',
          status_revision=?, operational_at=?, updated_at=?,
          last_actor=?, latest_event_id=?
      WHERE vehicle_id=?
    `).run(
      resultingStatusRevision, timestamp, timestamp,
      authority.subject, eventId, command.vehicleId
    );
    if(caseChanged){
      updateCase(command.vehicleId, timestamp, eventId, resultingCaseRevision);
    }
    insertNotification({
      notificationId, eventId, targetRole: "drops", kind: "VEHICLE_OPERATIONAL",
      priority: "HIGH", vehicleId: command.vehicleId, faultId: null,
      repairRequestId: null, timestamp,
      payload: { operationalAt: timestamp, resolvedFaults: activeFaultCount,
        completedRepairRequests: requestedRepairCount }
    });
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
      authority, timestamp, caseBefore: currentCaseRevision,
      caseAfter: resultingCaseRevision,
      statusBefore: currentStatusRevision, statusAfter: resultingStatusRevision,
      previousState: { status: record.status, disposition: record.disposition },
      resultingState: {
        status: "DRIFTSKLAR", disposition: "NONE",
        resolvedFaults: activeFaultCount,
        completedRepairRequests: requestedRepairCount,
        notificationId
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      status: "DRIFTSKLAR",
      disposition: "NONE",
      previousDisposition: record.disposition,
      statusRevision: resultingStatusRevision,
      caseRevision: resultingCaseRevision,
      operationalAt: timestamp,
      notificationId,
      resolvedFaults: activeFaultCount,
      completedRepairRequests: requestedRepairCount
    });
  }

  function executeReportNotOperational(command, authority){
    if(!writeEnabled) return unavailable();
    const legacy = command.faults.some((fault) => !fault.faultId);
    const payloadHash = command.payloadHash || sha256(stableStringify(command));
    const adapted = { ...command, payloadHash };
    const outcome = executeCommand(
      LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
      adapted,
      {
        roles: authority.roles || [authority.role || "drops"],
        effectiveRole: authority.effectiveRole || authority.role || "drops",
        capabilitySourceRoles: authority.capabilitySourceRoles || [authority.role || "drops"],
        ...authority
      }
    );
    if(outcome.ok && legacy){
      outcome.result = {
        schemaVersion: "vehicle-status-command-v1",
        command: LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
        actionId: outcome.result.actionId,
        vehicleId: outcome.result.vehicleId,
        status: outcome.result.status,
        disposition: outcome.result.disposition,
        revision: outcome.result.revision,
        registeredAt: outcome.result.registeredAt,
        faults: outcome.result.faults.map((fault) => ({
          stableFaultId: fault.stableFaultId,
          priority: fault.priority,
          category: fault.category,
          description: fault.description,
          createdAt: fault.createdAt,
          createdBy: fault.createdBy,
          resolvedAt: fault.resolvedAt,
          resolvedBy: fault.resolvedBy,
          resolutionDescription: fault.resolutionDescription
        })),
        eventId: outcome.result.eventId,
        idempotentReplay: outcome.result.idempotentReplay
      };
    }
    return outcome;
  }

  function getReadModel(options = {}){
    const roles = Array.isArray(options.roles) ? options.roles : [];
    const revision = db.prepare(`SELECT revision FROM ${META_TABLE} WHERE id='main'`).get()?.revision || 0;
    const cases = db.prepare(`SELECT * FROM ${CASE_TABLE} ORDER BY vehicle_id`).all().map(mapCase);
    const faults = db.prepare(`SELECT * FROM ${FAULT_TABLE} ORDER BY vehicle_id, slot, registered_at`).all()
      .map(toFaultContract);
    const repairRequests = db.prepare(`
      SELECT * FROM ${REPAIR_TABLE} ORDER BY vehicle_id, requested_at, repair_request_id
    `).all().map(mapRepair);
    const events = db.prepare(`SELECT * FROM ${EVENT_TABLE} ORDER BY server_timestamp, event_id`).all()
      .map(mapEvent);
    const allNotifications = db.prepare(`
      SELECT * FROM ${NOTIFICATION_TABLE} ORDER BY created_at, notification_id
    `).all().map(mapNotification);
    const notifications = roles.length
      ? allNotifications.filter((notification) => roles.includes(notification.targetRole))
      : [];
    const items = db.prepare(`SELECT * FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all()
      .map((record) => {
        const vehicleFaults = faults.filter((fault) =>
          fault.vehicleId === record.vehicle_id && fault.status === "ACTIVE");
        const caseRecord = cases.find((candidate) => candidate.vehicleId === record.vehicle_id);
        return {
          vehicleId: record.vehicle_id,
          currentStatus: record.status,
          previousStatus: record.previous_status,
          workshopDisposition: record.disposition,
          statusReason: vehicleFaults[0]?.description || null,
          statusAuthority: record.status === "DRIFTSKLAR"
            ? "vehicle_status.report_operational"
            : "vehicle_status.report_not_operational",
          registeredAt: record.registered_at,
          operationalAt: record.operational_at,
          registeredBy: record.last_actor,
          sourceLevel,
          stationPresenceAtRegistration: null,
          stationSlotAtRegistration: null,
          activeCaseId: caseRecord?.vehicleId || record.vehicle_id,
          statusRevision: record.status_revision,
          caseRevision: caseRecord?.caseRevision || 0,
          activeFaults: vehicleFaults,
          latestResolution: faults.find((fault) =>
            fault.vehicleId === record.vehicle_id && fault.status === "RESOLVED") || null,
          updatedAt: record.updated_at
        };
      });
    return {
      schemaVersion: "vehicle-status-read-model-v2",
      domain: "vehicle-status",
      contractActive: true,
      persistenceActive: true,
      statusAuthorityActive: writeEnabled,
      writeEnabled,
      runtimeRoleEnforcement: writeEnabled,
      operationalAuthority: false,
      sourceMode: repositoryMode === "production-pilot"
        ? "production_pilot_vehicle_status_repository"
        : "isolated_vehicle_status_test_repository",
      revision,
      items,
      history: [],
      cases,
      faults,
      repairRequests,
      events,
      notifications,
      diagnostics: [],
      message: {
        code: "vehicle_status_lifecycle_repository_active",
        text: "Authoritative vehicle-status lifecycle persistence is active."
      },
      openPolicyDecisions: []
    };
  }

  function getStorageSnapshot(){
    return {
      counts: {
        records: countRows(RECORD_TABLE),
        cases: countRows(CASE_TABLE),
        faults: countRows(FAULT_TABLE),
        repairRequests: countRows(REPAIR_TABLE),
        notifications: countRows(NOTIFICATION_TABLE),
        events: countRows(EVENT_TABLE),
        idempotency: countRows(IDEMPOTENCY_TABLE)
      },
      records: db.prepare(`SELECT * FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all(),
      cases: db.prepare(`SELECT * FROM ${CASE_TABLE} ORDER BY vehicle_id`).all(),
      faults: db.prepare(`SELECT * FROM ${FAULT_TABLE} ORDER BY vehicle_id, slot`).all(),
      repairRequests: db.prepare(`SELECT * FROM ${REPAIR_TABLE} ORDER BY repair_request_id`).all(),
      notifications: db.prepare(`SELECT * FROM ${NOTIFICATION_TABLE} ORDER BY notification_id`).all(),
      events: db.prepare(`SELECT * FROM ${EVENT_TABLE} ORDER BY event_id`).all(),
      idempotency: db.prepare(`SELECT * FROM ${IDEMPOTENCY_TABLE} ORDER BY action_id`).all()
    };
  }

  function resultBase(command, eventId, fields){
    return {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      command: eventCommandFromPayload(command),
      actionId: command.actionId,
      vehicleId: command.vehicleId,
      ...fields,
      eventId,
      idempotentReplay: false
    };
  }

  function eventCommandFromPayload(command){
    const row = db.prepare(`SELECT command_type FROM ${EVENT_TABLE} WHERE action_id=?`).get(command.actionId);
    return row?.command_type || null;
  }

  function insertEvent({
    eventId, command, commandName, authority, timestamp,
    caseBefore, caseAfter, statusBefore, statusAfter,
    previousState, resultingState
  }){
    db.prepare(`
      INSERT INTO ${EVENT_TABLE} (
        event_id, action_id, command_type, vehicle_id,
        previous_state_json, resulting_state_json,
        previous_status_revision, resulting_status_revision,
        previous_case_revision, resulting_case_revision,
        fault_repair_snapshot_json, server_timestamp,
        actor_subject, actor_roles_json, effective_role,
        identity_source, role_binding_source, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, command.actionId, commandName, command.vehicleId,
      JSON.stringify(previousState), JSON.stringify(resultingState),
      statusBefore, statusAfter, caseBefore, caseAfter,
      JSON.stringify({
        faults: selectFaults(command.vehicleId),
        repairRequests: db.prepare(`SELECT * FROM ${REPAIR_TABLE} WHERE vehicle_id=?`).all(command.vehicleId)
      }),
      timestamp, authority.subject, JSON.stringify(authority.roles || []),
      authority.effectiveRole || null, authority.identitySource,
      authority.roleBindingSource, command.payloadHash
    );
  }

  function insertNotification({
    notificationId, eventId, targetRole, kind, priority, vehicleId,
    faultId, repairRequestId, timestamp, payload
  }){
    db.prepare(`
      INSERT INTO ${NOTIFICATION_TABLE} (
        notification_id, target_role, kind, priority, vehicle_id,
        fault_id, repair_request_id, created_at, event_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notificationId, targetRole, kind, priority, vehicleId,
      faultId, repairRequestId, timestamp, eventId, JSON.stringify(payload)
    );
  }

  function insertIdempotency(commandName, command, result){
    const event = db.prepare(`SELECT event_id FROM ${EVENT_TABLE} WHERE action_id=?`).get(command.actionId);
    const finalResult = { ...result, command: commandName };
    db.prepare(`
      INSERT INTO ${IDEMPOTENCY_TABLE} (
        action_id, command_type, payload_hash, result_json, event_id,
        resulting_status_revision, resulting_case_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.actionId, commandName, command.payloadHash,
      JSON.stringify(finalResult), event.event_id,
      finalResult.statusRevision ?? finalResult.revision ?? null,
      finalResult.caseRevision ?? null
    );
    Object.assign(result, finalResult);
  }

  function ensureCase(vehicleId, timestamp, eventId, caseRevision){
    db.prepare(`
      INSERT INTO ${CASE_TABLE} (
        vehicle_id, case_revision, created_at, updated_at, latest_event_id
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_id) DO UPDATE SET
        case_revision=excluded.case_revision,
        updated_at=excluded.updated_at,
        latest_event_id=excluded.latest_event_id
    `).run(vehicleId, caseRevision, timestamp, timestamp, eventId);
  }

  function updateCase(vehicleId, timestamp, eventId, caseRevision){
    db.prepare(`
      UPDATE ${CASE_TABLE}
      SET case_revision=?, updated_at=?, latest_event_id=?
      WHERE vehicle_id=?
    `).run(caseRevision, timestamp, eventId, vehicleId);
  }

  function createLegacyFaultSnapshots(vehicleId, faults, authority){
    const timestamp = now();
    let currentCase = findCase(vehicleId);
    let caseRevision = currentCase?.case_revision || 0;
    for(const fault of faults){
      const faultId = randomUUID();
      db.prepare(`
        INSERT INTO ${FAULT_TABLE} (
          fault_id, vehicle_id, slot, category, description, status,
          registered_at, registered_by, resolved_at, resolved_by,
          resolution_event_id, event_id
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL, NULL, NULL, ?)
      `).run(
        faultId, vehicleId, fault.priority, fault.category, fault.description,
        timestamp, authority.subject, `legacy:${faultId}`
      );
      caseRevision += 1;
    }
    ensureCase(vehicleId, timestamp, `legacy:${vehicleId}`, caseRevision);
  }

  function findIdempotency(actionId){
    return db.prepare(`SELECT * FROM ${IDEMPOTENCY_TABLE} WHERE action_id=?`).get(actionId);
  }
  function findRecord(vehicleId){
    return db.prepare(`SELECT * FROM ${RECORD_TABLE} WHERE vehicle_id=?`).get(vehicleId);
  }
  function findCase(vehicleId){
    return db.prepare(`SELECT * FROM ${CASE_TABLE} WHERE vehicle_id=?`).get(vehicleId);
  }
  function selectFaults(vehicleId, status = null){
    const sql = status
      ? `SELECT * FROM ${FAULT_TABLE} WHERE vehicle_id=? AND status=? ORDER BY slot, fault_id`
      : `SELECT * FROM ${FAULT_TABLE} WHERE vehicle_id=? ORDER BY slot, fault_id`;
    return status ? db.prepare(sql).all(vehicleId, status) : db.prepare(sql).all(vehicleId);
  }
  function statusRevision(vehicleId){
    return findRecord(vehicleId)?.status_revision || 0;
  }
  function incrementGlobalRevision(){
    db.prepare(`UPDATE ${META_TABLE} SET revision=revision+1 WHERE id='main'`).run();
  }
  function countRows(table){
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }
  function countWhere(table, where, ...values){
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...values).count;
  }

  return {
    executeCommand,
    executeReportNotOperational,
    getReadModel,
    getStorageSnapshot
  };
}

function createVehicleStatusTestRepository(options = {}){
  return createVehicleStatusRepository({ ...options, mode: "test", writeEnabled: true });
}

function initializeSchema(db){
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  if(userVersion === 1){
    const legacyTables = [RECORD_TABLE, EVENT_TABLE, IDEMPOTENCY_TABLE];
    const legacyRows = legacyTables.reduce((sum, table) => {
      try{ return sum + db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }
      catch(_error){ return sum; }
    }, 0);
    if(legacyRows !== 0){
      throw new Error("vehicle_status_v1_nonempty_migration_requires_explicit_operator");
    }
    db.exec(`
      DROP TRIGGER IF EXISTS vehicle_status_command_events_immutable_update;
      DROP TRIGGER IF EXISTS vehicle_status_command_events_immutable_delete;
      DROP TABLE IF EXISTS ${IDEMPOTENCY_TABLE};
      DROP TABLE IF EXISTS ${EVENT_TABLE};
      DROP TABLE IF EXISTS ${RECORD_TABLE};
      DROP TABLE IF EXISTS ${META_TABLE};
    `);
  }else if(userVersion > 2){
    throw new Error("vehicle_status_schema_version_unsupported");
  }

  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      id TEXT PRIMARY KEY CHECK(id='main'),
      revision INTEGER NOT NULL CHECK(revision>=0)
    );
    INSERT OR IGNORE INTO ${META_TABLE} (id, revision) VALUES ('main', 0);

    CREATE TABLE IF NOT EXISTS ${CASE_TABLE} (
      vehicle_id TEXT PRIMARY KEY,
      case_revision INTEGER NOT NULL CHECK(case_revision>=0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      latest_event_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${RECORD_TABLE} (
      vehicle_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('DRIFTSKLAR','IKKE_DRIFTSKLAR')),
      previous_status TEXT,
      disposition TEXT NOT NULL CHECK(disposition IN ('NONE','TIL_REP','TIL_DREI')),
      status_revision INTEGER NOT NULL CHECK(status_revision>=1),
      registered_at TEXT NOT NULL,
      operational_at TEXT,
      updated_at TEXT NOT NULL,
      last_actor TEXT NOT NULL,
      latest_event_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${FAULT_TABLE} (
      fault_id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),
      category TEXT NOT NULL CHECK(category IN ('A1','A2','A3','A4','A5','A6')),
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','RESOLVED')),
      registered_at TEXT NOT NULL,
      registered_by TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_event_id TEXT,
      event_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_fault_per_slot
      ON ${FAULT_TABLE}(vehicle_id, slot) WHERE status='ACTIVE';

    CREATE TABLE IF NOT EXISTS ${REPAIR_TABLE} (
      repair_request_id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      fault_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('REQUESTED','COMPLETED')),
      requested_at TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      completed_at TEXT,
      completed_by TEXT,
      event_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_requested_repair_per_fault
      ON ${REPAIR_TABLE}(fault_id) WHERE status='REQUESTED';

    CREATE TABLE IF NOT EXISTS ${NOTIFICATION_TABLE} (
      notification_id TEXT PRIMARY KEY,
      target_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      priority TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      fault_id TEXT,
      repair_request_id TEXT,
      created_at TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
      event_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL UNIQUE,
      command_type TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      previous_state_json TEXT NOT NULL,
      resulting_state_json TEXT NOT NULL,
      previous_status_revision INTEGER NOT NULL,
      resulting_status_revision INTEGER NOT NULL,
      previous_case_revision INTEGER NOT NULL,
      resulting_case_revision INTEGER NOT NULL,
      fault_repair_snapshot_json TEXT NOT NULL,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      actor_roles_json TEXT NOT NULL,
      effective_role TEXT,
      identity_source TEXT NOT NULL,
      role_binding_source TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY_TABLE} (
      action_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      resulting_status_revision INTEGER,
      resulting_case_revision INTEGER
    );

    CREATE TRIGGER IF NOT EXISTS vehicle_status_command_events_immutable_update
    BEFORE UPDATE ON ${EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'vehicle status events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_command_events_immutable_delete
    BEFORE DELETE ON ${EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'vehicle status events are immutable'); END;
    PRAGMA user_version = 2;
  `);
}

function mapCase(row){
  return {
    vehicleId: row.vehicle_id,
    caseRevision: row.case_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestEventId: row.latest_event_id
  };
}

function toFaultContract(row){
  return {
    faultId: row.fault_id,
    stableFaultId: row.fault_id,
    vehicleId: row.vehicle_id,
    slot: row.slot,
    priority: row.slot,
    category: row.category,
    description: row.description,
    status: row.status,
    registeredAt: row.registered_at,
    registeredBy: row.registered_by,
    createdAt: row.registered_at,
    createdBy: row.registered_by,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionEventId: row.resolution_event_id,
    resolutionDescription: row.status === "RESOLVED"
      ? "Verksted bekreftet kjøretøyet driftsklart."
      : null,
    eventId: row.event_id
  };
}

function toFaultSnapshot(row){
  return {
    faultId: row.fault_id,
    slot: row.slot,
    category: row.category,
    description: row.description
  };
}

function compareFaultSnapshot(left, right){
  return left.slot - right.slot || left.faultId.localeCompare(right.faultId);
}

function mapRepair(row){
  return {
    repairRequestId: row.repair_request_id,
    vehicleId: row.vehicle_id,
    faultId: row.fault_id,
    status: row.status,
    requestedAt: row.requested_at,
    requestedBy: row.requested_by,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    eventId: row.event_id
  };
}

function mapNotification(row){
  return {
    notificationId: row.notification_id,
    eventId: row.event_id,
    targetRole: row.target_role,
    kind: row.kind,
    notificationType: row.kind,
    priority: row.priority,
    vehicleId: row.vehicle_id,
    faultId: row.fault_id,
    repairRequestId: row.repair_request_id,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json)
  };
}

function mapEvent(row){
  return {
    eventId: row.event_id,
    actionId: row.action_id,
    command: row.command_type,
    eventType: `vehicle_status.${row.command_type}`,
    vehicleId: row.vehicle_id,
    previousState: JSON.parse(row.previous_state_json),
    resultingState: JSON.parse(row.resulting_state_json),
    previousStatusRevision: row.previous_status_revision,
    statusRevision: row.resulting_status_revision,
    previousCaseRevision: row.previous_case_revision,
    caseRevision: row.resulting_case_revision,
    timestamp: row.server_timestamp,
    actor: row.actor_subject,
    actorRoles: JSON.parse(row.actor_roles_json),
    effectiveRole: row.effective_role,
    sourceLevel: row.identity_source,
    payloadDigest: row.payload_hash
  };
}

function requireRevision(expected, current, code, fields){
  if(expected !== current){
    throw conflict(code, "Expected revision does not match current revision.", fields);
  }
}

function conflict(code, message, fields = {}, status = 409){
  return new VehicleStatusRepositoryConflict(code, message, fields, status);
}

function unavailable(){
  return {
    ok: false,
    status: 404,
    error: "not_found",
    message: "The requested resource was not found."
  };
}

function rollbackQuietly(db){
  try{ db.exec("ROLLBACK;"); }catch(_error){ /* no active transaction */ }
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

module.exports = {
  CASE_TABLE,
  EVENT_TABLE,
  FAULT_TABLE,
  IDEMPOTENCY_TABLE,
  META_TABLE,
  NOTIFICATION_TABLE,
  RECORD_TABLE,
  REPAIR_TABLE,
  VehicleStatusRepositoryConflict,
  createVehicleStatusRepository,
  createVehicleStatusTestRepository,
  initializeSchema
};
