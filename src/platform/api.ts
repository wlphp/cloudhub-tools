import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke = tauriInvoke;

export type PlatformErrorCode =
  | "unknown"
  | "unsupported-in-preview"
  | "validation"
  | "authentication"
  | "permission"
  | "network"
  | "not-found"
  | "conflict"
  | "cancelled";

function publicPlatformMessage(code: PlatformErrorCode, rawMessage: string): string {
  if (code === "unsupported-in-preview") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  const messages: Record<Exclude<PlatformErrorCode, "unsupported-in-preview">, string> = {
    unknown: "操作失败，请稍后重试",
    validation: "输入参数无效，请检查后重试",
    authentication: "认证失败，请检查凭据或登录状态",
    permission: "权限不足，请检查当前账号权限",
    network: "网络或云服务暂时不可用，请稍后重试",
    "not-found": "目标资源不存在或已被移除",
    conflict: "操作冲突，请刷新后重试",
    cancelled: "操作已取消",
  };
  return messages[code];
}

export class PlatformError extends Error {
  readonly kind = "platform-error" as const;
  constructor(
    message: string,
    readonly code: PlatformErrorCode = "unknown",
    readonly retryable = false,
  ) {
    super(publicPlatformMessage(code, message));
    this.name = "PlatformError";
  }
}

function classifyPlatformError(message: string): { code: PlatformErrorCode; retryable: boolean } {
  if (/仅在桌面端|仅在浏览器预览|unsupported-in-preview/i.test(message)) return { code: "unsupported-in-preview", retryable: false };
  if (/取消|cancelled|canceled/i.test(message)) return { code: "cancelled", retryable: false };
  if (/不存在|not found|未找到/i.test(message)) return { code: "not-found", retryable: false };
  if (/冲突|已存在|conflict|duplicate/i.test(message)) return { code: "conflict", retryable: false };
  if (/权限|无权|forbidden|unauthorized|notauthorized|accessdenied|permission/i.test(message)) return { code: "permission", retryable: false };
  if (/密钥|凭据|认证|签名|access key|authentication|invalid token/i.test(message)) return { code: "authentication", retryable: false };
  if (/参数|格式|不能为空|无效|invalid|must be|不能超过/i.test(message)) return { code: "validation", retryable: false };
  if (/超时|网络|连接|请求失败|timeout|network|connection|fetch failed/i.test(message)) return { code: "network", retryable: true };
  return { code: "unknown", retryable: false };
}

export function normalizePlatformError(reason: unknown): PlatformError {
  if (reason instanceof PlatformError) return reason;
  if (typeof reason === "object" && reason !== null && "kind" in reason && reason.kind === "unsupported-in-preview") {
    const unsupported = reason as UnsupportedInPreviewError;
    return new PlatformError(unsupported.message, "unsupported-in-preview", false);
  }
  if (typeof reason === "object" && reason !== null && "code" in reason && "message" in reason) {
    const structured = reason as { code?: PlatformErrorCode; message?: string; retryable?: boolean };
    const code = structured.code && ["unknown", "unsupported-in-preview", "validation", "authentication", "permission", "network", "not-found", "conflict", "cancelled"].includes(structured.code)
      ? structured.code : "unknown";
    return new PlatformError(String(structured.message), code, structured.retryable === true);
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  const classified = classifyPlatformError(message);
  return new PlatformError(message, classified.code, classified.retryable);
}

export function platformErrorMessage(reason: unknown, fallback = "操作失败"): string {
  const error = normalizePlatformError(reason);
  return error.message || fallback;
}

function webApiPort(value: string | undefined): number {
  const port = Number(value || "1430");
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1430;
}

const localWebApiPort = webApiPort(
  import.meta.env.VITE_CLOUDHUB_TOOLS_WEB_API_PORT
    || import.meta.env.VITE_ALIYUN_TOOLS_WEB_API_PORT,
);
const localWebApiBaseUrl = `http://127.0.0.1:${localWebApiPort}`;

export interface UnsupportedInPreviewError extends Error {
  kind: "unsupported-in-preview";
  feature?: string;
  hint?: string;
}

function buildUnsupported(payload: { error?: string; code?: string; details?: { feature?: string; hint?: string } }): UnsupportedInPreviewError {
  const error = new Error(payload.error || "Web API 调用未实现") as UnsupportedInPreviewError;
  error.kind = "unsupported-in-preview";
  if (payload.details?.feature) error.feature = payload.details.feature;
  if (payload.details?.hint) error.hint = payload.details.hint;
  return error;
}

export async function webApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(`${localWebApiBaseUrl}${path}`, init);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 501 && payload?.code === "unsupported-in-preview") {
      throw buildUnsupported(payload);
    }
    if (!response.ok) {
      throw new Error(payload.error || `Web API ${response.status}`);
    }
    return payload as T;
  } catch (reason) {
    throw normalizePlatformError(reason);
  }
}
