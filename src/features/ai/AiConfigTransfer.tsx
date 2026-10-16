import { useEffect, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { aiClient, type AiProfile, type AiImportPreview } from "../../platform/clients/ai";

export function AiConfigTransfer({ profiles, onImported }: { profiles: AiProfile[]; onImported: () => Promise<void> }) {
  const [selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<AiImportPreview|null>(null),[importIds,setImportIds]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState("");const alive=useRef(true),token=useRef<string|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(token.current)void aiClient.cancelImport(token.current).catch(()=>{});};},[]);
  function toggle(id:string){setSelected(values=>values.includes(id)?values.filter(v=>v!==id):[...values,id]);}
  async function exportFile(){setBusy(true);setMessage("");try{const saved=await aiClient.exportConfig(selected);if(alive.current)setMessage(saved?"AI配置文件已导出，包含API密钥，请妥善保管。":"已取消导出");}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  async function prepare(){setBusy(true);setMessage("");try{if(token.current)await aiClient.cancelImport(token.current);token.current=null;setPreview(null);const next=await aiClient.prepareImport();if(!next)return;if(!alive.current){void aiClient.cancelImport(next.token).catch(()=>{});return;}token.current=next.token;setPreview(next);setImportIds(next.profiles.map(p=>p.id));}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  async function cancel(){if(token.current)await aiClient.cancelImport(token.current);token.current=null;setPreview(null);setImportIds([]);}
  async function confirm(){if(!preview)return;setBusy(true);setMessage("");try{const count=await aiClient.confirmImport(preview.token,importIds);token.current=null;if(alive.current){setPreview(null);setMessage(`已新增 ${count} 个AI配置，已恢复文件中的密钥、模型、启用和默认状态；旧版无密钥配置保持停用。`);await onImported();}}catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);}}
  return <details className="ai-transfer"><summary>AI配置文件迁移</summary><p>导出的文件包含明文 API 密钥，请妥善保管，勿分享或上传。导入后恢复密钥、模型、启用状态和默认配置，同名配置自动改名；已有配置保留，导入的默认配置会替换当前默认选择。旧版无密钥文件仍以停用状态导入。</p>
    <div className="ai-actions"><button type="button" disabled={busy} onClick={() => setSelected(profiles.map(profile => profile.id))}>全选</button><button type="button" disabled={busy} onClick={() => setSelected([])}>取消全选</button></div><div className="ai-checks">{profiles.map(profile=><label key={profile.id}><input type="checkbox" checked={selected.includes(profile.id)} disabled={busy} onChange={()=>toggle(profile.id)}/>{profile.name}</label>)}</div>
    <div className="ai-actions"><button type="button" disabled={busy||!selected.length} onClick={()=>void exportFile()}><Download size={15}/>导出配置文件</button><button className="ai-file-button" type="button" disabled={busy} onClick={() => void prepare()}><Upload size={15}/>选择配置文件</button></div>
    {message&&<p className="ai-feedback" role="status">{message}</p>}
    {preview&&<section aria-label="AI配置迁移预览"><h3>确认要新增的配置</h3>{preview.profiles.map(profile=><label key={profile.id} className="ai-transfer-row"><input type="checkbox" checked={importIds.includes(profile.id)} disabled={busy} onChange={()=>setImportIds(ids=>ids.includes(profile.id)?ids.filter(id=>id!==profile.id):[...ids,profile.id])}/><span><strong>{profile.name}</strong><small>{profile.baseUrl} · {profile.model} · {profile.hasKey?"包含密钥":"不包含密钥"} · {profile.enabled?"已启用":"已停用"}{profile.isDefault?" · 默认配置":""}</small></span></label>)}<div className="ai-actions"><button type="button" disabled={busy} onClick={()=>void cancel().catch(e=>setMessage(String(e)))}>取消迁移</button><button type="button" className="ai-primary" disabled={busy||!importIds.length} onClick={()=>void confirm()}>确认新增配置</button></div></section>}
  </details>;
}
