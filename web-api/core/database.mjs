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
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC)");
  sharedDatabase = db;
  return sharedDatabase;
}

export function writeApiLog(accountId, endpoint, action, request, response, status, message = null) {
  database().prepare("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(accountId, endpoint, action, serializeLogValue(request), response == null ? null : serializeLogValue(response), status, message, Date.now());
  pruneLogs(database());
}

process.once("exit", () => {
  sharedDatabase?.close();
});
