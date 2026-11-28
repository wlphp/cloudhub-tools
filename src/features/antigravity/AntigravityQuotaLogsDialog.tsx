import { useEffect, useState } from "react";
import { Eye, History } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { antigravityClient, type AntigravityQuotaRefreshLog } from "../../platform/clients/antigravity";
import { SharedDialog } from "../../shared/SharedDialog";

const sources = { single: "单账号刷新", selected: "刷新所选账号", all: "刷新全部账号" };
const resultLabel = (entry: AntigravityQuotaRefreshLog) => entry.success ? "额度刷新成功" : "额度刷新失败";
const displayTime = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", { hour12: false });

export function AntigravityQuotaLogsDialog({ accountId, label, onClose }: {
  accountId: number;
  label: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<AntigravityQuotaRefreshLog[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<AntigravityQuotaRefreshLog | null>(null);

  useEffect(() => {
    let active = true;
    void antigravityClient.listQuotaRefreshLogs(accountId).then(logs => {
      if (!active) return;
      setEntries(logs);
      setStatus("ready");
    }).catch(() => {
      if (active) setStatus("error");
    });
    return () => { active = false; };
  }, [accountId]);

  return <>
    <SharedDialog sizeStorageKey="features/antigravity/quota-logs"
      title="账号日志" subtitle={label} icon={<History size={19} aria-hidden="true" />}
      className="codex-account-logs-dialog" bodyClassName="codex-account-logs-body"
      onClose={onClose} footer={<button type="button" onClick={onClose}>关闭</button>}
    >
      {status === "loading" && <p role="status">正在读取日志…</p>}
      {status === "error" && <p role="alert" className="codex-account-logs-error">读取账号日志失败，请关闭后重试。</p>}
      {status === "ready" && entries.length === 0 && <p role="status" className="codex-account-logs-empty">
        {runningInTauri ? "暂无配额刷新日志。" : "浏览器预览中暂无桌面配额刷新记录。"}
      </p>}
      {entries.length > 0 && <ol className="codex-account-log-list" aria-label="配额刷新记录">
        {entries.map(entry => <li key={entry.id}>
          <time dateTime={new Date(entry.createdAt).toISOString()}>{displayTime(entry.createdAt)}</time>
          <span>{resultLabel(entry)}</span>
          <button type="button" className="codex-account-log-view" onClick={() => setSelected(entry)}>
            <Eye size={14} aria-hidden="true" />查看
          </button>
        </li>)}
      </ol>}
    </SharedDialog>
    {selected && <SharedDialog sizeStorageKey="features/antigravity/quota-log-detail"
      title="日志详情" subtitle={displayTime(selected.createdAt)}
      className="codex-account-log-detail-dialog" bodyClassName="codex-account-log-detail-body"
      onClose={() => setSelected(null)}
      footer={<button type="button" onClick={() => setSelected(null)}>关闭</button>}
    >
      <p>{resultLabel(selected)}</p>
      <p>刷新方式：{sources[selected.source]}</p>
      <p>耗时：{selected.durationMs.toLocaleString("zh-CN")} 毫秒</p>
      <h3>上游 API 查询</h3>
      {selected.requests?.length ? <ol className="ag-quota-request-list">
        {selected.requests.map((request, index) => <li key={index}>
          <code>POST {request.url}</code>
          <p>{request.status == null ? "未收到 HTTP 响应" : `HTTP ${request.status}`}</p>
          <strong>请求参数（JSON）</strong>
          <pre>{JSON.stringify(request.parameters, null, 2)}</pre>
          <strong>返回参数（JSON）</strong>
          {request.response !== undefined
            ? <pre>{JSON.stringify(request.response, null, 2)}</pre>
            : <p>未记录 JSON 响应。</p>}
        </li>)}
      </ol> : <p>这条记录没有上游请求详情。旧日志仅保存刷新结果，部分刷新也可能在发出查询前失败。</p>}
    </SharedDialog>}
  </>;
}
