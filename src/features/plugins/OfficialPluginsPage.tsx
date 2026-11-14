import { ToastNotice } from "../../shared/ToastNotice";
import { SortSelectionControls } from "../../shared/SortSelectionControls";
import { ListSortHandle } from "../../shared/ListSortHandle";
import { useSortableDrag } from "../../shared/useSortableDrag";
import { useDialogDocument } from "../../shared/DialogDocument";
import { useEffect, useRef, useState } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { ArrowLeft, Cpu, Globe, MessageCircle, NotebookPen, RefreshCw, Search, Package, SquareTerminal } from "lucide-react";
import { runningInTauri, runningOnPhone } from "../../platform/api";
import { pluginsClient, type WechatPluginStatus } from "../../platform/clients/plugins";
import { officialPlugins } from "./registry";
import { PluginApplication } from "./PluginApplication";
import { PluginPresentationDialog } from "./PluginPresentationDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { PluginPageHost } from "./PluginSurface";
import { PluginPresentationProvider, usePluginPresentation, type PluginPresentation } from "./pluginPresentation";
import { applicationCatalog, sortedApplications, type ApplicationDefinition, type ApplicationSection } from "./applicationCatalog";
import type { ApplicationPreferenceState } from "./useApplicationPreferences";
import type { Account, LocalAsset } from "../../shared/types";

const plugin = officialPlugins[0];
const hardwarePlugin = officialPlugins[1];
const wslPlugin = officialPlugins[2];
const browserPlugin = officialPlugins[3];
const notesPlugin = officialPlugins[4];
const claudePlugin = officialPlugins[5];
const configKey = `${plugin.id}.config`;

/** 桌面列表保留直接设置入口；手机端收进详情弹层以精简操作区。 */
function PresentationButton({ pluginId, onOpen }: { pluginId: string; onOpen: (id: string) => void }) {
  const { get } = usePluginPresentation();
  const current = get(pluginId);
  const label = current.mode === "page" ? "页面" : current.size === "small" ? "小弹窗" : "大弹窗";
  return <button type="button" className="table-link plugin-presentation-trigger" aria-label="设置" title={`设置，当前打开方式：${label}`} onClick={() => onOpen(pluginId)}>设置</button>;
}

function readConfig(): { enabled: boolean; path: string; count: number } {
  try {
    const value = JSON.parse(localStorage.getItem(configKey) || "{}");
    return { enabled: value.enabled !== false, path: typeof value.path === "string" ? value.path : "",
      count: Number.isInteger(value.count) && value.count >= 2 && value.count <= 5 ? value.count : 2 };
  } catch { return { enabled: true, path: "", count: 2 }; }
}

const applicationDetailNotes: Record<string, string> = {
  "cloudhub.wechat-multi": "需安装微信客户端，多开效果取决于微信版本。",
  "cloudhub.hardware-info": "本机读取；Wi-Fi 密码仅临时显示且不进入复制或导出。",
  "cloudhub.wsl-dashboard": "仅限 Windows 桌面端；删除操作会永久删除发行版数据。",
  "cloudhub.fingerprint-browser": "独立环境与基础参数；深层硬件指纹需定制内核。",
  "cloudhub.claude-providers": "API Key 本地加密保存；切换前自动备份配置，支持直连、路由与聚合。",
  "cloudhub.notes": "数据仅保存在本机，账号密码为明文存储，不做加密。",
};

function applicationPlatform(app: ApplicationDefinition) {
  if (app.platform === "all") return "Windows / macOS / Linux / Android / iOS";
  if (app.id === "cloudhub.hardware-info") return "Windows / macOS / Linux";
  if (app.id === "cloudhub.wsl-dashboard") return "Windows / WSL";
  if (app.id === "cloudhub.fingerprint-browser") return "Windows x64";
  if (app.id === "cloudhub.lan-devices") return "Windows / macOS";
  return app.platform === "windows" ? "Windows" : "Windows / macOS / Linux";
}

