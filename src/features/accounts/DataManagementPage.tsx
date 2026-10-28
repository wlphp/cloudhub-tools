import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Database, Download, FolderOpen, HardDriveDownload, LockKeyhole, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import { appClient } from "../../platform/clients/app";
import { databaseClient, type DatabaseBackupRecord, type DatabaseImportPreview } from "../../platform/clients/database";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { translateUiText, type UiLanguage } from "../../i18n/ui-strings";
import { BackupCreateDialog, BackupPasswordDialog, SqlExportDialog } from "./DataTransferDialogs";
import { CloudSyncSection } from "./CloudSyncSection";

type Props = {
  language: UiLanguage;
  onPhoneMigration: () => void;
  onOpenDirectory: () => Promise<void>;
  canManageBackups: boolean;
  onRestore: (preview: DatabaseImportPreview) => void;
  onStatus: (message: string) => void;
};

const sizeText = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DataManagementPage({ language, onOpenDirectory, onPhoneMigration, canManageBackups, onRestore, onStatus }: Props) {
  const t = (text: string) => translateUiText(language, text);
  const [backupOpen, setBackupOpen] = useState(false);
  const [dataPath, setDataPath] = useState("");
  const [pathLoading, setPathLoading] = useState(false);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);
  const [error, setError] = useState("");
  const [exportConfirm, setExportConfirm] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "overwrite">("merge");
  useEffect(() => {
    if (!canManageBackups) return;
    let active = true;
    setPathLoading(true);
    void appClient.dataPath().then(path => { if (active) setDataPath(path); })
      .catch(() => { if (active) setError(t("读取存储位置失败，请重试。")); })
      .finally(() => { if (active) setPathLoading(false); });
    return () => { active = false; };
  }, [canManageBackups]);
  async function refreshPath() {
    setPathLoading(true);
    setError("");
    try { setDataPath(await appClient.dataPath()); }
    catch { setError(t("读取存储位置失败，请重试。")); }
    finally { setPathLoading(false); }
  }
  async function importSql() {
    setBusy("import");
    setError("");
    try {
      const preview = await databaseClient.prepareSqlImport(importMode);
      if (preview) onRestore(preview);
    } catch { setError(t("SQL 导入失败，请检查文件格式、数据关联和数据库版本；当前数据未修改。")); }
    finally { setBusy(null); }
  }
  return <>
    <section className="data-settings-section" aria-label={t("存储位置")}>
      <h2>{t("存储位置")}</h2>
      <div className="data-settings-panel">
        <label htmlFor="cloudhub-data-path">{t("CloudHub 数据目录")}</label>
        <div className="data-settings-path">
          <input id="cloudhub-data-path" readOnly value={dataPath} placeholder={t(canManageBackups ? (pathLoading ? "正在读取…" : "暂未读取到存储位置") : "仅桌面客户端可查看本机目录")} title={dataPath} />
          <button type="button" className="secondary" disabled={!canManageBackups || pathLoading || !dataPath} title={t("打开目录")} aria-label={t("打开目录")} onClick={() => void onOpenDirectory()}><FolderOpen size={16} /></button>
          <button type="button" className="secondary" disabled={!canManageBackups || pathLoading} title={t("刷新存储位置")} aria-label={t("刷新存储位置")} onClick={() => void refreshPath()}><RefreshCw size={16} /></button>
        </div>
        <p>{t("数据库、加密密钥与本机备份保存在此目录。")}</p>
      </div>
    </section>
    <section className="data-settings-section" aria-label={t("数据管理")}>
      <h2>{t("数据管理")}</h2>
      <div className="data-settings-panel">
        <div className="data-settings-heading"><h3>{t("明文 SQL 导入导出")}</h3><span className="data-settings-badge">{t("未加密")}</span></div>
        <p>{t("迁移业务配置，包含明文密码、密钥和私钥。")}</p>
        <div className="data-settings-toolbar" aria-busy={busy !== null}>
          <label className="data-settings-import-mode">{t("重复记录")}<select aria-label={t("导入冲突处理")} value={importMode} disabled={!canManageBackups || busy !== null} onChange={event => setImportMode(event.target.value as "merge" | "overwrite")}><option value="merge">{t("跳过已有（默认）")}</option><option value="overwrite">{t("覆盖已有")}</option></select></label>
          <div className="data-settings-transfer">
            <button type="button" className="secondary" disabled={!canManageBackups || busy !== null} onClick={() => void importSql()}><FolderOpen size={16} aria-hidden="true" />{t(busy === "import" ? "正在读取…" : "导入 SQL")}</button>
            <button type="button" className="secondary" disabled={!canManageBackups || busy !== null} onClick={() => setExportConfirm(true)}><Download size={16} aria-hidden="true" />{t("导出明文 SQL")}</button>
          </div>
        </div>
        <div className="data-settings-notes">
          <p className="data-settings-warning"><AlertTriangle size={14} aria-hidden="true" />{t("文件包含明文凭据，请妥善保管。")}</p>
          <details className="data-settings-scope">
            <summary>{t("查看范围与说明")}</summary>
            <p>{t("统一范围：云账号、SSH/RDP、主机、宝塔面板及站点证书关联、证书及历史私钥、流水线、FRP、Claude/Codex 供应商、AI 配置、备忘录、指纹浏览器配置、验证器种子与可迁移偏好。不含 Codex 登录账号、日志、缓存、设备身份及下载包。")}</p>
            <p>{t("仅支持数据库版本一致的 CloudHub SQL，文件最大 64 MB。导入先预览再确认，凭据会用本机密钥重新加密。")}</p>
          </details>
        </div>
        {!canManageBackups && <p>{t("SQL 导入导出仅在桌面客户端中可用。")}</p>}
        <div className="data-settings-backup">
          <div>
            <div className="data-settings-heading"><h3>{t("加密备份与恢复")}</h3><span className="data-settings-badge"><LockKeyhole size={12} aria-hidden="true" />{t("字段加密")}</span></div>
            <p>{canManageBackups ? t("敏感字段保持加密，备份内携带恢复密钥。默认无需密码，创建时可选密码保护，恢复前先预览。") : t("加密备份仅在桌面客户端中可用。")}</p>
          </div>
          <button type="button" className="primary-update-btn" disabled={!canManageBackups} onClick={() => setBackupOpen(true)}>{t("管理加密备份")}<ArrowRight size={15} aria-hidden="true" /></button>
        </div>
      </div>
    </section>
    <CloudSyncSection available={canManageBackups} onRestore={onRestore} />
    {error && <p className="data-settings-error" role="alert">{error}</p>}
    <div className="settings-card"><div className="settings-icon purple"><Upload size={22} /></div><div className="settings-copy"><strong>{t("手机扫码迁移")}</strong><small>{t("通过扫码在设备间选择并迁移数据。")}</small></div><button type="button" className="secondary settings-link" onClick={onPhoneMigration}>{t("开始迁移")}</button></div>
    {backupOpen && <BackupRestoreDialog onClose={() => setBackupOpen(false)} onRestore={onRestore} onStatus={onStatus} />}
    {exportConfirm && <SqlExportDialog onClose={() => setExportConfirm(false)} onExport={async (tables, includeTrash) => { const path = await databaseClient.exportSql(tables, includeTrash); if (path) onStatus("明文 SQL 已导出，包含密码和私钥，请妥善保管。"); }} />}
  </>;
}

