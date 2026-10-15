import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleStop, FolderOpen, MessageSquare, Play, Pause, RefreshCw, Save, SquareTerminal, Star, X, FileArchive, ScrollText, Settings2, House, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { WslDeleteConfirmation } from "./WslDeleteConfirmation";
import { runningInTauri } from "../../platform/api";
import { pluginsClient, type WslDistribution, type WslOnlineDistribution, type WslOperationLog } from "../../platform/clients/plugins";

interface Props { open: boolean; enabled: boolean; onClose: () => void }
type Tab = "home" | "install" | "settings" | "logs";
type InstallMode = "online" | "rootfs";
const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: "home", label: "首页", Icon: House }, { id: "install", label: "安装", Icon: FileArchive },
  { id: "settings", label: "设置", Icon: Settings2 }, { id: "logs", label: "运行日志", Icon: ScrollText },
];

function formatWslTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function isWslRunning(state: string): boolean { return state.trim().toLowerCase() === "running"; }
function isInstalledDistribution(items: WslDistribution[], name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  return items.some(item => item.name.trim().toLocaleLowerCase("en-US") === normalized);
}
function displayWslState(state: string): string {
  const normalized = state.trim().toLowerCase();
  if (normalized === "running") return "运行中";
  if (normalized === "stopped") return "已停止";
  return state.trim() || "状态未知";
}
function rootfsSuggestedName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const withoutExtension = base.replace(/\.(tar\.gz|tar\.xz|tar|wsl)$/i, "").replace(/^rootfs[-_]?/i, "");
  return withoutExtension.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128) || "NewDistribution";
}
function DistributionIcon({ name }: { name: string }) {
  const distro = name.toLowerCase();
  if (distro.includes("docker")) return <svg className="wsl-system-icon is-docker" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#0875d1"/><path d="M7 8h8a8 8 0 0 1 0 16H7z" fill="#fff"/><path d="M11 12h4a4 4 0 0 1 0 8h-4z" fill="#0875d1"/></svg>;
  if (distro.includes("ubuntu")) return <svg className="wsl-system-icon is-ubuntu" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#e95420"/><g fill="#fff"><circle cx="16" cy="7" r="2.4"/><circle cx="8.2" cy="20.5" r="2.4"/><circle cx="23.8" cy="20.5" r="2.4"/></g><g fill="none" stroke="#fff" strokeWidth="1.8"><path d="M13.6 8.7 9.5 16.1M10.6 21.1h8M22.5 18.3l-4.1-7.2"/><path d="M22.7 11.2a9.2 9.2 0 0 1 2.4 5.2M9 11.2a9.2 9.2 0 0 0-2.1 5.2M19 24.2a9.2 9.2 0 0 1-6 0"/></g></svg>;
  if (distro.includes("debian")) return <svg className="wsl-system-icon is-debian" viewBox="0 0 32 32" aria-hidden="true"><path d="M22.7 5.6c-3.1-2-8.3-1.4-11.2.8-3.7 2.8-4.8 8.2-2.8 12.2 1.8 3.7 6.8 5.8 10.3 3.5 2.2-1.5 3-5.2.9-6.9-1.6-1.4-4.9-.5-4.6 1.6.2 1.3 2.1 1.8 2.8.7.5-.8-.1-1.9-1-1.9-.6 0-1 .5-.9 1.1" fill="none" stroke="#d70a53" strokeWidth="2.1" strokeLinecap="round"/><path d="M23.3 7.3c4.1 3 5.2 8.2 3.4 12.5-1.6 3.8-5.3 6.5-9.5 6.5" fill="none" stroke="#d70a53" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  if (distro.includes("kali")) return <svg className="wsl-system-icon is-kali" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#367bf0"/><path d="M8 21c4-1 5-7 10-9 2-1 4 0 5 2-3 0-4 2-4 4 0 2 2 3 5 3-2 3-8 4-12 1l-3 2z" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (distro.includes("fedora")) return <svg className="wsl-system-icon is-fedora" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#294172"/><path d="M18.5 7.5a6 6 0 0 0-6 6v11h4v-8.2h6v-3.8h-6v-1a2 2 0 0 1 2-2h3v-4z" fill="#fff"/><path d="M12.5 18.5H10a3 3 0 0 0 0 6h2.5" fill="none" stroke="#fff" strokeWidth="2"/></svg>;
  return <svg className="wsl-system-icon is-linux" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="16" fill="#4b5563"/><path d="M11 21c-1-2 0-4 1-6V11a4 4 0 0 1 8 0v4c2 2 2 5 0 7-2 2-7 2-9-1z" fill="#fff"/><path d="M13 18h6M14 12h.1M18 12h.1" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

export function WslDashboardPlugin({ open, enabled, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("home");
  const [items, setItems] = useState<WslDistribution[]>([]);
  const [onlineItems, setOnlineItems] = useState<WslOnlineDistribution[]>([]);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const onlineRequestRef = useRef(false);
  const [logs, setLogs] = useState<WslOperationLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WslDistribution | null>(null);
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [distribution, setDistribution] = useState("Ubuntu");
  const [installMode, setInstallMode] = useState<InstallMode>("online");
  const [cloneName, setCloneName] = useState("");
  const [cloneLocation, setCloneLocation] = useState("");
  const [defaultInstallLocation, setDefaultInstallLocation] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [editingRemark, setEditingRemark] = useState<string | null>(null);
  const [expandedDistribution, setExpandedDistribution] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [onlineListError, setOnlineListError] = useState("");
  const [rootfsPath, setRootfsPath] = useState("");
  const [rootfsName, setRootfsName] = useState("");
  const [rootfsLocation, setRootfsLocation] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const selectedDistributionInstalled = isInstalledDistribution(items, distribution);
  useEffect(() => {
    if (!selectedDistributionInstalled) return;
    const suggestedName = `${distribution}-copy`.slice(0, 128);
    const base = defaultInstallLocation.trim().replace(/[\\/]+$/, "");
    setCloneName(suggestedName);
    setCloneLocation(base ? `${base}\\${suggestedName}` : "");
  }, [distribution, selectedDistributionInstalled, defaultInstallLocation]);

  async function refresh() {
    setBusy(true); setError("");
    try { setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 WSL 发行版列表"); }
    finally { setBusy(false); }
  }
  async function loadOnlineList() {
    if (onlineRequestRef.current) return;
    onlineRequestRef.current = true;
    setOnlineBusy(true); setOnlineListError("");
    try {
      const catalog = await pluginsClient.wslOnlineList();
      if (!catalog.length) throw new Error("WSL 未返回可安装的发行版，请重新加载目录。");
      setOnlineItems(catalog);
      setDistribution(current => catalog.some(item => item.name === current) ? current : catalog[0].name);
    } catch (reason) { setOnlineListError(reason instanceof Error ? reason.message : "无法读取 WSL 在线目录，请检查网络连接后重试"); }
    finally { onlineRequestRef.current = false; setOnlineBusy(false); }
  }
  async function loadSettings() {
    try { setDefaultInstallLocation((await pluginsClient.wslSettings()).defaultInstallLocation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 WSL 安装设置"); }
  }
  async function loadLogs() {
    try { setLogs(await pluginsClient.wslLogs()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 WSL 运行日志"); }
  }
  useEffect(() => { if (open && runningInTauri && enabled) { void refresh(); void loadSettings(); void loadLogs(); } }, [open, enabled]);
  useEffect(() => { if (open && tab === "logs" && runningInTauri && enabled) void loadLogs(); }, [open, tab, enabled]);
  useEffect(() => { if (open && tab === "install" && runningInTauri && enabled) void loadOnlineList(); }, [open, tab, enabled]);
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (root) root.inert = true;
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (deleteTargetRef.current) setDeleteTarget(null); else onClose(); } };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); if (root) root.inert = wasInert; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open, onClose]);

  async function control(item: WslDistribution, action: "start" | "stop" | "default" | "unregister", confirmationName?: string) {
    if (busy) return;
    if (action === "unregister" && confirmationName !== item.name) { setError(""); setMessage(""); setDeleteTarget(item); return; }
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslControl(item.name, action, confirmationName); if (action === "unregister") setDeleteTarget(null); setMessage(action === "unregister" ? `已删除发行版：${item.name}` : action === "default" ? `默认发行版已设为 ${item.name}` : action === "start" ? `已启动 ${item.name}` : `已停止 ${item.name}`); setItems(await pluginsClient.wslList()); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "WSL 操作失败");
      try { setItems(await pluginsClient.wslList()); } catch { /* 保留原操作错误，避免刷新失败覆盖故障原因。 */ }
    }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function backup(item: WslDistribution) {
    if (busy) return;
    setBusy(true); setBackingUp(true); setError(""); setMessage("");
    try { const savedPath = await pluginsClient.wslBackup(item.name); if (savedPath) setMessage(`已备份 ${item.name}：${savedPath}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "备份发行版失败"); }
    finally { setBusy(false); setBackingUp(false); if (tab === "logs") void loadLogs(); }
  }
  async function shutdown() {
    if (busy || !window.confirm("停止所有正在运行的 WSL 发行版？未保存的 Linux 工作可能丢失。")) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslShutdown(); setMessage("已停止所有 WSL 发行版。"); setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "停止 WSL 失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function installOnline() {
    if (selectedDistributionInstalled) return;
    if (busy || settingsBusy || !window.confirm(`将通过 Windows WSL 安装“${distribution}”${defaultInstallLocation.trim() ? `到“${defaultInstallLocation.trim()}”` : "到 WSL 默认位置"}。Windows 可能请求管理员权限或要求重启。继续？`)) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslInstall(distribution, defaultInstallLocation.trim()); await pluginsClient.wslSaveSettings(defaultInstallLocation.trim()); setMessage(`已提交 ${distribution} 安装请求。`); setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "安装发行版失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function cloneInstalledDistribution() {
    if (busy || !cloneName.trim() || !cloneLocation.trim()) { setError("请填写新实例名称和安装目录。"); return; }
    if (isInstalledDistribution(items, cloneName)) { setError("新实例名称已存在，请更换名称。"); return; }
    if (!window.confirm(`将“${distribution}”当前的 Linux 文件系统复制为新实例“${cloneName.trim()}”。原发行版不会被修改；过程需要临时磁盘空间，正在运行的发行版建议先停止后再复制。继续？`)) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslCloneDistribution(distribution, cloneName.trim(), cloneLocation.trim()); setMessage(`已复制为新实例 ${cloneName.trim()}。`); setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "复制发行版失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function chooseRootfs() {
    if (busy) return;
    setError("");
    try {
      const selected = await pluginsClient.wslSelectRootfsFile();
      if (selected) { const name = rootfsSuggestedName(selected); const base = defaultInstallLocation.trim().replace(/[\\/]+$/, ""); setRootfsPath(selected); setRootfsName(name); setRootfsLocation(base ? `${base}\\${name}` : ""); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "选择 RootFS 文件失败"); }
  }
  async function chooseInstallLocation() {
    if (settingsBusy || busy) return;
    setError("");
    try { const selected = await pluginsClient.wslSelectInstallLocation(); if (selected) setDefaultInstallLocation(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "选择 WSL 安装目录失败"); }
  }
  async function chooseRootfsLocation() {
    if (busy) return;
    setError("");
    try { const selected = await pluginsClient.wslSelectInstallLocation(); if (selected) setRootfsLocation(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "选择发行版安装目录失败"); }
  }
  async function installRootfs() {
    if (busy || !rootfsPath || !rootfsName.trim() || !rootfsLocation.trim()) { setError("请先选择 RootFS 文件，并填写实例名称和安装目录。"); return; }
    if (isInstalledDistribution(items, rootfsName)) { setError("该发行版已安装，请更换实例名称或从首页列表管理。"); return; }
    if (!window.confirm(`将把所选 RootFS 导入为“${rootfsName.trim()}”，安装目录为“${rootfsLocation.trim()}”。继续？`)) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslImportRootfs(rootfsName.trim(), rootfsLocation.trim(), rootfsPath); setMessage(`已导入发行版 ${rootfsName.trim()}。`); setItems(await pluginsClient.wslList()); setRootfsPath(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "导入 RootFS 失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function saveInstallLocation() {
    if (settingsBusy || busy) return;
    setSettingsBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslSaveSettings(defaultInstallLocation.trim()); setDefaultInstallLocation(defaultInstallLocation.trim()); setMessage("默认发行版安装目录已保存。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存 WSL 安装设置失败"); }
    finally { setSettingsBusy(false); }
  }
  async function openDistributionTool(item: WslDistribution, action: "terminal" | "folder") {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { if (action === "terminal") await pluginsClient.wslOpenTerminal(item.name); else await pluginsClient.wslOpenFolder(item.name); setMessage(action === "terminal" ? `已向终端发送打开请求：${item.name}。` : `已向资源管理器发送打开请求：${item.name}。`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "打开发行版工具失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function saveRemark(item: WslDistribution) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslSaveSettings(defaultInstallLocation.trim(), item.name, remarkDraft.trim()); setItems(await pluginsClient.wslList()); setEditingRemark(null); setMessage(`已保存 ${item.name} 的备注。`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存发行版备注失败"); }
    finally { setBusy(false); }
  }
  async function clearLogs() {
    if (busy || !window.confirm("清空 WSL 运行日志？此操作无法撤销。")) return;
    setBusy(true); setError("");
    try { await pluginsClient.wslClearLogs(); setLogs([]); setMessage("运行日志已清空。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "清空运行日志失败"); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return createPortal(<div className="modal-backdrop ide-theme">
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="wsl-dashboard-title" aria-busy={busy} className="modal-form-layout official-plugin-card wechat-settings-dialog" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex="0"]')).filter(element => element.matches(":not(:disabled)") && element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
      <header className="modal-head official-plugin-heading"><SquareTerminal size={22} aria-hidden="true" /><div><h2 id="wsl-dashboard-title">WSL 管理</h2><p>CloudHub Tools · Windows · 本机运行</p></div><DialogHeaderActions><button type="button" className="close" aria-label="关闭 WSL 管理" onClick={onClose}><X size={16} aria-hidden="true" /></button></DialogHeaderActions></header>
      <nav className="wsl-tabs" role="tablist" aria-label="WSL 管理页面">{TABS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" id={`wsl-tab-${id}`} aria-selected={tab === id} aria-controls={`wsl-panel-${id}`} className={tab === id ? "is-active" : ""} onClick={() => { setTab(id); setError(""); setMessage(""); }}><Icon size={15} aria-hidden="true" />{label}</button>)}</nav>
      <div className="modal-body">
        {!enabled && <p role="status">插件已停用，请回到软件列表启用后再管理发行版。</p>}
        {!runningInTauri && <p role="status">浏览器预览无法访问本机 WSL，请在 Windows 桌面客户端使用。</p>}
        {runningInTauri && <>
          <div className="wsl-tab-panel" role="tabpanel" id={`wsl-panel-${tab}`} aria-labelledby={`wsl-tab-${tab}`}>
            {tab === "home" && <>
              <p>停止发行版会保留数据；删除发行版会永久移除其 Linux 文件与设置，请先备份。</p>
              <div className="official-plugin-actions"><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{busy ? "正在刷新…" : "刷新列表"}</button><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void shutdown()}><CircleStop size={14} aria-hidden="true" />停止全部 WSL</button></div>
              {enabled && !busy && !error && items.length === 0 && <p role="status">未检测到已注册的 WSL 发行版。可在“安装”页添加发行版。</p>}
              {items.length > 0 && <div className="wsl-distro-list">{items.map(item => {
                const running = isWslRunning(item.state);
                const expanded = expandedDistribution === item.name;
                return <article key={item.name} className={`wsl-distro-row ${running ? "is-running" : "is-stopped"} ${expanded ? "is-expanded" : ""}`}>
                  <div className="wsl-distro-main">
                    <button type="button" className={`wsl-row-power ${running ? "is-running" : "is-stopped"}`} disabled={busy} aria-label={`${running ? "停止" : "启动"} ${item.name}`} title={`${running ? "停止" : "启动"} ${item.name}`} onClick={() => void control(item, running ? "stop" : "start")}>{running ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>
                    <DistributionIcon name={item.name} />
                    <div className="wsl-distro-title"><strong title={item.name}>{item.name}</strong><span className={`wsl-row-state ${running ? "is-running" : "is-stopped"}`}><i aria-hidden="true" />{displayWslState(item.state)}{item.isDefault && <em>默认</em>}</span><small className="wsl-row-last-start">最后启动：{formatWslTimestamp(item.lastStartedAt)}</small>{item.remark && <small className="wsl-row-remark">备注：{item.remark}</small>}</div>
                    <div className="wsl-row-tools"><button type="button" className="wsl-icon-action" title={`在终端中打开 ${item.name}`} aria-label={`在终端中打开 ${item.name}`} disabled={busy} onClick={() => void openDistributionTool(item, "terminal")}><SquareTerminal size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`编辑 ${item.name} 的备注`} aria-label={`编辑 ${item.name} 的备注`} disabled={busy} onClick={() => { setExpandedDistribution(item.name); setEditingRemark(editingRemark === item.name ? null : item.name); setRemarkDraft(item.remark); }}><MessageSquare size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`打开 ${item.name} 的文件夹`} aria-label={`打开 ${item.name} 的文件夹`} disabled={busy} onClick={() => void openDistributionTool(item, "folder")}><FolderOpen size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={expanded ? `收起 ${item.name} 详情` : `展开 ${item.name} 管理操作`} aria-label={expanded ? `收起 ${item.name} 详情` : `展开 ${item.name} 管理操作`} aria-expanded={expanded} aria-controls={`wsl-details-${encodeURIComponent(item.name)}`} onClick={() => setExpandedDistribution(expanded ? null : item.name)}>{expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button></div>
                  </div>
                  {expanded && <div className="wsl-distro-expanded" id={`wsl-details-${encodeURIComponent(item.name)}`}><div className="wsl-expanded-meta"><span>WSL {item.version ?? "未知"}</span><span>安装时间：{formatWslTimestamp(item.installedAt)}</span></div><div className="wsl-distro-actions">{!running ? <button type="button" className="secondary wsl-action-start" disabled={busy} onClick={() => void control(item, "start")}><Play size={14} aria-hidden="true" />启动</button> : <button type="button" className="secondary wsl-action-stop" disabled={busy} onClick={() => void control(item, "stop")}><CircleStop size={14} aria-hidden="true" />停止</button>}{!item.isDefault && <button type="button" className="secondary" disabled={busy} aria-label={`将 ${item.name} 设为默认发行版`} onClick={() => void control(item, "default")}><Star size={14} aria-hidden="true" />设为默认</button>}<button type="button" className="secondary" disabled={busy} onClick={() => void backup(item)}><FileArchive size={14} aria-hidden="true" />{backingUp ? "正在备份…" : "备份"}</button><button type="button" className="secondary" disabled={busy} onClick={() => void control(item, "unregister")}><Trash2 size={14} aria-hidden="true" />删除</button></div>{editingRemark === item.name && <div className="wsl-distro-remark"><label htmlFor={`wsl-remark-${encodeURIComponent(item.name)}`}>发行版备注</label><input id={`wsl-remark-${encodeURIComponent(item.name)}`} maxLength={500} value={remarkDraft} disabled={busy} onChange={event => setRemarkDraft(event.target.value)} placeholder="添加用途或环境说明" /><button type="button" className="secondary" disabled={busy} onClick={() => void saveRemark(item)}><Save size={14} aria-hidden="true" />保存备注</button></div>}</div>}
                </article>;
              })}</div>}
            </>}
            {tab === "install" && <>
              <p>选择安装来源，然后按提示填写发行版和目标位置。</p>
              <div className="wsl-install-method-switch" role="group" aria-label="安装来源">
                <button type="button" aria-pressed={installMode === "online"} className={installMode === "online" ? "is-active" : ""} onClick={() => setInstallMode("online")}>在线发行版</button>
                <button type="button" aria-pressed={installMode === "rootfs"} className={installMode === "rootfs" ? "is-active" : ""} onClick={() => setInstallMode("rootfs")}>本地 RootFS</button>
              </div>
              {installMode === "online" ? <section className="wsl-install-settings wsl-install-card" aria-labelledby="wsl-online-install-title">
                <h3 id="wsl-online-install-title">在线安装</h3>
                <div className="wsl-online-install-row"><label htmlFor="wsl-distro-install">发行版</label><select id="wsl-distro-install" value={onlineItems.length ? distribution : ""} disabled={busy || !enabled || !onlineItems.length} onChange={event => setDistribution(event.target.value)}>{onlineItems.length === 0 && <option value="">{onlineBusy ? "正在读取在线目录…" : "在线目录未加载，请重新加载"}</option>}{onlineItems.map(item => { const installed = isInstalledDistribution(items, item.name); return <option key={item.name} value={item.name}>{item.friendlyName}{installed ? "（已安装，可复制）" : ""}</option>; })}</select><button type="button" className="secondary" disabled={busy || onlineBusy || !enabled} onClick={() => void loadOnlineList()}><RefreshCw size={14} aria-hidden="true" />{onlineBusy ? "读取中…" : onlineListError ? "重新加载" : "刷新目录"}</button>{selectedDistributionInstalled ? <span className="wsl-installed-hint">已安装</span> : <button type="button" className="secondary" disabled={busy || onlineBusy || settingsBusy || !enabled || !onlineItems.length} onClick={() => void installOnline()}>安装</button>}</div>
                {onlineListError && <p role="alert" className="wsl-online-list-error">{onlineListError} {onlineItems.length ? "已保留上次读取的目录，可继续选择或重新加载。" : "可点击重新加载，或选择本地 RootFS 安装。"}</p>}
                {selectedDistributionInstalled && <div className="wsl-clone-form"><p>此发行版已安装。可复制当前文件系统为独立实例，原实例保持不变。</p><div className="wsl-clone-fields"><label htmlFor="wsl-clone-name">新实例名称<input id="wsl-clone-name" value={cloneName} maxLength={128} disabled={busy || !enabled} onChange={event => setCloneName(event.target.value)} spellCheck={false} /></label><label htmlFor="wsl-clone-location">新实例安装目录<div className="wsl-rootfs-file-row"><input id="wsl-clone-location" value={cloneLocation} disabled={busy || !enabled} onChange={event => setCloneLocation(event.target.value)} placeholder="选择一个新的空目录" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfsLocation()}>选择目录</button></div></label></div><small>将临时导出并导入当前文件系统；需要足够的临时磁盘空间。</small><button type="button" className="secondary" disabled={busy || !enabled || !cloneName.trim() || !cloneLocation.trim()} onClick={() => void cloneInstalledDistribution()}>{busy ? "正在复制…" : "复制为新实例"}</button></div>}
              </section> : <section className="wsl-install-settings wsl-install-card" aria-labelledby="wsl-rootfs-title">
                <h3 id="wsl-rootfs-title">从本地 RootFS 安装</h3>
                <div className="wsl-form-grid">
                  <div className="wsl-form-field wsl-form-wide"><label htmlFor="wsl-rootfs-file">RootFS 文件（.tar、.tar.gz、.tar.xz、.wsl）</label><div className="wsl-rootfs-file-row"><input id="wsl-rootfs-file" value={rootfsPath} readOnly placeholder="请选择本地文件" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfs()}>选择文件</button></div></div>
                  <label className="wsl-form-field" htmlFor="wsl-rootfs-name">实例名称<input id="wsl-rootfs-name" value={rootfsName} maxLength={128} disabled={busy || !enabled} onChange={event => setRootfsName(event.target.value)} placeholder="例如 Ubuntu-Dev" spellCheck={false} /></label>
                  <div className="wsl-form-field"><label htmlFor="wsl-rootfs-location">实例安装目录</label><div className="wsl-rootfs-file-row"><input id="wsl-rootfs-location" value={rootfsLocation} disabled={busy || !enabled} onChange={event => setRootfsLocation(event.target.value)} placeholder="选择一个新的空目录" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfsLocation()}>选择目录</button></div></div>
                </div>
                <div className="wsl-rootfs-footer"><small>导入需要一个新的空目录。源文件路径不会写入运行日志。</small><button type="button" className="secondary" disabled={busy || !enabled || !rootfsPath || !rootfsName.trim() || !rootfsLocation.trim()} onClick={() => void installRootfs()}>{busy ? "正在导入…" : "创建安装"}</button></div>
              </section>}
            </>}
            {tab === "settings" && <>
              <p>设置在线安装使用的默认位置。留空时由 WSL 选择系统默认目录。</p>
              <section className="wsl-install-settings" aria-labelledby="wsl-install-location-label"><label id="wsl-install-location-label" htmlFor="wsl-install-location">默认发行版安装目录</label><div className="wsl-install-location-controls"><input id="wsl-install-location" value={defaultInstallLocation} disabled={busy || settingsBusy || !enabled} onChange={event => setDefaultInstallLocation(event.target.value)} placeholder="留空时使用 WSL 默认位置" spellCheck={false} /><button type="button" className="secondary" disabled={busy || settingsBusy || !enabled} onClick={() => void chooseInstallLocation()}>选择目录</button><button type="button" className="secondary" disabled={busy || settingsBusy || !enabled} onClick={() => void saveInstallLocation()}>{settingsBusy ? "保存中…" : "保存"}</button></div><small>本地 RootFS 安装目录在“安装”页按实例单独指定。</small></section>
            </>}
            {tab === "logs" && <><div className="wsl-logs-heading"><div><h3>运行日志</h3><p>最多保留最近 200 条本机操作记录。</p></div><button type="button" className="secondary" disabled={busy || logs.length === 0} onClick={() => void clearLogs()}><Trash2 size={14} aria-hidden="true" />清空日志</button></div>{logs.length === 0 ? <p role="status">暂无运行日志。</p> : <ol className="wsl-log-list">{logs.map((entry, index) => <li key={`${entry.timestamp}-${index}`}><time dateTime={new Date(entry.timestamp).toISOString()}>{formatWslTimestamp(entry.timestamp)}</time><span>{entry.action === "注销" ? "删除发行版" : entry.action === "关闭全部 WSL" ? "停止全部 WSL" : entry.action}</span><span>{entry.distribution || "全部发行版"}</span><strong className={entry.success ? "is-success" : "is-failure"}>{entry.success ? "成功" : "失败"}</strong></li>)}</ol>}<small>日志只记录时间、操作、发行版名称和结果；不会保存目录、RootFS 文件路径或 WSL 命令输出。</small></>}
          </div>
          {error && <p role="alert" className="hardware-info-error">{error}</p>}{message && <p role="status">{message}</p>}
          <details><summary>插件权限与支持范围</summary><ul><li>仅在 Windows 桌面端管理本机 WSL；浏览器预览不提供原生 WSL 能力。</li><li>支持在线安装、本地 RootFS 导入、启动、停止、设为默认、终端、文件夹、备注、TAR 备份及删除；删除前须输入发行版名称确认。</li><li>迁移、VHDX 挂载、计划任务、端口转发、代理和 USB 管理尚未实现。</li></ul></details>
        </>}
      </div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button></div>
    </section>
    {deleteTarget && <WslDeleteConfirmation key={deleteTarget.name} name={deleteTarget.name} parentRef={dialogRef} busy={busy} backingUp={backingUp} error={error} message={message} onCancel={() => setDeleteTarget(null)} onBackup={() => void backup(deleteTarget)} onConfirm={confirmationName => void control(deleteTarget, "unregister", confirmationName)} />}
  </div>, document.body);
}
