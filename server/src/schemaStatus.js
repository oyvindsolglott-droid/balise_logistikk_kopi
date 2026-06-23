const ACTIONS_SCHEMA_VERSION = 1;

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

function getSchemaStatus(db){
  try{
    const schemaUserVersion = getUserVersion(db);
    const actionsColumns = getActionsTableInfo(db);
    const actionsTablePresent = actionsColumns.length > 0;
    const actionsIndexes = actionsTablePresent ? getActionsIndexList(db) : [];
    const actionsSchemaReady = actionsTablePresent && isExpectedActionsSchema(actionsColumns, actionsIndexes);

    return {
      schemaUserVersion,
      actionsTablePresent,
      actionsSchemaReady,
      migrationRequired: !actionsSchemaReady,
      migrationsEnabled: false
    };
  }catch(_error){
    return {
      schemaUserVersion: null,
      actionsTablePresent: false,
      actionsSchemaReady: false,
      migrationRequired: true,
      migrationsEnabled: false,
      schemaStatusError: "schema_status_unavailable"
    };
  }
}

function getUserVersion(db){
  const row = db.prepare("PRAGMA user_version;").get();
  return Number(row.user_version) || 0;
}

function getActionsTableInfo(db){
  return db.prepare("PRAGMA table_info(actions);").all().map(row => ({
    name: row.name,
    type: normalizeType(row.type),
    notnull: Number(row.notnull),
    pk: Number(row.pk)
  }));
}

function getActionsIndexList(db){
  return db.prepare("PRAGMA index_list(actions);").all().map(row => ({
    unique: Number(row.unique),
    origin: row.origin
  }));
}

function isExpectedActionsSchema(columns, indexes){
  if(columns.length !== EXPECTED_ACTIONS_COLUMNS.length){
    return false;
  }

  for(let index = 0; index < EXPECTED_ACTIONS_COLUMNS.length; index += 1){
    const expected = EXPECTED_ACTIONS_COLUMNS[index];
    const actual = columns[index];
    if(!actual || actual.name !== expected.name){
      return false;
    }

    if(actual.type !== expected.type){
      return false;
    }

    if(typeof expected.notnull === "number" && actual.notnull !== expected.notnull){
      return false;
    }

    if(actual.pk !== expected.pk){
      return false;
    }
  }

  return indexes.some(index => index.unique === 1 && index.origin === "pk");
}

function normalizeType(type){
  return String(type || "").trim().toUpperCase();
}

module.exports = {
  ACTIONS_SCHEMA_VERSION,
  getSchemaStatus
};
