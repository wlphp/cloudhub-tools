import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "./pagination-bar.css";

export const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
export const DEFAULT_PAGE_SIZE = 10;

export function normalizePageSize(value: number, fallback: number = DEFAULT_PAGE_SIZE): number {
  return PAGE_SIZE_OPTIONS.includes(value) ? value : fallback;
}

type PaginationBarProps = {
  page: number;
  pageSize: number;
  /** Optional effective count for layouts that must paginate complete grid rows. */
  paginationPageSize?: number;
  /** 已知总条数；未知（服务端分页无总数）时隐藏总数与跳页。 */
  total?: number;
  /** total 未知时的下一页依据；false 时禁用下一页。 */
  hasNext?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  disabled?: boolean;
  className?: string;
};

export function PaginationBar({ page, pageSize, paginationPageSize = pageSize, total, hasNext, onPageChange, onPageSizeChange, pageSizeOptions = PAGE_SIZE_OPTIONS, disabled = false, className }: PaginationBarProps) {
  const [jumpDraft, setJumpDraft] = useState(String(page));
  useEffect(() => { setJumpDraft(String(page)); }, [page]);
  const pageCount = total === undefined ? null : Math.max(1, Math.ceil(total / paginationPageSize));
  const prevDisabled = disabled || page <= 1;
  const nextDisabled = disabled || (pageCount !== null ? page >= pageCount : hasNext === false);
  const pageNumbers = pageCount === null ? [] : pageCount <= 5
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : page <= 2
      ? [1, 2, 3, "ellipsis-end" as const, pageCount]
      : page >= pageCount - 1
        ? [1, "ellipsis-start" as const, pageCount - 2, pageCount - 1, pageCount]
        : [1, "ellipsis-start" as const, page - 1, page, page + 1, "ellipsis-end" as const, pageCount];
  function applyJump() {
    if (pageCount === null) return;
    const target = Number.parseInt(jumpDraft, 10);
    if (Number.isNaN(target)) { setJumpDraft(String(page)); return; }
    const clamped = Math.min(Math.max(target, 1), pageCount);
    if (clamped === page) setJumpDraft(String(page));
    else onPageChange(clamped);
  }
  return (
    <div className={`pagination-bar${className ? ` ${className}` : ""}`}>
      <button type="button" className="pagination-nav" aria-label="上一页" disabled={prevDisabled} onClick={() => onPageChange(page - 1)}><ChevronLeft size={15} /></button>
      {pageCount !== null ? <nav className="pagination-pages" aria-label="分页">{pageNumbers.map((item) => typeof item === "number"
        ? <button key={item} type="button" className={`pagination-page-number${item === page ? " is-current" : ""}`} aria-current={item === page ? "page" : undefined} aria-label={`第 ${item} 页`} disabled={disabled || item === page} onClick={() => onPageChange(item)}>{item}</button>
        : <span key={item} className="pagination-ellipsis" aria-hidden="true">…</span>)}</nav> : <span className="pagination-page-number is-current" aria-current="page">{page}</span>}
      <button type="button" className="pagination-nav" aria-label="下一页" disabled={nextDisabled} onClick={() => onPageChange(page + 1)}><ChevronRight size={15} /></button>
      {pageCount !== null && (
        <span className="pagination-jump">
          <span>到第</span>
          <input
            className="pagination-jump-input"
            aria-label="跳转页码"
            inputMode="numeric"
            value={jumpDraft}
            disabled={disabled}
            onChange={(event) => setJumpDraft(event.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(event) => { if (event.key === "Enter") applyJump(); }}
          />
          <span>页</span>
          <button type="button" className="pagination-jump-confirm" disabled={disabled} onClick={applyJump}>确定</button>
        </span>
      )}
      {total !== undefined && <span className="pagination-total">共 {total} 条</span>}
      {onPageSizeChange && (
        <select className="pagination-size" aria-label="每页条数" value={pageSize} disabled={disabled} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
          {pageSizeOptions.map((value) => <option key={value} value={value}>{value} 条/页{value === pageSize && paginationPageSize !== pageSize ? `（整行显示 ${paginationPageSize} 条）` : ""}</option>)}
        </select>
      )}
    </div>
  );
}
