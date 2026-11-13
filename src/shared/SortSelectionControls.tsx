import { useState } from "react";
import "./sort-selection-controls.css";

export function useItemSelection<Key extends string | number>() {
  const [selected, setSelected] = useState<Set<Key>>(() => new Set());
  const toggle = (key: Key) => setSelected(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAll = (keys: readonly Key[]) => setSelected(current => {
    const next = new Set(current);
    const all = keys.length > 0 && keys.every(key => next.has(key));
    keys.forEach(key => { if (all) next.delete(key); else next.add(key); });
    return next;
  });
  return { selected, toggle, toggleAll };
}

export function SelectionCheckbox({ label, checked, mixed = false, disabled = false, onChange }: { label: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange: () => void }) {
  return <input className="sortable-item-checkbox" type="checkbox" aria-label={label} checked={checked} disabled={disabled} ref={element => { if (element) element.indeterminate = mixed; }} onChange={onChange} />;
}

export function SortSelectionControls<Key extends string | number>({ label, keys, selected, sorting, onToggleAll, onSortingChange, scope = "当前页", showSelectAll = true, disabled = false }: {
  label: string; keys: readonly Key[]; selected: ReadonlySet<Key>; sorting: boolean;
  onToggleAll: () => void; onSortingChange: (sorting: boolean) => void;
  scope?: string; showSelectAll?: boolean; disabled?: boolean;
}) {
  const count = keys.filter(key => selected.has(key)).length;
  return <div className="sort-selection-controls">
    {!sorting && showSelectAll && <label className="sort-select-all"><SelectionCheckbox label={`全选${scope}${label}`} checked={keys.length > 0 && count === keys.length} mixed={count > 0 && count < keys.length} disabled={disabled || keys.length === 0} onChange={onToggleAll} /><span>全选{scope}</span></label>}
    {!sorting && selected.size > 0 && <span className="sort-selection-count">已选 {selected.size} 项</span>}
    <button type="button" className={`secondary sort-mode-button${sorting ? " is-sorting" : ""}`} aria-label={sorting ? `退出${label}排序` : `${label}排序`} aria-pressed={sorting} disabled={disabled || (!sorting && keys.length < 2)} onClick={() => onSortingChange(!sorting)}>{sorting ? "退出排序" : "排序"}</button>
  </div>;
}
