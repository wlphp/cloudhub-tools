import { useEffect, useState } from "react";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { preferencesClient } from "../../platform/clients/preferences";
import type { UpdateSource } from "../../platform/clients/updates";
const KEY = "app.update.source";
const PREVIEW = "cloudhub.preview.updateSource";
const valid = (s: unknown): s is UpdateSource => s === "auto" || s === "accelerated" || s === "mirror705810" || s === "direct";
export function useUpdateSource() {
  const [source, setSource] = useState<UpdateSource>("auto");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const value = runningInTauri ? (await preferencesClient.list())[KEY] : localStorage.getItem(PREVIEW);
        if (alive && valid(value)) setSource(value);
      } catch { if (alive) setError("线路偏好读取失败，本次使用自动选择"); }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, []);
  async function save(next: UpdateSource) {
    if (saving || !valid(next)) return;
    setSaving(true); setError("");
    try {
      if (runningInTauri) await preferencesClient.save(KEY, next);
      else localStorage.setItem(PREVIEW, next);
      setSource(next);
    } catch (reason) { setError(platformErrorMessage(reason, "线路设置保存失败")); }
    finally { setSaving(false); }
  }
  return { source, loaded, saving, error, save };
}
