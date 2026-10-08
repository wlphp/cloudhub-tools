import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createReadStream, promises as fsp } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath, ensureDataDir, keyPath } from "./paths.mjs";
import { closeDatabase } from "./database.mjs";

const MAGIC = Buffer.from("CHDBMIG1");
const FORMAT = "cloudhub-tools-database-migration";
const VERSION = 1;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;
const REQUIRED_TABLES = ["cloud_accounts", "cloud_assets", "ssh_connections", "rdp_connections", "managed_hosts", "panel_connections", "operation_logs", "api_logs", "client_preferences"];
const LABELS = [["cloud_accounts", "云账号"], ["cloud_assets", "云资产"], ["ssh_connections", "SSH 连接"], ["rdp_connections", "RDP 连接"], ["managed_hosts", "托管主机"], ["panel_connections", "面板连接"], ["operation_logs", "操作日志"], ["api_logs", "API 日志"], ["client_preferences", "客户端设置"]];
const preparedImports = new Map();

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function sha256File(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail("迁移包内容不完整");
  return buffer;
}

function resetImportedSyncIdentity(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has("sync_local_device")) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sync_outbox_acknowledgements", "sync_inbox", "sync_entity_versions", "sync_devices", "sync_outbox", "sync_tombstones", "sync_local_versions"]) {
        if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
      }
      const columns = new Set(db.prepare("PRAGMA table_info(sync_local_device)").all().map((column) => column.name));
      const assignments = ["device_id=?", "device_name='本机'", "created_at=?"];
      if (columns.has("public_key")) assignments.push("public_key=NULL");
      db.prepare(`UPDATE sync_local_device SET ${assignments.join(",")} WHERE id=1`).run(crypto.randomUUID(), Date.now());
      if (tables.has("client_preferences")) db.prepare("DELETE FROM client_preferences WHERE key='sync.identity.signing_seed'").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

function validateDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") fail("导入数据库完整性校验失败");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missing = REQUIRED_TABLES.find((table) => !tables.has(table));
    if (missing) fail(`导入数据库缺少必要数据表: ${missing}`);
  } finally { db.close(); }
}

function buildPreview(databasePath, packageName, exportedAt, token) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const categories = LABELS.map(([table, label]) => ({ label, count: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) }));
    return {
      token,
      packageName,
      exportedAt: typeof exportedAt === "string" ? exportedAt : "未知",
      totalRecords: categories.reduce((total, item) => total + item.count, 0),
      categories,
      details: [],
      conflicts: [],
    };
  } finally { db.close(); }
}

async function parsePackage(packagePath, databasePath) {
  const stat = await fsp.stat(packagePath);
  if (stat.size > MAX_PACKAGE_BYTES || stat.size < 20) fail("迁移包格式无效或超过 4 GB 限制");
  const handle = await fsp.open(packagePath, "r");
  try {
    const magic = await readExact(handle, 8, 0);
    if (!magic.equals(MAGIC)) fail("文件格式无效，请选择电脑导出的 .chdb 备份");
    const manifestLength = (await readExact(handle, 4, 8)).readUInt32LE(0);
    if (!manifestLength || manifestLength > 1024 * 1024) fail("迁移包信息长度无效");
    const manifestStart = 12;
    const manifest = JSON.parse((await readExact(handle, manifestLength, manifestStart)).toString("utf8"));
    if (manifest?.format !== FORMAT || manifest?.version !== VERSION) fail("不支持的迁移包版本");
    let offset = manifestStart + manifestLength;
    const databaseLength = Number((await readExact(handle, 8, offset)).readBigUInt64LE(0));
    offset += 8;
    const keyLength = (await readExact(handle, 4, offset)).readUInt32LE(0);
    offset += 4;
    if (!Number.isSafeInteger(databaseLength) || databaseLength <= 0 || keyLength !== 32 || offset + databaseLength + keyLength !== stat.size) fail("迁移包长度无效或内容不完整");
    const databaseStart = offset;
    const keyStart = databaseStart + databaseLength;
    const key = await readExact(handle, keyLength, keyStart);
    const [databaseHash, keyHash] = await Promise.all([
      sha256File(packagePath, databaseStart, keyStart - 1),
      Promise.resolve(crypto.createHash("sha256").update(key).digest("hex")),
    ]);
    if (databaseHash !== manifest.database_sha256 || keyHash !== manifest.key_sha256) fail("迁移包校验失败，文件可能已损坏或被篡改");
    await pipeline(createReadStream(packagePath, { start: databaseStart, end: keyStart - 1 }), fs.createWriteStream(databasePath, { flags: "wx" }));
    validateDatabase(databasePath);
    resetImportedSyncIdentity(databasePath);
    validateDatabase(databasePath);
    return { key, manifest };
  } finally { await handle.close(); }
}

