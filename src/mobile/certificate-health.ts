import type { CertificateSummary } from "../platform/clients/certificates";

type Health = "valid" | "expiring" | "expired" | "pending" | "unknown" | "failed";
export function certificateHealth(item: CertificateSummary, now = Date.now()) {
  if (["failed", "error", "revoked"].includes(item.status)) return { key: "failed" as Health, label: item.status === "revoked" ? "已吊销" : "签发失败", days: null };
  if (item.status !== "issued" && item.status !== "valid") return { key: "pending" as Health, label: "签发中", days: null };
  if (!item.notAfter || !Number.isFinite(item.notAfter)) return { key: "unknown" as Health, label: "有效期待补全", days: null };
  const remaining = item.notAfter * 1000 - now;
  if (remaining <= 0) return { key: "expired" as Health, label: "已过期", days: -Math.floor(-remaining / 86400000) };
  if (item.notBefore && item.notBefore * 1000 > now) return { key: "pending" as Health, label: "尚未生效", days: null };
  const days = Math.ceil(remaining / 86400000);
  return { key: (remaining <= 30 * 86400000 ? "expiring" : "valid") as Health, label: remaining <= 30 * 86400000 ? "即将到期" : "有效", days };
}
