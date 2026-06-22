function createSchemaSql(){
  return `
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actor TEXT,
      device_id TEXT,
      created_at TEXT NOT NULL,
      previous_revision INTEGER
    );

    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      key TEXT PRIMARY KEY,
      mode TEXT,
      date TEXT,
      generated_at TEXT,
      payload_json TEXT,
      updated_at TEXT
    );
  `;
}

function initialState(){
  return {
    schemaVersion: 1,
    source: "server-initial",
    operationalState: {},
    notes: "Initial server state. PWA is not connected yet."
  };
}

module.exports = {
  createSchemaSql,
  initialState
};
