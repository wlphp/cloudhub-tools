import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  }} />{draft !== null && createPortal(<div className="ai-backdrop"><section className="modal ai-asset-note-dialog modal-form-layout dialog-common-theme ide-theme" role="dialog" aria-modal="true" aria-label="核对资产备注" onKeyDown={event => {
    if(event.key === "Escape") { event.stopPropagation(); close(); }
    if(event.key === "Tab") {
      const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLElement>("textarea,button")); const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey && document.activeElement===first) {event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first.focus();}
    }
  }}><header><h2>核对资产备注</h2><DialogHeaderActions><button type="button" aria-label="关闭备注核对" onClick={close}>关闭</button></DialogHeaderActions></header><p>原有备注保留在前面。保存后仅更新本地备注，可继续编辑；云资源属性不会改变。</p><label>备注草稿<textarea autoFocus rows={10} maxLength={8192} value={draft} onChange={event=>setDraft(event.target.value)} /></label>{error&&<p role="alert">{error}</p>}<div className="ai-actions"><button type="button" onClick={close}>取消</button><button type="button" className="ai-primary" onClick={()=>{if(draft.length>8192){setError("备注超过8192字，请缩短后保存");return;}onSave(draft.trim());close();}}>保存备注</button></div></section></div>,document.body)}</div>;
}
