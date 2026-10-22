import { nativeOnly } from "./base";

export function isCodexDefaultProcessBusy(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("检测到 Codex 客户端或 CLI 正在运行");
}

export interface CodexQuotaWindow { name: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface CodexResetCredit { id: string | null; status: string | null; resetType: string | null; grantedAt: number | null; expiresAt: number | null; redeemedAt: number | null }
export interface CodexBenefits { expiresAt: number | null; resetCredits: number | null; resetExpiresAt: number | null; resetCards?: CodexResetCredit[]; fetchedAt: number | null; subscriptionError: string | null; creditsError: string | null }
export interface CodexAccount {
  isWebSession?: boolean;
  id: number; label: string; email: string | null; accountId: string | null;
  userId?: string | null; loginProvider?: string | null; workspaceName?: string | null;
  proxyUrl?: string | null; benefits?: CodexBenefits;
  authMode: "chatgpt" | "apikey"; plan: string | null; note: string; tags: string[];
  quota: { windows: CodexQuotaWindow[]; fetchedAt: number | null }; lastError: string | null; updatedAt: number;
}
export type CodexExportFormat = "cockpit_tools" | "auth_json" | "sub2api" | "cpa";
export interface CodexState { accounts: CodexAccount[]; cliAvailable: boolean; desktopAvailable: boolean; canOpenDefault?: boolean; supportsRemoteLogs?: boolean; profileHome: string; currentAccountId: number | null; canRestore: boolean }
export interface CodexRemoteLog { id: string; timestamp: number; accountId: number | null; transport: string; method: string; url: string; status: number | null; outcome: string; durationMs: number; proxyMode: string; proxyUrl: string | null }
export interface CodexRemoteLogState { enabled: boolean; logs: CodexRemoteLog[] }
export interface CodexSwitchPreview { token: string; accountLabel: string; profileHome: string; hasPreviousAuth: boolean }
export interface CodexAuthMetadata { userId: string | null; accessExpiresAt: number | null; refreshExpiresAt: number | null; idExpiresAt: number | null; hasRefreshToken: boolean; isWebSession?: boolean }
export interface CodexAccountEvent { id: number; accountId: number; eventType: string; message: string; details: unknown | null; createdAt: number }
export interface CodexAccountDetails { email: string; password: string; twoFactor: string; mailUrl: string; phone: string; note: string }
export interface CodexAccountDetailView { details: CodexAccountDetails; version: number; auth: CodexAuthMetadata; availableSecrets: string[]; lastRefresh: string | null }
export interface CodexLaunchConfig { version: string; model: string | null; contextWindow: number | null; compactLimit: number | null }
export interface CodexConfigSource { path: string; workspace: string | null; exists: boolean; authExists: boolean; preview: Record<string, string | number | boolean | null> | null; configPreview: Record<string, unknown> | null; authPath: string; authPreview: Record<string, unknown> | null }
export interface CodexInstance { id: string; accountId: number; name: string; workDir: string; kind: "cli" | "desktop"; running: boolean; lastError: string | null }
export interface CodexGatewaySettings { loggingEnabled: boolean; strategy: "round_robin" | "quota_first" | "ordered"; cooldownSeconds: number }
export interface CodexCallDetail { request: unknown; forwarded: unknown; response: unknown; events: unknown[]; eventCount: number; truncated: boolean }
export interface CodexCallLog { id: string; timestamp: number; endpoint: string; model: string | null; accountId: number | null; status: number; upstreamStatus: number | null; outcome: string; streaming: boolean; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CodexGatewayState { lanAddress?: string | null; supportsShareConfig?: boolean; allowLan?: boolean; listeningLan?: boolean; supportsLanAccess?: boolean; settings?: CodexGatewaySettings; running: boolean; address: string | null; accountIds: number[]; completed: number; failed: number; active: number; supportsCustomKey?: boolean; supportsModels?: boolean; supportsRemoteModels?: boolean; supportsPersistentConfig?: boolean; supportsFunctionTools?: boolean; supportsMultiProtocol?: boolean; supportsConfigSave?: boolean; supportsKeyReveal?: boolean; supportsAutoStart?: boolean; supportsPoolPersistence?: boolean; autoStart?: boolean; startupAccountIds?: number[]; startupError?: string | null; configuredPort?: number | null }

export const codexClient = {
  configSource(action: "state" | "select_project" | "open_directory" | "preview" | "preview_config" | "reveal_config" | "preview_auth" | "reveal_auth", workspace: string | null = null): Promise<CodexConfigSource | null> { return nativeOnly("codex_config_source", { action, workspace }); },
  accountDetails(id: number): Promise<CodexAccountDetailView> { return nativeOnly("codex_account_details", { id }); },
  accountEvents(id: number): Promise<CodexAccountEvent[]> { return nativeOnly("codex_account_events", { id }); },
  saveAccountDetails(id: number, version: number, input: CodexAccountDetails): Promise<void> { return nativeOnly("codex_save_account_details", { id, version, input }); },
  accountSecret(id: number, field: string, copy = false): Promise<string | null> { return nativeOnly("codex_account_secret", { id, field, copy }); },
  openDefaultCli(): Promise<void> { return nativeOnly("codex_open_default_cli"); },
  closeDefaultProcesses(): Promise<void> { return nativeOnly("codex_close_default_processes"); },
  launchConfig(id: string | null, input: CodexLaunchConfig | null = null): Promise<CodexLaunchConfig> { return nativeOnly("codex_launch_config", { id, input }); },
  authMetadata(id: number): Promise<CodexAuthMetadata> { return nativeOnly("codex_auth_metadata", { id }); },
  forceRefresh(id: number): Promise<CodexAuthMetadata> { return nativeOnly("codex_force_refresh", { id }); },
  bindInstance(id: string, accountId: number): Promise<CodexInstance[]> { return nativeOnly("codex_bind_instance", { id, accountId }); },
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
  openDefault(): Promise<string> { return nativeOnly("codex_open_default"); },
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
  testAccount(id: number, model: string, prompt: string, effort: string): Promise<{ text: string; durationMs: number; inputTokens: number | null; outputTokens: number | null }> { return nativeOnly("codex_test_account", { id, model, prompt, effort }); },
  exportAccountsFile(accountId: number | null = null, accountIds: number[] | null = null, format: CodexExportFormat = "cockpit_tools"): Promise<boolean> { return nativeOnly("codex_export_accounts_file", { accountId, accountIds, format }); },
  instances(): Promise<CodexInstance[]> { return nativeOnly("codex_list_instances"); },
  createInstance(accountId: number, name: string, kind: "cli" | "desktop"): Promise<CodexInstance[] | null> { return nativeOnly("codex_create_instance", { accountId, name, kind }); },
  startInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_start_instance", { id }); },
  stopInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_stop_instance", { id }); },
  deleteInstance(id: string): Promise<CodexInstance[]> { return nativeOnly("codex_delete_instance", { id }); },
  startLogin(accountId: number | null = null): Promise<{ token: string; authUrl: string }> { return nativeOnly("codex_start_login", { accountId }); },
  copyLoginUrl(token: string): Promise<void> { return nativeOnly("codex_copy_login_url", { token }); },
  openLoginUrl(token: string): Promise<void> { return nativeOnly("codex_open_login_url", { token }); },
  pollLogin(token: string): Promise<{ status: "pending" | "completed" }> { return nativeOnly("codex_poll_login", { token }); },
  cancelLogin(token: string): Promise<void> { return nativeOnly("codex_cancel_login", { token }); },
  state(): Promise<CodexState> { return nativeOnly("codex_get_state"); },
  importLocal(): Promise<CodexState> { return nativeOnly("codex_import_local"); },
  importText(content: string): Promise<CodexState> { return nativeOnly("codex_import_text", { content }); },
  importFile(format: CodexExportFormat = "cockpit_tools"): Promise<CodexState | null> { return nativeOnly("codex_import_file", { format }); },
  saveMetadata(input: { id: number; label: string; note: string; tags: string[] }): Promise<CodexAccount> { return nativeOnly("codex_save_metadata", { input }); },
  deleteAccount(id: number): Promise<CodexState> { return nativeOnly("codex_delete_account", { id }); },
  refreshQuota(id: number): Promise<CodexAccount> { return nativeOnly("codex_refresh_quota", { id }); },
  prepareSwitch(id: number): Promise<CodexSwitchPreview> { return nativeOnly("codex_prepare_switch", { id }); },
  confirmSwitch(token: string): Promise<CodexState> { return nativeOnly("codex_confirm_switch", { token }); },
  restoreProfile(): Promise<CodexState> { return nativeOnly("codex_restore_profile"); },
};
