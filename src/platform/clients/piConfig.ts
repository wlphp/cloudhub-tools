import { nativeOnly } from "./base";

export const PI_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "bedrock-converse-stream", "mistral-conversations"] as const;
export type PiApi = typeof PI_APIS[number];
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export type PiModelSummary = { id: string; name?: string | null; reasoning: boolean; contextWindow?: number | null; maxTokens?: number | null };
/** keyKind 只描述密钥来源；字面量密钥和 !command 不回传，环境变量名通过 keyReference 展示。 */
export type PiProviderSummary = {
  id: string; name: string; baseUrl?: string | null; api?: string | null;
  keyKind: "none" | "env" | "command" | "literal"; keyReference?: string | null;
  models: PiModelSummary[];
};
export type PiConfigState = {
  agentDir: string; modelsFile: string; settingsFile: string;
  modelsExists: boolean; settingsExists: boolean;
  providers: PiProviderSummary[];
  defaultProvider?: string | null; defaultModel?: string | null; defaultThinkingLevel?: string | null;
  backups: PiConfigBackup[];
};
export type PiConfigBackup = { id: string; file: "models.json" | "settings.json" | "mcp.json"; createdAt: number; legacy?: boolean };
export type PiModelInput = { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; compat?: Record<string, unknown> };
export type PiProviderInput = {
  originalId?: string; id: string; name: string; baseUrl: string; api: PiApi;
  /** 留空表示保留现有密钥。 */
  apiKey?: string;
  compat?: Record<string, unknown>;
  models: PiModelInput[];
};
export type PiConfigAction =
  | { type: "state" | "open_config_directory" }
  | { type: "restore_backup"; id: string }
  | { type: "save"; provider: PiProviderInput }
  | { type: "import_providers"; providers: PiProviderInput[] }
  | { type: "delete"; id: string }
  | { type: "delete_providers"; ids: string[] }
  | { type: "set_default"; provider: string; model: string; thinking?: PiThinkingLevel };

export function piConfigAction(action: PiConfigAction) {
  return nativeOnly<PiConfigState>("pi_config_action", { action });
}

export function piModelCatalog(input: { provider?: string; baseUrl: string; api: PiApi; apiKey?: string }) {
  return nativeOnly<string[]>("pi_config_action", { action: { type: "model_catalog", ...input } });
}

export type PiResource = "usage" | "mcp" | "prompts" | "skills" | "sessions";
export type PiResourceSnapshot = {
  rows: { name: string; detail?: string; source?: string; enabled?: boolean; modifiedAt?: number; calls?: number; tokens?: number }[];
  skipped: number;
};

export function piInspect(resource: PiResource) {
  return nativeOnly<PiResourceSnapshot>("pi_config_action", { action: { type: "inspect", resource } });
}

export function piAddResource(action: { type: "add_mcp"; name: string; url: string } | { type: "add_prompt"; name: string; content: string }) {
  return nativeOnly<PiResourceSnapshot>("pi_config_action", { action });
}

export function piOpenSkillsDirectory() {
  return nativeOnly<null>("pi_config_action", { action: { type: "open_skills_directory" } });
}
