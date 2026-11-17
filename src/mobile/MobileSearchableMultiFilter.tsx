import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Filter, Search } from "lucide-react";

export type MobileMultiFilterOption = {
  id: string;
  label: string;
  detail?: string;
  count: number;
  icon?: ReactNode;
};

type Props = {
  id: string;
  label: string;
  options: MobileMultiFilterOption[];
  selectedIds: string[] | null;
  onChange: (selectedIds: string[] | null) => void;
  searchPlaceholder?: string;
};

export function MobileSearchableMultiFilter({ id, label, options, selectedIds, onChange, searchPlaceholder }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? options.filter(option => `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase().includes(normalized)) : options;
  }, [options, query]);
  const selectedSet = selectedIds === null ? new Set(options.map(option => option.id)) : new Set(selectedIds);
  const selectedCount = selectedIds === null ? options.length : selectedIds.length;
  const allVisibleSelected = visibleOptions.length > 0 && visibleOptions.every(option => selectedSet.has(option.id));
  const someVisibleSelected = visibleOptions.some(option => selectedSet.has(option.id));
  const summary = selectedIds === null ? `全部${label}（${options.length}）` : selectedCount ? `已选 ${selectedCount} 个${label}` : `未选${label}`;

  const commit = (next: string[]) => onChange(next.length === options.length ? null : next);
  const toggleOption = (optionId: string) => {
    const next = new Set(selectedSet);
    next.has(optionId) ? next.delete(optionId) : next.add(optionId);
    commit([...next]);
  };
  const toggleVisible = () => {
    const next = new Set(selectedSet);
    for (const option of visibleOptions) allVisibleSelected ? next.delete(option.id) : next.add(option.id);
    commit([...next]);
  };

  return <div className={`mobile-searchable-filter${open ? " is-open" : ""}`}>
    <button type="button" className="mobile-searchable-filter-toggle" aria-label={`${summary}，${open ? "收起" : "展开"}${label}筛选`} aria-expanded={open} aria-controls={`${id}-options`} onClick={() => setOpen(value => !value)}>
      <Filter size={16} aria-hidden="true" /><span>{summary}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="mobile-searchable-filter-popover" id={`${id}-options`}>
      <label className="mobile-searchable-filter-search"><Search size={15} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder={searchPlaceholder ?? `搜索${label}`} aria-label={`搜索${label}`} /></label>
      <label className="mobile-searchable-filter-all"><input type="checkbox" checked={allVisibleSelected} ref={input => { if (input) input.indeterminate = someVisibleSelected && !allVisibleSelected; }} onChange={toggleVisible} /><span>{query.trim() ? `全选搜索结果（${visibleOptions.length}）` : `全选${label}`}</span><small>{visibleOptions.length}</small></label>
      <div className="mobile-searchable-filter-options" role="group" aria-label={`${label}选项`}>
        {visibleOptions.map(option => <label className="mobile-searchable-filter-option" key={option.id}>
          <input type="checkbox" checked={selectedSet.has(option.id)} onChange={() => toggleOption(option.id)} />
          {option.icon && <span className="mobile-searchable-filter-icon" aria-hidden="true">{option.icon}</span>}
          <span className="mobile-searchable-filter-copy"><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
          <span className="mobile-searchable-filter-count">{option.count}</span>
        </label>)}
        {!visibleOptions.length && <p className="mobile-searchable-filter-empty">没有匹配的{label}</p>}
      </div>
      <div className="mobile-searchable-filter-footer"><span>显示 {visibleOptions.length} / {options.length} 个{label}</span><button type="button" disabled={selectedIds === null} onClick={() => { onChange(null); setQuery(""); }}>清除筛选</button></div>
    </div>}
  </div>;
}
