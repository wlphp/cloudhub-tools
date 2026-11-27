import { nativeOnly } from "./base";
import type { ClaudeMode, ClaudeModelMapping, ClaudeProviderInput, ClaudeRoutingConfig, ClaudeRoutingState } from "./claudeProviders";

export type DesktopProvider = Omit<ClaudeProviderInput, "apiKey"> & { keyConfigured: boolean };
export type DesktopSelection = { mode: ClaudeMode; provider: string; members: string[] };
type DesktopConfigPreviewValue = string | number | boolean | null | DesktopConfigPreviewValue[] | { [key: string]: DesktopConfigPreviewValue };
export type DesktopConfigFile = { path: string; status: "readable" | "missing" | "unreadable"; preview: Record<string, DesktopConfigPreviewValue> | null };
type DesktopGatewaySettings = Pick<ClaudeRoutingConfig, "port" | "timeoutSecs" | "firstByteSecs" | "idleSecs" | "logging">;
export type ClaudeDesktopState = { selection: DesktopSelection; applied: boolean; running: boolean; providers: DesktopProvider[]; configFiles: DesktopConfigFile[]; gatewayConfig: ClaudeRoutingConfig };
export type DesktopAction =
  | { type: "state" | "resume" | "open_config_directory" }
  | { type: "save"; provider: ClaudeProviderInput }
  | { type: "delete"; id: string }
  | { type: "import"; ids: string[] }
  | { type: "reorder"; ids: string[] }
  | { type: "save_gateway_settings"; settings: DesktopGatewaySettings }
  | { type: "apply"; selection: DesktopSelection };

export const initialDesktopSelection: DesktopSelection = { mode: "direct", provider: "", members: [] };

export function claudeDesktopAction(action: DesktopAction) {
  return nativeOnly<ClaudeDesktopState>("claude_desktop_action", { action });
}

export async function revealClaudeDesktopConfigKey() {
  const { key } = await nativeOnly<{ key: string }>("claude_desktop_action", { action: { type: "reveal_config_key" } });
  return key;
}

export type DesktopConnectionDiagnosis = {
  mode: ClaudeMode; applied: boolean; normalModeMatches: boolean; thirdPartyModeMatches: boolean;
  profileSelected: boolean; modelCount: number; durationMs: number;
  probe: "official" | "config_mismatch" | "gateway_stopped" | "models_available" | "models_unavailable" | "tcp_available" | "tcp_unavailable";
};

export function getClaudeDesktopRoutingState() {
  return nativeOnly<ClaudeRoutingState | null>("claude_desktop_action", { action: { type: "routing_state" } });
}

export function diagnoseClaudeDesktopConnection() {
  return nativeOnly<DesktopConnectionDiagnosis>("claude_desktop_action", { action: { type: "diagnose_connection" } });
}

export async function revealClaudeDesktopProviderKey(id: string) {
  const { key } = await nativeOnly<{ key: string }>("claude_desktop_action", { action: { type: "reveal_provider_key", id } });
  return key;
}

export function queryClaudeDesktopModels(id: string, draft: ClaudeProviderInput) {
  return nativeOnly<ClaudeModelMapping[]>("claude_desktop_action", {
    action: { type: "model_catalog", id: id || null, draft },
  });
}
