import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { RefreshCw } from "lucide-react";

type Phase = "idle" | "pulling" | "ready" | "refreshing" | "settling";
const triggerDistance = 64;
const restingDistance = 48;
const maxDistance = 104;

/** Keep high-frequency gesture updates out of the resource page's render cycle. */
export function MobilePullRefresh({ containerRef, actionRef, scopeKey, disabled, onError, children }: {
  containerRef: RefObject<HTMLElement | null>;
  actionRef: RefObject<(() => Promise<void>) | null>;
  scopeKey: string;
  disabled: boolean;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    const surface = surfaceRef.current;
    const indicator = indicatorRef.current;
    if (!container || !surface || !indicator) return;
    let alive = true;
    let currentPhase: Phase = "idle";
    let frame = 0;
    let settleTimer = 0;
    let finishTimer = 0;
    let distance = 0;
    let tracking: { id: number; x: number; y: number; locked: boolean } | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const updatePhase = (next: Phase) => {
      if (currentPhase === next) return;
      currentPhase = next;
      surface.dataset.pullPhase = next;
      indicator.dataset.pullPhase = next;
      setPhase(next);
    };
    const paint = () => {
      frame = 0;
      surface.style.setProperty("--pull-distance", `${distance}px`);
      indicator.style.setProperty("--pull-distance", `${distance}px`);
      indicator.style.setProperty("--pull-progress", String(Math.min(distance / triggerDistance, 1)));
    };
    const move = (next: number) => {
      distance = next;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const settle = () => {
      tracking = null;
      updatePhase("settling");
      move(0);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (alive) updatePhase("idle");
      }, reducedMotion ? 0 : 280);
    };
    // A nested scroller, editor or horizontal gesture must retain its own gestures.
    const nestedScrollTarget = (target: EventTarget | null) => {
      let element = target instanceof Element ? target : null;
      if (element?.closest("input, textarea, select, [contenteditable='true'], .mobile-terminal-output, [data-no-pull-refresh]")) return true;
      while (element && element !== container) {
        const style = getComputedStyle(element);
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) return true;
        element = element.parentElement;
      }
      return false;
    };
    const start = (event: TouchEvent) => {
      if (tracking || event.touches.length !== 1) { if (tracking) settle(); return; }
      if (disabled || container.closest("[inert]") || currentPhase !== "idle" || container.scrollTop > 1 || !actionRef.current || nestedScrollTarget(event.target)) return;
      const touch = event.touches[0];
      tracking = { id: touch.identifier, x: touch.clientX, y: touch.clientY, locked: false };
    };
    const drag = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1 || container.scrollTop > 1 || container.closest("[inert]")) { settle(); return; }
      const touch = event.touches[0];
      if (touch.identifier !== tracking.id) { settle(); return; }
      const x = touch.clientX - tracking.x;
      const y = touch.clientY - tracking.y;
      if (!tracking.locked) {
        if (Math.max(Math.abs(x), Math.abs(y)) < 8) return;
        if (y <= 0 || Math.abs(x) > y) { tracking = null; return; }
        if (!event.cancelable) { tracking = null; return; }
        tracking.locked = true;
      }
      if (event.cancelable) event.preventDefault();
      // Continuous resistance: responsive initially, progressively harder to pull.
      move(maxDistance * (1 - Math.exp(-Math.max(0, y - 8) / 150)));
      updatePhase(distance >= triggerDistance ? "ready" : "pulling");
    };
    const end = () => {
      if (!tracking) return;
      const action = actionRef.current;
      const refresh = tracking.locked && distance >= triggerDistance && action;
      tracking = null;
      if (!refresh) { if (distance > 0) settle(); return; }
      updatePhase("refreshing");
      move(restingDistance);
      const started = performance.now();
      // Catch synchronous and asynchronous failures without a stuck indicator.
      void Promise.resolve().then(() => refresh()).catch(error => {
        if (alive) errorRef.current(error instanceof Error ? error.message : "刷新失败，请重试");
      }).finally(() => {
        if (!alive) return;
        // Fast local reads should not flash and disappear before users see feedback.
        finishTimer = window.setTimeout(settle, Math.max(0, 420 - (performance.now() - started)));
      });
    };
    const cancel = () => { if (tracking) settle(); };
    setPhase("idle");
    surface.dataset.pullPhase = indicator.dataset.pullPhase = "idle";
    move(0);
    container.addEventListener("touchstart", start, { passive: true });
    container.addEventListener("touchmove", drag, { passive: false });
    container.addEventListener("touchend", end, { passive: true });
    container.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      clearTimeout(finishTimer);
      container.removeEventListener("touchstart", start);
      container.removeEventListener("touchmove", drag);
      container.removeEventListener("touchend", end);
      container.removeEventListener("touchcancel", cancel);
      surface.dataset.pullPhase = indicator.dataset.pullPhase = "idle";
      surface.style.removeProperty("--pull-distance");
      indicator.style.removeProperty("--pull-distance");
    };
  }, [containerRef, actionRef, scopeKey, disabled]);

  const visible = phase !== "idle" && phase !== "settling";
  return <>
    <div ref={indicatorRef} className="mobile-pull-refresh" aria-hidden={!visible}>
      <RefreshCw size={18} aria-hidden="true" className={phase === "refreshing" ? "mobile-spin" : ""} />
      <span role="status" aria-live="polite">{phase === "refreshing" ? "正在刷新…" : phase === "ready" ? "松开刷新" : "下拉刷新"}</span>
    </div>
    <div ref={surfaceRef} className="mobile-refresh-content">{children}</div>
  </>;
}
