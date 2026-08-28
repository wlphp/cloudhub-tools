import type { LocalAsset } from "../../shared/types";

const cloudHubFavoriteAssetsStorageKey = "cloudhub-tools-favorite-assets";
const legacyFavoriteAssetsStorageKey = "aliyun-tools-favorite-assets";

export function assetFavoriteKey(asset: LocalAsset) {
  return `${asset.account_id}:${asset.resource_type}:${asset.asset_key}`;
}

export function savedFavoriteAssetKeys() {
  try {
    const storedValue = localStorage.getItem(cloudHubFavoriteAssetsStorageKey)
      ?? localStorage.getItem(legacyFavoriteAssetsStorageKey)
      ?? "[]";
    const value = JSON.parse(storedValue);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function stringListFromValue(value: string | undefined) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function stringRecordFromValue(value: string | undefined) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, note]) => typeof note === "string")) as Record<string, string>
      : {};
  } catch {
    return {};
  }
}
