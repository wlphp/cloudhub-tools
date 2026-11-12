// ListInstances also retains these nested fields in older local caches.
export function aliyunSwasFields(item: Record<string, unknown>): Record<string, unknown> {
  const spec = item.ResourceSpec as Record<string, unknown> | null | undefined;
  const image = item.Image as Record<string, unknown> | null | undefined;
  const disks = Array.isArray(item.Disks) ? item.Disks as Record<string, unknown>[] : [];
  const systemDisk = disks.find(disk => disk?.DiskType === "system");
  return {
    ...item,
    Cpu: spec?.Cpu ?? item.Cpu,
    MemoryInGB: spec?.Memory ?? item.MemoryInGB,
    Bandwidth: spec?.Bandwidth ?? item.Bandwidth,
    SystemDiskSize: systemDisk?.Size ?? spec?.DiskSize ?? item.SystemDiskSize,
    PrivateIpAddress: item.InnerIpAddress ?? item.PrivateIpAddress,
    CreateTime: item.CreationTime ?? item.CreateTime,
    ImageName: image?.ImageName ?? item.ImageName,
    OSType: image?.OsType ?? item.OSType,
  };
}
