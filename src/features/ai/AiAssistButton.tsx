import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Bot, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { aiClient, type AiDraft, type AiFields, type AiPreview, type AiProfile, type AiReply, type AiTask, type AiImage,type AiProgress } from "../../platform/clients/ai";
import { AiImageEditor } from "./AiImageEditor";
import { runningInTauri } from "../../platform/api";
import "./ai.css";

type Props={task:AiTask;title?:string;text?:string|(()=>string);current?:AiFields;onApply?:(draft:AiDraft)=>void|Promise<void>;onApplyItems?:(items:AiFields[])=>void|Promise<void>;disabled?:boolean};
const labels:Record<string,string>={name:"名称",host:"主机 / IP",port:"端口",platform:"操作系统",username:"用户名",group_name:"分组",tags:"标签",remark:"备注",type:"类型",rr:"主机记录",value:"记录值",ttl:"TTL",priority:"优先级",line:"线路",panel_url:"面板地址",url:"网址",expires_at:"到期日期",command:"命令",description:"说明",query:"搜索内容",group:"分组",resource_type:"资源类型",expires_within_days:"到期天数",kind:"协议类型",local_ip:"本地 IP / 域名",local_port:"本地端口",remote_port:"服务端远端端口",custom_domain:"访问域名"};
export function AiAssistButton(props:Props){
  const [open,setOpen]=useState(false),[text,setText]=useState("");const opener=useRef<HTMLButtonElement>(null);
  return <><button ref={opener} type="button" className="ai-assist-button" disabled={props.disabled} onClick={()=>{setText(typeof props.text==="function"?props.text():props.text||"");setOpen(true);}}><Bot size={15} aria-hidden="true" />{props.title||"AI 辅助"}</button>{open&&<Workbench {...props} initialText={text} onClose={()=>{setOpen(false);requestAnimationFrame(()=>{const dialogs=document.querySelectorAll('[role="dialog"][aria-modal="true"]');const active=dialogs[dialogs.length-1];if(!active|| (opener.current&&active.contains(opener.current)))opener.current?.focus();});}}/>}</>;
}
function Workbench({task,title="AI 辅助",current,onApply,onApplyItems,initialText,onClose}:Props&{initialText:string;onClose:()=>void}){
  const [profiles,setProfiles]=useState<AiProfile[]>([]),[profileId,setProfileId]=useState("");
  const [text,setText]=useState(initialText),[preview,setPreview]=useState<AiPreview|null>(null),[reply,setReply]=useState<AiReply|null>(null);
  const [fields,setFields]=useState<AiFields>({}),[selected,setSelected]=useState<Record<string,boolean>>({}),[selectedItems,setSelectedItems]=useState<boolean[]>([]),[item,setItem]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const alive=useRef(true),request=useRef<string|null>(null),panel=useRef<HTMLElement>(null);
  const panelDrag=useRef<{startX:number;startY:number;left:number;top:number}|null>(null);
  const [image,setImage]=useState<AiImage|null>(null),[imageEditor,setImageEditor]=useState(false),[pendingImage,setPendingImage]=useState<File|null>(null),[progress,setProgress]=useState<AiProgress|null>(null);
  const imageInput=useRef<HTMLInputElement>(null),textInput=useRef<HTMLTextAreaElement>(null);
  const [imageDropActive,setImageDropActive]=useState(false);
  const streaming=true;
  const [model, setModel] = useState("");
  const profile=profiles.find(p=>p.id===profileId);
  useEffect(() => { setModel(profile?.model || ""); }, [profileId, profile?.model]);
  const visionReady = profile?.visionStatus === "supported" && model === profile.model;
  function addImage(file:File){
    if(!visionReady){setError("当前模型不支持图片，请切换到已测试图像能力的模型。");return;}
    if(!["image/png","image/jpeg"].includes(file.type)){setError("请选择PNG或JPEG图片。");return;}
    setPendingImage(file);setImageEditor(true);setImage(null);setPreview(null);setReply(null);setError("");
  }
  useEffect(()=>{
    const handle=(event:KeyboardEvent)=>{
      if(!panel.current?.isConnected)return;
      if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();onClose();}
    };
    window.addEventListener("keydown",handle,true);return()=>window.removeEventListener("keydown",handle,true);
  },[onClose]);
  useEffect(()=>{
    const move=(event:globalThis.MouseEvent)=>{const active=panelDrag.current;if(!active||!panel.current)return;const bounds=panel.current.getBoundingClientRect();const left=Math.min(Math.max(8,active.left+event.clientX-active.startX),Math.max(8,window.innerWidth-Math.min(bounds.width,window.innerWidth)-8));const top=Math.min(Math.max(8,active.top+event.clientY-active.startY),Math.max(8,window.innerHeight-Math.min(bounds.height,window.innerHeight)-8));panel.current.style.left=`${left}px`;panel.current.style.top=`${top}px`;};
    const end=()=>{panelDrag.current=null;};
    window.addEventListener("mousemove",move,true);window.addEventListener("mouseup",end,true);
    return()=>{window.removeEventListener("mousemove",move,true);window.removeEventListener("mouseup",end,true);};
  },[]);
  useEffect(()=>{alive.current=true;void aiClient.list().then(list=>{if(alive.current){setProfiles(list);setProfileId(list.find(p=>p.enabled&&p.isDefault)?.id||list.find(p=>p.enabled)?.id||"");}}).catch(e=>{if(alive.current)setError(String(e));});panel.current?.querySelector<HTMLButtonElement>("button")?.focus();return()=>{alive.current=false;if(request.current)void aiClient.cancel(request.current).catch(()=>{});};},[]);
  useEffect(()=>{
    if(!runningInTauri)return;
    let disposed=false;
    const listener=getCurrentWebview().onDragDropEvent(event=>{
      const payload=event.payload;
      if(payload.type==="leave"){setImageDropActive(false);return;}
      const box=textInput.current?.getBoundingClientRect();
      const x=payload.position.x/window.devicePixelRatio,y=payload.position.y/window.devicePixelRatio;
      const inside=!!box&&x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom;
      setImageDropActive(inside&&payload.type!=="drop");
      if(payload.type!=="drop"||!inside)return;
      if(payload.paths.length!==1){setError("请一次拖入一张图片。");return;}
      if(!visionReady){setError("当前模型不支持图片，请切换到已测试图像能力的模型。");return;}
      void aiClient.readImageFile(payload.paths[0]).then(async dataUrl=>{
        if(!/^data:image\/(png|jpeg);base64,/.test(dataUrl))throw new Error("请选择PNG或JPEG图片。");
        const blob=await(await fetch(dataUrl)).blob();
        if(!disposed)addImage(new File([blob],"image",{type:blob.type}));
      }).catch(()=>{if(!disposed)setError("图片读取失败，请选择有效的PNG或JPEG图片。");});
    }).catch(error=>{if(!disposed)setError(String(error));return()=>{};});
    return()=>{disposed=true;void listener.then(unlisten=>unlisten()).catch(()=>{});};
  },[visionReady]);
  function choose(next:AiFields){setFields({...next});setSelected(Object.fromEntries(Object.entries(next).map(([key,value])=>[key,value!==null&&(!current?.[key]||current[key]===value)])));}
  async function run(){if(!profile||(!text.trim()&&!image))return;setBusy(true);setError("");setReply(null);setProgress(null);const id=crypto.randomUUID();request.current=id;try{const safe=await aiClient.preview(text);if(!alive.current||request.current!==id)return;setText(safe.text);setPreview(safe);const next=await aiClient.run({requestId:id,profileId,expectedRevision:profile.updatedAt,task,text:safe.text,streaming,model: model || profile.model,...(image?{image}:{})},update=>{if(alive.current&&request.current===id&&update.requestId===id)setProgress(update);});if(alive.current&&request.current===id){setReply(next);setItem(0);setSelectedItems(next.draft.items.map(()=>true));choose(Object.keys(next.draft.fields).length?next.draft.fields:next.draft.items[0]||{});}}catch(e){if(alive.current&&request.current===id)setError(String(e));}finally{if(request.current===id)request.current=null;if(alive.current)setBusy(false);}}
  async function apply(){if(!reply||(!onApply&&!onApplyItems))return;setBusy(true);setError("");try{if(onApplyItems&&(task==="server"||task==="dns")&&reply.draft.items.length){const chosen=reply.draft.items.filter((_,index)=>selectedItems[index]);if(!chosen.length)throw new Error("请先选择要填入的候选。");await onApplyItems(chosen);}else if(onApply){const picked=Object.fromEntries(Object.entries(fields).filter(([key,value])=>selected[key]&&value!==null));await onApply({...reply.draft,fields:picked,items:[]});}if(alive.current)onClose();}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current)setBusy(false);}}
  function beginPanelDrag(event:ReactMouseEvent<HTMLElement>){if(window.innerWidth<=600||event.button!==0||!(event.target instanceof Element)||event.target.closest("button,a,input,select,textarea,[role='button']"))return;const element=panel.current;if(!element)return;const bounds=element.getBoundingClientRect();panelDrag.current={startX:event.clientX,startY:event.clientY,left:bounds.left,top:bounds.top};element.style.position="fixed";element.style.margin="0";element.style.transform="none";element.style.left=`${bounds.left}px`;element.style.top=`${bounds.top}px`;element.style.right="auto";element.style.bottom="auto";event.preventDefault();}
  return createPortal(<div className="ai-backdrop"><aside ref={panel} className="ai-workbench ai-assist-workbench ide-theme" role="dialog" aria-labelledby="ai-workbench-title">
    <header title="拖动标题栏可移动此面板" onMouseDown={beginPanelDrag}><h2 id="ai-workbench-title"><Bot size={19} aria-hidden="true" />{title}</h2><DialogHeaderActions><button type="button" aria-label="关闭AI辅助" onClick={onClose}><X size={18}/></button></DialogHeaderActions></header>
    <div className="ai-workbench-body">{<>
      <div className={`ai-model-selectors${(profile?.models?.length || 0) > 1 ? " has-two-fields" : ""}`}>
        <label>本次使用的服务<select value={profileId} disabled={busy} onChange={e=>{setProfileId(e.target.value);setReply(null);setPreview(null);setImage(null);setImageEditor(false);}}><option value="">请选择已启用的服务</option>{profiles.filter(p=>p.enabled).map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>
        {(profile?.models?.length || 0) > 1 && <label>本次使用的模型<select disabled={busy} value={model} onChange={e => { setModel(e.target.value); setReply(null); setPreview(null); setImage(null); setImageEditor(false); }}>{profile!.models!.map(id => <option key={id} value={id}>{id}{id === profile!.model ? "（默认）" : ""}</option>)}</select></label>}
      </div>
      {!profileId&&<button type="button" onClick={()=>{onClose();window.dispatchEvent(new Event("cloudhub-ai-settings"));}}>打开系统设置配置 AI</button>}
      <section className={`ai-composer${imageDropActive?" is-image-drop-active":""}`} aria-label="分析内容和图片">
        <label>分析内容<textarea ref={textInput} rows={7} maxLength={32000} disabled={busy} value={text} onPaste={event=>{const file=Array.from(event.clipboardData.items).find(item=>item.kind==="file"&&item.type.startsWith("image/"))?.getAsFile();if(file){event.preventDefault();addImage(file);}}} onDragOver={event=>{if(Array.from(event.dataTransfer.items).some(item=>item.kind==="file")){event.preventDefault();setImageDropActive(true);}}} onDragLeave={()=>setImageDropActive(false)} onDrop={event=>{const files=Array.from(event.dataTransfer.files);if(!files.length)return;event.preventDefault();setImageDropActive(false);if(files.length!==1){setError("请一次拖入一张图片。");return;}addImage(files[0]);}} onChange={e=>{setText(e.target.value);setPreview(null);setReply(null);setError("");}} placeholder="粘贴分析内容，或将图片拖入/粘贴到这里。"/></label>
        <div className="ai-composer-tools"><button type="button" disabled={busy||!visionReady} title="选择PNG或JPEG图片" onClick={()=>imageInput.current?.click()}>添加图片</button><input ref={imageInput} className="ai-image-file-input" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="选择PNG或JPEG图片" onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value="";if(file)addImage(file);}}/></div>
        {image&&<div className="ai-prepared-image" aria-label="待发送截图预览"><img src={image.dataUrl} alt="裁剪遮挡后将发送的截图"/><button type="button" disabled={busy} onClick={()=>{setImage(null);setPreview(null);setReply(null);}}>移除截图</button></div>}
      </section>
      {imageEditor&&<AiImageEditor initialFile={pendingImage||undefined} onCancel={()=>{setImageEditor(false);setPendingImage(null);}} onPrepared={prepared=>{setImage(prepared);setImageEditor(false);setPendingImage(null);setPreview(null);setReply(null);if(!text.trim())setText("请按当前任务识别截图中的信息，仅填写有依据的内容。");}}/>}
      <small>仅发送本次选定的内容，不读取全部终端历史或数据库。结果供核对，不会自动保存或执行。</small>
      <div className="ai-actions"><button type="button" className="ai-primary" disabled={busy||(!text.trim()&&!image)||!profileId||imageEditor||(!!image&&!visionReady)} onClick={()=>void run()}>{busy?"检查并分析中…":"发送并分析"}</button>{busy&&request.current&&<button type="button" onClick={()=>void aiClient.cancel(request.current!).catch(e=>setError(String(e)))}>取消请求</button>}</div>
      {busy&&progress&&<p role="status" aria-live="polite">{({connecting:"正在连接服务",receiving:"正在接收模型响应",validating:"正在校验完整结果",done:"完整结果已校验"})[progress.phase]} · 已接收 {progress.receivedBytes} 字节</p>}
      {preview&&<p role="status">发送前自动检查完成{preview.removedLines?`，已移除 ${preview.removedLines} 行疑似凭据`:""}。本次内容将发送给 {profiles.find(p=>p.id===profileId)?.name||"所选服务"}，可能产生调用费用。</p>}
      {error&&<p className="ai-feedback" role="alert">{error}</p>}
      {reply&&<section aria-label="AI分析结果"><h3>结果草稿</h3><pre>{reply.draft.summary}</pre>{!!reply.draft.warnings.length&&<><h4>需要核对</h4><ul>{reply.draft.warnings.map((v,i)=><li key={i}>{v}</li>)}</ul></>}{!!reply.draft.evidence.length&&<><h4>原文依据</h4><ul>{reply.draft.evidence.map((v,i)=><li key={i}>{v}</li>)}</ul></>}
        {reply.draft.items.length>0&&onApplyItems&&(task==="server"||task==="dns")?<section className="ai-server-candidate-list" aria-label={task==="dns"?"DNS记录候选预览":"服务器候选预览"}><h4>识别到 {reply.draft.items.length} 条{task==="dns"?"DNS记录":"服务器候选"}</h4><p>{task==="dns"?"勾选后进行本地DNS规则解析并填入编辑器；仍需逐条核对和保存。":"勾选后进入重复项与字段审核；此处不会保存服务器或凭据。"}</p>{reply.draft.items.map((record,index)=><label className="ai-server-candidate" key={index}><input type="checkbox" checked={!!selectedItems[index]} disabled={busy} onChange={event=>setSelectedItems(selectedItems.map((checked,i)=>i===index?event.target.checked:checked))}/><span><strong>{index+1}. {task==="dns"?`${String(record.rr||"@")} · ${String(record.type||"未知类型")}`:String(record.name||"未命名服务器")}</strong><small>{task==="dns"?`${String(record.value||"缺少记录值")}${record.ttl!=null?` · TTL ${record.ttl}`:""}`:`${String(record.host||"缺少主机")} : ${String(record.port||"?")} · ${String(record.platform||"未知系统")} · ${String(record.username||"缺少用户名")}`}</small></span></label>)}</section>:reply.draft.items.length>0&&!(onApplyItems&&(task==="server"||task==="dns"))&&<label>选择要填写的记录<select value={item} disabled={busy} onChange={e=>{const index=Number(e.target.value);setItem(index);choose(reply.draft.items[index]);}}>{reply.draft.items.map((record,index)=><option key={index} value={index}>{index+1}. {String(record.name||record.rr||record.host||record.type||"记录")}</option>)}</select></label>}
        {!(onApplyItems&&(task==="server"||task==="dns")&&reply.draft.items.length)&&<>{!!Object.keys(fields).length&&<button type="button" onClick={()=>setSelected(Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value!==null])))}>勾选全部字段</button>}<div className="ai-result-fields">{Object.entries(fields).map(([key,value])=><label key={key}><span className="ai-field-title"><input type="checkbox" checked={!!selected[key]} disabled={value===null||busy} onChange={e=>setSelected({...selected,[key]:e.target.checked})}/>{labels[key]||key}</span><input disabled={busy} value={value??""} onChange={e=>setFields({...fields,[key]:typeof value==="number"?(e.target.value===""?null:Number(e.target.value)):e.target.value})}/>{current?.[key]!=null&&current[key]!==""&&<small>当前：{String(current[key])}；勾选后应用此字段</small>}</label>)}</div></>}<p>输入 {reply.inputTokens??"未知"} / 输出 {reply.outputTokens??"未知"} Token</p>
      </section>}
    </>}</div>
    <footer className="ai-workbench-footer"><button type="button" onClick={onClose}>关闭</button>{reply&&<button type="button" onClick={()=>void navigator.clipboard.writeText(JSON.stringify({...reply.draft,fields},null,2)).catch(()=>setError("复制失败，请选择文本手动复制"))}>复制结果</button>}{reply&&(onApply||onApplyItems)&&<button type="button" className="ai-primary" disabled={busy||!(onApplyItems&&(task==="server"||task==="dns")&&reply.draft.items.length?selectedItems.some(Boolean):Object.values(selected).some(Boolean))} onClick={()=>void apply()}>{onApplyItems&&task==="server"&&reply.draft.items.length?"审核并填入选中候选":onApplyItems&&task==="dns"&&reply.draft.items.length?"审核并填入选中记录":"应用勾选字段"}</button>}</footer>
  </aside></div>,document.body);
}
