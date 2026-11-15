import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface AppLockPatternGridProps {
  /** 松手且已连接至少 4 个点时回调；返回的是 "0472" 形式的点序字符串。 */
  onComplete: (pattern: string) => void;
  disabled?: boolean;
}

/** 3×3 滑动图案九宫格；锁屏与设置页共用，轨迹只保存在内存中。 */
export function AppLockPatternGrid({ onComplete, disabled = false }: AppLockPatternGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const sequenceRef = useRef<number[]>([]);
  const [sequence, setSequence] = useState<number[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const applySequence = (next: number[]) => {
    sequenceRef.current = next;
    setSequence(next);
  };

  const dotCenter = (index: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const cell = rect.width / 3;
    return {
      x: (index % 3) * cell + cell / 2,
      y: Math.floor(index / 3) * cell + cell / 2,
      radius: cell / 2,
    };
  };

  const hitDot = (clientX: number, clientY: number): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const cell = rect.width / 3;
    const col = Math.floor((clientX - rect.left) / cell);
    const row = Math.floor((clientY - rect.top) / cell);
    if (col < 0 || col > 2 || row < 0 || row > 2) return null;
    const index = row * 3 + col;
    const center = dotCenter(index);
    if (!center) return null;
    const dx = clientX - rect.left - center.x;
    const dy = clientY - rect.top - center.y;
    // 触点略超出圆形热区也算命中，减少手指抖动导致的断线。
    return Math.hypot(dx, dy) <= center.radius * 1.35 ? index : null;
  };

  const stopDrawing = () => {
    drawingRef.current = false;
    setCursor(null);
    if (sequenceRef.current.length >= 4) onComplete(sequenceRef.current.join(""));
    applySequence([]);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const index = hitDot(event.clientX, event.clientY);
    applySequence(index === null ? [] : [index]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !drawingRef.current) return;
    const grid = gridRef.current;
    if (grid) {
      const rect = grid.getBoundingClientRect();
      setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    const index = hitDot(event.clientX, event.clientY);
    if (index === null) return;
    const current = sequenceRef.current;
    if (current[current.length - 1] !== index) applySequence([...current, index]);
  };

  const trailPoints = sequence.map((index) => dotCenter(index)).filter((point): point is { x: number; y: number; radius: number } => point !== null);
  const lastPoint = trailPoints[trailPoints.length - 1];

  return (
    <div
      ref={gridRef}
      className={"app-lock-pattern" + (disabled ? " is-disabled" : "")}
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