async function writeRequestFile(req, targetPath) {
  let total = 0;
  const output = fs.createWriteStream(targetPath, { flags: "wx" });
  try {
    await pipeline(req, new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_PACKAGE_BYTES) callback(Object.assign(new Error("迁移包超过 4 GB 限制"), { statusCode: 413 }));
      else callback(null, chunk);
    } }), output);
    if (total < 20) fail("迁移包格式无效");
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [token, item] of preparedImports) {
    if (item.expiresAt > now) continue;
    preparedImports.delete(token);
    clearTimeout(item.timer);
    void fsp.rm(item.databasePath, { force: true });
  }
}

async function prepareImport(req, url) {
  ensureDataDir();
  cleanupExpired();
  const token = crypto.randomUUID();
  const packagePath = path.join(dataDir, `.mobile-import-package-${token}.chdb`);
  const databasePath = path.join(dataDir, `.mobile-import-preview-${token}.sqlite3`);
  try {
    await writeRequestFile(req, packagePath);
    const { key, manifest } = await parsePackage(packagePath, databasePath);
    const filename = String(url.searchParams.get("name") || "cloudhub-tools-backup.chdb").replace(/[\\/\0]/g, "_").slice(0, 160);
    const preview = buildPreview(databasePath, filename || "cloudhub-tools-backup.chdb", manifest.exported_at || "未知", token);
    const prepared = { databasePath, key, expiresAt: Date.now() + 10 * 60 * 1000, timer: undefined };
    prepared.timer = setTimeout(() => {
      if (preparedImports.get(token) !== prepared) return;
      preparedImports.delete(token);
      void fsp.rm(databasePath, { force: true });
    }, 10 * 60 * 1000);
    prepared.timer.unref?.();
    preparedImports.set(token, prepared);
    return preview;
  } catch (error) {
    await fsp.rm(databasePath, { force: true });
    throw error;
  } finally { await fsp.rm(packagePath, { force: true }); }
}

async function confirmImport(token, exclusive) {
  cleanupExpired();
  const prepared = preparedImports.get(token);
  if (!prepared) fail("导入预览已失效，请重新选择文件", 409);
  validateDatabase(prepared.databasePath);
  await exclusive?.enter?.();
  try {
    closeDatabase();
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const suffix = crypto.randomUUID().slice(0, 8);
    const backupDb = path.join(dataDir, `cloudhub_tools.sqlite3.before-import-${stamp}-${suffix}`);
    const backupKey = path.join(dataDir, `.key.before-import-${stamp}-${suffix}`);
    const stagedKey = path.join(dataDir, `.mobile-import-key-${crypto.randomUUID()}`);
    let databaseBackedUp = false;
    let keyBackedUp = false;
    let importedInstalled = false;
    try {
      await fsp.writeFile(stagedKey, prepared.key, { flag: "wx", mode: 0o600 });
      try { await fsp.rename(dbPath, backupDb); databaseBackedUp = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fsp.rename(prepared.databasePath, dbPath);
      importedInstalled = true;
      try { await fsp.rename(keyPath, backupKey); keyBackedUp = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fsp.rename(stagedKey, keyPath);
      preparedImports.delete(token);
      clearTimeout(prepared.timer);
      return "已导入电脑备份，手机原数据已保留为导入前备份。";
    } catch (error) {
      if (importedInstalled) await fsp.rm(dbPath, { force: true });
      if (databaseBackedUp) await fsp.rename(backupDb, dbPath).catch(() => undefined);
      if (keyBackedUp) await fsp.rename(backupKey, keyPath).catch(() => undefined);
      throw error;
    } finally {
      await fsp.rm(stagedKey, { force: true });
    }
  } finally {
    exclusive?.leave?.();
    await fsp.rm(prepared.databasePath, { force: true });
    clearTimeout(prepared.timer);
    preparedImports.delete(token);
  }
}

export async function handleDatabaseMigrationRoutes(req, res, url, send, exclusive) {
  if (req.method === "POST" && url.pathname === "/api/database-import/preview") {
    const preview = await prepareImport(req, url);
    send(res, 200, preview);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/database-import/confirm") {
    const body = JSON.parse(await readRequestBody(req));
    const message = await confirmImport(String(body.token || ""), exclusive);
    send(res, 200, { message });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/database-import/cancel") {
    const body = JSON.parse(await readRequestBody(req));
    const prepared = preparedImports.get(String(body.token || ""));
    if (prepared) {
      preparedImports.delete(String(body.token));
      clearTimeout(prepared.timer);
      await fsp.rm(prepared.databasePath, { force: true });
    }
    send(res, 200, {});
    return true;
  }
  return false;
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 16 * 1024) fail("请求参数过大", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

process.once("exit", () => {
  for (const item of preparedImports.values()) {
    clearTimeout(item.timer);
    try { fs.rmSync(item.databasePath, { force: true }); } catch { /* Process is exiting. */ }
  }
});
