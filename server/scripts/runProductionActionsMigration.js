#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  ACTIONS_SCHEMA_VERSION,
  PRODUCTION_DB_PATH,
  inspectDatabase,
  migrateActionsSchema,
  validateActionsSchema
} = require("../src/actionsMigration");

const REPO_ROOT = "/Users/solglottsr/balise_logistikk_kopi";
const SERVER_CWD = "/Users/solglottsr/balise_logistikk_kopi/server";
const ALLOW_FLAG = "SDE_ALLOW_PRODUCTION_SCHEMA_MIGRATION_ONCE";
const CONFIRM_DB_PATH_ENV = "SDE_CONFIRM_PRODUCTION_DB_PATH";
const BACKUP_PATH_ENV = "SDE_PRODUCTION_SCHEMA_BACKUP_PATH";

class ProductionMigrationRunnerError extends Error{
  constructor(code, message, details = {}){
    super(message);
    this.name = "ProductionMigrationRunnerError";
    this.code = code;
    this.details = details;
  }
}

function runProductionActionsMigration({ env = process.env, cwd = process.cwd() } = {}){
  const preflight = runPreflight({ env, cwd });

  console.log("production actions migration preflight ok");
  console.log(`targetDb=${preflight.targetDb}`);
  console.log(`backupPath=${preflight.backupPath}`);
  console.log(`currentUserVersion=${preflight.targetInspection.userVersion}`);
  console.log(`actionsTablePresent=${preflight.targetInspection.actionsExists}`);

  const db = new DatabaseSync(preflight.targetDb);
  try{
    const migration = migrateActionsSchema(db, {
      databasePath: preflight.targetDb,
      allowProductionDatabase: true
    });
    const finalInspection = inspectDatabase(db);
    const schemaCheck = validateActionsSchema(finalInspection);

    if(finalInspection.userVersion !== ACTIONS_SCHEMA_VERSION || !schemaCheck.ok){
      throw new ProductionMigrationRunnerError(
        "postcheck_failed",
        "Production actions migration postcheck failed.",
        {
          userVersion: finalInspection.userVersion,
          actionsSchemaProblems: schemaCheck.problems
        }
      );
    }

    console.log("production actions migration completed");
    console.log(`changed=${migration.changed}`);
    console.log(`finalUserVersion=${finalInspection.userVersion}`);
    console.log(`actionsTablePresent=${finalInspection.actionsExists}`);
    console.log(`actionsSchemaReady=${schemaCheck.ok}`);

    return {
      ok: true,
      changed: migration.changed,
      preflight,
      finalInspection
    };
  }finally{
    db.close();
  }
}

function runPreflight({ env = process.env, cwd = process.cwd() } = {}){
  assertCwd(cwd);
  assertEnvFlags(env);

  const targetDb = env.SDE_SERVER_DB_PATH;
  const confirmedDb = env[CONFIRM_DB_PATH_ENV];
  const backupPath = env[BACKUP_PATH_ENV];

  assertExactProductionPath(targetDb, "SDE_SERVER_DB_PATH");
  assertExactProductionPath(confirmedDb, CONFIRM_DB_PATH_ENV);
  assertBackupPath(backupPath);
  assertProductionServerStopped();

  const backupInspection = inspectReadOnlyDatabase(backupPath);
  if(backupInspection.integrityCheck !== "ok"){
    throw new ProductionMigrationRunnerError(
      "backup_integrity_failed",
      "Backup PRAGMA integrity_check did not return ok.",
      { integrityCheck: backupInspection.integrityCheck }
    );
  }

  if(backupInspection.userVersion !== 0 || backupInspection.actionsExists){
    throw new ProductionMigrationRunnerError(
      "backup_not_pre_migration_state",
      "Backup must represent the pre-migration production schema.",
      {
        userVersion: backupInspection.userVersion,
        actionsExists: backupInspection.actionsExists
      }
    );
  }

  const targetInspection = inspectReadOnlyDatabase(targetDb);
  if(targetInspection.integrityCheck !== "ok"){
    throw new ProductionMigrationRunnerError(
      "target_integrity_failed",
      "Target DB PRAGMA integrity_check did not return ok.",
      { integrityCheck: targetInspection.integrityCheck }
    );
  }

  if(targetInspection.userVersion !== 0){
    throw new ProductionMigrationRunnerError(
      "unexpected_target_user_version",
      "Production DB user_version must be 0 before actions migration.",
      { userVersion: targetInspection.userVersion }
    );
  }

  if(targetInspection.actionsExists){
    throw new ProductionMigrationRunnerError(
      "target_actions_table_exists",
      "Production DB already has an actions table."
    );
  }

  return {
    targetDb,
    backupPath: path.resolve(backupPath),
    backupInspection,
    targetInspection
  };
}

