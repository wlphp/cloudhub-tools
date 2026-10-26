import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, LoaderCircle, Network, Pencil, Plus, RotateCw, ScanSearch, Save, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { nativeOnly } from "../../platform/clients/base";
import { runningInTauri } from "../../platform/api";
import { SharedDialog } from "../../shared/SharedDialog";

type ProxyStatus = { id: string; name: string; url: string; authConfigured: boolean };
type ProxyDraft = ProxyStatus & { username: string; password: string };
type PoolStatus = { enabled: boolean; selectedId: string | null; proxies: ProxyStatus[] };
type ProxyCandidate = { url: string; source: string; enabled: boolean };
const supportsNetworkProxy = runningInTauri;
const emptyDraft = (): ProxyDraft => ({ id: crypto.randomUUID(), name: "", url: "", authConfigured: false, username: "", password: "" });

export function NetworkSettingsPage({ mobile = false }: { mobile?: boolean }) {
  const [pool, setPool] = useState<PoolStatus>({ enabled: false, selectedId: null, proxies: [] });
  const [drafts, setDrafts] = useState<ProxyDraft[]>([]);
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [busyAction, setBusyAction] = useState<"load" | "save" | "detect" | { type: "test"; proxyId: string } | null>(null);
  const busy = busyAction !== null;
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<ProxyCandidate[]>([]);
  const [latencies, setLatencies] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => { setMessage(""); setError(""); }, 3500);
    return () => window.clearTimeout(timer);
  }, [message, error]);

  async function load() {
    setBusyAction("load"); setError("");
    try {
      const value = await nativeOnly<PoolStatus>("network_proxy_get");
      setPool(value);
      setDrafts(value.proxies.map(proxy => ({ ...proxy, username: "", password: "" })));
      setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取代理池失败"); }
    finally { setBusyAction(null); }
  }
  useEffect(() => { if (supportsNetworkProxy) void load(); }, []);

  function updateDraft(id: string, patch: Partial<ProxyDraft>) {
    setDraft(item => item?.id === id ? { ...item, ...patch } : item);
  }
  function edit(proxy: ProxyDraft) { setDraft({ ...proxy, username: proxy.authConfigured ? "" : proxy.username, password: proxy.authConfigured ? "" : proxy.password }); }
  function applyDraft() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.url.trim()) { setError("请填写代理名称和地址。"); return; }
    setError("");
    setDrafts(items => items.some(item => item.id === draft.id)
      ? items.map(item => item.id === draft.id ? draft : item)
      : [...items, draft]);
    setLatencies(current => { const next = { ...current }; delete next[draft.id]; return next; });
    setDraft(null);
  }
  function remove(id: string) {
    const next = drafts.filter(item => item.id !== id);
    setLatencies(current => { const value = { ...current }; delete value[id]; return value; });
    setDrafts(next); setDraft(current => current?.id === id ? null : current);
    setPool(current => ({ ...current, proxies: next, selectedId: current.selectedId === id ? next[0]?.id ?? null : current.selectedId, enabled: current.enabled && next.length > 0 }));
  }
  function addDraft() { setError(""); setCandidates([]); setDraft(emptyDraft()); }

  async function save() {
    setBusyAction("save"); setError(""); setMessage("");
    try {
      const value = await nativeOnly<PoolStatus>("network_proxy_save", {
        enabled: pool.enabled, selectedId: pool.selectedId,
        proxies: drafts.map(({ id, name, url, username, password }) => ({ id, name, url, username, password })),
      });
      setPool(value); setDrafts(value.proxies.map(proxy => ({ ...proxy, username: "", password: "" })));
      setDraft(null); setMessage("代理池已保存；已选择的代理将作为全局代理使用。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存代理池失败"); }
    finally { setBusyAction(null); }
  }
  async function test(proxy: ProxyDraft) {
    setBusyAction({ type: "test", proxyId: proxy.id }); setError(""); setMessage("");
    setLatencies(current => { const next = { ...current }; delete next[proxy.id]; return next; });
    try {
      const latency = await nativeOnly<number>("network_proxy_test", { proxyId: proxy.id, url: proxy.url, username: proxy.username, password: proxy.password, keepAuth: proxy.authConfigured && !proxy.username && !proxy.password });
      setLatencies(current => ({ ...current, [proxy.id]: latency }));
      setMessage(`“${proxy.name || "未命名代理"}”连通性测试成功。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "代理连接测试失败"); }
    finally { setBusyAction(null); }
  }
  async function detect() {
    setBusyAction("detect"); setError(""); setMessage("");
    try {
      const values = await nativeOnly<ProxyCandidate[]>("network_proxy_detect");
      setCandidates(values);
      if (!values.length) setMessage("没有检测到可用的 HTTP/HTTPS 代理地址，可手动填写。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取本机代理配置失败"); }
    finally { setBusyAction(null); }
  }

  return <section className={`settings-grid settings-list network-settings${mobile ? " mobile-network-settings" : ""}`}>
    <div className="network-settings-heading"><div><h2><Network size={18} />全局出站代理</h2><p>为应用出站请求指定默认代理。账号或功能单独配置的代理优先；未单独配置时使用这里选择的代理。</p></div><button type="button" className="secondary" onClick={() => void load()} disabled={!supportsNetworkProxy || busy}>{busyAction === "load" ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}{busyAction === "load" ? "刷新中" : "刷新"}</button></div>
    {!supportsNetworkProxy ? <p className="network-settings-notice">网络代理设置仅支持桌面客户端，移动端和浏览器预览版不会模拟代理状态。</p> : <>
      <div className="network-settings-card">
        <div className="network-pool-toolbar"><label className="network-proxy-toggle"><input type="checkbox" checked={pool.enabled} onChange={event => setPool(current => ({ ...current, enabled: event.target.checked }))} /><span><strong>启用全局出站代理</strong><small>从下方代理池中选择默认代理；关闭时不额外指定代理</small></span></label><button type="button" className="secondary" onClick={addDraft} disabled={busy}><Plus size={14} />添加代理</button></div>
        {drafts.length === 0 ? <div className="network-pool-empty">代理池为空。添加一个 HTTP/HTTPS 代理后即可选择使用。</div> : <div className="network-pool-list" role="radiogroup" aria-label="选择全局代理">
          {drafts.map(proxy => <article className={`network-pool-item${pool.selectedId === proxy.id ? " is-selected" : ""}`} key={proxy.id}>
            <label className="network-pool-choice"><input type="radio" name="global-proxy-choice" checked={pool.selectedId === proxy.id} onChange={() => setPool(current => ({ ...current, selectedId: proxy.id }))} /><span className="network-pool-details"><strong>{proxy.name || "未命名代理"}</strong><span>{proxy.url || "未填写地址"}</span><small>{proxy.authConfigured ? "已配置认证" : "无认证"}{pool.selectedId === proxy.id ? " · 当前选择" : ""}{latencies[proxy.id] !== undefined ? ` · 延迟 ${latencies[proxy.id]} ms` : ""}</small></span></label>
            <div className="network-pool-item-actions"><button type="button" className="secondary" aria-label={`测试${proxy.name || "代理"}`} title="测试连接" disabled={busy || !proxy.url} onClick={() => void test(proxy)}>{busyAction && typeof busyAction === "object" && busyAction.type === "test" && busyAction.proxyId === proxy.id ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}{busyAction && typeof busyAction === "object" && busyAction.type === "test" && busyAction.proxyId === proxy.id ? "测试中" : "测试"}</button><button type="button" className="secondary" aria-label={`编辑${proxy.name || "代理"}`} title="编辑" disabled={busy} onClick={() => edit(proxy)}><Pencil size={14} /></button><button type="button" className="secondary danger" aria-label={`移除${proxy.name || "代理"}`} title="移出代理池" disabled={busy} onClick={() => remove(proxy.id)}><Trash2 size={14} /></button></div>
          </article>)}
        </div>}
        <div className="network-proxy-actions"><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busyAction === "save" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{busyAction === "save" ? "保存中" : "保存代理池"}</button></div>
      </div>
      <div className="network-priority-card"><h3><ShieldCheck size={16} />代理优先级</h3><ol><li><strong>账号/功能专属代理</strong>：该请求使用自己的代理。</li><li><strong>全局代理池</strong>：没有专属代理且全局已开启时，使用当前选择项。</li><li><strong>直连/系统网络</strong>：前两者都未启用时，不额外指定代理；操作系统代理或 VPN 仍可能生效。</li></ol><p>当前支持 HTTP/HTTPS（含可选认证）；SOCKS5 暂不支持。代理认证信息在本机加密保存，代理地址和认证信息不会写入 API 日志。全局代理使用当前应用进程代理环境变量，应用启动的兼容子进程可能继承这些变量。设置对新建连接生效。</p></div>
      {(message || (error && !draft)) && createPortal(<div className={`toast-notice network-toast-notice${error ? " network-toast-error" : ""}`} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">{message ? <><Check size={15} aria-hidden="true" />{message}</> : error}</div>, document.body)}
      {draft && <SharedDialog
        title={drafts.some(item => item.id === draft.id) ? "编辑代理" : "添加代理"}
        subtitle="配置后先加入代理池，再保存代理池使更改生效。"
        icon={<Network size={18} aria-hidden="true" />}
        size="small"
        className="network-proxy-dialog"
        busy={busy}
        onClose={() => setDraft(null)}
        bodyClassName="network-proxy-dialog-body"
        footer={<><button type="button" className="secondary" onClick={() => setDraft(null)}>取消</button><button type="button" className="primary" disabled={busy} onClick={applyDraft}>{drafts.some(item => item.id === draft.id) ? "应用修改" : "加入代理池"}</button></>}
      >
        <div className="network-proxy-credentials"><label>代理名称<input value={draft.name} onChange={event => updateDraft(draft.id, { name: event.target.value })} maxLength={80} placeholder="例如：香港节点" autoFocus /></label><label>代理地址（HTTP/HTTPS）<input value={draft.url} onChange={event => updateDraft(draft.id, { url: event.target.value })} placeholder="http://127.0.0.1:7890" autoComplete="url" /></label></div>
        {!mobile && <div className="network-pool-editor-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void detect()}>{busyAction === "detect" ? <LoaderCircle size={14} className="spin" /> : <ScanSearch size={14} />}{busyAction === "detect" ? "检测中" : "检测地址"}</button>{candidates.map((candidate, index) => <button type="button" className="network-candidate-chip" key={`${candidate.url}-${index}`} onClick={() => updateDraft(draft.id, { url: candidate.url })}>{candidate.url}<small>{candidate.source}{candidate.enabled ? " · 系统已启用" : ""}</small></button>)}</div>}
        <div className="network-proxy-credentials"><label>用户名（可选）<input value={draft.username} onChange={event => updateDraft(draft.id, { username: event.target.value })} autoComplete="off" placeholder={draft.authConfigured ? "已保存，留空保留" : "代理用户名"} /></label><label>密码（可选）<input type="password" value={draft.password} onChange={event => updateDraft(draft.id, { password: event.target.value })} autoComplete="new-password" placeholder={draft.authConfigured ? "已保存，留空保留" : "代理密码"} /></label></div>
        <p className="network-pool-hint">凭据仅在本机加密保存。更换已保存的认证信息时，请同时填写用户名和密码。SOCKS5 暂不支持。</p>
        {error && <p className="network-settings-error" role="alert">{error}</p>}
      </SharedDialog>}
    </>}
  </section>;
}
