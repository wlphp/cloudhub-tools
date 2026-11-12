import { CheckCircle2, MapPin, RefreshCw, Square, X } from "lucide-react";
import { dismissLocationBatch, startLocationBatch, stopLocationBatch, useIpLocations, type LocationTarget } from "./ip-location-store";

export function PanelIpLocationProgress({ panels }: { panels: LocationTarget[] }) {
  const { batch } = useIpLocations();
  if (batch.phase === "idle") return null;
  const running = batch.phase === "running";
  const done = batch.success + batch.failed;
  const remaining = batch.total - done;
  const title = running ? batch.stopping ? "正在停止，等待当前查询完成…" : batch.total ? `共 ${batch.total} 个 IP，正在获取第 ${batch.current} / ${batch.total} 个` : "正在准备获取归属地…"
    : batch.phase === "error" ? "读取本地缓存失败，请重试"
    : batch.phase === "stopped" ? `已停止获取：已处理 ${done} / ${batch.total} 个 IP`
    : batch.failed ? `本轮获取结束：已处理全部 ${batch.total} 个 IP，${batch.failed} 个失败`
    : `归属地全部获取完毕，共 ${batch.total} 个 IP`;
  return <section className="panel-location-progress" aria-label="归属地批量获取进度" aria-busy={running}>
    <div className="panel-location-progress-main" role="status" aria-live="polite">
      {running ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : batch.failed || batch.phase === "error" || batch.phase === "stopped" ? <MapPin size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
      <div><strong>{title}</strong><p>{batch.total > 0 && <>涉及 {batch.panels} 台面板，重复 IP 合并查询 · 已保存 {batch.success} · 失败 {batch.failed}{batch.notFound > 0 && ` · 未收录 / 内网 ${batch.notFound}（已缓存）`}{remaining > 0 && ` · 待处理 ${remaining}`}</>}{running && batch.name && <span className="panel-location-current">当前：{batch.name}</span>}</p></div>
    </div>
    {running && <progress value={done} max={batch.total || 1} aria-label="已处理 IP 数量" />}
    <div className="panel-location-progress-actions">
      {running ? <button type="button" className="secondary" disabled={batch.stopping} onClick={stopLocationBatch}><Square size={13} aria-hidden="true" />停止后续获取</button>
        : <>{(batch.failed > 0 || remaining > 0 || batch.phase === "error") && <button type="button" className="secondary" onClick={() => void startLocationBatch(panels)}><RefreshCw size={14} aria-hidden="true" />重试未完成</button>}<button type="button" className="secondary" aria-label="关闭归属地获取总结" title="关闭总结" onClick={dismissLocationBatch}><X size={14} aria-hidden="true" /></button></>}
    </div>
  </section>;
}
