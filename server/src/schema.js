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

    CREATE TABLE IF NOT EXISTS shared_sporplan_draft (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      audit_json TEXT
    );

    CREATE TABLE IF NOT EXISTS night_plans (
      plan_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      plan_date TEXT NOT NULL,
      signature TEXT NOT NULL,
      ds TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      image_id TEXT,
      final_form_sha256 TEXT NOT NULL,
      operational_authority INTEGER NOT NULL DEFAULT 0 CHECK (operational_authority = 0)
    );

    CREATE TABLE IF NOT EXISTS night_plan_images (
      image_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_provenance (
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      ocr_engine TEXT,
      ocr_version TEXT,
      source_image_sha256 TEXT,
      imported_at TEXT,
      human_corrected INTEGER NOT NULL,
      mapping_status TEXT,
      mapping_report_json TEXT,
      saved_at TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      final_form_sha256 TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      PRIMARY KEY(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_learning_records (
      learning_record_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      final_form_sha256 TEXT NOT NULL,
      source_image_sha256 TEXT,
      learning_status TEXT NOT NULL,
      learning_source TEXT NOT NULL,
      canonical_form_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model_version TEXT,
      pipeline_version TEXT,
      recognizer_result_json TEXT,
      human_ground_truth_json TEXT,
      schema_version TEXT NOT NULL,
      UNIQUE(plan_id, plan_revision)
    );

    CREATE TABLE IF NOT EXISTS night_plan_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS night_plan_images_plan_idx
      ON night_plan_images(plan_id, plan_revision);
    CREATE INDEX IF NOT EXISTS night_plan_learning_plan_idx
      ON night_plan_learning_records(plan_id, plan_revision);
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
