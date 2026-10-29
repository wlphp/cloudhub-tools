import { useState } from "react";
import { LockKeyhole, FileWarning } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { DataTransferScope, useTransferCatalog } from "./DataTransferScope";

export function SqlExportDialog({ onClose, onExport }: { onClose: () => void; onExport: (tables: string[], includeTrash: boolean) => Promise<void> }) {
  const { categories, tables, setTables, error: catalogError } = useTransferCatalog();
  const [includeTrash, setIncludeTrash] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || !accepted || !tables.length) return;
    setBusy(true); setError("");
    try { await onExport(tables, includeTrash); onClose(); }
    catch { setError("SQL 导出失败，请检查凭据与保存位置后重试。"); }
    finally { setBusy(false); }
  }
  return <SharedDialog title="导出明文 SQL" size="small" icon={<FileWarning size={18} />} className="data-transfer-dialog" busy={busy} closeDisabled={busy} initialFocus="input" onClose={onClose} onSubmit={event => { event.preventDefault(); void submit(); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !accepted || !tables.length}>{busy ? "正在导出…" : "导出明文 SQL"}</button></>}>
    <p>SQL 包含解密后的密码、Access Key Secret、令牌和私钥，任何获得文件的人均可阅读。请保存至可信位置，不要分享给他人。</p>
    <DataTransferScope categories={categories} tables={tables} onChange={setTables} disabled={busy} />
    {catalogError && <p role="alert">{catalogError}</p>}
    <label className="data-transfer-check"><input type="checkbox" checked={includeTrash} disabled={busy} onChange={event => setIncludeTrash(event.target.checked)} />包含回收站（保留删除状态）</label>
    <p>包含所选模块的凭据、私钥及验证码种子。排除登录账号、日志、缓存、设备身份和下载包。关联父记录自动纳入。文件最大 64 MB，要求数据库版本一致。</p>
    <label className="data-transfer-check"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />我了解文件未加密，且包含明文凭据</label>
    {error && <p role="alert">{error}</p>}
  </SharedDialog>;
}

export function BackupCreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (password?: string, tables?: string[]) => Promise<void> }) {
  const { categories, tables, setTables, error: catalogError } = useTransferCatalog();
  const [protectedBackup, setProtectedBackup] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || !tables.length) return;
    if (protectedBackup) {
      if ([...password].length < 8 || new TextEncoder().encode(password).length > 1024) { setError("备份密码至少 8 个字符，最多 1024 个 UTF-8 字节。"); return; }
      if (password !== repeat) { setError("两次输入的备份密码不一致。"); return; }
    }
    setBusy(true); setError("");
    try { await onCreate(protectedBackup ? password : undefined, tables); setPassword(""); setRepeat(""); onClose(); }
    catch { setError("创建备份失败，请检查凭据和存储权限后重试。"); }
    finally { setBusy(false); }
  }
  return <SharedDialog title="创建备份" size="small" className="data-transfer-dialog" icon={<LockKeyhole size={18} />} busy={busy} closeDisabled={busy} initialFocus="input[type=checkbox]" onClose={onClose} onSubmit={event => { event.preventDefault(); void submit(); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "正在创建…" : "保存备份"}</button></>}>
    <label className="data-transfer-check"><input type="checkbox" checked={protectedBackup} disabled={busy} onChange={event => { setProtectedBackup(event.target.checked); setPassword(""); setRepeat(""); setError(""); }} />使用密码保护</label>
    <p>{protectedBackup ? "敏感字段保持密文，数据库和恢复 key 再整体使用此密码加密。导入和恢复时需要密码，忘记后无法恢复，密码不会保存。" : "默认不设置密码：敏感字段保持密文，恢复 key 随备份携带。持有完整文件即可恢复凭据，请妥善保管。"}</p>
    {protectedBackup && <>
      <label className="data-transfer-field">备份密码<input type="password" autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
      <label className="data-transfer-field">确认备份密码<input type="password" autoComplete="new-password" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} /></label>
    </>}
    <section className="backup-content-scope" aria-label="备份内容">
      <h3>备份内容</h3>
      <p>包含所选项目及其回收站数据，保留密码、密钥、证书私钥和验证码种子。</p>
      <DataTransferScope categories={categories} tables={tables} onChange={setTables} disabled={busy} />
      {catalogError && <p role="alert">{catalogError}</p>}
      <p>指纹浏览器仅备份配置及代理凭据；Claude/Codex 管理仅备份供应商相关配置。</p>
    </section>
    {error && <p role="alert">{error}</p>}
  </SharedDialog>;
}

export function BackupPasswordDialog({ kind, onClose, onExecute }: { kind: "restore" | "import"; onClose: () => void; onExecute: (password: string) => Promise<void> }) {
  const title = kind === "restore" ? "解锁备份" : "导入密码备份";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy) return;
    if ([...password].length < 8 || new TextEncoder().encode(password).length > 1024) { setError("备份密码至少 8 个字符，最多 1024 个 UTF-8 字节。"); return; }
    setBusy(true); setError("");
    try { await onExecute(password); setPassword(""); onClose(); }
    catch { setError("无法读取备份，请检查密码、文件完整性及版本后重试。"); }
    finally { setBusy(false); }
  }
  return <SharedDialog title={title} size="small" className="data-transfer-dialog" icon={<LockKeyhole size={18} />} onClose={onClose} busy={busy} closeDisabled={busy} initialFocus="input[type=password]" onSubmit={event => { event.preventDefault(); void submit(); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "正在处理…" : kind === "import" ? "选择备份文件" : "解锁并预览"}</button></>}>
    <p>输入创建该密码备份时设置的密码，密码不会保存。普通备份无需此步骤。</p>
    <label className="data-transfer-field">备份密码<input type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
  </SharedDialog>;
}
