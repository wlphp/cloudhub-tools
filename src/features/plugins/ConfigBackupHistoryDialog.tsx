import { Archive, Clock3, RotateCcw } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";

export type ConfigBackupRecord = {
  id: string | number;
  createdAt: number;
  file?: string;
  legacy?: boolean;
};

export function backupDate(backup: ConfigBackupRecord) {
  return new Date(backup.createdAt).toLocaleString("zh-CN", { hour12: false });
}

export function ConfigBackupHistoryDialog<Record extends ConfigBackupRecord>({ title, sizeStorageKey, backups, busy, onClose, onRestore }: {
  title: string;
  sizeStorageKey: string;
  backups: Record[];
  busy?: boolean;
  onClose: () => void;
  onRestore: (backup: Record) => void;
}) {
  return <SharedDialog sizeStorageKey={sizeStorageKey} title={title}
    subtitle="恢复前会自动备份当前配置，所选历史版本会继续保留。"
    icon={<Archive size={18} aria-hidden="true" />} className="claude-backup-dialog"
    closeDisabled={busy} onClose={onClose}
    footer={<button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button>}>
    {backups.length ? <section aria-label="备份记录">
      <div className="claude-backup-summary"><strong>备份记录</strong><span>{backups.length} 条 · 最新在前</span></div>
      <ul className="claude-backup-history">
        {backups.map((backup, index) => <li className="claude-backup-history-row" key={backup.id}>
          <span className="claude-backup-icon"><Clock3 size={15} aria-hidden="true" /></span>
          <div className="claude-backup-meta">
            <strong>{backupDate(backup)}</strong>
            {backup.file && <code>{backup.file}</code>}
            {index === 0 && <span className="claude-backup-tag">最新</span>}
            {backup.legacy && <span className="claude-backup-tag">旧版备份</span>}
          </div>
          <button type="button" className="secondary" disabled={busy} aria-label={`恢复 ${backupDate(backup)} ${backup.file ?? "的配置"}`}
            onClick={() => onRestore(backup)}><RotateCcw size={13} aria-hidden="true" />恢复</button>
        </li>)}
      </ul>
    </section> : <p className="claude-backup-empty">当前配置目录还没有历史备份。</p>}
  </SharedDialog>;
}
