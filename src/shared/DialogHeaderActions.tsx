import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import "./dialogs.css";

export function DialogHeaderActions({ children }: { children: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const dialog = button.current?.closest<HTMLElement>(".modal-form-layout,.modal,.resource-modal,.mobile-account-form,.mobile-cert-request,dialog,[role=dialog],.flow-dialog,.terminal-quick-dialog,.terminal-connect-card,.certificate-dialog");
    if (!dialog) return;
    dialog.classList.add("dialog-common-theme");
    dialog.classList.toggle("dialog-size-expanded", expanded);
    return () => dialog.classList.remove("dialog-size-expanded");
  });
  return <div className="dialog-header-actions"><button ref={button} type="button" className="dialog-size-button" aria-label={expanded ? "缩小弹层" : "最大化弹层"} title={expanded ? "缩小" : "最大化"} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}</button>{children}</div>;
}
