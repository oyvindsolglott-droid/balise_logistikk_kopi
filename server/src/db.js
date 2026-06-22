const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createSchemaSql, initialState } = require("./schema");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "sde-server.sqlite3");

function getDatabasePath(){
  return process.env.SDE_SERVER_DB_PATH || DEFAULT_DB_PATH;
}

function openDatabase(){
  const databasePath = getDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(createSchemaSql());
  ensureMainState(db);

  return { db, databasePath };
}

function ensureMainState(db){
  const existing = db.prepare("SELECT id FROM app_state WHERE id = ?").get("main");
  if(existing) return;

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_state (id, revision, state_json, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?)
  `).run("main", 1, JSON.stringify(initialState()), now, "server-bootstrap");
}

module.exports = {
  openDatabase
};
