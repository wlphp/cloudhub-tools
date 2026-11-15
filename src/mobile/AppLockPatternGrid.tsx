import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { collectPathHits, withPassThroughDots } from "./app-lock-pattern-geometry";

interface AppLockPatternGridProps {
  /** 松手且已连接至少 4 个点时回调；返回的是 "0472" 形式的点序字符串。 */
  onComplete: (pattern: string) => void;
  disabled?: boolean;
  /** 父组件递增该值触发一次「失败轨迹红色闪示」，便于对照刚才实际登记的序列。 */
  failureSignal?: number;
}

const SHAKE_MS = 500;
const FAILURE_FLASH_MS = 700;

/** 3×3 滑动图案九宫格；锁屏与设置页共用，轨迹只保存在内存中。
 * 命中判定按「上一采样点 → 当前采样点」的线段计算而非离散采样点，快速滑动不漏点；
 * 相邻登记点连线穿过的未登记点自动补入，同一形状永远得到同一序列。 */
export function AppLockPatternGrid({ onComplete, disabled = false, failureSignal = 0 }: AppLockPatternGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const sequenceRef = useRef<number[]>([]);
  const lastSampleRef = useRef<{ x: number; y: number } | null>(null);
  const lastAttemptRef = useRef<number[]>([]);
  const shakeTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const failureSeenRef = useRef(failureSignal);
  const [sequence, setSequence] = useState<number[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [shake, setShake] = useState(false);
  const [flash, setFlash] = useState(false);

  const applySequence = (next: number[]) => {
    sequenceRef.current = next;
    setSequence(next);
  };

  const clearTimers = () => {
    if (shakeTimerRef.current !== null) { window.clearTimeout(shakeTimerRef.current); shakeTimerRef.current = null; }
    if (flashTimerRef.current !== null) { window.clearTimeout(flashTimerRef.current); flashTimerRef.current = null; }
  };

  useEffect(() => clearTimers, []);

  // 父组件验证失败后递增 failureSignal：恢复显示上次登记的轨迹并标红，供用户对照纠错。
  useEffect(() => {
    if (failureSignal === failureSeenRef.current) return;
    failureSeenRef.current = failureSignal;
    if (drawingRef.current || lastAttemptRef.current.length === 0) return;
    clearTimers();
    applySequence(lastAttemptRef.current);
    setFlash(true);
    flashTimerRef.current = window.setTimeout(() => {
      setFlash(false);
      applySequence([]);
      flashTimerRef.current = null;
    }, FAILURE_FLASH_MS);
  }, [failureSignal]);

  /** 按下归属：手指落在哪个格子就选中该格的点，与视觉位置一致。
   * 坐标统一使用网格本地坐标（clientX/Y 减去 rect 偏移），命中判定、采样与轨迹显示共用同一坐标系。 */
  const hitCell = (localX: number, localY: number, cell: number): number | null => {
    const col = Math.floor(localX / cell);
    const row = Math.floor(localY / cell);
    if (col < 0 || col > 2 || row < 0 || row > 2) return null;
    return row * 3 + col;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    clearTimers();
    setShake(false);
    setFlash(false);
    drawingRef.current = true;
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    lastSampleRef.current = point;
    setCursor(point);
    const index = hitCell(point.x, point.y, rect.width / 3);
    applySequence(index === null ? [] : [index]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !drawingRef.current) return;
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setCursor(point);
    const last = lastSampleRef.current;
    if (last) {
      const cell = rect.width / 3;
      const hits = collectPathHits(last.x, last.y, point.x, point.y, cell, sequenceRef.current);
      if (hits.length > 0) applySequence(withPassThroughDots([...sequenceRef.current, ...hits], cell));
    }
    lastSampleRef.current = point;
  };

  const stopDrawing = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setCursor(null);
    lastSampleRef.current = null;
    const attempted = sequenceRef.current;
    if (attempted.length >= 4) {
      lastAttemptRef.current = attempted;
      onComplete(attempted.join(""));
      applySequence([]);
    } else {
      // 不足 4 个点：抖动提示，轨迹保留到动画结束，让用户看清画了几个点。
      setShake(true);
      shakeTimerRef.current = window.setTimeout(() => {
        setShake(false);
        applySequence([]);
        shakeTimerRef.current = null;
      }, SHAKE_MS);
    }
  };

  const cell = (gridRef.current?.getBoundingClientRect().width ?? 0) / 3;
  const trailPoints = sequence.map((index) => ({
    x: ((index % 3) + 0.5) * cell,
    y: (Math.floor(index / 3) + 0.5) * cell,
  }));
  const lastPoint = trailPoints[trailPoints.length - 1];

  return (
    <div
      ref={gridRef}
      className={"app-lock-pattern" + (disabled ? " is-disabled" : "") + (shake ? " is-shake" : "") + (flash ? " is-flash" : "")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDrawing}
      onPointerCancel={stopDrawing}
      role="group"
      aria-label="滑动图案"
    >
      <svg className="app-lock-pattern-trail" aria-hidden="true">
        {trailPoints.length > 1 && <polyline points={trailPoints.map((point) => `${point.x},${point.y}`).join(" ")} />}
        {lastPoint && cursor && <line x1={lastPoint.x} y1={lastPoint.y} x2={cursor.x} y2={cursor.y} />}
      </svg>
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className={"app-lock-pattern-dot" + (sequence.includes(index) ? " is-active" : "")} aria-hidden="true" />
      ))}
    </div>
  );
}
