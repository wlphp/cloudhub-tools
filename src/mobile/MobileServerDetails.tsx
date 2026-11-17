import { aliyunSwasFields } from "../shared/utils/aliyunSwas";
import { baiduServerFields } from "../shared/utils/baiduServer";
import type { LocalAsset } from "../shared/types";
import { displayValue, firstAddress, formatAssetDate } from "../shared/utils/display";

type DetailField = { label: string; value: string; wide?: boolean };
type DetailGroup = { title: string; rows: DetailField[] };

function hasValue(input: unknown): boolean {
  if (input === null || input === undefined || input === "") return false;
  if (typeof input === "string") return input.trim() !== "" && input.trim() !== "-" && input.trim() !== "—";
  if (Array.isArray(input)) return input.some(hasValue);
  if (typeof input === "object") return Object.values(input as Record<string, unknown>).some(hasValue);
  return true;
}

function value(payload: Record<string, unknown>, keys: string[]): unknown {
  return keys.map(key => payload[key]).find(hasValue);
}

function numberValue(input: unknown): number | undefined {
  const parsed = typeof input === "number" ? input : typeof input === "string" && input.trim() ? Number(input) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveQuantity(input: unknown, unit: string): string | undefined {
  const number = numberValue(input);
  return number !== undefined && number > 0 ? `${number} ${unit}` : undefined;
}

function serverMemory(payload: Record<string, unknown>, cloudType: string | undefined, isLightServer: boolean): string | undefined {
  const memoryGb = value(payload, ["MemoryInGB", "memoryInGB", "memoryCapacityInGB"]);
  if (memoryGb !== undefined) return positiveQuantity(memoryGb, cloudType === "aliyun" && isLightServer ? "GiB" : "GB");

  const memory = value(payload, ["Memory", "memory", "ram"]);
  const amount = numberValue(memory);
  if (amount === undefined || amount <= 0) return undefined;
  if (isLightServer && (cloudType === "tencent" || cloudType === "jdcloud")) return `${amount} GB`;
  return amount >= 1024 ? `${Number((amount / 1024).toFixed(1))} GB` : `${amount} MB`;
}

function diskSummary(payload: Record<string, unknown>, isAliyunSwas: boolean): string | undefined {
  const sourceDisks = Array.isArray(payload.Disks) ? payload.Disks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const dataDisks = Array.isArray(payload.DataDisks) ? payload.DataDisks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const systemDisk = payload.SystemDisk && typeof payload.SystemDisk === "object" ? payload.SystemDisk as Record<string, unknown> : {};
  const systemDiskEntry = sourceDisks.find(disk => {
    const kind = String(disk.DiskType ?? disk.Type ?? disk.Usage ?? disk.DiskName ?? "").toLowerCase();
    return disk.isSystemDisk === true || disk.isSystemVolume === true || /system|boot|startup|系统盘|系统/.test(kind);
  });
  const unit = isAliyunSwas ? "GiB" : "GB";
  const systemSize = [
    value(payload, ["SystemDiskSize", "systemDiskSize"]),
    value(systemDisk, ["DiskSize", "Size", "DiskSizeGB"]),
    value(systemDiskEntry ?? {}, ["DiskSize", "Size", "DiskSizeGB"]),
    typeof payload.SystemDisk === "number" ? payload.SystemDisk : undefined,
  ].find(candidate => positiveQuantity(candidate, unit) !== undefined);
  const parts: string[] = [];
  const formattedSystemSize = positiveQuantity(systemSize, unit);
  if (formattedSystemSize) parts.push(`系统盘 ${formattedSystemSize}`);

  const otherDisks = [...sourceDisks.filter(disk => disk !== systemDiskEntry), ...dataDisks];
  const seen = new Set<string>();
  const formattedDataDisks = otherDisks.flatMap(disk => {
    const size = positiveQuantity(value(disk, ["DiskSize", "Size", "DiskSizeGB"]), unit);
    const name = String(value(disk, ["DiskName", "DiskId", "Name"]) ?? "");
    const summary = size ? `数据盘 ${size}` : name ? `数据盘 ${name}` : "";
    if (!summary || seen.has(summary)) return [];
    seen.add(summary);
    return [summary];
  });
  parts.push(...formattedDataDisks);
  if (parts.length) return parts.join(" · ");
  return typeof payload.SystemDisk === "string" && hasValue(payload.SystemDisk) ? payload.SystemDisk : undefined;
}

export function serverExpiryLabel(payload: Record<string, unknown>, cloudType?: string, resourceType?: string): string {
  const normalized = cloudType === "aliyun" && resourceType === "swas" ? aliyunSwasFields(payload) : payload;
  const expiry = value(normalized, ["ExpiredTime", "ExpirationTime", "ExpireTime", "ExpirationDate", "ExpireDate", "EndTime", "expiredTime", "expirationTime", "expireTime", "expire_time"]);
  return expiry === undefined ? "" : formatAssetDate(expiry);
}

export function MobileServerDetails({ server, cloudType }: { server: LocalAsset; cloudType?: string }) {
  const isLightServer = server.resource_type === "swas";
  const isAliyunSwas = cloudType === "aliyun" && isLightServer;
  const payload = cloudType === "baidu" && !isLightServer ? baiduServerFields(server.payload)
    : isAliyunSwas ? aliyunSwasFields(server.payload) : server.payload;

  const cpu = positiveQuantity(value(payload, ["Cpu", "CPU", "cpu", "cpuCount", "vcpu_count"]), "核");
  const memory = serverMemory(payload, cloudType, isLightServer);
  const instanceType = value(payload, ["InstanceType", "PlanId", "BundleId", "shape", "instanceType", "BundleName"]);
  const configuration = [cpu, memory].filter(Boolean).join(" / ");
  const configurationValue = configuration
    ? `${configuration}${instanceType ? ` · ${displayValue(instanceType)}` : ""}`
    : instanceType && displayValue(instanceType) !== "-" ? displayValue(instanceType) : undefined;

  const image = value(payload, ["OSName", "OsName", "OSType", "OsType", "ImageName", "ImageId", "imageId", "ImagePlatform", "BlueprintName", "BlueprintId"])
    ?? (payload.Image && typeof payload.Image === "object" ? value(payload.Image as Record<string, unknown>, ["ImageName", "ImageId", "OsType"]) : undefined);
  const disk = diskSummary(payload, isAliyunSwas);
  const accessible = payload.InternetAccessible && typeof payload.InternetAccessible === "object" ? payload.InternetAccessible as Record<string, unknown> : {};
  const network = payload.Network && typeof payload.Network === "object" ? payload.Network as Record<string, unknown> : {};
  const bandwidth = value(payload, ["Bandwidth", "InternetMaxBandwidthOut"])
    ?? value(accessible, ["InternetMaxBandwidthOut", "Bandwidth"])
    ?? value(network, ["InternetMaxBandwidthOut", "Bandwidth"]);
  const bandwidthNumber = numberValue(bandwidth);
  const publicAddress = firstAddress(value(payload, ["PublicIpAddress", "PublicIpAddresses", "PublicIp", "PublicAddresses", "InternetIp", "EipAddress"])
    ?? value(accessible, ["PublicIpAddress", "PublicIp", "PublicIpAddresses"]));
  const privateAddress = firstAddress(value(payload, ["PrivateIpAddress", "PrivateIpAddresses", "PrivateIp", "PrivateAddresses", "InnerIpAddress", "InternalIp"]));
  const publicIp = hasValue(publicAddress) ? publicAddress : "";
  const privateIp = hasValue(privateAddress) ? privateAddress : "";
  const createdAt = value(payload, ["CreationTime", "CreateTime", "CreatedTime", "createTime", "creationTime"]);
  const expiresAt = value(payload, ["ExpiredTime", "ExpirationTime", "ExpireTime", "ExpirationDate", "ExpireDate", "EndTime", "expiredTime", "expirationTime", "expireTime", "expire_time"]);

  const groups: DetailGroup[] = [
    { title: "基础配置", rows: [
      ...(configurationValue ? [{ label: isLightServer ? "套餐 / 配置" : "配置", value: configurationValue, wide: true }] : []),
      ...(image ? [{ label: "操作系统 / 镜像", value: displayValue(image), wide: true }] : []),
      ...(disk ? [{ label: "磁盘", value: disk, wide: true }] : []),
      ...(bandwidthNumber !== undefined && bandwidthNumber >= 0 ? [{ label: "公网带宽", value: `${bandwidthNumber} Mbps` }] : []),
    ] },
    { title: "网络信息", rows: [
      ...(publicIp ? [{ label: "公网 IP", value: publicIp }] : []),
      ...(privateIp ? [{ label: "私网 IP", value: privateIp }] : []),
    ] },
    { title: "生命周期", rows: [
      ...(createdAt ? [{ label: "创建时间", value: formatAssetDate(createdAt), wide: true }] : []),
      ...(expiresAt ? [{ label: "到期时间", value: formatAssetDate(expiresAt), wide: true }] : []),
    ] },
  ].filter(group => group.rows.length > 0);

  if (!groups.length) return <p className="mobile-server-detail-empty">缓存中暂无可展示的服务器详情。</p>;
  return <div className="mobile-server-configuration" aria-label="服务器配置">
    {groups.map(group => <section className="mobile-server-detail-group" key={group.title} aria-label={group.title}>
      <h4>{group.title}</h4>
      <dl>{group.rows.map(row => <div key={row.label} className={row.wide ? "mobile-server-detail-wide" : undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    </section>)}
  </div>;
}
