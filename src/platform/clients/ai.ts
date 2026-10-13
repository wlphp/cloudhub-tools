import { nativeOnly } from "./base";
import { Channel } from "@tauri-apps/api/core";
import { runningInTauri } from "../api";

export type AiProtocol = "openai_chat" | "openai_responses" | "claude" | "gemini";
export type AiProfile = {
  id: string; name: string; protocol: AiProtocol; baseUrl: string; model: string;
  enabled: boolean; isDefault: boolean; timeoutSeconds: number; maxOutputTokens: number;
  allowLoopbackHttp: boolean; hasKey: boolean; updatedAt: number; visionStatus: "unknown" | "supported" | "unsupported";
};
export type AiProfileInput = Omit<AiProfile, "id" | "hasKey" | "updatedAt" | "visionStatus"> & { id?: string; apiKey?: string };
export type AiTask = "connection" | "server" | "dns" | "panel" | "asset" | "command" | "diagnose" | "configuration" | "search" | "frp";
export type AiFields = Record<string, string | number | null>;
export type AiDraft = { summary: string; fields: AiFields; items: AiFields[]; warnings: string[]; evidence: string[] };
export type AiReply = { requestId: string; draft: AiDraft; inputTokens: number | null; outputTokens: number | null };
export type AiPreview = { text: string; removedLines: number };
export type AiImportPreview = { token: string; profiles: AiProfile[] };
export type AiProgress = { requestId:string; phase:"connecting"|"receiving"|"validating"|"done"; receivedBytes:number };
export type AiImage = { dataUrl:string; reviewed:boolean };
type ServiceInput={requestId:string;profileId:string;expectedRevision:number};

export const aiClient = {
  list: () => nativeOnly<AiProfile[]>("ai_list_profiles"),
  save: (input: AiProfileInput) => nativeOnly<AiProfile>("ai_save_profile", { input }),
  remove: (id: string) => nativeOnly<void>("ai_delete_profile", { id }),
  preview: (text: string) => nativeOnly<AiPreview>("ai_preview", { text }),
  run: (input: ServiceInput & { task: AiTask; text: string; image?:AiImage; streaming?:boolean },onProgress?:(progress:AiProgress)=>void) => nativeOnly<AiReply>("ai_run", { input, ...(runningInTauri?{onProgress:new Channel<AiProgress>(onProgress||(()=>{}))}:{}) }),
  models: (input:ServiceInput) => nativeOnly<string[]>("ai_list_models", {input}),
  testVision: (input:ServiceInput) => nativeOnly<{profile:AiProfile;passed:boolean}>("ai_test_vision", {input}),
  cancel: (requestId: string) => nativeOnly<void>("ai_cancel", { requestId }),
  exportConfig: (ids: string[]) => nativeOnly<boolean>("ai_export_config", { ids }),
  prepareImport: (content: string) => nativeOnly<AiImportPreview>("ai_prepare_import", { content }),
  confirmImport: (token: string, ids: string[]) => nativeOnly<number>("ai_confirm_import", { token, ids }),
  cancelImport: (token: string) => nativeOnly<void>("ai_cancel_import", { token }),
};
