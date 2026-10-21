import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Pencil, Copy, Trash2, RefreshCw, Search, Server, Play, FlaskConical, Gauge, Upload, Layers, GripVertical } from "lucide-react";
import { ProviderEditorPage, providerEditorInput } from "./ProviderEditorPage";
import { ProviderImportDialog } from "./ProviderImportDialog";
import { ProviderUsageDialog } from "./ProviderUsageDialog";
import { ProviderProbeDialog } from "./ProviderProbeDialog";
import { ProviderLaunchDialog, type ProviderLaunchTarget } from "./ProviderLaunchDialog";
import { codexProviders, type CodexProvider, type ProviderInput, type ProviderAggregate, type ProviderAggregateInput } from "../../platform/clients/codex-providers";
import { OverviewDialog } from "./OverviewDialogs";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { preferencesClient } from "../../platform/clients/preferences";
import "./model-providers.css";

const fresh = (): ProviderInput => ({ id: null, version: null, name: "", baseUrl: "", wireApi: "responses", models: [], note: "", keys: [{ id: null, name: "默认密钥", secret: "", settings: { models: [], modelsScoped: true } }] });
const freshAggregate = (): ProviderAggregateInput => ({ id: null, version: null, name: "", strategy: "failover", members: [] });
const mergeKeyModels = (keys: ProviderInput["keys"]) => [...new Set(keys.flatMap(key => key.settings?.models ?? []))];
const SWITCH_ENABLED_KEY = "codex.providers.switch-enabled";
const PROVIDER_ORDER_KEY = "codex.providers.order";

function reconcileProviderOrder(order: string[], providers: CodexProvider[]) {
  const ids = providers.map(provider => provider.id);
  return [...order.filter(id => ids.includes(id)), ...ids.filter(id => !order.includes(id))];
}

function sortProviders(providers: CodexProvider[], order: string[]) {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...providers].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

