import { AccountRefreshError } from "./AccountRefreshError";
import { ExportChecklist } from "../../shared/ExportSelection";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { OverviewDialog as Modal, CodexRecycleDialog } from "./OverviewDialogs";
import { AccountGroupsDialog } from "./AccountGroupsDialog";
import { CodexSettingsDialog } from "./CodexSettingsDialog";
import { ConfigToolbar } from "./ConfigToolbar";
import { ModelProviders } from "./ModelProviders";
import { AccountTestDialog } from "./AccountTestDialog";
import { AddAccountDialog } from "./AddAccountDialog";
import { AccountDetailsDialog } from "./AccountDetailsDialog";
import { CodexAccountLogsDialog } from "./CodexAccountLogsDialog";
import { LaunchPreviewDialog } from "./LaunchPreviewDialog";
import { AccountTable } from "./AccountTable";
import { emptyOverviewPreferences, readOverviewPreferences, saveOverviewPreferences, type OverviewPreferences } from "./overviewPreferences";
import { Bot, Copy, ExternalLink, Eye, EyeOff, FileText, Filter, FolderOpen, History, LayoutGrid, List, Link2, Play, Plus, RefreshCw, RotateCcw, Search, Server, Settings, ShieldCheck, Square, Tag, Terminal, Trash2, Upload, Users, X } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { codexClient, isCodexDefaultProcessBusy, type CodexAccount, type CodexExportFormat, type CodexGatewayState, type CodexInstance, type CodexState, type CodexSwitchPreview } from "../../platform/clients/codex";
import "./codex.css";
import { AccountControls } from "./AccountControls";
import { RemoteApiLogs } from "./RemoteApiLogs";
import { BatchProxyDialog } from "./BatchProxyDialog";
import { CodexGateway } from "./CodexGateway";
import { ServiceSummary, type GatewayAction } from "./ServiceSummary";
import { quotaPresentation, quotaResetTime, quotaStatusNames, remainingPercent, useQuotaClock, windowName, type QuotaStatus } from "./quotaPresentation";

const time = (value: number | null) => value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未刷新";

const panels = [{ id: "accounts", label: "账号总览", icon: Users }, { id: "providers", label: "模型供应商", icon: Server }, { id: "api", label: "API 反代服务", icon: Server }, { id: "instances", label: "应用多开", icon: Terminal }] as const;

