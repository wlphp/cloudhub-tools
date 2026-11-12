import { useState } from "react";
import { MapPin, RefreshCw, Trash2 } from "lucide-react";
import { locationAddress, useIpLocations, queryLocation as query, removeLocation } from "./ip-location-store";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";

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
  const address = locationAddress(ip);
  const store = useIpLocations();
  const state = store.entries.get(address);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!address || address === "-") return null;
  const data = state?.data;
  const loading = state?.loading || (!store.ready && !store.error);
  const error = state?.error || store.error;
  const location = data?.location;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const summary = data ? data.found
    ? text(location?.display) || [location?.province, location?.city, location?.isp].map(text).filter(Boolean).join("/") || text(location?.country) || "暂无归属地信息"
    : "未收录或为内网 / 保留地址" : "";
  return <div className="ip-location-row">
    <div className="ip-location-summary" aria-live="polite" aria-busy={loading}>
      {data ? <><span className="ip-location-result" title={summary}><MapPin size={12} aria-hidden="true" /><span>{summary}</span></span><button type="button" className="ip-location-action" onClick={() => setOpen(true)} aria-label={`查看 ${address} 的归属地详情`}>查看</button></>
        : <button type="button" className="ip-location-action" disabled={loading || store.batch.phase === "running"} title={store.batch.phase === "running" ? "正在按列表顺序获取，请等待批量任务结束" : "使用宝塔查询此 IP 的归属地"} onClick={() => void query(address)}>{loading ? <RefreshCw size={12} className="spin" aria-hidden="true" /> : <MapPin size={12} aria-hidden="true" />}{loading ? "获取中…" : error ? "重新获取归属地" : "一键获取归属地"}</button>}
    </div>
    {error && <small role="alert" className="ip-location-error">{error}</small>}
    {open && <SharedDialog sizeStorageKey="features/servers/ip-location/ip-location" title="IP 归属地详情" subtitle={`${address} · 已保存到本地 SQLite，删除前不会重复查询`} icon={<MapPin size={18} aria-hidden="true" />} className="ip-location-dialog" onClose={() => setOpen(false)} busy={loading} footer={<><button type="button" className="secondary" onClick={() => setOpen(false)}>关闭</button><button type="button" className="secondary" disabled={loading || store.batch.phase === "running"} onClick={() => setConfirmDelete(true)}><Trash2 size={14} aria-hidden="true" />删除归属地缓存</button></>}>
      {error && <p role="alert">{error}，当前保留上次查询结果。</p>}
      <p className="ip-location-overview" aria-live="polite">{summary}</p>
      {data && <><Fields data={data} /><details className="ip-location-raw"><summary>接口原始返回</summary><pre>{JSON.stringify(data, null, 2)}</pre></details></>}
    </SharedDialog>}
    {confirmDelete && <ConfirmDialog title="删除归属地缓存" message="确认删除此 IP 的本地归属地记录吗？所有使用此 IP 的卡片都会清除归属地，之后可手动重新获取。" confirmLabel="删除缓存" busy={loading} error={state?.error} onResolve={confirmed => {
      if (!confirmed) { setConfirmDelete(false); return; }
      void removeLocation(address).then(removed => { if (removed) { setConfirmDelete(false); setOpen(false); } });
    }} />}
  </div>;
}
