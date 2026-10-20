import { useEffect, useRef, useState } from "react";
import { History, Search } from "lucide-react";
import { codexClient, type CodexAccount } from "../../platform/clients/codex";
import { OverviewDialog } from "./OverviewDialogs";

type TestResult = { id: number; status: "queued" | "running" | "completed" | "failed" | "cancelled"; text?: string; durationMs?: number; inputTokens?: number | null; outputTokens?: number | null };
type TestRun = { at: number; model: string; prompt: string; results: TestResult[] };
const statusLabels = { queued: "排队中", running: "请求中", completed: "完成", failed: "失败，请检查账号、模型权限与额度", cancelled: "已停止" };
const previewPolicy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
function staticPreview(source: string) { return previewPolicy + source.replace(/<(?:meta|base)[^>]*>/gi, ""); }

export function AccountTestDialog({ accounts, models, onClose }: { accounts: CodexAccount[]; models: string[]; onClose: () => void }) {
  const eligibleAccounts = accounts.filter(account => account.authMode === "chatgpt" && !account.isWebSession);
  const [selected, setSelected] = useState(new Set(eligibleAccounts.map(account => account.id)));
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"new" | "history">("new");
  const [model, setModel] = useState(models[0] ?? "");
  const [prompt, setPrompt] = useState("创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制");
  const [effort, setEffort] = useState("medium");
  const [concurrency, setConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [history, setHistory] = useState<TestRun[]>([]);
  const [activeHistoryRun, setActiveHistoryRun] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const pending = useRef(false); const stopped = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopped.current = true; }; }, []);
  function update(id: number, values: Partial<TestResult>) { if (alive.current) setResults(current => current.map(result => result.id === id ? { ...result, ...values } : result)); }
  const visibleAccounts = eligibleAccounts.filter(account => `${account.email ?? ""} ${account.label} ${account.plan ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const allVisibleSelected = visibleAccounts.length > 0 && visibleAccounts.every(account => selected.has(account.id));
  const promptValid = !!prompt.trim() && new TextEncoder().encode(prompt).length <= 32768;
  const modelValid = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.trim());
  async function start() {
    if (pending.current || !selected.size || !promptValid || !modelValid) return;
    pending.current = true; stopped.current = false; setBusy(true); setPreview(null); setTab("history"); setActiveHistoryRun(0);
    const ids = eligibleAccounts.filter(account => selected.has(account.id)).map(account => account.id);
    const batchResults = new Map<number, TestResult>(ids.map(id => [id, { id, status: "queued" }]));
    setResults(ids.map(id => ({ id, status: "queued" })));
    let position = 0;
    async function worker() { while (!stopped.current && alive.current && position < ids.length) { const id = ids[position++]; batchResults.set(id, { id, status: "running" }); update(id, { status: "running" }); try { const result = await codexClient.testAccount(id, model.trim(), prompt, effort); batchResults.set(id, { id, ...result, status: "completed" }); update(id, { ...result, status: "completed" }); } catch { batchResults.set(id, { id, status: "failed" }); update(id, { status: "failed" }); } } }
    try { await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker)); }
    finally { pending.current = false; if (alive.current) { setBusy(false); const completed = ids.map(id => { const result = batchResults.get(id)!; return result.status === "queued" ? { ...result, status: "cancelled" as const } : result; }); setResults(completed); setHistory(previous => [{ at: Date.now(), model: model.trim(), prompt, results: completed }, ...previous]); } }
  }
  const previewResult = results.find(result => result.id === preview);
  const fenced = previewResult?.text?.split("```")[1];
  const html = fenced ? fenced.slice(fenced.indexOf(String.fromCharCode(10)) + 1) : previewResult?.text;
  const windowLabel = (account: CodexAccount) => account.quota.windows.find(window => window.name.toLowerCase().includes("week") || window.windowMinutes === 10080);
  return <OverviewDialog title="鹈鹕测智" busy={busy} onClose={onClose} className="codex-test-dialog" footer={<>{busy ? <button onClick={() => { stopped.current = true; }}>停止排队请求，等待当前请求完成</button> : <button onClick={onClose}>关闭</button>}{tab === "new" && <button className="primary" disabled={!selected.size || !promptValid || !modelValid || busy} onClick={() => void start()}>确认消耗额度并测试</button>}</>}>
    <div className="codex-test-tabs" role="tablist" aria-label="测试页面"><button role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>新建测试</button><button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><History size={14} />测试记录{history.length > 0 && <span>{history.length}</span>}</button></div>
    {tab === "new" ? <>
      <p className="codex-test-description">同一提示词并行发送到选中的账号，返回独立 HTML 结果，由你自行对比，不自动评分。</p>
      {!models.length && <p role="status">API 服务未运行，请填写该账号支持的模型名称。</p>}
      <label className="codex-test-prompt">鹈鹕提示词<textarea aria-label="鹈鹕提示词" value={prompt} rows={4} maxLength={16000} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>
      <div className="codex-test-options">
        <label>模型<input aria-label="测试模型" list="codex-test-models" value={model} maxLength={128} disabled={busy} onChange={event => setModel(event.target.value)} /><datalist id="codex-test-models">{models.map(value => <option key={value} value={value} />)}</datalist><select aria-label="选择模型" value={model} disabled={busy || !models.length} onChange={event => setModel(event.target.value)}><option value="">选择可用模型</option>{models.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>思考强度<select value={effort} disabled={busy} onChange={event => setEffort(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
        <label>并发数<input aria-label="并发数" type="number" min={1} max={4} step={1} value={concurrency} disabled={busy} onChange={event => setConcurrency(Math.max(1, Math.min(4, Number(event.target.value) || 1)))} /></label>
      </div>
      <p className="codex-test-note">所有账号使用相同交付约定：直接返回独立 HTML，不使用 Markdown 代码块或外部依赖。</p>
      <div className="codex-test-account-heading"><strong>测试账号 ({selected.size}/{eligibleAccounts.length})</strong><button type="button" onClick={() => setSelected(current => { const next = new Set(current); visibleAccounts.forEach(account => allVisibleSelected ? next.delete(account.id) : next.add(account.id)); return next; })}>{allVisibleSelected ? "取消全选" : "全选"}</button></div>
      <label className="codex-test-search"><Search size={15} /><input aria-label="搜索账号" placeholder="搜索账号" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="codex-test-account-list">{visibleAccounts.map(account => { const week = windowLabel(account); const remaining = week ? Math.max(0, Math.min(100, Math.round(100 - week.usedPercent))) : null; return <label className="codex-test-account" key={account.id}><input type="checkbox" checked={selected.has(account.id)} disabled={busy} onChange={event => setSelected(current => { const next = new Set(current); event.target.checked ? next.add(account.id) : next.delete(account.id); return next; })} /><span className="codex-test-account-email">{account.email || account.label}</span><span className="codex-test-plan">{account.plan?.toUpperCase() || "未知"}</span><span className="codex-test-quota">5 周额度 <b className={remaining === null ? "" : remaining < 20 ? "is-low" : "is-ok"}>{remaining === null ? "—" : `${remaining}%`}</b></span></label>; })}{!visibleAccounts.length && <p className="codex-test-empty">{eligibleAccounts.length ? "没有匹配的账号" : "没有可参与测试的 ChatGPT 账号；API Key 和 Web Session 不参与"}</p>}</div>
      <p className="codex-test-warning">测试会发送真实消息并消耗各账号额度；API Key 与网页会话账号不参与。</p>
    </> : <>
      {!history.length ? <div className="codex-test-history-empty"><History size={24} /><strong>{busy ? "测试进行中" : "暂无测试记录"}</strong><span>{busy ? "正在请求选中的账号，结果完成后会保留在此处。" : "完成一次账号测试后，结果会显示在这里。"}</span>{!busy && <button onClick={() => setTab("new")}>新建测试</button>}</div> : history.map((run, index) => <section className="codex-test-history-run" key={run.at}><header><div><strong>{run.model}</strong><span>{new Date(run.at).toLocaleString("zh-CN")} · {run.results.length} 个账号</span></div><button disabled={busy && index === 0} onClick={() => { setActiveHistoryRun(index); setResults(run.results); setPreview(null); }}>查看结果</button></header><p className="codex-test-history-prompt">{run.prompt}</p>{(index === activeHistoryRun ? results : run.results).map(result => <details key={result.id}><summary>{accounts.find(account => account.id === result.id)?.email || accounts.find(account => account.id === result.id)?.label} · {statusLabels[result.status]}{result.durationMs != null ? ` · ${(result.durationMs / 1000).toFixed(1)} 秒` : ""}</summary>{result.status === "completed" && <><p>输入 {result.inputTokens ?? "未知"} / 输出 {result.outputTokens ?? "未知"} Token</p><pre>{result.text || "模型未返回文本"}</pre>{result.text && /<html|<svg|<!doctype/i.test(result.text) && <button disabled={busy} onClick={() => setPreview(result.id)}>预览 HTML</button>}</>}</details>)}</section>)}
      {html && <div className="codex-test-preview"><p>静态隔离预览 · 不执行脚本，支持 CSS / SVG 动画</p><iframe title="模型 HTML 隔离预览" sandbox="" referrerPolicy="no-referrer" srcDoc={staticPreview(html)} /></div>}
    </>}
  </OverviewDialog>;
}
