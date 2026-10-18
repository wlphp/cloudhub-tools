import { invokeOrWeb, jsonRequest } from "./base";

export type Note = {
  id: number; title: string; body: string; group: string; tags: string[]; account: string; password: string;
  pinned: boolean; remindAt: number | null; remindRepeat: "none" | "daily" | "weekly" | "monthly";
  remindDoneAt: number | null; createdAt: number; updatedAt: number;
  /** Set while the note sits in the recycle bin; `null` for live notes. */
  deletedAt: number | null;
};
export type NoteInput = Omit<Note, "id" | "remindDoneAt" | "createdAt" | "updatedAt" | "deletedAt"> & { id?: number };
export type NoteReminder = { noteId: number; title: string; summary: string; fireAt: number };
export type NotesSnapshot = { notes: Note[]; groups: string[]; reminders: NoteReminder[]; trashed: Note[] };

/** Command names stay literal so `verify:platform-contracts` can match them statically. */
function request<T>(command: string, op: string, args: Record<string, unknown> = {}): Promise<T> {
  return invokeOrWeb<T>(command, args, { path: "/api/notes", init: jsonRequest("POST", { op, args }) });
}

export const notesClient = {
  /** Brings the app to the 备忘录 section from a pet alert; the preview has no windows to open. */
  open: () =>
    invokeOrWeb<void>("notes_open", undefined, () => ({
      path: "/api/notes-open",
      init: jsonRequest("POST", {}),
    })),
  snapshot: () => request<NotesSnapshot>("notes_snapshot", "snapshot"),
  save: (input: NoteInput) => request<number>("notes_save", "save", { input }),
  /** Moves notes to the recycle bin; they stay restorable there. */
  remove: (ids: number[]) => request<number>("notes_delete", "delete", { ids }),
  restore: (ids: number[]) => request<number>("notes_restore", "restore", { ids }),
  /** Irreversibly removes trashed notes. */
  purge: (ids: number[]) => request<number>("notes_purge", "purge", { ids }),
  saveGroup: (name: string) => request<string>("notes_group_save", "group_save", { name }),
  deleteGroup: (name: string, target: string) => request<number>("notes_group_delete", "group_delete", { name, target }),
  completeReminder: (id: number) => request<void>("notes_reminder_complete", "reminder_complete", { id }),
  /** Resolves the pet alert without changing the schedule (完成 is optional). */
  dismissReminder: (id: number) => request<number>("notes_reminder_dismiss", "reminder_dismiss", { id }),
  snoozeReminder: (id: number, minutes: number) => request<number>("notes_reminder_snooze", "reminder_snooze", { id, minutes }),
};
