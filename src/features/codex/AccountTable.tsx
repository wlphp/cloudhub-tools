import { RefreshCw } from "lucide-react";
import type { CodexAccount, CodexQuotaWindow } from "../../platform/clients/codex";
import { quotaPresentation, quotaStatusNames, remainingPercent, windowName } from "./quotaPresentation";

function quotaTone(percent: number | null): "good" | "warn" | "zero" | "unknown" {
  if (percent == null) return "unknown";
  if (percent <= 0) return "zero";
  if (percent <= 20) return "warn";
  return "good";
}

function QuotaCell({ windows, now }: { windows: CodexQuotaWindow[]; now: number }) {
  if (!windows.length) return <span className="codex-table-empty">未获取</span>;
  return (
    <div className="codex-table-quotas">
      {windows.map((window, index) => {
        const percent = remainingPercent(window);
        const tone = quotaTone(percent);
        const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
        return (
          <div className="codex-table-quota" data-tone={tone} key={index} title={windowName(window.windowMinutes)}>
            <div className="codex-table-quota-main">
              <span>{windowName(window.windowMinutes)}</span>
              <strong>{percent == null ? "未知" : `${Math.round(percent)}%`}</strong>
            </div>
            <span className="codex-table-quota-track" aria-hidden="true">
              <span className="codex-table-quota-fill" data-tone={tone} style={{ width: `${width}%` }} />
            </span>
          </div>
        );
      })}
      <span className="codex-visually-hidden">{`额度刷新基准 ${now}`}</span>
    </div>
  );
}

export function AccountTable({ accounts, selected, currentId, busy, refreshingIds, now, onSelect, onDetails, onSwitch, onRefresh, onLogs, onDelete }: { accounts: CodexAccount[]; selected: Set<number>; currentId?: number | null; busy: boolean; refreshingIds: Set<number>; now: number; onSelect: (id: number) => void; onDetails: (account: CodexAccount) => void; onSwitch: (account: CodexAccount) => void; onRefresh: (account: CodexAccount) => void; onLogs: (account: CodexAccount) => void; onDelete: (account: CodexAccount) => void }) {
  return (
    <div className="codex-account-table">
      <table>
        <caption>Codex 账号列表 · {accounts.length} 个</caption>
        <thead>
          <tr>
            <th>选择</th>
            <th>账号</th>
            <th>套餐 / 状态</th>
            <th>额度</th>
            <th>订阅到期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(account => {
            const current = currentId === account.id;
            const presentation = quotaPresentation(account, now);
            const secondaryEmail = account.email && account.label && account.label !== account.email ? account.email : "";
            return (
              <tr key={account.id} className={`${selected.has(account.id) ? "is-selected " : ""}${current ? "is-current" : ""}`.trim()}>
                <td className="codex-col-check">
                  <input type="checkbox" aria-label={`选择 ${account.label}`} checked={selected.has(account.id)} disabled={busy} onChange={() => onSelect(account.id)} />
                </td>
                <td>
                  <div className="codex-table-account">
                    <strong className={current ? "is-current" : undefined} title={account.label}>{account.label}</strong>
                    {secondaryEmail && <small title={secondaryEmail}>{secondaryEmail}</small>}
                    <div className="codex-table-badges">
                      {account.isWebSession && <span className="codex-badge codex-web-session-badge">Web Session</span>}
                      {current && <span className="codex-badge">当前</span>}
                      {account.tags.map(tag => <span className="codex-table-tag" key={tag}>{tag}</span>)}
                    </div>
                    {account.note && <small className="codex-table-note">{account.note}</small>}
                  </div>
                </td>
                <td>
                  <div className="codex-table-plan">
                    <span>{account.plan?.toUpperCase() ?? account.authMode}</span>
                    <small data-status={presentation.status}>{quotaStatusNames[presentation.status]}</small>
                  </div>
                </td>
                <td><QuotaCell windows={account.quota.windows} now={now} /></td>
                <td className="codex-table-expiry">{account.benefits?.expiresAt ? new Date(account.benefits.expiresAt * 1000).toLocaleDateString() : "未获取"}</td>
                <td className="codex-col-actions">
                  <div className="codex-table-actions">
                    <button disabled={busy} onClick={() => onDetails(account)}>详情</button>
                    <button disabled={busy || !!account.isWebSession} title={account.isWebSession ? "Web Session 凭据不支持切换默认账号" : undefined} onClick={() => onSwitch(account)}>切换</button>
                    <button aria-busy={refreshingIds.has(account.id)} disabled={busy || refreshingIds.has(account.id) || account.authMode !== "chatgpt"} onClick={() => onRefresh(account)}><RefreshCw size={13} className={refreshingIds.has(account.id) ? "codex-refresh-spinning" : undefined} />{refreshingIds.has(account.id) ? "刷新中…" : "刷新"}</button>
                    <button disabled={busy} onClick={() => onLogs(account)}>日志</button>
                    <button className="is-danger" disabled={busy} onClick={() => onDelete(account)}>删除</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
