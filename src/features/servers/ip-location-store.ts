import { useEffect, useSyncExternalStore } from "react";
import { ipLocationClient, type IpLocationResult } from "../../platform/clients/ip-location";

type QueryState = { data?: IpLocationResult; loading: boolean; error?: string };
export type LocationTarget = { ip: string; name: string };
type BatchState = {
  phase: "idle" | "running" | "completed" | "stopped" | "error";
  total: number; panels: number; current: number; name: string;
  success: number; failed: number; notFound: number; stopping: boolean;
};
const emptyBatch: BatchState = { phase: "idle", total: 0, panels: 0, current: 0, name: "", success: 0, failed: 0, notFound: 0, stopping: false };
let snapshot = { entries: new Map<string, QueryState>(), ready: false, error: "", batch: emptyBatch };
const subscribers = new Set<() => void>();
let hydration: Promise<void> | undefined;
let queryQueue = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const task = queryQueue.then(work);
  queryQueue = task.then(() => {}, () => {});
  return task;
}
const emit = () => subscribers.forEach(listener => listener());
export function locationAddress(ip: string) {
  const text = ip.trim().replace(/^\[|\]$/g, "");
  try { return text.includes(":") ? new URL(`http://[${text}]/`).hostname.slice(1, -1) : text; }
  catch { return text; }
}
function publish(ip: string, state: QueryState) {
  snapshot = { ...snapshot, entries: new Map(snapshot.entries).set(ip, state) };
  emit();
}
async function hydrate() {
  if (snapshot.ready) return;
  if (!hydration) hydration = ipLocationClient.list().then(rows => {
    const entries = new Map(snapshot.entries);
    for (const data of rows) entries.set(locationAddress(data.target), { data, loading: false });
    snapshot = { ...snapshot, entries, ready: true, error: "" };
    emit();
  }).catch(() => {
    snapshot = { ...snapshot, error: "读取归属地缓存失败，请点击重试" };
    emit();
    throw new Error(snapshot.error);
  }).finally(() => { hydration = undefined; });
  return hydration;
}
export function useIpLocations() {
  const state = useSyncExternalStore(listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, () => snapshot);
  useEffect(() => { void hydrate().catch(() => {}); }, []);
  return state;
}
export function queryLocation(rawIp: string) {
  return enqueue(async () => {
    try { await hydrate(); } catch { return false; }
    const ip = locationAddress(rawIp);
    if (snapshot.entries.get(ip)?.data) return true;
    publish(ip, { loading: true });
    try {
      publish(ip, { data: await ipLocationClient.query(ip), loading: false });
      return true;
    } catch {
      publish(ip, { loading: false, error: "归属地查询或保存失败，请重试" });
      return false;
    }
  });
}
export function removeLocation(ip: string) {
  return enqueue(async () => {
    const previous = snapshot.entries.get(ip)?.data;
    publish(ip, { data: previous, loading: true });
    try {
      await ipLocationClient.remove(ip);
      publish(ip, { loading: false });
      return true;
    } catch {
      publish(ip, { data: previous, loading: false, error: "删除归属地缓存失败，请重试" });
      return false;
    }
  });
}
function updateBatch(update: Partial<BatchState>) {
  snapshot = { ...snapshot, batch: { ...snapshot.batch, ...update } };
  emit();
}
export function stopLocationBatch() {
  if (snapshot.batch.phase === "running") updateBatch({ stopping: true });
}
export function dismissLocationBatch() {
  if (snapshot.batch.phase !== "running") updateBatch(emptyBatch);
}
export async function startLocationBatch(panels: LocationTarget[]) {
  if (snapshot.batch.phase === "running") return;
  updateBatch({ ...emptyBatch, phase: "running" });
  try { await hydrate(); } catch { updateBatch({ phase: "error" }); return; }
  const missing = panels.map(panel => ({ ...panel, ip: locationAddress(panel.ip) }))
    .filter(panel => panel.ip && panel.ip !== "-" && !snapshot.entries.get(panel.ip)?.data);
  const seen = new Set<string>();
  const targets = missing.filter(panel => {
    if (seen.has(panel.ip)) return false;
    seen.add(panel.ip);
    return true;
  });
  updateBatch({ total: targets.length, panels: missing.length });
  for (const [index, target] of targets.entries()) {
    if (snapshot.batch.stopping) break;
    updateBatch({ current: index + 1, name: target.name });
    const ok = await queryLocation(target.ip);
    updateBatch({
      success: snapshot.batch.success + (ok ? 1 : 0),
      failed: snapshot.batch.failed + (ok ? 0 : 1),
      notFound: snapshot.batch.notFound + (ok && snapshot.entries.get(target.ip)?.data?.found === false ? 1 : 0),
    });
  }
  const finished = snapshot.batch.success + snapshot.batch.failed === snapshot.batch.total;
  updateBatch({ phase: finished ? "completed" : "stopped", name: "" });
}
export function locationRegion(data?: IpLocationResult) {
  if (!data) return "未获取";
  if (!data.found) return "未收录 / 内网";
  const location = data.location;
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const country = text(location?.country);
  const province = text(location?.province);
  if (country && !["中国", "中国大陆", "China", "CN"].includes(country)) return country;
  return province || country || text(location?.city) || "未知地区";
}
