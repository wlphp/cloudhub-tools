import { ToastNotice } from "../../shared/ToastNotice";
import { MultiSelectFilter } from "../../shared/MultiSelectFilter";
import { SharedDialog } from "../../shared/SharedDialog";
import { SelectionCheckbox, SortSelectionControls } from "../../shared/SortSelectionControls";
import { ListSortHandle } from "../../shared/ListSortHandle";
import { useListOrder } from "../../shared/useListOrder";
import { useSortableDrag } from "../../shared/useSortableDrag";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, Bot, ChevronDown, Download, Eye, EyeOff, Info, LoaderCircle, Plus, RefreshCw, Save, Search, Star, Trash2, Upload, X } from "lucide-react";
import { aiClient, type AiImportPreview, type AiProfile, type AiProfileInput, type AiProtocol } from "../../platform/clients/ai";
import { preferencesClient } from "../../platform/clients/preferences";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import "./ai.css";
import { AiModelPickerDialog } from "./AiModelPickerDialog";
import { AiExportDialog, AiImportDialog } from "./AiConfigTransfer";
import { AiProviderPresetPicker } from "./AiProviderPresetPicker";
import { AI_USAGE_PREFERENCE_PREFIX, AiSupplierUsageCell } from "./AiSupplierUsageCell";
import { ProviderBrandIcon } from "../../shared/provider-brand/ProviderBrandIcon";
import { PaginationBar } from "../../shared/PaginationBar";
import { ConfirmDialog } from "../../shared/ConfirmDialog";

