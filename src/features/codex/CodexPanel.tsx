import { ExportChecklist } from "../../shared/ExportSelection";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Check, Copy, Download, ExternalLink, FileText, Filter, Link2, Play, Plus, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Square, Tag, Terminal, Trash2, Upload, Users, X } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { codexClient, type CodexAccount, type CodexExportFormat, type CodexGatewayState, type CodexInstance, type CodexState, type CodexSwitchPreview } from "../../platform/clients/codex";
import "./codex.css";
import { AccountControls } from "./AccountControls";
import { RemoteApiLogs } from "./RemoteApiLogs";
import { BatchProxyDialog } from "./BatchProxyDialog";
import { CodexGateway } from "./CodexGateway";
import { ServiceSummary, type GatewayAction } from "./ServiceSummary";
import { quotaPresentation, quotaResetTime, quotaStatusNames, remainingPercent, useQuotaClock, windowName, type QuotaStatus } from "./quotaPresentation";

function Modal({ title, busy, onClose, children, eyebrow, layout }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; eyebrow?: string; layout?: "form" }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`codex-dialog dialog-common-theme${layout === "form" ? " codex-dialog-form-layout" : ""}`} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div className="codex-dialog-heading">{eyebrow && <span className="codex-dialog-eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><DialogHeaderActions><button type="button" disabled={busy} onClick={onClose} aria-label="关闭对话框" title="关闭"><X size={17} /></button></DialogHeaderActions></header>{layout === "form" ? <div className="codex-dialog-form-body">{children}</div> : <div className="codex-dialog-content">{children}</div>}
  </dialog>;
}

const time = (value: number | null) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未刷新";

