import { useEffect, useRef, useState } from "react";
import { runningInTauri } from "../../platform/api";
import { preferencesClient } from "../../platform/clients/preferences";
import { APPLICATION_PREFERENCES_KEY, applicationCatalog, applicationPreference, parseApplicationPreferences, type ApplicationPreference, type ApplicationPreferences } from "./applicationCatalog";

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

  async function update(id: string, patch: Partial<ApplicationPreference>) {
    if (!ready || pending.current) return;
    const app = applicationCatalog.find(item => item.id === id);
    if (!app) return;
    if (patch.order !== undefined && (!Number.isInteger(patch.order) || patch.order < 0 || patch.order > 9999)) return;
    const next = { ...preferences, [id]: { ...applicationPreference(app, preferences), ...patch } };
    const raw = JSON.stringify(next);
    pending.current = true; setSaving(true); setError("");
    try {
      if (runningInTauri) await preferencesClient.save(APPLICATION_PREFERENCES_KEY, raw);
      else localStorage.setItem(APPLICATION_PREFERENCES_KEY, raw);
      setPreferences(next);
      if (runningInTauri) { try { localStorage.setItem(APPLICATION_PREFERENCES_KEY, raw); } catch { /* SQLite is authoritative on desktop. */ } }
    } catch { setError("菜单设置保存失败，本次修改未生效，请重试。"); }
    finally { pending.current = false; setSaving(false); }
  }
  return { preferences, ready, saving, error, update, retry: () => setRevision(value => value + 1) };
}
export type ApplicationPreferenceState = ReturnType<typeof useApplicationPreferences>;
