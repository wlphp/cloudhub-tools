import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, ChevronDown, Plus, Save, Trash2, X } from "lucide-react";
import { aiClient, type AiProfile, type AiProfileInput, type AiProtocol } from "../../platform/clients/ai";
import { runningInTauri } from "../../platform/api";
import "./ai.css";
import { AiConfigTransfer } from "./AiConfigTransfer";

const protocols: { value: AiProtocol; label: string; url: string }[] = [
  { value: "openai_chat", label: "OpenAI · Chat Completions", url: "https://api.openai.com/v1" },
  { value: "openai_responses", label: "OpenAI · Responses", url: "https://api.openai.com/v1" },
  { value: "claude", label: "Claude · Messages", url: "https://api.anthropic.com/v1" },
  { value: "gemini", label: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
];
const initial = (): AiProfileInput => ({ name: "", protocol: "openai_chat", baseUrl: protocols[0].url, model: "", apiKey: "", enabled: true, isDefault: true, timeoutSeconds: 60, maxOutputTokens: 2048, allowLoopbackHttp: false });

export function AiSettings() {
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<AiProfileInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [models,setModels]=useState<string[]>([]);
  const alive = useRef(true);
  const request = useRef<string | null>(null);
  const saveFeedback = useRef<HTMLParagraphElement | null>(null);
  async function reload() { const list = await aiClient.list(); if (alive.current) setProfiles(list); }
  useEffect(() => {
    alive.current = true;
    if (runningInTauri) void reload().catch(error => { if (alive.current) setMessage(String(error)); });
    return () => { alive.current = false; if (request.current) void aiClient.cancel(request.current).catch(() => {}); };
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await fn(); } catch (error) { if (alive.current) setMessage(String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  function edit(profile: AiProfile) { setExpanded(true); const { hasKey: _hasKey, updatedAt: _updatedAt, visionStatus:_vision, ...input } = profile; setDraft({ ...input, apiKey: "" }); setModels([]); setMessage(""); setDeleting(null); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return;
    const form = event.currentTarget as HTMLFormElement;
    const invalid = Array.from(form.elements).find((element): element is HTMLInputElement | HTMLSelectElement =>
      (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && !element.validity.valid);
    if (invalid) {
      const label = invalid.labels?.[0]?.firstChild?.textContent?.trim() || "配置字段";
      setMessage(`请检查${label}：${invalid.validity.valueMissing ? "此项必填" : invalid.validationMessage}`);
      const details = invalid.closest("details");
      if (details) details.open = true;
      invalid.focus();
      invalid.scrollIntoView({ block: "center" });
      return;
    }
    await action(async () => { await aiClient.save(draft); if (alive.current) { setDraft(null); setMessage("AI配置已加密保存"); await reload(); } });
    requestAnimationFrame(() => saveFeedback.current?.focus());
  }
  async function test(profile: AiProfile) {
    await action(async () => {
      const id = crypto.randomUUID(); request.current = id;
      try { const reply = await aiClient.run({ requestId: id, profileId: profile.id, expectedRevision: profile.updatedAt, task: "connection", text: "请完成连接与JSON格式测试。" });
        if (alive.current) setMessage(`测试通过：${reply.draft.summary || "结构化结果可用"}；输入 ${reply.inputTokens ?? "未知"} / 输出 ${reply.outputTokens ?? "未知"} Token`);
      } finally { request.current = null; }
    });
  }
  async function testVision(profile:AiProfile){await action(async()=>{const id=crypto.randomUUID();request.current=id;try{const result=await aiClient.testVision({requestId:id,profileId:profile.id,expectedRevision:profile.updatedAt});if(alive.current){setMessage(result.passed?"图像测试通过，可以使用裁剪遮挡后的截图识别":"图像测试未通过，请更换模型或重试，文本功能仍可使用");await reload();}}finally{request.current=null;}});}
  async function queryModels(){const profile=profiles.find(p=>p.id===draft?.id);if(!profile)return;await action(async()=>{const id=crypto.randomUUID();request.current=id;try{const result=await aiClient.models({requestId:id,profileId:profile.id,expectedRevision:profile.updatedAt});if(alive.current){setModels(result);setMessage(`已获取 ${result.length} 个模型名称，可下拉选择或直接填写`);}}finally{request.current=null;}});}
  return <section className="ai-settings" aria-labelledby="ai-settings-title">
    <header className="ai-settings-header"><div><h2 id="ai-settings-title"><Bot size={20} aria-hidden="true" />AI 服务 <small className="ai-profile-count">{profiles.length ? `${profiles.length} 项` : "未配置"}</small></h2>{expanded && <p>识别填写、命令草稿和错误分析均可选；未配置时继续手动操作。</p>}</div><div className="ai-settings-controls"><button className="ai-settings-toggle" type="button" aria-expanded={expanded} aria-controls="ai-settings-content" onClick={() => setExpanded(value => !value)}><ChevronDown size={15} aria-hidden="true" />{expanded ? "收起" : "展开"}</button><button type="button" disabled={busy || !runningInTauri} onClick={() => { setExpanded(true); setDraft(initial()); setMessage(""); }}><Plus size={15} />添加服务</button></div></header>
    <div id="ai-settings-content" hidden={!expanded}>
    {!runningInTauri ? <p role="status">AI配置与密钥调用请使用桌面或手机原生客户端，浏览器预览保留手动功能。</p> : <>
      {message && !draft && <p className="ai-feedback" role="status">{message}</p>}
      {!profiles.length && !draft && <p>尚未配置 AI 服务。配置不会自动上传业务数据。</p>}
      <div className="ai-profile-list">{profiles.map(profile => <article className="ai-profile" key={profile.id}>
        <div><strong>{profile.name}{profile.isDefault && <small>默认</small>}{!profile.enabled && <small>已停用</small>}</strong><span>{protocols.find(p => p.value === profile.protocol)?.label} · {profile.model}</span><span>{profile.baseUrl}</span><span>截图能力：{profile.visionStatus==="supported"?"已通过测试":profile.visionStatus==="unsupported"?"测试未通过":"尚未测试"}</span></div>
        <div className="ai-actions"><button type="button" disabled={busy} onClick={() => edit(profile)}>编辑</button><button type="button" disabled={busy || !profile.enabled} title="固定无敏感样例，测试可能产生调用费用" onClick={() => void test(profile)}>测试连接</button><button type="button" disabled={busy || !profile.enabled} title="发送本机生成的不含敏感信息的测试图，可能产生调用费用" onClick={()=>void testVision(profile)}>测试图像</button><button type="button" disabled={busy} aria-label={`删除AI服务 ${profile.name}`} onClick={() => setDeleting(profile.id)}><Trash2 size={15} /></button></div>
        {deleting === profile.id && <div className="ai-delete-confirm"><span>删除服务和密钥？正在进行的调用将取消。</span><button type="button" disabled={busy} onClick={() => void action(async () => { await aiClient.remove(profile.id); if (alive.current) { setDeleting(null); if (draft?.id === profile.id) setDraft(null); await reload(); } })}>确认删除</button><button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button></div>}
      </article>)}</div>
      {draft && <form className="ai-config-form" noValidate onSubmit={event => void save(event)}>
        <header><strong>{draft.id ? "编辑AI服务" : "添加AI服务"}</strong><button type="button" disabled={busy} aria-label="取消编辑AI服务" onClick={() => setDraft(null)}><X size={16} /></button></header>
        <label>配置名称<input required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：我的运维模型" /></label>
        <label>接口协议<select value={draft.protocol} onChange={e => { const next = protocols.find(p => p.value === e.target.value)!; setDraft({ ...draft, protocol: next.value, baseUrl: protocols.some(p => p.url === draft.baseUrl) ? next.url : draft.baseUrl }); }}>{protocols.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label>服务地址<input required maxLength={512} value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="HTTPS地址，可包含网关路径前缀" /></label>
        <label>模型名称<input required list="ai-model-options" maxLength={160} value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} placeholder="填写服务支持的模型名称" /><datalist id="ai-model-options">{models.map(model=><option key={model} value={model}/>)}</datalist></label>
        <div className="ai-actions"><button type="button" disabled={busy || !draft.id || !profiles.find(p=>p.id===draft.id)?.enabled || !!draft.apiKey || draft.baseUrl!==profiles.find(p=>p.id===draft.id)?.baseUrl || draft.protocol!==profiles.find(p=>p.id===draft.id)?.protocol} onClick={()=>void queryModels()}>查询服务模型</button><small>使用已保存的地址与密钥查询；首次可直接填写模型名称。</small></div>
        <label>API Key<input type="password" autoComplete="new-password" required={!draft.id || (draft.enabled && !profiles.find(p=>p.id===draft.id)?.hasKey)} maxLength={4096} value={draft.apiKey || ""} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} placeholder={draft.id ? "留空保留已保存密钥；未携带密钥的导入配置需补填" : "本地加密保存"} /></label>
        <div className="ai-checks"><label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用此服务</label><label><input type="checkbox" checked={draft.isDefault} onChange={e => setDraft({ ...draft, isDefault: e.target.checked })} />设为默认服务</label></div>
        <details><summary>高级设置</summary><div className="ai-form-columns"><label>请求超时（秒）<input type="number" required min={5} max={180} value={draft.timeoutSeconds} onChange={e => setDraft({ ...draft, timeoutSeconds: Number(e.target.value) })} /></label><label>最大输出 Token<input type="number" required min={128} max={8192} value={draft.maxOutputTokens} onChange={e => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })} /></label></div><label className="ai-checkbox"><input type="checkbox" checked={draft.allowLoopbackHttp} onChange={e => setDraft({ ...draft, allowLoopbackHttp: e.target.checked })} />允许本机回环 HTTP 服务（例如本地模型网关）</label></details>
        <p>密钥不回显、不写入调用日志。保存后可用固定样例测试；第三方服务可能仅支持部分协议能力。</p>
        {message && <p className="ai-feedback" role="status" tabIndex={-1} ref={saveFeedback}>{message}</p>}
        <div className="ai-actions"><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button type="submit" className="ai-primary" disabled={busy}><Save size={15} />{busy ? "处理中…" : "保存配置"}</button></div>
      </form>}
      {busy && request.current && <button type="button" onClick={() => void aiClient.cancel(request.current!).catch(error => setMessage(String(error)))}>取消测试</button>}
      <AiConfigTransfer profiles={profiles} onImported={reload}/>
    </>}
    </div>
  </section>;
}
