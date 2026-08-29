import { type ReactNode, useMemo } from "react";
import { createPortal } from "react-dom";
import { Cloud, X } from "lucide-react";
import { DomainResourcePanel } from "../domains/DomainResourcePanel";
import type { Account, ConfirmRequest, DomainTool, EsaOverview, LocalAsset, ResourceResponse, View } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { columnLabel, resourceColumns } from "./presentation";
import { AccountSummaryPanel } from "./AccountSummaryPanel";
import { EsaResourcePanel } from "./EsaResourcePanel";
import {
  EcsResourcePanel,
  OssResourcePanel,
  RdsResourcePanel,
  RedisResourcePanel,
  SwasResourcePanel,
  type ResourceRegion,
} from "./InfrastructureResourcePanels";

type ActiveResource = { account: Account; view: View; source: "cache" | "live" } | null;

type ResourceDetailDialogProps = {
  active: ActiveResource;
  summary: Record<string, unknown> | null;
  resources: ResourceResponse | null;
  loading: boolean;
  quickTool: { accountId: number; bucket: string; kind: "files" | "stat" } | null;
  assetDisplayNames: Record<string, string>;
  domainKeyword: string;
  domainKeywordDraft: string;
  domainSearchLoading: boolean;
  esaTab: "overview" | "sites" | "functions";
  esaRange: string;
  esaTrend: keyof EsaOverview["trend"];
  esaSelectedSiteId: string;
  esaOverview: EsaOverview | null;
  esaSiteKeyword: string;
  onClose: () => void;
  onQuickActionOpened: () => void;
  onDisplayNamesChange: (update: (current: Record<string, string>) => Record<string, string>) => void;
  onDomainKeywordChange: (value: string) => void;
  onSearchDomains: () => void;
  onOpenDomainTool: (input: { kind: DomainTool["kind"]; account: Account; domain: string }) => void;
  onRefreshResources: (account: Account, type: "ecs" | "swas" | "rds" | "redis" | "oss" | "domain") => void;
  onRefreshEsa: (account: Account) => void;
  onOpenSshClient: (asset: LocalAsset, account: Account) => void;
  onNotice: (message: string) => void;
  onConfirm: (message: string, options?: Pick<ConfirmRequest, "tone" | "title" | "confirmLabel">) => Promise<boolean>;
  onPrompt: (message: string, initialValue?: string) => Promise<string | null>;
  onEsaTabChange: (value: "overview" | "sites" | "functions") => void;
  onEsaRangeChange: (value: string) => void;
  onEsaTrendChange: (value: keyof EsaOverview["trend"]) => void;
  onEsaSelectedSiteChange: (value: string) => void;
  onEsaOverviewChange: (value: EsaOverview | null) => void;
  onEsaSiteKeywordChange: (value: string) => void;
};

