import { useEffect, useMemo, useState } from "react";
import { Activity, BellRing, CheckCircle2, Cloud, Database, HardDrive, RefreshCw, Server, ShieldAlert, Clock3, Layers3 } from "lucide-react";
import type { Account, LocalAsset } from "../../shared/types";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { desktopPetClient, petSeverityLabel, sortPetAlerts, type PetAlert, type PetSnapshot } from "../../platform/clients/desktopPet";

const emptySnapshot: PetSnapshot = { alerts: [], checkedAt: 0, lastError: null };
const resourceKinds = [
  { key: "ecs", label: "云服务器", color: "#4f8df7", icon: Server },
  { key: "swas", label: "轻量服务器", color: "#28a879", icon: HardDrive },
  { key: "domain", label: "域名", color: "#9b72e8", icon: Cloud },
  { key: "oss", label: "对象存储", color: "#e6a23c", icon: Database },
  { key: "other", label: "其他资源", color: "#8290a5", icon: Activity },
];

function Donut({ values, label }: { values: { label: string; value: number; color: string }[]; label: string }) {
  const total = values.reduce((sum, item) => sum + item.value, 0);
  let offset = 0;
  return <div className="desktop-overview-donut-wrap">
    <svg className="desktop-overview-donut" viewBox="0 0 120 120" role="img" aria-label={`${label}，共 ${total} 项`}>
      <circle cx="60" cy="60" r="48" fill="none" stroke="var(--jb-border)" strokeWidth="14" />
      {total > 0 && values.filter(item => item.value > 0).map(item => {
        const length = item.value / total * 301.59;
        const circle = <circle key={item.label} cx="60" cy="60" r="48" fill="none" stroke={item.color} strokeWidth="14" strokeDasharray={`${length} ${301.59 - length}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />;
        offset += length;
        return circle;
      })}
      <text x="60" y="56" textAnchor="middle" className="desktop-overview-donut-total">{total}</text>
      <text x="60" y="74" textAnchor="middle" className="desktop-overview-donut-caption">{label}</text>
    </svg>
    <ul className="desktop-overview-legend">{values.map(item => <li key={item.label}><span><i style={{ background: item.color }} />{item.label}</span><strong>{item.value}</strong></li>)}</ul>
  </div>;
}

export function DesktopHomePage({ accounts, assets, onNavigate }: { accounts: Account[]; assets: LocalAsset[]; onNavigate: (section: "accounts" | "resources" | "monitorAlerts") => void }) {
  const [activeAlerts, setActiveAlerts] = useState<number | null>(null);
  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    void desktopPetClient.snapshot().then(snapshot => { if (active) setActiveAlerts(snapshot.alerts.filter(alert => alert.active).length); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const counts = resourceKinds.map(kind => ({ ...kind, value: kind.key === "other" ? assets.filter(asset => !["ecs", "swas", "domain", "oss"].includes(asset.resource_type)).length : assets.filter(asset => asset.resource_type === kind.key).length }));
  const providers = Array.from(accounts.reduce((map, account) => map.set(account.cloud_type, (map.get(account.cloud_type) ?? 0) + 1), new Map<string, number>())).sort((a, b) => b[1] - a[1]);
  const now = Date.now() / 1000;
  const latestFetch = assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at || 0), 0);
  const staleAssets = assets.filter(asset => asset.fetched_at > 0 && now - asset.fetched_at > 7 * 86400).length;
  const formatFetchedAt = (timestamp: number) => timestamp ? new Date(timestamp * 1000).toLocaleString() : "暂无采集记录";
  return <section className="desktop-overview-page">
    <header className="desktop-overview-header"><div><span className="eyebrow">LOCAL CONSOLE</span><h1>首页</h1><p>云账号与本机已保存资源概况</p></div></header>
    <div className="desktop-overview-kpis">
      <button type="button" onClick={() => onNavigate("accounts")}><span><Cloud size={17} />云账号</span><strong>{accounts.length}</strong><small>已启用 {accounts.filter(account => account.enabled).length}</small></button>
      <button type="button" onClick={() => onNavigate("resources")}><span><HardDrive size={17} />已保存资源</span><strong>{assets.length}</strong><small>本机资产清单</small></button>
      <button type="button" onClick={() => onNavigate("monitorAlerts")}><span><BellRing size={17} />未解除预警</span><strong className="is-warning">{activeAlerts === null ? "—" : activeAlerts}</strong><small>{activeAlerts === null ? "本机监控状态" : "查看监控预警明细"}</small></button>
    </div>
    <div className="desktop-overview-grid">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>资源类型分布</h2><p>按本机已保存的云资源统计</p></div><Database size={18} aria-hidden="true" /></div><Donut values={counts.map(({ label, value, color }) => ({ label, value, color }))} label="资源" /></article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>快捷入口</h2><p>常用管理页面</p></div><Activity size={18} aria-hidden="true" /></div><div className="desktop-overview-shortcuts"><button onClick={() => onNavigate("accounts")}><Cloud />账号管理<span>查看云账号与同步状态</span></button><button onClick={() => onNavigate("resources")}><HardDrive />资产管理<span>查看已获取的云资源</span></button><button onClick={() => onNavigate("monitorAlerts")}><BellRing />监控预警<span>检查未解除与历史预警</span></button></div></article>
    </div>
    <div className="desktop-overview-grid desktop-overview-details">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>云厂商账号</h2><p>{providers.length} 个厂商 · {accounts.filter(account => !account.enabled).length} 个未启用</p></div><Layers3 size={18} aria-hidden="true" /></div>
        {providers.length ? <ul className="desktop-overview-provider-list">{providers.map(([provider, count]) => <li key={provider}><span><i />{provider}</span><strong>{count} 个账号</strong></li>)}</ul> : <p className="desktop-overview-muted">添加云账号后，这里会显示各厂商账号分布。</p>}
      </article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>资源采集状态</h2><p>仅统计本机已保存的采集记录</p></div><Clock3 size={18} aria-hidden="true" /></div>
        <div className="desktop-overview-freshness"><div><span>最近采集</span><strong>{formatFetchedAt(latestFetch)}</strong></div><div><span>超过 7 天未更新</span><strong className={staleAssets ? "is-warning" : ""}>{staleAssets} 项</strong></div><button type="button" onClick={() => onNavigate("resources")}>查看资源清单</button></div>
      </article>
    </div>
  </section>;
}

type AlertProductSection = PetAlert["section"];
const alertProductLabels: Record<AlertProductSection, string> = { panels: "面板", resources: "资源", certificates: "证书", notes: "备忘录" };

export function DesktopMonitorAlertsPage({ onNavigate }: { onNavigate: (section: AlertProductSection) => void }) {
  const [snapshot, setSnapshot] = useState<PetSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const refresh = async () => {
    if (!runningInTauri) { setError("浏览器预览无法读取本机运维预警，请在桌面客户端中查看。"); return; }
    setLoading(true); setError("");
    try { setSnapshot(await desktopPetClient.snapshot()); }
    catch (reason) { setError(platformErrorMessage(reason, "读取监控预警失败，请稍后重试。")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const activeCount = snapshot.alerts.filter(alert => alert.active && !alert.ignored).length;
  const ignoredCount = snapshot.alerts.filter(alert => alert.active && alert.ignored).length;
  const recoveredCount = snapshot.alerts.filter(alert => !alert.active).length;
  const rangeAlerts = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const tomorrow = today + 86400;
    const start = range === "today" ? today : range === "yesterday" ? today - 86400 : range === "7days" ? today - 6 * 86400 : 0;
    const end = range === "yesterday" ? today : range === "today" ? tomorrow : Infinity;
    return snapshot.alerts.filter(alert => alert.updatedAt >= start && alert.updatedAt < end);
  }, [snapshot.alerts, range]);
  const alerts = useMemo(() => sortPetAlerts(rangeAlerts.filter(alert => status === "active" ? alert.active : !alert.active)), [rangeAlerts, status]);
  const productSummary = (["panels", "resources", "certificates", "notes"] as const).map((section, i) => ({ label: ["面板", "资源", "证书", "备忘录"][i], count: rangeAlerts.filter(alert => alert.active && !alert.ignored && alert.section === section).length })).filter(item => item.count > 0);
  const severity = (["emergency", "critical", "warning"] as const).map((level, index) => ({ label: petSeverityLabel(level), value: rangeAlerts.filter(alert => alert.active && !alert.ignored && alert.severity === level).length, color: ["#dc4c4c", "#e88032", "#d5a323"][index] }));
  const checkedLabel = snapshot.checkedAt ? new Date(snapshot.checkedAt * 1000).toLocaleString() : "尚无检查记录";
  return <section className="desktop-overview-page">
    <header className="desktop-overview-header"><div><span className="eyebrow">LOCAL OPERATIONS</span><h1><BellRing size={23} />监控预警</h1><p>来自本机桌面运维监控的状态与历史事件</p></div><button className="secondary" type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "desktop-overview-spin" : undefined} />{loading ? "读取中…" : "刷新"}</button></header>
    {error && <p className="desktop-overview-message" role="alert">{error}</p>}{snapshot.lastError && !error && <p className="desktop-overview-message" role="status">{snapshot.lastError}</p>}
    <div className="desktop-overview-grid desktop-alert-grid">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>预警状态</h2><p>本机监控记录 · 最近检查：{checkedLabel}</p></div><ShieldAlert size={19} /></div><div className="desktop-overview-kpis compact"><button type="button" aria-pressed={status === "active"} onClick={() => setStatus("active")}><span>未解除</span><strong className="is-warning">{activeCount}</strong></button><button type="button" aria-pressed={status === "recovered"} onClick={() => setStatus("recovered")}><span>已解除</span><strong>{recoveredCount}</strong></button></div><Donut values={severity} label="未解除" /><div className="desktop-alert-products"><h3>预警产品汇总 <small>当前范围内 · 未解除且未忽略</small></h3>{productSummary.length ? productSummary.map(item => <div key={item.label}><span>{item.label}</span><strong>{item.count}</strong></div>) : <p>当前范围暂无未处理预警</p>}{ignoredCount > 0 && <p className="desktop-alert-ignored-note">另有 {ignoredCount} 条已忽略预警（历史保留）</p>}</div></article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>{status === "active" ? "未解除预警" : "已解除预警"}</h2><p>{alerts.length} 条记录</p></div><span>{loading ? "更新中" : "状态明细"}</span></div>
        <div className="desktop-alert-range" role="group" aria-label="预警时间范围">{([['today','今日'],['yesterday','昨天'],['7days','7天'],['all','全部']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div>
        {alerts.length === 0 ? <div className="desktop-alert-empty"><CheckCircle2 size={25} /><strong>{status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>未获取到数据的资源不会被视为正常。</span></div> : <div className="desktop-alert-list">{alerts.map((alert: PetAlert) => <article key={alert.key} className={`desktop-alert-row is-${alert.active ? alert.severity : "recovered"}`}><div className="desktop-alert-row-title"><ShieldAlert size={17} /><strong>{alert.title}</strong><span>{!alert.active ? "已解除" : alert.ignored ? "已忽略" : petSeverityLabel(alert.severity)}</span></div><p>{alert.detail}</p><footer><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString()}</time><span>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</span></footer><div className="desktop-alert-row-actions"><button className="secondary desktop-alert-view" type="button" onClick={() => onNavigate(alert.section)} aria-label={`查看${alertProductLabels[alert.section]}：${alert.title}`}>查看{alertProductLabels[alert.section]}</button>{alert.active && <button className="secondary desktop-alert-action" type="button" disabled={!!busyKey} onClick={() => { setBusyKey(alert.key); void desktopPetClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => setBusyKey("")); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "恢复提醒" : "标记忽略"}</button>}</div></article>)}</div>}
      </article>
    </div>
  </section>;
}
