import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, BellRing, CheckCircle2, ChevronDown, ChevronUp, Cloud, Database, HardDrive, RefreshCw, Server, ShieldAlert, Clock3, Layers3, Trash2, Search, Settings2, Star, Monitor, ShieldCheck, GitBranch } from "lucide-react";
import type { Account, LocalAsset } from "../../shared/types";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { desktopPetClient, defaultPetSettings, petSeverityLabel, sortPetAlerts, type PetAlert, type PetSettings, type PetSnapshot } from "../../platform/clients/desktopPet";
import { useConfirmDialog } from "../../shared/useConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { SharedDialog } from "../../shared/SharedDialog";
import { resourcesClient } from "../../platform/clients/resources";
import { applicationPreference, sortedApplications } from "../plugins/applicationCatalog";
import type { ApplicationPreferenceState } from "../plugins/useApplicationPreferences";

const emptySnapshot: PetSnapshot = { alerts: [], checkedAt: 0, lastError: null };
const resourceKinds = [
  { key: "ecs", label: "云服务器", color: "#4f8df7", icon: Server },
  { key: "swas", label: "轻量服务器", color: "#28a879", icon: HardDrive },
  { key: "domain", label: "域名", color: "#9b72e8", icon: Cloud },
  { key: "oss", label: "对象存储", color: "#e6a23c", icon: Database },
  { key: "other", label: "其他资源", color: "#8290a5", icon: Activity },
];
const homeShortcuts = [
  { label: "账号管理", description: "云账号与同步状态", section: "accounts" as const, icon: Cloud },
  { label: "资产管理", description: "已获取的云资源", section: "resources" as const, icon: HardDrive },
  { label: "监控预警", description: "未解除与历史预警", section: "monitorAlerts" as const, icon: BellRing },
  { label: "服务器", description: "云服务器与轻量服务器", section: "servers" as const, icon: Server },
  { label: "云效流水线", description: "流水线与运行记录", section: "flow" as const, icon: GitBranch },
  { label: "我的收藏", description: "收藏的常用资源", section: "favorites" as const, icon: Star },
  { label: "面板管理", description: "管理已添加的运维面板", section: "panels" as const, icon: Monitor },
  { label: "证书管理", description: "HTTPS 证书与部署", section: "certificates" as const, icon: ShieldCheck },
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

export function DesktopHomePage({ accounts, assets, applicationSettings, onNavigate, onOpenSoftware }: { accounts: Account[]; assets: LocalAsset[]; applicationSettings: ApplicationPreferenceState; onNavigate: (section: "accounts" | "resources" | "monitorAlerts" | "servers" | "flow" | "favorites" | "panels" | "certificates") => void; onOpenSoftware: (id?: string) => void }) {
  const [activeAlerts, setActiveAlerts] = useState<number | null>(null);
  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    void desktopPetClient.snapshot().then(snapshot => { if (active) setActiveAlerts(snapshot.alerts.filter(alert => alert.active).length); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const counts = resourceKinds.map(kind => ({ ...kind, value: kind.key === "other" ? assets.filter(asset => !["ecs", "swas", "domain", "oss"].includes(asset.resource_type)).length : assets.filter(asset => asset.resource_type === kind.key).length }));
  const providers = Array.from(accounts.reduce((map, account) => map.set(account.cloud_type, (map.get(account.cloud_type) ?? 0) + 1), new Map<string, number>())).sort((a, b) => b[1] - a[1]);
  const homeApplications = sortedApplications(applicationSettings.preferences).filter(app => applicationPreference(app, applicationSettings.preferences).home);
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
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>快捷入口</h2><p>常用管理页面 · 最多显示 8 项</p></div><Activity size={18} aria-hidden="true" /></div><div className="desktop-overview-shortcuts">{homeShortcuts.slice(0, 8).map(({ label, description, section, icon: Icon }) => <button type="button" key={section} onClick={() => onNavigate(section)}><Icon aria-hidden="true" /><strong>{label}</strong><span>{description}</span></button>)}</div></article>
    </div>
    <article className="desktop-overview-card desktop-overview-software-card"><div className="desktop-overview-card-heading"><div><h2>常用软件</h2><p>与移动端一致，按软件商店的首页显示设置</p></div><Layers3 size={18} aria-hidden="true" /></div>
      {homeApplications.length ? <div className="desktop-overview-software-grid">{homeApplications.map(app => { const Icon = app.icon; return <button type="button" key={app.id} onClick={() => onOpenSoftware(app.id)} aria-label={`打开${app.name}`}><Icon size={19} aria-hidden="true" /><span>{app.name}</span></button>; })}</div> : <p className="desktop-overview-muted">暂无首页常用软件。<button type="button" className="desktop-overview-inline-link" onClick={() => onOpenSoftware()}>前往软件商店设置</button></p>}
    </article>
    <div className="desktop-overview-grid desktop-overview-details">
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>云厂商账号</h2><p>{providers.length} 个厂商 · {accounts.filter(account => !account.enabled).length} 个未启用</p></div><Layers3 size={18} aria-hidden="true" /></div>
        {providers.length ? <ul className="desktop-overview-provider-list" aria-label="云厂商账号数量分布">{providers.map(([provider, count]) => <li key={provider}><div className="desktop-overview-provider-row"><span><i />{provider}</span><strong>{count} 个账号</strong></div><div className="desktop-overview-provider-bar" role="img" aria-label={`${provider}：${count} 个账号，占 ${Math.round(count / accounts.length * 100)}%`}><span style={{ width: `${Math.max(4, count / accounts.length * 100)}%` }} /></div></li>)}</ul> : <p className="desktop-overview-muted">添加云账号后，这里会显示各厂商账号分布。</p>}
      </article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>资源采集状态</h2><p>仅统计本机已保存的采集记录</p></div><Clock3 size={18} aria-hidden="true" /></div>
        <div className="desktop-overview-freshness"><div><span>最近采集</span><strong>{formatFetchedAt(latestFetch)}</strong></div><div><span>超过 7 天未更新</span><strong className={staleAssets ? "is-warning" : ""}>{staleAssets} 项</strong></div><button type="button" onClick={() => onNavigate("resources")}>查看资源清单</button></div>
      </article>
    </div>
  </section>;
}

type AlertProductSection = PetAlert["section"];
const alertProductLabels: Record<AlertProductSection, string> = { panels: "面板", resources: "资源", certificates: "证书", notes: "备忘录" };

const monitoredAssetTypes = new Set(["ecs", "cvm", "lighthouse", "swas", "server", "instance", "domain"]);
const assetTypeLabels: Record<string, string> = { ecs: "云服务器", cvm: "云服务器", lighthouse: "轻量服务器", swas: "轻量服务器", server: "服务器", instance: "服务器", domain: "域名", oss: "对象存储" };
const assetAlertKey = (asset: LocalAsset) => `asset:${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
const assetDisplayName = (asset: LocalAsset) => ["InstanceName", "Name", "name", "DomainName", "BucketName"].map(key => asset.payload[key]).find(value => typeof value === "string" && value.trim()) as string | undefined ?? asset.asset_key;

export function DesktopMonitorAlertsPage({ onNavigate, accounts }: { onNavigate: (section: AlertProductSection) => void; accounts: Account[] }) {
  const [snapshot, setSnapshot] = useState<PetSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
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
  const [strategyType, setStrategyType] = useState("all");
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
    setStrategiesOpen(true); setStrategyLoading(true); setStrategyError(""); setStrategyQuery(""); setStrategyType("all");
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
  const selectedCount = alerts.filter(alert => selectedKeys.has(alert.key)).length;
  const allSelected = alerts.length > 0 && selectedCount === alerts.length;
  const someSelected = selectedCount > 0 && !allSelected;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected; }, [someSelected]);
  const pageCount = Math.max(1, Math.ceil(alerts.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageAlerts = alerts.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setSelectedKeys(current => new Set([...current].filter(key => snapshot.alerts.some(alert => alert.key === key)))); }, [snapshot.alerts]);
  const productSummary = (["panels", "resources", "certificates", "notes"] as const).map(section => ({ section, label: alertProductLabels[section], count: rangeAlerts.filter(alert => alert.active && !alert.ignored && alert.section === section).reduce((total, alert) => total + Math.max(1, alert.occurrences), 0) })).filter(item => item.count > 0);
  const checkedLabel = snapshot.checkedAt ? new Date(snapshot.checkedAt * 1000).toLocaleString() : "尚无检查记录";
  const assetTypes = [...new Set(strategyAssets.map(asset => asset.resource_type))].sort((a, b) => (assetTypeLabels[a] ?? a).localeCompare(assetTypeLabels[b] ?? b, "zh-CN"));
  const visibleStrategyAssets = strategyAssets.filter(asset => (strategyType === "all" || asset.resource_type === strategyType) && `${assetDisplayName(asset)} ${asset.asset_key} ${assetTypeLabels[asset.resource_type] ?? asset.resource_type} ${accounts.find(account => account.id === asset.account_id)?.account_name ?? ""}`.toLowerCase().includes(strategyQuery.trim().toLowerCase()));
  const selectableStrategyAssets = visibleStrategyAssets.filter(asset => monitoredAssetTypes.has(asset.resource_type));
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
  return <section className="desktop-overview-page">
    <header className="desktop-overview-header"><div><span className="eyebrow">LOCAL OPERATIONS</span><h1><BellRing size={23} />监控预警</h1><p>来自本机桌面运维监控的状态与历史事件</p></div><div className="desktop-alert-page-actions"><button className="secondary" type="button" onClick={() => void openStrategies()}><Settings2 size={15} aria-hidden="true" />预警策略</button><button className="secondary desktop-alert-inspect" type="button" disabled={checking || loading} onClick={() => void runInspection()}><Activity size={15} className={checking ? "desktop-overview-spin" : undefined} aria-hidden="true" />{checking ? "巡检中…" : "立即巡检"}</button><button className="secondary" type="button" disabled={loading || checking} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "desktop-overview-spin" : undefined} />{loading ? "读取中…" : "刷新"}</button></div></header>
    {error && <p className="desktop-overview-message" role="alert">{error}</p>}{snapshot.lastError && !error && <p className="desktop-overview-message" role="status">{snapshot.lastError}</p>}
    <div className="desktop-overview-grid desktop-alert-grid">
      <article className="desktop-overview-card desktop-alert-summary"><div className="desktop-overview-card-heading"><div><h2>预警概览</h2><p>最近检查：{checkedLabel}</p></div><ShieldAlert size={19} /></div><div className="desktop-alert-summary-counts"><button type="button" aria-pressed={status === "active"} onClick={() => { setStatus("active"); setPage(1); setSelectedKeys(new Set()); }}><span>未解除</span><strong className="is-warning">{activeCount}</strong></button><button type="button" aria-pressed={status === "recovered"} onClick={() => { setStatus("recovered"); setPage(1); setSelectedKeys(new Set()); }}><span>已解除</span><strong>{recoveredCount}</strong></button></div><div className="desktop-alert-products"><h3>被预警产品 <small>当前范围 · 未解除未静音 · 累计发生次数</small></h3>{productSummary.length ? productSummary.map(item => <button className="desktop-alert-product-link" type="button" key={item.section} onClick={() => onNavigate(item.section)} aria-label={`查看${item.label}预警，${item.count}条`}>{item.label}<strong>{item.count} 次</strong></button>) : <p>当前范围暂无未处理预警</p>}{ignoredCount > 0 && <p className="desktop-alert-ignored-note">另有 {ignoredCount} 条已静音预警（历史保留）</p>}<p className="desktop-alert-check-time">监控状态 · {snapshot.lastError ? "巡检异常" : "本机巡检"}</p></div></article>
      <article className="desktop-overview-card"><div className="desktop-overview-card-heading"><div><h2>{status === "active" ? "未解除预警" : "已解除预警"}</h2><p>{alerts.length} 条记录 · {status === "active" ? ignoredCount + " 条已静音" : "保留历史记录"}</p></div><div className="desktop-alert-heading-actions">{loading && <span role="status">更新中</span>}</div></div>
        <div className="desktop-alert-filters">
          <div className="desktop-alert-range" role="group" aria-label="预警状态筛选">{([['active','未解除'],['recovered','已解除']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); setSelectedKeys(new Set()); }}>{label}</button>)}</div>
          <div className="desktop-alert-range" role="group" aria-label="预警时间范围">{([['today','今日'],['yesterday','昨天'],['7days','7天'],['all','全部']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setRange(value); setPage(1); setSelectedKeys(new Set()); }}>{label}</button>)}</div>
        </div>
        <div className="desktop-alert-selection"><label><input ref={selectAllRef} type="checkbox" checked={allSelected} disabled={!alerts.length || clearing} aria-label="全选当前筛选结果" onChange={event => setSelectedKeys(current => { const next = new Set(current); for (const alert of alerts) event.target.checked ? next.add(alert.key) : next.delete(alert.key); return next; })} /><span>全选当前结果（{alerts.length}）</span></label><button type="button" className="secondary desktop-alert-clear" disabled={selectedCount === 0 || clearing || !!busyKey} onClick={() => void clearSelectedAlerts()}><Trash2 size={14} aria-hidden="true" />{clearing ? "清理中…" : `清理所选${selectedCount ? `（${selectedCount}）` : ""}`}</button></div>
        {alerts.length === 0 ? <div className="desktop-alert-empty"><CheckCircle2 size={25} /><strong>{status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>未获取到数据的资源不会被视为正常。</span></div> : <div className="desktop-alert-list">{pageAlerts.map((alert: PetAlert) => {
          const expanded = expandedKeys.has(alert.key);
          return <article key={alert.key} className={`desktop-alert-row is-${alert.active ? alert.severity : "recovered"}${expanded ? " is-expanded" : ""}`}><div className="desktop-alert-row-summary"><input type="checkbox" aria-label={`选择预警：${alert.title}`} checked={selectedKeys.has(alert.key)} disabled={clearing || !!busyKey} onChange={event => setSelectedKeys(current => { const next = new Set(current); event.target.checked ? next.add(alert.key) : next.delete(alert.key); return next; })} /><button type="button" className="desktop-alert-disclosure" aria-expanded={expanded} onClick={() => setExpandedKeys(current => { const next = new Set(current); next.has(alert.key) ? next.delete(alert.key) : next.add(alert.key); return next; })}><span className="desktop-alert-row-title"><ShieldAlert size={16} aria-hidden="true" /><strong>{alert.title}</strong><span>{!alert.active ? "已解除" : alert.ignored ? "已静音" : petSeverityLabel(alert.severity)}</span></span>{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</button><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString()}</time></div>{expanded && <div className="desktop-alert-expanded">{alert.active && alert.ignored && <p className="desktop-alert-muted-note">预警仍在监控，系统已停止重复通知。</p>}<p>{alert.detail}</p><footer><span>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</span><div className="desktop-alert-row-actions"><button className="secondary desktop-alert-view" type="button" onClick={() => onNavigate(alert.section)} aria-label={`查看${alertProductLabels[alert.section]}：${alert.title}`}>查看{alertProductLabels[alert.section]}</button>{alert.active && <button className="secondary desktop-alert-action" type="button" disabled={!!busyKey || clearing} onClick={() => { setBusyKey(alert.key); void desktopPetClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => setBusyKey("")); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "取消静音" : "静音提醒"}</button>}</div></footer></div>}</article>;
        })}</div>}
        {alerts.length > 0 && <PaginationBar className="desktop-alert-pagination" page={safePage} pageSize={pageSize} total={alerts.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />}
      </article>
    </div>
    {confirmationDialog}
    {strategiesOpen && <SharedDialog sizeStorageKey="features/overview/desktop-overview-pages/desktop-monitor-alerts-page" title="预警策略" subtitle="查看所有本地资产的监控参与状态与当前规则。调整仅影响后续巡检，不会删除历史预警。" icon={<Settings2 size={20} aria-hidden="true" />} className="desktop-alert-strategy-dialog" closeLabel="关闭预警策略" onClose={() => setStrategiesOpen(false)} footer={<button type="button" className="secondary" onClick={() => setStrategiesOpen(false)}>完成</button>}>
      {strategyError && <p className="desktop-overview-message" role="alert">{strategyError}</p>}
      <div className="desktop-alert-strategy-global"><strong>全局策略</strong><span>运维预警：{strategySettings.monitoring ? "已开启" : "已关闭"}</span><span>服务器到期：提前 {strategySettings.expiryDays} 天</span><span>证书到期：提前 {strategySettings.expiryDays} 天（{strategySettings.certificates ? "已开启" : "已关闭"}）</span><span>宝塔面板：CPU {strategySettings.panels ? `${strategySettings.cpuThreshold}%` : "关闭"} · 磁盘 {strategySettings.panels ? `${strategySettings.diskThreshold}%` : "关闭"} · 访问异常 {strategySettings.panelAccess ? "开启" : "关闭"}</span></div>
      <section className="desktop-alert-strategy-config" aria-label="巡检范围与提醒规则">
        <div className="desktop-alert-strategy-config-heading"><strong>巡检范围与提醒规则</strong><label><span>启用运维预警</span><input type="checkbox" aria-label="启用运维预警" checked={strategySettings.monitoring} disabled={!!strategySaving} onChange={event => void updateStrategySettings({ monitoring: event.target.checked })} /></label></div>
        <div className="desktop-alert-strategy-switches">{([
          ["certificates", "HTTPS 证书到期"], ["servers", "服务器与域名到期"], ["panels", "宝塔资源与服务巡检"], ["panelAccess", "面板访问异常"],
        ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={strategySettings[key]} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
        <div className="desktop-alert-strategy-tunings">
          <label>巡检间隔<select aria-label="策略巡检间隔" value={strategySettings.intervalSeconds} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ intervalSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></label>
          <label>到期提醒<select aria-label="策略到期提醒" value={strategySettings.expiryDays} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ expiryDays: Number(event.target.value) })}><option value={7}>提前 7 天</option><option value={30}>提前 30 天</option><option value={60}>提前 60 天</option></select></label>
          {(["cpuThreshold", "diskThreshold"] as const).map(key => <label key={key}>{key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值<select aria-label={`策略${key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值`} value={strategySettings[key]} disabled={!strategySettings.monitoring || !!strategySaving} onChange={event => void updateStrategySettings({ [key]: Number(event.target.value) })}>{[70, 80, 90, 95].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>)}
        </div>
        <div className="desktop-alert-strategy-preferences">{([["quiet", "免打扰", "暂停运维及生活气泡"], ["keepInTray", "关闭后驻留托盘", "后台继续提醒，从托盘退出"]] as const).map(([key, label, hint]) => <label key={key}><span>{label}<small>{hint}</small></span><input type="checkbox" checked={strategySettings[key]} disabled={!!strategySaving} onChange={event => void updateStrategySettings({ [key]: event.target.checked })} /></label>)}</div>
      </section>
      <div className="desktop-alert-strategy-filters"><label className="desktop-alert-strategy-type"><span>类型</span><select aria-label="按资产类型筛选" value={strategyType} onChange={event => setStrategyType(event.target.value)}><option value="all">全部类型（{strategyAssets.length}）</option>{assetTypes.map(type => <option key={type} value={type}>{assetTypeLabels[type] ?? type}（{strategyAssets.filter(asset => asset.resource_type === type).length}）</option>)}</select></label><label className="desktop-alert-strategy-search"><Search size={15} aria-hidden="true" /><input type="search" value={strategyQuery} onChange={event => setStrategyQuery(event.target.value)} placeholder="搜索资产名称、ID 或账号" aria-label="搜索预警策略资产" /></label></div>
      <div className="desktop-alert-strategy-selection"><label><input type="checkbox" checked={allVisibleParticipating} disabled={!selectableStrategyAssets.length || !!strategySaving || !strategySettings.monitoring || !strategySettings.servers} onChange={event => void toggleVisibleStrategies(event.target.checked)} aria-label="全选当前筛选资产参与监控" /><span>全选当前筛选结果（{selectableStrategyAssets.length}）</span></label><small>仅全选支持到期监控的资产</small></div>
      <div className="desktop-alert-strategy-list" aria-busy={strategyLoading}>{strategyLoading ? <p role="status">正在读取资产与策略…</p> : visibleStrategyAssets.length ? visibleStrategyAssets.map(asset => {
        const supported = monitoredAssetTypes.has(asset.resource_type);
        const key = assetAlertKey(asset);
        const participating = strategySettings.monitoring && strategySettings.servers && !strategySettings.excludedAssetAlerts.includes(key);
        const accountName = accounts.find(account => account.id === asset.account_id)?.account_name ?? `账号 ${asset.account_id}`;
        const ruleLabel = asset.resource_type === "domain" ? `域名到期提醒 · 提前 ${strategySettings.expiryDays} 天（以采集到的有效期为准）` : `服务器到期提醒 · 提前 ${strategySettings.expiryDays} 天`;
        return <article className="desktop-alert-strategy-row" key={key}><div className="desktop-alert-strategy-asset"><strong>{assetDisplayName(asset)}</strong><span>{accountName} · {assetTypeLabels[asset.resource_type] ?? asset.resource_type}</span><small>{supported ? ruleLabel : "当前版本暂无此类资产的预警规则"}</small></div>{supported ? <label className="desktop-alert-strategy-toggle"><input type="checkbox" checked={participating} disabled={!!strategySaving || !strategySettings.monitoring || !strategySettings.servers} onChange={event => void toggleAssetStrategy(asset, event.target.checked)} aria-label={`${assetDisplayName(asset)}参与${asset.resource_type === "domain" ? "域名" : "服务器"}到期监控`} /><span>{strategySaving === key ? "保存中…" : !strategySettings.monitoring || !strategySettings.servers ? "全局策略已关闭" : participating ? "监控中" : "未参与"}</span></label> : <span className="desktop-alert-strategy-unavailable">未支持</span>}</article>;
      }) : <p className="desktop-alert-strategy-empty">{strategyAssets.length ? "没有匹配的资产。" : "本机暂无已保存资产。"}</p>}</div>
    </SharedDialog>}
  </section>;
}
