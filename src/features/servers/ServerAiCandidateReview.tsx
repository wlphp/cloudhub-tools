import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Server, X } from "lucide-react";
import type { AiFields } from "../../platform/clients/ai";
import type { ManagedHost } from "../../shared/types";
import { reviewServerAiCandidates, type ServerAiCandidate } from "./serverAiCandidates";
import "../ai/ai.css";

type Props = { items: AiFields[]; existing: ManagedHost[]; onFill: (fields: AiFields) => void; onClose: () => void };
const shownFields = [["name", "名称"], ["host", "主机"], ["port", "端口"], ["platform", "系统"], ["username", "用户名"], ["group_name", "分组"], ["tags", "标签"], ["remark", "备注"]] as const;

export function ServerAiCandidateReview({ items, existing, onFill, onClose }: Props) {
  const candidates = reviewServerAiCandidates(items, existing);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab" && dialog.current) {
        const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [onClose]);
  function fill(candidate: ServerAiCandidate) {
    if (candidate.errors.length || candidate.duplicateOf) return;
    onFill(candidate.fields);
    onClose();
  }
  const readyCount = candidates.filter(candidate => !candidate.errors.length && !candidate.duplicateOf).length;
  return createPortal(<div className="ai-backdrop server-ai-review-backdrop"><section ref={dialog} className="ai-asset-note-dialog ide-theme server-ai-review" role="dialog" aria-modal="true" aria-labelledby="server-ai-review-title">
    <header><div><span className="eyebrow">SERVER CANDIDATES</span><h2 id="server-ai-review-title"><Server size={18} />审核服务器候选</h2></div><DialogHeaderActions><button type="button" aria-label="关闭候选审核" onClick={onClose}><X size={18} /></button></DialogHeaderActions></header>
    <p>逐条检查识别结果。填入只会更新服务器表单；登录密码、私钥和保存操作仍由你完成。</p>
    <div className="server-ai-review-list">{candidates.map((candidate, index) => {
      const blocked = candidate.errors.length > 0 || !!candidate.duplicateOf;
      return <article className={`server-ai-review-card${blocked ? " is-blocked" : ""}`} key={index}>
        <div className="server-ai-review-card-head"><strong>{index + 1}. {String(candidate.fields.name || "未命名服务器")}</strong>{blocked ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}</div>
        <dl>{shownFields.map(([key, label]) => candidate.fields[key] == null || candidate.fields[key] === "" ? null : <div key={key}><dt>{label}</dt><dd>{String(candidate.fields[key])}</dd></div>)}</dl>
        {candidate.duplicateOf && <p className="server-ai-candidate-warning" role="status">{candidate.duplicateOf}，不能重复填入</p>}
        {!!candidate.errors.length && <ul className="server-ai-candidate-errors">{candidate.errors.map(error => <li key={error}>{error}</li>)}</ul>}
        <button type="button" className="ai-primary" disabled={blocked} onClick={() => fill(candidate)}>填入此服务器表单</button>
      </article>;
    })}</div>
    <footer><span role="status">{readyCount} / {candidates.length} 条可填入</span><button type="button" onClick={onClose}>关闭</button></footer>
  </section></div>, document.body);
}
