import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { GatewayTunnel } from "./GatewayTunnel";
import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Boxes, CheckCircle2, Gem, Globe, Clock3, Copy, Eye, EyeOff, Info, Link2, Maximize2, Minimize2, Play, Power, RefreshCw, Save, Server, Settings, Square, ScrollText, Users, X, XCircle } from "lucide-react";
import { codexClient, type CodexAccount, type CodexGatewayState } from "../../platform/clients/codex";

import { GatewayMonitoring, PoolQuota } from "./GatewayMonitoring";

// Recommended IDs are suggestions, never evidence of account availability.
const recommendedModels = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

export function CodexGateway({ accounts, disabled, onStateChange, externalPool, onLanUrlChange, actionRequest }: { accounts: CodexAccount[]; disabled: boolean; onStateChange?: (state: CodexGatewayState) => void; externalPool?: number[]; onLanUrlChange?: (url: string | null) => void; actionRequest?: {id: number; kind: "pool" | "logs" | "start" | "stop" | "config"} }) {
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolMaximized, setPoolMaximized] = useState(false);
  const poolDialog = useRef<HTMLDialogElement>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [state, setState] = useState<CodexGatewayState | null>(null);
  const [pool, setPool] = useState<Set<number>>(new Set());
  const [port, setPort] = useState("0");
  const serviceKeyInput = useRef<HTMLInputElement>(null);
  const keyFetched = useRef(false);
  const keyRevealRevision = useRef(0);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyInvalid, setKeyInvalid] = useState(false);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [networks, setNetworks] = useState<{ip: string; adapter: string; network: string}[]>([]);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [selectedIp, setSelectedIp] = useState(() => { try { return localStorage.getItem("codex-lan-ip") ?? ""; } catch { return ""; } });
  const networkRevision = useRef(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"start" | "stop" | "wake" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const portInitialized = useRef(false);
  const poolInitialized = useRef(false);
  const stateRevision = useRef(0);
  async function refreshNetworks() {
    const revision = ++networkRevision.current;
    setNetworkBusy(true); setNetworkError("");
    try {
      const rows = await codexClient.gatewayLanInterfaces();
      if (!alive.current || revision !== networkRevision.current) return;
      setNetworks(rows);
      const defaultIp = state?.lanAddress?.match(/^http:\/\/([^:]+):/)?.[1];
      setSelectedIp(current => rows.some(row => row.ip === current) ? current : rows.find(row => row.ip === defaultIp)?.ip ?? rows[0]?.ip ?? "");
    } catch {
      if (alive.current && revision === networkRevision.current) { setNetworks([]); setNetworkError("读取网络列表失败，请点击刷新重试。"); }
    } finally { if (alive.current && revision === networkRevision.current) setNetworkBusy(false); }
  }
  useEffect(() => { if (state?.supportsLanAccess && (state.allowLan || state.listeningLan)) void refreshNetworks(); }, [state?.supportsLanAccess, state?.allowLan, state?.listeningLan]);
  useEffect(() => { try { if (selectedIp) localStorage.setItem("codex-lan-ip", selectedIp); } catch { /* Local preference is optional. */ } }, [selectedIp]);
  useEffect(() => { if (state) onStateChange?.(state); }, [state, onStateChange]);
  useEffect(() => { if (externalPool) { stateRevision.current++; setPool(new Set(externalPool)); poolInitialized.current = true; } }, [externalPool]);
  function hideKey() {
    keyRevealRevision.current++;
    if (serviceKeyInput.current) {
      serviceKeyInput.current.type = "password";
      if (keyFetched.current) serviceKeyInput.current.value = "";
    }
    keyFetched.current = false;
    setKeyVisible(false);
  }
  useEffect(() => {
    const hide = () => hideKey();
    window.addEventListener("blur", hide);
    return () => { window.removeEventListener("blur", hide); keyRevealRevision.current++; if (serviceKeyInput.current) serviceKeyInput.current.value = ""; };
  }, []);
  useEffect(() => { hideKey(); }, [state?.running, state?.address]);
  useEffect(() => {
    alive.current = true;
    let reading = false;
    const read = async () => {
      if (reading || operation.current) return;
      reading = true;
      const revision = stateRevision.current;
      try { const next = await codexClient.gatewayState(); if (alive.current && revision === stateRevision.current) { setState(next); setUpdatedAt(Date.now()); if (!portInitialized.current) { setPort(String(next.configuredPort ?? next.address?.match(/:(\d+)\/v1$/)?.[1] ?? 0)); portInitialized.current = true; } if (!poolInitialized.current) { setPool(new Set(next.startupAccountIds ?? next.accountIds)); poolInitialized.current = true; } } }
      catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "读取本地服务失败"); }
      finally { reading = false; }
    };
    void read(); const timer = window.setInterval(() => void read(), 3000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { if (poolOpen) poolDialog.current?.showModal(); else poolDialog.current?.close(); }, [poolOpen]);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); else dialog.current?.close(); }, [confirmation]);
  async function act(run: () => Promise<void>) {
    if (operation.current) return;
    stateRevision.current++;
    operation.current = true; setBusy(true); setError(""); setMessage("");
    try { await run(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "本地 API 操作失败"); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  const ids = accounts.filter((account) => pool.has(account.id) && !account.isWebSession).map((account) => account.id);
  const locked = busy || disabled;
  const running = !!state?.running;
  const networkPending = running && !!state?.allowLan !== !!state?.listeningLan;
  const listenPort = state?.address?.match(/:(\d+)\/v1$/)?.[1];
  const listenAddress = running ? `${state?.listeningLan ? "0.0.0.0" : "127.0.0.1"}${listenPort ? `:${listenPort}` : ""}` : "未监听";
  const selectedNetwork = networks.find(network => network.ip === selectedIp);
  const lanPort = listenPort ?? state?.configuredPort;
  const selectedLanUrl = selectedNetwork && lanPort ? `http://${selectedNetwork.ip}:${lanPort}/v1` : null;
  useEffect(() => { onLanUrlChange?.(selectedLanUrl); }, [selectedLanUrl, onLanUrlChange]);
  const activeIds = running ? state.accountIds.filter(id => !accounts.find(account => account.id === id)?.isWebSession) : ids;
  useEffect(() => {
    if (!actionRequest) return;
    if (actionRequest.kind === "pool") setPoolOpen(true);
    if (actionRequest.kind === "logs") setLogsOpen(true);
    if (actionRequest.kind === "start") { if (canStart) setConfirmation("start"); else setError("请先检查服务账号、端口和密钥配置"); }
    if (actionRequest.kind === "stop" && running) setConfirmation("stop");
  }, [actionRequest]);
  const portInvalid = !/^\d+$/.test(port) || +port > 65535 || (+port !== 0 && +port < 1024);
  const canStart = !locked && !running && ids.length > 0 && !portInvalid && !keyInvalid;
  const baseUrl = state?.address ?? "<BASE_URL>";
  function updatePool(selected: Set<number>) {
    const accountIds = accounts.filter(account => selected.has(account.id) && !account.isWebSession).map(account => account.id);
    void act(async () => {
      const next = await codexClient.saveGatewayPool(accountIds);
      if (alive.current) { setPool(new Set(next.startupAccountIds ?? accountIds)); poolInitialized.current = true; setState(next); setMessage("服务账号池已保存，重启应用后保留"); }
    });
  }
  useEffect(() => { setModels([]); }, [state?.address, state?.accountIds.join(",")]);
  const protocolRoot = baseUrl.replace(/\/v1$/, "");
  const protocols = [
    { name: "OpenAI 协议", color: "openai", icon: Server, supported: true, base: baseUrl, routes: ["/v1/chat/completions", "/v1/completions", "/v1/responses (Codex)"], hint: "Chat Completions / Completions 支持文本；Responses 支持文本、函数工具及流式输出。" },
    { name: "Anthropic 协议", color: "anthropic", icon: Boxes, supported: !!state?.supportsMultiProtocol, base: protocolRoot, routes: ["/v1/messages"], hint: "Messages 支持文本、函数工具及流式输出；使用服务密钥作为 x-api-key。" },
    { name: "Gemini 协议", color: "gemini", icon: Gem, supported: !!state?.supportsMultiProtocol, base: protocolRoot, routes: ["/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent"], hint: "支持文本、函数工具和 SSE；使用服务密钥作为 x-goog-api-key。" },
  ];
  async function copyText(value: string, success: string) {
    await navigator.clipboard.writeText(value);
    if (alive.current) setMessage(success);
  }
  return <section className="codex-gateway codex-api-page">
    <header className="codex-api-header"><div className="codex-api-header-main"><div className="codex-api-title"><span className="codex-api-icon"><Server size={29} /></span><div className="codex-api-title-copy"><div><h2>API 反代服务</h2><span className={`codex-badge${running ? " is-running" : ""}`}>{state ? running ? "运行中" : "已停止" : "检查中"}</span></div><p>将您的 API 接口通过本地服务进行反向代理，支持多模型统一调用</p></div></div><div className="codex-actions">
      <button aria-label="服务账号池" onClick={() => setPoolOpen(true)}><Users size={14} aria-hidden="true" />服务账号池 <span className="codex-badge">{activeIds.length} / {accounts.length}</span></button>
      <button onClick={() => setLogsOpen(true)}><ScrollText size={14} />调用日志</button>
      <button disabled={locked} onClick={() => void act(async () => { const next = await codexClient.gatewayState(); if (alive.current) { setState(next); setUpdatedAt(Date.now()); setMessage("服务统计已刷新"); } })}><RefreshCw size={14} />刷新统计</button>
      <button className="codex-api-start" disabled={!canStart} onClick={() => setConfirmation("start")}><Play size={14} />启动反代服务</button>
      <button className="codex-api-stop" disabled={locked || !running} onClick={() => setConfirmation("stop")}><Square size={14} />停止服务</button>
    </div></div><div className="codex-header-status" aria-label="服务状态"><span className={`codex-service-indicator${running ? " is-running" : ""}`}><Activity size={15} />{state ? running ? "服务运行中" : "服务已停止" : "检查中"}</span><span><Users size={14} />服务账号 <strong>{activeIds.length} / {accounts.length}</strong></span><span><Clock3 size={14} />处理中 <strong>{state ? state.active : "—"}</strong></span><span><CheckCircle2 size={14} />已完成请求 <strong>{state ? state.completed : "—"}</strong></span><span><XCircle size={14} />失败请求 <strong>{state ? state.failed : "—"}</strong></span><small>统计刷新于 {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}</small></div></header>
    {(error || state?.startupError) && <p className="codex-feedback error" role="alert">{error || state?.startupError}</p>}{message && <p className="codex-feedback" role="status">{message}</p>}
    <div className="codex-config-container">
      <section className="codex-api-card codex-config-card"><div className="codex-config-heading"><h3><Settings size={23} aria-hidden="true" />服务配置</h3><div className="codex-config-switches"><div className="codex-auto-start-control" title="下次打开应用时沿用已保存端口、密钥和账号池；关闭开关不停止当前服务"><div><label className="codex-auto-start-toggle"><input type="checkbox" role="switch" aria-label="跟随应用自动启动" checked={state?.autoStart ?? false} disabled={locked || !state?.supportsAutoStart || (!state.autoStart && (!state.configuredPort || !activeIds.length))} onChange={event => { const enabled = event.target.checked; void act(async () => { const next = await codexClient.setGatewayAutoStart(enabled, activeIds); if (alive.current) { setState(next); setMessage(enabled ? "已开启跟随应用自动启动" : "已关闭跟随应用自动启动"); } }); }} />自动启动</label><small className="codex-auto-start-help">{!state?.supportsAutoStart ? "更新原生版本后可使用" : !state.configuredPort || !activeIds.length ? "先保存端口并选择账号" : ""}</small></div></div><div className="codex-lan-control"><label className="codex-auto-start-toggle"><input type="checkbox" role="switch" aria-label="允许局域网访问" aria-describedby="codex-lan-help" checked={state?.allowLan ?? false} disabled={locked || !state?.supportsLanAccess} onChange={event => { const enabled = event.target.checked; void act(async () => { const next = await codexClient.setGatewayAllowLan(enabled); if (alive.current) { setState(next); setMessage("访问设置已保存"); } }); }} />允许局域网访问</label>{networkPending && <small className="codex-network-pending">待重启生效</small>}</div></div></div><div className="codex-config-sections"><section className="codex-config-group"><h4><Globe size={15} />访问与共享</h4><GatewayTunnel /><div className="codex-api-config">
        <div className="codex-api-field"><span>本机 Base URL</span><div><div className="codex-api-value"><code>{state?.address ?? "启动服务后生成访问地址"}</code><button disabled={locked || !state?.address} aria-label="复制 Base URL" title="复制本机 Base URL" onClick={() => void act(() => copyText(state!.address!, "本机 Base URL 已复制"))}><Copy size={14} /></button></div></div></div>
        {(state?.allowLan || (running && state?.listeningLan)) && <div className="codex-api-field codex-lan-url"><span>局域网 Base URL</span><div><div className="codex-network-picker"><select aria-label="选择局域网网络" disabled={locked || networkBusy || !networks.length} value={selectedNetwork ? selectedIp : ""} onChange={event => setSelectedIp(event.target.value)}>{!networks.length && <option value="">{networkBusy ? "读取网络中…" : "没有可用的局域网地址"}</option>}{networks.map(network => <option key={network.ip} value={network.ip}>{network.adapter} · {network.network} · {network.ip}</option>)}</select><button disabled={locked || networkBusy} aria-label="刷新网络列表" title="刷新网络列表" onClick={() => void refreshNetworks()}><RefreshCw size={14} /></button></div>{networkError && <small role="status">{networkError}</small>}<div className="codex-api-value"><code>{selectedLanUrl ?? "未检测到局域网 IPv4 地址"}</code><button disabled={locked || networkBusy || !selectedLanUrl} aria-label="复制局域网 Base URL" title="复制局域网地址" onClick={() => void act(() => copyText(selectedLanUrl!, "局域网地址已复制"))}><Copy size={14} /></button></div><div className="codex-lan-share"><small>{!running ? "启动服务后可分享给同一局域网的朋友。" : !state?.listeningLan ? "重启服务后此地址生效，再复制分享配置。" : "此地址供同一局域网设备使用，分享配置包含服务密钥。"}</small><button disabled={locked || !running || !state?.listeningLan || networkBusy || !selectedLanUrl || !state?.supportsShareConfig} title="复制局域网地址和服务密钥" onClick={() => void act(async () => { await codexClient.copyGatewayShareConfig(selectedIp); if (alive.current) setMessage("局域网地址和服务密钥已复制，可发给同一局域网的朋友"); })}><Copy size={14} />复制分享配置</button></div></div></div>}
        <div className="codex-api-field codex-current-listener"><span>当前监听</span><div><code>{listenAddress}</code><small>{!running ? "服务已停止，当前没有开放访问。" : state?.listeningLan ? "当前允许本机及局域网设备访问（IPv4）。0.0.0.0 是监听地址，不能作为客户端访问地址。" : "当前服务仅允许本机访问。"}</small></div></div>
        <div className="codex-lan-access"><div id="codex-lan-help"><p><Globe size={14} />{networkPending || !running ? `已保存：下次启动${state?.allowLan ? "允许局域网访问（IPv4）" : "仅允许本机访问"}。` : state?.allowLan ? "已允许局域网访问（IPv4）。" : "局域网访问已关闭。"}</p>{(state?.allowLan || (running && state?.listeningLan)) && <p className="codex-lan-warning"><AlertTriangle size={14} />可达此端口的设备均可连接，请保管好服务密钥。</p>}{networkPending && <p className="codex-network-pending"><Info size={14} />请先停止服务，再启动反代服务以应用新设置；当前监听范围尚未改变。</p>}</div></div>
      </div></section><section className="codex-config-group"><h4><Settings size={15} />密钥、端口与模型</h4><div className="codex-api-config">
        <div className="codex-api-field"><span>服务密钥</span><div><div className="codex-api-value codex-api-key-value"><input ref={serviceKeyInput} type={keyVisible ? "text" : "password"} aria-label="服务密钥" autoComplete="new-password" spellCheck={false} maxLength={256} placeholder={running ? "••••••••••••••••" : state?.supportsPersistentConfig ? "留空沿用已保存密钥；首次启动自动生成" : "留空自动生成，或填写自定义密钥"} readOnly={running} disabled={locked || (!running && !state?.supportsCustomKey)} onChange={(event) => { keyFetched.current = false; const value = event.target.value; setKeyInvalid(!!value && !/^[A-Za-z0-9._-]{24,256}$/.test(value)); }} /><button aria-label={keyVisible ? "隐藏服务密钥" : "查看服务密钥"} title={keyVisible ? "隐藏服务密钥" : "查看服务密钥"} aria-pressed={keyVisible} disabled={locked} onClick={() => {
          if (keyVisible) { hideKey(); return; }
          const input = serviceKeyInput.current;
          if (!input) return;
          if (!running && input.value) { setKeyVisible(true); return; }
          if (!state?.supportsKeyReveal) { setError("当前原生版本需更新后才能查看已保存密钥"); return; }
          const revision = ++keyRevealRevision.current;
          void act(async () => { const value = await codexClient.revealGatewayKey(); if (alive.current && revision === keyRevealRevision.current && serviceKeyInput.current) { serviceKeyInput.current.value = value; keyFetched.current = true; setKeyVisible(true); } });
        }}>{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}</button><button aria-label="复制服务密钥" title="复制服务密钥" disabled={locked || !running} onClick={() => void act(async () => { await codexClient.copyGatewayKey(); if (alive.current) setMessage(state?.supportsPersistentConfig ? "本地服务密钥已复制；停止和重启后保持不变" : "本地服务密钥已复制；停止服务后失效"); })}><Copy size={14} /></button></div><small>{!running && state && !state.supportsCustomKey ? "当前旧测试版使用自动密钥；更新原生测试版后可自定义。" : state?.supportsPersistentConfig ? "密钥加密保存在本地。点击小眼睛查看；填写新密钥并启动后才会修改。" : "留空自动生成；当前原生版本仅本次运行有效，更新后支持固定保存。"}</small></div></div>
        <div className="codex-api-field"><label htmlFor="codex-api-port">服务端口</label><div><div className="codex-api-value codex-api-port-value"><input id="codex-api-port" aria-label="服务端口" aria-describedby="codex-api-port-help" type="number" min={0} max={65535} value={port} disabled={locked} onChange={(event) => { portInitialized.current = true; setPort(event.target.value); }} /><button disabled={locked || portInvalid || !state?.supportsConfigSave} onClick={() => void act(async () => { hideKey(); const next = await codexClient.saveGatewayPort(+port); if (alive.current) { setState(next); if (next.configuredPort) setPort(String(next.configuredPort)); setMessage(next.running ? "端口已保存，服务已在配置端口运行" : "端口已保存，下次启动时使用"); } })}><Save size={14} />保存</button></div><small id="codex-api-port-help">{!state?.supportsConfigSave ? "更新原生版本后支持保存端口并自动重启服务。" : "可随时修改为 1024–65535，保存后自动重启；0 沿用固定端口。重启会中断请求并清除日志。"}</small></div></div>
        <div className="codex-api-field"><label htmlFor="codex-api-model-input">模型 ID</label><div><div className="codex-api-model-row"><input id="codex-api-model-input" aria-label="唤醒模型" aria-describedby="codex-api-model-help" placeholder="填写账号可用的模型 ID" value={model} maxLength={100} disabled={locked} onChange={(event) => setModel(event.target.value)} /><button disabled={locked || !running || !state?.supportsModels} onClick={() => void act(async () => { setModelsBusy(true); setModels([]); try { const next = await codexClient.gatewayModels(); if (alive.current) { setModels(next); if (!model && next.length) setModel(next[0]); setMessage(next.length ? `已获取 ${next.length} 个模型 ID` : "当前账号未返回模型列表，可手动填写模型 ID"); } } finally { if (alive.current) setModelsBusy(false); } })}><RefreshCw size={14} />{modelsBusy ? "获取中…" : "获取模型列表"}</button></div><select aria-label="选择模型 ID" disabled={locked} value={models.includes(model) || recommendedModels.includes(model) ? model : ""} onChange={(event) => { if (event.target.value) setModel(event.target.value); }}><option value="" disabled>选择模型 ID</option><optgroup label="推荐模型（未验证账号权限）">{recommendedModels.filter((id) => !models.includes(id)).map((id) => <option key={id} value={id}>{id}</option>)}</optgroup>{models.length > 0 && <optgroup label={state?.supportsRemoteModels ? "官方目录返回" : "CLI 目录（未验证来源）"}>{models.map((id) => <option key={id} value={id}>{id}</option>)}</optgroup>}</select><small id="codex-api-model-help">{!running ? "可选择推荐模型或手动填写；推荐项未验证账号权限，启动服务后可获取官方目录。" : !state?.supportsModels ? "当前原生版本需更新后才能获取模型列表。" : !state.supportsRemoteModels ? "当前原生版本读取 CLI 目录，可能包含内置模型；更新后直接查询官方目录。" : "直接查询官方模型目录，不使用 CLI 内置列表；查询不发送推理请求。"}</small></div></div>
      </div></section></div>{!running && <p className="codex-api-description" role="status">{!accounts.length ? "请先在账号总览添加账号。" : !ids.length ? "点击“服务账号池”选择至少一个账号，再启动反代服务。" : portInvalid ? "请输入 1024–65535 的端口，或使用 0 自动分配。" : keyInvalid ? "服务密钥须为 24–256 位字母、数字或 . _ -，不能含空格。" : `已选择 ${ids.length} 个账号，可以启动服务。`}</p>}
    <GatewayMonitoring logsOpen={logsOpen} onClose={() => setLogsOpen(false)} accounts={accounts} state={state} locked={locked} act={act} onState={setState} />
      <details className="codex-config-note"><summary>调用说明</summary><div className="codex-service-note"><Info size={21} aria-hidden="true" /><div><p>请求使用服务账号的订阅额度或 API 账单。{state?.supportsFunctionTools ? "Responses 支持文本、函数工具及流式输出；工具由客户端执行，网关不执行本机工具。暂不支持图片或托管工具。" : "支持文本请求及流式输出，不执行本机工具。"}</p><p>统计来自当前服务进程，ChatGPT 订阅端点可能随官方客户端变化。</p></div></div></details></section>
    </div>
    <dialog ref={poolDialog} className={`codex-dialog modal-form-layout dialog-common-theme codex-pool-dialog${poolMaximized ? " is-maximized" : ""}`} aria-labelledby="codex-pool-title" onCancel={() => setPoolOpen(false)} onClose={() => setPoolOpen(false)}>
      <header><h2 id="codex-pool-title">服务账号池</h2><div className="codex-pool-window-actions"><button aria-label={poolMaximized ? "还原服务账号池" : "最大化服务账号池"} title={poolMaximized ? "还原" : "最大化"} aria-pressed={poolMaximized} onClick={() => setPoolMaximized(value => !value)}>{poolMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><button aria-label="关闭服务账号池" title="关闭服务账号池" onClick={() => setPoolOpen(false)}><X size={16} /></button></div></header>
      <div className="codex-pool-dialog-body">
    <section className="codex-api-card"><div className="codex-api-section-heading"><h3>账号选择 <span className="codex-badge">{activeIds.length} 个账号</span></h3><div className="codex-actions"><button disabled={locked || running || !accounts.length || !state?.supportsPoolPersistence} onClick={() => updatePool(ids.length === accounts.length ? new Set() : new Set(accounts.map((account) => account.id)))}>{ids.length === accounts.length && accounts.length ? "清空选择" : "全选账号"}</button><button disabled={locked || !ids.length || !/^[A-Za-z0-9._-]{1,100}$/.test(model)} onClick={() => setConfirmation("wake")}><Power size={14} />唤醒所选账号</button></div></div><p className="codex-api-description">{state?.supportsPoolPersistence ? "账号勾选后立即保存，停止服务和重启应用后保留；修改账号池需先停止服务。" : "更新原生版本后可选择并固定保存服务账号池。"}唤醒会发送模型请求并消耗额度。</p>
      <div className="codex-service-pool" role="group" aria-label="API 反代服务账号">{accounts.map((account) => <label key={account.id}><input type="checkbox" aria-label={account.label} checked={!account.isWebSession && activeIds.includes(account.id)} disabled={locked || running || !state?.supportsPoolPersistence || !!account.isWebSession} title={account.isWebSession ? "Web Session 账号仅支持查看额度，不能加入 API 服务" : undefined} onChange={() => { const next = new Set(pool); next.has(account.id) ? next.delete(account.id) : next.add(account.id); updatePool(next); }} /><PoolQuota account={account} /></label>)}</div>{!accounts.length && <p className="codex-api-description">请先在账号总览添加账号。</p>}
    </section>
      </div><div className="codex-dialog-actions"><button onClick={() => setPoolOpen(false)}>完成</button></div>
    </dialog>

    <section className="codex-api-card codex-protocol-section codex-multi-protocol">
      <div className="codex-protocol-heading"><h3><Link2 size={19} aria-hidden="true" />多协议支持</h3><p className="codex-api-description">统一服务地址和密钥，按不同客户端协议接入；调用当前服务账号可用的模型。</p><small>模型目录：GET /v1/models · 实际调用权限以上游为准</small></div>
      <div className="codex-protocol-grid">{protocols.map(protocol => {
        const Icon = protocol.icon;
        return <article className={`codex-protocol-card protocol-${protocol.color}${protocol.supported ? "" : " is-unavailable"}`} key={protocol.name}>
          <div className="codex-protocol-title"><span className="codex-protocol-icon"><Icon size={17} aria-hidden="true" /></span><h4>{protocol.name}</h4><button disabled={locked || !running || !protocol.supported} aria-label={`复制 ${protocol.name} Base URL`} title="复制协议接入 Base URL" onClick={() => void act(() => copyText(protocol.base, `${protocol.name} Base URL 已复制`))}><Copy size={14} />{protocol.name === "OpenAI 协议" && "复制 BASE"}</button></div>
          <div className="codex-protocol-routes">{protocol.routes.map(path => <code key={path}>{path}</code>)}</div>
          <small>{protocol.supported ? protocol.hint : "当前原生版本需更新后才能使用此协议入口。"}</small>
        </article>;
      })}</div>
      <p className="codex-api-description">协议转换不提供额外的 Claude / Gemini 模型权限。暂不支持图片、托管工具或 thinking；多账号函数工具会话须提供 X-CloudHub-Session，或只选择一个服务账号。</p>
    </section>
    <dialog ref={dialog} className="codex-dialog modal-form-layout dialog-common-theme" aria-label={confirmation === "start" ? "启动API 反代服务" : confirmation === "stop" ? "停止API 反代服务" : "唤醒 Codex 账号"} onCancel={(event) => { event.preventDefault(); if (!busy) setConfirmation(null); }}><header><h2>{confirmation === "start" ? "启动API 反代服务" : confirmation === "stop" ? "停止API 反代服务" : "唤醒 Codex 账号"}</h2><DialogHeaderActions><button disabled={busy} aria-label="关闭服务对话框" onClick={() => setConfirmation(null)}><X size={16} /></button></DialogHeaderActions></header><p>{confirmation === "start" ? "外部本机客户端持有服务密钥后，可以通过所选账号发起请求并消耗额度。服务账号不能同时启动受管 CLI 实例。" : confirmation === "stop" ? state?.supportsPersistentConfig ? "停止服务将取消正在传输的请求；已保存的密钥和端口将在下次启动时沿用。" : "停止服务将取消正在传输的请求，当前旧原生版本的服务密钥随即失效。" : `向 ${ids.length} 个账号各发送一次简短请求，模型为 ${model}。这可能消耗额度或产生 API 费用，不会增加可用额度，也不改变官方重置时间。`}</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button disabled={busy} onClick={() => void act(async () => {
      if (confirmation === "start") {
        if (!canStart) throw new Error("请检查账号选择、端口和服务密钥");
        const serviceKey = state?.supportsCustomKey ? serviceKeyInput.current?.value || null : null;
        if (serviceKeyInput.current) serviceKeyInput.current.value = "";
        setKeyInvalid(false);
        const next = await codexClient.startGateway(+port, ids, serviceKey); if (alive.current) { setState(next); if (next.configuredPort) setPort(String(next.configuredPort)); }
      }
      else if (confirmation === "stop") { const next = await codexClient.stopGateway(); if (alive.current) setState(next); }
      else { let failed = 0; for (const id of ids) { if (!alive.current) break; try { await codexClient.wakeAccount(id, model); } catch { failed++; } } if (alive.current) setMessage(`已处理 ${ids.length} 个账号${failed ? `，${failed} 个唤醒失败，请检查登录或模型权限` : "，唤醒请求完成"}`); }
      if (alive.current) setConfirmation(null);
    })}>{busy ? "处理中…" : "确认操作"}</button></div></dialog>
  </section>;
}
