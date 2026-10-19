import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";
import "./help-tooltip.css";

/** Non-interactive contextual help; usable by mouse, keyboard and touch. */
export function HelpTooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const keep = () => clearTimeout(timer.current);
  const close = () => { keep(); setPosition(null); };
  const show = () => {
    keep();
    const bounds = trigger.current?.getBoundingClientRect();
    if (bounds) setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - 344)), top: bounds.bottom + 6 });
  };
  const deferClose = () => { keep(); timer.current = setTimeout(() => setPosition(null), 150); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopImmediatePropagation(); setPosition(null); } };
    const hide = () => setPosition(null);
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => { document.removeEventListener("keydown", dismiss, true); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide, true); };
  }, [position]);
  return <>
    <button ref={trigger} type="button" className="shared-help-trigger" aria-label={label} aria-describedby={position ? id : undefined}
      onMouseEnter={show} onMouseLeave={deferClose} onFocus={show} onBlur={close} onClick={show}>
      <HelpCircle size={14} aria-hidden="true" />
    </button>
    {position && createPortal(<div id={id} role="tooltip" className="shared-help-tooltip ide-theme" style={position} onMouseEnter={keep} onMouseLeave={deferClose}>{children}</div>, document.body)}
  </>;
}
