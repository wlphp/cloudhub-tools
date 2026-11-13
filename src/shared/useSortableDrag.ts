import { useEffect, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import "./sortable-drag.css";

export type SortableDrop = { key: string; side: "before" | "after" };
type Options = {
  selector: string; attribute: string; scope?: string; layout?: "list" | "grid"; enabled?: boolean;
  insertion?: "nearest" | "edges"; hitArea?: string;
  onMove: (source: string, target: string, after: boolean) => void;
  onPreview?: (drop: SortableDrop | null) => void;
  canMove?: (source: string, target: string) => boolean;
};

/** Preview with transforms; persist once and settle into the committed slots. */
export function useSortableDrag(options: Options) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const cleanupRef = useRef<(() => void) | null>(null);
  const animations = useRef(new Set<Animation>());
  useEffect(() => () => { cleanupRef.current?.(); animations.current.forEach(animation => animation.cancel()); }, []);

  function startDrag(event: PointerEvent<HTMLElement>, sourceKey: string) {
    if (latest.current.enabled === false || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    cleanupRef.current?.();
    animations.current.forEach(animation => animation.cancel());
    animations.current.clear();
    const config = latest.current;
    const handle = event.currentTarget;
    const document = handle.ownerDocument;
    const window = document.defaultView!;
    const source = handle.closest<HTMLElement>(config.selector);
    const container = config.scope ? source?.closest<HTMLElement>(config.scope) : source?.parentElement;
    if (!source || !container) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(config.selector));
    const sourceIndex = items.indexOf(source);
    if (sourceIndex < 0 || items.length < 2) return;
    const rects = items.map(item => item.getBoundingClientRect());
    const hitRects = items.map(item => (config.hitArea ? item.querySelector(config.hitArea) : item)?.getBoundingClientRect() || item.getBoundingClientRect());
    const originalStyles = items.map(item => ({ transform: item.style.transform, transition: item.style.transition, willChange: item.style.willChange }));
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    const grid = config.layout === "grid";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let x = startX, y = startY, targetIndex = sourceIndex, frame = 0;
    let target: SortableDrop | null = null;
    let active = false, ended = false;
    let scrollParent: HTMLElement | null = container;
    while (scrollParent && !(scrollParent.scrollHeight > scrollParent.clientHeight && /auto|scroll/.test(window.getComputedStyle(scrollParent).overflowY))) scrollParent = scrollParent.parentElement;
    const scroller = scrollParent || document.scrollingElement as HTMLElement;
    const initialScroll = scroller.scrollTop;
    const originalCursor = document.body.style.cursor, originalSelection = document.body.style.userSelect;
    event.preventDefault();
    handle.setPointerCapture(pointerId);

    function preview(next: SortableDrop | null) {
      if (target?.key === next?.key && target?.side === next?.side) return;
      target = next;
      latest.current.onPreview?.(next);
    }
    function draw(autoScroll = true) {
      if (!active || ended) return;
      if (!source!.isConnected) { finish(false); return; }
      const bounds = scrollParent?.getBoundingClientRect() || { top: 0, bottom: window.innerHeight };
      const containerBounds = container!.getBoundingClientRect();
      const edge = y < bounds.top + 36 ? y - bounds.top - 36 : y > bounds.bottom - 36 ? y - bounds.bottom + 36 : 0;
      if (autoScroll && edge && x >= containerBounds.left && x <= containerBounds.right) scroller.scrollTop += Math.max(-10, Math.min(10, edge / 4));
      const scrollDelta = scroller.scrollTop - initialScroll;
      const dx = grid ? x - startX : 0, dy = y - startY + scrollDelta;
      const pointX = x;
      const pointY = !grid && config.insertion !== "edges" ? rects[sourceIndex].top + rects[sourceIndex].height / 2 + dy : y + scrollDelta;
      const inside = x >= containerBounds.left && x <= containerBounds.right && y >= Math.max(containerBounds.top, bounds.top) && y <= Math.min(containerBounds.bottom, bounds.bottom);
      targetIndex = sourceIndex;
      if (inside) {
        const nearest = hitRects.reduce((best, rect, index) => {
          const distance = Math.hypot(grid ? rect.left + rect.width / 2 - pointX : 0, rect.top + rect.height / 2 - pointY);
          return distance < best.distance ? { index, distance } : best;
        }, { index: sourceIndex, distance: Infinity }).index;
        const after = config.insertion === "edges" ? pointY >= hitRects[nearest].top + hitRects[nearest].height / 2 : nearest > sourceIndex;
        const candidate = items[nearest].getAttribute(config.attribute)!;
        if (config.canMove && !config.canMove(sourceKey, candidate)) preview(null);
        else {
          targetIndex = config.insertion === "edges" ? nearest + (after ? 1 : 0) - (sourceIndex < nearest + (after ? 1 : 0) ? 1 : 0) : nearest;
          preview(nearest === sourceIndex ? null : { key: candidate, side: after ? "after" : "before" });
        }
      } else preview(null);
      const order = items.map((_, index) => index);
      order.splice(sourceIndex, 1);
      order.splice(targetIndex, 0, sourceIndex);
      let top = rects[0].top;
      const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
      order.forEach((index, slot) => {
        const destination = grid ? rects[slot] : { left: rects[index].left, top };
        const tx = index === sourceIndex ? dx : destination.left - rects[index].left;
        const ty = index === sourceIndex ? dy : destination.top - rects[index].top;
        items[index].style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        top += rects[index].height + gap;
      });
    }
    function tick() { draw(); if (!ended) frame = window.requestAnimationFrame(tick); }
    function move(moveEvent: globalThis.PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      x = moveEvent.clientX; y = moveEvent.clientY;
      if (!active && Math.hypot(x - startX, y - startY) >= 5) {
        active = true;
        setDraggedKey(sourceKey);
        source!.setAttribute("data-sortable-dragging", "");
        document.body.style.cursor = "grabbing"; document.body.style.userSelect = "none";
        items.forEach(item => { item.style.willChange = "transform"; item.style.transition = item === source || reducedMotion ? "none" : "transform 160ms cubic-bezier(.2,.8,.2,1)"; });
        frame = window.requestAnimationFrame(tick);
      }
      moveEvent.preventDefault();
    }
    function cleanup() {
      ended = true;
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", drop);
      document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", cancel); handle.removeEventListener("lostpointercapture", cancel);
      source!.removeAttribute("data-sortable-dragging");
      items.forEach((item, index) => Object.assign(item.style, originalStyles[index]));
      document.body.style.cursor = originalCursor; document.body.style.userSelect = originalSelection;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      cleanupRef.current = null;
    }
    function finish(commit: boolean) {
      if (ended) return;
      const positions = items.map(item => item.getBoundingClientRect());
      const dropTarget = target;
      const destination = config.insertion === "edges" ? dropTarget?.key : items[targetIndex].getAttribute(config.attribute);
      cleanup();
      flushSync(() => {
        setDraggedKey(null); latest.current.onPreview?.(null);
        if (commit && latest.current.enabled !== false && active && destination && targetIndex !== sourceIndex && (!latest.current.canMove || latest.current.canMove(sourceKey, destination))) latest.current.onMove(sourceKey, destination, dropTarget?.side === "after");
      });
      if (active && !reducedMotion) items.forEach((item, index) => {
        if (!item.isConnected) return;
        const rect = item.getBoundingClientRect(), dx = positions[index].left - rect.left, dy = positions[index].top - rect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        if (item === source) item.setAttribute("data-sortable-settling", "");
        const animation = item.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: originalStyles[index].transform || "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
        animations.current.add(animation);
        const settled = () => { animations.current.delete(animation); item.removeAttribute("data-sortable-settling"); };
        void animation.finished.then(settled, settled);
      });
      if (active) {
        const suppressClick = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
        handle.addEventListener("click", suppressClick, { capture: true, once: true });
        window.setTimeout(() => handle.removeEventListener("click", suppressClick, true), 0);
      }
      if (handle.isConnected) handle.focus({ preventScroll: true });
    }
    function drop(endEvent: globalThis.PointerEvent) {
      if (endEvent.pointerId !== pointerId) return;
      x = endEvent.clientX; y = endEvent.clientY;
      draw(false); finish(Boolean(target));
    }
    function cancel() { finish(false); }
    function keydown(keyEvent: KeyboardEvent) { if (keyEvent.key === "Escape") { keyEvent.preventDefault(); keyEvent.stopPropagation(); cancel(); } }
    cleanupRef.current = cleanup;
    document.addEventListener("pointermove", move, { passive: false }); document.addEventListener("pointerup", drop);
    document.addEventListener("pointercancel", cancel); document.addEventListener("keydown", keydown);
    window.addEventListener("blur", cancel); handle.addEventListener("lostpointercapture", cancel);
  }
  return { draggedKey, startDrag };
}
