import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { codexClient, type CodexAccount, type CodexCallDetail, type CodexRemoteLog, type CodexRemoteLogState } from "../../platform/clients/codex";

const outcomes: Record<string, string> = { completed: "完成", completed_without_body: "完成（响应体未读取）", http_error: "HTTP 错误", http_error_body_truncated: "HTTP 错误（响应截断）", timeout: "超时", connect_error: "连接失败", request_error: "请求失败", stream_error: "流中断", body_pending: "响应体读取中断", cancelled: "取消", cli_error: "CLI 查询失败", body_error: "响应读取失败", body_too_large: "响应超过大小限制", invalid_json: "响应格式无效" };
const network = (log: CodexRemoteLog) => log.proxyMode === "account" ? `账号代理：${log.proxyUrl ?? "地址未记录"}` : "系统网络（实际代理路径未确认）";

export function RemoteApiLogs({ accounts, onClose }: { accounts: CodexAccount[]; onClose: () => void }) {
  const [state, setState] = useState<CodexRemoteLogState | null>(null);
  const [selected, setSelected] = useState<CodexRemoteLog | null>(null);
  const [detail, setDetail] = useState<CodexCallDetail | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  useEffect(() => { alive.current=true; const node=dialog.current; node?.showModal(); void act(codexClient.remoteLogs); return () => {alive.current=false;node?.close();}; }, []);
  useEffect(() => {
    if (!selected) {detailDialog.current?.close();return;}
    detailDialog.current?.showModal();setDetail(null);setDetailError("");
    let stopped=false;
    void codexClient.remoteLogDetail(selected.id).then(value=>{if(!stopped)setDetail(value);}).catch(reason=>{if(!stopped)setDetailError(reason instanceof Error?reason.message:"读取日志详情失败，请刷新列表");});
    return ()=>{stopped=true;};
  },[selected]);
  async function act(action: () => Promise<CodexRemoteLogState>) {
    if(operation.current)return;operation.current=true;setBusy(true);setError("");
    try{const next=await action();if(alive.current)setState(next);}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:"读取远端 API 日志失败，请重试");}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  return <>
    <dialog ref={dialog} className={`codex-dialog codex-log-dialog${expanded?" codex-log-expanded":""}`} aria-label="远端 API 日志" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
      <header><h2>远端 API 日志</h2><div className="codex-actions"><button aria-label={expanded?"还原远端日志":"放大远端日志"} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button aria-label="关闭远端日志" disabled={busy} onClick={onClose}><X size={16}/></button></div></header>
      <div className="codex-log-dialog-body"><section className="codex-api-card">
        <div className="codex-actions"><label className="codex-auto-start-toggle"><input type="checkbox" aria-label="记录远端 API 日志" checked={state?.enabled??false} disabled={busy||!state} onChange={event=>void act(()=>codexClient.configureRemoteLogs(event.target.checked))}/>记录远端 API 日志</label><button disabled={busy} onClick={()=>void act(codexClient.remoteLogs)}><RefreshCw size={14}/>刷新日志</button><button disabled={busy} onClick={()=>{setSelected(null);void act(codexClient.clearRemoteLogs);}}>清空日志</button></div>
        <p className="codex-api-description">默认关闭，开启后记录订阅／权益、模型目录、网关推理和唤醒调用；仅保留当前进程内最近 500 条，详情总量最多 8 MB，退出后清除。记录脱敏参数和请求／响应头、账号代理配置、状态、耗时及流式事件；授权、Cookie 和身份头隐藏。非 JSON 响应原文不记录。不会补录历史调用。</p>
        <p className="codex-api-description">额度刷新由官方 CLI 查询，仅记录 RPC 参数和结果，其内部 HTTP 地址、状态及请求头不可见。系统网络可能使用环境代理或 VPN，无法据此确认实际链路。记录详细参数可能包含对话和工具内容。</p>
        {error&&<p role="alert" className="codex-card-error">{error}</p>}
        {!state?.logs.length?<p role="status">{state?.enabled?"暂无日志，请执行额度／权益刷新或远端 API 调用后刷新日志。":"开启日志记录后，新的远端调用会显示在这里。"}</p>:<div className="codex-call-log-scroll" tabIndex={0} role="region" aria-label="远端日志列表"><table className="codex-call-log"><thead><tr><th>详情</th><th>时间／账号</th><th>请求</th><th>代理／网络</th><th>状态／结果</th><th>耗时</th></tr></thead><tbody>{state.logs.map(log=><tr key={log.id}><td><button aria-label={`查看远端日志 ${log.id}`} onClick={()=>setSelected(log)}>查看</button></td><td>{new Date(log.timestamp).toLocaleTimeString()}<small>{accounts.find(account=>account.id===log.accountId)?.label??(log.accountId?`账号 #${log.accountId}`:"未关联账号")}</small></td><td><code>{log.method}</code><small>{log.url}</small><small>{log.transport==="cli_rpc"?"官方 CLI RPC":"远端 HTTP"}</small></td><td>{network(log)}</td><td>{log.status??"—"}<small>{outcomes[log.outcome]??log.outcome}</small></td><td>{log.durationMs} ms</td></tr>)}</tbody></table></div>}
      </section></div>
    </dialog>
    <dialog ref={detailDialog} className={`codex-dialog codex-log-dialog${detailExpanded?" codex-log-expanded":""}`} aria-label="远端 API 调用详情" onCancel={event=>{event.preventDefault();setSelected(null);}}>
      <header><h2>远端 API 调用详情</h2><div className="codex-actions"><button aria-label={detailExpanded?"还原远端详情":"放大远端详情"} onClick={()=>setDetailExpanded(!detailExpanded)}>{detailExpanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button aria-label="关闭远端详情" onClick={()=>setSelected(null)}><X size={16}/></button></div></header>
      <div className="codex-log-dialog-body">{selected&&<section className="codex-api-card"><p className="codex-api-description">请求 ID：{selected.id} · {new Date(selected.timestamp).toLocaleString()} · {selected.durationMs} ms</p><p className="codex-api-description">{selected.method} {selected.url}<br/>{network(selected)} · {outcomes[selected.outcome]??selected.outcome} · HTTP {selected.status??"不可见／未收到响应"}</p>{detailError?<p role="alert" className="codex-card-error">{detailError}</p>:!detail?<p role="status">正在读取详情…</p>:<>{detail.truncated&&<p role="status">详情超过容量上限，已截断；流式事件共 {detail.eventCount} 条。</p>}<div className="codex-log-parameters">{([["发送参数与请求头",detail.request],["返回参数与响应头",detail.response]] as const).map(([label,value])=><details key={label} open><summary>{label}</summary><pre tabIndex={0} aria-label={label}>{value==null?"此阶段未捕获参数":JSON.stringify(value,null,2)}</pre></details>)}<details><summary>流式事件 · {detail.events.length} / {detail.eventCount}</summary><pre tabIndex={0} aria-label="远端流式事件">{JSON.stringify(detail.events,null,2)}</pre></details></div></>}</section>}</div>
    </dialog>
  </>;
}
