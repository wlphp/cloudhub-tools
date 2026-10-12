import { useEffect, useState } from "react";
import type { CodexAccount, CodexQuotaWindow } from "../../platform/clients/codex";

export const quotaStatusNames = { ready: "额度充足", low: "额度偏低", exhausted: "额度耗尽", stale: "缓存待刷新", unknown: "尚未获取", error: "刷新失败", billing: "API 计费" };
export type QuotaStatus = keyof typeof quotaStatusNames;
export const windowName = (minutes: number | null) => minutes ? minutes % 1440 === 0 ? `${minutes / 1440} 天窗口` : minutes % 60 === 0 ? `${minutes / 60} 小时窗口` : `${minutes} 分钟窗口` : "额度窗口";
export const remainingPercent = (window: CodexQuotaWindow) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 ? 100 - window.usedPercent : null;
export function quotaResetTime(resetsAt: number | null, now: number): string {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= 0) return "重置时间未知";
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return "重置时间未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getTime() <= now) return `已到重置时间，待刷新（${timestamp}）`;
  const minutes = Math.ceil((date.getTime() - now) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  const duration = `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${remainder ? `${remainder}分钟` : ""}`.trim();
  return `${duration}（${timestamp}）`;
}
export function quotaPresentation(account: CodexAccount, now: number): { status: QuotaStatus; remaining: number | null } {
  if (account.authMode === "apikey") return { status: "billing", remaining: null };
  if (account.lastError) return { status: "error", remaining: null };
  const { fetchedAt, windows } = account.quota;
  if (!fetchedAt || !windows.length || windows.some(window => remainingPercent(window) == null)) return { status: "unknown", remaining: null };
  if (fetchedAt > now || now - fetchedAt > 15 * 60 * 1000 || windows.some(window => window.resetsAt != null && window.resetsAt * 1000 <= now)) return { status: "stale", remaining: null };
  const remaining = Math.min(...windows.map(window => remainingPercent(window)!));
  return { status: remaining <= 0 ? "exhausted" : remaining <= 20 ? "low" : "ready", remaining };
}
export function useQuotaClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  return now;
}
