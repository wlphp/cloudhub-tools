import { useEffect, useState } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { httpDebugProxyClient as client, type HttpInterceptConfig, type HttpInterceptSummary, type HttpInterceptDetail, type HttpInterceptDecision } from "../../platform/clients/http-debug-proxy";

export function HttpInterceptPanel({ running }: { running: boolean }) {
  const [config, setConfig] = useState<HttpInterceptConfig>({ request: false, response: false, keyword: "" });
  const [pending, setPending] = useState<HttpInterceptSummary[]>([]);
  const [editing, setEditing] = useState<HttpInterceptDetail | null>(null);
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState(200);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (!running) { setPending([]); setEditing(null); setBody(""); setUrl(""); setApplied(false); return; }
    let active = true;
    let polling = false;
    async function poll(initial = false) {
      if (polling) return;
      polling = true;
      try { const next = await client.intercepts(); if (active) { setPending(next.pending); if (initial) setConfig(next.config); } }
      catch { /* The parent reports stopped or unavailable proxy state. */ }
      finally { polling = false; }
    }
    void poll(true);
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [running]);
  async function apply() {
    setBusy(true); setError("");
    try { await client.configureIntercept(config); setPending((await client.intercepts()).pending); setApplied(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "设置断点失败"); }
    finally { setBusy(false); }
  }
  async function edit(id: string) {
    setBusy(true); setError("");
    try { const value = await client.interceptDetail(id); setEditing(value); setBody(value.body ?? ""); setUrl(""); setStatus(value.status); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "暂停已结束"); }
    finally { setBusy(false); }
  }
  async function resolve(id: string, decision: HttpInterceptDecision) {
    setBusy(true); setError("");
    try { await client.resolveIntercept(id, decision); setEditing(null); setBody(""); setUrl(""); setPending((await client.intercepts()).pending); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "放行失败"); }
    finally { setBusy(false); }
  }
  const expired = editing && !pending.some(item => item.id === editing.summary.id);
  const editorActions = editing ? <>
    <button type="button" className="primary" disabled={busy || !!expired} onClick={() => void resolve(editing.summary.id, { cancel: false, ...(editing.body !== null && body !== editing.body ? { body } : {}), ...(editing.summary.phase === "request" && url.trim() ? { url: url.trim() } : {}), ...(editing.summary.phase === "response" && status !== editing.status ? { status } : {}) })}>修改后继续</button>
    <button type="button" className="secondary" disabled={busy || !!expired} onClick={() => void resolve(editing.summary.id, { cancel: false })}>原样放行</button>
    <button type="button" className="secondary" disabled={busy || !!expired} onClick={() => void resolve(editing.summary.id, { cancel: true })}>取消请求</button>
  </> : undefined;
  return <section className="http-debug-proxy-intercept" aria-label="请求响应断点">
    <div className="http-debug-proxy-intercept-controls">
      <strong>断点拦截</strong>
      <label><input type="checkbox" checked={config.request} onChange={event => { setConfig(value => ({ ...value, request: event.target.checked })); setApplied(false); }} />发送前暂停</label>
      <label><input type="checkbox" checked={config.response} onChange={event => { setConfig(value => ({ ...value, response: event.target.checked })); setApplied(false); }} />返回前暂停</label>
      <label className="http-debug-proxy-intercept-keyword">地址包含<input value={config.keyword} onChange={event => { setConfig(value => ({ ...value, keyword: event.target.value })); setApplied(false); }} placeholder="域名或路径，留空匹配全部" maxLength={2048} /></label>
      <button type="button" className="secondary" disabled={busy || !running} onClick={() => void apply()}>{applied ? "断点已应用" : "应用断点"}</button>
      <strong role="status">待处理 {pending.length}</strong>
    </div>
    <p className="http-debug-proxy-intercept-hint">请求发送前或响应返回前暂停，编辑后继续。最长等待 3 分钟，超时自动原样放行。</p>
    <details><summary>使用说明与编辑范围</summary><p>先启动抓包，再应用断点。地址关键字区分大小写，HTTPS 需要解密。关闭某阶段断点并应用会放行该阶段等待内容；停止抓包会取消等待。关闭编辑窗口保留暂停，清空会话不影响断点。客户端自身超时仍然有效。</p><p>支持不超过 256 KB 的完整 UTF-8 正文、替换请求 URL 和响应状态码。压缩或二进制正文只能保留原样；不支持 WebSocket 消息或流式逐块编辑。正文可能含敏感数据，仅在编辑窗口临时显示。</p></details>
    {error && !editing && <p className="http-debug-proxy-error" role="alert">{error}</p>}
    {pending.length > 0 && <ul className="http-debug-proxy-pending">{pending.map(item => <li key={item.id}>
      <strong>{item.phase === "request" ? "请求待发送" : "响应待返回"}</strong><code title={item.url}>{item.method} {item.url}</code><span>到 {new Date(item.expiresAt).toLocaleTimeString()} 放行</span>
      <button type="button" className="secondary" disabled={busy} onClick={() => void edit(item.id)}>编辑并继续</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void resolve(item.id, { cancel: false })}>原样放行</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void resolve(item.id, { cancel: true })}>取消请求</button>
    </li>)}</ul>}
    {editing && <SharedDialog title={editing.summary.phase === "request" ? "请求断点 · 发送前编辑" : "响应断点 · 返回前编辑"} subtitle={`到 ${new Date(editing.summary.expiresAt).toLocaleTimeString()} 自动原样放行`} size="large" resizable sizeStorageKey="http-debug-proxy-intercept" footer={editorActions} onClose={() => { setEditing(null); setBody(""); setUrl(""); setError(""); }}>
      <div className="http-debug-proxy-intercept-editor">
        <pre>{editing.summary.method} {editing.summary.url}</pre>
        {editing.summary.phase === "request" ? <label>替换完整 URL（可选，留空保留原地址及参数）<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/path?key=value" /></label> : <label>响应状态码<input type="number" min={200} max={599} value={status} onChange={event => setStatus(Number(event.target.value))} /></label>}
        {editing.body === null ? <p>此正文为压缩、二进制或超过编辑限制，无法安全编辑。</p> : <label>正文<textarea aria-label="正文" value={body} onChange={event => setBody(event.target.value)} spellCheck={false} /></label>}
        <p>正文可能含敏感数据。地址中的敏感参数已隐藏，替换 URL 时请填写完整地址。</p>
        {expired && <p role="status">此暂停已结束，编辑内容不会再发送。</p>}
        {error && <p className="http-debug-proxy-error" role="alert">{error}</p>}
      </div>
    </SharedDialog>}
  </section>;
}
