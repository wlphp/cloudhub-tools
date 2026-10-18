import { useState } from "react";
import { FileArchive, Trash2 } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";

interface Props {
  name: string;
  busy: boolean;
  backingUp: boolean;
  error: string;
  message: string;
  onCancel: () => void;
  onBackup: () => void;
  onConfirm: (confirmationName: string) => void;
}

export function WslDeleteConfirmation({ name, busy, backingUp, error, message, onCancel, onBackup, onConfirm }: Props) {
  const [confirmation, setConfirmation] = useState("");
  return <SharedDialog title={`删除发行版 ${name}`} icon={<Trash2 size={18} aria-hidden="true" />} role="alertdialog" className="wsl-delete-dialog" size="small" showResize={false} closeLabel="关闭删除对话框" closeDisabled={busy} onClose={onCancel}
    footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={onBackup}><FileArchive size={14} aria-hidden="true" />{backingUp ? "正在备份…" : "先备份"}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="wsl-delete-confirm" disabled={busy || confirmation !== name} onClick={() => onConfirm(confirmation)}>{busy && !backingUp ? "正在删除…" : "确认删除"}</button>
    </>}>
      <p id="wsl-delete-warning">此操作会永久删除该发行版内的全部 Linux 文件、已安装软件和设置，无法撤销。请确认已保存所需备份。</p>
      <label htmlFor="wsl-delete-name">请输入完整发行版名称 <strong>{name}</strong> 以确认删除</label>
      <input id="wsl-delete-name" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="wsl-delete-warning" />
      {error && <p role="alert" className="hardware-info-error">{error}</p>}
      {message && <p role="status" className="hardware-info-message">{message}</p>}
    </SharedDialog>;
}
