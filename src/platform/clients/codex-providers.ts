import { invoke, runningInTauri } from "../api";

const safeErrors = new Set(["供应商地址无效", "供应商名称、协议、模型或密钥数量无效", "密钥名称重复或参数无效", "供应商标识无效", "密钥已被修改，请刷新后重试", "新密钥不能为空", "供应商已被修改，请刷新后重试", "目标配置已变更，请重新预览", "请先恢复上次供应商配置，再切换供应商", "没有供应商配置备份", "目标配置已被外部修改，未恢复", "此供应商需要协议转换，请等待网关配置完成", "模型不在供应商目录中", "检测到 Codex 客户端或 CLI 正在运行，请关闭后再切换或恢复默认登录", "请先停止实例再修改启动配置", "无法启动官方 CLI 读取供应商配置", "未找到官方 Codex CLI。请安装官方 CLI 并加入 PATH 后重试供应商切换", "无法启动官方 Codex CLI。请检查 CLI 安装和 Windows 安全软件拦截后重试", "官方 Codex CLI 在读取配置时提前退出。请更新 CLI 到兼容版本后重试", "官方 Codex CLI 读取配置超时。请检查 CLI 版本及本机运行状态后重试", "官方 Codex CLI 初始化失败。请检查 CLI 版本与安装状态后重试", "官方 CLI 无法生成供应商配置"]);
safeErrors.add("复制供应商失败");
for (const message of ["供应商请求繁忙，请稍后重试", "请先恢复使用此供应商的实例配置，再编辑或删除", "供应商账号仍被实例引用，请先恢复或解绑实例", "供应商账号正在使用，请先停止关联实例或服务"]) safeErrors.add(message);
for (const message of ["供应商密钥格式无效", "请先填写 API Key 或选择已保存密钥", "读取供应商密钥任务失败", "供应商密钥不存在"]) safeErrors.add(message);
for (const message of ["默认模型或上下文参数无效", "密钥模型目录无效", "供应商网关端口被占用", "供应商网关配置失效，请恢复配置后重新应用", "聚合名称、成员数量或标识无效", "聚合成员或权重无效", "聚合供应商不存在", "聚合目前要求成员均为有效的 Chat Completions 密钥", "聚合供应商已被修改，请刷新后重试", "聚合成员不能重复"]) safeErrors.add(message);
for (const message of ["请先恢复应用此聚合配置的 Codex 目标，再修改聚合", "请先恢复应用此聚合配置的 Codex 目标，再删除聚合"]) safeErrors.add(message);
for (const message of ["OAuth 账号已被其他实例、服务或供应商占用", "此 OAuth 账号由默认客户端管理，请先切换默认登录或选择默认目标", "目标 OAuth 登录已更新，请先导入最新登录后重试", "只能绑定含 ID Token 和 Refresh Token 的官方 OAuth 账号", "供应商实例已登录不同 OAuth 账号，未覆盖凭据", "OAuth 账号与实例凭据均已变更，未覆盖登录", "OAuth 账号已更新，请先恢复并重新应用供应商配置"]) safeErrors.add(message);
for (const message of ["此供应商暂不支持额度查询", "额度查询网络失败或超时", "额度接口拒绝请求，请检查密钥与适配类型", "额度响应无法识别，当前额度未知"]) safeErrors.add(message);
for (const message of ["供应商导入文件须为不超过 2 MB 的 JSON", "请粘贴要导入的 JSON 内容", "供应商导入文件不是有效 JSON", "请选择 Cockpit 供应商数组或 CodexPlusPlus 设置 JSON", "每次可导入 1 至 100 个供应商", "导入协议缺失或不支持，未导入任何供应商", "请仅导入第三方 API 配置；官方和聚合配置不能按普通供应商导入", "导入供应商缺少密钥列表", "导入配置包含无效地址、模型、密钥或上下文设置，未导入任何供应商", "导入预览已过期，请重新选择文件", "供应商目录已变更，请重新预览导入", "导入地址指向本地代理，请改为真实上游地址后导入"]) safeErrors.add(message);
async function nativeOnly<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!runningInTauri) throw new Error("该功能仅支持桌面客户端");
  try { return await invoke<T>(command, args); }
  catch (reason) {
    const detail = typeof reason === "object" && reason !== null ? reason as { message?: unknown; code?: unknown } : null;
    const message = typeof reason === "string" ? reason : detail && "message" in detail ? String(detail.message) : "";
    // The native provider layer forwards only exact, authored diagnostics under
    // the codex-provider code, so those messages are safe to show verbatim.
    if (detail && detail.code === "codex-provider" && message) throw new Error(message);
    throw new Error(safeErrors.has(message) ? message : "模型供应商操作失败，请刷新后重试");
  }
}

