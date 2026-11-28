import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowDown, Download, Eye, EyeOff, FolderOpen, GripVertical, Layers, Pencil, Plug, Plus, RotateCcw, Route, Search, Server, Settings2, Trash2 } from "lucide-react";
import { runningInTauri, runningOnPhone } from "../../platform/api";
import { claudeDesktopAction, diagnoseClaudeDesktopConnection, getClaudeDesktopRoutingState, initialDesktopSelection, revealClaudeDesktopConfigKey, type ClaudeDesktopState, type DesktopAction, type DesktopConfigFile, type DesktopConnectionDiagnosis, type DesktopProvider, type DesktopSelection } from "../../platform/clients/claudeDesktop";
import { claudeProvidersClient, DEFAULT_CLAUDE_ROUTING, type ClaudeMode, type ClaudeProviderInput, type ClaudeRoutingState } from "../../platform/clients/claudeProviders";
import { SharedDialog } from "../../shared/SharedDialog";
import { HelpTooltip } from "../../shared/HelpTooltip";
import { SortSelectionControls } from "../../shared/SortSelectionControls";
import { useSortableDrag } from "../../shared/useSortableDrag";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import { ClaudeProviderPresetPicker } from "./ClaudeProviderPresetPicker";
import { ClaudeRoutingGraph } from "./ClaudeRoutingGraph";
import { ClaudeRoutingLiveFeed } from "./ClaudeRoutingLiveFeed";
import { RoutingSettings, UsagePanel } from "./ClaudeRoutingPanels";
import { Editor } from "./ClaudeProvidersPlugin";
import "./claude-providers.css";

const nativeDesktop = runningInTauri && !runningOnPhone;
const emptySelection: ReadonlySet<string> = new Set();
const modes = [
  { id: "direct", name: "直连", icon: Plug },
  { id: "route", name: "路由", icon: Route },
  { id: "aggregate", name: "聚合", icon: Layers },
] as const;
const nameOf = (mode: ClaudeMode) => modes.find(item => item.id === mode)?.name;
const previewProvider: DesktopProvider = {
  id: "preview-anthropic",
  name: "示例供应商",
  baseUrl: "https://example.invalid",
  apiFormat: "anthropic",
  modelCatalog: [{ model: "claude-sonnet-4-6", displayName: "Sonnet" }],
  keyConfigured: false,
};
const emptyState: ClaudeDesktopState = {
  selection: initialDesktopSelection,
  applied: !nativeDesktop,
  running: false,
  providers: nativeDesktop ? [] : [previewProvider],
  configFiles: [],
  gatewayConfig: { ...DEFAULT_CLAUDE_ROUTING, port: 15722 },
};
const configStatus = { readable: "可读取", missing: "文件不存在", unreadable: "无法读取或解析" };
const configFileRoles = [
  { title: "Claude 主配置", description: "记录启动时使用官方登录（1p）还是第三方配置（3p）。" },
  { title: "Claude-3p 主配置", description: "第三方运行目录也记录同一个部署模式。应用时 CloudHub 会同步这两个入口。" },
  { title: "第三方配置索引", description: "登记可用的第三方方案，并通过 appliedId 指向当前选中的方案。" },
  { title: "CloudHub 连接方案", description: "模型列表写在此文件的 inferenceModels 字段中。要修改源模型列表，请在供应商列表点编辑，打开「渠道可用模型」。" },
];

function modelsOf(provider: DesktopProvider) {
  const models = provider.modelCatalog?.length ? provider.modelCatalog : Object.values(provider.models ?? {});
  return [...new Map(models.map(model => [model.model.replace(/\[1m\]$/i, ""), model])).values()];
}

function directRequirement(provider: DesktopProvider) {
  if (provider.officialLogin) return null;
  if ((provider.apiFormat ?? "anthropic") !== "anthropic" || provider.isFullUrl
    || !URL.canParse(provider.baseUrl ?? "") || new URL(provider.baseUrl ?? "").protocol !== "https:") {
    return { label: "需要路由", reason: "直连要求 HTTPS Anthropic Messages 基础地址。请在「路由」中启用此供应商。" };
  }
  const models = modelsOf(provider);
  if (!models.length || models.length > 200) {
    return { label: "需要配置模型", reason: "直连需要配置 1 至 200 个兼容模型。" };
  }
  if (models.some(({ model }) => !/^claude-(sonnet|opus|haiku|fable)-/.test(model))) {
    return { label: "需要路由", reason: "模型 ID 不兼容 Claude Desktop 直连。请在「路由」中启用此供应商。" };
  }
  return null;
}

