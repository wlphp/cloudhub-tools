import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { codexClient, type CodexState } from "../../platform/clients/codex";

export function TokenImportDialog({ onImported, onClose }: { onImported: (state: CodexState) => void; onClose: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => { alive.current = false; };
  }, []);
  async function submit() {
    if (pending.current) return;
    setError("");
    if (!content.trim() || new TextEncoder().encode(content).length > 2 * 1024 * 1024) {
      setError("请输入不超过 2 MB 的 Token 或 JSON"); input.current?.focus(); return;
    }
    pending.current = true; setBusy(true);
    try {
      const next = await codexClient.importText(content);
      if (alive.current) { setContent(""); onImported(next); }
    } catch (reason) {
      if (alive.current) { setError(reason instanceof Error ? reason.message : "导入失败，请检查 Token 或 JSON"); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <SharedDialog title="导入 Token / JSON" className="codex-dialog codex-dialog-form-layout" closeLabel="关闭导入" closeDisabled={busy} busy={busy} onClose={onClose} onSubmit={event => { event.preventDefault(); void submit(); }} bodyClassName="codex-dialog-form-content" footerClassName="codex-dialog-actions" footer={<><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !content.trim()}><Upload size={15} aria-hidden="true" />{busy ? "导入中…" : "导入账号"}</button></>}>
        <p id="codex-token-help">粘贴官方 auth.json、Cockpit Tools / Sub2API 账号 JSON、session JSON、access token 或 refresh token。重复账号会更新凭据，账号只在本机加密保存。</p>
        <details><summary>必填字段与格式说明</summary><p>JSON 支持 tokens、credentials、accessToken / access_token 和 refreshToken / refresh_token；支持账号数组或 accounts 列表，每次最多 100 个账号。仅有 Refresh Token 时请逐个导入，需要连接官方认证服务。单独 Access Token 必须包含账号与用户标识，到期后需重新导入。API Key 可直接粘贴或使用 OPENAI_API_KEY 字段。</p></details>
        <label htmlFor="codex-token-content">Token / JSON 内容<textarea ref={input} id="codex-token-content" value={content} disabled={busy} rows={9} maxLength={2 * 1024 * 1024} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby={error ? "codex-token-help codex-token-error" : "codex-token-help"} aria-invalid={!!error} placeholder="粘贴 Token 或账号 JSON" onChange={event => { setContent(event.target.value); setError(""); }} /></label>
        {error && <p id="codex-token-error" role="alert" className="codex-card-error">{error}</p>}
        <p role="status">{busy ? "正在导入，请稍候…" : "关闭窗口后会清空输入内容。"}</p>
  </SharedDialog>;
}
