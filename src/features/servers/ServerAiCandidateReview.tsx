import { SharedDialog } from "../../shared/SharedDialog";
import { AlertTriangle, CheckCircle2, Server } from "lucide-react";
import type { AiFields } from "../../platform/clients/ai";
import type { ManagedHost } from "../../shared/types";
import { reviewServerAiCandidates, type ServerAiCandidate } from "./serverAiCandidates";
import "../ai/ai.css";

type Props = { items: AiFields[]; existing: ManagedHost[]; onFill: (fields: AiFields) => void; onClose: () => void };
const shownFields = [["name", "名称"], ["host", "主机"], ["port", "端口"], ["platform", "系统"], ["username", "用户名"], ["group_name", "分组"], ["tags", "标签"], ["remark", "备注"]] as const;

export function ServerAiCandidateReview({ items, existing, onFill, onClose }: Props) {
  const candidates = reviewServerAiCandidates(items, existing);
  function fill(candidate: ServerAiCandidate) {
    if (candidate.errors.length || candidate.duplicateOf) return;
    onFill(candidate.fields);
    onClose();
  }
  const readyCount = candidates.filter(candidate => !candidate.errors.length && !candidate.duplicateOf).length;
  return <SharedDialog title="审核服务器候选" eyebrow="SERVER CANDIDATES" icon={<Server size={18} />} className="ai-asset-note-dialog server-ai-review" closeLabel="关闭候选审核" onClose={onClose} footer={<><span role="status">{readyCount} / {candidates.length} 条可填入</span><button type="button" onClick={onClose}>关闭</button></>}>
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
  </SharedDialog>;
}
