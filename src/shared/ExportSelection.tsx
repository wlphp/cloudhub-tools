import { useEffect, useRef, useState } from "react";
import { SharedDialog } from "./SharedDialog";
import "./export-selection.css";

export type ExportItem = { id: string; label: string; detail?: string };

export function ExportChecklist({ items, selected, onChange, disabled = false, search = true }: { items: ExportItem[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; search?: boolean }) {
  const [query, setQuery] = useState("");
  const valid = selected.filter(id => items.some(item => item.id === id));
  const visible = items.filter(item => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="export-selection" aria-label="选择导出内容">
    <div className="export-selection-tools"><button type="button" disabled={disabled} onClick={() => onChange(items.map(item => item.id))}>全选</button><button type="button" disabled={disabled} onClick={() => onChange([])}>取消全选</button><span aria-live="polite">已选 {valid.length} / {items.length}</span></div>
    {search && <input aria-label="搜索导出内容" placeholder="搜索名称" value={query} onChange={event => setQuery(event.target.value)} />}
    <div className="export-selection-list">{visible.map(item => <label key={item.id}><input type="checkbox" disabled={disabled} checked={valid.includes(item.id)} onChange={event => onChange(event.target.checked ? [...valid, item.id] : valid.filter(id => id !== item.id))} /><span>{item.label}{item.detail && <small>{item.detail}</small>}</span></label>)}{!visible.length && <p>没有可选内容</p>}</div>
  </section>;
}

function SelectionDialog({ title, items, finish }: { title: string; items: ExportItem[]; finish: (ids: string[] | null) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <SharedDialog title={title} size="small" className="export-selection-dialog export-selection-picker-dialog" closeLabel="关闭导出选择" onClose={() => finish(null)} footer={<><button type="button" className="secondary" onClick={() => finish(null)}>取消</button><button type="button" className="primary" disabled={!selected.length} onClick={() => finish(selected)}>导出所选（{selected.length}）</button></>}><ExportChecklist items={items} selected={selected} onChange={setSelected} /></SharedDialog>;
}

export function useExportSelection() {
  const [request, setRequest] = useState<{ title: string; items: ExportItem[] } | null>(null);
  const resolver = useRef<((ids: string[] | null) => void) | null>(null);
  useEffect(() => () => { resolver.current?.(null); }, []);
  function choose(title: string, items: ExportItem[]): Promise<string[] | null> {
    resolver.current?.(null);
    return new Promise(resolve => { resolver.current = resolve; setRequest({ title, items }); });
  }
  function finish(ids: string[] | null) { resolver.current?.(ids); resolver.current = null; setRequest(null); }
  return { choose, dialog: request ? <SelectionDialog key={request.title} {...request} finish={finish} /> : null };
}
