import { invoke, runningInTauri } from "../api";

async function nativeOnly<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!runningInTauri) throw new Error("该功能仅支持桌面客户端");
  try { return await invoke<T>(command, args); }
  catch (reason) {
    const detail = typeof reason === "object" && reason !== null ? reason as { message?: unknown } : null;
    const message = typeof reason === "string" ? reason : detail && "message" in detail ? String(detail.message) : "";
    // 原样上报后端原因：这里再套一层白名单只会把真实失败原因换成通用提示，
    // 用户既看不到问题出在哪，也无从处理。
    throw new Error(message || "操作失败：后端未返回具体原因");
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
export interface ProviderConfigPreview { version: string; path: string; hasBackup: boolean; catalogStale: boolean; recoveryPending: boolean; conflict?: string | null; applied: { providerId: string; keyId: string; providerVersion: number; model: string; oauthAccountId: number | null } | null }
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
  restore: (id: string | null): Promise<ProviderConfigPreview> => nativeOnly("codex_provider_restore", { id }),
  revealKey: (providerId: string, keyId: string, version: number): Promise<string> => nativeOnly("codex_provider_reveal_key", { providerId, keyId, version }),
  list: (): Promise<CodexProvider[]> => nativeOnly("codex_provider_list"),
  save: (input: ProviderInput): Promise<CodexProvider[]> => nativeOnly("codex_provider_save", { input }),
  duplicate: (id: string, version: number): Promise<CodexProvider[]> => nativeOnly("codex_provider_duplicate", { id, version }),
  remove: (id: string, version: number): Promise<CodexProvider[]> => nativeOnly("codex_provider_remove", { id, version }),
};
