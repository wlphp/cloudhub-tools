import { nativeOnly } from "./base";

export interface DriveConnection {
  id: string; name: string; provider: string; endpoint: string; region: string;
  bucket: string; prefix: string; pathStyle: boolean; mountPoint: string;
  readOnly: boolean; autoMount: boolean; cacheDir: string; cacheGib: number;
  accessKeyId: string; hasCredentials: boolean; hasSessionToken: boolean;
}
export interface DriveMount {
  id: string; phase: "idle" | "mounted" | "recovery"; queued: number; uploading: number;
  errors: number; bytesUsed: number; outOfSpace: boolean; dirty: boolean; message: string;
}
export interface DriveSnapshot {
  dependency: { supported: boolean; installed: boolean; winfsp: boolean; version: string; source: string;
    progress: { phase: string; downloaded: number; total: number } };
  connections: DriveConnection[]; mounts: DriveMount[];
}
export type DriveInput = Omit<DriveConnection, "hasCredentials" | "hasSessionToken"> & {
  accessKeyId: string; secretKey: string; sessionToken: string;
};
export const cloudDriveClient = {
  snapshot: () => nativeOnly<DriveSnapshot>("cloud_drive_snapshot"),
  install: () => nativeOnly<void>("cloud_drive_install"),
  save: (input: DriveInput, clearSessionToken: boolean, reuseSavedCredentials = false) => nativeOnly<void>("cloud_drive_save", { input, clearSessionToken, reuseSavedCredentials }),
  remove: (id: string) => nativeOnly<void>("cloud_drive_remove", { id }),
  probe: (id: string, kind: "test" | "buckets" | "directories") => nativeOnly<string[]>("cloud_drive_probe", { id, kind }),
  listBuckets: (input: DriveInput, clearSessionToken: boolean, reuseSavedCredentials = false) => nativeOnly<string[]>("cloud_drive_list_buckets", { input, clearSessionToken, reuseSavedCredentials }),
  mount: (id: string) => nativeOnly<void>("cloud_drive_mount", { id }),
  unmount: (id: string) => nativeOnly<void>("cloud_drive_unmount", { id }),
  suspend: (id: string) => nativeOnly<void>("cloud_drive_suspend", { id }),
  credentials: (id: string, accessKeyId: string, secretKey: string, sessionToken: string) => nativeOnly<void>("cloud_drive_credentials", { id, accessKeyId, secretKey, sessionToken }),
  revealSecret: (id: string) => nativeOnly<string>("cloud_drive_reveal_secret", { id }),
  clearRecovery: (id: string) => nativeOnly<void>("cloud_drive_clear_recovery", { id }),
  open: (id: string) => nativeOnly<void>("cloud_drive_open", { id }),
  winfsp: () => nativeOnly<void>("cloud_drive_winfsp"),
  selectCache: () => nativeOnly<string | null>("cloud_drive_select_cache"),
};
