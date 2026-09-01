// Cache and aggregation helpers for the resources workspace. Pure helpers
// live in `./pure` so they stay free of platform imports and can be tested in
// plain Node.

import { resourcesClient } from "../../platform/clients";
import type { Account, LocalAsset, ResourceResponse, View } from "../../shared/types";

// Re-export the pure helpers so callers can pick whichever surface suits them.
export { resourceColumns, listResourceViews } from "./pure.ts";

export interface CachedSummary {
  account_id: string;
  account_type: string;
  available_amount: string;
  available_cash_amount: string;
  credit_amount: string;
  month_consume: string;
  month_bill: string;
  ecs_count: number;
  domain_count: number;
  dns_record_count: number;
  oss_count: number;
  rds_count: number;
  redis_count: number;
  swas_count: number;
  esa_count: number;
  cached_at: number;
}

export async function fetchLocalAssets(
  account: Account,
  resourceType: string | null,
): Promise<LocalAsset[]> {
  return resourcesClient.listLocal({
    accountId: account.id,
    resourceType: resourceType || undefined,
  });
}

export async function fetchCachedResources(
  account: Account,
  view: Exclude<View, "summary">,
): Promise<ResourceResponse> {
  const assets = await fetchLocalAssets(account, view);
  const items = assets.map((asset) => ({
    ...asset.payload,
    _region_id:
      asset.region_id ||
      (asset.payload as Record<string, unknown>)?._region_id ||
      (asset.payload as Record<string, unknown>)?.RegionId ||
      undefined,
  }));
  const fetchedAt = assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0);
  return { resource_type: view, items, errors: [], fetched_at: fetchedAt };
}

export async function fetchCachedSummary(account: Account): Promise<CachedSummary> {
  const assets = await fetchLocalAssets(account, null);
  const count = (type: string) => assets.filter((asset) => asset.resource_type === type).length;
  const dnsRecordCount = assets
    .filter((asset) => asset.resource_type === "domain")
    .reduce(
      (total, asset) => total + Number((asset.payload as Record<string, unknown>)?.RecordCount || 0),
      0,
    );
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
    dns_record_count: dnsRecordCount,
    oss_count: count("oss"),
    rds_count: count("rds"),
    redis_count: count("redis"),
    swas_count: count("swas"),
    esa_count: count("esa"),
    cached_at: assets.reduce((latest, asset) => Math.max(latest, asset.fetched_at), 0),
  };
}
