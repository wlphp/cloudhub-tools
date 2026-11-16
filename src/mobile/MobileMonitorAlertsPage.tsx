import { useConfirmDialog } from "../shared/useConfirmDialog";
import { PaginationBar } from "../shared/PaginationBar";
import { MonitorScopeGroups } from "../features/overview/MonitorScopeGroups";
import { useEffect, useMemo, useState, useRef, type MutableRefObject } from "react";
import { Activity, CheckCircle2, ChevronDown, Filter, RefreshCw, Trash2, BellRing, Search, Settings2, ShieldAlert } from "lucide-react";
import { platformErrorMessage } from "../platform/api";
import { monitorAlertProductLabel, monitorSeverityLabel, sortMonitorAlerts, type MonitorAlert, type MonitorSnapshot } from "../platform/clients/monitorAlerts";
import { defaultMonitorSettings, monitorAlertsClient, type MonitorSettings } from "../platform/clients/monitorAlerts";
import type { Account, LocalAsset } from "../shared/types";
import { resourcesClient } from "../platform/clients/resources";
import { SharedDialog } from "../shared/SharedDialog";

const emptySnapshot: MonitorSnapshot = { alerts: [], checkedAt: 0, lastError: null };
const monitoredAssetTypes = new Set(["ecs", "cvm", "lighthouse", "swas", "server", "instance", "domain", "rds", "redis"]);
const assetTypeLabels: Record<string, string> = { ecs: "云服务器", cvm: "云服务器", lighthouse: "轻量服务器", swas: "轻量服务器", server: "服务器", instance: "服务器", domain: "域名", rds: "云数据库", redis: "Redis", oss: "对象存储" };
const assetStrategyEnabled = (settings: MonitorSettings, type: string) => {
  if (["ecs", "cvm", "server", "instance"].includes(type)) return settings.servers;
  if (["lighthouse", "swas"].includes(type)) return settings.lightServers;
  return type === "domain" ? settings.domains : type === "rds" ? settings.databases : type === "redis" ? settings.redis : false;
};
const assetAlertKey = (asset: LocalAsset) => `asset:${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
const assetName = (asset: LocalAsset) => ["InstanceName", "Name", "name", "DomainName", "BucketName"].map(key => asset.payload[key]).find(value => typeof value === "string" && value.trim()) as string | undefined ?? asset.asset_key;

export function MobileMonitorAlertsPage({ compact = false, onNavigate, onActiveCount, refreshRef, cachedAssets = [], accounts = [] }: { compact?: boolean; onNavigate?: (section: MonitorAlert["section"]) => void; onActiveCount?: (count: number) => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null>; cachedAssets?: LocalAsset[]; accounts?: Account[] }) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
  const [productFilter, setProductFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [clearing, setClearing] = useState(false);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const snapshotRevision = useRef(0);
  const mutationPending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [expandedAlerts, setExpandedAlerts] = useState<Set<string>>(() => new Set());
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [strategyGlobalOpen, setStrategyGlobalOpen] = useState(false);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategySaving, setStrategySaving] = useState(false);
  const [strategyError, setStrategyError] = useState("");
  const [strategyQuery, setStrategyQuery] = useState("");
  const [strategyType, setStrategyType] = useState("all");
  const [strategySettings, setStrategySettings] = useState<MonitorSettings>(defaultMonitorSettings);
  const [strategyAssets, setStrategyAssets] = useState<LocalAsset[]>([]);

  useEffect(() => {
    if (!strategiesOpen || !cachedAssets.length) return;
    setStrategyAssets(current => {
      const byKey = new Map(current.map(asset => [assetAlertKey(asset), asset]));
      cachedAssets.forEach(asset => byKey.set(assetAlertKey(asset), asset));
      return [...byKey.values()];
    });
  }, [cachedAssets, strategiesOpen]);

  const refresh = async () => {
    if (mutationPending.current) return;
    const revision = ++snapshotRevision.current;
    setLoading(true);
    setError("");
    try {
      const next = await monitorAlertsClient.snapshot();
      if (revision === snapshotRevision.current) setSnapshot(next);
    } catch (reason) {
      setError(platformErrorMessage(reason, "读取监控预警失败，请稍后重试。"));
    } finally {
      setLoading(false);
    }
  };

  const openStrategies = async () => {
    setStrategiesOpen(true); setStrategyGlobalOpen(false); setStrategyLoading(true); setStrategyError(""); setStrategyQuery(""); setStrategyType("all");

    try {
      const [settingsResult, assetsResult] = await Promise.allSettled([monitorAlertsClient.settings(), resourcesClient.listLocal()]);
      const errors: string[] = [];
      if (settingsResult.status === "fulfilled") setStrategySettings(settingsResult.value);
      else errors.push(platformErrorMessage(settingsResult.reason, "读取预警策略失败。"));
      const freshAssets = assetsResult.status === "fulfilled" ? assetsResult.value : [];
      if (assetsResult.status === "rejected") errors.push(platformErrorMessage(assetsResult.reason, "读取本机资产失败。"));
      const byKey = new Map([...cachedAssets, ...freshAssets].map(asset => [assetAlertKey(asset), asset]));
      setStrategyAssets([...byKey.values()]);
      setStrategyError(errors.join(" "));
    } catch (reason) { setStrategyAssets(cachedAssets); setStrategyError(platformErrorMessage(reason, "读取预警策略失败。")); }
    finally { setStrategyLoading(false); }
  };
  const updateSettings = async (patch: Partial<MonitorSettings>) => {
    const next = { ...strategySettings, ...patch };
    setStrategySaving(true); setStrategyError("");
    try { await monitorAlertsClient.save(next); setStrategySettings(next); }
    catch (reason) { setStrategyError(platformErrorMessage(reason, "保存预警策略失败。")); }
    finally { setStrategySaving(false); }
  };
  const setAssetParticipation = async (assets: LocalAsset[], enabled: boolean) => {
    const keys = new Set(assets.filter(asset => monitoredAssetTypes.has(asset.resource_type)).map(assetAlertKey));
    const excludedAssetAlerts = enabled
      ? strategySettings.excludedAssetAlerts.filter(key => !keys.has(key))
      : [...new Set([...strategySettings.excludedAssetAlerts, ...keys])];
    await updateSettings({ excludedAssetAlerts });
  };
  const runInspection = async () => {
    if (checking || loading || mutationPending.current) return;
    mutationPending.current = true;
    ++snapshotRevision.current;
    setChecking(true); setError("");
    try { await monitorAlertsClient.check(); setSnapshot(await monitorAlertsClient.snapshot()); }
    catch (reason) { setError(platformErrorMessage(reason, "立即巡检失败，请稍后重试。")); }
    finally { mutationPending.current = false; setChecking(false); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (clearing || checking || busyKey) return;
    const timer = window.setInterval(() => {
      if (mutationPending.current) return;
      const revision = ++snapshotRevision.current;
      void monitorAlertsClient.snapshot().then(next => { if (revision === snapshotRevision.current) { setSnapshot(next); setError(""); } }).catch(reason => setError(platformErrorMessage(reason, "刷新监控预警失败。")));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [clearing, checking, busyKey]);
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
  const alerts = useMemo(() => sortMonitorAlerts(rangeAlerts.filter(alert => status === "active" ? alert.active : !alert.active)), [rangeAlerts, status]);
  const productCounts = [...new Set(alerts.map(monitorAlertProductLabel))].map(label => ({ label, count: alerts.filter(alert => monitorAlertProductLabel(alert) === label).length }));
  const filteredAlerts = productFilter === "all" ? alerts : alerts.filter(alert => monitorAlertProductLabel(alert) === productFilter);
  const pageCount = Math.max(1, Math.ceil(filteredAlerts.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageAlerts = filteredAlerts.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedCount = filteredAlerts.filter(alert => selectedKeys.has(alert.key)).length;
  const allSelected = filteredAlerts.length > 0 && selectedCount === filteredAlerts.length;
  const mutedCount = snapshot.alerts.filter(alert => alert.active && alert.ignored).length;
  const checkedLabel = snapshot.checkedAt ? new Date(snapshot.checkedAt * 1000).toLocaleString("zh-CN") : "尚无检查记录";
  useEffect(() => { setSelectedKeys(current => new Set([...current].filter(key => filteredAlerts.some(alert => alert.key === key)))); }, [snapshot.alerts, status, range, productFilter]);
  const clearSelected = async () => {
    const keys = filteredAlerts.filter(alert => selectedKeys.has(alert.key)).map(alert => alert.key);
    if (!keys.length || clearing || checking || busyKey) return;
    if (!await confirm({ title: "清理所选预警", message: `将永久清理选中的 ${keys.length} 条预警记录，包括未解除或已解除记录。此操作无法撤销。`, confirmLabel: "清理所选" })) return;
    mutationPending.current = true;
    ++snapshotRevision.current; setClearing(true); setError("");
    try { setSnapshot(await monitorAlertsClient.clearSelected(keys)); setSelectedKeys(new Set()); }
    catch (reason) { setError(platformErrorMessage(reason, "清理预警失败，请稍后重试。")); }
    finally { mutationPending.current = false; setClearing(false); }
  };
  const activeCount = snapshot.alerts.filter(alert => alert.active).length;
  const recoveredCount = snapshot.alerts.filter(alert => !alert.active).length;
  const assetTypes = [...new Set(strategyAssets.map(asset => asset.resource_type))].sort((a, b) => (assetTypeLabels[a] ?? a).localeCompare(assetTypeLabels[b] ?? b, "zh-CN"));
  const visibleAssets = strategyAssets.filter(asset => (strategyType === "all" || asset.resource_type === strategyType) && `${assetName(asset)} ${asset.asset_key} ${assetTypeLabels[asset.resource_type] ?? asset.resource_type} ${asset.account_id}`.toLowerCase().includes(strategyQuery.trim().toLowerCase()));
  const supportedVisibleAssets = visibleAssets.filter(asset => monitoredAssetTypes.has(asset.resource_type) && assetStrategyEnabled(strategySettings, asset.resource_type));
  const allVisibleEnabled = supportedVisibleAssets.length > 0 && supportedVisibleAssets.every(asset => !strategySettings.excludedAssetAlerts.includes(assetAlertKey(asset)));
  useEffect(() => { onActiveCount?.(activeCount); }, [activeCount, onActiveCount]);

  return <div className="mobile-alerts-page mobile-alerts-pc-aligned">
    {!compact && <header className="mobile-alerts-heading">
      <div className="mobile-alerts-compact-title"><h1><BellRing size={21} />监控预警</h1><button type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}>{checking ? "巡检中…" : "操作"}<ChevronDown size={15} /></button></div>
      {toolsOpen && <div className="mobile-alerts-heading-actions"><button type="button" className="mobile-alert-header-action" onClick={() => void openStrategies()}><Settings2 size={15} />预警策略</button><button type="button" className="mobile-alert-header-action" disabled={checking || loading || clearing || !!busyKey} onClick={() => void runInspection()}><Activity size={15} className={checking ? "mobile-spin" : undefined} />{checking ? "巡检中…" : "立即巡检"}</button><button type="button" className="mobile-alert-header-action" disabled={checking || loading || clearing || !!busyKey} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "mobile-spin" : undefined} />刷新</button></div>}
      {toolsOpen && <p className="mobile-alerts-check-meta">最近检查：{checkedLabel} · {mutedCount} 条已静音</p>}
    </header>}
    {error && <p className="mobile-alerts-message" role="alert">{error}</p>}{snapshot.lastError && !error && <p className="mobile-alerts-message" role="status">{snapshot.lastError}</p>}
    <section className="mobile-alert-results" aria-label="预警记录">
      <header className="mobile-alert-results-heading mobile-alert-results-compact-heading"><span>{filteredAlerts.length} 条记录</span>{filteredAlerts.length > 0 && <button type="button" disabled={clearing} aria-pressed={selectionMode} onClick={() => { setSelectionMode(value => !value); setSelectedKeys(new Set()); }}>{selectionMode ? "退出多选" : "批量选择"}</button>}</header>
      <div className="mobile-alerts-filters" role="group" aria-label="预警状态筛选">{([["active", "未解除", activeCount], ["recovered", "已解除", recoveredCount]] as const).map(([value,label,count]) => <button type="button" key={value} aria-pressed={status === value} onClick={() => { setStatus(value); setProductFilter("all"); setPage(1); }}>{label} <span>{count}</span></button>)}</div>
      <button type="button" className="mobile-alert-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(open => !open)}><Filter size={14} /><span>{productFilter === "all" ? "全部产品" : productFilter} · {range === "today" ? "今日" : range === "yesterday" ? "昨天" : range === "7days" ? "7天" : "全部时间"}</span><ChevronDown size={14} /></button>
      {filtersOpen && <div className="mobile-alert-filter-options">
      <div className="mobile-alert-product-filters" role="group" aria-label="按预警产品筛选"><button type="button" aria-pressed={productFilter === "all"} onClick={() => { setProductFilter("all"); setPage(1); }}>全部 <strong>{alerts.length}</strong></button>{productCounts.map(item => <button type="button" key={item.label} aria-pressed={productFilter === item.label} onClick={() => { setProductFilter(item.label); setPage(1); }}>{item.label} <strong>{item.count}</strong></button>)}</div>
      <div className="mobile-alerts-filters mobile-alerts-range" role="group" aria-label="预警时间范围">{([["today","今日"],["yesterday","昨天"],["7days","7天"],["all","全部"]] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setRange(value); setProductFilter("all"); setPage(1); }}>{label}</button>)}</div>
      </div>}
      {selectionMode && filteredAlerts.length > 0 && <div className="mobile-alert-selection"><label><input type="checkbox" checked={allSelected} ref={input => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} disabled={!filteredAlerts.length || clearing || checking} onChange={event => setSelectedKeys(event.target.checked ? new Set(filteredAlerts.map(alert => alert.key)) : new Set())} />全选当前结果（{filteredAlerts.length}）</label><button type="button" disabled={!selectedCount || clearing || checking || !!busyKey} onClick={() => void clearSelected()}><Trash2 size={14} />{clearing ? "清理中…" : `清理所选${selectedCount ? `（${selectedCount}）` : ""}`}</button></div>}
      {loading && !snapshot.alerts.length ? <p className="mobile-alerts-empty" role="status">正在读取监控预警…</p> : !filteredAlerts.length ? <div className="mobile-alerts-empty"><CheckCircle2 size={26} /><strong>{productFilter !== "all" ? `暂无${productFilter}预警` : status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>巡检失败或未获取到数据的资源不会被视为正常。</span></div> : <div className="mobile-alert-list">{pageAlerts.map(alert => {
        const expanded = expandedAlerts.has(alert.key);
        return <article className={`mobile-alert-row is-${alert.active ? alert.severity : "recovered"}`} key={alert.key}>
          <div className={`mobile-alert-row-summary${selectionMode ? " is-selecting" : ""}`}>{selectionMode && <label className="mobile-alert-row-select"><input type="checkbox" aria-label={`选择预警：${alert.title}`} checked={selectedKeys.has(alert.key)} disabled={clearing || checking} onChange={event => setSelectedKeys(current => { const next = new Set(current); event.target.checked ? next.add(alert.key) : next.delete(alert.key); return next; })} /></label>}<button type="button" className="mobile-alert-row-disclosure" aria-expanded={expanded} onClick={() => setExpandedAlerts(current => { const next = new Set(current); next.has(alert.key) ? next.delete(alert.key) : next.add(alert.key); return next; })}><span className="mobile-alert-row-name"><ShieldAlert size={16} /><strong>{alert.title}</strong></span><span className="mobile-alert-row-tags"><small>{monitorAlertProductLabel(alert)}</small><small>{!alert.active ? "已解除" : alert.ignored ? "已静音" : monitorSeverityLabel(alert.severity)}</small></span><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString("zh-CN")}</time><ChevronDown size={16} className="mobile-alert-row-chevron" /></button></div>
          {expanded && <div className="mobile-alert-row-detail">{alert.active && alert.ignored && <p>预警仍在监控，已停止重复通知。</p>}<p>{alert.detail}</p><small>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</small><div className="mobile-alert-row-actions">{onNavigate && <button type="button" onClick={() => onNavigate(alert.section)}>查看{alert.section === "resources" ? "资源" : alert.section === "certificates" ? "证书" : alert.section === "panels" ? "面板" : "备忘录"}</button>}{alert.active && <button type="button" disabled={!!busyKey || clearing || checking} onClick={() => { mutationPending.current = true; ++snapshotRevision.current; setBusyKey(alert.key); void monitorAlertsClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => { mutationPending.current = false; setBusyKey(""); }); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "取消静音" : "静音提醒"}</button>}</div></div>}
        </article>;
      })}</div>}
      {filteredAlerts.length > 0 && <PaginationBar className="mobile-alert-pagination-bar" page={safePage} pageSize={pageSize} total={filteredAlerts.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} disabled={clearing} />}
    </section>
    {confirmationDialog}
    {strategiesOpen && <SharedDialog title="预警策略" subtitle="配置巡检范围与提醒规则，并管理资产是否参与监控。" icon={<Settings2 size={20} aria-hidden="true" />} size="small" className="mobile-alert-strategy-dialog" closeLabel="关闭预警策略" onClose={() => setStrategiesOpen(false)} footer={<button type="button" className="secondary" onClick={() => setStrategiesOpen(false)}>完成</button>}>
      {strategyError && <p className="mobile-alerts-message" role="alert">{strategyError}</p>}
      {strategyLoading ? <p className="mobile-strategy-loading" role="status">正在读取资产与策略…</p> : <>
        <div className="mobile-strategy-summary"><button type="button" className="mobile-strategy-summary-toggle" aria-expanded={strategyGlobalOpen} onClick={() => setStrategyGlobalOpen(open => !open)}><strong>全局策略</strong><ChevronDown size={15} aria-hidden="true" className="mobile-strategy-summary-chevron" /></button>{strategyGlobalOpen && <div className="mobile-strategy-summary-chips"><span>运维预警 {strategySettings.monitoring ? "已开启" : "已关闭"}</span><span>到期提前 {strategySettings.expiryDays} 天</span><span>CPU {strategySettings.cpuThreshold}% · 磁盘 {strategySettings.diskThreshold}%</span></div>}</div>
        {strategyGlobalOpen && <section className="mobile-strategy-config" aria-label="巡检范围与提醒规则">
          <label className="mobile-strategy-master"><span><strong>启用运维预警</strong><small>App 前台按设定间隔巡检；退到后台、锁屏或退出后不保证执行</small></span><input type="checkbox" aria-label="启用运维预警" checked={strategySettings.monitoring} disabled={strategySaving} onChange={event => void updateSettings({ monitoring: event.target.checked })} /></label>
          <MonitorScopeGroups settings={strategySettings} disabled={!strategySettings.monitoring || strategySaving} onChange={patch => void updateSettings(patch)} />
          <div className="mobile-strategy-tunings">
            <label>巡检间隔<select aria-label="策略巡检间隔" value={strategySettings.intervalSeconds} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ intervalSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></label>
            <label>到期提醒<select aria-label="策略到期提醒" value={strategySettings.expiryDays} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ expiryDays: Number(event.target.value) })}><option value={7}>提前 7 天</option><option value={30}>提前 30 天</option><option value={60}>提前 60 天</option></select></label>
            {(["cpuThreshold", "diskThreshold"] as const).map(key => <label key={key}>{key === "cpuThreshold" ? "CPU" : "磁盘"}阈值<select aria-label={`策略${key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值`} value={strategySettings[key]} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ [key]: Number(event.target.value) })}>{[70, 80, 90, 95].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>)}
          </div>
        </section>}
        <div className="mobile-strategy-assets-heading"><strong>资产监控</strong><span>{strategyAssets.length} 项资产</span></div>
        <div className="mobile-strategy-toolbar"><label className="mobile-strategy-type">类型<select aria-label="按资产类型筛选" value={strategyType} onChange={event => setStrategyType(event.target.value)}><option value="all">全部类型（{strategyAssets.length}）</option>{assetTypes.map(type => <option key={type} value={type}>{assetTypeLabels[type] ?? type}（{strategyAssets.filter(asset => asset.resource_type === type).length}）</option>)}</select></label><label className="mobile-strategy-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索预警策略资产" placeholder="搜索名称、ID、账号" value={strategyQuery} onChange={event => setStrategyQuery(event.target.value)} /></label></div>
        <div className="mobile-strategy-select-all"><label><input type="checkbox" aria-label="全选当前筛选资产参与监控" checked={allVisibleEnabled} disabled={!supportedVisibleAssets.length || strategySaving || !strategySettings.monitoring} onChange={event => void setAssetParticipation(supportedVisibleAssets, event.target.checked)} /><span>全选当前筛选结果（{supportedVisibleAssets.length}）</span></label><small>仅全选已开启产品策略的资产</small></div>
        <div className="mobile-strategy-list" aria-busy={strategyLoading}>{strategyLoading ? <p className="mobile-strategy-loading">正在读取资产与策略…</p> : visibleAssets.length ? visibleAssets.map(asset => {
          const supported = monitoredAssetTypes.has(asset.resource_type);
          const participating = strategySettings.monitoring && assetStrategyEnabled(strategySettings, asset.resource_type) && !strategySettings.excludedAssetAlerts.includes(assetAlertKey(asset));
          const label = `${assetTypeLabels[asset.resource_type] ?? asset.resource_type}到期提醒 · 提前 ${strategySettings.expiryDays} 天`;
          const accountName = accounts.find(account => account.id === asset.account_id)?.account_name ?? `账号 ${asset.account_id}`;
          return <article className="mobile-strategy-asset" key={assetAlertKey(asset)}><div><strong>{assetName(asset)}</strong><span>{accountName} · {assetTypeLabels[asset.resource_type] ?? asset.resource_type}</span><small>{supported ? asset.resource_type === "domain" ? `${label}（以采集到的有效期为准）` : label : "当前版本暂无此类资产的预警规则"}</small></div>{supported ? <label className="mobile-strategy-asset-toggle"><input type="checkbox" aria-label={`${assetName(asset)}参与${asset.resource_type === "domain" ? "域名" : "服务器"}到期监控`} checked={participating} disabled={strategySaving || !strategySettings.monitoring || !assetStrategyEnabled(strategySettings, asset.resource_type)} onChange={event => void setAssetParticipation([asset], event.target.checked)} /><span>{participating ? "监控中" : "未参与"}</span></label> : <span className="mobile-strategy-unsupported">未支持</span>}</article>;
        }) : <p className="mobile-strategy-empty">{strategyAssets.length ? "没有匹配的资产。" : "本机暂无已保存资产。"}</p>}</div>
      </>}
    </SharedDialog>}
  </div>;
}
