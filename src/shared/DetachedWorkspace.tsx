import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, PanelsTopLeft } from "lucide-react";
import { runningInTauri, runningOnPhone } from "../platform/api";
import { DialogDocument } from "./DialogDocument";
import { openDetachedDialog, type DetachedDialog } from "./detachedDialog";
import "./detached-workspace.css";

/** Move the live portal so terminal sessions and local edits keep their owner. */
export function DetachedWorkspace({ children, enabled, visible, onDetachedChange, onDocumentChange }: {
  children: (controls: { onPointerDown: (event: PointerEvent<HTMLElement>) => void; action: ReactNode }) => ReactNode;
  enabled: boolean;
  visible: boolean;
  onDocumentChange: (owner: Document) => void;
  onDetachedChange: (detached: boolean) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [portal] = useState(() => document.createElement("div"));
  const popup = useRef<DetachedDialog | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [owner, setOwner] = useState(document);
  const [error, setError] = useState("");
  const changed = useRef(onDetachedChange);
  changed.current = onDetachedChange;
  const documentChanged = useRef(onDocumentChange);
  documentChanged.current = onDocumentChange;
  const canDetach = enabled && runningInTauri && !runningOnPhone;

  const restore = () => {
    const previous = popup.current;
    if (!previous) return;
    // Adopt back before destroying the native document; React keeps the same nodes.
    anchor.current?.append(portal);
    popup.current = null;
    setOwner(document);
    documentChanged.current(document);
    changed.current(false);
    previous.dispose();
  };

  useLayoutEffect(() => {
    mounted.current = true;
    portal.className = "detachable-workspace-content";
    anchor.current?.append(portal);
    const dispose = () => popup.current?.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      mounted.current = false;
      anchor.current?.append(portal);
      popup.current?.dispose();
      popup.current = null;
      portal.remove();
      window.removeEventListener("pagehide", dispose);
    };
  }, [portal]);

  const detach = async (position?: { x: number; y: number }) => {
    if (!canDetach || busy.current || popup.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const bounds = portal.querySelector(".managed-servers-page")!.getBoundingClientRect();
      const result = await openDetachedDialog(document, "终端管理 · 云枢工具箱", bounds, position, restore);
      if (!mounted.current) { result.dispose(); return; }
      // Theme variables are scoped to the application shell in the parent.
      const shell = anchor.current?.closest(".ide-theme");
      portal.className = `detachable-workspace-content ide-theme workspace-popout${shell?.classList.contains("theme-light") ? " theme-light" : ""}`;
      result.document.body.append(portal);
      popup.current = result;
      setOwner(result.document);
      documentChanged.current(result.document);
      changed.current(true);
      result.window.addEventListener("pagehide", () => { if (popup.current === result && mounted.current) restore(); }, { once: true });
      result.window.focus();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "打开独立窗口失败，请重试");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!canDetach || event.button !== 0 || (event.target as Element).closest("button, input, select, textarea, a, label, [role='tab']")) return;
    if (popup.current) { event.preventDefault(); void popup.current.native.startDragging().catch(() => {}); return; }
    const header = event.currentTarget;
    const view = header.ownerDocument.defaultView!;
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = portal.querySelector(".managed-servers-page")!.getBoundingClientRect();
    const pointerId = event.pointerId;
    header.setPointerCapture(pointerId);
    const finish = () => {
      view.removeEventListener("pointermove", move);
      view.removeEventListener("pointerup", finish);
      view.removeEventListener("pointercancel", finish);
      if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId || Math.hypot(next.clientX - startX, next.clientY - startY) < 16) return;
      finish();
      void detach({ x: next.screenX - (startX - bounds.left), y: next.screenY - (startY - bounds.top) });
    };
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", finish, { once: true });
    view.addEventListener("pointercancel", finish, { once: true });
    event.preventDefault();
  };

  const detached = owner !== document;
  useLayoutEffect(() => { if (!detached) portal.className = "detachable-workspace-content"; }, [detached, portal]);
  const action = canDetach ? <button type="button" className="terminal-workspace-popout" disabled={pending} title={detached ? "回到父页面" : "独立窗口（也可拖动顶部空白处）"} onClick={() => detached ? restore() : void detach()}>{detached ? <PanelsTopLeft size={14} /> : <ExternalLink size={14} />}{detached ? "回到父页面" : pending ? "正在分离…" : "独立窗口"}</button> : null;
  return <>
    <div ref={anchor} className="detachable-workspace-anchor" />
    {detached && visible && <div className="terminal-workspace-placeholder"><p>终端管理已移到独立窗口</p><button type="button" className="secondary" onClick={() => void popup.current?.native.setFocus()}>显示独立窗口</button><button type="button" className="secondary" onClick={restore}>回到父页面</button></div>}
    {createPortal(<DialogDocument.Provider value={owner}>{error && <p role="alert" className="dialog-detach-error">{error}</p>}{children({ onPointerDown, action })}</DialogDocument.Provider>, portal)}
  </>;
}
