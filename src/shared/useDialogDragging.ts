import { useEffect } from "react";

const headerSelector = ":scope > header, :scope > .modal-head, :scope > .detail-toolbar, :scope > .terminal-quick-dialog-head, :scope > .terminal-connect-card-head, :scope > .frp-editor-header, :scope > .flow-details-header, :scope > .certificate-dialog-header, :scope > .auth-dialog-header";
const headerMatchSelector = headerSelector.replace(/:scope > /g, "");
const dialogSelector = ".modal, .resource-modal, .codex-dialog, .flow-dialog, .certificate-dialog, .modal-form-layout, .ai-config-dialog, .ai-asset-note-dialog, .app-confirm-dialog, .auth-dialog, .sync-transfer-panel, .terminal-quick-dialog, .terminal-connect-card, .dns-editor-modal, .security-group-modal, [role='dialog'], dialog";
const interactiveSelector = "button, a, input, select, textarea, label, [contenteditable='true'], [role='button']";

export function useDialogDragging() {
  useEffect(() => {
    let active: { element: HTMLElement; header: HTMLElement; pointerId: number; x: number; y: number; left: number; top: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const element = event.target.closest<HTMLElement>(dialogSelector);
      if (!element || element.classList.contains("ai-assist-workbench") || event.target.closest(interactiveSelector) || element.classList.contains("is-maximized") || element.classList.contains("dialog-size-expanded")) return;
      let header = event.target.closest<HTMLElement>(headerMatchSelector);
      if (!header || header.parentElement !== element) {
        const firstChild = element.firstElementChild;
        const className = firstChild instanceof HTMLElement ? firstChild.className : "";
        if (!(firstChild instanceof HTMLElement) || !(firstChild.tagName === "HEADER" || (typeof className === "string" && /(?:head|header|toolbar)$/i.test(className)))) return;
        header = firstChild;
      }
      if (!header.contains(event.target)) return;
      const rect = element.getBoundingClientRect();
      active = { element, header, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      element.style.position = "fixed";
      element.style.margin = "0";
      element.style.transform = "none";
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      header.classList.add("dialog-dragging-header");
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const { element, x, y, left, top } = active;
      const rect = element.getBoundingClientRect();
      const nextLeft = Math.min(Math.max(8, left + event.clientX - x), Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth) - 8));
      const nextTop = Math.min(Math.max(8, top + event.clientY - y), Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight) - 8));
      element.style.left = `${nextLeft}px`;
      element.style.top = `${nextTop}px`;
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      active.header.classList.remove("dialog-dragging-header");
      active = null;
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
    };
  }, []);
}