const panels = [{ id: "accounts", label: "账号总览", icon: Users }, { id: "api", label: "API 反代服务", icon: Server }, { id: "instances", label: "应用多开", icon: Terminal }] as const;

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
  const [plan, setPlan] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuotaStatus | "">("");
  const [sort, setSort] = useState("default");
  const now = useQuotaClock();
  const [batch, setBatch] = useState<{ total: number; done: number; label: string; stopping: boolean } | null>(null);
  const stopBatch = useRef(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [remoteLogsOpen, setRemoteLogsOpen] = useState(false);
  const [proxyAccounts, setProxyAccounts] = useState<CodexAccount[] | null>(null);
  const [inspecting, setInspecting] = useState<CodexAccount | null>(null);
  const [editing, setEditing] = useState<{ id: number; label: string; note: string; tags: string } | null>(null);
  const [deleting, setDeleting] = useState<CodexAccount | null>(null);
  const [switching, setSwitching] = useState<CodexSwitchPreview | null>(null);
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
      catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "读取 Codex 实例失败"); }
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
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Codex 操作失败，请重试"); }
    finally { operation.current = false; if (alive.current) setBusy(""); }
  }

  function replace(account: CodexAccount) { if (alive.current) setState((current) => current ? { ...current, accounts: current.accounts.map((v) => v.id === account.id ? account : v) } : current); }
  const accounts = state?.accounts ?? [];
  const cpaExportUnavailable = exporting?.ids.some(id => accounts.find(account => String(account.id) === id)?.authMode !== "chatgpt") ?? false;
  const instanceAccount = accounts.find((account) => String(account.id) === instanceAccountId) ?? accounts[0];
  const visible = useMemo(() => {
    const filtered = accounts.filter(account => (!plan || (account.plan ?? account.authMode) === plan) && (!statusFilter || quotaPresentation(account, now).status === statusFilter) && [account.label, account.email, account.accountId, account.note, ...account.tags].some(text => text?.toLowerCase().includes(query.trim().toLowerCase())));
    const compareNullable = (a: number | null | undefined, b: number | null | undefined, descending = false) => a == null ? b == null ? 0 : 1 : b == null ? -1 : descending ? b - a : a - b;
    return filtered.sort((a, b) => {
      let comparison = 0;
      if (sort === "quota") comparison = compareNullable(quotaPresentation(a, now).remaining, quotaPresentation(b, now).remaining, true);
      else if (sort === "expiry") comparison = compareNullable(a.benefits?.expiresAt, b.benefits?.expiresAt);
      else if (sort === "name") comparison = a.label.localeCompare(b.label, "zh-CN", { numeric: true });
      else comparison = Number(b.id === state?.currentAccountId) - Number(a.id === state?.currentAccountId);
      return comparison || a.id - b.id;
    });
  }, [accounts, query, plan, statusFilter, sort, now, state?.currentAccountId]);
  const targets = visible.filter(account => account.authMode === "chatgpt" && (!selected.size || selected.has(account.id)));
  const proxyTargets = visible.filter(account => selected.has(account.id));
  const statusCounts = accounts.reduce<Partial<Record<QuotaStatus, number>>>((counts, account) => { const status = quotaPresentation(account, now).status; counts[status] = (counts[status] ?? 0) + 1; return counts; }, {});
  const plans = [...new Set(accounts.map((account) => account.plan ?? account.authMode))].sort();
  const allSelected = visible.length > 0 && visible.every((v) => selected.has(v.id));
  const close = () => { document.querySelector<HTMLDialogElement>(".codex-dialog-form-layout[open]")?.close(); setInspecting(null); setEditing(null); setDeleting(null); setSwitching(null); setRestoring(false); setCreatingInstance(null); setStoppingInstance(null); setDeletingInstance(null); setExporting(null); setError(""); };

  async function refresh(ids: number[], kind: "quota" | "benefits" = "quota") {
    await act(kind === "quota" ? "刷新额度" : "刷新订阅权益", async () => {
      stopBatch.current = false;
      let failures = 0;
      let processed = 0;
      const failureDetails: string[] = [];
      try {
        for (const id of ids) {
          if (!alive.current || stopBatch.current) break;
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
          processed++;
          if (alive.current) setBatch(current => current ? { ...current, done: processed } : null);
        }
        if (alive.current) {
          const detail = failureDetails.length ? `。${failureDetails.slice(0, 3).join("；")}${failureDetails.length > 3 ? `；另有 ${failureDetails.length - 3} 个失败账号` : ""}` : "";
          setNotice(`${stopBatch.current ? "已停止后续刷新，" : ""}已处理 ${processed} / ${ids.length} 个账号${failures ? `，${failures} 个未能完整更新${detail}` : kind === "quota" ? "，额度已更新" : "，订阅权益已更新"}`);
        }
      } finally { if (alive.current) setBatch(null); }
    });
  }

  if (!runningInTauri) return <section className="codex-page"><header className="codex-heading"><div><span className="codex-eyebrow">AI 工具</span><h1>Codex 管理</h1><p>统一管理本机 Codex 账号与使用额度</p></div></header><div className="codex-empty"><ShieldCheck size={34} /><h2>请在桌面客户端中使用</h2><p>账号凭据、客户端切换和本机实例由 CloudHub 桌面端管理。</p></div></section>;

  return <section className="codex-page" aria-busy={!!busy}>
    <header className="codex-heading"><div><span className="codex-eyebrow">AI 工具</span><h1><Bot size={25} />Codex 管理</h1><p>本地加密账号 · 订阅额度 · 客户端切换</p></div><div className="codex-actions">
      <button disabled={!!busy || !state?.canOpenDefault} title="打开默认 Codex 桌面客户端" onClick={() => void act("打开 Codex", async () => { await codexClient.openDefault(); if (alive.current) setNotice("已请求打开默认 Codex 客户端"); })}><Play size={15} />启动 Codex</button>
      <button disabled={!!busy || !!login || !state?.cliAvailable} onClick={() => void act("生成授权地址", async () => { const result = await codexClient.startLogin(); if (alive.current) { setLogin(result.token); setLoginUrl(result.authUrl); loginToken.current = result.token; } else await codexClient.cancelLogin(result.token); })}><Plus size={15} />登录新账号</button>
      <button disabled={!!busy} onClick={() => void act("导入本机", async () => { const next = await codexClient.importLocal(); if (alive.current) { setState(next); setNotice("已导入本机登录账号，重复身份会更新凭据"); } })}><Download size={15} />导入本机登录</button>
      <button disabled={!!busy} onClick={() => { setError(""); setImportFormat("cockpit_tools"); setImporting(true); }}><Upload size={15} />导入文件</button>
      <button disabled={!!busy || !accounts.length} onClick={() => { setError(""); setExporting({ accountId: null, ids: accounts.filter(account => selected.has(account.id)).map(account => String(account.id)), format: "cockpit_tools" }); }}><Upload size={15} />导出 JSON</button>
      <button disabled={!!busy} title="重新读取账号列表" aria-label="重新读取账号列表" onClick={() => void act("加载", async () => { const next = await codexClient.state(); if (alive.current) setState(next); })}><RefreshCw size={15} /></button>
    </div></header>
    <div className="codex-tabs" role="tablist" aria-label="Codex 管理面板">
      {panels.map(({ id, label, icon: Icon }, index) => <button key={id} id={`codex-tab-${id}`} role="tab" aria-selected={activePanel === id} aria-controls={`codex-panel-${id}`} tabIndex={activePanel === id ? 0 : -1} onClick={() => setActivePanel(id)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % panels.length : event.key === "ArrowLeft" ? (index + panels.length - 1) % panels.length : event.key === "Home" ? 0 : event.key === "End" ? panels.length - 1 : null;
        if (next !== null) { event.preventDefault(); setActivePanel(panels[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }
      }}><Icon size={16} />{label}</button>)}
    </div>
    {toast && <div className={`codex-toast${toast.isError ? " is-error" : ""}`} role={toast.isError ? "alert" : "status"} aria-live={toast.isError ? "assertive" : "polite"} aria-atomic="true"><span>{toast.message}</span><button type="button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={14} /></button></div>}
    {error && <div className="codex-feedback error" role="alert">{error}</div>}
    {notice && <div className="codex-feedback" role="status">{notice}</div>}
    {busy && <div className="codex-progress" role="status"><RefreshCw size={14} />{busy}中…{batch && <><span>{batch.done} / {batch.total} · {batch.label}</span><progress aria-label="账号刷新进度" max={batch.total} value={batch.done} /><button disabled={batch.stopping} onClick={() => { stopBatch.current = true; setBatch(current => current ? { ...current, stopping: true } : null); }}>{batch.stopping ? "等待当前账号完成" : "停止后续刷新"}</button></>}</div>}
    {login && <div className="codex-login" role="status"><div className="codex-login-link"><span>授权地址已生成，可在本机任意浏览器或无痕窗口打开（5 分钟内有效）</span><div className="codex-login-url"><input aria-label="授权登录地址" readOnly value={loginUrl} onFocus={event => event.target.select()} /><button disabled={!!busy || !loginUrl} onClick={() => void act("复制授权地址", async () => { await codexClient.copyLoginUrl(login); if (alive.current) setNotice("授权地址已复制，可在你选择的浏览器中打开"); })}><Copy size={14} />复制地址</button><button disabled={!!busy || !loginUrl} onClick={() => void act("打开登录页面", () => codexClient.openLoginUrl(login))}><ExternalLink size={14} />打开浏览器</button></div></div><button disabled={!!busy} onClick={() => void act("取消登录", async () => { await codexClient.cancelLogin(login); if (alive.current) { setLogin(null); setLoginUrl(""); loginToken.current = null; setNotice("已取消登录"); } })}>取消登录</button></div>}
    <section className="codex-tab-panel" id="codex-panel-accounts" role="tabpanel" aria-labelledby="codex-tab-accounts" hidden={activePanel !== "accounts"} tabIndex={0}>
    <div className="codex-summary-strip"><div className="codex-overview"><div><Users size={19} /><span>账号总数<strong>{accounts.length}</strong></span></div><div><Check size={19} /><span>已获取额度<strong>{accounts.filter((v) => v.quota.fetchedAt).length}</strong></span></div><div><Bot size={19} /><span>官方 CLI<strong>{state ? state.cliAvailable ? "已检测到" : "未检测到" : "检查中"}</strong></span></div></div>
    <div className="codex-status-summary" aria-label="Codex 额度状态概览">{(Object.keys(quotaStatusNames) as QuotaStatus[]).map(status => <button key={status} aria-pressed={statusFilter === status} onClick={() => setStatusFilter(current => current === status ? "" : status)}>{quotaStatusNames[status]} <strong>{statusCounts[status] ?? 0}</strong></button>)}</div><button disabled={!state?.supportsRemoteLogs} title={state?.supportsRemoteLogs ? "查看远端请求参数、响应与代理配置" : "需要新版原生程序支持"} onClick={() => setRemoteLogsOpen(true)}><FileText size={14} />API 日志</button></div>
    {state && !state.cliAvailable && <p className="codex-hint">额度刷新和实例启动需要安装官方 Codex CLI，并将其加入 PATH。账号导入与备注仍可使用。</p>}
    <div className="codex-toolbar"><div className="codex-toolbar-filters"><label className="codex-search"><Search size={15} /><input aria-label="搜索 Codex 账号" placeholder="搜索账号、标签或备注" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="codex-plan"><Filter size={14} /><select aria-label="筛选 Codex 套餐" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">全部套餐</option>{plans.map((v) => <option key={v} value={v}>{v === "apikey" ? "API Key" : v === "chatgpt" ? "未知套餐" : v.toUpperCase()}</option>)}</select></label>
      <label className="codex-plan"><select aria-label="筛选 Codex 额度状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value as QuotaStatus | "")}><option value="">全部额度状态</option>{(Object.keys(quotaStatusNames) as QuotaStatus[]).map(status => <option key={status} value={status}>{quotaStatusNames[status]}</option>)}</select></label>
      <label className="codex-plan"><select aria-label="Codex 账号排序" value={sort} onChange={event => setSort(event.target.value)}><option value="default">当前账号优先</option><option value="quota">剩余额度从高到低</option><option value="expiry">订阅到期从近到远</option><option value="name">账号名称排序</option></select></label></div><div className="codex-toolbar-actions">
      <label className="codex-select"><input type="checkbox" checked={allSelected} disabled={!visible.length || !!busy} onChange={() => setSelected((current) => { const next = new Set(current); visible.forEach((v) => allSelected ? next.delete(v.id) : next.add(v.id)); return next; })} />全选</label>
      <span className="codex-hint-inline" role="status">显示 {visible.length} / {accounts.length} 个 · 已选 {selected.size} 个</span>
      {selected.size > 0 && <button disabled={!!busy} onClick={() => setSelected(new Set())}>清空选择</button>}
      <button disabled={!!busy || !proxyTargets.length} onClick={() => { setError(""); setProxyAccounts(proxyTargets); }}><ShieldCheck size={14} />批量设置代理 ({proxyTargets.length})</button>
      <button disabled={!!busy || !state?.cliAvailable || !targets.length} onClick={() => void refresh(targets.map(account => account.id))}><RefreshCw size={14} />{selected.size ? `刷新所选 (${targets.length})` : "刷新列表额度"}</button>
      <button disabled={!!busy || !targets.length} onClick={() => void refresh(targets.map(account => account.id), "benefits")}><RefreshCw size={14} />刷新{selected.size ? "所选" : "列表"}订阅权益</button>
      {(query || plan || statusFilter) && <button onClick={() => { setQuery(""); setPlan(""); setStatusFilter(""); }}>清除筛选</button>}
    </div><small className="codex-toolbar-help">批量刷新仅处理当前列表内的 ChatGPT 账号；有勾选时只刷新列表内已选账号。订阅权益包含有效期与可用重置次数，不消耗重置次数。</small></div>
    {state && !accounts.length ? <div className="codex-empty"><Bot size={35} /><h2>添加你的第一个 Codex 账号</h2><p>导入本机登录或选择账号 JSON。账号凭据只在本机加密保存。</p></div> : !visible.length && state ? <div className="codex-empty"><Search size={28} /><h2>没有匹配的账号</h2><p>调整搜索关键词、套餐或额度状态筛选。</p></div>  : <div className="codex-grid codex-reference-grid"><ServiceSummary accounts={accounts} state={gateway} lanUrl={summaryLanUrl} active={activePanel === "accounts"} busy={!!busy} onOpen={kind => { setActivePanel("api"); setGatewayAction(current => ({id:(current?.id ?? 0)+1,kind})); }} onInstances={() => setActivePanel("instances")} onRefresh={() => void act("刷新服务统计", async () => { const next = await codexClient.gatewayState(); if (alive.current) setGateway(next); })} />{visible.map((account) => <article className={`codex-card${state?.currentAccountId === account.id ? " current" : ""}`} key={account.id} aria-label={`Codex 账号 ${account.label}`}>
      <div className="codex-card-title"><input type="checkbox" aria-label={`选择 ${account.label}`} checked={selected.has(account.id)} disabled={!!busy} onChange={() => setSelected((current) => { const next = new Set(current); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next; })} /><h2 title={account.label}>{account.label}</h2>{state?.currentAccountId === account.id && <span className="codex-badge codex-current-badge">当前</span>}{account.lastError && <span className="codex-badge codex-error-badge">刷新失败</span>}<span className="codex-badge">{account.authMode === "apikey" ? "API KEY" : account.plan?.toUpperCase() ?? "未知套餐"}</span></div>
      <div className="codex-card-meta"><span>{state?.currentAccountId === account.id ? "当前默认账号" : account.email ?? "本地账号"}</span><span>{account.authMode === "chatgpt" ? "ChatGPT 登录" : "API Key"}</span></div>
      <div className="codex-tags">{account.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
      <AccountControls account={account} busy={!!busy} act={act} onAccount={replace} onNotice={setNotice} onEdit={() => { setError(""); setEditing({ id: account.id, label: account.label, note: account.note, tags: account.tags.join(", ") }); }} headerAction={<button className="codex-pool-link" disabled={!!busy || !gateway?.supportsPoolPersistence || gateway.running} title={gateway?.running ? "请先停止 API 服务再修改账号池" : "账号池选择会保存到本机"} onClick={() => void act("保存服务账号池", async () => { const current = await codexClient.gatewayState(); if (current.running) throw new Error("请先停止 API 服务再修改账号池"); const ids = new Set(current.startupAccountIds ?? current.accountIds); ids.has(account.id) ? ids.delete(account.id) : ids.add(account.id); const next = await codexClient.saveGatewayPool([...ids]); if (alive.current) { setGateway(next); setExternalPool(next.startupAccountIds ?? [...ids]); setNotice("服务账号池已保存"); } })}><Link2 size={12} />{(gateway?.startupAccountIds ?? []).includes(account.id) ? "移除 API 服务" : "添加至 API 服务"}</button>}>
      {account.accountId && <p className="codex-account-id" title={account.accountId}>工作区：{account.accountId}</p>}
      <div className="codex-account-status" data-status={quotaPresentation(account, now).status}>{quotaStatusNames[quotaPresentation(account, now).status]}{["stale", "error"].includes(quotaPresentation(account, now).status) ? " · 以下为上次缓存" : ""}</div>
      <div className="codex-quota">{account.quota.windows.length ? account.quota.windows.map((window, index) => <div key={`${window.name}-${index}`}><div className="codex-quota-label"><span>{windowName(window.windowMinutes)}</span><strong>{remainingPercent(window) == null ? "额度未知" : `${Math.round(remainingPercent(window)!)}% 剩余`}</strong></div>{remainingPercent(window) != null && <progress aria-label={`${window.name}剩余额度`} max={100} value={remainingPercent(window)!} />}<small title="距额度重置剩余时间">{quotaResetTime(window.resetsAt, now)}</small></div>) : <p>{account.authMode === "apikey" ? "API Key 按 API 账单计费，不展示订阅额度" : "尚未获取额度"}</p>}</div>
      </AccountControls>
      {account.lastError && <p className="codex-card-error" role="status">{account.lastError}</p>}
      {account.note && <p className="codex-note">{account.note}</p>}
      <div className="codex-card-bottom"><small>额度更新：{time(account.quota.fetchedAt)}</small><div className="codex-card-actions">
        <button disabled={!!busy || (!state?.cliAvailable && !state?.desktopAvailable)} aria-label={`创建 ${account.label} 独立实例`} title="创建独立 Codex 实例" onClick={() => { setError(""); setCreatingInstance({ accountId: account.id, name: `${account.label} 实例`, kind: state?.desktopAvailable ? "desktop" : "cli" }); }}><Terminal size={15} /></button>
        <button disabled={!!busy} aria-label={`编辑 ${account.label} 标签`} title="编辑账号标签和备注" onClick={() => { setError(""); setEditing({ id: account.id, label: account.label, note: account.note, tags: account.tags.join(", ") }); }}><Tag size={15} /></button>
        <button disabled={!!busy} aria-label={`查看 ${account.label} 信息`} title="查看账号信息" onClick={() => setInspecting(account)}><FileText size={15} /></button>
        <button disabled={!!busy} title="切换默认客户端账号" onClick={() => void act("准备切号", async () => { const preview = await codexClient.prepareSwitch(account.id); if (alive.current) setSwitching(preview); })}><Play size={15} /><span className="codex-visually-hidden">切换</span></button>
        <button disabled={!!busy || account.authMode !== "chatgpt" || !state?.cliAvailable} aria-label={`刷新 ${account.label} 额度`} title={busy ? `${busy}中，请稍候` : account.authMode !== "chatgpt" ? "仅 ChatGPT 登录账号支持额度刷新" : !state?.cliAvailable ? "需要安装并检测到官方 Codex CLI" : "刷新额度"} onClick={() => void refresh([account.id])}><RefreshCw size={15} /></button>
        <button disabled={!!busy || !!gateway?.running || instances.some(instance => instance.running)} aria-label={`导出 ${account.label} JSON`} title={gateway?.running || instances.some(instance => instance.running) ? "请先停止 API 服务和独立实例再备份" : "导出此账号的登录 JSON"} onClick={() => { setError(""); setExporting({ accountId: account.id, ids: [String(account.id)], format: "cockpit_tools" }); }}><Upload size={15} /></button>
        <button disabled={!!busy} aria-label={`删除 ${account.label}`} title="从 CloudHub 删除账号" onClick={() => { setError(""); setDeleting(account); }}><Trash2 size={15} /></button>
      </div></div>
    </article>)}</div>}
    </section>
    <section className="codex-tab-panel" id="codex-panel-api" role="tabpanel" aria-labelledby="codex-tab-api" hidden={activePanel !== "api"} tabIndex={0}><CodexGateway accounts={accounts} disabled={!!busy} onStateChange={setGateway} externalPool={externalPool} onLanUrlChange={setSummaryLanUrl} actionRequest={gatewayAction} /></section>
    <section className="codex-tab-panel" id="codex-panel-instances" role="tabpanel" aria-labelledby="codex-tab-instances" hidden={activePanel !== "instances"} tabIndex={0}>
    <div className="codex-instances"><h2><Terminal size={18} />应用多开 <small>{instances.length}</small></h2>
      <div className="codex-instance-toolbar"><label>选择账号<select value={instanceAccount ? String(instanceAccount.id) : ""} disabled={!!busy || !accounts.length} onChange={(event) => setInstanceAccountId(event.target.value)}>{!accounts.length && <option value="">请先添加账号</option>}{accounts.map((account) => <option key={account.id} value={String(account.id)}>{account.label}</option>)}</select></label><button disabled={!!busy || !instanceAccount || (!state?.cliAvailable && !state?.desktopAvailable)} onClick={() => { if (instanceAccount) { setError(""); setCreatingInstance({ accountId: instanceAccount.id, name: `${instanceAccount.label} 实例`, kind: state?.desktopAvailable ? "desktop" : "cli" }); } }}><Plus size={15} />创建独立实例</button></div>
      <p className="codex-hint">每个实例保留独立登录、窗口数据与会话。停止会结束该实例的任务并保存登录状态；默认 ChatGPT 账号须先切换为其他账号，才能启动其独立实例，避免登录续期冲突。</p>
      {!instances.length ? <p className="codex-hint">选择账号并创建实例，也可以从账号总览的终端按钮进入。</p> : instances.map((instance) => <article className="codex-instance" key={instance.id}><div><strong>{instance.name} <small>{instance.kind === "desktop" ? "桌面" : "CLI"}</small></strong><span>{accounts.find((a) => a.id === instance.accountId)?.label ?? "账号不可用"} · {instance.running ? "运行中" : "已停止"}</span><small title={instance.workDir}>{instance.workDir}</small>{instance.lastError && <p className="codex-card-error">{instance.lastError}</p>}</div><button disabled={!!busy || (instance.kind === "desktop" ? !state?.desktopAvailable : !state?.cliAvailable)} onClick={() => instance.running ? setStoppingInstance(instance) : void act("启动实例", async () => { const next = await codexClient.startInstance(instance.id); if (alive.current) setInstances(next); })}>{instance.running ? <Square size={14} /> : <Play size={14} />}{instance.running ? "停止" : "启动"}</button><button disabled={!!busy || instance.running} title="删除实例配置" aria-label={`删除实例 ${instance.name}`} onClick={() => { setError(""); setDeletingInstance(instance); }}><Trash2 size={14} /></button></article>)}
    </div>
    </section>
    {state && activePanel === "accounts" && <footer className="codex-footer"><span><ShieldCheck size={14} />默认目录：{state.profileHome}</span><button disabled={!!busy || !state.canRestore} onClick={() => { setError(""); setRestoring(true); }}><RotateCcw size={14} />恢复切换前登录</button></footer>}
    {remoteLogsOpen && <RemoteApiLogs accounts={accounts} onClose={() => setRemoteLogsOpen(false)} />}
    {proxyAccounts && <BatchProxyDialog accounts={proxyAccounts} busy={!!busy} act={act} onClose={() => setProxyAccounts(null)} onSaved={next => { setState(current => current ? { ...current, accounts: current.accounts.map(account => next.find(updated => updated.id === account.id) ?? account) } : current); setProxyAccounts(null); setNotice(`已更新 ${next.length} 个账号的代理设置`); }} />}
    {inspecting && <Modal title="Codex 账号信息" eyebrow="ACCOUNT" layout="form" busy={!!busy} onClose={close}><div className="codex-dialog-form-content"><section className="codex-dialog-form-section" aria-label="账号详情"><dl className="codex-account-details"><dt>账号</dt><dd>{inspecting.label}</dd><dt>邮箱</dt><dd>{inspecting.email ?? "未提供"}</dd><dt>登录方式</dt><dd>{inspecting.authMode === "chatgpt" ? "ChatGPT 登录" : "API Key"}</dd><dt>套餐</dt><dd>{inspecting.plan?.toUpperCase() ?? "未知"}</dd><dt>工作区</dt><dd>{inspecting.accountId ?? "未提供"}</dd><dt>标签</dt><dd>{inspecting.tags.join("、") || "无"}</dd><dt>备注</dt><dd>{inspecting.note || "无"}</dd><dt>额度更新</dt><dd>{time(inspecting.quota.fetchedAt)}</dd></dl></section></div><footer className="codex-dialog-actions"><button onClick={close}>关闭</button></footer></Modal>}
    {editing && <Modal title="编辑 Codex 账号" eyebrow="ACCOUNT" layout="form" busy={!!busy} onClose={close}><form onSubmit={(e) => { e.preventDefault(); void act("保存备注", async () => { const account = await codexClient.saveMetadata({ ...editing, tags: [...new Set(editing.tags.split(/[,，]/).map((v) => v.trim()).filter(Boolean))] }); replace(account); if (alive.current) { setEditing(null); setNotice("账号信息已保存"); } }); }}><div className="codex-dialog-form-content"><p className="codex-dialog-callout">名称、标签和备注仅更新 CloudHub 中的账号资料，不会修改 Codex 登录状态。</p><section className="codex-dialog-form-section" aria-labelledby="codex-account-profile-heading"><div className="codex-dialog-section-heading"><h3 id="codex-account-profile-heading">账号资料</h3><span>用于识别和筛选账号</span></div><label>账号名称<input autoFocus required maxLength={160} value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></label><label>标签（逗号分隔）<input value={editing.tags} maxLength={820} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></label></section><section className="codex-dialog-form-section" aria-labelledby="codex-account-note-heading"><div className="codex-dialog-section-heading"><h3 id="codex-account-note-heading">备注</h3><span>最多 2000 个字符</span></div><label>账号备注<textarea value={editing.note} maxLength={2000} rows={4} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></label></section>{error && <p role="alert" className="codex-card-error">{error}</p>}</div><footer className="codex-dialog-actions"><button type="button" disabled={!!busy} onClick={close}>取消</button><button className="codex-dialog-primary" disabled={!!busy || !editing.label.trim()}>保存账号信息</button></footer></form></Modal>}
    {deleting && <Modal title="删除 Codex 账号" busy={!!busy} onClose={close}><p>从 CloudHub 删除「{deleting.label}」及其保存的凭据。默认客户端登录和历史会话目录会保留。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button className="danger" disabled={!!busy} onClick={() => void act("删除账号", async () => { const next = await codexClient.deleteAccount(deleting.id); if (alive.current) { setState(next); setSelected((current) => { const ids = new Set(current); ids.delete(deleting.id); return ids; }); setDeleting(null); setNotice("账号已从 CloudHub 删除"); } })}>确认删除账号</button></div></Modal>}
    {switching && <Modal title="切换默认 Codex 账号" busy={!!busy} onClose={close}><p>将默认客户端切换到「{switching.accountLabel}」。请先结束正在运行的 Codex 任务，并关闭默认客户端，完成后重新打开。</p><p className="codex-path">{switching.profileHome}</p><p>{switching.hasPreviousAuth ? "原登录状态会暂存，可在页面底部恢复。" : "当前没有文件登录状态，可恢复为未登录。"}原有配置和会话保留；确认有效期为 90 秒。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} onClick={() => void act("切换账号", async () => { const next = await codexClient.confirmSwitch(switching.token); if (alive.current) { setState(next); setSwitching(null); setNotice("默认账号已切换，请重新启动 Codex 客户端"); } })}>已结束任务，确认切换</button></div></Modal>}
    {restoring && <Modal title="恢复 Codex 登录" busy={!!busy} onClose={close}><p>恢复上一次切换前的登录状态。若客户端已更新认证文件，CloudHub 会停止恢复，避免覆盖新的登录。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} onClick={() => void act("恢复登录", async () => { const next = await codexClient.restoreProfile(); if (alive.current) { setState(next); setRestoring(false); setNotice("已恢复切换前的登录状态"); } })}>确认恢复登录</button></div></Modal>}
    {creatingInstance && <Modal title="创建独立 Codex 实例" eyebrow="CODEX INSTANCE" layout="form" busy={!!busy} onClose={close}><form onSubmit={(event) => { event.preventDefault(); void act("创建实例", async () => { const next = await codexClient.createInstance(creatingInstance.accountId, creatingInstance.name, creatingInstance.kind); if (next && alive.current) { setInstances(next); setCreatingInstance(null); setActivePanel("instances"); setNotice("实例已创建，点击启动打开独立窗口或终端"); } }); }}><div className="codex-dialog-form-content"><p className="codex-dialog-callout">桌面实例会在窗口内提示选择项目；CLI 实例直接进入所选目录。每个实例使用独立登录与会话目录。</p><section className="codex-dialog-form-section" aria-labelledby="codex-instance-config-heading"><div className="codex-dialog-section-heading"><h3 id="codex-instance-config-heading">实例配置</h3><span>创建后可在“应用多开”中启动</span></div><div className="codex-dialog-fields"><label>实例名称<input autoFocus required maxLength={80} value={creatingInstance.name} onChange={(event) => setCreatingInstance({ ...creatingInstance, name: event.target.value })} /></label><label>实例类型<select aria-label="实例类型" value={creatingInstance.kind} onChange={(event) => setCreatingInstance({ ...creatingInstance, kind: event.target.value as "cli" | "desktop" })}><option value="desktop" disabled={!state?.desktopAvailable}>Codex 桌面窗口</option><option value="cli" disabled={!state?.cliAvailable}>Codex CLI 终端</option></select></label></div></section>{error && <p role="alert" className="codex-card-error">{error}</p>}</div><footer className="codex-dialog-actions"><button type="button" disabled={!!busy} onClick={close}>取消</button><button className="codex-dialog-primary" disabled={!!busy || !creatingInstance.name.trim()}>选择项目目录</button></footer></form></Modal>}
    {stoppingInstance && <Modal title="停止 Codex 实例" busy={!!busy} onClose={close}><p>停止「{stoppingInstance.name}」会结束终端及正在运行的任务。请先保存工作。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} className="danger" onClick={() => void act("停止实例", async () => { const next = await codexClient.stopInstance(stoppingInstance.id); if (alive.current) { setInstances(next); setStoppingInstance(null); setState(await codexClient.state()); } })}>确认停止实例</button></div></Modal>}
    {exporting && <Modal title="导出 Codex 账号" busy={!!busy} onClose={close}>{!exporting.accountId && <ExportChecklist items={accounts.map(account => ({ id: String(account.id), label: account.label }))} selected={exporting.ids} disabled={!!busy} onChange={ids => setExporting({ ...exporting, ids })} />}<label className="codex-export-format">导出格式<select value={exporting.format} disabled={!!busy} onChange={event => setExporting({ ...exporting, format: event.target.value as CodexExportFormat })}><option value="cockpit_tools">Cockpit Tools（推荐）</option><option value="auth_json">官方 auth.json</option><option value="sub2api">Sub2API</option><option value="cpa" disabled={cpaExportUnavailable}>CPA{cpaExportUnavailable ? "（当前选择含 API Key 账号）" : ""}</option></select></label><p>{exporting.format === "sub2api" ? "生成可导入 Sub2API 的账号数据文件。" : exporting.format === "auth_json" ? "单账号导出为 auth.json；多个账号会分别打包为 ZIP。" : exporting.format === "cpa" ? "生成 CLIProxyAPI 凭据格式；多个账号分别打包为 ZIP。" : "生成可由 Cockpit Tools 导入的账号数据文件。"} 文件包含登录凭据，请妥善保管。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy || !exporting.ids.length || (exporting.format === "cpa" && cpaExportUnavailable)} onClick={() => void act("导出账号", async () => { if (await codexClient.exportAccountsFile(exporting.accountId, exporting.ids.map(Number), exporting.format) && alive.current) { setExporting(null); setNotice(`账号已导出为 ${exporting.format}`); } })}>选择保存位置</button></div></Modal>}
    {importing && <Modal title="导入 Codex 账号" busy={!!busy} onClose={() => setImporting(false)}><label className="codex-export-format">导入格式<select value={importFormat} disabled={!!busy} onChange={event => setImportFormat(event.target.value as CodexExportFormat)}><option value="cockpit_tools">Cockpit Tools</option><option value="auth_json">官方 auth.json</option><option value="sub2api">Sub2API</option><option value="cpa">CPA</option></select></label><p>{importFormat === "auth_json" ? "选择官方 auth.json；多个账号的 ZIP 备份也可导入。" : importFormat === "cpa" ? "选择 CPA 凭据 JSON，或包含多个 JSON 文件的 ZIP。" : importFormat === "sub2api" ? "选择 Sub2API 导出的账号数据 JSON。" : "选择 Cockpit Tools 导出的账号数据 JSON。"} 重复账号会更新凭据，并在本机加密保存。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={() => setImporting(false)}>取消</button><button disabled={!!busy} onClick={() => void act("导入账号", async () => { const next = await codexClient.importFile(importFormat); if (next && alive.current) { setState(next); setImporting(false); setNotice("账号导入完成，凭据已加密保存"); } })}>选择文件</button></div></Modal>}
    {deletingInstance && <Modal title="删除 Codex 实例配置" busy={!!busy} onClose={close}><p>删除「{deletingInstance.name}」的实例配置和登录凭据。独立目录中的历史会话保留。</p>{error && <p role="alert" className="codex-card-error">{error}</p>}<div className="codex-dialog-actions"><button disabled={!!busy} onClick={close}>取消</button><button disabled={!!busy} className="danger" onClick={() => void act("删除实例", async () => { const next = await codexClient.deleteInstance(deletingInstance.id); if (alive.current) { setInstances(next); setDeletingInstance(null); } })}>确认删除实例配置</button></div></Modal>}
  </section>;
}
