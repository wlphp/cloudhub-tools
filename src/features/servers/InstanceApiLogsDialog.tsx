import { useEffect, useState } from "react";
import { logsClient } from "../../platform/clients";
import { platformErrorMessage } from "../../platform/api";
import type { ApiLog } from "../../shared/types";
import { SharedDialog } from "../../shared/SharedDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import "./oracle-operations.css";

/** 云端动作名 → 中文标签；各云命名风格不同（RPC 帕斯卡、OCI 全大写、Vultr 小写路径）。 */
const actionLabels: Record<string, string> = {
  START: "开机", STOP: "关机", SOFTRESET: "重启", RESET: "强制重启",
  start: "开机", stop: "关机", reboot: "重启", restart: "重启", forceReboot: "强制重启", halt: "关机",
  StartInstance: "开机", StartInstances: "开机",
  StopInstance: "关机", StopInstances: "关机",
  RebootInstance: "重启", RebootInstances: "重启",
  RestartInstance: "重启", RestartInstances: "重启",
  ModifyInstanceAttribute: "修改实例属性", ModifyInstancesAttribute: "修改实例属性",
  RenameInstance: "修改实例属性",
  DescribeInstances: "查询实例", DescribeInstanceStatus: "查询实例状态",
  ListInstances: "查询实例", ListInstanceStatuses: "查询实例状态",
  GET: "查询",
};

/** Vultr / OCI 这类用 HTTP 路径记录动作的云，按路径尾段推断语义。 */
const pathLabels: [RegExp, string][] = [
  [/\/start$/, "开机"],
  [/\/halt$/, "关机"],
  [/\/stop$/, "关机"],
  [/\/reboot$/, "重启"],
  [/\/restart$/, "重启"],
  [/\/reset$/, "强制重启"],
];

function parseParams(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function format(value: unknown) {
  if (value == null || value === "") return "（无响应正文）";
  if (typeof value === "string") { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
  return JSON.stringify(value, null, 2);
}

export function actionLabel(log: ApiLog): string {
  const params = parseParams(log.request_params);
  for (const candidate of [params?.action, params?.Action]) {
    const mapped = typeof candidate === "string" ? actionLabels[candidate] : undefined;
    if (mapped) return mapped;
  }
  const mapped = actionLabels[log.action];
  if (mapped) return mapped;
  const byPath = pathLabels.find(([pattern]) => pattern.test(log.action));
  if (byPath) return byPath[1];
  return log.action || "实例操作";
}

/**
 * 单台实例的 API 操作记录。所有云的服务器卡片共用这个弹窗：
 * 后端按 `request_params` 里出现的实例 ID 过滤，不区分云厂商。
 */
export function InstanceApiLogsDialog({ accountId, instanceId, name, onClose }: { accountId: number; instanceId: string; name: string; onClose: () => void }) {
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
      <summary><span>{new Date(log.created_at).toLocaleString()}</span><strong>{actionLabel(log)}</strong><span className={log.status === "成功" ? "log-success" : "log-failure"}>{log.status}</span><span>查看返回值</span></summary>
      <div className="api-log-meta"><span>接口：{log.action || "-"}</span><span>端点：{log.endpoint || "-"}</span></div>
      <div className="api-log-section"><h3>请求参数</h3><pre>{format(log.request_params)}</pre><h3>API 返回值</h3><pre>{format(log.response_params)}</pre>{log.message && <p>{log.message}</p>}</div>
    </details>)}
  </SharedDialog>;
}
