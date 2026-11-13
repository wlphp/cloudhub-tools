import { ToastNotice } from "../../shared/ToastNotice";
import { useListOrder } from "../../shared/useListOrder";
import { SortSelectionControls } from "../../shared/SortSelectionControls";
import { ListSortHandle } from "../../shared/ListSortHandle";
import { useSortableDrag } from "../../shared/useSortableDrag";
import { useDialogDocument } from "../../shared/DialogDocument";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CircleStop, Copy, Download, FolderInput, FolderOpen, Info, MessageSquare, MoreVertical, Play, Pause, RefreshCw, Save, SquareTerminal, Star, FileArchive, ScrollText, Settings2, House, Trash2 } from "lucide-react";
import { MoreMenu } from "../../shared/MoreMenu";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WslDeleteConfirmation } from "./WslDeleteConfirmation";
import { invoke, runningInTauri, runningOnPhone } from "../../platform/api";
import { pluginsClient, type WslDistribution, type WslDistributionDetails, type WslDistroConfig, type WslMirrorDistro, type WslMirrorInstallProgress, type WslOnlineDistribution, type WslOperationLog, type WslRuntimeInfo } from "../../platform/clients/plugins";
import { networkClient, type ProxyCandidate } from "../../platform/clients/network";

interface Props { open: boolean; enabled: boolean }
type Tab = "home" | "install" | "settings" | "logs";
type InstallMode = "online" | "mirror" | "rootfs";
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
function formatWslBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "无法获取";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
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
function onlineInstallDirectory(basePath: string, distroName: string): string {
  const base = basePath.trim().replace(/[\\/]+$/, "");
  if (!base) return "";
  const folder = distroName.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  return folder ? `${base}\\${folder}` : base;
}
function mirrorSuggestedName(distro: WslMirrorDistro): string {
  return `${distro.name}-${distro.version}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "Linux";
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

export function WslDashboardPlugin({ open, enabled }: Props) {
  const document = useDialogDocument();
  const window = document.defaultView!;
  const [tab, setTab] = useState<Tab>("home");
  const [items, setItems] = useState<WslDistribution[]>([]);
  const [onlineItems, setOnlineItems] = useState<WslOnlineDistribution[]>([]);
  const [mirrorItems, setMirrorItems] = useState<WslMirrorDistro[]>([]);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const mirrorRequestRef = useRef(false);
  const [mirrorSelection, setMirrorSelection] = useState("");
  const [mirrorInstanceName, setMirrorInstanceName] = useState("");
  const [mirrorLocation, setMirrorLocation] = useState("");
  const [mirrorProgress, setMirrorProgress] = useState<WslMirrorInstallProgress | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const onlineRequestRef = useRef(false);
  const [logs, setLogs] = useState<WslOperationLog[]>([]);
  const [logsQuery, setLogsQuery] = useState("");
  const [logsResultFilter, setLogsResultFilter] = useState<"all" | "success" | "failure">("all");
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(10);
  const [runtimeInfo, setRuntimeInfo] = useState<WslRuntimeInfo | null>(null);
  const [runtimeInfoBusy, setRuntimeInfoBusy] = useState(false);
  const [runtimeInfoError, setRuntimeInfoError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wslUpdating, setWslUpdating] = useState(false);
  const [confirmWslUpdate, setConfirmWslUpdate] = useState(false);
  const [wslProxyUrl, setWslProxyUrl] = useState("");
  const [wslProxyCandidates, setWslProxyCandidates] = useState<ProxyCandidate[]>([]);
  const [wslProxyDetecting, setWslProxyDetecting] = useState(false);
  const [wslProxyDetected, setWslProxyDetected] = useState(false);
  const [installing, setInstalling] = useState<{ distribution: string; mode: InstallMode } | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WslDistribution | null>(null);
  const [moveTarget, setMoveTarget] = useState<WslDistribution | null>(null);
  const [moveLocation, setMoveLocation] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [confirmMove, setConfirmMove] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<WslDistribution | null>(null);
  const [cloneDialogName, setCloneDialogName] = useState("");
  const [cloneDialogLocation, setCloneDialogLocation] = useState("");
  const [cloneDialogBusy, setCloneDialogBusy] = useState(false);
  const [cloneDialogError, setCloneDialogError] = useState("");
  const [detailTarget, setDetailTarget] = useState<WslDistribution | null>(null);
  const [detailInfo, setDetailInfo] = useState<WslDistributionDetails | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailFeedback, setDetailFeedback] = useState("");
  const [configTarget, setConfigTarget] = useState<WslDistribution | null>(null);
  const [distroConfig, setDistroConfig] = useState<WslDistroConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [distribution, setDistribution] = useState("Ubuntu");
  const [installMode, setInstallMode] = useState<InstallMode>("mirror");
  const [cloneName, setCloneName] = useState("");
  const [cloneLocation, setCloneLocation] = useState("");
  const [defaultInstallLocation, setDefaultInstallLocation] = useState("");
  const [onlineLocation, setOnlineLocation] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [editingRemark, setEditingRemark] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [remarkSaving, setRemarkSaving] = useState(false);
  const [remarkError, setRemarkError] = useState("");
  const [onlineListError, setOnlineListError] = useState("");
  const [rootfsPath, setRootfsPath] = useState("");
  const [rootfsName, setRootfsName] = useState("");
  const [rootfsLocation, setRootfsLocation] = useState("");
  const listOrder = useListOrder("cloudhub.wsl.distribution-order");
  const [sorting, setSorting] = useState(false);
  const sortedItems = listOrder.sort(items, item => item.name);
  const sortIds = sortedItems.map(item => item.name);
  // Native operations remain independent of the saved display order.
  const sortDisabled = !listOrder.ready || listOrder.saving || busy || !enabled;
  function moveItem(source: string, target: string) { if (sorting && !sortDisabled) void listOrder.move(sortIds, source, target); }
  const drag = useSortableDrag({ selector: "[data-wsl-sort-id]", attribute: "data-wsl-sort-id", enabled: sorting && !sortDisabled, onMove: moveItem });
  const dialogRef = useRef<HTMLElement>(null);
  const selectedDistributionInstalled = isInstalledDistribution(items, distribution);
  const selectedMirror = mirrorItems.find(item => item.id === mirrorSelection) ?? null;
  const filteredLogs = logs.filter(entry => {
    if (logsResultFilter === "success" && !entry.success) return false;
    if (logsResultFilter === "failure" && entry.success) return false;
    const query = logsQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) return true;
    const action = entry.action === "注销" ? "删除发行版" : entry.action === "关闭全部 WSL" ? "停止全部 WSL" : entry.action;
    return `${formatWslTimestamp(entry.timestamp)} ${action} ${entry.distribution || "全部发行版"} ${entry.success ? "成功" : "失败"}`.toLocaleLowerCase("zh-CN").includes(query);
  });
  const logPageCount = Math.max(1, Math.ceil(filteredLogs.length / logsPageSize));
  const safeLogsPage = Math.min(logsPage, logPageCount);
  const visibleLogs = filteredLogs.slice((safeLogsPage - 1) * logsPageSize, safeLogsPage * logsPageSize);
  useEffect(() => { setOnlineLocation(onlineInstallDirectory(defaultInstallLocation, distribution)); }, [defaultInstallLocation, distribution]);
  useEffect(() => { setMirrorLocation(onlineInstallDirectory(defaultInstallLocation, mirrorInstanceName)); }, [defaultInstallLocation, mirrorInstanceName]);
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
  async function loadMirrorList() {
    if (mirrorRequestRef.current || busy) return;
    mirrorRequestRef.current = true; setMirrorBusy(true); setOnlineListError("");
    try {
      const catalog = await pluginsClient.wslMirrorList();
      if (!catalog.length) throw new Error("当前设备架构没有可用的镜像发行版。");
      setMirrorItems(catalog);
      const selected = catalog.find(item => item.id === mirrorSelection) ?? catalog[0];
      setMirrorSelection(selected.id);
      setMirrorInstanceName(current => current || mirrorSuggestedName(selected));
    } catch (reason) { setOnlineListError(reason instanceof Error ? reason.message : "无法读取在线镜像目录，请检查网络后重试"); }
    finally { mirrorRequestRef.current = false; setMirrorBusy(false); }
  }
  async function loadSettings() {
    try { setDefaultInstallLocation((await pluginsClient.wslSettings()).defaultInstallLocation ?? ""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 WSL 安装设置"); }
  }
  async function loadRuntimeInfo() {
    setRuntimeInfoBusy(true); setRuntimeInfoError("");
    try { setRuntimeInfo(await pluginsClient.wslRuntimeInfo()); }
    catch (reason) { setRuntimeInfo(null); setRuntimeInfoError(reason instanceof Error ? reason.message : "无法读取 WSL 版本信息"); }
    finally { setRuntimeInfoBusy(false); }
  }
  async function openWindowsProxySettings() {
    setError(""); setMessage("");
    try {
      await invoke<string>("windows_toolbox_open", { action: "system-proxy" });
      setMessage("已打开 Windows 网络代理设置。WSL 在线下载使用 Windows 的网络环境；请在系统代理中启用代理后重试。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开 Windows 网络代理设置"); }
  }
  async function loadLogs() {
    try { setLogs(await pluginsClient.wslLogs()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 WSL 运行日志"); }
  }
  useEffect(() => { if (open && runningInTauri && !runningOnPhone && enabled) { void refresh(); void loadSettings(); void loadLogs(); void loadRuntimeInfo(); } }, [open, enabled]);
  useEffect(() => { if (open && tab === "logs" && runningInTauri && !runningOnPhone && enabled) void loadLogs(); }, [open, tab, enabled]);
  useEffect(() => { if (open && tab === "install" && installMode === "online" && runningInTauri && !runningOnPhone && enabled) void loadOnlineList(); }, [open, tab, installMode, enabled]);
  useEffect(() => { if (open && tab === "install" && installMode === "mirror" && runningInTauri && !runningOnPhone && enabled) void loadMirrorList(); }, [open, tab, installMode, enabled]);

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
  async function selectMoveLocation() {
    setMoveError("");
    try { const selected = await pluginsClient.wslSelectMoveLocation(); if (selected) setMoveLocation(selected); }
    catch (reason) { setMoveError(reason instanceof Error ? reason.message : "无法选择目标目录"); }
  }
  async function moveDistribution() {
    if (!moveTarget || !moveLocation.trim() || busy) return;
    setBusy(true); setMoveBusy(true); setMoveError(""); setError(""); setMessage("");
    try {
      await pluginsClient.wslMove(moveTarget.name, moveLocation.trim());
      setMessage(`已移动 ${moveTarget.name} 到 ${moveLocation.trim()}。`);
      setMoveTarget(null); setMoveLocation("");
    } catch (reason) { setMoveError(reason instanceof Error ? reason.message : "移动发行版失败"); }
    finally {
      try { setItems(await pluginsClient.wslList()); } catch { /* 移动结果或操作错误不应被列表刷新失败覆盖 */ }
      setBusy(false); setMoveBusy(false); if (tab === "logs") void loadLogs();
    }
  }
  async function shutdown() {
    if (busy || !window.confirm("停止所有正在运行的 WSL 发行版？未保存的 Linux 工作可能丢失。")) return;
    setBusy(true); setError(""); setMessage("");
    try { await pluginsClient.wslShutdown(); setMessage("已停止所有 WSL 发行版。"); setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "停止 WSL 失败"); }
    finally { setBusy(false); if (tab === "logs") void loadLogs(); }
  }
  async function updateWsl() {
    if (busy) return;
    setBusy(true); setWslUpdating(true); setError(""); setMessage("");
    try {
      await pluginsClient.wslUpdate(wslProxyUrl.trim() || null);
      try {
        const updatedInfo = await pluginsClient.wslRuntimeInfo();
        setRuntimeInfo(updatedInfo); setRuntimeInfoError("");
        setMessage(updatedInfo.compatible === true
          ? `WSL 已升级并符合最低兼容版本（${updatedInfo.currentVersion}）。`
          : updatedInfo.currentVersion
            ? `升级命令已完成，当前版本为 ${updatedInfo.currentVersion}，仍低于最低兼容版本 ${updatedInfo.minimumSupportedVersion}。请重启 Windows 后重新检查。`
            : "升级命令已完成，但暂时无法读取版本；请重启 Windows 后重新检查。");
      } catch {
        setRuntimeInfo(null); setRuntimeInfoError("升级命令已完成，但无法重新读取版本信息。");
        setMessage("升级命令已完成。请重启 Windows 后重新检查 WSL 版本。");
      }
      try { setItems(await pluginsClient.wslList()); } catch { /* 更新成功不应被列表刷新错误覆盖 */ }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新 WSL 失败"); }
    finally { setBusy(false); setWslUpdating(false); if (tab === "logs") void loadLogs(); }
  }
  async function detectWslProxy() {
    if (wslProxyDetecting || busy) return;
    setWslProxyDetecting(true); setError("");
    try {
      const candidates = await networkClient.detect();
      setWslProxyCandidates(candidates); setWslProxyDetected(true);
      if (!candidates.length) setMessage("未检测到本机 HTTP/HTTPS 代理，可手动填写；留空则沿用当前进程网络设置。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取本机代理配置失败"); }
    finally { setWslProxyDetecting(false); }
  }
  async function installOnline() {
    if (selectedDistributionInstalled) return;
    if (busy || settingsBusy || !window.confirm(`将通过 Windows WSL 安装“${distribution}”${onlineLocation.trim() ? `到“${onlineLocation.trim()}”` : "到 WSL 默认位置"}。Windows 可能请求管理员权限或要求重启。继续？`)) return;
    setBusy(true); setInstalling({ distribution, mode: "online" }); setError(""); setMessage("");
    try { await pluginsClient.wslInstall(distribution, onlineLocation.trim()); await pluginsClient.wslSaveSettings(defaultInstallLocation.trim()); setMessage(`已提交 ${distribution} 安装请求。`); setItems(await pluginsClient.wslList()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "安装发行版失败"); }
    finally { setBusy(false); setInstalling(null); if (tab === "logs") void loadLogs(); }
  }
  async function chooseOnlineLocation() {
    if (settingsBusy || busy) return;
    setError("");
    try { const selected = await pluginsClient.wslSelectInstallLocation(); if (selected) setOnlineLocation(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "选择发行版安装目录失败"); }
  }
  async function installMirror() {
    if (!selectedMirror || busy || !mirrorInstanceName.trim() || !mirrorLocation.trim()) return;
    if (isInstalledDistribution(items, mirrorInstanceName)) { setError("该实例名称已存在，请更换名称。"); return; }
    if (!window.confirm(`将从测速结果中选择最快镜像，下载并校验归档格式 ${selectedMirror.name} ${selectedMirror.version}，再导入为“${mirrorInstanceName.trim()}”到“${mirrorLocation.trim()}”。继续？`)) return;
    setBusy(true); setInstalling({ distribution: mirrorInstanceName.trim(), mode: "mirror" }); setMirrorProgress(null); setError(""); setMessage("");
    try {
      await pluginsClient.wslMirrorInstall({ distribution: selectedMirror.name, version: selectedMirror.version, instanceName: mirrorInstanceName.trim(), installLocation: mirrorLocation.trim() }, setMirrorProgress);
      await pluginsClient.wslSaveSettings(defaultInstallLocation.trim());
      setMessage(`已通过镜像安装 ${mirrorInstanceName.trim()}。`); setItems(await pluginsClient.wslList());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "镜像安装失败"); }
    finally { setBusy(false); setInstalling(null); if (tab === "logs") void loadLogs(); }
  }
  async function chooseMirrorLocation() {
    if (busy) return;
    setError("");
    try { const selected = await pluginsClient.wslSelectInstallLocation(); if (selected) setMirrorLocation(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "选择镜像安装目录失败"); }
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
  function openCloneDialog(item: WslDistribution) {
    const safeName = [item.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""), "copy"].filter(Boolean).join("-").slice(0, 128);
    const base = defaultInstallLocation.trim().replace(/[\\/]+$/, "");
    setCloneTarget(item); setCloneDialogName(safeName); setCloneDialogLocation(base ? base + "\\" + safeName : ""); setCloneDialogBusy(false); setCloneDialogError("");
  }
  async function chooseCloneDialogLocation() {
    setCloneDialogError("");
    try { const selected = await pluginsClient.wslSelectInstallLocation(); if (selected) setCloneDialogLocation(selected); }
    catch (reason) { setCloneDialogError(reason instanceof Error ? reason.message : "选择克隆目录失败"); }
  }
  async function cloneFromList() {
    if (!cloneTarget || busy || cloneDialogBusy) return;
    if (!cloneDialogName.trim() || !cloneDialogLocation.trim()) { setCloneDialogError("请填写新实例名称和安装目录。"); return; }
    if (cloneDialogName.trim().startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(cloneDialogName.trim())) { setCloneDialogError("实例名称请使用字母、数字、点、下划线或连字符，且不能以连字符开头。"); return; }
    if (isInstalledDistribution(items, cloneDialogName)) { setCloneDialogError("新实例名称已存在，请更换名称。"); return; }
    setBusy(true); setCloneDialogBusy(true); setCloneDialogError(""); setError(""); setMessage("");
    try {
      await pluginsClient.wslCloneDistribution(cloneTarget.name, cloneDialogName.trim(), cloneDialogLocation.trim());
      setMessage("已将 " + cloneTarget.name + " 克隆为 " + cloneDialogName.trim() + "。");
      setCloneTarget(null); setCloneDialogName(""); setCloneDialogLocation("");
    } catch (reason) { setCloneDialogError(reason instanceof Error ? reason.message : "克隆发行版失败"); }
    finally {
      try { setItems(await pluginsClient.wslList()); } catch { /* 克隆结果不应被列表刷新错误覆盖 */ }
      setBusy(false); setCloneDialogBusy(false); if (tab === "logs") void loadLogs();
    }
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
    setBusy(true); setInstalling({ distribution: rootfsName.trim(), mode: "rootfs" }); setError(""); setMessage("");
    try { await pluginsClient.wslImportRootfs(rootfsName.trim(), rootfsLocation.trim(), rootfsPath); setMessage(`已导入发行版 ${rootfsName.trim()}。`); setItems(await pluginsClient.wslList()); setRootfsPath(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "导入 RootFS 失败"); }
    finally { setBusy(false); setInstalling(null); if (tab === "logs") void loadLogs(); }
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
  async function showDetails(item: WslDistribution) {
    setDetailTarget(item); setDetailInfo(null); setDetailFeedback(""); setDetailBusy(true);
    try { setDetailInfo(await pluginsClient.wslDetails(item.name)); }
    catch (reason) { setDetailFeedback(reason instanceof Error ? reason.message : "无法读取发行版详细信息"); }
    finally { setDetailBusy(false); }
  }
  async function copyWslIp() {
    if (!detailInfo?.ipAddress) return;
    try { await navigator.clipboard.writeText(detailInfo.ipAddress); setDetailFeedback("IP 地址已复制"); }
    catch { setDetailFeedback("复制失败，请检查剪贴板权限后重试"); }
  }
  async function openDistroConfig(item: WslDistribution) {
    setConfigTarget(item); setDistroConfig(null); setConfigError(""); setConfigLoading(true);
    try { setDistroConfig(await pluginsClient.wslDistroConfig(item.name)); }
    catch (reason) { setConfigError(reason instanceof Error ? reason.message : "无法读取发行版配置"); }
    finally { setConfigLoading(false); }
  }
  function updateDistroConfig(values: Partial<WslDistroConfig>) {
    setDistroConfig(current => current ? { ...current, ...values } : current);
  }
  async function saveDistroConfig(restart: boolean) {
    if (!configTarget || !distroConfig || configSaving) return;
    setConfigSaving(true); setConfigError("");
    try {
      await pluginsClient.wslSaveDistroConfig(configTarget.name, distroConfig, restart);
      if (restart) { try { setItems(await pluginsClient.wslList()); } catch { /* 配置已经写入，列表刷新失败不影响保存结果 */ } }
      setMessage(restart ? `已保存并重启 ${configTarget.name}。` : `已保存 ${configTarget.name} 的 /etc/wsl.conf。`);
      setConfigTarget(null); setDistroConfig(null);
    } catch (reason) { setConfigError(reason instanceof Error ? reason.message : "保存发行版配置失败"); }
    finally { setConfigSaving(false); }
  }
  async function saveRemark(item: WslDistribution) {
    if (remarkSaving) return;
    const remark = remarkDraft.trim();
    setRemarkSaving(true); setRemarkError("");
    try {
      await pluginsClient.wslSaveSettings(defaultInstallLocation.trim(), item.name, remark);
      setItems(current => current.map(distribution => distribution.name === item.name ? { ...distribution, remark } : distribution));
      setEditingRemark(null); setMessage(`已保存 ${item.name} 的备注。`);
    } catch (reason) { setRemarkError(reason instanceof Error ? reason.message : "保存发行版备注失败"); }
    finally { setRemarkSaving(false); }
  }
  async function clearLogs() {
    if (busy || !window.confirm("清空 WSL 运行日志？此操作无法撤销。")) return;
    setBusy(true); setError("");
    try { await pluginsClient.wslClearLogs(); setLogs([]); setMessage("运行日志已清空。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "清空运行日志失败"); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return <div className="wsl-content">
    <section ref={dialogRef} aria-label="WSL 管理内容" aria-busy={busy} className="plugin-content wechat-settings-dialog">
      <nav className="wsl-tabs" role="tablist" aria-label="WSL 管理页面">{TABS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" id={`wsl-tab-${id}`} aria-selected={tab === id} aria-controls={`wsl-panel-${id}`} className={tab === id ? "is-active" : ""} onClick={() => { setTab(id); setError(""); setMessage(""); }}><Icon size={15} aria-hidden="true" />{label}</button>)}</nav>
      <div className="plugin-content-body">
        {!enabled && <p role="status">插件已停用，请回到软件列表启用后再管理发行版。</p>}
        {(!runningInTauri || runningOnPhone) && <p role="status">{runningOnPhone ? "手机端无法访问本机 WSL，请在 Windows 桌面客户端使用。" : "浏览器预览无法访问本机 WSL，请在 Windows 桌面客户端使用。"}</p>}
        {runningInTauri && !runningOnPhone && <>
          <div className="wsl-tab-panel" role="tabpanel" id={`wsl-panel-${tab}`} aria-labelledby={`wsl-tab-${tab}`}>
            {tab === "home" && <>
              <div className="wsl-home-toolbar">
                <p className="wsl-home-warning">停止发行版会保留数据；删除发行版会永久移除其 Linux 文件与设置，请先备份。</p>
                <div className="official-plugin-actions"><SortSelectionControls label="发行版" keys={sortIds} selected={new Set<string>()} sorting={sorting} onToggleAll={() => {}} onSortingChange={setSorting} showSelectAll={false} disabled={sortDisabled} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{busy && !wslUpdating ? "正在刷新…" : "刷新列表"}</button><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void shutdown()}><CircleStop size={14} aria-hidden="true" />停止全部 WSL</button></div>
              </div>
              <details className={`wsl-runtime-card ${runtimeInfo?.compatible === true ? "is-compatible" : runtimeInfo?.compatible === false ? "is-outdated" : ""}`} aria-busy={runtimeInfoBusy || wslUpdating}>
                <summary className="wsl-runtime-summary"><strong>WSL 平台版本</strong><span>当前版本：<code>{runtimeInfo?.currentVersion ?? (runtimeInfoBusy ? "正在读取…" : "未知")}</code></span><span className={`wsl-runtime-badge ${runtimeInfo?.compatible === true ? "is-compatible" : runtimeInfo?.compatible === false ? "is-outdated" : "is-unknown"}`} role="status">{runtimeInfoBusy ? "正在检查" : runtimeInfo?.compatible === true ? "符合要求" : runtimeInfo?.compatible === false ? "需要升级" : "无法确认"}</span><span className="wsl-expand-hint"><ChevronDown size={17} aria-hidden="true" /></span></summary>
                <div className="wsl-runtime-expanded">
                <div className="wsl-runtime-main">
                  <p className="wsl-runtime-minimum">最低兼容版本：≥ {runtimeInfo?.minimumSupportedVersion ?? "2.6.3"}</p>
                  <div className="wsl-runtime-actions"><button type="button" className="secondary" disabled={runtimeInfoBusy || busy || !enabled} onClick={() => void loadRuntimeInfo()}><RefreshCw size={14} aria-hidden="true" />{runtimeInfoBusy ? "读取中…" : "刷新版本"}</button><button type="button" className="secondary" disabled={busy || runtimeInfoBusy || !enabled} onClick={() => setConfirmWslUpdate(true)}><Download size={14} aria-hidden="true" />{wslUpdating ? "正在升级…" : "升级 WSL"}</button></div>
                </div>
                <details className="wsl-update-proxy">
                  <summary>升级代理（可选）<span>{wslProxyUrl.trim() ? "已填写" : "未设置"}</span></summary>
                  <div className="wsl-update-proxy-body">
                    <label htmlFor="wsl-update-proxy-url">HTTP/HTTPS 代理地址</label>
                    <div className="wsl-update-proxy-controls">
                      <input id="wsl-update-proxy-url" type="url" inputMode="url" maxLength={512} placeholder="http://127.0.0.1:10808" value={wslProxyUrl} disabled={busy || !enabled} onChange={event => setWslProxyUrl(event.target.value)} />
                      <button type="button" className="secondary" disabled={busy || wslProxyDetecting || !enabled} onClick={() => void detectWslProxy()}><RefreshCw size={14} aria-hidden="true" />{wslProxyDetecting ? "读取中…" : "获取本机代理"}</button>
                    </div>
                    {wslProxyDetected && wslProxyCandidates.length > 0 && <label className="wsl-update-proxy-choice">检测到的代理
                      <select aria-label="选择本机代理" disabled={busy || !enabled} value={wslProxyCandidates.some(candidate => candidate.url === wslProxyUrl) ? wslProxyUrl : ""} onChange={event => setWslProxyUrl(event.target.value)}>
                        <option value="">选择一个地址</option>
                        {wslProxyCandidates.map((candidate, index) => <option key={`${candidate.url}-${index}`} value={candidate.url}>{candidate.url} · {candidate.source}{candidate.enabled ? "" : "（系统代理已关闭）"}</option>)}
                      </select>
                    </label>}
                    <small>代理仅用于本次 Windows WSL 更新下载，留空则沿用当前网络设置。</small>
                  </div>
                </details>
                {runtimeInfo?.components?.length ? <ul className="wsl-runtime-components">{runtimeInfo.components.map(component => <li key={`${component.name}-${component.version}`}><span>{component.name}</span><code>{component.version}</code></li>)}</ul> : null}
                {(runtimeInfoError || runtimeInfo?.message) && <p className="wsl-runtime-note" role="status">{runtimeInfoError || runtimeInfo?.message}</p>}
                {wslUpdating && <div className="wsl-update-progress" role="status" aria-live="polite"><strong>正在升级 Windows Subsystem for Linux</strong><progress aria-label="正在升级 WSL" /><span>由 Windows 检查并安装更新，运行中的发行版可能暂时不可用。</span></div>}
                </div>
              </details>
              {enabled && !busy && !error && items.length === 0 && <p role="status">未检测到已注册的 WSL 发行版。可在“安装”页添加发行版。</p>}
              {listOrder.error && <p role="alert">{listOrder.error}<button type="button" onClick={listOrder.retry}>重试</button></p>}
              {items.length > 0 && <div className="wsl-distro-list">{sortedItems.map(item => {
                const running = isWslRunning(item.state);
                return <article key={item.name} data-wsl-sort-id={item.name} className={`wsl-distro-row ${running ? "is-running" : "is-stopped"}`}>
                  <div className={`wsl-distro-main${sorting ? " is-sorting" : ""}`}>{sorting && <ListSortHandle id={item.name} name={item.name} ids={sortIds} disabled={sortDisabled} onStart={drag.startDrag} onMove={moveItem} />}
                    <button type="button" className={`wsl-row-power ${running ? "is-running" : "is-stopped"}`} disabled={busy} aria-label={`${running ? "停止" : "启动"} ${item.name}`} title={`${running ? "停止" : "启动"} ${item.name}`} onClick={() => void control(item, running ? "stop" : "start")}>{running ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button>
                    <DistributionIcon name={item.name} />
                    <div className="wsl-distro-title"><strong title={item.name}>{item.name}</strong><span className={`wsl-row-state ${running ? "is-running" : "is-stopped"}`}><i aria-hidden="true" />{displayWslState(item.state)}{item.isDefault && <em>默认</em>}</span><small className="wsl-row-last-start">最后启动：{formatWslTimestamp(item.lastStartedAt)}</small>{item.remark && <small className="wsl-row-remark" title={item.remark}>备注：{item.remark.split(/\r?\n/, 1)[0]}</small>}</div>
                    <div className="wsl-row-tools"><button type="button" className="wsl-icon-action" title={`cmd /c start "WSL: ${item.name}" wsl.exe -d ${item.name} --cd ~`} aria-label={`在终端中打开 ${item.name}`} disabled={busy} onClick={() => void openDistributionTool(item, "terminal")}><SquareTerminal size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`查看 ${item.name} 的详细信息`} aria-label={`查看 ${item.name} 的详细信息`} disabled={busy} onClick={() => void showDetails(item)}><Info size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`编辑 ${item.name} 的备注`} aria-label={`编辑 ${item.name} 的备注`} onClick={() => { setEditingRemark(item.name); setRemarkDraft(item.remark); setRemarkError(""); }}><MessageSquare size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`打开 ${item.name} 的文件夹`} aria-label={`打开 ${item.name} 的文件夹`} disabled={busy} onClick={() => void openDistributionTool(item, "folder")}><FolderOpen size={16} aria-hidden="true" /></button><button type="button" className="wsl-icon-action" title={`配置 ${item.name} 的 /etc/wsl.conf`} aria-label={`配置 ${item.name} 的 /etc/wsl.conf`} disabled={busy} onClick={() => void openDistroConfig(item)}><Settings2 size={16} aria-hidden="true" /></button><MoreMenu triggerClassName="wsl-icon-action" triggerIcon={<MoreVertical size={16} aria-hidden="true" />} triggerTitle={`更多管理操作 ${item.name}`} triggerAriaLabel={`更多管理操作 ${item.name}`} header={<span className="shared-more-menu-header">WSL {item.version ?? "未知"} · 安装于 {formatWslTimestamp(item.installedAt)}</span>} items={[running ? { id: "stop", label: "停止", icon: <CircleStop size={14} aria-hidden="true" />, disabled: busy, onSelect: () => void control(item, "stop") } : { id: "start", label: "启动", icon: <Play size={14} aria-hidden="true" />, disabled: busy, onSelect: () => void control(item, "start") }, ...(!item.isDefault ? [{ id: "default", label: "设为默认", icon: <Star size={14} aria-hidden="true" />, disabled: busy, title: `将 ${item.name} 设为默认发行版`, onSelect: () => void control(item, "default") }] : []), ...(item.version === 2 ? [{ id: "move", label: "移动到…", icon: <FolderInput size={14} aria-hidden="true" />, disabled: busy, onSelect: () => { setMoveTarget(item); setMoveLocation(""); setMoveError(""); } }] : [{ id: "move-disabled", label: "移动（仅支持 WSL 2）", icon: <FolderInput size={14} aria-hidden="true" />, disabled: true }]), { id: "clone", label: "克隆", icon: <Copy size={14} aria-hidden="true" />, disabled: busy, onSelect: () => openCloneDialog(item) }, { id: "backup", label: backingUp ? "正在备份…" : "备份", icon: <FileArchive size={14} aria-hidden="true" />, disabled: busy, onSelect: () => void backup(item) }, { id: "unregister", label: "删除", icon: <Trash2 size={14} aria-hidden="true" />, danger: true, disabled: busy, onSelect: () => void control(item, "unregister") }]} /></div>
                  </div>
                </article>;
              })}</div>}
            </>}
            {tab === "install" && <>
              <div className="wsl-install-intro"><div><h2>添加 Linux 发行版</h2><p>选择获取方式，再设置实例名称和安装目录。</p></div><span>Windows · WSL 2</span></div>
              <div className="wsl-install-method-switch" role="group" aria-label="安装来源">
                <button type="button" aria-pressed={installMode === "online"} className={installMode === "online" ? "is-active" : ""} onClick={() => setInstallMode("online")}><strong>在线发行版</strong><small>使用 WSL 官方目录</small></button>
                <button type="button" aria-pressed={installMode === "mirror"} className={installMode === "mirror" ? "is-active" : ""} onClick={() => setInstallMode("mirror")}><strong>高速镜像</strong><small>测速后自动选择来源</small></button>
                <button type="button" aria-pressed={installMode === "rootfs"} className={installMode === "rootfs" ? "is-active" : ""} onClick={() => setInstallMode("rootfs")}><strong>本地 RootFS</strong><small>导入已有安装包</small></button>
              </div>
              {installMode === "online" ? <section className="wsl-install-settings wsl-install-card" aria-labelledby="wsl-online-install-title">
                <h3 id="wsl-online-install-title">在线安装</h3>
                {runningInTauri && !runningOnPhone && <div className="wsl-proxy-hint"><span>在线下载由 Windows WSL 执行；若下载较慢，请配置 Windows 系统代理。应用内单独设置代理不会自动应用到 WSL 下载。</span><button type="button" className="secondary" disabled={busy} onClick={() => void openWindowsProxySettings()}><Settings2 size={14} aria-hidden="true" />打开代理设置</button></div>}
                <div className="wsl-online-install-row"><label htmlFor="wsl-distro-install">发行版</label><select id="wsl-distro-install" value={onlineItems.length ? distribution : ""} disabled={busy || !enabled || !onlineItems.length} onChange={event => setDistribution(event.target.value)}>{onlineItems.length === 0 && <option value="">{onlineBusy ? "正在读取在线目录…" : "在线目录未加载，请重新加载"}</option>}{onlineItems.map(item => { const installed = isInstalledDistribution(items, item.name); return <option key={item.name} value={item.name}>{item.friendlyName}{installed ? "（已安装，可复制）" : ""}</option>; })}</select><button type="button" className="secondary" disabled={busy || onlineBusy || !enabled} onClick={() => void loadOnlineList()}><RefreshCw size={14} aria-hidden="true" />{onlineBusy ? "读取中…" : onlineListError ? "重新加载" : "刷新目录"}</button>{selectedDistributionInstalled ? <span className="wsl-installed-hint">已安装</span> : <button type="button" className="secondary" disabled={busy || onlineBusy || settingsBusy || !enabled || !onlineItems.length} onClick={() => void installOnline()}>{installing?.mode === "online" ? "正在安装…" : "安装"}</button>}</div>
                <div className="wsl-online-location"><label htmlFor="wsl-online-location">实例安装目录</label><div><input id="wsl-online-location" value={onlineLocation} disabled={busy || !enabled} onChange={event => setOnlineLocation(event.target.value)} placeholder="设置默认目录后自动创建发行版子目录；留空使用 WSL 默认位置" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseOnlineLocation()}>选择目录</button></div><small>{defaultInstallLocation.trim() ? `默认位置：${defaultInstallLocation.trim()}；已按发行版名称生成子目录，可修改。` : "可在“设置”页指定默认父目录；安装时会在其下按发行版名称创建子目录。"}</small></div>
                {installing?.mode === "online" && <div className="wsl-install-progress" role="status" aria-live="polite"><strong>正在安装 {installing.distribution}</strong><progress aria-label={`正在安装 ${installing.distribution}`} /><span>由 WSL 下载并注册发行版，耗时取决于网络和系统状态。</span></div>}
                {onlineListError && <p role="alert" className="wsl-online-list-error">{onlineListError} {onlineItems.length ? "已保留上次读取的目录，可继续选择或重新加载。" : "可点击重新加载，或选择本地 RootFS 安装。"}</p>}
                {selectedDistributionInstalled && <div className="wsl-clone-form"><p>此发行版已安装。可复制当前文件系统为独立实例，原实例保持不变。</p><div className="wsl-clone-fields"><label htmlFor="wsl-clone-name">新实例名称<input id="wsl-clone-name" value={cloneName} maxLength={128} disabled={busy || !enabled} onChange={event => setCloneName(event.target.value)} spellCheck={false} /></label><label htmlFor="wsl-clone-location">新实例安装目录<div className="wsl-rootfs-file-row"><input id="wsl-clone-location" value={cloneLocation} disabled={busy || !enabled} onChange={event => setCloneLocation(event.target.value)} placeholder="选择一个新的空目录" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfsLocation()}>选择目录</button></div></label></div><small>将临时导出并导入当前文件系统；需要足够的临时磁盘空间。</small><button type="button" className="secondary" disabled={busy || !enabled || !cloneName.trim() || !cloneLocation.trim()} onClick={() => void cloneInstalledDistribution()}>{busy ? "正在复制…" : "复制为新实例"}</button></div>}
              </section> : installMode === "mirror" ? <section className="wsl-install-settings wsl-install-card" aria-labelledby="wsl-mirror-install-title">
                <h3 id="wsl-mirror-install-title">高速镜像安装</h3>
                <p className="wsl-mirror-description">并行测试可用镜像速度，优先下载最快的镜像；失败后自动切换，再将归档导入为 WSL 2。</p>
                <div className="wsl-online-install-row"><label htmlFor="wsl-mirror-distro">发行版</label><select id="wsl-mirror-distro" value={mirrorSelection} disabled={busy || mirrorBusy || !enabled || !mirrorItems.length} onChange={event => { const selected = mirrorItems.find(item => item.id === event.target.value); setMirrorSelection(event.target.value); if (selected) setMirrorInstanceName(mirrorSuggestedName(selected)); }}><option value="">{mirrorBusy ? "正在读取镜像目录…" : "选择发行版"}</option>{mirrorItems.map(item => <option key={item.id} value={item.id}>{item.name} {item.version} · {item.sourceCount} 个镜像</option>)}</select><button type="button" className="secondary" disabled={busy || mirrorBusy || !enabled} onClick={() => void loadMirrorList()}><RefreshCw size={14} aria-hidden="true" />{mirrorBusy ? "读取中…" : onlineListError ? "重新加载" : "刷新镜像"}</button></div>
                <div className="wsl-mirror-fields">
                  <label htmlFor="wsl-mirror-name">实例名称<input id="wsl-mirror-name" value={mirrorInstanceName} maxLength={64} disabled={busy || !enabled} onChange={event => setMirrorInstanceName(event.target.value)} placeholder="例如 Ubuntu-24.04" spellCheck={false} /></label>
                  <div className="wsl-online-location"><label htmlFor="wsl-mirror-location">实例安装目录</label><div><input id="wsl-mirror-location" value={mirrorLocation} disabled={busy || !enabled} onChange={event => setMirrorLocation(event.target.value)} placeholder="设置默认目录后自动生成专属子目录" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseMirrorLocation()}>选择目录</button></div><small>{defaultInstallLocation.trim() ? `默认父目录：${defaultInstallLocation.trim()}；当前按实例名称生成子目录。` : "可在“设置”页指定默认父目录；留空时需手动选择目录。"}</small></div>
                </div>
                <button type="button" className="secondary wsl-mirror-install-button" disabled={busy || mirrorBusy || !enabled || !selectedMirror || !mirrorInstanceName.trim() || !mirrorLocation.trim()} onClick={() => void installMirror()}><Download size={14} aria-hidden="true" />{installing?.mode === "mirror" ? "正在安装…" : "测速并安装"}</button>
                {installing?.mode === "mirror" && <div className="wsl-install-progress" role="status" aria-live="polite"><strong>{mirrorProgress?.stage === "probing" ? "正在并行测速镜像…" : mirrorProgress?.stage === "downloading" ? `正在从 ${mirrorProgress.mirror ?? "镜像"} 下载` : mirrorProgress?.stage === "verifying" ? "正在校验归档格式…" : mirrorProgress?.stage === "importing" ? "下载完成，正在导入 WSL…" : `正在安装 ${installing.distribution}`}</strong>{mirrorProgress?.stage === "downloading" && <><progress aria-label="镜像下载进度" max={mirrorProgress.totalBytes ?? undefined} value={mirrorProgress.totalBytes ? Math.min(mirrorProgress.downloadedBytes, mirrorProgress.totalBytes) : undefined} /><span>{mirrorProgress.totalBytes ? `${(mirrorProgress.downloadedBytes / 1048576).toFixed(1)} / ${(mirrorProgress.totalBytes / 1048576).toFixed(1)} MB` : `${(mirrorProgress.downloadedBytes / 1048576).toFixed(1)} MB`} · ${(mirrorProgress.bytesPerSecond / 1048576).toFixed(1)} MB/s</span></>}</div>}
                {onlineListError && <p role="alert" className="wsl-online-list-error">{onlineListError} 可点击“刷新镜像”重试，或使用其他安装方式。</p>}
              </section> : <section className="wsl-install-settings wsl-install-card" aria-labelledby="wsl-rootfs-title">
                <h3 id="wsl-rootfs-title">从本地 RootFS 安装</h3>
                <div className="wsl-form-grid">
                  <div className="wsl-form-field wsl-form-wide"><label htmlFor="wsl-rootfs-file">RootFS 文件（.tar、.tar.gz、.tar.xz、.wsl）</label><div className="wsl-rootfs-file-row"><input id="wsl-rootfs-file" value={rootfsPath} readOnly placeholder="请选择本地文件" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfs()}>选择文件</button></div></div>
                  <label className="wsl-form-field" htmlFor="wsl-rootfs-name">实例名称<input id="wsl-rootfs-name" value={rootfsName} maxLength={128} disabled={busy || !enabled} onChange={event => setRootfsName(event.target.value)} placeholder="例如 Ubuntu-Dev" spellCheck={false} /></label>
                  <div className="wsl-form-field"><label htmlFor="wsl-rootfs-location">实例安装目录</label><div className="wsl-rootfs-file-row"><input id="wsl-rootfs-location" value={rootfsLocation} disabled={busy || !enabled} onChange={event => setRootfsLocation(event.target.value)} placeholder="选择一个新的空目录" spellCheck={false} /><button type="button" className="secondary" disabled={busy || !enabled} onClick={() => void chooseRootfsLocation()}>选择目录</button></div></div>
                </div>
                <div className="wsl-rootfs-footer"><small>导入需要一个新的空目录。源文件路径不会写入运行日志。</small><button type="button" className="secondary" disabled={busy || !enabled || !rootfsPath || !rootfsName.trim() || !rootfsLocation.trim()} onClick={() => void installRootfs()}>{installing?.mode === "rootfs" ? "正在导入…" : "创建安装"}</button></div>
                {installing?.mode === "rootfs" && <div className="wsl-install-progress" role="status" aria-live="polite"><strong>正在导入 {installing.distribution}</strong><progress aria-label={`正在导入 ${installing.distribution}`} /><span>正在注册发行版，完成时间取决于 RootFS 文件大小。</span></div>}
              </section>}
            </>}
            {tab === "settings" && <>
              <p>设置在线安装使用的默认位置。留空时由 WSL 选择系统默认目录。</p>
              <section className="wsl-install-settings" aria-labelledby="wsl-install-location-label"><label id="wsl-install-location-label" htmlFor="wsl-install-location">默认发行版安装目录</label><div className="wsl-install-location-controls"><input id="wsl-install-location" value={defaultInstallLocation} disabled={busy || settingsBusy || !enabled} onChange={event => setDefaultInstallLocation(event.target.value)} placeholder="留空时使用 WSL 默认位置" spellCheck={false} /><button type="button" className="secondary" disabled={busy || settingsBusy || !enabled} onClick={() => void chooseInstallLocation()}>选择目录</button><button type="button" className="secondary" disabled={busy || settingsBusy || !enabled} onClick={() => void saveInstallLocation()}>{settingsBusy ? "保存中…" : "保存"}</button></div><small>本地 RootFS 安装目录在“安装”页按实例单独指定。</small></section>
            </>}
            {tab === "logs" && <><div className="wsl-logs-heading"><div><h3>运行日志</h3><p>最多保留最近 200 条本机操作记录。</p></div><button type="button" className="secondary" disabled={busy || logs.length === 0} onClick={() => void clearLogs()}><Trash2 size={14} aria-hidden="true" />清空日志</button></div>{logs.length === 0 ? <p role="status">暂无运行日志。</p> : <><div className="wsl-log-filters"><label>检索日志<input type="search" value={logsQuery} onChange={event => { setLogsQuery(event.target.value); setLogsPage(1); }} placeholder="操作、发行版或时间" /></label><label>执行结果<select value={logsResultFilter} onChange={event => { setLogsResultFilter(event.target.value as typeof logsResultFilter); setLogsPage(1); }}><option value="all">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select></label></div>{visibleLogs.length === 0 ? <p className="wsl-log-empty" role="status">没有符合条件的日志，请调整检索条件。</p> : <ol className="wsl-log-list">{visibleLogs.map((entry, index) => <li key={`${entry.timestamp}-${(safeLogsPage - 1) * logsPageSize + index}`}><time dateTime={new Date(entry.timestamp).toISOString()}>{formatWslTimestamp(entry.timestamp)}</time><span>{entry.action === "注销" ? "删除发行版" : entry.action === "关闭全部 WSL" ? "停止全部 WSL" : entry.action}</span><span>{entry.distribution || "全部发行版"}</span><strong className={entry.success ? "is-success" : "is-failure"}>{entry.success ? "成功" : "失败"}</strong></li>)}</ol>}{filteredLogs.length > 0 && <PaginationBar className="wsl-log-pagination" page={safeLogsPage} pageSize={logsPageSize} total={filteredLogs.length} onPageChange={setLogsPage} onPageSizeChange={size => { setLogsPageSize(size); setLogsPage(1); }} pageSizeOptions={[10, 20, 50]} />}</>}<small>日志只记录时间、操作、发行版名称和结果；不会保存目录、RootFS 文件路径或 WSL 命令输出。</small></>}
          </div>
          {error && <ToastNotice message={error} tone="error" />}{message && <ToastNotice message={message} />}
          <details className="wsl-install-guide-disclosure"><summary><span><strong>安装与运行说明</strong><small>展开查看镜像原理、常用命令与支持范围</small></span><span className="wsl-expand-hint"><ChevronDown size={17} aria-hidden="true" /></span></summary>
          <section className="wsl-install-guide" aria-labelledby="wsl-install-guide-title">
            <div className="wsl-install-guide-heading"><div><h3 id="wsl-install-guide-title">安装与运行说明</h3><p>了解镜像来源如何选择，以及发行版安装后如何启动。</p></div></div>
            <div className="wsl-install-guide-grid">
              <article><span className="wsl-guide-step">01</span><div><h4>镜像安装原理</h4><p>应用读取镜像目录，按当前设备架构筛选发行版和下载源。点击“测速并安装”后，会并行测量各镜像的短数据响应速度，并按结果依次尝试。</p></div></article>
              <article><span className="wsl-guide-step">02</span><div><h4>下载与校验</h4><p>优先使用响应最快的镜像；下载失败或归档格式不符时自动尝试下一来源。支持分块的较大文件会并行下载，随后检查归档格式。</p></div></article>
              <article><span className="wsl-guide-step">03</span><div><h4>导入为 WSL 2</h4><p>校验通过后，应用调用 Windows 的 WSL 导入命令，将归档注册到你指定的空目录，并设为 WSL 2。临时下载文件在导入后清理。</p></div></article>
              <article><span className="wsl-guide-step">04</span><div><h4>启动和进入 Linux</h4><p>回到“发行版”页点击启动或终端图标。也可在 PowerShell 运行 <code>wsl -d 实例名称</code>；首次启动时按发行版提示创建 Linux 用户。</p></div></article>
            </div>
            <details className="wsl-install-guide-more"><summary>安装方式、数据位置与常用命令</summary><div className="wsl-guide-details"><p><strong>在线发行版：</strong>从 Windows WSL 在线目录选择，下载和注册由 Windows WSL 执行。<strong>高速镜像：</strong>由应用下载归档并导入，适合官方源较慢时使用。<strong>本地 RootFS：</strong>导入已有的 TAR、压缩 TAR 或 WSL 安装文件。</p><p>发行版文件存放在所选实例目录中。备份前建议先停止发行版；删除会注销实例并移除其中的 Linux 文件，请先使用“备份”或 <code>wsl --export 实例名称 备份.tar</code> 保存数据。</p><ul><li><code>wsl -l -v</code>：查看发行版及 WSL 版本</li><li><code>wsl -d 实例名称</code>：启动并进入指定发行版</li><li><code>wsl --shutdown</code>：停止所有正在运行的 WSL 发行版</li></ul></div></details>
          <section className="wsl-install-guide-scope"><h4>插件权限与支持范围</h4><ul><li>仅在 Windows 桌面端管理本机 WSL；浏览器预览不提供原生 WSL 能力。</li><li>“在线发行版”列表由 Windows 的 <code>wsl.exe --list --online</code> 命令读取 WSL 在线目录；详见 <a href="https://learn.microsoft.com/windows/wsl/basic-commands#list-available-linux-distributions" target="_blank" rel="noopener noreferrer" onClick={event => { if (runningInTauri) { event.preventDefault(); void openUrl("https://learn.microsoft.com/windows/wsl/basic-commands#list-available-linux-distributions").catch(() => setError("无法打开微软 WSL 命令说明，请复制链接到浏览器访问。")); } }}>微软 WSL 命令说明</a>。</li><li>支持在线安装、本地 RootFS 导入、启动、停止、设为默认、终端、文件夹、备注、TAR 备份及删除；删除前须输入发行版名称确认。</li><li>迁移、VHDX 挂载、计划任务、端口转发、代理和 USB 管理尚未实现。</li></ul></section>
          </section></details>
        </>}
      </div>
    </section>
    {configTarget && <SharedDialog sizeStorageKey="features/plugins/wsl-dashboard-plugin/wsl-dashboard-plugin" title={`${configTarget.name} 配置 (/etc/wsl.conf)`} subtitle="这些选项仅作用于当前发行版。配置变更在发行版下次启动时生效。" icon={<Settings2 size={18} aria-hidden="true" />} size="small" className="wsl-config-dialog" bodyClassName="wsl-config-dialog-body" closeDisabled={configSaving} onClose={() => { setConfigTarget(null); setDistroConfig(null); setConfigError(""); }} footer={<><button type="button" className="secondary" disabled={configSaving} onClick={() => { setConfigTarget(null); setDistroConfig(null); setConfigError(""); }}>取消</button><button type="button" className="secondary" disabled={configSaving || configLoading || !distroConfig} onClick={() => void saveDistroConfig(false)}><Save size={14} aria-hidden="true" />{configSaving ? "保存中…" : "保存"}</button><button type="button" className="primary" disabled={configSaving || configLoading || !distroConfig} onClick={() => void saveDistroConfig(true)}><RefreshCw size={14} aria-hidden="true" />{configSaving ? "正在应用…" : "保存并重启发行版"}</button></>}>
      {configLoading && <p role="status">正在读取 /etc/wsl.conf…</p>}
      {configError && <div className="wsl-config-error" role="alert"><span>{configError}</span>{!configLoading && !distroConfig && <button type="button" className="secondary" onClick={() => void openDistroConfig(configTarget)}>重试</button>}</div>}
      {distroConfig && <div className="wsl-config-form">
        <section className="wsl-config-section"><h3>自动挂载</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.automountEnabled} disabled={configSaving} onChange={event => updateDistroConfig({ automountEnabled: event.target.checked })} /><span>自动挂载磁盘</span></label>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.mountFstab} disabled={configSaving} onChange={event => updateDistroConfig({ mountFstab: event.target.checked })} /><span>处理 /etc/fstab</span></label>
          <label className="wsl-config-field">挂载根目录<input value={distroConfig.mountRoot} maxLength={1024} disabled={configSaving} onChange={event => updateDistroConfig({ mountRoot: event.target.value })} placeholder="/mnt/" /></label>
          <label className="wsl-config-field">挂载参数<input value={distroConfig.mountOptions} maxLength={2048} disabled={configSaving} onChange={event => updateDistroConfig({ mountOptions: event.target.value })} placeholder="例如：metadata,uid=1000" /></label>
        </section>
        <section className="wsl-config-section"><h3>网络设置</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.generateHosts} disabled={configSaving} onChange={event => updateDistroConfig({ generateHosts: event.target.checked })} /><span>生成 /etc/hosts</span></label>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.generateResolvConf} disabled={configSaving} onChange={event => updateDistroConfig({ generateResolvConf: event.target.checked })} /><span>生成 /etc/resolv.conf</span></label>
          <label className="wsl-config-field">主机名<input value={distroConfig.hostname} maxLength={253} disabled={configSaving} onChange={event => updateDistroConfig({ hostname: event.target.value })} placeholder="留空使用 Windows 主机名" /></label>
        </section>
        <section className="wsl-config-section"><h3>互操作设置</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.interopEnabled} disabled={configSaving} onChange={event => updateDistroConfig({ interopEnabled: event.target.checked })} /><span>启用 Windows 进程互操作</span></label>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.appendWindowsPath} disabled={configSaving} onChange={event => updateDistroConfig({ appendWindowsPath: event.target.checked })} /><span>将 Windows 路径加入 PATH</span></label>
        </section>
        <section className="wsl-config-section"><h3>默认用户</h3>
          <label className="wsl-config-field">启动时使用的 Linux 用户<input value={distroConfig.defaultUser} maxLength={64} disabled={configSaving} onChange={event => updateDistroConfig({ defaultUser: event.target.value })} placeholder="留空使用发行版默认用户" /></label>
        </section>
        <section className="wsl-config-section"><h3>启动设置</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.systemd} disabled={configSaving} onChange={event => updateDistroConfig({ systemd: event.target.checked })} /><span>启用 systemd（仅 WSL 2）</span></label>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.protectBinfmt} disabled={configSaving} onChange={event => updateDistroConfig({ protectBinfmt: event.target.checked })} /><span>保护 binfmt 注册</span></label>
          <label className="wsl-config-field">systemd 初始化超时（毫秒）<input type="number" min={0} max={600000} step={1000} value={distroConfig.initTimeout} disabled={configSaving} onChange={event => updateDistroConfig({ initTimeout: Number(event.target.value) })} /></label>
          <label className="wsl-config-field">发行版启动命令（以 root 执行）<input value={distroConfig.bootCommand} maxLength={2048} disabled={configSaving} onChange={event => updateDistroConfig({ bootCommand: event.target.value })} placeholder="例如：service docker start" /></label>
          <small className="wsl-config-warning">启动命令会在发行版启动时以 root 身份执行，请仅填写可信命令。</small>
        </section>
        <section className="wsl-config-section"><h3>时间设置</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.useWindowsTimezone} disabled={configSaving} onChange={event => updateDistroConfig({ useWindowsTimezone: event.target.checked })} /><span>同步 Windows 时区</span></label>
        </section>
        <section className="wsl-config-section"><h3>GPU 设置</h3>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.gpuEnabled} disabled={configSaving} onChange={event => updateDistroConfig({ gpuEnabled: event.target.checked })} /><span>启用 GPU 支持</span></label>
          <label className="wsl-config-check"><input type="checkbox" checked={distroConfig.appendGpuLibPath} disabled={configSaving} onChange={event => updateDistroConfig({ appendGpuLibPath: event.target.checked })} /><span>将 WSL GPU 库加入路径</span></label>
        </section>
        <p className="wsl-config-restart-note">“保存并重启发行版”会终止当前实例后重新启动；未保存的 Linux 会话工作可能丢失。</p>
      </div>}
    </SharedDialog>}
    {cloneTarget && <SharedDialog sizeStorageKey="features/plugins/wsl-dashboard-plugin/wsl-dashboard-plugin/2" title={`克隆 ${cloneTarget.name}`} subtitle={cloneDialogBusy ? "正在创建独立发行版，请稍候。" : "将当前 Linux 文件系统复制为一个新的发行版。"} icon={<Copy size={18} aria-hidden="true" />} size="small" className="wsl-clone-dialog" closeDisabled={cloneDialogBusy} onClose={() => { if (!cloneDialogBusy) { setCloneTarget(null); setCloneDialogError(""); } }} footer={<><button type="button" className="secondary" disabled={cloneDialogBusy} onClick={() => { setCloneTarget(null); setCloneDialogError(""); }}>取消</button><button type="button" className="primary" disabled={cloneDialogBusy || !cloneDialogName.trim() || !cloneDialogLocation.trim()} onClick={() => void cloneFromList()}><Copy size={14} aria-hidden="true" />{cloneDialogBusy ? "正在克隆…" : "开始克隆"}</button></>}>
      <div className="wsl-clone-dialog-form"><label htmlFor="wsl-clone-dialog-name">新实例名称<input id="wsl-clone-dialog-name" value={cloneDialogName} maxLength={128} disabled={cloneDialogBusy} onChange={event => setCloneDialogName(event.target.value)} spellCheck={false} /></label><label htmlFor="wsl-clone-dialog-location">新实例安装目录<div><input id="wsl-clone-dialog-location" value={cloneDialogLocation} disabled={cloneDialogBusy} onChange={event => setCloneDialogLocation(event.target.value)} placeholder="选择一个新的空目录" spellCheck={false} /><button type="button" className="secondary" disabled={cloneDialogBusy} onClick={() => void chooseCloneDialogLocation()}>选择目录</button></div></label><small>原发行版不会被修改，克隆后保留其 WSL 版本。过程会临时导出并重新导入文件系统，需要足够磁盘空间；建议先停止正在运行的源发行版。</small>{cloneDialogError && <p role="alert">{cloneDialogError}</p>}</div>
    </SharedDialog>}
    {moveTarget && <SharedDialog sizeStorageKey="features/plugins/wsl-dashboard-plugin/wsl-dashboard-plugin/3" title={`移动 ${moveTarget.name}`} subtitle={moveBusy ? "正在移动发行版，请稍候。" : "选择发行版新的存储目录。"} icon={<FolderInput size={18} aria-hidden="true" />} size="small" className="wsl-move-dialog" closeDisabled={moveBusy} onClose={() => { if (!moveBusy) { setMoveTarget(null); setMoveError(""); } }} footer={<><button type="button" className="secondary" disabled={moveBusy} onClick={() => { setMoveTarget(null); setMoveError(""); }}>取消</button><button type="button" className="primary" disabled={moveBusy || !moveLocation.trim()} onClick={() => setConfirmMove(true)}><FolderInput size={14} aria-hidden="true" />{moveBusy ? "正在移动…" : "移动"}</button></>}>
      <div className="wsl-move-form"><label htmlFor="wsl-move-location">新存储目录</label><div><input id="wsl-move-location" value={moveLocation} disabled={moveBusy} onChange={event => setMoveLocation(event.target.value)} placeholder="例如：D:\\WSL\\Ubuntu-20.04" /><button type="button" className="secondary" disabled={moveBusy} onClick={() => void selectMoveLocation()}>选择目录</button></div><small>仅支持 WSL 2。移动期间会关闭所有正在运行的 WSL 发行版。</small>{moveError && <p role="alert">{moveError}</p>}</div>
    </SharedDialog>}
    {confirmMove && moveTarget && createPortal(<ConfirmDialog title="确认移动发行版" confirmLabel="确认移动" message={`移动 ${moveTarget.name} 前会关闭所有正在运行的 WSL 发行版，相关 Linux 会话中的未保存工作可能丢失。目标目录：${moveLocation.trim()}。移动可能需要数分钟，是否继续？`} onResolve={confirmed => { setConfirmMove(false); if (confirmed) void moveDistribution(); }} />, document.body)}
    {editingRemark && <SharedDialog sizeStorageKey="features/plugins/wsl-dashboard-plugin/wsl-dashboard-plugin/4" title={`${editingRemark} 备注`} subtitle="记录用途、环境或维护信息，支持换行。" icon={<MessageSquare size={18} aria-hidden="true" />} size="small" className="wsl-remark-dialog" onClose={() => { setEditingRemark(null); setRemarkError(""); }} closeDisabled={remarkSaving} footer={<><button type="button" className="secondary" disabled={remarkSaving} onClick={() => { setEditingRemark(null); setRemarkError(""); }}>取消</button><button type="button" className="primary" disabled={remarkSaving} onClick={() => { const item = items.find(distribution => distribution.name === editingRemark); if (item) void saveRemark(item); }}><Save size={14} aria-hidden="true" />{remarkSaving ? "保存中…" : "保存备注"}</button></>}>
      <label className="wsl-remark-field" htmlFor="wsl-remark-editor">备注内容<textarea id="wsl-remark-editor" rows={5} maxLength={500} value={remarkDraft} disabled={remarkSaving} onChange={event => setRemarkDraft(event.target.value)} placeholder="例如：开发环境\n用于测试 Docker 镜像构建" /></label>
      <div className="wsl-remark-meta"><small>列表中仅显示第一行。</small><small>{remarkDraft.length} / 500</small></div>
      {remarkError && <p className="wsl-details-feedback" role="alert">{remarkError}</p>}
    </SharedDialog>}
    {detailTarget && <SharedDialog sizeStorageKey="features/plugins/wsl-dashboard-plugin/wsl-dashboard-plugin/5" title={`${detailTarget.name} 详细信息`} subtitle="WSL 实例状态与运行信息" icon={<Info size={18} aria-hidden="true" />} size="small" className="wsl-details-dialog" onClose={() => { setDetailTarget(null); setDetailInfo(null); setDetailFeedback(""); }} footer={<button type="button" onClick={() => { setDetailTarget(null); setDetailInfo(null); setDetailFeedback(""); }}>关闭</button>}>
      {detailBusy ? <p role="status">正在读取发行版信息…</p> : <dl className="wsl-details-list">
        <dt>WSL 版本</dt><dd>{(detailInfo ?? detailTarget).version ? `WSL ${(detailInfo ?? detailTarget).version}` : "未知"}</dd>
        <dt>状态</dt><dd>{displayWslState((detailInfo ?? detailTarget).state)}{(detailInfo ?? detailTarget).isDefault && <span className="wsl-details-default">默认</span>}</dd>
        <dt>IP 地址</dt><dd className="wsl-details-ip">{detailInfo?.ipAddress ? <><code>{detailInfo.ipAddress}</code><button type="button" className="secondary" onClick={() => void copyWslIp()}><Copy size={14} aria-hidden="true" />复制 IP</button></> : <span>{(detailInfo ?? detailTarget).state.toLowerCase() === "running" ? "未能获取 IP 地址" : "发行版运行后可查看"}</span>}</dd>
        <dt>根文件系统已用</dt><dd>{formatWslBytes(detailInfo?.rootUsedBytes ?? null)}</dd>
        <dt>安装时间</dt><dd>{formatWslTimestamp((detailInfo ?? detailTarget).installedAt)}</dd>
        <dt>最后启动</dt><dd>{formatWslTimestamp((detailInfo ?? detailTarget).lastStartedAt)}</dd>
        {(detailInfo ?? detailTarget).remark && <><dt>备注</dt><dd>{(detailInfo ?? detailTarget).remark}</dd></>}
      </dl>}
      {detailFeedback && <p className="wsl-details-feedback" role={detailInfo ? "status" : "alert"}>{detailFeedback}</p>}
      <small className="wsl-details-note">IP 只会在发行版运行时读取；磁盘用量统计 Linux 根文件系统已使用空间。</small>
    </SharedDialog>}
    {deleteTarget && <WslDeleteConfirmation key={deleteTarget.name} name={deleteTarget.name} busy={busy} backingUp={backingUp} error={error} message={message} onCancel={() => setDeleteTarget(null)} onBackup={() => void backup(deleteTarget)} onConfirm={confirmationName => void control(deleteTarget, "unregister", confirmationName)} />}
    {confirmWslUpdate && createPortal(<ConfirmDialog title="升级 WSL" confirmLabel="开始升级" message={`将使用 wsl.exe --update --web-download 更新本机 WSL 平台组件${wslProxyUrl.trim() ? `，并临时使用代理 ${wslProxyUrl.trim()}` : ""}。不会删除发行版或其 Linux 文件；升级期间运行中的发行版可能暂时不可用。是否继续？`} onResolve={confirmed => { setConfirmWslUpdate(false); if (confirmed) void updateWsl(); }} />, document.body)}
  </div>;
}
