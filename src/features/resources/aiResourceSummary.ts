type SafeMetric = string | number | null;

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return clean && clean !== "-" ? clean : null;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function serialize(title: string, values: Array<[string, SafeMetric]>): string {
  const lines = values.filter((entry): entry is [string, string | number] => entry[1] != null).map(([label, value]) => `${label}：${value}`);
  return `${title}\n${lines.join("\n")}\n请基于这些已知字段给出简短的容量/配置观察、需要补充的监控项和人工排查建议。区分事实与推测，不假设服务已异常，也不要建议直接执行变更。`;
}

export function rdsAiSummary(item: Record<string, unknown>, usedGb?: number | null, totalGb?: number | null): string {
  const total = safeNumber(totalGb);
  const used = safeNumber(usedGb);
  const usagePercent = total != null && total > 0 && used != null ? Math.round(used / total * 1000) / 10 : null;
  return serialize("请解读所选关系型数据库的规格和状态", [
    ["引擎", safeText(item.Engine)], ["引擎版本", safeText(item.EngineVersion)],
    ["运行状态", safeText(item.DBInstanceStatus)], ["实例规格", safeText(item.DBInstanceClass)],
    ["存储总量GB", total ?? safeNumber(item.DBInstanceStorage)], ["已用存储GB", used], ["存储使用百分比", usagePercent],
    ["网络类型", safeText(item.DBInstanceNetType)], ["付费类型", safeText(item.PayType)],
  ]);
}

export function redisAiSummary(item: Record<string, unknown>): string {
  return serialize("请解读所选 Redis 实例的规格和状态", [
    ["运行状态", safeText(item.InstanceStatus)], ["架构", safeText(item.ArchitectureType)],
    ["引擎版本", safeText(item.EngineVersion)], ["容量MB", safeNumber(item.Capacity)],
    ["带宽Mbps", safeNumber(item.Bandwidth)], ["连接数", safeNumber(item.Connections)],
    ["网络类型", safeText(item.NetworkType)], ["付费类型", safeText(item.ChargeType)],
  ]);
}

export function ossAiSummary(item: Record<string, unknown>, detail: { storage?: number; objectCount?: number; multipartUploadCount?: number; monthTraffic?: number; monthRequests?: number; acl?: string; cors?: unknown[] } | null): string {
  const safeAcl = safeText(detail?.acl || item.Acl);
  const corsCount = Array.isArray(detail?.cors) ? detail.cors.length : null;
  return serialize("请检查所选对象存储配置与使用情况", [
    ["存储类型", safeText(item.StorageClass)], ["访问控制级别", safeAcl],
    ["存储字节", safeNumber(detail?.storage)], ["对象数量", safeNumber(detail?.objectCount)],
    ["未完成分片上传数", safeNumber(detail?.multipartUploadCount)], ["当月流量字节", safeNumber(detail?.monthTraffic)],
    ["当月请求数", safeNumber(detail?.monthRequests)], ["CORS规则数", corsCount],
  ]);
}
