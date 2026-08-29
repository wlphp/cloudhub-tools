import { useState } from "react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import { assetTypes, cloudProvider, supportsResourceSync, syncAssetTypes } from "../cloud/catalog";
import type { Account } from "../../shared/types";

type SyncResult = { fetched: number; counts: Record<string, number>; errors: string[] };

type UseAssetSyncOptions = {
  loadApiLogs: () => Promise<void>;
  loadLocalAssets: () => Promise<void>;
  notify: (message: string) => void;
};

export function useAssetSync({ loadApiLogs, loadLocalAssets, notify }: UseAssetSyncOptions) {
  const [account, setAccount] = useState<Account | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(assetTypes.map(([value]) => value));
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  function open(nextAccount: Account) {
    setSelectedTypes(syncAssetTypes(nextAccount).map(([value]) => value));
    setAccount(nextAccount);
  }

  function close() {
    setAccount(null);
    setResult(null);
  }

  async function sync() {
    if (!account) return;
    if (!supportsResourceSync(account)) {
      setResult({ fetched: 0, counts: {}, errors: [`${cloudProvider(account.cloud_type).label}资源实时拉取尚未接入。账号可正常保存、筛选和管理。`] });
      notify(`${cloudProvider(account.cloud_type).label}资源 API 尚未接入`);
      return;
    }
    setSyncing(true);
    setResult(null);
    try {
      const nextResult = runningInTauri
        ? await invoke<SyncResult>("sync_cloud_assets", { id: account.id, resourceTypes: selectedTypes })
        : await webApi<SyncResult>("/api/sync-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account.id, resource_types: selectedTypes }) });
      setResult(nextResult);
      notify(`${account.account_name} 已获取 ${nextResult.fetched} 项资产${nextResult.errors.length ? `，${nextResult.errors.length} 项失败` : ""}`);
      await loadLocalAssets();
      await loadApiLogs();
    } catch (error) {
      notify(`资产获取失败：${String(error)}`);
    } finally {
      setSyncing(false);
    }
  }

  const showOracleDatabasePermissionHint = account?.cloud_type === "oracle"
    && Boolean(result?.errors.some((error) => /rds:.*Authorization failed or requested resource not found/i.test(error)));

  return {
    account,
    selectedTypes,
    setSelectedTypes,
    syncing,
    result,
    showOracleDatabasePermissionHint,
    open,
    close,
    sync,
  };
}
