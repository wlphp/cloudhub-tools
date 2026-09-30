import { nativeOnly } from "./base";
import { Channel } from "@tauri-apps/api/core";
import type { FrpGlobalSettings, FrpGlobalSettingsInput, FrpRuntime, FrpServer, FrpServerInput } from "../../shared/types";

export interface FrpRelease { version: string; architecture: string; releaseUrl: string; sha256: string }
export interface FrpInstallProgress {
  stage: "metadata" | "downloading" | "verifying" | "extracting" | "checking" | "installing" | "complete" | "error";
  downloadedBytes: number;
  totalBytes: number | null;
}

export const frpClient = {
  revealServerPanelPassword(serverId: number): Promise<string> { return nativeOnly("reveal_frp_server_panel_password", { serverId }); },
  openServerPanel(serverId: number): Promise<void> { return nativeOnly("open_frp_server_panel", { serverId }); },
  revealServerToken(serverId: number): Promise<string> { return nativeOnly("reveal_frp_server_token", { serverId }); },
  revealAdminPassword(): Promise<string> { return nativeOnly("reveal_frp_admin_password"); },
  openInstallDirectory(): Promise<void> { return nativeOnly("open_frp_install_directory"); },
  localPaths(serverId: number | null): Promise<{ binaryPath: string; configPath: string | null; installed: boolean; version: string | null }> { return nativeOnly("get_frp_local_paths", { serverId }); },
  openConfig(serverId: number): Promise<void> { return nativeOnly("open_frp_config_file", { serverId }); },
  settings(): Promise<FrpGlobalSettings | null> { return nativeOnly("get_frp_global_settings"); },
  saveSettings(input: FrpGlobalSettingsInput): Promise<FrpGlobalSettings> { return nativeOnly("save_frp_global_settings", { input }); },
  servers(): Promise<FrpServer[]> { return nativeOnly("list_frp_servers"); },
  saveServer(input: FrpServerInput): Promise<FrpServer> { return nativeOnly("save_frp_server", { input }); },
  deleteServer(id: number): Promise<void> { return nativeOnly("delete_frp_server", { id }); },
  releases(): Promise<FrpRelease[]> { return nativeOnly("list_frp_releases"); },
  async install(version: string, onProgress: (progress: FrpInstallProgress) => void): Promise<void> {
    let active = true;
    const channel = new Channel<FrpInstallProgress>((progress) => { if (active) onProgress(progress); });
    try { await nativeOnly<void>("install_frpc", { version, onProgress: channel }); }
    finally { active = false; channel.onmessage = () => {}; }
  },
  apply(serverId: number): Promise<FrpRuntime> { return nativeOnly("apply_frp_profile", { serverId }); },
  runtime(): Promise<FrpRuntime[]> { return nativeOnly("get_frpc_runtime"); },
  logs(serverId: number): Promise<string[]> { return nativeOnly("get_frpc_logs", { serverId }); },
  control(serverId: number, action: "start" | "stop" | "restart"): Promise<FrpRuntime[]> { return nativeOnly("control_frpc", { serverId, action }); },
  panel(serverId: number): Promise<string> { return nativeOnly("open_frpc_panel", { serverId }); },
};
