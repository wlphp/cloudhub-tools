import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { codexProviders, type CodexProvider, type ProviderUsage } from "../../platform/clients/codex-providers";

export function ProviderUsageDialog({ provider, onClose }: { provider: CodexProvider; onClose: () => void }) {
  const [keyId, setKeyId] = useState(provider.keys[0]?.id ?? "");
  const [adapter, setAdapter] = useState("auto");
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function query() {
    if (active.current) return;
    active.current = true; setBusy(true); setUsage(null); setError("");
    try { const result = await codexProviders.usage(provider.id, keyId, provider.version, adapter); if (alive.current) setUsage(result); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "额度查询失败"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  return <OverviewDialog title={provider.name + " · 额度"} busy={busy} layout="form" onClose={onClose} footer={<><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy || !keyId} onClick={() => void query()}><RefreshCw size={14} />{busy ? "查询中..." : "查询额度"}</button></>}>
    <div className="codex-provider-form">
      <label>密钥<select disabled={busy} value={keyId} onChange={e => { setKeyId(e.target.value); setUsage(null); setError(""); }}>{provider.keys.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>额度适配<select disabled={busy} value={adapter} onChange={e => { setAdapter(e.target.value); setUsage(null); setError(""); }}><option value="auto">官方接口 · DeepSeek / MiniMax / 智谱</option><option value="new_api">New API · display 额度接口</option></select></label>
      {error && <p role="alert" className="codex-card-error">{error}</p>}
      {usage ? <><dl>{usage.windows.map((window, index) => <div key={index}><dt>{window.name}</dt><dd>{window.remaining.toLocaleString()} {window.unit}{window.total != null ? " / " + window.total.toLocaleString() : ""}{window.resetsAt && <small> · 重置 {new Date(window.resetsAt * 1000).toLocaleString()}</small>}</dd></div>)}</dl><small>查询时间 {new Date(usage.fetchedAt).toLocaleString()}</small></> : !busy && <p role="status">当前额度未知</p>}
    </div>
  </OverviewDialog>;
}
