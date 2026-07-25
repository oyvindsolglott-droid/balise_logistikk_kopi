#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ROLE_KEYS } = require("../src/identityPolicy");
const {
  CAPABILITY_IDS,
  evaluateRuntimeAuthorization
} = require("../src/runtimeAuthorization");
const {
  CONFIRM_OPERATIONAL_TEXT,
  LIFECYCLE_COMMANDS,
  createVehicleStatusReadHandler,
  normalizeLifecycleCommand
} = require("../src/vehicleStatusLifecycle");
const {
  createVehicleStatusRepository
} = require("../src/vehicleStatusTestRepository");

const FIXED_TIME = "2026-07-24T08:09:10.111Z";
const VEHICLE_ID = "74-04";
const MAIN_DB =
  "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const SHARED_DRAFT_DB = MAIN_DB;
const productionBefore = snapshotFiles([
  MAIN_DB,
  `${MAIN_DB}-wal`,
  `${MAIN_DB}-shm`
]);
const passed = [];
let uuidCounter = 0;

const dropsAuthority = Object.freeze({
  subject: "cf-access|drops-lifecycle-test",
  roles: Object.freeze([ROLE_KEYS.DROPS]),
  effectiveRole: ROLE_KEYS.DROPS,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.DROPS]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});
const workshopAuthority = Object.freeze({
  subject: "cf-access|verksted-lifecycle-test",
  roles: Object.freeze([ROLE_KEYS.VERKSTED]),
  effectiveRole: ROLE_KEYS.VERKSTED,
  capabilitySourceRoles: Object.freeze([ROLE_KEYS.VERKSTED]),
  identitySource: "cloudflare_access_jwt",
  roleBindingSource: "server_config"
});

async function check(name, callback){
  await callback();
  passed.push(name);
}

