import { useEffect, useRef, useState, type RefObject } from "react";
import { FileArchive, Trash2 } from "lucide-react";

interface Props {
  name: string;
  parentRef: RefObject<HTMLElement | null>;
  busy: boolean;
  backingUp: boolean;
  error: string;
  message: string;
  onCancel: () => void;
  onBackup: () => void;
  onConfirm: (confirmationName: string) => void;
}

export function WslDeleteConfirmation({ name, parentRef, busy, backingUp, error, message, onCancel, onBackup, onConfirm }: Props) {
  const [confirmation, setConfirmation] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const parent = parentRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (parent) parent.inert = true;
    cancelRef.current?.focus();
    return () => { if (parent) parent.inert = false; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [parentRef]);

  return <div className="wsl-delete-backdrop">
    <section role="alertdialog" aria-modal="true" aria-labelledby="wsl-delete-title" aria-describedby="wsl-delete-warning" className="wsl-delete-dialog" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <h3 id="wsl-delete-title"><Trash2 size={18} aria-hidden="true" />删除发行版 {name}</h3>
      <p id="wsl-delete-warning">此操作会永久删除该发行版内的全部 Linux 文件、已安装软件和设置，无法撤销。请确认已保存所需备份。</p>
      <label htmlFor="wsl-delete-name">请输入完整发行版名称 <strong>{name}</strong> 以确认删除</label>
      <input id="wsl-delete-name" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="wsl-delete-warning" />
      {error && <p role="alert" className="hardware-info-error">{error}</p>}
      {message && <p role="status" className="hardware-info-message">{message}</p>}
      <div className="wsl-delete-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onBackup}><FileArchive size={14} aria-hidden="true" />{backingUp ? "正在备份…" : "先备份"}</button>
        <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="wsl-delete-confirm" disabled={busy || confirmation !== name} onClick={() => onConfirm(confirmation)}>{busy && !backingUp ? "正在删除…" : "确认删除"}</button>
      </div>
    </section>
  </div>;
}
