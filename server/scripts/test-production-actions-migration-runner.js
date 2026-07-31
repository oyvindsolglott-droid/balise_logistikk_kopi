#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { PRODUCTION_DB_PATH } = require("../src/actionsMigration");
const {
  inspectReadOnlyDatabase,
  isTmpDatabasePath,
  runVerifiedActionsMigration
} = require("./productionActionsMigrationRunnerCore");

function main(){
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const tmpDb = `/tmp/sde-b13h-runner-test-${stamp}.sqlite3`;

  assertTmpTarget(tmpDb);
  assertProductionDbRejected();

  createPreMigrationFixture(tmpDb);
  const before = inspectReadOnlyDatabase(tmpDb);
  assertPreMigrationCopy(before);

  const firstRun = runVerifiedActionsMigration({
    targetDb: tmpDb,
    allowProductionDatabase: false,
    label: "B13H first /tmp runner test"
  });
  assertPostMigrationCopy(firstRun.after);

  const secondRun = runVerifiedActionsMigration({
    targetDb: tmpDb,
    allowProductionDatabase: false,
    label: "B13H idempotency /tmp runner test"
  });
  assertIdempotentSecondRun(secondRun);

  console.log(`tmpDb: ${tmpDb}`);
  console.log("preMigrationFixture: ok");
  console.log("precheck: ok");
  console.log(`firstRun: ok changed=${firstRun.changed}`);
  console.log(`idempotencyRun: ok changed=${secondRun.changed}`);
  console.log("productionDbRejected: ok");
  console.log("result: PASS_B13H_PRODUCTION_MIGRATION_RUNNER_TEST");
}

function createPreMigrationFixture(targetDb){
  for(const file of [targetDb, `${targetDb}-shm`, `${targetDb}-wal`]){
    fs.rmSync(file, { force: true });
  }
  execFileSync("sqlite3", [
    targetDb,
    "PRAGMA user_version=0;"
  ], {
    stdio: "pipe"
  });
}

function assertTmpTarget(databasePath){
  if(!isTmpDatabasePath(databasePath)){
    throw new Error(`Test target must be under /tmp: ${databasePath}`);
  }

  if(path.resolve(databasePath) === path.resolve(PRODUCTION_DB_PATH)){
    throw new Error("Test target must never be the production database.");
  }
}

function assertProductionDbRejected(){
  try{
    assertTmpTarget(PRODUCTION_DB_PATH);
  }catch(_error){
    return;
  }

  throw new Error("Production DB unexpectedly passed /tmp test-target validation.");
}

function assertPreMigrationCopy(inspection){
  if(inspection.integrityCheck !== "ok"){
    throw new Error(`Expected pre-migration integrity ok, got ${inspection.integrityCheck}`);
  }

  if(inspection.userVersion !== 0){
    throw new Error(`Expected pre-migration user_version 0, got ${inspection.userVersion}`);
  }

  if(inspection.actionsExists){
    throw new Error("Expected no actions table before migration.");
  }
}

function assertPostMigrationCopy(inspection){
  if(inspection.integrityCheck !== "ok"){
    throw new Error(`Expected post-migration integrity ok, got ${inspection.integrityCheck}`);
  }

  if(inspection.userVersion !== 1){
    throw new Error(`Expected post-migration user_version 1, got ${inspection.userVersion}`);
  }

  if(!inspection.actionsExists){
    throw new Error("Expected actions table after migration.");
  }

  if(inspection.actionsTableInfo.length !== 13){
    throw new Error(`Expected 13 actions columns, got ${inspection.actionsTableInfo.length}`);
  }
}

function assertIdempotentSecondRun(result){
  assertPostMigrationCopy(result.after);

  if(result.changed){
    throw new Error("Expected second migration run to be idempotent/no-op.");
  }

  const actionsTableCount = result.after.tables.filter(table => table === "actions").length;
  if(actionsTableCount !== 1){
    throw new Error(`Expected exactly one actions table, got ${actionsTableCount}`);
  }
}

try{
  main();
}catch(error){
  console.error("B13H production migration runner test failed");
  console.error(error);
  process.exitCode = 1;
}
