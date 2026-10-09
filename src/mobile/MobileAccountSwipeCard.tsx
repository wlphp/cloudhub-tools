import { Children, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export function MobileAccountSwipeCard({ label, children }: { label: string; children: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; start: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [content, ...actions] = Children.toArray(children);
  const settle = (left: number) => {
    const element = card.current;
    if (!element) return;
    element.scrollTo({ left, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return <article ref={card} className={`mobile-account-card mobile-account-swipe-card${dragging ? " is-dragging" : ""}`}
    onScroll={(event) => setExpanded(event.currentTarget.scrollLeft > 40)}
    onPointerDown={(event) => {
      suppressClick.current = false;
      if (event.pointerType !== "mouse" || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest(".mobile-account-select")) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: event.currentTarget.scrollLeft, dragging: false };
    }}
    onPointerMove={(event) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      const delta = event.clientX - current.x;
      const vertical = event.clientY - current.y;
      if (!current.dragging) {
        if (Math.abs(vertical) > 8 && Math.abs(vertical) > Math.abs(delta)) { gesture.current = null; return; }
        if (Math.abs(delta) < 8) return;
        current.dragging = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }
      event.preventDefault();
      event.currentTarget.scrollLeft = current.start - delta;
    }}
    onPointerUp={(event) => {
      const current = gesture.current;
      gesture.current = null;
      if (!current?.dragging) return;
      setDragging(false);
      const maximum = event.currentTarget.scrollWidth - event.currentTarget.clientWidth;
      const delta = current.x - event.clientX;
      settle(Math.abs(delta) > 32 ? delta > 0 ? maximum : 0 : event.currentTarget.scrollLeft > maximum / 2 ? maximum : 0);
    }}
    onPointerCancel={() => { gesture.current = null; setDragging(false); }}
    onLostPointerCapture={() => { gesture.current = null; setDragging(false); }}
    onClickCapture={(event) => {
      if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    }}>
    <div className="mobile-account-swipe-main">{content}<button type="button" className="mobile-account-menu" aria-label={`${expanded ? "收起" : "展开"} ${label} 操作`} aria-expanded={expanded} title="更多操作" onClick={() => {
      const element = card.current;
      if (element) settle(expanded ? 0 : element.scrollWidth - element.clientWidth);
    }}><MoreHorizontal size={19} /></button></div>
    {actions}
  </article>;
}