export function ResourceDetailDialog({
  active,
  summary,
  resources,
  loading,
  quickTool,
  assetDisplayNames,
  domainKeyword,
  domainKeywordDraft,
  domainSearchLoading,
  esaTab,
  esaRange,
  esaTrend,
  esaSelectedSiteId,
  esaOverview,
  esaSiteKeyword,
  onClose,
  onQuickActionOpened,
  onDisplayNamesChange,
  onDomainKeywordChange,
  onSearchDomains,
  onOpenDomainTool,
  onRefreshResources,
  onRefreshEsa,
  onOpenSshClient,
  onNotice,
  onConfirm,
  onPrompt,
  onEsaTabChange,
  onEsaRangeChange,
  onEsaTrendChange,
  onEsaSelectedSiteChange,
  onEsaOverviewChange,
  onEsaSiteKeywordChange,
}: ResourceDetailDialogProps) {
  const tableColumns = useMemo(() => resourceColumns(resources?.items ?? []), [resources]);
  const regions = useMemo<ResourceRegion[]>(() => {
    const values = new Map<string, { name: string; items: Record<string, unknown>[] }>();
    for (const item of resources?.items ?? []) {
      const id = String(item._region_id || item.RegionId || "未知地域");
      const current = values.get(id) || { name: String(item._region_name || id), items: [] };
      current.items.push(item);
      values.set(id, current);
    }
    return Array.from(values.entries());
  }, [resources]);
  const domainItems = useMemo(() => (resources?.items ?? []).filter((item) => {
    const keyword = domainKeyword.trim().toLowerCase();
    return !keyword || String(item.DomainName || "").toLowerCase().includes(keyword) || String(item.RegistrantOrganization || "").toLowerCase().includes(keyword);
  }), [resources, domainKeyword]);

  if (!active) return null;

  const openSshClient = (resourceType: "ecs" | "swas", item: Record<string, unknown>, index: number) => {
    const instanceId = String(item.InstanceId || item.InstanceName || index);
    onOpenSshClient({ account_id: active.account.id, resource_type: resourceType, asset_key: instanceId, region_id: String(item._region_id || item.RegionId || active.account.region_id || ""), payload: item, fetched_at: resources?.fetched_at || Date.now() }, active.account);
  };
  const updateEcsDisplayName = (key: string, value: string) => {
    onDisplayNamesChange((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };
  const openEsaConsole = () => {
    const cloudType = active.account.cloud_type;
    const target = cloudType === "tencent" ? "https://console.cloud.tencent.com/edgeone" : cloudType === "volcengine" ? "https://console.volcengine.com/cdn/" : "https://esa.console.aliyun.com/";
    const label = cloudType === "tencent" ? "腾讯云 EdgeOne" : cloudType === "volcengine" ? "火山引擎 CDN" : "阿里云 ESA";
    window.open(target, "_blank", "noopener,noreferrer");
    onNotice(`已打开${label}控制台`);
  };
  const activeTitle = `【${active.account.account_name}】${active.view === "summary" ? "账号汇总" : ({ ecs: "云服务器", swas: "轻量服务器", rds: "云数据库", redis: "云 Redis", oss: "对象存储", esa: "边缘安全加速", domain: "域名" } as Partial<Record<View, string>>)[active.view] || active.view}`;

  let content: ReactNode;
  if (loading) {
    content = <div className="loading-overlay"><span className="loading-text">加载中…</span></div>;
  } else if (active.view === "summary") {
    content = <AccountSummaryPanel account={active.account} source={active.source} summary={summary} />;
  } else if (active.view === "ecs") {
    content = <EcsResourcePanel account={active.account} source={active.source} resources={resources} loading={loading} regions={regions} displayNames={assetDisplayNames} onDisplayNameChange={updateEcsDisplayName} onRefresh={(type) => onRefreshResources(active.account, type)} onNotice={onNotice} onConfirm={onConfirm} onPrompt={onPrompt} onSshLogin={(item, index) => openSshClient("ecs", item, index)} />;
  } else if (active.view === "swas") {
    content = <SwasResourcePanel account={active.account} resources={resources} loading={loading} onRefresh={(type) => onRefreshResources(active.account, type)} onNotice={onNotice} onConfirm={onConfirm} onSshLogin={(item, index) => openSshClient("swas", item, index)} />;
  } else if (active.view === "rds") {
    content = <RdsResourcePanel account={active.account} resources={resources} loading={loading} regions={regions} onRefresh={(type) => onRefreshResources(active.account, type)} />;
  } else if (active.view === "redis") {
    content = <RedisResourcePanel account={active.account} resources={resources} loading={loading} regions={regions} onRefresh={(type) => onRefreshResources(active.account, type)} />;
  } else if (active.view === "oss") {
    content = <OssResourcePanel account={active.account} resources={resources} loading={loading} quickTool={quickTool} onQuickActionOpened={onQuickActionOpened} onRefresh={(type) => onRefreshResources(active.account, type)} onConfirm={onConfirm} onPrompt={onPrompt} />;
  } else if (active.view === "esa") {
    content = <EsaResourcePanel source={active.source} resources={resources} loading={loading} tab={esaTab} range={esaRange} trend={esaTrend} selectedSiteId={esaSelectedSiteId} overview={esaOverview} siteKeyword={esaSiteKeyword} onTabChange={onEsaTabChange} onRangeChange={onEsaRangeChange} onTrendChange={onEsaTrendChange} onSelectedSiteChange={onEsaSelectedSiteChange} onOverviewChange={onEsaOverviewChange} onSiteKeywordChange={onEsaSiteKeywordChange} onRefresh={() => onRefreshEsa(active.account)} onOpenConsole={openEsaConsole} />;
  } else if (active.view === "domain") {
    content = <DomainResourcePanel account={active.account} items={domainItems} loading={loading} searchLoading={domainSearchLoading} keyword={domainKeywordDraft} onKeywordChange={onDomainKeywordChange} onSearch={onSearchDomains} onRefresh={() => onRefreshResources(active.account, "domain")} onOpenTool={(kind, domain) => onOpenDomainTool({ kind, account: active.account, domain })} />;
  } else {
    content = <div>{(resources?.errors?.length ?? 0) > 0 && <div className="error-list">{resources?.errors.map((error) => <div key={error}>部分区域读取失败：{error}</div>)}</div>}{resources?.items?.length ? <div className="resource-table-wrap"><table><thead><tr>{tableColumns.map((key) => <th key={key}>{columnLabel(key)}</th>)}</tr></thead><tbody>{resources.items.map((item, index) => <tr key={index}>{tableColumns.map((key) => <td key={key}>{displayValue(item[key])}</td>)}</tr>)}</tbody></table></div> : <div className="detail-empty"><Cloud size={28} /><span>暂未读取到资源</span></div>}</div>;
  }

  return createPortal(
    <div className="resource-modal-backdrop" onClick={onClose}>
      <section className="detail-panel resource-modal" onClick={(event) => event.stopPropagation()}>
        <div className="detail-toolbar"><div><span className="eyebrow">{active.account.account_name}</span><h2>{activeTitle}</h2></div><div className="detail-toolbar-actions"><button className="close-detail" type="button" title="关闭资源详情" aria-label="关闭资源详情" onClick={onClose}><X size={18} /></button></div></div>
        {content}
      </section>
    </div>,
    document.body,
  );
}
