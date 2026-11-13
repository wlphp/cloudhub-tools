import { useEffect } from "react";
import { runningInTauri, runningOnPhone } from "../platform/api";

const headerSelector = ":scope > header, :scope > .modal-head, :scope > .detail-toolbar, :scope > .terminal-quick-dialog-head, :scope > .terminal-connect-card-head, :scope > .frp-editor-header, :scope > .flow-details-header, :scope > .certificate-dialog-header, :scope > .auth-dialog-header";
const headerMatchSelector = headerSelector.replace(/:scope > /g, "");
const dialogSelector = ".modal, .resource-modal, .codex-dialog, .flow-dialog, .certificate-dialog, .modal-form-layout, .ai-config-dialog, .ai-asset-note-dialog, .app-confirm-dialog, .auth-dialog, .sync-transfer-panel, .terminal-quick-dialog, .terminal-connect-card, .dns-editor-modal, .security-group-modal, [role='dialog'], dialog";
const interactiveSelector = "button, a, input, select, textarea, label, [contenteditable='true'], [role='button']";

export function useDialogDragging(ownerDocument: Document = document, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const document = ownerDocument;
    const window = document.defaultView!;
    const { Element, HTMLElement } = window;
    let active: { element: HTMLElement; header: HTMLElement; pointerId: number; x: number; y: number; left: number; top: number; width: number; height: number; transition: string; detachRequested: boolean } | null = null;
    let frame = 0;
    let pending: { left: number; top: number } | null = null;
    const applyPending = () => {
      frame = 0;
      if (active && pending) {
        active.element.style.left = `${pending.left}px`;
        active.element.style.top = `${pending.top}px`;
      }
      pending = null;
    };
    const finish = () => {
      window.cancelAnimationFrame(frame);
      applyPending();
      const previous = active;
      active = null;
      if (!previous) return;
      previous.header.classList.remove("dialog-dragging-header");
      previous.element.style.transition = previous.transition;
      if (previous.header.hasPointerCapture(previous.pointerId)) previous.header.releasePointerCapture(previous.pointerId);
    };

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
      finish();
      const rect = element.getBoundingClientRect();
      active = { element, header, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height, transition: element.style.transition, detachRequested: false };
      header.setPointerCapture(event.pointerId);
      element.style.position = "fixed";
      element.style.margin = "0";
      element.style.transform = "none";
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      element.style.transition = "none";
      header.classList.add("dialog-dragging-header");
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const { element, x, y, left, top, width, height } = active;
      const proposedLeft = left + event.clientX - x;
      const proposedTop = top + event.clientY - y;
      if (runningInTauri && !runningOnPhone && !active.detachRequested && element.closest("[data-shared-dialog-host]") &&
          Math.hypot(event.clientX - x, event.clientY - y) > 12 &&
          (proposedLeft < -32 || proposedTop < -32 || proposedLeft + width > window.innerWidth + 32 || proposedTop + height > window.innerHeight + 32)) {
        active.detachRequested = true;
        element.dispatchEvent(new CustomEvent("cloudhub-dialog-detach", { bubbles: true, detail: { x: event.screenX - (x - left), y: event.screenY - (y - top) } }));
      }
      pending = {
        left: Math.min(Math.max(8, proposedLeft), Math.max(8, window.innerWidth - Math.min(width, window.innerWidth) - 8)),
        top: Math.min(Math.max(8, proposedTop), Math.max(8, window.innerHeight - Math.min(height, window.innerHeight) - 8)),
      };
      if (!frame) frame = window.requestAnimationFrame(applyPending);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      finish();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("lostpointercapture", onPointerUp, true);
    window.addEventListener("blur", finish);
    return () => {
      finish();
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("lostpointercapture", onPointerUp, true);
      window.removeEventListener("blur", finish);
    };
  }, [ownerDocument, enabled]);
}
