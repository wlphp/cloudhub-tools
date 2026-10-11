import { useEffect, useRef, useState } from "react";
import { CalendarDays, Edit3, RefreshCw, RotateCcw, Shield, X } from "lucide-react";
import { codexClient, type CodexAccount } from "../../platform/clients/codex";

export function AccountControls({ account, busy, act, onAccount, onEdit }: { account: CodexAccount; busy: boolean; act: (name: string, run: () => Promise<void>) => Promise<void>; onAccount: (account: CodexAccount) => void; onEdit: () => void }) {
  const [modal, setModal] = useState<"proxy" | "reset" | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current=true; return () => { alive.current=false; }; }, []);
  useEffect(() => { if (modal) dialog.current?.showModal(); else dialog.current?.close(); }, [modal]);
  const benefits = account.benefits;
  const expires = benefits?.expiresAt;
  const remainingDays = expires == null ? null : Math.max(0, Math.ceil((expires * 1000 - Date.now()) / 86400000));
  const run = (name: string, action: () => Promise<void>) => act(name, async () => { setError(""); try { await action(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "账号操作失败，请重试"); throw reason; } });
  const refresh = () => run("刷新账号权益", async () => { const next = await codexClient.refreshBenefits(account.id); if (alive.current) onAccount(next); });
  const close = () => { if (!busy) { setModal(null); setError(""); } };
  return <>
    <div className="codex-account-controls">
      <button disabled={busy} aria-label={`编辑 ${account.label} 备注`} onClick={onEdit}><Edit3 size={13} />{account.note ? "改备注" : "加备注"}</button>
      <button disabled={busy} aria-label={`配置 ${account.label} 代理`} title={account.proxyUrl ? `已配置：${account.proxyUrl}` : "沿用系统网络设置"} onClick={() => { setUrl(account.proxyUrl ?? ""); setError(""); setModal("proxy"); }}><Shield size={13} />{account.proxyUrl ? "代理已设" : "代理"}</button>
      {account.authMode === "chatgpt" && <button disabled={busy} aria-label={`查看 ${account.label} 重置次数`} onClick={() => { setError(""); setModal("reset"); }}><RotateCcw size={13} />重置 {benefits?.resetCredits ?? "—"}</button>}
    </div>
    {account.authMode === "chatgpt" && <div className={`codex-subscription${expires && remainingDays! > 0 ? " is-active" : ""}`}>
      <div><CalendarDays size={14} /><strong>{remainingDays == null ? "未获取订阅有效期" : remainingDays === 0 ? "订阅已到期" : `订阅有效期 ${remainingDays} 天`}</strong><button disabled={busy} aria-label={`刷新 ${account.label} 订阅与重置次数`} onClick={() => void refresh()}><RefreshCw size={13} />刷新</button></div>
      {expires != null && <small>{new Date(expires * 1000).toLocaleString()}</small>}
      {benefits?.fetchedAt && <small>权益更新：{new Date(benefits.fetchedAt).toLocaleString()}（缓存）</small>}
      {benefits?.subscriptionError && <small className="codex-card-error">订阅查询失败：{benefits.subscriptionError}</small>}
      {benefits?.creditsError && <small className="codex-card-error">重置次数查询失败：{benefits.creditsError}</small>}
    </div>}
    <dialog ref={dialog} className="codex-dialog" aria-label={modal === "proxy" ? "账号代理" : "主动重置额度"} onCancel={(event) => { event.preventDefault(); close(); }}>
      <header><h2>{modal === "proxy" ? "账号代理" : "主动重置额度"}</h2><button disabled={busy} aria-label="关闭账号设置" title="关闭" onClick={close}><X size={16} /></button></header>
      <p className="codex-account-dialog-label">{account.label}</p>
      {modal === "proxy" ? <form onSubmit={(event) => { event.preventDefault(); void run("保存账号代理", async () => { const next = await codexClient.saveProxy(account.id, url); if (alive.current) { onAccount(next); setModal(null); } }); }}>
        <label>HTTP/HTTPS 代理地址<input aria-label="账号代理地址" placeholder="http://127.0.0.1:7890" maxLength={512} value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} /></label>
        <p>留空沿用系统网络。仅支持无账号密码的 HTTP/HTTPS 代理；SOCKS、订阅节点和代理认证尚未支持。用于该账号的额度/权益查询、网关上游请求及新启动的独立实例。修改前请停止该账号的服务和实例；默认客户端不受影响。</p>
        {error && <p role="alert" className="codex-card-error">{error}</p>}
        <div className="codex-dialog-actions"><button type="button" disabled={busy} onClick={close}>取消</button><button disabled={busy}>保存代理</button></div>
      </form> : <>
        <p>官方可用主动重置次数：<strong>{benefits?.resetCredits ?? "未获取"}</strong></p>
        {benefits?.resetExpiresAt && <p>最近到期：{new Date(benefits.resetExpiresAt * 1000).toLocaleString()}</p>}
        <p>确认会消耗一次官方重置机会，刷新使用限额，并可能改变下次重置时间。不会购买次数。请先停止该账号的服务和实例。提交前会重新核对可用次数。</p>
        {benefits?.creditsError && <p role="status" className="codex-card-error">{benefits.creditsError}</p>}
        {error && <p role="alert" className="codex-card-error">{error}</p>}
        <div className="codex-dialog-actions"><button disabled={busy} onClick={() => void refresh()}>刷新次数</button><button disabled={busy} onClick={close}>取消</button><button disabled={busy || !benefits?.resetCredits || !!benefits.creditsError} onClick={() => void run("主动重置额度", async () => { const next=await codexClient.consumeReset(account.id); if (alive.current) { onAccount(next); setModal(null); } })}>确认消耗一次并重置</button></div>
      </>}
    </dialog>
  </>;
}
