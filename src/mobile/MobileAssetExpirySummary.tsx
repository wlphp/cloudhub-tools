import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import type { LocalAsset } from "../shared/types";
import { assetTypes } from "../features/cloud/catalog";
import { assetExpiryPolicyFromValue, assetExpiryPolicyPreferenceKey } from "../features/assets/expiryPolicy";
import { withinAssetExpiry } from "../features/assets/aiSearch";
import { preferencesClient } from "../platform/clients/preferences";
import { runningInTauri } from "../platform/api";
import { SharedDialog } from "../shared/SharedDialog";

export function MobileAssetExpirySummary({ assets, onApply }: { assets: LocalAsset[]; onApply: (days: number, types: string[]) => void }) {
  const [policy, setPolicy] = useState(() => { try { return assetExpiryPolicyFromValue(localStorage.getItem(assetExpiryPolicyPreferenceKey)); } catch { return assetExpiryPolicyFromValue(null); } });
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(!runningInTauri);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!runningInTauri) return; let active = true; void preferencesClient.list().then(values => { if (active && values[assetExpiryPolicyPreferenceKey]) setPolicy(assetExpiryPolicyFromValue(values[assetExpiryPolicyPreferenceKey])); }).catch(() => { if (active) setError("读取到期策略失败，请稍后重试。"); }).finally(() => { if (active) setReady(true); }); return () => { active = false; }; }, []);
  const update = async (next: typeof policy) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try { const value = JSON.stringify(next); if (runningInTauri) await preferencesClient.save(assetExpiryPolicyPreferenceKey, value); localStorage.setItem(assetExpiryPolicyPreferenceKey, value); setPolicy(next); }
    catch { setError("保存到期策略失败，请重试。"); }
    finally { setSaving(false); }
  };
  const count = assets.filter(asset => policy.resourceTypes.includes(asset.resource_type) && withinAssetExpiry(asset, policy.days, Date.now())).length;
  return <><div className="mobile-expiry-summary"><button type="button" onClick={() => onApply(policy.days, policy.resourceTypes)}><span><Clock3 size={17} />{policy.days} 天内到期</span><strong>{count}</strong><small>项资产 · 查看明细</small></button><button type="button" aria-haspopup="dialog" disabled={!ready} onClick={() => setOpen(true)}>到期策略</button></div>
    {open && <SharedDialog title="到期策略" subtitle="设置到期汇总范围，修改后自动保存。" size="small" className="mobile-expiry-policy-dialog" closeLabel="关闭到期策略" onClose={() => setOpen(false)} footer={<button type="button" className="secondary" onClick={() => setOpen(false)}>完成</button>}>
      {error && <p role="alert">{error}</p>}
      <label className="mobile-expiry-days">到期范围<input key={policy.days} type="number" min={1} max={3650} disabled={saving} defaultValue={policy.days} onBlur={event => { const days = Number(event.currentTarget.value); if (Number.isInteger(days) && days >= 1 && days <= 3650) void update({ ...policy, days }); else event.currentTarget.value = String(policy.days); }} />天内</label>
      <fieldset className="mobile-expiry-types" disabled={saving}><legend>统计资源类型</legend>{assetTypes.map(([type, label]) => <label key={type}><input type="checkbox" checked={policy.resourceTypes.includes(type)} onChange={event => void update({ ...policy, resourceTypes: event.target.checked ? [...policy.resourceTypes, type] : policy.resourceTypes.filter(item => item !== type) })} />{label}</label>)}</fieldset>
      <p className="mobile-form-hint">仅统计本机已保存、具有有效到期时间的资产。</p>
    </SharedDialog>}
  </>;
}
