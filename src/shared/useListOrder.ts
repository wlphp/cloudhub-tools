import { useEffect, useRef, useState } from "react";
import { runningInTauri } from "../platform/api";
import { preferencesClient } from "../platform/clients/preferences";

function parseOrder(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}

/** Only stable identifiers are stored; resource data stays in its owning client. */
export function useListOrder(key: string) {
  const [order, setOrder] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        const raw = runningInTauri ? (await preferencesClient.list())[key] : localStorage.getItem(key);
        if (!cancelled) { setOrder(parseOrder(raw)); setReady(true); setError(""); }
      } catch { if (!cancelled) setError("无法读取排序设置，请重试。"); }
    })();
    return () => { cancelled = true; };
  }, [key, revision]);

  function sort<T>(items: readonly T[], id: (item: T) => string): T[] {
    const positions = new Map(order.map((value, index) => [value, index]));
    return [...items].sort((a, b) => (positions.get(id(a)) ?? Infinity) - (positions.get(id(b)) ?? Infinity));
  }
  async function move(ids: string[], source: string, target: string) {
    const from = ids.indexOf(source), to = ids.indexOf(target);
    if (!ready || pending.current || from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    const previous = order;
    pending.current = true; setSaving(true); setOrder(next); setError("");
    try {
      const raw = JSON.stringify(next);
      if (runningInTauri) await preferencesClient.save(key, raw);
      else localStorage.setItem(key, raw);
    } catch { setOrder(previous); setError("排序保存失败，已恢复原顺序，请重试。"); }
    finally { pending.current = false; setSaving(false); }
  }
  return { sort, move, ready, saving, error, retry: () => setRevision(value => value + 1) };
}
