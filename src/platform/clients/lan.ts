import { nativeOnly } from "./base";

export type LanInterface = { id: string; name: string; ip: string; prefix: number; gateway: string; network: string; networkKey: string; suggestedRange: string };
export type LanDevice = { ip: string; mac: string; hostname: string; vendor: string; kind: string; evidence: string[]; ports: number[]; latencyMs: number | null; lastSeen: number; alias: string; note: string; tags: string; favorite: boolean; manualKind: string; os?: string; osStatus?: string; model?: string; macKind?: string; manualOs?: string };
export type LanScan = { id: string; networkKey: string; interfaceId: string; range: string; status: "running" | "completed" | "cancelled" | "failed"; completed: number; total: number; startedAt: number; finishedAt: number | null; devices: LanDevice[]; warnings: string[] };
export type LanLedger = { devices: LanDevice[]; history: LanScan[] };
export type LanAnnotation = Pick<LanDevice, "alias" | "note" | "tags" | "favorite" | "manualKind" | "manualOs"> & { networkKey: string; deviceKey: string };
export const DEFAULT_LAN_PORTS = "22,80,443,445,3389,631,9100,554";
export const lanDeviceKey = (d: LanDevice) => d.mac ? `mac:${d.mac}` : `ip:${d.ip}`;
export const lanService = (port: number) => ({ 22: "SSH", 80: "HTTP", 443: "HTTPS", 445: "SMB", 3389: "RDP", 631: "IPP", 9100: "打印", 554: "RTSP", 8080: "HTTP（常用）", 8443: "HTTPS（常用）" }[port] ?? "TCP");
export const lanClient = {
  interfaces: () => nativeOnly<LanInterface[]>("lan_interfaces"),
  status: () => nativeOnly<LanScan | null>("lan_status"),
  start: (i: LanInterface, range: string, ports: number[]) => nativeOnly<LanScan>("lan_start", { interfaceId: i.id, sourceIp: i.ip, networkKey: i.networkKey, range, ports }),
  cancel: (id: string) => nativeOnly<void>("lan_cancel", { id }),
  ledger: (networkKey: string) => nativeOnly<LanLedger>("lan_ledger", { networkKey }),
  annotate: (input: LanAnnotation) => nativeOnly<void>("lan_annotate", { input }),
  export: (networkKey: string, format: "csv" | "json") => nativeOnly<string | null>("lan_export", { networkKey, format }),
};
