import type { KeyboardEvent, PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import "./sortable-drag.css";

function handleKeyDown(event: KeyboardEvent<HTMLElement>, ids: string[], id: string, onMove: (source: string, target: string) => void) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const target = ids[ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)];
  if (target) onMove(id, target);
}

export function ListSortHandle({ id, name, ids, disabled, onStart, onMove, as = "button" }: {
  id: string; name: string; ids: string[]; disabled: boolean;
  onStart: (event: PointerEvent<HTMLElement>, id: string) => void;
  onMove: (source: string, target: string) => void;
  /** 卡片本身是 button 时用 span 变体，避免按钮嵌套按钮。 */
  as?: "button" | "span";
}) {
  if (as === "span") {
    return <span
      role="button"
      tabIndex={disabled ? undefined : 0}
      aria-disabled={disabled || undefined}
      className="list-sort-handle"
      aria-label={`拖动排序 ${name}`}
      title="拖动排序，也可用上下方向键调整"
      onPointerDown={event => onStart(event, id)}
      onKeyDown={event => handleKeyDown(event, ids, id, onMove)}
    ><GripVertical size={16} aria-hidden="true" /></span>;
  }
  return <button type="button" className="list-sort-handle" disabled={disabled} aria-label={`拖动排序 ${name}`} title="拖动排序，也可用上下方向键调整" onPointerDown={event => onStart(event, id)} onKeyDown={event => handleKeyDown(event, ids, id, onMove)}><GripVertical size={16} aria-hidden="true" /></button>;
}
