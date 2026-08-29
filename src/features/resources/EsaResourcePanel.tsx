import { Cloud, RefreshCw, Search } from "lucide-react";
import type { EsaOverview, ResourceResponse } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { cloudStatusText, formatEsaTime } from "./presentation";
import { formatBytes, formatMetric } from "../panels/panelMetrics";

type EsaTab = "overview" | "sites" | "functions";

export function EsaResourcePanel({
  source,
  resources,
  loading,
  tab,
  range,
  trend,
  selectedSiteId,
  overview,
  siteKeyword,
  onTabChange,
  onRangeChange,
  onTrendChange,
  onSelectedSiteChange,
  onOverviewChange,
  onSiteKeywordChange,
  onRefresh,
  onOpenConsole,
}: {
  source: "cache" | "live";
  resources: ResourceResponse | null;
  loading: boolean;
  tab: EsaTab;
  range: string;
  trend: keyof EsaOverview["trend"];
  selectedSiteId: string;
  overview: EsaOverview | null;
  siteKeyword: string;
  onTabChange: (value: EsaTab) => void;
  onRangeChange: (value: string) => void;
  onTrendChange: (value: keyof EsaOverview["trend"]) => void;
  onSelectedSiteChange: (value: string) => void;
  onOverviewChange: (value: EsaOverview | null) => void;
  onSiteKeywordChange: (value: string) => void;
  onRefresh: () => void;
  onOpenConsole: () => void;
}) {
  const sites = resources?.items || [];
  const visibleSites = sites.filter((item) => {
    const keyword = siteKeyword.trim().toLowerCase();
    return !keyword || [item.SiteName, item.DomainName, item.SiteId, item.Name].some((value) => String(value || "").toLowerCase().includes(keyword));
  });
  const trendPoints = overview?.trend[trend] || [];
  const trendMax = Math.max(1, ...trendPoints.map((point) => point.value));
  const chartPath = trendPoints.map((point, index) => {
    const x = trendPoints.length === 1 ? 36 : 36 + (index / (trendPoints.length - 1)) * 688;
    const y = 172 - (point.value / trendMax) * 138;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const trendOptions: { value: keyof EsaOverview["trend"]; label: string }[] = [
    { value: "traffic", label: "流量" }, { value: "requests", label: "请求数" }, { value: "page_view", label: "PV" },
  ];
  const dataSourceLabel = source === "live" && overview ? "实时数据" : "本地站点缓存";
  const siteOptions = overview?.site_options || sites.map((site) => ({ id: String(site.SiteId || ""), name: displayValue(site.SiteName || site.DomainName || site.Name) }));
  return (
    <div className="esa-reference">
      <div className="esa-tabs" aria-label="边缘安全加速视图">
        <button type="button" aria-pressed={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => onTabChange("overview")}>数据概览</button>
        <button type="button" aria-pressed={tab === "sites"} className={tab === "sites" ? "active" : ""} onClick={() => onTabChange("sites")}>站点列表</button>
        <button type="button" aria-pressed={tab === "functions"} className={tab === "functions" ? "active" : ""} onClick={() => onTabChange("functions")}>函数和 Pages</button>
      </div>
      <div className="esa-head"><div className="esa-head-copy"><h3>边缘安全加速</h3><span className={`esa-data-source${source === "live" && overview ? " is-live" : ""}`}>{dataSourceLabel}</span></div><button className="layui-btn layui-btn-primary" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button></div>
      {tab === "overview" && <>
        <div className="esa-overview-toolbar">
          <label className="esa-site-filter"><span>站点</span><select value={selectedSiteId} onChange={(event) => { onSelectedSiteChange(event.target.value); onOverviewChange(null); }}><option value="">全部站点</option>{siteOptions.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
          <div className="esa-range-tabs" aria-label="统计范围">{[["today", "今日"], ["yesterday", "昨日"], ["week", "近 7 日"], ["month", "近 30 日"]].map(([value, label]) => <button type="button" key={value} aria-pressed={range === value} className={range === value ? "active" : ""} onClick={() => { onRangeChange(value); onOverviewChange(null); }}>{label}</button>)}</div>
          <span className="esa-toolbar-hint">{overview ? `${overview.range_label}实时统计` : "选择范围后点击实时拉取"}</span>
        </div>
        <div className="metric-grid">
          <div className={`metric-card${overview ? "" : " is-cache"}`}><div className="label">边缘响应流量</div><div className="value">{overview ? formatBytes(overview.traffic) : "-"}</div><div className="hint">{overview?.range_label || "本地缓存未包含统计"}</div></div>
          <div className={`metric-card${overview ? "" : " is-cache"}`}><div className="label">总请求数</div><div className="value">{overview ? formatMetric(overview.requests) : "-"}</div><div className="hint">{overview?.range_label || "本地缓存未包含统计"}</div></div>
          <div className={`metric-card${overview ? "" : " is-cache"}`}><div className="label">WAF 防护请求数</div><div className="value">{overview ? formatMetric(overview.defence_requests) : "-"}</div><div className="hint">已拦截的 WAF 请求</div></div>
        </div>
        <div className="esa-chart-panel">
          <div className="esa-chart-head"><strong>{trendOptions.find((item) => item.value === trend)?.label}趋势</strong><div className="esa-trend-tabs">{trendOptions.map((item) => <button key={item.value} className={trend === item.value ? "active" : ""} onClick={() => onTrendChange(item.value)}>{item.label}</button>)}</div></div>
          {overview ? <><svg className="esa-chart" viewBox="0 0 760 210" preserveAspectRatio="none" role="img" aria-label="ESA 趋势图"><line x1="36" x2="724" y1="172" y2="172" /><line x1="36" x2="724" y1="103" y2="103" /><line x1="36" x2="724" y1="34" y2="34" />{chartPath && <path className="esa-chart-line" d={chartPath} />}</svg><div className="esa-chart-axis"><span>{formatEsaTime(trendPoints[0]?.time || "")}</span><span>{formatEsaTime(trendPoints[Math.floor(trendPoints.length / 2)]?.time || "")}</span><span>{formatEsaTime(trendPoints[trendPoints.length - 1]?.time || "")}</span></div></> : <div className="esa-chart-empty"><RefreshCw size={20} aria-hidden="true" /><strong>尚未拉取趋势数据</strong><span>选择站点和统计范围后，拉取数据即可查看趋势。</span><button type="button" className="esa-chart-empty-action" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "拉取趋势数据"}</button></div>}
        </div>
        <div className="site-summary esa-site-summary">已接入 <b>{overview?.site_count ?? sites.length}</b> 个站点，其中 <b>{overview?.active_count ?? sites.filter((item) => String(item.Status || "").toLowerCase() === "active").length}</b> 个已启用。</div>
      </>}
      {tab === "sites" && <div className="esa-sites"><div className="esa-sites-toolbar"><div className="site-summary">本地缓存共 <b>{sites.length}</b> 个站点</div><label className="esa-site-search"><Search size={14} /><input value={siteKeyword} onChange={(event) => onSiteKeywordChange(event.target.value)} placeholder="搜索站点或站点 ID" /></label></div>{visibleSites.length ? <div className="resource-table-wrap"><table><thead><tr><th>站点</th><th>站点 ID</th><th>接入方式</th><th>覆盖范围</th><th>状态</th><th>套餐</th><th>操作</th></tr></thead><tbody>{visibleSites.map((item, index) => <tr key={String(item.SiteId || index)}><td>{displayValue(item.SiteName || item.DomainName || item.Name)}</td><td><code>{displayValue(item.SiteId || item.Id)}</code></td><td>{displayValue(item.AccessType)}</td><td>{displayValue(item.Coverage || item.Region)}</td><td>{cloudStatusText(item.Status || item.SiteStatus)}</td><td>{displayValue(item.PlanName || item.Plan)}</td><td><button className="table-action" onClick={onOpenConsole}>控制台</button></td></tr>)}</tbody></table></div> : <div className="detail-empty"><Cloud size={34} />暂无匹配的边缘站点</div>}</div>}
      {tab === "functions" && <div className="function-panel"><h3>边缘函数和 Pages</h3><p>函数、Pages 项目及路由配置由云厂商边缘控制台统一管理。</p><button className="layui-btn" onClick={onOpenConsole}>打开边缘控制台</button></div>}
    </div>
  );
}
