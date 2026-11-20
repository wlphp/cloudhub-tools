import type { ClaudeMode, ClaudeRequestLog } from "../../platform/clients/claudeProviders";

/** 拓扑与渠道卡片沿用供应商列表的 5 小时本地统计窗口。 */
export const ROUTING_USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

export type RoutingUsage = { requests: number; errors: number; tokens: number; durationMs: number };
/** 中枢统计：请求按客户端请求去重，并统计最终交付给 Agent 的错误。 */
export type RoutingTotals = RoutingUsage & { deliveredErrors: number; reroutedRequests: number };

/**
 * 按当前连接模式汇总已完成的本地请求日志。
 * 渠道维度按请求尝试计数（故障转移会产生多条记录）；中枢维度按 requestId 去重：
 * requests 为客户端请求数，deliveredErrors 为最终仍失败的请求数。
 * tokens 为输入 + 输出 + 缓存读取，便于和供应商列表的「本地 · 5h」保持一致。
 */
export function summarizeRoutingUsage(logs: ClaudeRequestLog[], mode: ClaudeMode, since: number): { total: RoutingTotals; byProvider: Map<string, RoutingUsage> } {
  const total: RoutingTotals = { requests: 0, errors: 0, tokens: 0, durationMs: 0, deliveredErrors: 0, reroutedRequests: 0 };
  const byProvider = new Map<string, RoutingUsage>();
  const requests = new Map<string, { status: number; timestamp: number; rerouted: boolean }>();
  for (const log of logs) {
    if ((log.mode ?? mode) !== mode || log.timestamp < since) continue;
    const tokens = log.inputTokens + log.outputTokens + log.cacheReadTokens;
    const errors = log.status >= 400 ? 1 : 0;
    const duration = Number.isFinite(log.durationMs) ? Math.max(0, log.durationMs) : 0;
    total.errors += errors;
    total.tokens += tokens;
    total.durationMs += duration;
    // 旧记录没有 requestId：退化为每条日志独立计数，避免把不同请求误合并。
    const key = log.requestId?.trim() || `log:${log.id}`;
    const previous = requests.get(key);
    if (previous) {
      previous.rerouted ||= (log.attempt ?? 1) > 1;
      if (log.timestamp >= previous.timestamp) {
        previous.status = log.status;
        previous.timestamp = log.timestamp;
      }
    } else {
      requests.set(key, { status: log.status, timestamp: log.timestamp, rerouted: (log.attempt ?? 1) > 1 });
    }
    const entry = byProvider.get(log.providerId) ?? { requests: 0, errors: 0, tokens: 0, durationMs: 0 };
    entry.requests += 1;
    entry.errors += errors;
    entry.tokens += tokens;
    entry.durationMs += duration;
    byProvider.set(log.providerId, entry);
  }
  total.requests = requests.size;
  for (const request of requests.values()) {
    if (request.status >= 400) total.deliveredErrors += 1;
    if (request.rerouted) total.reroutedRequests += 1;
  }
  return { total, byProvider };
}

export function formatRoutingCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "0";
}

export function formatRoutingTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString("zh-CN");
}

/** 渠道卡片的紧凑延迟格式：6.2s / 1m20s。 */
export function formatRoutingLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}
