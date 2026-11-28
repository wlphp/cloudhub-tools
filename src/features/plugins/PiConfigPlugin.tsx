import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpFromLine, Check, ChevronDown, Copy, FolderOpen, GripVertical, Pencil, Plus, RotateCcw, Search, Server, Star, Trash2, X } from "lucide-react";
import { runningInTauri, runningOnPhone } from "../../platform/api";
import { PI_APIS, PI_THINKING_LEVELS, piConfigAction, piModelCatalog, type PiApi, type PiConfigAction, type PiConfigBackup, type PiConfigState, type PiProviderInput, type PiProviderSummary, type PiThinkingLevel } from "../../platform/clients/piConfig";
import { SharedDialog } from "../../shared/SharedDialog";
import { SecretField } from "../../shared/SecretField";
import { SelectionCheckbox } from "../../shared/SortSelectionControls";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ToastNotice } from "../../shared/ToastNotice";
import { useDialogDocument } from "../../shared/DialogDocument";
import { useSortableDrag } from "../../shared/useSortableDrag";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import { PiProviderPresetPicker, type PiPresetSelection } from "./PiProviderPresetPicker";
import { backupDate, ConfigBackupHistoryDialog } from "./ConfigBackupHistoryDialog";
import { PiResourcePanel, piResourceTabs } from "./PiResourcePanel";
import type { PiResource } from "../../platform/clients/piConfig";
import "./claude-providers.css";

const nativeDesktop = runningInTauri && !runningOnPhone;
const previewState: PiConfigState = { agentDir: "", modelsFile: "", settingsFile: "", modelsExists: false, settingsExists: false, providers: [], backups: [] };
const transferFormat = "cloudhub-pi-providers";

function portableProvider(value: unknown): PiProviderInput {
  const provider = value as Partial<PiProviderInput> | null;
  if (!provider || typeof provider.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider.id.trim())
    || typeof provider.name !== "string" || !provider.name.trim() || typeof provider.baseUrl !== "string"
    || !provider.api || !PI_APIS.includes(provider.api) || !Array.isArray(provider.models) || !provider.models.length) {
    throw new Error("供应商必须包含有效的标识、名称、地址、协议和模型。");
  }
  const url = URL.canParse(provider.baseUrl) ? new URL(provider.baseUrl) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("供应商地址必须是无凭据、查询参数和片段的 HTTP(S) 地址。");
  }
  const models = provider.models.map(model => {
    if (!model || typeof model.id !== "string" || !model.id.trim()) throw new Error("供应商包含无效模型。");
    return { id: model.id.trim(), name: typeof model.name === "string" ? model.name : undefined,
      reasoning: model.reasoning === true, contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined };
  });
  return { id: provider.id.trim(), name: provider.name.trim(), baseUrl: provider.baseUrl.trim(), api: provider.api, models };
}

type Tab = "providers" | "commands" | "config" | PiResource;
type DraftModel = { id: string; name?: string | null; reasoning: boolean; contextWindow?: number | null; maxTokens?: number | null };
type Draft = { originalId?: string; id: string; name: string; baseUrl: string; api: PiApi; apiKey: string; keyKind?: PiProviderSummary["keyKind"]; models: DraftModel[] };

// 均摘自本机 Pi 文档 docs/slash-commands.md 与 docs/usage.md。
const piCommands = [
  { command: "pi", description: "在当前目录启动 Pi 交互会话" },
  { command: "/model", description: "选择模型，可写成 /model 供应商/模型（Ctrl+L 打开同一选择器）" },
  { command: "/thinking", description: "设置思考级别，如 /thinking high" },
  { command: "/scoped-models", description: "配置交互中 Ctrl+P 循环切换的模型" },
  { command: "/login", description: "添加供应商登录或 API Key" },
  { command: "/logout", description: "移除供应商登录" },
  { command: "/new", description: "开始新会话" },
  { command: "/resume", description: "恢复其他会话" },
  { command: "/session", description: "查看当前会话信息与统计" },
  { command: "/tree", description: "浏览会话树" },
  { command: "/fork", description: "从较早的用户消息分出新会话" },
  { command: "/clone", description: "在当前位置复制一份会话" },
  { command: "/compact", description: "压缩当前上下文，可附加压缩说明" },
  { command: "/copy", description: "复制上一条助手回复" },
  { command: "/export", description: "把会话导出为 HTML 或 JSONL" },
  { command: "/mcp", description: "管理 MCP 服务器：登录、重连、启用或停用" },
  { command: "/reload", description: "重新加载快捷键、扩展、技能、模板与主题" },
  { command: "/settings", description: "打开设置" },
  { command: "/hotkeys", description: "查看当前快捷键" },
  { command: "/quit", description: "退出 Pi" },
];

