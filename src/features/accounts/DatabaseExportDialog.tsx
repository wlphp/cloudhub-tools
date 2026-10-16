import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";

export function DatabaseExportDialog({ onFullBackup, onClose }: { onFullBackup: () => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  async function exportAll() {
    if (busy) return;
    setBusy(true);
    dialog.current?.close();
    onClose();
    try { await onFullBackup(); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="export-selection-dialog modal-form-layout dialog-common-theme" aria-label="导出完整备份" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>导出完整备份</h2><DialogHeaderActions><button type="button" disabled={busy} aria-label="关闭数据导出" title="关闭" onClick={onClose}><X size={17} /></button></DialogHeaderActions></header>
    <p>导出完整数据库备份，包含本机全部配置与数据，不需要迁移口令。</p>
    <footer><button type="button" disabled={busy} onClick={onClose}>关闭</button><button type="button" disabled={busy} onClick={() => void exportAll()}>{busy ? "处理中…" : "选择位置并导出"}</button></footer>
  </dialog>, document.body);
}
