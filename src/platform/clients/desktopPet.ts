import { nativeOnly } from "./base";
import { Channel } from "@tauri-apps/api/core";
import type { AiImage } from "./ai";
import { monitorSeverityLabel, sortMonitorAlerts, type MonitorAlert, type MonitorSnapshot } from "./monitorAlerts";
export type PetAlert = MonitorAlert;
export type PetSnapshot = MonitorSnapshot;
export type PetComputerAction = "shutdown" | "restart" | "taskManager" | "lock" | "explorer";

export interface PetSettings {
  life: PetLifeSettings;
  appearance: "alpaca" | "dog" | "penguin" | "fish";
  enabled: boolean; monitoring: boolean; panels: boolean; panelDisk: boolean; panelServices: boolean; panelAccess: boolean; certificates: boolean; servers: boolean;
  lightServers: boolean; domains: boolean; databases: boolean; redis: boolean;
  excludedAssetAlerts: string[];
  size: number; roam: "edge" | "free" | "still"; activity: number; sound: boolean; reducedMotion: boolean;
  quiet: boolean; intervalSeconds: number; expiryDays: number; cpuThreshold: number; diskThreshold: number; keepInTray: boolean;
  voice: PetVoiceSettings;
}
export type PetSpeechPreset = "system" | "warm" | "clear" | "bright" | "steady" | "mimoBingtang" | "mimoMoli";
export const isMimoSpeechPreset = (preset: PetSpeechPreset | undefined): preset is "mimoBingtang" | "mimoMoli" => preset === "mimoBingtang" || preset === "mimoMoli";

