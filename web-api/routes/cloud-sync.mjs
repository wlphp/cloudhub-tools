import { database } from "../core/database.mjs";
import { decryptSecret, encryptSecret } from "../core/crypto.mjs";
import { readBody, send } from "../core/http.mjs";
import { CloudSyncError, createCloudSyncChannels, previewConfigKey } from "../services/cloud-sync.mjs";
import { createBrowserCloudBackup } from "../services/database-restore.mjs";

const channels = createCloudSyncChannels({
  load() {
    const row = database().prepare("SELECT value FROM client_preferences WHERE key=?").get(previewConfigKey);
    if (!row) return null;
    return JSON.parse(decryptSecret(row.value));
  },
  persist(config) {
    database().prepare("INSERT INTO client_preferences(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(previewConfigKey, encryptSecret(JSON.stringify(config)), Date.now());
  },
});

export async function handleCloudSyncRoutes(req, res, url) {
  if (!url.pathname.startsWith("/api/cloud-sync/")) return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    const action = url.pathname.slice("/api/cloud-sync/".length);
    const channelId = url.searchParams.get("channelId") ?? "default";
    const service = channels.channel(channelId);
    if (req.method === "GET" && action === "channels") send(res, 200, channels.list());
    else if (req.method === "POST" && action === "delete") {
      await channels.run(() => channels.remove(channelId)); send(res, 200, null);
    }
    else if (req.method === "GET" && action === "state") send(res, 200, service.state());
    else if (req.method === "GET" && action === "versions") send(res, 200, await channels.run(() => service.versions()));
    else if (req.method === "POST" && action === "delete-version") {
      const body = JSON.parse(await readBody(req, 1024));
      if (!body || typeof body.versionId !== "string" || Object.keys(body).some(key => key !== "versionId")) throw new CloudSyncError("备份版本参数无效");
      await channels.run(() => service.deleteVersion(body.versionId)); send(res, 200, null);
    }
    else if (req.method === "POST" && ["save", "test", "reveal"].includes(action)) {
      const body = JSON.parse(await readBody(req, 32 * 1024));
      if ((body.config?.id ?? "default") !== channelId) throw new CloudSyncError("同步渠道不匹配");
      const result = await channels.run(() => action === "reveal" ? service.reveal(body.config, body.field) : service[action](body.config));
      send(res, 200, result ?? null);
    } else if (req.method === "POST" && action === "upload") {
      const body = JSON.parse(await readBody(req, 1024));
      if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw new CloudSyncError("上传参数无效，请直接备份本机当前数据");
      send(res, 200, await channels.run(() => service.upload(() => createBrowserCloudBackup(service.state().config.tables))));
    }
    else if (req.method === "POST" && action === "download") {
      const bytes = await channels.run(() => service.download(url.searchParams.get("versionId") ?? undefined));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="cloudhub-cloud-backup.chdb"', "Content-Length": bytes.length, "Cache-Control": "no-store" });
      res.end(bytes);
    } else send(res, 404, { error: "云备份接口不存在" });
  } catch (error) {
    // Configuration/SQLite/decryption failures may contain local details; only service errors are public.
    const message = error instanceof CloudSyncError ? error.message : "云备份操作失败，请检查本地调试服务与配置";
    send(res, 400, { error: message });
  }
  return true;
}
