import { Channel } from "@tauri-apps/api/core";
import { invokeOrWeb, nativeOnly, queryPath } from "./base";
export type UpdateSource = "auto" | "accelerated" | "mirror705810" | "direct";
export type UpdateRoute = Exclude<UpdateSource, "auto">;
export type UpdateProgress = { downloaded: number; total: number | null; route: UpdateRoute; message: string };
export type UpdateProbe = { route: UpdateRoute; available: boolean; responseMs: number; bytesPerSecond: number; message: string };
export type DesktopUpdate = { version: string; notes?: string; route: UpdateRoute };
export type MobileUpdate = { version: string; available: boolean; notes: string; size: number; downloadable: boolean; route: UpdateRoute };
export const sourceLabel = (source: UpdateSource) => source === "auto" ? "自动选择" : source === "accelerated" ? "gh-proxy.com" : source === "mirror705810" ? "github.705810.xyz" : "GitHub 官方直连";
const channel = (onProgress: (event: UpdateProgress) => void) => { const result = new Channel<UpdateProgress>(); result.onmessage = onProgress; return result; };
export const updatesClient = {
  info: (source: UpdateSource) => invokeOrWeb<{ version: string; notes: string; route: UpdateRoute }>("app_update_info", { source }, { path: queryPath("/api/app-update-info", { source }) }),
  probe: (route: UpdateRoute) => invokeOrWeb<UpdateProbe>("app_update_probe", { route }, { path: queryPath("/api/app-update-probe", { route }) }),
  checkDesktop: (source: UpdateSource, progress: (e: UpdateProgress) => void) => nativeOnly<DesktopUpdate | null>("app_update_check", { source, onProgress: channel(progress) }),
  installDesktop: (source: UpdateSource, expectedVersion: string, progress: (e: UpdateProgress) => void) => nativeOnly<void>("app_update_install", { source, expectedVersion, onProgress: channel(progress) }),
  checkAndroid: (source: UpdateSource, progress: (e: UpdateProgress) => void) => nativeOnly<MobileUpdate>("plugin:cloudhub-mobile-updater|check", { source, onProgress: channel(progress) }),
  downloadAndroid: (source: UpdateSource, expectedVersion: string, progress: (e: UpdateProgress) => void) => nativeOnly<void>("plugin:cloudhub-mobile-updater|download", { source, expectedVersion, onProgress: channel(progress) }),
};
