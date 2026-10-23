import { useState } from "react";
import { Database, FileText, Globe2, KeyRound, Monitor, Upload } from "lucide-react";
import type { CodexExportFormat } from "../../platform/clients/codex";
import { OverviewDialog } from "./OverviewDialogs";

type AddMethod = "official" | "oauth" | "token" | "apikey" | "file";
const methods: { id: AddMethod; label: string; Icon: typeof Monitor }[] = [
  { id: "official", label: "官方登录", Icon: Monitor },
  { id: "oauth", label: "OAuth 授权", Icon: Globe2 },
  { id: "token", label: "Token / JSON", Icon: FileText },
  { id: "apikey", label: "API Key", Icon: KeyRound },
  { id: "file", label: "导入", Icon: Database },
];

export function AddAccountDialog({ busy, error, canOpenDefault, onClose, onOfficialLogin, onOAuth, onImportLocal, onImportText, onImportFile }: {
  busy: boolean; error: string; canOpenDefault: boolean; onClose: () => void;
  onOfficialLogin: () => void; onOAuth: () => void; onImportLocal: () => void;
  onImportText: (content: string, force?: boolean) => Promise<boolean>; onImportFile: (format: CodexExportFormat) => void;
}) {
  const [method, setMethod] = useState<AddMethod>("official");
  const [content, setContent] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [format, setFormat] = useState<CodexExportFormat>("cockpit_tools");

  async function importContent(value: string, force = false) {
    if (!value.trim() || busy) return;
    if (await onImportText(value, force)) { setContent(""); setApiKey(""); }
  }

  return <OverviewDialog title="添加 Codex 账号" busy={busy} onClose={onClose} className="codex-add-account-dialog" footer={<button type="button" onClick={onClose} disabled={busy}>关闭</button>}>
    <div className="codex-add-methods" role="tablist" aria-label="选择账号添加方式">
      {methods.map(({ id, label, Icon }) => <button id={`codex-add-tab-${id}`} key={id} type="button" role="tab" aria-selected={method === id} aria-controls={`codex-add-panel-${id}`} onClick={() => setMethod(id)} disabled={busy}><Icon size={15} />{label}</button>)}
    </div>
    <section id={`codex-add-panel-${method}`} className="codex-add-panel" role="tabpanel" aria-labelledby={`codex-add-tab-${method}`}>
      {method === "official" && <>
        <p>使用官方 Codex 客户端登录后，将本机已登录的账号安全导入 CloudHub。</p>
        <ol className="codex-add-steps"><li>打开官方 Codex 客户端</li><li>在客户端完成账号登录</li><li>返回此处点击“导入本机登录”</li></ol>
        <div className="codex-add-actions"><button type="button" disabled={busy || !canOpenDefault} onClick={onOfficialLogin}><Monitor size={15} />打开官方 Codex 客户端</button><button type="button" className="codex-add-primary" disabled={busy} onClick={onImportLocal}><Database size={15} />导入本机登录</button></div>
      </>}
      {method === "oauth" && <>
        <p>通过 Codex 官方授权页面登录。授权回调由本机 Codex 登录进程处理，完成后账号凭据会加密保存。</p>
        <ol className="codex-add-steps"><li>启动官方 OAuth 授权会话</li><li>在浏览器登录并授权</li><li>等待授权结果自动导入</li></ol>
        <button type="button" className="codex-add-primary codex-add-wide" disabled={busy} onClick={onOAuth}><Globe2 size={15} />开始 OAuth 授权</button>
      </>}
      {method === "token" && <>
        <p>粘贴官方 Token、auth.json、session JSON 或兼容的账号 JSON。凭据只在本机加密保存。</p>
        <label>Token / JSON 内容<textarea value={content} rows={8} maxLength={2 * 1024 * 1024} disabled={busy} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="粘贴 Token 或账号 JSON" onChange={event => setContent(event.target.value)} /></label>
        <button type="button" className="codex-add-primary codex-add-wide" disabled={busy || !content.trim()} onClick={() => void importContent(content)}><Upload size={15} />导入账号</button>
        <p id="codex-force-import-help">强制导入会直接保存现有凭据，跳过在线换取和身份完整性检查，并允许更新运行中账号。运行中实例可能回写旧凭据；保存成功不代表凭据可用，缺少 Refresh Token 时无法自动续期。</p>
        <button type="button" disabled={busy || !content.trim()} aria-describedby="codex-force-import-help" onClick={() => void importContent(content, true)}>强制导入</button>
      </>}
      {method === "apikey" && <>
        <p>添加 OpenAI API Key 账号。Key 会在本机加密保存；该账号按 API 使用量计费，不提供 ChatGPT 订阅额度。</p>
        <label>OpenAI API Key<input type="password" value={apiKey} maxLength={16_384} disabled={busy} autoComplete="new-password" placeholder="sk-…" onChange={event => setApiKey(event.target.value)} /></label>
        <button type="button" className="codex-add-primary codex-add-wide" disabled={busy || !apiKey.trim()} onClick={() => void importContent(apiKey)}><KeyRound size={15} />添加 API Key</button>
      </>}
      {method === "file" && <>
        <p>从本地文件导入 Codex 账号。重复账号会更新凭据，并在本机加密保存。</p>
        <label>文件格式<select value={format} disabled={busy} onChange={event => setFormat(event.target.value as CodexExportFormat)}><option value="cockpit_tools">Cockpit Tools</option><option value="auth_json">官方 auth.json</option><option value="sub2api">Sub2API</option><option value="cpa">CPA</option></select></label>
        <button type="button" className="codex-add-primary codex-add-wide" disabled={busy} onClick={() => onImportFile(format)}><Upload size={15} />选择文件并导入</button>
      </>}
      {error && <p className="codex-card-error" role="alert">{error}</p>}
    </section>
  </OverviewDialog>;
}
