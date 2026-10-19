import { useMemo, useState } from "react";
import { Plug, Route, Layers, Settings2, Trash2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { HelpTooltip } from "../../shared/HelpTooltip";
import { type ClaudeMode, type ClaudeProviderSummary, type ClaudeRoutingConfig, type ClaudeRoutingState } from "../../platform/clients/claudeProviders";

export const CLAUDE_MODES: { id: ClaudeMode; label: string; icon: typeof Plug }[] = [
  { id: "direct", label: "直连", icon: Plug }, { id: "route", label: "路由", icon: Route }, { id: "aggregate", label: "聚合", icon: Layers },
];

export function providerModelCount(provider: ClaudeProviderSummary): number {
  const models = provider.modelCatalog?.length ? provider.modelCatalog : Object.values(provider.models ?? {});
  return new Set(models.map(model => model.model).filter(Boolean)).size;
}

export function AggregateStartDialog({ providers, config, initialDefault, onClose, onStart }: {
  providers: ClaudeProviderSummary[]; config: ClaudeRoutingConfig; initialDefault: string;
  onClose: () => void; onStart: (config: ClaudeRoutingConfig) => Promise<void>;
}) {
  const [target, setTarget] = useState(initialDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eligible = providers.filter(provider => !provider.officialLogin && provider.keyConfigured && providerModelCount(provider) > 0);
  const memberIds = [...new Set([...config.members, ...(initialDefault && target !== initialDefault ? [initialDefault] : [])])].filter(id => id !== target);
  const members = providers.filter(provider => memberIds.includes(provider.id));
  return <SharedDialog title="让 Claude Code 使用聚合模式？" subtitle="默认供应商承接不带前缀的请求。" size="small" onClose={onClose} closeDisabled={busy}
    onSubmit={event => {
      event.preventDefault();
      if (busy || !eligible.some(provider => provider.id === target)) return;
      setBusy(true); setError("");
      void onStart({ ...config, defaultProvider: target, members: memberIds }).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : "启用聚合失败")).finally(() => setBusy(false));
    }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !eligible.some(provider => provider.id === target)}>{busy ? "启用中…" : "切换到聚合模式"}</button></>}>
    <label className="claude-field">默认供应商<select required value={target} disabled={busy} onChange={event => setTarget(event.target.value)}><option value="">选择默认供应商</option>{eligible.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    {!eligible.length && <p role="alert" className="claude-error">请先为供应商配置 API Key 和至少一个模型。Claude 官方订阅仅支持直连。</p>}
    <div className="claude-aggregate-notes">
      <p>{members.length ? "另外 " + members.map(provider => provider.name).join("、") + " 共 " + members.reduce((count, provider) => count + providerModelCount(provider), 0) + " 个模型，将以 ccs- 前缀出现在 /model 中。" : "尚未添加其他供应商，可返回列表添加聚合成员。"}</p>
      <p>聚合模式不做故障转移；队列和设置会保留，回到路由模式后继续使用。</p>
      <p>启用后当前作用域配置将指向本地服务，请保持本应用运行；已运行的 Claude Code 请重启以读取连接配置。</p>
    </div>
    {error && <p role="alert" className="claude-error">{error}</p>}
  </SharedDialog>;
}

export function RoutingSettings({ config, mode, running, onClose, onSave }: { config: ClaudeRoutingConfig; mode: "route" | "aggregate"; running: boolean; onClose: () => void; onSave: (config: ClaudeRoutingConfig) => Promise<void> }) {
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
  const visibleFields = fields.filter(field => mode === "route" || !["retries", "failureThreshold", "cooldownSecs"].includes(field.key));
  return <SharedDialog title={mode === "route" ? "Claude Code 路由设置" : "Claude Code 聚合设置"} size="small" onClose={onClose} closeDisabled={busy}
    onSubmit={event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      void onSave(draft).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : "保存失败")).finally(() => setBusy(false));
    }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>保存</button></>}>
    <p className="claude-config-help">端口、超时和请求用量记录由路由与聚合模式共用，不影响直连。{mode === "aggregate" ? "聚合模式不做故障转移，路由的重试和熔断设置保持不变。" : "重试与熔断用于路由队列；自动故障转移开关在页面顶部设置。"}{running ? "本地服务运行中，修改监听端口前请先回到直连。" : "保存设置不会自动启用此模式。"}</p>
    <div className="claude-field-row">{visibleFields.map(field => <label key={field.key} className="claude-field">{field.label}
      <input type="number" required disabled={busy || (running && field.key === "port")} min={field.min} max={field.max} value={Number(draft[field.key])} onChange={e => setDraft(current => ({ ...current, [field.key]: Number(e.target.value) }))} />
    </label>)}</div>
    <label className="claude-check"><input type="checkbox" disabled={busy} checked={draft.logging} onChange={e => setDraft({ ...draft, logging: e.target.checked })} />记录请求用量</label>
    {error && <p role="alert" className="claude-error">{error}</p>}
  </SharedDialog>;
}

