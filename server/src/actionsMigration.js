const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ACTIONS_SCHEMA_VERSION = 1;
const PRODUCTION_DB_PATH = "/Users/solglottsr/balise_logistikk_kopi/server/data/sde-server.sqlite3";

const ACTIONS_TABLE_SQL = `
CREATE TABLE actions (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  device_id TEXT,
  expected_revision INTEGER,
  request_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  resulting_revision INTEGER,
  event_id INTEGER,
  server_created_at TEXT NOT NULL,
  completed_at TEXT
);
`;

const EXPECTED_ACTIONS_COLUMNS = [
  { name: "action_id", type: "TEXT", pk: 1 },
  { name: "action_type", type: "TEXT", notnull: 1, pk: 0 },
  { name: "actor_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "actor_role", type: "TEXT", notnull: 0, pk: 0 },
  { name: "device_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "expected_revision", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "request_json", type: "TEXT", notnull: 1, pk: 0 },
  { name: "payload_hash", type: "TEXT", notnull: 1, pk: 0 },
  { name: "status", type: "TEXT", notnull: 1, pk: 0 },
  { name: "resulting_revision", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "event_id", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "server_created_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "completed_at", type: "TEXT", notnull: 0, pk: 0 }
];

class MigrationError extends Error{
  constructor(code, message, details = {}){
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

function openMigrationDatabase(databasePath, options = {}){
  assertSafeMigrationDatabasePath(databasePath, options);
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  return new DatabaseSync(databasePath);
}

function migrateActionsSchema(db, { databasePath, allowProductionDatabase = false } = {}){
  assertSafeMigrationDatabasePath(databasePath, { allowProductionDatabase });

  const precheck = inspectDatabase(db);
  ensureIntegrityOk(precheck);
  ensureSupportedUserVersion(precheck);

  let changed = false;
  db.exec("BEGIN IMMEDIATE TRANSACTION;");

  try{
    const current = inspectDatabase(db);
    const schemaCheck = validateActionsSchema(current);

    if(!current.actionsExists){
      db.exec(ACTIONS_TABLE_SQL);
      setUserVersion(db, ACTIONS_SCHEMA_VERSION);
      changed = true;
    }else if(schemaCheck.ok){
      if(current.userVersion < ACTIONS_SCHEMA_VERSION){
        setUserVersion(db, ACTIONS_SCHEMA_VERSION);
        changed = true;
      }
    }else{
      throw new MigrationError(
        "unexpected_actions_schema",
        "Existing actions table does not match expected schema.",
        { problems: schemaCheck.problems }
      );
    }

    db.exec("COMMIT;");
  }catch(error){
    rollbackQuietly(db);
    throw error;
  }

  const postcheck = inspectDatabase(db);
  ensureIntegrityOk(postcheck);

  if(postcheck.userVersion !== ACTIONS_SCHEMA_VERSION){
    throw new MigrationError(
      "unexpected_user_version",
      `Expected PRAGMA user_version ${ACTIONS_SCHEMA_VERSION}.`,
      { userVersion: postcheck.userVersion }
    );
  }

  const postSchemaCheck = validateActionsSchema(postcheck);
  if(!postSchemaCheck.ok){
    throw new MigrationError(
      "unexpected_actions_schema",
      "Post-migration actions schema does not match expected schema.",
      { problems: postSchemaCheck.problems }
    );
  }

  return {
    ok: true,
    changed,
    precheck,
    postcheck
  };
}

function inspectDatabase(db){
  const integrityRow = db.prepare("PRAGMA integrity_check;").get();
  const userVersionRow = db.prepare("PRAGMA user_version;").get();
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `).all().map(row => row.name);
  const actionsExists = tables.includes("actions");

  return {
    integrityCheck: integrityRow.integrity_check,
    userVersion: Number(userVersionRow.user_version) || 0,
    tables,
    actionsExists,
    actionsTableInfo: actionsExists ? getActionsTableInfo(db) : [],
    actionsIndexList: actionsExists ? getActionsIndexList(db) : []
  };
}

function validateActionsSchema(inspection){
  const problems = [];

  if(!inspection.actionsExists){
    return {
      ok: false,
      problems: ["actions table is missing"]
    };
  }

  const columns = inspection.actionsTableInfo;
  if(columns.length !== EXPECTED_ACTIONS_COLUMNS.length){
    problems.push(`expected ${EXPECTED_ACTIONS_COLUMNS.length} columns, found ${columns.length}`);
  }

  for(let index = 0; index < EXPECTED_ACTIONS_COLUMNS.length; index += 1){
    const expected = EXPECTED_ACTIONS_COLUMNS[index];
    const actual = columns[index];
    if(!actual){
      problems.push(`missing column ${expected.name}`);
      continue;
    }

    if(actual.name !== expected.name){
      problems.push(`column ${index} expected ${expected.name}, found ${actual.name}`);
    }

    if(normalizeType(actual.type) !== expected.type){
      problems.push(`column ${expected.name} expected type ${expected.type}, found ${actual.type}`);
    }

    if(typeof expected.notnull === "number" && Number(actual.notnull) !== expected.notnull){
      problems.push(`column ${expected.name} expected notnull ${expected.notnull}, found ${actual.notnull}`);
    }

    if(Number(actual.pk) !== expected.pk){
      problems.push(`column ${expected.name} expected pk ${expected.pk}, found ${actual.pk}`);
    }
  }

  if(!hasPrimaryKeyIndexOnActionId(inspection.actionsIndexList)){
    problems.push("actions table is missing unique primary key index for action_id");
  }

  return {
    ok: problems.length === 0,
    problems
  };
}

function assertSafeMigrationDatabasePath(databasePath, { allowProductionDatabase = false } = {}){
  if(!databasePath || typeof databasePath !== "string"){
    throw new MigrationError(
      "database_path_required",
      "A databasePath string is required for actions migration."
    );
  }

  if(!allowProductionDatabase && isProductionDatabasePath(databasePath)){
    throw new MigrationError(
      "production_database_blocked",
      "Actions migration cannot run against the production database.",
      { databasePath }
    );
  }
}

function isProductionDatabasePath(databasePath){
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

function ensureIntegrityOk(inspection){
  if(inspection.integrityCheck !== "ok"){
    throw new MigrationError(
      "integrity_check_failed",
      "PRAGMA integrity_check did not return ok.",
      { integrityCheck: inspection.integrityCheck }
    );
  }
}

function ensureSupportedUserVersion(inspection){
  if(inspection.userVersion > ACTIONS_SCHEMA_VERSION){
    throw new MigrationError(
      "unsupported_user_version",
      `Database user_version ${inspection.userVersion} is newer than supported version ${ACTIONS_SCHEMA_VERSION}.`,
      { userVersion: inspection.userVersion }
    );
  }
}

function getActionsTableInfo(db){
  return db.prepare("PRAGMA table_info(actions);").all().map(row => ({
    cid: Number(row.cid),
    name: row.name,
    type: row.type,
    notnull: Number(row.notnull),
    dfltValue: row.dflt_value,
    pk: Number(row.pk)
  }));
}

function getActionsIndexList(db){
  return db.prepare("PRAGMA index_list(actions);").all().map(row => ({
    seq: Number(row.seq),
    name: row.name,
    unique: Number(row.unique),
    origin: row.origin,
    partial: Number(row.partial)
  }));
}

function hasPrimaryKeyIndexOnActionId(indexList){
  return indexList.some(index => index.unique === 1 && index.origin === "pk");
}

function setUserVersion(db, version){
  db.exec(`PRAGMA user_version = ${Number(version)};`);
}

function normalizeType(type){
  return String(type || "").trim().toUpperCase();
}

function rollbackQuietly(db){
  try{
    db.exec("ROLLBACK;");
  }catch(_error){
    // Preserve the original migration error.
  }
}

module.exports = {
  ACTIONS_SCHEMA_VERSION,
  ACTIONS_TABLE_SQL,
  EXPECTED_ACTIONS_COLUMNS,
  MigrationError,
  PRODUCTION_DB_PATH,
  assertSafeMigrationDatabasePath,
  inspectDatabase,
  migrateActionsSchema,
  openMigrationDatabase,
  validateActionsSchema
};
