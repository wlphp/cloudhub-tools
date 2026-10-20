import { useState } from "react";

export function RefreshFailure({ label, reason }: { label: string; reason: string }) {
  const [expanded, setExpanded] = useState(false);
  const characters = Array.from(reason);
  const lengthy = characters.length > 120 || reason.split("\n").length > 3;
  const preview = reason.replace(/\s+/g, " ");
  return <div className="codex-refresh-failure">
    <p className="codex-card-error" role="status"><strong>{label}：</strong>{lengthy && !expanded ? Array.from(preview).slice(0, 120).join("") + "…" : reason}</p>
    {lengthy && <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${label}原因`} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开完整原因"}</button>}
  </div>;
}
