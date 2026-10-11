import { useEffect, useRef, useState } from "react";
import { Copy, Play, Power, RefreshCw, Server, ShieldCheck, Square, ScrollText, Users, X } from "lucide-react";
import { codexClient, type CodexAccount, type CodexGatewayState } from "../../platform/clients/codex";

import { GatewayMonitoring, PoolQuota } from "./GatewayMonitoring";

// Recommended IDs are suggestions, never evidence of account availability.
const recommendedModels = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

export function CodexGateway({ accounts, disabled }: { accounts: CodexAccount[]; disabled: boolean }) {
  const [poolOpen, setPoolOpen] = useState(false);
  const poolDialog = useRef<HTMLDialogElement>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [state, setState] = useState<CodexGatewayState | null>(null);
  const [pool, setPool] = useState<Set<number>>(new Set());
  const [port, setPort] = useState("0");
  const serviceKeyInput = useRef<HTMLInputElement>(null);
  const [keyInvalid, setKeyInvalid] = useState(false);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"start" | "stop" | "wake" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const portInitialized = useRef(false);
  useEffect(() => {
    alive.current = true;
    let reading = false;
    const read = async () => {
      if (reading || operation.current) return;
      reading = true;
      try { const next = await codexClient.gatewayState(); if (alive.current) { setState(next); if (!portInitialized.current) { setPort(String(next.configuredPort ?? next.address?.match(/:(\d+)\/v1$/)?.[1] ?? 0)); portInitialized.current = true; } } }
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
    operation.current = true; setBusy(true); setError(""); setMessage("");
    try { await run(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "本地 API 操作失败"); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  const ids = accounts.filter((account) => pool.has(account.id)).map((account) => account.id);
  const locked = busy || disabled;
  const running = !!state?.running;
  const activeIds = running ? state.accountIds : ids;
  const portInvalid = !/^\d+$/.test(port) || +port > 65535 || (+port !== 0 && +port < 1024);
  const canStart = !locked && !running && ids.length > 0 && !portInvalid && !keyInvalid;
  const baseUrl = state?.address ?? "<BASE_URL>";
  const displayPort = running ? state?.address?.match(/:(\d+)\/v1$/)?.[1] ?? port : port;
  const modelId = model || "<MODEL_ID>";
  useEffect(() => { setModels([]); }, [state?.address, state?.accountIds.join(",")]);
  const protocols = [
    { name: "OpenAI 兼容", path: "/v1/chat/completions", supported: true, example: `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=<SERVICE_KEY>\nOPENAI_MODEL=${modelId}`, hint: "文本 Chat Completions，支持流式响应。" },
    { name: "Responses", path: "/v1/responses", supported: true, example: `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=<SERVICE_KEY>\nOPENAI_MODEL=${modelId}\nOPENAI_API_ENDPOINT=/responses`, hint: state?.supportsFunctionTools ? "支持文本、函数工具及流式响应。工具由客户端执行；多账号工具会话需固定会话标识。" : "文本 Responses，支持流式响应。" },
    { name: "Anthropic Messages", path: "/v1/messages", supported: false },
    { name: "Gemini", path: "/v1beta/models", supported: false },
    { name: "Ollama Bridge", path: "/api/chat", supported: false },
  ];
  async function copyText(value: string, success: string) {
    await navigator.clipboard.writeText(value);
    if (alive.current) setMessage(success);
  }
  return <section className="codex-gateway codex-api-page">
    <header className="codex-api-header"><div className="codex-api-title"><span className="codex-api-icon"><Server size={21} /></span><h2>本地 API 服务</h2><span className={`codex-badge${running ? " is-running" : ""}`}>{state ? running ? "运行中" : "已停止" : "检查中"}</span></div><div className="codex-actions">
      <button aria-label="服务账号池" onClick={() => setPoolOpen(true)}><Users size={14} aria-hidden="true" />服务账号池 <span className="codex-badge">{activeIds.length} / {accounts.length}</span></button>
      <button onClick={() => setLogsOpen(true)}><ScrollText size={14} />调用日志</button>
      <button disabled={locked} onClick={() => void act(async () => { const next = await codexClient.gatewayState(); if (alive.current) { setState(next); setMessage("服务统计已刷新"); } })}><RefreshCw size={14} />刷新统计</button>
      <button className="codex-api-start" disabled={!canStart} onClick={() => setConfirmation("start")}><Play size={14} />启动本地服务</button>
      <button className="codex-api-stop" disabled={locked || !running} onClick={() => setConfirmation("stop")}><Square size={14} />停止服务</button>
    </div></header>
    {!running && <p className="codex-api-description" role="status">{!accounts.length ? "请先在账号总览添加账号。" : !ids.length ? "点击“服务账号池”选择至少一个账号，再启动本地服务。" : portInvalid ? "请输入 1024–65535 的端口，或使用 0 自动分配。" : keyInvalid ? "服务密钥须为 24–256 位字母、数字或 . _ -，不能含空格。" : `已选择 ${ids.length} 个账号，可以启动服务。`}</p>}
    {error && <p className="codex-feedback error" role="alert">{error}</p>}{message && <p className="codex-feedback" role="status">{message}</p>}
    <div className="codex-api-columns">
      <section className="codex-api-card"><h3>服务配置</h3><div className="codex-api-config">
        <div className="codex-api-field"><span>Base URL</span><div className="codex-api-value"><code>{state?.address ?? "启动服务后生成访问地址"}</code><button disabled={locked || !state?.address} aria-label="复制 Base URL" title="复制 Base URL" onClick={() => void act(() => copyText(state!.address!, "Base URL 已复制"))}><Copy size={14} /></button></div></div>
        <div className="codex-api-field"><span>客户端地址</span><div><code>127.0.0.1</code><small>仅允许本机访问。</small></div></div>
        <div className="codex-api-field"><span>服务密钥</span><div><div className="codex-api-value">{running ? <code>••••••••••••••••</code> : <input ref={serviceKeyInput} type="password" aria-label="服务密钥" autoComplete="new-password" spellCheck={false} maxLength={256} placeholder={state?.supportsPersistentConfig ? "留空沿用已保存密钥；首次启动自动生成" : "留空自动生成，或填写自定义密钥"} disabled={locked || !state?.supportsCustomKey} onChange={(event) => { const value = event.target.value; setKeyInvalid(!!value && !/^[A-Za-z0-9._-]{24,256}$/.test(value)); }} />}<button disabled={locked || !running} onClick={() => void act(async () => { await codexClient.copyGatewayKey(); if (alive.current) setMessage(state?.supportsPersistentConfig ? "本地服务密钥已复制；停止和重启后保持不变" : "本地服务密钥已复制；停止服务后失效"); })}><Copy size={14} />复制服务密钥</button></div><small>{!running && state && !state.supportsCustomKey ? "当前旧测试版使用自动密钥；更新原生测试版后可自定义。" : state?.supportsPersistentConfig ? "密钥加密保存在本地。留空沿用；填写新密钥并启动后才会修改。" : "留空自动生成；当前原生版本仅本次运行有效，更新后支持固定保存。"}</small></div></div>
        <label className="codex-api-field"><span>服务端口</span><div><input aria-label="服务端口" aria-describedby="codex-api-port-help" type="number" min={0} max={65535} value={displayPort} disabled={locked || running} onChange={(event) => { portInitialized.current = true; setPort(event.target.value); }} /><small id="codex-api-port-help">0 首次自动分配后固定保存；可手动修改为 1024–65535，启动成功后保存。</small></div></label>
        <div className="codex-api-field"><label htmlFor="codex-api-model-input">模型 ID</label><div><div className="codex-api-model-row"><input id="codex-api-model-input" aria-label="唤醒模型" aria-describedby="codex-api-model-help" placeholder="填写账号可用的模型 ID" value={model} maxLength={100} disabled={locked} onChange={(event) => setModel(event.target.value)} /><button disabled={locked || !running || !state?.supportsModels} onClick={() => void act(async () => { setModelsBusy(true); setModels([]); try { const next = await codexClient.gatewayModels(); if (alive.current) { setModels(next); if (!model && next.length) setModel(next[0]); setMessage(next.length ? `已获取 ${next.length} 个模型 ID` : "当前账号未返回模型列表，可手动填写模型 ID"); } } finally { if (alive.current) setModelsBusy(false); } })}><RefreshCw size={14} />{modelsBusy ? "获取中…" : "获取模型列表"}</button></div><select aria-label="选择模型 ID" disabled={locked} value={models.includes(model) || recommendedModels.includes(model) ? model : ""} onChange={(event) => { if (event.target.value) setModel(event.target.value); }}><option value="" disabled>选择模型 ID</option><optgroup label="推荐模型（未验证账号权限）">{recommendedModels.filter((id) => !models.includes(id)).map((id) => <option key={id} value={id}>{id}</option>)}</optgroup>{models.length > 0 && <optgroup label={state?.supportsRemoteModels ? "官方目录返回" : "CLI 目录（未验证来源）"}>{models.map((id) => <option key={id} value={id}>{id}</option>)}</optgroup>}</select><small id="codex-api-model-help">{!running ? "可选择推荐模型或手动填写；推荐项未验证账号权限，启动服务后可获取官方目录。" : !state?.supportsModels ? "当前原生版本需更新后才能获取模型列表。" : !state.supportsRemoteModels ? "当前原生版本读取 CLI 目录，可能包含内置模型；更新后直接查询官方目录。" : "直接查询官方模型目录，不使用 CLI 内置列表；查询不发送推理请求。"}</small></div></div>
      </div></section>
      <section className="codex-api-card"><h3><ShieldCheck size={16} />服务状态</h3><div className="codex-api-metrics">
        <div><span>服务账号</span><strong>{activeIds.length}<small> / {accounts.length}</small></strong></div>
        <div><span>处理中</span><strong>{state ? state.active : "—"}</strong></div>
        <div><span>已完成请求</span><strong>{state ? state.completed : "—"}</strong></div>
        <div><span>失败请求</span><strong>{state ? state.failed : "—"}</strong></div>
      </div><p className="codex-api-description">请求使用服务账号的订阅额度或 API 账单。{state?.supportsFunctionTools ? "Responses 支持文本、函数工具及流式输出；工具执行由客户端权限控制，网关不执行本机工具。暂不支持图片或托管工具。" : "支持文本请求及流式输出，不执行本机工具。"}</p><p className="codex-api-description">统计来自当前服务进程。ChatGPT 订阅端点可能随官方客户端变化。</p></section>
    </div>
    <dialog ref={poolDialog} className="codex-dialog codex-pool-dialog" aria-labelledby="codex-pool-title" onCancel={() => setPoolOpen(false)} onClose={() => setPoolOpen(false)}>
      <header><h2 id="codex-pool-title">服务账号池</h2><button aria-label="关闭服务账号池" title="关闭服务账号池" onClick={() => setPoolOpen(false)}><X size={16} /></button></header>
      <div className="codex-pool-dialog-body">
    <section className="codex-api-card"><div className="codex-api-section-heading"><h3>账号选择 <span className="codex-badge">{activeIds.length} 个账号</span></h3><div className="codex-actions"><button disabled={locked || running || !accounts.length} onClick={() => setPool(ids.length === accounts.length ? new Set() : new Set(accounts.map((account) => account.id)))}>{ids.length === accounts.length && accounts.length ? "清空选择" : "全选账号"}</button><button disabled={locked || !ids.length || !/^[A-Za-z0-9._-]{1,100}$/.test(model)} onClick={() => setConfirmation("wake")}><Power size={14} />唤醒所选账号</button></div></div><p className="codex-api-description">选择用于请求的账号；修改账号池需先停止服务。唤醒会发送模型请求并消耗额度。</p>
      <div className="codex-service-pool" role="group" aria-label="本地 API 服务账号">{accounts.map((account) => <label key={account.id}><input type="checkbox" aria-label={account.label} checked={activeIds.includes(account.id)} disabled={locked || running} onChange={() => setPool((current) => { const next = new Set(current); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next; })} /><PoolQuota account={account} /></label>)}</div>{!accounts.length && <p className="codex-api-description">请先在账号总览添加账号。</p>}
    </section>
      </div><div className="codex-dialog-actions"><button onClick={() => setPoolOpen(false)}>完成</button></div>
    </dialog>
    <GatewayMonitoring logsOpen={logsOpen} onClose={() => setLogsOpen(false)} accounts={accounts} state={state} locked={locked} act={act} onState={setState} />
    <section className="codex-api-card"><h3>协议兼容</h3><p className="codex-api-description">同一服务地址提供以下入口。示例中的 &lt;SERVICE_KEY&gt; 需替换为复制的服务密钥。</p><div className="codex-protocol-grid">{protocols.map((protocol) => <article className={`codex-protocol-card${protocol.supported ? "" : " is-unavailable"}`} key={protocol.name}><div className="codex-api-section-heading"><h4>{protocol.name}</h4><span className="codex-badge">{protocol.supported ? "文本已接入" : "未接入"}</span></div><code className="codex-protocol-path">{protocol.path}</code>{protocol.supported ? <><pre>{protocol.example}</pre><div className="codex-api-section-heading"><small>{protocol.hint}</small><button disabled={locked || !running} aria-label={`复制 ${protocol.name} 接入配置`} title="复制示例配置（密钥需另行填写）" onClick={() => void act(() => copyText(protocol.example!, "接入配置已复制，请填写服务密钥"))}><Copy size={14} /></button></div></> : <p>当前服务未提供此协议入口。</p>}</article>)}</div><p className="codex-api-description">{state?.supportsModels ? state.supportsRemoteModels ? "模型目录：GET /v1/models，需携带服务密钥。来自官方上游，缓存 60 秒；实际调用权限仍以上游为准。" : "当前原生版本模型目录来自 CLI，可能包含内置模型；更新后将直接查询官方上游。" : "当前原生版本尚未提供 /v1/models；更新测试版后即可使用模型列表。"}</p></section>
    <dialog ref={dialog} className="codex-dialog" aria-label={confirmation === "start" ? "启动本地 API 服务" : confirmation === "stop" ? "停止本地 API 服务" : "唤醒 Codex 账号"} onCancel={(event) => { event.preventDefault(); if (!busy) setConfirmation(null); }}><header><h2>{confirmation === "start" ? "启动本地 API 服务" : confirmation === "stop" ? "停止本地 API 服务" : "唤醒 Codex 账号"}</h2><button disabled={busy} aria-label="关闭服务对话框" onClick={() => setConfirmation(null)}><X size={16} /></button></header><p>{confirmation === "start" ? "外部本机客户端持有服务密钥后，可以通过所选账号发起请求并消耗额度。服务账号不能同时启动受管 CLI 实例。" : confirmation === "stop" ? state?.supportsPersistentConfig ? "停止服务将取消正在传输的请求；已保存的密钥和端口将在下次启动时沿用。" : "停止服务将取消正在传输的请求，当前旧原生版本的服务密钥随即失效。" : `向 ${ids.length} 个账号各发送一次简短请求，模型为 ${model}。这可能消耗额度或产生 API 费用，不会增加可用额度，也不改变官方重置时间。`}</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button disabled={busy} onClick={() => void act(async () => {
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
