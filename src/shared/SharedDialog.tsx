import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEventHandler, type PointerEvent as ReactPointerEvent, type PointerEventHandler, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, PanelsTopLeft, X } from "lucide-react";
import { DialogHeaderActions } from "./DialogHeaderActions";
import { runningInTauri, runningOnPhone } from "../platform/api";
import { DialogDocument, useDialogDocument } from "./DialogDocument";
import { dragDetachedDialog, openDetachedDialog, type DetachedDialog } from "./detachedDialog";
import { useDetachedOwner } from "./DialogPage";

const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"], [contenteditable="true"]';
const isolation = new WeakMap<HTMLElement, { original: boolean; owners: Set<symbol> }>();

const DIALOG_MIN_WIDTH = 320;
const DIALOG_MIN_HEIGHT = 180;
const resizeDirections = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const resizeCursors: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize" };

interface DialogSize { width: number; height: number }

function loadDialogSize(key: string): DialogSize | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`cloudhub.dialogSize.${key}`) ?? "") as Partial<DialogSize> | null;
    if (!parsed || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height) || Number(parsed.width) <= 0 || Number(parsed.height) <= 0) return null;
    return { width: Math.min(16384, Math.max(1, Math.round(parsed.width as number))), height: Math.min(16384, Math.max(1, Math.round(parsed.height as number))) };
  } catch { return null; }
}

function saveDialogSize(key: string, size: DialogSize) {
  try { window.localStorage.setItem(`cloudhub.dialogSize.${key}`, JSON.stringify(size)); } catch { /* 隐私模式下写入失败可忽略 */ }
}

