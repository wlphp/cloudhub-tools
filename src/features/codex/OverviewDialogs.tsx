import { useEffect, useRef, useState, type ReactNode } from "react";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { RecycleBin } from "../../shared/RecycleBin";
import { trashClient, type TrashSnapshot } from "../../platform/clients/trash";

export function OverviewDialog({ title, busy, onClose, children, eyebrow, description, headerActions, layout, className = "", footer, footerLayout = "actions", dismissWhileBusy = false }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; eyebrow?: string; description?: string; headerActions?: ReactNode; layout?: "form"; className?: string; footer?: ReactNode; footerLayout?: "actions" | "stacked"; dismissWhileBusy?: boolean }) {
  return <SharedDialog title={title} subtitle={description} eyebrow={eyebrow} busy={busy} closeDisabled={busy && !dismissWhileBusy} closeLabel="关闭对话框" onClose={onClose} headerActions={headerActions} className={`codex-dialog ${className}${layout === "form" ? " codex-dialog-form-layout" : ""}`} bodyClassName={layout === "form" ? "codex-dialog-form-body" : "codex-dialog-content"} footerClassName={footerLayout === "stacked" ? "codex-launch-footer" : "codex-overview-dialog-actions"} footer={footer}>{children}</SharedDialog>;
}

export function CodexRecycleDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [purging, setPurging] = useState<string[] | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void trashClient.list().then(value => { if (alive.current) setSnapshot(value); }).catch(() => { if (alive.current) setError("读取回收站失败，请关闭后重试"); });
    return () => { alive.current = false; };
  }, []);
  async function run(ids: string[], purge: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (purge) await trashClient.purge("codex_accounts", ids);
      else await trashClient.restore("codex_accounts", ids);
      await onChanged();
      const next = await trashClient.list();
      if (alive.current) { setSnapshot(next); setPurging(null); }
    } catch {
      const message = purge ? "彻底删除失败，请重试" : "恢复账号失败，请重试";
      if (alive.current) setError(message);
      if (!purge) throw new Error(message);
    }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const group = snapshot?.groups.find(value => value.kind === "codex_accounts");
  return <OverviewDialog title="Codex 账号回收站" busy={busy || !!purging} onClose={onClose}>
    {error && <p role="alert" className="codex-card-error">{error}</p>}
    {!snapshot ? <p>正在读取回收站…</p> : <><p>删除的 Codex 账号可在此恢复。{snapshot.scrubDays ? `删除 ${snapshot.scrubDays} 天后会清除凭据，恢复后需要重新登录。` : "凭据保留至手动彻底删除。"}</p><RecycleBin kinds={group ? [{ id: group.kind, label: group.label, items: group.items }] : []} busy={busy} onClose={onClose} actions={{ restore: (_, ids) => run(ids, false), purge: async (_, ids) => { setPurging(ids); } }} /></>}
    {purging && <ConfirmDialog title="彻底删除 Codex 账号" message={`将永久删除 ${purging.length} 个账号及其凭据，无法恢复。`} confirmLabel="彻底删除" busy={busy} error={error} onResolve={confirmed => { if (confirmed) void run(purging, true); else setPurging(null); }} />}
  </OverviewDialog>;
}
