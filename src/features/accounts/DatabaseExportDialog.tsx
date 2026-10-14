import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ExportChecklist } from "../../shared/ExportSelection";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { accountsClient, type SyncEnvelope, type SyncImportPreview } from "../../platform/clients/accounts";
import type { Account, ManagedHost, PanelConnection } from "../../shared/types";

export function DatabaseExportDialog({ accounts, hosts, panels, onFullBackup, onClose }: { accounts: Account[]; hosts: ManagedHost[]; panels: PanelConnection[]; onFullBackup: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState("selected");
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [envelope, setEnvelope] = useState<SyncEnvelope | null>(null);
  const [preview, setPreview] = useState<SyncImportPreview | null>(null);
  const items = [...accounts.map(account => ({ id: `account:${account.id}`, label: `云账号 · ${account.account_name}` })), ...hosts.map(host => ({ id: `host:${host.id}`, label: `服务器 · ${host.name}` })), ...panels.map(panel => ({ id: `panel:${panel.id}`, label: `面板 · ${panel.name}` }))];
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  async function readFile(file: File | undefined) {
    setEnvelope(null); setPreview(null); setMessage("");
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error();
      const value = JSON.parse(await file.text());
      if (!value || typeof value.ciphertext !== "string" || typeof value.salt !== "string") throw new Error();
      setEnvelope(value);
    } catch { setMessage("请选择有效的加密配置迁移文件（不超过 16 MiB）"); }
  }
  async function save() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      if (scope === "full") { dialog.current?.close(); onClose(); await onFullBackup(); return; }
      if (scope === "import") {
        if (!envelope || !password) return;
        if (!preview) { setPreview(await accountsClient.previewSyncBundle(envelope, password)); return; }
        if (preview.conflicts.length || preview.deletions.length) { setMessage("文件包含冲突或删除操作，请先处理后重试。"); return; }
        await accountsClient.importSyncBundle(envelope, password);
        setMessage("配置已导入，请关闭弹窗并刷新列表。"); setEnvelope(null); setPreview(null); return;
      }
      const valid = selected.filter(id => items.some(item => item.id === id));
      if (!valid.length || password.length < 12 || password !== repeat) { setMessage("请选择配置并填写一致的迁移口令（至少 12 个字符）"); return; }
      const ids = (prefix: string) => valid.filter(id => id.startsWith(prefix)).map(id => Number(id.slice(prefix.length)));
      if (await accountsClient.saveSyncBundleFile(ids("account:"), ids("host:"), ids("panel:"), password, false)) setMessage("所选配置已导出为加密迁移文件，可通过配置同步导入。");
      else setMessage("已取消保存");
    } catch { setMessage("导出失败，请检查所选配置和保存位置后重试。"); }
    finally { setBusy(false); if (scope !== "import" || preview) { setPassword(""); setRepeat(""); } }
  }
  return <dialog ref={dialog} className="export-selection-dialog" aria-label="选择数据导出范围" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>数据导出与迁移</h2><DialogHeaderActions><button type="button" disabled={busy} aria-label="关闭数据导出" title="关闭" onClick={onClose}><X size={17} /></button></DialogHeaderActions></header>
    <form id="database-export-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>导出范围<select value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setPreview(null); setMessage(""); setPassword(""); setRepeat(""); }}><option value="selected">选择云账号、服务器与面板</option><option value="full">完整数据库备份</option><option value="import">导入加密配置迁移文件</option></select></label>
      {scope === "selected" && <><ExportChecklist items={items} selected={selected} onChange={setSelected} disabled={busy} /><p>生成口令加密的配置迁移文件；在此窗口切换到“导入加密配置迁移文件”恢复。验证码、证书和 AI 配置请使用对应页面的导出入口。</p></>}
      {scope === "import" && <label>配置迁移文件<input type="file" accept=".json,application/json" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /></label>}
      {scope !== "full" && <label>迁移口令<input type="password" autoComplete="new-password" required minLength={scope === "selected" ? 12 : 1} maxLength={1024} disabled={busy} value={password} onChange={event => { setPassword(event.target.value); setPreview(null); }} /></label>}
      {scope === "selected" && <label>确认迁移口令<input type="password" autoComplete="new-password" required disabled={busy} value={repeat} onChange={event => setRepeat(event.target.value)} /></label>}
      {scope === "full" && <p>生成 .chdb 完整数据库备份，导入时会替换目标数据库。验证码请使用验证器页面单独导出。</p>}
      {scope === "import" && preview && <section><p>将新增或更新 {preview.accounts.length} 个云账号、{preview.managedHosts.length} 台服务器、{preview.panels.length} 个面板。同一配置以文件内容覆盖，SSH 指纹需要重新确认。</p>{preview.conflicts.length > 0 || preview.deletions.length > 0 ? <p role="alert">文件包含冲突或删除操作，请先处理后重试。</p> : <p>确认后导入文件中的配置。</p>}</section>}
      {message && <p role="status">{message}</p>}
    </form>
    <footer><button type="button" disabled={busy} onClick={onClose}>关闭</button><button type="submit" form="database-export-form" disabled={busy || (scope === "selected" && (!selected.length || password.length < 12 || password !== repeat)) || (scope === "import" && (!envelope || !password || !!preview?.conflicts.length || !!preview?.deletions.length))}>{busy ? "处理中…" : scope === "import" ? preview ? "确认导入配置" : "预览迁移文件" : "选择位置并导出"}</button></footer>
  </dialog>;
}
