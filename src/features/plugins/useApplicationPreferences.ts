import { useEffect, useRef, useState } from "react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { preferencesClient } from "../../platform/clients/preferences";
import { APPLICATION_PREFERENCES_KEY, applicationCatalog, applicationPreference, parseApplicationPreferences, sortedApplications, type ApplicationPreference, type ApplicationPreferences } from "./applicationCatalog";

function cachedPreferences() {
  try { return parseApplicationPreferences(localStorage.getItem(APPLICATION_PREFERENCES_KEY)); } catch { return {}; }
}

/** App owns this state; the store and sidebar receive the same confirmed preferences. */
export function useApplicationPreferences() {
  const [preferences, setPreferences] = useState<ApplicationPreferences>(cachedPreferences);
  const [ready, setReady] = useState(!runningInTauri);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!runningInTauri) return;
    let cancelled = false;
    setReady(false);
    void preferencesClient.list().then(values => {
      if (cancelled) return;
      setPreferences(values[APPLICATION_PREFERENCES_KEY] === undefined ? cachedPreferences() : parseApplicationPreferences(values[APPLICATION_PREFERENCES_KEY]));
      setReady(true); setError("");
    }).catch(() => { if (!cancelled) setError("无法读取菜单设置，请重试；当前设置未被覆盖。"); });
    return () => { cancelled = true; };
  }, [revision]);

  async function persist(next: ApplicationPreferences) {
    const raw = JSON.stringify(next);
    pending.current = true; setSaving(true); setError("");
    try {
      if (runningInTauri) await preferencesClient.save(APPLICATION_PREFERENCES_KEY, raw);
      else localStorage.setItem(APPLICATION_PREFERENCES_KEY, raw);
      setPreferences(next);
      if (runningInTauri) { try { localStorage.setItem(APPLICATION_PREFERENCES_KEY, raw); } catch { /* SQLite is authoritative on desktop. */ } }
    } catch (reason) {
      const detail = platformErrorMessage(reason, "未知错误");
      setError(`菜单设置保存失败，本次修改未生效：${detail}`);
    }
    finally { pending.current = false; setSaving(false); }
  }
  async function update(id: string, patch: Partial<ApplicationPreference>) {
    if (!ready || pending.current) return;
    const app = applicationCatalog.find(item => item.id === id);
    if (!app) return;
    if (patch.order !== undefined && (!Number.isInteger(patch.order) || patch.order < 1 || patch.order > applicationCatalog.length)) return;
    await persist({ ...preferences, [id]: { ...applicationPreference(app, preferences), ...patch } });
  }
  async function updateOrder(id: string, position: number) {
    if (!ready || pending.current || !Number.isInteger(position) || position < 1 || position > applicationCatalog.length) return;
    const ordered = sortedApplications(preferences);
    const currentIndex = ordered.findIndex(app => app.id === id);
    if (currentIndex < 0 || currentIndex + 1 === position) return;
    const [moved] = ordered.splice(currentIndex, 1);
    ordered.splice(position - 1, 0, moved);
    const next = { ...preferences };
    ordered.forEach((app, index) => { next[app.id] = { ...applicationPreference(app, preferences), order: index + 1 }; });
    await persist(next);
  }
  return { preferences, ready, saving, error, update, updateOrder, retry: () => setRevision(value => value + 1), dismissError: () => setError("") };
}
export type ApplicationPreferenceState = ReturnType<typeof useApplicationPreferences>;
