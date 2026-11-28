import { useState, type ReactNode } from "react";
import { ArrowUpDown, ChevronDown, Filter, Search, type LucideIcon } from "lucide-react";

type Props = {
  title: string;
  description: string;
  icon: LucideIcon;
  count: number;
  countLabel: string;
  secondaryCount: number;
  secondaryLabel: string;
  search: string;
  onSearch: (value: string) => void;
  ascending: boolean;
  onSort: () => void;
  /** 覆盖摘要行末尾的排序说明（如“自定义排序 / 拖拽排序中”）。 */
  sortSummary?: string;
  /** 拖拽排序期间禁用名称排序按钮。 */
  sortDisabled?: boolean;
  /** 名称排序按钮之后追加的自定义/拖拽排序控件。 */
  sortExtras?: ReactNode;
  filter?: ReactNode;
  filterSummary?: string;
  filterLayout?: "stacked";
  filterFullWidth?: boolean;
  actions?: ReactNode;
  inlineActions?: boolean;
  showListHeading?: boolean;
};

export function MobileResourceOverview({ title, count, countLabel, secondaryCount, secondaryLabel, search, onSearch, ascending, onSort, sortSummary, sortDisabled, sortExtras, filter, filterSummary, filterLayout, filterFullWidth, actions, inlineActions, showListHeading = true }: Props) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const showInlineActions = Boolean(actions) || inlineActions || title === "操作日志" || title === "API 日志";
  const toolsId = `mobile-resource-tools-${title.replace(/[^\p{L}\p{N}]+/gu, "-")}`;
  return <>
    <div className="mobile-page-title"><h1>{title}</h1>{showInlineActions && actions && <div className="mobile-resource-page-actions mobile-resource-inline-actions">{actions}</div>}</div>
    <div className="mobile-resource-summary mobile-resource-summary-fixed" aria-label={`${title}概览`}><span>{title}概览 · {count} {countLabel} · {secondaryCount} {secondaryLabel}</span></div>
    <button type="button" className="mobile-list-filter-toggle" aria-expanded={toolsOpen} aria-controls={toolsId} onClick={() => setToolsOpen(open => !open)}><Filter size={15} aria-hidden="true" /><span>筛选与排序 · {search.trim() ? search.trim() : "全部"}{filter ? ` · ${filterSummary ?? "筛选项"}` : ""} · {sortSummary ?? `名称${ascending ? "升序" : "倒序"}`}</span><ChevronDown size={15} aria-hidden="true" /></button>
    {toolsOpen && <div id={toolsId} className={`mobile-resource-tools${filter ? " has-filter" : ""}${filterLayout === "stacked" ? " has-stacked-filter" : ""}${filterFullWidth ? " has-full-width-filter" : ""}`}>
      <label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label={`搜索${title}`} placeholder={`搜索${title}名称 / 账号 / 状态…`} value={search} onChange={(event) => onSearch(event.currentTarget.value)} /></label>
      {filter && <div className="mobile-account-provider-filter">{filter}</div>}
      <div className="mobile-sort-chip-row" role="group" aria-label={`${title}排序方式`}>
        <button className="mobile-account-sort" type="button" aria-label={`按名称${ascending ? "升序" : "降序"}排列`} aria-pressed={sortSummary === undefined} disabled={sortDisabled} onClick={onSort}><ArrowUpDown size={16} aria-hidden="true" />{ascending ? "按名称" : "名称倒序"}</button>
        {sortExtras}
      </div>
    </div>}
    {showListHeading && <div className="mobile-domain-list-heading"><h2>{title}列表 <span>{count}</span></h2></div>}
    {search && <button className="mobile-resource-clear" type="button" onClick={() => onSearch("")}>清除搜索{count === 0 ? " · 没有匹配结果，请尝试其他关键词" : ""}</button>}
  </>;
}
