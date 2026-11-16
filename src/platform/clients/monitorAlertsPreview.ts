import { defaultMonitorSettings, type MonitorAlert, type MonitorSettings, type MonitorSnapshot } from "./monitorAlerts";
import { resourcesClient } from "./resources";
import { assetExpiryTimestamp } from "../../features/assets/aiSearch";

// H5 UI debugging only. These keys never read or update native monitoring state.
const settingsKey = "cloudhub.h5-debug.monitor-settings.v1";
const historyKey = "cloudhub.h5-debug.monitor-history.v1";
function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }
const empty: MonitorSnapshot = { alerts: [], checkedAt: 0, lastError: null };
function settings(): MonitorSettings {
  const stored = read<Partial<MonitorSettings>>(settingsKey, {});
  return { ...defaultMonitorSettings, ...stored, excludedAssetAlerts: Array.isArray(stored.excludedAssetAlerts) ? stored.excludedAssetAlerts : [] };
}
function snapshot(): MonitorSnapshot {
  const stored = read<MonitorSnapshot>(historyKey, empty);
  return Array.isArray(stored.alerts) ? stored : empty;
}
function productEnabled(type: string, policy: MonitorSettings) {
  if (["ecs", "cvm", "server", "instance"].includes(type)) return policy.servers;
  if (["swas", "lighthouse"].includes(type)) return policy.lightServers;
  return type === "domain" ? policy.domains : type === "rds" ? policy.databases : type === "redis" ? policy.redis : false;
}
export const monitorAlertsPreview = {
  settings: async () => settings(),
  snapshot: async () => snapshot(),
  save: async (value: MonitorSettings) => { write(settingsKey, value); },
  check: async () => {
    const policy = settings();
    if (!policy.monitoring) throw new Error("请先开启运维预警");
    const assets = await resourcesClient.listLocal();
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const previous = snapshot();
    const active = new Map<string, MonitorAlert>();
    for (const asset of assets) {
      const key = `asset:${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
      const expiry = assetExpiryTimestamp(asset);
      if (!productEnabled(asset.resource_type, policy) || policy.excludedAssetAlerts.includes(key) || expiry === null || expiry > now + policy.expiryDays * 86400000) continue;
      const days = Math.ceil((expiry - now) / 86400000);
      const old = previous.alerts.find(alert => alert.key === key);
      const payload = asset.payload || {};
      const name = String(payload.InstanceName || payload.DBInstanceDescription || payload.DomainName || payload.Name || asset.asset_key).slice(0, 200);
      active.set(key, { key, title: `${name} ${days <= 0 ? "已到期" : "即将到期"}`, detail: `H5 调试：根据本机已保存的资源缓存检查到期时间 ${new Date(expiry).toLocaleString("zh-CN")}。此结果不包含实时面板、系统服务或证书巡检。`, section: "resources", severity: days <= 0 ? "critical" : days <= 7 ? "warning" : "warning", active: true, ignored: old?.ignored ?? false, firstSeen: old?.firstSeen ?? seconds, updatedAt: seconds, snoozedUntil: 0, notifiedAt: 0, occurrences: (old?.occurrences ?? 0) + 1 });
    }
    const alerts = [...active.values(), ...previous.alerts.filter(alert => !active.has(alert.key)).map(alert => ({ ...alert, active: false }))];
    write(historyKey, { alerts, checkedAt: seconds, lastError: null });
  },
  ignore: async (keys: string[], ignored = true) => {
    const next = snapshot();
    next.alerts = next.alerts.map(alert => keys.includes(alert.key) ? { ...alert, ignored } : alert);
    write(historyKey, next); return next;
  },
  clearSelected: async (keys: string[]) => {
    const next = snapshot();
    next.alerts = next.alerts.filter(alert => !keys.includes(alert.key));
    write(historyKey, next); return next;
  },
};
