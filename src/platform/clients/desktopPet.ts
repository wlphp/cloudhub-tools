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
  enabled: boolean; monitoring: boolean; panels: boolean; panelAccess: boolean; certificates: boolean; servers: boolean;
  excludedAssetAlerts: string[];
  size: number; roam: "edge" | "free" | "still"; activity: number; sound: boolean; reducedMotion: boolean;
  quiet: boolean; intervalSeconds: number; expiryDays: number; cpuThreshold: number; diskThreshold: number; keepInTray: boolean;
  voice: PetVoiceSettings;
}
export interface PetVoiceSettings {
  enabled: boolean; wakeEnabled: boolean; wakeWord: string; modelFile: string; language: string; autoSend: boolean; maxSeconds: number;
}
export const defaultPetVoice: PetVoiceSettings = { enabled: true, wakeEnabled: false, wakeWord: "小驼", modelFile: "", language: "zh", autoSend: true, maxSeconds: 60 };
export interface PetVoiceModel { name: string; sizeBytes: number }
export interface PetVoiceStatus { modelsDir: string; models: PetVoiceModel[]; catalog: PetVoiceModel[]; selected: string | null; ready: boolean; listening: boolean }
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
export interface PetChatService { id: string; name: string; model: string; revision: number; supportsImages: boolean }
export interface PetChatMessage { role: "user" | "assistant"; text: string; image?: string }
export const petSeverityLabel = monitorSeverityLabel;
export const sortPetAlerts = sortMonitorAlerts;
export const defaultPetSettings: PetSettings = {
  life: defaultPetLife,
  appearance: "alpaca",
  enabled: false, monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true, excludedAssetAlerts: [],
  size: 120, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false,
  intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false,
  voice: defaultPetVoice,
};
export const desktopPetClient = {
  lifeState: () => nativeOnly<PetLifeState>("pet_life_state"),
  lifeAction: (id: string, action: "ack" | "snooze" | "testWater" | "openWeather") => nativeOnly<PetLifeState>("pet_life_action", { id, action }),
  lifeWeather: () => nativeOnly<PetLifeState>("pet_life_weather"),
  voiceStatus: () => nativeOnly<PetVoiceStatus>("pet_voice_status"),
  voiceTranscribe: (audio: string) => nativeOnly<string>("pet_voice_transcribe", { audio }),
  voiceIntent: (requestId: string, service: PetChatService, text: string) => nativeOnly<PetVoiceIntent>("pet_voice_intent", { requestId, profileId: service.id, revision: service.revision, text }),
  openVoiceModelsDir: () => nativeOnly<void>("pet_voice_open_models_dir"),
  voiceDownloadModel: (name: string, onProgress: (progress: PetVoiceDownloadProgress) => void) => nativeOnly<PetVoiceStatus>("pet_voice_download_model", { name, onProgress: new Channel<PetVoiceDownloadProgress>(onProgress) }),
  voiceCancelModelDownload: () => nativeOnly<void>("pet_voice_cancel_model_download"),
  chatServices: () => nativeOnly<PetChatService[]>("pet_chat_services"),
  chat: (requestId: string, service: PetChatService, messages: PetChatMessage[], image?: AiImage) => nativeOnly<string>("pet_chat", { requestId, profileId: service.id, revision: service.revision, messages: messages.map(({ role, text }) => ({ role, text })), image: image ?? null }),
  readChatImage: (sourcePath: string) => nativeOnly<string>("pet_chat_read_image", { sourcePath }),
  cancelChat: (requestId: string) => nativeOnly<void>("pet_chat_cancel", { requestId }),
  settings: () => nativeOnly<PetSettings>("pet_settings"),
  snapshot: () => nativeOnly<PetSnapshot>("pet_snapshot"),
  notice: () => nativeOnly<PetAlert | null>("pet_notice"), dismiss: () => nativeOnly<void>("pet_dismiss"),
  save: (settings: PetSettings) => nativeOnly<void>("pet_save_settings", { settings }),
  show: () => nativeOnly<void>("pet_show"), hide: () => nativeOnly<void>("pet_hide"),
  check: () => nativeOnly<void>("pet_check"),
  layout: (expanded: boolean, enlarged = false) => nativeOnly<void>("pet_layout", { expanded, enlarged }),
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
