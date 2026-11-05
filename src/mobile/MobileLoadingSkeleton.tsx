import type { ReactNode } from "react";

type Variant = "list" | "dashboard" | "detail";

/** Content-shaped placeholders used only while a page has no first result yet. */
export function MobileLoadingSkeleton({ variant = "list", rows = 4, label = "正在加载页面内容" }: {
  variant?: Variant;
  rows?: number;
  label?: string;
}) {
  const items: ReactNode[] = Array.from({ length: rows }, (_, index) => <div className="mobile-skeleton-card" key={index}>
    <span className="mobile-skeleton-avatar" />
    <span className="mobile-skeleton-copy"><i /><i /><i /></span>
    <span className="mobile-skeleton-meta"><i /><i /></span>
  </div>);

  return <div className={`mobile-skeleton mobile-skeleton-${variant}`} role="status" aria-label={label} aria-busy="true">
    <span className="mobile-skeleton-sr">{label}</span>
    {variant === "dashboard" ? <>
      <div className="mobile-skeleton-panel"><i className="is-short" /><i className="is-title" /><div className="mobile-skeleton-shortcuts">{Array.from({ length: 4 }, (_, index) => <span key={index}><i /><i /></span>)}</div></div>
      <div className="mobile-skeleton-panel"><div className="mobile-skeleton-pills"><i /><i /><i /></div><div className="mobile-skeleton-shortcuts">{Array.from({ length: 3 }, (_, index) => <span key={index}><i /><i /></span>)}</div></div>
      <div className="mobile-skeleton-panel"><i className="is-short" /><i className="is-title" />{items.slice(0, 2)}</div>
    </> : variant === "detail" ? <div className="mobile-skeleton-panel"><i className="is-title" />{items.slice(0, 3)}</div> : <>
      <div className="mobile-skeleton-summary"><i /><i /></div>
      {items}
    </>}
  </div>;
}
