import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Info, LoaderCircle, X } from "lucide-react";
import { useDialogDocument } from "./DialogDocument";
import "./toast-notice.css";

const hosts = new WeakMap<Document, { element: HTMLDivElement; users: number }>();

/** Transient operation feedback. Resource state and form validation stay with their controls. */
export function ToastNotice({ message, tone, children, duration = 4500, onDismiss, className = "" }: {
  message?: string | null; tone?: "info" | "error" | "progress"; children?: ReactNode;
  /** Zero keeps live progress visible until its owner finishes. */
  duration?: number; onDismiss?: () => void; className?: string;
}) {
  const ownerDocument = useDialogDocument();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const kind = tone ?? (/失败|错误|无法|异常|未能/.test(message ?? "") ? "error" : "info");
  useLayoutEffect(() => {
    if (!message) { setHost(null); return; }
    let entry = hosts.get(ownerDocument);
    if (!entry) {
      const element = ownerDocument.createElement("div");
      element.className = "app-toast-stack ide-theme";
      element.setAttribute("data-toast-stack", "");
      ownerDocument.body.appendChild(element);
      entry = { element, users: 0 }; hosts.set(ownerDocument, entry);
    }
    entry.users++; setHost(entry.element);
    return () => {
      if (--entry.users === 0) { entry.element.remove(); hosts.delete(ownerDocument); }
    };
  }, [ownerDocument, !!message]);
  useEffect(() => { setDismissed(null); setPaused(false); }, [message]);
  useEffect(() => {
    if (!message || duration <= 0 || paused || dismissed === message) return;
    const timer = ownerDocument.defaultView!.setTimeout(() => { setDismissed(message); dismissRef.current?.(); }, duration);
    return () => ownerDocument.defaultView!.clearTimeout(timer);
  }, [message, duration, paused, dismissed, ownerDocument]);
  if (!message || !host || dismissed === message) return null;
  const Icon = kind === "progress" ? LoaderCircle : kind === "error" ? CircleAlert : Info;
  return createPortal(<div className={`toast-notice app-toast-notice is-${kind} ${className}`} role={kind === "error" ? "alert" : "status"} aria-atomic="true"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false); }}>
    <Icon size={16} aria-hidden="true" /><div className="app-toast-content"><span>{message}</span>{children}</div>
    {kind !== "progress" && <button type="button" className="app-toast-close" aria-label="关闭通知" title="关闭通知" onClick={() => { setDismissed(message); dismissRef.current?.(); }}><X size={14} aria-hidden="true" /></button>}
  </div>, host);
}
