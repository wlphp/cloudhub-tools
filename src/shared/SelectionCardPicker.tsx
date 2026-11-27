import type { ReactNode } from "react";
import { Check, Search } from "lucide-react";
import { PaginationBar } from "./PaginationBar";
import { SelectionCheckbox } from "./SortSelectionControls";
import "./selection-card-picker.css";

/** 单张可选卡片的内容槽位：首行标题 + 徽标，次行说明 + 右侧摘要，可选页脚（如错误）。 */
export type SelectionCardContent = {
  title: ReactNode;
  /** 标题悬浮提示；隐私模式下传 undefined。 */
  titleHint?: string;
  badge?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
};

export type SelectionCardPickerProps<T, Key extends string | number> = {
  heading: string;
  /** 当前页条目（已筛选、排序、分页）。 */
  items: readonly T[];
  /** 筛选后的总数（跨页）。 */
  filteredCount: number;
  /** 未筛选时的可选总数。 */
  totalCount: number;
  /** 已选数量（可包含不在当前筛选中的条目）。 */
  selectedCount: number;
  getKey: (item: T) => Key;
  selected: ReadonlySet<Key>;
  onToggle: (key: Key) => void;
  /** 筛选结果（跨页）是否已全选 / 部分选中。 */
  allSelected: boolean;
  partiallySelected: boolean;
  onToggleAll: () => void;
  renderCard: (item: T, selected: boolean) => SelectionCardContent;
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder?: string;
  /** 搜索框下方的筛选/排序控件（MultiSelectFilter、排序下拉、方向按钮等）。 */
  toolbar?: ReactNode;
  filtering: boolean;
  onClearFilters?: () => void;
  onClearSelection?: () => void;
  /** 计数单位，例如“个账号”。 */
  unit?: string;
  emptyText: string;
  noMatchText?: string;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  disabled?: boolean;
  className?: string;
};

/**
 * 公共“卡片网格多选”选择器：搜索 → 筛选行 → 计数与全选 → 双列卡片 → 分页。
 * 选中态同时用勾选标记和强调边框表达，不只依赖颜色；真实复选框保留在卡片内供键盘与读屏使用。
 */
export function SelectionCardPicker<T, Key extends string | number>({
  heading, items, filteredCount, totalCount, selectedCount, getKey, selected, onToggle,
  allSelected, partiallySelected, onToggleAll, renderCard, search, onSearchChange, searchLabel,
  searchPlaceholder = "搜索…", toolbar, filtering, onClearFilters, onClearSelection, unit = "项",
  emptyText, noMatchText = "没有匹配的结果", page, pageSize, onPageChange, onPageSizeChange,
  pageSizeOptions, disabled = false, className,
}: SelectionCardPickerProps<T, Key>) {
  return <section className={`selection-picker${className ? ` ${className}` : ""}`} aria-label={heading}>
    <strong className="selection-picker-heading">{heading}</strong>
    <label className="selection-picker-search">
      <Search size={15} aria-hidden="true" />
      <input aria-label={searchLabel} placeholder={searchPlaceholder} value={search} onChange={event => onSearchChange(event.target.value)} />
    </label>
    {toolbar && <div className="selection-picker-toolbar">{toolbar}</div>}
    <div className="selection-picker-summary">
      <span role="status">{filtering ? `当前筛选 ${filteredCount} ${unit}` : `共 ${totalCount} ${unit}`}{selectedCount > 0 && ` · 已选 ${selectedCount}`}</span>
      <span className="selection-picker-actions">
        {filtering && onClearFilters && <button type="button" disabled={disabled} onClick={onClearFilters}>清除筛选</button>}
        {selectedCount > 0 && onClearSelection && <button type="button" disabled={disabled} onClick={onClearSelection}>清空选择</button>}
        <label className={`selection-picker-select-all${disabled || !filteredCount ? " is-disabled" : ""}`}>
          <SelectionCheckbox label={filtering ? `全选当前筛选${unit}` : `全选${unit}`} checked={allSelected} mixed={partiallySelected} disabled={disabled || !filteredCount} onChange={onToggleAll} />
          <span>{allSelected ? "取消全选" : "全选"} ({filteredCount})</span>
        </label>
      </span>
    </div>
    {totalCount === 0 ? <p className="selection-picker-empty">{emptyText}</p>
      : filteredCount === 0 ? <p className="selection-picker-empty">{noMatchText}</p>
      : <div className="selection-picker-grid">
        {items.map(item => {
          const key = getKey(item);
          const checked = selected.has(key);
          const card = renderCard(item, checked);
          return <label key={key} className={`selection-card${checked ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}>
            <input type="checkbox" className="selection-card-input" checked={checked} disabled={disabled} onChange={() => onToggle(key)} />
            <span className="selection-card-head">
              <span className="selection-card-mark" aria-hidden="true">{checked && <Check size={11} strokeWidth={3} />}</span>
              <strong className="selection-card-title" title={card.titleHint}>{card.title}</strong>
              {card.badge}
            </span>
            {(card.meta || card.aside) && <span className="selection-card-body">
              <small className="selection-card-meta">{card.meta}</small>
              {card.aside && <span className="selection-card-aside">{card.aside}</span>}
            </span>}
            {card.footer && <span className="selection-card-footer">{card.footer}</span>}
          </label>;
        })}
      </div>}
    {filteredCount > 0 && <PaginationBar className="selection-picker-pagination" page={page} pageSize={pageSize} total={filteredCount} disabled={disabled} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} pageSizeOptions={pageSizeOptions} />}
  </section>;
}
