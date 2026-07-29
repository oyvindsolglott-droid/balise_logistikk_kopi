"use strict";

const crypto = require("node:crypto");
const {
  LIFECYCLE_COMMANDS,
  LIFECYCLE_SCHEMA_VERSION
} = require("./vehicleStatusLifecycle");
const {
  buildAnalytics,
  buildProcessCases
} = require("./vehicleStatusProcessAnalytics");

const RECORD_TABLE = "vehicle_status_command_records";
const EVENT_TABLE = "vehicle_status_command_events";
const IDEMPOTENCY_TABLE = "vehicle_status_command_idempotency";
const META_TABLE = "vehicle_status_command_meta";
const CASE_TABLE = "vehicle_status_cases";
const FAULT_TABLE = "vehicle_status_faults";
const REPAIR_TABLE = "vehicle_status_repair_requests";
const NOTIFICATION_TABLE = "vehicle_status_role_notifications";
const PROCESS_CASE_TABLE = "vehicle_status_process_cases";
const PROCESS_EVENT_TABLE = "vehicle_status_process_events";
const PROCESS_OBSERVATION_TABLE = "vehicle_status_process_observations";
const WORKSHOP_EXIT_REQUEST_TABLE = "vehicle_status_workshop_exit_requests";
const WORKSHOP_EXIT_EVENT_TABLE = "vehicle_status_workshop_exit_events";
const WORKSHOP_INGRESS_QUEUE_TABLE = "vehicle_status_workshop_ingress_queue";
const WORKSHOP_INGRESS_QUEUE_META_TABLE = "vehicle_status_workshop_ingress_queue_meta";
const WORKSHOP_INGRESS_QUEUE_EVENT_TABLE = "vehicle_status_workshop_ingress_queue_events";
const WORKSHOP_MESSAGE_TABLE = "vehicle_status_workshop_messages";
const WORKSHOP_MESSAGE_EVENT_TABLE = "vehicle_status_workshop_message_events";
const OPERATIONAL_MESSAGE_TABLE = "vehicle_status_operational_messages";
const OPERATIONAL_MESSAGE_EVENT_TABLE = "vehicle_status_operational_message_events";
const OPERATIONAL_MESSAGE_ACK_TABLE =
  "vehicle_status_operational_message_acknowledgements";