export function ModelProviders({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<CodexProvider[]>([]);
  const [aggregates, setAggregates] = useState<ProviderAggregate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [switchEnabled, setSwitchEnabled] = useState(false);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [savingSwitch, setSavingSwitch] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderInput | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState("");
  const [removing, setRemoving] = useState<CodexProvider | null>(null);
  const [launching, setLaunching] = useState<ProviderLaunchTarget | null>(null);
  const [probing, setProbing] = useState<CodexProvider | null>(null);
  const [usage, setUsage] = useState<CodexProvider | null>(null);
  const [importing, setImporting] = useState(false);
  const [aggregateEditing, setAggregateEditing] = useState<ProviderAggregateInput | null>(null);
  const [aggregateRemoving, setAggregateRemoving] = useState<ProviderAggregate | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const providerOrderRef = useRef<string[]>([]);
  useEffect(() => {
    alive.current = true;
    void Promise.allSettled([codexProviders.list(), codexProviders.aggregateList(), preferencesClient.list()]).then(([providerResult, aggregateResult, preferenceResult]) => {
      if (!alive.current) return;
      if (providerResult.status === "rejected") throw providerResult.reason;
      const providers = providerResult.value;
      const groups = aggregateResult.status === "fulfilled" ? aggregateResult.value : [];
      const preferences = preferenceResult.status === "fulfilled" ? preferenceResult.value : {};
      if (aggregateResult.status === "rejected") setError("读取聚合供应商失败");
      if (preferenceResult.status === "rejected") setError("读取供应商切换设置失败，当前按关闭处理");
      let savedOrder: string[] = [];
      try {
        const parsed: unknown = JSON.parse(preferences[PROVIDER_ORDER_KEY] ?? "[]");
        if (Array.isArray(parsed)) savedOrder = parsed.filter((value): value is string => typeof value === "string");
      } catch { /* Ignore invalid local ordering and use the repository order. */ }
      const order = reconcileProviderOrder(savedOrder, providers);
      providerOrderRef.current = order;
      setItems(sortProviders(providers, order));
      setAggregates(groups);
      setSwitchEnabled(preferences[SWITCH_ENABLED_KEY] === "true");
      if (JSON.stringify(order) !== JSON.stringify(savedOrder)) void preferencesClient.save(PROVIDER_ORDER_KEY, JSON.stringify(order)).catch(() => undefined);
    }).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : "读取供应商失败"); }).finally(() => {
      if (alive.current) { setLoading(false); setPreferencesLoading(false); }
    });
    return () => { alive.current = false; };
  }, []);
  function updateProviderList(values: CodexProvider[]) {
    const order = reconcileProviderOrder(providerOrderRef.current, values);
    const changed = JSON.stringify(order) !== JSON.stringify(providerOrderRef.current);
    providerOrderRef.current = order;
    setItems(sortProviders(values, order));
    if (selectedProviderId && !values.some(value => value.id === selectedProviderId)) setSelectedProviderId(null);
    if (changed) void preferencesClient.save(PROVIDER_ORDER_KEY, JSON.stringify(order)).catch(() => {
      if (alive.current) setError("供应商已更新，但排序偏好保存失败");
    });
  }
  async function setProviderSwitchEnabled(enabled: boolean) {
    if (savingSwitch || preferencesLoading) return false;
    setSavingSwitch(true);
    setError("");
    try {
      await preferencesClient.save(SWITCH_ENABLED_KEY, String(enabled));
      if (alive.current) setSwitchEnabled(enabled);
      return alive.current;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "保存供应商切换设置失败");
      return false;
    } finally { if (alive.current) setSavingSwitch(false); }
  }
  function reorderProvider(sourceId: string, targetId: string) {
    if (busy) return;
    const sourceIndex = items.findIndex(value => value.id === sourceId);
    const targetIndex = items.findIndex(value => value.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const next = [...items];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    const order = next.map(value => value.id);
    providerOrderRef.current = order;
    setItems(next);
    void preferencesClient.save(PROVIDER_ORDER_KEY, JSON.stringify(order)).catch(e => {
      if (alive.current) setError(e instanceof Error ? e.message : "保存供应商排序失败");
    });
  }
  function moveProvider(providerId: string, delta: -1 | 1) {
    const index = items.findIndex(value => value.id === providerId);
    const target = items[index + delta];
    if (index < 0 || !target) return;
    reorderProvider(providerId, target.id);
  }
  async function run(action: () => Promise<CodexProvider[]>, close = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const values = await action(); if (alive.current) { updateProviderList(values); if (close) { setEditing(null); setRemoving(null); } } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "供应商操作失败"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function runAggregate(action: () => Promise<ProviderAggregate[]>, close = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const values = await action(); if (alive.current) { setAggregates(values); if (close) { setAggregateEditing(null); setAggregateRemoving(null); } } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "聚合供应商操作失败"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const [providers, groups] = await Promise.all([codexProviders.list(), codexProviders.aggregateList()]);
      if (alive.current) { updateProviderList(providers); setAggregates(groups); }
    }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "刷新供应商失败"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function edit(value?: CodexProvider) {
    const keys = value?.keys.map(k => ({ ...k, secret: null, settings: { ...k.settings, models: k.settings?.modelsScoped || k.settings?.models?.length ? k.settings.models ?? [] : value.models, modelsScoped: true } }));
    setError("");
    setCatalogMessage("");
    setEditing(value && keys ? { ...value, keys } : { ...fresh(), name: `供应商 ${items.length + 1}` });
  }
  function updateKeys(keys: ProviderInput["keys"]) {
    setEditing(current => current ? { ...current, keys } : current);
  }
  async function fetchModels() {
    if (pending.current || !editing) return;
    if (!editing.baseUrl.trim() || !editing.keys.length || editing.keys.some(key => !key.id && !key.secret?.trim())) return;
    pending.current = true; setBusy(true); setFetchingModels(true); setError(""); setCatalogMessage("");
    try {
      const outcomes: ({ models: string[] } | { failed: true })[] = Array(editing.keys.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < editing.keys.length) {
          const index = cursor++;
          const key = editing.keys[index];
          try {
            const result = await codexProviders.models({ baseUrl: editing.baseUrl.trim(), providerId: editing.id, version: editing.version, keyId: key.id, secret: key.secret || null });
            outcomes[index] = result.error ? { failed: true } : { models: result.models };
          } catch {
            outcomes[index] = { failed: true };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, editing.keys.length) }, worker));
      if (!alive.current) return;
      const keys = editing.keys.map((key, index) => {
        const outcome = outcomes[index];
        if (!outcome || "failed" in outcome) return key;
        const keyModels = [...new Set([...(key.settings?.models ?? []), ...outcome.models])];
        return { ...key, settings: { ...key.settings, models: keyModels, modelsScoped: true } };
      });
      const catalog = mergeKeyModels(keys);
      if (catalog.length > 200 || keys.some(key => (key.settings?.models?.length ?? 0) > 200)) {
        setError("合并后超过 200 个模型，请先精简密钥模型目录");
        return;
      }
      updateKeys(keys);
      const successful = outcomes.filter(outcome => outcome && !("failed" in outcome)).length;
      const failed = outcomes.flatMap((outcome, index) => outcome && "failed" in outcome ? [editing.keys[index].name || `密钥 ${index + 1}`] : []);
      const found = outcomes.reduce((count, outcome) => count + (outcome && "models" in outcome ? outcome.models.length : 0), 0);
      setCatalogMessage(`已查询 ${successful}/${editing.keys.length} 个密钥，发现 ${found} 个模型${failed.length ? `；失败：${failed.join("、")}` : ""}`);
    } catch { if (alive.current) setError("获取模型目录失败"); }
    finally { pending.current = false; if (alive.current) { setBusy(false); setFetchingModels(false); } }
  }
  const visible = items.filter(v => (protocol === "all" || v.wireApi === protocol) && (v.name + " " + v.baseUrl + " " + v.models.join(" ")).toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  return <div className="codex-providers" aria-busy={loading || busy || preferencesLoading}>
    <section className="codex-provider-list-panel" aria-labelledby="codex-provider-list-heading">
      <header className="codex-provider-list-heading"><h2 id="codex-provider-list-heading">供应商列表</h2><span>{items.length} 个供应商配置；可拖动排序，点击编辑进入详情</span></header>
      <div className="codex-provider-switch-row">
        <div><strong>启用供应商配置切换</strong><p>关闭后本工具不会在手动切换时写入 Codex 的 config.toml / auth.json；启动 Codex 时始终不会自动改动这些文件。</p></div>
        <button type="button" className="codex-provider-switch" role="switch" aria-checked={switchEnabled} aria-label="启用供应商配置切换" disabled={savingSwitch || preferencesLoading} onClick={() => void setProviderSwitchEnabled(!switchEnabled)}><span /></button>
      </div>
      <div className="codex-provider-toolbar">
        <div className="codex-provider-filters">
          <label className="codex-provider-search"><Search size={15} /><input aria-label="搜索模型供应商" placeholder="搜索名称、地址或模型" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <select aria-label="供应商协议筛选" value={protocol} onChange={e => setProtocol(e.target.value)}><option value="all">全部协议</option><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></select>
          <span>{visible.length} 个供应商</span>
        </div>
        <div className="codex-provider-actions">
          <button title="刷新供应商" aria-label="刷新供应商" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={15} /></button>
          <button disabled={busy} onClick={() => edit()}><Plus size={15} />添加供应商</button>
          <button disabled={busy || loading || items.filter(v => v.wireApi === "chat_completions").reduce((count, v) => count + v.keys.length, 0) < 2} onClick={() => { setError(""); setAggregateEditing(freshAggregate()); }}><Plus size={15} />添加聚合供应商</button>
          <button title="从第三方导入" aria-label="从第三方导入" disabled={busy} onClick={() => setImporting(true)}><Upload size={15} />从第三方导入</button>
        </div>
      </div>
      {error && !editing && !removing && <p role="alert" className="codex-card-error">{error}</p>}
      {loading ? <p role="status">正在读取供应商...</p> : !visible.length ? <div className="codex-empty"><Server size={30} /><h2>{items.length ? "没有匹配的供应商" : "暂无模型供应商"}</h2><button onClick={() => edit()}><Plus size={15} />添加供应商</button></div> : <div className="codex-provider-list" aria-label="模型供应商">
        {visible.map(v => {
          const selected = selectedProviderId === v.id;
          return <article className={`codex-provider-row${selected ? " is-selected" : ""}${draggingProviderId && draggingProviderId !== v.id ? " is-drop-target" : ""}`} key={v.id} aria-label={"模型供应商 " + v.name} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={event => { event.preventDefault(); const source = event.dataTransfer.getData("text/plain") || draggingProviderId; if (source) reorderProvider(source, v.id); setDraggingProviderId(null); }} onDragEnd={() => setDraggingProviderId(null)}>
            <button type="button" className="codex-provider-reorder-handle" title="拖动排序，或使用上下方向键" aria-label={`排序 ${v.name}，按上下方向键调整位置`} disabled={busy} draggable={!busy} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveProvider(v.id, event.key === "ArrowUp" ? -1 : 1); } }} onDragStart={event => { setDraggingProviderId(v.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", v.id); }}><GripVertical size={17} /></button>
            <div className="codex-provider-row-info" role="button" tabIndex={0} aria-pressed={selected} onClick={() => setSelectedProviderId(v.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedProviderId(v.id); } }}>
              <span className="codex-provider-avatar" aria-hidden="true">{v.name.trim().slice(0, 1).toLocaleUpperCase() || <Server size={17} />}</span>
              <span className="codex-provider-row-copy"><strong>{v.name}</strong><span>{v.wireApi === "responses" ? "Responses API" : "Chat Completions"} · {v.baseUrl} · {v.keys.length} 个密钥 · {v.models.length} 个模型</span></span>
            </div>
            <div className="codex-provider-row-actions" role="group" aria-label={`${v.name} 操作`}>
              <button title="查询额度" aria-label={`查询额度 ${v.name}`} disabled={busy} onClick={() => setUsage(v)}><Gauge size={15} /></button>
              <button title="模型测试" aria-label={`模型测试 ${v.name}`} disabled={busy} onClick={() => setProbing(v)}><FlaskConical size={15} /></button>
              <button title="启动预览" aria-label={`启动预览 ${v.name}`} disabled={busy} onClick={() => { setSelectedProviderId(v.id); setLaunching({ kind: "provider", value: v }); }}><Play size={15} /></button>
              <button title="编辑供应商" aria-label={`编辑 ${v.name}`} disabled={busy} onClick={() => { setSelectedProviderId(v.id); edit(v); }}><Pencil size={15} /></button>
              <button type="button" title="复制供应商" aria-label={`复制 ${v.name}`} disabled={busy} onClick={() => void run(() => codexProviders.duplicate(v.id, v.version))}><Copy size={15} /></button>
              <button title="删除供应商" aria-label={`删除 ${v.name}`} disabled={busy} onClick={() => { setError(""); setRemoving(v); }}><Trash2 size={15} /></button>
            </div>
          </article>;
        })}
      </div>}
    {aggregates.length > 0 && <section className="codex-aggregate-section" aria-label="聚合供应商">
      <header><h2><Layers size={17} />聚合供应商</h2><span>{aggregates.length} 个配置</span></header>
      <div className="codex-aggregate-list">{aggregates.map(value => <article className="codex-aggregate-row" key={value.id}>
        <div><strong>{value.name}</strong><span>{value.strategy === "failover" ? "故障切换" : value.strategy === "roundRobin" ? "请求轮询" : "加权轮询"}</span></div>
        <div>{value.members.map(member => `${member.providerName} · ${member.keyName} (${member.weight})`).join(" / ")}</div>
        <div>{value.models.join(" / ")}</div>
        <footer><button title="启动预览" aria-label={"启动预览聚合 " + value.name} disabled={busy} onClick={() => setLaunching({ kind: "aggregate", value })}><Play size={15} /></button><button title="编辑聚合" aria-label={"编辑聚合 " + value.name} disabled={busy} onClick={() => setAggregateEditing({ id: value.id, version: value.version, name: value.name, strategy: value.strategy, members: value.members.map(({ providerId, keyId, weight }) => ({ providerId, keyId, weight })) })}><Pencil size={15} /></button><button title="删除聚合" aria-label={"删除聚合 " + value.name} disabled={busy} onClick={() => setAggregateRemoving(value)}><Trash2 size={15} /></button></footer>
      </article>)}</div>
    </section>}
    </section>
    {editing && <ProviderEditorPage value={editing} busy={busy} fetchingModels={fetchingModels} catalogMessage={catalogMessage} error={error} onChange={setEditing} onKeysChange={updateKeys} onFetchModels={() => void fetchModels()} onSave={() => void run(() => codexProviders.save(providerEditorInput(editing)), true)} onClose={() => { setEditing(null); setError(""); }} />}
    {aggregateEditing && <AggregateDialog value={aggregateEditing} providers={items.filter(v => v.wireApi === "chat_completions")} busy={busy} onClose={() => setAggregateEditing(null)} onChange={setAggregateEditing} onSave={() => void runAggregate(() => codexProviders.aggregateSave(aggregateEditing), true)} error={error} />}
    {launching && <ProviderLaunchDialog target={launching} switchEnabled={switchEnabled} onEnableSwitch={() => setProviderSwitchEnabled(true)} onClose={() => { setLaunching(null); onChanged?.(); }} />}
    {probing && <ProviderProbeDialog provider={probing} onClose={() => setProbing(null)} onSaved={updateProviderList} />}
    {usage && <ProviderUsageDialog provider={usage} onClose={() => setUsage(null)} />}
    {importing && <ProviderImportDialog onClose={() => setImporting(false)} onSaved={updateProviderList} />}
    {removing && createPortal(<ConfirmDialog title="删除模型供应商" message={"删除“" + removing.name + "”及其保存的全部密钥？"} confirmLabel="删除" busy={busy} error={error} onResolve={yes => yes ? void run(() => codexProviders.remove(removing.id, removing.version), true) : setRemoving(null)} />, document.body)}
    {aggregateRemoving && createPortal(<ConfirmDialog title="删除聚合供应商" message={"删除“" + aggregateRemoving.name + "”的聚合配置？成员供应商及密钥不会删除。"} confirmLabel="删除" busy={busy} error={error} onResolve={yes => yes ? void runAggregate(() => codexProviders.aggregateRemove(aggregateRemoving.id, aggregateRemoving.version), true) : setAggregateRemoving(null)} />, document.body)}
  </div>;
}

