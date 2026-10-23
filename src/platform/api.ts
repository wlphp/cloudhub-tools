import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke = tauriInvoke;

export type PlatformErrorCode =
  | "codex-login"
  | "codex-launch"
  | "codex-config"
  | "codex-import"
  | "claude-workbench"
  | "oss-cname"
  | "local-plugin"
  | "unknown"
  | "ai"
  | "unsupported-in-preview"
  | "validation"
  | "authentication"
  | "permission"
  | "network"
  | "not-found"
  | "conflict"
  | "frp-port-conflict"
  | "codex-account-busy"
  | "codex-gateway-port-conflict"
  | "codex-model-catalog"
  | "codex-provider"
  | "codex-proxy"
  | "cancelled"
  | "certificate"
  | "esa-query"
  | "authenticator-error"
  | "authenticator-locked"
  | "hardware-info"
  | "wsl-dashboard"
  | "browser"
  | "notes"
  | "panel-probe";

// 失败原因一律原样透传。这里只做两件事：把夹带的凭据形状片段脱敏，以及在原生层
// 真的没给出文字时补一句可读提示。按 code 用通用文案覆盖原文没有意义——覆盖之后
// 用户既看不到问题出在哪，也不知道下一步该做什么，只能反复重试同一件事。
const CREDENTIAL_SHAPE = /(private[_-]?key|secret[_-]?key|access[_-]?key|api[_-]?key|password|passwd|secret|token|authorization|signature)(\s*=\s*)[^,;\s]+/gi;
const BEARER_CREDENTIAL = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const OTP_URI = /otpauth:\/\/[^\s]+/gi;
const MAX_ERROR_LENGTH = 500;

// 仅在原生层返回空文案时才用；正常失败一律显示原文。
const EMPTY_MESSAGE_FALLBACK: Partial<Record<PlatformErrorCode, string>> = {
  "frp-port-conflict": "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程",
  "codex-account-busy": "所选账号已有 Codex 实例或服务运行，请先停止后再启动 API 服务",
  "codex-gateway-port-conflict": "本地 API 端口已被占用，请换一个端口后重试",
  "authenticator-locked": "验证器已锁定，请重新解锁",
};

function publicPlatformMessage(code: PlatformErrorCode, rawMessage: string): string {
  const text = String(rawMessage ?? "")
    .replace(OTP_URI, "[OTP 地址已隐藏]")
    .replace(CREDENTIAL_SHAPE, "$1$2[已隐藏]")
    .replace(BEARER_CREDENTIAL, "$1[已隐藏]")
    .trim();
  return text.slice(0, MAX_ERROR_LENGTH) || EMPTY_MESSAGE_FALLBACK[code] || "操作失败：后端未返回具体原因";
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
  if (/仅在桌面端|仅在浏览器预览|仅支持 CloudHub 原生客户端|unsupported-in-preview/i.test(message)) return { code: "unsupported-in-preview", retryable: false };
  if (message.includes("所选账号已有实例或服务运行")) return { code: "codex-account-busy", retryable: false };
  if (message.includes("本地 API 端口被占用") || message.includes("无法监听")) return { code: "codex-gateway-port-conflict", retryable: false };
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
    const code = structured.code && ["codex-config", "codex-launch", "codex-login", "codex-import", "claude-workbench", "oss-cname", "local-plugin", "ai", "unknown", "unsupported-in-preview", "validation", "authentication", "permission", "network", "not-found", "conflict", "frp-port-conflict", "codex-account-busy", "codex-gateway-port-conflict", "codex-model-catalog", "codex-provider", "codex-proxy", "cancelled", "certificate", "esa-query", "authenticator-error", "authenticator-locked", "hardware-info", "wsl-dashboard", "browser", "notes", "panel-probe"].includes(structured.code)
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
      if (["authenticator-error", "authenticator-locked", "ai", "notes"].includes(payload?.code)) throw new PlatformError(payload.error || "操作失败", payload.code);
      throw new Error(payload.error || `Web API ${response.status}`);
    }
    return payload as T;
  } catch (reason) {
    throw normalizePlatformError(reason);
  }
}
