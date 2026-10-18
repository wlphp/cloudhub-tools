import { useCallback, useEffect, useState } from "react";
import type { TrashActions } from "./RecycleBin";
import { trashClient, type TrashSnapshot } from "../platform/clients/trash";

export function useTrashGroups(): { snapshot: TrashSnapshot | null; loading: boolean; error: string; reload: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await trashClient.list());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取回收站失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { snapshot, loading, error, reload };
}

export type TrashPanelState = { busy: boolean; error: string; actions: TrashActions; setScrubDays: (days: number) => Promise<void>; scrubNow: () => Promise<void> };

/** Recycle bin actions shared by the settings entry and per-feature entries. */
export function useTrashActions(reload: () => Promise<void>, onDone?: () => void): TrashPanelState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>, failure: string, done?: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
      // Only a completed restore closes the panel; changing the retention
      // setting or scrubbing secrets keeps the user where they are.
      if (done) onDone?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    setScrubDays: (days) => run(() => trashClient.setScrubDays(days), "保存保留天数失败"),
    scrubNow: () => run(() => trashClient.scrubNow(), "清理密钥失败"),
    actions: {
      restore: (kind, ids) => run(() => trashClient.restore(kind, ids), "恢复失败", true),
      purge: (kind, ids) => run(() => trashClient.purge(kind, ids), "彻底删除失败"),
      confirmPurge: (_kind, count) => window.confirm(`彻底删除 ${count} 项后无法恢复，确定继续吗？`),
    },
  };
}
