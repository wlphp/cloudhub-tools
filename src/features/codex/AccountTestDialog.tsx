import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bird, Download, ExternalLink, History, LoaderCircle, Minus, RotateCcw, Search, Square, Tag } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { codexClient, type CodexAccount, type CodexQuotaWindow } from "../../platform/clients/codex";
import {
  CODEX_PELICAN_DEFAULT_MODEL,
  CODEX_PELICAN_DEFAULT_PROMPT,
  CODEX_PELICAN_MAX_CONCURRENCY,
  codexPelicanClient,
  isPelicanRunning,
  pelicanCompletedCount,
  type CodexPelicanArtifact,
  type CodexPelicanBatch,
  type CodexPelicanItem,
  type CodexPelicanItemStatus,
  type CodexPelicanStatus,
} from "../../platform/clients/codex-pelican";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SelectionCheckbox } from "../../shared/SortSelectionControls";
import { OverviewDialog } from "./OverviewDialogs";
import {
  BENCHMARK_NOTICES,
  CANDY_REFERENCE,
  DEFAULT_MODEL_PRESETS,
  PELICAN_BENCHMARK_IDS,
  PELICAN_BENCHMARKS,
  pelicanBenchmark,
  pelicanBenchmarkLabel,
  pelicanPreviewDocument,
  REASONING_EFFORTS,
  scoredPelicanBenchmark,
} from "./pelicanBenchmarks";
import { formatRuleLabel, gradePelicanReply } from "./pelicanScoring";
import { quotaResetTime, remainingPercent, useQuotaClock } from "./quotaPresentation";

type ViewMode = "setup" | "results" | "history";

const batchStatusLabels: Record<CodexPelicanStatus, string> = {
  running: "生成中",
  cancelling: "正在终止",
  completed: "已完成",
  cancelled: "已终止",
  interrupted: "已中断",
};

const itemStatusLabels: Record<CodexPelicanItemStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已终止",
  interrupted: "已中断",
};

export function maskText(value: string, privacy: boolean): string {
  if (!privacy || !value) return value;
  const at = value.indexOf("@");
  if (at > 1) return `${value.slice(0, 2)}***${value.slice(at)}`;
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 4)}***${value.slice(-3)}`;
}

function defaultPelicanConcurrency(accountCount: number): number {
  return Math.min(CODEX_PELICAN_MAX_CONCURRENCY, Math.max(1, Math.floor(accountCount)));
}

function parsePelicanConcurrency(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= CODEX_PELICAN_MAX_CONCURRENCY ? parsed : null;
}

function accountContext(account: CodexAccount | undefined, fallbackEmail: string): string[] {
  if (!account) return [];
  const label = account.label?.trim();
  const scope = account.workspaceName?.trim() || account.accountId?.trim() || account.userId?.trim();
  return [...new Set([label, scope].filter((v): v is string => Boolean(v && v !== fallbackEmail && v !== account.email)))];
}

function formatWindowBadgeLabel(window: CodexQuotaWindow): string {
  const minutes = window.windowMinutes;
  if (minutes === 10080) return "周配额";
  if (minutes && minutes > 10080 && minutes % 10080 === 0) return `${minutes / 10080} 周配额`;
  const weeksMatch = /^(\d+)\s*week/i.exec(window.name.trim());
  if (weeksMatch) return `${Number(weeksMatch[1])} 周配额`;
  if (/^weekly$/i.test(window.name.trim())) return "周配额";
  if (minutes && minutes < 1440 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440} 天配额`;
  return window.name || "配额";
}

