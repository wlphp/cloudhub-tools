import { DatabaseSync } from "node:sqlite";
import { dbPath, ensureDataDir } from "./paths.mjs";
import { pruneLogs, serializeLogValue } from "./logging.mjs";

let sharedDatabase;

export function database() {
  if (sharedDatabase) return sharedDatabase;
  ensureDataDir();
  const db = new DatabaseSync(dbPath);
  try { db.exec("ALTER TABLE cloud_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
  try { db.exec("ALTER TABLE cloud_accounts ADD COLUMN credential_meta TEXT"); } catch { /* already migrated */ }
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_assets (
    account_id INTEGER NOT NULL, resource_type TEXT NOT NULL, asset_key TEXT NOT NULL,
    region_id TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, resource_type, asset_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, endpoint TEXT NOT NULL,
    action TEXT NOT NULL, request_params TEXT NOT NULL, response_params TEXT,
    status TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, action TEXT NOT NULL,
    result TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ai_profiles(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,base_url TEXT NOT NULL,
    model TEXT NOT NULL,models_json TEXT NOT NULL DEFAULT '[]',key_ciphertext TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,is_default INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 60,max_output_tokens INTEGER NOT NULL DEFAULT 2048,
    allow_loopback_http INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL
  )`);
  if (!db.prepare("PRAGMA table_info(ai_profiles)").all().some(column => column.name === "models_json")) db.exec("ALTER TABLE ai_profiles ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ai_one_default ON ai_profiles(is_default) WHERE is_default=1");
  db.exec(`CREATE TABLE IF NOT EXISTS ai_capabilities(
    profile_id TEXT PRIMARY KEY REFERENCES ai_profiles(id) ON DELETE CASCADE,
    config_revision INTEGER NOT NULL,vision_status TEXT NOT NULL CHECK(vision_status IN ('supported','unsupported')),
    checked_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC)");
  sharedDatabase = db;
  return sharedDatabase;
}

export function closeDatabase() {
  if (!sharedDatabase) return;
  sharedDatabase.close();
  sharedDatabase = undefined;
}

export function writeApiLog(accountId, endpoint, action, request, response, status, message = null) {
  database().prepare("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(accountId, endpoint, action, serializeLogValue(request), response == null ? null : serializeLogValue(response), status, message, Date.now());
  pruneLogs(database());
}

process.once("exit", () => {
  sharedDatabase?.close();
});
