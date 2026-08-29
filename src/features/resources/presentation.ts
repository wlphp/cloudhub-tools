import { displayValue } from "../../shared/utils/display";

export function remotePlatformFromPayload(payload: Record<string, unknown>): "linux" | "windows" {
  const system = [payload.OSName, payload.OSType, payload.ImageName, payload.ImageId, payload.Platform, payload.SystemType].map(displayValue).join(" ");
  return /windows|win(?:dows)?\s*(?:server)?/i.test(system) ? "windows" : "linux";
}

export function displayDnsServers(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayDnsServers).filter(Boolean).join(", ");
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(displayDnsServers).filter(Boolean).join(", ");
  return value == null || value === "" ? "" : String(value);
}

export function formatMoney(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : displayValue(value);
}

export function summaryMetricClass(tone: string, value: unknown): string {
  const isEmpty = value === null || value === undefined || value === "";
  return `summary-metric-value value-${tone}${isEmpty ? " is-empty" : ""}`;
}

export function daysUntil(value: unknown): number | null {
  if (!value) return null;
  const time = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(time) ? null : Math.ceil((time - Date.now()) / 86400000);
}

export function domainStatus(item: Record<string, unknown>): [string, string] {
  const days = daysUntil(item.ExpirationDate);
  if (days !== null && days < 0) return ["已过期", "status-expired"];
  if (item.DomainStatus === "PAUSE") return ["暂停", "status-other"];
  return ["正常", "status-normal"];
}

export function cloudStatusText(value: unknown): string {
  const status = String(value || "-");
  return ({ Running: "运行中", Normal: "运行中", Stopped: "已停止", Creating: "创建中", Deleting: "删除中", Rebooting: "重启中", running: "运行中", stopped: "已停止", pending: "处理中", active: "已启用", inactive: "未启用", suspended: "已暂停", rebuilding: "重建中" } as Record<string, string>)[status] || status;
}

export function formatEsaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const columnLabels: Record<string, string> = { InstanceName: "实例名称", InstanceId: "实例 ID", Status: "状态", RegionId: "地域", PublicIpAddress: "公网 IP", PrivateIpAddress: "内网 IP", Cpu: "CPU", Memory: "内存(MB)", OSType: "系统类型", OSName: "操作系统", ExpiredTime: "到期时间", CreationTime: "创建时间", DomainName: "域名", DomainStatus: "域名状态", RegistrationDate: "注册时间", ExpirationDate: "到期时间", DBInstanceDescription: "实例名称", DBInstanceId: "实例 ID", DBInstanceStatus: "状态", DBInstanceType: "实例类型", DBInstanceClass: "规格", Engine: "引擎", EngineVersion: "引擎版本", ConnectionString: "连接地址", Port: "端口", KVStoreInstanceId: "实例 ID", ConnectionDomain: "连接地址", InstanceStatus: "状态", Capacity: "容量(GB)", Bandwidth: "带宽", CreateTime: "创建时间", EndTime: "到期时间", BucketName: "存储桶", Location: "地域", Name: "名称", PlanName: "套餐" };

export function columnLabel(key: string): string {
  return columnLabels[key] || key.replace(/([A-Z])/g, " $1").trim();
}

export function resourceColumns(items: Record<string, unknown>[]): string[] {
  const preferred = ["InstanceName", "InstanceId", "Status", "RegionId", "PublicIpAddress", "PublicIp", "DomainName", "DBInstanceDescription", "DBInstanceId", "KVStoreInstanceId", "AssetId", "BucketName", "Name", "IpAddress", "SizeGb", "AttachedTo", "CreatedAt", "PlanName"];
  const keys = Array.from(new Set(items.flatMap((item) => Object.keys(item).filter((key) => !key.startsWith("_")))));
  const ordered = preferred.filter((key) => keys.includes(key));
  return [...ordered, ...keys.filter((key) => !ordered.includes(key))].slice(0, 7);
}
