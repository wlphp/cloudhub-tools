import { nativeOnly } from "./base";

export interface CodexHistoryEntry {
  id: string; home: string; instanceId: string | null; createdAt: number | null; migratedAt: number | null;
  source: string; mode: string; summary: string; complete: boolean; pinned: boolean; pending: boolean;
}
export interface CodexHistoryTarget { id: string | null; name: string; home: string; version: string; pending: boolean }
export interface CodexHistoryState { entries: CodexHistoryEntry[]; targets: CodexHistoryTarget[] }
export type CodexHistoryAction = "manual" | "restore" | "recover" | "pin" | "delete";
export const codexHistory = {
  list: (): Promise<CodexHistoryState> => nativeOnly("codex_history_list"),
  action: (action: CodexHistoryAction, target: CodexHistoryTarget | null, entry: CodexHistoryEntry | null = null, pinned: boolean | null = null): Promise<CodexHistoryState> => nativeOnly("codex_history_action", { action, target: target?.id ?? null, snapshotId: entry?.id ?? null, version: target?.version ?? null, pinned }),
};
