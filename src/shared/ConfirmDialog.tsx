import { useId, type PointerEventHandler, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { SharedDialog } from "./SharedDialog";

export function ConfirmDialog({ message, title = "确认操作", confirmLabel = "确认", busy = false, error, children, onResolve, onPointerDown }: { message: string; title?: string; confirmLabel?: string; busy?: boolean; error?: string; children?: ReactNode; onResolve: (confirmed: boolean) => void; onPointerDown?: PointerEventHandler<HTMLElement> }) {
  const id = useId();
  return <SharedDialog title={title} icon={<AlertTriangle size={18} aria-hidden="true" />} role="alertdialog" size="small" className="shared-confirm-dialog" closeLabel="关闭确认" showResize={false} closeDisabled={busy} busy={busy} onClose={() => onResolve(false)} onHeaderPointerDown={onPointerDown} describedBy={`${id}-message`} initialFocus="button[data-cancel]" footer={<><button type="button" className="secondary" data-cancel disabled={busy} onClick={() => onResolve(false)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => onResolve(true)}>{busy ? "正在执行…" : confirmLabel}</button></>}>
    <p id={`${id}-message`}>{message}</p>{children}{error && <p role="alert">{error}</p>}
  </SharedDialog>;
}
