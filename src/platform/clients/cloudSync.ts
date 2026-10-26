import { nativeOnly } from "./base";
import type { DatabaseImportPreview } from "./database";

export type CloudSyncConfig = {
  method: "webdav" | "s3"; provider: string; endpoint: string; username: string;
  password: string; accessKeyId: string; secretKey: string; bucket: string; region: string;
  pathStyle: boolean; remoteRoot: string; profile: string; autoSync: boolean;
  allowInsecure: boolean; passwordProtected: boolean; backupPassword: string;
};
export type CloudSyncView = {
  configured: boolean;
  config: Omit<CloudSyncConfig, "password" | "secretKey" | "backupPassword"> & {
    hasPassword: boolean; hasSecretKey: boolean; hasBackupPassword: boolean;
  };
  status: { busy: boolean; paused: boolean; lastUpload: string | null; lastDownload: string | null; error: string | null };
};
export const cloudSyncClient = {
  revealSecret: (config: CloudSyncConfig, field: "password" | "secretKey" | "backupPassword") => nativeOnly<string>("cloud_sync_reveal_secret", { config, field }),
  state: () => nativeOnly<CloudSyncView>("cloud_sync_state"),
  save: (config: CloudSyncConfig) => nativeOnly<CloudSyncView>("cloud_sync_save", { config }),
  test: (config: CloudSyncConfig) => nativeOnly<void>("cloud_sync_test", { config }),
  upload: () => nativeOnly<CloudSyncView>("cloud_sync_upload"),
  download: () => nativeOnly<DatabaseImportPreview>("cloud_sync_download"),
};
