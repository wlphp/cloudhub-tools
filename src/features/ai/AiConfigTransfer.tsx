import { useEffect, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { aiClient, type AiProfile, type AiImportPreview } from "../../platform/clients/ai";

export function AiConfigTransfer({ profiles, onImported }: { profiles: AiProfile[]; onImported: () => Promise<void> }) {
  const [selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<AiImportPreview|null>(null),[importIds,setImportIds]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");const alive=useRef(true),token=useRef<string|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(token.current)void aiClient.cancelImport(token.current).catch(()=>{});};},[]);
  function toggle(id:string){setSelected(values=>values.includes(id)?values.filter(v=>v!==id):[...values,id]);}
  async function exportFile(){setBusy(true);setMessage("");try{const saved=await aiClient.exportConfig(selected);if(alive.current)setMessage(saved?"AI配置文件已导出，不包含API密钥。导入后需重新填写密钥。":"已取消导出");}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  async function prepare(file:File){setBusy(true);setMessage("");try{if(file.size>600000)throw new Error("AI配置文件超过大小限制");if(token.current)await aiClient.cancelImport(token.current);token.current=null;setPreview(null);const next=await aiClient.prepareImport(await file.text());if(!alive.current){void aiClient.cancelImport(next.token).catch(()=>{});return;}token.current=next.token;setPreview(next);setImportIds(next.profiles.map(p=>p.id));}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  async function cancel(){if(token.current)await aiClient.cancelImport(token.current);token.current=null;setPreview(null);setImportIds([]);}
  async function confirm(){if(!preview)return;setBusy(true);setMessage("");try{const count=await aiClient.confirmImport(preview.token,importIds);token.current=null;if(alive.current){setPreview(null);setMessage(`已新增 ${count} 个AI配置，均为停用状态。请核对地址和密钥后编辑启用。`);await onImported();}}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  return <details className="ai-transfer"><summary>AI配置文件迁移</summary><p>导出的文件不包含 API 密钥，地址和模型名称未加密；导入会新增停用配置，同名配置自动改名，保留已有配置。请安全保存文件，并在导入后重新填写密钥。</p>
    <div className="ai-checks">{profiles.map(profile=><label key={profile.id}><input type="checkbox" checked={selected.includes(profile.id)} disabled={busy} onChange={()=>toggle(profile.id)}/>{profile.name}</label>)}</div>
    <div className="ai-actions"><button type="button" disabled={busy||!selected.length} onClick={()=>void exportFile()}><Download size={15}/>导出配置文件</button><label className="ai-file-button"><Upload size={15}/>选择配置文件<input type="file" accept=".json,application/json" aria-label="选择AI配置文件" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.currentTarget.value="";if(file)void prepare(file);}}/></label></div>
    {message&&<p className="ai-feedback" role="status">{message}</p>}
    {preview&&<section aria-label="AI配置迁移预览"><h3>确认要新增的配置</h3>{preview.profiles.map(profile=><label key={profile.id} className="ai-transfer-row"><input type="checkbox" checked={importIds.includes(profile.id)} disabled={busy} onChange={()=>setImportIds(ids=>ids.includes(profile.id)?ids.filter(id=>id!==profile.id):[...ids,profile.id])}/><span><strong>{profile.name}</strong><small>{profile.baseUrl} · {profile.model} · {profile.hasKey?"包含密钥":"不包含密钥"}</small></span></label>)}<div className="ai-actions"><button type="button" disabled={busy} onClick={()=>void cancel().catch(e=>setMessage(String(e)))}>取消迁移</button><button type="button" className="ai-primary" disabled={busy||!importIds.length} onClick={()=>void confirm()}>确认新增配置</button></div></section>}
  </details>;
}
