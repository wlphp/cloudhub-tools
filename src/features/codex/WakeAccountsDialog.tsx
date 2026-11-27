import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Play, Square } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { codexClient, type CodexAccount } from "../../platform/clients/codex";
import { CODEX_PELICAN_DEFAULT_MODEL } from "../../platform/clients/codex-pelican";
import { MultiSelectFilter } from "../../shared/MultiSelectFilter";
import { SelectionCardPicker } from "../../shared/SelectionCardPicker";
import { OverviewDialog } from "./OverviewDialogs";
import { maskText, PelicanAccountBadges } from "./AccountTestDialog";
import { DEFAULT_MODEL_PRESETS, REASONING_EFFORTS } from "./pelicanBenchmarks";
import { remainingPercent, useQuotaClock } from "./quotaPresentation";

/** 与后端 model_valid 保持一致：字母数字开头，仅允许 . _ -，最长 100 位。 */
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const DEFAULT_WAKE_PROMPT = "hi";
const MAX_PROMPT_BYTES = 32_768;
const CUSTOM_MODEL = "__custom__";
const FIVE_HOURS = 300;
const ONE_WEEK = 10080;

type WakeSort = "default" | "fiveHour" | "weekly" | "name";
type WakeResult = { status: "running" | "ok" | "failed"; message?: string };

const sortLabels: Record<WakeSort, string> = { default: "默认顺序", fiveHour: "按 5h 额度", weekly: "按周额度", name: "按账号名称" };

const planKey = (account: CodexAccount) => account.plan?.trim().toLowerCase() || "unknown";
const accountName = (account: CodexAccount) => account.email || account.label;

function windowRemaining(account: CodexAccount, minutes: number): number | null {
  if (!account.quota.fetchedAt) return null;
  const window = account.quota.windows.find(item => item.windowMinutes === minutes);
  return window ? remainingPercent(window) : null;
}

