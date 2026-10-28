import { useEffect, useRef, useState } from "react";
import { Archive, FolderOpen, Pin, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { platformErrorMessage } from "../../platform/api";
import { databaseClient } from "../../platform/clients/database";
import { codexHistory, type CodexHistoryAction, type CodexHistoryEntry, type CodexHistoryState, type CodexHistoryTarget } from "../../platform/clients/codex-history";

const reasons: Record<string, string> = { account: "切换账号前", provider: "切换供应商前", instance: "切换实例账号前", restore: "恢复历史前", manual: "手动备份", legacy_account: "旧版账号备份迁入", legacy_provider: "旧版供应商备份迁入" };
const timestamp = (value: number | null) => value === null ? "旧版备份 · 原备份时间未知" : new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
type Confirmation = { action: "restore" | "delete" | "recover"; entry: CodexHistoryEntry | null; target: CodexHistoryTarget | null };

export function ConfigHistoryDialog({ initialTarget, privacy = false, onClose, onChanged }: { initialTarget?: string | null; privacy?: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<CodexHistoryState | null>(null);
  const [targetId, setTargetId] = useState(initialTarget === undefined ? "all" : initialTarget ?? "default");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);
  async function refresh() {
    if (working.current) return;
    working.current = true; setLoading(true); setError("");
    try { const next = await codexHistory.list(); if (alive.current) setState(next); }
    catch (e) { if (alive.current) setError(platformErrorMessage(e, "读取备份历史失败")); }
    finally { working.current = false; if (alive.current) setLoading(false); }
  }
  async function openBackupDirectory() {
    setError(""); setNotice("");
    try {
      await databaseClient.openBackupDirectory();
      if (alive.current) setNotice("已打开应用数据备份目录。Codex 历史记录保存在本地加密数据库中。");
    } catch (e) { if (alive.current) setError(platformErrorMessage(e, "打开备份目录失败")); }
  }
  async function run(action: CodexHistoryAction, target: CodexHistoryTarget | null, entry: CodexHistoryEntry | null = null) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = await codexHistory.action(action, target, entry, action === "pin" ? !entry?.pinned : null);
      if (alive.current) {
        setState(next); setConfirmation(null);
        setNotice(action === "restore" ? "已恢复所选备份。恢复前状态已自动备份，可再次选择恢复；请重新启动 Codex。" : action === "recover" ? "已处理未完成操作，请检查配置后重新应用。" : action === "manual" ? "当前配置与登录已加密备份" : action === "delete" ? "备份已删除" : "保留状态已更新");
      }
      if (["restore", "recover"].includes(action)) {
        try { await onChanged(); }
        catch { if (alive.current) setNotice("恢复已完成，但页面刷新失败，请关闭后刷新账号列表。"); }
      }
    } catch (e) {
      if (alive.current) setError(platformErrorMessage(e, "备份操作失败"));
      // Refresh versions after conflicts; do not silently retry a confirmed replacement.
      try { const next = await codexHistory.list(); if (alive.current) setState(next); } catch { /* keep the last list and the original error */ }
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }
  const targets = state?.targets ?? [];
  const selectedTarget = targets.find(t => (t.id ?? "default") === targetId) ?? null;
  const entries = (state?.entries ?? []).filter(e => (targetId === "all" || selectedTarget?.home === e.home) && (!source || e.source === source));
  const pendingTargets = targets.filter(t => t.pending && (targetId === "all" || t === selectedTarget));
  const locked = busy || loading;
  const targetName = (home: string) => targets.find(t => t.home === home)?.name ?? "目标已移除";
  const confirmMessage = confirmation?.action === "delete" ? `删除 ${timestamp(confirmation.entry?.createdAt ?? null)} 的备份？删除后无法恢复该记录。` : confirmation?.action === "recover" ? `将 ${confirmation.target?.name} 的未完成操作回退到操作前状态。外部修改冲突时保留恢复点并停止。` : `将 ${confirmation?.target?.name} 恢复到 ${timestamp(confirmation?.entry?.createdAt ?? null)} 保存的状态。${confirmation?.entry?.complete ? "配置、登录及目标绑定将一并恢复。" : "此为旧版部分备份，仅恢复已捕获内容。"}当前状态会先自动备份。请先停止 Codex，恢复后需要重新启动。`;
  return <>
    <OverviewDialog title="Codex 备份与恢复" busy={locked} onClose={onClose} layout="form" className="codex-history-dialog" description="账号切换与供应商切换共用本机加密备份历史" footer={<><span className="codex-history-count">{entries.length} 条记录</span><button type="button" disabled={locked} onClick={onClose}>关闭</button></>}>
      <div className="codex-history-content">
        <div className="codex-history-controls">
          <label>目标目录<select aria-label="备份目标" value={targetId} disabled={locked} onChange={e => setTargetId(e.target.value)}><option value="all">全部目标</option>{targets.map(t => <option key={t.id ?? "default"} value={t.id ?? "default"}>{privacy && t.id ? "独立实例" : t.name}</option>)}</select></label>
          <label>备份来源<select aria-label="备份来源" value={source} disabled={locked} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{Object.entries(reasons).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <button type="button" disabled={locked} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button>
          <button type="button" disabled={locked || !selectedTarget || selectedTarget.pending} title={!selectedTarget ? "先选择需要备份的目标目录" : "将当前配置与登录加密保存到本机"} onClick={() => selectedTarget && void run("manual", selectedTarget)}><Archive size={14} />立即备份</button>
          <button type="button" disabled={locked} title="打开应用数据目录中的数据库备份文件夹；Codex 历史记录本身加密保存在本地数据库中" onClick={() => void openBackupDirectory()}><FolderOpen size={14} />打开备份目录</button>
        </div>
        <p className="codex-history-help">时间按本地时区显示。每条备份只能恢复到原目录；恢复前会自动保存当前状态。旧版备份没有原始时间，迁入时间不作为备份时间。</p>
        {selectedTarget && <code className="codex-history-path">{privacy ? "配置目录已隐藏" : selectedTarget.home}</code>}
        {pendingTargets.map(t => <div key={t.home} className="codex-provider-launch-warning" role="status"><span>{privacy ? "目标" : t.name} 有未完成的配置操作，请先处理。</span><button type="button" disabled={locked} onClick={() => setConfirmation({ action: "recover", entry: null, target: t })}>处理待恢复操作</button></div>)}
        {loading && <p role="status">正在读取备份历史…</p>}
        {error && <p role="alert" className="codex-card-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!loading && !entries.length && <p role="status">暂无符合条件的备份。切换账号或供应商时会自动备份，也可选择目标后立即备份。</p>}
        {!!entries.length && <div className="codex-history-table-wrap"><table className="codex-history-table"><thead><tr><th>备份时间</th><th>目标 / 当时模式</th><th>备份内容与来源</th><th>操作</th></tr></thead><tbody>{entries.map(entry => {
          const target = targets.find(t => t.home === entry.home) ?? null;
          return <tr key={entry.id}>
            <td><time dateTime={entry.createdAt === null ? undefined : new Date(entry.createdAt).toISOString()} title={entry.createdAt === null ? `迁入时间：${timestamp(entry.migratedAt)}` : new Date(entry.createdAt).toString()}>{timestamp(entry.createdAt)}</time>{entry.pinned && <small><Pin size={12} />已保留</small>}{entry.pending && <small>待恢复</small>}</td>
            <td><span title={privacy ? undefined : entry.home}>{privacy ? "目标信息已隐藏" : targetName(entry.home)}</span><small>{entry.mode}</small></td>
            <td><span>{privacy ? (entry.complete ? "完整备份" : "旧版部分备份") : entry.summary}</span><small>{reasons[entry.source] ?? "自动备份"}</small></td>
            <td><div className="codex-history-row-actions"><button type="button" disabled={locked || !target || target.pending} onClick={() => setConfirmation({ action: "restore", entry, target })}><RotateCcw size={13} />恢复</button><button type="button" disabled={locked || entry.pending} aria-label={`${entry.pinned ? "取消保留" : "保留"}备份 ${entry.id}`} aria-pressed={entry.pinned} onClick={() => void run("pin", target, entry)}><Pin size={13} /></button><button type="button" disabled={locked || entry.pending} aria-label={`删除备份 ${entry.id}`} onClick={() => setConfirmation({ action: "delete", entry, target })}><Trash2 size={13} /></button></div></td>
          </tr>;
        })}</tbody></table></div>}
      </div>
    </OverviewDialog>
    {confirmation && <ConfirmDialog title={confirmation.action === "delete" ? "删除 Codex 备份" : confirmation.action === "recover" ? "处理未完成配置操作" : "恢复所选 Codex 备份"} message={privacy ? "确认对所选目标执行此操作？恢复前会自动备份当前状态。" : confirmMessage} confirmLabel={confirmation.action === "delete" ? "确认删除" : "确认恢复"} busy={busy} error={error} onResolve={confirmed => { if (confirmed) void run(confirmation.action, confirmation.target, confirmation.entry); else if (!busy) { setConfirmation(null); setError(""); } }} />}
  </>;
}
