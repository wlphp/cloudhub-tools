import { nativeOnly } from "./base";

export interface CodexQuotaWindow { name: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface CodexBenefits { expiresAt: number | null; resetCredits: number | null; resetExpiresAt: number | null; fetchedAt: number | null; subscriptionError: string | null; creditsError: string | null }
export interface CodexAccount {
  id: number; label: string; email: string | null; accountId: string | null;
  proxyUrl?: string | null; benefits?: CodexBenefits;
  authMode: "chatgpt" | "apikey"; plan: string | null; note: string; tags: string[];
  quota: { windows: CodexQuotaWindow[]; fetchedAt: number | null }; lastError: string | null; updatedAt: number;
}
export type CodexExportFormat = "cockpit_tools" | "auth_json" | "sub2api" | "cpa";
export interface CodexState { accounts: CodexAccount[]; cliAvailable: boolean; desktopAvailable: boolean; canOpenDefault?: boolean; supportsRemoteLogs?: boolean; profileHome: string; currentAccountId: number | null; canRestore: boolean }
export interface CodexRemoteLog { id: string; timestamp: number; accountId: number | null; transport: string; method: string; url: string; status: number | null; outcome: string; durationMs: number; proxyMode: string; proxyUrl: string | null }
export interface CodexRemoteLogState { enabled: boolean; logs: CodexRemoteLog[] }
export interface CodexSwitchPreview { token: string; accountLabel: string; profileHome: string; hasPreviousAuth: boolean }
export interface CodexInstance { id: string; accountId: number; name: string; workDir: string; kind: "cli" | "desktop"; running: boolean; lastError: string | null }
export interface CodexGatewaySettings { loggingEnabled: boolean; strategy: "round_robin" | "quota_first" | "ordered"; cooldownSeconds: number }
export interface CodexCallDetail { request: unknown; forwarded: unknown; response: unknown; events: unknown[]; eventCount: number; truncated: boolean }
export interface CodexCallLog { id: string; timestamp: number; endpoint: string; model: string | null; accountId: number | null; status: number; upstreamStatus: number | null; outcome: string; streaming: boolean; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CodexGatewayState { lanAddress?: string | null; supportsShareConfig?: boolean; allowLan?: boolean; listeningLan?: boolean; supportsLanAccess?: boolean; settings?: CodexGatewaySettings; running: boolean; address: string | null; accountIds: number[]; completed: number; failed: number; active: number; supportsCustomKey?: boolean; supportsModels?: boolean; supportsRemoteModels?: boolean; supportsPersistentConfig?: boolean; supportsFunctionTools?: boolean; supportsMultiProtocol?: boolean; supportsConfigSave?: boolean; supportsKeyReveal?: boolean; supportsAutoStart?: boolean; supportsPoolPersistence?: boolean; autoStart?: boolean; startupAccountIds?: number[]; startupError?: string | null; configuredPort?: number | null }

export const codexClient = {
  remoteLogs(): Promise<CodexRemoteLogState> { return nativeOnly("codex_remote_logs"); },
  remoteLogDetail(id: string): Promise<CodexCallDetail> { return nativeOnly("codex_remote_log_detail", { id }); },
  configureRemoteLogs(enabled: boolean): Promise<CodexRemoteLogState> { return nativeOnly("codex_remote_logs_configure", { enabled }); },
  clearRemoteLogs(): Promise<CodexRemoteLogState> { return nativeOnly("codex_remote_logs_clear"); },
  saveProxies(ids: number[], url: string): Promise<CodexAccount[]> { return nativeOnly("codex_save_proxies", { ids, url }); },
  detectProxies(): Promise<{ url: string; source: string; enabled: boolean }[]> { return nativeOnly("codex_detect_proxies"); },
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
  revealGatewayKey(): Promise<string> { return nativeOnly("codex_gateway_reveal_key"); },
  saveGatewayPort(port: number): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_save_port", { port }); },
  setGatewayAutoStart(enabled: boolean, accountIds: number[]): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_set_auto_start", { enabled, accountIds }); },
  copyGatewayShareConfig(ip: string): Promise<void> { return nativeOnly("codex_gateway_copy_share_config", { ip }); },
  gatewayLanInterfaces(): Promise<{ip: string; adapter: string; network: string}[]> { return nativeOnly("codex_gateway_lan_interfaces"); },
  setGatewayAllowLan(enabled: boolean): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_set_allow_lan", { enabled }); },
  saveGatewayPool(accountIds: number[]): Promise<CodexGatewayState> { return nativeOnly("codex_gateway_save_pool", { accountIds }); },
  wakeAccount(id: number, model: string): Promise<void> { return nativeOnly("codex_wake_account", { id, model }); },
  exportAccountsFile(accountId: number | null = null, accountIds: number[] | null = null, format: CodexExportFormat = "cockpit_tools"): Promise<boolean> { return nativeOnly("codex_export_accounts_file", { accountId, accountIds, format }); },
  instances(): Promise<CodexInstance[]> { return nativeOnly("codex_list_instances"); },
  createInstance(accountId: number, name: string, kind: "cli" | "desktop"): Promise<CodexInstance[] | null> { return nativeOnly("codex_create_instance", { accountId, name, kind }); },
  startInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_start_instance", { id }); },
  stopInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_stop_instance", { id }); },
  deleteInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_delete_instance", { id }); },
  startLogin(): Promise<{ token: string; authUrl: string }> { return nativeOnly("codex_start_login"); },
  copyLoginUrl(token: string): Promise<void> { return nativeOnly("codex_copy_login_url", { token }); },
  openLoginUrl(token: string): Promise<void> { return nativeOnly("codex_open_login_url", { token }); },
  pollLogin(token: string): Promise<{ status: "pending" | "completed" }> { return nativeOnly("codex_poll_login", { token }); },
  cancelLogin(token: string): Promise<void> { return nativeOnly("codex_cancel_login", { token }); },
  state(): Promise<CodexState> { return nativeOnly("codex_get_state"); },
  importLocal(): Promise<CodexState> { return nativeOnly("codex_import_local"); },
  importFile(format: CodexExportFormat = "cockpit_tools"): Promise<CodexState | null> { return nativeOnly("codex_import_file", { format }); },
  saveMetadata(input: { id: number; label: string; note: string; tags: string[] }): Promise<CodexAccount> { return nativeOnly("codex_save_metadata", { input }); },
  deleteAccount(id: number): Promise<CodexState> { return nativeOnly("codex_delete_account", { id }); },
  refreshQuota(id: number): Promise<CodexAccount> { return nativeOnly("codex_refresh_quota", { id }); },
  prepareSwitch(id: number): Promise<CodexSwitchPreview> { return nativeOnly("codex_prepare_switch", { id }); },
  confirmSwitch(token: string): Promise<CodexState> { return nativeOnly("codex_confirm_switch", { token }); },
  restoreProfile(): Promise<CodexState> { return nativeOnly("codex_restore_profile"); },
};
