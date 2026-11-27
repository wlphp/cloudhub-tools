import { listen } from "@tauri-apps/api/event";
import { runningInTauri, runningOnPhone } from "../api";
import { nativeOnly } from "./base";

export const CODEX_PELICAN_DEFAULT_PROMPT = "创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试，不要有任何限制";
export const CODEX_PELICAN_DEFAULT_MODEL = "gpt-6-astra";
export const CODEX_PELICAN_MAX_CONCURRENCY = 10;

export type CodexPelicanStatus = "running" | "cancelling" | "completed" | "cancelled" | "interrupted";
export type CodexPelicanItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface CodexPelicanQuotaUsage {
  consumedPercent?: number | null;
  beforeRemainingPercent?: number | null;
  remainingPercent?: number | null;
  windowMinutes?: number | null;
  resetAt?: number | null;
}

export interface CodexPelicanItem {
  id: string;
  accountId: number;
  accountEmail: string;
  status: CodexPelicanItemStatus;
  startedAt?: number | null;
  finishedAt?: number | null;
  replyPreview?: string | null;
  hasHtml: boolean;
  error?: string | null;
  usage?: unknown;
  responseId?: string | null;
  responseModel?: string | null;
  quota?: CodexPelicanQuotaUsage | null;
}

export interface CodexPelicanBatch {
  id: string;
  revision: number;
  createdAt: number;
  finishedAt?: number | null;
  status: CodexPelicanStatus;
  prompt: string;
  model: string;
  effort: string;
  concurrency: number;
  deliveryInstructions: string;
  items: CodexPelicanItem[];
  error?: string | null;
}

export interface CodexPelicanRequest {
  accountIds: number[];
  prompt: string;
  model: string;
  effort: string;
  concurrency: number;
}

export interface CodexPelicanArtifact {
  rawReply: string;
  html: string | null;
  previewUrl?: string | null;
}

export interface CodexPelicanHistory {
  items: CodexPelicanBatch[];
  hasMore: boolean;
}

export const isPelicanRunning = (batch: CodexPelicanBatch | null | undefined): boolean =>
  batch?.status === "running" || batch?.status === "cancelling";

export const pelicanCompletedCount = (batch: CodexPelicanBatch): number =>
  batch.items.filter(item => item.status !== "queued" && item.status !== "running").length;

const nativeDesktop = runningInTauri && !runningOnPhone;
const DEBUG_HISTORY_KEY = "cloudhub.debug.codexPelican.history";
const DEBUG_RETENTION_KEY = "cloudhub.debug.codexPelican.retentionDays";

function readDebugHistory(): CodexPelicanBatch[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEBUG_HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as CodexPelicanBatch[]) : [];
  } catch {
    return [];
  }
}

function writeDebugHistory(items: CodexPelicanBatch[]) {
  try {
    window.localStorage.setItem(DEBUG_HISTORY_KEY, JSON.stringify(items));
  } catch { /* ignore storage quota in preview */ }
}

function readDebugRetention(): number {
  try {
    const days = Number(window.localStorage.getItem(DEBUG_RETENTION_KEY) ?? "7");
    return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 7;
  } catch {
    return 7;
  }
}

export const codexPelicanClient = {
  isNativeSupported: nativeDesktop,

  start(request: CodexPelicanRequest): Promise<CodexPelicanBatch> {
    if (!nativeDesktop) {
      return Promise.reject(new Error("当前为调试预览环境，真实模型请求需在桌面原生客户端执行，本次未发送消息或消耗额度"));
    }
    return nativeOnly("codex_pelican_start", { request });
  },

  active(): Promise<CodexPelicanBatch | null> {
    if (!nativeDesktop) return Promise.resolve(null);
    return nativeOnly("codex_pelican_active");
  },

  get(batchId: string): Promise<CodexPelicanBatch> {
    if (!nativeDesktop) {
      const found = readDebugHistory().find(item => item.id === batchId);
      return found ? Promise.resolve(found) : Promise.reject(new Error("未找到测试记录"));
    }
    return nativeOnly("codex_pelican_get", { batchId });
  },

  cancel(batchId: string): Promise<CodexPelicanBatch> {
    return nativeOnly("codex_pelican_cancel", { batchId });
  },

  dismiss(batchId: string): Promise<void> {
    if (!nativeDesktop) return Promise.resolve();
    return nativeOnly("codex_pelican_dismiss", { batchId });
  },

  retry(batchId: string, itemId: string): Promise<CodexPelicanBatch> {
    return nativeOnly("codex_pelican_retry", { batchId, itemId });
  },

  artifact(batchId: string, itemId: string): Promise<CodexPelicanArtifact> {
    if (!nativeDesktop) return Promise.resolve({ rawReply: "", html: null });
    return nativeOnly("codex_pelican_artifact", { batchId, itemId });
  },

  browser(batchId: string, itemId: string): Promise<string> {
    return nativeOnly("codex_pelican_browser", { batchId, itemId });
  },

  history(offset = 0, limit = 20): Promise<CodexPelicanHistory> {
    if (!nativeDesktop) {
      const all = readDebugHistory();
      const slice = all.slice(offset, offset + limit);
      return Promise.resolve({ items: slice, hasMore: offset + limit < all.length });
    }
    return nativeOnly("codex_pelican_history", { offset, limit });
  },

  delete(batchId: string): Promise<void> {
    if (!nativeDesktop) {
      writeDebugHistory(readDebugHistory().filter(item => item.id !== batchId));
      return Promise.resolve();
    }
    return nativeOnly("codex_pelican_delete", { batchId });
  },

  clearAll(): Promise<{ deletedCount: number }> {
    if (!nativeDesktop) {
      const count = readDebugHistory().length;
      writeDebugHistory([]);
      return Promise.resolve({ deletedCount: count });
    }
    return nativeOnly("codex_pelican_clear_all");
  },

  retentionGet(): Promise<{ days: number }> {
    if (!nativeDesktop) return Promise.resolve({ days: readDebugRetention() });
    return nativeOnly("codex_pelican_retention_get");
  },

  retentionSet(days: number): Promise<{ days: number }> {
    if (!nativeDesktop) {
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return Promise.reject(new Error("保留天数需为 1 至 3650 天"));
      }
      try { window.localStorage.setItem(DEBUG_RETENTION_KEY, String(days)); } catch { /* ignore */ }
      return Promise.resolve({ days });
    }
    return nativeOnly("codex_pelican_retention_set", { days });
  },

  cleanup(): Promise<{ deletedCount: number }> {
    if (!nativeDesktop) {
      const days = readDebugRetention();
      const cutoff = Date.now() - days * 86_400_000;
      const prev = readDebugHistory();
      const kept = prev.filter(item => item.createdAt >= cutoff);
      writeDebugHistory(kept);
      return Promise.resolve({ deletedCount: prev.length - kept.length });
    }
    return nativeOnly("codex_pelican_cleanup");
  },

  subscribeProgress(onBatch: (batch: CodexPelicanBatch) => void): Promise<() => void> {
    if (!nativeDesktop) return Promise.resolve(() => undefined);
    return listen<CodexPelicanBatch>("codex://pelican-progress", ({ payload }) => onBatch(payload));
  },
};
