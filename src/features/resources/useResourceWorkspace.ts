import { useState } from "react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import {
  assetTypes,
  cloudProvider,
  resourceLabels,
  supportsResourceSync,
  syncAssetTypes,
} from "../cloud/catalog";
import type { Account, EsaOverview, LocalAsset, ResourceResponse, View } from "../../shared/types";

type ResourceView = Exclude<View, "summary">;
type ResourceType = (typeof assetTypes)[number][0];

const resourceViews: readonly ResourceView[] = ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"];

type UseResourceWorkspaceOptions = {
  closeAccountMenu: () => void;
  loadLocalAssets: () => Promise<void>;
  loadApiLogs: () => Promise<void>;
  notify: (message: string) => void;
  openLocalResourceList: (accountId: number, resourceType: string) => void;
};

export function useResourceWorkspace({ closeAccountMenu, loadLocalAssets, loadApiLogs, notify, openLocalResourceList }: UseResourceWorkspaceOptions) {
  const [active, setActive] = useState<{ account: Account; view: View; source: "cache" | "live" } | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [resources, setResources] = useState<ResourceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [esaTab, setEsaTab] = useState<"overview" | "sites" | "functions">("overview");
  const [esaRange, setEsaRange] = useState("today");
  const [esaTrend, setEsaTrend] = useState<keyof EsaOverview["trend"]>("traffic");
  const [esaSelectedSiteId, setEsaSelectedSiteId] = useState("");
  const [esaOverview, setEsaOverview] = useState<EsaOverview | null>(null);
  const [esaSiteKeyword, setEsaSiteKeyword] = useState("");

  async function keepLoadingVisible(startedAt: number) {
    const remaining = 320 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  }

  async function cachedResourceResponse(account: Account, view: ResourceView): Promise<ResourceResponse> {
    const assets = runningInTauri
      ? await invoke<LocalAsset[]>("list_local_assets", { accountId: account.id, resourceType: view })
      : await webApi<LocalAsset[]>(`/api/local-assets?account_id=${account.id}&resource_type=${encodeURIComponent(view)}`);
    return {
      resource_type: view,
      items: assets.map((asset) => ({ ...asset.payload, _region_id: asset.region_id || asset.payload._region_id || asset.payload.RegionId || undefined })),
      errors: [],
      fetched_at: assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0),
    };
  }

  async function cachedSummary(account: Account): Promise<Record<string, unknown>> {
    const assets = runningInTauri
      ? await invoke<LocalAsset[]>("list_local_assets", { accountId: account.id, resourceType: null })
      : await webApi<LocalAsset[]>(`/api/local-assets?account_id=${account.id}`);
    const count = (type: string) => assets.filter((asset) => asset.resource_type === type).length;
    return {
      account_id: account.access_key_id,
      account_type: "本地缓存",
      available_amount: "-",
      available_cash_amount: "-",
      credit_amount: "-",
      month_consume: "-",
      month_bill: "-",
      ecs_count: count("ecs"),
      domain_count: count("domain"),
      dns_record_count: assets.filter((asset) => asset.resource_type === "domain").reduce((total, asset) => total + Number(asset.payload.RecordCount || 0), 0),
      oss_count: count("oss"),
      rds_count: count("rds"),
      redis_count: count("redis"),
      swas_count: count("swas"),
      esa_count: count("esa"),
      cached_at: assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0),
    };
  }

  async function openCachedSummary(account: Account) {
    const startedAt = Date.now();
    closeAccountMenu();
    setActive({ account, view: "summary", source: "cache" });
    setSummary(null);
    setResources(null);
    setLoading(true);
    try {
      setSummary(await cachedSummary(account));
      notify(`${account.account_name} · 汇总（本地缓存）`);
    } catch (error) {
      notify(`读取本地汇总失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function openCachedView(account: Account, view: ResourceView) {
    const startedAt = Date.now();
    closeAccountMenu();
    setActive({ account, view, source: "cache" });
    setResources(null);
    setLoading(true);
    try {
      setResources(await cachedResourceResponse(account, view));
      notify(`${account.account_name} · ${resourceLabels[view]}（本地缓存）`);
    } catch (error) {
      notify(`读取本地缓存失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  function openAccountResource(account: Account, resourceType: ResourceType) {
    if (resourceViews.includes(resourceType as ResourceView)) {
      void openCachedView(account, resourceType as ResourceView);
      return;
    }
    closeAccountMenu();
    openLocalResourceList(account.id, resourceType);
    void loadLocalAssets();
  }

  async function pullLatestResources(account: Account, view: ResourceView) {
    if (!supportsResourceSync(account)) {
      notify(`${cloudProvider(account.cloud_type).label}的${resourceLabels[view]}实时拉取尚未接入`);
      return;
    }
    if (!syncAssetTypes(account).some(([type]) => type === view)) {
      notify(`${cloudProvider(account.cloud_type).label}暂未接入${resourceLabels[view]}实时拉取`);
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    try {
      const result = runningInTauri
        ? await invoke<{ fetched: number; counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: [view] })
        : await webApi<{ fetched: number; counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: [view] }) });
      setResources(await cachedResourceResponse(account, view));
      setActive({ account, view, source: "live" });
      await loadLocalAssets();
      await loadApiLogs();
      notify(`${account.account_name} · 已实时拉取 ${result.counts[view] ?? result.fetched} 项${resourceLabels[view]}${result.errors.length ? `，${result.errors.length} 项失败` : ""}`);
    } catch (error) {
      notify(`实时拉取失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  async function pullLatestEsaOverview(account: Account) {
    if (!supportsResourceSync(account)) {
      notify(`${cloudProvider(account.cloud_type).label}的边缘安全加速实时拉取尚未接入`);
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    try {
      const syncResult = runningInTauri
        ? await invoke<{ fetched: number; counts: Record<string, number>; errors: string[] }>("sync_cloud_assets", { id: account.id, resourceTypes: ["esa"] })
        : await webApi<{ fetched: number; counts: Record<string, number>; errors: string[] }>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: ["esa"] }) });
      const overview = runningInTauri
        ? await invoke<EsaOverview>("esa_overview", { id: account.id, range: esaRange, siteId: esaSelectedSiteId || null })
        : await webApi<EsaOverview>(`/api/esa-overview?id=${account.id}&range=${encodeURIComponent(esaRange)}${esaSelectedSiteId ? `&site_id=${encodeURIComponent(esaSelectedSiteId)}` : ""}`);
      setResources(await cachedResourceResponse(account, "esa"));
      setEsaOverview(overview);
      setActive({ account, view: "esa", source: "live" });
      await loadLocalAssets();
      await loadApiLogs();
      notify(`${account.account_name} · 边缘安全加速实时数据已更新${syncResult.errors.length ? `，${syncResult.errors.length} 项失败` : ""}`);
    } catch (error) {
      notify(`边缘安全加速实时拉取失败：${String(error)}`);
    } finally {
      await keepLoadingVisible(startedAt);
      setLoading(false);
    }
  }

  return {
    active, setActive, summary, resources, loading,
    esaTab, setEsaTab, esaRange, setEsaRange, esaTrend, setEsaTrend,
    esaSelectedSiteId, setEsaSelectedSiteId, esaOverview, setEsaOverview, esaSiteKeyword, setEsaSiteKeyword,
    openCachedSummary, openCachedView, openAccountResource, pullLatestResources, pullLatestEsaOverview,
  };
}
