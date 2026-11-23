import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogDocument } from "./DialogDocument";
import "./context-menu.css";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** 在该项上方显示分组分隔线。 */
  separated?: boolean;
  onSelect?: () => void;
}

/**
 * 通用右键菜单：门户到 body，按指针坐标固定定位并自动避让窗口边缘。
 * 打开后焦点落在第一项，可用方向键移动；点击外部、Escape、滚动或窗口失焦时关闭。
 * 点击菜单项会先关闭菜单再执行动作，避免动作打开新的弹层时菜单仍停留。
 */
export function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: ContextMenuItem[]; onClose: () => void }) {
  const doc = useDialogDocument();
  const view = doc.defaultView!;
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 6;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(margin, Math.min(x, view.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(y, view.innerHeight - rect.height - margin));
    // 位置未变化时保留原对象，避免重渲染后再次触发定位。
    setPosition(current => current.left === left && current.top === top ? current : { left, top });
  }, [x, y, view]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus({ preventScroll: true });
    };
    const dismiss = () => close.current();
    view.addEventListener("pointerdown", onPointerDown, true);
    view.addEventListener("keydown", onKeyDown, true);
    view.addEventListener("blur", dismiss);
    view.addEventListener("resize", dismiss);
    return () => {
      view.removeEventListener("pointerdown", onPointerDown, true);
      view.removeEventListener("keydown", onKeyDown, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    };
  }, [doc, view]);

  return createPortal(
    <div ref={menuRef} className="shared-context-menu" role="menu" aria-label={label} style={{ left: position.left, top: position.top }} onContextMenu={event => event.preventDefault()}>
      {items.map(item => <Fragment key={item.id}>
        {item.separated && <div className="shared-context-separator" role="separator" />}
        <button type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled} onClick={() => { close.current(); item.onSelect?.(); }}>
          {item.icon && <span className="shared-context-icon">{item.icon}</span>}
          <span className="shared-context-label">{item.label}</span>
        </button>
      </Fragment>)}
    </div>,
    doc.body,
  );
}