const CLEANING_TRACK_REQUEST_TABLE = "vehicle_status_cleaning_track_space_requests";
const WORKSHOP_SLOTS = new Set(["7N", "7S", "8N", "8S"]);
const CLEANING_TRACK_SLOTS = new Set(["5S", "5M", "10S", "10N"]);
const SEMANTIC_NOOP = Symbol("vehicle_status_semantic_noop");

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
      [LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT]: executeRequestWorkshopExit,
      [LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE]: executeManageWorkshopIngressQueue,
      [LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE]: executeRequestCleaningTrackSpace,
      [LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE]: executeSendOperationalMessage,
      [LIFECYCLE_COMMANDS.SEND_WORKSHOP_MESSAGE]: executeSendOperationalMessage,
      [LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE]:
        executeAcknowledgeOperationalMessage,
      [LIFECYCLE_COMMANDS.MARK_FOR_TURNING]: executeMarkForTurning,
      [LIFECYCLE_COMMANDS.REPORT_OPERATIONAL]: executeReportOperational,
      [LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED]: executeNotificationPresented,
      [LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED]: executeWorkshopSheetOpened,
      [LIFECYCLE_COMMANDS.WORK_STARTED]: executeWorkStarted,
      [LIFECYCLE_COMMANDS.SET_WAIT_REASON]: executeSetWaitReason
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
      const implementationResult = implementation(command, authority);
      if(implementationResult?.[SEMANTIC_NOOP]){
        db.exec("COMMIT;");
        return {
          ok: true,
          status: 200,
          result: implementationResult.result
        };
      }
      const result = implementationResult;
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
    const processCase = ensureActiveProcessCase(command.vehicleId, timestamp, eventId);
    insertProcessEvent({
      eventType: "FAULT_REGISTERED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      faultId,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        slot: command.slot,
        category: command.category,
        description: command.description
      },
      idempotencyKey: `${command.actionId}:fault-registered`
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
    const processCase = ensureActiveProcessCase(command.vehicleId, timestamp, eventId);
    insertProcessEvent({
      eventType: "NOT_OPERATIONAL_REPORTED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        status: "IKKE_DRIFTSKLAR",
        disposition: "NONE",
        statusRevision: resultingRevision
      },
      idempotencyKey: `${command.actionId}:not-operational`
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
      statusBefore: record?.status_revision || 0, statusAfter: record?.status_revision || 0,
      previousState: { faultStatus: fault.status },
      resultingState: { repairRequestId, repairStatus: "REQUESTED", notificationId }
    });
    const processCase = ensureActiveProcessCase(command.vehicleId, timestamp, eventId);
    insertProcessEvent({
      eventType: "REPAIR_REQUESTED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      faultId: command.faultId,
      repairRequestId,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        status: "REQUESTED",
        requestedAt: timestamp
      },
      idempotencyKey: `${command.actionId}:repair-requested`
    });
    insertProcessEvent({
      eventType: "WORKSHOP_NOTIFICATION_CREATED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      faultId: command.faultId,
      repairRequestId,
      notificationId,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        targetRole: "verksted",
        notificationKind: "REPAIR_REQUESTED"
      },
      idempotencyKey: `${command.actionId}:notification-created`
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      faultId: command.faultId,
      repairRequestId,
      status: "REQUESTED",
      requestedAt: timestamp,
      caseRevision,
      notificationId,
      currentStatus: record?.status || null,
      disposition: record?.disposition || null,
      statusRevision: record?.status_revision || 0,
      externalRequestSent: false
    });
  }

  function executeRequestWorkshopExit(command, authority){
    const placementObservation = findObservation(`placement:${command.vehicleId}`);
    const placement = placementObservation
      ? safeJson(placementObservation.payload_json, {})
      : null;
    const sourceSlot = normalizeSlot(placement?.slot);
    if(!placement || placement.inWorkshop !== true || !WORKSHOP_SLOTS.has(sourceSlot)){
      throw conflict(
        "workshop_current_placement_required",
        "The vehicle must have a server-confirmed current workshop placement."
      );
    }
    if(placementObservation.source_revision !== command.expectedPlacementRevision){
      throw conflict(
        "workshop_placement_revision_mismatch",
        "The workshop placement revision is stale.",
        { currentPlacementRevision: placementObservation.source_revision }
      );
    }
    if(placement.workshopVisitId !== command.expectedVisitId){
      throw conflict(
        "workshop_visit_mismatch",
        "The workshop visit is stale.",
        { currentVisitId: placement.workshopVisitId }
      );
    }
    const existing = db.prepare(`
      SELECT * FROM ${WORKSHOP_EXIT_REQUEST_TABLE}
      WHERE vehicle_id = ? AND visit_id = ?
        AND status IN ('REQUESTED','CARD_CREATED','REPLAN_REQUIRED')
      ORDER BY requested_at, exit_request_id
      LIMIT 1
    `).get(command.vehicleId, placement.workshopVisitId);
    if(existing){
      return semanticNoOp(semanticNoOpResult(
        LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT,
        command,
        existing.event_id,
        {
          ...mapWorkshopExitRequest(existing),
          alreadyRequested: true
        }
      ));
    }

    const timestamp = now();
    const eventId = randomUUID();
    const exitRequestId = randomUUID();
    const txpNotificationId = randomUUID();
    const dropsNotificationId = randomUUID();
    const record = findRecord(command.vehicleId);
    const classification = classifyWorkshopExitRequest(record);
    const reasonCodes = classification === "UNKNOWN"
      ? ["authoritative_operational_classification_unavailable"]
      : [`vehicle_status_${classification.toLowerCase()}`];
    db.prepare(`
      INSERT INTO ${WORKSHOP_EXIT_REQUEST_TABLE} (
        exit_request_id, vehicle_id, visit_id, source_slot,
        placement_revision, classification, reason_codes_json, status,
        requested_at, requested_by, updated_at, completed_at,
        completed_slot, completed_placement_revision, event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, NULL, NULL, NULL, ?)
    `).run(
      exitRequestId,
      command.vehicleId,
      placement.workshopVisitId,
      sourceSlot,
      placementObservation.source_revision,
      classification,
      JSON.stringify(reasonCodes),
      timestamp,
      authority.subject,
      timestamp,
      eventId
    );
    insertWorkshopExitEvent({
      eventType: "WORKSHOP_EXIT_REQUESTED",
      exitRequestId,
      vehicleId: command.vehicleId,
      visitId: placement.workshopVisitId,
      timestamp,
      actorSubject: authority.subject,
      actorRole: authority.effectiveRole,
      sourceRevision: placementObservation.source_revision,
      payload: {
        sourceSlot,
        classification,
        reasonCodes
      },
      idempotencyKey: `${command.actionId}:workshop-exit-requested`
    });
    for(const [targetRole, notificationId] of [
      ["txp", txpNotificationId],
      ["drops", dropsNotificationId]
    ]){
      insertNotification({
        notificationId,
        eventId,
        targetRole,
        kind: "WORKSHOP_EXIT_REQUESTED",
        priority: "HIGH",
        vehicleId: command.vehicleId,
        faultId: null,
        repairRequestId: null,
        timestamp,
        payload: {
          exitRequestId,
          sourceSlot,
          visitId: placement.workshopVisitId,
          requestedAt: timestamp,
          classification,
          reasonCodes
        }
      });
    }
    const currentCase = findCase(command.vehicleId);
    const caseRevision = currentCase?.case_revision || 0;
    insertEvent({
      eventId,
      command,
      commandName: LIFECYCLE_COMMANDS.REQUEST_WORKSHOP_EXIT,
      authority,
      timestamp,
      caseBefore: caseRevision,
      caseAfter: caseRevision,
      statusBefore: record?.status_revision || 0,
      statusAfter: record?.status_revision || 0,
      previousState: {
        sourceSlot,
        visitId: placement.workshopVisitId
      },
      resultingState: {
        exitRequestId,
        status: "REQUESTED",
        txpNotificationId,
        dropsNotificationId
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      exitRequestId,
      visitId: placement.workshopVisitId,
      sourceSlot,
      placementRevision: placementObservation.source_revision,
      classification,
      reasonCodes,
      status: "REQUESTED",
      requestedAt: timestamp,
      requestedBy: authority.subject,
      notificationIds: [txpNotificationId, dropsNotificationId]
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
    const activeFaultsBeforeResolution = selectFaults(command.vehicleId, "ACTIVE");
    const requestedRepairsBeforeCompletion = db.prepare(`
      SELECT * FROM ${REPAIR_TABLE}
      WHERE vehicle_id = ? AND status = 'REQUESTED'
      ORDER BY requested_at, repair_request_id
    `).all(command.vehicleId);
    const activeFaultCount = activeFaultsBeforeResolution.length;
    const requestedRepairCount = requestedRepairsBeforeCompletion.length;
    const hasActiveWork = activeFaultCount > 0 || requestedRepairCount > 0;
    if(record?.status !== "IKKE_DRIFTSKLAR" && !hasActiveWork){
      throw conflict("vehicle_not_not_operational",
        "Only IKKE_DRIFTSKLAR vehicles or vehicles with active workshop work can be reported operational.");
    }
    const timestamp = now();
    const eventId = randomUUID();
    const notificationId = randomUUID();
    const caseChanged = hasActiveWork;
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
      INSERT INTO ${RECORD_TABLE} (
        vehicle_id, status, previous_status, disposition, status_revision,
        registered_at, operational_at, updated_at, last_actor, latest_event_id
      ) VALUES (?, 'DRIFTSKLAR', ?, 'NONE', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_id) DO UPDATE SET
        previous_status=${RECORD_TABLE}.status,
        status='DRIFTSKLAR',
        disposition='NONE',
        status_revision=excluded.status_revision,
        operational_at=excluded.operational_at,
        updated_at=excluded.updated_at,
        last_actor=excluded.last_actor,
        latest_event_id=excluded.latest_event_id
    `).run(
      command.vehicleId,
      record?.status || null,
      resultingStatusRevision,
      record?.registered_at || timestamp,
      timestamp,
      timestamp,
      authority.subject,
      eventId
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
      previousState: {
        status: record?.status || null,
        disposition: record?.disposition || null
      },
      resultingState: {
        status: "DRIFTSKLAR", disposition: "NONE",
        resolvedFaults: activeFaultCount,
        completedRepairRequests: requestedRepairCount,
        notificationId
      }
    });
    const processCase = findActiveProcessCase(command.vehicleId) ||
      ensureActiveProcessCase(command.vehicleId, timestamp, eventId);
    insertProcessEvent({
      eventType: "OPERATIONAL_REPORTED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        status: "DRIFTSKLAR",
        disposition: "NONE",
        statusRevision: resultingStatusRevision
      },
      idempotencyKey: `${command.actionId}:operational`
    });
    for(const fault of activeFaultsBeforeResolution){
      insertProcessEvent({
        eventType: "FAULT_RESOLVED",
        vehicleId: command.vehicleId,
        caseId: processCase.case_id,
        faultId: fault.fault_id,
        actionId: command.actionId,
        timestamp,
        authority,
        payload: { category: fault.category, resolvedAt: timestamp },
        idempotencyKey: `${command.actionId}:fault-resolved:${fault.fault_id}`
      });
    }
    for(const repair of requestedRepairsBeforeCompletion){
      insertProcessEvent({
        eventType: "REPAIR_REQUEST_COMPLETED",
        vehicleId: command.vehicleId,
        caseId: processCase.case_id,
        faultId: repair.fault_id,
        repairRequestId: repair.repair_request_id,
        actionId: command.actionId,
        timestamp,
        authority,
        payload: { completedAt: timestamp },
        idempotencyKey: `${command.actionId}:repair-completed:${repair.repair_request_id}`
      });
    }
    closeProcessCase(processCase.case_id, timestamp);
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      status: "DRIFTSKLAR",
      disposition: "NONE",
      previousDisposition: record?.disposition || null,
      statusRevision: resultingStatusRevision,
      caseRevision: resultingCaseRevision,
      operationalAt: timestamp,
      notificationId,
      resolvedFaults: activeFaultCount,
      completedRepairRequests: requestedRepairCount
    });
  }

  function executeNotificationPresented(command, authority){
    const notification = db.prepare(`
      SELECT * FROM ${NOTIFICATION_TABLE} WHERE notification_id = ?
    `).get(command.notificationId);
    if(!notification){
      throw conflict("notification_not_found", "The notification was not found.", {}, 404);
    }
    if(
      authority.effectiveRole !== notification.target_role ||
      !(authority.roles || []).includes(notification.target_role)
    ){
      throw conflict("notification_role_mismatch",
        "The notification does not target the authenticated role.", {}, 403);
    }
    if(notification.kind === "OPERATIONAL_MESSAGE" || notification.kind === "WORKSHOP_MESSAGE"){
      const message = db.prepare(`
        SELECT * FROM ${OPERATIONAL_MESSAGE_TABLE} WHERE notification_id = ?
      `).get(notification.notification_id);
      if(!message){
        throw conflict("operational_message_not_found",
          "The operational message was not found.", {}, 404);
      }
      const alreadyPresented = db.prepare(`
        SELECT operational_message_event_id, server_timestamp
        FROM ${OPERATIONAL_MESSAGE_EVENT_TABLE}
        WHERE message_id = ? AND event_type = 'OPERATIONAL_MESSAGE_PRESENTED'
        ORDER BY server_timestamp, operational_message_event_id
        LIMIT 1
      `).get(message.message_id);
      const eventCommand = {...command, vehicleId:notification.vehicle_id};
      if(alreadyPresented){
        return semanticNoOp(semanticNoOpResult(
          LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
          eventCommand,
          alreadyPresented.operational_message_event_id,
          {
            notificationId:notification.notification_id,
            timelineEventCreated:false,
            alreadyRecorded:true,
            presentedAt:alreadyPresented.server_timestamp,
            presentationMessageEventId:alreadyPresented.operational_message_event_id,
            caseRevision:0
          }
        ));
      }
      const timestamp = now();
      const eventId = randomUUID();
      const presentationMessageEventId = randomUUID();
      db.prepare(`
        INSERT INTO ${OPERATIONAL_MESSAGE_EVENT_TABLE} (
          operational_message_event_id, event_type, message_id, source_role,
          target_role, server_timestamp, actor_subject, actor_role,
          payload_json, idempotency_key
        ) VALUES (?, 'OPERATIONAL_MESSAGE_PRESENTED', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        presentationMessageEventId,
        message.message_id,
        message.source_role,
        message.target_role,
        timestamp,
        authority.subject,
        authority.effectiveRole,
        JSON.stringify({
          notificationId:notification.notification_id,
          presentationMeaning:
            "Notification rendered in the authenticated target surface; not proof of reading."
        }),
        `operational-message-presented:${notification.notification_id}`
      );
      insertEvent({
        eventId,
        command:eventCommand,
        commandName:LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
        authority,
        timestamp,
        caseBefore:0,
        caseAfter:0,
        statusBefore:0,
        statusAfter:0,
        previousState:{},
        resultingState:{
          notificationId:notification.notification_id,
          presentationMessageEventId
        }
      });
      incrementGlobalRevision();
      return resultBase(eventCommand, eventId, {
        notificationId:notification.notification_id,
        timelineEventCreated:true,
        alreadyRecorded:false,
        presentedAt:timestamp,
        presentationMessageEventId,
        caseRevision:0
      });
    }
    const processCase = findActiveProcessCase(notification.vehicle_id) ||
      findLatestProcessCase(notification.vehicle_id);
    if(!processCase){
      throw conflict("process_case_not_found", "No vehicle process case was found.", {}, 404);
    }
    const currentCaseRevision = findCase(notification.vehicle_id)?.case_revision || 0;
    const alreadyPresented = db.prepare(`
      SELECT process_event_id, action_id, server_timestamp
      FROM ${PROCESS_EVENT_TABLE}
      WHERE case_id = ? AND event_type = 'WORKSHOP_NOTIFICATION_PRESENTED'
        AND notification_id = ?
      ORDER BY server_timestamp, process_event_id
      LIMIT 1
    `).get(processCase.case_id, notification.notification_id);
    const eventCommand = { ...command, vehicleId: notification.vehicle_id };
    if(alreadyPresented){
      return semanticNoOp(semanticNoOpResult(
        LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
        eventCommand,
        originalCommandEventId(alreadyPresented.action_id) || alreadyPresented.process_event_id,
        {
          notificationId: notification.notification_id,
          timelineEventCreated: false,
          alreadyRecorded: true,
          presentedAt: alreadyPresented.server_timestamp,
          presentationProcessEventId: alreadyPresented.process_event_id,
          caseRevision: currentCaseRevision
        }
      ));
    }
    const timestamp = now();
    const eventId = randomUUID();
    const timelineEventCreated = insertProcessEvent({
      eventType: "WORKSHOP_NOTIFICATION_PRESENTED",
      vehicleId: notification.vehicle_id,
      caseId: processCase.case_id,
      faultId: notification.fault_id,
      repairRequestId: notification.repair_request_id,
      notificationId: notification.notification_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        presentationMeaning:
          "Notification rendered in an authenticated client; not proof of reading or understanding."
      },
      idempotencyKey: `notification-presented:${notification.notification_id}`
    });
    insertEvent({
      eventId, command: eventCommand,
      commandName: LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
      authority, timestamp,
      caseBefore: currentCaseRevision, caseAfter: currentCaseRevision,
      statusBefore: statusRevision(notification.vehicle_id),
      statusAfter: statusRevision(notification.vehicle_id),
      previousState: {},
      resultingState: {
        notificationId: notification.notification_id,
        timelineEventCreated
      }
    });
    incrementGlobalRevision();
    return resultBase(eventCommand, eventId, {
      notificationId: notification.notification_id,
      timelineEventCreated,
      alreadyRecorded: false,
      presentedAt: timestamp,
      caseRevision: currentCaseRevision
    });
  }

  function executeAcknowledgeOperationalMessage(command, authority){
    const notification = db.prepare(`
      SELECT * FROM ${NOTIFICATION_TABLE} WHERE notification_id=?
    `).get(command.notificationId);
    if(!notification){
      throw conflict("notification_not_found", "The notification was not found.", {}, 404);
    }
    if(
      authority.effectiveRole !== notification.target_role ||
      !(authority.roles || []).includes(notification.target_role)
    ){
      throw conflict("notification_role_mismatch",
        "The message does not target the authenticated role.", {}, 403);
    }
    const message = db.prepare(`
      SELECT * FROM ${OPERATIONAL_MESSAGE_TABLE}
      WHERE message_id=? AND notification_id=?
    `).get(command.messageId, command.notificationId);
    if(!message){
      throw conflict("operational_message_not_found",
        "The operational message was not found.", {}, 404);
    }
    const existing = db.prepare(`
      SELECT * FROM ${OPERATIONAL_MESSAGE_ACK_TABLE}
      WHERE notification_id=?
    `).get(command.notificationId);
    const eventCommand = {...command, vehicleId:"OPERATIONAL_MESSAGE"};
    if(existing){
      return semanticNoOp(semanticNoOpResult(
        LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
        eventCommand,
        existing.acknowledgement_id,
        {
          acknowledgementId:existing.acknowledgement_id,
          messageId:existing.message_id,
          notificationId:existing.notification_id,
          targetRole:existing.target_role,
          acknowledgedAt:existing.acknowledged_at,
          acknowledgedByRole:existing.acknowledged_by_role,
          alreadyRecorded:true,
          caseRevision:0
        }
      ));
    }
    const timestamp = now();
    const eventId = randomUUID();
    const acknowledgementId = randomUUID();
    db.prepare(`
      INSERT INTO ${OPERATIONAL_MESSAGE_ACK_TABLE} (
        acknowledgement_id, message_id, notification_id, target_role,
        acknowledged_at, acknowledged_by_role, actor_subject,
        action_id, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      acknowledgementId,
      message.message_id,
      notification.notification_id,
      notification.target_role,
      timestamp,
      authority.effectiveRole,
      authority.subject,
      command.actionId,
      `operational-message-acknowledged:${notification.notification_id}`
    );
    insertEvent({
      eventId,
      command:eventCommand,
      commandName:LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
      authority,
      timestamp,
      caseBefore:0,
      caseAfter:0,
      statusBefore:0,
      statusAfter:0,
      previousState:{},
      resultingState:{
        acknowledgementId,
        messageId:message.message_id,
        notificationId:notification.notification_id,
        targetRole:notification.target_role,
        acknowledgedAt:timestamp
      }
    });
    incrementGlobalRevision();
    return resultBase(eventCommand, eventId, {
      acknowledgementId,
      messageId:message.message_id,
      notificationId:notification.notification_id,
      targetRole:notification.target_role,
      acknowledgedAt:timestamp,
      acknowledgedByRole:authority.effectiveRole,
      alreadyRecorded:false,
      caseRevision:0
    });
  }

  function executeWorkshopSheetOpened(command, authority){
    const processCase = command.caseId
      ? findProcessCase(command.caseId, command.vehicleId)
      : (findActiveProcessCase(command.vehicleId) || findLatestProcessCase(command.vehicleId));
    if(!processCase){
      throw conflict("process_case_not_found", "No vehicle process case was found.", {}, 404);
    }
    const currentCaseRevision = findCase(command.vehicleId)?.case_revision || 0;
    const alreadyOpened = db.prepare(`
      SELECT process_event_id, action_id, server_timestamp
      FROM ${PROCESS_EVENT_TABLE}
      WHERE case_id = ? AND event_type = 'WORKSHOP_SHEET_FIRST_OPENED'
      ORDER BY server_timestamp, process_event_id
      LIMIT 1
    `).get(processCase.case_id);
    if(alreadyOpened){
      return semanticNoOp(semanticNoOpResult(
        LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED,
        command,
        originalCommandEventId(alreadyOpened.action_id) || alreadyOpened.process_event_id,
        {
          caseId: processCase.case_id,
          timelineEventCreated: false,
          alreadyRecorded: true,
          firstOpenedAt: alreadyOpened.server_timestamp,
          firstOpenedProcessEventId: alreadyOpened.process_event_id,
          caseRevision: currentCaseRevision
        }
      ));
    }
    const timestamp = now();
    const eventId = randomUUID();
    const timelineEventCreated = insertProcessEvent({
      eventType: "WORKSHOP_SHEET_FIRST_OPENED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: {
        openingMeaning:
          "Vehicle sheet opened in an authenticated client; not proof of reading or work start."
      },
      idempotencyKey: `workshop-sheet-first-opened:${processCase.case_id}`
    });
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.WORKSHOP_SHEET_OPENED,
      authority, timestamp,
      caseBefore: currentCaseRevision, caseAfter: currentCaseRevision,
      statusBefore: statusRevision(command.vehicleId),
      statusAfter: statusRevision(command.vehicleId),
      previousState: {},
      resultingState: { caseId: processCase.case_id, timelineEventCreated }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      caseId: processCase.case_id,
      timelineEventCreated,
      alreadyRecorded: false,
      firstOpenedAt: timestamp,
      caseRevision: currentCaseRevision
    });
  }

  function executeWorkStarted(command, authority){
    const processCase = findActiveProcessCase(command.vehicleId);
    if(!processCase){
      throw conflict("active_process_case_required", "An active vehicle process case is required.");
    }
    const currentCase = findCase(command.vehicleId);
    const currentCaseRevision = currentCase?.case_revision || 0;
    requireRevision(command.expectedCaseRevision, currentCaseRevision,
      "case_revision_mismatch", { currentCaseRevision });
    const activeWork = countWhere(
      FAULT_TABLE,
      "vehicle_id = ? AND status = 'ACTIVE'",
      command.vehicleId
    ) + countWhere(
      REPAIR_TABLE,
      "vehicle_id = ? AND status = 'REQUESTED'",
      command.vehicleId
    );
    if(activeWork === 0){
      throw conflict("active_work_required",
        "An ACTIVE fault or REQUESTED repair request is required.");
    }
    if(db.prepare(`
      SELECT 1 FROM ${PROCESS_EVENT_TABLE}
      WHERE case_id = ? AND event_type = 'WORK_STARTED'
    `).get(processCase.case_id)){
      throw conflict("work_already_started", "Work has already been started for this case.");
    }
    const timestamp = now();
    const eventId = randomUUID();
    const caseRevision = currentCaseRevision + 1;
    updateCase(command.vehicleId, timestamp, eventId, caseRevision);
    insertProcessEvent({
      eventType: "WORK_STARTED",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: { workStartedAt: timestamp },
      idempotencyKey: `${command.actionId}:work-started`
    });
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.WORK_STARTED,
      authority, timestamp,
      caseBefore: currentCaseRevision, caseAfter: caseRevision,
      statusBefore: statusRevision(command.vehicleId),
      statusAfter: statusRevision(command.vehicleId),
      previousState: {},
      resultingState: { workStartedAt: timestamp }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      caseId: processCase.case_id,
      workStartedAt: timestamp,
      caseRevision
    });
  }

  function executeSetWaitReason(command, authority){
    const processCase = findActiveProcessCase(command.vehicleId);
    if(!processCase){
      throw conflict("active_process_case_required", "An active vehicle process case is required.");
    }
    const currentCase = findCase(command.vehicleId);
    const currentCaseRevision = currentCase?.case_revision || 0;
    requireRevision(command.expectedCaseRevision, currentCaseRevision,
      "case_revision_mismatch", { currentCaseRevision });
    const timestamp = now();
    const eventId = randomUUID();
    const caseRevision = currentCaseRevision + 1;
    updateCase(command.vehicleId, timestamp, eventId, caseRevision);
    db.prepare(`
      UPDATE ${PROCESS_CASE_TABLE}
      SET current_wait_reason = ?, latest_event_at = ?
      WHERE case_id = ?
    `).run(command.reason, timestamp, processCase.case_id);
    insertProcessEvent({
      eventType: "WAIT_REASON_SET",
      vehicleId: command.vehicleId,
      caseId: processCase.case_id,
      actionId: command.actionId,
      timestamp,
      authority,
      payload: { reason: command.reason },
      idempotencyKey: `${command.actionId}:wait-reason`
    });
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.SET_WAIT_REASON,
      authority, timestamp,
      caseBefore: currentCaseRevision, caseAfter: caseRevision,
      statusBefore: statusRevision(command.vehicleId),
      statusAfter: statusRevision(command.vehicleId),
      previousState: { reason: processCase.current_wait_reason || "NONE" },
      resultingState: { reason: command.reason }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      caseId: processCase.case_id,
      currentWaitReason: command.reason,
      waitReasonSetAt: timestamp,
      caseRevision
    });
  }

  function executeManageWorkshopIngressQueue(command, authority){
    const currentPlacementRevision = currentWorkshopPlacementRevision();
    if(command.expectedPlacementRevision !== currentPlacementRevision){
      throw conflict("placement_revision_mismatch",
        "Expected placement revision does not match current canonical placement.", {
          currentPlacementRevision
        });
    }
    const currentQueueRevision = workshopQueueRevision(command.targetSlot);
    requireRevision(command.expectedQueueRevision, currentQueueRevision,
      "queue_revision_mismatch", { currentQueueRevision });
    const timestamp = now();
    const eventId = randomUUID();
    let queueEntry;
    let initialStatus = null;

    if(command.operation === "ADD"){
      const duplicate = db.prepare(`
        SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
        WHERE vehicle_id = ?
          AND status IN ('QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED','REPLAN_REQUIRED')
      `).get(command.vehicleId);
      if(duplicate){
        throw conflict("workshop_queue_duplicate",
          "Vehicle already has an active workshop ingress entry.", {
            existingTargetSlot: duplicate.target_slot,
            existingQueueEntryId: duplicate.queue_entry_id
          });
      }
      const occupiedBy = workshopSlotOccupant(command.targetSlot);
      const activeCardOwner = activeWorkshopIngressCardOwner(command.targetSlot);
      const currentSourceSlot = currentVehicleSlot(command.vehicleId);
      const routeNeedsReplan = (
        !currentSourceSlot ||
        currentSourceSlot === command.targetSlot
      );
      const canActivate = (
        !routeNeedsReplan &&
        !occupiedBy &&
        !activeCardOwner &&
        currentSourceSlot
      );
      initialStatus = routeNeedsReplan
        ? "REPLAN_REQUIRED"
        : (canActivate
          ? (command.requestType === "ASAP" ? "CARD_CREATED" : "READY_FOR_ACTIVATION")
          : "QUEUED");
      const queueEntryId = randomUUID();
      const linkedCardId = initialStatus === "CARD_CREATED"
        ? `workshop-ingress|${queueEntryId}|${command.vehicleId}|${command.targetSlot}`
        : null;
      const position = nextWorkshopQueuePosition(command.targetSlot);
      const reasonCodes = routeNeedsReplan
        ? [currentSourceSlot
          ? "TARGET_EQUALS_CURRENT_SOURCE"
          : "SOURCE_SLOT_UNRESOLVED"]
        : (canActivate
          ? []
          : [activeCardOwner
            ? "TARGET_RESERVED_BY_EXISTING_CARD"
            : (command.requestType === "ASAP"
              ? "HIGH_PRIORITY_WAITING_FOR_SLOT"
              : "WAITING_FOR_SLOT")]);
      db.prepare(`
        INSERT INTO ${WORKSHOP_INGRESS_QUEUE_TABLE} (
          queue_entry_id, target_slot, vehicle_id, position, status,
          created_at, created_by, updated_at, linked_card_id,
          reason_codes_json, placement_revision, request_type, priority,
          requested_at, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        queueEntryId, command.targetSlot, command.vehicleId, position, initialStatus,
        timestamp, authority.subject, timestamp, linkedCardId,
        JSON.stringify(reasonCodes), currentPlacementRevision,
        command.requestType, command.priority, timestamp,
        canActivate || routeNeedsReplan ? null : timestamp
      );
      queueEntry = db.prepare(`
        SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id = ?
      `).get(queueEntryId);
      insertWorkshopQueueEvent({
        eventType: initialStatus === "CARD_CREATED"
          ? "WORKSHOP_INGRESS_CARD_CREATED"
          : (initialStatus === "READY_FOR_ACTIVATION"
            ? "WORKSHOP_INGRESS_READY"
            : (initialStatus === "REPLAN_REQUIRED"
              ? "WORKSHOP_INGRESS_REPLAN_REQUIRED"
              : "WORKSHOP_INGRESS_QUEUED")),
        queueEntry,
        timestamp,
        authority,
        sourceRevision: currentPlacementRevision,
        payload: {
          operation: command.operation,
          requestType: command.requestType,
          priority: command.priority,
          requestedAt: timestamp,
          queuedAt: canActivate || routeNeedsReplan ? null : timestamp,
          initialStatus,
          linkedCardId
        },
        idempotencyKey: `${command.actionId}:workshop-ingress:${initialStatus}`
      });
      if(command.requestType === "ASAP"){
        for(const targetRole of ["txp", "sde_skiftere", "drops"]){
          insertNotification({
            notificationId: randomUUID(),
            eventId,
            targetRole,
            kind: "WORKSHOP_INGRESS_REQUESTED",
            priority: targetRole === "drops" ? "NORMAL" : "HIGH",
            vehicleId: command.vehicleId,
            faultId: null,
            repairRequestId: null,
            timestamp,
            payload: {
              queueEntryId,
              requestType: command.requestType,
              priority: command.priority,
              targetSlot: command.targetSlot,
              status: initialStatus === "REPLAN_REQUIRED"
                ? initialStatus
                : (canActivate
                  ? initialStatus
                  : "HIGH_PRIORITY_WAITING_FOR_SLOT"),
              requestedAt: timestamp,
              linkedCardId
            }
          });
        }
      }
      if(initialStatus === "READY_FOR_ACTIVATION"){
        activateWorkshopIngressQueueForEmptySlots({
          slot: command.targetSlot,
          sourceRevision: currentPlacementRevision,
          timestamp
        });
        queueEntry = db.prepare(`
          SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id = ?
        `).get(queueEntryId);
      }
    }else{
      queueEntry = db.prepare(`
        SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
        WHERE queue_entry_id = ? AND target_slot = ?
      `).get(command.queueEntryId, command.targetSlot);
      if(!queueEntry){
        throw conflict("workshop_queue_entry_not_found", "Queue entry was not found.", {}, 404);
      }
      if(command.operation === "CANCEL"){
        db.prepare(`
          UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
          SET status='CANCELLED', updated_at=?, linked_card_id=NULL
          WHERE queue_entry_id=?
        `).run(timestamp, queueEntry.queue_entry_id);
        queueEntry = db.prepare(`
          SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
        `).get(queueEntry.queue_entry_id);
        insertWorkshopQueueEvent({
          eventType: "WORKSHOP_INGRESS_CANCELLED",
          queueEntry, timestamp, authority, sourceRevision: currentPlacementRevision,
          payload: { operation: command.operation },
          idempotencyKey: `${command.actionId}:workshop-ingress:cancelled`
        });
      }else{
        moveWorkshopQueueEntry(queueEntry, command.operation, timestamp);
        queueEntry = db.prepare(`
          SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
        `).get(queueEntry.queue_entry_id);
        insertWorkshopQueueEvent({
          eventType: "WORKSHOP_INGRESS_REORDERED",
          queueEntry, timestamp, authority, sourceRevision: currentPlacementRevision,
          payload: { operation: command.operation, position: queueEntry.position },
          idempotencyKey: `${command.actionId}:workshop-ingress:reordered`
        });
      }
    }
    const queueRevision = incrementWorkshopQueueRevision(command.targetSlot);
    normalizeWorkshopQueuePositions(command.targetSlot);
    queueEntry = db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
    `).get(queueEntry.queue_entry_id);
    insertEvent({
      eventId, command, commandName: LIFECYCLE_COMMANDS.MANAGE_WORKSHOP_INGRESS_QUEUE,
      authority, timestamp,
      caseBefore: 0, caseAfter: 0, statusBefore: 0, statusAfter: 0,
      previousState: { queueRevision: currentQueueRevision },
      resultingState: {
        queueEntryId: queueEntry.queue_entry_id,
        targetSlot: queueEntry.target_slot,
        status: publicWorkshopIngressStatus(queueEntry),
        initialStatus,
        requestType: queueEntry.request_type,
        priority: queueEntry.priority,
        queueRevision
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      queueEntryId: queueEntry.queue_entry_id,
      targetSlot: queueEntry.target_slot,
      vehicleId: queueEntry.vehicle_id,
      position: queueEntry.position,
      status: publicWorkshopIngressStatus(queueEntry),
      initialStatus: command.operation === "ADD" ? (
        queueEntry.request_type === "PREBOOKED" && queueEntry.status === "CARD_CREATED"
          ? "READY_FOR_ACTIVATION"
          : publicWorkshopIngressStatus(queueEntry)
      ) : publicWorkshopIngressStatus(queueEntry),
      requestType: queueEntry.request_type,
      priority: queueEntry.priority,
      requestedAt: queueEntry.requested_at,
      queuedAt: queueEntry.queued_at,
      linkedCardId: queueEntry.linked_card_id,
      queueRevision,
      placementRevision: currentPlacementRevision
    });
  }

  function executeRequestCleaningTrackSpace(command, authority){
    const timestamp = now();
    const requestedStart = resolveEuropeOsloDateTime(
      command.requestedDate,
      command.startTime
    );
    if(!requestedStart){
      throw conflict(
        "invalid_cleaning_start_time",
        "The requested Europe/Oslo start time is invalid.",
        {},
        400
      );
    }
    const leadTimeMinutes = Math.floor(
      (Date.parse(requestedStart) - Date.parse(timestamp)) / 60000
    );
    if(!Number.isFinite(leadTimeMinutes) || leadTimeMinutes <= 0){
      throw conflict(
        "cleaning_start_time_not_future",
        "The requested cleaning start must be in the future.",
        {},
        400
      );
    }
    const shortNotice = leadTimeMinutes < 24 * 60;
    if(shortNotice && command.shortNoticeAcknowledged !== true){
      throw conflict(
        "cleaning_short_notice_acknowledgement_required",
        "Requests less than 24 hours ahead require explicit acknowledgement."
      );
    }

    const eventId = randomUUID();
    const cleaningRequestId = randomUUID();
    const reasonCodes = shortNotice ? ["SHORT_NOTICE_ACKNOWLEDGED"] : [];
    db.prepare(`
      INSERT INTO ${CLEANING_TRACK_REQUEST_TABLE} (
        cleaning_request_id, requested_slots_json, requested_date, start_time,
        time_zone, planned_start_at, lead_time_minutes, short_notice,
        short_notice_acknowledged, status, reason_codes_json,
        requested_at, requested_by, updated_at, event_id
      ) VALUES (?, ?, ?, ?, 'Europe/Oslo', ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?)
    `).run(
      cleaningRequestId,
      JSON.stringify(command.requestedSlots),
      command.requestedDate,
      command.startTime,
      requestedStart,
      leadTimeMinutes,
      shortNotice ? 1 : 0,
      command.shortNoticeAcknowledged ? 1 : 0,
      JSON.stringify(reasonCodes),
      timestamp,
      authority.subject,
      timestamp,
      eventId
    );
    for(const targetRole of ["txp", "drops"]){
      insertNotification({
        notificationId:randomUUID(),
        eventId,
        targetRole,
        kind:"CLEANING_TRACK_SPACE_REQUESTED",
        priority:shortNotice ? "HIGH" : "NORMAL",
        vehicleId:"CLEANING_TRACK_SPACE",
        faultId:null,
        repairRequestId:null,
        timestamp,
        payload:{
          cleaningRequestId,
          requestedSlots:command.requestedSlots,
          requestedDate:command.requestedDate,
          startTime:command.startTime,
          timeZone:"Europe/Oslo",
          plannedStartAt:requestedStart,
          shortNotice,
          requestedAt:timestamp
        }
      });
    }
    insertEvent({
      eventId,
      command,
      commandName:LIFECYCLE_COMMANDS.REQUEST_CLEANING_TRACK_SPACE,
      authority,
      timestamp,
      caseBefore:0,
      caseAfter:0,
      statusBefore:0,
      statusAfter:0,
      previousState:{},
      resultingState:{
        cleaningRequestId,
        requestedSlots:command.requestedSlots,
        plannedStartAt:requestedStart,
        status:"REQUESTED",
        shortNotice
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      cleaningRequestId,
      requestedSlots:command.requestedSlots,
      requestedDate:command.requestedDate,
      startTime:command.startTime,
      timeZone:"Europe/Oslo",
      plannedStartAt:requestedStart,
      leadTimeMinutes,
      shortNotice,
      shortNoticeAcknowledged:command.shortNoticeAcknowledged,
      reasonCodes,
      status:"REQUESTED",
      requestedAt:timestamp
    });
  }

  function executeSendOperationalMessage(command, authority){
    if(command.sourceRole !== authority.effectiveRole){
      throw conflict("message_source_role_mismatch",
        "The message source does not match the authenticated effective role.", {}, 403);
    }
    const eventCommand = {
      ...command,
      vehicleId:command.context?.vehicleId || command.vehicleId || "OPERATIONAL_MESSAGE"
    };
    const timestamp = now();
    const eventId = randomUUID();
    const messageId = randomUUID();
    const notificationId = randomUUID();
    db.prepare(`
      INSERT INTO ${OPERATIONAL_MESSAGE_TABLE} (
        message_id, source_role, target_role, message_text, context_json,
        created_at, created_by, notification_id, event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      command.sourceRole,
      command.targetRole,
      command.message,
      JSON.stringify(command.context || {}),
      timestamp,
      authority.subject,
      notificationId,
      eventId
    );
    db.prepare(`
      INSERT INTO ${OPERATIONAL_MESSAGE_EVENT_TABLE} (
        operational_message_event_id, event_type, message_id, source_role,
        target_role, server_timestamp, actor_subject, actor_role,
        payload_json, idempotency_key
      ) VALUES (?, 'OPERATIONAL_MESSAGE_SENT', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      messageId,
      command.sourceRole,
      command.targetRole,
      timestamp,
      authority.subject,
      authority.effectiveRole,
      JSON.stringify({
        message:command.message,
        context:command.context || {}
      }),
      `${command.actionId}:operational-message`
    );
    insertNotification({
      notificationId,
      eventId,
      targetRole: command.targetRole,
      kind: "OPERATIONAL_MESSAGE",
      priority: "NORMAL",
      vehicleId: command.context?.vehicleId || "OPERATIONAL_MESSAGE",
      faultId: null,
      repairRequestId: null,
      timestamp,
      payload: {
        messageId,
        message:command.message,
        sourceRole:command.sourceRole,
        targetRole:command.targetRole,
        context:command.context || {},
        selectedSlotId:command.context?.slotId || "",
        selectedVehicleId:command.context?.vehicleId || "",
        sentAt:timestamp
      }
    });
    insertEvent({
      eventId,
      command:eventCommand,
      commandName:LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
      authority, timestamp,
      caseBefore: 0, caseAfter: 0, statusBefore: 0, statusAfter: 0,
      previousState: {},
      resultingState: {
        messageId,
        notificationId,
        sourceRole:command.sourceRole,
        targetRole:command.targetRole,
        context:command.context || {}
      }
    });
    incrementGlobalRevision();
    return resultBase(command, eventId, {
      messageId,
      notificationId,
      messageRevision:eventId,
      sourceRole:command.sourceRole,
      targetRole: command.targetRole,
      createdAt: timestamp,
      context:command.context || {},
      selectedSlotId:command.context?.slotId || "",
      selectedVehicleId:command.context?.vehicleId || ""
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
    const workshopExitRequests = selectWorkshopExitRequests();
    const workshopExitEvents = selectWorkshopExitEvents();
    const workshopIngressQueue = selectWorkshopIngressQueue();
    const workshopIngressQueueEvents = selectWorkshopIngressQueueEvents();
    const cleaningTrackSpaceRequests = roles.includes("agila")
      ? db.prepare(`
          SELECT * FROM ${CLEANING_TRACK_REQUEST_TABLE}
          ORDER BY requested_at, cleaning_request_id
        `).all().map(mapCleaningTrackSpaceRequest)
      : [];
    const allOperationalMessages = selectOperationalMessages();
    const operationalMessages = roles.length
      ? allOperationalMessages.filter((message) => roles.includes(message.targetRole))
      : [];
    const operationalMessageReceipts = roles.length
      ? allOperationalMessages
          .filter((message) => roles.includes(message.sourceRole))
          .map((message) => ({
            messageId:message.messageId,
            notificationId:message.notificationId,
            sourceRole:message.sourceRole,
            targetRole:message.targetRole,
            sentAt:message.sentAt,
            messageRevision:message.eventId
          }))
      : [];
    const operationalMessageAcknowledgements = roles.length
      ? db.prepare(`
          SELECT * FROM ${OPERATIONAL_MESSAGE_ACK_TABLE}
          ORDER BY acknowledged_at, acknowledgement_id
        `).all()
          .filter((acknowledgement) => roles.includes(acknowledgement.target_role))
          .map(mapOperationalMessageAcknowledgement)
      : [];
    const events = db.prepare(`SELECT * FROM ${EVENT_TABLE} ORDER BY server_timestamp, event_id`).all()
      .map(mapEvent);
    const processEvents = selectProcessEvents();
    const processCases = buildProcessCases({
      caseRows: selectProcessCaseRows(),
      events: processEvents
    });
    const allNotifications = db.prepare(`
      SELECT n.*, (
        SELECT e.server_timestamp
        FROM ${OPERATIONAL_MESSAGE_TABLE} m
        JOIN ${OPERATIONAL_MESSAGE_EVENT_TABLE} e ON e.message_id=m.message_id
        WHERE m.notification_id=n.notification_id
          AND e.event_type='OPERATIONAL_MESSAGE_PRESENTED'
        ORDER BY e.server_timestamp, e.operational_message_event_id
        LIMIT 1
      ) AS presented_at, (
        SELECT a.acknowledged_at
        FROM ${OPERATIONAL_MESSAGE_ACK_TABLE} a
        WHERE a.notification_id=n.notification_id
        LIMIT 1
      ) AS acknowledged_at
      FROM ${NOTIFICATION_TABLE} n
      ORDER BY n.created_at, n.notification_id
    `).all().map(mapNotification);
    const notifications = roles.length
      ? allNotifications.filter((notification) => roles.includes(notification.targetRole))
      : [];
    const records = db.prepare(`SELECT * FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all();
    const itemVehicleIds = [...new Set([
      ...records.map((record) => record.vehicle_id),
      ...cases.map((vehicleCase) => vehicleCase.vehicleId),
      ...faults.map((fault) => fault.vehicleId)
    ])].sort();
    const items = itemVehicleIds.map((vehicleId) => {
        const record = records.find((candidate) => candidate.vehicle_id === vehicleId) || null;
        const vehicleFaults = faults.filter((fault) =>
          fault.vehicleId === vehicleId && fault.status === "ACTIVE");
        const caseRecord = cases.find((candidate) => candidate.vehicleId === vehicleId);
        return {
          vehicleId,
          currentStatus: record?.status || null,
          previousStatus: record?.previous_status || null,
          workshopDisposition: record?.disposition || null,
          statusReason: vehicleFaults[0]?.description || null,
          statusAuthority: record
            ? (record.status === "DRIFTSKLAR"
              ? "vehicle_status.report_operational"
              : "vehicle_status.report_not_operational")
            : null,
          registeredAt: record?.registered_at || null,
          operationalAt: record?.operational_at || null,
          registeredBy: record?.last_actor || null,
          sourceLevel,
          stationPresenceAtRegistration: null,
          stationSlotAtRegistration: null,
          activeCaseId: processCases.find((candidate) =>
            candidate.vehicleId === vehicleId && candidate.active)?.caseId ||
            caseRecord?.vehicleId ||
            vehicleId,
          statusRevision: record?.status_revision || 0,
          caseRevision: caseRecord?.caseRevision || 0,
          activeFaults: vehicleFaults,
          latestResolution: faults.find((fault) =>
            fault.vehicleId === vehicleId && fault.status === "RESOLVED") || null,
          updatedAt: record?.updated_at || caseRecord?.updatedAt || null
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
      workshopExitRequests,
      workshopExitEvents,
      workshopIngressQueue,
      workshopIngressQueueEvents,
      cleaningTrackSpaceRequests,
      operationalMessages,
      operationalMessageReceipts,
      operationalMessageAcknowledgements,
      workshopMessages:operationalMessages,
      events,
      processEvents,
      processCases,
      placements: selectPlacementObservations(),
      notifications,
      diagnostics: [],
      message: {
        code: "vehicle_status_lifecycle_repository_active",
        text: "Authoritative vehicle-status lifecycle persistence is active."
      },
      openPolicyDecisions: []
    };
  }

  function getAnalytics(filter = {}){
    const readModel = getReadModel({ roles: [] });
    return buildAnalytics({
      now,
      filter,
      cases: readModel.processCases,
      faults: readModel.faults,
      repairs: readModel.repairRequests,
      records: readModel.items,
      placements: selectPlacementObservations()
    });
  }

  function observeCanonicalPlacements(input = {}){
    const sourceRevision = String(input.placementRevision ?? "");
    if(!sourceRevision || !Array.isArray(input.placements)){
      throw new TypeError("placementRevision and placements are required.");
    }
    db.exec("BEGIN IMMEDIATE;");
    try{
      let eventsCreated = 0;
      const timestamp = now();
      const currentWorkshopOccupants = new Map();
      for(const raw of input.placements){
        const slot = normalizeSlot(raw?.slot);
        const vehicleId = String(raw?.vehicleId || "").trim();
        if(WORKSHOP_SLOTS.has(slot) && vehicleId){
          if(currentWorkshopOccupants.has(slot)){
            currentWorkshopOccupants.set(slot, null);
          }else{
            currentWorkshopOccupants.set(slot, vehicleId);
          }
        }
      }
      for(const raw of input.placements){
        const vehicleId = String(raw?.vehicleId || "").trim();
        const slot = normalizeSlot(raw?.slot);
        if(!vehicleId || !slot) continue;
        const observerKey = `placement:${vehicleId}`;
        const previous = findObservation(observerKey);
        if(previous?.source_revision === sourceRevision) continue;
        const previousPayload = previous ? safeJson(previous.payload_json, {}) : null;
        const fromSlot = normalizeSlot(previousPayload?.slot);
        const fromWorkshop = WORKSHOP_SLOTS.has(fromSlot);
        const toWorkshop = WORKSHOP_SLOTS.has(slot);
        const previousVisitId =
          typeof previousPayload?.workshopVisitId === "string"
            ? previousPayload.workshopVisitId
            : (typeof previousPayload?.lastWorkshopVisitId === "string"
              ? previousPayload.lastWorkshopVisitId
              : null);
        const workshopVisitId = toWorkshop
          ? (fromWorkshop && previousVisitId
            ? previousVisitId
            : `workshop-visit|${vehicleId}|${sourceRevision}`)
          : null;
        if(previousPayload){
          const eventType = !fromWorkshop && toWorkshop
            ? "WORKSHOP_AREA_ENTERED"
            : (fromWorkshop && !toWorkshop ? "WORKSHOP_AREA_EXITED" : null);
          const processCase = eventType === "WORKSHOP_AREA_ENTERED"
            ? findActiveProcessCase(vehicleId)
            : (eventType === "WORKSHOP_AREA_EXITED"
              ? findProcessCaseWithOpenWorkshopSegment(vehicleId)
              : null);
          if(eventType && processCase){
            eventsCreated += insertProcessEvent({
              eventType,
              vehicleId,
              caseId: processCase.case_id,
              timestamp,
              payload: { fromSlot, toSlot: slot, placementRevision: sourceRevision },
              sourceRevision,
              idempotencyKey:
                `placement:${processCase.case_id}:${sourceRevision}:${fromSlot}:${slot}:${eventType}`
            }) ? 1 : 0;
          }
          if(fromWorkshop && !toWorkshop && previousVisitId){
            eventsCreated += completeActiveWorkshopExitRequests({
              vehicleId,
              visitId: previousVisitId,
              completedSlot: slot,
              placementRevision: sourceRevision,
              timestamp
            });
          }
        }
        upsertObservation(observerKey, sourceRevision, {
          vehicleId,
          slot,
          inWorkshop: toWorkshop,
          placementRevision: sourceRevision,
          observedAt: timestamp,
          workshopVisitId,
          lastWorkshopVisitId: workshopVisitId || previousVisitId
        }, timestamp);
      }
      for(const slot of WORKSHOP_SLOTS){
        const observerKey = `workshop-slot:${slot}`;
        const previous = findObservation(observerKey);
        const previousPayload = previous ? safeJson(previous.payload_json, {}) : {};
        const previousVehicleId = String(previousPayload?.vehicleId || "");
        const vehicleId = currentWorkshopOccupants.get(slot) || "";
        upsertObservation(observerKey, sourceRevision, {
          slot,
          vehicleId: vehicleId || null,
          ambiguous: currentWorkshopOccupants.has(slot) && vehicleId === "",
          placementRevision: sourceRevision,
          observedAt: timestamp
        }, timestamp);
        if(previous && previousVehicleId && !vehicleId){
          eventsCreated += activateWorkshopIngressQueueForEmptySlots({
            slot,
            sourceRevision,
            timestamp
          });
        }else if(vehicleId){
          eventsCreated += replanWorkshopIngressCardsForOccupiedSlot({
            slot,
            vehicleId,
            sourceRevision,
            timestamp
          });
        }
      }
      upsertObservation("workshop-placement-snapshot", sourceRevision, {
        placementRevision: sourceRevision,
        observedAt: timestamp
      }, timestamp);
      if(eventsCreated) incrementGlobalRevision();
      db.exec("COMMIT;");
      return { eventsCreated, placementRevision: sourceRevision };
    }catch(error){
      rollbackQuietly(db);
      throw error;
    }
  }

  function observeProductionOccurrences(input = {}){
    const sourceRevision = String(input.sourceRevision || "").trim();
    if(!sourceRevision || !Array.isArray(input.occurrences)){
      throw new TypeError("sourceRevision and occurrences are required.");
    }
    db.exec("BEGIN IMMEDIATE;");
    try{
      const timestamp = now();
      const baselineKey = "production-occurrence-baseline";
      const previous = findObservation(baselineKey);
      if(!previous){
        upsertObservation(baselineKey, sourceRevision, {
          initialized: true,
          occurrenceCount: input.occurrences.length
        }, timestamp);
        db.exec("COMMIT;");
        return { eventsCreated: 0, sourceRevision, baselineEstablished: true };
      }
      if(previous.source_revision === sourceRevision){
        db.exec("COMMIT;");
        return { eventsCreated: 0, sourceRevision, replay: true };
      }
      let eventsCreated = 0;
      const closedCases = selectProcessCaseRows().filter((processCase) => processCase.closedAt);
      for(const processCase of closedCases){
        if(db.prepare(`
          SELECT 1 FROM ${PROCESS_EVENT_TABLE}
          WHERE case_id = ? AND event_type = 'RETURN_TO_SERVICE_DETECTED'
        `).get(processCase.caseId)) continue;
        const occurrence = input.occurrences
          .filter((candidate) =>
            String(candidate?.vehicleId || "") === processCase.vehicleId &&
            validEvidenceType(candidate?.evidenceType) &&
            Date.parse(String(candidate?.departureAt || "")) >
              Date.parse(String(processCase.closedAt || ""))
          )
          .sort((left, right) =>
            Date.parse(left.departureAt) - Date.parse(right.departureAt))[0];
        if(!occurrence?.occurrenceId || !occurrence?.operationalDate) continue;
        eventsCreated += insertProcessEvent({
          eventType: "RETURN_TO_SERVICE_DETECTED",
          vehicleId: processCase.vehicleId,
          caseId: processCase.caseId,
          timestamp,
          payload: {
            operationalDate: occurrence.operationalDate,
            trainNumber: occurrence.trainNumber || null,
            departureAt: occurrence.departureAt,
            detectedAt: timestamp
          },
          sourceRevision,
          sourceOccurrenceId: occurrence.occurrenceId,
          evidenceType: occurrence.evidenceType,
          idempotencyKey:
            `return-to-service:${processCase.caseId}:${occurrence.occurrenceId}`
        }) ? 1 : 0;
      }
      upsertObservation(baselineKey, sourceRevision, {
        initialized: true,
        occurrenceCount: input.occurrences.length
      }, timestamp);
      if(eventsCreated) incrementGlobalRevision();
      db.exec("COMMIT;");
      return { eventsCreated, sourceRevision };
    }catch(error){
      rollbackQuietly(db);
      throw error;
    }
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
        idempotency: countRows(IDEMPOTENCY_TABLE),
        processCases: countRows(PROCESS_CASE_TABLE),
        processEvents: countRows(PROCESS_EVENT_TABLE),
        processObservations: countRows(PROCESS_OBSERVATION_TABLE),
        workshopExitRequests: countRows(WORKSHOP_EXIT_REQUEST_TABLE),
        workshopExitEvents: countRows(WORKSHOP_EXIT_EVENT_TABLE),
        operationalMessages: countRows(OPERATIONAL_MESSAGE_TABLE),
        operationalMessageEvents: countRows(OPERATIONAL_MESSAGE_EVENT_TABLE),
        operationalMessageAcknowledgements: countRows(OPERATIONAL_MESSAGE_ACK_TABLE),
        cleaningTrackSpaceRequests: countRows(CLEANING_TRACK_REQUEST_TABLE)
      },
      records: db.prepare(`SELECT * FROM ${RECORD_TABLE} ORDER BY vehicle_id`).all(),
      cases: db.prepare(`SELECT * FROM ${CASE_TABLE} ORDER BY vehicle_id`).all(),
      faults: db.prepare(`SELECT * FROM ${FAULT_TABLE} ORDER BY vehicle_id, slot`).all(),
      repairRequests: db.prepare(`SELECT * FROM ${REPAIR_TABLE} ORDER BY repair_request_id`).all(),
      notifications: db.prepare(`SELECT * FROM ${NOTIFICATION_TABLE} ORDER BY notification_id`).all(),
      events: db.prepare(`SELECT * FROM ${EVENT_TABLE} ORDER BY event_id`).all(),
      idempotency: db.prepare(`SELECT * FROM ${IDEMPOTENCY_TABLE} ORDER BY action_id`).all(),
      processCases: db.prepare(`SELECT * FROM ${PROCESS_CASE_TABLE} ORDER BY vehicle_id, sequence`).all(),
      processEvents: db.prepare(`SELECT * FROM ${PROCESS_EVENT_TABLE} ORDER BY server_timestamp, process_event_id`).all(),
      workshopExitRequests: db.prepare(`
        SELECT * FROM ${WORKSHOP_EXIT_REQUEST_TABLE}
        ORDER BY requested_at, exit_request_id
      `).all(),
      workshopExitEvents: db.prepare(`
        SELECT * FROM ${WORKSHOP_EXIT_EVENT_TABLE}
        ORDER BY server_timestamp, workshop_exit_event_id
      `).all(),
      operationalMessages: db.prepare(`
        SELECT * FROM ${OPERATIONAL_MESSAGE_TABLE} ORDER BY created_at, message_id
      `).all(),
      operationalMessageEvents: db.prepare(`
        SELECT * FROM ${OPERATIONAL_MESSAGE_EVENT_TABLE}
        ORDER BY server_timestamp, operational_message_event_id
      `).all(),
      operationalMessageAcknowledgements: db.prepare(`
        SELECT * FROM ${OPERATIONAL_MESSAGE_ACK_TABLE}
        ORDER BY acknowledged_at, acknowledgement_id
      `).all(),
      cleaningTrackSpaceRequests: db.prepare(`
        SELECT * FROM ${CLEANING_TRACK_REQUEST_TABLE}
        ORDER BY requested_at, cleaning_request_id
      `).all()
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

  function semanticNoOp(result){
    return {
      [SEMANTIC_NOOP]: true,
      result
    };
  }

  function semanticNoOpResult(commandName, command, eventId, fields){
    return {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      command: commandName,
      actionId: command.actionId,
      vehicleId: command.vehicleId,
      ...fields,
      eventId,
      idempotentReplay: false
    };
  }

  function originalCommandEventId(actionId){
    if(!actionId) return null;
    return db.prepare(`
      SELECT event_id FROM ${EVENT_TABLE}
      WHERE action_id = ?
      LIMIT 1
    `).get(actionId)?.event_id || null;
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
      authority.effectiveRole || null, authority.identitySource || "server_command",
      authority.roleBindingSource || "server_authority", command.payloadHash
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
  function findActiveProcessCase(vehicleId){
    return db.prepare(`
      SELECT * FROM ${PROCESS_CASE_TABLE}
      WHERE vehicle_id = ? AND closed_at IS NULL
      ORDER BY sequence DESC LIMIT 1
    `).get(vehicleId);
  }
  function findLatestProcessCase(vehicleId){
    return db.prepare(`
      SELECT * FROM ${PROCESS_CASE_TABLE}
      WHERE vehicle_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(vehicleId);
  }
  function findProcessCaseWithOpenWorkshopSegment(vehicleId){
    const candidates = db.prepare(`
      SELECT * FROM ${PROCESS_CASE_TABLE}
      WHERE vehicle_id = ?
      ORDER BY sequence DESC
    `).all(vehicleId);
    return candidates.find((candidate) => {
      const lastTransition = db.prepare(`
        SELECT event_type FROM ${PROCESS_EVENT_TABLE}
        WHERE case_id = ?
          AND event_type IN ('WORKSHOP_AREA_ENTERED','WORKSHOP_AREA_EXITED')
        ORDER BY server_timestamp DESC, process_event_id DESC
        LIMIT 1
      `).get(candidate.case_id);
      return lastTransition?.event_type === "WORKSHOP_AREA_ENTERED";
    }) || null;
  }
  function findProcessCase(caseId, vehicleId){
    return db.prepare(`
      SELECT * FROM ${PROCESS_CASE_TABLE}
      WHERE case_id = ? AND vehicle_id = ?
    `).get(caseId, vehicleId);
  }
  function ensureActiveProcessCase(vehicleId, timestamp, sourceEventId){
    const existing = findActiveProcessCase(vehicleId);
    if(existing) return existing;
    const sequence = Number(db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS value
      FROM ${PROCESS_CASE_TABLE} WHERE vehicle_id = ?
    `).get(vehicleId)?.value || 0) + 1;
    const caseId = randomUUID();
    db.prepare(`
      INSERT INTO ${PROCESS_CASE_TABLE} (
        case_id, vehicle_id, sequence, opened_at, closed_at,
        current_wait_reason, source_event_id, latest_event_at
      ) VALUES (?, ?, ?, ?, NULL, 'NONE', ?, ?)
    `).run(caseId, vehicleId, sequence, timestamp, sourceEventId || null, timestamp);
    return findProcessCase(caseId, vehicleId);
  }
  function closeProcessCase(caseId, timestamp){
    db.prepare(`
      UPDATE ${PROCESS_CASE_TABLE}
      SET closed_at = COALESCE(closed_at, ?), latest_event_at = ?
      WHERE case_id = ?
    `).run(timestamp, timestamp, caseId);
  }
  function insertProcessEvent(input){
    if(input.idempotencyKey && db.prepare(`
      SELECT 1 FROM ${PROCESS_EVENT_TABLE} WHERE idempotency_key = ?
    `).get(input.idempotencyKey)){
      return false;
    }
    const processEventId = input.processEventId || randomUUID();
    db.prepare(`
      INSERT INTO ${PROCESS_EVENT_TABLE} (
        process_event_id, event_type, vehicle_id, case_id,
        fault_id, repair_request_id, notification_id, action_id,
        server_timestamp, actor_subject, actor_role, payload_json,
        source_revision, source_occurrence_id, evidence_type, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      processEventId,
      input.eventType,
      input.vehicleId,
      input.caseId,
      input.faultId || null,
      input.repairRequestId || null,
      input.notificationId || null,
      input.actionId || null,
      input.timestamp || now(),
      input.authority?.subject || null,
      input.authority?.effectiveRole || null,
      JSON.stringify(input.payload || {}),
      input.sourceRevision === undefined || input.sourceRevision === null
        ? null
        : String(input.sourceRevision),
      input.sourceOccurrenceId || null,
      input.evidenceType || null,
      input.idempotencyKey || null
    );
    db.prepare(`
      UPDATE ${PROCESS_CASE_TABLE}
      SET latest_event_at = ?
      WHERE case_id = ?
    `).run(input.timestamp || now(), input.caseId);
    return true;
  }
  function selectProcessEvents(){
    return db.prepare(`
      SELECT * FROM ${PROCESS_EVENT_TABLE}
      ORDER BY server_timestamp, process_event_id
    `).all().map((row) => ({
      processEventId: row.process_event_id,
      eventType: row.event_type,
      vehicleId: row.vehicle_id,
      caseId: row.case_id,
      faultId: row.fault_id,
      repairRequestId: row.repair_request_id,
      notificationId: row.notification_id,
      timestamp: row.server_timestamp,
      payload: safeJson(row.payload_json, {}),
      sourceRevision: row.source_revision,
      sourceOccurrenceId: row.source_occurrence_id,
      evidenceType: row.evidence_type
    }));
  }
  function selectProcessCaseRows(){
    return db.prepare(`
      SELECT * FROM ${PROCESS_CASE_TABLE}
      ORDER BY vehicle_id, sequence
    `).all().map((row) => ({
      caseId: row.case_id,
      vehicleId: row.vehicle_id,
      sequence: row.sequence,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      currentWaitReason: row.current_wait_reason,
      latestEventAt: row.latest_event_at
    }));
  }
  function getFirstProcessEventTimestamp(caseId, eventType, field = null, value = null){
    const where = field ? ` AND ${field} = ?` : "";
    const row = db.prepare(`
      SELECT server_timestamp FROM ${PROCESS_EVENT_TABLE}
      WHERE case_id = ? AND event_type = ?${where}
      ORDER BY server_timestamp, process_event_id LIMIT 1
    `).get(...(field ? [caseId, eventType, value] : [caseId, eventType]));
    return row?.server_timestamp || null;
  }
  function findObservation(observerKey){
    return db.prepare(`
      SELECT * FROM ${PROCESS_OBSERVATION_TABLE} WHERE observer_key = ?
    `).get(observerKey);
  }
  function upsertObservation(observerKey, sourceRevision, payload, timestamp){
    db.prepare(`
      INSERT INTO ${PROCESS_OBSERVATION_TABLE} (
        observer_key, source_revision, payload_json, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(observer_key) DO UPDATE SET
        source_revision = excluded.source_revision,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(observerKey, sourceRevision, JSON.stringify(payload), timestamp);
  }
  function currentWorkshopPlacementRevision(){
    return findObservation("workshop-placement-snapshot")?.source_revision || "";
  }
  function currentVehicleSlot(vehicleId){
    const row = findObservation(`placement:${vehicleId}`);
    return normalizeSlot(safeJson(row?.payload_json, {})?.slot);
  }
  function workshopSlotOccupant(slot){
    const row = findObservation(`workshop-slot:${slot}`);
    const payload = safeJson(row?.payload_json, {});
    return payload?.ambiguous === true ? "__AMBIGUOUS__" : String(payload?.vehicleId || "");
  }
  function activeWorkshopIngressCardOwner(slot){
    return db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN ('ACTIVATING','CARD_CREATED')
      ORDER BY COALESCE(requested_at, created_at), position, created_at, queue_entry_id
      LIMIT 1
    `).get(slot) || null;
  }
  function workshopQueueRevision(slot){
    return db.prepare(`
      SELECT revision FROM ${WORKSHOP_INGRESS_QUEUE_META_TABLE} WHERE target_slot=?
    `).get(slot)?.revision || 0;
  }
  function incrementWorkshopQueueRevision(slot){
    db.prepare(`
      INSERT INTO ${WORKSHOP_INGRESS_QUEUE_META_TABLE} (target_slot, revision)
      VALUES (?, 1)
      ON CONFLICT(target_slot) DO UPDATE SET revision=revision+1
    `).run(slot);
    return workshopQueueRevision(slot);
  }
  function nextWorkshopQueuePosition(slot){
    return (db.prepare(`
      SELECT MAX(position) AS position FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN (
        'QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED','REPLAN_REQUIRED'
      )
    `).get(slot)?.position || 0) + 1;
  }
  function normalizeWorkshopQueuePositions(slot){
    const rows = db.prepare(`
      SELECT queue_entry_id FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN (
        'QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED','REPLAN_REQUIRED'
      )
      ORDER BY
        CASE WHEN status IN ('ACTIVATING','CARD_CREATED') THEN 0
             WHEN request_type='ASAP' THEN 1 ELSE 2 END,
        COALESCE(requested_at, created_at),
        position, created_at, queue_entry_id
    `).all(slot);
    rows.forEach((row, index) => db.prepare(`
      UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE} SET position=? WHERE queue_entry_id=?
    `).run(index + 1, row.queue_entry_id));
  }
  function moveWorkshopQueueEntry(entry, operation, timestamp){
    const direction = operation === "MOVE_UP" ? -1 : 1;
    const candidate = db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN (
        'QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED','REPLAN_REQUIRED'
      ) AND position ${direction < 0 ? "<" : ">"} ?
      ORDER BY position ${direction < 0 ? "DESC" : "ASC"} LIMIT 1
    `).get(entry.target_slot, entry.position);
    if(!candidate) return;
    db.prepare(`
      UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE} SET position=?, updated_at=?
      WHERE queue_entry_id=?
    `).run(candidate.position, timestamp, entry.queue_entry_id);
    db.prepare(`
      UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE} SET position=?, updated_at=?
      WHERE queue_entry_id=?
    `).run(entry.position, timestamp, candidate.queue_entry_id);
  }
  function insertWorkshopQueueEvent({
    eventType, queueEntry, timestamp, authority = {}, sourceRevision,
    payload = {}, idempotencyKey
  }){
    db.prepare(`
      INSERT OR IGNORE INTO ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE} (
        workshop_ingress_event_id, event_type, queue_entry_id, target_slot,
        vehicle_id, server_timestamp, actor_subject, actor_role,
        source_revision, payload_json, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), eventType, queueEntry.queue_entry_id, queueEntry.target_slot,
      queueEntry.vehicle_id, timestamp, authority.subject || null,
      authority.effectiveRole || null, sourceRevision || null,
      JSON.stringify(payload), idempotencyKey || null
    );
  }
  function activateWorkshopIngressQueueForEmptySlots({slot, sourceRevision, timestamp}){
    if(workshopSlotOccupant(slot)) return 0;
    if(db.prepare(`
      SELECT 1 FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN ('ACTIVATING','CARD_CREATED')
      LIMIT 1
    `).get(slot)) return 0;
    const entry = db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status IN ('QUEUED','READY_FOR_ACTIVATION','REPLAN_REQUIRED')
      ORDER BY
        CASE WHEN request_type='ASAP' THEN 0 ELSE 1 END,
        COALESCE(requested_at, created_at),
        position, created_at, queue_entry_id LIMIT 1
    `).get(slot);
    if(!entry) return 0;
    const sourceSlot = currentVehicleSlot(entry.vehicle_id);
    if(!sourceSlot || sourceSlot === slot){
      const reasonCodes = [sourceSlot
        ? "TARGET_EQUALS_CURRENT_SOURCE"
        : "SOURCE_SLOT_UNRESOLVED"];
      db.prepare(`
        UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
        SET status='REPLAN_REQUIRED', updated_at=?, linked_card_id=NULL,
            reason_codes_json=?, placement_revision=?
        WHERE queue_entry_id=?
      `).run(timestamp, JSON.stringify(reasonCodes), sourceRevision, entry.queue_entry_id);
      const updated = db.prepare(`
        SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
      `).get(entry.queue_entry_id);
      insertWorkshopQueueEvent({
        eventType: "WORKSHOP_INGRESS_REPLAN_REQUIRED",
        queueEntry: updated, timestamp, sourceRevision,
        payload: { reasonCodes },
        idempotencyKey: `placement:${sourceRevision}:${entry.queue_entry_id}:replan`
      });
      incrementWorkshopQueueRevision(slot);
      return 1;
    }
    const linkedCardId =
      `workshop-ingress|${entry.queue_entry_id}|${entry.vehicle_id}|${slot}`;
    db.prepare(`
      UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
      SET status='CARD_CREATED', updated_at=?, linked_card_id=?,
          reason_codes_json='[]', placement_revision=?
      WHERE queue_entry_id=?
    `).run(timestamp, linkedCardId, sourceRevision, entry.queue_entry_id);
    const updated = db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
    `).get(entry.queue_entry_id);
    insertWorkshopQueueEvent({
      eventType: "WORKSHOP_INGRESS_CARD_CREATED",
      queueEntry: updated, timestamp, sourceRevision,
      payload: { linkedCardId, sourceSlot, targetSlot: slot },
      idempotencyKey: `placement:${sourceRevision}:${entry.queue_entry_id}:card`
    });
    incrementWorkshopQueueRevision(slot);
    return 1;
  }
  function replanWorkshopIngressCardsForOccupiedSlot({
    slot, vehicleId, sourceRevision, timestamp
  }){
    const entries = db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
      WHERE target_slot=? AND status='CARD_CREATED'
    `).all(slot);
    for(const entry of entries){
      if(entry.vehicle_id === vehicleId){
        db.prepare(`
          UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
          SET status='COMPLETED', updated_at=?, reason_codes_json='[]',
              placement_revision=?
          WHERE queue_entry_id=?
        `).run(timestamp, sourceRevision, entry.queue_entry_id);
        const completed = db.prepare(`
          SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
        `).get(entry.queue_entry_id);
        insertWorkshopQueueEvent({
          eventType: "WORKSHOP_INGRESS_COMPLETED",
          queueEntry: completed, timestamp, sourceRevision,
          payload: { linkedCardId: entry.linked_card_id, occupiedBy: vehicleId },
          idempotencyKey: `placement:${sourceRevision}:${entry.queue_entry_id}:completed`
        });
        incrementWorkshopQueueRevision(slot);
        continue;
      }
      db.prepare(`
        UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
        SET status='REPLAN_REQUIRED', updated_at=?, linked_card_id=NULL,
            reason_codes_json='["TARGET_OCCUPIED"]', placement_revision=?
        WHERE queue_entry_id=?
      `).run(timestamp, sourceRevision, entry.queue_entry_id);
      const updated = db.prepare(`
        SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} WHERE queue_entry_id=?
      `).get(entry.queue_entry_id);
      insertWorkshopQueueEvent({
        eventType: "WORKSHOP_INGRESS_REPLAN_REQUIRED",
        queueEntry: updated, timestamp, sourceRevision,
        payload: { reasonCodes: ["TARGET_OCCUPIED"], occupiedBy: vehicleId },
        idempotencyKey: `placement:${sourceRevision}:${entry.queue_entry_id}:occupied`
      });
      incrementWorkshopQueueRevision(slot);
    }
    return entries.length;
  }
  function selectWorkshopIngressQueue(){
    return db.prepare(`
      SELECT q.*, m.revision AS queue_revision
      FROM ${WORKSHOP_INGRESS_QUEUE_TABLE} q
      LEFT JOIN ${WORKSHOP_INGRESS_QUEUE_META_TABLE} m
        ON m.target_slot=q.target_slot
      ORDER BY q.target_slot, q.position, q.created_at, q.queue_entry_id
    `).all().map(mapWorkshopIngressQueueEntry);
  }
  function selectWorkshopIngressQueueEvents(){
    return db.prepare(`
      SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE}
      ORDER BY server_timestamp, workshop_ingress_event_id
    `).all().map(mapWorkshopIngressQueueEvent);
  }
  function selectOperationalMessages(){
    return db.prepare(`
      SELECT m.*
      FROM ${OPERATIONAL_MESSAGE_TABLE} m
      ORDER BY m.created_at, m.message_id
    `).all().map(mapOperationalMessage);
  }
  function selectPlacementObservations(){
    return db.prepare(`
      SELECT payload_json FROM ${PROCESS_OBSERVATION_TABLE}
      WHERE observer_key LIKE 'placement:%'
      ORDER BY observer_key
    `).all().map((row) => safeJson(row.payload_json, {}));
  }
  function classifyWorkshopExitRequest(record){
    if(record?.disposition === "TIL_DREI") return "TIL_DREI";
    if(record?.disposition === "TIL_REP") return "TIL_REP";
    if(record?.status === "DRIFTSKLAR") return "DRIFTSKLAR";
    if(record?.status === "IKKE_DRIFTSKLAR") return "IKKE_DRIFTSKLAR";
    return "UNKNOWN";
  }
  function mapWorkshopExitRequest(row){
    return {
      exitRequestId: row.exit_request_id,
      vehicleId: row.vehicle_id,
      visitId: row.visit_id,
      sourceSlot: row.source_slot,
      placementRevision: row.placement_revision,
      classification: row.classification,
      reasonCodes: safeJson(row.reason_codes_json, []),
      status: row.status,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      completedSlot: row.completed_slot,
      completedPlacementRevision: row.completed_placement_revision,
      eventId: row.event_id
    };
  }
  function selectWorkshopExitRequests(){
    return db.prepare(`
      SELECT * FROM ${WORKSHOP_EXIT_REQUEST_TABLE}
      ORDER BY requested_at, exit_request_id
    `).all().map(mapWorkshopExitRequest);
  }
  function selectWorkshopExitEvents(){
    return db.prepare(`
      SELECT * FROM ${WORKSHOP_EXIT_EVENT_TABLE}
      ORDER BY server_timestamp, workshop_exit_event_id
    `).all().map((row) => ({
      workshopExitEventId: row.workshop_exit_event_id,
      eventType: row.event_type,
      exitRequestId: row.exit_request_id,
      vehicleId: row.vehicle_id,
      visitId: row.visit_id,
      timestamp: row.server_timestamp,
      actorSubject: row.actor_subject,
      actorRole: row.actor_role,
      sourceRevision: row.source_revision,
      payload: safeJson(row.payload_json, {}),
      idempotencyKey: row.idempotency_key
    }));
  }
  function insertWorkshopExitEvent(input){
    const existing = input.idempotencyKey
      ? db.prepare(`
          SELECT 1 FROM ${WORKSHOP_EXIT_EVENT_TABLE}
          WHERE idempotency_key = ?
        `).get(input.idempotencyKey)
      : null;
    if(existing) return false;
    db.prepare(`
      INSERT INTO ${WORKSHOP_EXIT_EVENT_TABLE} (
        workshop_exit_event_id, event_type, exit_request_id,
        vehicle_id, visit_id, server_timestamp, actor_subject,
        actor_role, source_revision, payload_json, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workshopExitEventId || randomUUID(),
      input.eventType,
      input.exitRequestId,
      input.vehicleId,
      input.visitId,
      input.timestamp || now(),
      input.actorSubject || null,
      input.actorRole || null,
      input.sourceRevision === undefined || input.sourceRevision === null
        ? null
        : String(input.sourceRevision),
      JSON.stringify(input.payload || {}),
      input.idempotencyKey || null
    );
    return true;
  }
  function completeActiveWorkshopExitRequests(input){
    const rows = db.prepare(`
      SELECT * FROM ${WORKSHOP_EXIT_REQUEST_TABLE}
      WHERE vehicle_id = ? AND visit_id = ?
        AND status IN ('REQUESTED','CARD_CREATED','REPLAN_REQUIRED')
      ORDER BY requested_at, exit_request_id
    `).all(input.vehicleId, input.visitId);
    let completed = 0;
    for(const row of rows){
      const change = db.prepare(`
        UPDATE ${WORKSHOP_EXIT_REQUEST_TABLE}
        SET status = 'COMPLETED',
            updated_at = ?,
            completed_at = ?,
            completed_slot = ?,
            completed_placement_revision = ?
        WHERE exit_request_id = ?
          AND status IN ('REQUESTED','CARD_CREATED','REPLAN_REQUIRED')
      `).run(
        input.timestamp,
        input.timestamp,
        input.completedSlot,
        input.placementRevision,
        row.exit_request_id
      );
      if(!change.changes) continue;
      insertWorkshopExitEvent({
        eventType: "WORKSHOP_EXIT_COMPLETED",
        exitRequestId: row.exit_request_id,
        vehicleId: row.vehicle_id,
        visitId: row.visit_id,
        timestamp: input.timestamp,
        actorSubject: "system|canonical-placement-observer",
        actorRole: "system",
        sourceRevision: input.placementRevision,
        payload: {
          fromSlot: row.source_slot,
          completedSlot: input.completedSlot,
          placementRevision: input.placementRevision
        },
        idempotencyKey:
          `workshop-exit-completed:${row.exit_request_id}:${input.placementRevision}`
      });
      completed += 1;
    }
    return completed;
  }

  return {
    executeCommand,
    executeReportNotOperational,
    getAnalytics,
    getReadModel,
    getStorageSnapshot,
    observeCanonicalPlacements,
    observeProductionOccurrences
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
  }else if(userVersion > 9){
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
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROCESS_CASE_TABLE} (
      case_id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      current_wait_reason TEXT NOT NULL DEFAULT 'NONE'
        CHECK(current_wait_reason IN (
          'WAITING_FOR_SHUNTING',
          'WAITING_FOR_WORKSHOP_TRACK',
          'WAITING_FOR_PERSONNEL',
          'WAITING_FOR_PART',
          'WAITING_FOR_TECHNICAL_CLARIFICATION',
          'WAITING_FOR_TEST_RUN',
          'OTHER',
          'NONE'
        )),
      source_event_id TEXT,
      latest_event_at TEXT NOT NULL,
      UNIQUE(vehicle_id, sequence)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_process_case
      ON ${PROCESS_CASE_TABLE}(vehicle_id) WHERE closed_at IS NULL;

    CREATE TABLE IF NOT EXISTS ${PROCESS_EVENT_TABLE} (
      process_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'FAULT_REGISTERED',
        'NOT_OPERATIONAL_REPORTED',
        'REPAIR_REQUESTED',
        'WORKSHOP_NOTIFICATION_CREATED',
        'WORKSHOP_NOTIFICATION_PRESENTED',
        'WORKSHOP_SHEET_FIRST_OPENED',
        'WORKSHOP_AREA_ENTERED',
        'WORK_STARTED',
        'WAIT_REASON_SET',
        'OPERATIONAL_REPORTED',
        'WORKSHOP_AREA_EXITED',
        'RETURN_TO_SERVICE_DETECTED',
        'FAULT_RESOLVED',
        'REPAIR_REQUEST_COMPLETED'
      )),
      vehicle_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      fault_id TEXT,
      repair_request_id TEXT,
      notification_id TEXT,
      action_id TEXT,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT,
      actor_role TEXT,
      payload_json TEXT NOT NULL,
      source_revision TEXT,
      source_occurrence_id TEXT,
      evidence_type TEXT CHECK(
        evidence_type IS NULL OR
        evidence_type IN ('ACTUAL_DEPARTURE','TURSATT_SCHEDULED')
      ),
      idempotency_key TEXT UNIQUE,
      FOREIGN KEY(case_id) REFERENCES ${PROCESS_CASE_TABLE}(case_id)
    );
    CREATE INDEX IF NOT EXISTS vehicle_status_process_events_case_time
      ON ${PROCESS_EVENT_TABLE}(case_id, server_timestamp, process_event_id);
    CREATE INDEX IF NOT EXISTS vehicle_status_process_events_vehicle_type
      ON ${PROCESS_EVENT_TABLE}(vehicle_id, event_type);

    CREATE TABLE IF NOT EXISTS ${PROCESS_OBSERVATION_TABLE} (
      observer_key TEXT PRIMARY KEY,
      source_revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS vehicle_status_process_events_immutable_update
    BEFORE UPDATE ON ${PROCESS_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'vehicle status process events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_process_events_immutable_delete
    BEFORE DELETE ON ${PROCESS_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'vehicle status process events are immutable'); END;

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_EXIT_REQUEST_TABLE} (
      exit_request_id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      source_slot TEXT NOT NULL,
      placement_revision TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN (
        'TURSATT',
        'RESERVE',
        'TIL_DREI',
        'TIL_REP',
        'DRIFTSKLAR',
        'IKKE_DRIFTSKLAR',
        'UNKNOWN'
      )),
      reason_codes_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'REQUESTED',
        'CARD_CREATED',
        'REPLAN_REQUIRED',
        'COMPLETED',
        'CANCELLED'
      )),
      requested_at TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      completed_slot TEXT,
      completed_placement_revision TEXT,
      event_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_workshop_exit_per_visit
      ON ${WORKSHOP_EXIT_REQUEST_TABLE}(vehicle_id, visit_id)
      WHERE status IN ('REQUESTED','CARD_CREATED','REPLAN_REQUIRED');

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_EXIT_EVENT_TABLE} (
      workshop_exit_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'WORKSHOP_EXIT_REQUESTED',
        'WORKSHOP_EXIT_CARD_CREATED',
        'WORKSHOP_EXIT_REPLAN_REQUIRED',
        'WORKSHOP_EXIT_COMPLETED',
        'WORKSHOP_EXIT_CANCELLED'
      )),
      exit_request_id TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT,
      actor_role TEXT,
      source_revision TEXT,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      FOREIGN KEY(exit_request_id)
        REFERENCES ${WORKSHOP_EXIT_REQUEST_TABLE}(exit_request_id)
    );
    CREATE INDEX IF NOT EXISTS vehicle_status_workshop_exit_events_request_time
      ON ${WORKSHOP_EXIT_EVENT_TABLE}(
        exit_request_id, server_timestamp, workshop_exit_event_id
      );

    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_exit_events_immutable_update
    BEFORE UPDATE ON ${WORKSHOP_EXIT_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop exit events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_exit_events_immutable_delete
    BEFORE DELETE ON ${WORKSHOP_EXIT_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop exit events are immutable'); END;

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_INGRESS_QUEUE_META_TABLE} (
      target_slot TEXT PRIMARY KEY CHECK(target_slot IN ('8N','7N','8S','7S')),
      revision INTEGER NOT NULL CHECK(revision>=0)
    );
    INSERT OR IGNORE INTO ${WORKSHOP_INGRESS_QUEUE_META_TABLE} (target_slot, revision)
      VALUES ('8N',0),('7N',0),('8S',0),('7S',0);

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_INGRESS_QUEUE_TABLE} (
      queue_entry_id TEXT PRIMARY KEY,
      target_slot TEXT NOT NULL CHECK(target_slot IN ('8N','7N','8S','7S')),
      vehicle_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position>=1),
      status TEXT NOT NULL CHECK(status IN (
        'QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED',
        'REPLAN_REQUIRED','COMPLETED','CANCELLED'
      )),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      linked_card_id TEXT,
      reason_codes_json TEXT NOT NULL,
      placement_revision TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_ingress_vehicle_slot
      ON ${WORKSHOP_INGRESS_QUEUE_TABLE}(target_slot, vehicle_id)
      WHERE status IN (
        'QUEUED','READY_FOR_ACTIVATION','ACTIVATING','CARD_CREATED','REPLAN_REQUIRED'
      );

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE} (
      workshop_ingress_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'WORKSHOP_INGRESS_QUEUED','WORKSHOP_INGRESS_REORDERED',
        'WORKSHOP_INGRESS_READY','WORKSHOP_INGRESS_ACTIVATING',
        'WORKSHOP_INGRESS_CARD_CREATED','WORKSHOP_INGRESS_REPLAN_REQUIRED',
        'WORKSHOP_INGRESS_COMPLETED','WORKSHOP_INGRESS_CANCELLED'
      )),
      queue_entry_id TEXT NOT NULL,
      target_slot TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT,
      actor_role TEXT,
      source_revision TEXT,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      FOREIGN KEY(queue_entry_id) REFERENCES ${WORKSHOP_INGRESS_QUEUE_TABLE}(queue_entry_id)
    );
    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_ingress_events_immutable_update
    BEFORE UPDATE ON ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop ingress events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_ingress_events_immutable_delete
    BEFORE DELETE ON ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop ingress events are immutable'); END;

    CREATE TABLE IF NOT EXISTS ${CLEANING_TRACK_REQUEST_TABLE} (
      cleaning_request_id TEXT PRIMARY KEY,
      requested_slots_json TEXT NOT NULL,
      requested_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      time_zone TEXT NOT NULL CHECK(time_zone='Europe/Oslo'),
      planned_start_at TEXT NOT NULL,
      lead_time_minutes INTEGER NOT NULL CHECK(lead_time_minutes>0),
      short_notice INTEGER NOT NULL CHECK(short_notice IN (0,1)),
      short_notice_acknowledged INTEGER NOT NULL
        CHECK(short_notice_acknowledged IN (0,1)),
      status TEXT NOT NULL CHECK(status IN (
        'REQUESTED','APPROVED','REJECTED','COMPLETED','CANCELLED'
      )),
      reason_codes_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS ${WORKSHOP_MESSAGE_TABLE} (
      message_id TEXT PRIMARY KEY,
      target_role TEXT NOT NULL CHECK(target_role IN ('drops','txp','sde_skiftere','agila')),
      message_text TEXT NOT NULL CHECK(length(message_text) BETWEEN 1 AND 250),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      notification_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS ${WORKSHOP_MESSAGE_EVENT_TABLE} (
      workshop_message_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type='WORKSHOP_MESSAGE_SENT'),
      message_id TEXT NOT NULL,
      target_role TEXT NOT NULL,
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT,
      actor_role TEXT,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      FOREIGN KEY(message_id) REFERENCES ${WORKSHOP_MESSAGE_TABLE}(message_id)
    );
    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_message_events_immutable_update
    BEFORE UPDATE ON ${WORKSHOP_MESSAGE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop message events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_workshop_message_events_immutable_delete
    BEFORE DELETE ON ${WORKSHOP_MESSAGE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'workshop message events are immutable'); END;

    CREATE TABLE IF NOT EXISTS ${OPERATIONAL_MESSAGE_TABLE} (
      message_id TEXT PRIMARY KEY,
      source_role TEXT NOT NULL
        CHECK(source_role IN ('drops','txp','sde_skiftere','verksted','agila')),
      target_role TEXT NOT NULL
        CHECK(target_role IN ('drops','txp','sde_skiftere','verksted','agila')),
      message_text TEXT NOT NULL CHECK(length(message_text) BETWEEN 1 AND 250),
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      notification_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL UNIQUE,
      CHECK(source_role <> target_role)
    );
    CREATE TABLE IF NOT EXISTS ${OPERATIONAL_MESSAGE_EVENT_TABLE} (
      operational_message_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'OPERATIONAL_MESSAGE_SENT','OPERATIONAL_MESSAGE_PRESENTED'
      )),
      message_id TEXT NOT NULL,
      source_role TEXT NOT NULL
        CHECK(source_role IN ('drops','txp','sde_skiftere','verksted','agila')),
      target_role TEXT NOT NULL
        CHECK(target_role IN ('drops','txp','sde_skiftere','verksted','agila')),
      server_timestamp TEXT NOT NULL,
      actor_subject TEXT,
      actor_role TEXT,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      FOREIGN KEY(message_id) REFERENCES ${OPERATIONAL_MESSAGE_TABLE}(message_id)
    );
    CREATE TRIGGER IF NOT EXISTS vehicle_status_operational_message_events_immutable_update
    BEFORE UPDATE ON ${OPERATIONAL_MESSAGE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'operational message events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_operational_message_events_immutable_delete
    BEFORE DELETE ON ${OPERATIONAL_MESSAGE_EVENT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'operational message events are immutable'); END;

    CREATE TABLE IF NOT EXISTS ${OPERATIONAL_MESSAGE_ACK_TABLE} (
      acknowledgement_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      notification_id TEXT NOT NULL UNIQUE,
      target_role TEXT NOT NULL
        CHECK(target_role IN ('drops','txp','sde_skiftere','verksted','agila')),
      acknowledged_at TEXT NOT NULL,
      acknowledged_by_role TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      action_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      FOREIGN KEY(message_id) REFERENCES ${OPERATIONAL_MESSAGE_TABLE}(message_id)
    );
    CREATE TRIGGER IF NOT EXISTS vehicle_status_operational_message_ack_immutable_update
    BEFORE UPDATE ON ${OPERATIONAL_MESSAGE_ACK_TABLE}
    BEGIN SELECT RAISE(ABORT, 'operational message acknowledgements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS vehicle_status_operational_message_ack_immutable_delete
    BEFORE DELETE ON ${OPERATIONAL_MESSAGE_ACK_TABLE}
    BEGIN SELECT RAISE(ABORT, 'operational message acknowledgements are immutable'); END;
  `);
  if(userVersion < 6){
    migrateWorkshopMessagesToOperationalMessages(db);
  }
  if(userVersion < 7){
    migrateWorkshopIngressRequestTypes(db);
  }
  if(userVersion < 8){
    reconcileWorkshopIngressCardOwnership(db);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_status_one_active_ingress_card_per_target
      ON ${WORKSHOP_INGRESS_QUEUE_TABLE}(target_slot)
      WHERE status IN ('ACTIVATING','CARD_CREATED');
  `);
  if(userVersion < 3) backfillProcessHistory(db);
  db.exec("PRAGMA user_version = 9;");
}

function migrateWorkshopIngressRequestTypes(db){
  const columns = new Set(db.prepare(`
    PRAGMA table_info(${WORKSHOP_INGRESS_QUEUE_TABLE})
  `).all().map((column) => column.name));
  const additions = [
    ["request_type",
      "TEXT NOT NULL DEFAULT 'PREBOOKED' CHECK(request_type IN ('ASAP','PREBOOKED'))"],
    ["priority",
      "TEXT NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('HIGH','NORMAL'))"],
    ["requested_at", "TEXT"],
    ["queued_at", "TEXT"]
  ];
  for(const [name, definition] of additions){
    if(!columns.has(name)){
      db.exec(`ALTER TABLE ${WORKSHOP_INGRESS_QUEUE_TABLE} ADD COLUMN ${name} ${definition};`);
    }
  }
  db.exec(`
    UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
    SET requested_at=COALESCE(requested_at, created_at),
        queued_at=CASE
          WHEN status='QUEUED' THEN COALESCE(queued_at, created_at)
          ELSE queued_at
        END;
  `);
}

function reconcileWorkshopIngressCardOwnership(db){
  const activeRows = db.prepare(`
    SELECT * FROM ${WORKSHOP_INGRESS_QUEUE_TABLE}
    WHERE status IN ('ACTIVATING','CARD_CREATED')
    ORDER BY target_slot, COALESCE(requested_at, created_at),
      position, created_at, queue_entry_id
  `).all();
  if(activeRows.length === 0) return 0;
  const timestamp = activeRows
    .map((row) => row.updated_at || row.requested_at || row.created_at || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "1970-01-01T00:00:00.000Z";
  let changed = 0;
  for(const targetSlot of WORKSHOP_SLOTS){
    const rows = activeRows.filter((row) => row.target_slot === targetSlot);
    if(rows.length === 0) continue;
    const validRows = rows.filter((row) => {
      if(!row.linked_card_id) return false;
      const observation = db.prepare(`
        SELECT payload_json FROM ${PROCESS_OBSERVATION_TABLE}
        WHERE observer_key=?
      `).get(`placement:${row.vehicle_id}`);
      const sourceSlot = normalizeSlot(safeJson(observation?.payload_json, {})?.slot);
      return Boolean(sourceSlot && sourceSlot !== targetSlot);
    });
    const owner = validRows[0] || null;
    for(const row of rows){
      if(owner && row.queue_entry_id === owner.queue_entry_id) continue;
      const reasonCodes = [
        owner ? "TARGET_RESERVED_BY_EXISTING_CARD" : "STALE_OR_INVALID_CARD_OWNER"
      ];
      db.prepare(`
        UPDATE ${WORKSHOP_INGRESS_QUEUE_TABLE}
        SET status='REPLAN_REQUIRED', linked_card_id=NULL, updated_at=?,
          reason_codes_json=?
        WHERE queue_entry_id=?
      `).run(timestamp, JSON.stringify(reasonCodes), row.queue_entry_id);
      db.prepare(`
        INSERT OR IGNORE INTO ${WORKSHOP_INGRESS_QUEUE_EVENT_TABLE} (
          workshop_ingress_event_id, event_type, queue_entry_id, target_slot,
          vehicle_id, server_timestamp, actor_subject, actor_role,
          source_revision, payload_json, idempotency_key
        ) VALUES (?, 'WORKSHOP_INGRESS_REPLAN_REQUIRED', ?, ?, ?, ?,
          'schema-v8-migration', NULL, ?, ?, ?)
      `).run(
        `schema-v8-reconcile:${row.queue_entry_id}`,
        row.queue_entry_id,
        row.target_slot,
        row.vehicle_id,
        timestamp,
        row.placement_revision,
        JSON.stringify({
          reasonCodes,
          retainedOwnerQueueEntryId:owner?.queue_entry_id || null,
          retainedOwnerVehicleId:owner?.vehicle_id || null
        }),
        `schema-v8-reconcile:${row.queue_entry_id}`
      );
      db.prepare(`
        UPDATE ${WORKSHOP_INGRESS_QUEUE_META_TABLE}
        SET revision=revision+1 WHERE target_slot=?
      `).run(targetSlot);
      changed += 1;
    }
  }
  if(changed){
    db.prepare(`
      UPDATE ${META_TABLE} SET revision=revision+1 WHERE id='main'
    `).run();
  }
  return changed;
}

function migrateWorkshopMessagesToOperationalMessages(db){
  const messages = db.prepare(`
    SELECT m.*, e.workshop_message_event_id, e.server_timestamp,
      e.actor_subject, e.actor_role, e.payload_json, e.idempotency_key
    FROM ${WORKSHOP_MESSAGE_TABLE} m
    LEFT JOIN ${WORKSHOP_MESSAGE_EVENT_TABLE} e ON e.message_id=m.message_id
    ORDER BY m.created_at, m.message_id
  `).all();
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO ${OPERATIONAL_MESSAGE_TABLE} (
      message_id, source_role, target_role, message_text, context_json,
      created_at, created_by, notification_id, event_id
    ) VALUES (?, 'verksted', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO ${OPERATIONAL_MESSAGE_EVENT_TABLE} (
      operational_message_event_id, event_type, message_id, source_role,
      target_role, server_timestamp, actor_subject, actor_role,
      payload_json, idempotency_key
    ) VALUES (?, 'OPERATIONAL_MESSAGE_SENT', ?, 'verksted', ?, ?, ?, ?, ?, ?)
  `);
  for(const row of messages){
    const legacyContext = safeJson(row.payload_json, {});
    const context = {
      surface:"verksted",
      ...(legacyContext.selectedSlotId ? {slotId:String(legacyContext.selectedSlotId)} : {}),
      ...(legacyContext.selectedVehicleId
        ? {vehicleId:String(legacyContext.selectedVehicleId)}
        : {})
    };
    insertMessage.run(
      row.message_id,
      row.target_role,
      row.message_text,
      JSON.stringify(context),
      row.created_at,
      row.created_by,
      row.notification_id,
      row.event_id
    );
    insertEvent.run(
      row.workshop_message_event_id || `legacy-operational-message:${row.message_id}`,
      row.message_id,
      row.target_role,
      row.server_timestamp || row.created_at,
      row.actor_subject || row.created_by,
      row.actor_role || "verksted",
      JSON.stringify({message:row.message_text, context, migratedFrom:"WORKSHOP_MESSAGE"}),
      row.idempotency_key || `legacy-operational-message:${row.message_id}`
    );
  }
}

function backfillProcessHistory(db){
  const existingProcessEvents =
    db.prepare(`SELECT COUNT(*) AS count FROM ${PROCESS_EVENT_TABLE}`).get().count;
  if(existingProcessEvents > 0) return;
  const commandEvents = db.prepare(`
    SELECT * FROM ${EVENT_TABLE}
    ORDER BY server_timestamp, event_id
  `).all();
  const activeCases = new Map();
  const sequenceByVehicle = new Map();

  const ensureCase = (event) => {
    const active = activeCases.get(event.vehicle_id);
    if(active) return active;
    const sequence = (sequenceByVehicle.get(event.vehicle_id) || 0) + 1;
    sequenceByVehicle.set(event.vehicle_id, sequence);
    const caseId = `legacy-process:${event.vehicle_id}:${event.event_id}`;
    db.prepare(`
      INSERT OR IGNORE INTO ${PROCESS_CASE_TABLE} (
        case_id, vehicle_id, sequence, opened_at, closed_at,
        current_wait_reason, source_event_id, latest_event_at
      ) VALUES (?, ?, ?, ?, NULL, 'NONE', ?, ?)
    `).run(
      caseId,
      event.vehicle_id,
      sequence,
      event.server_timestamp,
      event.event_id,
      event.server_timestamp
    );
    const processCase = { caseId, vehicleId: event.vehicle_id, sequence };
    activeCases.set(event.vehicle_id, processCase);
    return processCase;
  };
  const add = (event, processCase, eventType, fields = {}, suffix = eventType) => {
    db.prepare(`
      INSERT OR IGNORE INTO ${PROCESS_EVENT_TABLE} (
        process_event_id, event_type, vehicle_id, case_id,
        fault_id, repair_request_id, notification_id, action_id,
        server_timestamp, actor_subject, actor_role, payload_json,
        source_revision, source_occurrence_id, evidence_type, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `).run(
      `legacy-process-event:${event.event_id}:${suffix}`,
      eventType,
      event.vehicle_id,
      processCase.caseId,
      fields.faultId || null,
      fields.repairRequestId || null,
      fields.notificationId || null,
      event.action_id,
      event.server_timestamp,
      event.actor_subject,
      event.effective_role,
      JSON.stringify({
        backfilledFromCommandEvent: event.event_id,
        provenance: "direct_immutable_command_event",
        ...(fields.payload || {})
      }),
      `backfill:${event.event_id}:${suffix}`
    );
    db.prepare(`
      UPDATE ${PROCESS_CASE_TABLE} SET latest_event_at = ? WHERE case_id = ?
    `).run(event.server_timestamp, processCase.caseId);
  };

  for(const event of commandEvents){
    if(![
      LIFECYCLE_COMMANDS.REGISTER_FAULT,
      LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
      LIFECYCLE_COMMANDS.REQUEST_REPAIR,
      LIFECYCLE_COMMANDS.REPORT_OPERATIONAL
    ].includes(event.command_type)) continue;
    const processCase = ensureCase(event);
    const resultingState = safeJson(event.resulting_state_json, {});
    if(event.command_type === LIFECYCLE_COMMANDS.REGISTER_FAULT){
      const fault = resultingState.faultId
        ? db.prepare(`SELECT * FROM ${FAULT_TABLE} WHERE fault_id = ?`)
          .get(resultingState.faultId)
        : null;
      add(event, processCase, "FAULT_REGISTERED", {
        faultId: resultingState.faultId || null,
        payload: fault ? {
          slot: fault.slot,
          category: fault.category,
          description: fault.description
        } : {}
      });
    }else if(event.command_type === LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL){
      add(event, processCase, "NOT_OPERATIONAL_REPORTED", {
        payload: {
          status: "IKKE_DRIFTSKLAR",
          disposition: resultingState.disposition || "NONE",
          statusRevision: event.resulting_status_revision
        }
      });
    }else if(event.command_type === LIFECYCLE_COMMANDS.REQUEST_REPAIR){
      const repair = db.prepare(`
        SELECT * FROM ${REPAIR_TABLE} WHERE event_id = ?
      `).get(event.event_id);
      const notification = db.prepare(`
        SELECT * FROM ${NOTIFICATION_TABLE} WHERE event_id = ?
      `).get(event.event_id);
      add(event, processCase, "REPAIR_REQUESTED", {
        faultId: repair?.fault_id || null,
        repairRequestId: repair?.repair_request_id || resultingState.repairRequestId || null,
        payload: { status: "REQUESTED", requestedAt: repair?.requested_at || event.server_timestamp }
      }, "repair-requested");
      add(event, processCase, "WORKSHOP_NOTIFICATION_CREATED", {
        faultId: repair?.fault_id || null,
        repairRequestId: repair?.repair_request_id || null,
        notificationId: notification?.notification_id || resultingState.notificationId || null,
        payload: { targetRole: "verksted", notificationKind: "REPAIR_REQUESTED" }
      }, "notification-created");
    }else{
      add(event, processCase, "OPERATIONAL_REPORTED", {
        payload: {
          status: "DRIFTSKLAR",
          disposition: "NONE",
          statusRevision: event.resulting_status_revision
        }
      }, "operational");
      const resolvedFaults = db.prepare(`
        SELECT * FROM ${FAULT_TABLE} WHERE resolution_event_id = ?
      `).all(event.event_id);
      for(const fault of resolvedFaults){
        add(event, processCase, "FAULT_RESOLVED", {
          faultId: fault.fault_id,
          payload: { category: fault.category, resolvedAt: fault.resolved_at }
        }, `fault-resolved:${fault.fault_id}`);
      }
      const completedRepairs = db.prepare(`
        SELECT * FROM ${REPAIR_TABLE}
        WHERE vehicle_id = ? AND status = 'COMPLETED' AND completed_at = ?
      `).all(event.vehicle_id, event.server_timestamp);
      for(const repair of completedRepairs){
        add(event, processCase, "REPAIR_REQUEST_COMPLETED", {
          faultId: repair.fault_id,
          repairRequestId: repair.repair_request_id,
          payload: { completedAt: repair.completed_at }
        }, `repair-completed:${repair.repair_request_id}`);
      }
      db.prepare(`
        UPDATE ${PROCESS_CASE_TABLE}
        SET closed_at = ?, latest_event_at = ?
        WHERE case_id = ?
      `).run(event.server_timestamp, event.server_timestamp, processCase.caseId);
      activeCases.delete(event.vehicle_id);
    }
  }
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

function mapWorkshopIngressQueueEntry(row){
  return {
    queueEntryId: row.queue_entry_id,
    targetSlot: row.target_slot,
    vehicleId: row.vehicle_id,
    position: row.position,
    status: publicWorkshopIngressStatus(row),
    internalStatus: row.status,
    requestType: row.request_type || "PREBOOKED",
    priority: row.priority || "NORMAL",
    requestedAt: row.requested_at || row.created_at,
    queuedAt: row.queued_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedCardId: row.linked_card_id,
    reasonCodes: safeJson(row.reason_codes_json, []),
    placementRevision: row.placement_revision,
    queueRevision: row.queue_revision || 0
  };
}

function mapWorkshopIngressQueueEvent(row){
  return {
    eventId: row.workshop_ingress_event_id,
    eventType: row.event_type,
    queueEntryId: row.queue_entry_id,
    targetSlot: row.target_slot,
    vehicleId: row.vehicle_id,
    timestamp: row.server_timestamp,
    sourceRevision: row.source_revision,
    payload: safeJson(row.payload_json, {})
  };
}

function mapCleaningTrackSpaceRequest(row){
  return {
    cleaningRequestId:row.cleaning_request_id,
    requestedSlots:safeJson(row.requested_slots_json, []),
    requestedDate:row.requested_date,
    startTime:row.start_time,
    timeZone:row.time_zone,
    plannedStartAt:row.planned_start_at,
    leadTimeMinutes:row.lead_time_minutes,
    shortNotice:row.short_notice === 1,
    shortNoticeAcknowledged:row.short_notice_acknowledged === 1,
    status:row.status,
    reasonCodes:safeJson(row.reason_codes_json, []),
    requestedAt:row.requested_at,
    requestedBy:row.requested_by,
    updatedAt:row.updated_at,
    eventId:row.event_id
  };
}

function mapOperationalMessage(row){
  const context = safeJson(row.context_json, {});
  return {
    messageId: row.message_id,
    sourceRole: row.source_role,
    targetRole: row.target_role,
    message: row.message_text,
    sentAt: row.created_at,
    createdAt: row.created_at,
    notificationId: row.notification_id,
    eventId: row.event_id,
    context,
    selectedSlotId:String(context.slotId || ""),
    selectedVehicleId:String(context.vehicleId || "")
  };
}

function mapOperationalMessageAcknowledgement(row){
  return {
    acknowledgementId:row.acknowledgement_id,
    messageId:row.message_id,
    notificationId:row.notification_id,
    targetRole:row.target_role,
    acknowledgedAt:row.acknowledged_at,
    acknowledgedByRole:row.acknowledged_by_role,
    actorSubject:row.actor_subject,
    actionId:row.action_id
  };
}

function publicWorkshopIngressStatus(row){
  if(row?.status !== "QUEUED") return row?.status;
  return row?.request_type === "ASAP"
    ? "HIGH_PRIORITY_WAITING_FOR_SLOT"
    : "WAITING_FOR_SLOT";
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
    presentedAt: row.presented_at || null,
    acknowledgedAt: row.acknowledged_at || null,
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

function safeJson(value, fallback){
  try{ return JSON.parse(String(value || "")); }
  catch(_error){ return fallback; }
}

function normalizeSlot(value){
  const normalized = String(value || "").trim().toUpperCase();
  return /^[1-9][0-9]?(?:N|S|M|SS)?$/.test(normalized) ? normalized : "";
}

function resolveEuropeOsloDateTime(requestedDate, startTime){
  const [year, month, day] = String(requestedDate).split("-").map(Number);
  const [hour, minute] = String(startTime).split(":").map(Number);
  if(
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) return null;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Europe/Oslo",
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit",
    hourCycle:"h23"
  });
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  for(let offsetHours = -3; offsetHours <= 3; offsetHours += 1){
    const candidate = new Date(utcGuess + offsetHours * 60 * 60 * 1000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    if(
      Number(parts.year) === year &&
      Number(parts.month) === month &&
      Number(parts.day) === day &&
      Number(parts.hour) === hour &&
      Number(parts.minute) === minute
    ){
      return candidate.toISOString();
    }
  }
  return null;
}

function validEvidenceType(value){
  return value === "ACTUAL_DEPARTURE" || value === "TURSATT_SCHEDULED";
}

module.exports = {
  CASE_TABLE,
  CLEANING_TRACK_REQUEST_TABLE,
  EVENT_TABLE,
  FAULT_TABLE,
  IDEMPOTENCY_TABLE,
  META_TABLE,
  NOTIFICATION_TABLE,
  OPERATIONAL_MESSAGE_EVENT_TABLE,
  OPERATIONAL_MESSAGE_ACK_TABLE,
  OPERATIONAL_MESSAGE_TABLE,
  PROCESS_CASE_TABLE,
  PROCESS_EVENT_TABLE,
  PROCESS_OBSERVATION_TABLE,
  RECORD_TABLE,
  REPAIR_TABLE,
  WORKSHOP_INGRESS_QUEUE_EVENT_TABLE,
  WORKSHOP_INGRESS_QUEUE_META_TABLE,
  WORKSHOP_INGRESS_QUEUE_TABLE,
  WORKSHOP_MESSAGE_EVENT_TABLE,
  WORKSHOP_MESSAGE_TABLE,
  VehicleStatusRepositoryConflict,
  createVehicleStatusRepository,
  createVehicleStatusTestRepository,
  initializeSchema
};
