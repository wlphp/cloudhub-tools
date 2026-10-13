type MetricRecord = Record<string, unknown>;

function record(value: unknown): MetricRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as MetricRecord : {};
}

function metric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.length > 48) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function load(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length > 96 || !/^[\d.+,\s-]+$/.test(value)) return null;
  return value;
}

export function aiMonitorSummary(metrics: MetricRecord): string {
  const cpu = record(metrics.cpu);
  const memory = record(metrics.memory);
  const swap = record(metrics.swap);
  const network = record(metrics.network);
  const disk = record(metrics.disk_io);
  return JSON.stringify({
    load: load(metrics.load),
    processes: metric(metrics.processes),
    active_processes: metric(metrics.active_processes),
    cpu: { cores: metric(cpu.cores), usage_percent: metric(cpu.usage) },
    memory: { used_bytes: metric(memory.used), total_bytes: metric(memory.total) },
    swap: { used_bytes: metric(swap.used), total_bytes: metric(swap.total) },
    network: {
      upload_rate_bytes: metric(network.up_rate), download_rate_bytes: metric(network.down_rate),
      uploaded_bytes: metric(network.up_total), downloaded_bytes: metric(network.down_total),
    },
    disk_io: {
      read_bytes: metric(disk.read), write_bytes: metric(disk.write), latency_ms: metric(disk.latency), iops: metric(disk.iops),
    },
  });
}

/** Keep panel monitor context to bounded, numeric measurements; omit host and account metadata. */
export function aiPanelMonitorSummary(input: {
  status: string;
  load: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercentages: Array<number | null>;
}): string {
  const percent = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  const load = input.load.length <= 64 && /^[\d.+,/\s-]+$/.test(input.load) ? input.load : "-";
  return JSON.stringify({
    status: ["online", "offline", "unknown"].includes(input.status) ? input.status : "unknown",
    load,
    cpu_usage_percent: percent(input.cpuPercent),
    memory_usage_percent: percent(input.memoryPercent),
    disk_usage_percentages: input.diskPercentages.slice(0, 12).map(percent),
  });
}
