import { SharedDialog } from "../../shared/SharedDialog";
import { useRef, useState } from "react";
import { AiAssistButton } from "../ai/AiAssistButton";
import { assetNoteCandidate } from "./aiNoteDraft";

export function AiAssetNotes({ name, type, note, onSave }: { name: string; type: string; note: string; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const opener = useRef<HTMLDivElement>(null);
  function close() { setDraft(null); requestAnimationFrame(() => opener.current?.querySelector("button")?.focus()); }
  return <div className="ai-asset-note-actions" ref={opener}><AiAssistButton task="asset" title="AI 整理备注" text={`资源名称：${name}\n资源类型：${type}\n请粘贴需要整理的购买信息或用途说明。`} current={{ remark: note }} onApply={result => {
    const candidate = assetNoteCandidate(result.fields);
    if (!candidate) throw new Error("请勾选需要整理的字段");
    setDraft([note.trim(), candidate].filter(Boolean).join("\n\n")); setError("");
  }} />{draft !== null && <SharedDialog title="核对资产备注" className="ai-asset-note-dialog" closeLabel="关闭备注核对" onClose={close} footer={<><button type="button" onClick={close}>取消</button><button type="button" className="primary" onClick={()=>{if(draft.length>8192){setError("备注超过8192字，请缩短后保存");return;}onSave(draft.trim());close();}}>保存备注</button></>}><p>原有备注保留在前面。保存后仅更新本地备注，可继续编辑；云资源属性不会改变。</p><label>备注草稿<textarea autoFocus rows={10} maxLength={8192} value={draft} onChange={event=>setDraft(event.target.value)} /></label>{error&&<p role="alert">{error}</p>}</SharedDialog>}</div>;
}
