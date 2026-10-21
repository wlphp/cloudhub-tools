import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { codexProviders, type CodexProvider, type ProviderImport } from "../../platform/clients/codex-providers";

export function ProviderImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (items: CodexProvider[]) => void }) {
  const [draft, setDraft] = useState<ProviderImport | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const alive = useRef(true); const token = useRef<string | null>(null); const active = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (token.current) void codexProviders.import("cancel", token.current).catch(() => {}); }; }, []);
  async function run(confirm: boolean) {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try {
      if (confirm) {
        await codexProviders.import("confirm", token.current); token.current = null;
        const values = await codexProviders.list(); if (alive.current) { onSaved(values); onClose(); }
      } else {
        const value = await codexProviders.import("prepare");
        if (!alive.current) { if (value) void codexProviders.import("cancel", value.token).catch(() => {}); return; }
        if (value) { token.current = value.token; setDraft(value); }
      }
    } catch (e) {
      if (confirm) { token.current = null; if (alive.current) setDraft(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "导入失败");
    }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  return <OverviewDialog title="导入模型供应商" layout="form" busy={busy} onClose={onClose} footer={<><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy} onClick={() => void run(false)}><Upload size={14} />选择 JSON 文件</button><button disabled={busy || !draft?.providers.some(v => !v.duplicate)} onClick={() => void run(true)}>确认导入</button></>}>
    <div className="codex-provider-form"><p>所选文件可能包含明文 API Key。凭据仅在本机读取并加密保存，预览不展示密钥。</p>
      {!draft && <p>接受 Cockpit 的 codex_model_providers.json 数组或 CodexPlusPlus 的 relayProfiles 设置 JSON。</p>}
      {draft && <>{draft.warnings.map(v => <p key={v}>{v}</p>)}<div className="codex-provider-results"><table><thead><tr><th>名称</th><th>地址</th><th>密钥数</th><th>状态</th></tr></thead><tbody>{draft.providers.map((v, i) => <tr key={i}><td>{v.name}</td><td>{v.baseUrl}</td><td>{v.keyCount}</td><td>{v.duplicate ? "重复 · 跳过" : "待导入"}</td></tr>)}</tbody></table></div></>}
      {error && <p role="alert" className="codex-card-error">{error}</p>}
    </div>
  </OverviewDialog>;
}
