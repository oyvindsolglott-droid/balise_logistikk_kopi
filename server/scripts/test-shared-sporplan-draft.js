"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createSchemaSql } = require("../src/schema");
const {
  ensureSharedSporplanDraftSchema,
  getSharedSporplanDraft,
  saveSharedSporplanDraft,
  validateSharedSporplanDraftPayload
} = require("../src/sharedSporplanDraft");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sde-sync-a-shared-sporplan-"));
const databasePath = path.join(tempDir, "sde-sync-a.sqlite3");
const productionDatabasePath = path.resolve(__dirname, "..", "data", "sde-server.sqlite3");

assert.notEqual(
  path.resolve(databasePath),
  productionDatabasePath,
  "test must not use the production database"
);
assert.ok(
  path.resolve(databasePath).startsWith(path.resolve(os.tmpdir())),
  "test database must live under the OS temp directory"
);

let db;

try{
  db = new DatabaseSync(databasePath);
  db.exec(createSchemaSql());

  runSchemaTest();
  runDefaultReadbackTest();
  runValidationTests();
  runSaveAndReadbackTests();
  runRevisionConflictTest();
  runNoOperationalStateEventsTest();

  console.log("SDE-SYNC-A shared sporplan draft tests OK");
}finally{
  if(db){
    db.close();
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runSchemaTest(){
  ensureSharedSporplanDraftSchema(db);
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get("shared_sporplan_draft");

  assert.equal(table.name, "shared_sporplan_draft", "shared sporplan draft table must exist");
}

function runDefaultReadbackTest(){
  const readback = getSharedSporplanDraft(db);

  assert.equal(readback.mode, "shared_sporplan_draft");
  assert.equal(readback.serverStateAuthority, false);
  assert.equal(readback.operationalAuthority, false);
  assert.equal(readback.writesRepresentOperationalAuthority, false);
  assert.equal(readback.revision, 0);
  assert.equal(readback.updatedAt, null);
  assert.deepEqual(readback.draft, {
    grunnoppstilling: {},
    grunnoppstillingRep: {}
  });
  assert.deepEqual(readback.audit, {
    updatedByActor: null,
    updatedByDevice: null,
    clientContext: {}
  });
}

function runValidationTests(){
  expectInvalid(
    "missing expectedRevision",
    {
      draft: emptyDraft(),
      audit: emptyAudit()
    },
    "expected_revision_required"
  );

  expectInvalid(
    "missing draft",
    {
      expectedRevision: 0,
      audit: emptyAudit()
    },
    "invalid_draft"
  );

  expectInvalid(
    "serverStateAuthority is blocked",
    payloadWithBlockedAuthorityField("serverStateAuthority"),
    "authority_field_not_allowed"
  );

  expectInvalid(
    "operationalAuthority is blocked",
    payloadWithBlockedAuthorityField("operationalAuthority"),
    "authority_field_not_allowed"
  );

  expectInvalid(
    "writesRepresentOperationalAuthority is blocked",
    payloadWithBlockedAuthorityField("writesRepresentOperationalAuthority"),
    "authority_field_not_allowed"
  );

  expectInvalid(
    "high-risk utfort field is blocked",
    {
      expectedRevision: 0,
      draft: {
        grunnoppstilling: {},
        grunnoppstillingRep: {},
        utfort: {}
      },
      audit: emptyAudit()
    },
    "high_risk_field_not_allowed"
  );

  expectInvalid(
    "DROPS field is blocked",
    {
      expectedRevision: 0,
      draft: emptyDraft(),
      audit: {
        actor: "pilot",
        device: "device",
        clientContext: {
          drops: "dispatch"
        }
      }
    },
    "high_risk_field_not_allowed"
  );

  expectInvalid(
    "invalid grunnoppstilling map rejected",
    {
      expectedRevision: 0,
      draft: {
        grunnoppstilling: [],
        grunnoppstillingRep: {}
      },
      audit: emptyAudit()
    },
    "invalid_draft_map"
  );
}

function runSaveAndReadbackTests(){
  const firstPayload = {
    expectedRevision: 0,
    draft: {
      grunnoppstilling: {
        "5M": "74-54"
      },
      grunnoppstillingRep: {
        "5M": "r"
      }
    },
    audit: {
      actor: "sde-sync-a-test",
      device: "temp-db-test",
      clientContext: {
        phase: "SDE-SYNC-A",
        source: "isolated-test"
      }
    }
  };

  const first = saveSharedSporplanDraft(db, firstPayload, "2026-07-02T08:00:00.000Z");
  assert.equal(first.ok, true);
  assert.equal(first.previousRevision, 0);
  assert.equal(first.readback.revision, 1);
  assert.equal(first.readback.updatedAt, "2026-07-02T08:00:00.000Z");
  assert.equal(first.readback.serverStateAuthority, false);
  assert.equal(first.readback.operationalAuthority, false);
  assert.equal(first.readback.writesRepresentOperationalAuthority, false);
  assert.deepEqual(first.readback.draft, firstPayload.draft);
  assert.deepEqual(first.readback.audit, {
    updatedByActor: "sde-sync-a-test",
    updatedByDevice: "temp-db-test",
    clientContext: firstPayload.audit.clientContext
  });

  const readback = getSharedSporplanDraft(db);
  assert.deepEqual(readback, first.readback, "get after save must return saved draft");

  const second = saveSharedSporplanDraft(db, {
    expectedRevision: 1,
    draft: {
      grunnoppstilling: {
        "5M": "74-54",
        "6S": "74-12"
      },
      grunnoppstillingRep: {
        "5M": "r",
        "6S": "d"
      }
    },
    audit: {
      actor: null,
      device: null,
      clientContext: {}
    }
  }, "2026-07-02T08:01:00.000Z");

  assert.equal(second.ok, true);
  assert.equal(second.previousRevision, 1);
  assert.equal(second.readback.revision, 2);
  assert.equal(second.readback.audit.updatedByActor, null);
  assert.equal(second.readback.audit.updatedByDevice, null);
}

function runRevisionConflictTest(){
  const conflict = saveSharedSporplanDraft(db, {
    expectedRevision: 1,
    draft: emptyDraft(),
    audit: emptyAudit()
  }, "2026-07-02T08:02:00.000Z");

  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "revision_conflict");
  assert.equal(conflict.expectedRevision, 1);
  assert.equal(conflict.currentRevision, 2);

  const readback = getSharedSporplanDraft(db);
  assert.equal(readback.revision, 2, "revision conflict must not bump revision");
}

function runNoOperationalStateEventsTest(){
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  assert.equal(eventCount, 0, "shared sporplan draft test must not create operational-state events");
}

function expectInvalid(label, payload, code){
  const validation = validateSharedSporplanDraftPayload(payload);
  assert.equal(validation.ok, false, `${label}: expected invalid`);
  assert.equal(validation.code, code, `${label}: unexpected validation code`);
}

function emptyDraft(){
  return {
    grunnoppstilling: {},
    grunnoppstillingRep: {}
  };
}

function emptyAudit(){
  return {
    actor: "sde-sync-a-test",
    device: "temp-db-test",
    clientContext: {}
  };
}

function payloadWithBlockedAuthorityField(fieldName){
  const payload = {
    expectedRevision: 0,
    draft: emptyDraft(),
    audit: emptyAudit()
  };
  payload[fieldName] = Boolean("blocked-authority-field");
  return payload;
}