export function WakeAccountsDialog({ initialSelectedIds, accounts, models, privacy, onClose, onFinished }: {
  initialSelectedIds: number[];
  accounts: CodexAccount[];
  models: string[];
  privacy: boolean;
  onClose: () => void;
  onFinished: (message: string) => void;
}) {
  const now = useQuotaClock();
  const eligible = useMemo(() => accounts.filter(account => account.authMode === "chatgpt" && !account.isWebSession), [accounts]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialSelectedIds.filter(id => eligible.some(account => account.id === id))));
  const [search, setSearch] = useState("");
  const [planFilters, setPlanFilters] = useState<string[]>([]);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [sort, setSort] = useState<WakeSort>("fiveHour");
  const [reverse, setReverse] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const presets = useMemo(() => {
    const known = new Set(DEFAULT_MODEL_PRESETS.map(preset => preset.model.toLowerCase()));
    const extra = models.filter(model => !known.has(model.toLowerCase())).map(model => ({ id: `gateway-${model}`, name: model, model, defaultEffort: "low" }));
    return [...DEFAULT_MODEL_PRESETS, ...extra];
  }, [models]);
  const [model, setModel] = useState(() => models[0] ?? CODEX_PELICAN_DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState(false);
  const [effort, setEffort] = useState("low");
  const [prompt, setPrompt] = useState("");

  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Map<number, WakeResult>>(() => new Map());
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const stopRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopRef.current = true; }; }, []);

  const planOptions = useMemo(() => [...new Set(eligible.map(planKey))].sort().map(value => ({ value, label: value === "unknown" ? "未知套餐" : value.toUpperCase(), count: eligible.filter(account => planKey(account) === value).length })), [eligible]);
  const tagOptions = useMemo(() => [...new Set(eligible.flatMap(account => account.tags))].sort().map(value => ({ value, label: value, count: eligible.filter(account => account.tags.includes(value)).length })), [eligible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = eligible.filter(account => {
      if (planFilters.length && !planFilters.includes(planKey(account))) return false;
      if (tagFilters.length && !account.tags.some(tag => tagFilters.includes(tag))) return false;
      if (!q) return true;
      return [account.email, account.label, account.workspaceName, account.plan, account.note, ...account.tags].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
    if (sort !== "default") {
      const value = (account: CodexAccount) => windowRemaining(account, sort === "fiveHour" ? FIVE_HOURS : ONE_WEEK);
      list.sort((a, b) => {
        if (sort === "name") return accountName(a).localeCompare(accountName(b), "zh-CN");
        const left = value(a), right = value(b);
        if (left == null && right == null) return 0;
        if (left == null) return 1;
        if (right == null) return -1;
        return right - left;
      });
    }
    return reverse ? list.reverse() : list;
  }, [eligible, search, planFilters, tagFilters, sort, reverse]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);
  const selectedIds = eligible.filter(account => selected.has(account.id)).map(account => account.id);
  const selectedFiltered = filtered.filter(account => selected.has(account.id)).length;
  const allFilteredSelected = filtered.length > 0 && selectedFiltered === filtered.length;
  const filtering = Boolean(search.trim()) || planFilters.length > 0 || tagFilters.length > 0;
  const presetValue = customModel ? CUSTOM_MODEL : presets.find(preset => preset.model.toLowerCase() === model.trim().toLowerCase())?.id ?? CUSTOM_MODEL;

  function toggleFiltered() {
    setSelected(current => {
      const next = new Set(current);
      filtered.forEach(account => allFilteredSelected ? next.delete(account.id) : next.add(account.id));
      return next;
    });
    setError("");
  }

  function toggleOne(id: number) {
    setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setError("");
  }

  async function start() {
    if (running) return;
    setError(""); setSummary("");
    const nextModel = model.trim();
    const text = prompt.trim() || DEFAULT_WAKE_PROMPT;
    if (!MODEL_PATTERN.test(nextModel)) { setError("请填写有效的模型名称：字母或数字开头，仅含字母、数字、. _ -，最长 100 位"); return; }
    if (!REASONING_EFFORTS.some(item => item.value === effort)) { setError("请选择推理强度"); return; }
    if (new TextEncoder().encode(text).length > MAX_PROMPT_BYTES) { setError("唤醒提示词不能超过 32 KB"); return; }
    const ids = selectedIds;
    if (!ids.length) { setError("请至少选择一个账号"); return; }
    if (!runningInTauri) { setError("唤醒会发送真实模型请求，需在桌面客户端执行；浏览器预览仅用于调试账号选择与参数。"); return; }
    stopRef.current = false;
    setStopping(false); setRunning(true); setResults(new Map()); setProgress({ done: 0, total: ids.length });
    let done = 0, failed = 0;
    try {
      for (const id of ids) {
        if (!alive.current || stopRef.current) break;
        setResults(current => new Map(current).set(id, { status: "running" }));
        try {
          await codexClient.wakeAccount(id, nextModel, { prompt: text, effort });
          if (alive.current) setResults(current => new Map(current).set(id, { status: "ok" }));
        } catch (reason) {
          failed++;
          const message = platformErrorMessage(reason, "唤醒请求失败");
          if (alive.current) setResults(current => new Map(current).set(id, { status: "failed", message }));
        }
        done++;
        if (alive.current) setProgress({ done, total: ids.length });
      }
    } finally {
      if (alive.current) { setRunning(false); setStopping(false); }
    }
    if (!alive.current) return;
    const message = `唤醒已处理 ${done} / ${ids.length} 个账号，成功 ${done - failed} 个，失败 ${failed} 个${stopRef.current ? "，已停止后续请求" : ""}。额度需手动刷新以获取最新数据。`;
    setSummary(message);
    onFinished(message);
  }

  const footer = running ? <>
    {progress && <span className="codex-wake-progress" role="status">{progress.done} / {progress.total}</span>}
    <button type="button" className="danger" disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}><Square size={13} />{stopping ? "等待当前账号完成" : "停止后续请求"}</button>
  </> : <>
    <button type="button" onClick={onClose}>{summary ? "关闭" : "取消"}</button>
    <button type="button" className="primary" disabled={!selectedIds.length} onClick={() => void start()}><Play size={14} />{summary ? "再次唤醒" : "开始唤醒"} ({selectedIds.length})</button>
  </>;

  return <OverviewDialog sizeStorageKey="features/codex/wake-accounts-dialog" title="唤醒 Codex 账号" icon={<Play size={18} aria-hidden="true" />} busy={running} onClose={onClose} className="codex-test-dialog codex-wake-dialog" footer={footer}>
    <div className="codex-wake-body">
      <p className="codex-test-warning">向所选账号逐个发送一次真实的简短模型请求，会消耗额度。请先停止账号关联的服务和实例；API Key 与仅网页会话账号不参与。</p>
      {error && <p className="codex-test-error" role="alert">{error}</p>}
      {summary && !error && <p className="codex-wake-summary" role="status">{summary}</p>}

      <SelectionCardPicker
        heading="选择要唤醒的账号"
        className="codex-wake-picker"
        items={paged}
        filteredCount={filtered.length}
        totalCount={eligible.length}
        selectedCount={selectedIds.length}
        getKey={account => account.id}
        selected={selected}
        onToggle={toggleOne}
        allSelected={allFilteredSelected}
        partiallySelected={selectedFiltered > 0 && !allFilteredSelected}
        onToggleAll={toggleFiltered}
        search={search}
        onSearchChange={value => { setSearch(value); setPage(1); }}
        searchLabel="搜索唤醒账号"
        searchPlaceholder="搜索邮箱、标签或备注"
        filtering={filtering}
        onClearFilters={() => { setSearch(""); setPlanFilters([]); setTagFilters([]); setPage(1); }}
        onClearSelection={() => setSelected(new Set())}
        unit="个账号"
        emptyText="暂无可唤醒账号（API Key 与仅网页会话账号不参与）"
        noMatchText="没有匹配的账号"
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={size => { setPageSize(size); setPage(1); }}
        disabled={running}
        toolbar={<>
          <MultiSelectFilter className="codex-plan-filter" label="套餐" ariaLabel="按套餐筛选唤醒账号" allLabel="全部套餐" total={eligible.length} options={planOptions} selected={planFilters} onChange={next => { setPlanFilters(next); setPage(1); }} disabled={running} />
          <MultiSelectFilter className="codex-plan-filter" label="标签" ariaLabel="按标签筛选唤醒账号" allLabel="全部标签" options={tagOptions} selected={tagFilters} onChange={next => { setTagFilters(next); setPage(1); }} disabled={running || !tagOptions.length} />
          <select aria-label="唤醒账号排序" value={sort} disabled={running} onChange={event => setSort(event.target.value as WakeSort)}>{(Object.keys(sortLabels) as WakeSort[]).map(key => <option key={key} value={key}>{sortLabels[key]}</option>)}</select>
          <button type="button" aria-label={reverse ? "恢复排序方向" : "反转排序方向"} title={reverse ? "恢复排序方向" : "反转排序方向"} aria-pressed={reverse} disabled={running || sort === "default"} onClick={() => setReverse(!reverse)}>{reverse ? <ArrowUp size={14} /> : <ArrowDown size={14} />}</button>
        </>}
        renderCard={account => {
          const result = results.get(account.id);
          const scope = account.workspaceName?.trim() || (account.label && account.label !== account.email ? account.label : "");
          return {
            title: maskText(accountName(account), privacy),
            titleHint: privacy ? undefined : accountName(account),
            badge: result && <span className={`codex-wake-status is-${result.status}`} title={result.message}>{result.status === "running" ? "唤醒中" : result.status === "ok" ? "成功" : "失败"}</span>,
            meta: <>{scope ? maskText(scope, privacy) : "个人账户"}{account.tags.length > 0 && ` · ${account.tags.join(" · ")}`}</>,
            aside: <PelicanAccountBadges account={account} now={now} />,
            footer: result?.status === "failed" && result.message ? <small className="codex-wake-card-error" role="alert">{result.message}</small> : undefined,
          };
        }}
      />

      <section className="codex-wake-section" aria-label="唤醒模型预设">
        <strong className="codex-wake-heading">唤醒模型预设</strong>
        <div className="codex-wake-options">
          <label className="codex-test-field"><span>模型预设</span>
            <select aria-label="选择唤醒模型预设" value={presetValue} disabled={running} onChange={event => {
              if (event.target.value === CUSTOM_MODEL) { setCustomModel(true); return; }
              const preset = presets.find(item => item.id === event.target.value);
              if (preset) { setCustomModel(false); setModel(preset.model); setError(""); }
            }}>
              {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              <option value={CUSTOM_MODEL}>自定义模型</option>
            </select>
          </label>
          <label className="codex-test-field"><span>推理强度</span>
            <select aria-label="唤醒推理强度" value={effort} disabled={running} onChange={event => setEffort(event.target.value)}>{REASONING_EFFORTS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
          </label>
        </div>
        {presetValue === CUSTOM_MODEL && <label className="codex-test-field"><span>模型 ID</span><input aria-label="自定义唤醒模型" value={model} maxLength={100} disabled={running} placeholder="填写账号可用的模型 ID" onChange={event => { setModel(event.target.value); setError(""); }} /></label>}
        <p className="codex-wake-hint">实际传入模型值：<code>{model.trim() || "未填写"}</code>；模型可用性由账号权限决定，失败原因显示在对应账号上。</p>
      </section>

      <label className="codex-test-field codex-test-prompt-field"><span>唤醒提示词</span>
        <textarea aria-label="唤醒提示词" rows={3} maxLength={MAX_PROMPT_BYTES} value={prompt} disabled={running} placeholder={`留空则使用默认提示词：${DEFAULT_WAKE_PROMPT}`} onChange={event => setPrompt(event.target.value)} />
      </label>
    </div>
  </OverviewDialog>;
}