function previewAction(state: ClaudeDesktopState, action: DesktopAction): ClaudeDesktopState {
  switch (action.type) {
    case "save_gateway_settings": return { ...state, gatewayConfig: { ...state.gatewayConfig, ...action.settings } };
    case "apply": return { ...state, applied: true, selection: action.selection };
    case "delete": return {
      ...state,
      selection: selectionAfterDelete(state.selection, action.id),
      providers: state.providers.filter(p => p.id !== action.id),
    };
    case "save": {
      const { apiKey, ...draft } = action.provider;
      const provider = { ...draft, keyConfigured: false };
      const exists = state.providers.some(p => p.id === provider.id);
      return { ...state, providers: exists ? state.providers.map(p => p.id === provider.id ? provider : p) : [...state.providers, provider] };
    }
    case "import":
      return state.providers.some(p => p.id === "preview-import") ? state : {
        ...state, providers: [...state.providers, { ...previewProvider, id: "preview-import", name: "Claude Code 导入示例" }],
      };
    default: return state;
  }
}

function selectionAfterDelete(selection: DesktopSelection, id: string): DesktopSelection {
  const members = selection.members.filter(member => member !== id);
  if (selection.provider !== id) return { ...selection, members };
  const [provider, ...remaining] = members;
  return provider ? { ...selection, provider, members: remaining } : initialDesktopSelection;
}

function usesProvider(selection: DesktopSelection, id: string) {
  return selection.provider === id || selection.members.includes(id);
}

