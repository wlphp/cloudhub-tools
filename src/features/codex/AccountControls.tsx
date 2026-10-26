import { RefreshFailure } from "./RefreshFailure";
import { SharedDialog } from "../../shared/SharedDialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Edit3, RefreshCw, Shield } from "lucide-react";
import { codexClient, type CodexAccount } from "../../platform/clients/codex";

export function AccountControls({ account, busy, act, onAccount, onEdit, onNotice, headerAction, children, onRefreshBenefits, refreshing = false }: { account: CodexAccount; busy: boolean; act: (name: string, run: () => Promise<void>) => Promise<void>; onAccount: (account: CodexAccount) => void; onEdit: () => void; onNotice?: (message: string) => void; headerAction?: ReactNode; children?: ReactNode; refreshing?: boolean; onRefreshBenefits?: () => Promise<void> }) {
  const [modal, setModal] = useState<"proxy" | "reset" | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [proxies, setProxies] = useState<{ url: string; source: string; enabled: boolean }[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);
  const [subscriptionExpanded, setSubscriptionExpanded] = useState(false);
  useEffect(() => { setSubscriptionExpanded(false); }, [account.id, refreshing]);
  const alive = useRef(true);
  useEffect(() => { alive.current=true; return () => { alive.current=false; }; }, []);
  const benefits = account.benefits;
  const expires = benefits?.expiresAt;
  const remainingDays = expires == null ? null : Math.max(0, Math.ceil((expires * 1000 - Date.now()) / 86400000));
  const run = (name: string, action: () => Promise<void>) => act(name, async () => { setError(""); try { await action(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "账号操作失败，请重试"); throw reason; } });
  const refresh = () => onRefreshBenefits ? onRefreshBenefits() : run("刷新账号权益", async () => { const next = await codexClient.refreshBenefits(account.id); if (alive.current) { onAccount(next); onNotice?.(`${account.label} 的订阅权益已刷新`); } });
  const close = () => { if (!busy && !detecting) { setModal(null); setError(""); } };
  const detect = async () => {
    setDetecting(true); setError(""); setDetected(false); setProxies([]);
    try { const rows = await codexClient.detectProxies(); if (alive.current) { setProxies(rows); setDetected(true); } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "读取本机代理配置失败，请手动填写代理地址"); }
    finally { if (alive.current) setDetecting(false); }
  };
  return <>
    <div className="codex-account-controls">
      <span className="codex-account-kind">{account.isWebSession ? "Web Session" : account.authMode === "chatgpt" ? "Team Name：" + ((account.workspaceName?.toLowerCase() === "personal" ? "个人账户" : account.workspaceName) || (["team", "business", "enterprise", "edu"].includes(account.plan?.toLowerCase() ?? "") ? "团队名称未获取" : "个人账户")) : "API Key 账号"}</span>
      <div className="codex-account-action-row">
      {headerAction}
      <button disabled={busy} aria-label={`编辑 ${account.label} 备注`} onClick={onEdit}><Edit3 size={13} />{account.note ? "改备注" : "加备注"}</button>{account.authMode === "chatgpt" && <button className="codex-reset-chip" disabled={busy} aria-label={`查看 ${account.label} 重置次数`} onClick={() => { setError(""); setModal("reset"); }}><RefreshCw size={12} />重置 {benefits?.resetCredits ?? "未获取"}</button>}
      <button disabled={busy} aria-label={`配置 ${account.label} 代理`} title={account.proxyUrl ? `已配置：${account.proxyUrl}` : "沿用系统网络设置"} onClick={() => { setUrl(account.proxyUrl ?? ""); setError(""); setProxies([]); setDetected(false); setModal("proxy"); }}><Shield size={13} />{account.proxyUrl ? "代理已设" : "代理"}</button>
      </div>
    </div>

    {children}
    {account.authMode === "chatgpt" && <div className={`codex-subscription${expires && remainingDays! > 0 ? " is-active" : ""}`}>
      <div><CalendarDays size={14} /><strong>{remainingDays == null ? "未获取订阅信息" : remainingDays === 0 ? "订阅已到期" : `订阅有效期 ${remainingDays} 天`}</strong><button disabled={busy} aria-label={`刷新 ${account.label} 订阅与重置次数`} title={refreshing ? "此账号正在刷新，请稍候" : "刷新订阅有效期和剩余重置次数"} aria-busy={refreshing} onClick={() => void refresh()}><RefreshCw className={refreshing ? "codex-refresh-spinning" : undefined} size={13} />{refreshing ? "刷新中…" : "刷新"}</button></div>
      {(expires != null || benefits?.fetchedAt || benefits?.subscriptionError || benefits?.creditsError) && <details className="codex-benefit-details" open={subscriptionExpanded} onToggle={event => setSubscriptionExpanded(event.currentTarget.open)}><summary>{expires != null && benefits?.subscriptionError ? "查看订阅详情 · 上次缓存" : "查看订阅详情"}</summary>
      {subscriptionExpanded && <>
      {expires != null && <small>{new Date(expires * 1000).toLocaleString()}</small>}
      {benefits?.fetchedAt && <small>权益更新：{new Date(benefits.fetchedAt).toLocaleString()}（缓存）</small>}
      {benefits?.subscriptionError && <RefreshFailure key={benefits.subscriptionError} label="最近一次订阅查询失败" reason={benefits.subscriptionError} />}
      {benefits?.creditsError && <RefreshFailure key={benefits.creditsError} label="重置次数查询失败" reason={benefits.creditsError} />}
      </>}
      </details>}
    </div>}
    {modal && <SharedDialog title={modal === "proxy" ? "账号代理" : "主动重置额度"} className={`codex-dialog${modal === "reset" ? " codex-reset-dialog" : ""}`} closeLabel="关闭账号设置" closeDisabled={busy || detecting} onClose={close}>
      <p className="codex-account-dialog-label">{account.label}</p>
      {modal === "proxy" ? <form onSubmit={(event) => { event.preventDefault(); if (detecting) return; if (url.trim() && !url.includes("://")) { setError("代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址"); return; } void run("保存账号代理", async () => { const next = await codexClient.saveProxy(account.id, url); if (alive.current) { onAccount(next); setModal(null); } }); }}>
        <label>HTTP/HTTPS 代理地址<input aria-label="账号代理地址" aria-describedby={`codex-proxy-help-${account.id}${error ? ` codex-proxy-error-${account.id}` : ""}`} aria-invalid={!!error} placeholder="http://127.0.0.1:7890" maxLength={512} value={url} disabled={busy || detecting} onChange={(event) => { setUrl(event.target.value); setError(""); }} /></label>
        {error && <p id={`codex-proxy-error-${account.id}`} role="alert" className="codex-card-error">{error}</p>}
        <div className="codex-proxy-detection"><button type="button" disabled={busy || detecting} onClick={() => void detect()}><RefreshCw size={14} aria-hidden="true" />{detecting ? "正在检测…" : "检测本机代理"}</button><span id={`codex-proxy-help-${account.id}`}>读取系统配置和环境变量，不会自动保存或修改系统设置。</span></div>
        {detected && <div className="codex-proxy-candidates" role="status">{proxies.length ? <><label>检测到的代理<select aria-label="检测到的代理" value="" disabled={busy} onChange={(event) => { if (event.target.value) { setUrl(event.target.value); setError(""); } }}><option value="">选择地址填入</option>{proxies.map((proxy, index) => <option key={index} value={proxy.url}>{proxy.url} · {proxy.source}{proxy.enabled ? "" : "（系统代理已关闭）"}</option>)}</select></label><small>地址来自已保存的配置，尚未验证连接；选择后点击保存代理。</small></> : <p>未检测到可用的 HTTP/HTTPS 代理配置，请在代理软件中查看地址并手动填写。</p>}</div>}
        <p>留空沿用系统网络。仅支持无账号密码的 HTTP/HTTPS 代理；SOCKS、订阅节点和代理认证尚未支持。用于该账号的额度/权益查询、网关上游请求及新启动的独立实例。修改前请停止该账号的服务和实例；默认客户端不受影响。</p>
        <div className="codex-dialog-actions"><button type="button" disabled={busy || detecting} onClick={close}>取消</button><button disabled={busy || detecting}>保存代理</button></div>
      </form> : <>
        <div className="codex-reset-dialog-body">
          <p>账号：<strong>{account.email ?? account.label}</strong></p>
          <p className="codex-reset-available">官方可用主动重置次数：<strong>{benefits?.resetCredits ?? "未获取"}</strong></p>
          {benefits?.resetExpiresAt && <p className="codex-reset-next-expiry">最近到期：{new Date(benefits.resetExpiresAt * 1000).toLocaleString()}</p>}
          <section className="codex-reset-card-list" aria-label="重置次数明细">
            <h3>重置次数明细</h3>
            {benefits?.resetCards?.length ? benefits.resetCards.map((card,index) => <div className="codex-reset-card-row" key={card.id ?? String(index)}>
              <div className="codex-reset-card-heading"><span className={card.status === "available" || card.status === "active" || card.status === "unused" ? "is-available" : ""}>{card.status === "available" || card.status === "active" || card.status === "unused" ? "可用" : card.status === "redeemed" || card.status === "used" || card.status === "consumed" ? "已使用" : card.status === "expired" ? "已过期" : card.status ?? "状态未知"}</span><strong>{card.resetType ?? "额度重置卡"}</strong></div>
              {card.id && <span>卡片 ID：<strong>{card.id}</strong></span>}
              <span>发放：<strong>{card.grantedAt ? new Date(card.grantedAt * 1000).toLocaleString() : "未提供"}</strong></span>
              <span>到期：<strong>{card.expiresAt ? new Date(card.expiresAt * 1000).toLocaleString() : "无到期时间"}</strong></span>
              {card.redeemedAt && <span>使用：<strong>{new Date(card.redeemedAt * 1000).toLocaleString()}</strong></span>}
            </div>) : <p>{refreshing ? "正在读取重置次数明细…" : "暂无重置卡明细，请刷新次数。"}</p>}
          </section>
          <p className="codex-reset-note">请先停止该账号的服务和实例。官方接口不支持指定消耗某张卡，将按官方规则处理；提交前会重新核对可用次数。</p>
          {benefits?.creditsError && <p role="status" className="codex-card-error">{benefits.creditsError}</p>}
          {error && <p role="alert" className="codex-card-error">{error}</p>}
        </div>
        <div className="codex-dialog-actions"><button disabled={busy} title={refreshing ? "此账号正在刷新，请稍候" : "刷新订阅有效期和剩余重置次数"} aria-busy={refreshing} onClick={() => void refresh()}>刷新次数</button><button disabled={busy} onClick={close}>取消</button><button disabled={busy || !benefits?.resetCredits || !!benefits.creditsError} onClick={() => void run("主动重置额度", async () => { const next=await codexClient.consumeReset(account.id); if (alive.current) { onAccount(next); setModal(null); } })}>按官方规则重置</button></div>
      </>}
    </SharedDialog>}
  </>;
}
