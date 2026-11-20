import { resourceKinds, homeShortcuts, formatHomeElapsed } from "./homeModel";
import { MonitorScopeGroups } from "./MonitorScopeGroups";
import { ToastNotice } from "../../shared/ToastNotice";
import { MultiSelectFilter } from "../../shared/MultiSelectFilter";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, BellRing, CheckCircle2, ChevronDown, ChevronUp, Cloud, Database, HardDrive, RefreshCw, ShieldAlert, Clock3, Layers3, Trash2, Search, Settings2, Star, ChartColumn } from "lucide-react";
import type { Account, LocalAsset } from "../../shared/types";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { desktopPetClient, defaultPetSettings, petSeverityLabel, sortPetAlerts, type PetAlert, type PetSettings, type PetSnapshot } from "../../platform/clients/desktopPet";
import { useConfirmDialog } from "../../shared/useConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { SharedDialog } from "../../shared/SharedDialog";
import { resourcesClient } from "../../platform/clients/resources";
import { monitorAlertProductLabel } from "../../platform/clients/monitorAlerts";
import { useSoftwareCounts } from "./useSoftwareCounts";
import { applicationPreference, sortedApplications } from "../plugins/applicationCatalog";
import type { ApplicationPreferenceState } from "../plugins/useApplicationPreferences";

const emptySnapshot: PetSnapshot = { alerts: [], checkedAt: 0, lastError: null };

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

