import { nativeOnly } from "./base";

export type SpeedTestConfig = { node: "cn-qiniu" | "cn-alipay" | "cloudflare" | "custom"; baseUrl: string; durationSecs: number; limitMib: number };
export type SpeedNetworkInfo = { publicIp: string | null; localIp: string | null; location: string | null; source: string; checkedAt: number; warning: string | null };
export type SpeedPoint = { seconds: number; mbps: number; direction: "download" | "upload" };
export type SpeedRun = {
  id: string; node: string; endpoint: string; colo: string;
  status: "running" | "completed" | "cancelled" | "failed";
  phase: "connecting" | "latency" | "download" | "upload";
  startedAt: number; finishedAt: number | null; elapsedSecs: number;
  durationSecs: number; limitMib: number;
  downloadMbps: number | null; uploadMbps: number | null; latencyMs: number | null; jitterMs: number | null;
  trafficBytes: number; points: SpeedPoint[]; warnings: string[]; error: string | null;
};
export const speedTestClient = {
  networkInfo: () => nativeOnly<SpeedNetworkInfo>("speed_test_network_info"),
  status: () => nativeOnly<SpeedRun | null>("speed_test_status"),
  start: (config: SpeedTestConfig) => nativeOnly<SpeedRun>("speed_test_start", { config }),
  cancel: (id: string) => nativeOnly<void>("speed_test_cancel", { id }),
  history: () => nativeOnly<SpeedRun[]>("speed_test_history"),
};