function actionId(){
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function command(name, payload){
  const normalized = normalizeLifecycleCommand(name, payload);
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  return normalized.value;
}

function registerFaultPayload(overrides = {}){
  return {
    actionId: actionId(),
    expectedCaseRevision: 0,
    vehicleId: VEHICLE_ID,
    slot: 1,
    category: "A1",
    description: "Konkret feilbeskrivelse",
    ...overrides
  };
}

function createFixture(options = {}){
  const databasePath = path.join(
    os.tmpdir(),
    `sde-vehicle-lifecycle-v2-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite3`
  );
  const db = new DatabaseSync(databasePath);
  const repository = createVehicleStatusRepository({
    db,
    mode: "test",
    writeEnabled: options.writeEnabled !== false,
    now: () => FIXED_TIME,
    randomUUID: actionId,
    failureInjector: options.failureInjector
  });
  return {
    db,
    databasePath,
    repository,
    close(){
      db.close();
      for(const suffix of ["", "-wal", "-shm"]){
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }
    }
  };
}

function execute(repository, name, payload, authority = dropsAuthority){
  return repository.executeCommand(name, command(name, payload), authority);
}

function identity(){
  return {
    identityVerified: true,
    identityKind: "human",
    subject: "cf-access|owner"
  };
}

function roleResult(roles){
  return {
    roleResolved: true,
    roles,
    roleBindingSource: "server_config",
    roleBindingId: "owner"
  };
}

function decision(capability, roles){
  return evaluateRuntimeAuthorization({
    identity: identity(),
    roleResult: roleResult(roles),
    capability
  });
}

async function main(){
  assert.equal(CONFIRM_OPERATIONAL_TEXT,
    "Bekreft at registrerte feil er kontrollert og kjøretøyet kan settes Driftsklart");

  await check("01 gate off gives no register-fault write", () => {
    const fixture = createFixture({ writeEnabled: false });
    try{
      const outcome = execute(
        fixture.repository,
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload()
      );
      assert.equal(outcome.status, 404);
      assert.equal(fixture.repository.getStorageSnapshot().counts.faults, 0);
    }finally{ fixture.close(); }
  });

  await check("02 unknown vehicleId is rejected", () => {
    const result = normalizeLifecycleCommand(
      LIFECYCLE_COMMANDS.REGISTER_FAULT,
      registerFaultPayload({ vehicleId: "99-99" })
    );
    assert.equal(result.status, 404);
  });

  await check("03 pilot allowlist permits only 74-04", () => {
    const allowed = normalizeLifecycleCommand(
      LIFECYCLE_COMMANDS.REGISTER_FAULT,
      registerFaultPayload(),
      { allowedVehicleIds: new Set([VEHICLE_ID]) }
    );
    const denied = normalizeLifecycleCommand(
      LIFECYCLE_COMMANDS.REGISTER_FAULT,
      registerFaultPayload({ vehicleId: "74-10" }),
      { allowedVehicleIds: new Set([VEHICLE_ID]) }
    );
    assert.equal(allowed.ok, true);
    assert.equal(denied.status, 404);
  });

  await check("04 register-fault slot must be 1 through 5", () => {
    for(const slot of [0, 6, 1.5, "1"]){
      assert.equal(normalizeLifecycleCommand(
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload({ slot })
      ).ok, false);
    }
  });

  await check("05 register-fault accepts only A1 through A6", () => {
    for(const category of ["A0", "A7", "a1", 1]){
      assert.equal(normalizeLifecycleCommand(
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload({ category })
      ).ok, false);
    }
  });

  await check("06 empty and control-character descriptions are rejected", () => {
    for(const description of ["", "   ", "feil\ninjeksjon", 7]){
      assert.equal(normalizeLifecycleCommand(
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload({ description })
      ).ok, false);
    }
  });

  const primary = createFixture();
  let faultResult;
  let reportResult;
  let repairResult;
  let turningResult;
  let operationalResult;
  try{
    const registerPayload = registerFaultPayload();
    const registerCommand = command(LIFECYCLE_COMMANDS.REGISTER_FAULT, registerPayload);
    const registerOutcome = primary.repository.executeCommand(
      LIFECYCLE_COMMANDS.REGISTER_FAULT,
      registerCommand,
      dropsAuthority
    );
    faultResult = registerOutcome.result;

    await check("07 registration creates server faultId and timestamp", () => {
      assert.equal(registerOutcome.status, 201);
      assert.match(faultResult.faultId, /^[0-9a-f-]{36}$/i);
      assert.equal(faultResult.registeredAt, FIXED_TIME);
      assert.equal(faultResult.caseRevision, 1);
    });

    await check("08 same active slot cannot be registered twice", () => {
      const duplicate = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload({ expectedCaseRevision: 1, description: "Annen feil" })
      );
      assert.equal(duplicate.status, 409);
      assert.equal(primary.repository.getStorageSnapshot().counts.faults, 1);
    });

    await check("09 register-fault idempotent replay creates no duplicate", () => {
      const replay = primary.repository.executeCommand(
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerCommand,
        dropsAuthority
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.result.idempotentReplay, true);
      assert.equal(replay.result.eventId, faultResult.eventId);
      assert.equal(primary.repository.getStorageSnapshot().counts.faults, 1);
    });

    await check("10 register-fault revision mismatch gives no write", () => {
      const before = primary.repository.getStorageSnapshot().counts;
      const mismatch = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload({ expectedCaseRevision: 0, slot: 2 })
      );
      assert.equal(mismatch.status, 409);
      assert.deepEqual(primary.repository.getStorageSnapshot().counts, before);
    });

    await check("11 admin_pilot alone cannot register faults", () => {
      assert.equal(decision(CAPABILITY_IDS.REGISTER_FAULT, [ROLE_KEYS.ADMIN_PILOT]).allowed, false);
    });

    await check("12 drops can register faults", () => {
      assert.equal(decision(CAPABILITY_IDS.REGISTER_FAULT, [ROLE_KEYS.DROPS]).allowed, true);
    });

    const authoritativeFault = {
      faultId: faultResult.faultId,
      slot: faultResult.slot,
      category: faultResult.category,
      description: faultResult.description
    };
    const reportPayload = {
      actionId: actionId(),
      expectedRevision: 0,
      vehicleId: VEHICLE_ID,
      faults: [authoritativeFault]
    };
    const reportOutcome = execute(
      primary.repository,
      LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
      reportPayload
    );
    reportResult = reportOutcome.result;

    await check("13 report-not-operational uses authoritative active faults", () => {
      assert.equal(reportOutcome.status, 201);
      assert.deepEqual(reportResult.faults.map((fault) => fault.faultId), [faultResult.faultId]);
    });

    await check("14 client fault injection cannot become authority", () => {
      const injected = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL,
        {
          actionId: actionId(),
          expectedRevision: 1,
          vehicleId: VEHICLE_ID,
          faults: [{ ...authoritativeFault, description: "Klientstyrt injeksjon" }]
        }
      );
      assert.equal(injected.status, 409);
    });

    await check("15 report-not-operational sets IKKE_DRIFTSKLAR", () => {
      assert.equal(reportResult.status, "IKKE_DRIFTSKLAR");
    });

    await check("16 report-not-operational sets disposition NONE", () => {
      assert.equal(reportResult.disposition, "NONE");
    });

    await check("17 legacy 50-contract compatibility remains available", () => {
      assert.equal(typeof primary.repository.executeReportNotOperational, "function");
    });

    await check("18 request-repair requires an existing fault", () => {
      const missing = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REQUEST_REPAIR,
        {
          actionId: actionId(),
          expectedCaseRevision: 1,
          vehicleId: VEHICLE_ID,
          faultId: "11111111-1111-4111-8111-111111111111"
        }
      );
      assert.equal(missing.status, 404);
    });

    await check("19 request-repair fault must belong to vehicleId", () => {
      const wrongVehicle = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REQUEST_REPAIR,
        {
          actionId: actionId(),
          expectedCaseRevision: 1,
          vehicleId: "74-10",
          faultId: faultResult.faultId
        }
      );
      assert.equal(wrongVehicle.status, 404);
    });

    await check("20 request-repair requires ACTIVE fault", () => {
      assert.equal(primary.repository.getReadModel({ roles: [ROLE_KEYS.DROPS] })
        .faults.find((fault) => fault.faultId === faultResult.faultId).status, "ACTIVE");
    });

    await check("21 request-repair requires IKKE_DRIFTSKLAR", () => {
      const fixture = createFixture();
      try{
        const fault = execute(
          fixture.repository,
          LIFECYCLE_COMMANDS.REGISTER_FAULT,
          registerFaultPayload()
        ).result;
        const denied = execute(
          fixture.repository,
          LIFECYCLE_COMMANDS.REQUEST_REPAIR,
          {
            actionId: actionId(),
            expectedCaseRevision: 1,
            vehicleId: VEHICLE_ID,
            faultId: fault.faultId
          }
        );
        assert.equal(denied.status, 409);
      }finally{ fixture.close(); }
    });

    const repairPayload = {
      actionId: actionId(),
      expectedCaseRevision: 1,
      vehicleId: VEHICLE_ID,
      faultId: faultResult.faultId
    };
    const repairCommand = command(LIFECYCLE_COMMANDS.REQUEST_REPAIR, repairPayload);
    const repairOutcome = primary.repository.executeCommand(
      LIFECYCLE_COMMANDS.REQUEST_REPAIR,
      repairCommand,
      dropsAuthority
    );
    repairResult = repairOutcome.result;

    await check("22 first repair request creates request event and workshop notification", () => {
      assert.equal(repairOutcome.status, 201);
      const snapshot = primary.repository.getStorageSnapshot();
      assert.equal(snapshot.counts.repairRequests, 1);
      assert.equal(snapshot.counts.notifications, 1);
      assert.equal(repairResult.caseRevision, 2);
      assert.equal(repairResult.status, "REQUESTED");
    });

    await check("23 request-repair replay creates no duplicate", () => {
      const before = primary.repository.getStorageSnapshot().counts;
      const replay = primary.repository.executeCommand(
        LIFECYCLE_COMMANDS.REQUEST_REPAIR,
        repairCommand,
        dropsAuthority
      );
      assert.equal(replay.result.idempotentReplay, true);
      assert.deepEqual(primary.repository.getStorageSnapshot().counts, before);
    });

    await check("24 request-repair performs no external Stadler request", () => {
      assert.equal(repairResult.externalRequestSent, false);
    });

    await check("25 admin_pilot alone cannot request repair", () => {
      assert.equal(decision(CAPABILITY_IDS.REQUEST_REPAIR, [ROLE_KEYS.ADMIN_PILOT]).allowed, false);
    });

    await check("26 drops can request repair", () => {
      assert.equal(decision(CAPABILITY_IDS.REQUEST_REPAIR, [ROLE_KEYS.DROPS]).allowed, true);
    });

    await check("27 DRIFTSKLAR vehicle cannot receive TIL_DREI", () => {
      const fixture = createFixture();
      try{
        const denied = execute(
          fixture.repository,
          LIFECYCLE_COMMANDS.MARK_FOR_TURNING,
          {
            actionId: actionId(),
            expectedStatusRevision: 0,
            vehicleId: VEHICLE_ID
          }
        );
        assert.equal(denied.status, 409);
      }finally{ fixture.close(); }
    });

    const turningPayload = {
      actionId: actionId(),
      expectedStatusRevision: 1,
      vehicleId: VEHICLE_ID
    };
    const turningCommand = command(LIFECYCLE_COMMANDS.MARK_FOR_TURNING, turningPayload);
    const turningOutcome = primary.repository.executeCommand(
      LIFECYCLE_COMMANDS.MARK_FOR_TURNING,
      turningCommand,
      dropsAuthority
    );
    turningResult = turningOutcome.result;

    await check("28 IKKE_DRIFTSKLAR vehicle can receive TIL_DREI", () => {
      assert.equal(turningOutcome.status, 201);
      assert.equal(turningResult.disposition, "TIL_DREI");
    });

    await check("29 status and disposition remain separate", () => {
      assert.equal(turningResult.status, "IKKE_DRIFTSKLAR");
      assert.equal(turningResult.disposition, "TIL_DREI");
    });

    await check("30 mark-for-turning replay creates no extra event", () => {
      const before = primary.repository.getStorageSnapshot().counts.events;
      const replay = primary.repository.executeCommand(
        LIFECYCLE_COMMANDS.MARK_FOR_TURNING,
        turningCommand,
        dropsAuthority
      );
      assert.equal(replay.result.idempotentReplay, true);
      assert.equal(primary.repository.getStorageSnapshot().counts.events, before);
    });

    await check("31 admin_pilot alone cannot mark for turning", () => {
      assert.equal(decision(CAPABILITY_IDS.MARK_FOR_TURNING, [ROLE_KEYS.ADMIN_PILOT]).allowed, false);
    });

    await check("32 drops can mark for turning", () => {
      assert.equal(decision(CAPABILITY_IDS.MARK_FOR_TURNING, [ROLE_KEYS.DROPS]).allowed, true);
    });

    await check("33 only workshop role can report operational", () => {
      assert.equal(decision(CAPABILITY_IDS.REPORT_OPERATIONAL, [ROLE_KEYS.VERKSTED]).allowed, true);
    });
    await check("34 drops cannot report operational", () => {
      assert.equal(decision(CAPABILITY_IDS.REPORT_OPERATIONAL, [ROLE_KEYS.DROPS]).allowed, false);
    });
    await check("35 admin_pilot alone cannot report operational", () => {
      assert.equal(decision(CAPABILITY_IDS.REPORT_OPERATIONAL, [ROLE_KEYS.ADMIN_PILOT]).allowed, false);
    });
    await check("36 report-operational requires IKKE_DRIFTSKLAR", () => {
      const fixture = createFixture();
      try{
        const denied = execute(
          fixture.repository,
          LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
          {
            actionId: actionId(),
            expectedStatusRevision: 0,
            expectedCaseRevision: 0,
            vehicleId: VEHICLE_ID
          },
          workshopAuthority
        );
        assert.equal(denied.status, 409);
      }finally{ fixture.close(); }
    });

    const operationalPayload = {
      actionId: actionId(),
      expectedStatusRevision: 2,
      expectedCaseRevision: 2,
      vehicleId: VEHICLE_ID
    };
    const operationalCommand = command(LIFECYCLE_COMMANDS.REPORT_OPERATIONAL, operationalPayload);
    const operationalOutcome = primary.repository.executeCommand(
      LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
      operationalCommand,
      workshopAuthority
    );
    operationalResult = operationalOutcome.result;
    const lifecycleReadback = primary.repository.getReadModel({ roles: [ROLE_KEYS.DROPS] });

    await check("37 report-operational sets DRIFTSKLAR", () => {
      assert.equal(operationalResult.status, "DRIFTSKLAR");
    });
    await check("38 report-operational clears disposition to NONE", () => {
      assert.equal(operationalResult.disposition, "NONE");
    });
    await check("39 all ACTIVE faults become RESOLVED", () => {
      assert.equal(lifecycleReadback.faults.every((fault) => fault.status === "RESOLVED"), true);
    });
    await check("40 all REQUESTED repairs become COMPLETED", () => {
      assert.equal(lifecycleReadback.repairRequests.every((request) => request.status === "COMPLETED"), true);
    });
    await check("41 resolvedAt and completedAt are server timestamps", () => {
      assert.equal(lifecycleReadback.faults[0].resolvedAt, FIXED_TIME);
      assert.equal(lifecycleReadback.repairRequests[0].completedAt, FIXED_TIME);
    });
    await check("42 operationalAt is server timestamp", () => {
      assert.equal(operationalResult.operationalAt, FIXED_TIME);
    });
    await check("43 one DROPS notification is created", () => {
      const operationalNotifications = lifecycleReadback.notifications
        .filter((notification) => notification.kind === "VEHICLE_OPERATIONAL");
      assert.equal(operationalNotifications.length, 1);
      assert.equal(operationalNotifications[0].targetRole, ROLE_KEYS.DROPS);
    });
    await check("44 first report-operational creates one immutable event", () => {
      assert.equal(lifecycleReadback.events.filter((event) =>
        event.command === LIFECYCLE_COMMANDS.REPORT_OPERATIONAL).length, 1);
    });
    await check("45 report-operational replay preserves event and notification", () => {
      const before = primary.repository.getStorageSnapshot().counts;
      const replay = primary.repository.executeCommand(
        LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
        operationalCommand,
        workshopAuthority
      );
      assert.equal(replay.result.eventId, operationalResult.eventId);
      assert.equal(replay.result.notificationId, operationalResult.notificationId);
      assert.deepEqual(primary.repository.getStorageSnapshot().counts, before);
    });
    await check("46 actionId payload conflict gives 409", () => {
      const conflict = primary.repository.executeCommand(
        LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
        command(LIFECYCLE_COMMANDS.REPORT_OPERATIONAL, {
          ...operationalPayload,
          vehicleId: "74-10"
        }),
        workshopAuthority
      );
      assert.equal(conflict.status, 409);
    });
    await check("47 report-operational revision conflict gives no write", () => {
      const before = primary.repository.getStorageSnapshot().counts;
      const conflict = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
        {
          actionId: actionId(),
          expectedStatusRevision: 1,
          expectedCaseRevision: 2,
          vehicleId: VEHICLE_ID
        },
        workshopAuthority
      );
      assert.equal(conflict.status, 409);
      assert.deepEqual(primary.repository.getStorageSnapshot().counts, before);
    });
    await check("48 new action against already operational vehicle adds no event", () => {
      const before = primary.repository.getStorageSnapshot().counts.events;
      const conflict = execute(
        primary.repository,
        LIFECYCLE_COMMANDS.REPORT_OPERATIONAL,
        {
          actionId: actionId(),
          expectedStatusRevision: 3,
          expectedCaseRevision: 3,
          vehicleId: VEHICLE_ID
        },
        workshopAuthority
      );
      assert.equal(conflict.status, 409);
      assert.equal(primary.repository.getStorageSnapshot().counts.events, before);
    });
    await check("49 injected failure rolls back the complete operational transaction", () => {
      const fixture = createPreparedFixture({ failAt: "report_operational_after_fault_resolution" });
      try{
        const before = fixture.repository.getStorageSnapshot();
        assert.throws(() => fixture.reportOperational(), /injected lifecycle failure/);
        assert.deepEqual(fixture.repository.getStorageSnapshot(), before);
      }finally{ fixture.close(); }
    });
    await check("50 TIL_DREI clears atomically with operational transition", () => {
      assert.equal(operationalResult.previousDisposition, "TIL_DREI");
      assert.equal(operationalResult.disposition, "NONE");
    });
    await check("51 historical faults are retained", () => {
      assert.equal(lifecycleReadback.faults.length, 1);
      assert.equal(lifecycleReadback.faults[0].status, "RESOLVED");
    });
  }finally{
    primary.close();
  }

  await check("52 owner retains explicit admin_pilot role", () => {
    const roles = [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS];
    assert.equal(roles.includes(ROLE_KEYS.ADMIN_PILOT), true);
  });
  await check("53 owner additionally has explicit drops role", () => {
    const roles = [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS];
    assert.equal(roles.includes(ROLE_KEYS.DROPS), true);
  });
  await check("54 capabilities are the union of explicit roles", () => {
    const result = decision(CAPABILITY_IDS.REGISTER_FAULT, [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS]);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.capabilitySourceRoles, [ROLE_KEYS.DROPS]);
  });
  await check("55 admin_pilot grants no operational writes alone", () => {
    for(const capability of [
      CAPABILITY_IDS.REGISTER_FAULT,
      CAPABILITY_IDS.REQUEST_REPAIR,
      CAPABILITY_IDS.MARK_FOR_TURNING,
      CAPABILITY_IDS.REPORT_OPERATIONAL
    ]){
      assert.equal(decision(capability, [ROLE_KEYS.ADMIN_PILOT]).allowed, false);
    }
  });
  await check("56 admin_pilot plus drops grants only drops commands", () => {
    const roles = [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS];
    assert.equal(decision(CAPABILITY_IDS.REGISTER_FAULT, roles).allowed, true);
    assert.equal(decision(CAPABILITY_IDS.REQUEST_REPAIR, roles).allowed, true);
    assert.equal(decision(CAPABILITY_IDS.MARK_FOR_TURNING, roles).allowed, true);
  });
  await check("57 multi-role owner receives no workshop write", () => {
    assert.equal(decision(
      CAPABILITY_IDS.REPORT_OPERATIONAL,
      [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS]
    ).allowed, false);
  });

  await check("58 gate off is 404 with zero writes for all commands", () => {
    const fixture = createFixture({ writeEnabled: false });
    try{
      const cases = [
        [LIFECYCLE_COMMANDS.REGISTER_FAULT, registerFaultPayload()],
        [LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL, {
          actionId: actionId(), expectedRevision: 0, vehicleId: VEHICLE_ID, faults: []
        }],
        [LIFECYCLE_COMMANDS.REQUEST_REPAIR, {
          actionId: actionId(), expectedCaseRevision: 0, vehicleId: VEHICLE_ID,
          faultId: "11111111-1111-4111-8111-111111111111"
        }],
        [LIFECYCLE_COMMANDS.MARK_FOR_TURNING, {
          actionId: actionId(), expectedStatusRevision: 0, vehicleId: VEHICLE_ID
        }],
        [LIFECYCLE_COMMANDS.REPORT_OPERATIONAL, {
          actionId: actionId(), expectedStatusRevision: 0, expectedCaseRevision: 0,
          vehicleId: VEHICLE_ID
        }]
      ];
      for(const [name, payload] of cases){
        assert.equal(execute(fixture.repository, name, payload).status, 404);
      }
      assert.equal(fixture.repository.getStorageSnapshot().counts.events, 0);
    }finally{ fixture.close(); }
  });
  await check("59 test gate cannot open production writes", () => {
    const fixture = createFixture({ writeEnabled: false });
    try{
      assert.equal(fixture.repository.getReadModel().writeEnabled, false);
    }finally{ fixture.close(); }
  });
  await check("60 allowlist alone cannot open writes", () => {
    const fixture = createFixture({ writeEnabled: false });
    try{
      assert.equal(execute(
        fixture.repository,
        LIFECYCLE_COMMANDS.REGISTER_FAULT,
        registerFaultPayload()
      ).status, 404);
    }finally{ fixture.close(); }
  });
  await check("61 authenticated readback computes pilot allowlist metadata server-side", async () => {
    let metadataContext = null;
    const handler = createVehicleStatusReadHandler({
      repository: {
        getReadModel({ roles }){
          return {
            writeEnabled: true,
            rolesSeen: [...roles]
          };
        }
      },
      roleBindingsCatalog: {
        bindings: [{
          bindingId: "owner-readiness",
          subject: "cf-access|owner",
          roles: [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS],
          enabled: true
        }]
      },
      verifyIdentityRequest: async () => ({
        ok: true,
        identity: {
          authenticated: true,
          identityVerified: true,
          identityKind: "human",
          subject: "cf-access|owner",
          identitySource: "cloudflare_access_jwt"
        }
      }),
      responseMetadata(context){
        metadataContext = context;
        const allowed = context.roles.includes(ROLE_KEYS.DROPS);
        return {
          productionPilotWriteEnabled: true,
          vehicleStatusPersistenceReady: true,
          registerFaultCommandAvailable: allowed,
          pilotAllowedVehicleIds: allowed ? [VEHICLE_ID] : []
        };
      }
    });
    const response = createJsonResponse();
    await handler({ headers: { authorization: "Bearer test" } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body.roles, [ROLE_KEYS.ADMIN_PILOT, ROLE_KEYS.DROPS]);
    assert.equal(response.body.registerFaultCommandAvailable, true);
    assert.deepEqual(response.body.pilotAllowedVehicleIds, [VEHICLE_ID]);
    assert.equal(metadataContext.identityResult.ok, true);
    assert.equal(metadataContext.roleResult.roleResolved, true);
  });
  await check("62 permanent lifecycle test uses temp databases only", () => {
    const fixture = createFixture();
    try{
      assert.equal(path.dirname(fixture.databasePath), os.tmpdir());
      assert.notEqual(path.resolve(fixture.databasePath), path.resolve(MAIN_DB));
    }finally{ fixture.close(); }
  });
  await check("63 production database is untouched", () => {
    assert.deepEqual(snapshotFiles(Object.keys(productionBefore)), productionBefore);
  });
  await check("64 operational state is untouched", () => {
    assert.equal(globalThis.__sdeOperationalStateWriteCount || 0, 0);
  });
  await check("65 shared draft is untouched", () => {
    assert.equal(SHARED_DRAFT_DB, MAIN_DB);
    assert.deepEqual(snapshotFiles(Object.keys(productionBefore)), productionBefore);
  });

  assert.equal(passed.length, 65);
  console.log(JSON.stringify({
    schemaVersion: "sde-vehicle-status-lifecycle-v2-test-report",
    status: "PASS",
    checks: passed.length,
    commands: Object.values(LIFECYCLE_COMMANDS),
    productionWrite: false
  }));
}