export function CodexPanel() {
  const [activePanel, setActivePanel] = useState<(typeof panels)[number]["id"]>("accounts");
  const [instanceAccountId, setInstanceAccountId] = useState("");
  const [state, setState] = useState<CodexState | null>(null);
  const [gateway, setGateway] = useState<CodexGatewayState | null>(null);
  const [summaryLanUrl, setSummaryLanUrl] = useState<string | null>(null);
  const [gatewayAction, setGatewayAction] = useState<{ id: number; kind: GatewayAction }>();
  const [externalPool, setExternalPool] = useState<number[]>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState<{ message: string; isError: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list" | "table">("grid");
  const [preferences, setPreferences] = useState<OverviewPreferences>(emptyOverviewPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<number[] | null>(null);
  const [wakeIds, setWakeIds] = useState<number[] | null>(null);
  const [testAccounts, setTestAccounts] = useState<CodexAccount[] | null>(null);
  const [wakeModel, setWakeModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [reverseSort, setReverseSort] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [plan, setPlan] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuotaStatus | "">("");
  const [sort, setSort] = useState("default");
  const now = useQuotaClock();
  const [batch, setBatch] = useState<{ total: number; done: number; label: string; stopping: boolean } | null>(null);
  const stopBatch = useRef(false);
  const refreshBatchRunning = useRef(false);
  const refreshingRef = useRef(new Set<number>());
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  async function refreshOne(id: number, kind: "quota" | "benefits" = "quota") {
    if (refreshingRef.current.has(id)) return;
    refreshingRef.current.add(id); setRefreshingIds(new Set(refreshingRef.current));
    try {
      replace(kind === "quota" ? await codexClient.refreshQuota(id) : await codexClient.refreshBenefits(id));
      if (kind === "quota" && alive.current) replace(await codexClient.refreshBenefits(id));
    }
    catch (reason) { if (alive.current) setError((accounts.find(a => a.id === id)?.label ?? "账号") + "刷新失败：" + platformErrorMessage(reason, "刷新请求失败")); }
    finally { refreshingRef.current.delete(id); if (alive.current) setRefreshingIds(new Set(refreshingRef.current)); }
  }
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [remoteLogsOpen, setRemoteLogsOpen] = useState(false);
  const [proxyAccounts, setProxyAccounts] = useState<CodexAccount[] | null>(null);
  const [launchAccountId, setLaunchAccountId] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState<CodexAccount | null>(null);
  const [editing, setEditing] = useState<{ id: number; label: string; note: string; tags: string } | null>(null);
  const [deleting, setDeleting] = useState<CodexAccount | null>(null);
  const [logsAccount, setLogsAccount] = useState<CodexAccount | null>(null);
  const [switching, setSwitching] = useState<CodexSwitchPreview | null>(null);
  const [closeDefaultRequest, setCloseDefaultRequest] = useState<{ retry: () => Promise<void>; inPreview: boolean } | null>(null);
  const [closeDefaultBusy, setCloseDefaultBusy] = useState(false);
  const [closeDefaultError, setCloseDefaultError] = useState("");
  const [switchAndLaunchCli, setSwitchAndLaunchCli] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [loginUrl, setLoginUrl] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const [instances, setInstances] = useState<CodexInstance[]>([]);
  const [creatingInstance, setCreatingInstance] = useState<{ accountId: number; name: string; kind: "cli" | "desktop" } | null>(null);
  const [stoppingInstance, setStoppingInstance] = useState<CodexInstance | null>(null);
  const [deletingInstance, setDeletingInstance] = useState<CodexInstance | null>(null);
  const [exporting, setExporting] = useState<{ accountId: number | null; ids: string[]; format: CodexExportFormat } | null>(null);
  const [importFormat, setImportFormat] = useState<CodexExportFormat>("cockpit_tools");
  const [importing, setImporting] = useState(false);
  const loginToken = useRef<string | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    if (!runningInTauri) return;
    let stopped = false;
    void readOverviewPreferences().then(value => { if (!stopped) { setPreferences(value); setViewMode(value.view); setPreferencesReady(true); } }).catch(() => { if (!stopped) setError("读取总览设置失败，请重新打开 Codex 管理后重试"); });
    return () => { stopped = true; };
  }, []);
  async function saveOverview(next: OverviewPreferences, done?: () => void) {
    if (!preferencesReady) return;
    await act("保存总览设置", async () => {
      await saveOverviewPreferences(next);
      if (alive.current) { setPreferences(next); setViewMode(next.view); done?.(); }
    });
  }
  useEffect(() => {
    const message = error || notice;
    if (!message) return;
    const isError = !!error || /失败|未能完整更新|无法/.test(notice);
    setToast({ message, isError });
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error, notice]);
  useEffect(() => {
    if (!runningInTauri) return;
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading || operation.current) return;
      reading = true;
      try { const next = await codexClient.instances(); if (!stopped) setInstances(next); }
      catch (reason) { if (!stopped) setError("读取 Codex 实例失败：" + (reason instanceof Error ? reason.message : "请重试")); }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => { alive.current = true; if (runningInTauri) void act("加载", async () => { const next = await codexClient.state(); if (alive.current) setState(next); }); return () => { alive.current = false; if (loginToken.current) void codexClient.cancelLogin(loginToken.current).catch(() => {}); }; }, []);
  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const result = await codexClient.pollLogin(login);
        if (result.status === "completed" && !stopped && alive.current) {
          const next = await codexClient.state();
          if (!stopped && alive.current) { setState(next); setLogin(null); setLoginUrl(""); loginToken.current = null; setNotice("官方登录完成，账号已加密保存"); }
        }
      } catch (reason) {
        if (!stopped && alive.current) { setLogin(null); setLoginUrl(""); loginToken.current = null; setError(reason instanceof Error ? reason.message : "Codex 登录失败"); void codexClient.cancelLogin(login).catch(() => {}); }
      } finally { polling = false; }
    }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [login]);

  async function act(name: string, run: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError(""); setNotice("");
    try { await run(); }
    catch (reason) { if (alive.current) setError(name + "失败：" + (reason instanceof Error ? reason.message : "请重试")); }
    finally { operation.current = false; if (alive.current) setBusy(""); }
  }

  async function resolveCloseDefault(confirmed: boolean) {
    if (!confirmed || !closeDefaultRequest || closeDefaultBusy) { if (!confirmed) setCloseDefaultRequest(null); return; }
    const request = closeDefaultRequest;
    setCloseDefaultBusy(true); setCloseDefaultError("");
    try {
      await codexClient.closeDefaultProcesses();
      setCloseDefaultRequest(null);
      try { await request.retry(); }
      catch (reason) {
        if (alive.current) {
          setCloseDefaultError(platformErrorMessage(reason, "重试操作失败"));
          setCloseDefaultRequest(current => current ?? request);
        }
      }
    } catch (reason) {
      if (alive.current) setCloseDefaultError(platformErrorMessage(reason, "关闭 Codex 或重试启动失败"));
    } finally {
      if (alive.current) setCloseDefaultBusy(false);
    }
  }

  function replace(account: CodexAccount) { if (alive.current) setState((current) => current ? { ...current, accounts: current.accounts.map((v) => v.id === account.id ? account : v) } : current); }
  const accounts = state?.accounts ?? [];
  const cpaExportUnavailable = exporting?.ids.some(id => accounts.find(account => String(account.id) === id)?.authMode !== "chatgpt") ?? false;
  const instanceAccount = accounts.find((account) => String(account.id) === instanceAccountId && !account.isWebSession) ?? accounts.find(account => !account.isWebSession);
  const visible = useMemo(() => {
    const group = preferences.groups.find(value => value.id === groupId);
    const filtered = accounts.filter(account => (!group || group.accountIds.includes(account.id)) && (!tagFilter || account.tags.includes(tagFilter)) && (!plan || (account.plan ?? account.authMode) === plan) && (!statusFilter || quotaPresentation(account, now).status === statusFilter) && [account.label, account.email, account.accountId, account.note, ...account.tags].some(text => text?.toLowerCase().includes(query.trim().toLowerCase())));
    const compareNullable = (a: number | null | undefined, b: number | null | undefined, descending = false) => a == null ? b == null ? 0 : 1 : b == null ? -1 : descending ? b - a : a - b;
    return filtered.sort((a, b) => {
      let comparison = 0;
      if (sort === "quota") comparison = compareNullable(quotaPresentation(a, now).remaining, quotaPresentation(b, now).remaining, true);
      else if (sort === "fiveHour" || sort === "weekly") {
        const minutes = sort === "fiveHour" ? 300 : 10080;
        const remaining = (account: CodexAccount) => { const window = account.quota.windows.find(window => window.windowMinutes === minutes); return quotaPresentation(account, now).remaining == null || !window ? null : remainingPercent(window); };
        comparison = compareNullable(remaining(a), remaining(b), true);
      }
      else if (sort === "expiry") comparison = compareNullable(a.benefits?.expiresAt, b.benefits?.expiresAt);
      else if (sort === "name") comparison = a.label.localeCompare(b.label, "zh-CN", { numeric: true });
      else comparison = Number(b.id === state?.currentAccountId) - Number(a.id === state?.currentAccountId);
      return (comparison || a.id - b.id) * (reverseSort ? -1 : 1);
    });
  }, [accounts, query, tagFilter, plan, statusFilter, sort, reverseSort, now, state?.currentAccountId, preferences.groups, groupId]);
  const targets = visible.filter(account => account.authMode === "chatgpt" && (!selected.size || selected.has(account.id)));
  const proxyTargets = visible.filter(account => selected.has(account.id));
  const plans = [...new Set(accounts.map((account) => account.plan ?? account.authMode))].sort();
  const allSelected = visible.length > 0 && visible.every((v) => selected.has(v.id));
  const close = () => { document.querySelector<HTMLDialogElement>(".codex-dialog-form-layout[open]")?.close(); setInspecting(null); setEditing(null); setDeleting(null); setSwitching(null); setSwitchAndLaunchCli(false); setRestoring(false); setCreatingInstance(null); setStoppingInstance(null); setDeletingInstance(null); setExporting(null); setError(""); };

  async function refresh(ids: number[], kind: "quota" | "benefits" = "quota") {
    if (refreshBatchRunning.current || batch) return;
    refreshBatchRunning.current = true; setNotice(""); setError("");
    await (async () => {
      stopBatch.current = false;
      let failures = 0;
      let processed = 0;
      const failureDetails: string[] = [];
      try {
        for (const id of ids) {
          if (!alive.current || stopBatch.current) break;
          if (refreshingRef.current.has(id)) continue;
          refreshingRef.current.add(id); setRefreshingIds(new Set(refreshingRef.current));
          const label = accounts.find(account => account.id === id)?.label ?? "账号";
          setBatch({ total: ids.length, done: processed, label, stopping: false });
          try {
            const account = kind === "quota" ? await codexClient.refreshQuota(id) : await codexClient.refreshBenefits(id);
            replace(account);
            const errors = kind === "quota"
              ? [account.lastError]
              : [account.benefits?.subscriptionError, account.benefits?.creditsError];
            const reasons = errors.filter((value): value is string => !!value);
            if (reasons.length) {
              failures++;
              failureDetails.push(`${label}：${reasons.map(reason => platformErrorMessage(reason, "刷新未完成")).join("；")}`);
            }
          } catch (reason) {
            failures++;
            failureDetails.push(`${label}：${platformErrorMessage(reason, "刷新请求失败")}`);
          }
          refreshingRef.current.delete(id); if (alive.current) setRefreshingIds(new Set(refreshingRef.current));
          processed++;
          if (alive.current) setBatch(current => current ? { ...current, done: processed } : null);
        }
        if (alive.current) {
          const detail = failureDetails.length ? `。${failureDetails.slice(0, 3).join("；")}${failureDetails.length > 3 ? `；另有 ${failureDetails.length - 3} 个失败账号` : ""}` : "";
          setNotice(`${stopBatch.current ? "已停止后续刷新，" : ""}已处理 ${processed} / ${ids.length} 个账号${failures ? `，${failures} 个未能完整更新${detail}` : kind === "quota" ? "，额度已更新" : "，订阅权益已更新"}`);
        }
      } finally { refreshBatchRunning.current = false; if (alive.current) setBatch(null); }
    })();
  }

  async function wake() {
    const ids = wakeIds;
    if (!ids?.length || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(wakeModel.trim())) return;
    await act("唤醒账号", async () => {
      stopBatch.current = false;
      let done = 0, failures = 0;
      try {
        for (const id of ids) {
          if (!alive.current || stopBatch.current) break;
          setBatch({ total: ids.length, done, label: accounts.find(account => account.id === id)?.label ?? "账号", stopping: false });
          try { await codexClient.wakeAccount(id, wakeModel.trim()); } catch { failures++; }
          done++;
        }
        if (alive.current) { setWakeIds(null); setNotice(`唤醒已处理 ${done} / ${ids.length} 个账号，成功 ${done - failures} 个，失败 ${failures} 个${stopBatch.current ? "，已停止后续请求" : ""}。额度需手动刷新以获取最新数据。`); }
      } finally { if (alive.current) setBatch(null); }
    });
  }

  async function batchDelete() {
    if (!deleteIds) return;
    await act("批量删除账号", async () => {
      const removed = new Set<number>();
      let failures = 0;
      for (const id of deleteIds) {
        try { await codexClient.deleteAccount(id); removed.add(id); } catch { failures++; }
      }
      const next = await codexClient.state();
      if (alive.current) { setState(next); setSelected(current => new Set([...current].filter(id => !removed.has(id)))); setDeleteIds(null); setNotice(`已将 ${removed.size} 个账号移入回收站${failures ? `，${failures} 个删除失败，请停止关联实例或服务后重试` : ""}`); }
    });
  }

  if (!runningInTauri) return <section className="codex-page"><header className="codex-heading"><div><span className="codex-eyebrow">AI 工具</span><h1>Codex 管理</h1><p>统一管理本机 Codex 账号与使用额度</p></div></header><div className="codex-empty"><ShieldCheck size={34} /><h2>请在桌面客户端中使用</h2><p>账号凭据、客户端切换和本机实例由 CloudHub 桌面端管理。</p></div></section>;

  return <section className={"codex-page codex-overview-reference" + (privacy ? " codex-privacy-view" : "")} aria-busy={!!busy}>
    {settingsOpen && <CodexSettingsDialog preferences={preferences} busy={!!busy} canOpenDefault={!!state?.canOpenDefault} onClose={() => setSettingsOpen(false)} onSave={next => void saveOverview(next)} onOpenGroups={() => { setSettingsOpen(false); setError(""); setGroupsOpen(true); }} onOpenLogs={() => { setSettingsOpen(false); setRemoteLogsOpen(true); }} onOpenApi={() => { setSettingsOpen(false); setActivePanel("api"); }} onStartCodex={() => { setSettingsOpen(false); void act("打开 Codex", async () => { await codexClient.openDefault(); if (alive.current) setNotice("已请求打开默认 Codex 客户端"); }); }} />}
    {addAccountOpen && <AddAccountDialog busy={!!busy} error={error} canOpenDefault={!!state?.canOpenDefault} onClose={() => setAddAccountOpen(false)} onOfficialLogin={() => void act("打开 Codex", async () => { await codexClient.openDefault(); if (alive.current) setNotice("请在官方 Codex 客户端完成登录，然后返回此窗口导入本机登录"); })} onOAuth={() => { setAddAccountOpen(false); void act("启动 OAuth 授权", async () => { const result = await codexClient.startLogin(); if (alive.current) { setLogin(result.token); setLoginUrl(result.authUrl); loginToken.current = result.token; } }); }} onImportLocal={() => { setAddAccountOpen(false); void act("导入本机", async () => { const next = await codexClient.importLocal(); if (alive.current) { setState(next); setNotice("已导入本机登录账号，重复身份会更新凭据"); } }); }} onImportText={async content => { if (operation.current) return false; operation.current = true; setBusy("导入账号"); setError(""); setNotice(""); try { const next = await codexClient.importText(content); if (alive.current) { setState(next); setAddAccountOpen(false); setNotice("账号导入完成，凭据已加密保存"); } return true; } catch { if (alive.current) setError("导入失败，请检查凭据格式、网络或账号运行状态后重试"); return false; } finally { operation.current = false; if (alive.current) setBusy(""); } }} onImportFile={format => { setAddAccountOpen(false); setError(""); setImportFormat(format); setImporting(true); }} />}
    {testAccounts && <AccountTestDialog accounts={testAccounts} models={models} onClose={() => setTestAccounts(null)} />}
    <header className="codex-heading"><div><span className="codex-eyebrow">AI 工具</span><h1><Bot size={25} />Codex 管理</h1><p>本地加密账号 · 订阅额度 · 客户端切换</p></div></header>
    <ConfigToolbar busy={!!busy} canRestore={!!state?.canRestore} onRestore={() => setRestoring(true)} />
    {groupsOpen && <AccountGroupsDialog groups={preferences.groups} accounts={accounts} busy={!!busy} error={error} onClose={() => setGroupsOpen(false)} onSave={groups => saveOverview({ ...preferences, groups }, () => { setGroupsOpen(false); if (!groups.some(group => group.id === groupId)) setGroupId(""); })} />}
    {recycleOpen && <CodexRecycleDialog onClose={() => setRecycleOpen(false)} onChanged={async () => { const next = await codexClient.state(); if (alive.current) setState(next); }} />}
    {deleteIds && <Modal title="批量删除 Codex 账号" busy={!!busy} onClose={() => setDeleteIds(null)}><p>将 {deleteIds.length} 个账号移入回收站，可在回收站恢复。关联的服务和实例必须先停止。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={() => setDeleteIds(null)}>取消</button><button disabled={!!busy || !deleteIds.length} onClick={() => void batchDelete()}>确认移入回收站</button></div></Modal>}
    {wakeIds && <Modal title="唤醒 Codex 账号" busy={!!busy} onClose={() => setWakeIds(null)}><p>向 {wakeIds.length} 个账号逐个发送真实的简短模型请求，会消耗额度。请先停止账号关联的服务和实例。</p><label>唤醒模型<input aria-label="唤醒模型" list="codex-wake-models" value={wakeModel} maxLength={128} disabled={!!busy} onChange={event => setWakeModel(event.target.value)} /><datalist id="codex-wake-models">{models.map(model => <option key={model} value={model} />)}</datalist></label><p>模型可用性由账号权限决定；失败账号会计入结果，可通过 API 日志排查。</p>{batch && <p role="status">{batch.done} / {batch.total} · {batch.label}</p>}{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions">{busy ? <button disabled={batch?.stopping} onClick={() => { stopBatch.current = true; setBatch(current => current ? { ...current, stopping: true } : null); }}>停止后续请求</button> : <><button onClick={() => setWakeIds(null)}>取消</button><button disabled={!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(wakeModel.trim())} onClick={() => void wake()}>确认消耗额度并唤醒</button></>}</div></Modal>}
    <div className="codex-tabs" role="tablist" aria-label="Codex 管理面板">
      {panels.map(({ id, label, icon: Icon }, index) => <button key={id} id={`codex-tab-${id}`} role="tab" aria-selected={activePanel === id} aria-controls={`codex-panel-${id}`} tabIndex={activePanel === id ? 0 : -1} onClick={() => setActivePanel(id)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % panels.length : event.key === "ArrowLeft" ? (index + panels.length - 1) % panels.length : event.key === "Home" ? 0 : event.key === "End" ? panels.length - 1 : null;
        if (next !== null) { event.preventDefault(); setActivePanel(panels[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }
      }}><Icon size={16} />{label}</button>)}
    </div>
    {toast && <div className={`codex-toast${toast.isError ? " is-error" : ""}`} role={toast.isError ? "alert" : "status"} aria-live={toast.isError ? "assertive" : "polite"} aria-atomic="true"><span>{toast.message}</span><button type="button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={14} /></button></div>}
    {error && <div className="codex-feedback error" role="alert">{error}</div>}
    {notice && <div className="codex-feedback" role="status">{notice}</div>}
    {(busy || batch) && <div className="codex-progress" role="status"><RefreshCw size={14} />{busy || "刷新账号"}中…{batch && <><span>{batch.done} / {batch.total} · {batch.label}</span><progress aria-label="账号刷新进度" max={batch.total} value={batch.done} /><button disabled={batch.stopping} onClick={() => { stopBatch.current = true; setBatch(current => current ? { ...current, stopping: true } : null); }}>{batch.stopping ? "等待当前账号完成" : "停止后续刷新"}</button></>}</div>}
    {login && <div className="codex-login" role="status"><div className="codex-login-link"><span>授权地址已生成，可在本机任意浏览器或无痕窗口打开（5 分钟内有效）</span><div className="codex-login-url"><input aria-label="授权登录地址" readOnly value={loginUrl} onFocus={event => event.target.select()} /><button disabled={!!busy || !loginUrl} onClick={() => void act("复制授权地址", async () => { await codexClient.copyLoginUrl(login); if (alive.current) setNotice("授权地址已复制，可在你选择的浏览器中打开"); })}><Copy size={14} />复制地址</button><button disabled={!!busy || !loginUrl} onClick={() => void act("打开登录页面", () => codexClient.openLoginUrl(login))}><ExternalLink size={14} />打开浏览器</button></div></div><button disabled={!!busy} onClick={() => void act("取消登录", async () => { await codexClient.cancelLogin(login); if (alive.current) { setLogin(null); setLoginUrl(""); loginToken.current = null; setNotice("已取消登录"); } })}>取消登录</button></div>}
    <section className="codex-tab-panel" id="codex-panel-providers" role="tabpanel" aria-labelledby="codex-tab-providers" hidden={activePanel !== "providers"} tabIndex={0}>{activePanel === "providers" && <ModelProviders onChanged={() => { void codexClient.state().then(v => { if (alive.current) setState(v); }).catch(() => { if (alive.current) setError("刷新账号失败"); }); void codexClient.instances().then(v => { if (alive.current) setInstances(v); }).catch(() => { if (alive.current) setError("刷新实例失败"); }); }} />}</section>
    <section className="codex-tab-panel" id="codex-panel-accounts" role="tabpanel" aria-labelledby="codex-tab-accounts" hidden={activePanel !== "accounts"} tabIndex={0}>
    {state && !state.cliAvailable && <p className="codex-hint">额度刷新、模型/上下文配置和 CLI 实例需要官方 Codex CLI；Codex 桌面客户端可通过桌面应用启动。账号导入与备注仍可使用。</p>}
    <div className="codex-toolbar"><div className="codex-overview-toolrow"><div className="codex-toolbar-filters"><label className="codex-search"><Search size={15} /><input aria-label="搜索 Codex 账号" placeholder="搜索账号、标签或备注" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="codex-plan"><Filter size={14} /><select aria-label="筛选 Codex 套餐" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">全部套餐</option>{plans.map((v) => <option key={v} value={v}>{v === "apikey" ? "API Key" : v === "chatgpt" ? "未知套餐" : v.toUpperCase()}</option>)}</select></label>
      <label className="codex-plan"><select aria-label="筛选 Codex 额度状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value as QuotaStatus | "")}><option value="">全部额度状态</option>{(Object.keys(quotaStatusNames) as QuotaStatus[]).map(status => <option key={status} value={status}>{quotaStatusNames[status]}</option>)}</select></label>
      <label className="codex-plan"><select aria-label="Codex 账号排序" value={sort} onChange={event => setSort(event.target.value)}><option value="default">当前账号优先</option><option value="quota">剩余额度从高到低</option><option value="fiveHour">5 小时额度从高到低</option><option value="weekly">每周额度从高到低</option><option value="expiry">订阅到期从近到远</option><option value="name">账号名称排序</option></select></label><label className="codex-plan"><select aria-label="筛选 Codex 标签" value={tagFilter} onChange={event => setTagFilter(event.target.value)}><option value="">标签筛选</option>{[...new Set(accounts.flatMap(account => account.tags))].sort().map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label><button aria-label="反转账号排序" aria-pressed={reverseSort} onClick={() => setReverseSort(!reverseSort)}>排序 {reverseSort ? "↑" : "↓"}</button><div className="codex-view-switch" role="group" aria-label="账号视图"><button type="button" aria-label="卡片视图" aria-pressed={viewMode === "grid"} disabled={!!busy || !preferencesReady} onClick={() => void saveOverview({ ...preferences, view: "grid" })}><LayoutGrid size={16} /></button><button type="button" aria-label="列表视图" aria-pressed={viewMode === "list"} disabled={!!busy || !preferencesReady} onClick={() => void saveOverview({ ...preferences, view: "list" })}><List size={16} /></button><button type="button" aria-label="表格视图" aria-pressed={viewMode === "table"} disabled={!!busy || !preferencesReady} onClick={() => void saveOverview({ ...preferences, view: "table" })}><Server size={16} /></button></div></div><div className="codex-actions">
      <button aria-label="添加 Codex 账号" title="添加 Codex 账号" disabled={!!busy} onClick={() => { setError(""); setAddAccountOpen(true); }}><Plus size={15} /></button>
      <button disabled={!!busy} title="重新读取账号列表" aria-label="重新读取账号列表" onClick={() => void act("加载", async () => { const next = await codexClient.state(); if (alive.current) setState(next); })}><RefreshCw size={15} /></button>
      <button aria-label={privacy ? "显示账号信息" : "隐藏账号信息"} aria-pressed={privacy} title={privacy ? "显示账号信息" : "隐藏账号信息"} onClick={() => setPrivacy(!privacy)}>{privacy ? <Eye size={15} /> : <EyeOff size={15} />}</button>
      <button aria-label="导出所选账号 JSON" title="导出所选账号 JSON" disabled={!!busy || !accounts.length} onClick={() => { setError(""); setExporting({ accountId: null, ids: accounts.filter(account => selected.has(account.id)).map(account => String(account.id)), format: "cockpit_tools" }); }}><Upload size={15} /></button>
      <button aria-label="管理账号分组" title="管理账号分组" disabled={!!busy || !preferencesReady} onClick={() => { setError(""); setGroupsOpen(true); }}><FolderOpen size={15} /></button>
      <button aria-label="Codex 设置" title="Codex 设置" disabled={!!busy || !preferencesReady} onClick={() => { setError(""); setSettingsOpen(true); }}><Settings size={15} /></button></div></div><div className="codex-toolbar-actions">
      <label className="codex-select"><input type="checkbox" checked={allSelected} disabled={!visible.length || !!busy} onChange={() => setSelected((current) => { const next = new Set(current); visible.forEach((v) => allSelected ? next.delete(v.id) : next.add(v.id)); return next; })} />全选</label>
      <div className="codex-group-tabs" role="group" aria-label="账号分组"><button aria-pressed={!groupId} onClick={() => setGroupId("")}>全部 <strong>{accounts.length}</strong></button>{preferences.groups.map(group => <button key={group.id} aria-pressed={groupId === group.id} onClick={() => setGroupId(group.id)}>{group.name} <strong>{accounts.filter(account => group.accountIds.includes(account.id)).length}</strong></button>)}<button disabled={!!busy || !preferencesReady} onClick={() => { setError(""); setGroupsOpen(true); }}><Plus size={14} />管理分组</button></div><span className="codex-hint-inline" role="status">显示 {visible.length} / {accounts.length} 个 · 已选 {selected.size} 个</span>
      <button disabled={!!busy || !selected.size} onClick={() => setSelected(new Set())}>清空选择</button>
<button disabled={!!busy || !proxyTargets.length} onClick={() => { setError(""); setProxyAccounts(proxyTargets); }}><ShieldCheck size={14} />批量设置代理 ({proxyTargets.length})</button>
<button disabled={!!busy || !selected.size || !state?.cliAvailable || !targets.length} onClick={() => void refresh(targets.map(account => account.id))}><RefreshCw size={14} />刷新所选 ({selected.size ? targets.length : 0})</button>
<button disabled={!!busy || !selected.size || !targets.length} onClick={() => void refresh(targets.map(account => account.id), "benefits")}><RefreshCw size={14} />刷新所选订阅权益</button>
<button disabled={!!busy || !selected.size} onClick={() => { setError(""); setDeleteIds(accounts.filter(account => selected.has(account.id)).map(account => account.id)); }}>删除所选 ({selected.size})</button>
      <button disabled={!!busy || !targets.length} onClick={() => void act("读取测试模型", async () => { const available = gateway?.running ? await codexClient.gatewayModels() : []; if (alive.current) { setModels(available); setTestAccounts(targets); } })}><Bot size={14} />鹈鹕测智</button>
      <button disabled={!!busy} onClick={() => setRecycleOpen(true)}><Trash2 size={14} />回收站</button>
      <button disabled={!!busy || !targets.length} onClick={() => void act("读取唤醒模型", async () => { const available = gateway?.running ? await codexClient.gatewayModels() : []; if (alive.current) { setModels(available); setWakeModel(available[0] ?? ""); setWakeIds(targets.map(account => account.id)); } })}><Play size={14} />唤醒账号 ({targets.length})</button>
      {selected.size > 0 && preferences.groups.length > 0 && <label className="codex-plan"><select aria-label="将所选账号加入分组" value="" disabled={!!busy || !preferencesReady} onChange={event => { const id = event.target.value; if (id) void saveOverview({ ...preferences, groups: preferences.groups.map(group => group.id === id ? { ...group, accountIds: [...new Set([...group.accountIds, ...selected])] } : group) }); }}><option value="">加入分组 ({selected.size})</option>{preferences.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      {selected.size > 0 && groupId && <button disabled={!!busy || !preferencesReady} onClick={() => void saveOverview({ ...preferences, groups: preferences.groups.map(group => group.id === groupId ? { ...group, accountIds: group.accountIds.filter(id => !selected.has(id)) } : group) })}>从当前分组移除所选</button>}
      <button disabled={!!busy || !visible.some(account => account.lastError)} onClick={() => { setError(""); setDeleteIds(visible.filter(account => account.lastError).map(account => account.id)); }}>清理错误账号</button>
      {(query || plan || statusFilter || tagFilter) && <button onClick={() => { setQuery(""); setPlan(""); setStatusFilter(""); setTagFilter(""); }}>清除筛选</button>}
    </div></div>
    {state && !accounts.length ? <div className="codex-empty"><Bot size={35} /><h2>添加你的第一个 Codex 账号</h2><p>导入本机登录或选择账号 JSON。账号凭据只在本机加密保存。</p></div> : !visible.length && state ? <div className="codex-empty"><Search size={28} /><h2>没有匹配的账号</h2><p>调整搜索关键词、套餐或额度状态筛选。</p></div> : viewMode === "table" ? <AccountTable accounts={visible} selected={selected} currentId={state?.currentAccountId} busy={!!busy} refreshingIds={refreshingIds} now={now} onSelect={id => setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; })} onDetails={setInspecting} onSwitch={account => void act("准备切号", async () => { try { const preview = await codexClient.prepareSwitch(account.id); if (alive.current) setSwitching(preview); } catch (reason) { if (isCodexDefaultProcessBusy(reason)) { setCloseDefaultRequest({ inPreview: false, retry: async () => { const preview = await codexClient.prepareSwitch(account.id); if (alive.current) setSwitching(preview); } }); return; } throw reason; } })} onRefresh={account => void refreshOne(account.id)} onLogs={setLogsAccount} onDelete={account => { setError(""); setDeleting(account); }} /> : <div className={"codex-grid codex-reference-grid" + (viewMode === "list" ? " codex-list-view" : "") + (preferences.compact ? " codex-compact-view" : "")}>{preferences.showServiceEntry && <ServiceSummary accounts={accounts} state={gateway} lanUrl={summaryLanUrl} active={activePanel === "accounts"} busy={!!busy} onOpen={kind => { setActivePanel("api"); setGatewayAction(current => ({id:(current?.id ?? 0)+1,kind})); }} onInstances={() => setActivePanel("instances")} onRefresh={() => void act("刷新服务统计", async () => { const next = await codexClient.gatewayState(); if (alive.current) setGateway(next); })} />}{visible.map((account) => <article className={`codex-card${state?.currentAccountId === account.id ? " current" : ""}`} key={account.id} aria-label={`Codex 账号 ${account.label}`}>
      <div className="codex-card-title"><input type="checkbox" aria-label={`选择 ${account.label}`} checked={selected.has(account.id)} disabled={!!busy} onChange={() => setSelected((current) => { const next = new Set(current); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next; })} /><h2 title={account.label}>{account.label}</h2>{account.isWebSession && <span className="codex-badge codex-web-session-badge" title="仅支持查看额度">Web Session</span>}{state?.currentAccountId === account.id && <span className="codex-badge codex-current-badge">当前</span>}{account.lastError && <span className="codex-badge codex-error-badge">刷新失败</span>}<span className={"codex-badge codex-plan-badge" + (account.plan && account.plan !== "free" ? " is-paid" : "")}>{account.authMode === "apikey" ? "API KEY" : account.plan?.toUpperCase() ?? "未知套餐"}</span></div>
      <div className="codex-tags">{account.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      <AccountControls refreshing={refreshingIds.has(account.id)} account={account} busy={!!busy || refreshingIds.has(account.id)} onRefreshBenefits={() => refreshOne(account.id, "benefits")} act={act} onAccount={replace} onNotice={setNotice} onEdit={() => { setError(""); setEditing({ id: account.id, label: account.label, note: account.note, tags: account.tags.join(", ") }); }} headerAction={!account.isWebSession && <button className="codex-pool-link" disabled={!!busy || !gateway?.supportsPoolPersistence || gateway.running} title={gateway?.running ? "请先停止 API 服务再修改账号池" : "账号池选择会保存到本机"} onClick={() => void act("保存服务账号池", async () => { const current = await codexClient.gatewayState(); if (current.running) throw new Error("请先停止 API 服务再修改账号池"); const ids = new Set(current.startupAccountIds ?? current.accountIds); ids.has(account.id) ? ids.delete(account.id) : ids.add(account.id); const next = await codexClient.saveGatewayPool([...ids]); if (alive.current) { setGateway(next); setExternalPool(next.startupAccountIds ?? [...ids]); setNotice("服务账号池已保存"); } })}><Link2 size={12} />{(gateway?.startupAccountIds ?? []).includes(account.id) ? "移除 API 服务" : "添加至 API 服务"}</button>}>
      {account.authMode === "chatgpt" && <p className="codex-account-id" title={"用户 ID：" + (account.userId ?? "未获取") + " · 工作区 ID：" + (account.accountId ?? "未获取")}>{account.loginProvider ? "使用 " + ({ google: "Google", apple: "Apple", windowslive: "Microsoft", microsoft: "Microsoft", auth0: "邮箱", openai: "OpenAI" }[account.loginProvider.toLowerCase()] ?? account.loginProvider) + " 登录" : "登录方式未获取"} | 用户 ID：{account.userId ?? "未获取"}</p>}
      {account.lastError && <AccountRefreshError key={account.lastError} accountLabel={account.label} reason={account.lastError}>{account.authMode === "chatgpt" && <button disabled={!!busy || !!login || !state?.cliAvailable} onClick={() => void act("重新授权", async () => { const result = await codexClient.startLogin(account.id); if (alive.current) { setLogin(result.token); setLoginUrl(result.authUrl); loginToken.current = result.token; setNotice("请使用该账号重新登录，完成后会核对身份并更新凭据"); } else await codexClient.cancelLogin(result.token); })}>重新授权</button>}</AccountRefreshError>}
      <div className={"codex-account-status" + ((quotaPresentation(account, now).status === "stale") ? "" : " codex-visually-hidden")} data-status={quotaPresentation(account, now).status}>{quotaStatusNames[quotaPresentation(account, now).status]}{(quotaPresentation(account, now).status === "stale") ? " · 以下为上次缓存" : ""}</div>
      <div className="codex-quota">{account.quota.windows.length ? account.quota.windows.map((window, index) => <div className={"codex-quota-window" + (remainingPercent(window) != null && remainingPercent(window)! <= 20 ? " is-low" : "")} key={`${window.name}-${index}`}><div className="codex-quota-label"><span>{windowName(window.windowMinutes)}</span><strong>{remainingPercent(window) == null ? "额度未知" : `${Math.round(remainingPercent(window)!)}% 剩余`}</strong></div>{remainingPercent(window) != null && <progress aria-label={`${window.name}剩余额度`} max={100} value={remainingPercent(window)!} />}<small title="距额度重置剩余时间">{quotaResetTime(window.resetsAt, now)}</small></div>) : <p>{account.authMode === "apikey" ? "API Key 按 API 账单计费，不展示订阅额度" : "尚未获取额度"}</p>}</div>
      </AccountControls>
      {account.note && <p className="codex-note">{account.note}</p>}
      <div className="codex-card-bottom"><small title={"额度更新：" + time(account.quota.fetchedAt)}>{time(account.quota.fetchedAt)}</small><div className="codex-card-actions">
        <button disabled={!!busy || account.isWebSession || !state?.cliAvailable} aria-label={`启动 ${account.label} 的 Codex CLI`} title={account.isWebSession ? "Web Session 账号不能启动 CLI" : !state?.cliAvailable ? "需要安装并检测到官方 Codex CLI" : "启动此账号的 Codex CLI"} onClick={() => {
          setError("");
          if (state?.currentAccountId === account.id) {
            setSwitchAndLaunchCli(false);
            void act("启动 Codex CLI", async () => {
              try {
                await codexClient.openDefaultCli();
                if (alive.current) setNotice("已使用当前账号启动 Codex CLI");
              } catch (reason) {
                if (isCodexDefaultProcessBusy(reason)) {
                  setCloseDefaultRequest({ inPreview: false, retry: async () => { await codexClient.openDefaultCli(); if (alive.current) setNotice("已使用当前账号启动 Codex CLI"); } });
                  return;
                }
                throw reason;
              }
            });
          } else {
            setSwitchAndLaunchCli(true);
            void act("准备启动 CLI", async () => {
              try {
                const preview = await codexClient.prepareSwitch(account.id);
                if (alive.current) setSwitching(preview);
              } catch (reason) {
                if (isCodexDefaultProcessBusy(reason)) {
                  setCloseDefaultRequest({ inPreview: false, retry: async () => { const preview = await codexClient.prepareSwitch(account.id); if (alive.current) setSwitching(preview); } });
                  return;
                }
                if (alive.current) setSwitchAndLaunchCli(false);
                throw reason;
              }
            });
          }
        }}><Terminal size={15}/></button>
        <button disabled={!!busy} aria-label={`编辑 ${account.label} 标签`} title="编辑账号标签和备注" onClick={() => { setError(""); setEditing({ id: account.id, label: account.label, note: account.note, tags: account.tags.join(", ") }); }}><Tag size={15} /></button>
        <button disabled={!!busy} aria-label={`查看 ${account.label} 信息`} title="查看账号信息" onClick={() => setInspecting(account)}><FileText size={15} /></button>
        <button disabled={!!busy || account.isWebSession} aria-label={`启动预览 ${account.label}`} title={account.isWebSession ? "Web Session 账号仅支持查看额度" : "Codex 桌面启动预览"} onClick={() => { setSwitchAndLaunchCli(false); setError(""); setLaunchAccountId(account.id); }}><Play size={15} /><span className="codex-visually-hidden">切换</span></button>
        <button aria-busy={refreshingIds.has(account.id)} disabled={!!busy || refreshingIds.has(account.id) || account.authMode !== "chatgpt" || (!account.isWebSession && !state?.cliAvailable)} aria-label={`刷新 ${account.label} 额度`} title={refreshingIds.has(account.id) ? "此账号正在刷新" : busy ? `${busy}中，请稍候` : account.authMode !== "chatgpt" ? "仅 ChatGPT 登录账号支持额度刷新" : !account.isWebSession && !state?.cliAvailable ? "需要安装并检测到官方 Codex CLI" : account.isWebSession ? "仅刷新此账号的额度" : "刷新账号：额度百分比、额度重置时间、订阅有效期和剩余重置次数"} onClick={() => void refreshOne(account.id)}><RefreshCw className={refreshingIds.has(account.id) ? "codex-refresh-spinning" : undefined} size={15} /></button>
        <button disabled={!!busy || !!gateway?.running || instances.some(instance => instance.running)} aria-label={`导出 ${account.label} JSON`} title={gateway?.running || instances.some(instance => instance.running) ? "请先停止 API 服务和独立实例再备份" : "导出此账号的登录 JSON"} onClick={() => { setError(""); setExporting({ accountId: account.id, ids: [String(account.id)], format: "cockpit_tools" }); }}><Upload size={15} /></button>
        <button disabled={!!busy} aria-label={`查看 ${account.label} 日志记录`} title="查看账号日志记录" onClick={() => setLogsAccount(account)}><History size={15} /></button>
        <button disabled={!!busy} aria-label={`删除 ${account.label}`} title="从 CloudHub 删除账号" onClick={() => { setError(""); setDeleting(account); }}><Trash2 size={15} /></button>
      </div></div>
    </article>)}</div>}
    </section>
    <section className="codex-tab-panel" id="codex-panel-api" role="tabpanel" aria-labelledby="codex-tab-api" hidden={activePanel !== "api"} tabIndex={0}><CodexGateway accounts={accounts} disabled={!!busy} onStateChange={setGateway} externalPool={externalPool} onLanUrlChange={setSummaryLanUrl} actionRequest={gatewayAction} /></section>
    <section className="codex-tab-panel" id="codex-panel-instances" role="tabpanel" aria-labelledby="codex-tab-instances" hidden={activePanel !== "instances"} tabIndex={0}>
    <div className="codex-instances"><h2><Terminal size={18} />应用多开 <small>{instances.length}</small></h2>
      <div className="codex-instance-toolbar"><label>选择账号<select value={instanceAccount ? String(instanceAccount.id) : ""} disabled={!!busy || !accounts.some(account => !account.isWebSession)} onChange={(event) => setInstanceAccountId(event.target.value)}>{!accounts.some(account => !account.isWebSession) && <option value="">暂无可启动账号</option>}{accounts.filter(account => !account.isWebSession).map((account) => <option key={account.id} value={String(account.id)}>{account.label}</option>)}</select></label><button disabled={!!busy || !instanceAccount || (!state?.cliAvailable && !state?.desktopAvailable)} onClick={() => { if (instanceAccount) { setError(""); setCreatingInstance({ accountId: instanceAccount.id, name: `${instanceAccount.label} 实例`, kind: state?.desktopAvailable ? "desktop" : "cli" }); } }}><Plus size={15} />创建独立实例</button></div>
      <p className="codex-hint">每个实例保留独立登录、窗口数据与会话。停止会结束该实例的任务并保存登录状态；默认 ChatGPT 账号须先切换为其他账号，才能启动其独立实例，避免登录续期冲突。</p>
      {!instances.length ? <p className="codex-hint">选择账号并创建实例，也可以从账号总览的终端按钮进入。</p> : instances.map((instance) => <article className="codex-instance" key={instance.id}><div><strong>{instance.name} <small>{instance.kind === "desktop" ? "桌面" : "CLI"}</small></strong><span>{accounts.find((a) => a.id === instance.accountId)?.label ?? "账号不可用"} · {instance.running ? "运行中" : "已停止"}</span><small title={instance.workDir}>{instance.workDir}</small>{instance.lastError && <p className="codex-card-error">{instance.lastError}</p>}</div><button disabled={!!busy || (instance.kind === "desktop" ? !state?.desktopAvailable : !state?.cliAvailable)} onClick={() => instance.running ? setStoppingInstance(instance) : void act("启动实例", async () => { const next = await codexClient.startInstance(instance.id); if (alive.current) setInstances(next); })}>{instance.running ? <Square size={14} /> : <Play size={14} />}{instance.running ? "停止" : "启动"}</button><button disabled={!!busy || instance.running} title="删除实例配置" aria-label={`删除实例 ${instance.name}`} onClick={() => { setError(""); setDeletingInstance(instance); }}><Trash2 size={14} /></button></article>)}
    </div>
    </section>
    {state && activePanel === "accounts" && <footer className="codex-footer"><span><ShieldCheck size={14} />默认目录：{state.profileHome}</span><button disabled={!!busy || !state.canRestore} onClick={() => { setError(""); setRestoring(true); }}><RotateCcw size={14} />恢复切换前登录</button></footer>}
    {remoteLogsOpen && <RemoteApiLogs accounts={accounts} onClose={() => setRemoteLogsOpen(false)} />}
    {proxyAccounts && <BatchProxyDialog accounts={proxyAccounts} busy={!!busy} act={act} onClose={() => setProxyAccounts(null)} onSaved={next => { setState(current => current ? { ...current, accounts: current.accounts.map(account => next.find(updated => updated.id === account.id) ?? account) } : current); setProxyAccounts(null); setNotice(`已更新 ${next.length} 个账号的代理设置`); }} />}
    {state && launchAccountId != null && accounts.find(a => a.id === launchAccountId) && <LaunchPreviewDialog account={accounts.find(a => a.id === launchAccountId)!} state={state} instances={instances} gateway={gateway} onClose={() => setLaunchAccountId(null)} onState={setState} onInstances={setInstances} onAccount={replace} onEdit={() => { const a = accounts.find(a => a.id === launchAccountId)!; setLaunchAccountId(null); setEditing({ id: a.id, label: a.label, note: a.note, tags: a.tags.join(", ") }); }} onExport={() => { setLaunchAccountId(null); setExporting({ accountId: launchAccountId, ids: [String(launchAccountId)], format: "cockpit_tools" }); }} onApi={() => { setLaunchAccountId(null); setActivePanel("api"); }} onDefaultBusy={retry => { setCloseDefaultError(""); setCloseDefaultRequest({ retry, inPreview: true }); }} onPool={async () => { const current = await codexClient.gatewayState(); if (current.running) throw new Error("请先停止 API 服务再修改账号池"); const ids = new Set(current.startupAccountIds ?? current.accountIds); ids.has(launchAccountId) ? ids.delete(launchAccountId) : ids.add(launchAccountId); const next = await codexClient.saveGatewayPool([...ids]); setGateway(next); setExternalPool(next.startupAccountIds ?? [...ids]); }} />}
    {inspecting && <AccountDetailsDialog account={inspecting} onClose={close} onChanged={async () => { const next = await codexClient.state(); if (alive.current) { setState(next); setInspecting(next.accounts.find(a => a.id === inspecting.id) ?? null); } }} />}
    {logsAccount && <CodexAccountLogsDialog account={logsAccount} onClose={() => setLogsAccount(null)} />}
    {editing && <Modal title="编辑 Codex 账号" eyebrow="ACCOUNT" layout="form" busy={!!busy} onClose={close}><form onSubmit={(e) => { e.preventDefault(); void act("保存备注", async () => { const account = await codexClient.saveMetadata({ ...editing, tags: [...new Set(editing.tags.split(/[,，]/).map((v) => v.trim()).filter(Boolean))] }); replace(account); if (alive.current) { setEditing(null); setNotice("账号信息已保存"); } }); }}><div className="codex-dialog-form-content"><p className="codex-dialog-callout">名称、标签和备注仅更新 CloudHub 中的账号资料，不会修改 Codex 登录状态。</p><section className="codex-dialog-form-section" aria-labelledby="codex-account-profile-heading"><div className="codex-dialog-section-heading"><h3 id="codex-account-profile-heading">账号资料</h3><span>用于识别和筛选账号</span></div><label>账号名称<input autoFocus required maxLength={160} value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></label><label>标签（逗号分隔）<input value={editing.tags} maxLength={820} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></label></section><section className="codex-dialog-form-section" aria-labelledby="codex-account-note-heading"><div className="codex-dialog-section-heading"><h3 id="codex-account-note-heading">备注</h3><span>最多 2000 个字符</span></div><label>账号备注<textarea value={editing.note} maxLength={2000} rows={4} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></label></section>{error && <p role="alert" className="codex-card-error">{error}</p>}</div><footer className="codex-dialog-actions"><button type="button" disabled={!!busy} onClick={close}>取消</button><button className="codex-dialog-primary" disabled={!!busy || !editing.label.trim()}>保存账号信息</button></footer></form></Modal>}
    {deleting && <Modal title="删除 Codex 账号" busy={!!busy} onClose={close}><p>将「{deleting.label}」移入回收站，可在回收站恢复。默认客户端登录和历史会话目录会保留。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button className="danger" disabled={!!busy} onClick={() => void act("删除账号", async () => { const next = await codexClient.deleteAccount(deleting.id); if (alive.current) { setState(next); setSelected((current) => { const ids = new Set(current); ids.delete(deleting.id); return ids; }); setDeleting(null); setNotice("账号已移入回收站"); } })}>确认删除账号</button></div></Modal>}
    {switching && <Modal title={switchAndLaunchCli ? "切换账号并启动 CLI" : "切换默认 Codex 账号"} busy={!!busy} onClose={close}><p>将默认客户端切换到「{switching.accountLabel}」。请先结束正在运行的 Codex 任务，并关闭默认客户端{switchAndLaunchCli ? "；确认后会启动 CLI 终端" : "，完成后重新打开"}。</p><p className="codex-path">{switching.profileHome}</p><p>{switching.hasPreviousAuth ? "原登录状态会暂存，可在页面底部恢复。" : "当前没有文件登录状态，可恢复为未登录。"}原有配置和会话保留；确认有效期为 90 秒。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} onClick={() => void act(switchAndLaunchCli ? "切换并启动 CLI" : "切换账号", async () => { const next = await codexClient.confirmSwitch(switching.token); if (!alive.current) return; setState(next); if (switchAndLaunchCli) { setSwitching(null); setSwitchAndLaunchCli(false); try { await codexClient.openDefaultCli(); } catch (reason) { throw new Error("账号已切换，CLI 启动失败。" + platformErrorMessage(reason, "请重试启动")); } setNotice("默认账号已切换并启动 Codex CLI"); } else { setSwitching(null); setNotice("默认账号已切换，请重新启动 Codex 客户端"); } })}>{switchAndLaunchCli ? "已结束任务，确认切换并启动 CLI" : "已结束任务，确认切换"}</button></div></Modal>}
    {restoring && <Modal title="恢复 Codex 登录" busy={!!busy} onClose={close}><p>恢复上一次切换前的登录状态。若客户端已更新认证文件，CloudHub 会停止恢复，避免覆盖新的登录。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} onClick={() => void act("恢复登录", async () => { const next = await codexClient.restoreProfile(); if (alive.current) { setState(next); setRestoring(false); setNotice("已恢复切换前的登录状态"); } })}>确认恢复登录</button></div></Modal>}
    {creatingInstance && <Modal title="创建独立 Codex 实例" eyebrow="CODEX INSTANCE" layout="form" busy={!!busy} onClose={close}><form onSubmit={(event) => { event.preventDefault(); void act("创建实例", async () => { const next = await codexClient.createInstance(creatingInstance.accountId, creatingInstance.name, creatingInstance.kind); if (next && alive.current) { setInstances(next); setCreatingInstance(null); setActivePanel("instances"); setNotice("实例已创建，点击启动打开独立窗口或终端"); } }); }}><div className="codex-dialog-form-content"><p className="codex-dialog-callout">桌面实例会在窗口内提示选择项目；CLI 实例直接进入所选目录。每个实例使用独立登录与会话目录。</p><section className="codex-dialog-form-section" aria-labelledby="codex-instance-config-heading"><div className="codex-dialog-section-heading"><h3 id="codex-instance-config-heading">实例配置</h3><span>创建后可在“应用多开”中启动</span></div><div className="codex-dialog-fields"><label>实例名称<input autoFocus required maxLength={80} value={creatingInstance.name} onChange={(event) => setCreatingInstance({ ...creatingInstance, name: event.target.value })} /></label><label>实例类型<select aria-label="实例类型" value={creatingInstance.kind} onChange={(event) => setCreatingInstance({ ...creatingInstance, kind: event.target.value as "cli" | "desktop" })}><option value="desktop" disabled={!state?.desktopAvailable}>Codex 桌面窗口</option><option value="cli" disabled={!state?.cliAvailable}>Codex CLI 终端</option></select></label></div></section>{error && <p role="alert" className="codex-card-error">{error}</p>}</div><footer className="codex-dialog-actions"><button type="button" disabled={!!busy} onClick={close}>取消</button><button className="codex-dialog-primary" disabled={!!busy || !creatingInstance.name.trim()}>选择项目目录</button></footer></form></Modal>}
    {stoppingInstance && <Modal title="停止 Codex 实例" busy={!!busy} onClose={close}><p>停止「{stoppingInstance.name}」会结束终端及正在运行的任务。请先保存工作。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} className="danger" onClick={() => void act("停止实例", async () => { const next = await codexClient.stopInstance(stoppingInstance.id); if (alive.current) { setInstances(next); setStoppingInstance(null); setState(await codexClient.state()); } })}>确认停止实例</button></div></Modal>}
    {exporting && <Modal title="导出 Codex 账号" busy={!!busy} onClose={close} footer={<><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy || !exporting.ids.length || (exporting.format === "cpa" && cpaExportUnavailable)} onClick={() => void act("导出账号", async () => { if (await codexClient.exportAccountsFile(exporting.accountId, exporting.ids.map(Number), exporting.format) && alive.current) { setExporting(null); setNotice(`账号已导出为 ${exporting.format}`); } })}>选择保存位置</button></>}>{!exporting.accountId && <ExportChecklist items={accounts.map(account => ({ id: String(account.id), label: account.label }))} selected={exporting.ids} disabled={!!busy} onChange={ids => setExporting({ ...exporting, ids })} />}<label className="codex-export-format">导出格式<select value={exporting.format} disabled={!!busy} onChange={event => setExporting({ ...exporting, format: event.target.value as CodexExportFormat })}><option value="cockpit_tools">Cockpit Tools（推荐）</option><option value="auth_json">官方 auth.json</option><option value="sub2api">Sub2API</option><option value="cpa" disabled={cpaExportUnavailable}>CPA{cpaExportUnavailable ? "（当前选择含 API Key 账号）" : ""}</option></select></label><p>{exporting.format === "sub2api" ? "生成可导入 Sub2API 的账号数据文件。" : exporting.format === "auth_json" ? "单账号导出为 auth.json；多个账号会分别打包为 ZIP。" : exporting.format === "cpa" ? "生成 CLIProxyAPI 凭据格式；多个账号分别打包为 ZIP。" : "生成可由 Cockpit Tools 导入的账号数据文件。"} 文件包含登录凭据，请妥善保管。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}</Modal>}
    {importing && <Modal title="导入 Codex 账号" busy={!!busy} onClose={() => setImporting(false)}><label className="codex-export-format">导入格式<select value={importFormat} disabled={!!busy} onChange={event => setImportFormat(event.target.value as CodexExportFormat)}><option value="cockpit_tools">Cockpit Tools</option><option value="auth_json">官方 auth.json</option><option value="sub2api">Sub2API</option><option value="cpa">CPA</option></select></label><p>{importFormat === "auth_json" ? "选择官方 auth.json；多个账号的 ZIP 备份也可导入。" : importFormat === "cpa" ? "选择 CPA 凭据 JSON，或包含多个 JSON 文件的 ZIP。" : importFormat === "sub2api" ? "选择 Sub2API 导出的账号数据 JSON。" : "选择 Cockpit Tools 导出的账号数据 JSON。"} 重复账号会更新凭据，并在本机加密保存。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={() => setImporting(false)}>取消</button><button disabled={!!busy} onClick={() => void act("导入账号", async () => { const next = await codexClient.importFile(importFormat); if (next && alive.current) { setState(next); setImporting(false); setNotice("账号导入完成，凭据已加密保存"); } })}>选择文件</button></div></Modal>}
    {deletingInstance && <Modal title="删除 Codex 实例配置" busy={!!busy} onClose={close}><p>删除「{deletingInstance.name}」的实例配置和登录凭据。独立目录中的历史会话保留。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} className="danger" onClick={() => void act("删除实例", async () => { const next = await codexClient.deleteInstance(deletingInstance.id); if (alive.current) { setInstances(next); setDeletingInstance(null); } })}>确认删除实例配置</button></div></Modal>}
    {closeDefaultRequest && createPortal(<ConfirmDialog title="关闭正在运行的 Codex" message="关闭正在运行的 Codex 桌面客户端和 CLI（包括 codex.exe）后，将继续刚才的切换或启动操作；若原操作包含启动，会启动所选客户端。正在进行的任务可能中断，请先确认没有未保存内容；CloudHub 管理的独立实例或 API 服务运行时不会被关闭。" confirmLabel="关闭并重试" busy={closeDefaultBusy} error={closeDefaultError} onResolve={confirmed => void resolveCloseDefault(confirmed)} />, closeDefaultRequest.inPreview ? document.querySelector<HTMLDialogElement>('dialog[aria-label="Codex 启动预览"]') ?? document.body : document.body)}
  </section>;
}
