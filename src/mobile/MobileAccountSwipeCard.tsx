import { Children, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export function MobileAccountSwipeCard({ label, children, details, sortId, sorting = false }: { label: string; children: ReactNode; details?: ReactNode; sortId?: string; sorting?: boolean }) {
  const [content, ...actions] = Children.toArray(children);
  const [expanded, setExpanded] = useState(false);

  return <article
    data-account-card={sortId === undefined ? undefined : ""}
    data-account-sort-id={sortId}
    className={`mobile-account-card mobile-account-swipe-card${sorting ? " is-sorting" : ""}`}
    onKeyDown={(event) => {
      if (event.key === "Escape") setExpanded(false);
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false);
    }}
    onClick={(event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".mobile-account-menu")) {
        setExpanded(false);
      }
    }}
  >
    <div className="mobile-account-swipe-main">
      {content}
      {!sorting && <div className="mobile-account-menu-anchor">
      <button
        type="button"
        className="mobile-account-menu"
        aria-label={`${expanded ? "收起" : "展开"} ${label} 操作`}
        aria-expanded={expanded}
        title="更多操作"
        onClick={() => setExpanded((open) => !open)}
      >
        <MoreHorizontal size={19} />
      </button>
      {expanded && actions}
      </div>}
    </div>
    {details}
  </article>;
}
