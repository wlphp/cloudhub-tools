import { SharedDialog } from "../../shared/SharedDialog";
import { useConfirmDialog } from "../../shared/useConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { PaginationBar } from "../../shared/PaginationBar";
import { AiLogAnalysis } from "../ai/AiLogAnalysis";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, Check, CircleAlert, Clock3, Eye, FileText, GitBranch, GitCommitHorizontal, LoaderCircle, Play, Plus, RefreshCw, Search, Settings2, Trash2, UserRound, Workflow, X } from "lucide-react";
import { flowClient } from "../../platform/clients";
import { runningInTauri } from "../../platform/api";
import type { FlowConnection, FlowConnectionInput, FlowGroup, FlowJob, FlowLogPage, FlowPipeline, FlowRun, FlowRunDetail, FlowStep } from "../../shared/types";
import "./flow.css";
import { readLocalRuns, rememberLocalRun } from "./localRecentRuns";

const emptyDraft: FlowConnectionInput = { name: "", edition: "central", organizationId: "", domain: "openapi-rdc.aliyuncs.com", token: "" };
const timeText = (value?: number | null) => value ? new Date(value).toLocaleString() : "—";
const durationText = (start?: number | null, end?: number | null, now = Date.now()) => { if (!start) return "—"; const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000)); return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`; };
const successAgeMinutes = (status: string | null | undefined, endTime: number | null | undefined, now: number) => { if (status !== "SUCCESS" || !endTime) return null; const elapsed = now - endTime; return elapsed >= 0 && elapsed <= 30 * 60 * 1000 ? Math.floor(elapsed / 60000) : null; };
const statusText = (value?: string | null) => ({ SUCCESS: "成功", FAIL: "失败", RUNNING: "运行中", CANCELED: "已取消", WAITING: "等待中", SKIPPED: "已跳过" }[value || ""] || value || "未知");
const triggerText = (mode?: number | null) => ({ 1: "页面手动触发", 2: "定时触发", 3: "代码提交触发", 4: "POP API 触发", 5: "流水线触发", 6: "Webhook 触发" } as Record<number, string>)[mode || 0] || "—";
type PipelineSummary = { runId?: string; status?: string | null; startTime?: number | null; endTime?: number | null; triggerMode?: number | null; creatorAccountId?: string | null; creatorEmail?: string | null; stages: Array<{ name: string; status?: string | null }> };

export function FlowPanel({ mobile = false }: { mobile?: boolean }) {
  const { confirm, confirmationDialog } = useConfirmDialog();
  const [connections, setConnections] = useState<FlowConnection[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [pipelines, setPipelines] = useState<FlowPipeline[]>([]);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null);
  const [pipelineSummaries, setPipelineSummaries] = useState<Record<string, PipelineSummary>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [recentView, setRecentView] = useState(false);
  const [localRecentView, setLocalRecentView] = useState(false);
  const historyView = recentView || localRecentView;
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
  const pipelineRequest = useRef(0);
  const connectionVersion = connections.find((item) => item.id === connectionId)?.updatedAt;
  const recentPipelines = useMemo(() => pipelines
    .filter((item) => { const start = pipelineSummaries[item.pipelineId]?.startTime; return typeof start === "number" && Number.isFinite(start) && start > 0; })
    .sort((a, b) => pipelineSummaries[b.pipelineId].startTime! - pipelineSummaries[a.pipelineId].startTime!), [pipelines, pipelineSummaries]);
  const visiblePipelines = historyView ? (recentView ? recentPipelines : pipelines).slice((page - 1) * 30, page * 30) : pipelines;

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

  async function loadPipelines(nextPage = page, search = keyword, restoreCache = true) {
    if (!connectionId) return;
    const request = ++pipelineRequest.current;
    ++summaryRequest.current;
    setSummaryLoading(false);
    setPipelineSummaries({});
    setBusy("pipelines"); setError("");
    try {
      if (localRecentView) {
        const items = readLocalRuns(connectionId).map(item => item.pipeline).filter(item => item.pipelineName.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        setPipelines(items); setPage(nextPage); setHasNext(false); setCacheUpdatedAt(null);
        void loadPipelineSummaries(items, connectionId);
        return;
      }
      if (restoreCache || recentView) {
        setPipelines([]); setCacheUpdatedAt(null);
        if (!recentView) try {
          const saved = await flowClient.cachedPipelines(connectionId, nextPage, 30, search, activeGroupId);
          if (request !== pipelineRequest.current) return;
          if (saved.updatedAt) {
            setPipelines(saved.pipelines); setCacheUpdatedAt(saved.updatedAt);
            setPage(nextPage); setHasNext(saved.pipelines.length === 30);
          }
        } catch { /* A missing or damaged cache must not block a fresh pull. */ }
      }
      if (request !== pipelineRequest.current) return;
      let items: FlowPipeline[];
      if (recentView) {
        const collected = new Map<string, FlowPipeline>();
        for (let currentPage = 1; ; currentPage++) {
          const batch = await flowClient.pipelines(connectionId, currentPage, 30, search, null);
          if (request !== pipelineRequest.current) return;
          const previousSize = collected.size;
          batch.forEach((item) => collected.set(item.pipelineId, item));
          if (batch.length < 30) break;
          if (collected.size === previousSize) throw new Error("流水线分页返回重复数据，请刷新后重试。");
        }
        items = [...collected.values()];
      } else items = await flowClient.pipelines(connectionId, nextPage, 30, search, activeGroupId);
      if (request !== pipelineRequest.current) return;
      setPipelines(items); setPage(recentView ? 1 : nextPage); setHasNext(!recentView && items.length === 30);
      setCacheUpdatedAt(Date.now());
      void loadPipelineSummaries(items, connectionId);
      if (selectedPipeline && !items.some((item) => item.pipelineId === selectedPipeline.pipelineId)) { setSelectedPipeline(null); setRuns([]); setRunDetail(null); }
    } catch (reason) { if (request === pipelineRequest.current) setError(reason instanceof Error ? reason.message : "读取流水线失败"); }
    finally { if (request === pipelineRequest.current) setBusy(""); }
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
    setDetailTab("latest"); setShowDetails(true);
    const history = await choosePipeline(pipeline);
    if (history[0]) await chooseRun(history[0], pipeline);
  }

  async function chooseRun(run: FlowRun, pipeline = selectedPipeline) {
    if (!connectionId || !pipeline) return;
    setBusy("detail"); setError("");
    try { setRunDetail(await flowClient.run(connectionId, pipeline.pipelineId, run.pipelineRunId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取运行详情失败"); }
    finally { setBusy(""); }
  }

  useEffect(() => { void loadConnections(); }, []);
  useEffect(() => { const timer = window.setInterval(() => setClockNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!connectionId) { setGroups([]); setActiveGroupId(null); setPipelines([]); setCacheUpdatedAt(null); setSelectedPipeline(null); setRuns([]); setRunDetail(null); return; }
    let active = true;
    setActiveGroupId(null);
    void flowClient.groups(connectionId).then((items) => { if (active) setGroups(items); }).catch((reason) => { if (active) { setGroups([]); setError(reason instanceof Error ? reason.message : "读取流水线分组失败"); } });
    return () => { active = false; };
  }, [connectionId, connectionVersion]);
  useEffect(() => {
    setKeyword("");
    if (connectionId) void loadPipelines(1, "");
    return () => { ++pipelineRequest.current; ++summaryRequest.current; };
  }, [connectionId, activeGroupId, connectionVersion, recentView, localRecentView]);
  useEffect(() => {
    if (!showDetails || !connectionId || !selectedPipeline || !runDetail || runDetail.status !== "RUNNING") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void flowClient.run(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId).then(setRunDetail).catch(() => undefined);
      void flowClient.runs(connectionId, selectedPipeline.pipelineId, 1, 20).then(setRuns).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [showDetails, connectionId, selectedPipeline?.pipelineId, runDetail?.pipelineRunId, runDetail?.status]);

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
    if (!await confirm({ message: `移除云效连接“${item.name}”？` })) return;
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
      rememberLocalRun(connectionId, selectedPipeline);
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
      if ((job.status || "").toUpperCase() === "RUNNING") {
        try {
          const liveLog = await flowClient.jobLog(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id);
          if (liveLog.logs.length > 0) {
            setJobLogs((old) => ({ ...old, [key]: { entries: [{ stepIndex: -1, buildId: -1, name: "任务运行日志", text: liveLog.logs, more: false, offset: liveLog.nextOffset }] } }));
            return;
          }
        } catch { /* A running job may not expose its task log yet; try step logs below. */ }
      }
      const steps = await flowClient.steps(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id);
      setJobSteps((old) => ({ ...old, [key]: steps }));
      const loggableSteps = steps.filter((step): step is FlowStep & { stepIndex: number; buildId: number } => step.stepIndex != null && step.buildId != null).slice(0, 30);
      const entries: Array<{ stepIndex: number; buildId: number; name: string; text: string; more: boolean; offset: number }> = [];
      if (loggableSteps.length === 0) {
        const pageResult = await flowClient.jobLog(connectionId, selectedPipeline.pipelineId, runDetail.pipelineRunId, job.id);
        entries.push({ stepIndex: -1, buildId: -1, name: "任务运行日志", text: pageResult.logs, more: false, offset: pageResult.nextOffset });
      }
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

  return <section className={`flow-page${mobile ? " mobile-flow-page" : ""}`}>
    <header className="flow-page-header"><div><span className="eyebrow">YUNXIAO FLOW</span><h1>云效流水线</h1><p>浏览组织流水线、手动运行并跟踪阶段与任务日志。</p></div><div className="flow-toolbar-actions">
      <select aria-label="选择云效连接" value={connectionId ?? ""} onChange={(event) => setConnectionId(Number(event.target.value) || null)}><option value="">选择云效连接</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      {currentConnection && <button className="secondary" disabled={busy !== ""} onClick={() => void verifyConnection()}><Activity size={15} />验证连接</button>}
      <button className="primary" onClick={() => { setDraft(emptyDraft); setShowConnection(true); }}><Plus size={15} />添加连接</button>
      {currentConnection && <button className="icon-button" aria-label="编辑连接" title="编辑连接" onClick={() => editConnection(currentConnection)}><Settings2 size={16} /></button>}
    </div></header>
    {message && <div className="flow-feedback success" role="status"><Check size={16} />{message}<button aria-label="关闭提示" onClick={() => setMessage("")}><X size={14} /></button></div>}
    {error && <div className="flow-feedback error" role="alert"><CircleAlert size={16} />{error}<button aria-label="关闭错误" onClick={() => setError("")}><X size={14} /></button></div>}
    {!connections.length ? <div className="flow-empty"><Activity size={34} /><h2>先连接云效组织</h2><p>使用云效个人访问令牌（PAT）连接中心版或 Region 版组织。令牌仅用于云效连接，并加密保存。</p><button onClick={() => { setDraft(emptyDraft); setShowConnection(true); }}><Plus size={15} />配置连接</button></div> : !currentConnection ? <div className="flow-empty">请选择云效连接。</div> : <div className="flow-workspace">
      <section className="panel flow-pipeline-panel"><div className="flow-panel-title"><div><h2>流水线 <span className="flow-count">{recentView ? recentPipelines.length : pipelines.length}</span></h2><span>{cacheUpdatedAt ? `更新于 ${new Date(cacheUpdatedAt).toLocaleString()}` : "首次拉取后自动保存"}</span></div><div className="flow-list-toolbar"><form className="flow-search" onSubmit={(event) => { event.preventDefault(); void loadPipelines(1); }}><Search size={15} /><input aria-label="搜索流水线" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索流水线名称" /><button type="submit">搜索</button></form></div><button className="icon-button flow-refresh-button" aria-label="刷新流水线" title="刷新流水线" disabled={busy === "pipelines"} onClick={() => void loadPipelines(page, keyword, false)}>{busy === "pipelines" ? <LoaderCircle className="flow-spin" size={16} /> : <RefreshCw size={16} />}{mobile && <span>刷新</span>}</button></div>
        <div className="flow-group-tabs" role="tablist" aria-label="流水线分组">
          <button type="button" role="tab" title="仅显示在本机通过本应用成功触发过的流水线，按本地触发时间倒序排列；运行状态仍从云效接口读取" aria-selected={localRecentView} className={localRecentView ? "active" : ""} onClick={() => { setRecentView(false); setActiveGroupId(null); setLocalRecentView(true); }}>本地最近运行</button>
          <button type="button" role="tab" title="显示当前云效连接下的全部流水线" aria-selected={!historyView && activeGroupId === null} className={!historyView && activeGroupId === null ? "active" : ""} onClick={() => { setRecentView(false); setLocalRecentView(false); setActiveGroupId(null); }}>全部</button>
          {groups.map((group) => <button type="button" role="tab" title={`显示云效分组「${group.groupName}」中的流水线`} aria-selected={!historyView && activeGroupId === group.groupId} className={!historyView && activeGroupId === group.groupId ? "active" : ""} key={group.groupId} onClick={() => { setRecentView(false); setLocalRecentView(false); setActiveGroupId(group.groupId); }}>{group.groupName}</button>)}
          <button type="button" role="tab" title="从云效接口读取各流水线的最新运行记录，按云端运行开始时间倒序排列，包含其他设备和自动触发的运行" aria-selected={recentView} className={recentView ? "active" : ""} onClick={() => { setLocalRecentView(false); setActiveGroupId(null); setRecentView(true); }}>云端最近运行</button>
        </div>
        {localRecentView && <p className="flow-recent-note" role="status">仅显示本机通过本应用触发过的流水线 · 按本地触发时间从新到旧排列</p>}
        {recentView && <p className="flow-recent-note" role="status">{summaryLoading || busy === "pipelines" ? "正在读取最近运行…" : "按最近运行开始时间从新到旧排列"} · 仅显示有运行时间的流水线</p>}
        <div className="flow-table-scroll">{mobile ? <div className="flow-mobile-cards">{visiblePipelines.map((pipeline) => {
          const summary = pipelineSummaries[pipeline.pipelineId];
          const status = summary?.status || pipeline.latestStatus;
          return <article className="flow-mobile-card" key={pipeline.pipelineId}>
            <div className="flow-mobile-card-heading">
              <button type="button" className="flow-name-button" onClick={() => void viewPipelineDetails(pipeline)}><span className="flow-card-symbol" aria-hidden="true"><Workflow size={17} /></span><strong>{pipeline.pipelineName}</strong></button>
              <span className={`flow-card-status ${(status || "").toLowerCase()}`}>{status === "SUCCESS" ? <span className="flow-status-icon success" aria-hidden="true"><Check size={12} /></span> : status === "RUNNING" ? <LoaderCircle size={12} /> : status === "FAIL" || status === "FAILED" ? <CircleAlert size={12} /> : <Activity size={12} />}{statusText(status)}</span>
            </div>
            <div className="flow-card-meta"><span>ID {pipeline.pipelineId}</span>{summary?.runId && <span>运行 #{summary.runId}</span>}</div>
            {!!summary?.stages.length && <div className="flow-card-stages" aria-label="最近运行阶段">{summary.stages.slice(0, 3).map((stage, index) => <span key={index}><i className={`flow-status-dot ${(stage.status || "").toLowerCase()}`} aria-hidden="true" />{stage.name}<small>{statusText(stage.status)}</small></span>)}{summary.stages.length > 3 && <span>另 {summary.stages.length - 3} 个阶段</span>}</div>}
            {summary?.startTime && <div className="flow-card-time"><Clock3 size={12} aria-hidden="true" /><span>{timeText(summary.startTime)}</span>{summary.triggerMode && <span>{triggerText(summary.triggerMode).replace("页面", "")}</span>}</div>}
            <footer className="flow-card-footer"><span>{summary?.creatorEmail || (summary?.creatorAccountId ? `账号 ${summary.creatorAccountId}` : summaryLoading ? "更新运行状态…" : "")}</span><div className="flow-row-actions"><button type="button" aria-label={`运行 ${pipeline.pipelineName}`} title="运行流水线" disabled={busy !== ""} onClick={() => { setSelectedPipeline(pipeline); setParamsJson("{}"); setShowRun(true); }}><Play size={14} />运行</button><button type="button" aria-label={`查看 ${pipeline.pipelineName} 详情`} title="查看详情" onClick={() => void viewPipelineDetails(pipeline)}><Eye size={14} />详情</button></div></footer>
          </article>;
        })}</div> : <table className="flow-pipeline-table"><thead><tr><th>流水线名称</th><th>最近运行状态</th><th>最近运行阶段</th><th>触发信息</th><th>最近运行开始时间</th><th className="flow-actions-heading">操作</th></tr></thead><tbody>{visiblePipelines.map((pipeline) => { const summary = pipelineSummaries[pipeline.pipelineId]; return <tr key={pipeline.pipelineId}><td><button type="button" className="flow-name-button" onClick={() => void viewPipelineDetails(pipeline)}><strong>{pipeline.pipelineName}</strong><small>ID {pipeline.pipelineId}</small></button></td><td>{summary ? summary.runId ? <div className="flow-list-status"><strong>#{summary.runId}</strong><span className="flow-list-status-separator">·</span>{summary.status === "SUCCESS" ? <span className="flow-status-icon success" title="运行成功" aria-label="运行成功"><Check size={14} /></span> : <span className={`flow-status ${(summary.status || "").toLowerCase()}`}>{statusText(summary.status)}</span>}</div> : <span className="flow-table-muted">暂无运行</span> : summaryLoading ? <span className="flow-table-muted">读取中…</span> : <span className="flow-table-muted">—</span>}</td><td><div className="flow-stage-track" style={summary?.stages.length ? { width: `${Math.min(summary.stages.length * 56, 280)}px` } : undefined}>{summary?.stages.length ? summary.stages.map((stage, index) => <div className="flow-stage-step" key={`${stage.name}-${index}`}><span className="flow-stage-label">{stage.name}</span><span className="flow-stage-rail"><i className={`flow-stage-node ${summary.status === "SUCCESS" && (stage.status || "").toLowerCase() === "success" && index < summary.stages.length - 1 ? "" : (stage.status || "").toLowerCase()}`} />{index < summary.stages.length - 1 && <i className="flow-stage-link" />}</span></div>) : <span className="flow-table-muted">{summaryLoading && !summary ? "读取中…" : "—"}</span>}</div></td><td><div className="flow-trigger-info"><span className="flow-trigger-avatar" aria-hidden="true"><UserRound size={12} /></span><small title={summary?.creatorEmail ? `触发账号：${summary.creatorEmail}` : summary?.creatorAccountId ? `账号 ID：${summary.creatorAccountId}` : ""}>{summary?.creatorEmail || (summary?.creatorAccountId ? `账号 ID：${summary.creatorAccountId}` : "—")}</small><strong>{triggerText(summary?.triggerMode)}</strong></div></td><td><div>{timeText(summary?.startTime)}</div>{successAgeMinutes(summary?.status, summary?.endTime, clockNow) !== null && <small className="flow-success-age">{successAgeMinutes(summary?.status, summary?.endTime, clockNow) === 0 ? "刚刚成功" : `已成功 ${successAgeMinutes(summary?.status, summary?.endTime, clockNow)} 分钟`}</small>}</td><td className="flow-action-cell"><div className="flow-row-actions"><button type="button" aria-label={`运行 ${pipeline.pipelineName}`} title="运行流水线" disabled={busy !== ""} onClick={() => { setSelectedPipeline(pipeline); setParamsJson("{}"); setShowRun(true); }}><Play size={15} /></button><button type="button" aria-label={`查看 ${pipeline.pipelineName} 详情`} title="查看详情" onClick={() => void viewPipelineDetails(pipeline)}><Eye size={15} /></button></div></td></tr>; })}</tbody></table>}{busy === "pipelines" && !pipelines.length && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={18} />正在读取流水线…</div>}{!visiblePipelines.length && busy !== "pipelines" && !summaryLoading && <div className="flow-list-empty">{recentView ? "没有找到有运行时间的流水线" : "没有找到流水线"}</div>}</div>
        <PaginationBar
          page={page}
          pageSize={30}
          total={historyView ? recentView ? recentPipelines.length : pipelines.length : undefined}
          hasNext={historyView ? undefined : hasNext}
          disabled={busy !== ""}
          onPageChange={(next) => { if (historyView) setPage(next); else void loadPipelines(next); }}
        />
      </section>
    </div>}
    {currentConnection && <div className="flow-connection-footer"><span><Check size={14} />PAT 已加密保存在本机</span><button className="text-danger" onClick={() => void removeConnection(currentConnection)}><Trash2 size={14} />移除此连接</button></div>}
    {showConnection && <SharedDialog title={draft.id ? "编辑云效连接" : "连接云效 Flow"} subtitle="个人访问令牌加密保存，留空可保留原令牌。" className="flow-dialog" onSubmit={(event) => void saveConnection(event)} onClose={() => setShowConnection(false)} closeDisabled={busy === "save"} footer={<><button type="button" className="secondary" disabled={busy === "save"} onClick={() => setShowConnection(false)}>取消</button><button type="submit" className="primary" disabled={busy === "save"}>{busy === "save" ? <LoaderCircle className="flow-spin" size={15} /> : <Check size={15} />}{busy === "save" ? "保存中…" : "保存并验证"}</button></>}>
      <label>连接名称<input autoFocus required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：公司研发组织" /></label>
      <label>组织版本<select value={draft.edition} onChange={(event) => setDraft({ ...draft, edition: event.target.value as "central" | "region", domain: event.target.value === "central" ? "openapi-rdc.aliyuncs.com" : "" })}><option value="central">中心版</option><option value="region">Region 版</option></select></label>
      {draft.edition === "central" ? <label>组织 ID<input required value={draft.organizationId || ""} onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })} placeholder="云效组织 ID" /></label> : <label>接入域名<input required value={draft.domain || ""} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} placeholder="例如：devops.aliyun.com" /><small>只填写 HTTPS 域名，不含路径。</small></label>}
      <label>个人访问令牌（PAT）<SecretField key={draft.id ?? "new"} secretLabel="个人访问令牌" reveal={draft.id && runningInTauri ? () => flowClient.revealToken(draft.id!) : undefined} autoComplete="new-password" required={!draft.id} value={draft.token || ""} onChange={(event) => setDraft({ ...draft, token: event.target.value })} placeholder={draft.id ? "留空以保留原令牌" : "粘贴云效 PAT"} /></label>
    </SharedDialog>}
    {showDetails && selectedPipeline && <SharedDialog title={selectedPipeline.pipelineName} eyebrow="PIPELINE RUN" subtitle={`流水线 ID ${selectedPipeline.pipelineId}${runDetail ? ` · 运行 #${runDetail.pipelineRunId}` : ""}`} className="flow-dialog flow-details-dialog" closeLabel="关闭详情" onClose={() => setShowDetails(false)}>
      <AiLogAnalysis scope=".flow-details-dialog .flow-job-log pre" title="AI 分析选中流水线日志" secrets={[draft.token || ""]} />
      <div className="flow-detail-overview"><div><span>运行状态</span><strong className={`flow-status ${(runDetail?.status || "").toLowerCase()}`}>{runDetail ? statusText(runDetail.status) : "—"}</strong></div><div><span>触发信息</span><strong>{triggerText(runDetail?.triggerMode)}</strong><small>{runDetail?.creatorEmail || (runDetail?.creatorAccountId ? `账号 ID：${runDetail.creatorAccountId}` : "—")}</small></div><div><span>开始时间</span><strong>{timeText(runDetail?.startTime)}</strong></div><div><span>结束时间</span><strong>{timeText(runDetail?.endTime)}</strong></div><div><span>持续时间</span><strong>{durationText(runDetail?.startTime, runDetail?.endTime, clockNow)}</strong></div></div>
      <nav className="flow-detail-tabs" aria-label="运行详情视图"><button type="button" className={detailTab === "latest" ? "active" : ""} aria-current={detailTab === "latest" ? "page" : undefined} onClick={() => setDetailTab("latest")}>最近运行</button><button type="button" className={detailTab === "history" ? "active" : ""} aria-current={detailTab === "history" ? "page" : undefined} onClick={() => setDetailTab("history")}>运行历史</button></nav>
      <div className={`flow-details-content ${detailTab}`}>{detailTab === "history" && <aside className="flow-history-list" aria-label="运行历史">{runs.map((run) => <button type="button" key={run.pipelineRunId} className={runDetail?.pipelineRunId === run.pipelineRunId ? "selected" : ""} onClick={() => void chooseRun(run)}><span className={`flow-status-dot ${(run.status || "").toLowerCase()}`} /><strong>#{run.pipelineRunId}</strong><span className={`flow-status ${(run.status || "").toLowerCase()}`}>{statusText(run.status)}</span><time>{timeText(run.startTime)}</time></button>)}{busy === "runs" && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={16} />读取运行历史…</div>}{!runs.length && busy !== "runs" && <p className="flow-list-empty">暂无运行记录</p>}</aside>}
      {busy === "detail" && !runDetail ? <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={18} />加载运行详情…</div> : !runDetail ? <div className="flow-empty compact"><Activity size={28} /><h2>暂无运行详情</h2><p>这条流水线还没有可显示的运行记录。</p></div> : <div className="flow-modal-run-detail"><aside className="flow-run-origin"><div className="flow-run-origin-heading"><span className="flow-source-icon"><GitBranch size={16} /></span><strong>流水线源 · {runDetail.sources.length || 1}</strong></div><article className="flow-source-card"><div className="flow-source-title"><span className="flow-source-mark"><GitBranch size={14} /></span><strong title={runDetail.sources[0]?.repository || selectedPipeline.pipelineName}>{runDetail.sources[0]?.repository || selectedPipeline.pipelineName}</strong></div><div><GitBranch size={13} /><span>{runDetail.sources[0]?.branch || "分支信息不可用"}</span></div><div><GitCommitHorizontal size={13} /><span>{runDetail.sources[0]?.commitId || "—"}</span></div><div><FileText size={13} /><span>{runDetail.sources[0]?.commitMessage || runDetail.sources[0]?.sourceType || "提交信息不可用"}</span></div></article><div className="flow-source-meta"><span>流水线</span><strong>{selectedPipeline.pipelineName}</strong></div><div className="flow-source-meta"><span>运行编号</span><strong>#{runDetail.pipelineRunId}</strong></div><div className="flow-source-meta"><span>触发账号</span><strong>{runDetail.creatorEmail || (runDetail.creatorAccountId ? `账号 ID：${runDetail.creatorAccountId}` : "—")}</strong></div></aside><div className="flow-stage-lanes">{runDetail.stages.map((stage, stageIndex) => <section className={`flow-stage-lane ${(stage.status || "").toLowerCase()}`} key={`${stage.name}-${stageIndex}`}><header className="flow-stage-lane-heading"><strong>{stage.name || `阶段 ${stageIndex + 1}`}</strong><span className={`flow-status ${(stage.status || "").toLowerCase()}`}>{statusText(stage.status)}</span></header>{stage.jobs.map((job, jobIndex) => { const key = `${runDetail.pipelineRunId}:${job.id || jobIndex}`; const logState = jobLogs[key]; return <article className={`flow-job-card ${(job.status || "").toLowerCase()}`} key={key}><div className="flow-job-card-heading"><span className={`flow-status-dot ${(job.status || "").toLowerCase()}`} /><strong>{job.name || `任务 ${jobIndex + 1}`}</strong></div><div className="flow-job-card-meta"><span>{durationText(job.startTime, job.endTime, clockNow)}</span>{job.id && <button type="button" className="flow-log-toggle" disabled={busy === `log:${key}`} onClick={() => void toggleJobLog(job)}><FileText size={13} />{busy === `log:${key}` ? "读取中…" : expandedJobs.has(key) ? "收起日志" : "日志"}</button>}{expandedJobs.has(key) && !logState?.entries.some((entry) => entry.text.length > 0 || entry.more) && <button type="button" className="flow-log-retry" aria-label="重新获取任务日志" title="重新获取日志" disabled={busy === `log:${key}`} onClick={() => void fetchJobLog(job, key)}><RefreshCw size={13} /></button>}</div>{expandedJobs.has(key) && <div className="flow-job-log">{busy === `log:${key}` && <div className="flow-inline-loading"><LoaderCircle className="flow-spin" size={15} />加载步骤和日志…</div>}{jobSteps[key] && !jobSteps[key].some((step) => step.stepIndex != null && step.buildId != null) && !logState?.entries.some((entry) => entry.text.length > 0) && <p className="flow-log-empty">{jobSteps[key].length === 0 ? "云效返回了空的步骤列表；任务结束后可点击右侧刷新按钮重试。" : "云效步骤缺少编号或构建 ID，无法请求日志；可点击右侧刷新按钮重试。"}</p>}{logState?.entries.map((entry) => entry.text || entry.more ? <section className="flow-log-entry" key={`${entry.stepIndex}-${entry.buildId}`}><strong>{entry.name}</strong><pre>{entry.text || "等待后续日志…"}</pre></section> : null)}{logState && logState.entries.length > 0 && !logState.entries.some((entry) => entry.text.length > 0 || entry.more) && <p className="flow-log-empty">云效当前没有返回日志内容；点击右侧刷新按钮可再次查询。</p>}{logState?.entries.some((entry) => entry.more) && <button className="secondary" disabled={busy !== ""} onClick={() => void loadMoreLog(job)}>继续加载日志</button>}</div>}</article>;})}{!stage.jobs.length && <p className="flow-stage-empty">该阶段没有返回任务。</p>}</section>)}{!runDetail.stages.length && <p className="flow-list-empty">云效没有返回阶段详情。</p>}</div></div>}
      </div></SharedDialog>}
    {showRun && selectedPipeline && <SharedDialog title="运行流水线" subtitle="确认运行目标与参数" size="small" className="flow-dialog flow-run-dialog" onSubmit={(event) => void runPipeline(event)} onClose={() => setShowRun(false)} closeDisabled={busy === "run"} busy={busy === "run"} footer={<><button type="button" className="secondary" disabled={busy === "run"} onClick={() => setShowRun(false)}>取消</button><button type="submit" className="primary" disabled={busy === "run"}>{busy === "run" ? <LoaderCircle className="flow-spin" size={15} /> : <Play size={15} />}{busy === "run" ? "正在触发…" : "确认运行"}</button></>}>
      <div className="flow-run-target">
        <span className="flow-run-target-icon"><Workflow size={20} aria-hidden="true" /></span>
        <div><strong>{selectedPipeline.pipelineName}</strong><span>{currentConnection?.name} · 流水线 ID {selectedPipeline.pipelineId}</span></div>
      </div>
      <p className="flow-run-default">默认使用云效中已配置的分支、环境及运行参数。</p>
      <details className="flow-run-advanced">
        <summary>自定义运行参数 <span>可选 · JSON</span></summary>
        <label>运行参数（JSON）<textarea aria-describedby="flow-run-params-help" spellCheck={false} value={paramsJson} onChange={(event) => setParamsJson(event.target.value)} rows={5} disabled={busy === "run"} /><small id="flow-run-params-help">留空或填写 {"{}"} 使用默认值。环境变量示例：</small><code>{'{"envs":{"key":"value"}}'}</code></label>
      </details>
      <div className="flow-run-notice"><CircleAlert size={15} aria-hidden="true" /><span>确认后将在云效创建一次运行，请确认目标环境。</span></div>
    </SharedDialog>}
    {confirmationDialog}
  </section>;
}
