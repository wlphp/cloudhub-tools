import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { databaseClient, type DatabaseImportPreview, type DatabaseRestorePlan } from "../../platform/clients/database";
import { SharedDialog } from "../../shared/SharedDialog";
import { DataTransferScope } from "./DataTransferScope";

export function DataImportReview({ preview, busy, onClose, onConfirm }: {
  preview: DatabaseImportPreview; busy: boolean; onClose: () => void;
  onConfirm: (tables?: string[], mode?: "merge" | "overwrite" | "replace", forceRestore?: boolean) => void;
}) {
  const sql = preview.importMode === "merge" || preview.importMode === "overwrite";
  const [tables, setTables] = useState(preview.categories.map(item => item.table));
  const [mode, setMode] = useState<"merge" | "overwrite" | "replace">("merge");
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [plan, setPlan] = useState<{ key: string; value: DatabaseRestorePlan } | null>(null);
  const [planError, setPlanError] = useState("");
  const [retry, setRetry] = useState(0);
  const planKey = JSON.stringify([preview.token, tables, mode, includeTrash, retry]);
  const currentPlan = plan?.key === planKey ? plan.value : null;
  useEffect(() => {
    let active = true;
    setPlanError("");
    if (!tables.length) return;
    void databaseClient.planImport(preview.token, sql ? undefined : tables, sql ? undefined : mode, includeTrash).then(value => {
      if (active) setPlan({ key: planKey, value });
    }).catch(() => { if (active) setPlanError("无法计算恢复影响，请重新预览；本地数据未修改。"); });
    return () => { active = false; };
  }, [planKey, preview.token, sql, tables, mode, includeTrash]);
  const destructive = sql ? preview.importMode === "overwrite" : mode !== "merge";
  const replacing = !sql && mode === "replace";
  return <SharedDialog title={sql ? "确认导入 SQL" : "确认恢复业务数据"} icon={<AlertTriangle size={20} />} role="alertdialog" className="database-import-dialog" busy={busy} closeDisabled={busy} onClose={onClose} initialFocus="button[data-cancel]" footer={<><button type="button" className="secondary" data-cancel disabled={busy} onClick={onClose}>取消导入</button><button type="button" className="primary" disabled={busy || !tables.length || !currentPlan || (destructive && !overwriteConfirmed)} onClick={() => { if (currentPlan && (!destructive || overwriteConfirmed)) onConfirm(sql ? undefined : tables, sql ? undefined : mode, true); }}>{busy ? "正在导入…" : "备份本机并导入"}</button></>}>
    <p>文件：{preview.packageName}<br />导出时间：{preview.exportedAt}<br />共 {preview.totalRecords} 条记录。恢复前自动保存本机快照。</p>
    {sql ? <><p>{preview.importMode === "merge" ? "追加数据并保留已有记录。" : "合并数据并覆盖重复记录。"}</p><div className="database-import-summary">{preview.categories.map(item => <span key={item.table}><b>{item.count}</b>{item.label}</span>)}</div></> : <><details className="data-settings-scope"><summary>数据范围 · 已选 {tables.length} / {preview.categories.length} 类</summary><DataTransferScope categories={preview.categories} tables={tables} onChange={next => { setTables(next); setOverwriteConfirmed(false); }} disabled={busy} /></details><label className="data-transfer-field">恢复方式<select aria-label="恢复方式" disabled={busy} value={mode} onChange={event => { setMode(event.target.value as typeof mode); setOverwriteConfirmed(false); }}><option value="merge">追加，保留已有（默认）</option><option value="overwrite">合并，覆盖重复记录</option><option value="replace">替换所选模块（删除本地独有记录）</option></select></label><p>{mode === "merge" ? "仅增加新记录，保留本地已有数据，重复记录不覆盖。" : null}</p><label className="data-transfer-check"><input type="checkbox" checked={includeTrash} disabled={busy} onChange={event => { setIncludeTrash(event.target.checked); setOverwriteConfirmed(false); }} />包含备份回收站（保留删除状态，默认不导入）</label></>}
    <p>每次导入前自动创建本机恢复备份，可在备份管理中恢复；备份失败将终止导入。</p>
    {sql && <label className="data-transfer-check"><input type="checkbox" checked={includeTrash} disabled={busy} onChange={event => { setIncludeTrash(event.target.checked); setOverwriteConfirmed(false); }} />包含文件回收站（保留删除状态，默认不导入）</label>}
    {currentPlan && <p>来源范围策略：{currentPlan.sourcePolicyVersion ?? (sql ? "SQL 交换格式" : "旧版备份，验证器不恢复")}；当前策略：{currentPlan.policyVersion}。</p>}
    <button type="button" className="secondary" disabled={busy || !tables.length} onClick={() => { setRetry(value => value + 1); setOverwriteConfirmed(false); }}>刷新恢复影响</button>
    {currentPlan ? <section aria-label="恢复影响"><h3>预计恢复影响</h3>{currentPlan.impacts.map(item => <p key={item.table}>{item.label}：新增 {item.added} · 更新 {item.updated} · 跳过 {item.skipped} · 删除 {item.deleted}{currentPlan.dependencyModules.includes(item.table) ? "（必要依赖，仅追加）" : ""}</p>)}{currentPlan.warnings.map((warning, index) => <small key={index}>{warning} </small>)}</section> : planError ? <p role="alert">{planError}<button type="button" className="secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>重新预览</button></p> : tables.length > 0 ? <p role="status">正在计算恢复影响…</p> : null}
    {destructive && <><p role="alert" className="data-settings-error">{replacing ? "警告：将用备份替换所选模块，删除其中备份未包含的本地记录；未选择的模块不参与删除。请核对上方逐项删除数量。" : "警告：与备份重复的本地记录将被覆盖，原有内容会被替换；其他本地记录保留。"}</p><label className="data-transfer-check"><input type="checkbox" checked={overwriteConfirmed} disabled={busy} onChange={event => setOverwriteConfirmed(event.target.checked)} />{replacing ? "我确认替换所选模块并删除本地独有记录" : "我确认覆盖重复的本地记录"}</label></>}
    <p>仅在选择验证器时恢复验证码种子；旧包不支持时保留本机。保留本机 Codex 登录账号、日志、设备身份和下载文件。恢复数据后不会启动进程或接管 Claude/Codex 配置文件。</p>
    {preview.details.length > 0 && <details className="data-settings-scope"><summary>备份详细内容 · {preview.details.length} 项</summary><div className="database-import-details">{preview.details.map((item, i) => <div key={i}>{item}</div>)}</div></details>}
    {preview.conflicts.length > 0 && <div className="database-import-conflicts"><strong>重复/冲突提示</strong>{preview.conflicts.map((item, i) => <div key={i}>{item}</div>)}</div>}
  </SharedDialog>;
}
