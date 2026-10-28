import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SharedDialog } from "../../shared/SharedDialog";
import { Cpu, Globe, MessageCircle, NotebookPen, RefreshCw, Search, Package, SlidersHorizontal, SquareTerminal, X } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { pluginsClient, type WechatPluginStatus } from "../../platform/clients/plugins";
import { officialPlugins } from "./registry";
import { PluginApplication } from "./PluginApplication";
import { PluginPresentationDialog } from "./PluginPresentationDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { PluginPageHost } from "./PluginSurface";
import { PluginPresentationProvider, usePluginPresentation, type PluginPresentation } from "./pluginPresentation";
import { applicationCatalog, applicationPreference, sortedApplications, type ApplicationDefinition, type ApplicationSection } from "./applicationCatalog";
import type { ApplicationPreferenceState } from "./useApplicationPreferences";

const plugin = officialPlugins[0];
const hardwarePlugin = officialPlugins[1];
const wslPlugin = officialPlugins[2];
const browserPlugin = officialPlugins[3];
const notesPlugin = officialPlugins[4];
const claudePlugin = officialPlugins[5];
const configKey = `${plugin.id}.config`;
const hardwareEnabledKey = hardwarePlugin.id + ".enabled";
const wslEnabledKey = wslPlugin.id + ".enabled";

function readConfig(): { enabled: boolean; path: string; count: number } {
  try {
    const value = JSON.parse(localStorage.getItem(configKey) || "{}");
    return { enabled: value.enabled !== false, path: typeof value.path === "string" ? value.path : "",
      count: Number.isInteger(value.count) && value.count >= 2 && value.count <= 5 ? value.count : 2 };
  } catch { return { enabled: true, path: "", count: 2 }; }
}

/** 操作列里的设置入口，工具提示保留当前打开方式。 */
function PresentationButton({ pluginId, onOpen }: { pluginId: string; onOpen: (id: string) => void }) {
  const { get } = usePluginPresentation();
  const current = get(pluginId);
  const label = current.mode === "page" ? "页面" : current.size === "small" ? "小弹窗" : "大弹窗";
  return <button type="button" className="table-link plugin-presentation-trigger" aria-label="设置" title={`设置，当前打开方式：${label}`} onClick={() => onOpen(pluginId)}>
    <SlidersHorizontal size={13} aria-hidden="true" /><span className="plugin-presentation-label">设置</span>
  </button>;
}

type StoreProps = { initialPluginId?: string; forceInitialPageMode?: boolean; applicationSettings: ApplicationPreferenceState; onOpenSection: (section: ApplicationSection) => void; onReturnCatalog: () => void; onLanConnect?: (ip: string, platform: "linux" | "windows", name: string) => void };

function OrderCell({ app, settings }: { app: ApplicationDefinition; settings: ApplicationPreferenceState }) {
  const order = applicationPreference(app, settings.preferences).order;
  const [draft, setDraft] = useState(String(order));
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(order)), [order, settings.saving]);
  const beginEditing = () => {
    if (!settings.ready || settings.saving) return;
    cancelled.current = false;
    setDraft(String(order));
    setEditing(true);
  };
  const commit = () => {
    if (cancelled.current) return;
    setEditing(false);
    const next = Number(draft);
    if (!draft.trim() || !Number.isInteger(next) || next < 0 || next > 9999) { setDraft(String(order)); return; }
    if (next !== order) void settings.update(app.id, { order: next });
  };
  return <td data-label="排序号">{editing ? <input autoFocus onFocus={event => event.currentTarget.select()} className="store-order-input" type="number" min={0} max={9999} step={1} aria-label={`${app.name}排序号`} value={draft} disabled={!settings.ready || settings.saving} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(String(order)); setEditing(false); } }} /> : <span className="store-order-value" role="button" tabIndex={0} aria-label={`编辑${app.name}排序号`} aria-disabled={!settings.ready || settings.saving} title="双击修改排序号，或按 Enter / F2 编辑" onDoubleClick={beginEditing} onKeyDown={event => { if (["Enter", "F2", " "].includes(event.key)) { event.preventDefault(); beginEditing(); } }}>{order}</span>}</td>;
}

