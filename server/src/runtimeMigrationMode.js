const fs = require("node:fs");
const path = require("node:path");
const { migrateActionsSchema, PRODUCTION_DB_PATH } = require("./actionsMigration");

const EXPECTED_SERVER_CWD = "/Users/solglottsr/balise_logistikk_kopi/server";
const SCHEMA_MIGRATIONS_FLAG = "SDE_ENABLE_SCHEMA_MIGRATIONS";

class RuntimeMigrationModeError extends Error{
  constructor(code, message, details = {}){
    super(message);
    this.name = "RuntimeMigrationModeError";
    this.code = code;
    this.details = details;
  }
}

function prepareRuntimeMigrationMode({
  port,
  rawPort,
  databasePath,
  cwd = process.cwd(),
  env = process.env
} = {}){
  const migrationsEnabled = env[SCHEMA_MIGRATIONS_FLAG] === "1";
  const mode = {
    migrationsEnabled,
    migrationRun: false,
    migrationChanged: false
  };

  if(!migrationsEnabled){
    return mode;
  }

  const guardFailure = getRuntimeMigrationGuardFailure({
    port,
    rawPort,
    databasePath,
    cwd,
    env
  });

  if(guardFailure){
    throw new RuntimeMigrationModeError(
      guardFailure.error,
      guardFailure.message,
      guardFailure.details
    );
  }

  return mode;
}

function runRuntimeMigrationIfEnabled(db, { mode, databasePath }){
  if(!mode?.migrationsEnabled){
    return mode || {
      migrationsEnabled: false,
      migrationRun: false,
      migrationChanged: false
    };
  }

  const migration = migrateActionsSchema(db, { databasePath });
  return {
    ...mode,
    migrationRun: true,
    migrationChanged: migration.changed
  };
}

function getRuntimeMigrationGuardFailure({ port, rawPort, databasePath, cwd, env }){
  const parsedPort = Number.parseInt(String(rawPort ?? ""), 10);

  if(rawPort === undefined || rawPort === ""){
    return guardFailure(
      "schema_migrations_port_required",
      "Runtime schema migration requires an explicit non-production PORT."
    );
  }

  if(!Number.isInteger(parsedPort) || parsedPort < 1){
    return guardFailure(
      "schema_migrations_invalid_port",
      "Runtime schema migration requires a valid numeric PORT.",
      { rawPort }
    );
  }

  if(parsedPort === 8787 || Number(port) === 8787){
    return guardFailure(
      "schema_migrations_production_port",
      "Runtime schema migration cannot run on production port 8787.",
      { port: parsedPort }
    );
  }

  if(!env.SDE_SERVER_DB_PATH){
    return guardFailure(
      "schema_migrations_db_path_required",
      "Runtime schema migration requires an explicit SDE_SERVER_DB_PATH."
    );
  }

  if(isProductionDatabasePath(databasePath)){
    return guardFailure(
      "schema_migrations_production_database",
      "Runtime schema migration cannot use the production database.",
      { databasePath }
    );
  }

  if(!isTmpDatabasePath(databasePath)){
    return guardFailure(
      "schema_migrations_tmp_database_required",
      "Runtime schema migration requires a database path under /tmp/.",
      { databasePath }
    );
  }

  if(path.resolve(cwd) !== EXPECTED_SERVER_CWD){
    return guardFailure(
      "schema_migrations_wrong_cwd",
      "Runtime schema migration must run from the approved server directory.",
      { cwd }
    );
  }

  if(env.SDE_ENABLE_TEST_WRITES === "1"){
    return guardFailure(
      "schema_migrations_test_writes_enabled",
      "Runtime schema migration must not run together with SDE_ENABLE_TEST_WRITES=1."
    );
  }

  if(env.SDE_ENABLE_ACTION_CONTRACT_TESTS === "1"){
    return guardFailure(
      "schema_migrations_action_contract_tests_enabled",
      "Runtime schema migration must not run together with SDE_ENABLE_ACTION_CONTRACT_TESTS=1."
    );
  }

  return null;
}

function guardFailure(error, message, details = {}){
  return {
    error,
    message,
    details
  };
}

function isTmpDatabasePath(databasePath){
  return typeof databasePath === "string" && path.resolve(databasePath).startsWith("/tmp/");
}

function isProductionDatabasePath(databasePath){
  const resolvedDatabasePath = path.resolve(databasePath || "");
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

module.exports = {
  RuntimeMigrationModeError,
  prepareRuntimeMigrationMode,
  runRuntimeMigrationIfEnabled
};