function ApplicationDetailsDialog({ app, order, onClose, onConfigure }: { app: ApplicationDefinition; order: number | undefined; onClose: () => void; onConfigure: () => void }) {
  return <SharedDialog sizeStorageKey="features/plugins/official-plugins-page/application-details-dialog" title="应用详情" subtitle={app.name} className="store-application-details-dialog" bodyClassName="store-application-details-body" size="small" showResize={false} closeLabel="关闭应用详情" onClose={onClose}
    footer={<><button type="button" className="secondary" onClick={onConfigure}>设置打开方式</button><button type="button" className="primary" onClick={onClose}>关闭</button></>}>
    <dl className="store-application-details">
      <div><dt>序号</dt><dd>{order ?? "—"}</dd></div>
      <div><dt>软件名称</dt><dd>{app.name}</dd></div>
      <div><dt>开发商</dt><dd>{app.publisher}</dd></div>
      <div><dt>版本</dt><dd>v{app.version}</dd></div>
      <div><dt>说明</dt><dd>{app.description}{applicationDetailNotes[app.id] && <small>{applicationDetailNotes[app.id]}</small>}</dd></div>
      <div><dt>价格</dt><dd>免费</dd></div>
      <div><dt>平台</dt><dd>{applicationPlatform(app)}</dd></div>
      <div><dt>来源</dt><dd>官方应用</dd></div>
    </dl>
  </SharedDialog>;
}

function ApplicationDetailsButton({ app, onOpen }: { app: ApplicationDefinition; onOpen: (id: string) => void }) {
  return <button type="button" className="table-link store-view-details" aria-label={`查看${app.name}全部信息`} onClick={() => onOpen(app.id)}>查看</button>;
}

type StoreProps = { mobile?: boolean; initialPluginId?: string; forceInitialPageMode?: boolean; applicationSettings: ApplicationPreferenceState; onOpenSection: (section: ApplicationSection) => boolean | void; onOpenPlugin?: () => void; onReturnCatalog: () => void; onLanConnect?: (ip: string, platform: "linux" | "windows", name: string) => void; accounts?: Account[]; localAssets?: LocalAsset[]; onStatus?: (message: string) => void; onConfirm?: (message: string) => Promise<boolean>; refreshActionRef?: { current: (() => Promise<void>) | null } };

