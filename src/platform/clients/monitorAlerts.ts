import { nativeOnly } from "./base";

export interface MonitorAlert {
  key: string; title: string; detail: string; section: "panels" | "resources" | "certificates" | "notes";
  severity: "emergency" | "critical" | "warning"; active: boolean; ignored?: boolean; firstSeen: number; updatedAt: number;
  snoozedUntil: number; notifiedAt: number; occurrences: number;
}
export interface MonitorSnapshot { alerts: MonitorAlert[]; checkedAt: number; lastError: string | null }
export const monitorSeverityRank = (severity: MonitorAlert["severity"]) => severity === "emergency" ? 3 : severity === "critical" ? 2 : 1;
export const monitorSeverityLabel = (severity: MonitorAlert["severity"]) => severity === "emergency" ? "超级严重" : severity === "critical" ? "紧急" : "提醒";
export function sortMonitorAlerts(alerts: MonitorAlert[]): MonitorAlert[] {
  return [...alerts].sort((a, b) => Number(b.active && !b.ignored) - Number(a.active && !a.ignored) || Number(b.active) - Number(a.active) || monitorSeverityRank(b.severity) - monitorSeverityRank(a.severity) || b.updatedAt - a.updatedAt);
}

export interface MonitorSettings {
  monitoring: boolean; panels: boolean; panelAccess: boolean; certificates: boolean; servers: boolean;
  excludedAssetAlerts: string[]; intervalSeconds: number; expiryDays: number;
  cpuThreshold: number; diskThreshold: number;
}
export const defaultMonitorSettings: MonitorSettings = {
  monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true,
  excludedAssetAlerts: [], intervalSeconds: 300, expiryDays: 30,
  cpuThreshold: 90, diskThreshold: 90,
};

// Monitoring is a standalone mobile feature even though desktop currently
// shares the persisted strategy model with its companion integration.
export const monitorAlertsClient = {
  settings: () => nativeOnly<MonitorSettings>("monitor_alerts_settings"),
  snapshot: () => nativeOnly<MonitorSnapshot>("monitor_alerts_snapshot"),
  save: (settings: MonitorSettings) => nativeOnly<void>("monitor_alerts_save_settings", { settings }),
  check: () => nativeOnly<void>("monitor_alerts_check"),
  ignore: (keys: string[], ignored = true) => nativeOnly<MonitorSnapshot>("monitor_alerts_ignore", { keys, ignored }),
};