const apiLabels: Record<PiApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
  "bedrock-converse-stream": "Bedrock Converse",
  "mistral-conversations": "Mistral Conversations",
};
const keyLabels: Record<PiProviderSummary["keyKind"], string> = { none: "未配置密钥", env: "环境变量", command: "命令获取", literal: "已保存密钥" };
const emptyDraft = (): Draft => ({ id: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", models: [] });
const errorText = (cause: unknown) => typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "操作失败，请稍后重试";

/** 预设或导入的标识与已有供应商冲突时追加序号，避免保存时覆盖手写条目。 */
function uniqueId(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  let index = 2;
  while (taken.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

const draftFromSelection = (value: PiPresetSelection, taken: string[]): Draft => ({
  id: uniqueId(value.id, taken), name: value.name, baseUrl: value.baseUrl, api: value.api, apiKey: value.apiKey,
  models: value.models.map(id => ({ id, reasoning: false })),
});

export function PiConfigPlugin() {
  const [tab, setTab] = useState<Tab>("providers");
  const [state, setState] = useState<PiConfigState | null>(nativeDesktop ? null : previewState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone?: "info" | "error" } | null>(null);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PiProviderSummary[]>([]);
  const [backupHistoryOpen, setBackupHistoryOpen] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [previewConfig, setPreviewConfig] = useState(false);

  const run = useCallback(async (action: PiConfigAction, success?: string) => {
    if (!nativeDesktop) {
      setState(previous => {
        const next = previous ?? previewState;
        const asSummary = (provider: PiProviderInput): PiProviderSummary => ({
          id: provider.id, name: provider.name, baseUrl: provider.baseUrl, api: provider.api,
          keyKind: "none", models: provider.models.map(model => ({ ...model, reasoning: model.reasoning ?? false })),
        });
        switch (action.type) {
          case "import_providers": return { ...next, providers: [...next.providers, ...action.providers.map(asSummary)] };
          case "save": return { ...next, providers: [...next.providers.filter(item => item.id !== (action.provider.originalId ?? action.provider.id)), asSummary(action.provider)] };
          case "delete": return { ...next, providers: next.providers.filter(item => item.id !== action.id) };
          case "delete_providers": return { ...next, providers: next.providers.filter(item => !action.ids.includes(item.id)) };
          case "set_default": return { ...next, defaultProvider: action.provider, defaultModel: action.model, defaultThinkingLevel: action.thinking ?? next.defaultThinkingLevel };
          default: return next;
        }
      });
      if (success) setNotice({ message: `浏览器调试 · ${success}` });
      return true;
    }
    setBusy(true);
    try {
      const next = await piConfigAction(action);
      if (action.type !== "open_config_directory") setState(next);
      if (action.type === "state") setLoadError(null);
      if (success) setNotice({ message: success });
      return true;
    } catch (cause) {
      if (action.type === "state") setLoadError(errorText(cause));
      else setNotice({ message: errorText(cause), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void run({ type: "state" }); }, [run]);

  const takenIds = state?.providers.map(provider => provider.id) ?? [];
  const backups = state?.backups ?? [];
  const restoreTarget: PiConfigBackup | undefined = backups.find(backup => backup.id === restoreId);
  const tabs: { id: Tab; name: string }[] = [{ id: "providers", name: "供应商" }, { id: "commands", name: "常用命令" }, ...piResourceTabs, { id: "config", name: "配置文件" }];
  const resource = piResourceTabs.find(item => item.id === tab);

  async function importProviders(file: File) {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("供应商文件不能超过 2 MB。");
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error("无法读取供应商 JSON 文件。"); }
      if (parsed?.format !== transferFormat || parsed.version !== 1 || !Array.isArray(parsed.providers) || !parsed.providers.length) {
        throw new Error("请选择本页导出的 Pi 供应商 JSON 文件。");
      }
      const providers: PiProviderInput[] = parsed.providers.map(portableProvider);
      const ids = new Set(takenIds);
      for (const provider of providers) {
        if (ids.has(provider.id)) throw new Error("文件内或当前配置中有重复的供应商标识，请调整后重新导入。");
        ids.add(provider.id);
      }
      await run({ type: "import_providers", providers }, `已导入 ${providers.length} 个供应商`);
    } catch (cause) {
      setNotice({ message: errorText(cause), tone: "error" });
    }
  }

  function exportProviders(providers: PiProviderSummary[]) {
    try {
      const content = JSON.stringify({ format: transferFormat, version: 1, providers: providers.map(portableProvider) }, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "pi-providers.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setNotice({ message: errorText(cause), tone: "error" });
    }
  }

  return <div className="claude-providers claude-management-workbench pi-config">
    <div className="pi-tabs" role="tablist" aria-label="Pi 配置分区">
      {tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "pi-tab is-active" : "pi-tab"} onClick={() => setTab(item.id)}>{item.name}</button>)}
    </div>

    {tab !== "commands" && !nativeDesktop && <p className="claude-config-help" role="status">浏览器调试模式。更改仅用于当前页面预览。</p>}
    {tab !== "commands" && nativeDesktop && loadError && <p className="claude-error" role="alert">{loadError}</p>}

    {tab === "providers" && state && <>
      <div className="claude-status-bar claude-config-panel pi-config-source-bar">
        <div className="claude-config-source">
          <span><Server size={13} aria-hidden="true" /> 配置文件 <code>{state.modelsFile || "models.json"}</code></span>
          <button type="button" className="secondary" onClick={() => setPreviewConfig(true)}>预览配置</button>
        </div>
        <div className="claude-status-bar-actions">
          <button type="button" className="secondary" onClick={() => setBackupHistoryOpen(true)} disabled={busy}><RotateCcw size={13} aria-hidden="true" />历史备份（{backups.length}）</button>
          <button type="button" className="secondary" onClick={() => void run({ type: "open_config_directory" })} disabled={!nativeDesktop || busy}><FolderOpen size={13} aria-hidden="true" />打开配置目录</button>
        </div>
      </div>
      <ProvidersTab state={state} busy={busy}
      onRefresh={() => void run({ type: "state" }, "已刷新")}
      onImport={file => void importProviders(file)} onExport={exportProviders}
      onAdd={() => setPicking(true)}
      onEdit={provider => setDraft({ originalId: provider.id, id: provider.id, name: provider.name, baseUrl: provider.baseUrl ?? "", api: (PI_APIS as readonly string[]).includes(provider.api ?? "") ? provider.api as PiApi : "openai-completions", apiKey: "", keyKind: provider.keyKind, models: provider.models })}
      onDelete={setPendingDelete}
      onSetDefault={(provider, model, thinking) => run({ type: "set_default", provider, model, thinking }, `默认模型已设为 ${provider}/${model}`)} />
    </>}

    {tab === "commands" && <PiCommandsPanel onNotice={message => setNotice({ message })} />}
    {resource && <PiResourcePanel key={resource.id} resource={resource.id} title={resource.name} nativeDesktop={nativeDesktop}
      onOpenDirectory={() => void run({ type: "open_config_directory" })} />}

    {tab === "config" && nativeDesktop && state && <section className="pi-config-files" aria-label="Pi 配置文件">
      <dl>
        <dt>配置目录</dt><dd><code>{state.agentDir}</code></dd>
        <dt>models.json</dt><dd><code>{state.modelsFile}</code>{!state.modelsExists && <span className="pi-muted">（尚未创建）</span>}</dd>
        <dt>settings.json</dt><dd><code>{state.settingsFile}</code>{!state.settingsExists && <span className="pi-muted">（尚未创建）</span>}</dd>
      </dl>
      <div className="claude-providers-actions">
        <button type="button" className="secondary" onClick={() => void run({ type: "open_config_directory" })} disabled={busy}><FolderOpen size={14} aria-hidden="true" />打开配置目录</button>
        <button type="button" className="secondary" onClick={() => setBackupHistoryOpen(true)} disabled={busy}><RotateCcw size={14} aria-hidden="true" />历史备份（{backups.length}）</button>
      </div>
      <details className="pi-details">
        <summary>说明</summary>
        <p>修改现有文件前会保留该文件的版本，可在「历史备份」中按文件恢复。密钥以 Pi 原生格式写入本机文件，界面只显示密钥来源。</p>
      </details>
    </section>}

    {picking && <PiProviderPresetPicker onClose={() => setPicking(false)}
      onCustom={() => { setPicking(false); setDraft(emptyDraft()); }}
      onSelect={value => { setPicking(false); setDraft(draftFromSelection(value, takenIds)); }} />}

    {draft && <ProviderEditor initial={draft} busy={busy} onClose={() => setDraft(null)}
      onSave={async value => {
        const ok = await run({ type: "save", provider: {
          originalId: value.originalId, id: value.id.trim(), name: value.name.trim(), baseUrl: value.baseUrl.trim(), api: value.api,
          apiKey: value.apiKey.trim() || undefined,
          models: value.models.map(model => ({ id: model.id.trim(), name: model.name?.trim() || undefined, reasoning: model.reasoning, contextWindow: model.contextWindow ?? undefined, maxTokens: model.maxTokens ?? undefined })),
        } }, value.originalId ? "供应商已更新" : "供应商已添加");
        if (ok) setDraft(null);
      }} />}

    {previewConfig && state && <SharedDialog sizeStorageKey="features/plugins/pi-config-plugin/config-preview" title="Pi 配置预览"
      subtitle="供应商与模型摘要，密钥已省略。" onClose={() => setPreviewConfig(false)}
      footer={<button type="button" className="secondary" onClick={() => setPreviewConfig(false)}>关闭</button>}>
      <pre className="pi-config-preview">{JSON.stringify({
        defaultProvider: state.defaultProvider, defaultModel: state.defaultModel, defaultThinkingLevel: state.defaultThinkingLevel,
        providers: state.providers.map(({ id, name, api, models }) => ({ id, name, api, models })),
      }, null, 2)}</pre>
    </SharedDialog>}

    {pendingDelete.length > 0 && <ConfirmDialog title="删除 Pi 供应商" tone="danger" confirmLabel="删除" busy={busy}
      message={pendingDelete.length === 1 ? `确定删除供应商「${pendingDelete[0].name}」吗？` : `确定删除所选的 ${pendingDelete.length} 个供应商吗？`}
      detail="会从 models.json 移除供应商及其模型，删除前自动备份。"
      onResolve={async confirmed => {
        if (confirmed && !await run({ type: "delete_providers", ids: pendingDelete.map(provider => provider.id) }, "供应商已删除")) return;
        setPendingDelete([]);
      }} />}

    {backupHistoryOpen && <ConfigBackupHistoryDialog sizeStorageKey="features/plugins/pi-config-plugin/backup-history"
      title="Pi 配置备份历史" backups={backups} busy={busy} onClose={() => setBackupHistoryOpen(false)}
      onRestore={backup => setRestoreId(backup.id)} />}

    {restoreTarget && <ConfirmDialog title="恢复 Pi 配置备份" confirmLabel="恢复" busy={busy}
      message={`恢复 ${backupDate(restoreTarget)} 的 ${restoreTarget.file}？`}
      detail="恢复前会备份该文件的当前版本。"
      onResolve={async confirmed => {
        if (confirmed && !await run({ type: "restore_backup", id: restoreTarget.id }, "已恢复所选备份")) return;
        setRestoreId(null);
      }} />}

    {notice && <ToastNotice message={notice.message} tone={notice.tone} onDismiss={() => setNotice(null)} />}
  </div>;
}

function ProvidersTab({ state, busy, onRefresh, onAdd, onEdit, onDelete, onSetDefault, onImport, onExport }: {
  state: PiConfigState; busy: boolean; onRefresh: () => void;
  onAdd: () => void; onEdit: (provider: PiProviderSummary) => void; onDelete: (providers: PiProviderSummary[]) => void;
  onSetDefault: (provider: string, model: string, thinking?: PiThinkingLevel) => Promise<boolean>;
  onImport: (file: File) => void; onExport: (providers: PiProviderSummary[]) => void;
}) {
  const options = useMemo(() => state.providers.flatMap(provider => provider.models.map(model => `${provider.id}/${model.id}`)), [state.providers]);
  const current = state.defaultProvider && state.defaultModel ? `${state.defaultProvider}/${state.defaultModel}` : "";
  const [target, setTarget] = useState(current);
  const [thinking, setThinking] = useState<string>(state.defaultThinkingLevel ?? "");
  const [query, setQuery] = useState("");
  const orderKey = `cloudhub.pi.provider-order:${state.modelsFile || "preview"}`;
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(orderKey) ?? "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  });
  const [sort, setSort] = useState(manualOrder.length ? "manual" : "name");
  const [reordering, setReordering] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { setTarget(current); setThinking(state.defaultThinkingLevel ?? ""); }, [current, state.defaultThinkingLevel]);

  const keyword = query.trim().toLocaleLowerCase();
  const ranks = new Map(manualOrder.map((id, index) => [id, index]));
  const sorted = [...state.providers].sort((a, b) => {
    const name = a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
    if (sort === "manual") return (ranks.get(a.id) ?? ranks.size) - (ranks.get(b.id) ?? ranks.size) || name;
    if (sort === "models") return b.models.length - a.models.length || name;
    if (sort === "default") return Number(b.id === state.defaultProvider) - Number(a.id === state.defaultProvider) || name;
    return sort === "reverse" ? -name : name;
  });
  const shown = sorted.filter(provider => reordering || !keyword || [provider.name, provider.id, provider.baseUrl ?? "", ...provider.models.flatMap(model => [model.id, model.name])]
    .join(" ").toLocaleLowerCase().includes(keyword));
  const selected = sorted.filter(provider => selection.has(provider.id));
  const allShownSelected = shown.length > 0 && shown.every(provider => selection.has(provider.id));
  const drag = useSortableDrag({
    selector: "[data-pi-provider-sort-id]", attribute: "data-pi-provider-sort-id",
    enabled: reordering && !busy, onMove: moveProvider,
  });

  function moveProvider(source: string, target: string) {
    const ids = sorted.map(provider => provider.id);
    const from = ids.indexOf(source);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, source);
    setManualOrder(ids);
    try { localStorage.setItem(orderKey, JSON.stringify(ids)); } catch { /* Keep the order for this session. */ }
  }

  function updateSelection(ids: string[], checked: boolean) {
    setSelection(previous => {
      const next = new Set(previous);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  }

  useEffect(() => {
    const ids = new Set(state.providers.map(provider => provider.id));
    setSelection(previous => new Set([...previous].filter(id => ids.has(id))));
  }, [state.providers]);

  function applyDefault(value = target, level = thinking) {
    const index = value.indexOf("/");
    if (index <= 0) return;
    void onSetDefault(value.slice(0, index), value.slice(index + 1), (level || undefined) as PiThinkingLevel | undefined);
  }

  return <section className="pi-providers-tab" aria-label="Pi 供应商">
    <div className="pi-default-bar">
      <label htmlFor="pi-default-model">默认模型</label>
      <select id="pi-default-model" value={target} onChange={event => setTarget(event.target.value)} disabled={busy || !options.length}>
        {!target && <option value="">{options.length ? "请选择" : "暂无可用模型"}</option>}
        {target && !options.includes(target) && <option value={target}>{target}（非云枢管理）</option>}
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      <label htmlFor="pi-default-thinking">思考级别</label>
      <select id="pi-default-thinking" value={thinking} onChange={event => setThinking(event.target.value)} disabled={busy}>
        <option value="">保持不变</option>
        {PI_THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
      <button type="button" className="secondary" onClick={() => applyDefault()} disabled={busy || !target || (target === current && thinking === (state.defaultThinkingLevel ?? ""))}><Check size={14} aria-hidden="true" />应用</button>
    </div>

    <header className="claude-providers-head claude-list-toolbar pi-provider-toolbar">
      {!reordering && <label className="claude-check">
        <input type="checkbox" checked={allShownSelected} disabled={busy || !shown.length}
          ref={element => { if (element) element.indeterminate = !allShownSelected && shown.some(provider => selection.has(provider.id)); }}
          onChange={event => updateSelection(shown.map(provider => provider.id), event.target.checked)} />
        全选当前结果
      </label>}
      {!reordering && <label className="claude-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索供应商" placeholder="搜索供应商、地址或模型" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      {reordering && <span className="pi-muted">拖动左侧手柄，或使用上下箭头调整顺序。</span>}
      <div className="claude-providers-actions">
      <select aria-label="供应商排序方式" value={sort} disabled={reordering} onChange={event => setSort(event.target.value)}>
        <option value="manual">手动顺序</option>
        <option value="name">名称升序</option><option value="reverse">名称降序</option>
        <option value="models">模型最多</option><option value="default">默认优先</option>
      </select>
        <button type="button" className={`secondary sort-mode-button${reordering ? " is-sorting" : ""}`} aria-pressed={reordering}
          disabled={busy || (!reordering && sorted.length < 2)} onClick={() => {
            if (!reordering) setSort("manual");
            setReordering(!reordering);
          }}><GripVertical size={14} aria-hidden="true" />{reordering ? "完成排序" : "拖拽排序"}</button>
        <input id="pi-provider-import" type="file" accept=".json,application/json" hidden disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onImport(file);
        }} />
        {!reordering && <>
        <button type="button" className="secondary" onClick={onRefresh} disabled={busy}><RotateCcw size={14} aria-hidden="true" />刷新</button>
        <button type="button" className="secondary" onClick={() => document.getElementById("pi-provider-import")?.click()} disabled={busy}><ArrowUpFromLine size={14} aria-hidden="true" />导入 JSON</button>
        <button type="button" className="primary" onClick={onAdd} disabled={busy}><Plus size={14} aria-hidden="true" />添加供应商</button>
        <button type="button" className="secondary" title="导出所选供应商（不含密钥）" onClick={() => onExport(selected)} disabled={busy || !selected.length}><ArrowDownToLine size={14} aria-hidden="true" />导出所选</button>
        <button type="button" className="secondary" title={selected.some(provider => provider.id === state.defaultProvider) ? "请先取消选择默认供应商或切换默认模型" : undefined}
          onClick={() => onDelete(selected)} disabled={busy || !selected.length || selected.some(provider => provider.id === state.defaultProvider)}>删除所选</button>
        </>}
        <span className="pi-muted" role="status">{shown.length} 个供应商{!reordering && selected.length > 0 && ` · 已选 ${selected.length}`}</span>
      </div>
    </header>

    {shown.length ? <ul className="claude-provider-list">
      {shown.map((provider, index) => {
        const isDefault = state.defaultProvider === provider.id;
        const open = expanded.has(provider.id);
        const firstModel = provider.models[0];
        const checked = selection.has(provider.id);
        return <li key={provider.id} data-pi-provider-sort-id={provider.id} className={`claude-provider-item pi-provider-card${isDefault ? " is-current" : ""}${checked && !reordering ? " is-selected" : ""}`}>
          {reordering ? <button type="button" className="claude-provider-drag-handle" disabled={busy}
            aria-label={`调整 ${provider.name} 的顺序`} title="拖动排序，也可使用上、下方向键"
            onPointerDown={event => drag.startDrag(event, provider.id)} onKeyDown={event => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const target = shown[index + (event.key === "ArrowUp" ? -1 : 1)];
              if (target) moveProvider(provider.id, target.id);
            }}><GripVertical size={16} aria-hidden="true" /></button>
          : <input type="checkbox" className="claude-provider-select" aria-label={`选择 ${provider.name}`} checked={checked} disabled={busy}
            onChange={event => updateSelection([provider.id], event.target.checked)} />}
          <div className="claude-provider-main">
            <div className="claude-provider-title">
              <ProviderBrandIcon
                name={provider.name}
                hints={[provider.id, provider.baseUrl ?? undefined, ...provider.models.map(m => m.id)]}
                fallback={provider.name.trim().slice(0, 1).toUpperCase()}
                className="is-small claude-provider-brand-logo"
              />
              <strong>{provider.name}</strong>
              {firstModel && <button type="button" className="claude-model-toggle" aria-expanded={open} aria-controls={`pi-models-${provider.id}`}
                onClick={() => setExpanded(previous => {
                  const next = new Set(previous);
                  if (open) next.delete(provider.id);
                  else next.add(provider.id);
                  return next;
                })}><ChevronDown size={13} aria-hidden="true" /> 模型 · {provider.models.length}</button>}
              {isDefault && <span className="claude-tag is-current">当前配置</span>}
              {provider.keyKind === "none" && <span className="claude-tag is-warning">未配置密钥</span>}
            </div>
            <code className="claude-provider-url" title={provider.baseUrl ?? undefined}>{provider.baseUrl || "内置地址"}</code>
            <div className="claude-provider-meta">
              <span>{provider.api ? apiLabels[provider.api as PiApi] ?? provider.api : "未指定协议"}</span>
              {provider.keyKind !== "none" && <span>{keyLabels[provider.keyKind]}{provider.keyReference ? ` · ${provider.keyReference}` : ""}</span>}
            </div>
            {firstModel && <div id={`pi-models-${provider.id}`} className="claude-model-mappings" hidden={!open}>
              {provider.models.map(model => {
                const value = `${provider.id}/${model.id}`;
                const chipDefault = value === current;
                return <button key={model.id} type="button" className={chipDefault ? "pi-chip is-default" : "pi-chip"} disabled={busy || chipDefault}
                  title={chipDefault ? "当前默认模型" : "设为默认模型"} onClick={() => applyDefault(value, "")}>
                  {chipDefault && <Star size={12} aria-hidden="true" />}{model.name || model.id}{model.reasoning && <span className="pi-muted"> · 推理</span>}
                </button>;
              })}
            </div>}
          </div>
          <div className="claude-provider-actions">
            {reordering ? <>
              <button type="button" className="secondary claude-icon-button" aria-label={`上移 ${provider.name}`} disabled={busy || index === 0}
                onClick={() => moveProvider(provider.id, shown[index - 1].id)}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="secondary claude-icon-button" aria-label={`下移 ${provider.name}`} disabled={busy || index === shown.length - 1}
                onClick={() => moveProvider(provider.id, shown[index + 1].id)}><ArrowDown size={14} aria-hidden="true" /></button>
            </> : <>
            <button type="button" className={isDefault ? "secondary pi-default-provider is-current" : "secondary pi-default-provider"}
              aria-label={isDefault ? `${provider.name} 已是默认供应商` : `将 ${provider.name} 设为默认`}
              aria-pressed={isDefault}
              title={firstModel ? `将 ${firstModel.name || firstModel.id} 设为默认模型` : "供应商暂无模型"}
              disabled={busy || isDefault || !firstModel} onClick={() => { if (firstModel) applyDefault(`${provider.id}/${firstModel.id}`, ""); }}>
              {isDefault ? <><Check size={13} aria-hidden="true" />默认中</> : "设为默认"}
            </button>
            <button type="button" className="secondary claude-icon-button" aria-label={`编辑 ${provider.name}`} title="编辑" onClick={() => onEdit(provider)} disabled={busy}><Pencil size={14} aria-hidden="true" /></button>
            <button type="button" className="secondary claude-icon-button is-danger" aria-label={`删除 ${provider.name}`} title={isDefault ? "请先切换默认模型" : "删除"} onClick={() => onDelete([provider])} disabled={busy || isDefault}><Trash2 size={14} aria-hidden="true" /></button>
            </>}
          </div>
        </li>;
      })}
    </ul> : <p className="claude-empty-line">{busy ? "正在读取供应商…" : keyword ? "没有符合条件的供应商" : "还没有自定义供应商，点击「添加供应商」从厂商预设或模型供应商快速创建。"}</p>}
  </section>;
}

function validate(draft: Draft): string | null {
  if (!draft.name.trim()) return "请填写供应商名称";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(draft.id.trim())) return "供应商标识仅支持字母、数字、点、下划线和连字符，最长 64 位";
  const url = draft.baseUrl.trim();
  if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol)) return "请求地址须为 http(s) 地址";
  const ids = draft.models.map(model => model.id.trim());
  if (!ids.length || ids.some(id => !id)) return "请至少填写一个模型 ID，并删除空行";
  if (new Set(ids).size !== ids.length) return "模型 ID 不能重复";
  return null;
}

