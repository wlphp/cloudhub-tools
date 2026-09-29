import { nativeOnly } from "./base";
import type { FrpGlobalSettings, FrpGlobalSettingsInput, FrpRuntime, FrpServer, FrpServerInput } from "../../shared/types";

export const frpClient = {
  settings(): Promise<FrpGlobalSettings | null> { return nativeOnly("get_frp_global_settings"); },
  saveSettings(input: FrpGlobalSettingsInput): Promise<FrpGlobalSettings> { return nativeOnly("save_frp_global_settings", { input }); },
  servers(): Promise<FrpServer[]> { return nativeOnly("list_frp_servers"); },
  saveServer(input: FrpServerInput): Promise<FrpServer> { return nativeOnly("save_frp_server", { input }); },
  deleteServer(id: number): Promise<void> { return nativeOnly("delete_frp_server", { id }); },
  install(): Promise<void> { return nativeOnly("install_frpc"); },
  apply(serverId: number): Promise<FrpRuntime> { return nativeOnly("apply_frp_profile", { serverId }); },
  runtime(): Promise<FrpRuntime[]> { return nativeOnly("get_frpc_runtime"); },
  control(serverId: number, action: "start" | "stop" | "restart"): Promise<FrpRuntime[]> { return nativeOnly("control_frpc", { serverId, action }); },
  panel(serverId: number): Promise<string> { return nativeOnly("open_frpc_panel", { serverId }); },
};
