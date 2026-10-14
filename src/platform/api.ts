import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke = tauriInvoke;

export type PlatformErrorCode =
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
  | "codex-proxy"
  | "cancelled"
  | "certificate"
  | "esa-query"
  | "authenticator-error"
  | "authenticator-locked";

function publicPlatformMessage(code: PlatformErrorCode, rawMessage: string): string {
  if (code === "ai") {
    if (/^AI服务拒绝请求（HTTP (400|404|422)）：(参数 (model|instructions|tools|tool_choice|input|reasoning|max_output_tokens|temperature|top_p|store|stream|include|service_tier|text|prompt_cache_key) 不兼容|模型不可用或模型参数不兼容|请求参数不受支持|指令参数不兼容|请求被拒绝)$/.test(rawMessage)) return rawMessage;
    const safe = ["AI任务状态不可用", "AI请求标识无效", "请先填写或选择分析内容", "内容含疑似凭据，请先使用发送预览移除后再提交", "AI任务已在运行或并发已达上限", "AI请求已取消", "AI服务地址无效", "AI服务地址不能包含账号、密码、查询参数或片段", "AI服务须使用HTTPS；本地回环HTTP需明确开启", "AI协议无效", "模型名称只支持字母、数字、点、下划线、冒号及连字符", "AI配置字段或限额无效", "AI密钥格式无效", "最多保存20个AI服务配置", "首次添加须填写AI密钥", "AI服务已停用", "分析内容过长，请选择较短片段", "内容包含私钥或验证器凭据，请移除后再分析", "模型未完整返回结果，请缩短输入或调整输出上限", "模型响应未完成或被拒绝", "模型响应未完成或请求了未授权工具", "模型响应未完成或内容被拒绝", "模型返回了敏感内容，结果已拦截", "AI结果格式不合法，请重试或手动填写", "AI结果超过处理上限", "AI结果包含未允许的字段或无效值", "AI结果包含疑似凭据，结果已拦截", "AI请求超时，可重试或继续手动操作", "AI连接失败，请检查地址与网络", "AI认证失败，请检查密钥和权限", "AI服务限流或额度不足，请稍后重试", "AI服务发生重定向，请填写最终HTTPS地址", "AI协议、路径或模型不受支持，请检查配置", "AI服务暂不可用，请稍后重试", "AI响应超过大小限制", "AI服务返回无效响应", "AI结果为空，请重试或手动填写", "更改AI服务来源时须重新填写密钥"];
    safe.push("启用AI服务须填写密钥", "请选择1～20个AI配置", "所选AI配置已变化，请刷新后重试", "AI迁移包类型、版本或数量无效", "AI迁移配置字段无效", "请选择迁移预览中的有效AI配置", "导入后AI配置将超过20个，请先整理配置", "导入AI配置失败，未写入任何配置", "AI配置文件超过大小限制", "AI配置文件格式无效", "AI迁移状态不可用", "请先关闭其他AI迁移预览", "AI迁移预览已过期，请重新选择文件", "保存AI迁移包失败", "导出AI配置失败", "读取AI迁移配置失败", "导出AI迁移任务失败", "读取AI迁移任务失败");
    safe.push("AI配置已变更，请关闭辅助面板后重新打开", "AI服务拒绝请求（HTTP 400），请检查模型和请求参数", "AI接口不存在（HTTP 404），请检查服务地址和接口协议", "AI请求参数无效（HTTP 422），请检查模型和服务兼容性");
    safe.push("AI流式事件超过大小限制", "AI流式文本编码无效", "AI流式结果超过大小限制", "AI流式事件数量超过限制", "AI流式响应未完整结束", "AI流式事件格式无效", "AI流式服务返回错误，请重试", "AI流式响应包含拒绝或未授权工具", "AI流式完成事件无效", "截图超过大小限制，请裁剪后重试", "截图格式无效，请使用PNG或JPEG图片", "截图数据无效", "截图格式与实际内容不一致", "截图尺寸无效", "截图尺寸须在1600像素以内，请裁剪或缩小", "无法解码截图", "截图包含二维码，请裁剪或遮挡后重试", "处理截图失败", "生成图像测试失败", "请先完成图像能力测试并确认截图已裁剪遮挡", "保存图像测试结果失败", "服务模型目录格式不兼容，可直接填写模型名称", "服务未返回可用模型名称，可直接填写", "查询AI模型失败，请检查服务和网络", "服务不支持模型查询或认证失败，可直接填写模型名称", "读取AI模型目录失败", "AI模型目录超过大小限制");
    safe.push("模型名称格式无效；Gemini只接受单个模型标识", "模型响应包含未授权工具");
    safe.push("每个服务最多配置20个模型", "请使用已配置的模型ID", "请先将所选模型设为默认并完成图像测试", "AI配置不存在，请刷新设置");
    safe.push("此服务尚未保存密钥", "AI配置标识无效");
    return safe.includes(rawMessage) ? rawMessage : "AI操作失败，请检查配置或继续手动操作";
  }
  if (code === "esa-query") {
    return /^ESA 查询失败：(ListSites|DescribeSiteTimeSeriesData|DescribeSiteWafTimeSeriesData)（(?:网络连接失败|响应格式无效|HTTP [1-5]\d{2}，错误代码 [A-Za-z0-9._-]{1,80})）$/.test(rawMessage)
      ? rawMessage : "ESA 实时数据获取失败，请检查账号权限和网络后重试";
  }
  if (code === "codex-proxy") {
    return ["代理地址无效", "代理地址不能包含换行或控制字符", "代理地址不能超过 512 个字符",
      "代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址",
      "请填写无账号密码的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890",
      "请先停止该账号的服务或实例，再修改代理", "保存账号代理任务失败", "保存账号代理失败",
      "读取本机代理配置失败，请手动填写代理地址", "本机代理配置超过读取限制",
      "请选择 1–1000 个有效账号后批量设置代理", "所选账号已不存在，请刷新列表后重试",
      "所选账号中有服务、实例或唤醒任务运行，请先停止后批量设置代理；未修改任何账号",
      "批量保存代理失败，未修改任何账号", "批量保存代理任务失败"].includes(rawMessage)
      ? rawMessage : "代理操作失败，请检查地址或手动填写";
  }
  if (code === "codex-model-catalog") {
    const safeMessages = [
      "官方模型目录认证过期，请重新登录服务账号", "官方模型目录访问被拒绝，请检查服务账号权限",
      "官方模型目录请求过于频繁，请稍后重试", "查询官方模型目录失败，请检查网络",
      "官方模型目录响应格式不兼容", "当前服务账号未返回模型目录", "服务账号均在冷却中，请稍后重试",
      "服务账号认证数据无效，请重新登录", "读取服务账号认证失败，请重新登录或刷新账号",
      "读取服务账号认证任务失败", "未找到官方 Codex 客户端，无法查询模型目录",
      "读取 Codex 客户端版本失败", "读取 Codex 客户端版本超时", "Codex 客户端版本无效",
      "读取官方模型目录失败", "官方模型目录响应超过限制",
    ];
    return safeMessages.includes(rawMessage) || /^官方模型目录返回 HTTP [1-5]\d{2}$/.test(rawMessage)
      ? rawMessage : "模型目录获取失败，请检查服务账号登录、权限与网络";
  }
  if (code === "authenticator-locked") return "验证器已锁定，请重新解锁";
  if (code === "authenticator-error") {
    return rawMessage
      .replace(/otpauth:\/\/[^\s]+/gi, "[OTP 地址已隐藏]")
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  if (code === "unsupported-in-preview") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  if (code === "certificate") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  const messages: Record<Exclude<PlatformErrorCode, "ai" | "unsupported-in-preview" | "certificate" | "esa-query" | "authenticator-error" | "authenticator-locked" | "codex-model-catalog" | "codex-proxy">, string> = {
    unknown: "操作失败，请稍后重试",
    validation: "输入参数无效，请检查后重试",
    authentication: "认证失败，请检查凭据或登录状态",
    permission: "权限不足，请检查当前账号权限",
    network: "网络或云服务暂时不可用，请稍后重试",
    "not-found": "目标资源不存在或已被移除",
    conflict: "操作冲突，请刷新后重试",
    "frp-port-conflict": "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程",
    "codex-account-busy": "所选账号已有 Codex 实例或服务运行，请先停止后再启动 API 服务",
    "codex-gateway-port-conflict": "本地 API 端口已被占用，请换一个端口后重试",
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
    const code = structured.code && ["ai", "unknown", "unsupported-in-preview", "validation", "authentication", "permission", "network", "not-found", "conflict", "frp-port-conflict", "codex-account-busy", "codex-gateway-port-conflict", "codex-model-catalog", "codex-proxy", "cancelled", "certificate", "esa-query", "authenticator-error", "authenticator-locked"].includes(structured.code)
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
      if (payload?.code === "authenticator-error" || payload?.code === "authenticator-locked" || payload?.code === "ai") throw new PlatformError(payload.error || "操作失败", payload.code);
      throw new Error(payload.error || `Web API ${response.status}`);
    }
    return payload as T;
  } catch (reason) {
    throw normalizePlatformError(reason);
  }
}
