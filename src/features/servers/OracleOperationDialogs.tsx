import type { OracleActionResult } from "../../platform/clients/servers";
import { SharedDialog } from "../../shared/SharedDialog";
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
