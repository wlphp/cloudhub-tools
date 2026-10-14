import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function AiModelInput({ label, value, models, disabled, onChange }: { label: string; value: string; models: string[]; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{left:number;top:number;width:number;height:number} | null>(null);
  const options = models.filter(model => model.toLowerCase().includes(search.toLowerCase()));
  function close() { setOpen(false); input.current?.focus({preventScroll:true}); }
  useLayoutEffect(() => {
    if (!open || disabled || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < 200 && above > below;
    const height = Math.min(280, upward ? above : below);
    setPosition({left:rect.left,top:upward ? rect.top - height - 4 : rect.bottom + 4,width:rect.width,height});

    const body = anchor.current.closest(".ai-config-dialog-body");
    const dismiss = () => setOpen(false);
    body?.addEventListener("scroll", dismiss);
    window.addEventListener("resize", dismiss);
    return () => { body?.removeEventListener("scroll", dismiss); window.removeEventListener("resize", dismiss); };
  }, [open, disabled]);
  useLayoutEffect(() => { if (open && position) searchInput.current?.focus({preventScroll:true}); }, [open, position]);
  return <div className="ai-model-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <label htmlFor={id}>{label}</label>
    <div ref={anchor} className="ai-model-input"><input ref={input} id={id} required maxLength={160} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder="填写或选择模型 ID" /><button type="button" disabled={disabled || !models.length} aria-label={`选择${label}`} aria-expanded={open} aria-controls={`${id}-options`} onClick={() => { setSearch(""); setPosition(null); setOpen(!open); }}><ChevronDown size={16} /></button></div>
    {open && !disabled && <div id={`${id}-options`} className="ai-model-options" style={position || {visibility:"hidden"}}><input ref={searchInput} aria-label={`搜索${label}`} value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索模型…" /><div>{options.map(model => <button type="button" key={model} title={model} onClick={() => { onChange(model); close(); }}>{model}</button>)}{!options.length && <small>没有匹配模型，可直接填写 ID</small>}</div></div>}
  </div>;
}
