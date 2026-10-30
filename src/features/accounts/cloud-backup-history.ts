import type { CloudSyncConfig } from "../../platform/clients/cloudSync";

export type BackupDownloadHistory = Record<string, { count: number; lastDownload: string }>;
export type CloudSyncHistoryEntry = { id: string; action: "upload" | "download"; occurredAt: string; versionId: string | null };

// Device-local usage metadata only; never included in cloud backup packages.
export function backupHistoryKey(channelId: string, config: Pick<CloudSyncConfig, "method" | "endpoint" | "bucket" | "remoteRoot" | "profile">) {
  return `cloudhub.backup-downloads.v1:${JSON.stringify([channelId, config.method, config.endpoint, config.bucket, config.remoteRoot, config.profile])}`;
}

export function readBackupHistory(key: string): BackupDownloadHistory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, value]) =>
      (id === "database.chdb" || /^backup-[\da-f-]{36}\.chdb$/i.test(id)) && value &&
      Number.isSafeInteger(value.count) && value.count > 0 && typeof value.lastDownload === "string" && Number.isFinite(Date.parse(value.lastDownload))));
  } catch { return {}; }
}

export function readCloudSyncHistory(key: string): CloudSyncHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}:events`) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CloudSyncHistoryEntry => item &&
      typeof item.id === "string" && (item.action === "upload" || item.action === "download") &&
      typeof item.occurredAt === "string" && Number.isFinite(Date.parse(item.occurredAt)) &&
      (item.versionId === null || typeof item.versionId === "string")).slice(0, 2000);
  } catch { return []; }
}

export function appendCloudSyncHistory(key: string, action: CloudSyncHistoryEntry["action"], versionId: string | null) {
  const records = readCloudSyncHistory(key);
  const record = { id: crypto.randomUUID(), action, occurredAt: new Date().toISOString(), versionId } satisfies CloudSyncHistoryEntry;
  const next = [record, ...records].slice(0, 2000);
  localStorage.setItem(`${key}:events`, JSON.stringify(next));
  return next;
}
