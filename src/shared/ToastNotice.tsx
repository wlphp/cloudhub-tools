import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Info, LoaderCircle, X } from "lucide-react";
import { useDialogDocument } from "./DialogDocument";
import "./toast-notice.css";

type ToastMember = { primary: (value: boolean) => void; dismiss: () => void };
const hosts = new WeakMap<Document, { element: HTMLDivElement; groups: Map<string | symbol, Set<ToastMember>> }>();

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
  const [primary, setPrimary] = useState(false);
  const dismissGroup = useRef(() => {});
  const uniqueKey = useRef(Symbol());
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const kind = tone ?? (/失败|错误|无法|异常|未能/.test(message ?? "") ? "error" : "info");
  useLayoutEffect(() => {
    if (!message || dismissed === message) { setHost(null); return; }
    let entry = hosts.get(ownerDocument);
    if (!entry) {
      const element = ownerDocument.createElement("div");
      element.className = "app-toast-stack ide-theme";
      element.setAttribute("data-toast-stack", "");
      ownerDocument.body.appendChild(element);
      entry = { element, groups: new Map() }; hosts.set(ownerDocument, entry);
    }
    // Rich/actionable notifications remain independent; plain feedback shares a slot.
    const key = kind === "progress" || children ? uniqueKey.current : `${kind}:${message}`;
    let group = entry.groups.get(key);
    if (!group) { group = new Set(); entry.groups.set(key, group); }
    const member: ToastMember = { primary: setPrimary, dismiss: () => { setDismissed(message); dismissRef.current?.(); } };
    group.add(member);
    group.forEach(item => item.primary(item === group.values().next().value));
    dismissGroup.current = () => { [...group].forEach(item => item.dismiss()); };
    setHost(entry.element);
    return () => {
      group.delete(member);
      if (!group.size) entry.groups.delete(key);
      else group.forEach(item => item.primary(item === group.values().next().value));
      if (!entry.groups.size) { entry.element.remove(); hosts.delete(ownerDocument); }
    };
  }, [ownerDocument, message, kind, dismissed === message, !!children]);
  useEffect(() => { setDismissed(null); setPaused(false); }, [message]);
  useEffect(() => {
    if (!message || !primary || duration <= 0 || paused || dismissed === message) return;
    const timer = ownerDocument.defaultView!.setTimeout(() => dismissGroup.current(), duration);
    return () => ownerDocument.defaultView!.clearTimeout(timer);
  }, [message, duration, paused, dismissed, ownerDocument, primary]);
  if (!message || !host || !primary || dismissed === message) return null;
  const Icon = kind === "progress" ? LoaderCircle : kind === "error" ? CircleAlert : Info;
  return createPortal(<div className={`toast-notice app-toast-notice is-${kind} ${className}`} role={kind === "error" ? "alert" : "status"} aria-atomic="true"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false); }}>
    <Icon size={16} aria-hidden="true" /><div className="app-toast-content"><span>{message}</span>{children}</div>
    {kind !== "progress" && <button type="button" className="app-toast-close" aria-label="关闭通知" title="关闭通知" onClick={() => dismissGroup.current()}><X size={14} aria-hidden="true" /></button>}
  </div>, host);
}
