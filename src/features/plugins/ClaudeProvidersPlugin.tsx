import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, Copy, Download, ExternalLink, FolderOpen, HelpCircle, ListChecks, Loader2, Pencil, Play, Plus, RotateCcw, Search, Server, Star, Trash2, Wand2, Wifi } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { claudeProvidersClient, claudeWorkbenchClient, DEFAULT_CLAUDE_ROUTING, type ClaudeMode, type ClaudeRoutingState, type ClaudeRoutingConfig, type ClaudeModelMapping, type ClaudeApiFormat, type ClaudeApiKeyField, type ClaudeProviderInput, type ClaudeProviderSummary, type ClaudeWorkspaceState } from "../../platform/clients/claudeProviders";
import { ModeBar, RoutingSettings, UsagePanel } from "./ClaudeRoutingPanels";
import { ClaudeWorkspacePanel } from "./ClaudeWorkspacePanel";
import "./claude-providers.css";

const USER_AGENT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "默认（保留 Claude Code UA）" },
  { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClaudeCode/1.0", label: "桌面浏览器风格" },
  { value: "claude-code/1.0", label: "Claude Code 默认" },
];

/** 一键设置：取当前 5 个角色中第一个已填的实际模型作为「主模型」，同步到全部角色。
 *  与 cc-switch ClaudeFormFields 中 "Apply to all" 行为一致：读表单已有值、批量推。 */
const QUICK_PRESET_PRIORITY = ["sonnet", "opus", "fable", "haiku", "subagent"] as const;

/** 去掉模型名末尾的 [1m] 标记，作为 displayName 用。 */
function stripOneMMarker(model: string): string {
  return model.replace(/\s*\[1m\]\s*$/i, "").trim();
}

function Hint({ text }: { text: string }) {
  return <span className="claude-hint-icon" title={text} aria-label={text} tabIndex={0}><HelpCircle size={13} aria-hidden="true" /></span>;
}

const ROLES: { key: string; label: string }[] = [
  { key: "sonnet", label: "Sonnet" },
  { key: "opus", label: "Opus" },
  { key: "haiku", label: "Haiku" },
  { key: "fable", label: "Fable" },
  { key: "subagent", label: "Subagent" },
];

const API_FORMATS: { value: ClaudeApiFormat; label: string }[] = [
  { value: "anthropic", label: "Anthropic Messages（原生）" },
  { value: "openai_chat", label: "OpenAI Chat Completions" },
  { value: "openai_responses", label: "OpenAI Responses" },
  { value: "gemini", label: "Gemini Native generateContent" },
];

const KEY_FIELDS: { value: ClaudeApiKeyField; label: string }[] = [
  { value: "auth_token", label: "ANTHROPIC_AUTH_TOKEN（默认）" },
  { value: "api_key", label: "ANTHROPIC_API_KEY" },
];

const emptyProvider = (): ClaudeProviderInput => ({
  id: "", name: "", description: "", websiteUrl: "", baseUrl: "", apiKey: "",
  apiKeyField: "auth_token", apiFormat: "anthropic", isFullUrl: true, models: {}, extraEnv: {},
  officialLogin: false, modelCatalog: [],
});

