import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { Activity, CheckCircle2, ChevronLeft, ChevronRight, Search, Settings2, ShieldAlert } from "lucide-react";
import { runningInTauri, platformErrorMessage } from "../platform/api";
import { monitorSeverityLabel, sortMonitorAlerts, type MonitorAlert, type MonitorSnapshot } from "../platform/clients/monitorAlerts";
import { defaultMonitorSettings, monitorAlertsClient, type MonitorSettings } from "../platform/clients/monitorAlerts";
import type { Account, LocalAsset } from "../shared/types";
import { resourcesClient } from "../platform/clients/resources";
import { SharedDialog } from "../shared/SharedDialog";

const pageSize = 6;
const emptySnapshot: MonitorSnapshot = { alerts: [], checkedAt: 0, lastError: null };
const monitoredAssetTypes = new Set(["ecs", "cvm", "lighthouse", "swas", "server", "instance", "domain"]);
const assetTypeLabels: Record<string, string> = { ecs: "云服务器", cvm: "云服务器", lighthouse: "轻量服务器", swas: "轻量服务器", server: "服务器", instance: "服务器", domain: "域名", oss: "对象存储" };
const assetAlertKey = (asset: LocalAsset) => `asset:${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
const assetName = (asset: LocalAsset) => ["InstanceName", "Name", "name", "DomainName", "BucketName"].map(key => asset.payload[key]).find(value => typeof value === "string" && value.trim()) as string | undefined ?? asset.asset_key;

export function MobileMonitorAlertsPage({ compact = false, onActiveCount, refreshRef, cachedAssets = [], accounts = [] }: { compact?: boolean; onActiveCount?: (count: number) => void; refreshRef?: MutableRefObject<(() => Promise<void>) | null>; cachedAssets?: LocalAsset[]; accounts?: Account[] }) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(emptySnapshot);
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const [range, setRange] = useState<"today" | "yesterday" | "7days" | "all">("7days");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
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
    if (!runningInTauri) {
      setError("浏览器预览无法读取本机运维预警，请在桌面或移动客户端中查看。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setSnapshot(await monitorAlertsClient.snapshot());
    } catch (reason) {
      setError(platformErrorMessage(reason, "读取监控预警失败，请稍后重试。"));
    } finally {
      setLoading(false);
    }
  };

  const openStrategies = async () => {
    setStrategiesOpen(true); setStrategyLoading(true); setStrategyError(""); setStrategyQuery(""); setStrategyType("all");
    if (!runningInTauri) { setStrategyError("预警策略仅支持原生移动 App。请在 CloudHub Tools App 中打开。"); setStrategyLoading(false); return; }
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
    if (!runningInTauri || checking || loading) return;
    setChecking(true); setError("");
    try { await monitorAlertsClient.check(); setSnapshot(await monitorAlertsClient.snapshot()); }
    catch (reason) { setError(platformErrorMessage(reason, "立即巡检失败，请稍后重试。")); }
    finally { setChecking(false); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!runningInTauri) return;
    const timer = window.setInterval(() => {
      void monitorAlertsClient.snapshot().then(next => { setSnapshot(next); setError(""); }).catch(reason => setError(platformErrorMessage(reason, "刷新监控预警失败。")));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
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
  const pageCount = Math.max(1, Math.ceil(alerts.length / pageSize));
  const pageAlerts = alerts.slice((page - 1) * pageSize, page * pageSize);
  const activeCount = snapshot.alerts.filter(alert => alert.active && !alert.ignored).length;
  const recoveredCount = snapshot.alerts.filter(alert => !alert.active).length;
  const assetTypes = [...new Set(strategyAssets.map(asset => asset.resource_type))].sort((a, b) => (assetTypeLabels[a] ?? a).localeCompare(assetTypeLabels[b] ?? b, "zh-CN"));
  const visibleAssets = strategyAssets.filter(asset => (strategyType === "all" || asset.resource_type === strategyType) && `${assetName(asset)} ${asset.asset_key} ${assetTypeLabels[asset.resource_type] ?? asset.resource_type} ${asset.account_id}`.toLowerCase().includes(strategyQuery.trim().toLowerCase()));
  const supportedVisibleAssets = visibleAssets.filter(asset => monitoredAssetTypes.has(asset.resource_type));
  const allVisibleEnabled = supportedVisibleAssets.length > 0 && supportedVisibleAssets.every(asset => !strategySettings.excludedAssetAlerts.includes(assetAlertKey(asset)));
  useEffect(() => { onActiveCount?.(activeCount); }, [activeCount, onActiveCount]);

  return <div className="mobile-alerts-page">
    {!compact && <header className="mobile-alerts-heading">
      <div className="mobile-alerts-title"><div><h1>监控预警</h1><span>本机运维状态</span></div><p>集中查看服务器、域名与证书预警，管理策略并发起巡检。</p></div>
      <div className="mobile-alerts-heading-actions"><button type="button" className="mobile-alert-header-action" onClick={() => void openStrategies()}><Settings2 size={16} aria-hidden="true" />预警策略</button><button type="button" className="mobile-alert-header-action is-primary" disabled={!runningInTauri || checking || loading} title={!runningInTauri ? "立即巡检仅支持原生移动 App" : undefined} onClick={() => void runInspection()}><Activity size={16} className={checking ? "mobile-spin" : undefined} aria-hidden="true" />{checking ? "巡检中" : "立即巡检"}</button></div>
    </header>}
    <div className="mobile-alerts-filters" role="group" aria-label="预警状态筛选">
      <button type="button" aria-pressed={status === "active"} onClick={() => { setStatus("active"); setPage(1); }}>未解除 <span>{activeCount}</span></button>
      <button type="button" aria-pressed={status === "recovered"} onClick={() => { setStatus("recovered"); setPage(1); }}>已解除 <span>{recoveredCount}</span></button>
    </div>
    <div className="mobile-alerts-filters mobile-alerts-range" role="group" aria-label="预警时间范围">{([['today','今日'],['yesterday','昨天'],['7days','7天'],['all','全部']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={range === value} onClick={() => { setRange(value); setPage(1); }}>{label}</button>)}</div>
    {error && <p className="mobile-alerts-message" role="alert">{error}</p>}
    {snapshot.lastError && !error && <p className="mobile-alerts-message" role="status">{snapshot.lastError}</p>}
    {loading && snapshot.alerts.length === 0 ? <div className="mobile-alerts-skeleton" role="status" aria-busy="true" aria-label="正在读取监控预警"><span className="mobile-skeleton-sr">正在读取监控预警</span><div className="mobile-skeleton-summary"><i /><i /></div>{[0,1,2].map(index => <article className="mobile-alert-card mobile-alert-skeleton-card" key={index}><i /><i /><i /></article>)}</div>
      : pageAlerts.length === 0 ? <div className="mobile-alerts-empty"><CheckCircle2 size={28} aria-hidden="true" /><strong>{status === "active" ? "暂无未解除预警" : "暂无已解除预警"}</strong><span>预警由本机监控策略生成；巡检失败或未获取到数据的资源不会被当作正常。</span></div>
      : <div className="mobile-alert-list" aria-live="polite">{pageAlerts.map((alert: MonitorAlert) => <article className={`mobile-alert-card is-${alert.active ? alert.severity : "recovered"}`} key={alert.key}>
        <div className="mobile-alert-card-title"><span className="mobile-alert-card-icon"><ShieldAlert size={17} aria-hidden="true" /></span><strong>{alert.title}</strong><span className="mobile-alert-severity">{!alert.active ? "已解除" : alert.ignored ? "已静音" : monitorSeverityLabel(alert.severity)}</span></div>
        {alert.active && alert.ignored && <p className="mobile-alert-muted-note">预警仍在监控，系统已停止重复通知。</p>}
        <p>{alert.detail}</p>
        <footer><time dateTime={new Date(alert.updatedAt * 1000).toISOString()}>{new Date(alert.updatedAt * 1000).toLocaleString()}</time><span>{alert.occurrences > 1 ? `发生 ${alert.occurrences} 次` : "监控预警"}</span></footer>
        {alert.active && <button className="mobile-alert-action" type="button" disabled={!!busyKey} onClick={() => { setBusyKey(alert.key); void monitorAlertsClient.ignore([alert.key], !alert.ignored).then(setSnapshot).catch(reason => setError(platformErrorMessage(reason, "更新预警状态失败。"))).finally(() => setBusyKey("")); }}>{busyKey === alert.key ? "处理中…" : alert.ignored ? "取消静音" : "静音提醒"}</button>}
      </article>)}</div>}
    {!compact && alerts.length > 0 && <nav className="mobile-alert-pagination" aria-label="预警列表分页">
      <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(current => current - 1)}><ChevronLeft size={17} aria-hidden="true" />上一页</button>
      <span>第 <strong>{page}</strong> / {pageCount} 页 · 共 {alerts.length} 条</span>
      <button type="button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)}>下一页<ChevronRight size={17} aria-hidden="true" /></button>
    </nav>}
    {strategiesOpen && <SharedDialog title="预警策略" subtitle="配置巡检范围与提醒规则，并管理资产是否参与监控。" icon={<Settings2 size={20} aria-hidden="true" />} size="small" className="mobile-alert-strategy-dialog" closeLabel="关闭预警策略" onClose={() => setStrategiesOpen(false)} footer={<button type="button" className="secondary" onClick={() => setStrategiesOpen(false)}>完成</button>}>
      {strategyError && <p className="mobile-alerts-message" role="alert">{strategyError}</p>}
      {strategyLoading ? <p className="mobile-strategy-loading" role="status">正在读取资产与策略…</p> : <>
        <div className="mobile-strategy-summary"><strong>全局策略</strong><span>运维预警 {strategySettings.monitoring ? "已开启" : "已关闭"}</span><span>到期提前 {strategySettings.expiryDays} 天</span><span>CPU {strategySettings.cpuThreshold}% · 磁盘 {strategySettings.diskThreshold}%</span></div>
        <section className="mobile-strategy-config" aria-label="巡检范围与提醒规则">
          <label className="mobile-strategy-master"><span><strong>启用运维预警</strong><small>App 前台按设定间隔巡检；退到后台、锁屏或退出后不保证执行</small></span><input type="checkbox" aria-label="启用运维预警" checked={strategySettings.monitoring} disabled={strategySaving} onChange={event => void updateSettings({ monitoring: event.target.checked })} /></label>
          <div className="mobile-strategy-options">{([["certificates", "HTTPS 证书到期"], ["servers", "服务器与域名到期"], ["panels", "宝塔资源与服务巡检"], ["panelAccess", "面板访问异常"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={strategySettings[key]} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
          <div className="mobile-strategy-tunings">
            <label>巡检间隔<select aria-label="策略巡检间隔" value={strategySettings.intervalSeconds} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ intervalSeconds: Number(event.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></label>
            <label>到期提醒<select aria-label="策略到期提醒" value={strategySettings.expiryDays} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ expiryDays: Number(event.target.value) })}><option value={7}>提前 7 天</option><option value={30}>提前 30 天</option><option value={60}>提前 60 天</option></select></label>
            {(["cpuThreshold", "diskThreshold"] as const).map(key => <label key={key}>{key === "cpuThreshold" ? "CPU" : "磁盘"}阈值<select aria-label={`策略${key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值`} value={strategySettings[key]} disabled={!strategySettings.monitoring || strategySaving} onChange={event => void updateSettings({ [key]: Number(event.target.value) })}>{[70, 80, 90, 95].map(value => <option key={value} value={value}>{value}%</option>)}</select></label>)}
          </div>
        </section>
        <div className="mobile-strategy-assets-heading"><strong>资产监控</strong><span>{strategyAssets.length} 项资产</span></div>
        <div className="mobile-strategy-toolbar"><label className="mobile-strategy-type">类型<select aria-label="按资产类型筛选" value={strategyType} onChange={event => setStrategyType(event.target.value)}><option value="all">全部类型（{strategyAssets.length}）</option>{assetTypes.map(type => <option key={type} value={type}>{assetTypeLabels[type] ?? type}（{strategyAssets.filter(asset => asset.resource_type === type).length}）</option>)}</select></label><label className="mobile-strategy-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索预警策略资产" placeholder="搜索名称、ID、账号" value={strategyQuery} onChange={event => setStrategyQuery(event.target.value)} /></label></div>
        <div className="mobile-strategy-select-all"><label><input type="checkbox" aria-label="全选当前筛选资产参与监控" checked={allVisibleEnabled} disabled={!supportedVisibleAssets.length || strategySaving || !strategySettings.monitoring || !strategySettings.servers} onChange={event => void setAssetParticipation(supportedVisibleAssets, event.target.checked)} /><span>全选当前筛选结果（{supportedVisibleAssets.length}）</span></label><small>仅支持服务器与域名到期监控</small></div>
        <div className="mobile-strategy-list" aria-busy={strategyLoading}>{strategyLoading ? <p className="mobile-strategy-loading">正在读取资产与策略…</p> : visibleAssets.length ? visibleAssets.map(asset => {
          const supported = monitoredAssetTypes.has(asset.resource_type);
          const participating = strategySettings.monitoring && strategySettings.servers && !strategySettings.excludedAssetAlerts.includes(assetAlertKey(asset));
          const label = asset.resource_type === "domain" ? `域名到期提醒 · 提前 ${strategySettings.expiryDays} 天` : `服务器到期提醒 · 提前 ${strategySettings.expiryDays} 天`;
          const accountName = accounts.find(account => account.id === asset.account_id)?.account_name ?? `账号 ${asset.account_id}`;
          return <article className="mobile-strategy-asset" key={assetAlertKey(asset)}><div><strong>{assetName(asset)}</strong><span>{accountName} · {assetTypeLabels[asset.resource_type] ?? asset.resource_type}</span><small>{supported ? asset.resource_type === "domain" ? `${label}（以采集到的有效期为准）` : label : "当前版本暂无此类资产的预警规则"}</small></div>{supported ? <label className="mobile-strategy-asset-toggle"><input type="checkbox" aria-label={`${assetName(asset)}参与${asset.resource_type === "domain" ? "域名" : "服务器"}到期监控`} checked={participating} disabled={strategySaving || !strategySettings.monitoring || !strategySettings.servers} onChange={event => void setAssetParticipation([asset], event.target.checked)} /><span>{participating ? "监控中" : "未参与"}</span></label> : <span className="mobile-strategy-unsupported">未支持</span>}</article>;
        }) : <p className="mobile-strategy-empty">{strategyAssets.length ? "没有匹配的资产。" : "本机暂无已保存资产。"}</p>}</div>
      </>}
    </SharedDialog>}
  </div>;
}
