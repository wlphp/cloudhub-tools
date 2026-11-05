import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { BellRing, CheckCircle2, ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { runningInTauri, platformErrorMessage } from "../platform/api";
import { desktopPetClient, petSeverityLabel, sortPetAlerts, type PetAlert, type PetSnapshot } from "../platform/clients/desktopPet";

const pageSize = 6;
const emptySnapshot: PetSnapshot = { alerts: [], checkedAt: 0, lastError: null };

export function MobileMonitorAlertsPage({ compact = false, onActiveCount, refreshRef }: { compact?: boolean; onActiveCount?: (count: number) => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null> }) {
  const [snapshot, setSnapshot] = useState<PetSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!runningInTauri) {
      setError("浏览器预览无法读取本机运维预警，请在桌面或移动客户端中查看。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setSnapshot(await desktopPetClient.snapshot());
    } catch (reason) {
      setError(platformErrorMessage(reason, "读取监控预警失败，请稍后重试。"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!refreshRef) return;
    refreshRef.current = refresh;
    return () => { if (refreshRef.current === refresh) refreshRef.current = null; };
  }, [refreshRef]);

  const rangeAlerts = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const start = range === "today" ? today : range === "yesterday" ? today - 86400 : range === "7days" ? today - 6 * 86400 : 0;
    const end = range === "yesterday" ? today : range === "today" ? today + 86400 : Infinity;
    return snapshot.alerts.filter(alert => alert.updatedAt >= start && alert.updatedAt < end);
  }, [snapshot.alerts, range]);
  const alerts = useMemo(() => sortPetAlerts(rangeAlerts.filter(alert => status === "active" ? alert.active : !alert.active)), [rangeAlerts, status]);
  const pageCount = Math.max(1, Math.ceil(alerts.length / pageSize));
  const pageAlerts = alerts.slice((page - 1) * pageSize, page * pageSize);
  const activeCount = snapshot.alerts.filter(alert => alert.active && !alert.ignored).length;
  const recoveredCount = snapshot.alerts.filter(alert => !alert.active).length;
  useEffect(() => { onActiveCount?.(activeCount); }, [activeCount, onActiveCount]);

  return <div className="mobile-alerts-page">
    {!compact && <header className="mobile-alerts-heading">
      <div><p>本机运维状态</p><h1><BellRing size={21} aria-hidden="true" />监控预警</h1></div>
    </header>}
    <div className="mobile-alerts-summary" aria-label="预警统计">
      <span><i className="is-active" aria-hidden="true" />未解除 <strong>{activeCount}</strong></span>
      <span><i className="is-recovered" aria-hidden="true" />已解除 <strong>{recoveredCount}</strong></span>
    </div>
    <div className="mobile-alerts-filters" role="group" aria-label="预警状态筛选">
      <button type="button" aria-pressed={status === "active"} onClick={() => { setStatus("active"); setPage(1); }}>未解除 <span>{activeCount}</span></button>
      <button type="button" aria-pressed={status === "recovered"} onClick={() => { setStatus("recovered"); setPage(1); }}>已解除 <span>{recoveredCount}</span></button>
    </div>
    <div className="mobile-alerts-filters mobile-alerts-range" role="group" aria-label="预警时间范围">{([['today','今日'],['yesterday','昨天'],['7days','7天'],['all','全部']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setRange(value); setPage(1); }}>{label}</button>)}</div>
    {error && <p className="mobile-alerts-message" role="alert">{error}</p>}
    {snapshot.lastError && !error && <p className="mobile-alerts-message" role="status">{snapshot.lastError}</p>}
    {loading && snapshot.alerts.length === 0 ? <div className="mobile-alerts-skeleton" role="status" aria-busy="true" aria-label="正在读取监控预警"><span className="mobile-skeleton-sr">正在读取监控预警</span><div className="mobile-skeleton-summary"><i /><i /></div>{[0,1,2].map(index => <article className="mobile-alert-card mobile-alert-skeleton-card" key={index}><i /><i /><i /></article>)}</div>
      : pageAlerts.length === 0 ? <div className="mobile-alerts-empty"><CheckCircle2 size={28} aria-hidden="true" /><strong>{status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>预警由桌面端运维监控生成；未获取到数据的资源不会被当作正常。</span></div>
      : <div className="mobile-alert-list" aria-live="polite">{pageAlerts.map((alert: PetAlert) => <article className={`mobile-alert-card is-${alert.active ? alert.severity : "recovered"}`} key={alert.key}>
        <div className="mobile-alert-card-title"><span className="mobile-alert-card-icon"><ShieldAlert size={17} aria-hidden="true" /></span><strong>{alert.title}</strong><span className="mobile-alert-severity">{!alert.active ? "已解除" : alert.ignored ? "已忽略" : petSeverityLabel(alert.severity)}</span></div>
        <p>{alert.detail}</p>
        <footer><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString()}</time><span>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</span></footer>
        {alert.active && <button className="mobile-alert-action" type="button" disabled={!!busyKey} onClick={() => { setBusyKey(alert.key); void desktopPetClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => setBusyKey("")); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "恢复提醒" : "标记忽略"}</button>}
      </article>)}</div>}
    {!compact && alerts.length > 0 && <nav className="mobile-alert-pagination" aria-label="预警列表分页">
      <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(current => current - 1)}><ChevronLeft size={17} aria-hidden="true" />上一页</button>
      <span>第 <strong>{page}</strong> / {pageCount} 页 · 共 {alerts.length} 条</span>
      <button type="button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)}>下一页<ChevronRight size={17} aria-hidden="true" /></button>
    </nav>}
  </div>;
}