function Editor({ draft, keyConfigured, onClose, onSaved }: { draft: ClaudeProviderInput; keyConfigured: boolean; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState<ClaudeProviderInput>(() => {
    const initial: ClaudeProviderInput = {
      ...draft,
      models: draft.models ?? {},
      extraEnv: draft.extraEnv ?? {},
      modelCatalog: draft.modelCatalog ?? [],
      userAgent: draft.userAgent ?? "",
      proxyHeaderOverride: draft.proxyHeaderOverride ?? "",
      proxyBodyOverride: draft.proxyBodyOverride ?? "",
      fallbackModel: draft.fallbackModel ?? null,
    };
    // 兜底回填：若 modelCatalog 里有该 model 的 displayName，而 5 个角色或默认兜底的
    // displayName 仍为空，用 modelCatalog 的值补上——避免编辑已保存供应商时整列显示
    // 「显示名称（可选）」占位。仅在 Editor 打开瞬间跑一次，运行时不动已开 Editor 的
    // displayName 状态，用户手动清空后不会被回填。
    const catalogByModel = new Map<string, string>();
    for (const item of initial.modelCatalog ?? []) {
      const id = item.model.trim();
      if (id && item.displayName && !catalogByModel.has(id)) catalogByModel.set(id, item.displayName);
    }
    const fillDisplay = (mapping: ClaudeModelMapping | null | undefined): ClaudeModelMapping | null => {
      if (!mapping) return null;
      if ((mapping.displayName ?? "").trim()) return mapping;
      const name = catalogByModel.get(mapping.model.trim());
      return name ? { ...mapping, displayName: name } : mapping;
    };
    const filledModels: Record<string, ClaudeModelMapping> = {};
    for (const [role, m] of Object.entries(initial.models ?? {})) filledModels[role] = fillDisplay(m) ?? m;
    return { ...initial, models: filledModels, fallbackModel: fillDisplay(initial.fallbackModel) };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [extraEnv, setExtraEnv] = useState(JSON.stringify(draft.extraEnv ?? {}, null, 2));
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerMessage, setPickerMessage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState<ClaudeModelMapping[] | null>(null);
  const [fullConfig, setFullConfig] = useState("");
  const hasSavedKey = Boolean(draft.id) && keyConfigured;

  const patch = (next: Partial<ClaudeProviderInput>) => setValue((current) => ({ ...current, ...next }));
  /**
   * 更新某一行的 `model` 或 `displayName`。当用户从下拉里选了一个 model（next 命中
   * modelCatalog 中某条），且当前 displayName 仍为空时，自动用 modelCatalog 的 displayName
   * 兜底——避免 5 行都显示「显示名称（可选）」占位。但只要用户已手动填过 displayName，
   * 一律保留，不被覆盖。
   */
  const setModel = (role: string, field: keyof ClaudeModelMapping, next: string | boolean) =>
    setValue((current) => {
      const models = { ...(current.models ?? {}) };
      const prev = models[role] ?? { model: "" };
      const updated: ClaudeModelMapping = { ...prev, [field]: next } as ClaudeModelMapping;
      if (field === "model" && typeof next === "string") {
        const alreadyFilled = (updated.displayName ?? "").trim();
        if (!alreadyFilled) {
          const catalogEntry = (current.modelCatalog ?? []).find(item => item.model.trim() === next.trim());
          if (catalogEntry?.displayName) updated.displayName = catalogEntry.displayName;
        }
      }
      models[role] = updated;
      return { ...current, models };
    });
  const setFallback = (field: keyof ClaudeModelMapping, next: string | boolean) =>
    setValue((current) => {
      const prev = current.fallbackModel ?? { model: "" };
      const updated: ClaudeModelMapping = { ...prev, [field]: next } as ClaudeModelMapping;
      if (field === "model" && typeof next === "string" && !(updated.displayName ?? "").trim()) {
        const catalogEntry = (current.modelCatalog ?? []).find(item => item.model.trim() === next.trim());
        if (catalogEntry?.displayName) updated.displayName = catalogEntry.displayName;
      }
      return { ...current, fallbackModel: updated };
    });
  const setCatalogItem = (index: number, field: keyof ClaudeModelMapping, next: string | boolean) =>
    setValue((current) => ({
      ...current,
      modelCatalog: (current.modelCatalog ?? []).map((item, i) => i === index ? { ...item, [field]: next } as ClaudeModelMapping : item),
    }));
  /** 实际请求模型下拉选项：聚合模型列表去重后按原顺序；空时为空数组（占位提示请先获取）。 */
  const modelOptions = useMemo(
    () => {
      const seen = new Set<string>();
      const list: { model: string; displayName?: string }[] = [];
      for (const item of value.modelCatalog ?? []) {
        const id = item.model.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        list.push({ model: id, displayName: item.displayName });
      }
      return list;
    },
    [value.modelCatalog],
  );

  function applyQuickPreset() {
    // 与 cc-switch ClaudeFormFields 的"一键设置"语义一致：取第一个已填的实际模型作为主模型，
    // 同步填到全部 5 个角色。displayName 同步去掉 [1m] 标记后的主模型名。
    const models = value.models ?? {};
    const primary = (() => {
      for (const role of QUICK_PRESET_PRIORITY) {
        const candidate = models[role]?.model?.trim();
        if (candidate) return candidate;
      }
      return "";
    })();
    if (!primary) {
      setPickerMessage("请先在「Sonnet / Opus / Fable / Haiku / Subagent」中任意一行填入实际模型，再使用一键设置");
      return;
    }
    const displayName = stripOneMMarker(primary);
    const next: Record<string, ClaudeModelMapping> = {};
    for (const role of QUICK_PRESET_PRIORITY) {
      next[role] = { model: primary, displayName };
    }
    patch({ models: next });
    setPickerMessage(`已将「${primary}」应用到全部 5 个角色`);
  }

  async function pullModelList() {
    if (pickerBusy) return;
    if (!draft.id) { setPickerMessage("请先保存供应商，再获取模型列表"); return; }
    setPickerBusy(true); setPickerMessage(""); setError("");
    try {
      const available = await claudeWorkbenchClient.models(draft.id);
      if (!available.length) { setPickerMessage("上游未返回模型，请手动填入"); setPickerBusy(false); return; }
      setPickerModels(available);
      setPickerOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "获取模型列表失败");
    } finally {
      setPickerBusy(false);
    }
  }

  function applyPickerSelection(addIds: string[], removeIds: string[]) {
    setValue(current => {
      const before = current.modelCatalog ?? [];
      const removeSet = new Set(removeIds);
      const remaining = before.filter(item => !removeSet.has(item.model));
      const existing = new Set(remaining.map(item => item.model));
      const additions = (pickerModels ?? [])
        .filter(item => addIds.includes(item.model) && !existing.has(item.model))
        .map(item => ({ model: item.model, displayName: stripOneMMarker(item.model) }));
      return { ...current, modelCatalog: [...remaining, ...additions] };
    });
    const added = addIds.length;
    const removed = removeIds.length;
    const summary = [
      added ? `新增 ${added}` : "",
      removed ? `移除 ${removed}` : "",
    ].filter(Boolean).join("，");
    setPickerMessage(summary ? `已更新聚合模型列表：${summary}` : "聚合模型列表未变更");
    setPickerOpen(false);
    setPickerModels(null);
  }

  function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch { return null; }
  }

  async function submit() {
    if (busy) return;
    const id = value.id.trim() || `custom-${Date.now().toString(36)}`;
    if (!value.name.trim()) { setError("请填写供应商名称"); return; }
    if (!value.officialLogin && !(value.baseUrl ?? "").trim()) { setError("请填写请求地址"); return; }
    const env = parseJsonObject(extraEnv);
    if (env === null) { setError("扩展环境变量必须为 JSON 对象"); return; }
    // proxy 覆盖字段在 schema 里是字符串（textarea 编辑的就是 JSON 文本），
    // 直接透传到后端，provider_env 内部解析；这里仅做"非空必须是合法 JSON 对象"的本地校验。
    const headersText = (value.proxyHeaderOverride ?? "").trim();
    if (headersText && !parseJsonObject(headersText)) { setError("Header 覆盖必须为 JSON 对象"); return; }
    const bodyText = (value.proxyBodyOverride ?? "").trim();
    if (bodyText && !parseJsonObject(bodyText)) { setError("Body 覆盖必须为 JSON 对象"); return; }
    if (value.modelCatalog?.some(item => !item.model.trim())) { setError("请填写模型列表中每项的模型 ID"); return; }
    setBusy(true); setError("");
    try {
      await claudeProvidersClient.save({ ...value, id, extraEnv: env });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存供应商失败");
    } finally { setBusy(false); }
  }

  return <SharedDialog
    title={draft.id ? `编辑供应商 · ${value.name || "(未命名)"}` : "添加供应商"}
    subtitle="Claude Code 供应商配置：请求地址、API Key、模型映射、路由增强"
    icon={<Server size={20} aria-hidden="true" />}
    className="claude-provider-dialog"
    bodyClassName="claude-provider-body"
    closeLabel="关闭供应商编辑"
    onClose={onClose}
    closeDisabled={busy}
    onSubmit={event => { event.preventDefault(); void submit(); }}
    footer={<>
      <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
      <button type="submit" className="primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
    </>}>
    <div className="claude-field-row">
      <label className="claude-field">供应商名称<input value={value.name} maxLength={60} autoFocus onChange={event => patch({ name: event.target.value })} placeholder="例如：公司专用账号" /></label>
      <label className="claude-field">官网链接<input value={value.websiteUrl ?? ""} onChange={event => patch({ websiteUrl: event.target.value })} placeholder="https://example.com" /></label>
    </div>
    <label className="claude-check"><input type="checkbox" checked={Boolean(value.officialLogin)} onChange={event => patch({ officialLogin: event.target.checked })} />使用 Claude 官方登录（保留当前 OAuth 行为）</label>
    <label className="claude-field">请求地址（Anthropic 风格端点）<input value={value.baseUrl ?? ""} onChange={event => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com/anthropic" /></label>
    <label className="claude-field">API Key
      <SecretField secretLabel="API Key" value={value.apiKey ?? ""} reveal={draft.id ? () => claudeWorkbenchClient.revealProvider(draft.id) : undefined} onChange={event => patch({ apiKey: event.target.value })} placeholder={draft.id ? "留空则保留已保存的密钥，点眼睛查看" : "填写供应商 API Key"} autoComplete="off" spellCheck={false} />
    </label>
    <div className="claude-field-row">
      <label className="claude-field">上游协议格式<select value={value.apiFormat} onChange={event => patch({ apiFormat: event.target.value as ClaudeApiFormat })}>{API_FORMATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="claude-field">认证字段<select value={value.apiKeyField} onChange={event => patch({ apiKeyField: event.target.value as ClaudeApiKeyField })}>{KEY_FIELDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    </div>

    {/* 模型映射 4 列：角色 / 显示名称 / 实际请求模型 / 1M 声明 */}
    <fieldset className="claude-models">
      <legend>模型映射 <Hint text={"各角色写入 env 的键：Sonnet → ANTHROPIC_DEFAULT_SONNET_MODEL，Opus → ANTHROPIC_DEFAULT_OPUS_MODEL，Haiku → ANTHROPIC_DEFAULT_HAIKU_MODEL，Fable → ANTHROPIC_DEFAULT_FABLE_MODEL，Subagent → CLAUDE_CODE_SUBAGENT_MODEL（1M 在模型 ID 末尾追加 [1M]）。" + "「一键设置」取第一个已填的实际模型作主模型，同步填到全部 5 个角色；Sonnet 是默认请求模型，建议完整填入。"} /></legend>
      <div className="claude-models-toolbar">
        <button type="button" className="secondary" disabled={busy} onClick={applyQuickPreset} title="把第一个已填的实际模型作为主模型，同步填到全部 5 个角色（cc-switch 行为）"><Wand2 size={13} aria-hidden="true" />一键设置</button>
        <button type="button" className="secondary" disabled={busy || pickerBusy || !draft.id || !hasSavedKey} onClick={() => void pullModelList()} title={
          !draft.id ? "保存后再拉取"
            : !hasSavedKey ? `请先填写 API Key 并保存再拉取（keyConfigured=${keyConfigured}）`
            : "从上游拉取模型列表，弹出多选窗口让你勾选后并入聚合模型列表"
        }>
          {pickerBusy ? <Loader2 className="is-spin" size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          获取模型列表
        </button>
        {pickerMessage && <span className="claude-models-toolbar-message">{pickerMessage}</span>}
      </div>
      <div className="claude-model-grid-head" role="row">
        <span role="columnheader">模型角色</span>
        <span role="columnheader">显示名称</span>
        <span role="columnheader">实际请求模型</span>
        <span role="columnheader">1M</span>
      </div>
      {ROLES.map(role => {
        const mapping = value.models?.[role.key] ?? { model: "" };
        return <div key={role.key} className="claude-model-row">
          <span className="claude-model-role">{role.label}</span>
          <input aria-label={`${role.label} 显示名称`} value={mapping.displayName ?? ""} onChange={event => setModel(role.key, "displayName", event.target.value)} placeholder="显示名称（可选）" />
          <ModelSelect
            ariaLabel={`${role.label} 实际模型`}
            value={mapping.model ?? ""}
            options={modelOptions}
            placeholder={modelOptions.length ? "选择聚合模型" : "请先点「获取模型列表」"}
            onChange={next => setModel(role.key, "model", next)}
          />
          <label className="claude-model-1m" title="上游支持 1M 上下文"><input type="checkbox" aria-label={`${role.label} 1M 上下文`} checked={Boolean(mapping.supports1m)} onChange={event => setModel(role.key, "supports1m", event.target.checked)} /><span>1M</span></label>
        </div>;
      })}
    </fieldset>

    {/* 默认兜底模型（仅路由/聚合生效） */}
    <fieldset className="claude-models">
      <legend>默认兜底模型 <Hint text="仅在路由或聚合模式下生效；写入 env 的 ANTHROPIC_DEFAULT_FALLBACK_MODEL。直连模式下该值不会写入 settings.json。" /></legend>
      <div className="claude-model-row">
        <span className="claude-model-role">默认</span>
        <input aria-label="默认兜底模型显示名称" value={value.fallbackModel?.displayName ?? ""} onChange={event => setFallback("displayName", event.target.value)} placeholder="显示名称（可选）" />
        <ModelSelect
          ariaLabel="默认兜底模型"
          value={value.fallbackModel?.model ?? ""}
          options={modelOptions}
          placeholder={modelOptions.length ? "选择聚合模型" : "请先点「获取模型列表」"}
          onChange={next => setFallback("model", next)}
        />
        <label className="claude-model-1m" title="上游支持 1M 上下文"><input type="checkbox" aria-label="默认兜底 1M" checked={Boolean(value.fallbackModel?.supports1m)} onChange={event => setFallback("supports1m", event.target.checked)} /><span>1M</span></label>
      </div>
    </fieldset>

    {/* 自定义 User-Agent */}
    <label className="claude-field">自定义 User-Agent <Hint text="仅在路由或聚合模式下生效；空字符串表示保留 Claude Code 默认 UA。" />
      <div className="claude-field-with-preset">
        <input value={value.userAgent ?? ""} onChange={event => patch({ userAgent: event.target.value })} placeholder="留空使用 Claude Code 默认 UA" />
        <select aria-label="User-Agent 预设" value="" onChange={event => { if (event.target.value !== "") patch({ userAgent: event.target.value }); }}>
          <option value="">预设…</option>
          {USER_AGENT_PRESETS.filter(item => item.value !== (value.userAgent ?? "")).map(item => <option key={item.label} value={item.value}>{item.label}</option>)}
        </select>
      </div>
    </label>

    {/* 本地代理请求覆盖 */}
    <fieldset className="claude-models">
      <legend>本地代理请求覆盖 <Hint text="仅在路由或聚合模式下生效。Header 合并到请求头，Body 合并到请求体。" /></legend>
      <div className="claude-field-row">
        <label className="claude-field">Header 覆盖（JSON 对象）<textarea rows={6} spellCheck={false} value={value.proxyHeaderOverride ?? ""} onChange={event => patch({ proxyHeaderOverride: event.target.value })} placeholder={'{ "X-Provider": "cc-switch" }'} /></label>
        <label className="claude-field">Body 覆盖（JSON 对象）<textarea rows={6} spellCheck={false} value={value.proxyBodyOverride ?? ""} onChange={event => patch({ proxyBodyOverride: event.target.value })} placeholder={'{ "temperature": 0.2 }'} /></label>
      </div>
    </fieldset>

    {/* 聚合模型列表 */}
    <fieldset className="claude-models">
      <legend>聚合模型列表 <Hint text="「获取模型列表」会自动追加；也可手动维护。列表会出现在聚合菜单。" /></legend>
      {(value.modelCatalog ?? []).map((item, index) => <div className="claude-catalog-row" key={index}>
        <button type="button" className="claude-icon-button" title="置为默认模型" aria-label={`置为默认模型 ${index + 1}`} aria-pressed={index === 0} disabled={busy} onClick={() => patch({ modelCatalog: [item, ...(value.modelCatalog ?? []).filter((_, i) => i !== index)] })}><Star size={13} fill={index === 0 ? "currentColor" : "none"} aria-hidden="true" /></button>
        <input aria-label={`模型 ID ${index + 1}`} value={item.model} onChange={event => setCatalogItem(index, "model", event.target.value)} placeholder="模型 ID" />
        <input aria-label={`模型名称 ${index + 1}`} value={item.displayName ?? ""} onChange={event => setCatalogItem(index, "displayName", event.target.value)} placeholder="显示名称" />
        <label className="claude-check"><input type="checkbox" aria-label={`模型 1M ${index + 1}`} checked={Boolean(item.supports1m)} onChange={event => setCatalogItem(index, "supports1m", event.target.checked)} />1M</label>
        <button type="button" className="claude-icon-button" title="移除模型" aria-label={`移除模型 ${index + 1}`} disabled={busy} onClick={() => patch({ modelCatalog: (value.modelCatalog ?? []).filter((_, i) => i !== index) })}><Trash2 size={13} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className="secondary" disabled={busy} onClick={() => patch({ modelCatalog: [...(value.modelCatalog ?? []), { model: "" }] })}><Plus size={14} aria-hidden="true" />手动添加模型</button>
    </fieldset>

    <label className="claude-field">备注<textarea rows={2} value={value.description ?? ""} onChange={event => patch({ description: event.target.value })} placeholder="仅用于本机识别，不参与设置" /></label>

    <details className="claude-advanced" onToggle={event => {
      if ((event.target as HTMLDetailsElement).open) {
        setFullConfig(JSON.stringify(value, null, 2));
      }
    }}>
      <summary>高级选项（展开配置 JSON）</summary>
      <div className="claude-advanced-content">
        <label className="claude-field">扩展环境变量（JSON 对象）<textarea rows={5} spellCheck={false} value={extraEnv} onChange={event => setExtraEnv(event.target.value)} placeholder='{ "DISABLE_INSTALLATION_CHECKS": "1" }' /></label>
        <label className="claude-field">配置 JSON（只读 / 实时同步）<textarea rows={8} spellCheck={false} value={fullConfig} onChange={event => setFullConfig(event.target.value)} /></label>
      </div>
    </details>

    {error && <p className="claude-error" role="alert">{error}</p>}
    {pickerOpen && pickerModels && <ModelPicker
      fetched={pickerModels}
      configured={value.modelCatalog ?? []}
      onApply={applyPickerSelection}
      onClose={() => { setPickerOpen(false); setPickerModels(null); }}
    />}
  </SharedDialog>;
}

/**
 * 与 cc-switch FetchedModelPicker 语义一致的可搜索多选弹层。
 * - 初始勾选状态取自 `configured`（即当前 modelCatalog）
 * - 用户可勾选新增或取消已添加
 * - 「应用」回调 onApply(add, remove)，由调用方写入 modelCatalog
 *
 * 弹层壳子用 `SharedDialog`：自动拿到 inert 隔离、ESC 关闭、Tab 焦点陷阱、aria-modal
 * 与 `应用/取消` footer，Editor 之外不要重复造 modal-backdrop。
 */
function ModelPicker({
  fetched, configured, onApply, onClose,
}: {
  fetched: ClaudeModelMapping[];
  configured: ClaudeModelMapping[];
  onApply: (add: string[], remove: string[]) => void;
  onClose: () => void;
}) {
  const configuredIds = useMemo(
    () => configured.map(item => item.model.trim()).filter(Boolean),
    [configured],
  );
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(configuredIds));

  const fetchedIds = useMemo(() => new Set(fetched.map(item => item.model)), [fetched]);
  const extraIds = useMemo(() => configuredIds.filter(id => !fetchedIds.has(id)), [configuredIds, fetchedIds]);
  const allIds = useMemo(() => [...extraIds, ...fetched.map(item => item.model)], [extraIds, fetched]);
  const normalized = query.trim().toLowerCase();
  const matches = (id: string) => (!onlySelected || draft.has(id)) && (!normalized || id.toLowerCase().includes(normalized));
  const visibleExtra = extraIds.filter(matches);
  const visibleFetched = fetched.filter(item => matches(item.model));
  const visibleIds = useMemo(() => [...visibleExtra, ...visibleFetched.map(item => item.model)], [visibleExtra, visibleFetched]);
  const selectedCount = allIds.filter(id => draft.has(id)).length;

  const setChecked = (ids: string[], checked: boolean) => setDraft(prev => {
    const next = new Set(prev);
    for (const id of ids) checked ? next.add(id) : next.delete(id);
    return next;
  });

  const apply = () => {
    const configuredSet = new Set(configuredIds);
    const add = fetched.map(item => item.model).filter(id => draft.has(id) && !configuredSet.has(id));
    const remove = configuredIds.filter(id => !draft.has(id));
    onApply(add, remove);
  };

  return <SharedDialog
    title="选择模型"
    subtitle="勾选要加入「聚合模型列表」的项，已在列表中的项会预选并允许取消。"
    icon={<ListChecks size={20} aria-hidden="true" />}
    size="small"
    onClose={onClose}
    className="claude-model-picker-dialog"
    bodyClassName="claude-model-picker"
    footer={<>
      <button type="button" className="secondary" onClick={onClose}>取消</button>
      <button type="button" className="primary" onClick={apply}>应用</button>
    </>}
  >
    <div className="claude-models-toolbar">
      <input
        type="search"
        className="claude-picker-search"
        aria-label="搜索模型"
        placeholder="搜索模型 ID"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
        autoFocus
      />
      <button type="button" className="secondary" disabled={!visibleIds.length} onClick={() => setChecked(visibleIds, true)}>全选</button>
      <button type="button" className="secondary" disabled={!visibleIds.length} onClick={() => setChecked(visibleIds, false)}>全不选</button>
      <label className="claude-check"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} />仅看已选</label>
    </div>
    <p className="claude-models-toolbar-message" role="status">已选 {selectedCount} / {allIds.length} 个</p>
    <ul className="claude-picker-list">
      {visibleExtra.length > 0 && <li className="claude-picker-group">已配置（不在本批上游返回）</li>}
      {visibleExtra.map(id => <li key={`extra-${id}`} className="claude-picker-item">
        <label className="claude-check">
          <input type="checkbox" checked={draft.has(id)} onChange={event => setChecked([id], event.target.checked)} />
          <code>{id}</code>
        </label>
      </li>)}
      {visibleFetched.length > 0 && <li className="claude-picker-group">上游返回</li>}
      {visibleFetched.map(item => <li key={`fetched-${item.model}`} className="claude-picker-item">
        <label className="claude-check">
          <input type="checkbox" checked={draft.has(item.model)} onChange={event => setChecked([item.model], event.target.checked)} />
          <span className="claude-picker-item-body">
            <code>{item.model}</code>
            {item.displayName && item.displayName !== item.model && <small className="claude-picker-item-sub">{item.displayName}</small>}
          </span>
        </label>
      </li>)}
      {!visibleIds.length && <li className="claude-picker-empty">没有匹配的模型</li>}
    </ul>
  </SharedDialog>;
}

/**
 * 「实际请求模型」下拉选择。选项来自 `modelCatalog`；当前值不在选项里时会原样保留并
 * 标为「自定义 ...」让用户知道这是手动值，可重新选择覆盖。
 */
function ModelSelect({
  value, options, onChange, ariaLabel, placeholder,
}: {
  value: string;
  options: { model: string; displayName?: string }[];
  onChange: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const trimmed = value.trim();
  const inOptions = trimmed && options.some(item => item.model === trimmed);
  return <select
    aria-label={ariaLabel}
    className="claude-model-select"
    value={trimmed}
    onChange={event => onChange(event.target.value)}
  >
    {!trimmed && <option value="">{placeholder ?? "选择模型"}</option>}
    {trimmed && !inOptions && <option value={trimmed}>自定义：{trimmed}</option>}
    {options.map(item => <option key={item.model} value={item.model}>
      {item.displayName && item.displayName !== item.model ? `${item.displayName}（${item.model}）` : item.model}
    </option>)}
  </select>;
}

function providerAccent(seed: string): { color: string; letter: string } {
  const trimmed = seed.trim() || "?";
  let hash = 0;
  for (let index = 0; index < trimmed.length; index += 1) hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  const hue = hash % 360;
  const letter = /[A-Za-z0-9]/.test(trimmed) ? trimmed[0].toUpperCase() : "?";
  return { color: `hsl(${hue}, 55%, 42%)`, letter };
}

/** 当前 5 小时窗口期内某供应商的累计请求与 token。 */
function windowedUsage(logs: ClaudeRoutingState["logs"], providerId: string) {
  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  const scoped = logs.filter(log => log.providerId === providerId && log.timestamp >= cutoff);
  let tokens = 0;
  for (const log of scoped) tokens += log.inputTokens + log.outputTokens + log.cacheReadTokens;
  return { requests: scoped.length, tokens };
}

/**
 * 5 小时窗口倒计时与剩余百分比。窗口起点取该 providerId 在近 5h 内的最早一条请求时间戳；
 * 截止 = 起点 + 5h。所有数据来自真实 routing 日志，不引入假数据。logs 为空或已重置时返回 null。
 */
function windowedCountdown(logs: ClaudeRoutingState["logs"], providerId: string) {
  const now = Date.now();
  const windowMs = 5 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  let earliest = Number.POSITIVE_INFINITY;
  for (const log of logs) {
    if (log.providerId !== providerId) continue;
    if (log.timestamp < cutoff) continue;
    if (log.timestamp < earliest) earliest = log.timestamp;
  }
  if (!Number.isFinite(earliest)) return null;
  const deadline = earliest + windowMs;
  const remainingMs = Math.max(0, deadline - now);
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = remainingMs <= 0 ? "重置中" : hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
  return { label, percent: Math.round((remainingMs / windowMs) * 100), remainingMs };
}

export function ClaudeProvidersPlugin() {
  const [providers, setProviders] = useState<ClaudeProviderSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState("");
  const [settingsExists, setSettingsExists] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [workspace, setWorkspace] = useState<ClaudeWorkspaceState["project"] | null>(null);
  const [editing, setEditing] = useState<ClaudeProviderInput | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [routing, setRouting] = useState<ClaudeRoutingState>({ mode: "direct", running: false, address: null, config: DEFAULT_CLAUDE_ROUTING, health: {}, logs: [], activeProvider: "", recoveryAvailable: false });
  const [viewMode, setViewMode] = useState<ClaudeMode>("direct");
  const [tab, setTab] = useState<"providers" | "usage" | "mcp" | "prompts" | "skills" | "sessions" | "config">("providers");
  const [keyword, setKeyword] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => Promise<unknown> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const confirm = (text: string, action: () => Promise<unknown>) => { setConfirmError(""); setConfirmation({ message: text, action }); };
  const refreshRouting = useCallback(async () => {
    const state = await claudeWorkbenchClient.state();
    if (state && !Array.isArray(state) && state.config) setRouting(state);
  }, []);
  const refreshWorkspace = useCallback(async () => {
    try {
      const next = await claudeWorkbenchClient.workspace();
      if (next && next.settingsPath !== undefined) setWorkspace(next.project);
    } catch { /* 仅展示信息，失败可忽略 */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await claudeProvidersClient.list();
      setProviders(list.providers);
      setCurrentId(list.currentId);
      setSettingsPath(list.settingsPath);
      setSettingsExists(list.settingsExists);
      setHasBackup(list.hasBackup);
      setError("");
      await Promise.all([refreshRouting(), refreshWorkspace()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取供应商失败");
    }
  }, [refreshRouting, refreshWorkspace]);

  useEffect(() => { void load(); }, [load]);
  // 直连模式下没有 3s 路由轮询，单独驱动一次每分钟刷新以保持 5h 倒计时实时。
  useEffect(() => {
    if (routing.running) return;
    const tick = window.setInterval(() => setProviders((current) => [...current]), 60000);
    return () => window.clearInterval(tick);
  }, [routing.running]);
  useEffect(() => {
    if (!routing.running) return;
    const timer = window.setInterval(() => { void refreshRouting().catch(() => {}); }, 3000);
    return () => window.clearInterval(timer);
  }, [routing.running, refreshRouting]);

  const toInput = (item: ClaudeProviderSummary): ClaudeProviderInput => ({
    id: item.id, name: item.name, description: item.description, websiteUrl: item.websiteUrl,
    baseUrl: item.baseUrl, apiKey: "", apiKeyField: item.apiKeyField, apiFormat: item.apiFormat,
    isFullUrl: item.isFullUrl, models: item.models, extraEnv: item.extraEnv,
    officialLogin: item.officialLogin, modelCatalog: item.modelCatalog,
    // 不复制就丢失：list 接口不传密钥但这 4 个非敏感字段每次编辑都要回填，
    // 否则用户填过的 User-Agent / Header 覆盖 / Body 覆盖 / 默认兜底模型会被静默清空。
    userAgent: item.userAgent ?? "",
    proxyHeaderOverride: item.proxyHeaderOverride ?? "",
    proxyBodyOverride: item.proxyBodyOverride ?? "",
    fallbackModel: item.fallbackModel ?? null,
  });

  const run = async (id: string, action: () => Promise<unknown>, done: string) => {
    if (busyId) return;
    setBusyId(id); setError("");
    try {
      await action();
      if (done) setMessage(done);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally { setBusyId(""); }
  };

  const current = useMemo(() => providers.find(item => item.id === currentId) ?? null, [providers, currentId]);
  const shown = providers.filter(item => `${item.name} ${item.baseUrl} ${item.description}`.toLowerCase().includes(keyword.toLowerCase()));
  const config = routing.config;
  const scopeLabel = workspace ? `项目 ${workspace}` : "用户全局";
  const saveConfig = async (next: ClaudeRoutingConfig) => { await claudeWorkbenchClient.saveRouting(next); await refreshRouting(); };
  const activate = (mode: ClaudeMode) => confirm(mode === "direct" ? "停止本地路由并恢复直连配置？" : `启用${mode === "route" ? "路由" : "聚合"}并接管当前 Claude Code 连接配置？`, async () => {
    await claudeWorkbenchClient.activate(mode); await load();
  });
  const moveQueue = (id: string, offset: number) => {
    const queue = [...config.queue], index = queue.indexOf(id), next = index + offset;
    if (index < 0 || next < 0 || next >= queue.length) return;
    [queue[index], queue[next]] = [queue[next], queue[index]];
    void run("queue", () => saveConfig({ ...config, queue }), "已更新故障转移顺序");
  };
  const changeScope = async (clear: boolean) => {
    try {
      await claudeWorkbenchClient.chooseProject(clear);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "切换作用域失败"); }
  };

  return <section className="claude-providers">
    <ModeBar view={viewMode} state={routing} currentName={current?.name} scopeLabel={scopeLabel} addressFallback={settingsPath} onView={mode => { setViewMode(mode); setTab("providers"); }} onActivate={activate} onSettings={() => setSettingsOpen(true)} disabled={Boolean(busyId)} />
    <nav className="claude-work-tabs" aria-label="Claude Code 工作台">
      {([["providers", "供应商"], ["usage", "用量"], ["mcp", "MCP"], ["prompts", "提示词"], ["skills", "技能"], ["sessions", "会话"], ["config", "配置"]] as const).map(([id, label]) =>
        <button type="button" key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {(message || error) && <p className={`claude-status${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || message}</p>}
    {routing.recoveryAvailable && !routing.running && <div className="claude-status is-error">检测到待恢复的连接配置<button type="button" className="secondary" onClick={() => activate("direct")}>恢复直连配置</button></div>}
    {tab === "usage" && <UsagePanel state={routing} providers={providers} onClear={() => confirm("清空当前请求记录？", async () => { await claudeWorkbenchClient.clearLogs(); await refreshRouting(); })} />}
    {tab !== "providers" && tab !== "usage" && <ClaudeWorkspacePanel key={tab} view={tab} confirm={confirm} onScopeChanged={load} />}
    {tab === "providers" && <>
    <header className="claude-providers-head">
      <label className="claude-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索供应商" placeholder="搜索供应商" value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
      <div className="claude-providers-actions">
        {hasBackup && <button type="button" className="secondary" disabled={Boolean(busyId)} onClick={() => void run("backup", () => claudeProvidersClient.restoreBackup(), "已恢复到上一份配置")}><RotateCcw size={14} aria-hidden="true" />恢复上一份</button>}
        <button type="button" className="secondary" disabled={Boolean(busyId) || routing.running} onClick={() => void run("import", () => claudeWorkbenchClient.providerAction({ type: "import_current" }), "已导入当前配置")}><Download size={14} />导入当前</button>
        <button type="button" className="primary" onClick={() => setEditing(emptyProvider())}><Plus size={14} aria-hidden="true" />添加供应商</button>
      </div>
    </header>

    <div className="claude-status-bar">
      <span className={settingsExists ? "is-ok" : "is-muted"}>
        <Server size={13} aria-hidden="true" />
        {settingsExists ? <>配置文件 <code>{settingsPath}</code></> : <>尚未找到 Claude Code 配置，切换后会创建 <code>{settingsPath}</code></>}
      </span>
      {workspace
        ? <span className="claude-current"><FolderOpen size={13} aria-hidden="true" />项目 {workspace}</span>
        : <span className="claude-current"><FolderOpen size={13} aria-hidden="true" />用户全局</span>}
      <span className="claude-status-bar-actions">
        <button type="button" className="secondary" disabled={Boolean(busyId) || routing.running} onClick={() => void changeScope(false)}>选择项目</button>
        <button type="button" className="secondary" disabled={Boolean(busyId) || !workspace || routing.running} onClick={() => void changeScope(true)}>不使用项目</button>
      </span>
    </div>

    {viewMode === "route" && <div className="claude-routing-options">
      <label className="claude-field">路由供应商<select aria-label="路由供应商" value={config.routeProvider} disabled={Boolean(busyId)} onChange={e => void run("target", () => saveConfig({ ...config, routeProvider: e.target.value }), "已更新路由目标")}><option value="">选择供应商</option>{providers.filter(p => !p.officialLogin && p.keyConfigured).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="claude-check"><input type="checkbox" checked={config.failover} disabled={Boolean(busyId)} onChange={e => void run("failover", () => saveConfig({ ...config, failover: e.target.checked }), "已更新故障转移设置")} />自动故障转移</label>
      {config.failover && <ol className="claude-queue">{config.queue.map((id, index) => <li key={id}><span>{providers.find(p => p.id === id)?.name ?? id}</span><button type="button" className="claude-icon-button" aria-label={`上移队列 ${id}`} title="上移" disabled={Boolean(busyId) || index === 0} onClick={() => moveQueue(id, -1)}><ArrowUp size={13} /></button><button type="button" className="claude-icon-button" aria-label={`下移队列 ${id}`} title="下移" disabled={Boolean(busyId) || index === config.queue.length - 1} onClick={() => moveQueue(id, 1)}><ArrowDown size={13} /></button></li>)}</ol>}
    </div>}
    {viewMode === "aggregate" && <label className="claude-field">默认供应商<select aria-label="默认供应商" value={config.defaultProvider} disabled={Boolean(busyId)} onChange={e => void run("default", () => saveConfig({ ...config, defaultProvider: e.target.value }), "已更新默认供应商")}><option value="">选择默认供应商</option>{providers.filter(p => !p.officialLogin && p.keyConfigured).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}

    {providers.length === 0 ? <div className="claude-empty">
      <Server size={26} aria-hidden="true" />
      <strong>还没有供应商</strong>
      <p>添加一个供应商，填写请求地址与 API Key 后即可一键切换。</p>
    </div> : <ul className="claude-provider-list">
      {shown.map(item => {
        const accent = providerAccent(item.websiteUrl || item.baseUrl || item.name);
        const needsRouting = !item.officialLogin && item.apiFormat !== "anthropic";
        const usage = windowedUsage(routing.logs, item.id);
        const usageMax = 100;
        const usagePercent = Math.min(100, usage.tokens === 0 ? 0 : Math.max(8, Math.round((usage.tokens / usageMax) * 100)));
        const countdown = windowedCountdown(routing.logs, item.id);
        const isCurrent = item.id === currentId;
        return <li key={item.id} className={`claude-provider-item${isCurrent ? " is-current" : ""}`}>
          <div className="claude-provider-main">
            <div className="claude-provider-title">
              <span className="claude-provider-logo" aria-hidden="true" style={{ background: accent.color }}>{accent.letter}</span>
              <strong>{item.name}</strong>
              {isCurrent && viewMode === "direct" && !routing.running && <span className="claude-tag is-current"><span className="claude-live-dot" aria-hidden="true" />使用中</span>}
              {!item.keyConfigured && !item.officialLogin && <span className="claude-tag is-warning">缺少 Key</span>}
              {item.officialLogin && <span className="claude-tag">官方登录</span>}
              {needsRouting && <span className="claude-tag is-warning">需要路由</span>}
              {routing.health[item.id]?.openUntil && routing.health[item.id].openUntil! > Date.now() && <span className="claude-tag is-warning">熔断中</span>}
            </div>
            <code className="claude-provider-url">{item.baseUrl || "未填写请求地址"}</code>
            <div className="claude-provider-meta">
              {item.apiFormat !== "anthropic" && <span>{API_FORMATS.find(format => format.value === item.apiFormat)?.label}</span>}
              {Object.entries(item.models ?? {}).slice(0, 3).map(([role, mapping]) => <span key={role} className="claude-model-chip">{role}: {mapping.model}</span>)}
            </div>
            {(isCurrent || usage.requests > 0) && <div className="claude-provider-usage" title={`最近 5 小时累计：${usage.requests} 次，${usage.tokens.toLocaleString()} tokens`}>
              <div className="claude-provider-usage-bar"><span style={{ width: `${usagePercent}%` }} /></div>
              <span className="claude-provider-usage-label">5 小时用量 {usage.requests} 次 / {usage.tokens.toLocaleString()} tokens</span>
            </div>}
            {countdown && isCurrent && viewMode === "direct" && !routing.running && <div className="claude-provider-countdown" title={`5 小时窗口剩余 ${countdown.percent}%，按 logs 最早一条时间戳计算`}>
              <span className="claude-provider-countdown-label">5 小时剩余 {countdown.percent}%</span>
              <span className="claude-provider-countdown-timer" aria-live="polite">⏱ {countdown.label}</span>
            </div>}
          </div>
          <div className="claude-provider-actions">
            {viewMode === "direct" && <button type="button" className="claude-icon-button is-primary" aria-label={`${isCurrent && !routing.running ? "启动" : "切换并启动"} ${item.name}`} title={needsRouting ? "此供应商需要路由或聚合模式" : !item.keyConfigured && !item.officialLogin ? "请先填写 API Key" : isCurrent && !routing.running ? "启动 Claude Code CLI" : "切换供应商并启动 Claude Code CLI"} disabled={Boolean(busyId) || needsRouting || (!item.keyConfigured && !item.officialLogin)} onClick={() => confirm(`启动 Claude Code 并使用“${item.name}”的配置？${!isCurrent || routing.running ? "将先切换到此供应商的直连配置，切换前自动备份。" : ""}`, async () => {
              if (!isCurrent || routing.running) {
                await claudeProvidersClient.switchTo(item.id);
                await load();
              }
              await claudeWorkbenchClient.launchCli(item.id);
              setMessage(`已请求启动 Claude Code，供应商：${item.name}`);
            })}><Play size={13} aria-hidden="true" /></button>}
            {viewMode === "direct" && <button type="button" className="secondary" disabled={Boolean(busyId) || (isCurrent && !routing.running) || needsRouting} onClick={() => void run(item.id, () => claudeProvidersClient.switchTo(item.id), `已切换到 ${item.name}，重启 Claude Code 后生效`)}><Check size={13} aria-hidden="true" />切换</button>}
            {viewMode === "route" && <button type="button" className="secondary" disabled={Boolean(busyId) || item.officialLogin || !item.keyConfigured} onClick={() => void run(item.id, () => saveConfig({ ...config, queue: config.queue.includes(item.id) ? config.queue.filter(id => id !== item.id) : [...config.queue, item.id] }), "已更新故障转移队列")}>{config.queue.includes(item.id) ? "移出队列" : "加入队列"}</button>}
            {viewMode === "aggregate" && <button type="button" className="secondary" disabled={Boolean(busyId) || item.officialLogin || !item.keyConfigured || item.id === config.defaultProvider} onClick={() => void run(item.id, () => saveConfig({ ...config, members: config.members.includes(item.id) ? config.members.filter(id => id !== item.id) : [...config.members, item.id] }), "已更新聚合名单")}>{item.id === config.defaultProvider ? "默认" : config.members.includes(item.id) ? "移出聚合" : "加入聚合"}</button>}
            <button type="button" className="secondary" aria-label={`编辑 ${item.name}`} onClick={() => setEditing(toInput(item))}><Pencil size={13} aria-hidden="true" />编辑</button>
            <button type="button" className="claude-icon-button" aria-label={`复制 ${item.name}`} title="复制供应商" disabled={Boolean(busyId)} onClick={() => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "duplicate", id: item.id }), "已复制供应商")}><Copy size={13} /></button>
            <button type="button" className="claude-icon-button" aria-label={`检测 ${item.name}`} title="连接检测" disabled={Boolean(busyId)} onClick={() => void run(item.id, async () => { const result = await claudeWorkbenchClient.probe(item.id); if (!result.reachable) throw new Error("无法连接供应商地址"); setMessage(`连接成功，${result.latencyMs} ms，HTTP ${result.status}`); }, "")}><Wifi size={13} /></button>
            <button type="button" className="claude-icon-button" aria-label={`上移 ${item.name}`} title="上移供应商" disabled={Boolean(busyId) || providers[0]?.id === item.id} onClick={() => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "move", id: item.id, offset: -1 }), "已更新排序")}><ArrowUp size={13} /></button>
            <button type="button" className="claude-icon-button" aria-label={`下移 ${item.name}`} title="下移供应商" disabled={Boolean(busyId) || providers[providers.length - 1]?.id === item.id} onClick={() => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "move", id: item.id, offset: 1 }), "已更新排序")}><ArrowDown size={13} /></button>
            {item.websiteUrl && /^https?:\/\//i.test(item.websiteUrl) && <a className="secondary claude-icon-button" href={item.websiteUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${item.name} 官网`} title="打开官网"><ExternalLink size={13} aria-hidden="true" /></a>}
            <button type="button" className="secondary claude-icon-button is-danger" aria-label={`删除 ${item.name}`} title="删除供应商" disabled={Boolean(busyId) || isCurrent} onClick={() => confirm(`确定删除供应商“${item.name}”吗？`, async () => { await claudeProvidersClient.remove(item.id); await load(); })}><Trash2 size={13} aria-hidden="true" /></button>
          </div>
        </li>;
      })}
    </ul>}
    {!!providers.length && !shown.length && <p role="status" className="claude-empty-line">没有符合条件的供应商</p>}
    </>}

    {editing && (() => {
      const editingSummary = providers.find(p => p.id === editing.id);
      return <Editor draft={editing} keyConfigured={Boolean(editingSummary?.keyConfigured)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setMessage("供应商已保存"); void load(); }} />;
    })()}
    {settingsOpen && <RoutingSettings config={config} onClose={() => setSettingsOpen(false)} onSave={saveConfig} />}
    {confirmation && createPortal(<ConfirmDialog message={confirmation.message} busy={confirmBusy} error={confirmError} onResolve={accepted => {
      if (confirmBusy) return;
      if (!accepted) { setConfirmation(null); return; }
      setConfirmBusy(true);
      void confirmation.action().then(() => setConfirmation(null)).catch(reason => setConfirmError(reason instanceof Error ? reason.message : "操作失败")).finally(() => setConfirmBusy(false));
    }} />, document.body)}
  </section>;
}
