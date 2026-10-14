import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RefreshCw, Save, X, Zap } from "lucide-react";
import { codexClient, type CodexAccount, type CodexCallDetail, type CodexCallLog, type CodexGatewayState, type CodexGatewaySettings } from "../../platform/clients/codex";

import { quotaPresentation, quotaResetTime, quotaStatusNames, remainingPercent, useQuotaClock, windowName } from "./quotaPresentation";

export function PoolQuota({ account }: { account: CodexAccount }) {
  const now = useQuotaClock();
  const presentation = quotaPresentation(account, now);
  return <span className="codex-pool-account"><strong>{account.label}</strong><small>{quotaStatusNames[presentation.status]}</small>
    {account.authMode === "apikey" ? <small>API 账单计费 · 无订阅额度</small> : account.quota.windows.length ? account.quota.windows.map((window, index) => <small key={index}>
      {windowName(window.windowMinutes)} · {remainingPercent(window) != null ? `${Math.round(remainingPercent(window)!)}% 剩余（缓存）` : "额度未知"}<br />{quotaResetTime(window.resetsAt, now)}
    </small>) : <small>尚未获取额度</small>}
    <small>额度更新：{account.quota.fetchedAt ? new Date(account.quota.fetchedAt).toLocaleString() : "未刷新"}{presentation.status === "stale" ? " · 已过期" : ""}</small>
    {account.lastError && <small className="codex-pool-warning">上次额度刷新失败</small>}
  </span>;
}

const outcomeNames: Record<string, string> = { completed: "完成", cancelled: "客户端取消", timeout: "超时", request_rejected: "授权或请求被拒绝", validation_error: "参数校验失败", affinity_required: "缺少会话标识", no_available_account: "无可用账号", upstream_error: "上游拒绝或连接失败", catalog_error: "模型目录失败", stream_error: "流中断" };

