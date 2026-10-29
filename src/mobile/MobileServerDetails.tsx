import type { LocalAsset } from "../shared/types";
import { displayValue, formatAssetDate } from "../shared/utils/display";

function value(payload: Record<string, unknown>, keys: string[]): unknown {
  return keys.map(key => payload[key]).find(item => item !== undefined && item !== null && item !== "");
}

function quantity(input: unknown, unit: string): string {
  const number = Number(input);
  return Number.isFinite(number) && number > 0 ? `${number} ${unit}` : "未获取";
}

export function serverExpiryLabel(payload: Record<string, unknown>): string {
  const expiry = value(payload, ["ExpiredTime", "ExpirationTime", "ExpireTime", "expiredTime", "expirationTime", "expireTime", "expire_time"]);
  return formatAssetDate(expiry);
}

export function MobileServerDetails({ server, cloudType }: { server: LocalAsset; cloudType?: string }) {
  const payload = server.payload;
  const memoryGb = value(payload, ["MemoryInGB", "memoryInGB", "memoryCapacityInGB"]);
  // Tencent CVM/Lighthouse return GB; other normalized server payloads use MB.
  const memory = memoryGb !== undefined ? quantity(memoryGb, "GB")
    : quantity(Number(value(payload, ["Memory", "memory", "ram"])) / (cloudType === "tencent" ? 1 : 1024), "GB");
  const disk = payload.SystemDisk && typeof payload.SystemDisk === "object" ? payload.SystemDisk as Record<string, unknown> : {};
  const fields: [string, string][] = [
    ["CPU", quantity(value(payload, ["Cpu", "CPU", "cpu", "cpuCount", "vcpu_count"]), "核")],
    ["内存", memory],
    ["实例规格 / 套餐", displayValue(value(payload, ["InstanceType", "PlanId", "shape", "instanceType"]))],
    ["操作系统 / 镜像", displayValue(value(payload, ["OSName", "OsName", "OSType", "ImageName", "ImageId", "imageId"]))],
    ["系统盘", quantity(value(payload, ["SystemDiskSize"]) ?? disk.Size, "GB")],
    ["公网带宽", quantity(value(payload, ["Bandwidth", "InternetMaxBandwidthOut"]), "Mbps")],
    ["公网 IP", displayValue(value(payload, ["PublicIpAddress", "PublicIpAddresses", "PublicIp", "PublicAddresses"]))],
    ["私网 IP", displayValue(value(payload, ["PrivateIpAddress", "PrivateIpAddresses", "PrivateIp"]))],
    ["创建时间", formatAssetDate(value(payload, ["CreationTime", "CreateTime", "CreatedTime", "createTime"]))],
    ["到期时间", serverExpiryLabel(payload)],
  ];
  const groups = [
    { title: "基础配置", indexes: [0, 1, 4, 5, 2, 3] },
    { title: "网络信息", indexes: [6, 7] },
    { title: "生命周期", indexes: [8, 9] },
  ];
  return <div className="mobile-server-configuration" aria-label="服务器配置">
    {groups.map(group => <section className="mobile-server-detail-group" key={group.title} aria-label={group.title}>
      <h4>{group.title}</h4>
      <dl>{group.indexes.map(index => {
        const [label, text] = fields[index];
        return <div key={label} className={index === 2 || index === 3 ? "mobile-server-detail-wide" : undefined}><dt>{label}</dt><dd>{text}</dd></div>;
      })}</dl>
    </section>)}
  </div>;
}
