import { nativeOnly } from "./base";
import type { AiImage } from "./ai";
export type PetComputerAction = "shutdown" | "restart" | "taskManager" | "lock" | "explorer";

export interface PetSettings {
  life: PetLifeSettings;
  appearance: "alpaca" | "dog" | "penguin" | "fish";
  enabled: boolean; monitoring: boolean; panels: boolean; panelAccess: boolean; certificates: boolean; servers: boolean;
  size: number; roam: "edge" | "free" | "still"; activity: number; sound: boolean; reducedMotion: boolean;
  quiet: boolean; intervalSeconds: number; expiryDays: number; cpuThreshold: number; diskThreshold: number; keepInTray: boolean;
}
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
export interface PetAlert {
  key: string; title: string; detail: string; section: "panels" | "resources" | "certificates" | "notes";
  severity: "emergency" | "critical" | "warning"; active: boolean; ignored?: boolean; firstSeen: number; updatedAt: number;
  snoozedUntil: number; notifiedAt: number; occurrences: number;
}
export interface PetSnapshot { alerts: PetAlert[]; checkedAt: number; lastError: string | null }
export interface PetChatService { id: string; name: string; model: string; revision: number; supportsImages: boolean }
export interface PetChatMessage { role: "user" | "assistant"; text: string; image?: string }
export const petSeverityRank = (severity: PetAlert["severity"]) => severity === "emergency" ? 3 : severity === "critical" ? 2 : 1;
export const petSeverityLabel = (severity: PetAlert["severity"]) => severity === "emergency" ? "超级严重" : severity === "critical" ? "紧急" : "提醒";
export function sortPetAlerts(alerts: PetAlert[]): PetAlert[] {
  return [...alerts].sort((a, b) => Number(b.active && !b.ignored) - Number(a.active && !a.ignored) || Number(b.active) - Number(a.active) || petSeverityRank(b.severity) - petSeverityRank(a.severity) || b.updatedAt - a.updatedAt);
}
export const defaultPetSettings: PetSettings = {
  life: defaultPetLife,
  appearance: "alpaca",
  enabled: false, monitoring: false, panels: false, panelAccess: true, certificates: true, servers: true,
  size: 120, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false,
  intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false,
};
export const desktopPetClient = {
  lifeState: () => nativeOnly<PetLifeState>("pet_life_state"),
  lifeAction: (id: string, action: "ack" | "snooze" | "testWater" | "openWeather") => nativeOnly<PetLifeState>("pet_life_action", { id, action }),
  lifeWeather: () => nativeOnly<PetLifeState>("pet_life_weather"),
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
};
