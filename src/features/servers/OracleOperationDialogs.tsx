import { useEffect, useState } from "react";
import { logsClient } from "../../platform/clients";
import type { OracleActionResult } from "../../platform/clients/servers";
import { platformErrorMessage } from "../../platform/api";
import type { ApiLog } from "../../shared/types";
import { SharedDialog } from "../../shared/SharedDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import "./oracle-operations.css";

function format(value: unknown) {
  if (value == null || value === "") return "（无响应正文）";
  if (typeof value === "string") { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
  return JSON.stringify(value, null, 2);
}

export function OracleResultDialog({ result, onClose }: { result: OracleActionResult & { label: string }; onClose: () => void }) {
  return <SharedDialog sizeStorageKey="features/servers/oracle-operation-dialogs/oracle-result-dialog" title={`${result.label} · API ${result.success ? "成功" : "失败"}`} className="oracle-operation-dialog" onClose={onClose} footer={<button type="button" className="secondary" onClick={onClose}>关闭</button>}>
    <p role="status" className={result.success ? "log-success" : "log-failure"}>{result.success ? "API 已受理操作，请刷新状态确认服务器执行结果。" : result.message || "API 返回失败，请查看下方返回值。"}</p>
    <div className="api-log-meta"><span>HTTP 状态码：{result.httpStatus ?? "未收到"}</span><span>请求 ID：{result.requestId || "未返回"}</span></div>
    <div className="api-log-section"><h3>API 返回值</h3><pre>{format(result.response)}</pre></div>
  </SharedDialog>;
}

export function OracleOperationLogsDialog({ accountId, instanceId, name, onClose }: { accountId: number; instanceId: string; name: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [rows, setRows] = useState<ApiLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(""); setRows([]);
    logsClient.listInstanceApi({ accountId, instanceId, limit: pageSize + 1, offset: (page - 1) * pageSize })
      .then(value => { if (alive) setRows(value); })
      .catch(reason => { if (alive) setError(platformErrorMessage(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, instanceId, page, pageSize, revision]);
  return <SharedDialog sizeStorageKey="features/servers/oracle-operation-dialogs/oracle-operation-logs-dialog" title="API 操作记录" subtitle={name} className="oracle-operation-dialog" onClose={onClose} headerActions={<button type="button" className="secondary" disabled={loading} onClick={() => { setPage(1); setRevision(value => value + 1); }}>刷新记录</button>} footer={<PaginationBar page={page} pageSize={pageSize} hasNext={rows.length > pageSize} disabled={loading || !!error} onPageChange={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} />}>
    <p>当前服务器的 API 操作记录；旧版未记录实例 ID 的日志可在全局 API 日志查看。</p>
    {error && <p role="alert" className="log-failure">读取失败：{error}</p>}
    {loading ? <p role="status">正在读取操作记录…</p> : !error && !rows.length ? <p>暂无操作记录</p> : rows.slice(0, pageSize).map(log => <details className="oracle-operation-log" key={log.id}>
      <summary><span>{new Date(log.created_at).toLocaleString()}</span><strong>{actionLabel(log.request_params)}</strong><span className={log.status === "成功" ? "log-success" : "log-failure"}>{log.status}</span><span>查看返回值</span></summary>
      <div className="api-log-section"><h3>请求参数</h3><pre>{format(log.request_params)}</pre><h3>API 返回值</h3><pre>{format(log.response_params)}</pre>{log.message && <p>{log.message}</p>}</div>
    </details>)}
  </SharedDialog>;
}

function actionLabel(params: string) {
  try { const action = JSON.parse(params).action as string; return ({ START: "开机", STOP: "关机", SOFTRESET: "重启", RESET: "强制重启" } as Record<string, string>)[action] || action || "实例操作"; }
  catch { return "实例操作"; }
}
