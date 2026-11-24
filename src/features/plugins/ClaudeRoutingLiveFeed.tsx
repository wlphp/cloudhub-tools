import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Radio } from "lucide-react";
import type { ClaudeMode, ClaudeProviderSummary, ClaudeRequestLog, ClaudeRoutingState } from "../../platform/clients/claudeProviders";
import { formatRoutingTokens } from "./claudeRoutingUsage";
import { providerAccent } from "./claudeRoutingVisuals";

/** 实时页只回看最近 10 分钟的完成记录；更早的请求去「用量」页看。 */
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ROWS = 80;
type Range = "live" | "today" | "all";

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function cachePercent(log: ClaudeRequestLog): number | null {
  const total = log.inputTokens + log.cacheReadTokens;
  return total > 0 ? (log.cacheReadTokens / total) * 100 : null;
}

function outputSpeed(log: ClaudeRequestLog): number | null {
  const seconds = (log.durationMs - (log.firstByteMs ?? 0)) / 1000;
  if (log.outputTokens <= 0 || seconds <= 0) return null;
  return log.outputTokens / seconds;
}

/**
 * 路由拓扑下方的实时请求列表。
 * 数据只来自本地网关快照：进行中的请求 + 已完成的请求元数据；不读取提示词、请求头或响应正文。
 */