export interface ModelSettings { models?: string[]; modelsScoped?: boolean; defaultModel?: string | null; contextWindow?: number | null; compactLimit?: number | null }
export interface ProviderKey { id: string; name: string; settings?: ModelSettings }
export interface CodexProvider {
  id: string; version: number; name: string; baseUrl: string;
  wireApi: "responses" | "chat_completions"; models: string[]; note: string; keys: ProviderKey[];
  settings?: ModelSettings;
}
export interface ProviderInput extends Omit<CodexProvider, "id" | "version" | "keys"> {
  id: string | null; version: number | null;
  keys: { id: string | null; name: string; secret: string | null; settings?: ModelSettings }[];
}
export function effectiveModels(provider: CodexProvider, keyId: string) {
  const settings = provider.keys.find(v => v.id === keyId)?.settings;
  return settings?.modelsScoped || settings?.models?.length ? settings.models ?? [] : provider.models;
}
export function keysForModel(provider: CodexProvider, model: string) {
  return provider.keys.filter(key => effectiveModels(provider, key.id).includes(model));
}
export function defaultModel(provider: CodexProvider, keyId: string) {
  const key = provider.keys.find(v => v.id === keyId);
  const models = effectiveModels(provider, keyId);
  const preferred = [key?.settings?.defaultModel, provider.settings?.defaultModel].find(value => value && models.includes(value));
  return preferred ?? models[0] ?? "";
}
export interface ProviderConfigPreview { version: string; path: string; hasBackup: boolean; catalogStale: boolean }
export interface ApplyProvider { providerId: string; keyId: string; providerVersion: number; model: string; version: string; oauthAccountId?: number | null }
export interface ProviderProbeResult { models: string[]; generated: boolean; elapsedMs: number; status: number | null; error: "network" | "http" | "invalid_response" | "response_too_large" | "output_limit" | "unsupported_input" | null; codexInput: boolean }
export interface ProviderModelCatalogInput { baseUrl: string; providerId: string | null; keyId: string | null; version: number | null; secret: string | null }
export interface ProviderUsage { adapter: string; fetchedAt: number; windows: { name: string; remaining: number; total: number | null; unit: string; resetsAt: number | null }[] }
export interface ProviderImport { token: string; providers: { name: string; baseUrl: string; wireApi: string; models: string[]; keyCount: number; duplicate: boolean }[]; warnings: string[] }
export interface ProviderRequestLog { id: string; providerId: string; source: string; method: string; url: string; requestBody: string; clientRequestBody: string; status: number | null; responseBody: string; error: string | null; elapsedMs: number; createdAt: number }
export type AggregateStrategy = "failover" | "roundRobin" | "weightedRoundRobin";
export interface ProviderAggregate {
  id: string; version: number; name: string; strategy: AggregateStrategy; models: string[];
  members: { providerId: string; keyId: string; providerName: string; keyName: string; wireApi: string; models: string[]; weight: number }[];
}
export interface ProviderAggregateInput {
  id: string | null; version: number | null; name: string; strategy: AggregateStrategy;
  members: { providerId: string; keyId: string; weight: number }[];
}
export const codexProviders = {
  models: (input: ProviderModelCatalogInput): Promise<ProviderProbeResult> => nativeOnly("codex_provider_models", { input }),
  aggregateList: (): Promise<ProviderAggregate[]> => nativeOnly("codex_provider_aggregate_list"),
  aggregateSave: (input: ProviderAggregateInput): Promise<ProviderAggregate[]> => nativeOnly("codex_provider_aggregate_save", { input }),
  aggregateRemove: (id: string, version: number): Promise<ProviderAggregate[]> => nativeOnly("codex_provider_aggregate_remove", { id, version }),
  import: (action: "prepare" | "prepare_text" | "confirm" | "cancel", token: string | null = null, text?: string): Promise<ProviderImport | null> => nativeOnly("codex_provider_import", { action, token, text }),
  export: (ids?: string[]): Promise<string> => nativeOnly("codex_provider_export", { ids: ids ?? null }),
  logs: (providerId: string, limit = 100): Promise<ProviderRequestLog[]> => nativeOnly("codex_provider_logs", { providerId, limit }),
  clearLogs: (providerId: string): Promise<number> => nativeOnly("codex_provider_logs_clear", { providerId }),
  usage: (providerId: string, keyId: string, version: number, adapter: string): Promise<ProviderUsage> => nativeOnly("codex_provider_usage", { providerId, keyId, version, adapter }),
  probe: (providerId: string, keyId: string, version: number, model: string | null): Promise<ProviderProbeResult> => nativeOnly("codex_provider_probe", { providerId, keyId, version, model }),
  preview: (id: string | null): Promise<ProviderConfigPreview> => nativeOnly("codex_provider_preview", { id }),
  apply: (id: string | null, input: ApplyProvider): Promise<ProviderConfigPreview> => nativeOnly("codex_provider_apply", { id, input }),
  restore: (id: string | null, force = false): Promise<ProviderConfigPreview> => nativeOnly("codex_provider_restore", { id, force }),
  revealKey: (providerId: string, keyId: string, version: number): Promise<string> => nativeOnly("codex_provider_reveal_key", { providerId, keyId, version }),
  list: (): Promise<CodexProvider[]> => nativeOnly("codex_provider_list"),
  save: (input: ProviderInput): Promise<CodexProvider[]> => nativeOnly("codex_provider_save", { input }),
  duplicate: (id: string, version: number): Promise<CodexProvider[]> => nativeOnly("codex_provider_duplicate", { id, version }),
  remove: (id: string, version: number): Promise<CodexProvider[]> => nativeOnly("codex_provider_remove", { id, version }),
};
