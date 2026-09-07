import crypto from "node:crypto";

const RESOURCE_ID_FIELDS = [
  "InstanceId",
  "DBInstanceId",
  "KVStoreInstanceId",
  "AssetId",
  "SiteId",
  "DomainName",
  "Name",
  "BucketName",
  "Id",
  "id",
];

export function stableAssetKey(resourceType, item) {
  for (const field of RESOURCE_ID_FIELDS) {
    const value = item?.[field];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  const region = String(item?._region_id || item?.RegionId || "global");
  const identity = ["PrivateIpAddress", "PublicIpAddress", "ConnectionDomain", "Endpoint"]
    .map((field) => item?.[field])
    .find((value) => typeof value === "string" && value.trim());
  if (identity) return `${resourceType}:${region}:${identity}`;
  const payload = JSON.stringify(item ?? {});
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  return `${resourceType}:${region}:${digest}`;
}

export function safeProviderError(reason) {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (/authorization failed or requested resource not found/i.test(message)) {
    return "Authorization failed or requested resource not found";
  }
  if (/401|unauthorized|invalid token|authentication|access key|secret/i.test(message)) {
    return "云厂商认证失败，请检查账号凭据";
  }
  if (/403|forbidden|accessdenied|permission/i.test(message)) {
    return "云厂商权限不足，请检查账号权限";
  }
  if (/429|too many requests|rate limit/i.test(message)) {
    return "云厂商请求过于频繁，请稍后重试";
  }
  if (/502|503|504|timeout|network|connection|fetch failed|请求失败|网络|连接|超时/i.test(message)) {
    return "云厂商或网络暂时不可用，请稍后重试";
  }
  return "云厂商返回了无法公开的错误信息";
}

export function sanitizeResourceResponse(response, resourceType = response?.resource_type) {
  return {
    ...response,
    resource_type: resourceType || "unknown",
    items: Array.isArray(response?.items) ? response.items : [],
    errors: Array.isArray(response?.errors) ? response.errors.map(safeProviderError) : [],
  };
}
