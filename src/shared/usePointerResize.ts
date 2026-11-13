import { useEffect, useRef, type PointerEvent } from "react";

/** Batch pane measurements to one update per frame and always release capture. */
export function usePointerResize() {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  return (event: PointerEvent<HTMLElement>, options: { className: string; onResize: (delta: number) => void; onFinish?: (delta: number) => void }) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    cleanupRef.current?.();
    const handle = event.currentTarget, document = handle.ownerDocument, window = document.defaultView!;
    const pointerId = event.pointerId, initialX = event.clientX;
    let delta = 0, frame = 0;
    event.preventDefault();
    handle.setPointerCapture(pointerId);
    document.body.classList.add(options.className);
    const apply = () => { frame = 0; options.onResize(delta); };
    const move = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      delta = pointer.clientX - initialX;
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    const cleanup = () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", abort);
      document.removeEventListener("keydown", keydown);
      handle.removeEventListener("lostpointercapture", abort);
      document.body.classList.remove(options.className);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      cleanupRef.current = null;
    };
    const end = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      delta = pointer.clientX - initialX;
      cleanup(); options.onResize(delta); options.onFinish?.(delta);
    };
    const abort = () => { cleanup(); options.onResize(0); };
    const cancel = (pointer: globalThis.PointerEvent) => { if (pointer.pointerId === pointerId) abort(); };
    const keydown = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); abort(); } };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", abort);
    document.addEventListener("keydown", keydown);
    handle.addEventListener("lostpointercapture", abort);
  };
}
