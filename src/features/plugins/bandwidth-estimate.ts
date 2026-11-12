import type { SpeedRun } from "../../platform/clients/speed-test";

// Convert measured megabits per second to megabytes per second.
export function estimateBandwidth(run: SpeedRun | null): string | null {
  const mbps = run?.downloadMbps;
  if (run?.status !== "completed" || mbps == null || !Number.isFinite(mbps) || mbps <= 0) return null;
  const megabytesPerSecond = mbps / 8;
  return megabytesPerSecond < .1 ? "不足 0.1 MB/s" : `约 ${megabytesPerSecond.toFixed(1)} MB/s`;
}
