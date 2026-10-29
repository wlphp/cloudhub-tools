import { invokeOrWeb, jsonRequest, nativeOnly } from "./base";
import { webApiDownload } from "../api";
import type { DatabaseImportPreview } from "./database";

export type CloudSyncConfig = {
  id?: string; name?: string;
  tables?: string[] | null;
  method: "webdav" | "s3"; provider: string; endpoint: string; username: string;
  password: string; accessKeyId: string; secretKey: string; bucket: string; region: string;
  pathStyle: boolean; remoteRoot: string; profile: string; autoSync: boolean;
  allowInsecure: boolean; passwordProtected: boolean; backupPassword: string;
};
export type CloudBackupVersion = { id: string; machineName: string; uploadedAt: string | null };
export type CloudSyncProgress = {
  phase: "connecting" | "preparing" | "uploading" | "downloading" | "confirming" | "verifying" | "finishing";
  transferred: number;
  total: number | null;
};
export type CloudSyncView = {
  configured: boolean;
  config: Omit<CloudSyncConfig, "password" | "secretKey" | "backupPassword"> & {
    hasPassword: boolean; hasSecretKey: boolean; hasBackupPassword: boolean;
  };
  status: { busy: boolean; paused: boolean; lastUpload: string | null; lastDownload: string | null; error: string | null; progress?: CloudSyncProgress | null };
};
export function cloudSyncChannelClient(channelId = "default") {
  const path = (action: string) => `/api/cloud-sync/${action}?channelId=${encodeURIComponent(channelId)}`;
  return {
    revealSecret: (config: CloudSyncConfig, field: "password" | "secretKey" | "backupPassword") => invokeOrWeb<string>("cloud_sync_reveal_secret", { config, field }, { path: path("reveal"), init: jsonRequest("POST", { config, field }) }),
    state: () => invokeOrWeb<CloudSyncView>("cloud_sync_state", { channelId }, { path: path("state") }),
    save: (config: CloudSyncConfig) => invokeOrWeb<CloudSyncView>("cloud_sync_save", { config }, { path: path("save"), init: jsonRequest("POST", { config }) }),
    test: (config: CloudSyncConfig) => invokeOrWeb<void>("cloud_sync_test", { config }, { path: path("test"), init: jsonRequest("POST", { config }) }),
    versions: () => invokeOrWeb<CloudBackupVersion[]>("cloud_sync_versions", { channelId }, { path: path("versions") }),
    downloadFile: (versionId?: string) => webApiDownload(`${path("download")}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""}`),
    upload: () => invokeOrWeb<CloudSyncView>("cloud_sync_upload", { channelId }, { path: path("upload"), init: jsonRequest("POST", {}) }),
    download: (versionId?: string) => nativeOnly<DatabaseImportPreview>("cloud_sync_download", { versionId, channelId }),
    remove: () => invokeOrWeb<void>("cloud_sync_delete", { channelId }, { path: path("delete"), init: jsonRequest("POST", {}) }),
  };
}
export const cloudSyncClient = {
  ...cloudSyncChannelClient(),
  channels: () => invokeOrWeb<CloudSyncView[]>("cloud_sync_channels", undefined, { path: "/api/cloud-sync/channels" }),
};
