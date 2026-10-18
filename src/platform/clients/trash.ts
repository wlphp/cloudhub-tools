import { invokeOrWeb } from "./base";

/** Row id as a string: text-keyed tables (authenticator) need this form. */
export type TrashEntry = { kind: string; id: string; title: string; deletedAt: number };
export type TrashGroup = { kind: string; label: string; items: TrashEntry[] };
/** Bin contents plus the credential-retention setting. */
export type TrashSnapshot = { groups: TrashGroup[]; scrubDays: number; scrubbedNow: number };

/** Global recycle bin. `kind` is a table id validated by the Rust layer. */
export const trashClient = {
  list: () => invokeOrWeb<TrashSnapshot>("trash_list", undefined, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "list" }) } }),
  restore: (kind: string, ids: string[]) => invokeOrWeb<number>("trash_restore", { kind, ids }, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "restore", kind, ids }) } }),
  purge: (kind: string, ids: string[]) => invokeOrWeb<number>("trash_purge", { kind, ids }, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "purge", kind, ids }) } }),
  /** Credential retention in days; `0` keeps them forever. */
  setScrubDays: (days: number) => invokeOrWeb<number>("trash_set_scrub_days", { days }, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "set_scrub_days", days }) } }),
  /** Clears credentials on every trashed row right away. */
  scrubNow: () => invokeOrWeb<number>("trash_scrub_now", undefined, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "scrub_now" }) } }),
  empty: () => invokeOrWeb<number>("trash_empty", undefined, { path: "/api/trash", init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "empty" }) } }),
};
