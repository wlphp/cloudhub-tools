import { preferencesClient } from "../../platform/clients/preferences";

export type AccountGroup = { id: string; name: string; accountIds: number[] };
export type OverviewPreferences = { groups: AccountGroup[]; view: "grid" | "list" | "table"; compact: boolean; showServiceEntry: boolean };
export const overviewPreferenceKey = "codex.overview.v1";
export const emptyOverviewPreferences: OverviewPreferences = { groups: [], view: "grid", compact: false, showServiceEntry: true };

export function parseOverviewPreferences(raw?: string): OverviewPreferences {
  if (!raw || raw.length > 100000) return emptyOverviewPreferences;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return emptyOverviewPreferences;
    const groups: AccountGroup[] = [];
    if (Array.isArray(value.groups)) for (const entry of value.groups.slice(0, 100)) {
      if (!entry || typeof entry.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || !Array.isArray(entry.accountIds) || groups.some(group => group.id === entry.id)) continue;
      groups.push({ id: entry.id, name: entry.name.trim().slice(0, 40), accountIds: [...new Set<number>(entry.accountIds.filter((id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))].slice(0, 1000) });
    }
    return { groups, view: value.view === "list" || value.view === "table" ? value.view : "grid", compact: value.compact === true, showServiceEntry: value.showServiceEntry !== false };
  } catch { return emptyOverviewPreferences; }
}

export async function readOverviewPreferences() {
  const values = await preferencesClient.list();
  return parseOverviewPreferences(values[overviewPreferenceKey]);
}
export function saveOverviewPreferences(value: OverviewPreferences) {
  return preferencesClient.save(overviewPreferenceKey, JSON.stringify(value));
}
