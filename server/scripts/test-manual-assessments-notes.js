"use strict";

const assert = require("node:assert/strict");

const {
  validateOperationalStateSnapshotPayload
} = require("../src/operationalState");

function basePayload(overrides = {}) {
  return {
    scope: "manual-assessments-notes",
    schemaVersion: 1,
    scopeVersion: 1,
    sourceModule: "shared-workspace-manual-note",
    writeIntent: "test_manual_assessment_note",
    readbackOnly: true,
    serviceDate: "2026-06-29",
    idempotencyKey: "manual-assessments-notes-test-20260629T215000Z",
    expectedRevision: 7,
    actor: {
      id: "b41c-test-actor",
      role: "sde-test"
    },
    device: {
      id: "b41c-test-device"
    },
    clientContext: {
      readbackOnly: true,
      notOperationalOrder: true,
      notCompletedCancelled: true,
      notSdeMotorSource: true,
      noAutomaticSubmit: true,
      oneManualSubmit: true,
      serverStateAuthority: false,
      operationalAuthority: false
    },
    payload: {
      category: "observation",
      assessmentStatus: "observation",
      relatedScope: "sde-night-placement-manual-overrides",
      validForServiceDate: "2026-06-29",
      text: "Delt observasjon til senere vurdering.",
      relatedVehicle: "74-54",
      relatedSlot: "5M"
    },
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectValid(name, payload) {
  const result = validateOperationalStateSnapshotPayload(payload);
  assert.equal(result.ok, true, `${name}: expected valid payload, got ${result.code}`);
  return result.value;
}

function expectInvalid(name, payload, code) {
  const result = validateOperationalStateSnapshotPayload(payload);
  assert.equal(result.ok, false, `${name}: expected invalid payload`);
  if (code) {
    assert.equal(result.code, code, `${name}: unexpected validation code`);
  }
}

const valid = expectValid("valid canonical B41 payload", basePayload());
assert.deepEqual(valid.stateScope, ["manual-assessments-notes"]);
assert.equal(valid.expectedServerRevision, 7);
assert.equal(valid.clientContext.serverStateAuthority, false);
assert.equal(valid.clientContext.operationalAuthority, false);
assert.equal(valid.stateSnapshot.manualAssessmentNote.readbackOnly, true);
assert.equal(valid.stateSnapshot.manualAssessmentNote.payload.relatedVehicle, "74-54");

const validStateScopeAlias = basePayload({ stateScope: ["manual-assessments-notes"] });
delete validStateScopeAlias.scope;
assert.deepEqual(
  expectValid("valid stateScope alias", validStateScopeAlias).stateScope,
  ["manual-assessments-notes"]
);

expectInvalid(
  "multiple scopes blocked",
  basePayload({ stateScope: ["manual-assessments-notes", "input-sporplan-draft"] }),
  "invalid_manual_assessments_scope"
);

expectInvalid(
  "wrong scope blocked",
  basePayload({ scope: "input-sporplan-draft" }),
  "invalid_manual_assessments_scope"
);

expectInvalid(
  "audit log direct write blocked",
  basePayload({ scope: "shared-workspace-audit-log" }),
  "audit_log_client_write_forbidden"
);

const missingExpectedRevision = basePayload();
delete missingExpectedRevision.expectedRevision;
expectInvalid(
  "expectedRevision required",
  missingExpectedRevision,
  "invalid_expectedRevision"
);

expectInvalid(
  "expectedRevision alias mismatch blocked",
  basePayload({ expectedServerRevision: 8 }),
  "expected_revision_alias_mismatch"
);

expectInvalid(
  "readbackOnly required",
  basePayload({ readbackOnly: false }),
  "invalid_readbackOnly"
);

expectInvalid(
  "authority context blocked",
  basePayload({
    clientContext: {
      ...basePayload().clientContext,
      operationalAuthority: true
    }
  }),
  "invalid_clientContext"
);

expectInvalid(
  "bad category blocked",
  basePayload({
    payload: {
      ...basePayload().payload,
      category: "order"
    }
  }),
  "invalid_manual_assessment_category"
);

expectInvalid(
  "operational language blocked",
  basePayload({
    payload: {
      ...basePayload().payload,
      text: "Utfoer skifteordre for 74-54."
    }
  }),
  "forbidden_manual_assessment_language"
);

expectInvalid(
  "transient UI field blocked",
  basePayload({
    payload: {
      ...basePayload().payload,
      selectedSlot: "5M"
    }
  }),
  "forbidden_manual_assessment_field"
);

const rawStateSnapshot = clone(basePayload());
rawStateSnapshot.stateSnapshot = { raw: true };
expectInvalid("raw stateSnapshot blocked", rawStateSnapshot);

console.log("PASS_B41C_MANUAL_ASSESSMENTS_GUARDS");
