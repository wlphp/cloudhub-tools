import { ToastNotice } from "../../shared/ToastNotice";
import { useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { aiClient, type AiProfile } from "../../platform/clients/ai";

export type ImportableAiSupplier = { profile: AiProfile; apiKey: string };

/** Reads the shared model-supplier catalog; secrets are revealed only after an explicit import click. */
export function AiSupplierImport({ target, onImport }: {
  target: "codex" | "claude";
  onImport: (value: ImportableAiSupplier) => void;
}) {
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void aiClient.list().then(items => {
      if (!active) return;
      const supported = items.filter(item => item.hasKey && (target === "codex"
        ? item.protocol === "openai_chat" || item.protocol === "openai_responses"
        : true));
      setProfiles(supported);
      setSelected(supported[0]?.id ?? "");
    }).catch(() => { if (active) setMessage("读取模型供应商失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [target]);

  async function importSelected() {
    const profile = profiles.find(item => item.id === selected);
    if (!profile || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const apiKey = await aiClient.revealKey(profile.id, profile.updatedAt);
      onImport({ profile, apiKey });
      setMessage("已填入渠道草稿；保存渠道后会在目标位置单独保存一份密钥。");
    } catch {
      setMessage("读取密钥失败，请确认模型供应商仍存在并重试");
    } finally { setBusy(false); }
  }

  return <div className="ai-supplier-import">
    <strong>从模型供应商导入</strong>
    {loading ? <span role="status">正在读取…</span> : profiles.length ? <div>
      <label>选择配置<select aria-label="选择模型供应商" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
      </select></label>
      <button type="button" disabled={busy || !selected} onClick={() => void importSelected()}>{busy ? <LoaderCircle size={14} className="is-spin" /> : <Download size={14} />}{busy ? "读取中…" : "导入配置"}</button>
    </div> : <span>暂无可导入且已配置密钥的模型供应商。</span>}
    <ToastNotice message={message} />
  </div>;
}
