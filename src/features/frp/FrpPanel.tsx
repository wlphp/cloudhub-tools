import { useEffect, useRef, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, ExternalLink, LoaderCircle, Network, Plus, RefreshCw, Save, Trash2, Server, Monitor, Play, Square, Settings2, Download, FileText, FolderOpen, Eye, EyeOff, Cable, ArrowRight, Pencil, X } from "lucide-react";
import { frpClient } from "../../platform/clients";
import type { FrpInstallProgress, FrpRelease } from "../../platform/clients/frp";
import { runningInTauri } from "../../platform/api";
import type { FrpGlobalSettingsInput, FrpProxy, FrpRuntime, FrpServer, FrpServerInput } from "../../shared/types";
import "../flow/flow.css";
import "./frp.css";
import { frpRuleUrl } from "./rule-url";

const blankProxy = (serverId: number): FrpProxy => ({ id: null, serverId, name: "", kind: "tcp", localIp: "127.0.0.1", localPort: 0, remotePort: null, customDomain: null, enabled: true });
const blankServer = (): FrpServerInput => ({ id: null, name: "", serverAddr: "", serverPort: 7000, token: "", panelUrl: "", panelUsername: "", panelPassword: null, proxies: [] });
const asServerInput = (server: FrpServer): FrpServerInput => ({ id: server.id, name: server.name, serverAddr: server.serverAddr, serverPort: server.serverPort, token: null, panelUrl: server.panelUrl ?? "", panelUsername: server.panelUsername ?? "", panelPassword: null, proxies: server.proxies });
const installStages: Record<FrpInstallProgress["stage"], string> = { metadata: "获取官方发布信息", downloading: "下载安装包", verifying: "校验 SHA-256", extracting: "解压安装包", checking: "检查配置兼容性", installing: "安装客户端", complete: "安装完成", error: "安装失败，可重试" };
const downloadSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export function FrpPanel() {
  const [servers, setServers] = useState<FrpServer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [globalSettings, setGlobalSettings] = useState<FrpGlobalSettingsInput>({ adminUser: "admin", adminPassword: "" });
  const [tokenVisible, setTokenVisible] = useState(false);
  const [revealedToken, setRevealedToken] = useState("");
  const tokenGeneration = useRef(0);
  const [serverPanelPasswordVisible, setServerPanelPasswordVisible] = useState(false);
  const [revealedServerPanelPassword, setRevealedServerPanelPassword] = useState("");
  const serverPanelPasswordGeneration = useRef(0);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState("");
  const revealGeneration = useRef(0);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [serverDraft, setServerDraft] = useState<FrpServerInput | null>(null);
  const [proxyDraft, setProxyDraft] = useState<FrpProxy | null>(null);
  const [editingProxyId, setEditingProxyId] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<FrpRuntime[]>([]);
  const [localPaths, setLocalPaths] = useState<{ binaryPath: string; configPath: string | null; installed: boolean; version: string | null } | null>(null);
  const [installerOpen, setInstallerOpen] = useState(false);
  const [releases, setReleases] = useState<FrpRelease[]>([]);
  const [installVersion, setInstallVersion] = useState("");
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState("");
  const [releaseReload, setReleaseReload] = useState(0);
  const [installProgress, setInstallProgress] = useState<FrpInstallProgress | null>(null);
  const installGeneration = useRef(0);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("rules");
  const [serverQuery, setServerQuery] = useState("");
  const [logSnapshot, setLogSnapshot] = useState<{ serverId: number; lines: string[] } | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsFollow, setLogsFollow] = useState(true);
  const [logsReload, setLogsReload] = useState(0);
  const logView = useRef<HTMLPreElement>(null);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const selected = servers.find((server) => server.id === selectedId) ?? null;
  const selectedRuntime = runtime.find((state) => state.serverId === selectedId) ?? null;
  const draftDirty = !!selected && !!serverDraft && (!!serverDraft.token || !!serverDraft.panelPassword || JSON.stringify({ ...serverDraft, token: "", panelPassword: null }) !== JSON.stringify({ ...asServerInput(selected), token: "", panelPassword: null }));
  const connectionNeedsApply = !!selectedRuntime && (!selectedRuntime.configPresent || !selectedRuntime.configCurrent);
  const connectionReady = !!selectedRuntime?.running && !connectionNeedsApply;
  const connectionActionLabel = connectionReady ? selectedRuntime?.connected ? "已连接" : "运行中" : connectionNeedsApply ? selectedRuntime?.running ? "应用配置并重启" : "应用配置并连接" : "启动连接";
  const connectionActionHint = draftDirty ? "请先保存修改，再应用配置并连接" : !selectedRuntime?.installed ? "请先安装本机 frpc" : connectionReady ? "连接进程已运行；需要重新连接时点击重启" : connectionNeedsApply ? "将已保存的配置写入本机，校验后启动或重启连接" : "使用已应用的配置启动连接";
  const installRelease = releases.find((release) => release.version === installVersion);
  const installDownloadUrl = installRelease ? `https://github.com/fatedier/frp/releases/download/v${installRelease.version}/frp_${installRelease.version}_windows_${installRelease.architecture}.zip` : null;
  const anyRunning = runtime.some((state) => state.running);
  const downloadPercent = installProgress?.totalBytes ? Math.min(100, Math.floor(installProgress.downloadedBytes / installProgress.totalBytes * 100)) : null;
  const logLines = logSnapshot?.serverId === selectedId ? logSnapshot.lines : [];

  useEffect(() => {
    if (!runningInTauri || activeTab !== "logs" || selectedId === null) return;
    let active = true; let timer: number | undefined;
    const load = async (initial = false) => {
      if (!initial && document.hidden) { timer = window.setTimeout(() => void load(), 2000); return; }
      if (initial) setLogsLoading(true);
      try {
        const lines = await frpClient.logs(selectedId);
        if (active) { setLogSnapshot({ serverId: selectedId, lines }); setLogsError(""); }
      } catch { if (active) setLogsError("读取客户端日志失败，请刷新重试。"); }
      finally {
        if (active) {
          setLogsLoading(false);
          if (logsAutoRefresh) timer = window.setTimeout(() => void load(), 2000);
        }
      }
    };
    setLogsError(""); void load(true);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedId, activeTab, logsAutoRefresh, logsReload]);

  useEffect(() => { setLogsFollow(true); }, [selectedId]);
  useEffect(() => {
    if (activeTab === "logs" && logsFollow && logView.current) logView.current.scrollTop = logView.current.scrollHeight;
  }, [logSnapshot, logsFollow, activeTab]);

  useEffect(() => () => { installGeneration.current += 1; }, []);
  useEffect(() => { setInstallProgress(null); }, [installVersion]);

  useEffect(() => {
    if (!installerOpen || !runningInTauri) return;
    let active = true;
    setReleasesLoading(true); setReleasesError("");
    void frpClient.releases().then((items) => {
      if (!active) return;
      setReleases(items);
      setInstallVersion((current) => items.some((item) => item.version === current) ? current : items[0]?.version ?? "");
    }).catch((reason) => { if (active) setReleasesError(String(reason)); })
      .finally(() => { if (active) setReleasesLoading(false); });
    return () => { active = false; };
  }, [installerOpen, releaseReload]);

  const refresh = async (preserveSelection = true) => {
    const [nextServers, nextSettings, nextRuntime] = await Promise.all([frpClient.servers(), frpClient.settings(), frpClient.runtime()]);
    setServers(nextServers);
    setRuntime(nextRuntime);
    if (nextSettings) {
      setGlobalSettings({ adminUser: nextSettings.adminUser, adminPassword: "" });
      setPasswordSaved(nextSettings.adminPasswordSaved);
    }
    setSelectedId((current) => preserveSelection && current && nextServers.some((server) => server.id === current) ? current : nextServers[0]?.id ?? null);
    return { nextServers, nextRuntime };
  };

  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    setBusy("load"); setError(""); setFeedback("");
    void Promise.all([frpClient.servers(), frpClient.settings(), frpClient.runtime()]).then(([loadedServers, settings, states]) => {
      if (!active) return;
      setServers(loadedServers); setSelectedId(loadedServers[0]?.id ?? null); setServerDraft(loadedServers[0] ? asServerInput(loadedServers[0]) : null); setRuntime(states);
      if (settings) { setGlobalSettings({ adminUser: settings.adminUser, adminPassword: "" }); setPasswordSaved(settings.adminPasswordSaved); }
    }).catch((reason) => { if (active) setError(`读取 FRP 配置失败：${String(reason)}`); }).finally(() => { if (active) setBusy(""); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    setLocalPaths(null);
    void frpClient.localPaths(selectedId).then((paths) => {
      if (active) setLocalPaths(paths);
    }).catch(() => { if (active) setError("读取本机 FRP 文件位置失败，请刷新页面重试"); });
    return () => { active = false; };
  }, [selectedId]);

  const run = async (label: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(""); setFeedback("");
    try { await operation(); setFeedback(`${label}完成`); }
    catch (reason) { setError(`${label}失败：${String(reason)}`); try { setRuntime(await frpClient.runtime()); } catch { /* 保留原操作错误 */ } }
    finally { setBusy(""); }
  };

  const hidePassword = () => {
    revealGeneration.current += 1;
    setPasswordVisible(false);
    setRevealedPassword("");
  };

  useEffect(() => {
    hidePassword();
    return () => { revealGeneration.current += 1; };
  }, [globalSettingsOpen]);

  useEffect(() => {
    if (!passwordVisible) return;
    const timeout = window.setTimeout(hidePassword, 30_000);
    window.addEventListener("blur", hidePassword);
    return () => { window.clearTimeout(timeout); window.removeEventListener("blur", hidePassword); };
  }, [passwordVisible]);

  const togglePassword = () => {
    if (passwordVisible) { hidePassword(); return; }
    if (globalSettings.adminPassword) { setPasswordVisible(true); return; }
    if (!passwordSaved) { setPasswordVisible(true); return; }
    const generation = ++revealGeneration.current;
    void run("查看面板密码", async () => {
      const password = await frpClient.revealAdminPassword();
      if (generation !== revealGeneration.current) return;
      setRevealedPassword(password);
      setPasswordVisible(true);
    });
  };

  const hideToken = () => {
    tokenGeneration.current += 1;
    setTokenVisible(false);
    setRevealedToken("");
  };

  useEffect(() => {
    hideToken();
    return () => { tokenGeneration.current += 1; };
  }, [selectedId, activeTab]);

  useEffect(() => {
    if (!tokenVisible) return;
    const timeout = window.setTimeout(hideToken, 30_000);
    window.addEventListener("blur", hideToken);
    return () => { window.clearTimeout(timeout); window.removeEventListener("blur", hideToken); };
  }, [tokenVisible]);

  const toggleToken = () => {
    if (tokenVisible) { hideToken(); return; }
    if (serverDraft?.token || !selected?.tokenSaved) { setTokenVisible(true); return; }
    const generation = ++tokenGeneration.current;
    void run("查看认证 Token", async () => {
      const token = await frpClient.revealServerToken(selected.id);
      if (generation !== tokenGeneration.current) return;
      setRevealedToken(token);
      setTokenVisible(true);
    });
  };

  const refreshStatus = () => void run("刷新状态", async () => { await refresh(); });
  const hideServerPanelPassword = () => {
    serverPanelPasswordGeneration.current += 1;
    setServerPanelPasswordVisible(false);
    setRevealedServerPanelPassword("");
  };
  useEffect(() => {
    hideServerPanelPassword();
    return () => { serverPanelPasswordGeneration.current += 1; };
  }, [selectedId, activeTab]);
  useEffect(() => {
    if (!serverPanelPasswordVisible) return;
    const timeout = window.setTimeout(hideServerPanelPassword, 30_000);
    window.addEventListener("blur", hideServerPanelPassword);
    return () => { window.clearTimeout(timeout); window.removeEventListener("blur", hideServerPanelPassword); };
  }, [serverPanelPasswordVisible]);
  const toggleServerPanelPassword = () => {
    if (serverPanelPasswordVisible) { hideServerPanelPassword(); return; }
    if (serverDraft?.panelPassword || !selected?.panelPasswordSaved) { setServerPanelPasswordVisible(true); return; }
    const generation = ++serverPanelPasswordGeneration.current;
    void run("查看服务端面板密码", async () => {
      const password = await frpClient.revealServerPanelPassword(selected.id);
      if (generation !== serverPanelPasswordGeneration.current) return;
      setRevealedServerPanelPassword(password); setServerPanelPasswordVisible(true);
    });
  };
  const installClient = () => {
    if (!installRelease || busy || anyRunning) return;
    const generation = ++installGeneration.current;
    setInstallProgress({ stage: "metadata", downloadedBytes: 0, totalBytes: null });
    void run("安装客户端", async () => {
      try {
        await frpClient.install(installRelease.version, (progress) => {
          if (generation === installGeneration.current) setInstallProgress(progress);
        });
      } catch (reason) {
        if (generation === installGeneration.current) setInstallProgress((current) => ({ stage: "error", downloadedBytes: current?.downloadedBytes ?? 0, totalBytes: current?.totalBytes ?? null }));
        throw reason;
      }
      if (generation === installGeneration.current) setInstallProgress((current) => ({ stage: "complete", downloadedBytes: current?.downloadedBytes ?? 0, totalBytes: current?.totalBytes ?? null }));
      await refresh(); setLocalPaths(await frpClient.localPaths(selectedId));
    });
  };
  const saveGlobal = (event: FormEvent) => {
    event.preventDefault();
    hidePassword();
    void run("保存全局面板账号", async () => {
      const saved = await frpClient.saveSettings(globalSettings);
      setGlobalSettings({ adminUser: saved.adminUser, adminPassword: "" }); setPasswordSaved(saved.adminPasswordSaved);
      await refresh();
    });
  };

  const editServer = (server: FrpServer) => setServerDraft(asServerInput(server));
  const addServer = () => { setActiveTab("connection"); setSelectedId(null); setServerDraft(blankServer()); setProxyDraft(null); };
  const saveServer = (event: FormEvent) => {
    event.preventDefault();
    if (!serverDraft) return;
    const input = { ...serverDraft, name: serverDraft.name.trim(), serverAddr: serverDraft.serverAddr.trim(), panelUrl: serverDraft.panelUrl?.trim() ?? "", panelUsername: serverDraft.panelUsername?.trim() ?? "", panelPassword: serverDraft.panelPassword || null, proxies: serverDraft.proxies.map((proxy) => ({ ...proxy, serverId: serverDraft.id ?? -1, localIp: proxy.localIp.trim(), customDomain: proxy.customDomain?.trim() || null })) };
    hideToken();
    hideServerPanelPassword();
    void run("保存服务端", async () => {
      const saved = await frpClient.saveServer(input);
      const loaded = await refresh(false);
      setSelectedId(saved.id); setServerDraft(asServerInput(saved)); setActiveTab("rules");
      setServers(loaded.nextServers);
    });
  };

  const saveProxy = (event: FormEvent) => {
    event.preventDefault();
    if (!proxyDraft || !serverDraft || selectedId === null) return;
    const name = proxyDraft.name.trim();
    if (!name) { setError("请填写穿透规则名称"); return; }
    if (serverDraft.proxies.some((proxy) => proxy.name === name && proxy.id !== editingProxyId)) { setError("当前服务端下规则名称不能重复"); return; }
    const next = { ...proxyDraft, id: editingProxyId, serverId: selectedId, name, localIp: proxyDraft.localIp.trim(), customDomain: proxyDraft.kind === "http" || proxyDraft.kind === "https" ? proxyDraft.customDomain?.trim() || null : null, remotePort: proxyDraft.kind === "tcp" || proxyDraft.kind === "udp" ? proxyDraft.remotePort : null };
    persistRules(editingProxyId ? serverDraft.proxies.map((proxy) => proxy.id === editingProxyId ? next : proxy) : [...serverDraft.proxies, next], () => {
      setProxyDraft(null); setEditingProxyId(null);
    });
  };

  const persistRules = (proxies: FrpProxy[], onSaved?: () => void) => {
    if (!serverDraft || !selected) return;
    void run("保存穿透规则", async () => {
      const saved = await frpClient.saveServer({ ...asServerInput(selected), proxies: proxies.map((proxy) => ({ ...proxy, serverId: selected.id })) });
      setServers((current) => current.map((server) => server.id === saved.id ? saved : server));
      setServerDraft((current) => current?.id === saved.id ? { ...current, proxies: saved.proxies } : current);
      onSaved?.();
      setRuntime(await frpClient.runtime());
    });
  };

  const apply = () => selected && void run("应用配置", async () => {
    if (!passwordSaved) throw new Error("请先保存全局客户端面板账号和密码");
    const state = await frpClient.apply(selected.id);
    setRuntime((current) => [...current.filter((item) => item.serverId !== state.serverId), state]);
  });

  const control = (action: "start" | "stop" | "restart") => selected && void run(action === "start" ? "启动服务端连接" : action === "stop" ? "停止服务端连接" : "重启服务端连接", async () => { const states = await frpClient.control(selected.id, action); setRuntime(states); if (action !== "stop" && !states.find((state) => state.serverId === selected.id)?.running) throw new Error("frpc 未保持运行，请检查本机面板端口和服务端配置"); });
  const openPanel = () => selected && void run("打开客户端面板", async () => { const url = await frpClient.panel(selected.id); await openUrl(url); });

  const deleteServer = () => {
    if (!selected) return;
    if (!window.confirm(`删除服务端“${selected.name}”及其全部 ${selected.proxies.length} 条本机规则？这会停止对应的本机 frpc 连接。`)) return;
    void run("删除服务端", async () => { await frpClient.deleteServer(selected.id); const loaded = await refresh(false); const next = loaded.nextServers[0]; if (next) { setSelectedId(next.id); setServerDraft(asServerInput(next)); } else { setSelectedId(null); setServerDraft(null); } });
  };

  return <section className="flow-page frp-page">
    <header className="flow-page-header"><div><span className="frp-eyebrow"><Network size={15} /> 网络服务</span><h1>内网穿透 <span className="frp-host-tag"><Monitor size={13} />当前电脑</span></h1><p>将本地服务连接到公网，集中管理 FRP 连接与穿透规则。</p></div>{runningInTauri && <div className="frp-actions"><button type="button" className="secondary" disabled={!!busy} onClick={refreshStatus}><RefreshCw size={15} />刷新状态</button><button type="button" className="primary" disabled={!!busy} onClick={addServer}><Plus size={15} />新增服务端</button></div>}</header>
    {!runningInTauri && <div className="flow-feedback error" role="status"><CircleAlert size={16} />内网穿透仅在桌面客户端可用。</div>}
    {error && <div className="flow-feedback error" role="alert"><CircleAlert size={16} />{error}</div>}
    {feedback && <div className="flow-feedback success" role="status">{feedback}</div>}
    {runningInTauri && <>
      <div className="frp-overview"><span>frpc：<strong>{runtime[0]?.version ?? localPaths?.version ?? ((runtime[0]?.installed || localPaths?.installed) ? "已安装 · 版本未知" : localPaths ? "未安装" : "检查中")}</strong></span><span>运行连接：<strong>{runtime.filter((state) => state.running).length}/{servers.length}</strong></span><span>运行规则：<strong>{runtime.reduce((total, state) => total + state.proxies.filter((proxy) => proxy.status === "running").length, 0)}</strong></span><span>配置：<strong>{servers.some((server) => !runtime.find((state) => state.serverId === server.id)?.configCurrent) ? "有待应用更改" : "已同步"}</strong></span><span className="frp-install-note"><span>GitHub 官方下载 <ArrowRight size={12} aria-hidden="true" />SHA-256 校验<ArrowRight size={12} aria-hidden="true" />解压安装</span><small>自动匹配 Windows 架构 · 可选择稳定版本 · 保留已有配置</small></span><button type="button" className="secondary" onClick={() => void run("打开 FRP GitHub", () => openUrl("https://github.com/fatedier/frp"))}><ExternalLink size={14} />GitHub · fatedier/frp</button><button type="button" disabled={!!busy} aria-expanded={installerOpen} aria-controls="frp-installer" onClick={() => setInstallerOpen(!installerOpen)}><Download size={15} />安装 / 更新</button></div>
      {installerOpen && <section id="frp-installer" className="frp-local-files frp-installer" aria-label="FRP 客户端安装" aria-busy={releasesLoading || busy === "安装客户端"}>
        <div className="frp-card-heading"><h2>安装 FRP 客户端</h2><button type="button" className="secondary" disabled={!!busy} onClick={() => setInstallerOpen(false)} aria-label="收起安装设置"><X size={15} /></button></div>
        <div className="frp-install-options"><label>安装版本<select value={installVersion} disabled={releasesLoading || !!busy || !!releasesError} onChange={(event) => setInstallVersion(event.target.value)}>{!releases.length && <option value="">{releasesLoading ? "正在读取官方版本…" : "暂无可用版本"}</option>}{releases.map((release, index) => <option key={release.version} value={release.version}>v{release.version}{index === 0 ? " · 最新可安装稳定版" : ""}</option>)}</select></label><div className="frp-install-package"><span>安装包</span><code>{installRelease ? `frp_${installRelease.version}_windows_${installRelease.architecture}.zip` : "自动匹配当前 Windows 架构"}</code><button type="button" className="secondary" disabled={!installRelease || !!busy} onClick={() => installRelease && void run("打开版本说明", () => openUrl(installRelease.releaseUrl))}><ExternalLink size={14} />版本说明</button></div></div>
        {installDownloadUrl && <div className="frp-install-download"><span>下载地址</span><a href={installDownloadUrl} aria-disabled={!!busy} onClick={(event) => { event.preventDefault(); if (!busy) void run("打开官方下载链接", () => openUrl(installDownloadUrl)); }}>{installDownloadUrl}<ExternalLink size={13} aria-hidden="true" /></a></div>}
        <div className="frp-file-row"><span>安装位置</span><code>{localPaths?.binaryPath ?? "读取中…"}</code><button type="button" className="secondary" disabled={!localPaths || !!busy} onClick={() => void run("打开安装目录", () => frpClient.openInstallDirectory())}><FolderOpen size={15} />打开安装目录</button></div>
        <p>从 fatedier/frp 官方 Releases 下载，按官方 SHA-256 校验后解压。替换前备份旧程序并检查已有配置兼容性；安装失败恢复旧程序，服务端配置与账号保持不变。列表包含近期 30 个发布中适合本机且提供校验信息的稳定版本。</p>
        {releasesLoading && <p role="status">正在获取 GitHub 官方版本信息…</p>}
        {releasesError && <p role="alert" className="frp-install-error">{releasesError}</p>}
        {anyRunning && <p className="frp-pending">安装或更换版本前，请先停止所有服务端连接。</p>}
        {installProgress && <div className={`frp-install-progress ${installProgress.stage === "error" ? "error" : ""}`}>
          <div className="frp-install-progress-heading"><span role="status">{installStages[installProgress.stage]}</span><span>{installProgress.stage === "downloading" ? `${downloadSize(installProgress.downloadedBytes)}${installProgress.totalBytes ? ` / ${downloadSize(installProgress.totalBytes)} · ${downloadPercent}%` : " · 下载中"}` : installProgress.stage === "complete" ? "已完成" : installProgress.downloadedBytes > 0 ? `已下载 ${downloadSize(installProgress.downloadedBytes)}` : installProgress.stage === "error" ? "未完成" : "等待服务器响应…"}</span></div>
          {installProgress.stage !== "error" && <progress aria-label={installProgress.stage === "downloading" ? "FRP 安装包下载进度" : "FRP 安装进度"} max={100} value={installProgress.stage === "complete" ? 100 : installProgress.stage === "downloading" ? downloadPercent ?? undefined : undefined} />}
          <small>{installProgress.stage === "downloading" ? "正在从 GitHub 官方下载，网络较慢时请稍候。" : installProgress.stage === "error" ? "查看页面上方的错误提示，重试将重新下载安装包。" : installProgress.stage === "complete" ? "客户端已安装，可应用配置并启动连接。" : installProgress.stage === "metadata" ? "正在读取所选版本的官方安装包与校验信息。" : "下载完成后继续校验和安装，全部完成后才会提示成功。"}</small>
        </div>}
        <div className="frp-form-footer"><button type="button" className="secondary" disabled={releasesLoading || !!busy} onClick={() => setReleaseReload((value) => value + 1)}><RefreshCw size={14} />刷新版本</button><button type="button" className="primary" disabled={!installRelease || releasesLoading || !!releasesError || anyRunning || !!busy} onClick={installClient}>{busy === "安装客户端" ? <LoaderCircle size={15} className="flow-spin" /> : <Download size={15} />}{busy === "安装客户端" ? (installProgress ? installStages[installProgress.stage] + "…" : "准备安装…") : `安装${installRelease ? ` v${installRelease.version}` : "所选版本"}`}</button></div>
      </section>}

      <details className="frp-files-disclosure">
        <summary>本机文件与运行说明</summary>
      <p className="frp-hint">每个服务端独立运行 frpc。关闭云枢 Tools 后，所有本机连接都会停止。</p>
      <section className="frp-local-files" aria-label="本机 FRP 文件位置">
        <div className="frp-file-row"><span>frpc 安装位置</span><code>{localPaths?.binaryPath ?? "读取中…"}</code><button type="button" className="secondary" disabled={!localPaths || !!busy} onClick={() => void run("打开安装目录", () => frpClient.openInstallDirectory())}><FolderOpen size={15} />打开安装目录</button></div>
        <div className="frp-file-row"><span>当前配置文件</span><code>{localPaths?.configPath ?? (selectedId ? "读取中…" : "保存服务端并应用配置后生成")}</code><button type="button" className="secondary" disabled={!selected || !selectedRuntime?.configPresent || !localPaths?.configPath || !!busy} onClick={() => selected && void run("打开配置文件", () => frpClient.openConfig(selected.id))}><FileText size={15} />打开配置文件</button></div>
        <p>每个服务端使用独立配置文件；首次应用配置后生成。手动修改后需重启连接生效，页面再次应用配置会覆盖手动修改。文件含认证信息，请勿分享。</p>
      </section>
      </details>
      <details className="frp-files-disclosure frp-global-disclosure" onToggle={(event) => { const open = event.currentTarget.open; setGlobalSettingsOpen(open); if (!open) hidePassword(); }}><summary>全局frp客户端面板设置</summary><form id="frp-global-settings" className="frp-card frp-global-settings" onSubmit={saveGlobal}><div className="frp-card-heading"><h2>全局frp客户端面板设置</h2><span>适用于所有 FRP 服务端，面板仅监听本机 127.0.0.1</span></div><div className="frp-form-grid frp-global-grid"><label>面板账号<input required value={globalSettings.adminUser} onChange={(event) => setGlobalSettings({ ...globalSettings, adminUser: event.target.value })} /></label><label>面板密码<span className="frp-password-field"><input type={passwordVisible ? "text" : "password"} autoComplete="new-password" required={!passwordSaved} value={passwordVisible && !globalSettings.adminPassword ? revealedPassword : globalSettings.adminPassword ?? ""} onChange={(event) => { revealGeneration.current += 1; setRevealedPassword(""); setGlobalSettings({ ...globalSettings, adminPassword: event.target.value }); }} placeholder={passwordSaved ? "已保存，留空保持不变" : "首次设置必填"} /><button type="button" disabled={!!busy} aria-label={passwordVisible ? "隐藏面板密码" : "查看面板密码"} title={passwordVisible ? "隐藏面板密码" : "查看面板密码"} aria-pressed={passwordVisible} onClick={togglePassword}>{passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label><div className="frp-form-footer"><button type="button" className="secondary" disabled={!selected || !selectedRuntime?.running || !!busy} title={selected ? `打开“${selected.name}”的客户端面板，需先启动连接` : "请先选择并启动服务端连接"} onClick={openPanel}><ExternalLink size={15} />打开客户端面板</button><button type="submit" disabled={!!busy}><Save size={15} />保存全局账号</button></div></div><p className="frp-global-panel-hint">{selected ? `客户端面板对应当前选中的服务端：${selected.name}，需先启动连接。` : "选择并启动一个服务端连接后，即可打开对应的客户端面板。"}</p></form></details>
      <div className="frp-server-layout">
        <aside className="frp-server-list" aria-label="FRP 服务端列表"><div className="frp-list-heading"><h2>服务端</h2><button type="button" className="secondary" aria-label="新增服务端" title="新增服务端" onClick={addServer}><Plus size={15} /></button></div><input className="frp-server-search" aria-label="搜索服务端" placeholder="搜索服务端…" value={serverQuery} onChange={(event) => setServerQuery(event.target.value)} />{servers.filter((server) => server.name.toLowerCase().includes(serverQuery.toLowerCase())).map((server) => { const state = runtime.find((item) => item.serverId === server.id); return <button type="button" key={server.id} className={`frp-server-item${selectedId === server.id ? " active" : ""}`} onClick={() => { setSelectedId(server.id); setActiveTab("rules"); editServer(server); setProxyDraft(null); }}><span className={`frp-dot ${state?.connected ? "online" : state?.running ? "pending" : "offline"}`} /><span className="frp-server-label"><strong>{server.name}</strong><small>{server.serverAddr}:{server.serverPort}</small></span><span className="frp-rule-count">{server.proxies.length}</span></button>; })}{!servers.length && !serverDraft && <p className="frp-empty">添加第一个 FRP 服务端。</p>}</aside>
        <main className="frp-server-content">
          <div className="frp-workspace-heading"><div><Server size={22} /><div><h2>{selected?.name || "新增服务端"}</h2><p>{selected ? `${selected.serverAddr}:${selected.serverPort} · 本机面板 :${selected.adminPort}` : "添加服务端，开始配置本地连接"}</p></div></div><button type="button" className="secondary" onClick={() => setActiveTab("connection")}><Settings2 size={15} />配置连接</button></div>
          {selected && <div className="frp-card frp-connection-card"><div className="frp-status-row"><span>进程：<strong>{selectedRuntime?.running ? "运行中" : "未运行"}</strong></span><span>代理：<strong>{selectedRuntime?.connected ? "有规则运行中" : selectedRuntime?.running ? "无规则运行" : "未连接"}</strong></span><span>配置：<strong>{selectedRuntime?.configCurrent ? "已应用" : selectedRuntime?.configPresent ? "待应用" : "未应用"}</strong></span></div><div className="frp-actions"><button type="button" className="primary" title={connectionActionHint} disabled={!selectedRuntime?.installed || draftDirty || connectionReady || !!busy} onClick={() => connectionNeedsApply ? apply() : control("start")}><Play size={14} />{connectionActionLabel}</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={() => control("restart")}>重启</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={() => { if (window.confirm(`停止“${selected.name}”连接及其全部穿透规则？`)) control("stop"); }}><Square size={14} />停止</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={openPanel}><ExternalLink size={15} />客户端面板</button></div></div>}
          <nav className="frp-tabs" aria-label="连接详情">{[{id:"rules", label:"穿透规则"}, {id:"connection", label:"连接配置"}, {id:"logs", label:"客户端运行日志"}].map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? "active" : ""} aria-current={activeTab === tab.id ? "page" : undefined} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === "rules" && <span>{serverDraft?.proxies.length ?? 0}</span>}</button>)}</nav>
          {selected && activeTab === "logs" && <section className="frp-card frp-logs-card" aria-label="客户端运行日志">
            <div className="frp-card-heading"><div><h2>客户端运行日志 · {selected.name}</h2><p className="frp-logs-hint">最近一次连接的最近 300 条日志 · 仅保留在本次应用会话 · 已过滤凭据信息</p></div><div className="frp-log-controls"><label><input type="checkbox" checked={logsAutoRefresh} onChange={(event) => setLogsAutoRefresh(event.target.checked)} />自动刷新</label><label><input type="checkbox" checked={logsFollow} onChange={(event) => setLogsFollow(event.target.checked)} />跟随最新</label><button type="button" className="secondary" disabled={logsLoading} onClick={() => setLogsReload((value) => value + 1)}><RefreshCw size={14} />刷新日志</button></div></div>
            {logsError && <p role="alert" className="frp-logs-error">{logsError}</p>}
            <pre ref={logView} className="frp-log-output" tabIndex={0} aria-label="frpc 日志内容" aria-busy={logsLoading} onScroll={(event) => { const view = event.currentTarget; if (view.scrollHeight - view.scrollTop - view.clientHeight > 24) setLogsFollow(false); }}>{logLines.length ? logLines.join("\n") : logsLoading ? "正在读取客户端日志…" : "暂无运行日志。请启动或重启当前服务端连接，日志会在这里显示。"}</pre>
            <p className="frp-logs-hint">{logsAutoRefresh ? "每 2 秒刷新；离开日志标签后暂停读取。" : "自动刷新已暂停，可手动刷新日志。"} 停止连接后仍可查看已采集的日志；重启连接会重新记录。</p>
          </section>}
          {serverDraft && <>
          <form hidden={activeTab !== "connection"} className="frp-card frp-server-settings" onSubmit={saveServer}><div className="frp-card-heading"><h2>{serverDraft.id ? "服务端连接" : "新增服务端连接"}</h2>{selectedRuntime && <span>{selectedRuntime.running ? "连接进程运行中" : "未连接"} · 本机面板端口 {selected?.adminPort ?? "保存后分配"}</span>}</div><div className="frp-form-grid"><label>服务端名称<input required maxLength={80} value={serverDraft.name} onChange={(event) => setServerDraft({ ...serverDraft, name: event.target.value })} placeholder="例如：生产 FRP" /></label><label>FRP 服务端地址<input required value={serverDraft.serverAddr} onChange={(event) => setServerDraft({ ...serverDraft, serverAddr: event.target.value })} placeholder="frps.example.com" /></label><label>连接端口<input required type="number" min="1" max="65535" value={serverDraft.serverPort || ""} onChange={(event) => setServerDraft({ ...serverDraft, serverPort: Number(event.target.value) })} /></label><label>认证 Token<span className="frp-password-field"><input type={tokenVisible ? "text" : "password"} autoComplete="new-password" value={tokenVisible && !serverDraft.token ? revealedToken : serverDraft.token ?? ""} onChange={(event) => { tokenGeneration.current += 1; setRevealedToken(""); setServerDraft({ ...serverDraft, token: event.target.value }); }} placeholder={selected?.tokenSaved ? "已保存，留空保持不变" : "服务端未启用 Token 可留空"} /><button type="button" disabled={!!busy} aria-label={tokenVisible ? "隐藏认证 Token" : "查看认证 Token"} title={tokenVisible ? "隐藏认证 Token" : "查看认证 Token"} aria-pressed={tokenVisible} onClick={toggleToken}>{tokenVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>Token 仅对当前服务端生效。</small></label></div>
            <section className="frp-remote-panel-settings" aria-label="服务端面板备注">
              <div className="frp-card-heading"><div><h2>服务端面板 · frps</h2><p>记录远端面板的访问地址和登录账号，仅作为本地备注。</p></div><button type="button" className="secondary" disabled={!selected?.panelUrl || !!busy} title={selected?.panelUrl ? "打开已保存的服务端面板地址" : "请先保存服务端面板地址"} onClick={() => selected && void run("打开服务端面板", () => frpClient.openServerPanel(selected.id))}><ExternalLink size={15} />打开服务端面板</button></div>
              <div className="frp-form-grid">
                <label>服务端面板地址<input type="url" maxLength={2048} value={serverDraft.panelUrl ?? ""} onChange={(event) => setServerDraft({ ...serverDraft, panelUrl: event.target.value })} placeholder="http://frps.example.com:7500" /><small>完整 HTTP / HTTPS 地址，可选填写。</small></label>
                <label>服务端面板账号<input maxLength={128} autoComplete="off" value={serverDraft.panelUsername ?? ""} onChange={(event) => setServerDraft({ ...serverDraft, panelUsername: event.target.value })} placeholder="面板登录账号" /></label>
                <label>服务端面板密码<span className="frp-password-field"><input maxLength={1024} type={serverPanelPasswordVisible ? "text" : "password"} autoComplete="new-password" value={serverPanelPasswordVisible && !serverDraft.panelPassword ? revealedServerPanelPassword : serverDraft.panelPassword ?? ""} onChange={(event) => { serverPanelPasswordGeneration.current += 1; setRevealedServerPanelPassword(""); setServerDraft({ ...serverDraft, panelPassword: event.target.value }); }} placeholder={selected?.panelPasswordSaved ? "已保存，留空保持不变" : "可选填写"} /><button type="button" disabled={!!busy} aria-label={serverPanelPasswordVisible ? "隐藏服务端面板密码" : "查看服务端面板密码"} title={serverPanelPasswordVisible ? "隐藏服务端面板密码" : "查看服务端面板密码"} aria-pressed={serverPanelPasswordVisible} onClick={toggleServerPanelPassword}>{serverPanelPasswordVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span><small>密码加密保存在本机，不会写入 frpc 配置文件。</small></label>
              </div>
            </section><div className="frp-form-footer"><button type="submit" disabled={!!busy}><Save size={15} />保存服务端</button>{selected && <button type="button" className="secondary" disabled={!!busy} onClick={deleteServer}><Trash2 size={14} />删除服务端</button>}</div></form>
          {selected && <>
            <section hidden={activeTab !== "rules"} className="frp-card frp-rules-card"><div className="frp-card-heading"><h2>穿透规则 · {selected.name}</h2><button type="button" className="secondary" disabled={!!busy} onClick={() => { setProxyDraft(blankProxy(selected.id)); setEditingProxyId(null); }}><Plus size={15} />新增规则</button></div>{draftDirty && <p className="frp-pending">服务端或规则有未保存修改；保存后再应用到本机。</p>}<div className="frp-rule-list" role="list" aria-label="穿透规则列表">{(serverDraft.proxies ?? []).map((proxy) => {
              const state = selectedRuntime?.proxies.find((item) => item.name === proxy.name);
              const ruleUrl = frpRuleUrl(proxy, selected.serverAddr);
              const status = !proxy.enabled ? "disabled" : draftDirty || !selectedRuntime?.configCurrent ? "pending" : state?.status === "running" ? "online" : state?.status === "error" ? "error" : "offline";
              const statusText = !proxy.enabled ? "停用" : status === "pending" ? "待应用" : status === "online" ? "运行中" : status === "error" ? "连接失败" : selectedRuntime?.running ? "未注册" : "未运行";
              const address = selected.serverAddr.includes(":") ? `[${selected.serverAddr}]` : selected.serverAddr;
              const entry = proxy.kind === "tcp" || proxy.kind === "udp" ? proxy.remotePort ? `${address}:${proxy.remotePort}` : "—" : proxy.customDomain || "—";
              const localAddress = proxy.localIp.includes(":") ? `[${proxy.localIp}]` : proxy.localIp;
              return <article className="frp-rule-row" role="listitem" key={proxy.id ?? proxy.name}>
                <div className="frp-rule-identity"><span className="frp-rule-icon"><Cable size={19} aria-hidden="true" /></span><div><strong>{proxy.name}</strong><div className="frp-rule-meta"><span className="frp-rule-protocol">{proxy.kind.toUpperCase()}</span><span className={`frp-rule-state ${status}`}><span className="frp-rule-state-dot" aria-hidden="true" />{statusText}</span></div></div></div>
                <div className="frp-rule-route"><div><small>本地目标</small><code>{localAddress}:{proxy.localPort}</code></div><ArrowRight size={18} className="frp-rule-arrow" aria-hidden="true" /><div><small>公网入口</small><code>{entry}</code></div></div>
                <div className="frp-rule-actions"><button type="button" className="secondary" disabled={!ruleUrl || !proxy.enabled || state?.status !== "running" || draftDirty || !selectedRuntime?.configCurrent || !!busy} aria-label={`打开规则 ${proxy.name}`} title={!ruleUrl ? "此规则无法用浏览器打开" : proxy.kind === "tcp" ? `通过 HTTP 打开 ${ruleUrl}，仅适用于网页服务` : `打开 ${ruleUrl}`} onClick={() => ruleUrl && void run("打开规则入口", () => openUrl(ruleUrl))}><ExternalLink size={14} />打开</button><button type="button" className="secondary" disabled={!!busy} onClick={() => { setProxyDraft({ ...proxy }); setEditingProxyId(proxy.id ?? null); }}><Pencil size={14} />编辑</button><button type="button" className="secondary" disabled={!!busy} title={`删除规则 ${proxy.name}`} aria-label={`删除规则 ${proxy.name}`} onClick={() => { if (window.confirm(`删除规则“${proxy.name}”？`)) persistRules(serverDraft.proxies.filter((item) => proxy.id ? item.id !== proxy.id : item.name !== proxy.name)); }}><Trash2 size={14} /></button></div>
              </article>;
            })}{!serverDraft.proxies.length && <p className="frp-empty">此服务端暂无穿透规则。</p>}</div>
            <div className="frp-rules-bottom">
              <figure className="frp-traffic-flow" aria-label="请求流量：公网访问者到 FRP 服务端，经隧道到本机 frpc，再到本地服务；响应按原路返回">
                <figcaption>流量如何到达本地服务</figcaption>
                <div className="frp-traffic-nodes">
                  <div><ExternalLink size={16} aria-hidden="true" /><span>公网访问者<small>访问映射端口 / 域名</small></span></div>
                  <ArrowRight size={16} className="frp-traffic-arrow" aria-hidden="true" />
                  <div><Server size={16} aria-hidden="true" /><span>FRP 服务端<small>接收并转发请求</small></span></div>
                  <ArrowRight size={16} className="frp-traffic-arrow" aria-hidden="true" />
                  <div><Network size={16} aria-hidden="true" /><span>本机 frpc<small>通过隧道接收请求</small></span></div>
                  <ArrowRight size={16} className="frp-traffic-arrow" aria-hidden="true" />
                  <div><Monitor size={16} aria-hidden="true" /><span>本地服务<small>规则中的本地 IP 与端口</small></span></div>
                </div>
                <p>frpc 主动连接服务端建立隧道；请求按上图转发，响应沿原路返回。上方规则展示的是本地目标与公网入口的映射关系。</p>
              </figure>
            </div></section></>}
          </>}
          {!serverDraft && <div className="frp-empty-state"><Network size={32} /><h2>添加你的第一个服务端</h2><p>配置 FRP 服务端后，即可创建穿透规则。</p><button type="button" className="primary" onClick={addServer}><Plus size={15} />新增服务端</button></div>}
        </main>
      </div>
    </>}
    {proxyDraft && <div className="frp-modal-backdrop"><form className="frp-modal frp-rule-editor" role="dialog" aria-modal="true" aria-labelledby="frp-rule-editor-title" onSubmit={saveProxy} onKeyDown={(event) => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); setProxyDraft(null); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="frp-editor-header"><span className="frp-editor-icon"><Cable size={20} /></span><div><h2 id="frp-rule-editor-title">{editingProxyId ? "编辑穿透规则" : "新增穿透规则"}</h2><p>将本地服务映射到公网入口</p></div><button type="button" className="secondary" disabled={!!busy} aria-label="关闭规则编辑器" title="关闭" onClick={() => setProxyDraft(null)}><X size={17} /></button></header>
      <div className="frp-editor-body">
        <div className="frp-form-grid frp-editor-basics"><label>规则名称<input autoFocus required value={proxyDraft.name} onChange={(event) => setProxyDraft({ ...proxyDraft, name: event.target.value })} placeholder="例如：本地开发站点" /></label><label>协议类型<select value={proxyDraft.kind} onChange={(event) => setProxyDraft({ ...proxyDraft, kind: event.target.value as FrpProxy["kind"], remotePort: null, customDomain: null })}><option value="tcp">TCP</option><option value="udp">UDP</option><option value="http">HTTP</option><option value="https">HTTPS</option></select></label></div>
        <section className="frp-editor-section"><h3><Monitor size={14} />本地目标</h3><div className="frp-form-grid frp-editor-address"><label>本地 IP / 域名<input required value={proxyDraft.localIp} onChange={(event) => setProxyDraft({ ...proxyDraft, localIp: event.target.value })} /></label><label>本地端口<input required type="number" min="1" max="65535" value={proxyDraft.localPort || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, localPort: Number(event.target.value) })} /></label></div></section>
        <section className="frp-editor-section"><h3><ExternalLink size={14} />公网入口</h3><div className="frp-form-grid frp-editor-address">{proxyDraft.kind === "tcp" || proxyDraft.kind === "udp" ? <label>服务端远端端口<input required type="number" min="1" max="65535" value={proxyDraft.remotePort || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, remotePort: Number(event.target.value) })} /></label> : <label>访问域名<input required value={proxyDraft.customDomain || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, customDomain: event.target.value })} placeholder="app.example.com" /></label>}<div className="frp-editor-server"><span>所属服务端</span><strong>{selected?.name}</strong><code>{selected?.serverAddr}</code></div></div></section>
        <label className="frp-checkbox frp-editor-enabled"><input type="checkbox" checked={proxyDraft.enabled} onChange={(event) => setProxyDraft({ ...proxyDraft, enabled: event.target.checked })} /><span>启用规则<small>保存后，应用服务端配置即可生效</small></span></label>
      </div>
      <footer><button type="button" className="secondary" disabled={!!busy} onClick={() => setProxyDraft(null)}>取消</button><button type="submit" className="primary" disabled={!!busy}><Save size={14} />{busy === "保存穿透规则" ? "保存中…" : "保存规则"}</button></footer>
    </form></div>}
  </section>;
}