function OfficialPluginsStore({ mobile = false, initialPluginId, forceInitialPageMode, applicationSettings, onOpenSection, onOpenPlugin, onReturnCatalog, onLanConnect, accounts = [], localAssets = [], onStatus = () => {}, onConfirm = async () => false, refreshActionRef }: StoreProps) {
  const document = useDialogDocument();
  const window = document.defaultView!;
  const { get } = usePluginPresentation();
  const [config, setConfig] = useState(readConfig);
  const [status, setStatus] = useState<WechatPluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState("官方应用");
  const [category, setCategory] = useState("全部");
  const [keyword, setKeyword] = useState("");
  const [activePlugin, setActivePlugin] = useState<{ id: string; presentation: PluginPresentation } | null>(() => {
    if (!initialPluginId) return null;
    const stored = get(initialPluginId);
    // 从左侧菜单进入的应用始终整页打开；弹层设置只在商店列表内打开时生效。
    return { id: initialPluginId, presentation: forceInitialPageMode ? { ...stored, mode: "page" } : stored };
  });
  const returnPosition = useRef({ windowY: 0, mainY: 0, contentY: 0, entry: null as HTMLElement | null });
  const [recent] = useState(() => {
    try { return localStorage.getItem(`${plugin.id}.last-used`) !== null; } catch { return false; }
  });
  const [hardwareRecent, setHardwareRecent] = useState(() => {
    try { return localStorage.getItem(hardwarePlugin.id + ".last-used") !== null; } catch { return false; }
  });
  const [presentationFor, setPresentationFor] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [wslRecent, setWslRecent] = useState(() => { try { return localStorage.getItem(`${wslPlugin.id}.last-used`) !== null; } catch { return false; } });
  const enabled = (id: string) => id === plugin.id ? config.enabled : true;
  const orderedApplications = sortedApplications(applicationSettings.preferences);
  const applicationPositions = new Map<string, number>(orderedApplications.map((app, index) => [app.id, index + 1]));
  const applications = orderedApplications.filter(app => source === "官方应用"
    && `${app.name} ${app.publisher} ${app.description} ${app.keywords ?? ""}`.toLowerCase().includes(keyword.trim().toLowerCase())
    && (category !== "已启用" || enabled(app.id)) && (category !== "桌面工具" || app.category === "桌面工具"));
  const visibleCount = applications.length;
  const [storePage, setStorePage] = useState(1);
  const [storePageSize, setStorePageSize] = useState(10);
  const pagedApplications = applications.slice((storePage - 1) * storePageSize, storePage * storePageSize);
  const [sorting, setSorting] = useState(false);
  const sortDisabled = !applicationSettings.ready || applicationSettings.saving;
  function moveApplication(source: string, target: string) {
    if (!sorting || sortDisabled) return;
    const position = applicationPositions.get(target);
    if (position !== undefined) void applicationSettings.updateOrder(source, position);
  }
  const drag = useSortableDrag({ selector: "[data-store-sort-id]", attribute: "data-store-sort-id", enabled: sorting && !sortDisabled, onMove: moveApplication });
  useEffect(() => { setStorePage(1); }, [keyword, category, source]);

  /** Capture the mode when opening so a mounted plugin never switches containers mid-edit. */
  function openPlugin(pluginId: string) {
    const app = applicationCatalog.find(item => item.id === pluginId);
    // Existing plugins retain their page/modal preference; newly catalogued modules use their owning page.
    const managedInStore = ["cloudhub.flow", "cloudhub.authenticator", "cloudhub.certificates", "cloudhub.codex", "cloudhub.frp"].includes(pluginId);
    if (app?.section && !managedInStore && pluginId !== notesPlugin.id && pluginId !== claudePlugin.id && onOpenSection(app.section) !== false) return;
    // 真正打开插件页时通知宿主清理遗留状态，避免上一页面留下的提示条（如“去 PC 端使用”）跟到新插件页顶部。
    onOpenPlugin?.();
    returnPosition.current = {
      windowY: window.scrollY,
      mainY: document.getElementById("main-content")?.scrollTop ?? 0,
      contentY: document.querySelector<HTMLElement>(".mobile-content")?.scrollTop ?? 0,
      entry: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    setActivePlugin({ id: pluginId, presentation: get(pluginId) });
    switch (pluginId) {
      case hardwarePlugin.id:
        setHardwareRecent(true);
        try { localStorage.setItem(hardwarePlugin.id + ".last-used", String(Date.now())); } catch { /* 仅用于最近使用列表 */ }
        break;
      case wslPlugin.id:
        setWslRecent(true);
        try { localStorage.setItem(`${wslPlugin.id}.last-used`, String(Date.now())); } catch { /* 最近使用记录为可选 */ }
        break;
      default:
        break;
    }
  }

  /** 关闭当前打开的插件，两种形态共用。 */
  function closePlugin() {
    const pluginId = activePlugin?.id;
    const position = returnPosition.current;
    setActivePlugin(null);
    if (initialPluginId) onReturnCatalog();
    setConfig(readConfig());
    if (runningInTauri && !runningOnPhone) void operate(() => refresh());
    window.requestAnimationFrame(() => {
      const main = document.getElementById("main-content");
      if (main) main.scrollTop = position.mainY;
      const content = document.querySelector<HTMLElement>(".mobile-content");
      if (content) content.scrollTop = position.contentY;
      window.scrollTo({ top: position.windowY, behavior: "instant" });
      const entry = position.entry?.isConnected ? position.entry
        : document.querySelector<HTMLElement>(`[data-plugin-entry="${CSS.escape(pluginId ?? "")}"]`);
      entry?.focus({ preventScroll: true });
    });
  }

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => { setMessage(""); setError(""); }, error ? 10000 : 7000);
    return () => window.clearTimeout(timer);
  }, [message, error]);


  useEffect(() => {
    if (activePlugin?.id !== plugin.id || !runningInTauri || runningOnPhone) return;
    let active = true;
    let checking = false;
    const checkStatus = async () => {
      if (busyRef.current || checking) return;
      checking = true;
      try {
        const next = await pluginsClient.wechatStatus();
        if (active && !busyRef.current) setStatus(next);
      } catch {
        if (active && !busyRef.current) setError("无法刷新微信状态，请点击刷新状态重试。");
      } finally { checking = false; }
    };
    void checkStatus();
    window.addEventListener("focus", checkStatus);
    return () => { active = false; window.removeEventListener("focus", checkStatus); };
  }, [activePlugin?.id, window]);

  async function operate(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "插件操作失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function refresh(detect = false) {
    const next = await pluginsClient.wechatStatus();
    setStatus(next);
    if (detect && next.detectedPath) setConfig(current => ({ ...current, path: next.detectedPath! }));
    if (detect) setMessage(next.detectedPath ? "已检测到微信客户端。" : "未找到默认安装位置，请手动选择微信客户端。");
  }

  useEffect(() => {
    if (!refreshActionRef) return;
    const action = async () => {
      if (runningInTauri && !runningOnPhone) await operate(() => refresh());
      else { setConfig(readConfig()); setStatus(null); setError(""); setMessage(""); }
    };
    refreshActionRef.current = action;
    return () => { if (refreshActionRef.current === action) refreshActionRef.current = null; };
  });

  useEffect(() => {
    if (runningInTauri && !runningOnPhone) void operate(() => refresh());
  }, []);

  useEffect(() => {
    try { localStorage.setItem(configKey, JSON.stringify(config)); }
    catch { setError("无法保存插件设置，请检查本地存储空间。"); }
  }, [config]);
  const application = activePlugin && (
      <PluginApplication pluginId={activePlugin.id} wslEnabled mobile={mobile || runningOnPhone} accounts={accounts} localAssets={localAssets} onStatus={onStatus} onConfirm={onConfirm} onLanConnect={onLanConnect ? (ip, platform, name) => { closePlugin(); onLanConnect(ip, platform, name); } : undefined} onNotify={activePlugin.presentation.mode === "modal" ? setMessage : undefined} onError={activePlugin.presentation.mode === "modal" ? setError : undefined} />);
  const activeDefinition = officialPlugins.find(item => item.id === activePlugin?.id);
  if (activePlugin?.presentation.mode === "page" && activeDefinition) {
    return <PluginPageHost title={activeDefinition.name} onClose={closePlugin}>{application}</PluginPageHost>;
  }

  return <section className="utility-page official-plugins-page software-store-page">
    <header><div className="store-heading"><span className="eyebrow">SOFTWARE STORE</span><div className="store-heading-line"><h1>软件商店</h1><span>官方工具免费内置 · 本地运行</span></div><p>集中管理云枢工具箱应用与插件，内置工具随客户端更新。</p></div><span className="store-total">{officialPlugins.length} 个内置应用</span></header>
    <div className="store-tabs" role="group" aria-label="应用来源">{["官方应用", "第三方应用"].map(item => <button key={item} type="button" aria-pressed={source === item} className={source === item ? "is-active" : ""} onClick={() => setSource(item)}>{item}</button>)}</div>
    <section className="panel store-catalog" aria-label="软件列表" aria-busy={busy}>
      <div className="store-search-row">
        <label htmlFor="store-search">应用搜索</label><div className="store-search-input"><Search size={15} aria-hidden="true" /><input id="store-search" type="search" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索应用名称、开发商或说明" /></div>
        <div className="store-categories" role="group" aria-label="应用分类">{["全部", "已内置", "已启用", "免费应用", "桌面工具"].map(item => <button type="button" key={item} aria-pressed={category === item} className={category === item ? "is-active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
        <SortSelectionControls label="应用" keys={pagedApplications.map(app => app.id)} selected={new Set<string>()} sorting={sorting} onToggleAll={() => {}} onSortingChange={setSorting} showSelectAll={false} disabled={sortDisabled} />
        <button type="button" className="secondary store-refresh" disabled={!runningInTauri || runningOnPhone || busy} onClick={() => void operate(() => refresh())}><RefreshCw size={14} aria-hidden="true" />{busy ? "正在刷新…" : "刷新应用状态"}</button>
      </div>
      <div className="store-filter-row"><span>最近使用</span>{recent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(plugin.id); }}><MessageCircle size={14} aria-hidden="true" />微信多开</button>}{hardwareRecent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(hardwarePlugin.id); }}><Cpu size={14} aria-hidden="true" />电脑信息</button>}{wslRecent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(wslPlugin.id); }}><SquareTerminal size={14} aria-hidden="true" />WSL 管理</button>}{!recent && !hardwareRecent && !wslRecent && <small>暂无使用记录</small>}</div>
      {!runningInTauri && <p className="store-platform-note" role="status">浏览器预览不支持启动本地软件，请在 Windows 桌面客户端使用。</p>}
      {runningInTauri && status && !status.supported && <p className="store-platform-note" role="status">微信多开插件仅支持 Windows 桌面端。</p>}
        <table className="store-table"><caption className="store-table-caption">应用列表</caption><thead><tr><th scope="col">{sorting ? "排序" : "序号"}</th><th scope="col">软件名称</th><th scope="col">开发商</th><th scope="col">说明</th><th scope="col">价格</th><th scope="col">平台</th><th scope="col">操作</th></tr></thead><tbody>
        {pagedApplications.map(app => {
        const Icon = app.icon;
        const serialCell = <td data-label="序号" className="store-serial-number">{sorting ? <ListSortHandle id={app.id} name={app.name} ids={pagedApplications.map(item => item.id)} disabled={sortDisabled} onStart={drag.startDrag} onMove={moveApplication} /> : applicationPositions.get(app.id)}</td>;
        if (app.id === plugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><MessageCircle size={20} aria-hidden="true" /><div><strong>{plugin.name}</strong><small>v{plugin.version} · 实验性</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{plugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{plugin.description}<small>{applicationDetailNotes[plugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={plugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={plugin.id} aria-expanded={activePlugin?.id === plugin.id} onClick={() => openPlugin(plugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === hardwarePlugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><Cpu size={20} aria-hidden="true" /><div><strong>{hardwarePlugin.name}</strong><small>v{hardwarePlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{hardwarePlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{hardwarePlugin.description}<small>{applicationDetailNotes[hardwarePlugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={hardwarePlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={hardwarePlugin.id} onClick={() => openPlugin(hardwarePlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === wslPlugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><SquareTerminal size={20} aria-hidden="true" /><div><strong>{wslPlugin.name}</strong><small>v{wslPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{wslPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{wslPlugin.description}<small>{applicationDetailNotes[wslPlugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / WSL</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={wslPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={wslPlugin.id} onClick={() => openPlugin(wslPlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === browserPlugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><Globe size={20} aria-hidden="true" /><div><strong>{browserPlugin.name}</strong><small>v{browserPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{browserPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{browserPlugin.description}<small>{applicationDetailNotes[browserPlugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows x64</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={browserPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={browserPlugin.id} onClick={() => openPlugin(browserPlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === claudePlugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><Icon size={20} aria-hidden="true" /><div><strong>{claudePlugin.name}</strong><small>v{claudePlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{claudePlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{claudePlugin.description}<small>{applicationDetailNotes[claudePlugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={claudePlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={claudePlugin.id} onClick={() => openPlugin(claudePlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === notesPlugin.id) return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><NotebookPen size={20} aria-hidden="true" /><div><strong>{notesPlugin.name}</strong><small>v{notesPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{notesPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{notesPlugin.description}<small>{applicationDetailNotes[notesPlugin.id]}</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={notesPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={notesPlugin.id} onClick={() => openPlugin(notesPlugin.id)}>管理</button></div></td>
        </tr>;
        return <tr key={app.id} data-store-sort-id={app.id}>
          {serialCell}
          <td data-label="软件名称"><div className="store-app-name"><Icon size={20} aria-hidden="true" /><div><strong>{app.name}</strong><small>v{app.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{app.publisher}</small></td>
          <td data-label="说明" className="store-description">{app.description}</td>
          <td data-label="价格">免费</td><td data-label="平台">{app.platform === "all" ? "桌面 / Android / iOS" : app.platform === "windows" ? "Windows" : app.id === "cloudhub.lan-devices" ? "Windows / macOS" : "Windows / macOS / Linux"}</td>
          <td data-label="操作"><div className="store-row-actions"><ApplicationDetailsButton app={app} onOpen={setDetailsFor} /><PresentationButton pluginId={app.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={app.id} onClick={() => openPlugin(app.id)}>管理</button></div></td>
        </tr>;
        })}
      </tbody></table>
      {visibleCount === 0 && <div className="store-empty"><Package size={30} aria-hidden="true" /><h2>{source === "第三方应用" ? "暂无第三方应用" : "没有符合条件的应用"}</h2><p>{source === "官方应用" ? "尝试调整搜索词或切换应用分类。" : "当前先提供官方内置应用，后续上架的应用将在这里展示。"}</p><button type="button" className="secondary" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); }}>查看全部官方应用</button></div>}
      {visibleCount > 0 && <PaginationBar className="store-pagination" page={storePage} pageSize={storePageSize} total={visibleCount} onPageChange={setStorePage} onPageSizeChange={(size) => { setStorePageSize(size); setStorePage(1); }} />}
    </section>
    {activePlugin && activeDefinition && <SharedDialog key={activePlugin.id} sizeStorageKey={`plugin:${activePlugin.id}`} title={activePlugin.id === plugin.id ? "微信多开设置" : activeDefinition.name} size={activePlugin.presentation.size} className={`plugin-application-dialog plugin-modal-${activePlugin.presentation.size}`} onClose={closePlugin} footer={<button type="button" className="secondary" onClick={closePlugin}><ArrowLeft size={15} aria-hidden="true" />返回软件商店</button>}>{application}</SharedDialog>}
    {presentationFor && <PluginPresentationDialog targetId={presentationFor} applicationSettings={applicationSettings} onClose={() => setPresentationFor(null)} />}
    {detailsFor && applicationCatalog.find(item => item.id === detailsFor) && <ApplicationDetailsDialog app={applicationCatalog.find(item => item.id === detailsFor)!} order={applicationPositions.get(detailsFor)} onClose={() => setDetailsFor(null)} onConfigure={() => { const id = detailsFor; setDetailsFor(null); setPresentationFor(id); }} />}
    <ToastNotice message={[message, error, applicationSettings.error].filter(Boolean).join(" ")} tone={error || applicationSettings.error ? "error" : undefined} onDismiss={() => { setMessage(""); setError(""); applicationSettings.dismissError(); }}>{applicationSettings.error && !applicationSettings.ready && <button type="button" className="table-link" onClick={applicationSettings.retry}>重试读取</button>}</ToastNotice>
  </section>;
}

/** 插件的打开方式存在本机设置里，因此整页包一层 Provider。 */
export function OfficialPluginsPage(props: StoreProps) {
  return <PluginPresentationProvider><OfficialPluginsStore {...props} /></PluginPresentationProvider>;
}
