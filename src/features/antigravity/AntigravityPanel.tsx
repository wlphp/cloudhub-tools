import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  ArrowLeftRight,
  Blocks,
  Clock,
  Copy,
  Diamond,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderKanban,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Shield,
  Sparkles,
  Table2,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ToastNotice } from "../../shared/ToastNotice";
import { AntigravityQuotaLogsDialog } from "./AntigravityQuotaLogsDialog";
import { AntigravityProxyDialog } from "./AntigravityProxyDialog";
import { MultiSelectFilter } from "../../shared/MultiSelectFilter";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { useGridPageSize } from "../../shared/useGridPageSize";
import { ListSortHandle } from "../../shared/ListSortHandle";
import { useSortableDrag, type SortableDrop } from "../../shared/useSortableDrag";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import {
  antigravityClient,
  type AntigravityAccount,
  type AntigravityModelQuota,
  type AntigravityQuotaBucket,
  type AntigravityState,
  type AntigravitySwitchTarget,
} from "../../platform/clients/antigravity";
import {
  AddAntigravityAccountDialog,
  AntigravityActionsDialog,
  AntigravityDetailsDialog,
  AntigravityDeviceProfileDialog,
  AntigravityEditDialog,
  AntigravityExportDialog,
  AntigravityTagsDialog,
  type AddAccountMethod,
} from "./AntigravityDialogs";
import "../codex/codex.css";
import "./antigravity.css";

