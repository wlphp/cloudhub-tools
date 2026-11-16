import { assetTypes } from "../cloud/catalog";
export const assetExpiryPolicyPreferenceKey = "cloudhub-asset-expiry-policy";
export const defaultAssetExpiryPolicy: { days: number; resourceTypes: string[] } = { days: 30, resourceTypes: assetTypes.map(([type]) => type) };
export function assetExpiryPolicyFromValue(value: string | null | undefined): typeof defaultAssetExpiryPolicy {
  try {
    const parsed: unknown = JSON.parse(value || "");
    if (!parsed || typeof parsed !== "object") return defaultAssetExpiryPolicy;
    const record = parsed as { days?: unknown; resourceTypes?: unknown };
    const days = Number(record.days);
    const allowedTypes = new Set<string>(assetTypes.map(([type]) => type));
    const resourceTypes = Array.isArray(record.resourceTypes) ? record.resourceTypes.filter((type): type is string => typeof type === "string" && allowedTypes.has(type)) : defaultAssetExpiryPolicy.resourceTypes;
    return { days: Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 30, resourceTypes };
  } catch { return defaultAssetExpiryPolicy; }
}
