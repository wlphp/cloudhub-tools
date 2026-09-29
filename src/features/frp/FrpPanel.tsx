import { useEffect, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, ExternalLink, LoaderCircle, Network, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { frpClient } from "../../platform/clients";
import { runningInTauri } from "../../platform/api";
import type { FrpGlobalSettingsInput, FrpProxy, FrpRuntime, FrpServer, FrpServerInput } from "../../shared/types";
import "../flow/flow.css";
import "./frp.css";

const blankProxy = (serverId: number): FrpProxy => ({ id: null, serverId, name: "", kind: "tcp", localIp: "127.0.0.1", localPort: 0, remotePort: null, customDomain: null, enabled: true });
const blankServer = (): FrpServerInput => ({ id: null, name: "", serverAddr: "", serverPort: 7000, token: "", proxies: [] });
const asServerInput = (server: FrpServer): FrpServerInput => ({ id: server.id, name: server.name, serverAddr: server.serverAddr, serverPort: server.serverPort, token: null, proxies: server.proxies });

export function FrpPanel() {
  const [servers, setServers] = useState<FrpServer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [globalSettings, setGlobalSettings] = useState<FrpGlobalSettingsInput>({ adminUser: "admin", adminPassword: "" });
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [serverDraft, setServerDraft] = useState<FrpServerInput | null>(null);
  const [proxyDraft, setProxyDraft] = useState<FrpProxy | null>(null);
  const [editingProxyId, setEditingProxyId] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<FrpRuntime[]>([]);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const selected = servers.find((server) => server.id === selectedId) ?? null;
  const selectedRuntime = runtime.find((state) => state.serverId === selectedId) ?? null;
  const draftDirty = !!selected && !!serverDraft && (!!serverDraft.token || JSON.stringify({ ...serverDraft, token: "" }) !== JSON.stringify({ id: selected.id, name: selected.name, serverAddr: selected.serverAddr, serverPort: selected.serverPort, token: "", proxies: selected.proxies }));

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

  const run = async (label: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(""); setFeedback("");
    try { await operation(); setFeedback(`${label}完成`); }
    catch (reason) { setError(`${label}失败：${String(reason)}`); try { setRuntime(await frpClient.runtime()); } catch { /* 保留原操作错误 */ } }
    finally { setBusy(""); }
  };

  const refreshStatus = () => void run("刷新状态", async () => { await refresh(); });
  const saveGlobal = (event: FormEvent) => {
    event.preventDefault();
    void run("保存全局面板账号", async () => {
      const saved = await frpClient.saveSettings(globalSettings);
      setGlobalSettings({ adminUser: saved.adminUser, adminPassword: "" }); setPasswordSaved(saved.adminPasswordSaved);
      await refresh();
    });
  };

  const editServer = (server: FrpServer) => setServerDraft(asServerInput(server));
  const addServer = () => { setSelectedId(null); setServerDraft(blankServer()); setProxyDraft(null); };
  const saveServer = (event: FormEvent) => {
    event.preventDefault();
    if (!serverDraft) return;
    const input = { ...serverDraft, name: serverDraft.name.trim(), serverAddr: serverDraft.serverAddr.trim(), proxies: serverDraft.proxies.map((proxy) => ({ ...proxy, serverId: serverDraft.id ?? -1, localIp: proxy.localIp.trim(), customDomain: proxy.customDomain?.trim() || null })) };
    void run("保存服务端", async () => {
      const saved = await frpClient.saveServer(input);
      const loaded = await refresh(false);
      setSelectedId(saved.id); setServerDraft(asServerInput(saved));
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
    setServerDraft({ ...serverDraft, proxies: editingProxyId ? serverDraft.proxies.map((proxy) => proxy.id === editingProxyId ? next : proxy) : [...serverDraft.proxies, next] });
    setProxyDraft(null); setEditingProxyId(null); setError("");
  };

  const persistRules = () => {
    if (!serverDraft || !selected) return;
    void run("保存穿透规则", async () => {
      const saved = await frpClient.saveServer({ ...serverDraft, id: selected.id, proxies: serverDraft.proxies.map((proxy) => ({ ...proxy, serverId: selected.id })) });
      setServers((current) => current.map((server) => server.id === saved.id ? saved : server));
      setServerDraft(asServerInput(saved));
      setRuntime(await frpClient.runtime());
    });
  };

  const apply = () => selected && void run("应用配置", async () => {
    if (!passwordSaved) throw new Error("请先保存全局客户端面板账号和密码");
    const state = await frpClient.apply(selected.id);
    setRuntime((current) => [...current.filter((item) => item.serverId !== state.serverId), state]);
  });

  const control = (action: "start" | "stop" | "restart") => selected && void run(action === "start" ? "启动服务端连接" : action === "stop" ? "停止服务端连接" : "重启服务端连接", async () => setRuntime(await frpClient.control(selected.id, action)));
  const openPanel = () => selected && void run("打开客户端面板", async () => { const url = await frpClient.panel(selected.id); await openUrl(url); });

  const deleteServer = () => {
    if (!selected) return;
    if (!window.confirm(`删除服务端“${selected.name}”及其全部 ${selected.proxies.length} 条本机规则？这会停止对应的本机 frpc 连接。`)) return;
    void run("删除服务端", async () => { await frpClient.deleteServer(selected.id); const loaded = await refresh(false); const next = loaded.nextServers[0]; if (next) { setSelectedId(next.id); setServerDraft(asServerInput(next)); } else { setSelectedId(null); setServerDraft(null); } });
  };

  return <section className="flow-page frp-page">
    <header className="flow-page-header"><div><span className="frp-eyebrow"><Network size={15} /> 网络服务</span><h1>内网穿透</h1><p>在当前电脑运行多个 frpc 连接；每条穿透规则归属一个服务端。</p></div></header>
    {!runningInTauri && <div className="flow-feedback error" role="status"><CircleAlert size={16} />内网穿透仅在桌面客户端可用。</div>}
    {error && <div className="flow-feedback error" role="alert"><CircleAlert size={16} />{error}</div>}
    {feedback && <div className="flow-feedback success" role="status">{feedback}</div>}
    {runningInTauri && <>
      <div className="frp-host-bar"><span>运行位置：当前电脑</span><button type="button" className="secondary" disabled={!!busy} onClick={refreshStatus}><RefreshCw size={15} />刷新状态</button></div>
      <div className="frp-overview"><span>frpc：<strong>{runtime[0] ? runtime[0].installed ? runtime[0].version : "未安装" : servers.length ? "检查中" : "添加服务端后检查"}</strong></span><span>运行连接：<strong>{runtime.filter((state) => state.running).length}/{servers.length}</strong></span><span>运行规则：<strong>{runtime.reduce((total, state) => total + state.proxies.filter((proxy) => proxy.status === "running").length, 0)}</strong></span><span>配置：<strong>{servers.some((server) => !runtime.find((state) => state.serverId === server.id)?.configCurrent) ? "有待应用更改" : "已同步"}</strong></span></div>
      <div className="frp-actions"><button type="button" disabled={!!busy} onClick={() => { if (window.confirm("确认在当前电脑安装或更新官方 frpc 吗？请先停止所有连接。")) void run("安装客户端", async () => { await frpClient.install(); await refresh(); }); }}>{busy === "安装客户端" ? <LoaderCircle size={15} className="flow-spin" /> : <Plus size={15} />}一键安装 / 更新</button><button type="button" className="secondary" disabled={!!busy} onClick={addServer}><Plus size={15} />新增服务端</button></div>
      <p className="frp-hint">每个服务端独立运行 frpc。关闭云枢 Tools 后，所有本机连接都会停止。</p>
      <form className="frp-card" onSubmit={saveGlobal}><div className="frp-card-heading"><h2>全局客户端面板账号</h2><span>所有服务端共用，面板仅监听本机 127.0.0.1</span></div><div className="frp-form-grid frp-global-grid"><label>面板账号<input required value={globalSettings.adminUser} onChange={(event) => setGlobalSettings({ ...globalSettings, adminUser: event.target.value })} /></label><label>面板密码<input type="password" autoComplete="new-password" required={!passwordSaved} value={globalSettings.adminPassword ?? ""} onChange={(event) => setGlobalSettings({ ...globalSettings, adminPassword: event.target.value })} placeholder={passwordSaved ? "已保存，留空保持不变" : "首次设置必填"} /></label><div className="frp-form-footer"><button type="submit" disabled={!!busy}><Save size={15} />保存全局账号</button></div></div></form>
      <div className="frp-server-layout">
        <aside className="frp-server-list" aria-label="FRP 服务端列表"><div className="frp-list-heading"><h2>服务端</h2><button type="button" className="secondary" aria-label="新增服务端" title="新增服务端" onClick={addServer}><Plus size={15} /></button></div>{servers.map((server) => { const state = runtime.find((item) => item.serverId === server.id); return <button type="button" key={server.id} className={`frp-server-item${selectedId === server.id ? " active" : ""}`} onClick={() => { setSelectedId(server.id); editServer(server); setProxyDraft(null); }}><span className={`frp-dot ${state?.connected ? "online" : state?.running ? "pending" : "offline"}`} /><span className="frp-server-label"><strong>{server.name}</strong><small>{server.serverAddr}:{server.serverPort}</small></span><span className="frp-rule-count">{server.proxies.length}</span></button>; })}{!servers.length && !serverDraft && <p className="frp-empty">添加第一个 FRP 服务端。</p>}</aside>
        {serverDraft && <main className="frp-server-content">
          <form className="frp-card" onSubmit={saveServer}><div className="frp-card-heading"><h2>{serverDraft.id ? "服务端连接" : "新增服务端连接"}</h2>{selectedRuntime && <span>{selectedRuntime.running ? "连接进程运行中" : "未连接"} · 本机面板端口 {selected?.adminPort ?? "保存后分配"}</span>}</div><div className="frp-form-grid"><label>服务端名称<input required maxLength={80} value={serverDraft.name} onChange={(event) => setServerDraft({ ...serverDraft, name: event.target.value })} placeholder="例如：生产 FRP" /></label><label>FRP 服务端地址<input required value={serverDraft.serverAddr} onChange={(event) => setServerDraft({ ...serverDraft, serverAddr: event.target.value })} placeholder="frps.example.com" /></label><label>连接端口<input required type="number" min="1" max="65535" value={serverDraft.serverPort || ""} onChange={(event) => setServerDraft({ ...serverDraft, serverPort: Number(event.target.value) })} /></label><label>认证 Token<input type="password" autoComplete="new-password" value={serverDraft.token ?? ""} onChange={(event) => setServerDraft({ ...serverDraft, token: event.target.value })} placeholder={selected?.tokenSaved ? "已保存，留空保持不变" : "服务端未启用 Token 可留空"} /><small>Token 仅对当前服务端生效。</small></label></div><div className="frp-form-footer"><button type="submit" disabled={!!busy}><Save size={15} />保存服务端</button>{selected && <button type="button" className="secondary" disabled={!!busy} onClick={deleteServer}><Trash2 size={14} />删除服务端</button>}</div></form>
          {selected && <><div className="frp-card frp-connection-card"><div className="frp-status-row"><span>进程：<strong>{selectedRuntime?.running ? "运行中" : "未运行"}</strong></span><span>代理：<strong>{selectedRuntime?.connected ? "有规则运行中" : selectedRuntime?.running ? "无规则运行" : "未连接"}</strong></span><span>配置：<strong>{selectedRuntime?.configCurrent ? "已应用" : selectedRuntime?.configPresent ? "待应用" : "未应用"}</strong></span></div><div className="frp-actions"><button type="button" disabled={!selectedRuntime?.installed || draftDirty || !!busy} onClick={apply}>应用此服务端配置</button><button type="button" className="secondary" disabled={!selectedRuntime?.configPresent || !!busy} onClick={() => control("start")}>启动</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={() => control("restart")}>重启</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={() => { if (window.confirm(`停止“${selected.name}”连接及其全部穿透规则？`)) control("stop"); }}>停止</button><button type="button" className="secondary" disabled={!selectedRuntime?.running || !!busy} onClick={openPanel}><ExternalLink size={15} />客户端面板</button></div></div>
            <section className="frp-card"><div className="frp-card-heading"><h2>穿透规则 · {selected.name}</h2><button type="button" className="secondary" disabled={!!busy} onClick={() => { setProxyDraft(blankProxy(selected.id)); setEditingProxyId(null); }}><Plus size={15} />新增规则</button></div>{draftDirty && <p className="frp-pending">服务端或规则有未保存修改；保存后再应用到本机。</p>}<div className="frp-table-wrap"><table className="frp-table"><thead><tr><th>规则</th><th>类型</th><th>本地目标</th><th>服务端入口</th><th>状态</th><th>操作</th></tr></thead><tbody>{(serverDraft.proxies ?? []).map((proxy) => { const state=selectedRuntime?.proxies.find((item)=>item.name===proxy.name); return <tr key={proxy.id ?? proxy.name}><td>{proxy.name}</td><td>{proxy.kind.toUpperCase()}</td><td>{proxy.localIp}:{proxy.localPort}</td><td>{proxy.remotePort || proxy.customDomain || "—"}</td><td><span className={`frp-proxy-status ${!proxy.enabled ? "disabled" : draftDirty || !selectedRuntime?.configCurrent ? "pending" : state?.status === "running" ? "online" : state?.status === "error" ? "error" : "offline"}`}>{!proxy.enabled ? "停用" : draftDirty || !selectedRuntime?.configCurrent ? "待应用" : state?.status === "running" ? "运行中" : state?.status === "error" ? "连接失败" : selectedRuntime?.running ? "未注册" : "未运行"}</span></td><td><button type="button" className="secondary" onClick={() => { setProxyDraft({ ...proxy }); setEditingProxyId(proxy.id ?? null); }}>编辑</button><button type="button" className="secondary" aria-label={`删除规则 ${proxy.name}`} onClick={() => { if (window.confirm(`删除规则“${proxy.name}”？`)) setServerDraft({ ...serverDraft, proxies: serverDraft.proxies.filter((item) => proxy.id ? item.id !== proxy.id : item.name !== proxy.name) }); }}><Trash2 size={14} /></button></td></tr>; })}</tbody></table>{!serverDraft.proxies.length && <p className="frp-empty">此服务端暂无穿透规则。</p>}</div><div className="frp-form-footer"><button type="button" disabled={!draftDirty || !!busy} onClick={persistRules}><Save size={15} />保存规则</button></div></section></>}
        </main>}
      </div>
    </>}
    {proxyDraft && <div className="frp-modal-backdrop"><form className="frp-modal" onSubmit={saveProxy}><h2>{editingProxyId ? "编辑穿透规则" : "新增穿透规则"}</h2><div className="frp-form-grid"><label>规则名称<input required value={proxyDraft.name} onChange={(event) => setProxyDraft({ ...proxyDraft, name: event.target.value })} /></label><label>类型<select value={proxyDraft.kind} onChange={(event) => setProxyDraft({ ...proxyDraft, kind: event.target.value as FrpProxy["kind"], remotePort: null, customDomain: null })}><option value="tcp">TCP</option><option value="udp">UDP</option><option value="http">HTTP</option><option value="https">HTTPS</option></select></label><label>本地 IP / 域名<input required value={proxyDraft.localIp} onChange={(event) => setProxyDraft({ ...proxyDraft, localIp: event.target.value })} /></label><label>本地端口<input required type="number" min="1" max="65535" value={proxyDraft.localPort || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, localPort: Number(event.target.value) })} /></label>{proxyDraft.kind === "tcp" || proxyDraft.kind === "udp" ? <label>服务端远端端口<input required type="number" min="1" max="65535" value={proxyDraft.remotePort || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, remotePort: Number(event.target.value) })} /></label> : <label>访问域名<input required value={proxyDraft.customDomain || ""} onChange={(event) => setProxyDraft({ ...proxyDraft, customDomain: event.target.value })} placeholder="app.example.com" /></label>}<label className="frp-checkbox"><input type="checkbox" checked={proxyDraft.enabled} onChange={(event) => setProxyDraft({ ...proxyDraft, enabled: event.target.checked })} />启用规则</label></div><footer><button type="button" className="secondary" onClick={() => setProxyDraft(null)}>取消</button><button type="submit">保存规则</button></footer></form></div>}
  </section>;
}
