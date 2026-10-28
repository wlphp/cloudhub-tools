import { useEffect, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { codexProviders, type CodexProvider, type ProviderUsage } from "../../platform/clients/codex-providers";
import { preferencesClient } from "../../platform/clients/preferences";
import { ProviderUsageDialog } from "./ProviderUsageDialog";

export const USAGE_PREFERENCE_PREFIX = "codex.providers.usage.";
export const USAGE_ADAPTERS = [["auto", "官方接口 · DeepSeek / MiniMax / 智谱"], ["sub2api", "Sub2API"], ["new_api", "New API"], ["one_api", "One API（兼容计费接口）"]] as const;
export interface UsageSelection { adapter: string; keyId: string }
export type UsageProvider = Pick<CodexProvider, "id" | "name" | "version" | "keys">;
export function readUsageSelection(value: string | undefined, provider: UsageProvider): UsageSelection | null {
  try {
    const parsed = JSON.parse(value ?? "null");
    return parsed && USAGE_ADAPTERS.some(([id]) => id === parsed.adapter) && provider.keys.some(key => key.id === parsed.keyId)
      ? { adapter: parsed.adapter, keyId: parsed.keyId } : null;
  } catch { return null; }
}

export function ProviderUsageControl({ provider, savedSelection, disabled, privacy, onSaved, preferencePrefix = USAGE_PREFERENCE_PREFIX, queryUsage, autoQuery = false }: { provider: UsageProvider; savedSelection: UsageSelection | null; disabled: boolean; privacy: boolean; onSaved: (value: string) => void; preferencePrefix?: string; queryUsage?: (selection: UsageSelection) => Promise<ProviderUsage>; autoQuery?: boolean }) {
  const [selection, setSelection] = useState<UsageSelection>(savedSelection ?? { adapter: "auto", keyId: provider.keys[0]?.id ?? "" });
  const [defaultSelection, setDefaultSelection] = useState(savedSelection);
  const [saveMessage, setSaveMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (autoQuery && savedSelection) void query(savedSelection); }, []);
  async function save() {
    if (active.current || !selection.keyId) return;
    active.current = true; setBusy(true); setSaveMessage("");
    try {
      await preferencesClient.save(preferencePrefix + provider.id, JSON.stringify(selection));
      if (alive.current) {
        setDefaultSelection(selection); onSaved(JSON.stringify(selection)); setSaveMessage("已保存，后续默认使用此类型和密钥");
      }
    } catch (e) { if (alive.current) setSaveMessage(e instanceof Error ? e.message : "保存失败"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  function changeSelection(next: UsageSelection) {
    setSelection(next); setUsage(null); setError(""); setSaveMessage("");
  }
  async function query(next = selection) {
    if (active.current || !next.keyId) return;
    active.current = true; setBusy(true); setError("");
    if (next.adapter !== selection.adapter || next.keyId !== selection.keyId) setUsage(null);
    setSelection(next);
    try {
      const result = await (queryUsage ? queryUsage(next) : codexProviders.usage(provider.id, next.keyId, provider.version, next.adapter));
      if (alive.current) setUsage(result);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "额度查询失败"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  const summary = usage?.windows.map((window, index) => <span key={index}>{index > 0 && " · "}{window.name}{" "}<strong className="codex-provider-usage-amount">{window.remaining.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong>{" "}{window.unit}</span>);
  return <>
    <div className="codex-provider-usage" aria-busy={busy}>
      <button type="button" title="设置额度平台与密钥" aria-label={`查询额度 ${provider.name}`} disabled={disabled || busy} onClick={() => { const next = defaultSelection ?? { adapter: "auto", keyId: provider.keys[0]?.id ?? "" }; if (next.adapter !== selection.adapter || next.keyId !== selection.keyId) changeSelection(next); setSaveMessage(""); setOpen(true); }}><Gauge size={15} /></button>
      {(defaultSelection || usage) && <>
        <span role="status" title={error || (usage ? `查询时间 ${new Date(usage.fetchedAt).toLocaleString()}` : undefined)}>{privacy ? "额度已隐藏" : busy ? "查询中…" : error ? (usage ? <>{summary}（刷新失败）</> : "额度查询失败") : summary || "额度未知"}</span>
        <button type="button" title="刷新额度" aria-label={`刷新额度 ${provider.name}`} disabled={disabled || busy || !defaultSelection?.keyId} onClick={() => { if (defaultSelection) void query(defaultSelection); }}><RefreshCw size={14} className={busy ? "codex-refresh-spinning" : ""} /></button>
      </>}
    </div>
    {open && <ProviderUsageDialog provider={provider} adapters={USAGE_ADAPTERS} selection={selection} usage={usage} busy={busy} error={error} saveMessage={saveMessage} onChange={changeSelection} onSave={() => void save()} onQuery={(next) => void query(next)} onClose={() => setOpen(false)} />}
  </>;
}