function ConfigFilePreview({ preview }: { preview: NonNullable<DesktopConfigFile["preview"]> }) {
  const [key, setKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);

  async function reveal() {
    const current = ++request.current;
    setLoading(true);
    setError(false);
    try {
      const value = await revealClaudeDesktopConfigKey();
      if (current === request.current) setKey(value);
    } catch {
      if (current === request.current) setError(true);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }

  return <details onToggle={event => {
    if (event.currentTarget.open) return;
    request.current++;
    setKey(null);
    setLoading(false);
    setError(false);
  }}>
    <summary>预览配置</summary>
    {nativeDesktop && preview.inferenceGatewayApiKey === "[已隐藏]" && <span className="claude-status-bar-actions">
      <button type="button" className="secondary" disabled={loading} onClick={() => key === null ? void reveal() : setKey(null)}>
        {key === null ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
        {loading ? "正在读取…" : key === null ? "显示密钥" : "隐藏密钥"}
      </button>
    </span>}
    {error && <p className="claude-error" role="alert">无法读取连接方案密钥，请刷新配置后重试。</p>}
    <pre className="claude-config-preview">{JSON.stringify(key === null ? preview : { ...preview, inferenceGatewayApiKey: key }, null, 2)}</pre>
  </details>;
}

const diagnosisLabels: Record<DesktopConnectionDiagnosis["probe"], string> = {
  official: "官方登录由 Claude Desktop 管理。",
  config_mismatch: "磁盘配置与 CloudHub 选择不一致。请检查配置概览，必要时重新应用。",
  gateway_stopped: "本机网关未运行，请启动网关后重试。",
  models_available: "本机网关认证及模型发现通过。",
  models_unavailable: "本机网关的模型发现请求失败。",
  tcp_available: "直连供应商的 TCP 端口可达。",
  tcp_unavailable: "无法连到直连供应商的 TCP 端口。",
};

function DesktopDiagnostics({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<DesktopConnectionDiagnosis | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);

  async function check() {
    setRunning(true);
    setFailed(false);
    setReport(null);
    try { setReport(await diagnoseClaudeDesktopConnection()); }
    catch { setFailed(true); }
    finally { setRunning(false); }
  }

  return <SharedDialog title="Claude Desktop 连接诊断" size="small" onClose={onClose} footer={<>
    <button type="button" className="secondary" onClick={onClose}>关闭</button>
    <button type="button" className="primary" disabled={running || !nativeDesktop} onClick={() => void check()}>{running ? "正在检测…" : report || failed ? "重新检测" : "开始检测"}</button>
  </>}>
    <p>检查磁盘上的部署模式、当前方案与模型清单。直连检测供应商的 TCP 可达性，路由与聚合检测本机网关的模型发现。</p>
    <p className="claude-config-help">诊断只检查连接与配置，不发送模型推理请求。</p>
    {!nativeDesktop && <p>浏览器预览无法读取本机文件或探测 Claude Desktop 网关。</p>}
    {failed && <p className="claude-error" role="alert">连接诊断未能完成，请检查本机配置后重试。</p>}
    {report && <div role="status">
      <p><strong>{diagnosisLabels[report.probe]}</strong>{report.probe !== "official" && ` · ${report.durationMs} ms`}</p>
      <ul>
        <li>CloudHub 已应用配置：{report.applied ? nameOf(report.mode) : "尚未应用"}</li>
        <li>Claude 主配置：{report.normalModeMatches ? "部署模式匹配" : "未找到匹配的部署模式"}</li>
        <li>Claude-3p 主配置：{report.thirdPartyModeMatches ? "部署模式匹配" : "未找到匹配的部署模式"}</li>
        <li>配置索引：{report.profileSelected ? "已选中 CloudHub 方案" : "未选中 CloudHub 方案"}</li>
        <li>方案文件模型数：{report.modelCount}</li>
      </ul>
    </div>}
  </SharedDialog>;
}

export function ClaudeDesktopPlugin() {
  const [state, setState] = useState(emptyState);
  const [view, setView] = useState<ClaudeMode>("direct");
  const [query, setQuery] = useState("");
  const [sorting, setSorting] = useState(false);
  const [showConfigDescription, setShowConfigDescription] = useState(false);
  const [configOverview, setConfigOverview] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [routing, setRouting] = useState<ClaudeRoutingState | null>(null);
  const [routingUnavailable, setRoutingUnavailable] = useState(false);
  const configDescriptionId = useId();
  const [busy, setBusy] = useState(nativeDesktop);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [presets, setPresets] = useState(false);
  const [editing, setEditing] = useState<ClaudeProviderInput | null>(null);
  const [pending, setPending] = useState<DesktopSelection | null>(null);
  const [remove, setRemove] = useState<DesktopProvider | null>(null);
  const [importOptions, setImportOptions] = useState<DesktopProvider[] | null>(null);
  const [importIds, setImportIds] = useState<string[]>([]);
  useEffect(() => {
    if (!nativeDesktop) return;
    let disposed = false;
    claudeDesktopAction({ type: "state" }).then(data => {
      if (!disposed) { setState(data); setView(data.selection.mode); }
    }).catch(reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "读取 Claude Desktop 设置失败");
    }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  const showRouting = view !== "direct";
  useEffect(() => {
    if (!nativeDesktop || !showRouting) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await getClaudeDesktopRoutingState();
        if (!disposed) { setRouting(next); setRoutingUnavailable(false); }
      } catch {
        if (!disposed) { setRouting(null); setRoutingUnavailable(true); }
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [showRouting]);

  async function perform(action: DesktopAction) {
    if (nativeDesktop) setState(await claudeDesktopAction(action));
    else setState(previous => previewAction(previous, action));
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await task(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Claude Desktop 操作失败"); }
    finally { setBusy(false); }
  }

  const official: DesktopProvider = { id: "", name: "Claude Desktop 官方登录", officialLogin: true, keyConfigured: false };
  const list = view === "direct" ? [official, ...state.providers] : state.providers;
  const keyword = query.trim().toLocaleLowerCase();
  const shown = list.filter(p => [p.name, p.baseUrl, p.websiteUrl].some(value => value?.toLocaleLowerCase().includes(keyword)));
  const sortableIds = shown.filter(provider => !provider.officialLogin).map(provider => provider.id);
  const canSort = sorting && !busy && sortableIds.length >= 2;
  const providerDrag = useSortableDrag({
    selector: "[data-claude-desktop-sort-id]",
    attribute: "data-claude-desktop-sort-id",
    enabled: canSort,
    onMove: moveProvider,
  });

  function moveProvider(source: string, target: string) {
    if (!canSort || source === target) return;
    const from = sortableIds.indexOf(source);
    const to = sortableIds.indexOf(target);
    if (from < 0 || to < 0) return;
    const reordered = [...sortableIds];
    reordered.splice(from, 1);
    reordered.splice(to, 0, source);
    const visible = new Set(sortableIds);
    const previous = state.providers;
    const byId = new Map(previous.map(provider => [provider.id, provider]));
    let slot = 0;
    const providers = previous.map(provider => visible.has(provider.id) ? byId.get(reordered[slot++])! : provider);
    setState(current => ({ ...current, providers }));
    void run(async () => {
      try {
        if (nativeDesktop) await perform({ type: "reorder", ids: providers.map(provider => provider.id) });
        setNotice(nativeDesktop ? "供应商顺序已保存" : "已调整预览中的供应商顺序");
      } catch (reason) {
        setState(current => ({ ...current, providers: previous }));
        throw reason;
      }
    });
  }
  const activeName = state.providers.find(p => p.id === state.selection.provider)?.name ?? official.name;
  const configFile = state.configFiles[state.selection.provider ? 1 : 0];
  const routingProviders = useMemo(() => state.providers.map(provider => ({ ...provider, isCurrent: false, keyDecryptionFailed: false })), [state.providers]);
  const routeState: ClaudeRoutingState = routing ?? {
    mode: state.selection.mode, running: false, address: null,
    config: { ...state.gatewayConfig,
      routeProvider: state.selection.mode === "route" ? state.selection.provider : "",
      defaultProvider: state.selection.mode === "aggregate" ? state.selection.provider : "",
      members: state.selection.mode === "aggregate" ? state.selection.members : [] },
    health: {}, logs: [], activeRequests: [], activeProvider: "", recoveryAvailable: false,
  };
  const providerRows = useRef(new Map<string, HTMLLIElement>());
  function locateProvider(id: string) {
    setQuery("");
    requestAnimationFrame(() => providerRows.current.get(id)?.scrollIntoView({ block: "nearest" }));
  }
  const viewingDifferentMode = state.applied && state.selection.mode !== view;
  const removingInUse = remove && usesProvider(state.selection, remove.id);
  const selectionAfterRemoval = remove ? selectionAfterDelete(state.selection, remove.id) : state.selection;
  const pendingIds = pending ? [pending.provider, ...pending.members].filter(Boolean) : [];
  const pendingProviders = pendingIds.flatMap(id => state.providers.filter(p => p.id === id));
  const missingModels = pendingProviders.filter(p => !modelsOf(p).length);
  const modelPreview = pendingProviders.flatMap(provider => modelsOf(provider).map(model => ({
    key: provider.id + "/" + model.model,
    label: (pending?.mode === "aggregate" ? provider.name + " / " : "") + (model.displayName || model.model),
  })));
  const invalidGateway = pending?.mode !== "direct" && (missingModels.length > 0 || modelPreview.length > 200);

  async function openImport() {
    const available = nativeDesktop ? (await claudeProvidersClient.list()).providers.filter(p => !p.officialLogin && p.keyConfigured && !p.keyDecryptionFailed)
      : [{ ...previewProvider, id: "preview-import", name: "Claude Code 导入示例" }];
    setImportIds([]);
    setImportOptions(available);
  }

  const closeApply = () => { setPending(null); setError(""); };
  const closeImport = () => { setImportOptions(null); setError(""); };
  const startApply = (id: string, mode = view) => {
    setError("");
    setPending({ mode, provider: id, members: mode === "aggregate" ? state.selection.members.filter(member => member !== id) : [] });
  };

  return <section className="claude-providers claude-management-workbench claude-desktop-workbench">
    <div className="claude-mode-bar">
      <div className="claude-mode-selector">
        <div className="claude-mode-tabs" role="group" aria-label="Claude Desktop 连接模式">
          {modes.map(({ id, name, icon: Icon }) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
            <Icon size={14} aria-hidden="true" />{name}
          </button>)}
        </div>
        <HelpTooltip label="连接模式的区别">
          <strong>连接模式的区别</strong>
          <p>直连：Claude Desktop 使用官方登录，或直接连接兼容 Anthropic Messages 的 HTTPS 供应商。</p>
          <p>路由：CloudHub 本机网关将请求转发给所选的一家供应商，并按需转换 API 格式。</p>
          <p>聚合：多家供应商的模型集中显示在 Claude Desktop 的模型菜单中。选中模型后，网关将请求发给对应供应商。</p>
          <p>使用路由或聚合时，需保持 CloudHub 运行。</p>
        </HelpTooltip>
      </div>
      <span className="claude-mode-status" role="status">{state.applied ? `${nativeDesktop ? "已应用配置" : "已模拟配置"} · ${nameOf(state.selection.mode)} · ${activeName}` : "尚未应用 CloudHub 配置"}</span>
      {view !== "direct" && <div className="claude-mode-actions">
        <span className="claude-config-help">{view === "route" ? "固定路由" : "按模型分发"}</span>
        <button type="button" className="secondary" onClick={() => setSettingsOpen(true)}><Settings2 size={14} aria-hidden="true" />网关设置</button>
      </div>}
    </div>
    {!nativeDesktop && <p className="claude-config-help" role="status">界面调试使用示例数据，保存和切换只在当前页面模拟。</p>}
    <div className="claude-status-bar">
      <div className="claude-config-source">
        <span className={configFile?.status === "readable" ? "is-ok" : "is-muted"}>
          <Server size={13} aria-hidden="true" />
          配置文件 {configFile ? <code>{configFile.path}</code> : nativeDesktop ? "路径暂不可用" : "预览环境"}
          {configFile && configFile.status !== "readable" && ` · ${configStatus[configFile.status]}`}
        </span>
      </div>
      <span className="claude-status-bar-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          setConfigOverview(true);
          if (nativeDesktop) void run(() => perform({ type: "state" }));
        }}>配置概览</button>
        <button type="button" className="secondary" onClick={() => setDiagnosticsOpen(true)}><Activity size={13} aria-hidden="true" />连接诊断</button>
        {configFile && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => perform({ type: "open_config_directory" }))}>
          <FolderOpen size={13} aria-hidden="true" />打开配置目录
        </button>}
      </span>
    </div>
    <div className="claude-config-help claude-config-description">
      <span>应用连接模式后，Claude Desktop 会在重启时加载配置。</span>
      <button type="button" aria-expanded={showConfigDescription} aria-controls={configDescriptionId} onClick={() => setShowConfigDescription(value => !value)}>
        <ArrowDown size={12} aria-hidden="true" />详细说明
      </button>
      <p id={configDescriptionId} hidden={!showConfigDescription}>应用配置前，CloudHub 会加密备份当前文件。应用后请退出并重新打开 Claude Desktop。编辑正在使用的供应商时，也会更新已应用的配置。</p>
    </div>
    {viewingDifferentMode && <div className="claude-desktop-mode-notice">
      <span role="status">正在查看「{nameOf(view)}」。{nativeDesktop ? "已应用的配置" : "已模拟的配置"}仍为「{nameOf(state.selection.mode)}」。</span>
      {view === "direct" && <button type="button" className="secondary" disabled={busy} onClick={() => startApply(official.id)}>
        <Plug size={14} aria-hidden="true" />切回官方直连
      </button>}
    </div>}
    {nativeDesktop && state.selection.mode !== "direct" && !state.running && <div className="claude-recovery-banner" role="status">
      <AlertTriangle className="claude-recovery-icon" size={16} aria-hidden="true" />
      <div className="claude-recovery-copy">
        <strong>Claude Desktop 本机网关已停止</strong>
        <span>当前为「{nameOf(state.selection.mode)}」模式，网关未运行时 Claude Desktop 的请求无法转发。</span>
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => perform({ type: "resume" }))}>
        <RotateCcw size={14} aria-hidden="true" />重新启动网关
      </button>
    </div>}
    {notice && <p className="claude-config-help" role="status">{notice}</p>}
    {error && !pending && !importOptions && !remove && <p className="claude-error" role="alert">{error}</p>}
    {view !== "direct" && <>
      {routingUnavailable && <p className="claude-error" role="status">暂时无法读取本机网关状态，正在重试。</p>}
      <ClaudeRoutingGraph desktop view={view} state={routeState} providers={routingProviders} onLocate={locateProvider}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMapping={state.selection.mode === view && state.applied ? () => setConfigOverview(true) : undefined} />
      <ClaudeRoutingLiveFeed desktop view={view} state={routeState} providers={routingProviders} onLocate={locateProvider} onOpenUsage={() => setUsageOpen(true)} />
    </>}
    <header className="claude-providers-head claude-list-toolbar">
      <label className="claude-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索供应商" placeholder="搜索供应商" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <span className="claude-config-help" role="status">共 {shown.length} 项</span>
      <div className="claude-providers-actions">
        <SortSelectionControls label="Claude Desktop 供应商" keys={sortableIds} selected={emptySelection} sorting={sorting}
          onSortingChange={setSorting} disabled={busy} showSelectAll={false} onToggleAll={() => {}} />
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => perform({ type: "state" }))}><RotateCcw size={14} aria-hidden="true" />刷新</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(openImport)}><Download size={14} aria-hidden="true" />从 Claude Code 导入</button>
        <button type="button" className="primary" disabled={busy} onClick={() => setPresets(true)}><Plus size={14} aria-hidden="true" />添加供应商</button>
      </div>
    </header>
    {shown.length ? <ul className="claude-provider-list">{shown.map(provider => {
      const selected = state.applied && state.selection.mode === view && usesProvider(state.selection, provider.id);
      const requirement = view === "direct" ? directRequirement(provider) : null;
      return <li key={provider.id || "official"} data-claude-desktop-sort-id={provider.officialLogin ? undefined : provider.id}
        ref={element => { if (element) providerRows.current.set(provider.id, element); else providerRows.current.delete(provider.id); }}
        className={"claude-provider-item" + (selected ? " is-current" : "")}>
        {sorting && !provider.officialLogin && <button type="button" className="claude-provider-drag-handle" aria-disabled={!canSort}
          title="拖动排序，也可使用上、下方向键" aria-label={`调整 ${provider.name} 的顺序`}
          onPointerDown={event => providerDrag.startDrag(event, provider.id)} onKeyDown={event => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const index = sortableIds.indexOf(provider.id);
            const target = sortableIds[index + (event.key === "ArrowUp" ? -1 : 1)];
            if (target) moveProvider(provider.id, target);
          }}><GripVertical size={16} aria-hidden="true" /></button>}
        <div className="claude-provider-main">
          <div className="claude-provider-title">
            <ProviderBrandIcon
              name={provider.name}
              hints={[provider.websiteUrl, provider.baseUrl, ...(provider.modelCatalog?.map(m => m.model) ?? [])]}
              fallback={provider.name.trim().slice(0, 1)}
              className="is-small claude-provider-brand-logo"
            />
            <strong>{provider.name}</strong>
            {provider.officialLogin && <span className="claude-tag is-fixed">官方登录</span>}
            {selected && <span className="claude-tag is-current">{state.selection.members.includes(provider.id) ? "已加入聚合" : `已配置${nameOf(view)}`}</span>}
            {view === "direct" && !selected && <span className={`claude-tag ${requirement ? "is-warning" : "is-configured"}`}>{requirement?.label ?? "可直连"}</span>}
          </div>
          <span className="claude-config-help">{provider.websiteUrl || provider.baseUrl || "使用 Claude Desktop 内置登录"}</span>
          {requirement && <span className="claude-config-help">{requirement.reason}</span>}
        </div>
        <div className="claude-provider-actions">
          {requirement?.label === "需要路由" ? <button type="button" className="secondary" onClick={() => setView("route")}>查看路由</button>
          : <button type="button" className="secondary" disabled={busy || Boolean(requirement)} onClick={() => startApply(provider.id)}>
            {view === "direct" && <Plug size={14} aria-hidden="true" />}
            {provider.officialLogin ? "恢复官方登录" : view === "direct" ? "应用直连" : view === "route" ? "启用路由" : "设置聚合"}
          </button>}
          {!provider.officialLogin && <>
            <button type="button" className="secondary claude-icon-button" aria-label={`编辑 ${provider.name}`} title="编辑" disabled={busy} onClick={() => setEditing(provider)}><Pencil size={14} aria-hidden="true" /></button>
            <button type="button" className="secondary claude-icon-button" aria-label={`删除 ${provider.name}`} title="删除" disabled={busy} onClick={() => { setError(""); setRemove(provider); }}><Trash2 size={14} aria-hidden="true" /></button>
          </>}
        </div>
      </li>;
    })}</ul> : <p className="claude-empty-line">{busy ? "正在读取供应商…" : keyword ? "没有符合条件的供应商" : "请添加或导入供应商"}</p>}
    {configOverview && <SharedDialog sizeStorageKey="claude-desktop-config-overview" title="Claude Desktop 配置概览" onClose={() => setConfigOverview(false)}
      footer={<button type="button" className="secondary" onClick={() => setConfigOverview(false)}>关闭</button>}>
      <p>{nativeDesktop ? "CloudHub 配置" : "预览配置"}：{state.applied ? `${nameOf(state.selection.mode)} · ${activeName}` : "尚未应用"}</p>
      {state.applied && state.selection.mode !== "direct" && <p>本机网关：{nativeDesktop ? (state.running ? "运行中" : "已停止") : "预览环境"}</p>}
      <p>四个文件共同描述一套连接配置。两个主配置决定启动模式，索引选中方案，方案文件保存实际连接参数。</p>
      <details>
        <summary>连接和写入原理</summary>
        <ul>
          <li><strong>官方登录</strong>：两个入口切回 1p，CloudHub 从索引移除自己的方案，并删除对应方案文件。其他第三方方案保留。</li>
          <li><strong>供应商直连</strong>：两个入口切到 3p，索引选中 CloudHub 方案，Claude Desktop 直接请求该方案配置的 HTTPS Anthropic Messages 供应商。</li>
          <li><strong>路由与聚合</strong>：同样使用 3p，CloudHub 将生成的模型 ID 写入方案文件，并通过本机网关的 /v1/models 提供模型发现。收到请求时，网关把该 ID 映射回上游模型；路由使用一家供应商，聚合按模型选择供应商。使用时需保持 CloudHub 运行。</li>
          <li><strong>应用配置</strong>：CloudHub 写入前加密备份相关文件。应用后退出并重新打开 Claude Desktop 以加载配置。</li>
        </ul>
      </details>
      <p className="claude-config-help">文件预览只展示与连接有关的字段和摘要。连接方案的密钥默认隐藏，可按需显示。</p>
      {busy && <p role="status">正在读取配置文件…</p>}
      {error && <p className="claude-error" role="alert">{error}</p>}
      {state.configFiles.length > 0 ? <div className="claude-desktop-config-files">{state.configFiles.map((file, index) => <section key={file.path}>
        <strong>{configFileRoles[index]?.title}</strong> · {configStatus[file.status]}
        <div className="claude-config-help">{configFileRoles[index]?.description}</div>
        <code>{file.path}</code>
        {file.preview && <ConfigFilePreview preview={file.preview} />}
      </section>)}</div> : !busy && <p>{nativeDesktop ? "暂未取得配置路径。" : "浏览器预览无法读取设备上的 Claude Desktop 文件。"}</p>}
    </SharedDialog>}
    {diagnosticsOpen && <DesktopDiagnostics onClose={() => setDiagnosticsOpen(false)} />}
    {settingsOpen && view !== "direct" && <RoutingSettings desktop mode={view} config={state.gatewayConfig} running={state.selection.mode !== "direct"}
      onClose={() => setSettingsOpen(false)} onSave={async ({ port, timeoutSecs, firstByteSecs, idleSecs, logging }) => {
        if (!nativeDesktop && port === DEFAULT_CLAUDE_ROUTING.port) throw new Error("该端口与预览中的 Claude Code 默认端口相同");
        await perform({ type: "save_gateway_settings", settings: { port, timeoutSecs, firstByteSecs, idleSecs, logging } });
      }} />}
    {usageOpen && <SharedDialog title="Claude Desktop 请求用量" onClose={() => setUsageOpen(false)}
      footer={<button type="button" className="secondary" onClick={() => setUsageOpen(false)}>关闭</button>}>
      <UsagePanel state={routeState} providers={routingProviders} />
    </SharedDialog>}
    {presets && <ClaudeProviderPresetPicker desktop onClose={() => setPresets(false)} onCustom={() => {
      setPresets(false); setEditing({ id: "", name: "", apiFormat: "anthropic", apiKeyField: "auth_token" });
    }} onSelect={input => { setPresets(false); setEditing(input); }} />}
    {editing && <Editor draft={editing} keyConfigured={Boolean(state.providers.find(p => p.id === editing.id)?.keyConfigured)} keyDecryptionFailed={false}
      desktopSave={provider => perform({ type: "save", provider })} onClose={() => setEditing(null)} onSaved={() => {
        setEditing(null);
        setNotice(nativeDesktop && usesProvider(state.selection, editing.id)
          ? "供应商和当前配置已更新。请退出并重新打开 Claude Desktop。"
          : nativeDesktop ? "供应商已保存" : "调试供应商已保存");
      }} />}
    {pending && <SharedDialog title={pending.provider ? `应用${nameOf(pending.mode)}配置` : "恢复 Claude Desktop 官方登录"} size="small" onClose={closeApply} closeDisabled={busy} footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={closeApply}>取消</button>
      <button type="button" className="primary" disabled={busy || invalidGateway} onClick={() => void run(async () => {
        await perform({ type: "apply", selection: pending });
        setPending(null);
        setNotice(nativeDesktop ? "配置已写入。请退出并重新打开 Claude Desktop。" : "调试配置已更新。");
      })}>应用</button>
    </>}>
      <p className="claude-config-help">{pending.mode !== "direct" ? "应用后请保持 CloudHub 运行，退出并重新打开 Claude Desktop 以加载配置。"
        : pending.provider ? "直连会将供应商 API Key 写入 Claude Desktop 本机配置。应用后请退出并重新打开 Claude Desktop。"
        : "应用后请退出并重新打开 Claude Desktop，再使用官方账号登录。"}</p>
      {pending.mode !== "direct" && missingModels.length > 0 && <p className="claude-error" role="status">请先为 {missingModels.map(p => p.name).join("、")} 配置模型。</p>}
      {pending.mode !== "direct" && modelPreview.length > 200 && <p className="claude-error" role="status">Claude Desktop 最多可使用 200 个模型。</p>}
      {pending.mode === "aggregate" && <>
        <p>默认供应商 · {state.providers.find(p => p.id === pending.provider)?.name}</p>
        <fieldset className="claude-models"><legend>参与聚合的其他供应商</legend>{state.providers.filter(p => p.id !== pending.provider).map(p =>
          <label key={p.id} className="claude-check"><input type="checkbox" checked={pending.members.includes(p.id)} onChange={event => {
            setPending({ ...pending, members: event.target.checked ? [...pending.members, p.id] : pending.members.filter(id => id !== p.id) });
          }} />{p.name}</label>
        )}</fieldset>
        <details><summary>模型预览（{modelPreview.length}/200）</summary><ul>{modelPreview.map(model => <li key={model.key}>{model.label}</li>)}</ul></details>
      </>}
      {error && <p className="claude-error" role="alert">{error}</p>}
    </SharedDialog>}
    {importOptions && <SharedDialog title="从 Claude Code 导入供应商" icon={<Server size={18} aria-hidden="true" />} size="small" onClose={closeImport} closeDisabled={busy} footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={closeImport}>取消</button>
      <button type="button" className="primary" disabled={busy || !importIds.length} onClick={() => void run(async () => {
        await perform({ type: "import", ids: importIds }); closeImport(); setNotice("已处理所选供应商，重复配置将跳过。");
      })}>导入所选</button>
    </>}>
      <p className="claude-config-help">复制供应商及模型配置。第三方协议或模型可通过路由使用。</p>
      {importOptions.length ? importOptions.map(p => <label className="claude-check" key={p.id}>
        <input type="checkbox" checked={importIds.includes(p.id)} onChange={event => setImportIds(ids => event.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />{p.name} · {p.apiFormat ?? "anthropic"}
      </label>) : <p className="claude-config-help">没有可导入的第三方供应商。</p>}
      {error && <p className="claude-error" role="alert">{error}</p>}
    </SharedDialog>}
    {remove && <SharedDialog title="删除 Claude Desktop 供应商" size="small" onClose={() => { setRemove(null); setError(""); }} closeDisabled={busy} footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={() => setRemove(null)}>取消</button>
      <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => {
        await perform({ type: "delete", id: remove.id });
        setRemove(null);
        if (removingInUse) setView(selectionAfterRemoval.mode);
        setNotice(nativeDesktop && removingInUse
          ? "供应商已删除，配置已更新。请退出并重新打开 Claude Desktop。"
          : "供应商已删除");
      })}>删除</button>
    </>}>
      <p>删除「{remove.name}」及其在 Claude Desktop 管理中保存的凭据？</p>
      {removingInUse && <p>{selectionAfterRemoval.provider
        ? "删除后将更新聚合配置，并保留其余供应商。"
        : "删除后将恢复 Claude Desktop 官方登录。"}</p>}
      {error && <p className="claude-error" role="alert">{error}</p>}
    </SharedDialog>}
  </section>;
}
