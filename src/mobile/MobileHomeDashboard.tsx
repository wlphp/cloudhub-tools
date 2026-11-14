import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { Account, LocalAsset } from "../shared/types";
import type { MobileFeatureDestination } from "./MobileMorePage";
import { runningInTauri } from "../platform/api";
import { certificatesClient, type CertificateSummary } from "../platform/clients/certificates";
import { monitorAlertsClient, type MonitorSnapshot } from "../platform/clients/monitorAlerts";
import { homeStatistics } from "./home-statistics";
import "./home-dashboard.css";

type Props = { accounts: Account[]; assets: LocalAsset[]; assetError?: boolean; onActiveAlertCount: (count: number | null) => void; onNavigate: (tab: MobileFeatureDestination | "monitorAlerts") => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null> };
const destinations: Record<string, MobileFeatureDestination> = { ecs: "servers", swas: "servers", domain: "domains", oss: "storage", rds: "databases", redis: "redis" };
const dateLabel = (value: number) => new Date(value < 100_000_000_000 ? value * 1000 : value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function MobileHomeDashboard({ accounts, assets, assetError, onActiveAlertCount, onNavigate, refreshRef }: Props) {
  const [dimension, setDimension] = useState<"types" | "providers">("types");
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [certificates, setCertificates] = useState<CertificateSummary[]>([]);
  const [certificateError, setCertificateError] = useState(false);
  const [certificatesLoaded, setCertificatesLoaded] = useState(false);
  const [monitorError, setMonitorError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now);
  const revision = useRef(0);
  const lastActiveCount = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    const token = ++revision.current;
    setLoading(true);
    const [monitor, certs] = await Promise.allSettled([runningInTauri ? monitorAlertsClient.snapshot() : Promise.resolve(null), certificatesClient.summaries()]);
    if (token !== revision.current) return;
    setNow(Date.now());
    if (monitor.status === "fulfilled" && (!monitor.value || (Array.isArray(monitor.value.alerts) && Number.isFinite(monitor.value.checkedAt)))) {
      setSnapshot(monitor.value);
      setMonitorError(Boolean(monitor.value?.lastError));
      lastActiveCount.current = monitor.value && monitor.value.checkedAt > 0 ? monitor.value.alerts.filter(alert => alert.active && !alert.ignored).length : null;
      onActiveAlertCount(lastActiveCount.current);
    } else { setMonitorError(true); onActiveAlertCount(lastActiveCount.current); }
    if (certs.status === "fulfilled" && Array.isArray(certs.value)) { setCertificates(certs.value); setCertificateError(false); setCertificatesLoaded(true); }
    else setCertificateError(true);
    setLoading(false);
  }, [onActiveAlertCount]);
  useEffect(() => {
    void refresh();
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, 60000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    if (refreshRef) refreshRef.current = refresh;
    return () => { revision.current++; window.clearInterval(timer); window.removeEventListener("focus", visibleRefresh); document.removeEventListener("visibilitychange", visibleRefresh); if (refreshRef?.current === refresh) refreshRef.current = null; };
  }, [refresh, refreshRef]);
  const stats = useMemo(() => homeStatistics(assets, accounts, certificates, now), [assets, accounts, certificates, now]);
  const active = snapshot?.alerts.filter(alert => alert.active && !alert.ignored) ?? [];
  const known = Boolean(snapshot && snapshot.checkedAt > 0);
  const count = known ? active.length : "—";
  const groups = [
    { label: "超级严重", count: active.filter(alert => alert.severity === "emergency").length, tone: "danger" },
    { label: "紧急", count: active.filter(alert => alert.severity === "critical").length, tone: "warning" },
    { label: "提醒", count: active.filter(alert => alert.severity === "warning").length, tone: "accent" },
  ];
  const rows = stats[dimension];
  const max = Math.max(1, ...rows.map(row => row.count));
  const assetAvailable = !assetError || assets.length > 0;
  const expiryBuckets = [{ label: "已过期", count: stats.expiry.expired, tone: "danger" }, { label: "7天内", count: stats.expiry.week, tone: "warning" }, { label: "8–30天", count: stats.expiry.month, tone: "accent" }, { label: "30天后", count: stats.expiry.later, tone: "muted" }];
  const expiryMax = Math.max(1, ...expiryBuckets.map(row => row.count));
  return <section className="home-dashboard" aria-label="资产与风险概览" aria-busy={loading}>
    <header className="home-dashboard-heading"><div><p>本地资源看板</p><h1>资产与风险概览</h1></div><span>本机数据</span></header>
    <div className="home-stat-grid">
      {[{ label: "资产总数", value: assetAvailable ? assets.length : "—", destination: "assets" }, { label: "云账号", value: accounts.length, destination: "accounts" }, { label: "待处理预警", value: count, destination: "monitorAlerts" }, { label: "30天内到期", value: assetAvailable && certificatesLoaded && !certificateError ? stats.expiry.week + stats.expiry.month : "—", destination: "assets" }].map(metric => <button type="button" key={metric.label} onClick={() => onNavigate(metric.destination as MobileFeatureDestination | "monitorAlerts")}><span>{metric.label}<ArrowUpRight size={14} aria-hidden="true" /></span><strong>{metric.value}</strong><small>{metric.label === "30天内到期" ? "含独立证书 · 不含已过期" : metric.label === "待处理预警" ? known ? "未解除且未忽略" : loading ? "正在读取" : "状态未知" : "查看列表"}</small></button>)}
    </div>
    {assetError && <p className="home-dashboard-notice" role="status">资产缓存读取失败{assets.length ? "，保留上次数据" : "，资产统计暂不可用"}。</p>}
    <section className="home-chart-card" aria-label="资产分布">
      <header><h2>资产分布</h2><div className="home-chart-switch" role="group" aria-label="资产统计维度"><button type="button" aria-pressed={dimension === "types"} onClick={() => setDimension("types")}>按类型</button><button type="button" aria-pressed={dimension === "providers"} onClick={() => setDimension("providers")}>按云厂商</button></div></header>
      {rows.length ? <ul className="home-bars">{rows.map(row => <li key={row.key}><button type="button" onClick={() => onNavigate(dimension === "types" ? destinations[row.key] ?? "assets" : "assets")} aria-label={`${row.label} ${row.count} 项，查看${dimension === "types" && destinations[row.key] ? row.label : "全部资产"}`}><span>{row.label}</span><span className="home-bar-track" aria-hidden="true"><i style={{ width: `${row.count / max * 100}%` }} /></span><strong>{row.count}</strong></button></li>)}</ul> : <p className="home-chart-empty">{assetError ? "资产统计暂不可用" : "暂无本地资产，添加云账号并同步资源后查看。"}</p>}
      <p className="home-chart-note">{stats.oldestCache ? `最早缓存 ${dateLabel(stats.oldestCache)}` : "暂无完整的资产缓存时间"} · 不实时请求云端</p>
    </section>
    <section className="home-chart-card" aria-label="预警概况"><header><h2>预警概况</h2><button type="button" className="home-chart-link" onClick={() => onNavigate("monitorAlerts")}>全部预警<ChevronRight size={15} aria-hidden="true" /></button></header>
      {!known ? <p className="home-chart-empty">{!runningInTauri ? "浏览器预览无法读取预警，请在 App 中查看。" : loading ? "正在读取预警快照…" : "尚未完成巡检，当前风险状态未知。"}</p> : <><div className="home-risk-counts">{groups.map(group => <button type="button" key={group.label} data-tone={group.tone} onClick={() => onNavigate("monitorAlerts")}><strong>{group.count}</strong><span>{group.label}</span></button>)}</div><div className="home-risk-track" aria-label={`未解除预警 ${active.length} 条`}>{groups.filter(group => group.count).map(group => <i key={group.label} data-tone={group.tone} style={{ flex: group.count }} />)}</div><p className="home-chart-note">{active.length ? "仅统计未解除、未忽略的预警" : "当前快照没有待处理预警，不代表所有资产已巡检"} · 巡检于 {dateLabel(snapshot!.checkedAt)}</p><div className="home-risk-sources">{[{ key: "resources", label: "云资源" }, { key: "certificates", label: "证书" }, { key: "panels", label: "面板" }, { key: "notes", label: "备忘录" }].map(source => <span key={source.key}>{source.label}<strong>{active.filter(alert => alert.section === source.key).length}</strong></span>)}</div></>}
      {monitorError && <p className="home-dashboard-notice" role="status">最近读取或巡检失败{known ? "，以上为上次快照" : "，预警状态未知"}。</p>}
    </section>
    <section className="home-chart-card" aria-label="到期关注"><header><h2>到期关注</h2><button type="button" className="home-chart-link" onClick={() => onNavigate("certificates")}>证书管理<ChevronRight size={15} aria-hidden="true" /></button></header>
      <ul className="home-bars">{expiryBuckets.map(row => <li key={row.label}><span className="home-expiry-row" data-tone={row.tone}><span>{row.label}</span><span className="home-bar-track" aria-hidden="true"><i style={{ width: `${row.count / expiryMax * 100}%` }} /></span><strong>{assetAvailable ? row.count : "—"}</strong></span></li>)}</ul>
      <p className="home-chart-note">资产 {assets.length} 项 + 独立证书 {certificateError ? "读取失败" : !certificatesLoaded ? "正在读取" : `${certificates.length} 项`} · 有效期待补全 {stats.expiry.unknown} 项。区间互不重叠。</p>
      {certificateError && <p className="home-dashboard-notice" role="status">证书读取失败，到期图暂只含已读取的数据，不能作为完整统计。</p>}
      <details className="home-stat-help"><summary>统计口径与数据说明</summary><p>资产总数不包含独立证书库。到期统计合并两类记录，无有效期、按量付费和待签发证书列为待补全，不视为有效。预警来自本机巡检快照，读取失败或未巡检不代表正常。历史趋势将在积累真实每日快照后提供。</p></details>
    </section>
  </section>;
}
