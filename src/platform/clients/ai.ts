import { invokeOrWeb, jsonRequest, nativeOnly } from "./base";
import { Channel } from "@tauri-apps/api/core";
import { runningInTauri } from "../api";

export type AiProtocol = "openai_chat" | "openai_responses" | "claude" | "gemini";
export type AiProfile = {
  id: string; name: string; protocol: AiProtocol; baseUrl: string; model: string; models?: string[];
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
  readImageFile: (sourcePath: string) => nativeOnly<string>("ai_read_image_file", { sourcePath }),
  revealKey: (id: string, expectedRevision: number) => invokeOrWeb<string>("ai_reveal_key", { id, expectedRevision }, { path: "/api/ai/reveal", init: jsonRequest("POST", { id, expectedRevision }) }).then(value => typeof value === "string" ? value : (value as unknown as { key: string }).key),
  list: () => invokeOrWeb<AiProfile[]>("ai_list_profiles", undefined, { path: "/api/ai/profiles" }),
  save: (input: AiProfileInput) => invokeOrWeb<AiProfile>("ai_save_profile", { input }, { path: "/api/ai/profiles", init: jsonRequest("POST", input) }),
  remove: (id: string) => invokeOrWeb<void>("ai_delete_profile", { id }, { path: `/api/ai/profiles/${encodeURIComponent(id)}`, init: { method: "DELETE" } }),
  preview: (text: string) => invokeOrWeb<AiPreview>("ai_preview", { text }, { path: "/api/ai/preview", init: jsonRequest("POST", { text }) }),
  run: (input: ServiceInput & { task: AiTask; text: string; image?:AiImage; streaming?:boolean; model?:string },onProgress?:(progress:AiProgress)=>void) => runningInTauri
    ? nativeOnly<AiReply>("ai_run", { input, onProgress: new Channel<AiProgress>(onProgress || (()=>{})) })
    : invokeOrWeb<AiReply>("ai_run", { input }, { path: "/api/ai/run", init: jsonRequest("POST", input) }),
  models: (input:{requestId:string;profileId?:string;expectedRevision?:number;draft?:Pick<AiProfileInput,"protocol"|"baseUrl"|"apiKey"|"allowLoopbackHttp"|"timeoutSeconds">}) => invokeOrWeb<string[]>("ai_list_models", { input }, { path: "/api/ai/models", init: jsonRequest("POST", input) }),
  testVision: (input:ServiceInput) => nativeOnly<{profile:AiProfile;passed:boolean}>("ai_test_vision", {input}),
  cancel: (requestId: string) => invokeOrWeb<void>("ai_cancel", { requestId }, { path: "/api/ai/cancel", init: jsonRequest("POST", { requestId }) }),
  exportConfig: (ids: string[]) => nativeOnly<boolean>("ai_export_config", { ids }),
  prepareImport: (content: string) => nativeOnly<AiImportPreview>("ai_prepare_import", { content }),
  confirmImport: (token: string, ids: string[]) => nativeOnly<number>("ai_confirm_import", { token, ids }),
  cancelImport: (token: string) => nativeOnly<void>("ai_cancel_import", { token }),
};
