// Recover fields retained in older BCC caches as well as current normalized payloads.
export function baiduServerFields(item: Record<string, unknown>): Record<string, unknown> {
  const raw = item._raw && typeof item._raw === "object" ? item._raw as Record<string, unknown> : item;
  const memory = Number(raw.memoryCapacityInGB);
  const os = [raw.osName, raw.osVersion].filter(Boolean).join(" ");
  const nic = raw.nicInfo && typeof raw.nicInfo === "object" ? raw.nicInfo as Record<string, unknown> : {};
  const primaryIp = Array.isArray(nic.ips) ? nic.ips.find(ip => ip && (ip.primary === true || ip.primary === "true")) : undefined;
  const eipBandwidth = Number(primaryIp?.eipSize);
  const volumes = Array.isArray(raw.volumes) ? raw.volumes : [];
  return {
    ...item,
    Cpu: item.Cpu ?? raw.cpuCount,
    Memory: item.Memory ?? (Number.isFinite(memory) && memory > 0 ? memory * 1024 : undefined),
    MemoryInGB: item.MemoryInGB ?? (Number.isFinite(memory) && memory > 0 ? memory : undefined),
    InternetMaxBandwidthOut: Number.isFinite(eipBandwidth) && eipBandwidth > 0 ? eipBandwidth : item.InternetMaxBandwidthOut ?? raw.networkCapacityInMbps,
    OSName: os || raw.imageName || item.OSName,
    ImageId: item.ImageId ?? raw.imageId,
    CreationTime: item.CreationTime ?? raw.createTime,
    ExpiredTime: item.ExpiredTime ?? raw.expireTime,
    PaymentTiming: item.PaymentTiming ?? raw.paymentTiming,
    Disks: Array.isArray(item.Disks) ? item.Disks : volumes.filter(disk => disk && typeof disk === "object").map(disk => ({
      DiskId: disk.volumeId, DiskName: disk.isSystemVolume === true ? "系统盘" : "数据盘",
      Size: disk.diskSizeInGB, Category: disk.storageType ?? disk.type, Status: disk.status,
    })),
  };
}
