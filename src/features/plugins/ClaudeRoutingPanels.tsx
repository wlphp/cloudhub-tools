import { useMemo, useState } from "react";
import { Plug, Route, Layers, Settings2, Trash2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { type ClaudeMode, type ClaudeProviderSummary, type ClaudeRoutingConfig, type ClaudeRoutingState } from "../../platform/clients/claudeProviders";

export const CLAUDE_MODES: { id: ClaudeMode; label: string; icon: typeof Plug }[] = [
  { id: "direct", label: "直连", icon: Plug }, { id: "route", label: "路由", icon: Route }, { id: "aggregate", label: "聚合", icon: Layers },
];

export function RoutingSettings({ config, onClose, onSave }: { config: ClaudeRoutingConfig; onClose: () => void; onSave: (config: ClaudeRoutingConfig) => Promise<void> }) {
  const [draft, setDraft] = useState(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields: { key: keyof ClaudeRoutingConfig; label: string; min: number; max: number }[] = [
    { key: "port", label: "监听端口", min: 1024, max: 65535 },
    { key: "retries", label: "最大重试次数", min: 0, max: 10 },
    { key: "timeoutSecs", label: "请求总超时（秒）", min: 10, max: 1200 },
    { key: "firstByteSecs", label: "响应头超时（秒）", min: 1, max: 120 },
    { key: "idleSecs", label: "流式静默超时（秒，0 禁用）", min: 0, max: 600 },
    { key: "failureThreshold", label: "连续失败熔断阈值", min: 1, max: 20 },
    { key: "cooldownSecs", label: "熔断恢复等待（秒）", min: 0, max: 300 },
  ];
  return <SharedDialog title="Claude Code 路由设置" size="small" onClose={onClose} closeDisabled={busy}
    onSubmit={event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      void onSave(draft).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : "保存失败")).finally(() => setBusy(false));
    }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>保存</button></>}>
    <div className="claude-field-row">{fields.map(field => <label key={field.key} className="claude-field">{field.label}
      <input type="number" required min={field.min} max={field.max} value={Number(draft[field.key])} onChange={e => setDraft(current => ({ ...current, [field.key]: Number(e.target.value) }))} />
    </label>)}</div>
    <label className="claude-check"><input type="checkbox" checked={draft.logging} onChange={e => setDraft({ ...draft, logging: e.target.checked })} />记录请求用量</label>
    {error && <p role="alert" className="claude-error">{error}</p>}
  </SharedDialog>;
}

export function ModeBar({
  view, state, currentName, scopeLabel, addressFallback, onView, onActivate, onSettings, disabled,
}: {
  view: ClaudeMode; state: ClaudeRoutingState;
  /** 直连模式下显示的当前供应商名。 */
  currentName?: string;
  /** 作用域标签，如 "用户全局" / "项目 ~/work/foo"。路由与聚合下显示在尾段。 */
  scopeLabel?: string;
  /** 直连配置路径，用于副标题。 */
  addressFallback?: string;
  onView: (mode: ClaudeMode) => void;
  onActivate: (mode: ClaudeMode) => void;
  onSettings: () => void;
  disabled: boolean;
}) {
  const modeLabel = CLAUDE_MODES.find(mode => mode.id === state.mode)?.label ?? "直连";
  const status = (() => {
    if (state.mode === "direct") {
      const segments = ["直连生效中", "直连连接", currentName?.trim() || "未选择供应商"];
      return segments.join(" · ");
    }
    const segments = [`${modeLabel}生效中`, state.address || addressFallback || ""];
    if (state.mode === "route" && state.activeProvider) segments.push(`主供应商 ${state.activeProvider}`);
    if (state.mode === "aggregate") segments.push(`${state.activeProvider ? `默认 ${state.activeProvider}` : "未指定默认"} · ${state.config?.members?.length ?? 0} 成员`);
    if (scopeLabel) segments.push(scopeLabel);
    return segments.filter(Boolean).join(" · ");
  })();
  return <div className="claude-mode-bar">
    <div role="tablist" aria-label="Claude Code 连接模式" className="claude-mode-tabs">{CLAUDE_MODES.map(mode => {
      const Icon = mode.icon;
      return <button type="button" role="tab" key={mode.id} aria-selected={view === mode.id} onClick={() => onView(mode.id)}>
        <Icon size={15} aria-hidden="true" />{mode.label}{state.mode === mode.id && <i className="claude-live-dot" aria-label="生效中" />}
      </button>;
    })}</div>
    <span className="claude-mode-status">{status}</span>
    <div className="claude-mode-actions">
      {view !== state.mode && <button type="button" className="primary" disabled={disabled} onClick={() => onActivate(view)}>{view === "direct" ? "回到直连" : view === "route" ? "开始路由" : "切换到聚合模式"}</button>}
      {state.mode !== "direct" && view !== "direct" && <button type="button" className="secondary" disabled={disabled} onClick={() => onActivate("direct")}>回到直连</button>}
      <button type="button" className="secondary claude-icon-button" aria-label="路由设置" title="路由设置" onClick={onSettings}><Settings2 size={15} /></button>
    </div>
  </div>;
}

export function UsagePanel({ state, providers, onClear }: { state: ClaudeRoutingState; providers: ClaudeProviderSummary[]; onClear: () => void }) {
  const [keyword, setKeyword] = useState("");
  const logs = state.logs.filter(log => `${log.model} ${log.actualModel} ${providers.find(p => p.id === log.providerId)?.name ?? log.providerId} ${log.status}`.toLowerCase().includes(keyword.toLowerCase()));
  const totals = useMemo(() => state.logs.reduce((sum, log) => ({
    requests: sum.requests + 1, failed: sum.failed + Number(log.status >= 400), input: sum.input + log.inputTokens, output: sum.output + log.outputTokens, cache: sum.cache + log.cacheReadTokens,
  }), { requests: 0, failed: 0, input: 0, output: 0, cache: 0 }), [state.logs]);
  return <section className="claude-usage">
    <div className="claude-metrics">{[["请求", totals.requests], ["失败", totals.failed], ["输入 Token", totals.input], ["输出 Token", totals.output], ["缓存命中", totals.cache]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{Number(value).toLocaleString()}</strong></div>)}</div>
    <div className="claude-work-toolbar"><input type="search" aria-label="搜索请求日志" placeholder="搜索模型、供应商或状态" value={keyword} onChange={e => setKeyword(e.target.value)} /><button type="button" className="secondary" onClick={onClear}><Trash2 size={14} />清空日志</button></div>
    <div className="claude-table-scroll"><table><thead><tr><th>时间</th><th>供应商</th><th>请求模型 → 实际模型</th><th>状态</th><th>耗时</th><th>输入 / 输出</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{new Date(log.timestamp).toLocaleTimeString()}</td><td>{providers.find(p => p.id === log.providerId)?.name ?? log.providerId}</td><td><code>{log.model} → {log.actualModel}</code></td><td>{log.status}</td><td>{log.durationMs} ms</td><td>{log.inputTokens} / {log.outputTokens}</td></tr>)}</tbody></table></div>
    {!logs.length && <p role="status" className="claude-empty-line">暂无路由请求记录</p>}
  </section>;
}
