import { useEffect, useState } from "react";
import { Eye, History } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { codexClient, type CodexAccount, type CodexAccountEvent } from "../../platform/clients/codex";

const dateTime = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

type LogAttempt = {
  transport?: string;
  method?: string;
  path?: string;
  status?: number | null;
  outcome?: string;
  request?: unknown;
  calls?: { method?: string; params?: unknown }[];
  response?: unknown;
  error?: string;
};

function attemptsOf(details: unknown): LogAttempt[] {
  if (!details || typeof details !== "object") return [];
  const attempts = (details as { attempts?: unknown }).attempts;
  return Array.isArray(attempts) ? attempts.filter((value): value is LogAttempt => !!value && typeof value === "object") : [];
}

function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return <section className="codex-account-log-detail-section">
    <h3>{label}</h3>
    <pre tabIndex={0} aria-label={label}>{value == null ? "未捕获" : JSON.stringify(value, null, 2)}</pre>
  </section>;
}

export function CodexAccountLogsDialog({ account, onClose }: { account: CodexAccount; onClose: () => void }) {
  const [events, setEvents] = useState<CodexAccountEvent[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CodexAccountEvent | null>(null);

  useEffect(() => {
    let active = true;
    void codexClient.accountEvents(account.id)
      .then(value => { if (active) setEvents(value); })
      .catch(() => { if (active) setError("读取账号日志失败，请关闭后重试"); });
    return () => { active = false; };
  }, [account.id]);

  return <>
    <SharedDialog
      title="账号日志"
      subtitle={account.label}
      icon={<History size={19} aria-hidden="true" />}
      className="codex-account-logs-dialog"
      bodyClassName="codex-account-logs-body"
      onClose={onClose}
      footer={<button type="button" onClick={onClose}>关闭</button>}
    >
      {events === null && !error && <p role="status">正在读取日志…</p>}
      {error && <p role="alert" className="codex-account-logs-error">{error}</p>}
      {events?.length === 0 && <p role="status" className="codex-account-logs-empty">暂无账号日志。</p>}
      {!!events?.length && <ol className="codex-account-log-list" aria-label={`${account.label} 的账号日志`}>
        {events.map(event => <li key={event.id}>
          <time dateTime={new Date(event.createdAt).toISOString()}>{dateTime(event.createdAt)}</time>
          <span>{event.message}</span>
          <button type="button" className="codex-account-log-view" onClick={() => setSelected(event)}><Eye size={14} aria-hidden="true" />查看</button>
        </li>)}
      </ol>}
    </SharedDialog>
    {selected && <SharedDialog
      title="日志详情"
      subtitle={`${dateTime(selected.createdAt)} · ${selected.message}`}
      className="codex-account-log-detail-dialog"
      bodyClassName="codex-account-log-detail-body"
      onClose={() => setSelected(null)}
      footer={<button type="button" onClick={() => setSelected(null)}>关闭</button>}
    >
      {attemptsOf(selected.details).length === 0
        ? <p className="codex-account-log-detail-empty">这条历史记录只保存了事件说明，没有记录请求参数或返回参数。</p>
        : <div className="codex-account-log-attempts">{attemptsOf(selected.details).map((attempt, index) => <section className="codex-account-log-attempt" key={`${attempt.transport ?? "request"}-${index}`}>
          <header><strong>{attempt.transport ?? "请求"}{attempt.method ? ` · ${attempt.method}` : ""}{attempt.path ? ` ${attempt.path}` : ""}</strong><span>{attempt.status ? `HTTP ${attempt.status}` : "状态码不可见"} · {attempt.outcome === "completed" ? "成功" : attempt.outcome === "failed" ? "失败" : attempt.outcome ?? "未知"}</span></header>
          {attempt.request !== undefined && <JsonBlock label="上送参数" value={attempt.request} />}
          {attempt.calls?.map((call, callIndex) => <div className="codex-account-log-call" key={`${call.method ?? "RPC"}-${callIndex}`}>
            <h3>RPC 调用 · {call.method ?? "未知方法"}</h3>
            <JsonBlock label="上送参数" value={call.params} />
          </div>)}
          {attempt.response !== undefined && <JsonBlock label="返回参数（已筛选）" value={attempt.response} />}
          {attempt.error && <section className="codex-account-log-detail-section"><h3>失败原因</h3><p>{attempt.error}</p></section>}
        </section>)}</div>}
    </SharedDialog>}
  </>;
}
