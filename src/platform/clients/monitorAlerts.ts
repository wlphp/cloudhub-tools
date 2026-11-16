import { runningInTauri } from "../api";
import { nativeOnly } from "./base";

export interface MonitorAlert {
  key: string; title: string; detail: string; section: "panels" | "resources" | "certificates" | "notes";
  severity: "emergency" | "critical" | "warning"; active: boolean; ignored?: boolean; firstSeen: number; updatedAt: number;
  snoozedUntil: number; notifiedAt: number; occurrences: number;
}
const monitoredAssetProductLabels: Record<string, string> = {
  ecs: "云服务器", cvm: "云服务器", server: "云服务器", instance: "云服务器",
  lighthouse: "轻量服务器", swas: "轻量服务器", domain: "域名", rds: "云数据库", redis: "Redis",
};
export function monitorAlertProductLabel(alert: MonitorAlert): string {
  if (alert.section === "resources") {
    const resourceType = alert.key.split(":")[2] ?? "";
    return monitoredAssetProductLabels[resourceType] ?? "云资源";
  }
  if (alert.section === "certificates") return alert.key.startsWith("site:") ? "宝塔站点证书" : "本地证书";
  if (alert.section === "panels") {
    if (alert.key.endsWith(":connection")) return "面板访问";
    if (alert.key.includes(":metric:cpu")) return "CPU巡检";
    if (alert.key.includes(":metric:disk")) return "磁盘巡检";
    if (alert.key.includes(":service:")) return "面板服务";
    return "面板巡检";
  }
  return "备忘录";
}
export interface MonitorSnapshot { alerts: MonitorAlert[]; checkedAt: number; lastError: string | null }
const monitorSeverityRank = (severity: MonitorAlert["severity"]) => severity === "emergency" ? 3 : severity === "critical" ? 2 : 1;
export const monitorSeverityLabel = (severity: MonitorAlert["severity"]) => severity === "emergency" ? "超级严重" : severity === "critical" ? "紧急" : "提醒";
export function sortMonitorAlerts(alerts: MonitorAlert[]): MonitorAlert[] {
  return [...alerts].sort((a, b) => Number(b.active && !b.ignored) - Number(a.active && !a.ignored) || Number(b.active) - Number(a.active) || monitorSeverityRank(b.severity) - monitorSeverityRank(a.severity) || b.updatedAt - a.updatedAt);
}

export interface MonitorSettings {
  monitoring: boolean; panels: boolean; panelDisk: boolean; panelServices: boolean; panelAccess: boolean; certificates: boolean; servers: boolean;
  lightServers: boolean; domains: boolean; databases: boolean; redis: boolean;
  excludedAssetAlerts: string[]; intervalSeconds: number; expiryDays: number;
  cpuThreshold: number; diskThreshold: number;
}
export const defaultMonitorSettings: MonitorSettings = {
  monitoring: false, panels: false, panelDisk: false, panelServices: false, panelAccess: true, certificates: true, servers: true,
  lightServers: true, domains: true, databases: true, redis: true,
  excludedAssetAlerts: [], intervalSeconds: 300, expiryDays: 30,
  cpuThreshold: 90, diskThreshold: 90,
};

// Monitoring is a standalone mobile feature even though desktop currently
// shares the persisted strategy model with its companion integration.
const preview = async () => (await import("./monitorAlertsPreview")).monitorAlertsPreview;
export const monitorAlertsClient = {
  settings: () => runningInTauri ? nativeOnly<MonitorSettings>("monitor_alerts_settings") : preview().then(client => client.settings()),
  snapshot: () => runningInTauri ? nativeOnly<MonitorSnapshot>("monitor_alerts_snapshot") : preview().then(client => client.snapshot()),
  save: (settings: MonitorSettings) => runningInTauri ? nativeOnly<void>("monitor_alerts_save_settings", { settings }) : preview().then(client => client.save(settings)),
  clearSelected: (keys: string[]) => runningInTauri ? nativeOnly<MonitorSnapshot>("monitor_alerts_clear_selected", { keys }) : preview().then(client => client.clearSelected(keys)),
  check: () => runningInTauri ? nativeOnly<void>("monitor_alerts_check") : preview().then(client => client.check()),
  ignore: (keys: string[], ignored = true) => runningInTauri ? nativeOnly<MonitorSnapshot>("monitor_alerts_ignore", { keys, ignored }) : preview().then(client => client.ignore(keys, ignored)),
};