export function ClaudeRoutingLiveFeed({ view, state, providers, onLocate, onOpenUsage, desktop = false }: {
  view: Exclude<ClaudeMode, "direct">;
  state: ClaudeRoutingState;
  providers: ClaudeProviderSummary[];
  onLocate?: (id: string) => void;
  onOpenUsage?: () => void;
  desktop?: boolean;
}) {
  const clientLabel = desktop ? "Claude Desktop" : "Claude Code";
  const [range, setRange] = useState<Range>("live");
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowTops = useRef(new Map<string, number>());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 新请求插到顶部时，旧行按 magpie 的 FLIP 思路从原位置平滑下移，新行从上方落下，
   * 避免整列瞬间跳一截。切换时间范围属于整批换行，不逐行动画。
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const previous = rowTops.current;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li[data-feed-key]"));
    const next = new Map<string, number>();
    for (const row of rows) next.set(row.dataset.feedKey ?? "", row.offsetTop);
    const newcomers = [...next.keys()].filter(key => !previous.has(key)).length;
    const bulk = previous.size > 0 && newcomers > next.size / 2;
    if (!reduceMotion && previous.size > 0 && !bulk) {
      for (const row of rows) {
        const key = row.dataset.feedKey ?? "";
        const before = previous.get(key);
        const after = next.get(key) ?? 0;
        if (before === undefined) {
          row.animate(
            [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "translateY(0)" }],
            { duration: 360, easing: "cubic-bezier(.22,1,.36,1)" },
          );
        } else if (Math.abs(before - after) > 1) {
          for (const animation of row.getAnimations()) {
            if (animation.id === "claude-feed-shift") animation.cancel();
          }
          const shift = row.animate(
            [{ transform: `translateY(${before - after}px)` }, { transform: "translateY(0)" }],
            { duration: 360, easing: "cubic-bezier(.22,.8,.2,1)" },
          );
          shift.id = "claude-feed-shift";
        }
      }
    }
    rowTops.current = next;
  });

  const providerById = useMemo(() => new Map(providers.map(provider => [provider.id, provider])), [providers]);
  const live = state.running && state.mode === view;
  const active = useMemo(
    () => (state.activeRequests ?? [])
      .filter(request => (request.mode ?? view) === view)
      .sort((left, right) => right.timestamp - left.timestamp),
    [state.activeRequests, view],
  );
  const scopedLogs = useMemo(() => {
    const since = range === "today" ? startOfToday() : range === "live" ? now - LIVE_WINDOW_MS : 0;
    return state.logs.filter(log => (log.mode ?? view) === view && log.timestamp >= since);
  }, [now, range, state.logs, view]);
  const todayCount = useMemo(
    () => state.logs.filter(log => (log.mode ?? view) === view && log.timestamp >= startOfToday()).length,
    [now, state.logs, view],
  );
  const completed = scopedLogs.slice(0, Math.max(0, MAX_ROWS - active.length));
  const emptyMessage = !state.running
    ? state.logs.length
      ? "本地路由未运行；当前范围没有记录，可切换到「今天」或「全部」查看历史请求。"
      : "本地路由未运行；启动后请求会实时出现在这里。"
    : state.mode !== view
      ? `${clientLabel} 当前使用${state.mode === "aggregate" ? "聚合" : "路由"}模式；这里只显示${view === "route" ? "路由" : "聚合"}请求。`
      : `暂无请求。${clientLabel} 发起请求后会在这里实时出现。`;

  const providerName = (id: string) => providerById.get(id)?.name ?? id;
  const providerLogo = (id: string) => {
    const accent = providerAccent(providerName(id));
    return <span className="claude-live-feed-logo" style={{ background: accent.color }} aria-hidden="true">{accent.letter}</span>;
  };
  const providerLink = (id: string) => {
    const name = providerName(id);
    return onLocate
      ? <button type="button" className="claude-live-feed-provider-link" title="定位到供应商列表" onClick={() => onLocate(id)}>{name}</button>
      : <span>{name}</span>;
  };

  return <section className="claude-live-feed" aria-label="实时请求">
    <header className="claude-live-feed-head">
      <div className="claude-live-feed-title">
        <Radio size={13} aria-hidden="true" />
        <strong>实时请求</strong>
        <span className={`claude-route-graph-badge${live ? " is-live" : ""}`}><i aria-hidden="true" />{live ? "实时" : state.running ? "其他模式" : "未启动"}</span>
        <span className="claude-live-feed-count">{active.length ? `${active.length} 个进行中` : "暂无进行中"}</span>
      </div>
      <div className="claude-live-feed-actions">
        <div className="claude-live-feed-ranges" role="tablist" aria-label="请求时间范围">
          <button type="button" role="tab" aria-selected={range === "live"} onClick={() => setRange("live")}>实时</button>
          <button type="button" role="tab" aria-selected={range === "today"} onClick={() => setRange("today")}>今天 <small>{todayCount}</small></button>
          <button type="button" role="tab" aria-selected={range === "all"} onClick={() => setRange("all")}>全部</button>
        </div>
        {onOpenUsage && <button type="button" className="claude-route-graph-action" onClick={onOpenUsage}><ArrowUpRight size={12} aria-hidden="true" />完整用量</button>}
      </div>
    </header>

    <ul className="claude-live-feed-list" ref={listRef}>
      {active.map(request => {
        const elapsed = Math.max(0, now - request.timestamp);
        return <li key={`active-${request.id}`} data-feed-key={`active-${request.id}`} className="claude-live-feed-row is-live">
          <div className="claude-live-feed-line">
            <time dateTime={new Date(request.timestamp).toISOString()}>{formatClock(request.timestamp)}</time>
            <span className="claude-live-feed-provider">{providerLogo(request.providerId)}{providerLink(request.providerId)}</span>
            <code className="claude-live-feed-model" title={`${request.model} → ${request.actualModel}`}>{request.model} → {request.actualModel}</code>
            <span className="claude-live-feed-status is-live"><i aria-hidden="true" />正在回答…</span>
            <span className="claude-live-feed-duration">已等待 {formatDuration(elapsed)}</span>
          </div>
          <div className="claude-live-feed-meta">
            {request.attempt > 1 && <span className="is-warning">第 {request.attempt} 次尝试</span>}
            <span>{request.firstByteMs != null ? `首字 ${formatDuration(request.firstByteMs)}` : "等待首字…"}</span>
          </div>
        </li>;
      })}
      {completed.map(log => {
        const cache = cachePercent(log);
        const speed = outputSpeed(log);
        return <li key={`log-${log.id}`} data-feed-key={`log-${log.id}`} className={`claude-live-feed-row${log.status >= 400 ? " is-error" : ""}`}>
          <div className="claude-live-feed-line">
            <time dateTime={new Date(log.timestamp).toISOString()}>{formatClock(log.timestamp)}</time>
            <span className="claude-live-feed-provider">{providerLogo(log.providerId)}{providerLink(log.providerId)}</span>
            <code className="claude-live-feed-model" title={`${log.model} → ${log.actualModel}`}>{log.model} → {log.actualModel}</code>
            <span className={`claude-live-feed-status${log.status >= 400 ? " is-error" : ""}`}>{log.status >= 400 ? `失败 ${log.status}` : "完成"}</span>
            <span className="claude-live-feed-duration">{formatDuration(log.durationMs)}</span>
          </div>
          <div className="claude-live-feed-meta">
            {log.firstByteMs != null && <span>首字 {formatDuration(log.firstByteMs)}</span>}
            <span>输入 {formatRoutingTokens(log.inputTokens)}</span>
            <span>输出 {formatRoutingTokens(log.outputTokens)}</span>
            {cache != null && <span>缓存 {cache.toFixed(1)}%</span>}
            {speed != null && <span>{Math.round(speed)} tok/s</span>}
            <span className="is-muted">{log.mode === "aggregate" ? "聚合" : "路由"}</span>
          </div>
        </li>;
      })}
    </ul>
    {!active.length && !completed.length && <p className="claude-live-feed-empty">{emptyMessage}</p>}
    {completed.length < scopedLogs.length && <p className="claude-live-feed-more">仅显示最近 {MAX_ROWS} 条，完整记录请到「完整用量」。</p>}
  </section>;
}
