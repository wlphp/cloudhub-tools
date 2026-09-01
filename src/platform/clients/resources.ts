import type { EsaOverview, LocalAsset } from "../../shared/types";
import { invokeOrWeb, jsonRequest, queryPath } from "./base";

export type AssetSyncResult = {
  fetched: number;
  counts: Record<string, number>;
  errors: string[];
};

export const resourcesClient = {
  listLocal(filters: { accountId?: number; resourceType?: string } = {}): Promise<LocalAsset[]> {
    return invokeOrWeb("list_local_assets", {
      accountId: filters.accountId ?? null,
      resourceType: filters.resourceType ?? null,
    }, {
      path: queryPath("/api/local-assets", {
        account_id: filters.accountId,
        resource_type: filters.resourceType,
      }),
    });
  },

  sync(accountId: number, resourceTypes: string[]): Promise<AssetSyncResult> {
    return invokeOrWeb("sync_cloud_assets", { id: accountId, resourceTypes }, {
      path: "/api/sync-assets",
      init: jsonRequest("POST", { account_id: accountId, resource_types: resourceTypes }),
    });
  },

  summary(accountId: number): Promise<Record<string, unknown>> {
    return invokeOrWeb("cloud_account_summary", { id: accountId }, {
      path: queryPath("/api/cloud-summary", { id: accountId }),
    });
  },

  esaOverview(accountId: number, range: string, siteId?: string): Promise<EsaOverview> {
    return invokeOrWeb("esa_overview", { id: accountId, range, siteId: siteId || null }, {
      path: queryPath("/api/esa-overview", { id: accountId, range, site_id: siteId }),
    });
  },

  removeLocal(asset: Pick<LocalAsset, "account_id" | "resource_type" | "asset_key">): Promise<void> {
    return invokeOrWeb("delete_local_asset", {
      accountId: asset.account_id,
      resourceType: asset.resource_type,
      assetKey: asset.asset_key,
    }, {
      path: queryPath("/api/local-assets", {
        account_id: asset.account_id,
        resource_type: asset.resource_type,
        asset_key: asset.asset_key,
      }),
      init: { method: "DELETE" },
    });
  },

  rdsDetails(kind: "databases" | "accounts", accountId: number, regionId: string, instanceId: string): Promise<Record<string, unknown>[]> {
    return invokeOrWeb(kind === "databases" ? "list_rds_databases" : "list_rds_accounts", { id: accountId, regionId, instanceId }, {
      path: queryPath(kind === "databases" ? "/api/rds-databases" : "/api/rds-accounts", {
        id: accountId,
        region: regionId,
        instance: instanceId,
      }),
    });
  },

  redisAccounts(accountId: number, regionId: string, instanceId: string): Promise<Record<string, unknown>[]> {
    return invokeOrWeb("list_redis_accounts", { id: accountId, regionId, instanceId }, {
      path: queryPath("/api/redis-accounts", { id: accountId, region: regionId, instance: instanceId }),
    });
  },
};
