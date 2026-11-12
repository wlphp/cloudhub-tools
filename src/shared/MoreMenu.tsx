import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogDocument } from "./DialogDocument";

interface MoreMenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
}

interface MoreMenuProps {
  items: MoreMenuItem[];
  /** 触发按钮文案（可与 triggerIcon 同时使用，图标在前）。 */
  label?: ReactNode;
  /** 完全自定义触发按钮内容，优先于 label / triggerIcon。 */
  trigger?: ReactNode;
  triggerIcon?: ReactNode;
  triggerTitle?: string;
  triggerAriaLabel?: string;
  /** 附加到触发按钮上的样式类（沿用各页面既有按钮样式）。 */
  triggerClassName?: string;
  /** 菜单与触发按钮的对齐方式：right 右对齐（默认）、left 左对齐、center 相对触发按钮居中。 */
  align?: "right" | "left" | "center";
  /** 受控打开状态；不传则组件内部自持。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 菜单顶部信息行（如发行版元数据）。 */
  header?: ReactNode;
}

/**
 * 统一的「更多」下拉菜单：portal 到 body 渲染，避免被表格/卡片的 overflow 裁剪，
 * 打开时按触发按钮定位并自动上下翻转，点击外部或 Escape 关闭。
 */
export function MoreMenu({ items, label, trigger, triggerIcon, triggerTitle, triggerAriaLabel, triggerClassName, align = "right", open, onOpenChange, header }: MoreMenuProps) {
  const document = useDialogDocument();
  const window = document.defaultView!;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRect = useRef<DOMRect | null>(null);
  const [openState, setOpenState] = useState(false);
  const isOpen = open ?? openState;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setOpenState(next); };
  const [position, setPosition] = useState<{ top: number; left: number; transform: string; zIndex?: number }>({ top: 0, left: 0, transform: "" });

  const toggle = () => {
    if (isOpen) { setOpen(false); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      anchorRect.current = rect;
      const estimatedHeight = items.length * 34 + (header ? 26 : 0) + 12;
      const flip = rect.bottom + 8 + estimatedHeight > window.innerHeight - 8 && rect.top - estimatedHeight - 8 > 8;
      const menuHalf = 78;
      const rightAligned = align === "right" && rect.right >= 170;
      const centered = align === "center";
      const centerX = Math.max(menuHalf + 8, Math.min(rect.left + rect.width / 2, window.innerWidth - menuHalf - 8));
      const backdrop = triggerRef.current?.closest(".modal-backdrop");
      setPosition({
        zIndex: backdrop ? (Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 10000) + 1 : undefined,
        top: flip ? rect.top - 8 : rect.bottom + 8,
        left: centered ? centerX : rightAligned ? rect.right : Math.max(8, Math.min(rect.left, window.innerWidth - 160)),
        transform: `${flip ? "translateY(-100%) " : ""}${rightAligned ? "translateX(-100%)" : ""}${centered ? "translateX(-50%)" : ""}`.trim(),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const close = () => setOpen(false);
    const onScroll = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const anchor = anchorRect.current;
      // Opening a table action can deliver an already-completed scroll event.
      if (!rect || !anchor || Math.abs(rect.top - anchor.top) > 1 || Math.abs(rect.left - anchor.left) > 1) close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (wrapRef.current?.contains(event.target) || menuRef.current?.contains(event.target))) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!buttons.length) return;
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen, document, window]);

  return <span ref={wrapRef} className={`shared-more-wrap${isOpen ? " is-open" : ""}`}>
    <button ref={triggerRef} type="button" className={`shared-more-trigger${triggerClassName ? ` ${triggerClassName}` : ""}${isOpen ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={isOpen} title={triggerTitle} aria-label={triggerAriaLabel} onClick={(event) => { event.stopPropagation(); toggle(); }}>
      {trigger ?? <>{triggerIcon}{label}</>}
    </button>
    {isOpen && createPortal(
      <div ref={menuRef} className="shared-more-menu" role="menu" style={{ position: "fixed", top: position.top, left: position.left, zIndex: position.zIndex, transform: position.transform || undefined }} onClick={(event) => event.stopPropagation()}>
        {header}
        {items.map((item) => (
          <button key={item.id} type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled} title={item.title} onClick={() => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); item.onSelect?.(); }}>
            {item.icon && <span className="shared-more-icon">{item.icon}</span>}
            <span className="shared-more-label">{item.label}</span>
          </button>
        ))}
      </div>, document.body)}
  </span>;
}
