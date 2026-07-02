"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main(){
  try{
    db = new DatabaseSync(databasePath);
    db.exec(createSchemaSql());

    runSchemaTest();
    runDefaultReadbackTest();
    runValidationTests();
    runSaveAndReadbackTests();
    runRevisionConflictTest();
    runNoOperationalStateEventsTest();
    await runPostWithoutWriteFlagRouteTest();

    console.log("SDE-SYNC-D1 shared sporplan draft tests OK");
  }finally{
    if(db){
      db.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  const rowCount = getSharedDraftRowCount();

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
  assert.equal(rowCount, 0, "GET/default readback must not create a DB row");
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
    "invalid expectedRevision type",
    {
      expectedRevision: "0",
      draft: nonEmptyDraft(),
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
    "empty draft rejected",
    {
      expectedRevision: 0,
      draft: emptyDraft(),
      audit: emptyAudit()
    },
    "empty_shared_draft"
  );

  expectInvalid(
    "unknown draft field rejected",
    {
      expectedRevision: 0,
      draft: {
        ...nonEmptyDraft(),
        unknownField: "not allowed"
      },
      audit: emptyAudit()
    },
    "unexpected_draft_field"
  );

  expectInvalid(
    "high-risk draft field rejected",
    {
      expectedRevision: 0,
      draft: {
        ...nonEmptyDraft(),
        actions: []
      },
      audit: emptyAudit()
    },
    "high_risk_field_not_allowed"
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
    "clientContext operationalAuthority is blocked",
    {
      expectedRevision: 0,
      draft: nonEmptyDraft(),
      audit: {
        actor: "pilot",
        device: "device",
        clientContext: {
          operationalAuthority: true
        }
      }
    },
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
    "events field is blocked",
    {
      expectedRevision: 0,
      draft: nonEmptyDraft(),
      audit: {
        actor: "pilot",
        device: "device",
        clientContext: {
          events: []
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
  assertSharedDraftAudit(first.readback.audit, {
    actor: "sde-sync-a-test",
    device: "temp-db-test",
    expectedRevision: 0,
    previousServerRevision: 0,
    newServerRevision: 1,
    serverUpdatedAt: "2026-07-02T08:00:00.000Z"
  });
  assert.deepEqual(first.readback.audit.clientContext, firstPayload.audit.clientContext);
  const firstStoredAudit = getStoredAudit();
  assert.equal(firstStoredAudit.expectedRevision, 0);
  assert.equal(firstStoredAudit.previousServerRevision, 0);
  assert.equal(firstStoredAudit.newServerRevision, 1);

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
  assert.equal(second.readback.audit.expectedRevision, 1);
  assert.equal(second.readback.audit.previousServerRevision, 1);
  assert.equal(second.readback.audit.newServerRevision, 2);
  const secondStoredAudit = getStoredAudit();
  assert.equal(secondStoredAudit.expectedRevision, 1);
  assert.equal(secondStoredAudit.previousServerRevision, 1);
  assert.equal(secondStoredAudit.newServerRevision, 2);
  assert.equal(getSharedDraftRowCount(), 1, "updates must keep a single shared draft row");
}

function runRevisionConflictTest(){
  const conflict = saveSharedSporplanDraft(db, {
    expectedRevision: 1,
    draft: {
      grunnoppstilling: {
        "7M": "74-99"
      },
      grunnoppstillingRep: {}
    },
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

async function runPostWithoutWriteFlagRouteTest(){
  const routeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sde-sync-d1-shared-route-"));
  const routeDbPath = path.join(routeTempDir, "sde-sync-d1-route.sqlite3");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve(__dirname, "..", "src", "index.js");
  let child = null;

  assert.notEqual(path.resolve(routeDbPath), productionDatabasePath, "route test must not use production DB");
  assert.ok(path.resolve(routeDbPath).startsWith(path.resolve(os.tmpdir())), "route test DB must live under temp");

  try{
    child = spawn(process.execPath, [serverPath], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        SDE_SERVER_DB_PATH: routeDbPath,
        SDE_ENABLE_SHARED_SPORPLAN_DRAFT_WRITES: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });

    await waitForServer(port, child, () => output);
    const disabled = await requestJson("POST", port, "/api/shared-sporplan-draft", {
      expectedRevision: 0,
      draft: nonEmptyDraft(),
      audit: emptyAudit()
    });

    assert.equal(disabled.status, 403, "POST without write flag must be forbidden");
    assert.equal(disabled.body?.error, "shared_sporplan_draft_writes_disabled");
  }finally{
    if(child && child.exitCode === null){
      child.kill("SIGTERM");
      await waitForExit(child, 2000);
    }
    fs.rmSync(routeTempDir, { recursive: true, force: true });
  }
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

function nonEmptyDraft(){
  return {
    grunnoppstilling: {
      "5M": "74-54"
    },
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

function getSharedDraftRowCount(){
  return db.prepare("SELECT COUNT(*) AS count FROM shared_sporplan_draft").get().count;
}

function getStoredAudit(){
  const row = db.prepare("SELECT audit_json AS auditJson FROM shared_sporplan_draft WHERE id = ?").get("default");
  assert.ok(row, "stored shared draft row must exist");
  return JSON.parse(row.auditJson);
}

function assertSharedDraftAudit(audit, expected){
  assert.equal(audit.mode, "shared_sporplan_draft");
  assert.equal(audit.authority, "draft_readback_only");
  assert.equal(audit.operationalAuthority, false);
  assert.equal(audit.serverStateAuthority, false);
  assert.equal(audit.writesRepresentOperationalAuthority, false);
  assert.equal(audit.expectedRevision, expected.expectedRevision);
  assert.equal(audit.previousServerRevision, expected.previousServerRevision);
  assert.equal(audit.newServerRevision, expected.newServerRevision);
  assert.equal(audit.serverReceivedAt, expected.serverUpdatedAt);
  assert.equal(audit.serverUpdatedAt, expected.serverUpdatedAt);
  assert.equal(audit.actor, expected.actor);
  assert.equal(audit.device, expected.device);
  assert.equal(audit.updatedByActor, expected.actor);
  assert.equal(audit.updatedByDevice, expected.device);
}

function requestJson(method, port, pathName, body){
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body || {});
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text)
      }
    }, response => {
      let raw = "";
      response.on("data", chunk => { raw += chunk.toString(); });
      response.on("end", () => {
        let parsed = null;
        try{
          parsed = raw ? JSON.parse(raw) : null;
        }catch(_error){
          parsed = null;
        }
        resolve({
          status: response.statusCode,
          body: parsed,
          raw
        });
      });
    });
    request.on("error", reject);
    request.write(text);
    request.end();
  });
}

async function waitForServer(port, child, getOutput){
  const deadline = Date.now() + 5000;
  while(Date.now() < deadline){
    if(child.exitCode !== null){
      throw new Error(`test server exited early: ${getOutput()}`);
    }
    try{
      const health = await requestJson("GET", port, "/api/health");
      if(health.status === 200 && health.body?.ok === true){
        return;
      }
    }catch(_error){
      // Try again until the non-production test server is listening.
    }
    await delay(100);
  }
  throw new Error(`test server did not start: ${getOutput()}`);
}

function waitForExit(child, timeoutMs){
  return new Promise(resolve => {
    if(child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      if(child.exitCode === null){
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}
