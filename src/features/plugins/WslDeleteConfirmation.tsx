import { useEffect, useRef, useState, type RefObject } from "react";
import { FileArchive, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";

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

  return createPortal(<div className="wsl-delete-backdrop modal-backdrop">
    <section role="alertdialog" aria-modal="true" aria-labelledby="wsl-delete-title" aria-describedby="wsl-delete-warning" className="modal wsl-delete-dialog modal-form-layout dialog-common-theme" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="modal-head"><h2 id="wsl-delete-title"><Trash2 size={18} aria-hidden="true" />删除发行版 {name}</h2><DialogHeaderActions showResize={false}><button type="button" className="close" aria-label="关闭删除对话框" disabled={busy} onClick={onCancel}><X size={16} /></button></DialogHeaderActions></header>
      <div className="modal-body"><p id="wsl-delete-warning">此操作会永久删除该发行版内的全部 Linux 文件、已安装软件和设置，无法撤销。请确认已保存所需备份。</p>
      <label htmlFor="wsl-delete-name">请输入完整发行版名称 <strong>{name}</strong> 以确认删除</label>
      <input id="wsl-delete-name" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="wsl-delete-warning" />
      {error && <p role="alert" className="hardware-info-error">{error}</p>}
      {message && <p role="status" className="hardware-info-message">{message}</p>}</div>
      <footer className="modal-actions wsl-delete-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onBackup}><FileArchive size={14} aria-hidden="true" />{backingUp ? "正在备份…" : "先备份"}</button>
        <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="wsl-delete-confirm" disabled={busy || confirmation !== name} onClick={() => onConfirm(confirmation)}>{busy && !backingUp ? "正在删除…" : "确认删除"}</button>
      </footer>
    </section>
  </div>, document.body);
}
