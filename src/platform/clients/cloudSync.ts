import { invokeOrWeb, jsonRequest, nativeOnly } from "./base";
import { webApiDownload } from "../api";
import type { DatabaseImportPreview } from "./database";

export type CloudSyncConfig = {
  method: "webdav" | "s3"; provider: string; endpoint: string; username: string;
  password: string; accessKeyId: string; secretKey: string; bucket: string; region: string;
  pathStyle: boolean; remoteRoot: string; profile: string; autoSync: boolean;
  allowInsecure: boolean; passwordProtected: boolean; backupPassword: string;
};
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
export const cloudSyncClient = {
  revealSecret: (config: CloudSyncConfig, field: "password" | "secretKey" | "backupPassword") => invokeOrWeb<string>("cloud_sync_reveal_secret", { config, field }, { path: "/api/cloud-sync/reveal", init: jsonRequest("POST", { config, field }) }),
  state: () => invokeOrWeb<CloudSyncView>("cloud_sync_state", undefined, { path: "/api/cloud-sync/state" }),
  save: (config: CloudSyncConfig) => invokeOrWeb<CloudSyncView>("cloud_sync_save", { config }, { path: "/api/cloud-sync/save", init: jsonRequest("POST", { config }) }),
  test: (config: CloudSyncConfig) => invokeOrWeb<void>("cloud_sync_test", { config }, { path: "/api/cloud-sync/test", init: jsonRequest("POST", { config }) }),
  downloadFile: () => webApiDownload("/api/cloud-sync/download"),
  upload: () => invokeOrWeb<CloudSyncView>("cloud_sync_upload", undefined, { path: "/api/cloud-sync/upload", init: jsonRequest("POST", {}) }),
  download: () => nativeOnly<DatabaseImportPreview>("cloud_sync_download"),
};
