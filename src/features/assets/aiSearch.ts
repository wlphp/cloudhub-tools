import type { AiFields } from "../../platform/clients/ai";
import type { LocalAsset } from "../../shared/types";

export type AssetSearchFilters = { query?: string; group?: string; resource_type?: string; expires_within_days?: number | null };
export function assetSearchFilters(fields: AiFields, types: readonly string[], groups: readonly string[]): AssetSearchFilters {
  const allowed = ["query", "group", "resource_type", "expires_within_days"];
  if (Object.keys(fields).some(key=>!allowed.includes(key))) throw new Error("检索结果包含不支持的条件");
  const filters: AssetSearchFilters = {};
  for (const key of ["query", "group", "resource_type"] as const) {
    if (!(key in fields)) continue;
    if (fields[key] === null) continue;
    if (typeof fields[key] !== "string") throw new Error("检索条件必须是文本");
    const value = fields[key]!.trim();
    if (value.length > 256) throw new Error("检索条件过长");
    if (key === "resource_type" && value && !types.includes(value)) throw new Error("该资源类型不受支持，请核对后再应用");
    if (key === "group" && value && !groups.includes(value)) throw new Error("本机没有该分组，请填写完整分组名称");
    filters[key] = value;
  }
  if ("expires_within_days" in fields) {
    const value = fields.expires_within_days;
    if (value === null || value === "") filters.expires_within_days = null;
    else {
      const days = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("到期天数必须为0至3650的整数");
      filters.expires_within_days = days;
    }
  }
  return filters;
}

export function withinAssetExpiry(asset: LocalAsset, days: number | null, now: number): boolean {
  if (days === null) return true;
  const p = asset.payload || {};
  const raw = p.ExpiredTime || p.ExpirationTime || p.ExpirationDate || p.ExpireTime || p.ExpireDate || p.EndTime;
  let expires = NaN;
  if (typeof raw === "number") expires = raw < 100_000_000_000 ? raw * 1000 : raw;
  else if (typeof raw === "string" && /^\d{10,13}$/.test(raw)) { const value = Number(raw); expires = value < 100_000_000_000 ? value * 1000 : value; }
  else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T| )/.test(raw)) expires = Date.parse(raw);
  return Number.isFinite(expires) && expires >= now && expires <= now + days * 86_400_000;
}
