import { useState, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";

export function AccountRefreshError({ reason, accountLabel, children }: { reason: string; accountLabel: string; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const code = reason.match(/\b(?:invalid_refresh_token|refresh_token_reused|refresh_token_expired|invalid_grant)\b/i)?.[0];
  const status = reason.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:_code)?[\s"']*[:=]\s*)([45]\d{2})\b/i)?.[1];
  const summary = ["额度刷新失败", status ? `HTTP ${status}` : null, code].filter(Boolean).join(" · ");
  return <div className="codex-refresh-error-bar">
    <div className="codex-refresh-error-head">
      <AlertCircle size={14} aria-hidden="true" />
      <span className="codex-refresh-error-summary" title={summary} role="status">{summary}</span>
      <button type="button" aria-haspopup="dialog" onClick={() => { setCopyStatus(""); setExpanded(true); }}>查看详情</button>
      {children}
    </div>
    {expanded && <OverviewDialog title="错误详情" className="codex-error-detail-dialog" busy={false} onClose={() => setExpanded(false)} footer={<>
      <span className="codex-error-copy-status" role="status">{copyStatus}</span>
      <span className="codex-error-reauthorize" onClick={event => { if ((event.target as HTMLElement).closest("button:not(:disabled)")) setExpanded(false); }}>{children}</span>
      <button type="button" onClick={() => void navigator.clipboard.writeText(accountLabel + "\n" + reason).then(() => setCopyStatus("已复制"), () => setCopyStatus("复制失败，请重试"))}>复制</button>
      <button type="button" onClick={() => setExpanded(false)}>关闭</button>
    </>}>
      <strong className="codex-error-detail-account">{accountLabel}</strong>
      <pre className="codex-error-detail-text">{reason}</pre>
    </OverviewDialog>}
  </div>;
}
