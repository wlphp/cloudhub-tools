import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
const dataDir = path.join(localAppData, "CloudHubTools");
const legacyDataDir = path.join(localAppData, "AliyunTools");
const dbPath = path.join(dataDir, "cloudhub_tools.sqlite3");
const keyPath = path.join(dataDir, ".key");
let sharedDatabase;

function migrateLegacyData() {
  if (fs.existsSync(dataDir) || !fs.existsSync(legacyDataDir)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [legacyName, currentName] of [["aliyun_tools.sqlite3", "cloudhub_tools.sqlite3"], [".key", ".key"]]) {
    const source = path.join(legacyDataDir, legacyName);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dataDir, currentName));
  }
}

migrateLegacyData();
fs.mkdirSync(dataDir, { recursive: true });

export function database() {
  if (sharedDatabase) return sharedDatabase;
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
  sharedDatabase = db;
  return sharedDatabase;
}

process.once("exit", () => {
  sharedDatabase?.close();
});

export function writeApiLog(accountId, endpoint, action, request, response, status, message = null) {
  const db = database();
  db.prepare("INSERT INTO api_logs(account_id,endpoint,action,request_params,response_params,status,message,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(accountId, endpoint, action, JSON.stringify(request || {}), response == null ? null : JSON.stringify(response), status, message, Date.now());
}

export function decryptSecret(ciphertext) {
  const packed = Buffer.from(ciphertext, "base64");
  const key = fs.readFileSync(keyPath);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(packed.length - 16));
  return Buffer.concat([decipher.update(packed.subarray(12, packed.length - 16)), decipher.final()]).toString("utf8");
}

export function encryptSecret(secret) {
  const key = fs.readFileSync(keyPath);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64");
}
