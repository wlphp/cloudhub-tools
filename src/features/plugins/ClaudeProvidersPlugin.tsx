import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, Copy, Download, ExternalLink, FolderOpen, HelpCircle, ListChecks, Loader2, Minus, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Server, Star, Trash2, Wand2, Wifi } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { runningInTauri } from "../../platform/api";
import { MoreMenu } from "../../shared/MoreMenu";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { claudeProvidersClient, claudeWorkbenchClient, DEFAULT_CLAUDE_ROUTING, type ClaudeMode, type ClaudeRoutingState, type ClaudeRoutingConfig, type ClaudeModelMapping, type ClaudeApiFormat, type ClaudeApiKeyField, type ClaudeProviderInput, type ClaudeProviderSummary, type ClaudeProviderList, type ClaudeWorkspaceState } from "../../platform/clients/claudeProviders";
import { AggregateStartDialog, ModeBar, providerModelCount, RoutingSettings, UsagePanel } from "./ClaudeRoutingPanels";
import { ClaudeWorkspacePanel } from "./ClaudeWorkspacePanel";
import { ClaudeProviderPresetPicker } from "./ClaudeProviderPresetPicker";
import { ClaudeProviderUsage } from "./ClaudeProviderUsage";
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
  const canQueryModels = !value.officialLogin && Boolean(value.baseUrl?.trim()) && (hasSavedKey || Boolean(value.apiKey?.trim()));

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
    if (!canQueryModels) { setPickerMessage("请填写请求地址与 API Key"); return; }
    setPickerBusy(true); setPickerMessage(""); setError("");
    try {
      const available = await claudeWorkbenchClient.models(draft.id, { ...value, apiKey: value.apiKey ?? "" });
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
        <button type="button" className="secondary" disabled={busy} onClick={applyQuickPreset} title="把第一个已填的实际模型作为主模型，同步填到全部 5 个角色"><Wand2 size={13} aria-hidden="true" />一键设置</button>
        <button type="button" className="secondary" disabled={busy || pickerBusy || !canQueryModels} onClick={() => void pullModelList()} title={
          !canQueryModels ? "请填写请求地址与 API Key，官方登录不支持查询模型列表"
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
        <label className="claude-field">Header 覆盖（JSON 对象）<textarea rows={6} spellCheck={false} value={value.proxyHeaderOverride ?? ""} onChange={event => patch({ proxyHeaderOverride: event.target.value })} placeholder={'{ "X-Provider": "cloudhub-tools" }'} /></label>
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

export function ClaudeProvidersPlugin() {
  const balanceGeneration = useRef(0);
  useEffect(() => () => { balanceGeneration.current += 1; }, []);
  const [usageRevision, setUsageRevision] = useState(0);
  const [quotas, setQuotas] = useState<Record<string, { data?: Awaited<ReturnType<typeof claudeWorkbenchClient.quota>>; error?: string; loading?: boolean }>>({});
  const supportsQuota = (item: ClaudeProviderSummary) => {
    try { const url = new URL(item.baseUrl ?? ""); return !item.officialLogin && item.keyConfigured && ["https://api.minimaxi.com", "https://api.minimax.io", "https://api.minimax.cn"].includes(url.origin) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  };
  const refreshQuota = async (id: string) => {
    const generation = balanceGeneration.current;
    setQuotas(current => ({ ...current, [id]: { loading: true } }));
    try { const data = await claudeWorkbenchClient.quota(id); if (generation === balanceGeneration.current) setQuotas(current => ({ ...current, [id]: { data } })); }
    catch (reason) { if (generation === balanceGeneration.current) setQuotas(current => ({ ...current, [id]: { error: reason instanceof Error ? reason.message : "官方额度查询失败" } })); }
  };
  const [providers, setProviders] = useState<ClaudeProviderSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState("");
  const [settingsExists, setSettingsExists] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [backups, setBackups] = useState<NonNullable<ClaudeProviderList["backups"]>>([]);
  const [backupHistoryOpen, setBackupHistoryOpen] = useState(false);
  const [configurationStatus, setConfigurationStatus] = useState<ClaudeProviderList["configurationStatus"]>(null);
  const [workspace, setWorkspace] = useState<ClaudeWorkspaceState["project"] | null>(null);
  const [editing, setEditing] = useState<ClaudeProviderInput | null>(null);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [routing, setRouting] = useState<ClaudeRoutingState>({ mode: "direct", running: false, address: null, config: DEFAULT_CLAUDE_ROUTING, health: {}, logs: [], activeProvider: "", recoveryAvailable: false });
  const [viewMode, setViewMode] = useState<ClaudeMode>("direct");
  const [tab, setTab] = useState<"providers" | "usage" | "mcp" | "prompts" | "skills" | "sessions" | "config">("providers");
  const [keyword, setKeyword] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aggregateStartOpen, setAggregateStartOpen] = useState(false);
  const [routeStartOpen, setRouteStartOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState("");
  const [routeStartBusy, setRouteStartBusy] = useState(false);
  const [routeStartError, setRouteStartError] = useState("");
  const [quotaProviderId, setQuotaProviderId] = useState<string | null>(null);
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set());
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [showConfigDescription, setShowConfigDescription] = useState(false);
  const [importPreview, setImportPreview] = useState<Awaited<ReturnType<typeof claudeWorkbenchClient.prepareProviderImport>>>(null);
  const [importSelection, setImportSelection] = useState<Set<number>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const closeImport = () => { setImportPreview(null); void claudeWorkbenchClient.cancelProviderImport().catch(() => {}); };
  const [configPreview, setConfigPreview] = useState<{ path: string; document: unknown } | null>(null);
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

  const applyList = useCallback((list: ClaudeProviderList) => {
    setProviders(list.providers);
    setCurrentId(list.currentId);
    setSettingsPath(list.settingsPath);
    setSettingsExists(list.settingsExists);
    setHasBackup(list.hasBackup);
    setBackups(list.backups ?? []);
    setConfigurationStatus(list.configurationStatus);
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await claudeProvidersClient.list();
      applyList(list);
      // 额度查询独立于列表加载，失败不会阻塞供应商管理。
      ++balanceGeneration.current;
      setUsageRevision(current => current + 1);
      setQuotas({});
      setError("");
      await Promise.all([refreshRouting(), refreshWorkspace()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取供应商失败");
    }
  }, [applyList, refreshRouting, refreshWorkspace]);

  useEffect(() => { void load(); }, [load]);
  // 只读核对；返回窗口和可见时定期刷新，不重置余额或写入真实配置。
  useEffect(() => {
    if (busyId || routing.running) return;
    let disposed = false;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const list = await claudeProvidersClient.list();
        if (!disposed) applyList(list);
      } catch { /* 手动刷新保留完整错误提示；暂时失败不改写配置。 */ }
      finally { pending = false; }
    };
    const timer = window.setInterval(() => void check(), 5000);
    const onVisible = () => { void check(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", onVisible); document.removeEventListener("visibilitychange", onVisible); };
  }, [applyList, busyId, routing.running, settingsPath]);
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
  const routeProviders = providers.filter(item => !item.officialLogin && item.keyConfigured);
  const aggregateDefault = config.defaultProvider || routeProviders.find(item => item.id === currentId && providerModelCount(item) > 0)?.id || routeProviders.find(item => providerModelCount(item) > 0)?.id || "";
  const aggregateGroup = (item: ClaudeProviderSummary) => item.id === aggregateDefault ? 0 : config.members.includes(item.id) ? 1 : 2;
  const queueRank = (item: ClaudeProviderSummary) => config.queue.includes(item.id) ? config.queue.indexOf(item.id) : Number.MAX_SAFE_INTEGER;
  const displayed = viewMode === "aggregate" ? [...shown].sort((a, b) => aggregateGroup(a) - aggregateGroup(b)) : viewMode === "route" ? [...shown].sort((a, b) => queueRank(a) - queueRank(b)) : shown;
  const scopeLabel = workspace ? `项目 ${workspace}` : "用户全局";
  const saveConfig = async (next: ClaudeRoutingConfig) => { await claudeWorkbenchClient.saveRouting(next); await refreshRouting(); };
  const toggleFailover = (enabled: boolean) => {
    const target = routeProviders.find(item => item.id === config.routeProvider)?.id || routeProviders[0]?.id || "";
    const queue = config.queue.length ? config.queue : target ? [target] : [];
    if (enabled && !queue.length) { setError("请先添加已配置 API Key 的供应商"); return; }
    void run("failover", () => saveConfig({ ...config, failover: enabled, queue, routeProvider: config.routeProvider || target }), "已更新故障转移设置");
  };
  const toggleQueue = (id: string) => {
    const queue = config.queue.includes(id) ? config.queue.filter(value => value !== id) : [...config.queue, id];
    void run("queue", () => saveConfig({ ...config, queue, routeProvider: config.routeProvider || queue[0] || "" }), "已更新路由队列");
  };
  const activate = (mode: ClaudeMode) => {
    if (mode === "aggregate") { setAggregateStartOpen(true); return; }
    if (mode === "route") {
      const eligible = providers.filter(p => !p.officialLogin && p.keyConfigured);
      setRouteTarget(eligible.find(p => p.id === config.routeProvider)?.id ?? eligible.find(p => p.id === currentId)?.id ?? eligible[0]?.id ?? "");
      setRouteStartError(""); setRouteStartOpen(true); return;
    }
    confirm(mode === "direct" ? "停止本地路由并恢复直连配置？" : "启用聚合并接管当前 Claude Code 连接配置？", async () => {
      await claudeWorkbenchClient.activate(mode); await load();
    });
  };
  const moveQueue = (id: string, offset: number) => {
    const queue = [...config.queue], index = queue.indexOf(id), next = index + offset;
    if (index < 0 || next < 0 || next >= queue.length) return;
    [queue[index], queue[next]] = [queue[next], queue[index]];
    void run("queue", () => saveConfig({ ...config, queue }), "已更新故障转移顺序");
  };
  const changeScope = async (clear: boolean) => {
    await run("scope", () => claudeWorkbenchClient.chooseProject(clear), "");
  };

  return <section className="claude-providers">
    <ModeBar providers={providers} view={viewMode} state={routing} currentName={current?.name} directConfigurationIssue={Boolean(currentId) && !routing.running && ["changed", "missing", "unreadable"].includes(configurationStatus ?? "")} activeName={providers.find(item => item.id === routing.activeProvider)?.name} scopeLabel={scopeLabel} addressFallback={settingsPath} onView={mode => { setViewMode(mode); setTab("providers"); }} onActivate={activate} onSettings={() => setSettingsOpen(true)} onFailover={toggleFailover} disabled={Boolean(busyId) || routeStartBusy} />
    <nav className="claude-work-tabs" aria-label="Claude Code 工作台">
      {([["providers", "供应商"], ["usage", "用量"], ["mcp", "MCP"], ["prompts", "提示词"], ["skills", "技能"], ["sessions", "会话"], ["config", "配置"]] as const).map(([id, label]) =>
        <button type="button" key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {(message || error) && <p className={`claude-status${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || message}</p>}
    {routing.recoveryAvailable && !routing.running && <div className="claude-status is-error">检测到待恢复的连接配置<button type="button" className="secondary" onClick={() => activate("direct")}>恢复直连配置</button></div>}
    {tab === "usage" && <UsagePanel state={routing} providers={providers} onClear={() => confirm("清空当前请求记录？", async () => { await claudeWorkbenchClient.clearLogs(); await refreshRouting(); })} />}
    {tab !== "providers" && tab !== "usage" && <ClaudeWorkspacePanel key={tab} view={tab} confirm={confirm} onScopeChanged={load} />}
    {tab === "providers" && <>

    <div className="claude-status-bar claude-config-panel">
      <div className="claude-config-source">
      <span className={settingsExists ? "is-ok" : "is-muted"}>
        <Server size={13} aria-hidden="true" />
        {settingsExists ? <>配置文件 <code>{settingsPath}</code></> : <>尚未找到 Claude Code 配置，切换后会创建 <code>{settingsPath}</code></>}
      </span>
      <span className="claude-status-bar-actions">
        <button type="button" className="secondary" disabled={Boolean(busyId) || !settingsExists} onClick={() => void run("preview-config", async () => { setConfigPreview(await claudeProvidersClient.previewSettings()); }, "")} title="只读预览完整配置文件，包含明文密钥">预览配置</button>
        <button type="button" className="secondary" disabled={Boolean(busyId) || routing.running || !settingsExists} onClick={() => void run("import", () => claudeWorkbenchClient.providerAction({ type: "import_current" }), "已导入当前配置")} title="读取左侧配置文件中的请求地址、Key 和模型映射，保存到供应商列表"><Download size={13} aria-hidden="true" />从当前文件导入</button>
      </span>
      </div>
      {workspace
        ? <span className="claude-current"><FolderOpen size={13} aria-hidden="true" />项目 {workspace}</span>
        : <span className="claude-current"><FolderOpen size={13} aria-hidden="true" />用户全局</span>}
      <span className="claude-status-bar-actions">
        {hasBackup && (runningInTauri
          ? <button type="button" disabled={Boolean(busyId)} onClick={() => setBackupHistoryOpen(true)} title="查看并恢复任意历史配置备份"><RotateCcw size={13} aria-hidden="true" />历史备份（{backups.length}）</button>
          : <button type="button" disabled={Boolean(busyId)} onClick={() => confirm("恢复上一份 Claude Code 配置？当前配置会先备份。", async()=>{await claudeProvidersClient.restoreBackup();setMessage("已恢复到上一份配置");await load();})}><RotateCcw size={13} aria-hidden="true" />恢复上一份</button>)}
        <button type="button" className="secondary" disabled={Boolean(busyId) || !settingsPath} onClick={() => void run("open-config", () => claudeWorkbenchClient.providerAction({ type: "open_config_directory" }), "")} title="打开当前 Claude Code 配置文件所在目录"><FolderOpen size={13} aria-hidden="true" />打开配置目录</button>
        <button type="button" className="secondary" disabled={Boolean(busyId) || routing.running} onClick={() => void changeScope(false)}>选择项目</button>
        <button type="button" className="secondary" disabled={Boolean(busyId) || !workspace || routing.running} onClick={() => void changeScope(true)}>不使用项目</button>
      </span>
    </div>

    <div className="claude-config-help claude-config-description"><span>保存到本地；点击「切换」后写入配置文件。</span><button type="button" aria-expanded={showConfigDescription} aria-controls="claude-config-description" onClick={() => setShowConfigDescription(value => !value)}><ArrowDown size={12} aria-hidden="true" />详细说明</button><p id="claude-config-description" hidden={!showConfigDescription}>切换前会备份当前配置，并写入所选供应商的地址、Key 和模型映射；已运行的 Claude Code 需重启加载。路由／聚合模式写入本地代理地址，由 CloudHub 转发。</p></div>

    <header className="claude-providers-head claude-list-toolbar">
      <label className="claude-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索供应商" placeholder="搜索供应商" value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
      <div className="claude-providers-actions">
        <button type="button" disabled={Boolean(busyId)} aria-busy={busyId === "refresh"} title="重新读取供应商、当前配置和路由状态，不修改配置" onClick={() => { setMessage(""); void run("refresh", async () => {}, ""); }}>
          {busyId === "refresh" ? <Loader2 size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}{busyId === "refresh" ? "刷新中…" : "刷新"}
        </button>
        <button type="button" disabled={Boolean(busyId)} onClick={() => void run("prepare-import", async () => {
          const preview=await claudeWorkbenchClient.prepareProviderImport();
          if (preview) { setImportPreview(preview); setImportSelection(new Set(preview.providers.map(p=>p.index))); setImportError(""); }
        }, "")}>导入 JSON</button>
        <button type="button" className="primary" onClick={() => setPresetPickerOpen(true)}><Plus size={14} aria-hidden="true" />添加供应商</button>
      {selectedProviders.size > 0 && <button type="button" disabled={Boolean(busyId)} onClick={() => setSelectedProviders(new Set())}>取消选择（{selectedProviders.size}）</button>}
      <button type="button" disabled={Boolean(busyId) || !selectedProviders.size} onClick={() => {
        const ids=[...selectedProviders];
        confirm("导出所选 " + ids.length + " 条供应商？JSON 文件包含明文 API Key，不设密码，请妥善保管。",async()=>{ if(await claudeWorkbenchClient.exportProviders(ids)) { setMessage("已导出供应商配置（含明文 Key）"); setSelectedProviders(new Set()); } });
      }}>导出所选</button>
      <button type="button" disabled={Boolean(busyId) || !selectedProviders.size} onClick={() => {
        const ids=[...selectedProviders];
        const names=providers.filter(p=>selectedProviders.has(p.id)).map(p=>p.name).join("、");
        confirm("确认永久删除所选 " + ids.length + " 条供应商？（" + names + "）此操作不能撤销。",async()=>{await claudeWorkbenchClient.deleteProviders(ids);setSelectedProviders(new Set());setMessage("所选供应商已删除");await load();});
      }}>删除所选</button>
      </div>
    </header>
    {viewMode === "route" && <p className="claude-config-help">{config.failover ? "按 P1、P2… 优先级请求，失败时在重试次数限制内尝试后续供应商。" : "故障转移已关闭，仅使用固定供应商；队列与顺序仍保留。"} 无请求记录时显示“未检测”，不代表连接成功。</p>}
    {viewMode === "aggregate" && <p className="claude-config-help">默认供应商承接不带前缀的请求；添加其他供应商后，可在 Claude Code 的 /model 中选择其模型。聚合不使用故障转移。</p>}

    <div className="claude-list-selection"><label className="claude-check"><input type="checkbox" aria-label="全选当前搜索结果" disabled={Boolean(busyId) || !shown.length} checked={!!shown.length && shown.every(p=>selectedProviders.has(p.id))} ref={element=>{if(element)element.indeterminate=shown.some(p=>selectedProviders.has(p.id)) && !shown.every(p=>selectedProviders.has(p.id));}} onChange={event=>{const checked=event.target.checked;setSelectedProviders(current=>{const next=new Set(current);shown.forEach(p=>checked?next.add(p.id):next.delete(p.id));return next;});}} />全选当前结果</label><span>共 {shown.length} 个供应商</span></div>
    {providers.length === 0 ? <div className="claude-empty">
      <Server size={26} aria-hidden="true" />
      <strong>还没有供应商</strong>
      <p>添加一个供应商，填写请求地址与 API Key 后即可一键切换。</p>
    </div> : <ul className="claude-provider-list">
      {displayed.map((item, index) => {
        const accent = providerAccent(item.name);
        const modelGroups = new Map<string, string[]>();
        for (const role of ROLES.filter(role => item.models?.[role.key]?.model).slice(0, 3)) {
          const model = item.models?.[role.key]?.model;
          if (model) modelGroups.set(model, [...(modelGroups.get(model) ?? []), role.label]);
        }
        const needsRouting = !item.officialLogin && item.apiFormat !== "anthropic";
        const usage = windowedUsage(routing.logs, item.id);
        const isCurrent = item.id === currentId;
        const configurationIssue = isCurrent && viewMode === "direct" && !routing.running
          ? configurationStatus === "changed" ? "配置不一致" : configurationStatus === "missing" ? "配置文件缺失" : configurationStatus === "unreadable" ? "无法核对配置" : ""
          : "";
        const canSwitchBack = Boolean(configurationIssue) && configurationStatus !== "unreadable";
        const queueIndex = config.queue.indexOf(item.id);
        const inQueue = queueIndex >= 0;
        const isRouteTarget = routing.running && routing.mode === "route" && item.id === (config.failover ? routing.activeProvider : config.routeProvider);
        const lastResponse = routing.logs.find(log => log.providerId === item.id);
        const routeHealth = routing.health[item.id];
        const healthLabel = routeHealth?.openUntil && routeHealth.openUntil > Date.now() ? "熔断中" : routeHealth?.failures || (lastResponse && lastResponse.status >= 400) ? "请求失败" : lastResponse ? "正常" : "未检测";
        const group = aggregateGroup(item);
        const groupHeading = viewMode === "aggregate" && (index === 0 || aggregateGroup(displayed[index - 1]) !== group);
        return <Fragment key={item.id}>
          {groupHeading && <li className="claude-provider-group-heading">{group === 0 ? routing.mode === "aggregate" && routing.running ? "默认供应商" : "切换到聚合模式后的默认供应商" : (group === 1 ? "已添加" : "可添加") + " · " + providers.filter(provider => aggregateGroup(provider) === group).length}</li>}
          <li className={`claude-provider-item${(viewMode === "route" ? isRouteTarget : viewMode === "aggregate" ? group === 0 : isCurrent) ? " is-current" : ""}${selectedProviders.has(item.id) ? " is-selected" : ""}${viewMode === "route" ? " is-aggregate-item" : ""}`}>
          {viewMode === "route" && (index === 0 || config.queue.includes(displayed[index - 1].id) !== inQueue) && <div className="claude-aggregate-heading">{inQueue ? "队列 · 按优先级" : "不在队列"}（{shown.filter(provider => config.queue.includes(provider.id) === inQueue).length}）</div>}
          <input className="claude-provider-select" type="checkbox" aria-label={"选择 " + item.name} checked={selectedProviders.has(item.id)} disabled={Boolean(busyId)} onChange={event=>setSelectedProviders(current=>{const next=new Set(current);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next;})} />
          <div className="claude-provider-main">
            <div className="claude-provider-title">
              <span className="claude-provider-logo" aria-hidden="true" style={{ background: accent.color }}>{accent.letter}</span>
              <strong>{item.name}</strong>
              {modelGroups.size > 0 && <button type="button" className="claude-model-toggle" aria-label={`${expandedModels.has(item.id) ? "收起" : "展开"} ${item.name} 的模型`} aria-expanded={expandedModels.has(item.id)} aria-controls={`claude-models-${item.id}`} onClick={() => setExpandedModels(current => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                return next;
              })}><ArrowDown size={12} aria-hidden="true" />模型 · {modelGroups.size}</button>}
              {viewMode === "route" && inQueue && <><span className="claude-tag">P{queueIndex + 1}</span><span className="claude-tag" title="根据本地请求记录与熔断状态显示">{healthLabel}</span></>}
              {viewMode === "route" && isRouteTarget && <span className="claude-tag is-current">{config.failover ? "最近响应" : "路由中"}</span>}
              {viewMode === "aggregate" && <span className="claude-tag">{group === 0 ? "默认" : providerModelCount(item) + " 个模型"}</span>}
              {isCurrent && viewMode === "direct" && !routing.running && <><span className={`claude-tag ${configurationIssue ? "is-configured" : "is-current"}`}>{!configurationIssue && <span className="claude-live-dot" aria-hidden="true" />}{configurationIssue ? "当前配置" : "使用中"}</span>{configurationIssue && <span className="claude-tag is-warning">{configurationIssue}</span>}</>}
              {!item.keyConfigured && !item.officialLogin && <span className="claude-tag is-warning">缺少 Key</span>}
              {item.officialLogin && <span className="claude-tag">官方登录</span>}
              {needsRouting && <span className="claude-tag is-warning">需要路由</span>}
              {routing.health[item.id]?.openUntil && routing.health[item.id].openUntil! > Date.now() && <span className="claude-tag is-warning">熔断中</span>}
            </div>
            <code className="claude-provider-url">{item.baseUrl || "未填写请求地址"}</code>
            {item.apiFormat !== "anthropic" && <div className="claude-provider-meta">{API_FORMATS.find(format => format.value === item.apiFormat)?.label}</div>}
            {modelGroups.size > 0 && <dl id={`claude-models-${item.id}`} className="claude-model-mappings" aria-label="模型映射" hidden={!expandedModels.has(item.id)}>
              {Array.from(modelGroups, ([model, roles]) => <div key={model} className="claude-model-mapping">
                <dt>{roles.join(" / ")}</dt>
                <dd>{model}</dd>
              </div>)}
            </dl>}
            {configurationIssue && <p className="claude-configuration-warning" role="status"><HelpCircle size={13} aria-hidden="true" /><span>{configurationStatus === "unreadable" ? "无法读取或解析配置，请检查文件后刷新。" : configurationStatus === "missing" ? "配置文件已缺失，点击“切换回来”恢复。" : "配置已在外部更改，点击“切换回来”恢复此渠道。"}</span></p>}
          </div>
          <div className="claude-provider-stats">
            {!item.officialLogin && item.keyConfigured && runningInTauri && <ClaudeProviderUsage key={item.id + ":" + usageRevision + ":" + JSON.stringify(item)} provider={item} disabled={Boolean(busyId)} />}
            {(isCurrent || usage.requests > 0) && <div className="claude-provider-usage" title={`最近 5 小时累计：${usage.requests} 次，${usage.tokens.toLocaleString()} tokens`}>
              <span className="claude-stat-caption">本地 · 5h</span>
              <span className="claude-provider-usage-label"><strong>{usage.requests}</strong> 次<span className="claude-stat-divider" aria-hidden="true">/</span><strong>{usage.tokens.toLocaleString()}</strong> tokens</span>
            </div>}
          </div>
          <div className="claude-provider-actions">
            {quotaProviderId === item.id && <SharedDialog title={item.name + " · 剩余额度"} subtitle="来自供应商官方接口，与本地请求统计无关。" className="claude-providers claude-quota-dialog" size="small" onClose={() => setQuotaProviderId(null)} footer={<><button type="button" className="secondary" disabled={quotas[item.id]?.loading} onClick={() => void refreshQuota(item.id)}>{quotas[item.id]?.loading ? <Loader2 className="is-spin" size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}{quotas[item.id]?.loading ? "查询中…" : "刷新额度"}</button><button type="button" className="secondary" onClick={() => setQuotaProviderId(null)}>关闭</button></>}>
            <div className="claude-provider-quota" aria-busy={Boolean(quotas[item.id]?.loading)}>
              {!quotas[item.id]?.data && <span className="claude-quota-status" role="status">{quotas[item.id]?.loading ? "查询中…" : quotas[item.id]?.error || "待查询"}</span>}
              {quotas[item.id]?.data && <>
                {quotas[item.id].data!.windows.map(window => <div className="claude-quota-window" key={window.model + window.period}>
                  <span className="claude-stat-caption">{quotas[item.id].data!.windows.some(other => other.model !== window.model) ? window.model + " · " : ""}{window.period === "5h" ? "5 小时" : "本周"}剩余</span>
                  <div className="claude-provider-usage-bar" role="progressbar" aria-label={item.name + " " + window.model + " " + (window.period === "5h" ? "5 小时" : "本周") + "官方剩余额度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}><span style={{ width: `${window.remainingPercent}%` }} /></div>
                  <strong>{Number(window.remainingPercent.toFixed(1))}%</strong>
                  {window.resetsAt && <span className="claude-quota-reset">{window.resetsAt <= Date.now() ? "已到刷新时间，请刷新额度" : "重置 " + new Date(window.resetsAt).toLocaleString()}</span>}
                </div>)}
                {(["5h", "week"] as const).filter(period => !quotas[item.id].data!.windows.some(window => window.period === period)).map(period => <span className="claude-stat-caption" key={period}>{period === "5h" ? "5 小时" : "周"}额度：官方未提供可展示数据</span>)}
                <span className="claude-stat-caption">更新于 {new Date(quotas[item.id].data!.queriedAt).toLocaleTimeString()}</span>
              </>}
            </div></SharedDialog>}
            {viewMode === "direct" && <button type="button" className="secondary claude-icon-button" title={needsRouting ? "此供应商需要路由或聚合模式" : !item.keyConfigured && !item.officialLogin ? "请先填写 API Key" : configurationStatus === "unreadable" && isCurrent ? "请检查配置文件后刷新" : canSwitchBack ? "切换回来：备份当前配置并应用此渠道" : isCurrent && !routing.running && !configurationIssue ? "使用中" : "切换：备份当前配置并应用此渠道，保留 hooks 和插件等设置"} aria-label={item.name + " " + (canSwitchBack ? "切换回来" : isCurrent && !routing.running ? configurationIssue ? "无法核对" : "使用中" : "切换")} disabled={Boolean(busyId) || (isCurrent && !routing.running && !canSwitchBack) || needsRouting || (!item.keyConfigured && !item.officialLogin)} onClick={() => void run(item.id, () => claudeProvidersClient.switchTo(item.id), `已切换到 ${item.name}，重启 Claude Code 后生效`)}><Check size={14} aria-hidden="true" /></button>}
            {viewMode === "route" && <>
              <button type="button" className="secondary" title={inQueue ? "移出路由队列；启用故障转移时至少保留一家" : "加入路由队列"} disabled={Boolean(busyId) || (!inQueue && (item.officialLogin || !item.keyConfigured)) || (inQueue && config.failover && config.queue.length === 1)} onClick={() => toggleQueue(item.id)}><ListChecks size={13} aria-hidden="true" />{inQueue ? "移出队列" : "加入队列"}</button>
              {inQueue && <><button type="button" className="secondary claude-icon-button" aria-label={"提高 " + item.name + " 的优先级"} title="上移" disabled={Boolean(busyId) || queueIndex === 0} onClick={() => moveQueue(item.id, -1)}><ArrowUp size={13} aria-hidden="true" /></button><button type="button" className="secondary claude-icon-button" aria-label={"降低 " + item.name + " 的优先级"} title="下移" disabled={Boolean(busyId) || queueIndex === config.queue.length - 1} onClick={() => moveQueue(item.id, 1)}><ArrowDown size={13} aria-hidden="true" /></button></>}
              {!config.failover && <button type="button" className="secondary" disabled={Boolean(busyId) || item.officialLogin || !item.keyConfigured || item.id === config.routeProvider} onClick={() => void run(item.id, () => saveConfig({ ...config, routeProvider: item.id }), "已更新固定供应商")}>{item.id === config.routeProvider ? "固定供应商" : "设为固定"}</button>}
            </>}
            {viewMode === "aggregate" && <>
              {group === 0 ? <span className="claude-aggregate-default-status"><span className="claude-live-dot" aria-hidden="true" />{routing.running && routing.mode === "aggregate" ? "当前默认" : "切换后默认"}</span> : <button type="button" className="secondary claude-icon-button" aria-label={(group === 1 ? "从聚合移除 " : "添加到聚合 ") + item.name} title={item.officialLogin ? "官方订阅仅支持直连" : !item.keyConfigured ? "请先配置 API Key" : !providerModelCount(item) ? "请先配置模型列表" : group === 1 ? "移出聚合" : "添加到聚合"} disabled={Boolean(busyId) || (group !== 1 && (item.officialLogin || !item.keyConfigured || !providerModelCount(item)))} onClick={() => void run(item.id, () => saveConfig({ ...config, defaultProvider: aggregateDefault, members: group === 1 ? config.members.filter(id => id !== item.id) : [...config.members, item.id] }), "已更新聚合名单")}>{group === 1 ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}</button>}
            </>}
            <button type="button" className="secondary claude-icon-button" title={"编辑 " + item.name} aria-label={`编辑 ${item.name}`} onClick={() => setEditing(toInput(item))}><Pencil size={14} aria-hidden="true" /></button>
            <MoreMenu
              trigger={<MoreHorizontal size={14} aria-hidden="true" />}
              triggerClassName="secondary claude-icon-button"
              triggerTitle={item.name + " · 更多操作"}
              triggerAriaLabel={item.name + " · 更多操作"}
              items={[
                ...(supportsQuota(item) ? [{ id: "quota", label: "查询剩余额度", icon: <RotateCcw size={13} aria-hidden="true" />, disabled: Boolean(busyId), onSelect: () => { setQuotaProviderId(item.id); if (!quotas[item.id]?.loading) void refreshQuota(item.id); } }] : []),
                ...(viewMode === "aggregate" && group !== 0 ? [{ id: "default", label: "设为默认", icon: <Star size={13} aria-hidden="true" />, disabled: Boolean(busyId) || item.officialLogin || !item.keyConfigured || !providerModelCount(item), onSelect: () => void run(item.id, () => saveConfig({ ...config, defaultProvider: item.id, members: [...new Set([...config.members.filter(id => id !== item.id), ...(aggregateDefault ? [aggregateDefault] : [])])] }), "已更新聚合默认供应商") }] : []),
                { id: "duplicate", label: "复制供应商", icon: <Copy size={13} aria-hidden="true" />, disabled: Boolean(busyId), onSelect: () => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "duplicate", id: item.id }), "已复制供应商") },
                { id: "probe", label: "检测连接", icon: <Wifi size={13} aria-hidden="true" />, disabled: Boolean(busyId), onSelect: () => void run(item.id, async () => { const result = await claudeWorkbenchClient.probe(item.id); if (!result.reachable) throw new Error("无法连接供应商地址"); setMessage(`连接成功，${result.latencyMs} ms，HTTP ${result.status}`); }, "") },
                { id: "up", label: "上移", icon: <ArrowUp size={13} aria-hidden="true" />, disabled: Boolean(busyId) || providers[0]?.id === item.id, onSelect: () => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "move", id: item.id, offset: -1 }), "已更新排序") },
                { id: "down", label: "下移", icon: <ArrowDown size={13} aria-hidden="true" />, disabled: Boolean(busyId) || providers[providers.length - 1]?.id === item.id, onSelect: () => void run(item.id, () => claudeWorkbenchClient.providerAction({ type: "move", id: item.id, offset: 1 }), "已更新排序") },
                ...(item.websiteUrl && /^https?:\/\//i.test(item.websiteUrl) ? [{ id: "site", label: "打开官网", icon: <ExternalLink size={13} aria-hidden="true" />, onSelect: () => window.open(item.websiteUrl, "_blank", "noreferrer") }] : []),
                { id: "remove", label: "删除供应商", icon: <Trash2 size={13} aria-hidden="true" />, danger: true, disabled: Boolean(busyId) || isCurrent, onSelect: () => confirm(`确定删除供应商“${item.name}”吗？`, async () => { await claudeProvidersClient.remove(item.id); await load(); }) },
              ]}
            />
          </div>
        </li></Fragment>;
      })}
    </ul>}
    {!!providers.length && !shown.length && <p role="status" className="claude-empty-line">没有符合条件的供应商</p>}
    </>}

    {presetPickerOpen && <ClaudeProviderPresetPicker onClose={() => setPresetPickerOpen(false)} onCustom={() => { setPresetPickerOpen(false); setEditing(emptyProvider()); }} onSelect={input => { setPresetPickerOpen(false); setEditing(input); }} />}
    {editing && (() => {
      const editingSummary = providers.find(p => p.id === editing.id);
      return <Editor draft={editing} keyConfigured={Boolean(editingSummary?.keyConfigured)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setMessage("供应商已保存"); void load(); }} />;
    })()}
    {settingsOpen && viewMode !== "direct" && <RoutingSettings config={config} mode={viewMode} running={routing.running} onClose={() => setSettingsOpen(false)} onSave={saveConfig} />}
    {aggregateStartOpen && <AggregateStartDialog providers={providers} config={config} initialDefault={aggregateDefault} onClose={() => setAggregateStartOpen(false)} onStart={async next => { await saveConfig(next); await claudeWorkbenchClient.activate("aggregate"); setMessage("已启用聚合模式；请保持本应用运行。"); await load(); }} />}
    {routeStartOpen && <SharedDialog title="让 Claude Code 使用路由模式？" size="small" closeDisabled={routeStartBusy} onClose={() => setRouteStartOpen(false)}
      onSubmit={event => {
        event.preventDefault();
        if (routeStartBusy || !routeProviders.some(item => item.id === routeTarget)) return;
        setRouteStartBusy(true); setRouteStartError("");
        void (async () => {
          try {
            await saveConfig({ ...config, routeProvider: routeTarget, queue: config.failover ? [routeTarget, ...config.queue.filter(id => id !== routeTarget)] : config.queue });
            await claudeWorkbenchClient.activate("route");
            setRouteStartOpen(false); setMessage("已启用本地路由；已运行的 Claude Code 请重启以读取新配置。");
            await load();
          } catch (reason) { setRouteStartError(reason instanceof Error ? reason.message : "启动路由失败"); }
          finally { setRouteStartBusy(false); }
        })();
      }} footer={<>
        <button type="button" className="secondary" disabled={routeStartBusy} onClick={() => setRouteStartOpen(false)}>取消</button>
        <button type="submit" className="primary" disabled={routeStartBusy || !routeProviders.some(item => item.id === routeTarget)}>{routeStartBusy ? "启动中…" : "开始路由"}</button>
      </>}>
      <label className="claude-field">路由到<select required value={routeTarget} disabled={routeStartBusy} onChange={event => setRouteTarget(event.target.value)}><option value="">选择供应商</option>{routeProviders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {!routeProviders.length && <p className="claude-error" role="alert">暂无可用供应商，请先添加供应商并配置 API Key；官方登录不支持本地路由。</p>}
      <p className="claude-config-help">启用后，当前作用域的 Claude Code 配置将指向本地路由，由本应用转发到所选供应商。保持本应用运行，已启动的 Claude Code 需要重启以读取配置。</p>
      <p className="claude-config-help">{config.failover ? "故障转移已开启，所选供应商会排到 P1，其余队列顺序保留；启用后可在列表调整优先级。" : "故障转移已关闭，所选供应商作为固定目标；开启顶部开关后按队列优先级请求。"} 点击「回到直连」停止路由并恢复直连配置。</p>
      {routeStartError && <p className="claude-error" role="alert">{routeStartError}</p>}
    </SharedDialog>}
    {importPreview && <SharedDialog title="选择导入供应商" subtitle="导入为新记录，不覆盖现有供应商；完全相同的配置将跳过。" closeDisabled={importBusy} onClose={closeImport} footer={<>
      <button type="button" className="secondary" disabled={importBusy} onClick={closeImport}>取消</button>
      <button type="button" className="primary" disabled={importBusy || !importSelection.size} onClick={async()=>{setImportBusy(true);setImportError("");try{const result=await claudeWorkbenchClient.importProviders(importPreview.token,[...importSelection]);setImportPreview(null);setMessage("导入 " + result.imported + " 条，跳过重复 " + result.skipped + " 条");await load();}catch(reason){setImportError(reason instanceof Error?reason.message:"导入失败");}finally{setImportBusy(false);}}}>{importBusy?"导入中…":"导入所选"}</button>
    </>}>
      <div className="claude-batch-toolbar"><button type="button" disabled={importBusy} onClick={()=>setImportSelection(new Set(importPreview.providers.map(p=>p.index)))}>全选</button><button type="button" disabled={importBusy} onClick={()=>setImportSelection(new Set())}>清空选择</button><span>已选 {importSelection.size} 条</span></div>
      {importPreview.providers.map(p=><label className="claude-import-row" key={p.index}><input type="checkbox" disabled={importBusy} checked={importSelection.has(p.index)} onChange={event=>setImportSelection(current=>{const next=new Set(current);if(event.target.checked)next.add(p.index);else next.delete(p.index);return next;})} /><span>{p.name}<small>{p.baseUrl}</small></span></label>)}
      {importError && <p className="claude-error" role="alert">{importError}</p>}
    </SharedDialog>}
    {configPreview && <SharedDialog title="当前配置文件预览" subtitle={configPreview.path} onClose={() => setConfigPreview(null)} footer={<button type="button" className="secondary" onClick={() => setConfigPreview(null)}>关闭</button>}>
      <p className="claude-config-help">完整内容，只读预览，未脱敏；可能包含明文密钥、认证信息和命令，请勿直接截图或分享。</p>
      <pre className="claude-config-preview">{JSON.stringify(configPreview.document, null, 2)}</pre>
    </SharedDialog>}
    {backupHistoryOpen && <SharedDialog title="Claude Code 配置备份历史" subtitle="历史备份会一直保留；恢复后也不会删除所选记录。恢复前会自动备份当前配置。" size="large" onClose={() => setBackupHistoryOpen(false)} footer={<button type="button" className="secondary" onClick={() => setBackupHistoryOpen(false)}>关闭</button>}>
      <div className="claude-backup-history" role="list">
        {backups.map((backup, index) => <div className="claude-backup-history-row" role="listitem" key={backup.id}>
          <span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{index === 0 ? "最近备份" : `历史备份 #${backups.length - index}`}</small></span>
          <button type="button" className="secondary" disabled={Boolean(busyId)} onClick={() => confirm(`恢复 ${new Date(backup.createdAt).toLocaleString()} 的配置？当前配置会先另存为一条新备份。`, async () => { await claudeProvidersClient.restoreBackup(backup.id); setBackupHistoryOpen(false); setMessage("已恢复所选历史配置，所有历史备份仍保留"); await load(); })}><RotateCcw size={13} aria-hidden="true" />恢复此备份</button>
        </div>)}
        {!backups.length && <p className="claude-config-help">当前配置目录还没有历史备份。</p>}
      </div>
    </SharedDialog>}
    {confirmation && createPortal(<ConfirmDialog message={confirmation.message} busy={confirmBusy} error={confirmError} onResolve={accepted => {
      if (confirmBusy) return;
      if (!accepted) { setConfirmation(null); return; }
      setConfirmBusy(true);
      void confirmation.action().then(() => setConfirmation(null)).catch(reason => setConfirmError(reason instanceof Error ? reason.message : "操作失败")).finally(() => setConfirmBusy(false));
    }} />, document.body)}
  </section>;
}
