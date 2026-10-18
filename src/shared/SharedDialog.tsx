import { useEffect, useId, useRef, type FormEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { DialogHeaderActions } from "./DialogHeaderActions";

const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"], [contenteditable="true"]';
const isolation = new WeakMap<HTMLElement, { original: boolean; owners: Set<symbol> }>();

/** Shared shell; dragging and sizing use the existing app primitives. */
export function SharedDialog({ title, subtitle, icon, children, footer, onClose, className = "", bodyClassName = "", size = "large", closeLabel, showResize = true, closeDisabled = false, role = "dialog", onSubmit }: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  bodyClassName?: string;
  size?: "small" | "large";
  closeLabel?: string;
  showResize?: boolean;
  closeDisabled?: boolean;
  role?: "dialog" | "alertdialog";
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  // Capture before descendant autoFocus moves focus during the commit.
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose);
  close.current = () => { if (!closeDisabled) onClose(); };

  useEffect(() => {
    const background = [...document.querySelectorAll<HTMLElement>("#root, body > .modal-backdrop, body > .app-confirm-backdrop")]
      .filter(element => element !== backdrop.current && !element.contains(backdrop.current));
    const owner = Symbol();
    background.forEach(element => {
      const state = isolation.get(element) ?? { original: element.inert, owners: new Set<symbol>() };
      state.owners.add(owner);
      isolation.set(element, state);
      element.inert = true;
    });
    if (backdrop.current) backdrop.current.style.zIndex = String(Math.max(10000, ...background.map(element => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0)) + 1);
    dialog.current?.focus();

    const keydown = (event: KeyboardEvent) => {
      const current = dialog.current;
      if (!current || current.closest("[inert]")) return;
      // Child portals own their keyboard events despite React's portal bubbling.
      if (event.target instanceof Element && event.target !== document.body && !current.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === "Tab") {
        const controls = [...current.querySelectorAll<HTMLElement>(focusable)]
          .filter(element => element.getClientRects().length > 0 && !element.closest("[inert]"));
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); current.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === current)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    // Inline editors may consume Escape before the shell handles it.
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      background.forEach(element => {
        const state = isolation.get(element);
        if (!state) return;
        state.owners.delete(owner);
        if (!state.owners.size) {
          element.inert = state.original;
          isolation.delete(element);
        }
      });
      if (opener.current?.isConnected && !opener.current.closest("[inert]")) opener.current.focus({ preventScroll: true });
    };
  }, []);

  const content = <><div className={`modal-body ${bodyClassName}`}>{children}</div>{footer && <footer className="modal-actions">{footer}</footer>}</>;
  return createPortal(
    <div ref={backdrop} className="modal-backdrop ide-theme shared-dialog-backdrop">
      <section ref={dialog} className={`modal modal-form-layout dialog-common-theme shared-content-dialog shared-dialog-${size} ${className}`} role={role} aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-head">
          {icon}
          <div><h2 id={`${id}-title`}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <DialogHeaderActions showResize={showResize}>
            <button type="button" className="close" disabled={closeDisabled} aria-label={closeLabel ?? `关闭${title}`} title="关闭" onClick={onClose}><X size={18} aria-hidden="true" /></button>
          </DialogHeaderActions>
        </header>
        {onSubmit ? <form className="modal-form-content" onSubmit={onSubmit}>{content}</form> : content}
      </section>
    </div>,
    document.body,
  );
}
