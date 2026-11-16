import { useCallback, useState, type MutableRefObject } from "react";
import { useSoftwareCounts } from "../features/overview/useSoftwareCounts";
import { homeShortcuts } from "../features/overview/homeModel";
import { MobileHomeDashboard } from "./MobileHomeDashboard";
import { cloudProvider } from "../features/cloud/catalog";
import { applicationPreference, sortedApplications } from "../features/plugins/applicationCatalog";
import type { MobileFeatureDestination } from "./MobileMorePage";
import type { Account, LocalAsset } from "../shared/types";
import type { ApplicationPreferenceState } from "../features/plugins/useApplicationPreferences";

export function MobileHomePage({ accounts, assets, search, favoriteCount, panelCount, sshCount, applicationSettings, assetError, onActiveAlertCount, onNavigate, onOpenSoftware, refreshRef }: { accounts: Account[]; assets: LocalAsset[]; search: string; favoriteCount: number; panelCount: number; sshCount: number; applicationSettings: ApplicationPreferenceState; assetError?: boolean; onActiveAlertCount: (count: number | null) => void; onNavigate: (tab: MobileFeatureDestination | "monitorAlerts") => void; onOpenSoftware: (id: string) => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null> }) {
  const [activeAlerts, setActiveAlerts] = useState<number | null>(null);
  const handleAlertCount = useCallback((count: number | null) => { setActiveAlerts(count); onActiveAlertCount(count); }, [onActiveAlertCount]);
  const query = search.trim().toLocaleLowerCase();
  const homeSoftware = sortedApplications(applicationSettings.preferences).filter(app => applicationPreference(app, applicationSettings.preferences).home);
  const { softwareCounts, softwareCountsLoaded } = useSoftwareCounts(homeSoftware.map(app => app.id).join(","));
  const commonSoftware = homeSoftware.filter(app => app.name.toLocaleLowerCase().includes(query));
  const shortcuts = homeShortcuts.filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(query));
  const shortcutCounts: Partial<Record<(typeof homeShortcuts)[number]["section"], number>> = { accounts: accounts.length, resources: assets.length, monitorAlerts: activeAlerts ?? undefined, servers: sshCount, favorites: favoriteCount, panels: panelCount };
  const navigate = (section: (typeof homeShortcuts)[number]["section"]) => onNavigate(section === "resources" ? "assets" : section);
  const providers = [...accounts.reduce((map, account) => map.set(account.cloud_type, (map.get(account.cloud_type) ?? 0) + 1), new Map<string, number>())].sort((a,b) => b[1] - a[1]);
  const maxProvider = Math.max(1, ...providers.map(([,count]) => count));
  const softwareRows = homeSoftware.filter(app => (softwareCounts[app.id] ?? 0) > 0);
  const maxSoftwareCount = Math.max(1, ...softwareRows.map(app => softwareCounts[app.id]));
  const entries = <>
    <section className="home-chart-card"><header><div><h2>快捷入口</h2><p className="home-chart-note">常用管理页面 · 最多显示 8 项</p></div></header><div className="mobile-home-shortcuts">{shortcuts.map(({ section, label, description, icon: Icon }) => <button type="button" key={section} onClick={() => navigate(section)}><Icon size={19} aria-hidden="true" /><strong>{label}</strong>{shortcutCounts[section] !== undefined && <em>{shortcutCounts[section]}</em>}<small>{description}</small></button>)}</div>{!shortcuts.length && <p className="home-chart-empty">没有匹配的快捷入口</p>}</section>
    <section className="home-chart-card"><header><div><h2>常用软件</h2><p className="home-chart-note">按软件商店的首页显示设置</p></div></header><div className="mobile-home-software-grid">{commonSoftware.map(app => { const Icon = app.icon; const count = softwareCounts[app.id]; return <button type="button" key={app.id} onClick={() => onOpenSoftware(app.id)}><Icon size={19} aria-hidden="true" /><span>{app.name}</span>{count !== undefined && count > 0 && <strong>{count}</strong>}</button>; })}</div>{!commonSoftware.length && <p className="home-chart-empty">{query ? "没有匹配的常用软件" : "可在软件商店设置首页显示的软件"}</p>}</section>
  </>;
  return <div className="mobile-home-page mobile-home-pc-aligned">
    <div hidden={Boolean(query)}><MobileHomeDashboard accounts={accounts} assets={assets} favoriteCount={favoriteCount} assetError={assetError} onActiveAlertCount={handleAlertCount} onNavigate={onNavigate} refreshRef={refreshRef}>
      {entries}
      <section className="home-chart-card"><header><div><h2>云厂商账号</h2><p className="home-chart-note">{providers.length} 个厂商 · {accounts.filter(account => !account.enabled).length} 个未启用</p></div></header>{providers.length ? <ul className="home-bars">{providers.map(([provider,count]) => <li key={provider}><button type="button" onClick={() => onNavigate("accounts")}><span>{cloudProvider(provider).label}</span><span className="home-bar-track" aria-hidden="true"><i style={{width: `${count / maxProvider * 100}%`}} /></span><strong>{count}</strong></button></li>)}</ul> : <p className="home-chart-empty">添加云账号后，这里会显示各厂商账号分布。</p>}</section>
      <section className="home-chart-card mobile-software-chart"><header><div><h2>软件数据统计</h2><p className="home-chart-note">首页常用软件中可读取的本地记录数量</p></div></header>{softwareRows.length ? <div className="mobile-software-columns">{softwareRows.map(app => <button type="button" key={app.id} onClick={() => onOpenSoftware(app.id)} aria-label={`${app.name}，${softwareCounts[app.id]} 项`}><strong>{softwareCounts[app.id]}</strong><span className="mobile-software-column" aria-hidden="true"><i style={{height: `${softwareCounts[app.id] / maxSoftwareCount * 100}%`}} /></span><span>{app.name}</span></button>)}</div> : <p className="home-chart-empty">{softwareCountsLoaded ? "暂无可统计的软件记录" : "正在读取本机软件数量…"}</p>}</section>
    </MobileHomeDashboard></div>
    {query && entries}
  </div>;
}
