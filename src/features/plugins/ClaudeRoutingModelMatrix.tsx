import { useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { claudeWorkbenchClient, type ClaudeModelMapping, type ClaudeProviderSummary, type ClaudeRoutingConfig } from "../../platform/clients/claudeProviders";
import { CLAUDE_MODEL_ROLES } from "./claudeModelRoles";

type Draft = Record<string, Record<string, ClaudeModelMapping>>;

function buildDraft(columns: ClaudeProviderSummary[]): Draft {
  const draft: Draft = {};
  for (const provider of columns) {
    const models: Record<string, ClaudeModelMapping> = {};
    for (const role of CLAUDE_MODEL_ROLES) {
      const mapping = provider.models?.[role.key];
      if (mapping?.model?.trim()) models[role.key] = { ...mapping, model: mapping.model.trim() };
    }
    draft[provider.id] = models;
  }
  return draft;
}

function modelOptions(provider: ClaudeProviderSummary, current: string) {
  const seen = new Set<string>();
  const options: { model: string; displayName?: string }[] = [];
  for (const item of provider.modelCatalog ?? []) {
    const model = item.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    options.push({ model, displayName: item.displayName });
  }
  if (current && !seen.has(current)) options.push({ model: current, displayName: current });
  return options;
}

function optionLabel(item: { model: string; displayName?: string }): string {
  return item.displayName && item.displayName !== item.model ? `${item.displayName}（${item.model}）` : item.model;
}

/**
 * 路由级模型矩阵：行是 Claude Code 角色，列是当前路由队列里的渠道。
 * 编辑的是各供应商的 `models` 绑定；保存只更新模型字段，不动密钥和地址。
 */
export function ClaudeRoutingModelMatrix({ providers, config, onClose, onSaved }: {
  providers: ClaudeProviderSummary[];
  config: ClaudeRoutingConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const columns = useMemo(() => {
    const ids = [...new Set([...config.queue, config.routeProvider].filter(Boolean))];
    return ids
      .map(id => providers.find(provider => provider.id === id))
      .filter((provider): provider is ClaudeProviderSummary => provider !== undefined && !provider.officialLogin);
  }, [config.queue, config.routeProvider, providers]);
  const [draft, setDraft] = useState<Draft>(() => buildDraft(columns));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fixedProvider = columns.find(provider => provider.id === config.routeProvider);
  const fixedModels = fixedProvider ? draft[fixedProvider.id] ?? {} : {};
  const exposedRoles = CLAUDE_MODEL_ROLES.filter(role => fixedModels[role.key]?.model).map(role => `${role.label} · 路由`);

  const blocking = useMemo(() => {
    const messages: string[] = [];
    if (!columns.length) messages.push("当前路由队列没有可编辑的渠道，请先把供应商加入队列。");
    if (!fixedProvider) messages.push("尚未设置固定供应商，无法生成客户端角色映射。");
    else if (!draft[fixedProvider.id]?.sonnet?.model) messages.push(`固定供应商「${fixedProvider.name}」缺少 Sonnet 映射。`);
    if (config.failover) {
      const checked = new Set<string>();
      for (const provider of columns) {
        if (!config.queue.includes(provider.id) || checked.has(provider.id)) continue;
        checked.add(provider.id);
        if (!draft[provider.id]?.sonnet?.model) messages.push(`路由队列中的「${provider.name}」缺少 Sonnet 映射，无法参与故障转移。`);
      }
    }
    return messages;
  }, [columns, config.failover, config.queue, draft, fixedProvider]);

  const warnings = useMemo(() => {
    const messages: string[] = [];
    for (const provider of columns) {
      const missing = CLAUDE_MODEL_ROLES.filter(role => !draft[provider.id]?.[role.key]?.model).map(role => role.label);
      const optional = missing.filter(label => label !== "Sonnet");
      if (optional.length) messages.push(`${provider.name}：${optional.join(" / ")} 未映射，网关会回退到该渠道的 Sonnet。`);
      if (!provider.modelCatalog?.length) messages.push(`${provider.name}：渠道模型目录为空，新增模型请先到供应商编辑里获取或手动添加。`);
    }
    return [...new Set(messages)];
  }, [columns, draft]);

  const setCell = (providerId: string, role: string, model: string) => {
    setDraft(current => {
      const next: Draft = { ...current, [providerId]: { ...(current[providerId] ?? {}) } };
      if (!model) {
        delete next[providerId][role];
        return next;
      }
      const provider = columns.find(item => item.id === providerId);
      const existing = current[providerId]?.[role];
      const catalogEntry = provider?.modelCatalog?.find(item => item.model === model);
      next[providerId][role] = {
        model,
        displayName: existing?.model === model ? existing.displayName : catalogEntry?.displayName,
        supports1m: existing?.model === model ? existing.supports1m : catalogEntry?.supports1m,
      };
      return next;
    });
  };

  const save = async () => {
    if (busy) return;
    if (blocking.length) { setError(blocking[0]); return; }
    setBusy(true);
    setError("");
    try {
      await claudeWorkbenchClient.saveRoutingModels(columns.map(provider => ({ id: provider.id, models: draft[provider.id] ?? {} })));
      onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存模型映射失败");
    } finally {
      setBusy(false);
    }
  };

  return <SharedDialog
    sizeStorageKey="features/plugins/claude-routing-model-matrix"
    title="路由模型映射"
    subtitle="渠道先提供可用模型，再为每个 Claude Code 角色绑定实际模型。"
    className="claude-route-models-dialog"
    size="large"
    closeDisabled={busy}
    onClose={onClose}
    onSubmit={event => { event.preventDefault(); void save(); }}
    footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className="primary" disabled={busy || blocking.length > 0}>{busy ? <Loader2 className="is-spin" size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{busy ? "保存中…" : "保存映射"}</button>
    </>}
  >
    <p className="claude-config-help">客户端只会收到 <code>claude-sonnet-5</code> 这类角色 ID；真实模型由网关按下方矩阵改写。未映射角色不会出现在客户端菜单，收到对应请求时回退到该渠道的 Sonnet。</p>
    <div className="claude-route-models-client" aria-live="polite"><span>客户端将收到</span><strong>{exposedRoles.length ? exposedRoles.join(" / ") : "暂无已映射角色"}</strong></div>
    {blocking.length > 0 && <div className="claude-route-models-blocking" role="alert"><AlertTriangle size={14} aria-hidden="true" /><span>{blocking[0]}</span></div>}
    {columns.length > 0 ? <div className="claude-route-models-scroll">
      <table className="claude-route-models-table">
        <thead><tr>
          <th scope="col">角色</th>
          {columns.map(provider => {
            const queueIndex = config.queue.indexOf(provider.id);
            const fixed = provider.id === config.routeProvider;
            return <th key={provider.id} scope="col" className={fixed ? "is-fixed" : ""}>
              <span className="claude-route-models-provider"><strong>{provider.name}</strong>{queueIndex >= 0 && <span className="claude-route-models-p">P{queueIndex + 1}</span>}{fixed && <span className="claude-route-models-fixed">固定</span>}</span>
              {!draft[provider.id]?.sonnet?.model && <small>缺少 Sonnet</small>}
            </th>;
          })}
        </tr></thead>
        <tbody>{CLAUDE_MODEL_ROLES.map(role => <tr key={role.key}>
          <th scope="row">{role.label}{role.key === "subagent" && <small>独立子代理</small>}</th>
          {columns.map(provider => {
            const mapping = draft[provider.id]?.[role.key];
            return <td key={provider.id} className={provider.id === config.routeProvider ? "is-fixed" : ""}>
              <div className="claude-route-models-cell">
                <select aria-label={`${provider.name} ${role.label} 模型`} value={mapping?.model ?? ""} onChange={event => setCell(provider.id, role.key, event.target.value)}>
                  <option value="">未映射（回退 Sonnet）</option>
                  {modelOptions(provider, mapping?.model ?? "").map(item => <option key={item.model} value={item.model}>{optionLabel(item)}</option>)}
                </select>
                {mapping?.supports1m && <span className="claude-route-models-1m">1M</span>}
              </div>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div> : <p className="claude-empty-line">当前没有可编辑的渠道。</p>}
    {warnings.length > 0 && <ul className="claude-route-models-warnings">{warnings.map(message => <li key={message}><AlertTriangle size={12} aria-hidden="true" />{message}</li>)}</ul>}
    <p className="claude-config-help">保存后会刷新网关；路由运行中会立即重新应用。已运行的 Claude Code 需重启以读取新的角色列表。渠道模型目录在供应商编辑里维护。</p>
    {error && <p className="claude-error" role="alert">{error}</p>}
  </SharedDialog>;
}
