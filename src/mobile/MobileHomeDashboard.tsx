import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowUpRight, BellRing, ChevronDown, Cloud, Clock3, HardDrive, Star } from "lucide-react";
import type { Account, LocalAsset } from "../shared/types";
import type { MobileFeatureDestination } from "./MobileMorePage";
import { monitorAlertsClient } from "../platform/clients/monitorAlerts";
import { resourceKinds, formatHomeElapsed } from "../features/overview/homeModel";
import "./home-dashboard.css";

type Props = { accounts: Account[]; assets: LocalAsset[]; favoriteCount: number; assetError?: boolean; onActiveAlertCount: (count: number | null) => void; onNavigate: (tab: MobileFeatureDestination | "monitorAlerts") => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null>; children?: ReactNode };
export function MobileHomeDashboard({ accounts, assets, favoriteCount, assetError, onActiveAlertCount, onNavigate, refreshRef, children }: Props) {
  const [activeAlerts, setActiveAlerts] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++revision.current;
    setNow(Date.now());
    try {
      const snapshot = await monitorAlertsClient.snapshot();
      if (token !== revision.current) return;
      const count = snapshot.alerts.filter(alert => alert.active).length;
      setActiveAlerts(count); onActiveAlertCount(count); setError(Boolean(snapshot.lastError));
    } catch { if (token === revision.current) setError(true); }
  }, [onActiveAlertCount]);
  useEffect(() => {
    void refresh();
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, 60000);
    window.addEventListener("focus", visibleRefresh); document.addEventListener("visibilitychange", visibleRefresh);
    if (refreshRef) refreshRef.current = refresh;
    return () => { revision.current++; clearInterval(timer); window.removeEventListener("focus", visibleRefresh); document.removeEventListener("visibilitychange", visibleRefresh); if (refreshRef?.current === refresh) refreshRef.current = null; };
  }, [refresh, refreshRef]);
  const latestFetch = assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at || 0), 0);
  const counts = resourceKinds.map(kind => ({ ...kind, count: kind.key === "other" ? assets.filter(asset => !["ecs", "swas", "domain", "oss"].includes(asset.resource_type)).length : assets.filter(asset => asset.resource_type === kind.key).length }));
  let offset = 0;
  return <section className="home-dashboard mobile-home-unified" aria-label="首页资源概况">
    <header className="home-dashboard-heading mobile-home-compact-heading"><h1>首页</h1><details className="mobile-home-collection-details"><summary><span><Clock3 size={13} aria-hidden="true" />最近采集<strong>{latestFetch ? formatHomeElapsed(latestFetch, now) : "暂无记录"}</strong><ChevronDown size={13} className="mobile-home-collection-chevron" aria-hidden="true" /></span>{latestFetch > 0 && <time dateTime={new Date(latestFetch).toISOString()}>{new Date(latestFetch).toLocaleString("zh-CN")}</time>}</summary><p>云账号与本机已保存资源概况；采集时间仅统计本机已保存的记录，不会实时请求云端。</p></details></header>
    <div className="home-stat-grid">{[
      { label: "云账号", count: accounts.length, caption: `已启用 ${accounts.filter(account => account.enabled).length}`, icon: Cloud, destination: "accounts" },
      { label: "已保存资源", count: assetError && !assets.length ? null : assets.length, caption: "本机资产清单", icon: HardDrive, destination: "assets" },
      { label: "已收藏", count: favoriteCount, caption: "已收藏的资源", icon: Star, destination: "favorites" },
      { label: "未解除预警", count: activeAlerts, caption: activeAlerts === null ? "本机监控状态" : "查看监控预警明细", icon: BellRing, destination: "monitorAlerts" },
    ].map(({label, count, caption, icon: Icon, destination}) => <button key={label} type="button" onClick={() => onNavigate(destination as MobileFeatureDestination | "monitorAlerts")}><span className="home-stat-label"><Icon size={17} />{label}<ArrowUpRight size={13} className="home-stat-arrow" /></span><strong className={destination === "monitorAlerts" ? "mobile-home-warning" : undefined}>{count ?? "—"}</strong><small>{caption}</small></button>)}</div>
    {assetError && <p className="home-dashboard-notice" role="status">资产缓存读取失败{assets.length ? "，保留上次数据" : ""}。</p>}
    {error && <p className="home-dashboard-notice" role="status">最近读取或巡检失败，预警数量为上次可用快照。</p>}
    <section className="home-chart-card"><header><div><h2>资源类型分布</h2><p className="home-chart-note">按本机已保存的云资源统计</p></div></header>
      <div className="mobile-home-donut-layout"><svg viewBox="0 0 120 120" role="img" aria-label={`资源类型分布，共 ${assets.length} 项`}><circle cx="60" cy="60" r="48" fill="none" stroke="var(--mobile-border)" strokeWidth="14" />{counts.filter(item => item.count).map(item => {
        const length = item.count / assets.length * 301.59;
        const circle = <circle key={item.key} cx="60" cy="60" r="48" fill="none" stroke={item.color} strokeWidth="14" strokeDasharray={`${length} ${301.59 - length}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />;
        offset += length; return circle;
      })}<text x="60" y="57" textAnchor="middle" className="mobile-home-donut-total">{assets.length}</text><text x="60" y="75" textAnchor="middle" className="mobile-home-donut-caption">资源</text></svg><ul>{counts.map(item => <li key={item.key}><span><i style={{background: item.color}} />{item.label}</span><strong>{item.count}</strong></li>)}</ul></div>
    </section>
    {children}
  </section>;
}
