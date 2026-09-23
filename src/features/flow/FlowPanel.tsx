import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, Check, CircleAlert, Eye, FileText, GitBranch, GitCommitHorizontal, LoaderCircle, Play, Plus, RefreshCw, Search, Settings2, Trash2, UserRound, X } from "lucide-react";
import { flowClient } from "../../platform/clients";
import { runningInTauri } from "../../platform/api";
import type { FlowConnection, FlowConnectionInput, FlowGroup, FlowJob, FlowLogPage, FlowPipeline, FlowRun, FlowRunDetail, FlowStep } from "../../shared/types";
import "./flow.css";

const emptyDraft: FlowConnectionInput = { name: "", edition: "central", organizationId: "", domain: "openapi-rdc.aliyuncs.com", token: "" };
const timeText = (value?: number | null) => value ? new Date(value).toLocaleString() : "—";
const durationText = (start?: number | null, end?: number | null, now = Date.now()) => { if (!start) return "—"; const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000)); return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`; };
const successAgeMinutes = (status: string | null | undefined, endTime: number | null | undefined, now: number) => { if (status !== "SUCCESS" || !endTime) return null; const elapsed = now - endTime; return elapsed >= 0 && elapsed <= 30 * 60 * 1000 ? Math.floor(elapsed / 60000) : null; };
const statusText = (value?: string | null) => ({ SUCCESS: "成功", FAIL: "失败", RUNNING: "运行中", CANCELED: "已取消", WAITING: "等待中", SKIPPED: "已跳过" }[value || ""] || value || "未知");
const triggerText = (mode?: number | null) => ({ 1: "页面手动触发", 2: "定时触发", 3: "代码提交触发", 4: "POP API 触发", 5: "流水线触发", 6: "Webhook 触发" } as Record<number, string>)[mode || 0] || "—";
type PipelineSummary = { runId?: string; status?: string | null; startTime?: number | null; endTime?: number | null; triggerMode?: number | null; creatorAccountId?: string | null; creatorEmail?: string | null; stages: Array<{ name: string; status?: string | null }> };

export function FlowPanel() {
  const [connections, setConnections] = useState<FlowConnection[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [pipelines, setPipelines] = useState<FlowPipeline[]>([]);
  const [pipelineSummaries, setPipelineSummaries] = useState<Record<string, PipelineSummary>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<FlowPipeline | null>(null);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [runDetail, setRunDetail] = useState<FlowRunDetail | null>(null);
  const [draft, setDraft] = useState<FlowConnectionInput>(emptyDraft);
  const [showConnection, setShowConnection] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [detailTab, setDetailTab] = useState<"latest" | "history">("latest");
  const [paramsJson, setParamsJson] = useState("{}");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(() => new Set());
  const [jobSteps, setJobSteps] = useState<Record<string, FlowStep[]>>({});
  const [jobLogs, setJobLogs] = useState<Record<string, { entries: Array<{ stepIndex: number; buildId: number; name: string; text: string; more: boolean; offset: number }> }>>({});
  const summaryRequest = useRef(0);
  const detailsDialogRef = useRef<HTMLElement | null>(null);
  const detailsCloseRef = useRef<HTMLButtonElement | null>(null);
  const detailsOpenerRef = useRef<HTMLElement | null>(null);

  async function loadPipelineSummaries(items: FlowPipeline[], currentConnectionId: number) {
    const requestId = ++summaryRequest.current;
    setSummaryLoading(items.length > 0);
    setPipelineSummaries({});
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
      while (nextIndex < items.length) {
        if (requestId !== summaryRequest.current) return;
        const pipeline = items[nextIndex++];
        let summary: PipelineSummary = { status: pipeline.latestStatus || undefined, stages: [] };
        try {
          const latest = await flowClient.latestRun(currentConnectionId, pipeline.pipelineId);
          if (requestId !== summaryRequest.current) return;
          summary = { runId: latest.pipelineRunId, status: latest.status || pipeline.latestStatus || undefined, startTime: latest.startTime, endTime: latest.endTime, triggerMode: latest.triggerMode, creatorAccountId: latest.creatorAccountId, creatorEmail: latest.creatorEmail, stages: latest.stages.flatMap((stage) => stage.name ? [{ name: stage.name, status: stage.status }] : []) };
        } catch { /* Keep the pipeline row available when recent-run data is unavailable. */ }
        if (requestId === summaryRequest.current) setPipelineSummaries((old) => ({ ...old, [pipeline.pipelineId]: summary }));
      }
    });
    await Promise.all(workers);
    if (requestId === summaryRequest.current) setSummaryLoading(false);
  }

  async function loadConnections() {
    try {
      const items = await flowClient.connections();
      setConnections(items);
      setConnectionId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取云效连接失败"); }
  }

  async function loadPipelines(nextPage = page, search = keyword) {
    if (!connectionId) return;
    setBusy("pipelines"); setError("");
    try {
      const items = await flowClient.pipelines(connectionId, nextPage, 30, search, activeGroupId);
      setPipelines(items); setPage(nextPage); setHasNext(items.length === 30);
      void loadPipelineSummaries(items, connectionId);
      if (selectedPipeline && !items.some((item) => item.pipelineId === selectedPipeline.pipelineId)) { setSelectedPipeline(null); setRuns([]); setRunDetail(null); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取流水线失败"); }
    finally { setBusy(""); }
  }

  async function choosePipeline(pipeline: FlowPipeline): Promise<FlowRun[]> {
    setSelectedPipeline(pipeline); setRunDetail(null); setJobSteps({}); setJobLogs({}); setExpandedJobs(new Set());
    if (!connectionId) return [];
    setBusy("runs"); setError("");
    try { const items = await flowClient.runs(connectionId, pipeline.pipelineId, 1, 20); setRuns(items); return items; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取运行记录失败"); setRuns([]); return []; }
    finally { setBusy(""); }
  }

  async function viewPipelineDetails(pipeline: FlowPipeline) {
    detailsOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetailTab("latest"); setShowDetails(true);
    const history = await choosePipeline(pipeline);
    if (history[0]) await chooseRun(history[0]);
  }

  async function chooseRun(run: FlowRun) {
    if (!connectionId || !selectedPipeline) return;
    setBusy("detail"); setError("");
    try { setRunDetail(await flowClient.run(connectionId, selectedPipeline.pipelineId, run.pipelineRunId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取运行详情失败"); }
    finally { setBusy(""); }
  }

  useEffect(() => { if (runningInTauri) void loadConnections(); }, []);
  useEffect(() => { const timer = window.setInterval(() => setClockNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (showDetails) { detailsCloseRef.current?.focus(); return; }
    detailsOpenerRef.current?.focus();
    detailsOpenerRef.current = null;
  }, [showDetails]);
  useEffect(() => {
    if (!showDetails && !showRun && !showConnection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && showDetails && detailsDialogRef.current) {
        const focusable = detailsDialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key !== "Escape") return;
      if (showDetails) setShowDetails(false);
      else if (showRun && busy !== "run") setShowRun(false);
      else if (showConnection && !busy) setShowConnection(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDetails, showRun, showConnection, busy]);
  useEffect(() => {
    if (!connectionId) { setGroups([]); setActiveGroupId(null); setPipelines([]); setSelectedPipeline(null); setRuns([]); setRunDetail(null); return; }
    setActiveGroupId(null);
    void flowClient.groups(connectionId).then(setGroups).catch((reason) => { setGroups([]); setError(reason instanceof Error ? reason.message : "读取流水线分组失败"); });
  }, [connectionId]);
  useEffect(() => { if (connectionId) void loadPipelines(1, ""); }, [connectionId, activeGroupId]);
  useEffect(() => {
    if (!connectionId || !selectedPipeline || !runDetail || runDetail.status !== "RUNNING") return;
    const timer = window.setInterval(() => {
      void flowClient.run(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId).then(setRunDetail).catch(() => undefined);
      void flowClient.runs(connectionId, selectedPipeline.pipelineId, 1, 20).then(setRuns).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [connectionId, selectedPipeline?.pipelineId, runDetail?.pipelineRunId, runDetail?.status]);

  const currentConnection = useMemo(() => connections.find((item) => item.id === connectionId) ?? null, [connections, connectionId]);

  async function saveConnection(event: FormEvent) {
    event.preventDefault(); setBusy("save"); setError(""); setMessage("");
    try {
      const saved = await flowClient.saveConnection(draft);
      await loadConnections(); setConnectionId(saved.id); setShowConnection(false); setDraft(emptyDraft);
      try { await flowClient.testConnection(saved.id); setMessage("连接验证成功，已读取云效流水线权限"); }
      catch (reason) { setError(`配置已保存，但连接验证失败：${reason instanceof Error ? reason.message : "请检查连接信息和权限"}`); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存云效连接失败"); }
    finally { setBusy(""); }
  }

  function editConnection(item: FlowConnection) {
    setDraft({ id: item.id, name: item.name, edition: item.edition, organizationId: item.organizationId || "", domain: item.domain, token: "" }); setShowConnection(true);
  }

  async function removeConnection(item: FlowConnection) {
    if (!window.confirm(`移除云效连接“${item.name}”？`)) return;
    setBusy("delete");
    try { await flowClient.deleteConnection(item.id); await loadConnections(); setMessage("云效连接已移除"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "移除连接失败"); }
    finally { setBusy(""); }
  }

  async function verifyConnection() {
    if (!currentConnection) return;
    setBusy("verify"); setError(""); setMessage("");
    try { await flowClient.testConnection(currentConnection.id); setMessage("连接正常，当前 PAT 可以读取流水线"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "云效连接验证失败"); }
    finally { setBusy(""); }
  }

  async function runPipeline(event: FormEvent) {
    event.preventDefault();
    if (!connectionId || !selectedPipeline) return;
    try { const value = JSON.parse(paramsJson || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("运行参数必须是 JSON 对象"); }
    catch { setError("运行参数必须是有效的 JSON 对象"); return; }
    setBusy("run"); setError(""); setMessage("");
    try {
      const runId = await flowClient.start(connectionId, selectedPipeline.pipelineId, paramsJson || "{}");
      setShowRun(false); setMessage(`已触发运行 #${runId}`);
      await choosePipeline(selectedPipeline);
      const run = await flowClient.run(connectionId, selectedPipeline.pipelineId, runId);
      setRunDetail(run);
      setPipelineSummaries((old) => ({ ...old, [selectedPipeline.pipelineId]: { runId, status: run.status, startTime: run.startTime, endTime: run.endTime, triggerMode: run.triggerMode, creatorAccountId: run.creatorAccountId, stages: run.stages.flatMap((stage) => stage.name ? [{ name: stage.name, status: stage.status }] : []) } }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "触发流水线失败"); }
    finally { setBusy(""); }
  }

  async function toggleJobLog(job: FlowJob) {
    if (!connectionId || !selectedPipeline || !runDetail || !job.id) return;
    const key = `${runDetail.pipelineRunId}:${job.id}`;
    if (expandedJobs.has(key)) { setExpandedJobs((old) => { const next = new Set(old); next.delete(key); return next; }); return; }
    setExpandedJobs((old) => new Set(old).add(key));
    const hasContent = jobLogs[key]?.entries.some((entry) => entry.text.length > 0 || entry.more) || false;
    if (!hasContent) await fetchJobLog(job, key);
  }

  async function fetchJobLog(job: FlowJob, key: string) {
    if (!connectionId || !selectedPipeline || !runDetail || !job.id || busy === `log:${key}`) return;
    setBusy(`log:${key}`); setError("");
    try {
      const steps = await flowClient.steps(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id);
      setJobSteps((old) => ({ ...old, [key]: steps }));
      const loggableSteps = steps.filter((step): step is FlowStep & { stepIndex: number; buildId: number } => step.stepIndex != null && step.buildId != null).slice(0, 30);
      const entries: Array<{ stepIndex: number; buildId: number; name: string; text: string; more: boolean; offset: number }> = [];
      for (const step of loggableSteps) {
        const pageResult = await flowClient.log(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id, step.stepIndex, step.buildId, 0, 10000);
        entries.push({ stepIndex: step.stepIndex, buildId: step.buildId, name: step.name || "任务步骤", text: pageResult.logs, more: pageResult.more, offset: pageResult.nextOffset });
      }
      setJobLogs((old) => ({ ...old, [key]: { entries } }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取任务日志失败"); }
    finally { setBusy(""); }
  }

  async function loadMoreLog(job: FlowJob) {
    if (!connectionId || !selectedPipeline || !runDetail || !job.id) return;
    const key = `${runDetail.pipelineRunId}:${job.id}`; const current = jobLogs[key];
    if (!current) return;
    setBusy(`log:${key}`);
    try {
      const entries = [...current.entries];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]; if (!entry.more) continue;
        const next: FlowLogPage = await flowClient.log(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id, entry.stepIndex, entry.buildId, entry.offset, 10000);
        entries[i] = { ...entry, text: entry.text + next.logs, more: next.more, offset: next.nextOffset };
      }
      setJobLogs((old) => ({ ...old, [key]: { entries } }));
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "继续读取任务日志失败"); }
    finally { setBusy(""); }
  }

  return <section className="flow-page">
    <header className="flow-page-header"><div><span className="eyebrow">YUNXIAO FLOW</span><h1>云效流水线</h1><p>浏览组织流水线、手动运行并跟踪阶段与任务日志。</p></div><div className="flow-toolbar-actions">
      <select aria-label="选择云效连接" value={connectionId ?? ""} onChange={(event) => setConnectionId(Number(event.target.value) || null)}><option value="">选择云效连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      {currentConnection && <button className="secondary" disabled={busy !== ""} onClick={() => void verifyConnection()}><Activity size={15} />验证连接</button>}
      <button className="secondary" disabled={!runningInTauri} onClick={() => { setDraft(emptyDraft); setShowConnection(true); }}><Plus size={15} />添加连接</button>
      {currentConnection && <button className="icon-button" aria-label="编辑连接" title="编辑连接" onClick={() => editConnection(currentConnection)}><Settings2 size={16} /></button>}
    </div></header>
    {message && <div className="flow-feedback success" role="status"><Check size={16} />{message}<button aria-label="关闭提示" onClick={() => setMessage("")}><X size={14} /></button></div>}
    {error && <div className="flow-feedback error" role="alert"><CircleAlert size={16} />{error}<button aria-label="关闭错误" onClick={() => setError("")}><X size={14} /></button></div>}
    {!runningInTauri && <div className="flow-feedback error" role="status"><CircleAlert size={16} />云效流水线仅在桌面端可用；浏览器预览不会保存 PAT 或触发流水线。</div>}
    {!connections.length ? <div className="flow-empty"><Activity size={34} /><h2>先连接云效组织</h2><p>使用云效个人访问令牌（PAT）连接中心版或 Region 版组织。令牌只保存在本机加密存储中。</p><button disabled={!runningInTauri} onClick={() => { setDraft(emptyDraft); setShowConnection(true); }}><Plus size={15} />配置连接</button></div> : !currentConnection ? <div className="flow-empty">请选择云效连接。</div> : <div className="flow-workspace">
      <section className="panel flow-pipeline-panel"><div className="flow-panel-title"><div><h2>流水线</h2><span>{currentConnection.name} · {pipelines.length} 条当前页</span></div><button className="icon-button" aria-label="刷新流水线" title="刷新流水线" disabled={busy === "pipelines"} onClick={() => void loadPipelines(1)}>{busy === "pipelines" ? <LoaderCircle className="flow-spin" size={16} /> : <RefreshCw size={16} />}</button></div>
        <div className="flow-group-tabs" role="tablist" aria-label="流水线分组"><button type="button" role="tab" aria-selected={activeGroupId === null} className={activeGroupId === null ? "active" : ""} onClick={() => setActiveGroupId(null)}>全部</button>{groups.map((group) => <button type="button" role="tab" aria-selected={activeGroupId === group.groupId} className={activeGroupId === group.groupId ? "active" : ""} key={group.groupId} onClick={() => setActiveGroupId(group.groupId)}>{group.groupName}</button>)}</div>
        <div className="flow-list-toolbar"><form className="flow-search" onSubmit={(event) => { event.preventDefault(); void loadPipelines(1); }}><Search size={15} /><input aria-label="搜索流水线" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索流水线名称" /><button type="submit">搜索</button></form></div>
        <div className="flow-table-scroll"><table className="flow-pipeline-table"><thead><tr><th>流水线名称</th><th>最近运行状态</th><th>最近运行阶段</th><th>触发信息</th><th>最近运行开始时间</th><th className="flow-actions-heading">操作</th></tr></thead><tbody>{pipelines.map((pipeline) => { const summary = pipelineSummaries[pipeline.pipelineId]; return <tr key={pipeline.pipelineId}><td><button type="button" className="flow-name-button" onClick={() => void viewPipelineDetails(pipeline)}><strong>{pipeline.pipelineName}</strong><small>ID {pipeline.pipelineId}</small></button></td><td>{summary ? summary.runId ? <div className="flow-list-status"><strong>#{summary.runId}</strong><span className="flow-list-status-separator">·</span>{summary.status === "SUCCESS" ? <span className="flow-status-icon success" title="运行成功" aria-label="运行成功"><Check size={14} /></span> : <span className={`flow-status ${(summary.status || "").toLowerCase()}`}>{statusText(summary.status)}</span>}</div> : <span className="flow-table-muted">暂无运行</span> : summaryLoading ? <span className="flow-table-muted">读取中…</span> : <span className="flow-table-muted">—</span>}</td><td><div className="flow-stage-track" style={summary?.stages.length ? { width: `${Math.min(summary.stages.length * 56, 280)}px` } : undefined}>{summary?.stages.length ? summary.stages.map((stage, index) => <div className="flow-stage-step" key={`${stage.name}-${index}`}><span className="flow-stage-label">{stage.name}</span><span className="flow-stage-rail"><i className={`flow-stage-node ${summary.status === "SUCCESS" && (stage.status || "").toLowerCase() === "success" && index < summary.stages.length - 1 ? "" : (stage.status || "").toLowerCase()}`} />{index < summary.stages.length - 1 && <i className="flow-stage-link" />}</span></div>) : <span className="flow-table-muted">{summaryLoading && !summary ? "读取中…" : "—"}</span>}</div></td><td><div className="flow-trigger-info"><span className="flow-trigger-avatar" aria-hidden="true"><UserRound size={12} /></span><small title={summary?.creatorEmail ? `触发账号：${summary.creatorEmail}` : summary?.creatorAccountId ? `账号 ID：${summary.creatorAccountId}` : ""}>{summary?.creatorEmail || (summary?.creatorAccountId ? `账号 ID：${summary.creatorAccountId}` : "—")}</small><strong>{triggerText(summary?.triggerMode)}</strong></div></td><td><div>{timeText(summary?.startTime)}</div>{successAgeMinutes(summary?.status, summary?.endTime, clockNow) !== null && <small className="flow-success-age">{successAgeMinutes(summary?.status, summary?.endTime, clockNow) === 0 ? "刚刚成功" : `已成功 ${successAgeMinutes(summary?.status, summary?.endTime, clockNow)} 分钟`}</small>}</td><td className="flow-action-cell"><div className="flow-row-actions"><button type="button" aria-label={`运行 ${pipeline.pipelineName}`} title="运行流水线" disabled={busy !== ""} onClick={() => { setSelectedPipeline(pipeline); setParamsJson("{}"); setShowRun(true); }}><Play size={15} /></button><button type="button" aria-label={`查看 ${pipeline.pipelineName} 详情`} title="查看详情" onClick={() => void viewPipelineDetails(pipeline)}><Eye size={15} /></button></div></td></tr>; })}</tbody></table>{busy === "pipelines" && !pipelines.length && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={18} />正在读取流水线…</div>}{!pipelines.length && busy !== "pipelines" && <div className="flow-list-empty">没有找到流水线</div>}</div>
        <div className="flow-pagination"><span>第 {page} 页</span><button className="secondary" disabled={page <= 1 || busy !== ""} onClick={() => void loadPipelines(page - 1)}>上一页</button><button className="secondary" disabled={!hasNext || busy !== ""} onClick={() => void loadPipelines(page + 1)}>下一页</button></div>
      </section>
    </div>}
    {currentConnection && <div className="flow-connection-footer"><span><Check size={14} />PAT 已加密保存在本机</span><button className="text-danger" onClick={() => void removeConnection(currentConnection)}><Trash2 size={14} />移除此连接</button></div>}
    {showConnection && <div className="flow-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setShowConnection(false); }}><form className="flow-dialog" onSubmit={(event) => void saveConnection(event)}><header><div><h2>{draft.id ? "编辑云效连接" : "连接云效 Flow"}</h2><p>个人访问令牌只在 Rust 原生端加密保存。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setShowConnection(false)}><X size={17} /></button></header>
      <label>连接名称<input autoFocus required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：公司研发组织" /></label>
      <label>组织版本<select value={draft.edition} onChange={(event) => setDraft({ ...draft, edition: event.target.value as "central" | "region", domain: event.target.value === "central" ? "openapi-rdc.aliyuncs.com" : "" })}><option value="central">中心版</option><option value="region">Region 版</option></select></label>
      {draft.edition === "central" ? <label>组织 ID<input required value={draft.organizationId || ""} onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })} placeholder="云效组织 ID" /></label> : <label>接入域名<input required value={draft.domain || ""} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} placeholder="例如：devops.aliyun.com" /><small>只填写 HTTPS 域名，不含路径。</small></label>}
      <label>个人访问令牌（PAT）<input type="password" autoComplete="new-password" required={!draft.id} value={draft.token || ""} onChange={(event) => setDraft({ ...draft, token: event.target.value })} placeholder={draft.id ? "留空以保留原令牌" : "粘贴云效 PAT"} /></label>
      <footer><button type="button" className="secondary" disabled={busy === "save"} onClick={() => setShowConnection(false)}>取消</button><button type="submit" disabled={busy === "save"}>{busy === "save" ? <LoaderCircle className="flow-spin" size={15} /> : <Check size={15} />}{busy === "save" ? "保存中…" : "保存并验证"}</button></footer>
    </form></div>}
    {showDetails && selectedPipeline && <div className="flow-dialog-backdrop flow-details-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowDetails(false); }}><section ref={detailsDialogRef} className="flow-dialog flow-details-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-detail-title"><header className="flow-details-header"><div><span className="eyebrow">PIPELINE RUN</span><h2 id="flow-detail-title">{selectedPipeline.pipelineName}</h2><p>流水线 ID {selectedPipeline.pipelineId}{runDetail ? ` · 运行 #${runDetail.pipelineRunId}` : ""}</p></div><button ref={detailsCloseRef} type="button" className="icon-button" aria-label="关闭详情" onClick={() => setShowDetails(false)}><X size={17} /></button></header>
      <div className="flow-detail-overview"><div><span>运行状态</span><strong className={`flow-status ${(runDetail?.status || "").toLowerCase()}`}>{runDetail ? statusText(runDetail.status) : "—"}</strong></div><div><span>触发信息</span><strong>{triggerText(runDetail?.triggerMode)}</strong><small>{runDetail?.creatorEmail || (runDetail?.creatorAccountId ? `账号 ID：${runDetail.creatorAccountId}` : "—")}</small></div><div><span>开始时间</span><strong>{timeText(runDetail?.startTime)}</strong></div><div><span>结束时间</span><strong>{timeText(runDetail?.endTime)}</strong></div><div><span>持续时间</span><strong>{durationText(runDetail?.startTime, runDetail?.endTime, clockNow)}</strong></div></div>
      <nav className="flow-detail-tabs" aria-label="运行详情视图"><button type="button" className={detailTab === "latest" ? "active" : ""} aria-current={detailTab === "latest" ? "page" : undefined} onClick={() => setDetailTab("latest")}>最近运行</button><button type="button" className={detailTab === "history" ? "active" : ""} aria-current={detailTab === "history" ? "page" : undefined} onClick={() => setDetailTab("history")}>运行历史</button></nav>
      <div className={`flow-details-content ${detailTab}`}>{detailTab === "history" && <aside className="flow-history-list" aria-label="运行历史">{runs.map((run) => <button type="button" key={run.pipelineRunId} className={runDetail?.pipelineRunId === run.pipelineRunId ? "selected" : ""} onClick={() => void chooseRun(run)}><span className={`flow-status-dot ${(run.status || "").toLowerCase()}`} /><strong>#{run.pipelineRunId}</strong><span className={`flow-status ${(run.status || "").toLowerCase()}`}>{statusText(run.status)}</span><time>{timeText(run.startTime)}</time></button>)}{busy === "runs" && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={16} />读取运行历史…</div>}{!runs.length && busy !== "runs" && <p className="flow-list-empty">暂无运行记录</p>}</aside>}
      {busy === "detail" && !runDetail ? <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={18} />加载运行详情…</div> : !runDetail ? <div className="flow-empty compact"><Activity size={28} /><h2>暂无运行详情</h2><p>这条流水线还没有可显示的运行记录。</p></div> : <div className="flow-modal-run-detail"><aside className="flow-run-origin"><div className="flow-run-origin-heading"><span className="flow-source-icon"><GitBranch size={16} /></span><strong>流水线源 · {runDetail.sources.length || 1}</strong></div><article className="flow-source-card"><div className="flow-source-title"><span className="flow-source-mark"><GitBranch size={14} /></span><strong title={runDetail.sources[0]?.repository || selectedPipeline.pipelineName}>{runDetail.sources[0]?.repository || selectedPipeline.pipelineName}</strong></div><div><GitBranch size={13} /><span>{runDetail.sources[0]?.branch || "分支信息不可用"}</span></div><div><GitCommitHorizontal size={13} /><span>{runDetail.sources[0]?.commitId || "—"}</span></div><div><FileText size={13} /><span>{runDetail.sources[0]?.commitMessage || runDetail.sources[0]?.sourceType || "提交信息不可用"}</span></div></article><div className="flow-source-meta"><span>流水线</span><strong>{selectedPipeline.pipelineName}</strong></div><div className="flow-source-meta"><span>运行编号</span><strong>#{runDetail.pipelineRunId}</strong></div><div className="flow-source-meta"><span>触发账号</span><strong>{runDetail.creatorEmail || (runDetail.creatorAccountId ? `账号 ID：${runDetail.creatorAccountId}` : "—")}</strong></div></aside><div className="flow-stage-lanes">{runDetail.stages.map((stage, stageIndex) => <section className={`flow-stage-lane ${(stage.status || "").toLowerCase()}`} key={`${stage.name}-${stageIndex}`}><header className="flow-stage-lane-heading"><strong>{stage.name || `阶段 ${stageIndex + 1}`}</strong><span className={`flow-status ${(stage.status || "").toLowerCase()}`}>{statusText(stage.status)}</span></header>{stage.jobs.map((job, jobIndex) => { const key = `${runDetail.pipelineRunId}:${job.id || jobIndex}`; const logState = jobLogs[key]; return <article className={`flow-job-card ${(job.status || "").toLowerCase()}`} key={key}><div className="flow-job-card-heading"><span className={`flow-status-dot ${(job.status || "").toLowerCase()}`} /><strong>{job.name || `任务 ${jobIndex + 1}`}</strong></div><div className="flow-job-card-meta"><span>{durationText(job.startTime, job.endTime, clockNow)}</span>{job.id && <button type="button" className="flow-log-toggle" disabled={busy === `log:${key}`} onClick={() => void toggleJobLog(job)}><FileText size={13} />{busy === `log:${key}` ? "读取中…" : expandedJobs.has(key) ? "收起日志" : "日志"}</button>}{expandedJobs.has(key) && !logState?.entries.some((entry) => entry.text.length > 0 || entry.more) && <button type="button" className="flow-log-retry" aria-label="重新获取任务日志" title="重新获取日志" disabled={busy === `log:${key}`} onClick={() => void fetchJobLog(job, key)}><RefreshCw size={13} /></button>}</div>{expandedJobs.has(key) && <div className="flow-job-log">{busy === `log:${key}` && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={15} />加载步骤和日志…</div>}{jobSteps[key] && !jobSteps[key].some((step) => step.stepIndex != null && step.buildId != null) && <p className="flow-log-empty">{jobSteps[key].length === 0 ? "云效返回了空的步骤列表；任务结束后可点击右侧刷新按钮重试。" : "云效步骤缺少编号或构建 ID，无法请求日志；可点击右侧刷新按钮重试。"}</p>}{logState?.entries.map((entry) => entry.text || entry.more ? <section className="flow-log-entry" key={`${entry.stepIndex}-${entry.buildId}`}><strong>{entry.name}</strong><pre>{entry.text || "等待后续日志…"}</pre></section> : null)}{logState && logState.entries.length > 0 && !logState.entries.some((entry) => entry.text.length > 0 || entry.more) && <p className="flow-log-empty">云效当前没有返回日志内容；点击右侧刷新按钮可再次查询。</p>}{logState?.entries.some((entry) => entry.more) && <button className="secondary" disabled={busy !== ""} onClick={() => void loadMoreLog(job)}>继续加载日志</button>}</div>}</article>;})}{!stage.jobs.length && <p className="flow-stage-empty">该阶段没有返回任务。</p>}</section>)}{!runDetail.stages.length && <p className="flow-list-empty">云效没有返回阶段详情。</p>}</div></div>}
      </div></section></div>}
    {showRun && selectedPipeline && <div className="flow-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && busy !== "run") setShowRun(false); }}><form className="flow-dialog flow-run-dialog" onSubmit={(event) => void runPipeline(event)}><header><div><h2>运行流水线</h2><p>目标：{selectedPipeline.pipelineName}（{selectedPipeline.pipelineId}）</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setShowRun(false)}><X size={17} /></button></header><label>运行参数（JSON）<textarea spellCheck={false} value={paramsJson} onChange={(event) => setParamsJson(event.target.value)} rows={8} /><small>使用云效运行参数格式，例如环境变量 `{"{"}"envs":{"{"}"key":"value"{"}"}{"}"}`。留空则使用流水线默认值。</small></label><div className="flow-run-warning">确认后将立即在云效中创建一次真实运行。</div><footer><button type="button" className="secondary" disabled={busy === "run"} onClick={() => setShowRun(false)}>取消</button><button type="submit" disabled={busy === "run"}>{busy === "run" ? <LoaderCircle className="flow-spin" size={15} /> : <Play size={15} />}{busy === "run" ? "正在触发…" : "确认运行"}</button></footer></form></div>}
  </section>;
}
