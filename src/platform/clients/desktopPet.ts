import { nativeOnly } from "./base";

export interface PetSettings {
  enabled: boolean; monitoring: boolean; panels: boolean; certificates: boolean; servers: boolean;
  size: number; roam: "edge" | "free" | "still"; activity: number; sound: boolean; reducedMotion: boolean;
  quiet: boolean; intervalSeconds: number; expiryDays: number; cpuThreshold: number; diskThreshold: number; keepInTray: boolean;
}
export interface PetAlert {
  key: string; title: string; detail: string; section: "panels" | "resources" | "certificates";
  severity: "critical" | "warning"; active: boolean; firstSeen: number; updatedAt: number;
  snoozedUntil: number; notifiedAt: number; occurrences: number;
}
export interface PetSnapshot { alerts: PetAlert[]; checkedAt: number; lastError: string | null }
export const defaultPetSettings: PetSettings = {
  enabled: false, monitoring: false, panels: false, certificates: true, servers: true,
  size: 160, roam: "edge", activity: 1, sound: false, reducedMotion: false, quiet: false,
  intervalSeconds: 300, expiryDays: 30, cpuThreshold: 90, diskThreshold: 90, keepInTray: false,
};
export const desktopPetClient = {
  settings: () => nativeOnly<PetSettings>("pet_settings"),
  snapshot: () => nativeOnly<PetSnapshot>("pet_snapshot"),
  notice: () => nativeOnly<PetAlert | null>("pet_notice"), dismiss: () => nativeOnly<void>("pet_dismiss"),
  save: (settings: PetSettings) => nativeOnly<void>("pet_save_settings", { settings }),
  show: () => nativeOnly<void>("pet_show"), hide: () => nativeOnly<void>("pet_hide"),
  check: () => nativeOnly<void>("pet_check"),
  layout: (expanded: boolean) => nativeOnly<void>("pet_layout", { expanded }),
  sprite: (column: number, row: number, flipped: boolean) => nativeOnly<void>("pet_sprite", { column, row, flipped }),
  regions: (regions: number[][]) => nativeOnly<void>("pet_regions", { regions }),
  move: (dx: number, dy: number, reset = false, remember = false) => nativeOnly<void>("pet_move", { dx, dy, reset, remember }),
  open: (section: string, key?: string) => nativeOnly<void>("pet_open", { section, key: key ?? null }),
  snooze: (key: string, minutes = 60) => nativeOnly<void>("pet_snooze", { key, minutes }),
};
