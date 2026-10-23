import { SharedDialog } from "../../shared/SharedDialog";
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileUp } from "lucide-react";
import { SecretField } from "../../shared/SecretField";
import { certificatesClient, type CertificateImportPreview } from "../../platform/clients/certificates";
import { platformErrorMessage } from "../../platform/api";
import type { Certificate } from "../../shared/types";

export function CertificateImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (certificate: Certificate) => void }) {
  const [preview, setPreview] = useState<CertificateImportPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formKey, setFormKey] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const token = useRef<string | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    const listener = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") void prepare(() => certificatesClient.prepareFiles(event.payload.type === "drop" ? event.payload.paths : []));
    });
    return () => { alive.current = false; void listener.then(unlisten => unlisten()).catch(() => {}); if (token.current) void certificatesClient.cancelImport(token.current).catch(() => {}); };
  }, []);
  async function prepare(work: () => Promise<CertificateImportPreview | null>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await work();
      if (!result) return;
      if (!alive.current) { await certificatesClient.cancelImport(result.token); return; }
      if (token.current) await certificatesClient.cancelImport(token.current);
      token.current = result.token; setPreview(result); setSelected(result.candidates[0]?.id || ""); setFormKey(key => key + 1);
    } catch (reason) { if (alive.current) setError(platformErrorMessage(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function confirm() {
    if (!preview || !selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { const certificate = await certificatesClient.confirmImport(preview.token, selected); token.current = null; if (alive.current) onImported(certificate); }
    catch (reason) { if (alive.current) setError(platformErrorMessage(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const candidate = preview?.candidates.find(item => item.id === selected);
  return <SharedDialog title="导入 HTTPS 证书" className="certificate-source-dialog" bodyClassName="certificate-source-body" closeLabel="关闭证书导入" onClose={onClose} footer={<><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy || !candidate} onClick={() => void confirm()}>{busy ? "处理中…" : "确认导入并加密保存"}</button></>}>
      <button className="certificate-file-drop secondary" disabled={busy} onClick={() => void prepare(() => certificatesClient.selectImportFiles())}><FileUp size={20} />选择证书与私钥，或拖放 ZIP 到此窗口</button>
      <small>支持 PEM、CRT、CER、KEY 和 ZIP，在本机校验并加密保存。</small>
      <form ref={form} key={formKey} onSubmit={event => { event.preventDefault(); const values = new FormData(form.current!); const certificate = String(values.get("certificate") || ""); const privateKey = String(values.get("privateKey") || ""); setFormKey(key => key + 1); void prepare(() => certificatesClient.prepareText(certificate, privateKey)); }}>
        <label>证书 / 完整证书链<textarea name="certificate" aria-label="证书或完整证书链" rows={4} required disabled={busy} spellCheck={false} /></label>
        <label>私钥<SecretField multiline name="privateKey" secretLabel="导入私钥" rows={4} required disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <button className="secondary" type="submit" disabled={busy}>{busy ? "校验中…" : "校验粘贴内容"}</button>
      </form>
      {preview && <div className="certificate-import-preview"><label>选择证书<select aria-label="选择导入证书" value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}>{preview.candidates.map(item => <option value={item.id} key={item.id}>{item.primaryDomain} · {new Date(item.notAfter * 1000).toLocaleDateString()}</option>)}</select></label>{candidate && <><p>{candidate.domains.join(" · ")}</p><p>签发者：{candidate.issuer}</p><p>到期：{new Date(candidate.notAfter * 1000).toLocaleString()}</p>{candidate.warnings.map(warning => <p className="certificate-expiring" key={warning}>{warning}</p>)}</>}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
  </SharedDialog>;
}
