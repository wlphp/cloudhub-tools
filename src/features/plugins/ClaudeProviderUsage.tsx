import { useEffect, useState } from "react";
import { claudeWorkbenchClient, type ClaudeProviderSummary } from "../../platform/clients/claudeProviders";
import { preferencesClient } from "../../platform/clients/preferences";
import { ProviderUsageControl, readUsageSelection, type UsageProvider } from "../codex/ProviderUsageControl";
import "../codex/model-providers.css";

const PREFERENCE_PREFIX = "claude.providers.usage.";

/** 只传递密钥标签；实际凭据始终由原生层读取。 */
export function ClaudeProviderUsage({ provider, disabled }: { provider: ClaudeProviderSummary; disabled: boolean }) {
  const [preferences, setPreferences] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    preferencesClient.list().then(value => { if (alive) setPreferences(value); }).catch(() => {
      if (alive) { setPreferences({}); setError("额度查询设置读取失败，可重新选择并保存"); }
    });
    return () => { alive = false; };
  }, []);
  const usageProvider: UsageProvider = { id: provider.id, name: provider.name, version: 0, keys: [{ id: "primary", name: "供应商 API Key" }] };
  const saved = preferences && readUsageSelection(preferences[PREFERENCE_PREFIX + provider.id], usageProvider);
  let official = false;
  try { official = ["api.deepseek.com", "api.minimaxi.com", "www.minimaxi.com", "api.minimax.io", "www.minimax.io", "open.bigmodel.cn", "api.z.ai"].includes(new URL(provider.baseUrl ?? "").hostname); } catch { /* 未配置地址时仍允许打开设置 */ }
  return <div className="claude-provider-quota-control" title={error || undefined}>
    {preferences ? <ProviderUsageControl provider={usageProvider} savedSelection={saved || (official ? { adapter: "auto", keyId: "primary" } : null)}
      disabled={disabled} privacy={false} preferencePrefix={PREFERENCE_PREFIX} autoQuery
      queryUsage={selection => claudeWorkbenchClient.usage(provider.id, selection.adapter)}
      onSaved={value => { setPreferences(current => ({ ...current, [PREFERENCE_PREFIX + provider.id]: value })); setError(""); }} /> : <span role="status">读取额度设置…</span>}
  </div>;
}
