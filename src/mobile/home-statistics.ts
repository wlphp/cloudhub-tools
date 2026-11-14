import type { Account, LocalAsset } from "../shared/types";
import type { CertificateSummary } from "../platform/clients/certificates";
import { cloudProvider, resourceLabels } from "../features/cloud/catalog";

export function expiryTimestamp(raw: unknown): number | null {
  let value = NaN;
  if (typeof raw === "number" || typeof raw === "string" && /^\d{10,13}$/.test(raw)) {
    const number = Number(raw);
    value = number < 100_000_000_000 ? number * 1000 : number;
  } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T| )/.test(raw)) value = Date.parse(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function homeStatistics(assets: LocalAsset[], accounts: Account[], certificates: CertificateSummary[], now: number) {
  const types = new Map<string, number>();
  const providers = new Map<string, number>();
  const owners = new Map(accounts.map(account => [account.id, account.cloud_type]));
  const expiry = { expired: 0, week: 0, month: 0, later: 0, unknown: 0 };
  const addExpiry = (timestamp: number | null) => {
    if (timestamp === null) expiry.unknown++;
    else if (timestamp <= now) expiry.expired++;
    else if (timestamp <= now + 7 * 86400000) expiry.week++;
    else if (timestamp <= now + 30 * 86400000) expiry.month++;
    else expiry.later++;
  };
  for (const asset of assets) {
    const type = asset.resource_type;
    types.set(type, (types.get(type) ?? 0) + 1);
    const owner = owners.get(asset.account_id);
    const provider = owner ? cloudProvider(owner).label : "未关联账号";
    providers.set(provider, (providers.get(provider) ?? 0) + 1);
    const payload = asset.payload ?? {};
    const fields = ["ExpiredTime", "ExpirationTime", "ExpirationDate", "ExpireTime", "ExpireDate", "EndTime", "expiredTime", "expirationTime", "expireTime", "expire_time", "expires_at"];
    addExpiry(fields.map(field => expiryTimestamp(payload[field])).find(value => value !== null) ?? null);
  }
  for (const certificate of certificates) addExpiry(["issued", "valid"].includes(certificate.status) ? expiryTimestamp(certificate.notAfter) : null);
  const sort = <T extends { count: number; label: string }>(rows: T[]) => rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
  return {
    types: sort([...types].map(([key, count]) => ({ key, label: resourceLabels[key as keyof typeof resourceLabels] ?? key, count }))),
    providers: sort([...providers].map(([label, count]) => ({ key: label, label, count }))),
    expiry,
    oldestCache: assets.length && assets.every(asset => Number.isFinite(asset.fetched_at) && asset.fetched_at > 0) ? Math.min(...assets.map(asset => asset.fetched_at)) : null,
  };
}