function maskEmail(email: string, privacy: boolean): string {
  if (!privacy) return email;
  const at = email.indexOf("@");
  if (at <= 1) return "***" + (at >= 0 ? email.slice(at) : "");
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

function formatDatePart(value: number | null | undefined): string {
  if (!value) return "未刷新";
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function formatClockPart(value: number | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFullTime(value: number | null | undefined): string {
  if (!value) return "尚未刷新";
  return `${formatDatePart(value)} ${formatClockPart(value)}`;
}

function formatCompactCountdown(resetIso: string | undefined): string {
  if (!resetIso) return "";
  const target = Date.parse(resetIso);
  if (!Number.isFinite(target)) return "";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "0h 0m";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

function quotaTone(pct: number): "good" | "warn" | "zero" {
  if (pct <= 0) return "zero";
  if (pct <= 50) return "warn";
  return "good";
}

function isAccountAbnormal(account: AntigravityAccount): boolean {
  return Boolean(account.disabled || account.lastError || account.quota?.isForbidden);
}

/** 精致的四芒星图标（用于 Gemini 配额卡片，遵循参考图视觉识别） */
function GeminiStarIcon() {
  return (
    <svg className="ag-gemini-star" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <defs>
        <linearGradient id="ag-gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="52%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      <path
        fill="url(#ag-gemini-grad)"
        d="M8 0.8C8.4 4.5 11.5 7.6 15.2 8C11.5 8.4 8.4 11.5 8 15.2C7.6 11.5 4.5 8.4 0.8 8C4.5 7.6 7.6 4.5 8 0.8Z"
      />
    </svg>
  );
}

interface ModelBadge {
  key: string;
  label: string;
  family: "claude" | "gpt" | "gemini";
}

function parseVersionNumber(raw: string): number {
  const m = raw.match(/(\d+(?:[.-]\d+)?)/);
  if (!m) return 0;
  return Number.parseFloat(m[1].replace("-", ".")) || 0;
}

function extractModelBadges(models: AntigravityModelQuota[]): ModelBadge[] {
  if (!models.length) return [];
  const badges: ModelBadge[] = [];

  // 1) Claude 最高版本标签（例如 Claude 4.6 / Claude 5.5）
  const claudeModels = models.filter(m => /claude/i.test(`${m.name} ${m.displayName ?? ""}`));
  if (claudeModels.length > 0) {
    let bestVer = "";
    let bestScore = -1;
    for (const m of claudeModels) {
      const hay = `${m.displayName ?? ""} ${m.name}`;
      const match = hay.match(/claude[^0-9]*(\d+(?:[.-]\d+)?)/i) ?? hay.match(/(\d+\.\d+)/);
      const ver = match ? match[1].replace("-", ".") : "";
      const score = ver ? Number.parseFloat(ver) : 0;
      if (score > bestScore) {
        bestScore = score;
        bestVer = ver;
      }
    }
    badges.push({
      key: "claude",
      label: bestVer ? `Claude ${bestVer}` : "Claude",
      family: "claude",
    });
  }

  // 2) GPT 模型标签（例如 GPT-120B / GPT-5）
  const gptModels = models.filter(m => /gpt/i.test(`${m.name} ${m.displayName ?? ""}`));
  if (gptModels.length > 0) {
    const has120b = gptModels.some(m => /120b/i.test(`${m.name} ${m.displayName ?? ""}`));
    let label = "GPT";
    if (has120b) {
      label = "GPT-120B";
    } else {
      const first = gptModels[0];
      const hay = `${first.displayName ?? ""} ${first.name}`;
      const m = hay.match(/gpt[-\s]?([a-z0-9.]+)/i);
      if (m) label = `GPT-${m[1].toUpperCase()}`;
    }
    badges.push({ key: "gpt", label, family: "gpt" });
  }

  return badges;
}

function formatGeminiShortVersions(models: AntigravityModelQuota[]): string {
  const versions: string[] = [];
  for (const m of models) {
    const hay = `${m.displayName ?? ""} ${m.name}`;
    if (!/gemini/i.test(hay)) continue;
    const match = hay.match(/gemini[-\s]?(\d+(?:[.-]\d+)?)/i);
    if (match) {
      const v = match[1].replace("-", ".");
      if (!versions.includes(v)) versions.push(v);
    }
  }
  versions.sort((a, b) => parseVersionNumber(b) - parseVersionNumber(a));
  if (versions.length >= 2) return `Gemini ${versions[0]} / ${versions[1]}`;
  if (versions.length === 1) return `Gemini ${versions[0]}`;
  return "Gemini";
}

function formatClaudeGptShortLabel(models: AntigravityModelQuota[]): string {
  const badges = extractModelBadges(models);
  const claude = badges.find(b => b.family === "claude");
  const hasGpt = badges.some(b => b.family === "gpt");
  if (claude && hasGpt) return `${claude.label} / GPT`;
  if (claude) return claude.label;
  if (hasGpt) return "GPT";
  return "Claude / GPT";
}

interface QuotaGridCell {
  key: string;
  label: string;
  rawLabel: string;
  family: "gemini" | "claude" | "generic";
  isWeekly: boolean;
  percentage: number | null;
  resetText: string;
}

function isWeeklyBucket(bucket: AntigravityQuotaBucket): boolean {
  const hay = `${bucket.window} ${bucket.bucketId} ${bucket.displayName ?? ""}`.toLowerCase();
  return hay.includes("week") || hay.includes("7d") || hay.includes("168h");
}

function isShortWindowBucket(bucket: AntigravityQuotaBucket): boolean {
  const hay = `${bucket.window} ${bucket.bucketId} ${bucket.displayName ?? ""}`.toLowerCase();
  return hay.includes("5h") || hay.includes("five") || hay.includes("hour") || hay.includes("day") || hay.includes("daily");
}

function normalizeGenericLabel(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower.includes("weekly") || lower === "7d") return "周配额";
  if (lower.includes("five hour") || lower.includes("5h") || lower.includes("five_hour")) return "5H 配额";
  if (lower.includes("daily")) return "日配额";
  return raw.replace(/\s*limit\s*remaining$/i, "").trim() || raw;
}

function isWeeklyResetTime(resetIso: string | undefined): boolean {
  if (!resetIso) return false;
  const target = Date.parse(resetIso);
  if (!Number.isFinite(target)) return false;
  return target - Date.now() > 18 * 3600_000;
}

function summarizeModelsByWindow(list: AntigravityModelQuota[]): {
  shortModel?: { percentage: number; resetTime: string; rawLabel: string };
  weeklyModel?: { percentage: number; resetTime: string; rawLabel: string };
} {
  if (!list.length) return {};
  const shortOnes: AntigravityModelQuota[] = [];
  const weeklyOnes: AntigravityModelQuota[] = [];
  for (const m of list) {
    if (isWeeklyResetTime(m.resetTime)) weeklyOnes.push(m);
    else shortOnes.push(m);
  }
  const pickSummary = (subset: AntigravityModelQuota[]) => {
    if (!subset.length) return undefined;
    let lowest = subset[0];
    for (const item of subset) {
      if (item.percentage < lowest.percentage) lowest = item;
    }
    const withReset = subset.find(m => m.percentage === lowest.percentage && m.resetTime) ?? lowest;
    return {
      percentage: lowest.percentage,
      resetTime: withReset.resetTime,
      rawLabel: withReset.displayName || withReset.name,
    };
  };
  return {
    shortModel: pickSummary(shortOnes),
    weeklyModel: pickSummary(weeklyOnes),
  };
}

function extractQuotaGridCells(account: AntigravityAccount): QuotaGridCell[] {
  const groups = account.quota?.quotaGroups ?? [];
  const models = account.quota?.models ?? [];

  if (!groups.length && !models.length) return [];

  const geminiPrefix = formatGeminiShortVersions(models);
  const claudePrefix = formatClaudeGptShortLabel(models);

  const geminiGroup = groups.find(g => /gemini/i.test(g.displayName));
  const claudeGroup = groups.find(g => /claude|gpt|anthropic|openai|3p/i.test(g.displayName));

  const geminiModels = models.filter(m => /gemini/i.test(`${m.name} ${m.displayName ?? ""}`));
  const claudeModels = models.filter(m => /claude|gpt/i.test(`${m.name} ${m.displayName ?? ""}`));

  const bucketToCell = (
    key: string,
    label: string,
    family: "gemini" | "claude",
    isWeekly: boolean,
    rawPrefix: string,
    bucket: AntigravityQuotaBucket,
  ): QuotaGridCell => ({
    key,
    label,
    rawLabel: `${rawPrefix} · ${bucket.displayName || bucket.window}`,
    family,
    isWeekly,
    percentage: Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100),
    resetText: formatCompactCountdown(bucket.resetTime),
  });

  // 1) 第一行：Gemini 5H 额度 | Gemini 周额度
  const g5hBucket = geminiGroup?.buckets?.find(b => isShortWindowBucket(b));
  const gWeekBucket = geminiGroup?.buckets?.find(b => isWeeklyBucket(b));
  const geminiFallback = summarizeModelsByWindow(geminiModels);

  const g5hCell: QuotaGridCell = g5hBucket
    ? bucketToCell("gemini-5h", "Gemini 5H", "gemini", false, geminiPrefix, g5hBucket)
    : !geminiGroup && geminiFallback.shortModel
      ? {
          key: "gemini-5h",
          label: "Gemini 5H",
          rawLabel: `${geminiPrefix} 5H · ${geminiFallback.shortModel.rawLabel}`,
          family: "gemini",
          isWeekly: false,
          percentage: geminiFallback.shortModel.percentage,
          resetText: formatCompactCountdown(geminiFallback.shortModel.resetTime),
        }
      : {
          key: "gemini-5h",
          label: "Gemini 5H",
          rawLabel: `${geminiPrefix} 5H（当前未返回独立 5 小时窗口）`,
          family: "gemini",
          isWeekly: false,
          percentage: null,
          resetText: "",
        };

  const gWeekCell: QuotaGridCell = gWeekBucket
    ? bucketToCell("gemini-weekly", "Gemini 周", "gemini", true, geminiPrefix, gWeekBucket)
    : !geminiGroup && geminiFallback.weeklyModel
      ? {
          key: "gemini-weekly",
          label: "Gemini 周",
          rawLabel: `${geminiPrefix} 周配额 · ${geminiFallback.weeklyModel.rawLabel}`,
          family: "gemini",
          isWeekly: true,
          percentage: geminiFallback.weeklyModel.percentage,
          resetText: formatCompactCountdown(geminiFallback.weeklyModel.resetTime),
        }
      : {
          key: "gemini-weekly",
          label: "Gemini 周",
          rawLabel: `${geminiPrefix} 周配额（点击刷新获取最新周配额）`,
          family: "gemini",
          isWeekly: true,
          percentage: null,
          resetText: "",
        };

  // 2) 第二行：Claude 5H 额度 | Claude 周额度
  const c5hBucket = claudeGroup?.buckets?.find(b => isShortWindowBucket(b));
  const cWeekBucket = claudeGroup?.buckets?.find(b => isWeeklyBucket(b));
  const claudeFallback = summarizeModelsByWindow(claudeModels);

  const c5hCell: QuotaGridCell = c5hBucket
    ? bucketToCell("claude-5h", "Claude 5H", "claude", false, claudePrefix, c5hBucket)
    : !claudeGroup && claudeFallback.shortModel
      ? {
          key: "claude-5h",
          label: "Claude 5H",
          rawLabel: `${claudePrefix} 5H · ${claudeFallback.shortModel.rawLabel}`,
          family: "claude",
          isWeekly: false,
          percentage: claudeFallback.shortModel.percentage,
          resetText: formatCompactCountdown(claudeFallback.shortModel.resetTime),
        }
      : {
          key: "claude-5h",
          label: "Claude 5H",
          rawLabel: `${claudePrefix} 5H（当前未返回独立 5 小时窗口）`,
          family: "claude",
          isWeekly: false,
          percentage: null,
          resetText: "",
        };

  const cWeekCell: QuotaGridCell = cWeekBucket
    ? bucketToCell("claude-weekly", "Claude 周", "claude", true, claudePrefix, cWeekBucket)
    : !claudeGroup && claudeFallback.weeklyModel
      ? {
          key: "claude-weekly",
          label: "Claude 周",
          rawLabel: `${claudePrefix} 周配额 · ${claudeFallback.weeklyModel.rawLabel}`,
          family: "claude",
          isWeekly: true,
          percentage: claudeFallback.weeklyModel.percentage,
          resetText: formatCompactCountdown(claudeFallback.weeklyModel.resetTime),
        }
      : {
          key: "claude-weekly",
          label: "Claude 周",
          rawLabel: `${claudePrefix} 周配额（点击刷新获取最新周配额）`,
          family: "claude",
          isWeekly: true,
          percentage: null,
          resetText: "",
        };

  const hasAnyFamilyData =
    g5hCell.percentage !== null ||
    gWeekCell.percentage !== null ||
    c5hCell.percentage !== null ||
    cWeekCell.percentage !== null;

  // 固定 2x2 两行排布：
  // 第一行：Gemini 5H | Gemini 周
  // 第二行：Claude 5H | Claude 周
  if (hasAnyFamilyData) {
    return [g5hCell, gWeekCell, c5hCell, cWeekCell];
  }

  // Case 3: 仅返回通用未分族 quotaGroups
  if (groups.length > 0) {
    const out: QuotaGridCell[] = [];
    for (const group of groups) {
      for (const bucket of group.buckets ?? []) {
        const weekly = isWeeklyBucket(bucket);
        const rawLabel = bucket.displayName || `${group.displayName} ${bucket.window}`.trim();
        out.push({
          key: `${group.displayName}-${bucket.bucketId}`,
          label: normalizeGenericLabel(rawLabel),
          rawLabel,
          family: /gemini/i.test(rawLabel) ? "gemini" : /claude|gpt/i.test(rawLabel) ? "claude" : "generic",
          isWeekly: weekly,
          percentage: Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100),
          resetText: formatCompactCountdown(bucket.resetTime),
        });
      }
    }
    out.sort((a, b) => Number(a.isWeekly) - Number(b.isWeekly));
    if (out.length > 0) return out.slice(0, 4);
  }

  // Case 4: 兜底取前 4 个模型
  return models.slice(0, 4).map(m => {
    const rawLabel = m.displayName || m.name;
    return {
      key: m.name,
      label: normalizeGenericLabel(rawLabel),
      rawLabel,
      family: /gemini/i.test(rawLabel) ? "gemini" : /claude|gpt/i.test(rawLabel) ? "claude" : "generic",
      isWeekly: isWeeklyResetTime(m.resetTime),
      percentage: m.percentage,
      resetText: formatCompactCountdown(m.resetTime),
    };
  });
}

function accountMinQuota(account: AntigravityAccount): number | null {
  const pcts = extractQuotaGridCells(account)
    .map(c => c.percentage)
    .filter((p): p is number => p !== null);
  if (!pcts.length) return null;
  return Math.min(...pcts);
}

function accountClientTag(account: AntigravityAccount): string {
  if (account.customLabel.trim()) return account.customLabel.trim();
  if (account.oauthClientKey === "antigravity_gcp") return "GCP";
  return "";
}

const SWITCH_TARGETS: {
  id: AntigravitySwitchTarget;
  label: string;
  shortBadge: string;
  title: string;
}[] = [
  { id: "cli", label: "AGY CLI", shortBadge: "CLI", title: "切换 Antigravity CLI (agy) 账号" },
  { id: "ide", label: "IDE", shortBadge: "IDE", title: "切换 Antigravity IDE (state.vscdb) 账号" },
  { id: "jeb", label: "JEB", shortBadge: "JEB", title: "切换 JetBrains 插件 (ACP) 账号" },
  { id: "antigravity", label: "Antigravity", shortBadge: "AGY", title: "切换 Antigravity 桌面主端账号" },
];

function SwitchTargetButton({
  account,
  activeTargets,
  busy,
  onSelectTarget,
}: {
  account: AntigravityAccount;
  activeTargets: AntigravitySwitchTarget[];
  busy: boolean;
  onSelectTarget: (target: AntigravitySwitchTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const popoverWidth = 286;
    const popoverHeight = 64;
    const below = rect.top < popoverHeight + 16;
    const center = rect.left + rect.width / 2;
    const clampedLeft = Math.max(popoverWidth / 2 + 8, Math.min(center, window.innerWidth - popoverWidth / 2 - 8));
    setPos({
      top: below ? rect.bottom + 8 : rect.top - 8,
      left: clampedLeft,
      below,
    });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target))
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const hasActive = activeTargets.length > 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ag-act-btn ag-act-switch${open ? " is-open" : ""}${hasActive ? " has-active-target" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title="选择要切换的目标客户端（Antigravity / IDE / JEB / AGY CLI）"
        onClick={event => {
          event.stopPropagation();
          if (open) setOpen(false);
          else openMenu();
        }}
      >
        <ArrowLeftRight size={13} />
        <span>切换</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          className={`ag-switch-popover${pos.below ? " is-below" : ""}`}
          role="menu"
          aria-label={`选择 ${account.email} 的切换目标`}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            transform: pos.below ? "translateX(-50%)" : "translate(-50%, -100%)",
          }}
          onClick={event => event.stopPropagation()}
        >
          {SWITCH_TARGETS.map(item => {
            const isActive = activeTargets.includes(item.id);
            const icon =
              item.id === "antigravity" ? <ArrowLeftRight size={14} /> :
              item.id === "ide" ? <Repeat2 size={14} /> :
              item.id === "jeb" ? <Blocks size={14} /> :
              <Terminal size={14} />;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`ag-switch-opt is-${item.id}${isActive ? " is-active" : ""}`}
                title={isActive ? `${item.label} 当前正使用此账号，点击重新应用` : item.title}
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onSelectTarget(item.id);
                }}
              >
                {icon}
                <span>{item.label}</span>
                {isActive && <i className="ag-switch-active-dot" aria-label="当前已激活" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

export function AntigravityPanel({ mobile = false }: { mobile?: boolean }) {
  const [state, setState] = useState<AntigravityState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [tierQuickFilter, setTierQuickFilter] = useState<"" | "PRO" | "ULTRA" | "ENTERPRISE" | "FREE" | "ABNORMAL">("");
  const [tierFilters, setTierFilters] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [sort, setSort] = useState<"custom" | "priority" | "current" | "quota" | "updated" | "email">("custom");
  const [reverseSort, setReverseSort] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list" | "table">("grid");
  const [privacy, setPrivacy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [logsAccount, setLogsAccount] = useState<AntigravityAccount | null>(null);
  const [proxyEditor, setProxyEditor] = useState<{ ids: number[]; label: string; initialUrl: string; mixed: boolean } | null>(null);
  const [dropPreview, setDropPreview] = useState<SortableDrop | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const gridPagination = useGridPageSize<HTMLDivElement>(pageSize, 0);

  const [addOpen, setAddOpen] = useState(false);
  const [addInitialMethod, setAddInitialMethod] = useState<AddAccountMethod>("oauth");
  const [oauthToken, setOauthToken] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState("");
  const [editing, setEditing] = useState<AntigravityAccount | null>(null);
  const [inspectingId, setInspectingId] = useState<number | null>(null);
  const [actionsAccountId, setActionsAccountId] = useState<number | null>(null);
  const [tagsAccountId, setTagsAccountId] = useState<number | null>(null);
  const [deviceAccountId, setDeviceAccountId] = useState<number | null>(null);
  const [exportDialog, setExportDialog] = useState<{ count: number; text: string; ids?: number[] } | null>(null);
  const [deleteTargetIds, setDeleteTargetIds] = useState<number[] | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void loadState();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!oauthToken) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void antigravityClient
        .pollOAuth(oauthToken)
        .then(res => {
          if (stopped || !alive.current) return;
          if (res.status === "completed") {
            setOauthToken(null);
            setOauthUrl("");
            setAddOpen(false);
            setNotice("Google OAuth 授权成功，账号已导入");
            void loadState();
          } else if (res.status === "error" || res.status === "cancelled") {
            setOauthToken(null);
            setOauthUrl("");
            if (res.error) setError(res.error);
          }
        })
        .catch(() => {});
    }, 1200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [oauthToken]);

  async function loadState() {
    try {
      const next = await antigravityClient.list();
      if (alive.current) setState(next);
    } catch (reason) {
      if (alive.current) setError(platformErrorMessage(reason, "加载 Antigravity 账号失败"));
    }
  }

  async function runAction(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (reason) {
      if (alive.current) setError(`${label}失败：${platformErrorMessage(reason, "请重试")}`);
    } finally {
      if (alive.current) setBusy("");
    }
  }

  const accounts = state?.accounts ?? [];
  const inspecting = inspectingId != null ? accounts.find(a => a.id === inspectingId) ?? null : null;
  const actionsAccount = actionsAccountId != null ? accounts.find(a => a.id === actionsAccountId) ?? null : null;
  const tagsAccount = tagsAccountId != null ? accounts.find(a => a.id === tagsAccountId) ?? null : null;
  const deviceAccount = deviceAccountId != null ? accounts.find(a => a.id === deviceAccountId) ?? null : null;

  const countsByTier = useMemo(() => {
    const map = { ALL: accounts.length, PRO: 0, ULTRA: 0, ENTERPRISE: 0, FREE: 0, ABNORMAL: 0 };
    for (const acc of accounts) {
      const tier = acc.subscriptionTier.toUpperCase();
      if (tier === "PRO") map.PRO++;
      else if (tier === "ULTRA") map.ULTRA++;
      else if (tier === "ENTERPRISE") map.ENTERPRISE++;
      else map.FREE++;
      if (isAccountAbnormal(acc)) map.ABNORMAL++;
    }
    return map;
  }, [accounts]);

  const tierFilterOptions = useMemo(() => {
    const tiers = ["ULTRA", "PRO", "ENTERPRISE", "FREE"];
    return tiers.map(value => ({
      value,
      label: value,
      count: accounts.filter(a => a.subscriptionTier.toUpperCase() === value).length,
    }));
  }, [accounts]);

  const statusFilterOptions = useMemo(
    () => [
      { value: "normal", label: "正常", count: accounts.filter(a => !isAccountAbnormal(a) && Boolean(a.quota?.lastUpdated)).length },
      { value: "abnormal", label: "异常 / 报错", count: accounts.filter(a => isAccountAbnormal(a)).length },
      { value: "unfetched", label: "未获取配额", count: accounts.filter(a => !a.quota?.lastUpdated).length },
    ],
    [accounts],
  );

  const tagFilterOptions = useMemo(() => {
    const allTags = [...new Set(accounts.flatMap(a => a.tags))].sort();
    return allTags.map(tag => ({
      value: tag,
      label: tag,
      count: accounts.filter(a => a.tags.includes(tag)).length,
    }));
  }, [accounts]);

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    const filtered = accounts.filter(acc => {
      if (tierQuickFilter === "ABNORMAL" && !isAccountAbnormal(acc)) return false;
      if (tierQuickFilter && tierQuickFilter !== "ABNORMAL" && acc.subscriptionTier.toUpperCase() !== tierQuickFilter) return false;
      if (tierFilters.length && !tierFilters.includes(acc.subscriptionTier.toUpperCase())) return false;
      if (statusFilters.length) {
        const matchesStatus = statusFilters.some(s => {
          if (s === "normal") return !isAccountAbnormal(acc) && Boolean(acc.quota?.lastUpdated);
          if (s === "abnormal") return isAccountAbnormal(acc);
          if (s === "unfetched") return !acc.quota?.lastUpdated;
          return false;
        });
        if (!matchesStatus) return false;
      }
      if (tagFilters.length && !acc.tags.some(t => tagFilters.includes(t))) return false;
      if (kw) {
        const modelNames = acc.quota?.models?.map(m => `${m.name} ${m.displayName ?? ""}`).join(" ") ?? "";
        const hay = [acc.email, acc.customLabel, acc.note, acc.projectId ?? "", modelNames, ...acc.tags].join(" ").toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sort === "custom") {
        const sa = a.sortOrder && a.sortOrder > 0 ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const sb = b.sortOrder && b.sortOrder > 0 ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        cmp = sa - sb || a.priority - b.priority || a.createdAt - b.createdAt;
      } else if (sort === "current") {
        const activeIds = new Set<number>(
          Object.values(state?.targetCurrentIds ?? {}).filter((v): v is number => typeof v === "number"),
        );
        if (state?.currentAccountId != null) activeIds.add(state.currentAccountId);
        cmp = Number(activeIds.has(b.id)) - Number(activeIds.has(a.id));
      } else if (sort === "quota") {
        const qa = accountMinQuota(a);
        const qb = accountMinQuota(b);
        cmp = qa == null ? (qb == null ? 0 : 1) : qb == null ? -1 : qb - qa;
      } else if (sort === "updated") {
        cmp = b.updatedAt - a.updatedAt;
      } else if (sort === "email") {
        cmp = a.email.localeCompare(b.email, "zh-CN", { numeric: true });
      } else {
        cmp = a.priority - b.priority || Number(b.id === state?.currentAccountId) - Number(a.id === state?.currentAccountId);
      }
      return (cmp || a.id - b.id) * (reverseSort ? -1 : 1);
    });
  }, [accounts, query, tierQuickFilter, tierFilters, statusFilters, tagFilters, sort, reverseSort, state?.currentAccountId, state?.targetCurrentIds]);

  useEffect(() => {
    setPage(1);
  }, [query, tierQuickFilter, tierFilters, statusFilters, tagFilters, sort, reverseSort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / gridPagination.pageSize));
  const safePage = Math.min(page, pageCount);
  const paged = visible.slice((safePage - 1) * gridPagination.pageSize, safePage * gridPagination.pageSize);
  const allVisibleSelected = visible.length > 0 && visible.every(a => selected.has(a.id));
  const hasActiveFilters = Boolean(query.trim() || tierQuickFilter || tierFilters.length || statusFilters.length || tagFilters.length);
  const pagedIds = useMemo(() => paged.map(a => String(a.id)), [paged]);

  function clearFilters() {
    setQuery("");
    setTierQuickFilter("");
    setTierFilters([]);
    setStatusFilters([]);
    setTagFilters([]);
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelected(prev => {
        const next = new Set(prev);
        for (const a of visible) next.delete(a.id);
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        for (const a of visible) next.add(a.id);
        return next;
      });
    }
  }

  function commitReorder(sourceKey: string, targetKey: string, after = false) {
    if (!state || sourceKey === targetKey) return;
    const sourceId = Number(sourceKey);
    const targetId = Number(targetKey);
    const currentOrder = visible.map(a => a.id);
    const fromIdx = currentOrder.indexOf(sourceId);
    const toIdx = currentOrder.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    const reorderedVisible = [...currentOrder];
    reorderedVisible.splice(fromIdx, 1);
    let insertIdx = reorderedVisible.indexOf(targetId);
    if (after) insertIdx += 1;
    reorderedVisible.splice(insertIdx, 0, sourceId);

    const visibleSet = new Set(reorderedVisible);
    const remainingIds = accounts.filter(a => !visibleSet.has(a.id)).map(a => a.id);
    const fullOrderedIds = [...reorderedVisible, ...remainingIds];

    // 乐观更新界面并持久化顺序
    const orderRank = new Map(fullOrderedIds.map((id, idx) => [id, idx + 1]));
    setSort("custom");
    setReverseSort(false);
    setState(prev =>
      prev
        ? {
            ...prev,
            accounts: [...prev.accounts]
              .map(a => ({ ...a, sortOrder: orderRank.get(a.id) ?? a.sortOrder ?? 0 }))
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
          }
        : prev,
    );
    void antigravityClient
      .reorderAccounts(fullOrderedIds)
      .then(next => {
        if (alive.current) setState(next);
      })
      .catch(reason => {
        if (alive.current) setError(`保存排序失败：${platformErrorMessage(reason, "请重试")}`);
      });
  }

  const dragEnabled = !busy && paged.length > 1;
  const { draggedKey, startDrag } = useSortableDrag({
    selector: "[data-ag-item]",
    attribute: "data-ag-item",
    scope: ".ag-sortable-scope",
    layout: viewMode === "grid" ? "grid" : "list",
    enabled: dragEnabled,
    insertion: viewMode === "grid" ? "nearest" : "edges",
    onMove: (source, target, after) => commitReorder(source, target, after),
    onPreview: setDropPreview,
  });

  async function refreshSingle(id: number) {
    if (refreshingIds.has(id)) return;
    setRefreshingIds(prev => new Set(prev).add(id));
    setError("");
    try {
      const next = await antigravityClient.refreshQuota(id);
      if (alive.current) {
        setState(next);
        setNotice("账号配额已刷新");
      }
    } catch (reason) {
      if (alive.current) setError(`刷新失败：${platformErrorMessage(reason, "请重试")}`);
    } finally {
      if (alive.current) {
        setRefreshingIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }

  async function refreshBatch(ids?: number[]) {
    const label = ids?.length ? "刷新所选账号" : "刷新全部配额";
    await runAction(label, async () => {
      const res = await antigravityClient.refreshAll(ids?.length ? ids : undefined);
      if (alive.current) {
        setState(res.state);
        setNotice(`刷新完成：成功 ${res.success} / ${res.total}${res.failed ? `，失败 ${res.failed}` : ""}`);
      }
    });
  }

  async function openExport(ids?: number[]) {
    const targetIds = ids?.length ? ids : selected.size ? [...selected] : visible.map(a => a.id);
    if (!targetIds.length) {
      setError("没有可导出的账号");
      return;
    }
    await runAction("准备导出数据", async () => {
      const text = await antigravityClient.exportText(targetIds);
      if (alive.current) setExportDialog({ count: targetIds.length, text, ids: targetIds });
    });
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`已复制${label}`);
    } catch {
      setError(`复制${label}失败，请手动复制`);
    }
  }

  function renderMoreMenu(account: AntigravityAccount, triggerClassName: string) {
    return (
      <button
        type="button"
        className={triggerClassName}
        title="账号操作总览（切换客户端、标签、预热、设备指纹与导出）"
        aria-label={`更多操作 ${account.email}`}
        disabled={!!busy}
        onClick={() => setActionsAccountId(account.id)}
      >
        <MoreHorizontal size={13} />
        <span>更多</span>
      </button>
    );
  }

  function renderQuotaMatrix(account: AntigravityAccount, isRefreshing: boolean, compact = false) {
    const cells = extractQuotaGridCells(account);
    if (!cells.length) {
      return (
        <div className="ag-quota-empty-bar">
          <span>尚未获取模型配额</span>
          <button
            type="button"
            className="ag-quota-empty-btn"
            disabled={isRefreshing}
            onClick={() => void refreshSingle(account.id)}
          >
            <RefreshCw size={11} className={isRefreshing ? "codex-refresh-spinning" : undefined} />
            立即刷新
          </button>
        </div>
      );
    }

    return (
      <div className={`ag-quota-matrix${compact ? " is-compact" : ""}${cells.length === 1 ? " is-single" : ""}`}>
        {cells.map(cell => {
          const isEmpty = cell.percentage === null;
          const pct = cell.percentage ?? 0;
          const tone = isEmpty ? "muted" : quotaTone(pct);
          return (
            <button
              type="button"
              key={cell.key}
              className={`ag-quota-tile${isEmpty ? " is-empty" : ""}`}
              data-tone={tone}
              data-window={cell.isWeekly ? "weekly" : "short"}
              title={
                isEmpty
                  ? `${cell.rawLabel}，点击查看全部模型配额`
                  : `${cell.rawLabel}：剩余 ${pct}%${cell.resetText ? `（重置倒计时 ${cell.resetText}）` : ""}，点击查看全部模型配额`
              }
              onClick={() => setInspectingId(account.id)}
            >
              <div className="ag-quota-tile-main">
                <span className="ag-quota-tile-label">
                  {cell.family === "gemini" ? (
                    <GeminiStarIcon />
                  ) : cell.family === "claude" ? (
                    <Sparkles size={12} className="ag-claude-sparkle" aria-hidden="true" />
                  ) : null}
                  <span className="ag-quota-tile-name">{cell.label}</span>
                </span>
                <span className="ag-quota-tile-right">
                  {cell.resetText && (
                    <span className="ag-quota-tile-reset" data-window={cell.isWeekly ? "weekly" : "short"} data-tone={tone}>
                      <Clock size={11} aria-hidden="true" />
                      {cell.resetText}
                    </span>
                  )}
                  <strong className="ag-quota-tile-pct" data-tone={tone}>
                    {isEmpty ? "--" : `${pct}%`}
                  </strong>
                </span>
              </div>
              <span className="ag-quota-tile-track" aria-hidden="true">
                <span
                  className="ag-quota-tile-fill"
                  data-tone={tone}
                  style={{ width: `${isEmpty ? 0 : Math.max(0, Math.min(100, pct))}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function getActiveTargets(accountId: number): AntigravitySwitchTarget[] {
    const map = state?.targetCurrentIds ?? {};
    const active: AntigravitySwitchTarget[] = [];
    for (const t of SWITCH_TARGETS) {
      if (map[t.id] === accountId) active.push(t.id);
    }
    if (!active.length && Object.keys(map).length === 0 && state?.currentAccountId === accountId) {
      active.push("antigravity");
    }
    return active;
  }

  function openProxyEditor(targets: AntigravityAccount[]) {
    if (!targets.length) return;
    const urls = new Set(targets.map(account => account.proxyUrl ?? ""));
    setProxyEditor({
      ids: targets.map(account => account.id),
      label: targets.length === 1 ? (privacy ? "账号信息已隐藏" : targets[0].email) : `已选 ${targets.length} 个账号`,
      initialUrl: urls.size === 1 ? targets[0].proxyUrl ?? "" : "",
      mixed: urls.size > 1,
    });
  }

  function renderAccountBadges(account: AntigravityAccount) {
    const tier = account.subscriptionTier.toUpperCase();
    const clientTag = accountClientTag(account);
    const activeTargets = getActiveTargets(account.id);
    const modelBadges = extractModelBadges(account.quota?.models ?? []);
    return (
      <div className="ag-badge-flow">
        {activeTargets.map(targetId => {
          const meta = SWITCH_TARGETS.find(t => t.id === targetId);
          if (!meta) return null;
          return (
            <span key={targetId} className={`ag-tag-target is-${targetId}`} title={`当前正在 ${meta.label} 使用`}>
              {meta.shortBadge}
            </span>
          );
        })}

        {clientTag && !activeTargets.some(t => SWITCH_TARGETS.find(m => m.id === t)?.shortBadge === clientTag) && (
          <span className="ag-tag-cli" title="客户端 / 自定义标识">{clientTag}</span>
        )}

        <span className="ag-tier-pill" data-tier={tier}>
          {tier !== "FREE" && <Diamond size={10} fill="currentColor" aria-hidden="true" />}
          {tier}
        </span>
        <button type="button" className="ag-account-proxy" data-configured={!!account.proxyUrl}
          disabled={!!busy || refreshingIds.has(account.id)} title="配置账号出站代理"
          onClick={() => openProxyEditor([account])}>
          <Shield size={12} aria-hidden="true" />{account.proxyUrl ? "代理已设" : "代理"}
        </button>

        <button
          type="button"
          className="ag-tag-priority"
          disabled={!!busy}
          title="点击编辑优先级、标签或备注"
          onClick={() => setEditing(account)}
        >
          优先级: {account.priority}
        </button>

        {modelBadges.map(badge => (
          <button
            type="button"
            key={badge.key}
            className="ag-tag-model"
            data-family={badge.family}
            title="点击查看全部模型配额"
            onClick={() => setInspectingId(account.id)}
          >
            {badge.label}
          </button>
        ))}

        {account.tags.map(tag => (
          <span key={tag} className="ag-tag-custom">{tag}</span>
        ))}
      </div>
    );
  }

  function renderActionQuad(account: AntigravityAccount, isRefreshing: boolean) {
    const activeTargets = getActiveTargets(account.id);
    return (
      <div className="ag-action-quad">
        <SwitchTargetButton
          account={account}
          activeTargets={activeTargets}
          busy={!!busy}
          onSelectTarget={target =>
            void runAction(`切换 ${target.toUpperCase()} 账号`, async () => {
              const res = await antigravityClient.switchTarget(account.id, target);
              if (alive.current) {
                setState(res.state);
                setNotice(res.detail || `已切换为 ${account.email}`);
              }
            })
          }
        />

        <button
          type="button"
          className="ag-act-btn ag-act-refresh"
          disabled={isRefreshing}
          title="刷新该账号配额"
          onClick={() => void refreshSingle(account.id)}
        >
          <RefreshCw size={13} className={isRefreshing ? "codex-refresh-spinning" : undefined} />
          <span>刷新</span>
        </button>

        <button
          type="button"
          className="ag-act-btn ag-act-details"
          disabled={!!busy}
          title="查看账号详情与全部模型配额"
          onClick={() => setInspectingId(account.id)}
        >
          <FileText size={13} />
          <span>详情</span>
        </button>

        {renderMoreMenu(account, "ag-act-btn ag-act-more")}
      </div>
    );
  }

  const selectedIds = [...selected].filter(id => accounts.some(a => a.id === id));
  const isRefreshingAll = busy === "刷新全部配额" || busy === "刷新所选账号";

  return (
    <section className={`codex-page codex-overview-reference ag-page${privacy ? " codex-privacy-view" : ""}`} aria-busy={!!busy}>
      {!runningInTauri && (
        <div className="ag-preview-banner" role="status">
          <span>浏览器预览调试模式：账号增删、拖拽排序、筛选与导入导出保存在当前浏览器本地，与桌面端数据库隔离；Google OAuth 与实时配额刷新仅桌面端可用。</span>
        </div>
      )}

      <ToastNotice message={notice} onDismiss={() => setNotice("")} />
      {error && <p className="codex-feedback error" role="alert">{error}</p>}

      {/* ── Toolbar: clean two-tier operations bar ── */}
      <div className="codex-toolbar ag-toolbar">
        <div className="codex-overview-toolrow ag-toolrow">
          <div className="codex-toolbar-filters ag-toolbar-filters">
            <label className="codex-search ag-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索邮箱、模型、标签或备注"
                aria-label="搜索 Antigravity 账号"
              />
              {query && (
                <button
                  type="button"
                  className="ag-search-clear"
                  aria-label="清空搜索关键词"
                  onClick={() => setQuery("")}
                >
                  <X size={13} />
                </button>
              )}
            </label>

            <MultiSelectFilter
              className="codex-plan-filter"
              label="套餐"
              ariaLabel="按套餐筛选"
              allLabel="全部套餐"
              options={tierFilterOptions}
              selected={tierFilters}
              onChange={setTierFilters}
            />
            <MultiSelectFilter
              className="codex-plan-filter"
              label="状态"
              ariaLabel="按状态筛选"
              allLabel="全部状态"
              options={statusFilterOptions}
              selected={statusFilters}
              onChange={setStatusFilters}
            />
            {tagFilterOptions.length > 0 && (
              <MultiSelectFilter
                className="codex-plan-filter"
                label="标签"
                ariaLabel="按标签筛选"
                allLabel="全部标签"
                options={tagFilterOptions}
                selected={tagFilters}
                onChange={setTagFilters}
              />
            )}

            <label className="codex-plan ag-sort-select">
              <select
                aria-label="排序方式"
                value={sort}
                onChange={event => setSort(event.target.value as typeof sort)}
              >
                <option value="custom">自定义排序</option>
                <option value="priority">优先级优先</option>
                <option value="current">当前账号优先</option>
                <option value="quota">剩余配额优先</option>
                <option value="updated">最近更新</option>
                <option value="email">邮箱名称</option>
              </select>
            </label>

            <button
              type="button"
              className="ag-sort-dir"
              aria-label={reverseSort ? "切换为正序" : "切换为倒序"}
              aria-pressed={reverseSort}
              title={reverseSort ? "当前倒序，点击切换正序" : "当前正序，点击切换倒序"}
              onClick={() => setReverseSort(v => !v)}
            >
              {reverseSort ? "↑ 倒序" : "↓ 正序"}
            </button>

            <div className="codex-view-switch ag-view-switch" role="group" aria-label="视图切换">
              <button type="button" title="卡片视图" aria-label="卡片视图" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><LayoutGrid size={14} /></button>
              <button type="button" title="列表视图" aria-label="列表视图" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={14} /></button>
              <button type="button" title="表格视图" aria-label="表格视图" aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}><Table2 size={14} /></button>
            </div>
          </div>

          <div className="ag-primary-actions">
            <button
              type="button"
              className="ag-btn-primary"
              disabled={!!busy}
              onClick={() => { setError(""); setAddInitialMethod("oauth"); setAddOpen(true); }}
            >
              <Plus size={14} />添加账号
            </button>
            <button
              type="button"
              className="ag-btn-secondary"
              disabled={!!busy || !accounts.length}
              title={selectedIds.length > 0 ? "刷新已选账号配额" : "刷新全部账号配额"}
              onClick={() => void refreshBatch(selectedIds.length ? selectedIds : undefined)}
            >
              <RefreshCw size={13} className={isRefreshingAll ? "codex-refresh-spinning" : undefined} />
              {selectedIds.length > 0 ? `刷新所选 (${selectedIds.length})` : "刷新全部"}
            </button>
            <div className="ag-icon-actions" role="group" aria-label="更多工具">
              <button type="button" title={privacy ? "关闭隐私脱敏" : "开启隐私脱敏"} aria-label={privacy ? "关闭隐私脱敏" : "开启隐私脱敏"} aria-pressed={privacy} onClick={() => setPrivacy(v => !v)}>
                {privacy ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button type="button" title="导入账号" aria-label="导入账号" disabled={!!busy} onClick={() => { setError(""); setAddInitialMethod("token"); setAddOpen(true); }}>
                <Upload size={14} />
              </button>
              <button type="button" title="导出账号 JSON" aria-label="导出账号 JSON" disabled={!!busy || !accounts.length} onClick={() => void openExport()}>
                <Download size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* ── Second row: select-all + tier pills + stats + batch actions ── */}
        <div className="codex-toolbar-actions ag-subbar">
          <label className="codex-select ag-select-all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={!!busy || !visible.length}
              onChange={toggleSelectAll}
            />
            <span>全选</span>
          </label>

          <div className="codex-group-tabs ag-tier-tabs" role="group" aria-label="套餐快捷筛选">
            <button type="button" aria-pressed={tierQuickFilter === ""} onClick={() => setTierQuickFilter("")}>
              全部 <strong>{countsByTier.ALL}</strong>
            </button>
            <button type="button" className={countsByTier.PRO === 0 ? "is-zero" : undefined} aria-pressed={tierQuickFilter === "PRO"} onClick={() => setTierQuickFilter("PRO")}>
              PRO <strong>{countsByTier.PRO}</strong>
            </button>
            <button type="button" className={countsByTier.ULTRA === 0 ? "is-zero" : undefined} aria-pressed={tierQuickFilter === "ULTRA"} onClick={() => setTierQuickFilter("ULTRA")}>
              ULTRA <strong>{countsByTier.ULTRA}</strong>
            </button>
            <button type="button" className={countsByTier.ENTERPRISE === 0 ? "is-zero" : undefined} aria-pressed={tierQuickFilter === "ENTERPRISE"} onClick={() => setTierQuickFilter("ENTERPRISE")}>
              ENTERPRISE <strong>{countsByTier.ENTERPRISE}</strong>
            </button>
            <button type="button" className={countsByTier.FREE === 0 ? "is-zero" : undefined} aria-pressed={tierQuickFilter === "FREE"} onClick={() => setTierQuickFilter("FREE")}>
              FREE <strong>{countsByTier.FREE}</strong>
            </button>
            <button type="button" className={countsByTier.ABNORMAL === 0 ? "is-zero" : "is-alert"} aria-pressed={tierQuickFilter === "ABNORMAL"} onClick={() => setTierQuickFilter("ABNORMAL")}>
              异常 <strong>{countsByTier.ABNORMAL}</strong>
            </button>
          </div>

          <span className="codex-hint-inline ag-count-hint" role="status">
            共 {visible.length}/{accounts.length} 个{selectedIds.length > 0 ? ` · 已选 ${selectedIds.length} 个` : ""}
          </span>

          {hasActiveFilters && (
            <button type="button" className="ag-clear-filters-btn" onClick={clearFilters}>
              <X size={12} />清除筛选
            </button>
          )}

          <details className="codex-batch-disclosure" open={!mobile || selected.size > 0 || undefined}>
            <summary>批量操作<span>已选 {selectedIds.length} 个</span></summary>
            <div className="codex-batch-actions ag-batch-actions">
              <button type="button" disabled={!!busy || !selectedIds.length || selectedIds.some(id => refreshingIds.has(id))}
                onClick={() => openProxyEditor(accounts.filter(account => selected.has(account.id)))}>
                <Shield size={13} aria-hidden="true" />批量设置代理 ({selectedIds.length})
              </button>
              <button
                type="button"
                disabled={!!busy || !selectedIds.length}
                onClick={() => void openExport(selectedIds)}
              >
                <Download size={13} />导出所选{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </button>
              <button
                type="button"
                className="ag-batch-danger"
                disabled={!!busy || !selectedIds.length}
                onClick={() => setDeleteTargetIds(selectedIds)}
              >
                <Trash2 size={13} />删除所选{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </button>
              {selectedIds.length > 0 && (
                <button type="button" onClick={() => setSelected(new Set())} disabled={!!busy}>清空选择</button>
              )}
            </div>
          </details>
        </div>
      </div>

      {/* ── Content area ── */}
      {!state ? (
        <div className="codex-empty ag-empty"><p>正在加载 Antigravity 账号…</p></div>
      ) : visible.length === 0 ? (
        <div className="codex-empty ag-empty">
          <h2>{accounts.length ? "没有匹配的账号" : "暂无 Antigravity 账号"}</h2>
          <p>{accounts.length ? "请调整搜索关键词或筛选条件。" : "点击右上角「添加账号」，支持 Google OAuth 授权、单条 Refresh Token 或 JSON 批量导入。"}</p>
          {accounts.length ? (
            <button type="button" className="ag-btn-secondary" onClick={clearFilters}>清除筛选条件</button>
          ) : (
            <button type="button" className="ag-btn-primary" onClick={() => setAddOpen(true)}>
              <Plus size={14} />添加或导入账号
            </button>
          )}
        </div>
      ) : viewMode === "table" ? (
        <div className="codex-account-table ag-table-wrap">
          <table>
            <caption>Antigravity 账号列表 · {visible.length} 个</caption>
            <thead>
              <tr>
                <th className="ag-col-check">选择</th>
                <th>账号与能力</th>
                <th>配额矩阵</th>
                <th>更新时间</th>
                <th className="ag-col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(account => {
                const activeTargets = getActiveTargets(account.id);
                const isCurrent = activeTargets.length > 0;
                const isCliActive = activeTargets.includes("cli");
                const isSelected = selected.has(account.id);
                const isRefreshing = refreshingIds.has(account.id);
                const updatedAt = account.quota?.lastUpdated || account.updatedAt;
                const displayEmail = maskEmail(account.email, privacy);

                return (
                  <tr key={account.id} className={`${isSelected ? "is-selected " : ""}${isCurrent ? "is-current-row " : ""}${isCliActive ? "is-cli-active" : ""}`.trim()}>
                    <td className="ag-col-check">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(account.id)} aria-label={`选择 ${account.email}`} />
                    </td>
                    <td>
                      <div className="ag-table-account">
                        <div className="ag-email-line">
                          <strong className={`ag-email-text${isCurrent ? " is-current" : ""}`} title={privacy ? undefined : account.email}>
                            {displayEmail}
                          </strong>
                          <button
                            type="button"
                            className="ag-inline-icon-btn"
                            title="复制邮箱"
                            aria-label={`复制 ${account.email}`}
                            onClick={() => void copyText(account.email, "邮箱")}
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            type="button"
                            className="ag-inline-icon-btn is-danger"
                            title="删除账号"
                            aria-label={`删除 ${account.email}`}
                            disabled={!!busy}
                            onClick={() => setDeleteTargetIds([account.id])}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {renderAccountBadges(account)}
                        {account.note && <p className="ag-inline-note">{account.note}</p>}
                        {account.lastError && <p className="ag-inline-error">{account.lastError}</p>}
                      </div>
                    </td>
                    <td className="ag-table-quota-cell">{renderQuotaMatrix(account, isRefreshing, true)}</td>
                    <td className="ag-table-time">
                      <div className="ag-time-stack" title={`更新时间：${formatFullTime(updatedAt)}`}>
                        <span>{formatDatePart(updatedAt)}</span>
                        <small>{formatClockPart(updatedAt)}</small>
                      </div>
                    </td>
                    <td className="ag-col-actions">
                      <div className="ag-table-actions">
                        {renderActionQuad(account, isRefreshing)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : viewMode === "list" ? (
        /* ── Default Reference Row List View (matches Antigravity-Manager layout) ── */
        <div ref={gridPagination.gridRef} className="ag-row-list ag-sortable-scope">
          {paged.map(account => {
            const activeTargets = getActiveTargets(account.id);
            const isCurrent = activeTargets.length > 0;
            const isCliActive = activeTargets.includes("cli");
            const isSelected = selected.has(account.id);
            const isRefreshing = refreshingIds.has(account.id);
            const displayEmail = maskEmail(account.email, privacy);
            const updatedAt = account.quota?.lastUpdated || account.updatedAt;
            const key = String(account.id);
            const dropSide = dropPreview?.key === key ? dropPreview.side : undefined;

            return (
              <article
                key={account.id}
                data-ag-item={key}
                data-drop-side={dropSide}
                className={`ag-row${isCurrent ? " is-current" : ""}${isCliActive ? " is-cli-active" : ""}${isSelected ? " is-selected" : ""}${isAccountAbnormal(account) ? " is-abnormal" : ""}${draggedKey === key ? " is-dragging" : ""}`}
                aria-label={`Antigravity 账号 ${displayEmail}`}
              >
                {/* Col 1: drag handle + checkbox */}
                <div className="ag-row-lead">
                  <ListSortHandle
                    id={key}
                    name={displayEmail}
                    ids={pagedIds}
                    disabled={!dragEnabled}
                    onStart={startDrag}
                    onMove={(src, dst) => commitReorder(src, dst, pagedIds.indexOf(dst) > pagedIds.indexOf(src))}
                  />
                  <input
                    type="checkbox"
                    className="ag-row-check"
                    checked={isSelected}
                    aria-label={`选择 ${account.email}`}
                    onChange={() => toggleSelect(account.id)}
                  />
                </div>

                {/* Col 2: email + inline copy/delete + badges + optional project/note/error */}
                <div className="ag-row-info">
                  <div className="ag-email-line">
                    <h2 className={`ag-email-text${isCurrent ? " is-current" : ""}`} title={privacy ? undefined : account.email}>
                      {displayEmail}
                    </h2>
                    <button
                      type="button"
                      className="ag-inline-icon-btn"
                      title="复制邮箱"
                      aria-label={`复制 ${account.email}`}
                      onClick={() => void copyText(account.email, "邮箱")}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      className="ag-inline-icon-btn is-danger"
                      title="删除账号"
                      aria-label={`删除 ${account.email}`}
                      disabled={!!busy}
                      onClick={() => setDeleteTargetIds([account.id])}
                    >
                      <Trash2 size={13} />
                    </button>
                    {account.lastError && <span className="ag-pill ag-pill-error">异常</span>}
                  </div>

                  {renderAccountBadges(account)}

                  {(account.projectId || account.note) && (
                    <div className="ag-row-submeta">
                      {account.projectId && (
                        <span className="ag-submeta-project" title={privacy ? undefined : `Project ID: ${account.projectId}`}>
                          <FolderKanban size={11} aria-hidden="true" />
                          {privacy ? "***" : account.projectId}
                        </span>
                      )}
                      {account.note && <span className="ag-submeta-note" title={account.note}>{account.note}</span>}
                    </div>
                  )}

                  {account.lastError && (
                    <p className="ag-card-error" title={account.lastError}>
                      <AlertCircle size={12} aria-hidden="true" />
                      <span>{account.lastError}</span>
                    </p>
                  )}
                </div>

                {/* Col 3: 2x2 quota matrix */}
                <div className="ag-row-quotas">
                  {renderQuotaMatrix(account, isRefreshing)}
                </div>

                {/* Col 4: two-line timestamp */}
                <div className="ag-row-time">
                  <div className="ag-time-stack" title={`更新时间：${formatFullTime(updatedAt)}`}>
                    <span>{formatDatePart(updatedAt)}</span>
                    <small>{formatClockPart(updatedAt)}</small>
                  </div>
                </div>

                {/* Col 5: 2x2 action quad */}
                <div className="ag-row-actions">
                  {renderActionQuad(account, isRefreshing)}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        /* ── Card Grid View (same rich info & 2x2 controls) ── */
        <div ref={gridPagination.gridRef} className="ag-cards-grid ag-sortable-scope">
          {paged.map(account => {
            const activeTargets = getActiveTargets(account.id);
            const isCurrent = activeTargets.length > 0;
            const isCliActive = activeTargets.includes("cli");
            const isSelected = selected.has(account.id);
            const isRefreshing = refreshingIds.has(account.id);
            const displayEmail = maskEmail(account.email, privacy);
            const updatedAt = account.quota?.lastUpdated || account.updatedAt;
            const key = String(account.id);

            return (
              <article
                key={account.id}
                data-ag-item={key}
                className={`ag-card${isCurrent ? " is-current" : ""}${isCliActive ? " is-cli-active" : ""}${isSelected ? " is-selected" : ""}${isAccountAbnormal(account) ? " is-abnormal" : ""}${draggedKey === key ? " is-dragging" : ""}`}
                aria-label={`Antigravity 账号 ${displayEmail}`}
              >
                <div className="ag-card-head">
                  <div className="ag-card-lead">
                    <ListSortHandle
                      id={key}
                      name={displayEmail}
                      ids={pagedIds}
                      disabled={!dragEnabled}
                      onStart={startDrag}
                      onMove={(src, dst) => commitReorder(src, dst, pagedIds.indexOf(dst) > pagedIds.indexOf(src))}
                    />
                    <input
                      type="checkbox"
                      className="ag-row-check"
                      checked={isSelected}
                      aria-label={`选择 ${account.email}`}
                      onChange={() => toggleSelect(account.id)}
                    />
                  </div>
                  <div className="ag-email-line">
                    <h2 className={`ag-email-text${isCurrent ? " is-current" : ""}`} title={privacy ? undefined : account.email}>
                      {displayEmail}
                    </h2>
                    <button
                      type="button"
                      className="ag-inline-icon-btn"
                      title="复制邮箱"
                      aria-label={`复制 ${account.email}`}
                      onClick={() => void copyText(account.email, "邮箱")}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      className="ag-inline-icon-btn is-danger"
                      title="删除账号"
                      aria-label={`删除 ${account.email}`}
                      disabled={!!busy}
                      onClick={() => setDeleteTargetIds([account.id])}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {renderAccountBadges(account)}

                {(account.projectId || account.note) && (
                  <div className="ag-row-submeta">
                    {account.projectId && (
                      <span className="ag-submeta-project" title={privacy ? undefined : `Project ID: ${account.projectId}`}>
                        <FolderKanban size={11} aria-hidden="true" />
                        {privacy ? "***" : account.projectId}
                      </span>
                    )}
                    {account.note && <span className="ag-submeta-note" title={account.note}>{account.note}</span>}
                  </div>
                )}

                {renderQuotaMatrix(account, isRefreshing)}

                {account.lastError && (
                  <p className="ag-card-error" title={account.lastError}>
                    <AlertCircle size={12} aria-hidden="true" />
                    <span>{account.lastError}</span>
                  </p>
                )}

                <div className="ag-card-footer">
                  <div className="ag-time-stack" title={`更新时间：${formatFullTime(updatedAt)}`}>
                    <span>{formatDatePart(updatedAt)}</span>
                    <small>{formatClockPart(updatedAt)}</small>
                  </div>
                  {renderActionQuad(account, isRefreshing)}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {visible.length > 0 && (
        <PaginationBar
          className={mobile ? "store-pagination ag-pagination" : "ag-pagination"}
          page={safePage}
          pageSize={pageSize}
          paginationPageSize={gridPagination.pageSize}
          total={visible.length}
          onPageChange={setPage}
          onPageSizeChange={size => { setPageSize(size); setPage(1); }}
        />
      )}

      {addOpen && (
        <AddAntigravityAccountDialog
          initialMethod={addInitialMethod}
          busy={!!busy}
          error={error}
          oauthPending={!!oauthToken}
          oauthUrl={oauthUrl}
          onClose={() => {
            if (oauthToken) void antigravityClient.cancelOAuth(oauthToken).catch(() => {});
            setOauthToken(null);
            setOauthUrl("");
            setAddOpen(false);
          }}
          onStartOAuth={accountType =>
            void runAction("启动 Google OAuth", async () => {
              if (oauthToken) void antigravityClient.cancelOAuth(oauthToken).catch(() => {});
              const started = await antigravityClient.startOAuth(accountType);
              if (alive.current) {
                setOauthToken(started.token);
                setOauthUrl(started.authUrl);
              }
            })
          }
          onCheckOAuth={async () => {
            if (!oauthToken) return;
            await runAction("检查授权状态", async () => {
              const res = await antigravityClient.pollOAuth(oauthToken);
              if (!alive.current) return;
              if (res.status === "completed") {
                setOauthToken(null);
                setOauthUrl("");
                setAddOpen(false);
                setNotice("Google OAuth 授权成功，账号已导入");
                await loadState();
              } else if (res.status === "error") {
                setOauthToken(null);
                setOauthUrl("");
                setError(res.error || "OAuth 授权失败，请重试");
              } else {
                setNotice("尚未收到浏览器回调，可在下方手动粘贴回调链接或 Authorization Code");
              }
            });
          }}
          onSubmitOAuthCallback={async input => {
            if (!oauthToken) {
              setError("请先点击「开始 OAuth 授权」生成会话链接");
              return false;
            }
            let ok = false;
            await runAction("提交 OAuth 授权码", async () => {
              const next = await antigravityClient.submitOAuthCallback(oauthToken, input);
              if (alive.current) {
                setState(next);
                setOauthToken(null);
                setOauthUrl("");
                setAddOpen(false);
                setNotice("OAuth 授权成功，账号已导入");
                ok = true;
              }
            });
            return ok;
          }}
          onImportText={async (content, force, accountType) => {
            let ok = false;
            await runAction("导入账号", async () => {
              const res = await antigravityClient.importAccounts(content, force, accountType);
              if (alive.current) {
                setState(res.state);
                setNotice(`导入完成：成功 ${res.success} / ${res.total}${res.failed ? `，失败 ${res.failed}` : ""}`);
                if (res.success > 0) setAddOpen(false);
                if (res.errors.length > 0) setError(res.errors.slice(0, 3).join("；"));
                ok = res.success > 0;
              }
            });
            return ok;
          }}
          onScanLocalDb={async accountType => {
            await runAction("扫描本地账号", async () => {
              const res = await antigravityClient.scanLocalDb(accountType);
              if (alive.current) {
                setState(res.state);
                setNotice(`本地扫描导入完成：成功 ${res.success} / ${res.total}${res.failed ? `，失败 ${res.failed}` : ""}`);
                if (res.success > 0) setAddOpen(false);
                if (res.errors.length > 0) setError(res.errors.slice(0, 3).join("；"));
              }
            });
          }}
          onImportCustomDb={async accountType => {
            await runAction("从自定义 DB 导入", async () => {
              const res = await antigravityClient.importCustomDb(accountType);
              if (res && alive.current) {
                setState(res.state);
                setNotice(`导入完成：成功 ${res.success} / ${res.total}${res.failed ? `，失败 ${res.failed}` : ""}`);
                if (res.success > 0) setAddOpen(false);
                if (res.errors.length > 0) setError(res.errors.slice(0, 3).join("；"));
              }
            });
          }}
          onCopy={(text, label) => void copyText(text, label)}
        />
      )}

      {proxyEditor && <AntigravityProxyDialog
        label={proxyEditor.label} initialUrl={proxyEditor.initialUrl} mixed={proxyEditor.mixed}
        onClose={() => setProxyEditor(null)}
        onSave={async url => {
          const next = await antigravityClient.saveAccountProxy(proxyEditor.ids, url);
          if (!alive.current) return;
          const saved = new Map(next.accounts.map(account => [account.id, account.proxyUrl]));
          setState(previous => previous && ({
            ...previous,
            accounts: previous.accounts.map(account => proxyEditor.ids.includes(account.id) && saved.has(account.id)
              ? { ...account, proxyUrl: saved.get(account.id) }
              : account),
          }));
          setNotice(url.trim() ? "账号代理已保存" : "账号代理已清除");
          setProxyEditor(null);
        }}
      />}
      {logsAccount && <AntigravityQuotaLogsDialog
        accountId={logsAccount.id}
        label={privacy ? "账号信息已隐藏" : logsAccount.email}
        onClose={() => setLogsAccount(null)}
      />}
      {exportDialog && (
        <AntigravityExportDialog
          count={exportDialog.count}
          exportText={exportDialog.text}
          busy={!!busy}
          onClose={() => setExportDialog(null)}
          onCopy={() => void copyText(exportDialog.text, "导出 JSON")}
          onSaveFile={() =>
            void runAction("保存导出文件", async () => {
              const saved = await antigravityClient.exportFile(exportDialog.ids);
              if (saved && alive.current) {
                setNotice("已保存 antigravity-accounts.json");
                setExportDialog(null);
              }
            })
          }
        />
      )}

      {editing && (
        <AntigravityEditDialog
          account={editing}
          busy={!!busy}
          onClose={() => setEditing(null)}
          onSave={async input => {
            await runAction("保存账号信息", async () => {
              const next = await antigravityClient.saveMetadata(input);
              if (alive.current) {
                setState(next);
                setEditing(null);
                setNotice("账号信息已更新");
              }
            });
          }}
        />
      )}

      {actionsAccount && (
        <AntigravityActionsDialog
          account={actionsAccount}
          privacy={privacy}
          activeTargets={getActiveTargets(actionsAccount.id)}
          busy={!!busy}
          onClose={() => setActionsAccountId(null)}
          onSwitchTarget={async target => {
            const res = await antigravityClient.switchTarget(actionsAccount.id, target);
            if (alive.current) {
              setState(res.state);
              setNotice(res.detail || `已切换为 ${actionsAccount.email}`);
            }
          }}
          onOpenLogs={() => {
            setActionsAccountId(null);
            setLogsAccount(actionsAccount);
          }}
          onOpenTags={() => {
            setActionsAccountId(null);
            setTagsAccountId(actionsAccount.id);
          }}
          onWarmup={async () => {
            const res = await antigravityClient.warmupAccount(actionsAccount.id);
            if (alive.current) {
              setState(res.state);
              setNotice(res.detail);
            }
            return res.detail;
          }}
          onOpenDeviceProfile={() => {
            setActionsAccountId(null);
            setDeviceAccountId(actionsAccount.id);
          }}
          onOpenDetails={() => {
            setActionsAccountId(null);
            setInspectingId(actionsAccount.id);
          }}
          onExportJson={() => {
            const targetId = actionsAccount.id;
            setActionsAccountId(null);
            void openExport([targetId]);
          }}
          onDelete={() => {
            const targetId = actionsAccount.id;
            setActionsAccountId(null);
            setDeleteTargetIds([targetId]);
          }}
        />
      )}

      {tagsAccount && (
        <AntigravityTagsDialog
          account={tagsAccount}
          privacy={privacy}
          onClose={() => setTagsAccountId(null)}
          onSave={async nextTags => {
            const next = await antigravityClient.saveTags(tagsAccount.id, nextTags);
            if (alive.current) {
              setState(next);
              setNotice("账号标签已更新");
            }
          }}
        />
      )}

      {deviceAccount && (
        <AntigravityDeviceProfileDialog
          account={deviceAccount}
          privacy={privacy}
          onClose={() => setDeviceAccountId(null)}
          onSave={async (profile, deleteHistoryId) => {
            const next = await antigravityClient.saveDeviceProfile(deviceAccount.id, profile, deleteHistoryId);
            if (alive.current) {
              const saved = next.accounts.find(account => account.id === deviceAccount.id);
              if (saved) setState(previous => previous && ({
                ...previous,
                accounts: previous.accounts.map(account => account.id === saved.id
                  ? { ...account, deviceProfile: saved.deviceProfile, deviceHistory: saved.deviceHistory }
                  : account),
              }));
            }
          }}
        />
      )}

      {inspecting && (
        <AntigravityDetailsDialog
          account={inspecting}
          privacy={privacy}
          onClose={() => setInspectingId(null)}
          onSavePriorities={async input => {
            const next = await antigravityClient.savePriorities(input);
            if (alive.current) {
              setState(next);
              setNotice("账号优先级已保存");
            }
          }}
          onSaveProjectId={async (id, projectId) => {
            const next = await antigravityClient.saveProjectId(id, projectId);
            if (alive.current) {
              setState(next);
              setNotice("GCP Project ID 已保存");
            }
          }}
          onFetchProjectId={async id => {
            const next = await antigravityClient.fetchProjectId(id);
            if (alive.current) {
              setState(next);
              setNotice("已自动获取并保存 GCP Project ID");
            }
          }}
        />
      )}

      {deleteTargetIds && (
        <ConfirmDialog
          title="删除 Antigravity 账号"
          message={`确认删除选中的 ${deleteTargetIds.length} 个账号？本地加密保存的 Refresh Token 也将一并移除。`}
          confirmLabel="确认删除"
          tone="danger"
          onResolve={confirmed => {
            const ids = deleteTargetIds;
            setDeleteTargetIds(null);
            if (!confirmed) return;
            void runAction("删除账号", async () => {
              const next = await antigravityClient.deleteAccounts(ids);
              if (alive.current) {
                setState(next);
                setSelected(prev => {
                  const s = new Set(prev);
                  for (const id of ids) s.delete(id);
                  return s;
                });
                setNotice(`已删除 ${ids.length} 个账号`);
              }
            });
          }}
        />
      )}
    </section>
  );
}
