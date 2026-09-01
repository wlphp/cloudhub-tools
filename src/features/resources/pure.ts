// Pure helpers used by both the React layer and the cache layer. Kept free of
// platform imports so they can be exercised in plain `tsx` tests.

import type { View } from "../../shared/types";

export const RESOURCE_VIEWS: ReadonlyArray<Exclude<View, "summary">> = [
  "ecs",
  "domain",
  "oss",
  "rds",
  "redis",
  "swas",
  "esa",
] as const;

export const PREFERRED_RESOURCE_COLUMNS: readonly string[] = [
  "InstanceName",
  "InstanceId",
  "Status",
  "RegionId",
  "PublicIpAddress",
  "PublicIp",
  "DomainName",
  "DBInstanceDescription",
  "DBInstanceId",
  "KVStoreInstanceId",
  "AssetId",
  "BucketName",
  "Name",
  "IpAddress",
  "SizeGb",
  "AttachedTo",
  "CreatedAt",
  "PlanName",
];

export function resourceColumns(items: Record<string, unknown>[]): string[] {
  const keys = Array.from(
    new Set(
      items.flatMap((item) =>
        Object.keys(item).filter((key) => !key.startsWith("_")),
      ),
    ),
  );
  const ordered = PREFERRED_RESOURCE_COLUMNS.filter((key) => keys.includes(key));
  return [...ordered, ...keys.filter((key) => !ordered.includes(key))].slice(0, 7);
}

export function listResourceViews(): ReadonlyArray<Exclude<View, "summary">> {
  return RESOURCE_VIEWS;
}