export interface PetVoiceSettings {
  enabled: boolean; wakeEnabled: boolean; wakeWord: string; modelFile: string; language: string; autoSend: boolean; speak: boolean; device: string; cloudAsrEnabled: boolean;
  speechPreset: PetSpeechPreset;
  speechMimoProfileId: string;
  /** 云端识别服务商："openai" 复用 AI 配置的 OpenAI 兼容接口，"xfyun" 为讯飞语音听写（独立加密凭据）。 */
  cloudProvider: "openai" | "xfyun"; cloudProfileId: string; cloudEndpoint: string; cloudModel: string; maxSeconds: number;
}
export const defaultPetVoice: PetVoiceSettings = { enabled: true, wakeEnabled: false, wakeWord: "小小驼", modelFile: "", language: "zh", autoSend: true, speak: true, speechPreset: "system", speechMimoProfileId: "", device: "", cloudAsrEnabled: false, cloudProvider: "openai", cloudProfileId: "", cloudEndpoint: "", cloudModel: "", maxSeconds: 60 };
/** 讯飞语音听写凭据：随设置保存一次性传给后端加密落库，不回读。 */
export interface PetVoiceXfyunCredentials { appId: string; apiKey: string; apiSecret: string }
export interface PetVoiceModel { name: string; sizeBytes: number }
export interface PetVoiceStatus { modelsDir: string; models: PetVoiceModel[]; catalog: PetVoiceModel[]; selected: string | null; ready: boolean; listening: boolean; device: string; devices: string[]; activeDevice: string; listeningError: string | null; lastResult: "transcribing" | "unclear" | "unmatched" | "awakened" | "command" | "failed" | null; segments: number; matched: number; xfyunConfigured: boolean }
export interface PetVoiceDownloadProgress { stage: "connecting" | "downloading" | "done"; source: string; downloadedBytes: number; totalBytes: number | null; bytesPerSecond: number }
export interface PetVoiceIntent { action: string; text: string; summary: string }
export interface PetLifeSettings {
  enabled: boolean; province: string; city: string; weather: boolean; schedule: boolean;
  workStart: string; lunchStart: string; lunchEnd: string; workEnd: string; leaveBefore: number;
  ignoreHolidays: boolean; restDates: string[]; workDates: string[];
  water: boolean; waterMinutes: number; waterRoam: boolean; stretch: boolean; stretchMinutes: number;
}
export interface PetLifeNotice {
  id: string; kind: string; title: string; detail: string; createdAt: number; dueAt: number;
  expiresAt: number; acknowledged: boolean; level: number; url: string | null;
}
export interface PetLifeState {
  notices: PetLifeNotice[]; weatherCheckedAt: number; weatherAttemptAt: number; weatherError: string | null;
  region: string; calendarYear: number; calendarSupported: boolean;
}
export const defaultPetLife: PetLifeSettings = {
  enabled: false, province: "", city: "", weather: false, schedule: true,
  workStart: "09:00", lunchStart: "12:00", lunchEnd: "13:30", workEnd: "18:00", leaveBefore: 10,
  ignoreHolidays: true, restDates: [], workDates: [], water: true, waterMinutes: 60, waterRoam: true, stretch: false, stretchMinutes: 90,
};
export const emptyPetLifeState: PetLifeState = { notices: [], weatherCheckedAt: 0, weatherAttemptAt: 0, weatherError: null, region: "", calendarYear: 0, calendarSupported: false };
export interface PetChatService { id: string; name: string; model: string; revision: number; supportsImages: boolean; supportsMimoSpeech: boolean }
export interface PetChatMessage { role: "user" | "assistant"; text: string; image?: string }
export interface PetChatTurn { id: number | string; user: string; reply: string; image?: string; local?: boolean }
export interface PetChatHistoryPage { turns: PetChatTurn[]; hasOlder: boolean }
export type PetChatResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const petSeverityLabel = monitorSeverityLabel;
export const sortPetAlerts = sortMonitorAlerts;
export const defaultPetSettings: PetSettings = {
  life: defaultPetLife,
  appearance: "alpaca",
  enabled: false, monitoring: false, panels: false, panelDisk: false, panelServices: false, panelAccess: true, certificates: true, servers: true,
  lightServers: true, domains: true, databases: true, redis: true, excludedAssetAlerts: [],
  size: 120, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false,
  intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false,
  voice: defaultPetVoice,
};
export const desktopPetClient = {
  lifeState: () => nativeOnly<PetLifeState>("pet_life_state"),
  lifeAction: (id: string, action: "ack" | "snooze" | "testWater" | "openWeather") => nativeOnly<PetLifeState>("pet_life_action", { id, action }),
  lifeWeather: () => nativeOnly<PetLifeState>("pet_life_weather"),
  voiceStatus: () => nativeOnly<PetVoiceStatus>("pet_voice_status"),
  voiceSpeak: (text: string | null, interrupt = false, previewPreset?: PetSpeechPreset) => nativeOnly<void>("pet_voice_speak", { text, interrupt, previewPreset: previewPreset ?? null }),
  voiceContinue: (commandId: number) => nativeOnly<void>("pet_voice_continue", { commandId }),
  voiceTranscribe: (audio: string) => nativeOnly<string | null>("pet_voice_transcribe", { audio }),
  voiceIntent: (requestId: string, service: PetChatService, text: string) => nativeOnly<PetVoiceIntent>("pet_voice_intent", { requestId, profileId: service.id, revision: service.revision, text }),
  openVoiceModelsDir: () => nativeOnly<void>("pet_voice_open_models_dir"),
  voiceDownloadModel: (name: string, onProgress: (progress: PetVoiceDownloadProgress) => void) => nativeOnly<PetVoiceStatus>("pet_voice_download_model", { name, onProgress: new Channel<PetVoiceDownloadProgress>(onProgress) }),
  voiceCancelModelDownload: () => nativeOnly<void>("pet_voice_cancel_model_download"),
  chatServices: () => nativeOnly<PetChatService[]>("pet_chat_services"),
  chatLookup: (message: string, hasImage = false) => nativeOnly<string | null>("pet_chat_lookup", { message, hasImage }),
  chat: (requestId: string, service: PetChatService, message: string, image?: AiImage) => nativeOnly<PetChatTurn>("pet_chat", { requestId, profileId: service.id, revision: service.revision, message, image: image ?? null }),
  chatHistory: (before?: number) => nativeOnly<PetChatHistoryPage>("pet_chat_history", { before: before ?? null }),
  clearChatHistory: () => nativeOnly<void>("pet_chat_clear_history"),
  readChatImage: (sourcePath: string) => nativeOnly<string>("pet_chat_read_image", { sourcePath }),
  cancelChat: (requestId: string) => nativeOnly<void>("pet_chat_cancel", { requestId }),
  settings: () => nativeOnly<PetSettings>("pet_settings"),
  snapshot: () => nativeOnly<PetSnapshot>("pet_snapshot"),
  notice: () => nativeOnly<PetAlert | null>("pet_notice"), dismiss: () => nativeOnly<void>("pet_dismiss"),
  save: (settings: PetSettings, xfyunCredentials?: PetVoiceXfyunCredentials) => nativeOnly<void>("pet_save_settings", { settings, xfyunCredentials: xfyunCredentials ?? null }),
  show: () => nativeOnly<void>("pet_show"), hide: () => nativeOnly<void>("pet_hide"),
  check: () => nativeOnly<void>("pet_check"),
  layout: (expanded: boolean, enlarged = false, chat = false, pinned = true) => nativeOnly<void>("pet_layout", { expanded, enlarged, chat, pinned }),
  resizeChat: (edge: PetChatResizeEdge, dx: number, dy: number, start: boolean) => nativeOnly<void>("pet_resize_chat", { edge, dx, dy, start }),
  sprite: (column: number, row: number, flipped: boolean, appearance: PetSettings["appearance"] = "alpaca") => nativeOnly<void>("pet_sprite", { column, row, flipped, appearance }),
  regions: (regions: number[][]) => nativeOnly<void>("pet_regions", { regions }),
  move: (dx: number, dy: number, reset = false, remember = false, dock = false) => nativeOnly<void>("pet_move", { dx, dy, reset, remember, dock }),
  reveal: () => nativeOnly<void>("pet_move", { dx: 0, dy: 0, reset: false, remember: false, reveal: true }),
  open: (section: string, key?: string) => nativeOnly<void>("pet_open", { section, key: key ?? null }),
  computerAction: (action: PetComputerAction) => nativeOnly<void>("pet_computer_action", { action }),
  snooze: (key: string, minutes = 60) => nativeOnly<void>("pet_snooze", { key, minutes }),
  ignore: (keys: string[], ignored = true) => nativeOnly<PetSnapshot>("pet_ignore", { keys, ignored }),
  clearSelected: (keys: string[]) => nativeOnly<PetSnapshot>("pet_clear_selected", { keys }),
};