export function ModeBar({
  view, state, currentName, activeName, providers = [], scopeLabel, addressFallback, onView, onActivate, onSettings, onFailover, disabled,
}: {
  view: ClaudeMode; state: ClaudeRoutingState;
  /** 直连模式下显示的当前供应商名。 */
  currentName?: string;
  activeName?: string;
  providers?: ClaudeProviderSummary[];
  /** 作用域标签，如 "用户全局" / "项目 ~/work/foo"。路由与聚合下显示在尾段。 */
  scopeLabel?: string;
  /** 直连配置路径，用于副标题。 */
  addressFallback?: string;
  onView: (mode: ClaudeMode) => void;
  onActivate: (mode: ClaudeMode) => void;
  onSettings: () => void;
  onFailover?: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const modeLabel = CLAUDE_MODES.find(mode => mode.id === state.mode)?.label ?? "直连";
  const status = (() => {
    if (state.mode === "direct") {
      const segments = ["直连生效中", "直连连接", currentName?.trim() || "未选择供应商"];
      return segments.join(" · ");
    }
    const segments = [`${modeLabel}生效中`, state.address || addressFallback || ""];
    if (state.mode === "route") segments.push(state.config.failover ? "按队列优先级" : "固定供应商");
    if (state.activeProvider) segments.push(`最近响应 ${activeName || "未知供应商"}`);
    if (state.mode === "aggregate") {
      const members = providers.filter(provider => provider.id !== state.config.defaultProvider && state.config.members.includes(provider.id));
      return ["聚合生效中", "默认 " + (providers.find(provider => provider.id === state.config.defaultProvider)?.name || "未选择"), "另有 " + members.length + " 家共 " + members.reduce((count, provider) => count + providerModelCount(provider), 0) + " 个模型"].join(" · ");
    }
    if (scopeLabel) segments.push(scopeLabel);
    return segments.filter(Boolean).join(" · ");
  })();
  const viewedLabel = CLAUDE_MODES.find(mode => mode.id === view)?.label ?? "直连";
  return <><div className="claude-mode-bar">
    <div role="tablist" aria-label="Claude Code 连接模式" className="claude-mode-tabs">{CLAUDE_MODES.map(mode => {
      const Icon = mode.icon;
      return <button type="button" role="tab" key={mode.id} aria-selected={view === mode.id} onClick={() => onView(mode.id)}>
        <Icon size={15} aria-hidden="true" />{mode.label}{state.mode === mode.id && <i className="claude-live-dot" aria-label="生效中" />}
      </button>;
    })}</div>
    <HelpTooltip label="连接模式的区别">
      <strong>连接模式的区别</strong>
      <p>直连：CloudHub 不转发请求，Claude Code 直接连接所选供应商，使用原生连接方式。</p>
      <p>路由：请求经本机 CloudHub 转发，支持切换供应商、按优先级故障转移和格式转换。</p>
      <p>聚合：多家供应商的模型汇集在 /model 中，在 Claude Code 内选择模型即可分发到对应供应商，不做故障转移。</p>
    </HelpTooltip>
    <span className="claude-mode-status">{status}</span>
    <div className="claude-mode-actions">
      {view === "route" && <label className="claude-check" title="启用后按队列优先级请求，失败时尝试后续供应商"><input type="checkbox" role="switch" checked={state.config.failover} disabled={disabled} onChange={event => onFailover?.(event.target.checked)} />自动故障转移</label>}
      {state.mode !== "direct" && <button type="button" className="secondary" disabled={disabled} onClick={() => onActivate("direct")}>回到直连</button>}
      {view !== "direct" && <button type="button" className="secondary claude-icon-button" disabled={disabled} aria-label={view === "route" ? "路由设置" : "聚合设置"} title={view === "route" ? "路由设置" : "聚合设置"} onClick={onSettings}><Settings2 size={15} aria-hidden="true" /></button>}
    </div>
  </div>
    {view !== state.mode && <div className="claude-mode-banner" role="status">
      <span>正在查看{viewedLabel}页面，Claude Code 当前仍使用{modeLabel}模式。</span>
      {view !== "direct" && <button type="button" className="primary" disabled={disabled} onClick={() => onActivate(view)}>{view === "route" ? "开始路由" : "启用聚合"}</button>}
    </div>}
  </>;
}

export function UsagePanel({ state, providers, onClear }: { state: ClaudeRoutingState; providers: ClaudeProviderSummary[]; onClear: () => void }) {
  const [keyword, setKeyword] = useState("");
  const [modeFilter, setModeFilter] = useState("all");
  const logMode = (mode: ClaudeMode | null | undefined) => mode === "route" || mode === "aggregate" ? mode : "unknown";
  const modeLabel = (mode: ClaudeMode | null | undefined) => mode === "route" ? "路由" : mode === "aggregate" ? "聚合" : "未知";
  const logs = state.logs.filter(log => (modeFilter === "all" || logMode(log.mode) === modeFilter) && `${modeLabel(log.mode)} ${log.model} ${log.actualModel} ${providers.find(p => p.id === log.providerId)?.name ?? log.providerId} ${log.status}`.toLowerCase().includes(keyword.toLowerCase()));
  const totals = useMemo(() => logs.reduce((sum, log) => ({
    requests: sum.requests + 1, failed: sum.failed + Number(log.status >= 400), input: sum.input + log.inputTokens, output: sum.output + log.outputTokens, cache: sum.cache + log.cacheReadTokens,
  }), { requests: 0, failed: 0, input: 0, output: 0, cache: 0 }), [logs]);
  return <section className="claude-usage">
    <div className="claude-metrics">{[["请求", totals.requests], ["失败", totals.failed], ["输入 Token", totals.input], ["输出 Token", totals.output], ["缓存命中", totals.cache]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{Number(value).toLocaleString()}</strong></div>)}</div>
    <p className="claude-config-help">仅记录经过本地服务的请求；直连请求不在此统计。旧日志未记录连接模式的显示为“未知”。统计随当前筛选更新，清空日志将删除全部记录。</p>
    <div className="claude-work-toolbar claude-usage-toolbar">
      <input type="search" aria-label="搜索请求日志" placeholder="搜索模式、模型、供应商或状态" value={keyword} onChange={e => setKeyword(e.target.value)} />
      <label className="claude-usage-mode-filter"><span>连接模式</span><select value={modeFilter} onChange={event => setModeFilter(event.target.value)}><option value="all">全部</option><option value="route">路由</option><option value="aggregate">聚合</option><option value="unknown">未知</option></select></label>
      <button type="button" className="secondary claude-usage-clear" onClick={onClear}><Trash2 size={14} aria-hidden="true" />清空日志</button>
    </div>
    <div className="claude-table-scroll"><table><thead><tr><th>时间</th><th>连接模式</th><th>供应商</th><th>请求模型 → 实际模型</th><th>状态</th><th>耗时</th><th>输入 / 输出</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{new Date(log.timestamp).toLocaleTimeString()}</td><td>{modeLabel(log.mode)}</td><td>{providers.find(p => p.id === log.providerId)?.name ?? log.providerId}</td><td><code>{log.model} → {log.actualModel}</code></td><td>{log.status}</td><td>{log.durationMs} ms</td><td>{log.inputTokens} / {log.outputTokens}</td></tr>)}</tbody></table></div>
    {!logs.length && <p role="status" className="claude-empty-line">{state.logs.length ? "没有符合筛选条件的请求，请切换到全部模式或清空搜索。" : "暂无本地路由或聚合请求记录"}</p>}
  </section>;
}
