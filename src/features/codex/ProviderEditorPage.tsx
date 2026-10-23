import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, Download, Eye, EyeOff, LoaderCircle, Plus, Save, Search, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { codexClient } from "../../platform/clients/codex";
import { codexProviders, type ModelSettings, type ProviderInput } from "../../platform/clients/codex-providers";

// Public endpoint shortcuts only. Fetch the available model catalogue with the user's own key.
const presets: { name: string; baseUrl: string; wireApi: ProviderInput["wireApi"]; group: string }[] = [
  { name: "OpenAI API", baseUrl: "https://api.openai.com/v1", wireApi: "responses", group: "官方 API" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", wireApi: "responses", group: "官方 API" },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", wireApi: "chat_completions", group: "官方 API" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", wireApi: "chat_completions", group: "官方 API" },
  { name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", wireApi: "chat_completions", group: "官方 API" },
  { name: "MiniMax 国内", baseUrl: "https://api.minimaxi.com/v1", wireApi: "chat_completions", group: "官方 API" },
  { name: "MiniMax 国际", baseUrl: "https://api.minimax.io/v1", wireApi: "chat_completions", group: "官方 API" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", wireApi: "chat_completions", group: "聚合 / 中转" },
  { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", wireApi: "chat_completions", group: "聚合 / 中转" },
];

export function providerEditorInput(value: ProviderInput): ProviderInput {
  const model = value.settings?.defaultModel?.trim();
  const catalog = [...new Set(value.keys.flatMap(key => key.settings?.models ?? []))];
  const keys = model && !catalog.includes(model) ? value.keys.map((key, index) => index === 0 ? { ...key, settings: { ...key.settings, models: [...(key.settings?.models ?? []), model], modelsScoped: true } } : key) : value.keys;
  return { ...value, name: value.name.trim(), baseUrl: value.baseUrl.trim(), settings: { ...value.settings, defaultModel: model || null }, keys, models: [...new Set(keys.flatMap(key => key.settings?.models ?? []))] };
}

interface Props {
  value: ProviderInput;
  busy: boolean;
  fetchingModels: boolean;
  catalogMessage: string;
  error: string;
  onChange: (value: ProviderInput) => void;
  onKeysChange: (keys: ProviderInput["keys"]) => void;
  onFetchModels: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function ProviderEditorPage({ value, busy, fetchingModels, catalogMessage, error, onChange, onKeysChange, onFetchModels, onSave, onClose }: Props) {
  const [presetOpen, setPresetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [readingConfig, setReadingConfig] = useState(false);
  const [commonConfig, setCommonConfig] = useState("");
  const [commonMessage, setCommonMessage] = useState("");
  const initial = useRef(JSON.stringify(value));
  const editor = useRef<HTMLElement>(null);
  const formId = useId();
  const alive = useRef(true);
  const reading = useRef(false);
  const modelListId = useId();
  const presetsId = useId();
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const input = providerEditorInput(value);
  const canSave = !!input.name && !!input.baseUrl && input.keys.length > 0 && input.keys.every(key => key.name.trim() && (key.id || key.secret?.trim()));
  const canFetch = !!value.baseUrl.trim() && value.keys.length > 0 && value.keys.every(key => key.id || key.secret?.trim());
  const catalog = [...new Set(value.keys.flatMap(key => key.settings?.models ?? []))];
  const firstKey = input.keys[0];
  const firstModels = firstKey?.settings?.models ?? [];
  const effectiveSettings = { contextWindow: firstKey?.settings?.contextWindow ?? value.settings?.contextWindow, compactLimit: firstKey?.settings?.compactLimit ?? value.settings?.compactLimit };
  const model = [firstKey?.settings?.defaultModel, input.settings?.defaultModel].find(item => item && firstModels.includes(item)) || firstModels[0] || "";
  const converted = value.wireApi === "chat_completions";
  let previewUrl = "<填写供应商 API 地址>";
  let insecureRemote = false;
  try {
    const url = new URL(value.baseUrl);
    if (!url.username && !url.password && !url.search && !url.hash && ["https:", "http:"].includes(url.protocol)) previewUrl = value.baseUrl.replace(/\/+$/, "");
    insecureRemote = url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { /* Incomplete addresses stay out of the config preview. */ }
  const preview = [
    converted ? "# 配置示意：应用时生成本地代理地址及访问凭据" : "# 配置示意：Responses 直连供应商，密钥不在此处显示",
    "# 现有 MCP 等配置会保留；预览使用第一个密钥的设置",
    ...(model ? [`model = ${JSON.stringify(model)}`] : ["# 尚未选择模型，应用时需在启动预览中指定"]),
    'model_provider = "cloudhub_provider"',
    ...(effectiveSettings.contextWindow ? [`model_context_window = ${effectiveSettings.contextWindow}`] : []),
    ...(effectiveSettings.compactLimit ? [`model_auto_compact_token_limit = ${effectiveSettings.compactLimit}`] : []),
    'cli_auth_credentials_store = "file"',
    "", "[model_providers.cloudhub_provider]",
    'name = "CloudHub Provider"',
    `base_url = ${JSON.stringify(converted ? "http://127.0.0.1:<运行时端口>/v1" : previewUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `experimental_bearer_token = ${JSON.stringify(converted ? "<由本地代理管理>" : "<应用时写入所选密钥>")}`,
  ].join("\n");
  function close() {
    if (busy || reading.current) return;
    if (JSON.stringify(value) !== initial.current) setDiscarding(true);
    else onClose();
  }
  // 汇总区的增删写回各密钥的模型目录；被删除的模型对应的默认模型一并清除。
  function updateCatalog(models: string[]) {
    const wanted = new Set(models);
    const known = new Set(catalog);
    const added = models.filter(item => !known.has(item));
    const keys = value.keys.map((key, index) => {
      const kept = (key.settings?.models ?? []).filter(item => wanted.has(item));
      const list = index === 0 ? [...kept, ...added.filter(item => !kept.includes(item))] : kept;
      const current = key.settings?.defaultModel;
      return { ...key, settings: { ...key.settings, models: list, modelsScoped: true, defaultModel: current && list.includes(current) ? current : null } };
    });
    const configured = value.settings?.defaultModel;
    onChange({ ...value, keys, settings: { ...value.settings, defaultModel: configured && models.includes(configured) ? configured : null } });
  }
  async function readCommonConfig() {
    if (reading.current) return;
    reading.current = true; setReadingConfig(true); setCommonMessage("");
    try {
      const source = await codexClient.configSource("preview");
      if (!alive.current) return;
      const managed = new Set(["model", "model_provider", "model_context_window", "model_auto_compact_token_limit"]);
      const entries = Object.entries(source?.preview ?? {}).filter(([key, setting]) => !managed.has(key) && setting !== null);
      setCommonConfig(entries.map(([key, setting]) => `${key} = ${JSON.stringify(setting)}`).join("\n"));
      setCommonMessage(entries.length ? "已读取本机配置中的通用选项；应用供应商时保留目标现有配置。" : "当前没有可预览的通用选项。MCP、Skills 和 Plugins 会保留在目标原配置中。");
    } catch {
      if (alive.current) setCommonMessage("读取失败，请确认官方 Codex CLI 已安装且本机配置有效。");
    } finally {
      reading.current = false;
      if (alive.current) setReadingConfig(false);
    }
  }
  return <OverviewDialog title={value.name.trim() || (value.id ? "编辑供应商" : "添加供应商")} description={value.id ? "编辑供应商配置，保存后生效" : "新建供应商需要先保存到列表"} busy={busy || readingConfig} onClose={close} layout="form" className="codex-provider-editor-dialog" headerActions={<button type="submit" form={formId} className="codex-provider-save" disabled={busy || !canSave}>{busy && !fetchingModels ? <LoaderCircle size={15} className="codex-refresh-spinning" /> : <Save size={15} />}{busy && !fetchingModels ? "保存中…" : "保存"}</button>}>
    <section ref={editor} className="codex-provider-editor" aria-label="供应商配置表单" aria-busy={busy}>
    <form id={formId} onSubmit={event => { event.preventDefault(); if (canSave && !busy) onSave(); }}>
      <div className="codex-provider-editor-body">
        <div className="codex-provider-editor-card codex-provider-form">
          {!value.id && <div className="codex-provider-presets">
            <button type="button" className="codex-provider-preset-toggle" disabled={busy} aria-expanded={presetOpen} aria-controls={presetsId} onClick={() => setPresetOpen(open => !open)}><span>从预设模板创建 <small>{presets.length} 个供应商</small></span><ChevronDown size={14} className={presetOpen ? "is-open" : ""} /></button>
            {presetOpen && <div id={presetsId} className="codex-provider-preset-list" role="region" aria-label="供应商预设列表">
              <label className="codex-provider-preset-search"><Search size={14} /><input aria-label="搜索供应商预设" placeholder="搜索供应商…" disabled={busy} value={query} onChange={event => setQuery(event.target.value)} /></label>
              {["官方 API", "聚合 / 中转"].map(group => {
                const matches = presets.filter(preset => preset.group === group && (preset.name + " " + preset.baseUrl).toLowerCase().includes(query.trim().toLowerCase()));
                return matches.length > 0 && <div key={group}><h3>{group}</h3><div className="codex-provider-preset-grid">{matches.map(preset => <button type="button" key={preset.name} disabled={busy} onClick={() => { onChange({ ...value, name: preset.name, baseUrl: preset.baseUrl, wireApi: preset.wireApi }); setPresetOpen(false); setQuery(""); }}><span className="codex-provider-preset-initial">{preset.name.slice(0, 1)}</span><span><strong>{preset.name}</strong><small>{preset.wireApi === "responses" ? "Responses API" : "Chat Completions"}</small></span></button>)}</div></div>;
              })}
              {!presets.some(preset => (preset.name + " " + preset.baseUrl).toLowerCase().includes(query.trim().toLowerCase())) && <p>没有匹配的供应商</p>}
              <p>模板填入名称、地址和协议；模型请使用自己的密钥获取或手动填写。</p>
            </div>}
          </div>}
          <div className="codex-provider-editor-fields">
            <label>名称<input aria-label="名称" maxLength={100} required disabled={busy} value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} /></label>
            <label>接入模式<select aria-label="接入模式" disabled={busy} value={value.wireApi} onChange={event => onChange({ ...value, wireApi: event.target.value as ProviderInput["wireApi"] })}><option value="responses">API Key · Responses API</option><option value="chat_completions">API Key · Chat Completions</option><option value="official" disabled>官方登录（在账号总览中管理）</option></select></label>
            <label>配置模型<input aria-label="配置模型" list={modelListId} maxLength={160} pattern="[-a-zA-Z0-9._/:]+" placeholder="填写模型 ID，或从下方模型列表选择" disabled={busy} value={value.settings?.defaultModel ?? ""} onChange={event => onChange({ ...value, settings: { ...value.settings, defaultModel: event.target.value } })} /><small>默认启动 Codex 时使用的模型名；未在目录中的模型会加入第一个密钥。</small><datalist id={modelListId}>{catalog.map(item => <option key={item} value={item} />)}</datalist></label>
            <div className="codex-provider-target"><span>Codex 目标</span><div><ShieldCheck size={17} />已启用 Codex</div><small>此配置用于 Codex；切换目标在启动预览中选择。</small></div>
            <div className="codex-provider-copy-field"><label>API 地址<input aria-label="API 地址" type="url" required placeholder="https://api.example.com/v1" maxLength={2048} disabled={busy} value={value.baseUrl} onChange={event => onChange({ ...value, baseUrl: event.target.value.trim() })} />{insecureRemote && <small>该地址使用明文 HTTP，密钥会在网络中以未加密形式发送，请确认上游可信。</small>}</label><button type="button" title="复制 API 地址" aria-label="复制 API 地址" disabled={!value.baseUrl} onClick={() => void navigator.clipboard.writeText(value.baseUrl).catch(() => undefined)}><Copy size={14} /></button></div>
            <div className="codex-provider-mode-note"><span>{value.wireApi === "responses" ? "Responses API" : "Chat Completions"}</span><small>{value.wireApi === "responses" ? "使用 API Key 连接供应商。" : "通过本地代理转换为 Codex 使用的 Responses 协议。"}</small></div>
          </div>
          <details className="codex-provider-more"><summary><Settings size={14} />更多选项</summary><div className="codex-provider-editor-fields"><ContextSettings settings={value.settings ?? {}} disabled={busy} onChange={settings => onChange({ ...value, settings })} /><label className="codex-provider-wide">备注<textarea rows={2} maxLength={2000} disabled={busy} value={value.note} onChange={event => onChange({ ...value, note: event.target.value })} /></label></div></details>
          <div className="codex-provider-key-heading"><strong>API Key</strong><button type="button" disabled={busy || value.keys.length >= 50} onClick={() => onKeysChange([...value.keys, { id: null, name: `密钥 ${value.keys.length + 1}`, secret: "", settings: { models: [], modelsScoped: true } }])}><Plus size={14} />添加密钥</button></div>
          {value.keys.map((key, index) => <div className="codex-provider-key-group" key={key.id ?? index}><div className="codex-provider-key-row">
            <label>密钥名称<input required maxLength={100} disabled={busy} value={key.name} onChange={event => onKeysChange(value.keys.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} /></label>
            <ProviderSecretField disabled={busy} hasSavedValue={!!key.id} value={key.secret ?? ""} reveal={key.id && value.id ? () => codexProviders.revealKey(value.id!, key.id!, value.version ?? 0) : undefined} onChange={secret => onKeysChange(value.keys.map((item, position) => position === index ? { ...item, secret: key.id && !secret ? null : secret } : item))} />
            <button type="button" title="移除此密钥" aria-label={`移除密钥 ${index + 1}`} disabled={busy || value.keys.length === 1} onClick={() => onKeysChange(value.keys.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
          </div><details><summary>{key.name || `密钥 ${index + 1}`} · 模型目录与设置</summary>
            <ModelCatalogInput label={`模型目录 · ${key.name || `密钥 ${index + 1}`}`} disabled={busy} models={key.settings?.models ?? []} onChange={models => onKeysChange(value.keys.map((item, position) => position === index ? { ...item, settings: { ...item.settings, models, modelsScoped: true } } : item))} />
            <div className="codex-provider-model-settings"><label>覆盖默认模型<select disabled={busy} value={key.settings?.defaultModel ?? ""} onChange={event => onKeysChange(value.keys.map((item, position) => position === index ? { ...item, settings: { ...item.settings, defaultModel: event.target.value || null } } : item))}><option value="">继承供应商</option>{(key.settings?.models ?? []).map(model => <option key={model} value={model}>{model}</option>)}</select></label><ContextSettings settings={key.settings ?? {}} disabled={busy} inherited onChange={settings => onKeysChange(value.keys.map((item, position) => position === index ? { ...item, settings } : item))} /></div>
          </details></div>)}
          <p className="codex-provider-security-note"><ShieldCheck size={16} />密钥加密保存在本机；点击眼睛图标可显式查看已保存的密钥。{converted ? "应用时由本地代理访问上游。" : "应用时按 Codex 规范写入目标的本机私有配置。"}</p>
        </div>
        {error && <p role="alert" className="codex-card-error">{error}</p>}
        <div className="codex-provider-preview-columns">
          <section><header><div><h3>config.toml 预览</h3><p>配置示意随表单实时更新，按第一个密钥展示；预览隐藏访问凭据。</p></div></header><textarea aria-label="config.toml 预览" readOnly spellCheck={false} rows={14} value={preview} /></section>
          <section><header><div><h3>通用配置文件</h3><p>应用时保留目标现有配置；这里只读展示本机的通用选项。</p></div><button type="button" disabled={busy || readingConfig} onClick={() => void readCommonConfig()}>{readingConfig ? <LoaderCircle size={14} className="codex-refresh-spinning" /> : <Download size={14} />}读取当前配置</button></header><textarea aria-label="通用配置文件" readOnly spellCheck={false} rows={14} placeholder="点击「读取当前配置」查看。MCP、Skills 和 Plugins 继续由原配置管理。" value={commonConfig} />{commonMessage && <p role="status">{commonMessage}</p>}</section>
        </div>
        <section className="codex-provider-editor-models codex-provider-form"><header><div><h3>模型列表</h3><p>{catalog.length} 个模型，按密钥分别保存；可直接在此删除模型或清空列表。</p></div><div className="codex-provider-model-actions"><button type="button" aria-label="清空模型列表" disabled={busy || !catalog.length} onClick={() => updateCatalog([])}><Trash2 size={14} />清空</button><button type="button" aria-label="获取所有密钥模型" disabled={busy || !canFetch} onClick={onFetchModels}>{fetchingModels ? <LoaderCircle size={14} className="codex-refresh-spinning" /> : <Download size={14} />}{fetchingModels ? "获取中…" : "获取全部"}</button></div></header><ModelCatalogInput ariaLabel="模型 ID（按密钥汇总）" disabled={busy} models={catalog} onChange={updateCatalog} />{catalogMessage && <p role="status">{catalogMessage}</p>}{!canSave && <p>保存前请填写名称、API 地址及密钥。模型目录可以稍后补充，应用配置时需要选择模型。</p>}</section>
      </div>
    </form>
    {discarding && createPortal(<ConfirmDialog title="放弃未保存的修改" message="供应商配置尚未保存，确认放弃修改并关闭弹层？" confirmLabel="放弃修改" onResolve={confirmed => { setDiscarding(false); if (confirmed) onClose(); }} />, editor.current?.closest("dialog") ?? document.body)}
    </section>
  </OverviewDialog>;
}

function ModelCatalogInput({ label, ariaLabel, disabled, models, onChange }: { label?: string; ariaLabel?: string; disabled: boolean; models: string[]; onChange: (models: string[]) => void }) {
  const serialized = models.join("\n");
  const [text, setText] = useState(serialized);
  const emitted = useRef(serialized);
  useEffect(() => {
    if (serialized !== emitted.current) { emitted.current = serialized; setText(serialized); }
  }, [serialized]);
  return <label>{label}<textarea aria-label={ariaLabel} disabled={disabled} rows={3} placeholder="每行一个模型 ID" value={text} onChange={event => {
    setText(event.target.value);
    const next = [...new Set(event.target.value.split(/[\n,，]/).map(model => model.trim()).filter(Boolean))];
    emitted.current = next.join("\n");
    onChange(next);
  }} /></label>;
}

function ContextSettings({ settings, disabled, inherited, onChange }: { settings: ModelSettings; disabled: boolean; inherited?: boolean; onChange: (settings: ModelSettings) => void }) {
  return <><label>{inherited ? "覆盖上下文窗口" : "上下文窗口"}<input type="number" min={1024} max={10000000} placeholder={inherited ? "继承供应商" : "由模型决定"} disabled={disabled} value={settings.contextWindow ?? ""} onChange={event => onChange({ ...settings, contextWindow: event.target.value ? Number(event.target.value) : null })} /></label><label>{inherited ? "覆盖压缩阈值" : "压缩阈值"}<input type="number" min={1024} max={settings.contextWindow ?? 10000000} placeholder={inherited ? "继承供应商" : "由模型决定"} disabled={disabled} value={settings.compactLimit ?? ""} onChange={event => onChange({ ...settings, compactLimit: event.target.value ? Number(event.target.value) : null })} /></label></>;
}

function ProviderSecretField({ disabled, hasSavedValue, value, onChange, reveal }: { disabled: boolean; hasSavedValue: boolean; value: string; onChange: (value: string) => void; reveal?: () => Promise<string> }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!value) setVisible(false); }, [value]);
  const shown = value || saved;
  async function toggle() {
    if (shown) { setNotice(""); setVisible(current => !current); return; }
    if (!reveal) { setNotice(hasSavedValue ? "已保存的密钥不会回显；输入新密钥后可查看。" : "输入密钥后即可显示或隐藏。"); return; }
    setNotice(""); setLoading(true);
    try {
      const secret = await reveal();
      setSaved(secret); setVisible(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取已保存的密钥失败");
    } finally {
      setLoading(false);
    }
  }
  // 复制不要求先点眼睛：输入框里有值就直接复制，已保存的密钥则先读取再复制，
  // 用户为了拿一次密钥不必先把凭据显示在屏幕上。
  async function copySecret() {
    setNotice("");
    const put = async (secret: string) => {
      try { await navigator.clipboard.writeText(secret); setNotice("密钥已复制到剪贴板"); }
      catch { setNotice("复制失败，请检查剪贴板权限"); }
    };
    if (shown) { await put(shown); return; }
    if (!reveal) { setNotice(hasSavedValue ? "已保存的密钥不会回显；输入新密钥后可复制。" : "请先填写密钥。"); return; }
    setLoading(true);
    try { await put(await reveal()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取已保存的密钥失败"); }
    finally { setLoading(false); }
  }
  return <div className="codex-provider-secret-group"><label htmlFor={id}>密钥</label><div className="codex-provider-secret-field"><input id={id} type={visible ? "text" : "password"} autoComplete="new-password" disabled={disabled || loading} placeholder={hasSavedValue ? "留空保留已保存密钥" : "API Key"} value={shown} onChange={event => { setSaved(""); setNotice(""); onChange(event.target.value); }} /><div className="codex-provider-secret-actions"><button type="button" className="codex-provider-secret-toggle" title={visible ? "隐藏密钥" : "显示密钥"} aria-label={visible ? "隐藏密钥" : "显示密钥"} aria-pressed={visible} disabled={disabled || loading} onClick={() => void toggle()}>{loading ? <LoaderCircle size={15} className="codex-refresh-spinning" /> : visible ? <EyeOff size={15} /> : <Eye size={15} />}</button><button type="button" className="codex-provider-secret-copy" title="复制密钥" aria-label="复制密钥" disabled={disabled || loading} onClick={() => void copySecret()}><Copy size={15} /></button></div></div>{notice && <p className="codex-provider-secret-message">{notice}</p>}</div>;
}
