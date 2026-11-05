import { useMemo, useState, type MutableRefObject } from "react";
import { Activity, AppWindow, BellRing, ChevronRight, Cloud, Database, Folder, Globe2, HardDrive, Layers, Monitor, Server, ShieldCheck, Star, Terminal } from "lucide-react";
import type { MobileFeatureDestination } from "./MobileMorePage";
import { MobileMonitorAlertsPage } from "./MobileMonitorAlertsPage";
import type { Account, LocalAsset } from "../shared/types";
import { applicationCatalog, applicationPreference, sortedApplications } from "../features/plugins/applicationCatalog";
import type { ApplicationPreferenceState } from "../features/plugins/useApplicationPreferences";

const icons = { Cloud, HardDrive, Star, Server, Globe2, Folder, Database, Layers, ShieldCheck, Terminal, Monitor, AppWindow, BellRing };
type IconName = keyof typeof icons;
type HomeApplication = { id: MobileFeatureDestination | "alerts"; title: string; icon: IconName };
const defaultApps: HomeApplication[] = [
  { id: "accounts", title: "我的账号", icon: "Cloud" }, { id: "assets", title: "我的资产", icon: "HardDrive" },
  { id: "favorites", title: "我的收藏", icon: "Star" }, { id: "servers", title: "服务器", icon: "Server" },
  { id: "domains", title: "域名与 DNS", icon: "Globe2" },
  { id: "storage", title: "对象存储", icon: "Folder" }, { id: "databases", title: "云数据库", icon: "Database" },
  { id: "redis", title: "Redis", icon: "Layers" }, { id: "certificates", title: "证书管理", icon: "ShieldCheck" },
  { id: "ssh", title: "SSH 终端", icon: "Terminal" }, { id: "panels", title: "运维面板", icon: "Monitor" },
  { id: "flow", title: "云效流水线", icon: "AppWindow" }, { id: "authenticator", title: "身份验证器", icon: "ShieldCheck" },
  { id: "alerts", title: "监控预警", icon: "BellRing" },
];
const usageKey = "cloudhub.mobile-home-usage";

function loadUsage(): Partial<Record<HomeApplication["id"], number>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(usageKey) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Record<HomeApplication["id"], number>> : {};
  } catch { return {}; }
}

export function MobileHomePage({ accounts, assets, search, favoriteCount, applicationSettings, onActiveAlertCount, onNavigate, onOpenSoftware, refreshRef }: { accounts: Account[]; assets: LocalAsset[]; search: string; favoriteCount: number; applicationSettings: ApplicationPreferenceState; onActiveAlertCount: (count: number) => void; onNavigate: (tab: MobileFeatureDestination | "monitorAlerts") => void; onOpenSoftware: (id: string) => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null> }) {
  const [usage, setUsage] = useState(loadUsage);
  const ranked = useMemo(() => [...defaultApps].sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || defaultApps.indexOf(a) - defaultApps.indexOf(b)), [usage]);
  const filtered = ranked.filter(app => app.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const common = filtered.slice(0, 4);
  const shortcutCount: Partial<Record<HomeApplication["id"], number>> = {
    accounts: accounts.length,
    assets: assets.length,
    favorites: favoriteCount,
    servers: assets.filter(asset => asset.resource_type === "ecs" || asset.resource_type === "swas").length,
    domains: assets.filter(asset => asset.resource_type === "domain").length,
  };
  const commonSoftware = sortedApplications(applicationSettings.preferences)
    .filter(app => applicationPreference(app, applicationSettings.preferences).home && app.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const activate = (id: HomeApplication["id"]) => {
    const next = { ...usage, [id]: Math.min(9999, (usage[id] ?? 0) + 1) };
    setUsage(next);
    try { localStorage.setItem(usageKey, JSON.stringify(next)); } catch { /* 当前会话内排序仍然有效。 */ }
    onNavigate(id === "alerts" ? "monitorAlerts" : id);
  };

  return <div className="mobile-home-page">
    <section className="mobile-home-apps" aria-labelledby="mobile-home-apps-title">
      <div className="mobile-home-section-heading"><div><p>快捷访问</p><h1 id="mobile-home-apps-title">常用应用</h1></div><span><Activity size={15} aria-hidden="true" />常用优先</span></div>
      <div className="mobile-home-app-grid">{common.map(app => { const Icon = icons[app.icon]; const count = shortcutCount[app.id]; return <button type="button" key={app.id} onClick={() => activate(app.id)}><span className="mobile-home-app-icon"><Icon size={21} strokeWidth={1.8} aria-hidden="true" />{count !== undefined && <span className="mobile-home-app-count">{count > 99 ? "99+" : count}</span>}</span><span>{app.title}</span></button>; })}</div>
      {filtered.length === 0 && <p className="mobile-home-empty">没有匹配的应用</p>}
      {!accounts.length && <button type="button" className="mobile-home-add-account" onClick={() => activate("accounts")}><Cloud size={17} aria-hidden="true" />添加云账号<ChevronRight size={17} aria-hidden="true" /></button>}
    </section>
    <section className="mobile-home-resource-stats" aria-label="常用软件">
      {commonSoftware.map(app => { const Icon = app.icon; return <button type="button" key={app.id} onClick={() => onOpenSoftware(app.id)} aria-label={`打开${app.name}`}><Icon size={15} aria-hidden="true" /><span>{app.name}</span></button>; })}
      {!commonSoftware.length && <p>{search ? "没有匹配的常用软件" : applicationCatalog.some(app => applicationPreference(app, applicationSettings.preferences).home) ? "没有匹配的常用软件" : "可在软件商店设置首页显示的软件"}</p>}
    </section>
    <section className="mobile-home-alerts" aria-label="监控预警列表">
      <div className="mobile-home-alerts-heading"><div><p>资源风险与状态</p><h2><BellRing size={19} aria-hidden="true" />监控预警</h2></div><button type="button" onClick={() => onNavigate("monitorAlerts")}>全部预警<ChevronRight size={16} aria-hidden="true" /></button></div>
      <MobileMonitorAlertsPage compact onActiveCount={onActiveAlertCount} refreshRef={refreshRef} />
    </section>
  </div>;
}