function AggregateDialog({ value, providers, busy, error, onClose, onChange, onSave }: { value: ProviderAggregateInput; providers: CodexProvider[]; busy: boolean; error: string; onClose: () => void; onChange: (value: ProviderAggregateInput) => void; onSave: () => void }) {
  const valid = value.name.trim().length > 0 && value.members.length >= 2 && value.members.length <= 50 && value.members.every(member => member.weight >= 1 && member.weight <= 100);
  function toggle(provider: CodexProvider, keyId: string, checked: boolean) {
    const found = value.members.some(member => member.providerId === provider.id && member.keyId === keyId);
    const members = checked && !found ? [...value.members, { providerId: provider.id, keyId, weight: 1 }] : !checked ? value.members.filter(member => member.providerId !== provider.id || member.keyId !== keyId) : value.members;
    onChange({ ...value, members });
  }
  return <OverviewDialog title={value.id ? "编辑聚合供应商" : "新建聚合供应商"} busy={busy} layout="form" onClose={onClose} footer={<><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy || !valid} onClick={onSave}>{busy ? "保存中..." : "保存"}</button></>}>
    <div className="codex-provider-form codex-aggregate-form">
      <label>名称<input maxLength={100} disabled={busy} value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} /></label>
      <label>调度策略<select disabled={busy} value={value.strategy} onChange={e => onChange({ ...value, strategy: e.target.value as ProviderAggregateInput["strategy"] })}><option value="failover">故障切换</option><option value="roundRobin">请求轮询</option><option value="weightedRoundRobin">加权轮询</option></select></label>
      <p>目前仅支持 Chat Completions 成员。故障切换只会在上游明确返回 HTTP 429 且尚未向 Codex 返回响应时切换；网络超时及其他错误不会重放请求。</p>
      <div className="codex-aggregate-members">{providers.flatMap(provider => provider.keys.map(key => {
        const selected = value.members.find(member => member.providerId === provider.id && member.keyId === key.id);
        return <div key={provider.id + ":" + key.id}>
          <label><input type="checkbox" disabled={busy} checked={!!selected} onChange={e => toggle(provider, key.id, e.target.checked)} /><span>{provider.name} · {key.name}</span></label>
          {selected && <label>权重<input type="number" min={1} max={100} disabled={busy} value={selected.weight} onChange={e => onChange({ ...value, members: value.members.map(member => member.providerId === provider.id && member.keyId === key.id ? { ...member, weight: Number(e.target.value) } : member) })} /> </label>}
        </div>;
      }))}</div>
      <p>{value.members.length} 个成员</p>
      {error && <p role="alert" className="codex-card-error">{error}</p>}
    </div>
  </OverviewDialog>;
}
