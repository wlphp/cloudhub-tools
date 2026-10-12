import { useEffect, useState } from "react";
import { Copy, FileKey, Network, RefreshCw, Save } from "lucide-react";
import { codexTunnelClient, type CodexTunnelConfig, type CodexTunnelState } from "../../platform/clients/codex-tunnel";
import { frpClient } from "../../platform/clients/frp";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import type { FrpServer } from "../../shared/types";
import "./gateway-tunnel.css";

const blank: CodexTunnelConfig = { enabled: false, mode: "https", serverId: null, domain: "", publicPort: 443, certificatePath: "", privateKeyPath: "", trustedCaPath: "", tlsServerName: "", ruleName: "" };
export function GatewayTunnel({ monitorOnly = false }: { monitorOnly?: boolean }) {
  const [state, setState] = useState<CodexTunnelState | null>(null);
  const [form, setForm] = useState(blank);
  const [servers, setServers] = useState<FrpServer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [newConnection, setNewConnection] = useState(false);
  const [connection, setConnection] = useState({ name: "Codex API frps", serverAddr: "", serverPort: 7000, token: "" });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!runningInTauri) return;
    let alive = true;
    void Promise.all([codexTunnelClient.state(), frpClient.servers()]).then(([value, servers]) => {
      if (!alive || !value?.config) return;
      setState(value); setForm({ ...blank, ...value.config }); setServers(servers); setReady(true);
    }).catch(reason => { if (alive) setError(platformErrorMessage(reason)); });
    const timer = window.setInterval(() => { void codexTunnelClient.state().then(value => { if (alive && value?.config) setState(value); }).catch(() => {}); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  async function act(run: () => Promise<CodexTunnelState>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { const value = await run(); setState(value); setForm({ ...blank, ...value.config }); setMessage(value.error ? "配置已保存，公网连接失败，可重试" : "穿透配置已更新"); }
    catch (reason) { setError(platformErrorMessage(reason)); }
    finally { setBusy(false); }
  }
  const status = !state?.config.enabled ? form.enabled ? "待保存启用" : "未开启" : state.error ? "连接失败" : !state.localPort ? "等待 API 服务启动" : state.connected ? "代理已注册" : state.running ? "正在连接 frps" : "穿透未运行";
  return <section className="codex-tunnel" aria-label={monitorOnly ? "Codex API 托管穿透" : "API 内网穿透配置"}>
    <header><strong><Network size={15} />{monitorOnly ? "Codex API 托管穿透" : "内网穿透"}</strong>{!monitorOnly && <label><input type="checkbox" role="switch" aria-label="启用 API 内网穿透" checked={form.enabled} disabled={busy || !ready} onChange={event => { const enabled = event.target.checked; if (!enabled) void act(() => codexTunnelClient.save({ ...form, enabled: false })); else setForm({ ...form, enabled: true }); }} />启用内网穿透</label>}<span>{status}</span></header>
    {!runningInTauri && <p>内网穿透仅支持 PC 桌面端。</p>}
    {error && <p role="alert">{error}</p>}{state?.error && <p role="alert">{state.error}</p>}{message && <p role="status">{message}</p>}
    {state?.config.enabled && <div className="codex-tunnel-address"><span>公网 Base URL（{state.connected ? "代理已注册，外部访问待验证" : "已配置"}）</span><code>{state.publicUrl}</code><button aria-label="复制公网 Base URL" onClick={() => { void navigator.clipboard.writeText(state.publicUrl || "").then(() => setMessage("公网地址已复制")).catch(() => setError("复制地址失败")); }}><Copy size={14} /></button><small>本机目标：{state.localPort ? `127.0.0.1:${state.localPort}` : "等待 API 服务启动"} · 继续使用 API 服务密钥鉴权</small></div>}
    {monitorOnly && <p>此实例由 Codex API 服务独立托管。配置和开关请在“Codex 管理 → API 反代服务”中修改。</p>}
    {!monitorOnly && form.enabled && <div className="codex-tunnel-fields">
      <label>穿透模式<select aria-label="API 穿透模式" value={form.mode} disabled={busy} onChange={event => { const mode = event.target.value as CodexTunnelConfig["mode"]; setForm({ ...form, mode, publicPort: mode === "https" ? 443 : mode === "http" ? 80 : 6000 }); }}><option value="https">HTTPS（证书加密）</option><option value="http">HTTP（域名访问）</option><option value="tcp">TCP（端口映射）</option></select></label>
      <label>frps 连接<select aria-label="API 穿透 frps 连接" value={newConnection ? "new" : form.serverId ?? ""} disabled={busy} onChange={event => { setNewConnection(event.target.value === "new"); setForm({ ...form, serverId: event.target.value && event.target.value !== "new" ? Number(event.target.value) : null }); }}><option value="">请选择连接</option>{servers.map(server => <option key={server.id} value={server.id}>{server.name} · {server.serverAddr}:{server.serverPort}</option>)}<option value="new">新建 frps 连接</option></select></label>
      {newConnection && <><label>连接名称<input value={connection.name} onChange={e => setConnection({ ...connection, name: e.target.value })} /></label><label>frps 地址<input value={connection.serverAddr} placeholder="服务器域名或 IP" onChange={e => setConnection({ ...connection, serverAddr: e.target.value })} /></label><label>frps 连接端口<input type="number" min="1" max="65535" value={connection.serverPort} onChange={e => setConnection({ ...connection, serverPort: Number(e.target.value) })} /></label><label>frps Token<input type="password" autoComplete="off" value={connection.token} onChange={e => setConnection({ ...connection, token: e.target.value })} /></label></>}
      <label>{form.mode === "tcp" ? "公网地址（可选）" : `公网 ${form.mode.toUpperCase()} 域名（必填）`}<input aria-label="API 穿透公网域名" value={form.domain} placeholder={form.mode === "tcp" ? "留空沿用 frps 地址或 IP" : "api.example.com"} onChange={e => setForm({ ...form, domain: e.target.value.trim() })} /></label>
      <label>{form.mode === "tcp" ? "TCP 远端端口（必填）" : `公网 ${form.mode.toUpperCase()} 端口`}<input aria-label="API 穿透公网端口" type="number" min="1" max="65535" value={form.publicPort} onChange={e => setForm({ ...form, publicPort: Number(e.target.value) })} /></label>
      {form.mode === "https" && (["certificatePath", "privateKeyPath"] as const).map(field => <label key={field}>{field === "certificatePath" ? "HTTPS 证书文件" : "HTTPS 私钥文件"}<div><input aria-label={field === "certificatePath" ? "API 穿透证书路径" : "API 穿透私钥路径"} value={form[field]} onChange={e => setForm({ ...form, [field]: e.target.value })} /><button disabled={busy} aria-label={field === "certificatePath" ? "选择 API HTTPS 证书" : "选择 API HTTPS 私钥"} onClick={() => { void frpClient.selectTlsFile(field === "certificatePath" ? "certificate" : "private-key").then(path => { if (path) setForm(current => ({ ...current, [field]: path })); }).catch(reason => setError(platformErrorMessage(reason))); }}><FileKey size={14} /></button></div></label>)}
      <label>frps 受信 CA 文件（可选）<input value={form.trustedCaPath} onChange={e => setForm({ ...form, trustedCaPath: e.target.value })} /></label><label>frps TLS 名称（可选）<input value={form.tlsServerName} onChange={e => setForm({ ...form, tlsServerName: e.target.value })} /></label>
      <p>{form.mode === "tcp" ? "frps 需允许并放行 TCP 远端端口。" : `frps 需配置 ${form.mode.toUpperCase()} 入口端口，域名指向 frps。`}保存后随 API 服务启停，无需开启局域网访问。控制通道身份校验请配置受信 CA。</p>
      {form.mode !== "https" && <p>当前公网 API 使用 HTTP，调用方到 frps 的链路未加密；需要加密访问时请选择 HTTPS 或在服务端配置 HTTPS 反代。</p>}
      <button disabled={busy} onClick={() => void act(async () => {
        let serverId = form.serverId;
        if (newConnection) { const token = connection.token; setConnection(current => ({ ...current, token: "" })); const server = await frpClient.saveServer({ id: null, ...connection, token, panelUrl: "", panelUsername: "", panelPassword: null, proxies: [] }); serverId = server.id; setServers(await frpClient.servers()); setNewConnection(false); setForm(current => ({ ...current, serverId })); }
        return codexTunnelClient.save({ ...form, serverId });
      })}><Save size={14} />保存穿透配置</button>
    </div>}
    {state?.config.enabled && <div className="codex-tunnel-tools">{!state.installed && <span>请在内网穿透模块安装 frpc。</span>}<button disabled={busy || !state.localPort} onClick={() => void act(codexTunnelClient.retry)}><RefreshCw size={14} />重试穿透</button><details><summary>穿透日志</summary><pre>{state.logs.length ? state.logs.join("\n") : "暂无日志"}</pre></details></div>}
  </section>;
}