function assertCwd(cwd){
  if(path.resolve(cwd) !== SERVER_CWD){
    throw new ProductionMigrationRunnerError(
      "wrong_cwd",
      "Production migration runner must be started from the approved server directory.",
      { cwd }
    );
  }
}

function assertEnvFlags(env){
  if(env[ALLOW_FLAG] !== "1"){
    throw new ProductionMigrationRunnerError(
      "production_migration_flag_required",
      `Set ${ALLOW_FLAG}=1 to allow this one-shot runner.`
    );
  }

  if(env.SDE_ENABLE_SCHEMA_MIGRATIONS === "1"){
    throw new ProductionMigrationRunnerError(
      "runtime_migration_flag_forbidden",
      "Do not use SDE_ENABLE_SCHEMA_MIGRATIONS=1 with the production one-shot runner."
    );
  }

  if(env.SDE_ENABLE_TEST_WRITES === "1"){
    throw new ProductionMigrationRunnerError(
      "test_writes_flag_forbidden",
      "Production migration runner must not run with SDE_ENABLE_TEST_WRITES=1."
    );
  }

  if(env.SDE_ENABLE_ACTION_CONTRACT_TESTS === "1"){
    throw new ProductionMigrationRunnerError(
      "action_contract_tests_flag_forbidden",
      "Production migration runner must not run with SDE_ENABLE_ACTION_CONTRACT_TESTS=1."
    );
  }

  if(env.PORT){
    throw new ProductionMigrationRunnerError(
      "port_env_forbidden",
      "Production migration runner must not be run with PORT set."
    );
  }
}

function assertExactProductionPath(value, envName){
  if(!value){
    throw new ProductionMigrationRunnerError(
      "production_db_path_required",
      `${envName} must be set to the exact production database path.`
    );
  }

  if(path.resolve(value) !== path.resolve(PRODUCTION_DB_PATH)){
    throw new ProductionMigrationRunnerError(
      "production_db_path_mismatch",
      `${envName} must match the exact production database path.`,
      { [envName]: value, expected: PRODUCTION_DB_PATH }
    );
  }

  if(!fs.existsSync(value)){
    throw new ProductionMigrationRunnerError(
      "production_db_missing",
      "Production database does not exist.",
      { databasePath: value }
    );
  }
}

function assertBackupPath(backupPath){
  if(!backupPath){
    throw new ProductionMigrationRunnerError(
      "backup_path_required",
      `${BACKUP_PATH_ENV} must point to the fresh verified SQLite backup.`
    );
  }

  const resolvedBackupPath = path.resolve(backupPath);
  if(isPathInside(resolvedBackupPath, REPO_ROOT)){
    throw new ProductionMigrationRunnerError(
      "backup_inside_repo",
      "Backup path must be outside the repository.",
      { backupPath: resolvedBackupPath }
    );
  }

  if(!fs.existsSync(resolvedBackupPath) || !fs.statSync(resolvedBackupPath).isFile()){
    throw new ProductionMigrationRunnerError(
      "backup_missing",
      "Backup file does not exist.",
      { backupPath: resolvedBackupPath }
    );
  }
}

function assertProductionServerStopped(){
  const listener = getProductionListener();
  if(listener){
    throw new ProductionMigrationRunnerError(
      "production_server_running",
      "Production server must be stopped before production schema migration.",
      { listener }
    );
  }
}

function getProductionListener(){
  try{
    const output = execFileSync("lsof", [
      "-nP",
      "-iTCP:8787",
      "-sTCP:LISTEN"
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.trim() || null;
  }catch(error){
    if(error.status === 1){
      return null;
    }

    throw new ProductionMigrationRunnerError(
      "listener_check_failed",
      "Could not verify whether production port 8787 is listening.",
      { message: error.message }
    );
  }
}

function inspectReadOnlyDatabase(databasePath){
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try{
    return inspectDatabase(db);
  }finally{
    db.close();
  }
}

function isPathInside(childPath, parentPath){
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function main(){
  try{
    runProductionActionsMigration();
  }catch(error){
    if(error instanceof ProductionMigrationRunnerError){
      console.error(`production actions migration blocked: ${error.code}`);
      console.error(error.message);
      if(Object.keys(error.details).length > 0){
        console.error(JSON.stringify(error.details));
      }
      process.exitCode = 1;
      return;
    }

    console.error("production actions migration failed");
    console.error(error);
    process.exitCode = 1;
  }
}

if(require.main === module){
  main();
}

module.exports = {
  ALLOW_FLAG,
  BACKUP_PATH_ENV,
  CONFIRM_DB_PATH_ENV,
  ProductionMigrationRunnerError,
  runPreflight,
  runProductionActionsMigration
};
