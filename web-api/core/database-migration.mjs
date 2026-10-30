import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.mjs";
import { closeDatabase } from "./database.mjs";
import { readBody } from "./http.mjs";
import { readLimited, validatePackage } from "../services/cloud-sync.mjs";
import { callDatabaseRestore, consumeRestore, rememberRestore } from "../services/database-restore.mjs";
import { closeAuthenticatorBridge } from "../services/authenticator.mjs";

export async function handleDatabaseMigrationRoutes(req, res, url, send, exclusive) {
  const action = url.pathname.slice("/api/database-import/".length);
  if (!url.pathname.startsWith("/api/database-import/") || req.method !== "POST" || !["preview", "catalog", "plan", "confirm", "cancel"].includes(action)) return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (action === "catalog") {
      send(res, 200, await callDatabaseRestore({ op: "catalog" }));
    } else if (action === "preview") {
      const password = decodeURIComponent(String(req.headers["x-backup-password"] || ""));
      if (Buffer.byteLength(password) > 1024) throw new Error("备份密码过长");
      const bytes = await readLimited(req);
      validatePackage(bytes);
      const packagePath = path.join(dataDir, `.browser-backup-${crypto.randomUUID()}.chdb`);
      let preview;
      try {
        await fs.writeFile(packagePath, bytes, { flag: "wx", mode: 0o600 });
        preview = await callDatabaseRestore({ op: "preview", path: packagePath, password });
      } finally { await fs.rm(packagePath, { force: true }); }
      rememberRestore(preview.token);
      send(res, 200, preview);
    } else {
      const body = JSON.parse(await readBody(req, 16 * 1024));
      if (!body || typeof body.token !== "string" || !/^[a-f0-9-]{36}$/.test(body.token)) throw new Error("恢复参数无效");
      if (action === "cancel") {
        consumeRestore(body.token);
        send(res, 200, await callDatabaseRestore({ op: "cancel", token: body.token }));
      } else if (action === "plan") {
        if (!Array.isArray(body.tables) || !body.tables.length || body.tables.length > 32 || body.tables.some(table => typeof table !== "string" || !/^[a-z_]+$/.test(table)) || !["replace", "merge", "overwrite"].includes(body.mode) || typeof body.includeTrash !== "boolean") throw new Error("恢复参数无效");
        send(res, 200, await callDatabaseRestore({ op: "plan", token: body.token, tables: body.tables, mode: body.mode, includeTrash: body.includeTrash }));
      } else {
        if (!Array.isArray(body.tables) || !body.tables.length || body.tables.length > 32 || body.tables.some(table => typeof table !== "string" || !/^[a-z_]+$/.test(table)) || !["replace", "merge", "overwrite"].includes(body.mode) || typeof body.forceRestore !== "boolean") throw new Error("恢复范围或方式无效");
        await exclusive?.enter?.();
        let message;
        try {
          consumeRestore(body.token);
          closeAuthenticatorBridge(); closeDatabase();
          message = await callDatabaseRestore({ op: "confirm", token: body.token, tables: body.tables, mode: body.mode, forceRestore: body.forceRestore });
        } finally {
          await callDatabaseRestore({ op: "cancel", token: body.token }).catch(() => {});
          exclusive?.leave?.();
        }
        send(res, 200, message);
      }
    }
  } catch {
    // Never expose source rows, paths, parser errors, or SQLite diagnostics.
    send(res, 400, { error: action === "catalog" ? "读取数据范围失败，请更新本机调试程序后重试。" : "备份预览或恢复失败，请检查备份密码、文件格式与恢复范围；失败后请重新下载。" });
  }
  return true;
}
