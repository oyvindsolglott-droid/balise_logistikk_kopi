const fs = require("node:fs");
const path = require("node:path");

const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";
const PRODUCTION_PORT = 8787;

const CONFLICTING_SERVER_NOTE_FLAGS = [
  "SDE_ENABLE_SCHEMA_MIGRATIONS",
  "SDE_ENABLE_TEST_WRITES",
  "SDE_ENABLE_ACTIONS_TABLE_TEST_WRITES",
  "SDE_ENABLE_ACTION_CONTRACT_TESTS"
];

function getServerNoteGuardFailure(options){
  const env = options.env || process.env;
  if(!isFlagEnabled(env, "SDE_ENABLE_SERVER_NOTE_ACTIONS")){
    return {
      error: "server_note_actions_disabled",
      message: "Server note actions are disabled. Set SDE_ENABLE_SERVER_NOTE_ACTIONS=1 to enable this endpoint."
    };
  }

  return getServerNoteEnvironmentGuardFailure(options);
}

function getServerNoteEnvironmentGuardFailure(options){
  const env = options.env || process.env;
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(isFlagEnabled(env, "SDE_ENABLE_OPERATIONAL_WRITES")){
    return {
      error: "server_note_actions_operational_writes_forbidden",
      message: "Server note actions must not be enabled with SDE_ENABLE_OPERATIONAL_WRITES=1."
    };
  }

  const conflictingFlag = CONFLICTING_SERVER_NOTE_FLAGS.find(flag => isFlagEnabled(env, flag));
  if(conflictingFlag){
    return {
      error: "server_note_actions_conflicting_flag",
      message: `Server note actions must not be combined with ${conflictingFlag}=1.`,
      flag: conflictingFlag
    };
  }

  if(isFlagEnabled(env, "SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS")){
    return getProductionServerNoteGuardFailure({ port, databasePath });
  }

  return getTestServerNoteGuardFailure({ env, port, databasePath });
}

function getProductionServerNoteGuardFailure(options){
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(port !== PRODUCTION_PORT || !isProductionDatabasePath(databasePath)){
    return {
      error: "server_note_actions_production_target_required",
      message: "Production server note actions require production port 8787 and the production database."
    };
  }

  return null;
}

function getTestServerNoteGuardFailure(options){
  const env = options.env || process.env;
  const port = Number(options.port);
  const databasePath = options.databasePath;

  if(port === PRODUCTION_PORT){
    return {
      error: "server_note_actions_production_port",
      message: "Server note actions cannot run on production port 8787 in this phase."
    };
  }

  if(!env.SDE_SERVER_DB_PATH){
    return {
      error: "server_note_actions_db_path_required",
      message: "Server note actions require an explicit non-production SDE_SERVER_DB_PATH."
    };
  }

  if(isProductionDatabasePath(databasePath)){
    return {
      error: "server_note_actions_production_database",
      message: "Server note actions cannot use the production database in this phase."
    };
  }

  if(!isTmpDatabasePath(databasePath)){
    return {
      error: "server_note_actions_tmp_database_required",
      message: "Server note actions require a /tmp test database in this phase."
    };
  }

  return null;
}

function getServerNoteStatus(env = process.env){
  const serverNoteActionsEnabled = isFlagEnabled(env, "SDE_ENABLE_SERVER_NOTE_ACTIONS");
  return {
    serverNoteActionsEnabled,
    serverNoteProductionActionsEnabled: serverNoteActionsEnabled &&
      isFlagEnabled(env, "SDE_ENABLE_PRODUCTION_SERVER_NOTE_ACTIONS")
  };
}

function isFlagEnabled(env, flagName){
  return env[flagName] === "1";
}

function isProductionDatabasePath(databasePath){
  if(typeof databasePath !== "string" || !databasePath){
    return false;
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedProductionPath = path.resolve(PRODUCTION_DB_PATH);
  if(resolvedDatabasePath === resolvedProductionPath){
    return true;
  }

  try{
    if(fs.existsSync(resolvedDatabasePath) && fs.existsSync(resolvedProductionPath)){
      return fs.realpathSync(resolvedDatabasePath) === fs.realpathSync(resolvedProductionPath);
    }
  }catch(_error){
    return false;
  }

  return false;
}

function isTmpDatabasePath(databasePath){
  if(typeof databasePath !== "string" || !databasePath){
    return false;
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  return resolvedDatabasePath.startsWith("/tmp/") ||
    resolvedDatabasePath.startsWith("/private/tmp/");
}

module.exports = {
  PRODUCTION_DB_PATH,
  PRODUCTION_PORT,
  getServerNoteEnvironmentGuardFailure,
  getServerNoteGuardFailure,
  getServerNoteStatus,
  isProductionDatabasePath,
  isTmpDatabasePath
};