const SUPPLIER_ORDER_KEY = "cloudhub.ai.supplier-order";

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
  const [query, setQuery] = useState("");
  const [protocolFilters, setProtocolFilters] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importDialog, setImportDialog] = useState<{ open: boolean; preview: AiImportPreview | null }>({ open: false, preview: null });
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [sorting, setSorting] = useState(false);
  const listOrder = useListOrder(SUPPLIER_ORDER_KEY);
  const [draft, setDraft] = useState<AiProfileInput | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [revealedKey, setRevealedKey] = useState("");
  const [revealing, setRevealing] = useState(false);
  const keyRequest = useRef(0);
  const [saving, setSaving] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rowTests, setRowTests] = useState<Record<string, { kind: "connection" | "vision"; requestId: string }>>({});
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [pickerModels, setPickerModels] = useState<string[] | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pickerMessage, setPickerMessage] = useState("");
  const [usagePreferences, setUsagePreferences] = useState<Record<string, string>>({});
  const [usagePrefsReady, setUsagePrefsReady] = useState(false);
  const [usageRevision, setUsageRevision] = useState(0);
  const alive = useRef(true);
  const modelQueryRequest = useRef<string | null>(null);
  const activeTestRequests = useRef(new Set<string>());
  const saveFeedback = useRef<HTMLParagraphElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const orderedProfiles = listOrder.sort(profiles, profile => profile.id);
  const enabledCount = orderedProfiles.filter(profile => profile.enabled).length;
  const visionCount = orderedProfiles.filter(profile => profile.visionStatus === "supported").length;
  const defaultProfile = orderedProfiles.find(profile => profile.isDefault);
  const keyword = query.trim().toLocaleLowerCase();
  const filtered = orderedProfiles.filter(profile => (protocolFilters.length === 0 || protocolFilters.includes(profile.protocol)) && [profile.name, profile.baseUrl, profile.model, ...(profile.models ?? [])].some(value => value.toLocaleLowerCase().includes(keyword)));
  const protocolFilterOptions = protocols.map(item => ({ value: item.value, label: item.label, count: orderedProfiles.filter(profile => profile.protocol === item.value).length }));
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const validChecked = checkedIds.filter(id => orderedProfiles.some(profile => profile.id === id));
  const checkedSet = new Set(validChecked);
  const pagedSelectedCount = paged.filter(profile => checkedSet.has(profile.id)).length;
  const sortDisabled = !listOrder.ready || listOrder.saving || loading;
  function moveProfile(source: string, target: string) {
    if (!sorting || sortDisabled) return;
    void listOrder.move(orderedProfiles.map(profile => profile.id), source, target);
  }
  const drag = useSortableDrag({
    selector: "[data-ai-supplier-sort-id]",
    attribute: "data-ai-supplier-sort-id",
    enabled: sorting && !sortDisabled,
    onMove: moveProfile,
  });
  function toggleProfileSelection(id: string) {
    setCheckedIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
  }
  function togglePageSelection() {
    const pageIds = paged.map(profile => profile.id);
    if (!pageIds.length) return;
    setCheckedIds(current => {
      const allSelected = pageIds.every(id => current.includes(id));
      return allSelected ? current.filter(id => !pageIds.includes(id)) : [...new Set([...current, ...pageIds])];
    });
  }
  async function startImport() {
    if (importing) return;
    setExpanded(true);
    setMessage("");
    if (!runningInTauri) {
      setImportDialog({ open: true, preview: null });
      return;
    }
    setImporting(true);
    try {
      const next = await aiClient.prepareImport();
      if (!alive.current) {
        if (next) void aiClient.cancelImport(next.token).catch(() => {});
        return;
      }
      if (next) setImportDialog({ open: true, preview: next });
    } catch (error) {
      if (alive.current) setMessage(platformErrorMessage(error));
    } finally {
      if (alive.current) setImporting(false);
    }
  }
  useEffect(() => { setPage(1); setDeleting(null); }, [query, protocolFilters, pageSize]);
  function clearKeyDisplay() { keyRequest.current++; setKeyVisible(false); setRevealedKey(""); setRevealing(false); }
  useEffect(() => {
    if (!keyVisible) return;
    const timer = window.setTimeout(clearKeyDisplay, 30000);
    const hide = () => { if (document.hidden) clearKeyDisplay(); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [keyVisible]);
  async function toggleKey() {
    if (!draft || saving || revealing) return;
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
  function closeEditor() {
    if (savingRef.current) return;
    if (modelQueryRequest.current) { void aiClient.cancel(modelQueryRequest.current).catch(() => {}); modelQueryRequest.current = null; }
    clearKeyDisplay();
    setDraft(null);
    setFetchingModels(false);
    setPickerModels(null);
    setModelPickerOpen(false);
    setPickerMessage("");
    setMessage("");
  }
  async function reload(refreshUsage = false) {
    const list = await aiClient.list();
    if (alive.current) {
      setProfiles(list);
      if (refreshUsage) setUsageRevision(value => value + 1);
    }
  }
  async function refreshList() {
    if (refreshing) return;
    setRefreshing(true);
    setMessage("");
    try { await reload(true); }
    catch (error) { if (alive.current) setMessage(platformErrorMessage(error)); }
    finally { if (alive.current) setRefreshing(false); }
  }
  useEffect(() => {
    alive.current = true;
    void reload().catch(error => { if (alive.current) setMessage(platformErrorMessage(error)); }).finally(() => { if (alive.current) setLoading(false); });
    void preferencesClient.list().then(prefs => {
      if (alive.current) {
        setUsagePreferences(prefs);
        setUsagePrefsReady(true);
      }
    }).catch(() => {
      if (alive.current) setUsagePrefsReady(true);
    });
    return () => {
      alive.current = false;
      keyRequest.current++;
      if (modelQueryRequest.current) void aiClient.cancel(modelQueryRequest.current).catch(() => {});
      for (const reqId of activeTestRequests.current) void aiClient.cancel(reqId).catch(() => {});
      activeTestRequests.current.clear();
    };
  }, []);
  function edit(profile: AiProfile) { clearKeyDisplay(); opener.current = document.activeElement as HTMLElement; setExpanded(true); const { hasKey: _hasKey, updatedAt: _updatedAt, visionStatus:_vision, ...input } = profile; setDraft({ ...input, models: profile.models?.length ? profile.models : [profile.model], apiKey: "" }); setPickerModels(null); setModelPickerOpen(false); setPickerMessage(""); setMessage(""); setDeleting(null); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || saving) return;
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
    setSaving(true);
    setMessage("");
    try {
      await aiClient.save({ ...draft, model: draft.model.trim(), models: (draft.models || [draft.model]).map(model => model.trim()) });
      if (alive.current) { clearKeyDisplay(); setDraft(null); setMessage("AI配置已加密保存"); await reload(); }
    } catch (error) {
      if (alive.current) setMessage(platformErrorMessage(error));
    } finally {
      if (alive.current) setSaving(false);
    }
    requestAnimationFrame(() => saveFeedback.current?.focus());
  }
  function cancelRowTest(profileId: string) {
    const active = rowTests[profileId];
    if (!active) return;
    void aiClient.cancel(active.requestId).catch(error => {
      if (alive.current) setMessage(platformErrorMessage(error));
    });
  }
  async function test(profile: AiProfile) {
    if (rowTests[profile.id]) return;
    const id = crypto.randomUUID();
    activeTestRequests.current.add(id);
    setRowTests(current => ({ ...current, [profile.id]: { kind: "connection", requestId: id } }));
    setMessage("");
    try {
      const reply = await aiClient.run({ requestId: id, profileId: profile.id, expectedRevision: profile.updatedAt, task: "connection", text: "请完成连接与JSON格式测试。" });
      if (alive.current) setMessage(`“${profile.name}”测试通过：${reply.draft.summary || "结构化结果可用"}；输入 ${reply.inputTokens ?? "未知"} / 输出 ${reply.outputTokens ?? "未知"} Token`);
    } catch (error) {
      if (alive.current) setMessage(`“${profile.name}”连接测试失败：${platformErrorMessage(error)}`);
    } finally {
      activeTestRequests.current.delete(id);
      if (alive.current) {
        setRowTests(current => {
          if (current[profile.id]?.requestId !== id) return current;
          const { [profile.id]: _, ...rest } = current;
          return rest;
        });
      }
    }
  }
  async function testVision(profile: AiProfile) {
    if (rowTests[profile.id]) return;
    const id = crypto.randomUUID();
    activeTestRequests.current.add(id);
    setRowTests(current => ({ ...current, [profile.id]: { kind: "vision", requestId: id } }));
    setMessage("");
    try {
      const result = await aiClient.testVision({ requestId: id, profileId: profile.id, expectedRevision: profile.updatedAt });
      if (alive.current) {
        setMessage(result.passed ? `“${profile.name}”图像测试通过，可以使用裁剪遮挡后的截图识别` : `“${profile.name}”图像测试未通过，请更换模型或重试，文本功能仍可使用`);
        await reload();
      }
    } catch (error) {
      if (alive.current) setMessage(`“${profile.name}”图像测试失败：${platformErrorMessage(error)}`);
    } finally {
      activeTestRequests.current.delete(id);
      if (alive.current) {
        setRowTests(current => {
          if (current[profile.id]?.requestId !== id) return current;
          const { [profile.id]: _, ...rest } = current;
          return rest;
        });
      }
    }
  }
  async function removeProfile(profileId: string) {
    if (deletingBusy) return;
    setDeletingBusy(true);
    setMessage("");
    try {
      await aiClient.remove(profileId);
      if (alive.current) {
        setDeleting(null);
        if (draft?.id === profileId) setDraft(null);
        await reload();
      }
    } catch (error) {
      if (alive.current) setMessage(platformErrorMessage(error));
    } finally {
      if (alive.current) setDeletingBusy(false);
    }
  }
  async function queryModels() {
    if (!draft || saving || fetchingModels) return;
    const snapshot = draft;
    const profile = profiles.find(p => p.id === snapshot.id);
    const id = crypto.randomUUID();
    modelQueryRequest.current = id;
    setFetchingModels(true);
    setPickerMessage("");
    setMessage("");
    try {
      const result = await aiClient.models({
        requestId: id,
        profileId: snapshot.id,
        expectedRevision: profile?.updatedAt,
        draft: {
          protocol: snapshot.protocol,
          baseUrl: snapshot.baseUrl,
          apiKey: snapshot.apiKey,
          allowLoopbackHttp: snapshot.allowLoopbackHttp,
          timeoutSeconds: snapshot.timeoutSeconds,
        },
      });
      if (!alive.current || modelQueryRequest.current !== id) return;
      if (!result.length) {
        setPickerMessage("上游未返回可用模型，可手动添加");
        return;
      }
      setPickerModels(result);
      setModelPickerOpen(true);
    } catch (error) {
      if (alive.current && modelQueryRequest.current === id) setMessage(platformErrorMessage(error));
    } finally {
      if (modelQueryRequest.current === id) modelQueryRequest.current = null;
      if (alive.current) setFetchingModels(false);
    }
  }
  function applyModelPickerSelection(addIds: string[], removeIds: string[]) {
    setDraft(current => {
      if (!current) return current;
      const before = (current.models || [current.model]).map(item => item.trim()).filter(Boolean);
      const removeSet = new Set(removeIds);
      const remaining = before.filter(item => !removeSet.has(item));
      const existing = new Set(remaining);
      const additions = addIds.filter(item => !existing.has(item));
      const nextModels = [...remaining, ...additions];
      const finalModels = nextModels.length ? nextModels : [""];
      const nextDefault = current.model && finalModels.includes(current.model) ? current.model : finalModels[0];
      return { ...current, models: finalModels, model: nextDefault };
    });
    const summary = [
      addIds.length ? `新增 ${addIds.length}` : "",
      removeIds.length ? `移除 ${removeIds.length}` : "",
    ].filter(Boolean).join("，");
    setPickerMessage(summary ? `已更新可用模型：${summary}` : "可用模型未变更");
    setModelPickerOpen(false);
    setPickerModels(null);
  }
  function changeModel(index: number, value: string) {
    if (!draft) return;
    const entries = draft.models || [draft.model];
    setDraft({ ...draft, model: entries.indexOf(draft.model) === index ? value : draft.model, models: entries.map((model, i) => i === index ? value : model) });
  }
  function removeModel(index: number) {
    if (!draft) return;
    const entries = draft.models || [draft.model];
    if (entries.length <= 1) return;
    const removed = entries[index];
    const next = entries.filter((_, i) => i !== index);
    setDraft({ ...draft, models: next, model: draft.model === removed ? next[0] : draft.model });
  }
  return <section className={`ai-settings ai-supplier-manager${embedded ? " is-embedded" : ""}`} aria-label="模型供应商管理" aria-busy={loading}>
    <header className="ai-settings-header"><div><h2 id="ai-settings-title"><Bot size={20} aria-hidden="true" />模型供应商 <small className="ai-profile-count">{profiles.length ? `${profiles.length} 项` : "未配置"}</small></h2><p className="ai-settings-description">统一配置，供 AI 辅助和 Codex / Claude 导入使用。</p></div>
      <div className="ai-config-summary" role="group" aria-label="模型供应商概览">
      {profiles.length ? <div className="ai-summary-stats"><span className="ai-stat-chip"><small>启用</small><strong>{enabledCount} / {profiles.length}</strong></span><span className="ai-stat-chip"><small>图像测试通过</small><strong>{visionCount}</strong></span><span className="ai-stat-chip is-default ai-summary-default" title={defaultProfile?.name}><small>默认</small><strong>{defaultProfile ? `${defaultProfile.name}${defaultProfile.enabled ? "" : "（已停用）"}` : "未设置"}</strong></span></div> : <p>尚未添加模型供应商，可在手机或电脑端配置并使用 AI 辅助。</p>}
      </div>
      <div className="ai-settings-controls">{!embedded && <button className="ai-settings-toggle" type="button" aria-expanded={expanded} aria-controls="ai-settings-content" onClick={() => setExpanded(value => !value)}><ChevronDown size={15} aria-hidden="true" />{expanded ? "收起" : "展开"}</button>}<button type="button" className="ai-transfer-trigger" disabled={importing} onClick={() => void startImport()}><Upload size={14} aria-hidden="true" />导入</button><button type="button" className="ai-transfer-trigger" disabled={!orderedProfiles.length} title={orderedProfiles.length ? (validChecked.length ? `导出已选 ${validChecked.length} 个模型供应商` : "导出模型供应商配置") : "暂无可导出的模型供应商"} onClick={() => { setExpanded(true); setMessage(""); setExportOpen(true); }}><Download size={14} aria-hidden="true" />{validChecked.length ? `导出（${validChecked.length}）` : "导出"}</button><button type="button" className="ai-primary ai-add-supplier-btn" onClick={() => { opener.current = document.activeElement as HTMLElement; setExpanded(true); clearKeyDisplay(); setDraft(null); setPickerModels(null); setModelPickerOpen(false); setPickerMessage(""); setDeleting(null); setMessage(""); setPresetPickerOpen(true); }}><Plus size={15} aria-hidden="true" />添加模型供应商</button></div></header>
    <div id="ai-settings-content" hidden={!expanded}>
    <>
      {message && !draft && <ToastNotice message={message} />}
      {listOrder.error && <p role="alert" className="ai-order-error">{listOrder.error}<button type="button" disabled={listOrder.saving} onClick={listOrder.retry}>重试</button></p>}
      <div className="ai-supplier-toolbar"><label className="ai-supplier-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索模型供应商" placeholder="搜索名称、服务地址或模型" value={query} onChange={event => setQuery(event.target.value)} /></label><MultiSelectFilter className="ai-supplier-protocol-filter" label="协议" ariaLabel="筛选模型供应商协议" allLabel="全部协议" options={protocolFilterOptions} selected={protocolFilters} onChange={setProtocolFilters} /><div className="ai-supplier-toolbar-meta">{!sorting && validChecked.length > 0 && <span className="ai-supplier-selected">已选 {validChecked.length} 项</span>}<span className="ai-supplier-total">共 {filtered.length} 项</span><SortSelectionControls label="模型供应商" keys={paged.map(profile => profile.id)} selected={checkedSet} sorting={sorting} onToggleAll={togglePageSelection} onSortingChange={setSorting} showSelectAll={false} disabled={sortDisabled} /><button type="button" disabled={refreshing || loading} onClick={() => void refreshList()}><RefreshCw size={14} className={refreshing ? "spin" : ""} aria-hidden="true" />刷新</button></div></div>
      {loading ? <p role="status">正在读取模型供应商…</p> : !orderedProfiles.length ? <p className="ai-supplier-empty">尚未配置模型供应商。点击上方添加，配置不会自动上传业务数据。</p> : !filtered.length && <p className="ai-supplier-empty">没有匹配的模型供应商，请调整搜索或协议筛选。</p>}
      {!!paged.length && <div className="ai-supplier-table-wrap"><table className="ai-supplier-table" aria-label="模型供应商列表"><colgroup><col className="ai-supplier-col-select" /><col className="ai-supplier-col-name" /><col className="ai-supplier-col-protocol" /><col className="ai-supplier-col-address" /><col className="ai-supplier-col-model" /><col className="ai-supplier-col-usage" /><col className="ai-supplier-col-status" /><col className="ai-supplier-col-actions" /></colgroup><thead><tr><th scope="col" className="ai-supplier-select-col">{sorting ? "排序" : <SelectionCheckbox label="全选当前页模型供应商" checked={paged.length > 0 && pagedSelectedCount === paged.length} mixed={pagedSelectedCount > 0 && pagedSelectedCount < paged.length} onChange={togglePageSelection} />}</th><th scope="col">名称</th><th scope="col">协议</th><th scope="col">服务地址</th><th scope="col">默认模型</th><th scope="col">余额 / 额度</th><th scope="col">状态 / 图像</th><th scope="col">操作</th></tr></thead><tbody>{paged.map(profile => {
        const rowTesting = rowTests[profile.id]?.kind ?? null;
        return <tr className="ai-profile" key={profile.id} data-ai-supplier-sort-id={profile.id} aria-label={`模型供应商 ${profile.name}`}>
        <td className="ai-supplier-select">{sorting ? <ListSortHandle id={profile.id} name={profile.name} ids={paged.map(item => item.id)} disabled={sortDisabled} onStart={drag.startDrag} onMove={moveProfile} /> : <SelectionCheckbox label={`选择 ${profile.name}`} checked={checkedSet.has(profile.id)} onChange={() => toggleProfileSelection(profile.id)} />}</td>
        <td data-label="名称" className="ai-supplier-name"><div className="ai-supplier-name-cell"><ProviderBrandIcon name={profile.name} hints={[profile.baseUrl, profile.model, ...(profile.models ?? [])]} className="ai-supplier-brand-icon" /><div className="ai-supplier-name-text"><strong title={profile.name}>{profile.name}</strong>{profile.isDefault && <span className="ai-supplier-default">默认</span>}</div></div></td>
        <td data-label="协议" className="ai-supplier-protocol" title={protocols.find(p => p.value === profile.protocol)?.label}><span className={`ai-protocol-badge is-${profile.protocol}`}>{{ openai_chat: "Chat Completions", openai_responses: "Responses", claude: "Claude Messages", gemini: "Gemini" }[profile.protocol]}</span></td>
        <td data-label="地址" className="ai-supplier-address"><span className="ai-supplier-url" title={profile.baseUrl}>{profile.baseUrl}</span></td>
        <td data-label="模型" className="ai-supplier-model"><div className="ai-supplier-model-cell"><span className="ai-model-primary" title={profile.model}>{profile.model}</span>{(profile.models?.length || 0) > 1 && <span className="ai-model-count" title={profile.models!.join("、")}>共 {profile.models!.length} 个</span>}</div></td>
        <td data-label="余额 / 额度" className="ai-supplier-usage"><AiSupplierUsageCell profile={profile} savedRaw={usagePreferences[AI_USAGE_PREFERENCE_PREFIX + profile.id]} preferencesReady={usagePrefsReady} refreshRevision={usageRevision} disabled={false} onSaved={value => setUsagePreferences(current => ({ ...current, [AI_USAGE_PREFERENCE_PREFIX + profile.id]: value }))} /></td>
        <td data-label="状态" className="ai-supplier-state"><div className="ai-supplier-state-cell"><span className={`ai-state-pill ${profile.enabled ? "is-enabled" : "is-disabled"}`}><i aria-hidden="true" />{profile.enabled ? "已启用" : "已停用"}</span><small className={`ai-vision-state is-${profile.visionStatus}`}>图像：{profile.visionStatus === "supported" ? "已通过" : profile.visionStatus === "unsupported" ? "未通过" : "未测试"}</small></div></td>
        <td className="ai-supplier-operations"><div className="ai-actions"><button type="button" onClick={() => edit(profile)}>编辑</button><button type="button" disabled={rowTesting ? rowTesting !== "connection" : !profile.enabled} title={rowTesting === "connection" ? "取消当前连接测试" : "固定无敏感样例，测试可能产生调用费用"} onClick={() => { if (rowTesting === "connection") cancelRowTest(profile.id); else void test(profile); }}>{rowTesting === "connection" ? <><LoaderCircle size={12} className="spin" aria-hidden="true" />取消测试</> : "测试连接"}</button>{runningInTauri && <button type="button" disabled={rowTesting ? rowTesting !== "vision" : !profile.enabled} title={rowTesting === "vision" ? "取消当前图像测试" : "发送本机生成的不含敏感信息的测试图，可能产生调用费用"} onClick={() => { if (rowTesting === "vision") cancelRowTest(profile.id); else void testVision(profile); }}>{rowTesting === "vision" ? <><LoaderCircle size={12} className="spin" aria-hidden="true" />取消测试</> : "测试图像"}</button>}<button type="button" className="ai-action-danger" aria-label={`删除模型供应商 ${profile.name}`} title="删除" onClick={() => { setMessage(""); setDeleting(profile.id); }}><Trash2 size={13} aria-hidden="true" />删除</button></div></td>
      </tr>; })}</tbody></table></div>}
      {!!filtered.length && <PaginationBar className="store-pagination" page={safePage} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={setPageSize} />}
      {deleting && <ConfirmDialog title="删除模型供应商" tone="danger" message={`删除“${profiles.find(profile => profile.id === deleting)?.name ?? "此供应商"}”及其保存的密钥？`} detail="正在进行的调用将取消。已导入 Codex / Claude 的独立配置会保留。" confirmLabel="确认删除" busy={deletingBusy} error={message || undefined} onResolve={yes => { if (!yes) { setDeleting(null); return; } void removeProfile(deleting); }} />}
      <div className="ai-supplier-footer-panels">
        <details className="ai-supplier-help"><summary><span className="ai-collapse-title"><Info size={15} aria-hidden="true" /><span>使用与导入说明</span><small>供应用内 AI 辅助及 Codex / Claude / Pi 导入复用</small></span><ChevronDown size={15} className="ai-collapse-chevron" aria-hidden="true" /></summary><p>应用内识别填写、命令草稿和错误分析继续使用这里的供应商。添加 Codex 或 Claude 供应商时，可选择“从模型供应商导入”填入草稿；保存后由目标模块独立管理。连接与图像测试可能产生调用费用。</p></details>
      </div>
      {exportOpen && <AiExportDialog profiles={orderedProfiles} initialSelectedIds={validChecked} onClose={() => setExportOpen(false)} onDone={text => { setMessage(text); setExportOpen(false); setCheckedIds([]); }} />}
      {importDialog.open && <AiImportDialog key={importDialog.preview?.token ?? "empty"} initialPreview={importDialog.preview} onClose={() => setImportDialog({ open: false, preview: null })} onImported={reload} onDone={text => { setMessage(text); setImportDialog({ open: false, preview: null }); }} />}
      {presetPickerOpen && <AiProviderPresetPicker base={initial()} onClose={() => setPresetPickerOpen(false)} onCustom={() => { setPresetPickerOpen(false); clearKeyDisplay(); setDraft(initial()); setPickerModels(null); setModelPickerOpen(false); setPickerMessage(""); setMessage(""); }} onSelect={next => { setPresetPickerOpen(false); clearKeyDisplay(); setDraft(next); setPickerModels(null); setModelPickerOpen(false); setPickerMessage(""); setMessage(""); }} />}
      {draft && <SharedDialog sizeStorageKey="features/ai/ai-settings/ai-settings" title={draft.id ? "编辑模型供应商" : "添加模型供应商"} className="ai-config-form ai-config-dialog ai-workbench" bodyClassName="ai-config-dialog-body" initialFocus={"input[maxlength='120']"} noValidate onSubmit={event => void save(event)} onClose={closeEditor} closeLabel="取消编辑模型供应商" closeDisabled={saving} footerClassName="ai-actions ai-workbench-footer" footer={<>{!draft.id && <button type="button" className="ai-reselect-preset" disabled={saving || fetchingModels} onClick={() => { clearKeyDisplay(); setDraft(null); setPickerModels(null); setModelPickerOpen(false); setPickerMessage(""); setMessage(""); setPresetPickerOpen(true); }}>重选厂商</button>}<button type="button" disabled={saving} onClick={closeEditor}>取消</button><button type="submit" className="ai-primary" disabled={saving || fetchingModels}><Save size={15} />{saving ? "处理中…" : "保存配置"}</button></>}>
        <label>配置名称<input autoFocus required maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：我的运维模型" /></label>
        <label>接口协议<select disabled={saving || fetchingModels} value={draft.protocol} onChange={e => { const next = protocols.find(p => p.value === e.target.value)!; setPickerModels(null); setPickerMessage(""); setDraft({ ...draft, protocol: next.value, baseUrl: protocols.some(p => p.url === draft.baseUrl) ? next.url : draft.baseUrl }); }}>{protocols.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label>服务地址<input disabled={saving || fetchingModels} required maxLength={512} value={draft.baseUrl} onChange={e => { setPickerModels(null); setPickerMessage(""); setDraft({ ...draft, baseUrl: e.target.value }); }} placeholder="HTTPS地址，可包含网关路径前缀" /></label>
        <div className="ai-key-field"><label htmlFor="ai-api-key">API Key</label><div className="ai-key-input"><input id="ai-api-key" disabled={saving || revealing || fetchingModels} type={keyVisible ? "text" : "password"} autoComplete="new-password" spellCheck={false} required={!draft.id || (draft.enabled && !profiles.find(p=>p.id===draft.id)?.hasKey)} maxLength={4096} value={draft.apiKey || revealedKey} onChange={e => { keyRequest.current++; setRevealedKey(""); setDraft({ ...draft, apiKey: e.target.value }); }} placeholder={draft.id ? "留空保留已保存密钥；未携带密钥的导入配置需补填" : "本地加密保存"} /><button type="button" disabled={saving || revealing} aria-label={keyVisible ? "隐藏 API Key" : "查看 API Key"} aria-pressed={keyVisible} title={revealing ? "正在读取…" : keyVisible ? "隐藏密钥" : "查看密钥"} onClick={() => void toggleKey()}>{keyVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button></div></div>
        {(() => {
          const entries = draft.models?.length ? draft.models : [draft.model];
          const canQueryModels = Boolean(draft.baseUrl.trim() && (draft.apiKey?.trim() || profiles.find(p => p.id === draft.id)?.hasKey));
          const activeDefaultIndex = entries.indexOf(draft.model) >= 0 ? entries.indexOf(draft.model) : 0;
          return (
            <fieldset className="ai-models-fieldset" aria-label="模型ID配置">
              <legend>可用模型 <span className="ai-model-count-badge">{entries.filter(item => item.trim()).length}</span></legend>
              <div className="ai-models-toolbar">
                <button
                  type="button"
                  className="ai-model-query-button"
                  disabled={saving || fetchingModels || !canQueryModels}
                  title={!canQueryModels ? "请填写服务地址与 API Key 后获取模型列表" : "从上游拉取模型列表，弹出多选窗口勾选后并入可用模型"}
                  onClick={() => void queryModels()}
                >
                  {fetchingModels ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <ArrowDownToLine size={13} aria-hidden="true" />}
                  {fetchingModels ? "正在获取…" : "获取模型列表"}
                </button>
                {fetchingModels && modelQueryRequest.current && (
                  <button
                    type="button"
                    className="ai-model-query-cancel"
                    onClick={() => {
                      const activeId = modelQueryRequest.current;
                      modelQueryRequest.current = null;
                      setFetchingModels(false);
                      if (activeId) void aiClient.cancel(activeId).catch(() => setMessage("取消请求失败"));
                    }}
                  >
                    取消获取
                  </button>
                )}
                {pickerMessage && <span className="ai-models-toolbar-message" role="status">{pickerMessage}</span>}
              </div>
              <div className="ai-model-catalog-list" role="list" aria-label="可用模型列表">
                {entries.map((model, index) => {
                  const isDefault = activeDefaultIndex === index;
                  return (
                    <div className="ai-model-catalog-row ai-model-row" role="listitem" key={index}>
                      <button
                        type="button"
                        className={`ai-model-star-btn${isDefault ? " is-active" : ""}`}
                        aria-label={`默认模型 ${index + 1}`}
                        aria-pressed={isDefault}
                        title={isDefault ? "当前默认模型（用于测试和首次调用）" : "设为默认模型"}
                        disabled={saving || fetchingModels}
                        onClick={() => setDraft({ ...draft, model })}
                      >
                        <Star size={13} fill={isDefault ? "currentColor" : "none"} aria-hidden="true" />
                      </button>
                      <input
                        aria-label={index === 0 ? "模型名称" : `模型 ID ${index + 1}`}
                        required
                        maxLength={160}
                        autoComplete="off"
                        spellCheck={false}
                        value={model}
                        disabled={saving || fetchingModels}
                        placeholder="模型 ID"
                        onChange={event => changeModel(index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="ai-model-remove-btn"
                        aria-label={`删除模型 ${index + 1}`}
                        title="移除模型"
                        disabled={saving || fetchingModels || entries.length <= 1}
                        onClick={() => removeModel(index)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="ai-model-add-btn"
                disabled={saving || fetchingModels || entries.length >= 20}
                onClick={() => setDraft({ ...draft, models: [...entries, ""] })}
              >
                <Plus size={14} aria-hidden="true" />
                手动添加模型
              </button>
            </fieldset>
          );
        })()}
        <div className="ai-checks"><label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用此服务</label><label><input type="checkbox" checked={draft.isDefault} onChange={e => setDraft({ ...draft, isDefault: e.target.checked })} />设为默认服务</label></div>
        <details><summary>高级设置</summary><div className="ai-form-columns"><label>请求超时（秒）<input type="number" required min={5} max={180} value={draft.timeoutSeconds} onChange={e => setDraft({ ...draft, timeoutSeconds: Number(e.target.value) })} /></label><label>最大输出 Token<input type="number" required min={128} max={8192} value={draft.maxOutputTokens} onChange={e => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })} /></label></div><label className="ai-checkbox"><input type="checkbox" checked={draft.allowLoopbackHttp} onChange={e => setDraft({ ...draft, allowLoopbackHttp: e.target.checked })} />允许本机回环 HTTP 服务（例如本地模型网关）</label></details>
        <p>密钥仅在点击查看时显示，30秒后自动隐藏，不写入调用日志。保存后可用固定样例测试；第三方服务可能仅支持部分协议能力。</p>
        {message && <p className="ai-feedback ai-config-status" role="status" tabIndex={-1} ref={saveFeedback}>{message}</p>}
        {modelPickerOpen && pickerModels && <AiModelPickerDialog fetched={pickerModels} configured={draft.models || [draft.model]} onApply={applyModelPickerSelection} onClose={() => { setModelPickerOpen(false); setPickerModels(null); }} />}
      </SharedDialog>}
    </>
    </div>
  </section>;
}
