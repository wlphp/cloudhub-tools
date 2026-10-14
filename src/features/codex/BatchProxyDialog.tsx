import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { codexClient, type CodexAccount } from "../../platform/clients/codex";

export function BatchProxyDialog({ accounts, busy, act, onSaved, onClose }: { accounts: CodexAccount[]; busy: boolean; act: (name: string, run: () => Promise<void>) => Promise<void>; onSaved: (accounts: CodexAccount[]) => void; onClose: () => void }) {
  const common = accounts.every(account => account.proxyUrl === accounts[0]?.proxyUrl);
  const [url, setUrl] = useState(common ? accounts[0]?.proxyUrl ?? "" : "");
  const [error, setError] = useState("");
  const [proxies, setProxies] = useState<{ url: string; source: string; enabled: boolean }[]>([]);
  const [detected, setDetected] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const node = dialog.current; node?.showModal(); return () => { alive.current = false; node?.close(); }; }, []);
  const locked = busy || detecting;
  async function detect() {
    setDetecting(true); setError(""); setDetected(false); setProxies([]);
    try { const rows = await codexClient.detectProxies(); if (alive.current) { setProxies(rows); setDetected(true); } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "读取本机代理配置失败，请手动填写代理地址"); }
    finally { if (alive.current) setDetecting(false); }
  }
  return <dialog ref={dialog} className="codex-dialog" aria-label="批量设置代理" onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <header><h2>批量设置代理</h2><DialogHeaderActions><button type="button" disabled={locked} onClick={onClose} aria-label="关闭批量代理设置" title="关闭"><X size={16} /></button></DialogHeaderActions></header>
    <p>将统一设置当前列表内已选的 {accounts.length} 个账号。{!common && "所选账号当前代理不同，保存后统一替换。"}</p>
    <form onSubmit={event => {
      event.preventDefault(); if (locked) return;
      if (url.trim() && !url.includes("://")) { setError("代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址"); return; }
      void act("批量设置代理", async () => {
        setError("");
        try { const next = await codexClient.saveProxies(accounts.map(account => account.id), url); if (alive.current) onSaved(next); }
        catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "批量保存代理失败，未修改任何账号"); throw reason; }
      });
    }}>
      <label>HTTP/HTTPS 代理地址<input autoFocus aria-label="批量代理地址" aria-describedby={`codex-batch-proxy-help${error ? " codex-batch-proxy-error" : ""}`} aria-invalid={!!error} placeholder="http://127.0.0.1:10808" maxLength={512} disabled={locked} value={url} onChange={event => { setUrl(event.target.value); setError(""); }} /></label>
      {error && <p id="codex-batch-proxy-error" role="alert" className="codex-card-error">{error}</p>}
      <div className="codex-proxy-detection"><button type="button" disabled={locked} onClick={() => void detect()}><RefreshCw size={14} aria-hidden="true" />{detecting ? "正在检测…" : "检测本机代理"}</button><span>读取系统配置和环境变量，不会自动保存。</span></div>
      {detected && <div className="codex-proxy-candidates" role="status">{proxies.length ? <><label>检测到的代理<select aria-label="检测到的批量代理" value="" disabled={locked} onChange={event => { if (event.target.value) { setUrl(event.target.value); setError(""); } }}><option value="">选择地址填入</option>{proxies.map((proxy, index) => <option key={index} value={proxy.url}>{proxy.url} · {proxy.source}{proxy.enabled ? "" : "（系统代理已关闭）"}</option>)}</select></label><small>地址来自已保存的配置，尚未验证连接。</small></> : <p>未检测到可用的 HTTP/HTTPS 代理配置，请手动填写。</p>}</div>}
      <p id="codex-batch-proxy-help">留空会清除这 {accounts.length} 个账号的代理，恢复沿用系统网络。仅支持无账号密码的 HTTP/HTTPS 代理。请先停止所选账号的服务、实例及唤醒任务；任一账号不可修改时整批不保存。</p>
      <div className="codex-dialog-actions"><button type="button" disabled={locked} onClick={onClose}>取消</button><button disabled={locked || !accounts.length}>{url.trim() ? `保存到 ${accounts.length} 个账号` : `清除 ${accounts.length} 个账号代理`}</button></div>
    </form>
  </dialog>;
}
