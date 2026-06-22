#!/usr/bin/env node

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const {
  PRODUCTION_DB_PATH,
  assertSafeMigrationDatabasePath,
  inspectDatabase,
  migrateActionsSchema,
  openMigrationDatabase,
  validateActionsSchema
} = require("../src/actionsMigration");

const TEST_DB = "/tmp/sde-server-b10-actions-migration.sqlite3";
const BAD_SCHEMA_DB = "/tmp/sde-server-b10-actions-migration-bad.sqlite3";

function main(){
  const results = {
    productionGuard: runProductionGuardCheck(),
    freshDatabase: runFreshDatabaseScenario(),
    existingCorrectSchema: runExistingCorrectSchemaScenario(),
    badExistingSchema: runBadExistingSchemaScenario()
  };

  console.log(JSON.stringify(results, null, 2));
}

function runProductionGuardCheck(){
  try{
    assertSafeMigrationDatabasePath(PRODUCTION_DB_PATH);
  }catch(error){
    if(error.code === "production_database_blocked"){
      return {
        ok: true,
        blocked: true,
        error: error.code
      };
    }

    throw error;
  }

  throw new Error("Production database guard did not block migration.");
}

function runFreshDatabaseScenario(){
  removeDatabaseFiles(TEST_DB);
  const db = openMigrationDatabase(TEST_DB);

  try{
    const migration = migrateActionsSchema(db, { databasePath: TEST_DB });
    const inspection = inspectDatabase(db);
    const schemaCheck = validateActionsSchema(inspection);
    const uniqueActionId = verifyUniqueActionId(db);

    assertCondition(migration.changed === true, "fresh migration should change the database");
    assertCondition(inspection.integrityCheck === "ok", "fresh integrity_check should be ok");
    assertCondition(inspection.userVersion === 1, "fresh user_version should be 1");
    assertCondition(schemaCheck.ok, "fresh actions schema should match expected schema");

    return {
      ok: true,
      databasePath: TEST_DB,
      migrationChanged: migration.changed,
      integrityCheck: inspection.integrityCheck,
      userVersion: inspection.userVersion,
      tables: inspection.tables,
      actionsTableInfo: inspection.actionsTableInfo,
      actionsIndexList: inspection.actionsIndexList,
      uniqueActionId
    };
  }finally{
    closeQuietly(db);
  }
}

function runExistingCorrectSchemaScenario(){
  const db = openMigrationDatabase(TEST_DB);

  try{
    const migration = migrateActionsSchema(db, { databasePath: TEST_DB });
    const inspection = inspectDatabase(db);
    const schemaCheck = validateActionsSchema(inspection);

    assertCondition(migration.changed === false, "second migration should be a no-op");
    assertCondition(inspection.integrityCheck === "ok", "existing schema integrity_check should be ok");
    assertCondition(inspection.userVersion === 1, "existing schema user_version should remain 1");
    assertCondition(schemaCheck.ok, "existing actions schema should still match expected schema");

    return {
      ok: true,
      databasePath: TEST_DB,
      migrationChanged: migration.changed,
      integrityCheck: inspection.integrityCheck,
      userVersion: inspection.userVersion,
      tables: inspection.tables,
      actionsTableInfo: inspection.actionsTableInfo,
      actionsIndexList: inspection.actionsIndexList
    };
  }finally{
    closeQuietly(db);
  }
}

function runBadExistingSchemaScenario(){
  removeDatabaseFiles(BAD_SCHEMA_DB);
  const db = openMigrationDatabase(BAD_SCHEMA_DB);

  try{
    db.exec("CREATE TABLE actions (action_id TEXT);");

    let stoppedHard = false;
    let errorCode = "";
    let errorMessage = "";
    try{
      migrateActionsSchema(db, { databasePath: BAD_SCHEMA_DB });
    }catch(error){
      stoppedHard = error.code === "unexpected_actions_schema";
      errorCode = error.code || error.name;
      errorMessage = error.message;
    }

    const inspection = inspectDatabase(db);

    assertCondition(stoppedHard, "bad existing actions table should stop hard");
    assertCondition(inspection.userVersion === 0, "bad schema user_version should remain 0");
    assertCondition(inspection.actionsTableInfo.length === 1, "bad schema should not be repaired");

    return {
      ok: true,
      databasePath: BAD_SCHEMA_DB,
      stoppedHard,
      errorCode,
      errorMessage,
      integrityCheck: inspection.integrityCheck,
      userVersion: inspection.userVersion,
      tables: inspection.tables,
      actionsTableInfo: inspection.actionsTableInfo,
      actionsIndexList: inspection.actionsIndexList
    };
  }finally{
    closeQuietly(db);
  }
}

function verifyUniqueActionId(db){
  db.exec("SAVEPOINT b10_unique_action_id_test;");
  let duplicateRejected = false;
  let duplicateError = "";

  try{
    insertActionRow(db, "b10-unique-test");
    try{
      insertActionRow(db, "b10-unique-test");
    }catch(error){
      duplicateRejected = true;
      duplicateError = error.message;
    }

    assertCondition(duplicateRejected, "duplicate action_id should be rejected");
  }finally{
    rollbackSavepointQuietly(db, "b10_unique_action_id_test");
  }

  return {
    ok: true,
    duplicateRejected,
    duplicateError
  };
}

function insertActionRow(db, actionId){
  db.prepare(`
    INSERT INTO actions (
      action_id,
      action_type,
      actor_id,
      actor_role,
      device_id,
      expected_revision,
      request_json,
      payload_hash,
      status,
      resulting_revision,
      event_id,
      server_created_at,
      completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actionId,
    "b10.schema-test",
    "local-test-operator",
    "developer",
    "b10-migration-test",
    1,
    JSON.stringify({ actionId }),
    "b10-test-hash",
    "completed",
    2,
    1,
    "2026-06-23T00:00:00.000Z",
    "2026-06-23T00:00:00.000Z"
  );
}

function removeDatabaseFiles(databasePath){
  for(const suffix of ["", "-wal", "-shm"]){
    const filePath = `${databasePath}${suffix}`;
    if(fs.existsSync(filePath)){
      fs.unlinkSync(filePath);
    }
  }
}

function assertCondition(condition, message){
  if(!condition){
    throw new Error(message);
  }
}

function rollbackSavepointQuietly(db, savepointName){
  try{
    db.exec(`ROLLBACK TO ${savepointName};`);
  }catch(_error){
    // Preserve the original test failure.
  }

  try{
    db.exec(`RELEASE ${savepointName};`);
  }catch(_error){
    // Preserve the original test failure.
  }
}

function closeQuietly(db){
  try{
    db.close();
  }catch(_error){
    // Nothing useful to do while ending a one-shot test script.
  }
}

try{
  main();
}catch(error){
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
