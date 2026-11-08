import { useEffect, useId, useRef, useState, type FormEventHandler, type PointerEvent as ReactPointerEvent, type PointerEventHandler, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { PanelsTopLeft, X } from "lucide-react";
import { DialogHeaderActions } from "./DialogHeaderActions";

const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"], [contenteditable="true"]';
const isolation = new WeakMap<HTMLElement, { original: boolean; owners: Set<symbol> }>();

const DIALOG_MIN_WIDTH = 380;
const DIALOG_MIN_HEIGHT = 260;
const resizeDirections = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const resizeCursors: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize" };

interface DialogSize { width: number; height: number }

function loadDialogSize(key: string): DialogSize | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`cloudhub.dialogSize.${key}`) ?? "") as Partial<DialogSize> | null;
    if (!parsed || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: Math.max(DIALOG_MIN_WIDTH, Math.round(parsed.width as number)), height: Math.max(DIALOG_MIN_HEIGHT, Math.round(parsed.height as number)) };
  } catch { return null; }
}

function saveDialogSize(key: string, size: DialogSize) {
  try { window.localStorage.setItem(`cloudhub.dialogSize.${key}`, JSON.stringify(size)); } catch { /* 隐私模式下写入失败可忽略 */ }
}

/** Shared shell; dragging and sizing use the existing app primitives. */
export function SharedDialog({ title, titleExtra, subtitle, eyebrow, icon, children, footer, headerActions, onClose, className = "", bodyClassName = "", footerClassName = "", backdropClassName = "", size = "large", closeLabel, showResize = true, defaultExpanded = false, closeDisabled = false, busy = false, role = "dialog", onSubmit, formRef, noValidate = false, initialFocus, onHeaderPointerDown, describedBy, resizable = false, sizeStorageKey }: {
  title: string;
  /** 标题旁的补充徽标（如“已置顶”），随标题整行排版、自身不折行。 */
  titleExtra?: ReactNode;
  subtitle?: string;
  eyebrow?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  backdropClassName?: string;
  size?: "small" | "large";
  closeLabel?: string;
  showResize?: boolean;
  defaultExpanded?: boolean;
  closeDisabled?: boolean;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  onSubmit?: FormEventHandler<HTMLFormElement>;
  formRef?: Ref<HTMLFormElement>;
  noValidate?: boolean;
  initialFocus?: string;
  onHeaderPointerDown?: PointerEventHandler<HTMLElement>;
  describedBy?: string;
  /** 启用四边 + 四角拖拽调宽高；配合 sizeStorageKey 把拖拽后的尺寸记住，下次打开沿用。 */
  resizable?: boolean;
  sizeStorageKey?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [restoredSize, setRestoredSize] = useState<DialogSize | null>(() => (sizeStorageKey ? loadDialogSize(sizeStorageKey) : null));
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
    const initial = initialFocus ? dialog.current?.querySelector<HTMLElement>(initialFocus) : null;
    if (initial) initial.focus();
    else if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();

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

  // 四向拖拽调宽高：起拖时冻结为 fixed 定位并锚定对侧边缘，结束后把尺寸写入 localStorage。
  const startResize = (event: ReactPointerEvent<HTMLDivElement>, direction: string) => {
    const el = dialog.current;
    if (!el || event.button !== 0 || el.classList.contains("dialog-size-expanded")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = el.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const maxWidth = window.innerWidth - 32;
    const maxHeight = window.innerHeight - 32;
    document.body.style.userSelect = "none";
    document.body.style.cursor = resizeCursors[direction] ?? "nwse-resize";
    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let width = rect.width;
      let height = rect.height;
      if (direction.includes("e")) width = rect.width + dx;
      if (direction.includes("s")) height = rect.height + dy;
      if (direction.includes("w")) width = rect.width - dx;
      if (direction.includes("n")) height = rect.height - dy;
      width = Math.min(maxWidth, Math.max(DIALOG_MIN_WIDTH, width));
      height = Math.min(maxHeight, Math.max(DIALOG_MIN_HEIGHT, height));
      // 北/西向按夹取后的尺寸反推 left/top，保证对侧边缘纹丝不动。
      const left = direction.includes("w") ? rect.left + rect.width - width : rect.left;
      const top = direction.includes("n") ? rect.top + rect.height - height : rect.top;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    const finish = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const width = Math.round(Number.parseFloat(el.style.width));
      const height = Math.round(Number.parseFloat(el.style.height));
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      setRestoredSize({ width, height });
      if (sizeStorageKey) saveDialogSize(sizeStorageKey, { width, height });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    // 冻结为 fixed 定位并解锁基础样式的宽高限制，让对侧边缘在拖拽中保持不动。
    el.style.position = "fixed";
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.maxWidth = "none";
    el.style.maxHeight = "none";
    el.style.transform = "none";
  };

  const content = <><div className={`modal-body ${bodyClassName}`}>{children}</div>{footer && <footer className={`modal-actions ${footerClassName}`}>{footer}</footer>}</>;
  return createPortal(
    <div ref={backdrop} className={`modal-backdrop ide-theme shared-dialog-backdrop ${backdropClassName}`}>
      <section ref={dialog} className={`modal modal-form-layout dialog-common-theme shared-content-dialog shared-dialog-${size} ${resizable ? "dialog-resizable" : ""} ${restoredSize ? "dialog-user-size" : ""} ${className}`} style={restoredSize ? { width: restoredSize.width, height: restoredSize.height } : undefined} role={role} aria-modal="true" aria-busy={busy} aria-labelledby={`${id}-title`} aria-describedby={describedBy ?? (subtitle ? `${id}-subtitle` : undefined)} tabIndex={-1}>
        <header className="modal-head" onPointerDown={onHeaderPointerDown}>
          {icon ?? <span className="shared-dialog-mobile-icon" aria-hidden="true"><PanelsTopLeft size={22} /></span>}
          <div className="shared-dialog-heading">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={`${id}-title`}>{title}{titleExtra && <span className="shared-dialog-title-extra">{titleExtra}</span>}</h2>{subtitle && <p id={`${id}-subtitle`}>{subtitle}</p>}</div>
          <DialogHeaderActions showResize={showResize} defaultExpanded={defaultExpanded}>
            {headerActions}
            <button type="button" className="close" disabled={closeDisabled} aria-label={closeLabel ?? `关闭${title}`} title="关闭" onClick={onClose}><X size={18} aria-hidden="true" /></button>
          </DialogHeaderActions>
        </header>
        {onSubmit ? <form ref={formRef} className="modal-form-content" noValidate={noValidate} onSubmit={onSubmit}>{content}</form> : content}
        {resizable && resizeDirections.map(direction => <div key={direction} className={`dialog-resize-handle dialog-resize-${direction}`} aria-hidden="true" onPointerDown={event => startResize(event, direction)} />)}
      </section>
    </div>,
    document.body,
  );
}