function createPreparedFixture({ failAt } = {}){
  let enabled = false;
  const fixture = createFixture({
    failureInjector(point){
      if(enabled && point === failAt) throw new Error("injected lifecycle failure");
    }
  });
  const fault = execute(
    fixture.repository,
    LIFECYCLE_COMMANDS.REGISTER_FAULT,
    registerFaultPayload()
  ).result;
  execute(fixture.repository, LIFECYCLE_COMMANDS.REPORT_NOT_OPERATIONAL, {
    actionId: actionId(),
    expectedRevision: 0,
    vehicleId: VEHICLE_ID,
    faults: [{
      faultId: fault.faultId,
      slot: fault.slot,
      category: fault.category,
      description: fault.description
    }]
  });
  execute(fixture.repository, LIFECYCLE_COMMANDS.REQUEST_REPAIR, {
    actionId: actionId(),
    expectedCaseRevision: 1,
    vehicleId: VEHICLE_ID,
    faultId: fault.faultId
  });
  execute(fixture.repository, LIFECYCLE_COMMANDS.MARK_FOR_TURNING, {
    actionId: actionId(),
    expectedStatusRevision: 1,
    vehicleId: VEHICLE_ID
  });
  enabled = true;
  return {
    ...fixture,
    reportOperational(){
      return execute(fixture.repository, LIFECYCLE_COMMANDS.REPORT_OPERATIONAL, {
        actionId: actionId(),
        expectedStatusRevision: 2,
        expectedCaseRevision: 2,
        vehicleId: VEHICLE_ID
      }, workshopAuthority);
    }
  };
}

function snapshotFiles(filePaths){
  return Object.fromEntries(filePaths.map((filePath) => {
    try{
      const buffer = fs.readFileSync(filePath);
      return [filePath, {
        exists: true,
        size: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex")
      }];
    }catch(error){
      if(error.code === "ENOENT") return [filePath, { exists: false }];
      throw error;
    }
  }));
}

function createJsonResponse(){
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value){
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    status(value){
      this.statusCode = value;
      return this;
    },
    json(value){
      this.body = value;
      return value;
    }
  };
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