function modelDisplayName(slug: string): string {
  const preset = DEFAULT_MODEL_PRESETS.find(item => item.model.toLowerCase() === slug.toLowerCase());
  if (preset) return preset.name;
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => (/^gpt$/i.test(part) ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

function readTokenUsage(usage: unknown): { input: number; output: number; total: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const read = (key: string) => {
    const val = record[key];
    return typeof val === "number" && Number.isFinite(val) ? val : undefined;
  };
  const input = read("input_tokens") ?? read("inputTokens");
  const output = read("output_tokens") ?? read("outputTokens");
  const total = read("total_tokens") ?? read("totalTokens");
  if (input == null && output == null && total == null) return null;
  return { input: input ?? 0, output: output ?? 0, total: total ?? (input ?? 0) + (output ?? 0) };
}

function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function mergeSnapshot(
  active: CodexPelicanBatch | null,
  incoming: CodexPelicanBatch,
  dismissed: ReadonlySet<string>,
): CodexPelicanBatch | null {
  if (dismissed.has(incoming.id)) return active;
  if (!active) return incoming;
  if (active.id === incoming.id) return incoming.revision >= active.revision ? incoming : active;
  return incoming.createdAt >= active.createdAt ? incoming : active;
}

function PelicanReference({ prompt }: { prompt: string }) {
  const benchmark = scoredPelicanBenchmark(prompt);
  if (!benchmark && pelicanBenchmark(prompt) !== "candy") return null;
  return (
    <details className="codex-test-reference">
      <summary>参考解法</summary>
      {benchmark ? (
        <div className="codex-test-reference-body">
          <p className="codex-test-muted">
            {benchmark.suite === "Cockpit" ? (
              "原创固定题"
            ) : (
              <a
                href={benchmark.sourceUrl}
                target="_blank"
                rel="noreferrer"
                onClick={event => {
                  if (runningInTauri && benchmark.sourceUrl) {
                    event.preventDefault();
                    void openUrl(benchmark.sourceUrl).catch(() => undefined);
                  }
                }}
              >
                {benchmark.suite} · {benchmark.sourceId}
              </a>
            )}{" "}
            · {benchmark.release} · {benchmark.graderVersion}
          </p>
          <ul>
            {benchmark.rules.map((rule, index) => (
              <li key={index}>
                <span>{formatRuleLabel(rule.kind, "count" in rule ? rule.count : undefined)}</span>
                {"answer" in rule && <p>参考：{rule.answer}</p>}
                {"answers" in rule && <p>参考：{rule.answers.join(", ")}</p>}
                {"fields" in rule && (
                  <pre>{JSON.stringify(Object.fromEntries(rule.fields.map(f => [f.name, f.value])), null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
          {benchmark.reference && <p className="codex-test-muted">{benchmark.reference}</p>}
          <p className="codex-test-muted">
            {benchmark.rules.every(r => ["json", "noComma", "bullets", "placeholders"].includes(r.kind))
              ? "仅检查格式，内容需人工评估。"
              : "仅核对最终答案，不自动验证推理过程；代码题核对执行结果，不执行生成代码。"}
          </p>
          {benchmark.suite !== "Cockpit" && (
            <details className="codex-test-notices">
              <summary>许可与署名</summary>
              <pre>{BENCHMARK_NOTICES[benchmark.suite]}</pre>
            </details>
          )}
        </div>
      ) : (
        <div className="codex-test-reference-body">
          <p className="codex-test-muted">{CANDY_REFERENCE}</p>
        </div>
      )}
    </details>
  );
}

function PelicanScore({
  prompt,
  reply,
  status,
}: {
  prompt: string;
  reply?: string;
  status: CodexPelicanItemStatus;
}) {
  const score = useMemo(
    () => (status === "completed" && reply !== undefined ? gradePelicanReply(prompt, reply) : null),
    [prompt, reply, status],
  );
  if (status !== "completed") return null;
  if (!scoredPelicanBenchmark(prompt)) return <p className="codex-test-score-note">人工对比</p>;
  if (!score) return <p className="codex-test-score-note">等待完整回复</p>;
  if (score.status === "tooLong") return <p className="codex-test-score-note">回复过长，未判分</p>;
  const answerLabels = {
    passed: "答案正确",
    partial: "答案部分正确",
    failed: "答案不符",
    unavailable: "答案未判定",
  } as const;
  return (
    <details className={`codex-test-score is-${score.status}`}>
      <summary>
        <span>{score.format === "passed" ? "格式符合" : "格式不符"}</span>
        {score.answer && (
          <span>
            {answerLabels[score.answer]}
            {score.answer !== "unavailable" && ` · ${score.passed}/${score.total}`}
          </span>
        )}
      </summary>
      <p className="codex-test-score-note">
        {score.answer === null ? "仅检查格式，内容需人工评估。" : "仅核对最终答案，不自动验证推理过程。"}
      </p>
      <ul>
        {score.checks.map((check, index) => (
          <li key={index}>
            <strong>
              {check.passed ? "符合" : "不符"} · {formatRuleLabel(check.kind, check.count)}
              {check.field ? ` · ${check.field}` : ""}
            </strong>
            {check.expected !== undefined && <span>参考：{check.expected}</span>}
            {check.actual !== undefined && <span>实际：{check.actual}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PelicanAccountBadges({ account, now }: { account: CodexAccount; now: number }) {
  const plan = account.plan?.trim() ? account.plan.trim().toUpperCase() : null;
  const hasQuota = Boolean(account.quota.fetchedAt && account.quota.windows.length);
  return (
    <span className="codex-test-account-summary">
      <span className={`codex-test-plan${plan && plan !== "FREE" ? " is-paid" : ""}`}>{plan ?? "—"}</span>
      <span className="codex-test-account-quotas">
        {!hasQuota ? (
          <span className="codex-test-quota-muted">暂无配额数据</span>
        ) : (
          account.quota.windows.map((win, idx) => {
            const pct = remainingPercent(win);
            const rounded = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
            const tone = rounded == null ? "" : rounded < 20 ? "is-low" : rounded < 60 ? "is-mid" : "is-ok";
            const label = formatWindowBadgeLabel(win);
            const reset = quotaResetTime(win.resetsAt, now);
            return (
              <span
                className="codex-test-quota"
                key={`${win.name}-${idx}`}
                title={`${label}剩余 ${rounded == null ? "未知" : `${rounded}%`} · ${reset}`}
              >
                <span>{label}</span>
                <b className={tone}>{rounded == null ? "—" : `${rounded}%`}</b>
              </span>
            );
          })
        )}
      </span>
    </span>
  );
}

function PelicanResultTile({
  batch,
  item,
  account,
  privacy,
  onRetried,
  onEditTags,
}: {
  batch: CodexPelicanBatch;
  item: CodexPelicanItem;
  account: CodexAccount | undefined;
  privacy: boolean;
  onRetried: (next: CodexPelicanBatch) => void;
  onEditTags: (account: CodexAccount) => void;
}) {
  const [artifact, setArtifact] = useState<CodexPelicanArtifact | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [detailMode, setDetailMode] = useState<"preview" | "raw" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const tileRef = useRef<HTMLElement>(null);

  const email = item.accountEmail || account?.email || account?.label || `账号 #${item.accountId}`;
  const context = accountContext(account, email).map(v => maskText(v, privacy));
  const titleLabel = [maskText(email, privacy), ...context].join(" · ");
  const plan = account?.plan?.trim() ? account.plan.trim().toUpperCase() : null;

  const terminal = item.status !== "queued" && item.status !== "running";
  const retryable = item.status === "failed" || item.status === "cancelled" || item.status === "interrupted";
  const elapsed = item.startedAt == null ? 0 : Math.max(0, ((item.finishedAt ?? Date.now()) - item.startedAt) / 1000);
  const tokenUsage = readTokenUsage(item.usage);
  const tokenLabel = tokenUsage ? `${new Intl.NumberFormat("zh-CN").format(Math.round(tokenUsage.total))} Token` : null;
  const quotaLabel =
    item.quota?.consumedPercent != null
      ? `5h 消耗 ${formatPercent(item.quota.consumedPercent)}%`
      : item.quota?.remainingPercent != null
        ? `5h 剩余 ${formatPercent(item.quota.remainingPercent)}%`
        : null;

  useEffect(() => {
    setArtifact(null);
    setLoadError("");
    if (!terminal) return;
    let disposed = false;
    const node = tileRef.current;
    const fetchArtifact = () => {
      void codexPelicanClient
        .artifact(batch.id, item.id)
        .then(value => {
          if (!disposed) setArtifact(value);
        })
        .catch(reason => {
          if (!disposed) setLoadError(platformErrorMessage(reason, "读取生成结果失败"));
        });
    };
    if (!node || typeof IntersectionObserver === "undefined") {
      fetchArtifact();
      return () => { disposed = true; };
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        observer.disconnect();
        fetchArtifact();
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [batch.id, item.id, item.startedAt, item.finishedAt, terminal, loadAttempt]);

  async function runAction(op: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await op();
    } catch (reason) {
      setActionError(platformErrorMessage(reason, "操作失败"));
    } finally {
      setBusy(false);
    }
  }

  const html = terminal ? artifact?.html ?? null : null;
  const textReply = terminal && item.status === "completed" && !html ? artifact?.rawReply ?? item.replyPreview ?? "" : null;
  const previewUrl = html && artifact?.previewUrl ? artifact.previewUrl : undefined;
  const previewDoc = html && !previewUrl ? pelicanPreviewDocument(html) : undefined;

  function exportHtml() {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pelican-${item.accountId}-${item.id.slice(0, 8)}.html`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  return (
    <article className="codex-test-tile" ref={tileRef}>
      <header className="codex-test-tile-head">
        <div className="codex-test-tile-id" title={titleLabel}>
          <strong className="codex-test-tile-email">{maskText(email, privacy)}</strong>
          {context.length > 0 && <small className="codex-test-tile-context">{context.join(" · ")}</small>}
        </div>
        {plan && <span className={`codex-test-plan is-compact${plan !== "FREE" ? " is-paid" : ""}`}>{plan}</span>}
      </header>

      <div className="codex-test-tile-body">
        {html ? (
          <button
            type="button"
            className="codex-test-canvas"
            aria-label={`${titleLabel} · 放大预览`}
            onClick={() => { setActionError(""); setDetailMode("preview"); }}
          >
            <iframe
              title={titleLabel}
              src={previewUrl}
              srcDoc={previewDoc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              tabIndex={-1}
            />
          </button>
        ) : textReply !== null ? (
          <button
            type="button"
            className="codex-test-canvas is-text"
            aria-label={`${titleLabel} · 查看原始回复`}
            onClick={() => { setActionError(""); setDetailMode("raw"); }}
          >
            <span>{(textReply || "（空回复）").slice(0, 2000)}</span>
          </button>
        ) : (
          <div className={`codex-test-canvas-placeholder${retryable ? " is-failed" : ""}`}>
            {!terminal ? (
              <>
                <LoaderCircle className={item.status === "running" ? "codex-test-spin" : undefined} size={22} />
                <strong>{itemStatusLabels[item.status]}</strong>
                <span className="codex-test-elapsed">{elapsed.toFixed(0)}s</span>
                {item.replyPreview && <small className="codex-test-stream-snippet">{item.replyPreview.slice(-140)}</small>}
              </>
            ) : (
              <>
                <strong>{retryable ? itemStatusLabels[item.status] : !artifact && !loadError ? "读取中…" : "无可显示内容"}</strong>
                {loadError && (
                  <>
                    <p className="codex-test-cell-error">{loadError}</p>
                    <button type="button" disabled={busy} onClick={() => setLoadAttempt(v => v + 1)}>重试读取</button>
                  </>
                )}
                {item.error && !loadError && <p className="codex-test-cell-error">{item.error}</p>}
                {item.startedAt != null && <span className="codex-test-elapsed">{elapsed.toFixed(1)}s</span>}
                <div className="codex-test-cell-actions">
                  {item.error && (
                    <button type="button" disabled={busy} onClick={() => { setActionError(""); setDetailMode("error"); }}>
                      查看错误
                    </button>
                  )}
                  {retryable && (
                    <button
                      type="button"
                      disabled={busy || batch.status === "cancelling"}
                      onClick={() =>
                        void runAction(async () => {
                          const next = await codexPelicanClient.retry(batch.id, item.id);
                          onRetried(next);
                        })
                      }
                    >
                      {busy ? "重试中…" : "重试"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        if (!artifact) setArtifact(await codexPelicanClient.artifact(batch.id, item.id));
                        setDetailMode("raw");
                      })
                    }
                  >
                    原始回复
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {(html || textReply !== null) && (
          <div className="codex-test-cell-caption">
            <span className={`codex-test-status is-${item.status}`}>{itemStatusLabels[item.status]}</span>
            <span>{elapsed.toFixed(1)}s</span>
          </div>
        )}

        <PelicanScore prompt={batch.prompt} reply={artifact?.rawReply} status={item.status} />

        {(tokenLabel || quotaLabel) && (
          <div className="codex-test-cell-usage">
            {tokenLabel && <span>{tokenLabel}</span>}
            {quotaLabel && <span>{quotaLabel}</span>}
          </div>
        )}

        {actionError && !detailMode && <p className="codex-test-inline-error" role="alert">{actionError}</p>}
      </div>

      {account && (
        <footer className="codex-test-tile-tags">
          <div className="codex-test-tag-list">
            {account.tags.map(tag => (
              <span key={tag} className="codex-test-tag-pill" title={tag}>{tag}</span>
            ))}
          </div>
          <button
            type="button"
            className="codex-test-tag-btn"
            aria-label="编辑账号标签"
            title="编辑账号标签"
            onClick={() => onEditTags(account)}
          >
            <Tag size={13} />
          </button>
        </footer>
      )}

      {detailMode && (
        <OverviewDialog
          sizeStorageKey="features/codex/account-test-dialog/result-detail"
          title={titleLabel}
          icon={<Bird size={18} aria-hidden="true" />}
          busy={busy}
          onClose={() => setDetailMode(null)}
          className="codex-test-detail-dialog"
          footer={<button type="button" onClick={() => setDetailMode(null)}>关闭</button>}
        >
          <PelicanScore prompt={batch.prompt} reply={artifact?.rawReply} status={item.status} />
          <div className="codex-test-detail-toolbar">
            {html && (
              <button
                type="button"
                aria-pressed={detailMode === "preview"}
                onClick={() => setDetailMode("preview")}
              >
                预览
              </button>
            )}
            <button
              type="button"
              aria-pressed={detailMode === "raw"}
              disabled={!artifact?.rawReply && !item.replyPreview}
              onClick={() => setDetailMode("raw")}
            >
              原始回复
            </button>
            {item.error && (
              <button
                type="button"
                aria-pressed={detailMode === "error"}
                onClick={() => setDetailMode("error")}
              >
                查看错误
              </button>
            )}
            {html && runningInTauri && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    const url = await codexPelicanClient.browser(batch.id, item.id);
                    await openUrl(url);
                  })
                }
              >
                <ExternalLink size={14} />浏览器打开
              </button>
            )}
            {html && (
              <button type="button" onClick={exportHtml} title="导出的是模型原始 HTML；在应用外打开时不受预览隔离保护">
                <Download size={14} />导出 HTML
              </button>
            )}
          </div>
          {actionError && <p className="codex-test-inline-error" role="alert">{actionError}</p>}
          {(tokenUsage || item.quota) && (
            <div className="codex-test-detail-usage">
              {tokenUsage && (
                <span>
                  输入 {new Intl.NumberFormat("zh-CN").format(tokenUsage.input)} / 输出{" "}
                  {new Intl.NumberFormat("zh-CN").format(tokenUsage.output)}（共{" "}
                  {new Intl.NumberFormat("zh-CN").format(tokenUsage.total)} Token）
                </span>
              )}
              {item.quota?.consumedPercent != null && <span>5h 消耗 {formatPercent(item.quota.consumedPercent)}%</span>}
              {item.quota?.remainingPercent != null && <span>5h 剩余 {formatPercent(item.quota.remainingPercent)}%</span>}
              {item.responseModel && <span>响应模型：{item.responseModel}</span>}
            </div>
          )}
          {detailMode === "preview" && html ? (
            <iframe
              className="codex-test-detail-iframe"
              title={`${titleLabel} HTML 预览`}
              src={previewUrl}
              srcDoc={previewDoc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : (
            <pre className="codex-test-detail-pre" tabIndex={0}>
              {detailMode === "error"
                ? item.error || "测试任务异常中断"
                : artifact?.rawReply || item.replyPreview || "无可显示内容"}
            </pre>
          )}
        </OverviewDialog>
      )}
    </article>
  );
}

export function AccountTestHost({
  open,
  initialSelectedIds,
  accounts,
  models,
  privacy = false,
  onOpen,
  onClose,
  onAccountUpdated,
}: {
  open: boolean;
  initialSelectedIds: number[];
  accounts: CodexAccount[];
  models: string[];
  privacy?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAccountUpdated?: (account: CodexAccount) => void;
}) {
  const now = useQuotaClock();
  const [view, setView] = useState<ViewMode>("setup");
  const [active, setActive] = useState<CodexPelicanBatch | null>(null);
  const [batch, setBatch] = useState<CodexPelicanBatch | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());

  const eligibleAccounts = useMemo(
    () => accounts.filter(account => account.authMode === "chatgpt" && !account.isWebSession),
    [accounts],
  );
  const accountsById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialSelectedIds));
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState(CODEX_PELICAN_DEFAULT_PROMPT);
  const [model, setModel] = useState(CODEX_PELICAN_DEFAULT_MODEL);
  const [effort, setEffort] = useState("medium");
  const [concurrency, setConcurrency] = useState(() => String(defaultPelicanConcurrency(initialSelectedIds.length)));
  const concurrencyEdited = useRef(false);

  const [starting, setStarting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLDivElement>(null);

  const [historyItems, setHistoryItems] = useState<CodexPelicanBatch[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [retentionDays, setRetentionDays] = useState(7);
  const [retentionInput, setRetentionInput] = useState("7");
  const [retentionBusy, setRetentionBusy] = useState(false);

  const [confirmAction, setConfirmAction] = useState<
    | { kind: "stop" | "dismiss"; target: CodexPelicanBatch }
    | { kind: "delete"; target: CodexPelicanBatch }
    | { kind: "clearAll" }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  const [editingTagAccount, setEditingTagAccount] = useState<CodexAccount | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [tagError, setTagError] = useState("");

  const [, setTick] = useState(0);
  const dismissedRef = useRef(dismissedIds);
  dismissedRef.current = dismissedIds;

  // Sync initial selection whenever user opens dialog from overview without a running batch
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setError("");
      setFieldError(null);
      if (active && isPelicanRunning(active)) {
        setBatch(active);
        setView("results");
      } else {
        const validIds = initialSelectedIds.filter(id => eligibleAccounts.some(a => a.id === id));
        setSelected(new Set(validIds));
        if (!concurrencyEdited.current) {
          setConcurrency(String(defaultPelicanConcurrency(validIds.length)));
        }
        if (view === "results" && !batch) setView("setup");
      }
    }
    prevOpen.current = open;
  }, [open, initialSelectedIds, eligibleAccounts, active, batch, view]);

  const selectedIds = useMemo(
    () => eligibleAccounts.filter(a => selected.has(a.id)).map(a => a.id),
    [eligibleAccounts, selected],
  );

  useEffect(() => {
    if (!concurrencyEdited.current) {
      setConcurrency(String(defaultPelicanConcurrency(selectedIds.length)));
    }
  }, [selectedIds.length]);

  const receiveSnapshot = useCallback((incoming: CodexPelicanBatch) => {
    setActive(prev => mergeSnapshot(prev, incoming, dismissedRef.current));
    setBatch(prev => (prev?.id === incoming.id && incoming.revision >= prev.revision ? incoming : prev));
  }, []);

  useEffect(() => {
    void codexPelicanClient.cleanup().catch(() => undefined);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void codexPelicanClient
      .subscribeProgress(payload => {
        if (!disposed) receiveSnapshot(payload);
      })
      .then(async stop => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        const current = await codexPelicanClient.active();
        if (!disposed && current) receiveSnapshot(current);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [receiveSnapshot]);

  useEffect(() => {
    if (!active || !isPelicanRunning(active)) return;
    let disposed = false;
    let fetching = false;
    const timer = window.setInterval(() => {
      setTick(v => v + 1);
      if (fetching) return;
      fetching = true;
      void codexPelicanClient
        .active()
        .then(snapshot => {
          if (!disposed && snapshot) receiveSnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          fetching = false;
        });
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, receiveSnapshot]);

  const loadHistory = useCallback(async (offset: number) => {
    setHistoryLoading(true);
    setError("");
    try {
      const page = await codexPelicanClient.history(offset, 20);
      setHistoryItems(prev =>
        offset ? [...prev, ...page.items.filter(entry => !prev.some(existing => existing.id === entry.id))] : page.items,
      );
      setHistoryHasMore(page.hasMore);
    } catch (reason) {
      setError(platformErrorMessage(reason, "读取测试记录失败"));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || view !== "history") return;
    void loadHistory(0);
    void codexPelicanClient
      .retentionGet()
      .then(res => {
        setRetentionDays(res.days);
        setRetentionInput(String(res.days));
      })
      .catch(() => undefined);
  }, [open, view, loadHistory]);

  const presets = useMemo(() => {
    const known = new Set(DEFAULT_MODEL_PRESETS.map(p => p.model.toLowerCase()));
    const extra = models
      .filter(m => !known.has(m.toLowerCase()))
      .map(m => ({ id: `gateway-${m}`, name: modelDisplayName(m), model: m, defaultEffort: "medium" }));
    return [...DEFAULT_MODEL_PRESETS, ...extra];
  }, [models]);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligibleAccounts;
    return eligibleAccounts.filter(account => {
      const email = account.email || account.label;
      const ctx = accountContext(account, email);
      return [account.email, account.label, ...ctx, account.plan, ...account.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [eligibleAccounts, search]);

  const selectedFilteredCount = useMemo(
    () => filteredAccounts.filter(account => selected.has(account.id)).length,
    [filteredAccounts, selected],
  );
  const allFilteredSelected =
    filteredAccounts.length > 0 && selectedFilteredCount === filteredAccounts.length;

  function toggleFilteredAll() {
    setSelected(prev => {
      const next = new Set(prev);
      filteredAccounts.forEach(acc => (allFilteredSelected ? next.delete(acc.id) : next.add(acc.id)));
      return next;
    });
    clearErrors();
  }

  function invertFiltered() {
    setSelected(prev => {
      const next = new Set(prev);
      filteredAccounts.forEach(acc => (next.has(acc.id) ? next.delete(acc.id) : next.add(acc.id)));
      return next;
    });
    clearErrors();
  }

  const currentBenchmark = pelicanBenchmark(prompt);
  const benchmarkOptions = useMemo(() => {
    const base = PELICAN_BENCHMARK_IDS.map(id => ({ value: id, label: pelicanBenchmarkLabel(id) }));
    if (!PELICAN_BENCHMARK_IDS.includes(currentBenchmark)) {
      base.splice(base.length - 1, 0, {
        value: currentBenchmark,
        label: `${pelicanBenchmarkLabel(currentBenchmark)} · 历史题目`,
      });
    }
    return base;
  }, [currentBenchmark]);

  function clearErrors() {
    setFieldError(null);
    setError("");
  }

  function failField(field: string) {
    setFieldError(field);
    window.requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus();
    });
  }

  async function handleStart() {
    if (starting || isPelicanRunning(active)) return;
    clearErrors();
    if (!model.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.trim())) {
      failField("model");
      return;
    }
    const parsedConcurrency = parsePelicanConcurrency(concurrency);
    if (parsedConcurrency == null) {
      failField("concurrency");
      return;
    }
    if (!prompt.trim() || new TextEncoder().encode(prompt.trim()).length > 100_000) {
      failField("prompt");
      return;
    }
    if (!selectedIds.length) {
      failField("accounts");
      return;
    }
    setStarting(true);
    try {
      const started = await codexPelicanClient.start({
        accountIds: selectedIds,
        prompt,
        model: model.trim(),
        effort,
        concurrency: parsedConcurrency,
      });
      setDismissedIds(prev => {
        const next = new Set(prev);
        next.delete(started.id);
        return next;
      });
      setActive(started);
      setBatch(started);
      setView("results");
    } catch (reason) {
      setError(platformErrorMessage(reason, "启动账号测智失败"));
    } finally {
      setStarting(false);
    }
  }

  function editFromBatch(source: CodexPelicanBatch) {
    if (starting || isPelicanRunning(active)) return;
    const ids = source.items.map(i => i.accountId).filter(id => eligibleAccounts.some(a => a.id === id));
    setSelected(new Set(ids));
    setPrompt(source.prompt);
    setModel(source.model);
    setEffort(source.effort);
    concurrencyEdited.current = true;
    setConcurrency(String(source.concurrency));
    setBatch(null);
    setView("setup");
  }

  async function saveRetention() {
    const days = Number(retentionInput);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      setError("保留天数需为 1 至 3650 天");
      return;
    }
    setRetentionBusy(true);
    setError("");
    try {
      const saved = await codexPelicanClient.retentionSet(days);
      setRetentionDays(saved.days);
      setRetentionInput(String(saved.days));
      await codexPelicanClient.cleanup();
      await loadHistory(0);
    } catch (reason) {
      setError(platformErrorMessage(reason, "保存自动清理天数失败"));
    } finally {
      setRetentionBusy(false);
    }
  }

  async function resolveConfirm(confirmed: boolean) {
    if (!confirmed || !confirmAction) {
      if (!confirmBusy) {
        setConfirmAction(null);
        setConfirmError("");
      }
      return;
    }
    setConfirmBusy(true);
    setConfirmError("");
    try {
      if (confirmAction.kind === "stop") {
        const stopped = await codexPelicanClient.cancel(confirmAction.target.id);
        receiveSnapshot(stopped);
      } else if (confirmAction.kind === "dismiss") {
        const targetId = confirmAction.target.id;
        await codexPelicanClient.dismiss(targetId);
        setDismissedIds(prev => new Set([...prev, targetId]));
        if (active?.id === targetId) setActive(null);
        if (batch?.id === targetId) setBatch(null);
        setView("setup");
        onClose();
      } else if (confirmAction.kind === "delete") {
        const targetId = confirmAction.target.id;
        await codexPelicanClient.delete(targetId);
        setDismissedIds(prev => new Set([...prev, targetId]));
        if (active?.id === targetId) setActive(null);
        if (batch?.id === targetId) setBatch(null);
        await loadHistory(0);
      } else if (confirmAction.kind === "clearAll") {
        await codexPelicanClient.clearAll();
        setHistoryItems([]);
        setHistoryHasMore(false);
        setActive(null);
        setBatch(null);
      }
      setConfirmAction(null);
    } catch (reason) {
      setConfirmError(platformErrorMessage(reason, "执行操作失败"));
    } finally {
      setConfirmBusy(false);
    }
  }

  async function saveAccountTags() {
    if (!editingTagAccount || tagBusy) return;
    setTagBusy(true);
    setTagError("");
    try {
      const tags = [...new Set(tagInput.split(/[,，]/).map(s => s.trim()).filter(Boolean))];
      const updated = await codexClient.saveMetadata({
        id: editingTagAccount.id,
        label: editingTagAccount.label,
        note: editingTagAccount.note,
        tags,
      });
      onAccountUpdated?.(updated);
      setEditingTagAccount(null);
    } catch (reason) {
      setTagError(platformErrorMessage(reason, "保存标签失败"));
    } finally {
      setTagBusy(false);
    }
  }

  if (!open) {
    if (!active) return null;
    return createPortal(
      <button
        type="button"
        className="codex-test-floating"
        onClick={() => {
          setBatch(active);
          setView("results");
          onOpen();
        }}
      >
        <Bird size={16} aria-hidden="true" />
        <span>
          账号测智 · {pelicanCompletedCount(active)}/{active.items.length} · {batchStatusLabels[active.status]}
        </span>
      </button>,
      document.body,
    );
  }

  const resultsView = view === "results" && !!batch;
  const activeResultsView = resultsView && batch?.id === active?.id;
  const busy = starting || retentionBusy;

  const handleCloseRequest = () => {
    if (activeResultsView && batch && isPelicanRunning(batch)) {
      setConfirmError("");
      setConfirmAction({ kind: "dismiss", target: batch });
      return;
    }
    onClose();
  };

  const footer = resultsView && batch ? (
    activeResultsView ? (
      <>
        <button
          type="button"
          className="danger"
          disabled={!isPelicanRunning(batch) || batch.status === "cancelling"}
          onClick={() => {
            setConfirmError("");
            setConfirmAction({ kind: "stop", target: batch });
          }}
        >
          <Square size={13} />终止
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirmError("");
            setConfirmAction({ kind: "dismiss", target: batch });
          }}
        >
          彻底关闭
        </button>
      </>
    ) : (
      <>
        <button type="button" onClick={() => setView("history")}>返回记录</button>
        <button
          type="button"
          className="primary"
          disabled={starting || isPelicanRunning(active)}
          onClick={() => editFromBatch(batch)}
        >
          <RotateCcw size={14} />以此配置重测
        </button>
      </>
    )
  ) : view === "setup" ? (
    <button type="button" className="primary" disabled={starting || isPelicanRunning(active)} onClick={() => void handleStart()}>
      {starting ? "正在启动…" : "开始测试"}
    </button>
  ) : undefined;

  return (
    <>
      <OverviewDialog
        sizeStorageKey={resultsView ? "features/codex/account-test-dialog/results" : "features/codex/account-test-dialog/setup"}
        title={resultsView ? "测试结果" : "账号测智"}
        icon={<Bird size={20} aria-hidden="true" />}
        busy={busy}
        dismissWhileBusy
        onClose={handleCloseRequest}
        headerActions={
          <button
            type="button"
            className="dialog-size-button"
            aria-label="最小化"
            title="最小化"
            onClick={onClose}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        }
        className={`codex-test-dialog${resultsView ? " is-results" : ""}`}
        footer={footer}
      >
        <div className="codex-test-tabs" role="tablist" aria-label="账号测智视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === "setup"}
            disabled={starting || isPelicanRunning(active)}
            onClick={() => { clearErrors(); setView("setup"); }}
          >
            新建测试
          </button>
          {active && (
            <button
              type="button"
              role="tab"
              aria-selected={resultsView && batch?.id === active.id}
              onClick={() => { clearErrors(); setBatch(active); setView("results"); }}
            >
              当前测试
              <span className="codex-test-tab-badge">
                {pelicanCompletedCount(active)}/{active.items.length}
              </span>
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={view === "history"}
            onClick={() => { clearErrors(); setView("history"); }}
          >
            <History size={14} aria-hidden="true" />测试记录
          </button>
        </div>

        {error && <p className="codex-test-error" role="alert">{error}</p>}

        {view === "setup" && (
          <div className="codex-test-setup" ref={formRef}>
            <details className="codex-test-rules">
              <summary>
                <span>同题并行比较账号表现（动画输出独立 HTML，推理输出文本，不提供外部工具）</span>
                <span className="codex-test-rules-more">判分说明</span>
              </summary>
              <p>单题结果不能直接判定账号降智。格式与答案分别判定；固定客观题按参考答案核对，不等同于官方榜单成绩；动画、糖果解法和自定义题由你人工比较。</p>
            </details>

            <div className="codex-test-options">
              <label className="codex-test-field">
                <span>测试题目</span>
                <select
                  aria-label="测试题目"
                  value={currentBenchmark}
                  disabled={busy}
                  onChange={event => {
                    const nextId = event.target.value;
                    setPrompt(PELICAN_BENCHMARKS[nextId] ?? "");
                    clearErrors();
                  }}
                >
                  {benchmarkOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              <label className="codex-test-field">
                <span>模型预设</span>
                <select
                  aria-label="选择模型预设"
                  value={presets.find(p => p.model.toLowerCase() === model.trim().toLowerCase())?.id ?? ""}
                  disabled={busy}
                  onChange={event => {
                    const preset = presets.find(entry => entry.id === event.target.value);
                    if (preset) {
                      setModel(preset.model);
                      setEffort(preset.defaultEffort);
                      clearErrors();
                    }
                  }}
                >
                  <option value="">自定义模型</option>
                  {presets.map(preset => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
              </label>

              <label className="codex-test-field">
                <span>模型</span>
                <input
                  id="codex-test-model-input"
                  data-field="model"
                  aria-label="模型"
                  aria-invalid={fieldError === "model"}
                  value={model}
                  maxLength={128}
                  disabled={busy}
                  onChange={event => {
                    setModel(event.target.value);
                    clearErrors();
                  }}
                />
                {fieldError === "model" && <span className="codex-test-field-error" role="alert">请填写有效模型名称</span>}
              </label>

              <label className="codex-test-field">
                <span>思考强度</span>
                <select
                  aria-label="思考强度"
                  value={effort}
                  disabled={busy}
                  onChange={event => {
                    setEffort(event.target.value);
                    clearErrors();
                  }}
                >
                  {REASONING_EFFORTS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

              <label className="codex-test-field">
                <span>并发数</span>
                <input
                  data-field="concurrency"
                  aria-label="并发数"
                  aria-invalid={fieldError === "concurrency"}
                  type="text"
                  inputMode="numeric"
                  value={concurrency}
                  maxLength={4}
                  placeholder={`1–${CODEX_PELICAN_MAX_CONCURRENCY}`}
                  disabled={busy}
                  onChange={event => {
                    concurrencyEdited.current = true;
                    setConcurrency(event.target.value);
                    clearErrors();
                  }}
                />
                {fieldError === "concurrency" && (
                  <span className="codex-test-field-error" role="alert">
                    1–{CODEX_PELICAN_MAX_CONCURRENCY}
                  </span>
                )}
              </label>
            </div>

            <label className="codex-test-field codex-test-prompt-field">
              <span>提示词</span>
              <textarea
                data-field="prompt"
                aria-label="提示词"
                aria-invalid={fieldError === "prompt"}
                value={prompt}
                rows={2}
                maxLength={100000}
                disabled={busy}
                placeholder={currentBenchmark === "custom" ? "输入要并行发送给所选账号的测试提示词" : undefined}
                onChange={event => {
                  setPrompt(event.target.value);
                  clearErrors();
                }}
              />
              {fieldError === "prompt" && <span className="codex-test-field-error" role="alert">请先填写此项</span>}
            </label>

            <PelicanReference prompt={prompt} />

            <div className="codex-test-account-toolbar">
              <label className="codex-test-select-all">
                <SelectionCheckbox
                  label={search.trim() ? "全选当前筛选账号" : "全选测试账号"}
                  checked={allFilteredSelected}
                  mixed={selectedFilteredCount > 0 && !allFilteredSelected}
                  disabled={busy || !filteredAccounts.length}
                  onChange={toggleFilteredAll}
                />
                <span>{search.trim() ? "全选结果" : "全选"}</span>
              </label>
              <strong className="codex-test-account-count">测试账号 ({selectedIds.length}/{eligibleAccounts.length})</strong>
              <label className="codex-test-search">
                <Search size={14} aria-hidden="true" />
                <input
                  aria-label="搜索账号"
                  placeholder="搜索账号"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || !filteredAccounts.length}
                onClick={toggleFilteredAll}
              >
                {allFilteredSelected ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                disabled={busy || !filteredAccounts.length}
                onClick={invertFiltered}
              >
                反选
              </button>
              <button
                type="button"
                disabled={busy || !selectedIds.length}
                onClick={() => {
                  setSelected(new Set());
                  clearErrors();
                }}
              >
                清空
              </button>
            </div>

            <div
              className="codex-test-account-list"
              data-field="accounts"
              tabIndex={-1}
              aria-invalid={fieldError === "accounts"}
            >
              {!eligibleAccounts.length ? (
                <p className="codex-test-empty">暂无可测试账号（API Key 与仅网页会话账号不参与）</p>
              ) : !filteredAccounts.length ? (
                <p className="codex-test-empty">没有匹配的账号</p>
              ) : (
                filteredAccounts.map(account => {
                  const email = account.email || account.label;
                  const ctx = accountContext(account, email);
                  const checked = selected.has(account.id);
                  return (
                    <label className={`codex-test-account${checked ? " is-selected" : ""}`} key={account.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => {
                          setSelected(prev => {
                            const next = new Set(prev);
                            if (next.has(account.id)) next.delete(account.id);
                            else next.add(account.id);
                            return next;
                          });
                          clearErrors();
                        }}
                      />
                      <span className="codex-test-account-main">
                        <span className="codex-test-account-email">{maskText(email, privacy)}</span>
                        {ctx.length > 0 && (
                          <small className="codex-test-account-id">{ctx.map(v => maskText(v, privacy)).join(" · ")}</small>
                        )}
                        {account.tags.length > 0 && (
                          <small className="codex-test-account-tags">{account.tags.join(" · ")}</small>
                        )}
                      </span>
                      <PelicanAccountBadges account={account} now={now} />
                    </label>
                  );
                })
              )}
            </div>
            {fieldError === "accounts" && <span className="codex-test-field-error" role="alert">请至少选择一个账号</span>}

            <p className="codex-test-warning">测试会发送真实请求并消耗各账号额度；API Key 与仅网页会话账号不参与。</p>
          </div>
        )}

        {resultsView && batch && (
          <div className="codex-test-results-wrap">
            <div className="codex-test-progress-card">
              <div className="codex-test-progress-head">
                <div>
                  <strong>{pelicanBenchmarkLabel(pelicanBenchmark(batch.prompt))}</strong>
                  <span>{modelDisplayName(batch.model)} · {REASONING_EFFORTS.find(e => e.value === batch.effort)?.label ?? batch.effort}</span>
                </div>
                <span className={`codex-test-status is-${batch.status}`}>
                  {batchStatusLabels[batch.status]} · {pelicanCompletedCount(batch)}/{batch.items.length}
                </span>
              </div>
              <div className="codex-test-progress-track" aria-hidden="true">
                <div style={{ width: `${batch.items.length ? Math.round((pelicanCompletedCount(batch) / batch.items.length) * 100) : 0}%` }} />
              </div>
              {batch.error && <p className="codex-test-inline-error" role="alert">{batch.error}</p>}
            </div>

            <PelicanReference prompt={batch.prompt} />

            <div className="codex-test-matrix" role="region" aria-label="账号测智结果矩阵">
              {batch.items.map(item => (
                <PelicanResultTile
                  key={item.id}
                  batch={batch}
                  item={item}
                  account={accountsById.get(item.accountId)}
                  privacy={privacy}
                  onRetried={next => {
                    setDismissedIds(prev => {
                      const copy = new Set(prev);
                      copy.delete(next.id);
                      return copy;
                    });
                    setActive(next);
                    setBatch(next);
                  }}
                  onEditTags={acc => {
                    setTagError("");
                    setTagInput(acc.tags.join(", "));
                    setEditingTagAccount(acc);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {view === "history" && (
          <div className="codex-test-history">
            <div className="codex-test-account-heading">
              <strong>测试记录</strong>
              <div className="codex-test-history-actions">
                <button type="button" disabled={historyLoading || retentionBusy} onClick={() => void loadHistory(0)}>
                  刷新
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={historyLoading || retentionBusy || !historyItems.length || isPelicanRunning(active)}
                  onClick={() => {
                    setConfirmError("");
                    setConfirmAction({ kind: "clearAll" });
                  }}
                >
                  清理全部
                </button>
              </div>
            </div>

            <section className="codex-test-retention">
              <div>
                <strong>自动清理</strong>
                <p>超过设置天数后自动删除测试记录和生成文件，默认保留 7 天。</p>
              </div>
              <div className="codex-test-retention-controls">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  aria-label="自动清理保留天数"
                  value={retentionInput}
                  disabled={retentionBusy}
                  onChange={event => setRetentionInput(event.target.value)}
                />
                <span>天</span>
                <button
                  type="button"
                  disabled={retentionBusy || retentionInput.trim() === String(retentionDays)}
                  onClick={() => void saveRetention()}
                >
                  保存
                </button>
              </div>
            </section>

            {!historyItems.length ? (
              <div className="codex-test-history-empty">
                <History size={24} aria-hidden="true" />
                <strong>{historyLoading ? "正在读取记录…" : "暂无测试记录"}</strong>
                <span>完成一次账号测智后，题目、各账号原始回复与 HTML 预览都会保留在此处。</span>
              </div>
            ) : (
              <div className="codex-test-history-list">
                {historyItems.map(entry => (
                  <article className="codex-test-history-row" key={entry.id}>
                    <div className="codex-test-history-meta">
                      <strong>
                        {new Date(entry.createdAt).toLocaleString("zh-CN")} · {pelicanBenchmarkLabel(pelicanBenchmark(entry.prompt))}
                      </strong>
                      <p>
                        {modelDisplayName(entry.model)} · 思考强度{" "}
                        {REASONING_EFFORTS.find(e => e.value === entry.effort)?.label ?? entry.effort} ·{" "}
                        {entry.items.length} 个账号 · {batchStatusLabels[entry.status]}
                      </p>
                    </div>
                    <div className="codex-test-history-actions">
                      <button
                        type="button"
                        disabled={historyLoading}
                        onClick={() =>
                          void (async () => {
                            setHistoryLoading(true);
                            try {
                              const loaded = await codexPelicanClient.get(entry.id);
                              setBatch(loaded);
                              setView("results");
                            } catch (reason) {
                              setError(platformErrorMessage(reason, "打开测试记录失败"));
                            } finally {
                              setHistoryLoading(false);
                            }
                          })()
                        }
                      >
                        打开
                      </button>
                      <button
                        type="button"
                        disabled={historyLoading || isPelicanRunning(entry) || isPelicanRunning(active)}
                        onClick={() => editFromBatch(entry)}
                      >
                        重测
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={historyLoading || isPelicanRunning(entry)}
                        onClick={() => {
                          setConfirmError("");
                          setConfirmAction({ kind: "delete", target: entry });
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
                {historyHasMore && (
                  <button type="button" disabled={historyLoading} onClick={() => void loadHistory(historyItems.length)}>
                    {historyLoading ? "加载中…" : "加载更多"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </OverviewDialog>

      {confirmAction && (
        <ConfirmDialog
          title={
            confirmAction.kind === "stop"
              ? "终止本次测试？"
              : confirmAction.kind === "dismiss"
                ? "彻底关闭本次测试？"
                : confirmAction.kind === "delete"
                  ? "删除这条测试记录？"
                  : "清理全部账号测智记录？"
          }
          message={
            confirmAction.kind === "stop"
              ? "将取消排队任务并中断进行中的请求，保留已生成结果。"
              : confirmAction.kind === "dismiss"
                ? "若仍在运行将先终止。移除活动入口，历史记录及结果仍保留。"
                : confirmAction.kind === "delete"
                  ? "将永久删除这次测试的记录及生成结果，无法恢复。"
                  : "将永久删除所有测试记录及生成文件，且无法恢复。"
          }
          tone="danger"
          confirmLabel={
            confirmAction.kind === "stop"
              ? "终止"
              : confirmAction.kind === "dismiss"
                ? "彻底关闭"
                : confirmAction.kind === "delete"
                  ? "删除"
                  : "清理全部"
          }
          busy={confirmBusy}
          error={confirmError || undefined}
          onResolve={confirmed => void resolveConfirm(confirmed)}
        />
      )}

      {editingTagAccount && (
        <OverviewDialog
          sizeStorageKey="features/codex/account-test-dialog/tag-editor"
          title="编辑账号标签"
          busy={tagBusy}
          onClose={() => setEditingTagAccount(null)}
          className="codex-test-tag-dialog"
          footer={
            <>
              <button type="button" disabled={tagBusy} onClick={() => setEditingTagAccount(null)}>取消</button>
              <button type="button" className="primary" disabled={tagBusy} onClick={() => void saveAccountTags()}>
                {tagBusy ? "保存中…" : "保存"}
              </button>
            </>
          }
        >
          <p className="codex-test-note">{maskText(editingTagAccount.email || editingTagAccount.label, privacy)}</p>
          <label className="codex-test-field">
            <span>标签（多个标签用逗号分隔）</span>
            <input
              aria-label="账号标签"
              value={tagInput}
              maxLength={320}
              disabled={tagBusy}
              placeholder="例如：主力, 高配额, 待观察"
              onChange={event => setTagInput(event.target.value)}
            />
          </label>
          {tagError && <p className="codex-test-inline-error" role="alert">{tagError}</p>}
        </OverviewDialog>
      )}
    </>
  );
}
