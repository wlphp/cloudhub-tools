import { SharedDialog } from "../../shared/SharedDialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, ChevronDown, Eye, EyeOff, Plus, Save, Trash2 } from "lucide-react";
import { aiClient, type AiProfile, type AiProfileInput, type AiProtocol } from "../../platform/clients/ai";
import { runningInTauri } from "../../platform/api";
import "./ai.css";
import { AiModelInput } from "./AiModelInput";
import { AiConfigTransfer } from "./AiConfigTransfer";

const protocols: { value: AiProtocol; label: string; url: string }[] = [
  { value: "openai_chat", label: "OpenAI · Chat Completions", url: "https://api.openai.com/v1" },
  { value: "openai_responses", label: "OpenAI · Responses", url: "https://api.openai.com/v1" },
  { value: "claude", label: "Claude · Messages", url: "https://api.anthropic.com/v1" },
  { value: "gemini", label: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
];
const initial = (): AiProfileInput => ({ name: "", protocol: "openai_chat", baseUrl: protocols[0].url, model: "", models: [""], apiKey: "", enabled: true, isDefault: true, timeoutSeconds: 60, maxOutputTokens: 2048, allowLoopbackHttp: false });

export function AiSettings({ embedded = false }: { embedded?: boolean }) {
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [expanded, setExpanded] = useState(embedded);
  const [draft, setDraft] = useState<AiProfileInput | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [revealedKey, setRevealedKey] = useState("");
  const [revealing, setRevealing] = useState(false);
  const keyRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [models,setModels]=useState<string[]>([]);
  const alive = useRef(true);
  const request = useRef<string | null>(null);
  const saveFeedback = useRef<HTMLParagraphElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const enabledCount = profiles.filter(profile => profile.enabled).length;
  const visionCount = profiles.filter(profile => profile.visionStatus === "supported").length;
  const defaultProfile = profiles.find(profile => profile.isDefault);
  function clearKeyDisplay() { keyRequest.current++; setKeyVisible(false); setRevealedKey(""); setRevealing(false); }
  useEffect(() => {
    if (!keyVisible) return;
    const timer = window.setTimeout(clearKeyDisplay, 30000);
    const hide = () => { if (document.hidden) clearKeyDisplay(); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [keyVisible]);
  async function toggleKey() {
    if (!draft || busy || revealing) return;
    if (keyVisible) { clearKeyDisplay(); return; }
    if (draft.apiKey) { setKeyVisible(true); return; }
    const profile = profiles.find(profile => profile.id === draft.id);
    if (!profile?.hasKey) { setKeyVisible(true); return; }
    const token = ++keyRequest.current;
    setRevealing(true); setMessage("");
    try { const key = await aiClient.revealKey(profile.id, profile.updatedAt); if (alive.current && keyRequest.current === token) { setRevealedKey(key); setKeyVisible(true); } }
    catch { if (alive.current && keyRequest.current === token) setMessage("查看密钥失败，请重新打开编辑弹层后重试"); }
    finally { if (alive.current && keyRequest.current === token) setRevealing(false); }
  }
  function closeEditor() { if (!busyRef.current) { clearKeyDisplay(); setDraft(null); setModels([]); setMessage(""); } }
  async function reload() { const list = await aiClient.list(); if (alive.current) setProfiles(list); }
  useEffect(() => {
    alive.current = true;
    void reload().catch(error => { if (alive.current) setMessage(String(error)); });
    return () => { alive.current = false; keyRequest.current++; if (request.current) void aiClient.cancel(request.current).catch(() => {}); };
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await fn(); } catch (error) { if (alive.current) setMessage(String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  function edit(profile: AiProfile) { clearKeyDisplay(); opener.current = document.activeElement as HTMLElement; setExpanded(true); const { hasKey: _hasKey, updatedAt: _updatedAt, visionStatus:_vision, ...input } = profile; setDraft({ ...input, models: profile.models?.length ? profile.models : [profile.model], apiKey: "" }); setModels([]); setMessage(""); setDeleting(null); }
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
    const entries = (draft.models || [draft.model]).map(model => model.trim());
    if (new Set(entries).size !== entries.length) { setMessage("模型ID不能重复，请删除重复项"); return; }
    await action(async () => { await aiClient.save({ ...draft, model: draft.model.trim(), models: (draft.models || [draft.model]).map(model => model.trim()) }); if (alive.current) { clearKeyDisplay(); setDraft(null); setMessage("AI配置已加密保存"); await reload(); } });
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
  async function queryModels() {
    if (!draft || busy) return;
    const snapshot = draft;
    const profile = profiles.find(p => p.id === snapshot.id);
    await action(async () => {
      const id = crypto.randomUUID(); request.current = id;
      try {
        const result = await aiClient.models({ requestId: id, profileId: snapshot.id, expectedRevision: profile?.updatedAt, draft: { protocol: snapshot.protocol, baseUrl: snapshot.baseUrl, apiKey: snapshot.apiKey, allowLoopbackHttp: snapshot.allowLoopbackHttp, timeoutSeconds: snapshot.timeoutSeconds } });
        if (alive.current) { setModels(result); setMessage(result.length ? `已获取 ${result.length} 个模型名称，可下拉选择或直接填写` : "服务未返回可用模型，可直接填写模型ID"); }
      } finally { request.current = null; }
    });
  }
  function changeModel(index: number, value: string) {
    if (!draft) return;
    const entries = draft.models || [draft.model];
    setDraft({ ...draft, model: entries.indexOf(draft.model) === index ? value : draft.model, models: entries.map((model, i) => i === index ? value : model) });
  }
  return <section className="ai-settings" aria-labelledby="ai-settings-title">
    <header className="ai-settings-header"><div><h2 id="ai-settings-title"><Bot size={20} aria-hidden="true" />AI 服务 <small className="ai-profile-count">{profiles.length ? `${profiles.length} 项` : "未配置"}</small></h2><p className="ai-settings-description">识别填写、命令草稿和错误分析。</p></div>
      <div className="ai-config-summary" role="group" aria-label="AI 服务概览">
        {profiles.length ? <><div className="ai-summary-stats"><span>启用 <strong>{enabledCount} / {profiles.length}</strong></span><span>图像测试通过 <strong>{visionCount}</strong></span><span className="ai-summary-default" title={defaultProfile?.name}>默认：{defaultProfile ? `${defaultProfile.name}${defaultProfile.enabled ? "" : "（已停用）"}` : "未设置"}</span></div><div className="ai-summary-channels">{profiles.map(profile => <span className={`ai-summary-channel${profile.enabled ? "" : " is-disabled"}`} key={profile.id} title={`${profile.name} · ${protocols.find(p => p.value === profile.protocol)?.label || profile.protocol}${profile.enabled ? "" : " · 已停用"}`}><span>{profile.name}</span><small>{protocols.find(p => p.value === profile.protocol)?.label || profile.protocol}{!profile.enabled && " · 已停用"}</small></span>)}</div></> : <p>尚未添加服务，可在手机网页配置并使用 AI 辅助。</p>}
      </div>
      <div className="ai-settings-controls">{!embedded && <button className="ai-settings-toggle" type="button" aria-expanded={expanded} aria-controls="ai-settings-content" onClick={() => setExpanded(value => !value)}><ChevronDown size={15} aria-hidden="true" />{expanded ? "收起" : "展开"}</button>}<button type="button" disabled={busy} onClick={() => { opener.current = document.activeElement as HTMLElement; setExpanded(true); clearKeyDisplay(); setDraft(initial()); setModels([]); setDeleting(null); setMessage(""); }}><Plus size={15} />添加服务</button></div></header>
    <div id="ai-settings-content" hidden={!expanded}>
    <>
      {message && !draft && <p className="ai-feedback" role="status" tabIndex={-1} ref={saveFeedback}>{message}</p>}
      {!profiles.length && !draft && <p>尚未配置 AI 服务。配置不会自动上传业务数据。</p>}
      <div className="ai-profile-list">{profiles.map(profile => <article className="ai-profile" key={profile.id}>
        <div><strong>{profile.name}{profile.isDefault && <small>默认</small>}{!profile.enabled && <small>已停用</small>}</strong><span>{protocols.find(p => p.value === profile.protocol)?.label} · {profile.model}{(profile.models?.length || 0) > 1 && ` · ${profile.models!.length} 个模型`}</span><span>{profile.baseUrl}</span><span>截图能力：{profile.visionStatus==="supported"?"已通过测试":profile.visionStatus==="unsupported"?"测试未通过":"尚未测试"}</span></div>
        <div className="ai-actions"><button type="button" disabled={busy} onClick={() => edit(profile)}>编辑</button><button type="button" disabled={busy || !profile.enabled} title="固定无敏感样例，测试可能产生调用费用" onClick={() => void test(profile)}>测试连接</button>{runningInTauri && <button type="button" disabled={busy || !profile.enabled} title="发送本机生成的不含敏感信息的测试图，可能产生调用费用" onClick={()=>void testVision(profile)}>测试图像</button>}<button type="button" disabled={busy} aria-label={`删除AI服务 ${profile.name}`} onClick={() => setDeleting(profile.id)}><Trash2 size={15} /></button></div>
        {deleting === profile.id && <div className="ai-delete-confirm"><span>删除服务和密钥？正在进行的调用将取消。</span><button type="button" disabled={busy} onClick={() => void action(async () => { await aiClient.remove(profile.id); if (alive.current) { setDeleting(null); if (draft?.id === profile.id) setDraft(null); await reload(); } })}>确认删除</button><button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button></div>}
      </article>)}</div>
      {draft && <SharedDialog title={draft.id ? "编辑AI服务" : "添加AI服务"} className="ai-config-form ai-config-dialog ai-workbench" bodyClassName="ai-config-dialog-body" noValidate onSubmit={event => void save(event)} onClose={closeEditor} closeLabel="取消编辑AI服务" closeDisabled={busy} footerClassName="ai-actions ai-workbench-footer" footer={<><button type="button" disabled={busy} onClick={closeEditor}>取消</button><button type="submit" className="ai-primary" disabled={busy}><Save size={15} />{busy ? "处理中…" : "保存配置"}</button></>}>
        <label>配置名称<input autoFocus required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：我的运维模型" /></label>
        <label>接口协议<select disabled={busy} value={draft.protocol} onChange={e => { const next = protocols.find(p => p.value === e.target.value)!; setModels([]); setDraft({ ...draft, protocol: next.value, baseUrl: protocols.some(p => p.url === draft.baseUrl) ? next.url : draft.baseUrl }); }}>{protocols.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label>服务地址<input disabled={busy} required maxLength={512} value={draft.baseUrl} onChange={e => { setModels([]); setDraft({ ...draft, baseUrl: e.target.value }); }} placeholder="HTTPS地址，可包含网关路径前缀" /></label>
        <div className="ai-key-field"><label htmlFor="ai-api-key">API Key</label><div className="ai-key-input"><input id="ai-api-key" disabled={busy || revealing} type={keyVisible ? "text" : "password"} autoComplete="new-password" spellCheck={false} required={!draft.id || (draft.enabled && !profiles.find(p=>p.id===draft.id)?.hasKey)} maxLength={4096} value={draft.apiKey || revealedKey} onChange={e => { keyRequest.current++; setRevealedKey(""); setDraft({ ...draft, apiKey: e.target.value }); }} placeholder={draft.id ? "留空保留已保存密钥；未携带密钥的导入配置需补填" : "本地加密保存"} /><button type="button" disabled={busy || revealing} aria-label={keyVisible ? "隐藏 API Key" : "查看 API Key"} aria-pressed={keyVisible} title={revealing ? "正在读取…" : keyVisible ? "隐藏密钥" : "查看密钥"} onClick={() => void toggleKey()}>{keyVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button></div></div>
        <section className="ai-model-config" aria-label="模型ID配置">
          <div className="ai-model-heading"><strong>模型 ID</strong><div className="ai-model-query-actions"><button className="ai-model-query-cancel" type="button" style={{visibility: busy && request.current ? "visible" : "hidden"}} tabIndex={busy && request.current ? 0 : -1} aria-hidden={!(busy && request.current)} onClick={() => void aiClient.cancel(request.current!).catch(() => setMessage("取消请求失败"))}>取消获取</button><button className="ai-model-query-button" type="button" disabled={busy || !draft.baseUrl.trim() || !(draft.apiKey?.trim() || profiles.find(p => p.id === draft.id)?.hasKey)} onClick={() => void queryModels()}>{busy && request.current ? "正在获取…" : "获取模型列表"}</button></div></div>
          <small>可手动填写或获取后搜索选择；默认模型用于测试和首次调用。</small>
          {(draft.models || [draft.model]).map((model, index) => <div className="ai-model-row" key={index}>
            <label className="ai-model-default"><input type="radio" name="default-model" aria-label={`默认模型 ${index + 1}`} checked={(draft.models || [draft.model]).indexOf(draft.model) === index} disabled={busy} onChange={() => setDraft({ ...draft, model })} />默认</label>
            <AiModelInput label={index === 0 ? "模型名称" : `模型 ID ${index + 1}`} value={model} models={models} disabled={busy} onChange={value => changeModel(index, value)} />
            <button type="button" aria-label={`删除模型 ${index + 1}`} disabled={busy || (draft.models || []).length <= 1} onClick={() => { const entries = draft.models!.filter((_, i) => i !== index); setDraft({ ...draft, models: entries, model: draft.model === model ? entries[0] : draft.model }); }}><Trash2 size={15} /></button>
          </div>)}
          <button className="ai-add-model" type="button" disabled={busy || (draft.models || []).length >= 20} onClick={() => setDraft({ ...draft, models: [...(draft.models || [draft.model]), ""] })}><Plus size={15} />添加模型 ID</button>
        </section>
        <div className="ai-checks"><label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用此服务</label><label><input type="checkbox" checked={draft.isDefault} onChange={e => setDraft({ ...draft, isDefault: e.target.checked })} />设为默认服务</label></div>
        <details><summary>高级设置</summary><div className="ai-form-columns"><label>请求超时（秒）<input type="number" required min={5} max={180} value={draft.timeoutSeconds} onChange={e => setDraft({ ...draft, timeoutSeconds: Number(e.target.value) })} /></label><label>最大输出 Token<input type="number" required min={128} max={8192} value={draft.maxOutputTokens} onChange={e => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })} /></label></div><label className="ai-checkbox"><input type="checkbox" checked={draft.allowLoopbackHttp} onChange={e => setDraft({ ...draft, allowLoopbackHttp: e.target.checked })} />允许本机回环 HTTP 服务（例如本地模型网关）</label></details>
        <p>密钥仅在点击查看时显示，30秒后自动隐藏，不写入调用日志。保存后可用固定样例测试；第三方服务可能仅支持部分协议能力。</p>
        <p className={`ai-feedback ai-config-status${message ? "" : " is-empty"}`} role={message ? "status" : undefined} tabIndex={-1} ref={saveFeedback}>{message || "\u00a0"}</p>
      </SharedDialog>}
      {busy && request.current && <button type="button" onClick={() => void aiClient.cancel(request.current!).catch(error => setMessage(String(error)))}>取消测试</button>}
      {runningInTauri && <AiConfigTransfer profiles={profiles} onImported={reload}/>}
    </>
    </div>
  </section>;
}
