import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { DatabaseImportPreview } from "../../platform/clients/database";
import { SharedDialog } from "../../shared/SharedDialog";
import { DataTransferScope } from "./DataTransferScope";

export function DataImportReview({ preview, busy, onClose, onConfirm }: {
  preview: DatabaseImportPreview; busy: boolean; onClose: () => void;
  onConfirm: (tables?: string[], mode?: "merge" | "overwrite" | "replace") => void;
}) {
  const sql = preview.importMode === "merge" || preview.importMode === "overwrite";
  const [tables, setTables] = useState(preview.categories.map(item => item.table));
  const [mode, setMode] = useState<"merge" | "overwrite" | "replace">("replace");
  return <SharedDialog title={sql ? "确认导入 SQL" : "确认恢复业务数据"} icon={<AlertTriangle size={20} />} role="alertdialog" className="database-import-dialog" busy={busy} closeDisabled={busy} onClose={onClose} initialFocus="button[data-cancel]" footer={<><button type="button" className="secondary" data-cancel disabled={busy} onClick={onClose}>取消导入</button><button type="button" className="primary" disabled={busy || !tables.length} onClick={() => onConfirm(sql ? undefined : tables, sql ? undefined : mode)}>{busy ? "正在导入…" : "确定导入"}</button></>}>
    <p>文件：{preview.packageName}<br />导出时间：{preview.exportedAt}<br />共 {preview.totalRecords} 条记录。恢复前自动保存本机快照。</p>
    {sql ? <><p>{preview.importMode === "merge" ? "合并数据并保留已有记录。" : "合并数据并覆盖重复记录。"}</p><div className="database-import-summary">{preview.categories.map(item => <span key={item.table}><b>{item.count}</b>{item.label}</span>)}</div></> : <><DataTransferScope categories={preview.categories} tables={tables} onChange={setTables} disabled={busy} /><label className="data-transfer-field">恢复方式<select aria-label="恢复方式" disabled={busy} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="replace">替换所选模块</option><option value="merge">合并，保留已有</option><option value="overwrite">合并，覆盖重复</option></select></label></>}
    <p>包含验证码种子。保留本机 Codex 登录账号、日志、设备身份和下载文件。恢复数据后不会启动进程或接管 Claude/Codex 配置文件。</p>
    <div className="database-import-details">{preview.details.map((item, i) => <div key={i}>{item}</div>)}</div>
    {preview.conflicts.length > 0 && <div className="database-import-conflicts"><strong>重复/冲突提示</strong>{preview.conflicts.map((item, i) => <div key={i}>{item}</div>)}</div>}
  </SharedDialog>;
}
