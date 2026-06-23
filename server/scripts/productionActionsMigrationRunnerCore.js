const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  ACTIONS_SCHEMA_VERSION,
  assertSafeMigrationDatabasePath,
  inspectDatabase,
  migrateActionsSchema,
  validateActionsSchema
} = require("../src/actionsMigration");

function runVerifiedActionsMigration({
  targetDb,
  allowProductionDatabase = false,
  label = "actions migration"
}){
  assertSafeMigrationDatabasePath(targetDb, { allowProductionDatabase });

  const db = new DatabaseSync(targetDb);
  try{
    const before = inspectDatabase(db);
    const migration = migrateActionsSchema(db, {
      databasePath: targetDb,
      allowProductionDatabase
    });
    const after = inspectDatabase(db);
    const schemaCheck = validateActionsSchema(after);

    if(after.userVersion !== ACTIONS_SCHEMA_VERSION || !schemaCheck.ok){
      throw new Error(`${label} postcheck failed: ${JSON.stringify({
        userVersion: after.userVersion,
        actionsSchemaProblems: schemaCheck.problems
      })}`);
    }

    return {
      ok: true,
      changed: migration.changed,
      before,
      after,
      actionsSchemaReady: schemaCheck.ok
    };
  }finally{
    db.close();
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

function isTmpDatabasePath(databasePath){
  return typeof databasePath === "string" && path.resolve(databasePath).startsWith("/tmp/");
}

module.exports = {
  inspectReadOnlyDatabase,
  isPathInside,
  isTmpDatabasePath,
  runVerifiedActionsMigration
};
