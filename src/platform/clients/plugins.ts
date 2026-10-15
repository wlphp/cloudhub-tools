import { nativeOnly } from "./base";

export interface WechatPluginStatus {
  supported: boolean;
  detectedPath: string | null;
  runningProcesses: number;
}

export interface WechatLaunchResult {
  requested: number;
  started: number;
  failed: number;
}

export interface WechatSession {
  id: string;
  label: string;
  createdAt: number;
  dataPath: string;
  recovery: boolean;
  family: "微信 3.x" | "微信 4.x";
}

export interface WechatDataDetection {
  candidates: { path: string; family: string; source: string }[];
  limited: boolean;
}

export interface HardwareInfo {
  model: string;
  os: string;
  uptime: string;
  updatedAt: string;
  wifiPasswordSupported: boolean;
  sections: { title: string; rows: { label: string; value: string }[] }[];
}

export interface WifiPasswordReveal {
  ssid: string;
  password: string;
}

export interface WslDistribution {
  name: string;
  state: string;
  version: number | null;
  isDefault: boolean;
  installedAt: number | null;
  lastStartedAt: number | null;
  remark: string;
}

export interface WslOnlineDistribution {
  name: string;
  friendlyName: string;
}

export interface WslDashboardSettings {
  defaultInstallLocation: string;
}

export interface WslOperationLog {
  timestamp: number;
  action: string;
  distribution: string | null;
  success: boolean;
}

export const pluginsClient = {
  hardwareInfo: () => nativeOnly<HardwareInfo>("hardware_info_get"),
  wslList: () => nativeOnly<WslDistribution[]>("wsl_dashboard_list"),
  wslControl: (name: string, action: "start" | "stop" | "default" | "unregister", confirmationName?: string) => nativeOnly<void>("wsl_dashboard_control", { name, action, confirmationName: confirmationName ?? null }),
  wslBackup: (name: string) => nativeOnly<string | null>("wsl_dashboard_backup", { name }),
  wslShutdown: () => nativeOnly<void>("wsl_dashboard_shutdown"),
  wslSettings: () => nativeOnly<WslDashboardSettings>("wsl_dashboard_settings_get"),
  wslSaveSettings: (defaultInstallLocation: string, name?: string, remark?: string) => nativeOnly<void>("wsl_dashboard_save_settings", { defaultInstallLocation, name: name ?? null, remark: remark ?? null }),
  wslSelectInstallLocation: () => nativeOnly<string | null>("wsl_dashboard_select_install_location"),
  wslSelectRootfsFile: () => nativeOnly<string | null>("wsl_dashboard_select_rootfs_file"),
  wslImportRootfs: (distribution: string, installLocation: string, filePath: string) => nativeOnly<void>("wsl_dashboard_import_rootfs", { distribution, installLocation, filePath }),
  wslLogs: () => nativeOnly<WslOperationLog[]>("wsl_dashboard_logs_get"),
  wslClearLogs: () => nativeOnly<void>("wsl_dashboard_logs_clear"),
  wslInstall: (distribution: string, location: string) => nativeOnly<void>("wsl_dashboard_install", { distribution, location }),
  wslCloneDistribution: (source: string, distribution: string, installLocation: string) => nativeOnly<void>("wsl_dashboard_clone", { source, distribution, installLocation }),
  wslOnlineList: () => nativeOnly<WslOnlineDistribution[]>("wsl_dashboard_online_list"),
  wslOpenTerminal: (name: string) => nativeOnly<void>("wsl_dashboard_open_terminal", { name }),
  wslOpenFolder: (name: string) => nativeOnly<void>("wsl_dashboard_open_folder", { name }),
  revealWifiPassword: () => nativeOnly<WifiPasswordReveal>("hardware_wifi_password_reveal"),
  exportHardwareImage: (dataUrl: string) => nativeOnly<string | null>("hardware_info_export_png", { dataUrl }),
  deleteWechatSession: (id: string) => nativeOnly<void>("wechat_sessions_delete", { id }),
  detectWechatData: (browse = false) => nativeOnly<WechatDataDetection | null>("wechat_sessions_detect", { browse }),
  wechatSessions: () => nativeOnly<WechatSession[]>("wechat_sessions_list"),
  selectWechatData: () => nativeOnly<string | null>("wechat_sessions_select"),
  captureWechatSession: (dataPath: string, label: string, path: string) => nativeOnly<WechatSession>("wechat_sessions_capture", { dataPath, label, path }),
  launchWechatSession: (id: string, path: string, quickIntervalMs?: number) => nativeOnly<void>("wechat_sessions_launch", { id, path, ...(quickIntervalMs === undefined ? {} : { quickIntervalMs }) }),
  restoreWechatBackup: (id: string) => nativeOnly<void>("wechat_sessions_restore", { id }),
  wechatStatus: () => nativeOnly<WechatPluginStatus>("wechat_plugin_status"),
  selectWechat: () => nativeOnly<string | null>("wechat_plugin_select"),
  launchWechat: (path: string, count: number) => nativeOnly<WechatLaunchResult>("wechat_plugin_launch", { path, count }),
};
