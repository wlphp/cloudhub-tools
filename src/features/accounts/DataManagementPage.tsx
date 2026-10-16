import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Database, Download, HardDriveDownload, RefreshCw, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { databaseClient, type DatabaseBackupRecord, type DatabaseImportPreview } from "../../platform/clients/database";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";

type Props = {
  onBack: () => void;
  onPhoneMigration: () => void;
  canManageBackups: boolean;
  onRestore: (preview: DatabaseImportPreview) => void;
  onStatus: (message: string) => void;
};

const sizeText = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DataManagementPage({ onBack, onPhoneMigration, canManageBackups, onRestore, onStatus }: Props) {
  const [backupOpen, setBackupOpen] = useState(false);
  return <section className="utility-page data-management-page">
    <header><div><span className="eyebrow">LOCAL DATA</span><h1>数据管理</h1><p>迁移本机数据，或创建完整备份并在需要时恢复。</p></div><button className="secondary" onClick={onBack}><ArrowLeft size={15} />返回系统设置</button></header>
    <section className="data-management-actions">
      <article className="panel data-management-action"><div className="settings-icon purple"><Upload size={22} /></div><div><h2>手机扫码迁移</h2><p>通过扫码在设备间选择并迁移数据。</p></div><button className="secondary" onClick={onPhoneMigration}>开始迁移</button></article>
      <article className="panel data-management-action"><div className="settings-icon blue"><Database size={22} /></div><div><h2>备份与恢复</h2><p>{canManageBackups ? "管理本机完整数据库备份；恢复前可查看数据概况。" : "完整数据库备份仅在桌面客户端中可用。"}</p></div><button className="primary-update-btn" disabled={!canManageBackups} onClick={() => setBackupOpen(true)}>打开备份与恢复</button></article>
    </section>
    {backupOpen && <BackupRestoreDialog onClose={() => setBackupOpen(false)} onRestore={onRestore} onStatus={onStatus} />}
  </section>;
}

function BackupRestoreDialog({ onClose, onRestore, onStatus }: Pick<Props, "onRestore" | "onStatus"> & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [records, setRecords] = useState<DatabaseBackupRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmMessage, setConfirmMessage] = useState("");
  useEffect(() => { dialog.current?.showModal(); void refresh(); return () => dialog.current?.close(); }, []);
  function askConfirm(message: string) {
    setConfirmMessage(message);
    confirmDialog.current?.showModal();
    return new Promise<boolean>(resolve => { confirmResolver.current = resolve; });
  }
  function resolveConfirm(confirmed: boolean) {
    confirmDialog.current?.close();
    confirmResolver.current?.(confirmed);
    confirmResolver.current = null;
  }
  async function refresh() {
    try { setRecords(await databaseClient.listBackups()); setError(""); }
    catch (e) { setError(`读取备份失败：${String(e)}`); }
  }
  async function create() {
    if (!await askConfirm("本机备份包含账号凭据等敏感数据。备份保存在当前设备，请妥善保护设备数据目录。现在创建备份吗？")) return;
    setBusy(true);
    try { const record = await databaseClient.createBackup(); setRecords(rows => [record, ...rows]); onStatus("完整数据备份已创建"); }
    catch (e) { setError(`创建备份失败：${String(e)}`); }
    finally { setBusy(false); }
  }
  async function download(record: DatabaseBackupRecord) {
    try { const path = await databaseClient.downloadBackup(record.id); if (path) onStatus(`备份已下载：${path}`); }
    catch (e) { setError(`下载备份失败：${String(e)}`); }
  }
  async function remove(record: DatabaseBackupRecord) {
    if (!await askConfirm(`确定删除 ${new Date(record.createdAt).toLocaleString()} 这条备份吗？删除后无法恢复。`)) return;
    try { await databaseClient.deleteBackup(record.id); setRecords(rows => rows.filter(row => row.id !== record.id)); onStatus("备份已删除"); }
    catch (e) { setError(`删除备份失败：${String(e)}`); }
  }
  async function restore(record: DatabaseBackupRecord) {
    setBusy(true);
    try { const preview = await databaseClient.prepareBackupRestore(record.id); if (preview) { onClose(); onRestore(preview); } }
    catch (e) { setError(`准备恢复失败：${String(e)}`); }
    finally { setBusy(false); }
  }
  async function importBackup() {
    setBusy(true);
    try { const record = await databaseClient.importBackup(); if (record) { setRecords(rows => [record, ...rows]); onStatus("备份文件已导入，可在列表中查看或恢复"); } }
    catch (e) { setError(`导入备份失败：${String(e)}`); }
    finally { setBusy(false); }
  }
  return <>
  <dialog ref={dialog} className="codex-dialog modal-form-layout dialog-common-theme backup-restore-dialog" aria-label="备份与恢复" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div className="codex-dialog-heading"><h2>备份与恢复</h2></div><DialogHeaderActions><button type="button" aria-label="关闭备份与恢复" title="关闭" onClick={onClose}><X size={17} /></button></DialogHeaderActions></header>
    <div className="codex-dialog-content backup-restore-content">
      <p className="backup-restore-note">完整备份包含本机敏感数据。恢复会替换普通数据库内容，并保留当前设备的 Codex 与验证器数据。</p>
      <div className="backup-restore-toolbar"><strong>本机备份</strong><div><button type="button" className="secondary" disabled={busy} onClick={() => void importBackup()}><Upload size={14} />导入备份</button><button type="button" className="primary" disabled={busy} onClick={() => void create()}><HardDriveDownload size={14} />立即备份</button><button type="button" className="secondary icon-button" aria-label="刷新备份列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div></div>
      {error && <p className="backup-restore-error" role="alert">{error}</p>}
      <div className="backup-restore-list">{records.length ? records.map(record => <article className="backup-record" key={record.id}><div><strong className="backup-record-name" title={record.fileName}>{record.fileName}</strong><small>{new Date(record.createdAt).toLocaleString()} · {sizeText(record.sizeBytes)}</small></div><div className="backup-record-actions"><button type="button" className="secondary" aria-label="下载备份" title="下载" onClick={() => void download(record)}><Download size={14} /></button><button type="button" className="secondary" aria-label="删除备份" title="删除" onClick={() => void remove(record)}><Trash2 size={14} /></button><button type="button" className="secondary" disabled={busy} onClick={() => void restore(record)}><RotateCcw size={14} />恢复</button></div></article>) : <div className="backup-empty"><Database size={24} /><span>还没有备份记录</span></div>}</div>
      <div className="codex-dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button></div>
    </div>
  </dialog>
  {createPortal(<dialog ref={confirmDialog} className="app-confirm-dialog modal-form-layout dialog-common-theme backup-inline-confirm" aria-modal="true" aria-labelledby="backup-confirm-title" onCancel={event => { event.preventDefault(); resolveConfirm(false); }}>
      <div className="app-confirm-copy"><span className="eyebrow">PLEASE CONFIRM</span><h2 id="backup-confirm-title">确认操作</h2><p>{confirmMessage}</p></div>
      <div className="app-confirm-actions"><button type="button" className="secondary" autoFocus onClick={() => resolveConfirm(false)}>取消</button><button type="button" className="primary app-confirm-primary" onClick={() => resolveConfirm(true)}>确认</button></div>
  </dialog>, document.querySelector(".ide-theme") ?? document.body)}
  </>;
}
