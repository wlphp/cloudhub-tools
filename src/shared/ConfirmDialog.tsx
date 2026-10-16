import { useEffect, useId, useRef, type PointerEventHandler } from "react";
import { AlertTriangle, X } from "lucide-react";
import { DialogHeaderActions } from "./DialogHeaderActions";

export function ConfirmDialog({ message, title = "确认操作", confirmLabel = "确认", busy = false, error, onResolve, onPointerDown }: { message: string; title?: string; confirmLabel?: string; busy?: boolean; error?: string; onResolve: (confirmed: boolean) => void; onPointerDown?: PointerEventHandler<HTMLElement> }) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const resolve = useRef(onResolve);
  resolve.current = onResolve;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button[data-cancel]")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!busy) resolve.current(false); }
      if (e.key === "Tab") {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (first && last && ((e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      }
    };
    window.addEventListener("keydown",key,true);
    return () => { window.removeEventListener("keydown",key,true); previous?.focus(); };
  }, [busy]);
  return <div className="app-confirm-backdrop">
    <section ref={dialog} className="app-confirm-dialog modal-form-layout dialog-common-theme shared-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
      <header onPointerDown={onPointerDown}><strong id={`${id}-title`}><AlertTriangle size={18} aria-hidden="true" />{title}</strong><DialogHeaderActions showResize={false}><button className="close" disabled={busy} aria-label="关闭确认" onClick={() => onResolve(false)}><X size={16} /></button></DialogHeaderActions></header>
      <div className="modal-body"><p id={`${id}-message`}>{message}</p>{error && <p role="alert">{error}</p>}</div>
      <footer className="app-confirm-actions"><button type="button" className="secondary" data-cancel disabled={busy} onClick={() => onResolve(false)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => onResolve(true)}>{busy ? "正在执行…" : confirmLabel}</button></footer>
    </section>
  </div>;
}