export function GatewayMonitoring({ accounts, state, locked, act, onState, logsOpen, onClose }: { logsOpen: boolean; onClose: () => void; accounts: CodexAccount[]; state: CodexGatewayState | null; locked: boolean; act: (run: () => Promise<void>) => Promise<void>; onState: (next: CodexGatewayState) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodexCallDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [logError, setLogError] = useState("");
  useEffect(() => { if (logsOpen) dialog.current?.showModal(); else { dialog.current?.close(); setSelected(null); setDetail(null); setDetailError(""); } }, [logsOpen]);
  useEffect(() => {
    if (logsOpen && selected) detailDialog.current?.showModal();
    else detailDialog.current?.close();
  }, [logsOpen, selected]);
  useEffect(() => { let cancelled=false; setDetail(null); setDetailError(""); if (logsOpen && selected) void codexClient.gatewayLogDetail(selected).then(value => { if (!cancelled) setDetail(value); }).catch(() => { if (!cancelled) setDetailError("详情不可用，日志可能已清除或过期，请刷新列表。"); }); return () => { cancelled=true; }; }, [logsOpen, selected]);
  const [logs, setLogs] = useState<CodexCallLog[]>([]);
  const [strategy, setStrategy] = useState<CodexGatewaySettings["strategy"]>("round_robin");
  const [cooldown, setCooldown] = useState("60");
  const [feedback, setFeedback] = useState("");
  const initialized = useRef(false);
  const alive = useRef(true);
  const logRevision = useRef(0);
  const supported = !!state?.settings;
  useEffect(() => { if (!initialized.current && state?.settings) { setStrategy(state.settings.strategy); setCooldown(String(state.settings.cooldownSeconds)); initialized.current = true; } }, [state?.settings]);
  useEffect(() => { alive.current=true; return () => { alive.current=false; }; }, []);
  useEffect(() => {
    if (!supported || !logsOpen) return;
    let cancelled = false;
    let reading = false;
    const read = async () => { if (reading) return; reading = true; const revision = ++logRevision.current; try { const rows = await codexClient.gatewayLogs(); if (!cancelled && alive.current && revision === logRevision.current) { setLogs(rows); setLogError(""); setSelected(current => rows.some(row => row.id === current) ? current : null); } } catch { if (!cancelled) setLogError("读取调用日志失败，请刷新重试。"); } finally { reading = false; } };
    void read(); const timer = window.setInterval(() => void read(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [supported, state?.running, logsOpen]);
  const logAct = (run: () => Promise<void>) => act(async () => { setLogError(""); try { await run(); } catch (error) { if (alive.current) setLogError("日志操作失败，请重试。"); throw error; } });
  const invalid = !/^\d+$/.test(cooldown) || +cooldown < 5 || +cooldown > 3600;
  return <>
    <section className="codex-api-card codex-routing-card"><div className="codex-routing-heading"><Zap size={27} aria-hidden="true" /><div><h3>轮询规则</h3><p>按规则分配服务账号，提高请求稳定性</p></div></div><div className="codex-gateway-rules">
      <label>账号选择规则<select aria-label="账号选择规则" value={strategy} disabled={locked || !supported} onChange={(event) => setStrategy(event.target.value as CodexGatewaySettings["strategy"])}><option value="round_robin">依次轮询</option><option value="quota_first">剩余额度优先</option><option value="ordered">按账号池顺序优先</option></select></label>
      <label>失败冷却（秒）<input aria-label="失败冷却秒数" type="number" min={5} max={3600} value={cooldown} disabled={locked || !supported} onChange={(event) => setCooldown(event.target.value)} /></label>
      <button disabled={locked || !supported || invalid} onClick={() => void act(async () => { const next = await codexClient.configureGateway({ loggingEnabled: state?.settings?.loggingEnabled ?? false, strategy, cooldownSeconds: +cooldown }); if (alive.current) { onState(next); setFeedback("轮询规则已保存并生效"); } })}><Save size={14} aria-hidden="true" />保存轮询规则</button>
    </div><details className="codex-routing-help"><summary>规则说明</summary><p className="codex-api-description">依次轮询分配新请求；顺序优先使用列表中第一个可用账号。额度优先比较各窗口最低剩余比例，15 分钟前或已过重置时间的数据视为未知，已知耗尽账号跳过，未知额度作为候补。已绑定会话保持原账号，冷却期间不切换工具上下文。</p><p className="codex-api-description">规则保存后立即生效，重启后沿用。认证失效至少冷却 300 秒，不自动重放失败请求。额度来自账号总览的上次刷新，不是实时消耗估算；刷新后重新保存规则即可更新路由使用的额度。</p></details>{!logsOpen && feedback && <p className="codex-feedback" role="status">{feedback}</p>}{invalid && <p className="codex-card-error" role="alert">失败冷却时间须为 5–3600 秒。</p>}</section>
    <dialog ref={dialog} className={`codex-dialog codex-log-dialog dialog-common-theme${logsExpanded ? " codex-log-expanded" : ""}`} aria-labelledby="codex-log-title" onCancel={onClose} onClose={onClose}><header><h3 id="codex-log-title">调用日志</h3><div className="codex-actions"><button aria-label={logsExpanded ? "还原调用日志" : "放大调用日志"} title={logsExpanded ? "还原" : "放大"} aria-pressed={logsExpanded} onClick={() => setLogsExpanded(value => !value)}>{logsExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button aria-label="关闭调用日志" title="关闭" onClick={onClose}><X size={18} /></button></div></header><div className="codex-log-dialog-body"><section className="codex-api-card"><div className="codex-api-section-heading"><h3>调用记录 <span className="codex-badge">{logs.length} 条</span></h3><div className="codex-actions">
      <label className="codex-log-toggle"><input type="checkbox" aria-label="记录调用日志" checked={state?.settings?.loggingEnabled ?? false} disabled={locked || !supported} onChange={(event) => { const enabled = event.target.checked; void logAct(async () => { const next = await codexClient.configureGateway({ ...state!.settings!, loggingEnabled: enabled }); if (alive.current) { onState(next); setFeedback(enabled ? "调用日志已开启" : "调用日志已关闭"); } }); }} />记录调用日志</label>
      <button disabled={locked || !supported} onClick={() => void logAct(async () => { const revision = ++logRevision.current; const rows = await codexClient.gatewayLogs(); if (alive.current && revision === logRevision.current) { setLogs(rows); setFeedback("调用日志已刷新"); } })}><RefreshCw aria-hidden="true" size={14} />刷新日志</button>
      <button disabled={locked || !logs.length} onClick={() => void logAct(async () => { await codexClient.clearGatewayLogs(); logRevision.current++; if (alive.current) { setLogs([]); setSelected(null); setDetail(null); setFeedback("调用日志已清空"); } })}>清空日志</button>
    </div></div><p className="codex-api-description">默认关闭。开启后最多保留最近 500 条，详情总量不超过 8 MB，超过时移除旧记录。仅保存在当前服务内存中，停止服务后清除；关闭后停止记录，已有日志仍可查看。详情显示请求正文、转换后参数、回复和工具内容；认证头、密钥等凭据脱敏。详情有大小上限，流式事件最多展示 12 条（含终止事件）。流式请求结束时记录，HTTP 200 仍可能伴随流中断。</p>
      {logError && <p role="alert" className="codex-card-error">{logError}</p>}
      {logsOpen && feedback && <p className="codex-feedback" role="status">{feedback}</p>}
      {!logs.length ? <p className="codex-api-description" role="status">{state?.settings?.loggingEnabled ? "暂无调用日志，完成一次请求后将显示。" : "日志记录已关闭，开启后可查看调用状态。"}</p> : <div className="codex-call-log-scroll" tabIndex={0} role="region" aria-label="调用日志列表"><table className="codex-call-log"><thead><tr><th>详情</th><th>时间</th><th>接口 / 模型</th><th>账号</th><th>HTTP / 上游</th><th>结果</th><th>耗时 / Token</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id} className={selected === log.id ? "codex-log-selected" : ""}><td><button aria-label={`查看调用 ${log.id} 详情`} aria-haspopup="dialog" aria-controls="codex-log-detail" onClick={() => setSelected(log.id)}>查看</button></td><td>{new Date(log.timestamp).toLocaleTimeString()}</td><td><code>{log.endpoint}</code><small>{log.model ?? "—"}{log.streaming ? " · 流式" : ""}</small></td><td>{accounts.find((account) => account.id === log.accountId)?.label ?? (log.accountId ? `账号 #${log.accountId}` : "未分配")}</td><td>{log.status} / {log.upstreamStatus ?? "—"}</td><td>{outcomeNames[log.outcome] ?? "未知"}</td><td>{log.durationMs} ms<small>输入 {log.inputTokens ?? "—"} / 输出 {log.outputTokens ?? "—"}</small></td></tr>)}</tbody></table></div>}
    </section>
    </div></dialog>
    <dialog ref={detailDialog} id="codex-log-detail" className={`codex-dialog codex-log-dialog codex-log-detail-dialog dialog-common-theme${detailExpanded ? " codex-log-expanded" : ""}`} aria-labelledby="codex-log-detail-title" onCancel={event => { event.preventDefault(); setSelected(null); }} onClose={() => setSelected(null)}><header><h3 id="codex-log-detail-title">调用详情</h3><div className="codex-actions"><button aria-label={detailExpanded ? "还原调用详情" : "放大调用详情"} title={detailExpanded ? "还原" : "放大"} aria-pressed={detailExpanded} onClick={() => setDetailExpanded(value => !value)}>{detailExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button aria-label="关闭调用详情" title="关闭" onClick={() => setSelected(null)}><X size={18} /></button></div></header><div className="codex-log-dialog-body">
    {selected && <section className="codex-api-card"><p className="codex-api-description">请求 ID：{selected}</p>{detailError ? <p role="alert" className="codex-card-error">{detailError}</p> : !detail ? <p role="status">正在读取详情…</p> : <>
      {detail.truncated && <p role="status" className="codex-api-description">内容超过展示上限，已截断；事件共 {detail.eventCount} 条。</p>}
      <div className="codex-log-parameters">{([["客户端上送参数", detail.request], ["网关上送参数（转换后）", detail.forwarded], ["返回参数", detail.response]] as const).map(([title, value]) => <details key={title} open><summary>{title}</summary><pre tabIndex={0} aria-label={title}>{value == null ? "未捕获参数（请求可能在此阶段之前失败，或来自旧版记录）" : JSON.stringify(value, null, 2)}</pre></details>)}</div>
      <details><summary>流式事件 · {detail.events.length} / {detail.eventCount}</summary><pre tabIndex={0} aria-label="流式事件">{JSON.stringify(detail.events, null, 2)}</pre></details>
    </>}</section>}
    </div></dialog>
  </>;
}