function BackupRestoreDialog({ onClose, onRestore, onStatus }: Pick<Props, "onRestore" | "onStatus"> & { onClose: () => void }) {
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [records, setRecords] = useState<DatabaseBackupRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmMessage, setConfirmMessage] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordAction, setPasswordAction] = useState<{ kind: "restore" | "import"; record?: DatabaseBackupRecord } | null>(null);
  useEffect(() => { void refresh(); return () => { confirmResolver.current?.(false); }; }, []);
  function askConfirm(message: string) {
    setConfirmMessage(message);
    return new Promise<boolean>(resolve => { confirmResolver.current = resolve; });
  }
  function resolveConfirm(confirmed: boolean) {
    setConfirmMessage("");
    confirmResolver.current?.(confirmed);
    confirmResolver.current = null;
  }
  async function refresh() {
    try { setRecords(await databaseClient.listBackups()); setError(""); }
    catch (e) { setError(`读取备份失败：${String(e)}`); }
  }
  async function download(record: DatabaseBackupRecord) {
    try { const path = await databaseClient.downloadBackup(record.id); if (path) onStatus(`备份已下载：${path}`); }
    catch (e) { setError(`下载备份失败：${String(e)}`); }
  }
  async function openLocation() {
    try { await databaseClient.openBackupDirectory(); }
    catch { setError("打开备份位置失败，请确认备份目录存在且可访问。"); }
  }
  async function remove(record: DatabaseBackupRecord) {
    if (!await askConfirm(`确定删除 ${new Date(record.createdAt).toLocaleString()} 这条备份吗？删除后无法恢复。`)) return;
    try { await databaseClient.deleteBackup(record.id); setRecords(rows => rows.filter(row => row.id !== record.id)); onStatus("备份已删除"); }
    catch (e) { setError(`删除备份失败：${String(e)}`); }
  }
  async function restore(record: DatabaseBackupRecord) {
    if (record.encrypted) { setPasswordAction({ kind: "restore", record }); return; }
    setBusy(true);
    try { const preview = await databaseClient.prepareBackupRestore(record.id); if (preview) { onClose(); onRestore(preview); } }
    catch { setError("准备恢复失败，请检查备份文件完整性及版本；当前数据未修改。"); }
    finally { setBusy(false); }
  }
  async function executePasswordAction(password: string) {
    if (!passwordAction) return;
    setBusy(true);
    try {
      if (passwordAction.kind === "restore" && passwordAction.record) {
        const preview = await databaseClient.prepareBackupRestore(passwordAction.record.id, password);
        if (preview) { onClose(); onRestore(preview); }
      } else {
        const record = await databaseClient.importBackup(password);
        if (record) { setRecords(rows => [record, ...rows]); onStatus("备份已导入，尚未恢复数据"); }
      }
    }
    finally { setBusy(false); }
  }
  async function createBackup(password?: string) {
    setBusy(true);
    try {
      const record = await databaseClient.createBackup(password);
      setRecords(rows => [record, ...rows]);
      onStatus(record.encrypted ? "密码备份已保存，恢复时需要备份密码。" : "备份已保存，包含加密字段及恢复密钥，请妥善保管。");
    } finally { setBusy(false); }
  }
  async function importBackup() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const record = await databaseClient.importBackup();
      if (record) {
        setRecords(rows => [record, ...rows]);
        onStatus("备份已导入，尚未恢复数据");
      }
    } catch { setError("导入失败，请检查文件完整性及版本；若为设置密码的备份，请使用“导入密码备份”。"); }
    finally { setBusy(false); }
  }
  return <>
  <SharedDialog title="备份与恢复" className="codex-dialog backup-restore-dialog" bodyClassName="codex-dialog-content backup-restore-content" closeDisabled={busy} onClose={onClose} footer={<button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button>}>
      <p className="backup-restore-note">敏感字段保持密文，恢复 key 随备份携带。创建时默认不加密码，也可勾选密码保护，将数据库和 key 整体加密。不加密码时，持有完整文件即可恢复凭据，请勿公开分享；密码备份需记住密码。导入仅加入列表；恢复先预览，可选择模块与合并或替换方式；包含验证码种子，保留当前设备的 Codex 登录账号、日志和设备身份。本机与云备份包含回收站。</p>
      <div className="backup-restore-toolbar"><strong>本机备份</strong><div><button type="button" className="secondary" disabled={busy} onClick={() => void importBackup()}><Upload size={14} />导入备份</button><button type="button" className="secondary" disabled={busy} onClick={() => setPasswordAction({ kind: "import" })}>导入密码备份</button><button type="button" className="primary" disabled={busy} onClick={() => { setError(""); setCreateOpen(true); }}><HardDriveDownload size={14} />创建备份</button><button type="button" className="secondary icon-button" aria-label="刷新备份列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /></button></div></div>
      {error && <p className="backup-restore-error" role="alert">{error}</p>}
      <div className="backup-restore-list">{records.length ? records.map(record => <article className="backup-record" key={record.id}><div><strong className="backup-record-name" title={record.fileName}>{record.fileName}</strong><small>{new Date(record.createdAt).toLocaleString()} · {sizeText(record.sizeBytes)} · {record.encrypted ? "密码备份" : "内含恢复密钥 · 无需密码"}</small></div><div className="backup-record-actions">
        <button type="button" className="secondary" aria-label="打开位置" title="打开位置" disabled={busy} onClick={() => void openLocation()}><FolderOpen size={14} /></button>
        <button type="button" className="secondary" aria-label="下载备份" title="下载" disabled={busy} onClick={() => void download(record)}><Download size={14} /></button><button type="button" className="secondary" aria-label="删除备份" title="删除" disabled={busy} onClick={() => void remove(record)}><Trash2 size={14} /></button><button type="button" className="secondary" disabled={busy} onClick={() => void restore(record)}><RotateCcw size={14} />恢复</button></div></article>) : <div className="backup-empty"><Database size={24} /><span>还没有备份记录</span></div>}</div>
  </SharedDialog>
  {confirmMessage && <ConfirmDialog message={confirmMessage} onResolve={resolveConfirm} />}
  {passwordAction && <BackupPasswordDialog kind={passwordAction.kind} onClose={() => setPasswordAction(null)} onExecute={executePasswordAction} />}
  {createOpen && <BackupCreateDialog onClose={() => setCreateOpen(false)} onCreate={createBackup} />}
  </>;
}
