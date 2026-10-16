import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import "./dialogs.css";

export function DialogHeaderActions({ children, defaultExpanded = false, expanded: controlledExpanded, onExpandedChange, showResize = true }: { children: ReactNode; defaultExpanded?: boolean; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void; showResize?: boolean }) {
  const actions = useRef<HTMLDivElement>(null);
  const [localExpanded, setExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? localExpanded;
  useLayoutEffect(() => {
    const dialog = actions.current?.closest<HTMLElement>(".modal-form-layout,.modal,.resource-modal,.mobile-account-form,.mobile-cert-request,dialog,[role=dialog],.flow-dialog,.terminal-quick-dialog,.terminal-connect-card,.certificate-dialog");
    if (!dialog) return;
    dialog.classList.add("dialog-common-theme");
    // Controlled sizing is owned by the native window rather than viewport CSS.
    dialog.classList.toggle("dialog-size-expanded", expanded && !onExpandedChange);
    return () => dialog.classList.remove("dialog-size-expanded");
  });
  return <div ref={actions} className="dialog-header-actions">{showResize && <button type="button" className="dialog-size-button" aria-label={expanded ? "缩小弹层" : "最大化弹层"} title={expanded ? "缩小" : "最大化"} aria-pressed={expanded} onClick={() => onExpandedChange ? onExpandedChange(!expanded) : setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}</button>}{children}</div>;
}