/** Shared shell; dragging and sizing use the existing app primitives. */
export function SharedDialog({ title, titleExtra, subtitle, eyebrow, icon, children, footer, headerActions, onClose, className = "", bodyClassName = "", footerClassName = "", backdropClassName = "", size = "large", closeLabel, showResize = true, defaultExpanded = false, closeDisabled = false, busy = false, role = "dialog", onSubmit, formRef, noValidate = false, initialFocus, onHeaderPointerDown, describedBy, resizable = true, sizeStorageKey, preserveSize = false }: {
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
  /** Keep the current dimensions when an interaction changes the dialog content. */
  preserveSize?: boolean;
}) {
  const id = useId();
  const contextDocument = useDialogDocument();
  // Focus in the detached portal can update the app's action-document context.
  // Its original parent must stay stable or the portal effect destroys its own popup.
  const parentDocument = useRef(contextDocument).current;
  const retainOwner = useDetachedOwner();
  const [portal] = useState(() => document.createElement("div"));
  const [portalReady, setPortalReady] = useState(false);
  const [ownerDocument, setOwnerDocument] = useState(parentDocument);
  const [detached, setDetached] = useState<DetachedDialog | null>(null);
  const detachedRef = useRef<DetachedDialog | null>(null);
  const [detaching, setDetaching] = useState(false);
  const detachingRef = useRef(false);
  const [detachError, setDetachError] = useState("");
  const mounted = useRef(false);
  const canDetach = runningInTauri && !runningOnPhone;
  const view = ownerDocument.defaultView!;
  const dialog = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(portal);
  const sizingEnabled = resizable && !runningOnPhone && !detached;
  const storageKey = sizeStorageKey || `shared:${className || size}`;
  const [restored, setRestored] = useState(() => ({ key: storageKey, size: sizingEnabled ? loadDialogSize(storageKey) : null }));
  const restoredSize = sizingEnabled ? (restored.key === storageKey ? restored.size : loadDialogSize(storageKey)) : null;
  const resizeCleanup = useRef<(() => void) | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    if (!detachedRef.current) {
      parentDocument.body.append(portal);
      setOwnerDocument(parentDocument);
      setPortalReady(true);
    }
    return () => {
      mounted.current = false;
      dragCleanup.current?.();
      // Return the React-owned container before the native document disappears.
      parentDocument.body.append(portal);
      detachedRef.current?.dispose();
      detachedRef.current = null;
      portal.remove();
    };
  }, [parentDocument, portal]);

  // A page popup can close while its editor is still open; return the live form to the app
  // before the native document disappears. Detached dialogs own their own popup instead.
  useLayoutEffect(() => {
    const parentWindow = parentDocument.defaultView;
    if (!parentWindow || parentDocument === document) return;
    const adopt = () => {
      if (!mounted.current || detachedRef.current) return;
      document.body.append(portal);
      setOwnerDocument(document);
      setPortalReady(true);
    };
    // WebView2 does not always deliver pagehide to a window closed natively.
    parentDocument.addEventListener("cloudhub-document-restore", adopt);
    parentWindow.addEventListener("pagehide", adopt);
    return () => {
      parentDocument.removeEventListener("cloudhub-document-restore", adopt);
      parentWindow.removeEventListener("pagehide", adopt);
    };
  }, [parentDocument, portal]);

  useLayoutEffect(() => {
    portal.className = `modal-backdrop ide-theme shared-dialog-backdrop ${backdropClassName}${detached ? " dialog-popout-host" : ""}`;
    portal.dataset.sharedDialogHost = "true";
  });

  useLayoutEffect(() => {
    if (!sizingEnabled || ownerDocument.querySelector(".mobile-shell")) return;
    const element = dialog.current;
    if (!element) return;
    const keepInViewport = () => {
      if (!element.classList.contains("dialog-user-size") || element.classList.contains("dialog-size-expanded")) return;
      if (getComputedStyle(element).position !== "fixed") return;
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(16, Math.min(rect.left, view.innerWidth - rect.width - 16))}px`;
      element.style.top = `${Math.max(16, Math.min(rect.top, view.innerHeight - rect.height - 16))}px`;
    };
    const observer = new MutationObserver(keepInViewport);
    observer.observe(element, { attributes: true, attributeFilter: ["class"] });
    view.addEventListener("resize", keepInViewport);
    return () => { observer.disconnect(); view.removeEventListener("resize", keepInViewport); resizeCleanup.current?.(); };
  }, [sizingEnabled, storageKey, ownerDocument, view, portalReady]);
  // Capture before descendant autoFocus moves focus during the commit.
  const opener = useRef(parentDocument.activeElement instanceof HTMLElement ? parentDocument.activeElement : null);
  const close = useRef(onClose);
  close.current = () => { if (!closeDisabled) onClose(); };

  const detach = async (position?: { x: number; y: number }) => {
    const element = dialog.current;
    if (!canDetach || detachingRef.current || detachedRef.current || !element || portal.closest("[inert]")) return;
    detachingRef.current = true;
    setDetaching(true);
    setDetachError("");
    try {
      const popup = await openDetachedDialog(ownerDocument, title, element.getBoundingClientRect(), position, () => { if (!portal.closest("[inert]")) close.current(); });
      if (!mounted.current) { popup.dispose(); return; }
      resizeCleanup.current?.();
      popup.document.body.append(portal);
      detachedRef.current = popup;
      setOwnerDocument(popup.document);
      setDetached(popup);
      popup.window.focus();
      // Unexpected document teardown restores the still-live form in its parent.
      popup.window.addEventListener("pagehide", () => {
        if (detachedRef.current !== popup || !mounted.current) return;
        parentDocument.body.append(portal);
        detachedRef.current = null;
        setDetached(null);
        setOwnerDocument(parentDocument);
        popup.dispose();
      }, { once: true });
    } catch (error) {
      if (mounted.current) setDetachError(error instanceof Error ? error.message : "打开独立窗口失败，内容已保留");
    } finally {
      detachingRef.current = false;
      if (mounted.current) setDetaching(false);
    }
  };
  const detachLatest = useRef(detach);
  detachLatest.current = detach;
  useEffect(() => {
    const request = (event: Event) => { void detachLatest.current((event as CustomEvent<{ x: number; y: number }>).detail); };
    portal.addEventListener("cloudhub-dialog-detach", request);
    return () => portal.removeEventListener("cloudhub-dialog-detach", request);
  }, [portal]);
  useEffect(() => {
    const dispose = () => detachedRef.current?.dispose();
    window.addEventListener("pagehide", dispose);
    return () => window.removeEventListener("pagehide", dispose);
  }, []);
  useEffect(() => { if (detached) detached.document.title = title; }, [detached, title]);
  useEffect(() => { if (detached) return retainOwner?.(); }, [detached, retainOwner]);

  const preserveCurrentSize = (event: { target: EventTarget | null }) => {
    if (event.target instanceof Element && event.target.closest(".dialog-resize-handle")) return;
    const element = dialog.current;
    if (!preserveSize || !element || element.classList.contains("dialog-size-expanded")) return;
    const rect = element.getBoundingClientRect();
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  };

  useEffect(() => {
    const background = detached ? [] : [...ownerDocument.querySelectorAll<HTMLElement>("#root, body > .workspace-popout, body > .modal-backdrop, body > .app-confirm-backdrop")]
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
    else if (!dialog.current?.contains(ownerDocument.activeElement)) dialog.current?.focus();

    const keydown = (event: KeyboardEvent) => {
      const current = dialog.current;
      if (!current || current.closest("[inert]")) return;
      // Child portals own their keyboard events despite React's portal bubbling.
      if (event.target instanceof Element && event.target !== ownerDocument.body && !current.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === "Tab") {
        const controls = [...current.querySelectorAll<HTMLElement>(focusable)]
          .filter(element => element.getClientRects().length > 0 && !element.closest("[inert]"));
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); current.focus(); }
        else if (event.shiftKey && (ownerDocument.activeElement === first || ownerDocument.activeElement === current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (ownerDocument.activeElement === last || ownerDocument.activeElement === current)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    // Inline editors may consume Escape before the shell handles it.
    ownerDocument.addEventListener("keydown", keydown);
    return () => {
      ownerDocument.removeEventListener("keydown", keydown);
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
  }, [ownerDocument, detached, portalReady]);

  // Anchor the opposite edge, and persist only sizes explicitly chosen by the user.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>, direction: string) => {
    const element = dialog.current;
    if (!sizingEnabled || !element || event.button !== 0 || element.classList.contains("dialog-size-expanded") || ownerDocument.querySelector(".mobile-shell")) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const rect = element.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const previousSelect = ownerDocument.body.style.userSelect, previousCursor = ownerDocument.body.style.cursor;
    ownerDocument.body.style.userSelect = "none";
    ownerDocument.body.style.cursor = resizeCursors[direction];
    element.classList.add("dialog-user-size", "dialog-resizing");
    Object.assign(element.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, right: "auto", bottom: "auto", margin: "0", transform: "none" });
    element.style.setProperty("--dialog-user-width", `${rect.width}px`);
    element.style.setProperty("--dialog-user-height", `${rect.height}px`);
    let changed = false;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const west = direction.includes("w"), north = direction.includes("n");
      const maxWidth = Math.max(1, west ? rect.right - 16 : view.innerWidth - rect.left - 16);
      const maxHeight = Math.max(1, north ? rect.bottom - 16 : view.innerHeight - rect.top - 16);
      const width = direction.includes("e") || west ? Math.min(maxWidth, Math.max(Math.min(DIALOG_MIN_WIDTH, maxWidth), rect.width + (west ? startX - move.clientX : move.clientX - startX))) : rect.width;
      const height = direction.includes("s") || north ? Math.min(maxHeight, Math.max(Math.min(DIALOG_MIN_HEIGHT, maxHeight), rect.height + (north ? startY - move.clientY : move.clientY - startY))) : rect.height;
      changed ||= Math.abs(width - rect.width) > .5 || Math.abs(height - rect.height) > .5;
      element.style.setProperty("--dialog-user-width", `${width}px`);
      element.style.setProperty("--dialog-user-height", `${height}px`);
      element.style.left = `${west ? rect.right - width : rect.left}px`;
      element.style.top = `${north ? rect.bottom - height : rect.top}px`;
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      ownerDocument.body.style.userSelect = previousSelect;
      ownerDocument.body.style.cursor = previousCursor;
      element.classList.remove("dialog-resizing");
      resizeCleanup.current = null;
    };
    const finish = () => {
      cleanup();
      if (!changed) return;
      const box = element.getBoundingClientRect();
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      setRestored({ key: storageKey, size: next });
      saveDialogSize(storageKey, next);
    };
    resizeCleanup.current = cleanup;
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  const content = <><div className={`modal-body ${bodyClassName}`}>{children}</div>{footer && <footer className={`modal-actions ${footerClassName}`}>{footer}</footer>}</>;
  return portalReady ? createPortal(
    <DialogDocument.Provider value={ownerDocument}>
      <section ref={dialog} className={`modal modal-form-layout dialog-common-theme shared-content-dialog shared-dialog-${size} ${sizingEnabled ? "dialog-resizable" : ""} ${restoredSize ? "dialog-user-size" : ""} ${className}`} data-dialog-size-key={storageKey} role={role} aria-modal={detached ? undefined : true} aria-busy={busy || detaching} aria-labelledby={`${id}-title`} aria-describedby={describedBy ?? (subtitle ? `${id}-subtitle` : undefined)} style={restoredSize ? { "--dialog-user-width": `${restoredSize.width}px`, "--dialog-user-height": `${restoredSize.height}px` } as CSSProperties : undefined} tabIndex={-1} onPointerDownCapture={preserveCurrentSize} onKeyDownCapture={preserveCurrentSize}>
        <header className="modal-head" onPointerDown={event => {
          if (!detached) { onHeaderPointerDown?.(event); return; }
          if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, textarea, label")) return;
          event.preventDefault();
          event.stopPropagation();
          dragCleanup.current?.();
          dragCleanup.current = dragDetachedDialog(detached, event.currentTarget, event, () => setDetachError("独立窗口拖动失败，请重试。"));
        }}>
          {icon ?? <span className="shared-dialog-mobile-icon" aria-hidden="true"><PanelsTopLeft size={22} /></span>}
          <div className="shared-dialog-heading">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={`${id}-title`}>{title}{titleExtra && <span className="shared-dialog-title-extra">{titleExtra}</span>}</h2>{subtitle && <p id={`${id}-subtitle`}>{subtitle}</p>}</div>
          <DialogHeaderActions key={`${storageKey}:${Boolean(restoredSize)}:${Boolean(detached)}`} showResize={showResize && !detached} defaultExpanded={defaultExpanded && !restoredSize && !detached}>
            {headerActions}
            {canDetach && !detached && <button type="button" className="dialog-size-button" disabled={detaching} aria-label="移到独立窗口" title="移到独立窗口（也可拖出主窗口）" onClick={() => void detach()}><ExternalLink size={16} aria-hidden="true" /></button>}
            <button type="button" className="close" disabled={closeDisabled} aria-label={closeLabel ?? `关闭${title}`} title="关闭" onClick={() => close.current()}><X size={18} aria-hidden="true" /></button>
          </DialogHeaderActions>
        </header>
        {detachError && <p className="dialog-detach-error" role="alert">{detachError}</p>}
        {onSubmit ? <form ref={formRef} className="modal-form-content" noValidate={noValidate} onSubmit={onSubmit}>{content}</form> : content}
        {sizingEnabled && resizeDirections.map(direction => <div key={direction} className={`dialog-resize-handle dialog-resize-${direction}`} aria-hidden="true" onPointerDown={event => startResize(event, direction)} />)}
      </section>
    </DialogDocument.Provider>,
    portal,
  ) : null;
}