export function DesktopHomePage({ accounts, assets, applicationSettings, favoriteCount, panelCount, serverCount, onNavigate, onOpenSoftware }: { accounts: Account[]; assets: LocalAsset[]; applicationSettings: ApplicationPreferenceState; favoriteCount: number; panelCount: number; serverCount: number; onNavigate: (section: "accounts" | "resources" | "monitorAlerts" | "servers" | "flow" | "favorites" | "panels" | "certificates") => void; onOpenSoftware: (id?: string) => void }) {
  const [activeAlerts, setActiveAlerts] = useState<number | null>(null);
  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    void desktopPetClient.snapshot().then(snapshot => { if (active) setActiveAlerts(snapshot.alerts.filter(alert => alert.active).length); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const counts = resourceKinds.map(kind => ({ ...kind, value: kind.key === "other" ? assets.filter(asset => !["ecs", "swas", "domain", "oss"].includes(asset.resource_type)).length : assets.filter(asset => asset.resource_type === kind.key).length }));
  const shortcutCounts: Partial<Record<(typeof homeShortcuts)[number]["section"], number>> = { accounts: accounts.length, resources: assets.length, monitorAlerts: activeAlerts ?? undefined, servers: serverCount, favorites: favoriteCount, panels: panelCount };
  const providers = Array.from(accounts.reduce((map, account) => map.set(account.cloud_type, (map.get(account.cloud_type) ?? 0) + 1), new Map<string, number>())).sort((a, b) => b[1] - a[1]);
  const maxProviderCount = Math.max(1, ...providers.map(([, count]) => count));
  const homeApplications = useMemo(() => sortedApplications(applicationSettings.preferences).filter(app => applicationPreference(app, applicationSettings.preferences).home), [applicationSettings.preferences]);
  const homeApplicationIds = homeApplications.map(app => app.id).join(",");
  const { softwareCounts, softwareCountsLoaded } = useSoftwareCounts(homeApplicationIds);
  const now = Date.now();
  const latestFetch = assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at || 0), 0);
  const softwareCountItems = homeApplications.flatMap(app => softwareCounts[app.id] ? [{ id: app.id, name: app.name, count: softwareCounts[app.id] }] : []);
  const maxSoftwareCount = Math.max(1, ...softwareCountItems.map(item => item.count));
  const formatFetchedAt = (timestamp: number) => timestamp > 0 ? new Date(timestamp).toLocaleString() : "暂无采集记录";
  return <section className="desktop-overview-page">
    <header className="desktop-overview-header"><div className="desktop-overview-home-heading"><div><span className="eyebrow">LOCAL CONSOLE</span><h1>首页</h1><p>云账号与本机已保存资源概况</p></div><div className="desktop-overview-collection-meta" aria-label="本机资源采集信息"><span><Clock3 size={14} aria-hidden="true" />最近采集</span><strong>{latestFetch ? `${formatFetchedAt(latestFetch)} · ${formatHomeElapsed(latestFetch, now)}` : "暂无采集记录"}</strong><small>仅统计本机已保存的采集记录</small></div></div></header>
    <div className="desktop-overview-kpis">
      <button type="button" onClick={() => onNavigate("accounts")}><span><Cloud size={17} />云账号</span><strong>{accounts.length}</strong><small>已启用 {accounts.filter(account => account.enabled).length}</small></button>
      <button type="button" onClick={() => onNavigate("resources")}><span><HardDrive size={17} />已保存资源</span><strong>{assets.length}</strong><small>本机资产清单</small></button>
      <button type="button" onClick={() => onNavigate("favorites")}><span><Star size={17} />已收藏</span><strong>{favoriteCount}</strong><small>已收藏的资源</small></button>
      <button type="button" onClick={() => onNavigate("monitorAlerts")}><span><BellRing size={17} />未解除预警</span><strong className="is-warning">{activeAlerts === null ? "—" : activeAlerts}</strong><small>{activeAlerts === null ? "本机监控状态" : "查看监控预警明细"}</small></button>
    </div>
    <div className="desktop-overview-grid">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>资源类型分布</h2><p>按本机已保存的云资源统计</p></div><Database size={18} aria-hidden="true" /></div><Donut values={counts.map(({ label, value, color }) => ({ label, value, color }))} label="资源" /></article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>快捷入口</h2><p>常用管理页面 · 最多显示 8 项</p></div><Activity size={18} aria-hidden="true" /></div><div className="desktop-overview-shortcuts">{homeShortcuts.slice(0, 8).map(({ label, description, section, icon: Icon }) => <button type="button" key={section} title={label} onClick={() => onNavigate(section)}><Icon aria-hidden="true" /><strong>{label}</strong>{shortcutCounts[section] !== undefined && <em aria-label={`${shortcutCounts[section]}项`}>{shortcutCounts[section]}</em>}<span>{description}</span></button>)}</div></article>
    </div>
    <article className="desktop-overview-card desktop-overview-software-card"><div className="desktop-overview-card-heading"><div><h2>常用软件</h2><p>与移动端一致，按软件商店的首页显示设置</p></div><Layers3 size={18} aria-hidden="true" /></div>
      {homeApplications.length ? <div className="desktop-overview-software-grid">{homeApplications.map(app => { const Icon = app.icon; const count = softwareCounts[app.id]; return <button type="button" key={app.id} onClick={() => onOpenSoftware(app.id)} aria-label={`打开${app.name}${count === undefined ? "" : `，${count}项`}`}><Icon size={19} aria-hidden="true" /><span>{app.name}</span>{count !== undefined && count > 0 && <em>{count}</em>}</button>; })}</div> : <p className="desktop-overview-muted">暂无首页常用软件。<button type="button" className="desktop-overview-inline-link" onClick={() => onOpenSoftware()}>前往软件商店设置</button></p>}
    </article>
    <div className="desktop-overview-grid desktop-overview-details">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>云厂商账号</h2><p>{providers.length} 个厂商 · {accounts.filter(account => !account.enabled).length} 个未启用</p></div><Layers3 size={18} aria-hidden="true" /></div>
        {providers.length ? <ul className="desktop-overview-provider-list" aria-label="云厂商账号数量分布">{providers.map(([provider, count]) => <li key={provider}><span>{provider}</span><div className="desktop-overview-provider-track" role="img" aria-label={`${provider}：${count} 个账号`}><i style={{ width: `${Math.max(4, count / maxProviderCount * 100)}%` }} /></div><strong>{count}</strong></li>)}</ul> : <p className="desktop-overview-muted">添加云账号后，这里会显示各厂商账号分布。</p>}
      </article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>软件数据统计</h2><p>首页常用软件中可读取的本地记录数量</p></div><ChartColumn size={18} aria-hidden="true" /></div>
        {softwareCountItems.length ? <ul className="desktop-overview-software-count-chart" aria-label="常用软件本地记录数量">{softwareCountItems.map(item => <li key={item.id}><span>{item.name}</span><div className="desktop-overview-software-count-track" role="img" aria-label={`${item.name}：${item.count} 项`}><i style={{ height: `${Math.max(3, item.count / maxSoftwareCount * 100)}%` }} /></div><strong>{item.count}</strong></li>)}</ul> : <p className="desktop-overview-muted">{softwareCountsLoaded ? "暂无可统计的软件记录" : "正在读取本地软件数量…"}</p>}
      </article>
    </div>
  </section>;
}

