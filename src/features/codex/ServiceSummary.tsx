import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, ExternalLink, Play, Power, RefreshCw, ScrollText, Terminal, Users } from "lucide-react";
import { codexClient, type CodexAccount, type CodexGatewayState } from "../../platform/clients/codex";
import { quotaPresentation, useQuotaClock } from "./quotaPresentation";

export type GatewayAction = "pool" | "logs" | "start" | "stop" | "config";
export function ServiceSummary({ accounts, state, lanUrl, active, busy, onOpen, onInstances, onRefresh }: { accounts: CodexAccount[]; state: CodexGatewayState | null; lanUrl: string | null; active: boolean; busy: boolean; onOpen: (action: GatewayAction) => void; onInstances: () => void; onRefresh: () => void }) {
  const [addressKind, setAddressKind] = useState("local");
  const [visible, setVisible] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const alive = useRef(true);
  const now = useQuotaClock();
  function hideKey() { revision.current++; if (keyInput.current) keyInput.current.value = ""; setVisible(false); }
  useEffect(() => {
    alive.current = true;
    window.addEventListener("blur", hideKey);
    return () => { alive.current = false; revision.current++; if (keyInput.current) keyInput.current.value = ""; window.removeEventListener("blur", hideKey); };
  }, []);
  useEffect(() => { hideKey(); }, [state?.running, state?.address, active]);
  async function run(action: () => Promise<void>) {
    if (working || busy) return;
    setWorking(true); setMessage("");
    try { await action(); } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { if (alive.current) setWorking(false); }
  }
  const ids = state?.running ? state.accountIds : state?.startupAccountIds ?? [];
  const pool = accounts.filter(account => ids.includes(account.id));
  const statuses = pool.map(account => quotaPresentation(account, now).status);
  const ready = statuses.filter(status => ["ready", "low", "billing"].includes(status)).length;
  const errors = statuses.filter(status => ["error", "exhausted"].includes(status)).length;
  const unknown = statuses.length - ready - errors;
  const plans = [...new Set(pool.map(account => account.plan?.toUpperCase() ?? (account.authMode === "apikey" ? "API KEY" : "未知")))];
  const canLan = !!state?.running && !!state.listeningLan && !!lanUrl;
  const address = addressKind === "lan" && canLan ? lanUrl : state?.address;
  const locked = busy || working;
  return <section className="codex-card codex-service-summary codex-summary-reference" aria-label="API 服务概览">
    <div className="codex-summary-title"><strong>API 服务</strong><button className="codex-summary-pool-button" title="管理服务账号池" aria-label="概览服务账号池" onClick={() => onOpen("pool")}><Users size={13} />服务账号池</button><span className={`codex-badge${state?.running ? " is-running" : ""}`}>{state?.running ? "运行中" : "已停止"}</span></div>
    <div className="codex-summary-field"><select aria-label="概览访问地址" value={addressKind === "lan" && canLan ? "lan" : "local"} onChange={event => setAddressKind(event.target.value)}><option value="local">本机</option><option value="lan" disabled={!canLan}>局域网</option></select><code>{address ?? "启动服务后生成地址"}</code><button disabled={locked || !address} title="复制 API 服务地址" aria-label="复制 API 服务地址" onClick={() => void run(async () => { if (address) { await navigator.clipboard.writeText(address); if (alive.current) setMessage("服务地址已复制"); } })}><Copy size={14} /></button></div>
    <div className="codex-summary-field"><span>密钥</span><input ref={keyInput} aria-label="概览服务密钥" type={visible ? "text" : "password"} readOnly placeholder="••••••••••••" autoComplete="off" /><button disabled={locked || !state?.supportsKeyReveal || !state.configuredPort} title={visible ? "隐藏服务密钥" : "查看服务密钥"} aria-label={visible ? "隐藏概览服务密钥" : "查看概览服务密钥"} aria-pressed={visible} onClick={() => { if (visible) { hideKey(); return; } const expected = ++revision.current; void run(async () => { const key = await codexClient.revealGatewayKey(); if (alive.current && revision.current === expected && keyInput.current) { keyInput.current.value = key; setVisible(true); } }); }}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button><button disabled={locked || !state?.configuredPort} title="复制服务密钥" aria-label="复制概览服务密钥" onClick={() => void run(async () => { await codexClient.copyGatewayKey(); if (alive.current) setMessage("服务密钥已复制"); })}><Copy size={14} /></button></div>
    <div className="codex-summary-binding"><span>服务账号：{pool.length ? pool.length === 1 ? pool[0].label : `${pool.length} 个账号` : "未选择"}</span><button aria-label="配置概览服务账号" onClick={() => onOpen("pool")}><Users size={12} />配置</button></div>
    <div className="codex-summary-pool"><strong>{plans.length ? plans.map(plan => `${plan} (${pool.filter(account => (account.plan?.toUpperCase() ?? (account.authMode === "apikey" ? "API KEY" : "未知")) === plan).length})`).join(" · ") : "服务账号池"}</strong><span>{pool.length} / {accounts.length}</span></div>
    <div className="codex-summary-health"><span>账号状态</span><strong>可用 {ready}/{pool.length} · 异常 {errors} · 待刷新 {unknown}</strong></div>
    <div className="codex-summary-counters"><span>处理中 {state?.active ?? 0}</span><span>完成 {state?.completed ?? 0}</span><span>失败 {state?.failed ?? 0}</span></div>
    <p className="codex-summary-help">访问范围：{!state?.running ? "服务已停止" : state.listeningLan ? "本机 + 局域网（IPv4）" : "仅本机"}</p>
    <div className="codex-summary-action-rail"><button disabled={locked} title="服务账号池" aria-label="概览账号池操作" onClick={() => onOpen("pool")}><Users size={15} /></button><button disabled={locked} title="应用多开" aria-label="概览应用多开" onClick={onInstances}><Terminal size={15} /></button><button disabled={locked} title="调用日志" aria-label="概览调用日志" onClick={() => onOpen("logs")}><ScrollText size={15} /></button><button disabled={locked} title="打开服务配置" aria-label="打开 API 服务配置" onClick={() => onOpen("config")}><ExternalLink size={15} /></button><button disabled={locked} title="刷新服务统计" aria-label="刷新概览服务统计" onClick={onRefresh}><RefreshCw size={15} /></button><button disabled={locked || !!state?.running || !ids.length} title="启动服务" aria-label="概览启动服务" onClick={() => onOpen("start")}><Play size={15} /></button><button disabled={locked || !state?.running} title="停止服务" aria-label="概览停止服务" onClick={() => onOpen("stop")}><Power size={15} /></button></div>
    {message && <small className="codex-summary-result" role="status">{message}</small>}
  </section>;
}
