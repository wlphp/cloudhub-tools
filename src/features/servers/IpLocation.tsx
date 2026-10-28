import { useState, useSyncExternalStore } from "react";
import { MapPin, RefreshCw } from "lucide-react";
import { ipLocationClient, type IpLocationResult } from "../../platform/clients/ip-location";
import { SharedDialog } from "../../shared/SharedDialog";

type QueryState = { data?: IpLocationResult; loading: boolean; error?: string };
const empty: QueryState = { loading: false };
const cache = new Map<string, QueryState>();
const subscribers = new Set<() => void>();
function subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; }
function publish(ip: string, value: QueryState) {
  cache.set(ip, value);
  if (cache.size > 256) {
    const oldest = [...cache.keys()].find(key => key !== ip && !cache.get(key)?.loading);
    if (oldest) cache.delete(oldest);
  }
  subscribers.forEach(listener => listener());
}
async function query(ip: string) {
  if (cache.get(ip)?.loading) return;
  const previous = cache.get(ip)?.data;
  publish(ip, { data: previous, loading: true });
  try { publish(ip, { data: await ipLocationClient.query(ip), loading: false }); }
  catch { publish(ip, { data: previous, loading: false, error: "归属地查询失败，请稍后重试" }); }
}

const labels: Record<string, string> = {
  feature: "查询类型", target: "IP 地址", found: "已收录", location: "归属地",
  country: "国家 / 地区", province: "省份", city: "城市", isp: "运营商", display: "归属地摘要",
  longitude: "经度", latitude: "纬度", has_coordinates: "包含坐标", checked_at: "查询时间", request_id: "请求编号",
};
function FieldValue({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (value == null || value === "") return <>暂无</>;
  if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
  if (name === "checked_at" && typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value * 1000).getTime())) return <>{new Date(value * 1000).toLocaleString("zh-CN")}</>;
  if (name === "feature" && value === "ip") return <>IP 归属地查询</>;
  if (typeof value === "object") return depth < 6 ? <Fields data={value} depth={depth + 1} /> : <pre>{JSON.stringify(value, null, 2)}</pre>;
  return <>{String(value)}</>;
}
function Fields({ data, depth = 0 }: { data: object; depth?: number }) {
  return <dl className="ip-location-fields">{Object.entries(data).map(([key, value]) => <div key={key}><dt>{labels[key] || key}</dt><dd><FieldValue name={key} value={value} depth={depth} /></dd></div>)}</dl>;
}

export function IpLocation({ ip }: { ip: string }) {
  const address = ip.trim();
  const state = useSyncExternalStore(subscribe, () => cache.get(address) || empty);
  const [open, setOpen] = useState(false);
  if (!address || address === "-") return null;
  const { data, loading, error } = state;
  const location = data?.location;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const summary = data ? data.found
    ? text(location?.display) || [location?.province, location?.city, location?.isp].map(text).filter(Boolean).join("/") || text(location?.country) || "暂无归属地信息"
    : "未收录或为内网 / 保留地址" : "";
  return <div className="ip-location-row">
    <div className="ip-location-summary" aria-live="polite" aria-busy={loading}>
      {data ? <><span className="ip-location-result" title={summary}><MapPin size={12} aria-hidden="true" /><span>{summary}</span></span><button type="button" className="ip-location-action" onClick={() => setOpen(true)} aria-label={`查看 ${address} 的归属地详情`}>查看</button></>
        : <button type="button" className="ip-location-action" disabled={loading} title="使用宝塔查询此 IP 的归属地" onClick={() => void query(address)}>{loading ? <RefreshCw size={12} className="spin" aria-hidden="true" /> : <MapPin size={12} aria-hidden="true" />}{loading ? "获取中…" : error ? "重新获取归属地" : "一键获取归属地"}</button>}
    </div>
    {error && <small role="alert" className="ip-location-error">{error}</small>}
    {open && <SharedDialog title="IP 归属地详情" subtitle={`${address} · 使用宝塔服务查询`} icon={<MapPin size={18} aria-hidden="true" />} className="ip-location-dialog" onClose={() => setOpen(false)} busy={loading} footer={<><button type="button" className="secondary" onClick={() => setOpen(false)}>关闭</button><button type="button" className="primary" disabled={loading} onClick={() => void query(address)}><RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? "正在拉取…" : "重新拉取最新信息"}</button></>}>
      {error && <p role="alert">{error}，当前保留上次查询结果。</p>}
      <p className="ip-location-overview" aria-live="polite">{summary}</p>
      {data && <><Fields data={data} /><details className="ip-location-raw"><summary>接口原始返回</summary><pre>{JSON.stringify(data, null, 2)}</pre></details></>}
    </SharedDialog>}
  </div>;
}
