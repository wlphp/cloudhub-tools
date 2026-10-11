import { nativeOnly } from "./base";

export interface CodexQuotaWindow { name: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface CodexBenefits { expiresAt: number | null; resetCredits: number | null; resetExpiresAt: number | null; fetchedAt: number | null; subscriptionError: string | null; creditsError: string | null }
export interface CodexAccount {
  id: number; label: string; email: string | null; accountId: string | null;
  proxyUrl?: string | null; benefits?: CodexBenefits;
  authMode: "chatgpt" | "apikey"; plan: string | null; note: string; tags: string[];
  quota: { windows: CodexQuotaWindow[]; fetchedAt: number | null }; lastError: string | null; updatedAt: number;
}
export interface CodexState { accounts: CodexAccount[]; cliAvailable: boolean; desktopAvailable: boolean; canOpenDefault?: boolean; profileHome: string; currentAccountId: number | null; canRestore: boolean }
export interface CodexSwitchPreview { token: string; accountLabel: string; profileHome: string; hasPreviousAuth: boolean }
export interface CodexInstance { id: string; accountId: number; name: string; workDir: string; kind: "cli" | "desktop"; running: boolean; lastError: string | null }
export interface CodexGatewaySettings { loggingEnabled: boolean; strategy: "round_robin" | "quota_first" | "ordered"; cooldownSeconds: number }
export interface CodexCallDetail { request: unknown; forwarded: unknown; response: unknown; events: unknown[]; eventCount: number; truncated: boolean }
export interface CodexCallLog { id: string; timestamp: number; endpoint: string; model: string | null; accountId: number | null; status: number; upstreamStatus: number | null; outcome: string; streaming: boolean; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CodexGatewayState { settings?: CodexGatewaySettings; running: boolean; address: string | null; accountIds: number[]; completed: number; failed: number; active: number; supportsCustomKey?: boolean; supportsModels?: boolean; supportsRemoteModels?: boolean; supportsPersistentConfig?: boolean; supportsFunctionTools?: boolean; configuredPort?: number | null }

export const codexClient = {
  saveProxy(id: number, url: string): Promise<CodexAccount> { return nativeOnly("codex_save_proxy", { id, url }); },
  refreshBenefits(id: number): Promise<CodexAccount> { return nativeOnly("codex_refresh_benefits", { id }); },
  consumeReset(id: number): Promise<CodexAccount> { return nativeOnly("codex_consume_reset", { id }); },
  configureGateway(settings: CodexGatewaySettings): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_configure", { settings }); },
  gatewayLogDetail(id: string): Promise<CodexCallDetail> { return nativeOnly("codex_gateway_log_detail", { id }); },
  gatewayLogs(): Promise<CodexCallLog[]> { return nativeOnly("codex_gateway_logs"); },
  clearGatewayLogs(): Promise<void> { return nativeOnly("codex_gateway_clear_logs"); },
  openDefault(): Promise<void> { return nativeOnly("codex_open_default"); },
  gatewayModels(): Promise<string[]> { return nativeOnly("codex_gateway_models"); },
  gatewayState(): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_state"); },
  startGateway(port: number, accountIds: number[], serviceKey: string | null = null): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_start", { port, accountIds, serviceKey }); },
  stopGateway(): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_stop"); },
  copyGatewayKey(): Promise<void> { return nativeOnly("codex_gateway_copy_key"); },
  wakeAccount(id: number, model: string): Promise<void> { return nativeOnly("codex_wake_account", { id, model }); },
  exportBackup(password: string): Promise<boolean> { return nativeOnly("codex_export_backup", { password }); },
  importBackup(password: string): Promise<boolean> { return nativeOnly("codex_import_backup", { password }); },
  instances(): Promise<CodexInstance[]> { return nativeOnly("codex_list_instances"); },
  createInstance(accountId: number, name: string, kind: "cli" | "desktop"): Promise<CodexInstance[] | null> { return nativeOnly("codex_create_instance", { accountId, name, kind }); },
  startInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_start_instance", { id }); },
  stopInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_stop_instance", { id }); },
  deleteInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_delete_instance", { id }); },
  startLogin(): Promise<{ token: string }> { return nativeOnly("codex_start_login"); },
  pollLogin(token: string): Promise<{ status: "pending" | "completed" }> { return nativeOnly("codex_poll_login", { token }); },
  cancelLogin(token: string): Promise<void> { return nativeOnly("codex_cancel_login", { token }); },
  state(): Promise<CodexState> { return nativeOnly("codex_get_state"); },
  importLocal(): Promise<CodexState> { return nativeOnly("codex_import_local"); },
  importFile(): Promise<CodexState | null> { return nativeOnly("codex_import_file"); },
  saveMetadata(input: { id: number; label: string; note: string; tags: string[] }): Promise<CodexAccount> { return nativeOnly("codex_save_metadata", { input }); },
  deleteAccount(id: number): Promise<CodexState> { return nativeOnly("codex_delete_account", { id }); },
  refreshQuota(id: number): Promise<CodexAccount> { return nativeOnly("codex_refresh_quota", { id }); },
  prepareSwitch(id: number): Promise<CodexSwitchPreview> { return nativeOnly("codex_prepare_switch", { id }); },
  confirmSwitch(token: string): Promise<CodexState> { return nativeOnly("codex_confirm_switch", { token }); },
  restoreProfile(): Promise<CodexState> { return nativeOnly("codex_restore_profile"); },
};