function SidebarCell({ app, settings }: { app: ApplicationDefinition; settings: ApplicationPreferenceState }) {
  return <td data-label="左侧菜单显示"><label className="store-switch"><input type="checkbox" aria-label={`左侧菜单显示${app.name}`} checked={applicationPreference(app, settings.preferences).sidebar} disabled={!settings.ready || settings.saving} onChange={event => void settings.update(app.id, { sidebar: event.target.checked })} /><span aria-hidden="true" /></label></td>;
}

function OfficialPluginsStore({ initialPluginId, forceInitialPageMode, applicationSettings, onOpenSection, onReturnCatalog, onLanConnect }: StoreProps) {
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
  const returnPosition = useRef({ windowY: 0, mainY: 0, entry: null as HTMLElement | null });
  const [recent, setRecent] = useState(() => {
    try { return localStorage.getItem(`${plugin.id}.last-used`) !== null; } catch { return false; }
  });
  const [hardwareRecent, setHardwareRecent] = useState(() => {
    try { return localStorage.getItem(hardwarePlugin.id + ".last-used") !== null; } catch { return false; }
  });
  const [hardwareEnabled, setHardwareEnabled] = useState(() => {
    try { return localStorage.getItem(hardwareEnabledKey) !== "false"; } catch { return true; }
  });
  const [presentationFor, setPresentationFor] = useState<string | null>(null);
  const [wslEnabled, setWslEnabled] = useState(() => { try { return localStorage.getItem(wslEnabledKey) !== "false"; } catch { return true; } });
  const [wslRecent, setWslRecent] = useState(() => { try { return localStorage.getItem(`${wslPlugin.id}.last-used`) !== null; } catch { return false; } });
  const supported = runningInTauri && status?.supported === true;
  const enabled = (id: string) => id === plugin.id ? config.enabled : id === hardwarePlugin.id ? hardwareEnabled : id === wslPlugin.id ? wslEnabled : true;
  const applications = sortedApplications(applicationSettings.preferences).filter(app => source === "官方应用"
    && `${app.name} ${app.publisher} ${app.description} ${app.keywords ?? ""}`.toLowerCase().includes(keyword.trim().toLowerCase())
    && (category !== "已启用" || enabled(app.id)) && (category !== "桌面工具" || app.category === "桌面工具"));
  const visibleCount = applications.length;
  const [storePage, setStorePage] = useState(1);
  const [storePageSize, setStorePageSize] = useState(10);
  const pagedApplications = applications.slice((storePage - 1) * storePageSize, storePage * storePageSize);
  useEffect(() => { setStorePage(1); }, [keyword, category, source]);
  const canLaunch = supported && config.enabled && !busy && !!(config.path || status?.detectedPath);

  /** Capture the mode when opening so a mounted plugin never switches containers mid-edit. */
  function openPlugin(pluginId: string) {
    const app = applicationCatalog.find(item => item.id === pluginId);
    // Existing plugins retain their page/modal preference; newly catalogued modules use their owning page.
    if (app?.section && pluginId !== notesPlugin.id && pluginId !== claudePlugin.id) { onOpenSection(app.section); return; }
    returnPosition.current = {
      windowY: window.scrollY,
      mainY: document.getElementById("main-content")?.scrollTop ?? 0,
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
    if (runningInTauri) void operate(() => refresh());
    window.requestAnimationFrame(() => {
      const main = document.getElementById("main-content");
      if (main) main.scrollTop = position.mainY;
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
    if (activePlugin?.id !== plugin.id || !runningInTauri) return;
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
  }, [activePlugin?.id]);

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
    if (runningInTauri) void operate(() => refresh());
  }, []);

  useEffect(() => {
    try { localStorage.setItem(configKey, JSON.stringify(config)); }
    catch { setError("无法保存插件设置，请检查本地存储空间。"); }
  }, [config]);
  useEffect(() => {
    try { localStorage.setItem(hardwareEnabledKey, String(hardwareEnabled)); }
    catch { setError("无法保存插件设置，请检查本地存储空间。"); }
  }, [hardwareEnabled]);
  useEffect(() => {
    try { localStorage.setItem(wslEnabledKey, String(wslEnabled)); }
    catch { setError("无法保存插件设置，请检查本地存储空间。"); }
  }, [wslEnabled]);

  async function launch() {
    // 启动前重新检查，不能用打开设置时的进程快照永久禁用按钮。
    const current = await pluginsClient.wechatStatus();
    setStatus(current);
    if (!current.supported) throw new Error("微信多开插件仅支持 Windows 桌面端");
    if (current.runningProcesses > 0) throw new Error("请先从微信托盘菜单退出所有微信，再点击批量启动。不会自动结束已有微信。");
    const result = await pluginsClient.launchWechat(config.path || current.detectedPath || "", config.count);
    if (result.started > 0) {
      setRecent(true);
      try { localStorage.setItem(`${plugin.id}.last-used`, String(Date.now())); } catch { /* 不影响已提交的启动请求 */ }
    }
    setMessage(`已提交 ${result.started}/${result.requested} 个启动请求${result.failed ? `，${result.failed} 个未能启动，请检查客户端权限` : ""}。请查看实际微信窗口；启动请求数不代表多开成功。`);
    // 刷新失败不能覆盖已提交的启动结果，以免用户误以为可以立即重试。
    try { setStatus(await pluginsClient.wechatStatus()); }
    catch { setError("启动后未能刷新进程状态，请查看微信窗口后再操作。"); }
  }

  const application = activePlugin && (activePlugin.id === hardwarePlugin.id && (!hardwareEnabled || !runningInTauri)
    ? <p role="status">电脑信息当前已停用或运行环境不支持，请返回软件商店检查启用状态，并在桌面客户端使用。</p>
    : <PluginApplication pluginId={activePlugin.id} wslEnabled={wslEnabled} onLanConnect={onLanConnect ? (ip, platform, name) => { closePlugin(); onLanConnect(ip, platform, name); } : undefined} onNotify={activePlugin.presentation.mode === "modal" ? setMessage : undefined} onError={activePlugin.presentation.mode === "modal" ? setError : undefined} />);
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
        <button type="button" className="secondary store-refresh" disabled={!runningInTauri || busy} onClick={() => void operate(() => refresh())}><RefreshCw size={14} aria-hidden="true" />{busy ? "正在刷新…" : "刷新应用状态"}</button>
      </div>
      <div className="store-filter-row"><span>最近使用</span>{recent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(plugin.id); }}><MessageCircle size={14} aria-hidden="true" />微信多开</button>}{hardwareRecent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(hardwarePlugin.id); }}><Cpu size={14} aria-hidden="true" />电脑信息</button>}{wslRecent && <button type="button" className="store-recent" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); openPlugin(wslPlugin.id); }}><SquareTerminal size={14} aria-hidden="true" />WSL 管理</button>}{!recent && !hardwareRecent && !wslRecent && <small>暂无使用记录</small>}</div>
      {!runningInTauri && <p className="store-platform-note" role="status">浏览器预览不支持启动本地软件，请在 Windows 桌面客户端使用。</p>}
      {runningInTauri && status && !status.supported && <p className="store-platform-note" role="status">微信多开插件仅支持 Windows 桌面端。</p>}
      {applicationSettings.error && <p className="notes-error" role="alert">{applicationSettings.error}{!applicationSettings.ready && <button type="button" className="table-link" onClick={applicationSettings.retry}>重试读取</button>}</p>}
      <table className="store-table"><caption className="store-table-caption">应用列表</caption><thead><tr><th scope="col" title="排序号越小越靠前，双击数字修改，失焦或按 Enter 保存，Escape 取消。">排序号</th><th scope="col">软件名称</th><th scope="col">开发商</th><th scope="col">说明</th><th scope="col">价格</th><th scope="col">平台</th><th scope="col">状态</th><th scope="col">启用</th><th scope="col" title="隐藏菜单后仍可从商店打开，不会停止后台任务。">左侧菜单显示</th><th scope="col">操作</th></tr></thead><tbody>
        {pagedApplications.map(app => {
        const orderCell = <OrderCell app={app} settings={applicationSettings} />;
        const sidebarCell = <SidebarCell app={app} settings={applicationSettings} />;
        const Icon = app.icon;
        if (app.id === plugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><MessageCircle size={20} aria-hidden="true" /><div><strong>{plugin.name}</strong><small>v{plugin.version} · 实验性</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{plugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{plugin.description}<small>需安装微信客户端，多开效果取决于微信版本。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />{config.enabled ? "已内置" : "已停用"}</span></td>
          <td data-label="启用"><label className="store-switch"><input type="checkbox" aria-label="启用微信多开" checked={config.enabled} disabled={busy} onChange={event => setConfig(current => ({ ...current, enabled: event.target.checked }))} /><span aria-hidden="true" /></label></td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={plugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={plugin.id} aria-expanded={activePlugin?.id === plugin.id} onClick={() => openPlugin(plugin.id)}>管理</button><button type="button" className="table-link" disabled={!canLaunch} onClick={() => void operate(launch)}>启动</button></div></td>
        </tr>;
        if (app.id === hardwarePlugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><Cpu size={20} aria-hidden="true" /><div><strong>{hardwarePlugin.name}</strong><small>v{hardwarePlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{hardwarePlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{hardwarePlugin.description}<small>本机读取；Wi-Fi 密码仅临时显示且不进入复制或导出。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />{hardwareEnabled ? "已内置" : "已停用"}</span></td>
          <td data-label="启用"><label className="store-switch"><input type="checkbox" aria-label="启用电脑信息插件" checked={hardwareEnabled} disabled={busy} onChange={event => setHardwareEnabled(event.target.checked)} /><span aria-hidden="true" /></label></td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={hardwarePlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={hardwarePlugin.id} disabled={!hardwareEnabled || !runningInTauri} onClick={() => openPlugin(hardwarePlugin.id)}>查看</button></div></td>
        </tr>;
        if (app.id === wslPlugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><SquareTerminal size={20} aria-hidden="true" /><div><strong>{wslPlugin.name}</strong><small>v{wslPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{wslPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{wslPlugin.description}<small>仅限 Windows 桌面端；删除操作会永久删除发行版数据。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / WSL</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />{wslEnabled ? "已内置" : "已停用"}</span></td>
          <td data-label="启用"><label className="store-switch"><input type="checkbox" aria-label="启用 WSL 管理插件" checked={wslEnabled} onChange={event => setWslEnabled(event.target.checked)} /><span aria-hidden="true" /></label></td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={wslPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={wslPlugin.id} disabled={!wslEnabled} onClick={() => openPlugin(wslPlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === browserPlugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><Globe size={20} aria-hidden="true" /><div><strong>{browserPlugin.name}</strong><small>v{browserPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{browserPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{browserPlugin.description}<small>独立环境与基础参数；深层硬件指纹需定制内核。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows x64</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />内核按需下载</span></td>
          <td data-label="启用">已内置</td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={browserPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={browserPlugin.id} onClick={() => openPlugin(browserPlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === claudePlugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><Icon size={20} aria-hidden="true" /><div><strong>{claudePlugin.name}</strong><small>v{claudePlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{claudePlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{claudePlugin.description}<small>API Key 本地加密保存；切换前自动备份配置，支持直连、路由与聚合。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />已内置</span></td>
          <td data-label="启用">已内置</td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={claudePlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={claudePlugin.id} onClick={() => openPlugin(claudePlugin.id)}>管理</button></div></td>
        </tr>;
        if (app.id === notesPlugin.id) return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><NotebookPen size={20} aria-hidden="true" /><div><strong>{notesPlugin.name}</strong><small>v{notesPlugin.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{notesPlugin.publisher}</small></td>
          <td data-label="说明" className="store-description">{notesPlugin.description}<small>数据仅保存在本机，账号密码为明文存储，不做加密。</small></td>
          <td data-label="价格">免费</td><td data-label="平台">Windows / macOS / Linux</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />已内置</span></td>
          <td data-label="启用">已内置</td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions"><PresentationButton pluginId={notesPlugin.id} onOpen={setPresentationFor} /><button type="button" className="table-link" data-plugin-entry={notesPlugin.id} onClick={() => openPlugin(notesPlugin.id)}>打开</button></div></td>
        </tr>;
        return <tr key={app.id}>
          {orderCell}
          <td data-label="软件名称"><div className="store-app-name"><Icon size={20} aria-hidden="true" /><div><strong>{app.name}</strong><small>v{app.version} · 官方</small></div></div></td>
          <td data-label="开发商"><span className="store-publisher">官方</span><small>{app.publisher}</small></td>
          <td data-label="说明" className="store-description">{app.description}</td>
          <td data-label="价格">免费</td><td data-label="平台">{app.id === "cloudhub.lan-devices" ? "Windows / macOS" : "Windows / macOS / Linux"}</td>
          <td data-label="状态"><span className="store-state"><i aria-hidden="true" />已内置</span></td><td data-label="启用">已内置</td>
          {sidebarCell}
          <td data-label="操作"><div className="store-row-actions">{["cloudhub.lan-devices", "cloudhub.network-speed", "cloudhub.mail"].includes(app.id) && <PresentationButton pluginId={app.id} onOpen={setPresentationFor} />}<button type="button" className="table-link" data-plugin-entry={app.id} onClick={() => openPlugin(app.id)}>打开</button></div></td>
        </tr>;
        })}
      </tbody></table>
      {visibleCount === 0 && <div className="store-empty"><Package size={30} aria-hidden="true" /><h2>{source === "第三方应用" ? "暂无第三方应用" : "没有符合条件的应用"}</h2><p>{source === "官方应用" ? "尝试调整搜索词或切换应用分类。" : "当前先提供官方内置应用，后续上架的应用将在这里展示。"}</p><button type="button" className="secondary" onClick={() => { setSource("官方应用"); setCategory("全部"); setKeyword(""); }}>查看全部官方应用</button></div>}
      {visibleCount > 0 && <PaginationBar page={storePage} pageSize={storePageSize} total={visibleCount} onPageChange={setStorePage} onPageSizeChange={(size) => { setStorePageSize(size); setStorePage(1); }} />}
      <div className="store-list-footer"><span>内置应用随云枢工具箱更新</span></div>
    </section>
    {activePlugin && activeDefinition && <SharedDialog title={activePlugin.id === plugin.id ? "微信多开设置" : activeDefinition.name} size={activePlugin.presentation.size} className={`plugin-application-dialog plugin-modal-${activePlugin.presentation.size}`} onClose={closePlugin}>{application}</SharedDialog>}
    {presentationFor && <PluginPresentationDialog targetId={presentationFor} onClose={() => setPresentationFor(null)} />}
    {(message || error) && createPortal(<div className="ide-theme store-notification-layer"><div className="toast-notice store-notification" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true"><span>{[message, error].filter(Boolean).join(" ")}</span><button type="button" aria-label="关闭操作提示" title="关闭提示" onClick={() => { setMessage(""); setError(""); }}><X size={14} aria-hidden="true" /></button></div></div>, document.body)}
  </section>;
}

/** 插件的打开方式存在本机设置里，因此整页包一层 Provider。 */
export function OfficialPluginsPage(props: StoreProps) {
  return <PluginPresentationProvider><OfficialPluginsStore {...props} /></PluginPresentationProvider>;
}
