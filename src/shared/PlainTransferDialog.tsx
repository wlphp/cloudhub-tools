import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { SharedDialog } from "./SharedDialog";

export type TransferRow = { id: string; title: string; detail: string };
export type ImportPreview = { token: string; rows: Array<{ index: number; title: string; detail: string }> };

export function PlainTransferDialog({ title, rows, prepareImport, importSelected, exportSelected, onClose, onDone }: {
  title: string; rows: TransferRow[]; prepareImport: () => Promise<ImportPreview | null>;
  importSelected: (token: string, indices: number[]) => Promise<{ imported: number; skipped: number }>;
  exportSelected: (ids: string[], acknowledgePlain: boolean) => Promise<boolean>;
  onClose: () => void; onDone: (message: string) => void;
}) {
  const [tab, setTab] = useState<"export" | "import">("export");
  const [selected, setSelected] = useState(() => new Set(rows.map(row => row.id)));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [imported, setImported] = useState(() => new Set<number>());
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const all = rows.length > 0 && rows.every(row => selected.has(row.id));
  const load = async () => { setBusy(true); setError(""); try { const next = await prepareImport(); if (next) { setPreview(next); setImported(new Set(next.rows.map(row => row.index))); } } catch (e) { setError(e instanceof Error ? e.message : "导入文件读取失败"); } finally { setBusy(false); } };
  const submitExport = async () => { setBusy(true); setError(""); try { const saved = await exportSelected(rows.filter(row => selected.has(row.id)).map(row => row.id), acknowledge); if (saved) { onDone("已导出所选配置；文件包含明文秘钥，请妥善保管"); onClose(); } } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); } finally { setBusy(false); } };
  const submitImport = async () => { if (!preview) return; setBusy(true); setError(""); try { const result = await importSelected(preview.token, [...imported]); onDone(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条重复配置`); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "导入失败"); } finally { setBusy(false); } };
  return <SharedDialog title={`${title}导入 / 导出`} icon={tab === "export" ? <Download size={18} /> : <Upload size={18} />} busy={busy} closeDisabled={busy} onClose={onClose} size="small"
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button>{tab === "export" ? <button type="button" className="primary" disabled={busy || !selected.size || !acknowledge} onClick={() => void submitExport()}><Download size={14} />导出所选</button> : <button type="button" className="primary" disabled={busy || !preview || !imported.size} onClick={() => void submitImport()}><Upload size={14} />导入所选</button>}</>}>
    <div className="transfer-tabs"><button type="button" className={tab === "export" ? "active" : ""} onClick={() => setTab("export")}>导出</button><button type="button" className={tab === "import" ? "active" : ""} onClick={() => setTab("import")}>导入</button></div>
    {tab === "export" ? <><p className="transfer-warning">导出文件包含明文秘钥，不加密。请仅保存到可信位置，不要上传或发送给他人。</p><label className="transfer-check"><input type="checkbox" checked={all} onChange={event => setSelected(event.target.checked ? new Set(rows.map(row => row.id)) : new Set())} />全选（{rows.length} 条）</label><div className="transfer-list">{rows.map(row => <label key={row.id} className="transfer-row"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /><span><strong>{row.title}</strong><small>{row.detail}</small></span></label>)}{!rows.length && <p>暂无可导出的配置。</p>}</div><label className="transfer-check"><input type="checkbox" checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} />我确认导出文件将包含明文秘钥</label></> : <><p className="transfer-warning">导入文件中的秘钥会在保存时重新加密；仅选择你信任的文件。</p>{!preview && <button type="button" className="secondary" disabled={busy} onClick={() => void load()}><Upload size={14} />选择导入文件</button>}{preview && <><label className="transfer-check"><input type="checkbox" checked={preview.rows.length > 0 && preview.rows.every(row => imported.has(row.index))} onChange={event => setImported(event.target.checked ? new Set(preview.rows.map(row => row.index)) : new Set())} />全选（{preview.rows.length} 条）</label><div className="transfer-list">{preview.rows.map(row => <label key={row.index} className="transfer-row"><input type="checkbox" checked={imported.has(row.index)} onChange={() => setImported(current => { const next = new Set(current); next.has(row.index) ? next.delete(row.index) : next.add(row.index); return next; })} /><span><strong>{row.title}</strong><small>{row.detail}</small></span></label>)}</div></>}{error && <p role="alert" className="transfer-error">{error}</p>}</>}
  </SharedDialog>;
}
