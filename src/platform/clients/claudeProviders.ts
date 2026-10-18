import { invokeOrWeb, jsonRequest, nativeOnly } from "./base";

/** 上游协议格式。 */
export type ClaudeApiFormat = "anthropic" | "openai_chat" | "openai_responses" | "gemini";
/** Claude Code 读取凭据的字段名。 */
export type ClaudeApiKeyField = "auth_token" | "api_key";

export type ClaudeModelMapping = { model: string; displayName?: string; supports1m?: boolean };

export type ClaudeApiKeyFieldChoice = "auth_token" | "api_key";

export type ClaudeProviderInput = {
  id: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyField?: ClaudeApiKeyFieldChoice;
  apiFormat?: ClaudeApiFormat;
  isFullUrl?: boolean;
  models?: Record<string, ClaudeModelMapping>;
  extraEnv?: Record<string, unknown>;
  officialLogin?: boolean;
  modelCatalog?: ClaudeModelMapping[];
  /** 自定义 User-Agent，路由/聚合生效 */
  userAgent?: string;
  /** 本地代理请求 Header 覆盖 JSON */
  proxyHeaderOverride?: string;
  /** 本地代理请求 Body 覆盖 JSON */
  proxyBodyOverride?: string;
  /** 默认兜底模型（路由/聚合生效） */
  fallbackModel?: ClaudeModelMapping | null;
};

export type ClaudeMode = "direct" | "route" | "aggregate";
export type ClaudeRoutingConfig = {
  port: number; routeProvider: string; defaultProvider: string; members: string[];
  failover: boolean; queue: string[]; retries: number; timeoutSecs: number;
  firstByteSecs: number; idleSecs: number; failureThreshold: number; cooldownSecs: number; logging: boolean;
};
export const DEFAULT_CLAUDE_ROUTING: ClaudeRoutingConfig = {
  port: 15721, routeProvider: "", defaultProvider: "", members: [], failover: false, queue: [],
  retries: 2, timeoutSecs: 600, firstByteSecs: 90, idleSecs: 180, failureThreshold: 8, cooldownSecs: 90, logging: true,
};
export type ClaudeRequestLog = {
  id: string; timestamp: number; providerId: string; model: string; actualModel: string; status: number;
  durationMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
};
export type ClaudeRoutingState = {
  mode: ClaudeMode; running: boolean; address: string | null; config: ClaudeRoutingConfig;
  health: Record<string, { failures: number; openUntil: number | null }>;
  logs: ClaudeRequestLog[]; activeProvider: string; recoveryAvailable: boolean;
};
export type ClaudePrompt = { id: string; name: string; content: string };
export type ClaudeWorkspaceState = {
  project: string | null; settingsPath: string; mcpPath: string; promptPath: string;
  mcp: { name: string; enabled: boolean; transport: string; command: string; url: string; hasSecrets: boolean }[];
  prompts: ClaudePrompt[]; activePrompt: string | null;
  skills: { name: string; description: string; trashed: boolean; key: string }[];
  sessions: { key: string; id: string; title: string; project: string; modifiedAt: number; bytes: number; trashed: boolean }[];
  environmentConflicts: string[];
};
export type ClaudeWorkspaceAction =
  | { type: "save_mcp"; name: string; config: Record<string, unknown> }
  | { type: "toggle_mcp"; name: string; enabled: boolean }
  | { type: "delete_mcp"; name: string }
  | { type: "save_prompt"; prompt: ClaudePrompt }
  | { type: "delete_prompt" | "activate_prompt"; id: string }
  | { type: "restore_file"; kind: "mcp" | "prompt" }
  | { type: "trash_skill" | "restore_skill" | "trash_session" | "restore_session"; key: string };
export const claudeWorkbenchClient = {
  state: () => nativeOnly<ClaudeRoutingState>("claude_routing_state"),
  saveRouting: (config: ClaudeRoutingConfig) => nativeOnly<void>("claude_routing_save", { config }),
  activate: (mode: ClaudeMode) => nativeOnly<void>("claude_routing_activate", { mode }),
  clearLogs: () => nativeOnly<void>("claude_routing_clear_logs"),
  providerAction: (action: { type: "duplicate"; id: string } | { type: "move"; id: string; offset: number } | { type: "import_current" }) =>
    nativeOnly<void>("claude_provider_action", { action }),
  probe: (id: string) => nativeOnly<{ reachable: boolean; status: number | null; latencyMs: number }>("claude_provider_probe", { id }),
  models: (id: string) => nativeOnly<ClaudeModelMapping[]>("claude_provider_models", { id }),
  workspace: () => nativeOnly<ClaudeWorkspaceState>("claude_workspace_state"),
  workspaceAction: (action: ClaudeWorkspaceAction) => nativeOnly<void>("claude_workspace_action", { action }),
  chooseProject: (clear = false) => nativeOnly<string | null>("claude_workspace_project", { clear }),
  installSkill: () => nativeOnly<boolean>("claude_skill_install"),
  sessionPreview: (key: string) => nativeOnly<string>("claude_session_preview", { key }),
  /** 使用指定供应商的当前设置启动 Claude Code CLI（桌面端），浏览器预览下不可用。 */
  launchCli: (id: string) => nativeOnly<void>("claude_launch_cli", { id }),
  /** 单独解密某家供应商的 API Key（仅桌面端），浏览器预览下不可用。 */
  revealProvider: (id: string) => nativeOnly<string>("claude_provider_reveal", { id }),
};

/** 列表项；密钥本身不返回，只给 `keyConfigured`。 */
export type ClaudeProviderSummary = Omit<ClaudeProviderInput, "apiKey"> & {
  keyConfigured: boolean;
  isCurrent: boolean;
};

export type ClaudeProviderList = {
  providers: ClaudeProviderSummary[];
  currentId: string | null;
  settingsPath: string;
  settingsExists: boolean;
  hasBackup: boolean;
};

const post = (op: string, args: Record<string, unknown> = {}) => ({
  path: "/api/claude-providers",
  init: jsonRequest("POST", { op, args }),
});

/** Claude Code 供应商管理；写入 `~/.claude/settings.json`。桌面端原生，浏览器预览受限。 */
export const claudeProvidersClient = {
  list: () => invokeOrWeb<ClaudeProviderList>("claude_provider_list", undefined, post("list")),
  save: (provider: ClaudeProviderInput) => invokeOrWeb<void>("claude_provider_save", { provider }, post("save", { provider })),
  remove: (id: string) => invokeOrWeb<number>("claude_provider_delete", { id }, post("delete", { id })),
  /** 备份后把该供应商写入 live 配置并标记为当前生效。 */
  switchTo: (id: string) => invokeOrWeb<void>("claude_provider_switch", { id }, post("switch", { id })),
  restoreBackup: () => invokeOrWeb<void>("claude_provider_restore_backup", undefined, post("restore_backup")),
  currentSettings: () => invokeOrWeb<unknown>("claude_provider_current_settings", undefined, post("current_settings")),
};