function ProviderEditor({ initial, busy, onClose, onSave }: { initial: Draft; busy: boolean; onClose: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const editing = Boolean(initial.originalId);
  const catalogSupported = value.api !== "bedrock-converse-stream";
  const update = (patch: Partial<Draft>) => setValue(current => ({ ...current, ...patch }));
  const updateModel = (index: number, patch: Partial<DraftModel>) => setValue(current => ({ ...current, models: current.models.map((model, i) => i === index ? { ...model, ...patch } : model) }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || catalogBusy) return;
    const problem = validate(value);
    setError(problem);
    if (!problem) await onSave(value);
  }

  async function loadCatalog() {
    if (!nativeDesktop) {
      setCatalogError("请在桌面客户端获取模型列表，当前可手动添加模型。");
      return;
    }
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const models = await piModelCatalog({ provider: initial.originalId, baseUrl: value.baseUrl.trim(), api: value.api, apiKey: value.apiKey.trim() || undefined });
      const existing = new Set(value.models.map(model => model.id.trim()));
      if (models.length) {
        setSelectedModels(models.filter(id => existing.has(id)));
        setCatalog(models);
      } else {
        setCatalogError("上游未返回模型，请手动添加。");
      }
    } catch (cause) {
      setCatalogError(errorText(cause));
    } finally {
      setCatalogBusy(false);
    }
  }

  const keyPlaceholder = editing && value.keyKind && value.keyKind !== "none"
    ? `留空保留现有密钥（${keyLabels[value.keyKind]}）`
    : initial.apiKey ? "已从模型供应商导入" : "本机模型可留空";

  return <><SharedDialog sizeStorageKey="features/plugins/pi-config-plugin/editor"
    title={editing ? `编辑供应商 · ${initial.name || initial.id}` : "添加 Pi 供应商"}
    subtitle="Pi 供应商配置：请求地址、API Key 和渠道可用模型"
    icon={<Server size={20} aria-hidden="true" />}
    className="claude-provider-dialog pi-editor"
    bodyClassName="claude-provider-body"
    initialFocus="#pi-name"
    closeLabel="关闭供应商编辑"
    busy={busy}
    onClose={onClose}
    onSubmit={submit}
    noValidate
    footer={<>
      <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
      <button type="submit" className="primary" disabled={busy || catalogBusy}><Check size={14} aria-hidden="true" />保存</button>
    </>}>
    <div className="claude-field-row">
      <label className="claude-field">供应商名称
        <input id="pi-name" value={value.name} maxLength={80} onChange={event => update({ name: event.target.value })} autoComplete="off" placeholder="例如：公司专用账号" />
      </label>
      <label className="claude-field">供应商标识
        <input value={value.id} maxLength={64} onChange={event => update({ id: event.target.value })} autoComplete="off" spellCheck={false} placeholder="用于 /model 标识/模型" />
      </label>
    </div>
    <label className="claude-field">请求地址
      <input value={value.baseUrl} disabled={catalogBusy} onChange={event => update({ baseUrl: event.target.value })} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" />
    </label>
    <label className="claude-field">API Key
      <SecretField secretLabel="API Key" value={value.apiKey} disabled={catalogBusy} onChange={event => update({ apiKey: event.target.value })} autoComplete="off" spellCheck={false} placeholder={keyPlaceholder} />
    </label>
    <label className="claude-field">上游协议格式
      <select id="pi-api" value={value.api} disabled={catalogBusy} onChange={event => update({ api: event.target.value as PiApi })}>
        {PI_APIS.map(api => <option key={api} value={api}>{apiLabels[api]}</option>)}
      </select>
    </label>

    <fieldset className="claude-models pi-editor-models">
      <legend>渠道可用模型 <span className="pi-model-count">{value.models.length}</span></legend>
      <div className="claude-models-toolbar pi-models-toolbar">
        <button type="button" className="secondary pi-fetch-models" onClick={() => void loadCatalog()}
          disabled={busy || catalogBusy || !catalogSupported || !value.baseUrl.trim()}
          title={!catalogSupported ? "该协议请手动添加模型" : undefined}>
          <ArrowDownToLine size={13} aria-hidden="true" />{catalogBusy ? "正在获取…" : "获取模型列表"}
        </button>
        {value.models.length > 0 && (
          <label className="claude-check" style={{ marginLeft: "auto" }}>
            <SelectionCheckbox
              label="全选推理模型"
              checked={value.models.every(model => model.reasoning)}
              mixed={value.models.some(model => model.reasoning) && !value.models.every(model => model.reasoning)}
              disabled={busy}
              onChange={() => {
                const nextReasoning = !value.models.every(model => model.reasoning);
                setValue(current => ({ ...current, models: current.models.map(model => ({ ...model, reasoning: nextReasoning })) }));
              }}
            />
            全选推理模型
          </label>
        )}
        {catalogError && <span className="claude-models-toolbar-message" role="status">{catalogError}</span>}
      </div>
      <div className="pi-model-list" role="list" aria-label="渠道可用模型列表">
      {value.models.map((model, index) => <div className="pi-model-row" role="listitem" key={index}>
        <input aria-label={`模型 ${index + 1} ID`} value={model.id} onChange={event => updateModel(index, { id: event.target.value })} autoComplete="off" spellCheck={false} placeholder="模型 ID" />
        <input aria-label={`模型 ${index + 1} 显示名称`} value={model.name ?? ""} onChange={event => updateModel(index, { name: event.target.value })} maxLength={120} autoComplete="off" placeholder="显示名称（可选）" />
        <label className="claude-check"><input type="checkbox" checked={model.reasoning} onChange={event => updateModel(index, { reasoning: event.target.checked })} />推理模型</label>
        <button type="button" className="secondary claude-icon-button" aria-label={`移除模型 ${index + 1}`} onClick={() => setValue(current => ({ ...current, models: current.models.filter((_, i) => i !== index) }))} disabled={busy}><X size={14} aria-hidden="true" /></button>
      </div>)}
      </div>
      <button type="button" className="secondary pi-add-model" disabled={busy || value.models.length >= 200} onClick={() => setValue(current => ({ ...current, models: [...current.models, { id: "", reasoning: false }] }))}><Plus size={14} aria-hidden="true" />手动添加模型</button>
    </fieldset>
    {error && <p className="claude-error" role="alert">{error}</p>}
  </SharedDialog>
  {catalog && (() => {
    const catalogSet = new Set(catalog);
    const manualCount = value.models.filter(model => model.id.trim() && !catalogSet.has(model.id.trim())).length;
    const remaining = Math.max(0, 200 - manualCount);
    return <SharedDialog sizeStorageKey="features/plugins/pi-config-plugin/model-catalog" size="small"
      title="选择渠道模型" className="pi-catalog-dialog" initialFocus="[type=search]" onClose={() => setCatalog(null)}
      footer={<>
        <button type="button" className="secondary" onClick={() => setCatalog(null)}>取消</button>
        <button type="button" className="primary" disabled={selectedModels.length > remaining}
          onClick={() => {
            setValue(current => {
              const selectedSet = new Set(selectedModels);
              const kept = current.models.filter(model => {
                const id = model.id.trim();
                return id && (!catalogSet.has(id) || selectedSet.has(id));
              });
              const keptIds = new Set(kept.map(model => model.id.trim()));
              const additions = selectedModels.filter(id => !keptIds.has(id)).map(id => ({ id, reasoning: false }));
              return { ...current, models: [...kept, ...additions] };
            });
            setCatalog(null);
          }}>确认选择（{selectedModels.length}）</button>
      </>}>
      <PiCatalogList catalog={catalog} selected={selectedModels} onChange={setSelectedModels}
        remaining={remaining} />
    </SharedDialog>;
  })()}</>;
}

