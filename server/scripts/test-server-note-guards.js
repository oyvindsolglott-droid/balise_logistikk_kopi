#!/usr/bin/env node

const {
  PRODUCTION_DB_PATH,
  PRODUCTION_PORT,
  getServerNoteGuardFailure,
  getServerNoteStatus
} = require("../src/serverNoteGuards");

const TEST_PORT = 8790;
const TMP_DB = "/tmp/sde-b20-blocker-server-note-guard.sqlite3";
const NON_TMP_DB = "/Users/solglottsr/balise_logistikk_kopi/server/data/not-production.sqlite3";

function main(){
  assertError("disabled without server-note flag", guard({}, TEST_PORT, TMP_DB), "server_note_actions_disabled");

  assertNull("test mode allows non-production /tmp target", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: TMP_DB
  }, TEST_PORT, TMP_DB));

  assertError("test mode blocks production port", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: TMP_DB
  }, PRODUCTION_PORT, TMP_DB), "server_note_actions_production_port");

  assertError("test mode blocks production database", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: PRODUCTION_DB_PATH
  }, TEST_PORT, PRODUCTION_DB_PATH), "server_note_actions_production_database");

  assertError("test mode requires explicit DB path", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1"
  }, TEST_PORT, TMP_DB), "server_note_actions_db_path_required");

  assertError("test mode requires /tmp database", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: NON_TMP_DB
  }, TEST_PORT, NON_TMP_DB), "server_note_actions_tmp_database_required");

  assertError("production-like target needs extra production flag", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: PRODUCTION_DB_PATH
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH), "server_note_actions_production_port");

  assertNull("production mode allows only production port and DB", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1"
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH));

  assertError("production flag does not allow /tmp target", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1",
    SDE_SERVER_DB_PATH: TMP_DB
  }, TEST_PORT, TMP_DB), "server_note_actions_production_target_required");

  assertError("operational flag alone does not enable server-note", guard({
    SDE_ENABLE_OPERATIONAL_WRITES: "1"
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH), "server_note_actions_disabled");

  assertError("operational flag cannot be combined with server-note", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_OPERATIONAL_WRITES: "1"
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH), "server_note_actions_operational_writes_forbidden");

  assertError("migration flag cannot be combined with production server-note", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_SCHEMA_MIGRATIONS: "1"
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH), "server_note_actions_conflicting_flag");

  assertError("test write flag cannot be combined with production server-note", guard({
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES: "1"
  }, PRODUCTION_PORT, PRODUCTION_DB_PATH), "server_note_actions_conflicting_flag");

  assertStatus("disabled status", {}, false, false);
  assertStatus("test mode status", {
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1"
  }, true, false);
  assertStatus("production mode status", {
    SDE_ENABLE_SERVER_NOTE_ACTIONS: "1",
    SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS: "1"
  }, true, true);

  console.log("disabled: ok");
  console.log("testMode: ok");
  console.log("productionMode: ok");
  console.log("conflictingFlags: ok");
  console.log("statusFields: ok");
  console.log("result: PASS_B20_BLOCKER_SERVER_NOTE_GUARDS");
}

function guard(env, port, databasePath){
  return getServerNoteGuardFailure({
    env,
    port,
    databasePath
  });
}

function assertStatus(label, env, expectedActionsEnabled, expectedProductionEnabled){
  const status = getServerNoteStatus(env);
  assertEqual(status.serverNoteActionsEnabled, expectedActionsEnabled, `${label} serverNoteActionsEnabled`);
  assertEqual(
    status.serverNoteProductionActionsEnabled,
    expectedProductionEnabled,
    `${label} serverNoteProductionActionsEnabled`
  );
}

function assertNull(label, value){
  if(value !== null){
    throw new Error(`${label}: expected no guard failure, got ${JSON.stringify(value)}`);
  }
}

function assertError(label, value, expectedError){
  if(!value){
    throw new Error(`${label}: expected ${expectedError}, got no guard failure`);
  }

  assertEqual(value.error, expectedError, label);
}

function assertEqual(actual, expected, label){
  if(actual !== expected){
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

main();
