import type { PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import "./sortable-drag.css";

export function ListSortHandle({ id, name, ids, disabled, onStart, onMove }: {
  id: string; name: string; ids: string[]; disabled: boolean;
  onStart: (event: PointerEvent<HTMLElement>, id: string) => void;
  onMove: (source: string, target: string) => void;
}) {
  return <button type="button" className="list-sort-handle" disabled={disabled} aria-label={`拖动排序 ${name}`} title="拖动排序，也可用上下方向键调整" onPointerDown={event => onStart(event, id)} onKeyDown={event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const target = ids[ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) onMove(id, target);
  }}><GripVertical size={16} aria-hidden="true" /></button>;
}
