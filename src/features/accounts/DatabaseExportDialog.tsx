import { useState } from "react";
import { SharedDialog } from "../../shared/SharedDialog";

export function DatabaseExportDialog({ onFullBackup, onClose }: { onFullBackup: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  async function exportAll() {
    if (busy) return;
    setBusy(true);
    onClose();
    try { await onFullBackup(); }
    finally { setBusy(false); }
  }
  return <SharedDialog title="导出完整备份" size="small" className="export-selection-dialog" closeLabel="关闭数据导出" onClose={onClose} closeDisabled={busy} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button><button type="button" className="primary" disabled={busy} onClick={() => void exportAll()}>{busy ? "处理中…" : "选择位置并导出"}</button></>}>
    <p>导出完整数据库备份，包含本机全部配置与数据，不需要迁移口令。</p>
  </SharedDialog>;
}