type AlertProductSection = PetAlert["section"];
const alertProductLabels: Record<AlertProductSection, string> = { panels: "面板", resources: "资源", certificates: "证书", notes: "备忘录" };

const monitoredAssetTypes = new Set(["ecs", "cvm", "lighthouse", "swas", "server", "instance", "domain", "rds", "redis"]);
const assetTypeLabels: Record<string, string> = { ecs: "服务器", cvm: "服务器", lighthouse: "轻量服务器", swas: "轻量服务器", server: "服务器", instance: "服务器", domain: "域名", rds: "云数据库", redis: "Redis", oss: "对象存储" };
const assetStrategyEnabled = (settings: PetSettings, resourceType: string) => {
  if (["ecs", "cvm", "server", "instance"].includes(resourceType)) return settings.servers;
  if (["lighthouse", "swas"].includes(resourceType)) return settings.lightServers;
  if (resourceType === "domain") return settings.domains;
  if (resourceType === "rds") return settings.databases;
  if (resourceType === "redis") return settings.redis;
  return false;
};
const assetAlertKey = (asset: LocalAsset) => `asset:${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
const assetDisplayName = (asset: LocalAsset) => ["InstanceName", "Name", "name", "DomainName", "BucketName"].map(key => asset.payload[key]).find(value => typeof value === "string" && value.trim()) as string | undefined ?? asset.asset_key;

export function DesktopMonitorAlertsPage({ onNavigate, accounts }: { onNavigate: (section: AlertProductSection) => void; accounts: Account[] }) {
  const [snapshot, setSnapshot] = useState<PetSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
  const [productFilter, setProductFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategySaving, setStrategySaving] = useState("");
  const [strategyError, setStrategyError] = useState("");
  const [strategyQuery, setStrategyQuery] = useState("");
  const [strategyTypes, setStrategyTypes] = useState<string[]>([]);
  const [strategySettings, setStrategySettings] = useState<PetSettings>(defaultPetSettings);
  const [strategyAssets, setStrategyAssets] = useState<LocalAsset[]>([]);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const clearSelectedAlerts = async () => {
    const keys = [...selectedKeys];
    if (!keys.length || clearing) return;
    const accepted = await confirm({ title: "清理所选预警", message: `将永久清理选中的 ${keys.length} 条预警记录，包括未解除或已解除记录。此操作无法撤销。`, confirmLabel: "清理所选" });
    if (!accepted) return;
    setClearing(true); setError("");
    try { setSnapshot(await desktopPetClient.clearSelected(keys)); setSelectedKeys(new Set()); }
    catch (reason) { setError(platformErrorMessage(reason, "清理预警失败，请稍后重试。")); }
    finally { setClearing(false); }
  };
  const openStrategies = async () => {
    setStrategiesOpen(true); setStrategyLoading(true); setStrategyError(""); setStrategyQuery(""); setStrategyTypes([]);
    if (!runningInTauri) { setStrategyError("预警策略仅支持桌面客户端。"); setStrategyLoading(false); return; }
    try {
      const [settings, assets] = await Promise.all([desktopPetClient.settings(), resourcesClient.listLocal()]);
      setStrategySettings(settings); setStrategyAssets(assets);
    } catch (reason) { setStrategyError(platformErrorMessage(reason, "读取资产预警策略失败。")); }
    finally { setStrategyLoading(false); }
  };
  const toggleAssetStrategy = async (asset: LocalAsset, enabled: boolean) => {
    const key = assetAlertKey(asset);
    const excludedAssetAlerts = enabled ? strategySettings.excludedAssetAlerts.filter(item => item !== key) : [...strategySettings.excludedAssetAlerts, key];
    const next = { ...strategySettings, excludedAssetAlerts };
    setStrategySaving(key); setStrategyError("");
    try { await desktopPetClient.save(next); setStrategySettings(next); }
    catch (reason) { setStrategyError(platformErrorMessage(reason, "保存资产预警策略失败。")); }
    finally { setStrategySaving(""); }
  };
  const updateStrategySettings = async (patch: Partial<PetSettings>) => {
    const next = { ...strategySettings, ...patch };
    setStrategySaving("settings"); setStrategyError("");
    try { await desktopPetClient.save(next); setStrategySettings(next); }
    catch (reason) { setStrategyError(platformErrorMessage(reason, "保存预警策略失败。")); }
    finally { setStrategySaving(""); }
  };
  const refresh = async () => {
    if (!runningInTauri) { setError("浏览器预览无法读取本机运维预警，请在桌面客户端中查看。"); return; }
    setLoading(true); setError("");
    try { setSnapshot(await desktopPetClient.snapshot()); }
    catch (reason) { setError(platformErrorMessage(reason, "读取监控预警失败，请稍后重试。")); }
    finally { setLoading(false); }
  };
  const runInspection = async () => {
    if (!runningInTauri || checking) return;
    setChecking(true); setError("");
    try {
      await desktopPetClient.check();
      setSnapshot(await desktopPetClient.snapshot());
    } catch (reason) { setError(platformErrorMessage(reason, "立即巡检失败，请稍后重试。")); }
    finally { setChecking(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const activeCount = snapshot.alerts.filter(alert => alert.active).length;
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
  const productCounts = [...new Set(alerts.map(monitorAlertProductLabel))].map(label => ({ label, count: alerts.filter(alert => monitorAlertProductLabel(alert) === label).length }));
  const filteredAlerts = productFilter === "all" ? alerts : alerts.filter(alert => monitorAlertProductLabel(alert) === productFilter);
  const selectedCount = filteredAlerts.filter(alert => selectedKeys.has(alert.key)).length;
  const allSelected = filteredAlerts.length > 0 && selectedCount === filteredAlerts.length;
  const someSelected = selectedCount > 0 && !allSelected;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected; }, [someSelected]);
  const pageCount = Math.max(1, Math.ceil(filteredAlerts.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageAlerts = filteredAlerts.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setSelectedKeys(current => new Set([...current].filter(key => snapshot.alerts.some(alert => alert.key === key)))); }, [snapshot.alerts]);
  const checkedLabel = snapshot.checkedAt ? new Date(snapshot.checkedAt * 1000).toLocaleString() : "尚无检查记录";
  const assetTypes = [...new Set(strategyAssets.map(asset => asset.resource_type))].sort((a, b) => (assetTypeLabels[a] ?? a).localeCompare(assetTypeLabels[b] ?? b, "zh-CN"));
  const strategyTypeOptions = assetTypes.map(type => ({ value: type, label: assetTypeLabels[type] ?? type, count: strategyAssets.filter(asset => asset.resource_type === type).length }));
  const visibleStrategyAssets = strategyAssets.filter(asset => (strategyTypes.length === 0 || strategyTypes.includes(asset.resource_type)) && `${assetDisplayName(asset)} ${asset.asset_key} ${assetTypeLabels[asset.resource_type] ?? asset.resource_type} ${accounts.find(account => account.id === asset.account_id)?.account_name ?? ""}`.toLowerCase().includes(strategyQuery.trim().toLowerCase()));
  const selectableStrategyAssets = visibleStrategyAssets.filter(asset => monitoredAssetTypes.has(asset.resource_type) && assetStrategyEnabled(strategySettings, asset.resource_type));
  const allVisibleParticipating = selectableStrategyAssets.length > 0 && selectableStrategyAssets.every(asset => !strategySettings.excludedAssetAlerts.includes(assetAlertKey(asset)));
  const toggleVisibleStrategies = async (enabled: boolean) => {
    const visibleKeys = new Set(selectableStrategyAssets.map(assetAlertKey));
    const excludedAssetAlerts = enabled
      ? strategySettings.excludedAssetAlerts.filter(key => !visibleKeys.has(key))
      : [...new Set([...strategySettings.excludedAssetAlerts, ...visibleKeys])];
    const next = { ...strategySettings, excludedAssetAlerts };
    setStrategySaving("all"); setStrategyError("");
    try { await desktopPetClient.save(next); setStrategySettings(next); }
    catch (reason) { setStrategyError(platformErrorMessage(reason, "保存资产预警策略失败。")); }
    finally { setStrategySaving(""); }
  };
  return <section className="desktop-overview-page desktop-monitor-alerts-page">
    <header className="desktop-overview-header"><div><span className="eyebrow">LOCAL OPERATIONS</span><h1><BellRing size={23} />监控预警</h1><p>来自本机桌面运维监控的状态与历史事件</p></div><div className="desktop-alert-page-actions"><button className="secondary" type="button" onClick={() => void openStrategies()}><Settings2 size={15} aria-hidden="true" />预警策略</button><button className="secondary desktop-alert-inspect" type="button" disabled={checking || loading} onClick={() => void runInspection()}><Activity size={15} className={checking ? "desktop-overview-spin" : undefined} aria-hidden="true" />{checking ? "巡检中…" : "立即巡检"}</button><button className="secondary" type="button" disabled={loading || checking} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "desktop-overview-spin" : undefined} />{loading ? "读取中…" : "刷新"}</button></div></header>
    {error && <ToastNotice message={error} tone="error" />}{snapshot.lastError && !error && <p className="desktop-overview-message" role="status">{snapshot.lastError}</p>}
    <div className="desktop-overview-grid desktop-alert-grid">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>{status === "active" ? "未解除预警" : "已解除预警"}</h2><p>最近检查：{checkedLabel} · {filteredAlerts.length} 条记录 · {status === "active" ? ignoredCount + " 条已静音" : "保留历史记录"}</p></div><div className="desktop-alert-heading-actions">{loading && <span role="status">更新中</span>}<div className="desktop-alert-product-filters" role="group" aria-label="按预警产品筛选"><button type="button" aria-pressed={productFilter === "all"} onClick={() => { setProductFilter("all"); setPage(1); setSelectedKeys(new Set()); }}>全部 <strong>{alerts.length}</strong></button>{productCounts.map(item => <button type="button" key={item.label} aria-pressed={productFilter === item.label} onClick={() => { setProductFilter(item.label); setPage(1); setSelectedKeys(new Set()); }}>{item.label} <strong>{item.count}</strong></button>)}</div></div></div>
        <div className="desktop-alert-filters">
          <div className="desktop-alert-range" role="group" aria-label="预警状态筛选">{([['active','未解除',activeCount],['recovered','已解除',recoveredCount]] as const).map(([value,label,count]) => <button type="button" key={value} aria-pressed={status === value} onClick={() => { setStatus(value); setProductFilter("all"); setPage(1); setSelectedKeys(new Set()); }}>{label} <strong>{count}</strong></button>)}</div>
          <div className="desktop-alert-range" role="group" aria-label="预警时间范围">{([['today','今日'],['yesterday','昨天'],['7days','7天'],['all','全部']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setRange(value); setProductFilter("all"); setPage(1); setSelectedKeys(new Set()); }}>{label}</button>)}</div>
        </div>
        <div className="desktop-alert-selection"><label><input ref={selectAllRef} type="checkbox" checked={allSelected} disabled={!filteredAlerts.length || clearing} aria-label="全选当前筛选结果" onChange={event => setSelectedKeys(current => { const next = new Set(current); for (const alert of filteredAlerts) event.target.checked ? next.add(alert.key) : next.delete(alert.key); return next; })} /><span>全选当前结果（{filteredAlerts.length}）</span></label><button type="button" className="secondary desktop-alert-clear" disabled={selectedCount === 0 || clearing || !!busyKey} onClick={() => void clearSelectedAlerts()}><Trash2 size={14} aria-hidden="true" />{clearing ? "清理中…" : `清理所选${selectedCount ? `（${selectedCount}）` : ""}`}</button></div>
        {filteredAlerts.length === 0 ? <div className="desktop-alert-empty"><CheckCircle2 size={25} /><strong>{productFilter !== "all" ? `暂无${productFilter}预警` : status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>未获取到数据的资源不会被视为正常。</span></div> : <div className="desktop-alert-list">{pageAlerts.map((alert: PetAlert) => {
          const expanded = expandedKeys.has(alert.key);
          return <article key={alert.key} className={`desktop-alert-row is-${alert.active ? alert.severity : "recovered"}${expanded ? " is-expanded" : ""}`}><div className="desktop-alert-row-summary"><input type="checkbox" aria-label={`选择预警：${alert.title}`} checked={selectedKeys.has(alert.key)} disabled={clearing || !!busyKey} onChange={event => setSelectedKeys(current => { const next = new Set(current); event.target.checked ? next.add(alert.key) : next.delete(alert.key); return next; })} /><button type="button" className="desktop-alert-disclosure" aria-expanded={expanded} onClick={() => setExpandedKeys(current => { const next = new Set(current); next.has(alert.key) ? next.delete(alert.key) : next.add(alert.key); return next; })}><span className="desktop-alert-row-title"><ShieldAlert size={16} aria-hidden="true" /><strong>{alert.title}</strong><small className="desktop-alert-product-tag">{monitorAlertProductLabel(alert)}</small><span className="desktop-alert-severity-tag">{!alert.active ? "已解除" : alert.ignored ? "已静音" : petSeverityLabel(alert.severity)}</span></span>{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</button><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString()}</time></div>{expanded && <div className="desktop-alert-expanded">{alert.active && alert.ignored && <p className="desktop-alert-muted-note">预警仍在监控，系统已停止重复通知。</p>}<p>{alert.detail}</p><footer><span>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</span><div className="desktop-alert-row-actions"><button className="secondary desktop-alert-view" type="button" onClick={() => onNavigate(alert.section)} aria-label={`查看${alertProductLabels[alert.section]}：${alert.title}`}>查看{alertProductLabels[alert.section]}</button>{alert.active && <button className="secondary desktop-alert-action" type="button" disabled={!!busyKey || clearing} onClick={() => { setBusyKey(alert.key); void desktopPetClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => setBusyKey("")); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "取消静音" : "静音提醒"}</button>}</div></footer></div>}</article>;
        })}</div>}
        {filteredAlerts.length > 0 && <PaginationBar className="desktop-alert-pagination" page={safePage} pageSize={pageSize} total={filteredAlerts.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />}
      </article>
    </div>
    {confirmationDialog}
    {strategiesOpen && <SharedDialog sizeStorageKey="features/overview/desktop-overview-pages/desktop-monitor-alerts-page" title="预警策略" subtitle="查看所有本地资产的监控参与状态与当前规则。调整仅影响后续巡检，不会删除历史预警。" icon={<Settings2 size={20} aria-hidden="true" />} className="desktop-alert-strategy-dialog" closeLabel="关闭预警策略" onClose={() => setStrategiesOpen(false)} footer={<button type="button" className="secondary" onClick={() => setStrategiesOpen(false)}>完成</button>}>
      {strategyError && <p className="desktop-overview-message" role="alert">{strategyError}</p>}
      <div className="desktop-alert-strategy-global"><strong>全局策略</strong><span>运维预警：{strategySettings.monitoring ? "已开启" : "已关闭"}</span><span>到期提醒：提前 {strategySettings.expiryDays} 天</span><span>宝塔面板：CPU {strategySettings.panels ? `${strategySettings.cpuThreshold}%` : "关闭"} · 磁盘 {strategySettings.panelDisk ? `${strategySettings.diskThreshold}%` : "关闭"} · 服务 {strategySettings.panelServices ? "开启" : "关闭"} · 访问异常 {strategySettings.panelAccess ? "开启" : "关闭"}</span></div>
      <section className="desktop-alert-strategy-config" aria-label="巡检范围与提醒规则">
        <div className="desktop-alert-strategy-config-heading"><strong>巡检范围与提醒规则</strong><label><span>启用运维预警</span><input type="checkbox" aria-label="启用运维预警" checked={strategySettings.monitoring} disabled={!!strategySaving} onChange={event => void updateStrategySettings({ monitoring: event.target.checked })} /></label></div>
        <MonitorScopeGroups settings={strategySettings} disabled={!strategySettings.monitoring || !!strategySaving} onChange={patch => void updateStrategySettings(patch)} />
        <div className="desktop-alert-strategy-tunings">
          <label>巡检间隔<select aria-label="策略巡检间隔" value={strategySettings.intervalSeconds} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ intervalSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></label>
          <label>到期提醒<select aria-label="策略到期提醒" value={strategySettings.expiryDays} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ expiryDays: Number(event.target.value) })}><option value={7}>提前 7 天</option><option value={30}>提前 30 天</option><option value={60}>提前 60 天</option></select></label>
          {(["cpuThreshold", "diskThreshold"] as const).map(key => <label key={key}>{key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值<select aria-label={`策略${key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值`} value={strategySettings[key]} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ [key]: Number(event.target.value) })}>{[70, 80, 90, 95].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>)}
        </div>
        <div className="desktop-alert-strategy-preferences">{([["quiet", "免打扰", "暂停运维及生活气泡"], ["keepInTray", "关闭后驻留托盘", "后台继续提醒，从托盘退出"]] as const).map(([key, label, hint]) => <label key={key}><span>{label}<small>{hint}</small></span><input type="checkbox" checked={strategySettings[key]} disabled={!!strategySaving} onChange={event => void updateStrategySettings({ [key]: event.target.checked })} /></label>)}</div>
      </section>
      <div className="desktop-alert-strategy-filters"><MultiSelectFilter className="desktop-alert-strategy-type" label="类型" ariaLabel="按资产类型筛选" allLabel="全部类型" total={strategyAssets.length} options={strategyTypeOptions} selected={strategyTypes} onChange={setStrategyTypes} /><label className="desktop-alert-strategy-search"><Search size={15} aria-hidden="true" /><input type="search" value={strategyQuery} onChange={event => setStrategyQuery(event.target.value)} placeholder="搜索资产名称、ID 或账号" aria-label="搜索预警策略资产" /></label></div>
      <div className="desktop-alert-strategy-selection"><label><input type="checkbox" checked={allVisibleParticipating} disabled={!selectableStrategyAssets.length || !!strategySaving || !strategySettings.monitoring} onChange={event => void toggleVisibleStrategies(event.target.checked)} aria-label="全选当前筛选资产参与监控" /><span>全选当前筛选结果（{selectableStrategyAssets.length}）</span></label><small>仅全选支持到期监控的资产</small></div>
      <div className="desktop-alert-strategy-list" aria-busy={strategyLoading}>{strategyLoading ? <p role="status">正在读取资产与策略…</p> : visibleStrategyAssets.length ? visibleStrategyAssets.map(asset => {
        const supported = monitoredAssetTypes.has(asset.resource_type);
        const key = assetAlertKey(asset);
        const productEnabled = assetStrategyEnabled(strategySettings, asset.resource_type);
        const participating = strategySettings.monitoring && productEnabled && !strategySettings.excludedAssetAlerts.includes(key);
        const accountName = accounts.find(account => account.id === asset.account_id)?.account_name ?? `账号 ${asset.account_id}`;
        const ruleLabel = `${assetTypeLabels[asset.resource_type] ?? asset.resource_type}到期提醒 · 提前 ${strategySettings.expiryDays} 天${asset.resource_type === "domain" ? "（以采集到的有效期为准）" : ""}`;
        return <article className="desktop-alert-strategy-row" key={key}><div className="desktop-alert-strategy-asset"><strong>{assetDisplayName(asset)}</strong><span>{accountName} · {assetTypeLabels[asset.resource_type] ?? asset.resource_type}</span><small>{supported ? ruleLabel : "当前版本暂无此类资产的预警规则"}</small></div>{supported ? <label className="desktop-alert-strategy-toggle"><input type="checkbox" checked={participating} disabled={!!strategySaving || !strategySettings.monitoring || !productEnabled} onChange={event => void toggleAssetStrategy(asset, event.target.checked)} aria-label={`${assetDisplayName(asset)}参与${assetTypeLabels[asset.resource_type] ?? asset.resource_type}到期监控`} /><span>{strategySaving === key ? "保存中…" : !strategySettings.monitoring ? "全局策略已关闭" : !productEnabled ? "产品策略已关闭" : participating ? "监控中" : "未参与"}</span></label> : <span className="desktop-alert-strategy-unavailable">未支持</span>}</article>;
      }) : <p className="desktop-alert-strategy-empty">{strategyAssets.length ? "没有匹配的资产。" : "本机暂无已保存资产。"}</p>}</div>
    </SharedDialog>}
  </section>;
}