function PiCatalogList({ catalog, selected, onChange, remaining }: {
  catalog: string[]; selected: string[]; onChange: (ids: string[]) => void; remaining: number;
}) {
  const [query, setQuery] = useState("");
  const shown = catalog.filter(id => id.toLowerCase().includes(query.trim().toLowerCase()));
  const selection = new Set(selected);
  const selectedVisible = shown.filter(id => selection.has(id)).length;
  const allVisible = shown.length > 0 && selectedVisible === shown.length;
  return <section className="pi-catalog" aria-label="渠道模型">
    <div className="pi-catalog-toolbar">
      <label className="claude-search pi-catalog-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label="搜索渠道模型" placeholder="搜索模型 ID" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <button type="button" className="secondary" disabled={!selected.length} onClick={() => onChange([])}>清空选择</button>
    </div>
    <div className="pi-catalog-results">
      <div className="pi-catalog-heading">
        <label className="claude-check">
          <SelectionCheckbox label="全选当前结果" checked={allVisible} mixed={selectedVisible > 0 && !allVisible}
            disabled={!shown.length} onChange={() => {
              for (const id of shown) {
                if (allVisible) selection.delete(id);
                else selection.add(id);
              }
              onChange([...selection]);
            }} />
          全选当前结果
        </label>
        <span role="status">{shown.length} 个结果 · 已选 {selected.length}</span>
      </div>
      {!!shown.length && <ul className="claude-picker-list pi-catalog-list">
        {shown.map(id => <li key={id} className={`claude-picker-item${selection.has(id) ? " is-selected" : ""}`}>
          <label className="claude-check">
            <input type="checkbox" checked={selection.has(id)} onChange={event => {
              if (event.target.checked) selection.add(id);
              else selection.delete(id);
              onChange([...selection]);
            }} />
            <span className="claude-picker-item-body"><code>{id}</code></span>
          </label>
        </li>)}
      </ul>}
      {!shown.length && <p className="claude-picker-empty">没有匹配的模型，请换一个关键词。</p>}
    </div>
    {selected.length > remaining && <p className="claude-error" role="alert">当前供应商最多还能添加 {remaining} 个模型，请减少选择。</p>}
  </section>;
}

function PiCommandsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const document = useDialogDocument();
  async function copyCommand(command: string) {
    try {
      await document.defaultView!.navigator.clipboard.writeText(command);
      onNotice(`已复制 ${command}`);
    } catch {
      onNotice(`复制 ${command} 失败，请选中命令文本手动复制。`);
    }
  }
  return <section aria-label="Pi 常用命令">
    <ul className="claude-cli-commands pi-cli-commands">
      {piCommands.map(({ command, description }) => <li key={command}>
        <code>{command}</code>
        <span>{description}</span>
        <button type="button" className="secondary" aria-label={`复制 ${command}`} onClick={() => void copyCommand(command)}><Copy size={13} aria-hidden="true" />复制</button>
      </li>)}
    </ul>
  </section>;
}
